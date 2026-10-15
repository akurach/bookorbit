import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { ExternalStatusPolicy, YandexBooksEntry, YandexBooksEntryList, YandexBooksSyncResult } from '@bookorbit/types';
import type { RequestUser } from '../../common/types/request-user';
import type { YandexBooksEntryRow } from '../../db/schema';
import { ExternalCatalogService } from '../book/external-catalog.service';
import { YandexBooksClientService } from './yandex-books-client.service';
import { YandexBooksRepository, type YandexBooksLease } from './yandex-books.repository';
import { YandexBooksSettingsService } from './yandex-books-settings.service';

const emptyResult = (): YandexBooksSyncResult => ({ fetched: 0, imported: 0, updated: 0, conflicts: 0 });

@Injectable()
export class YandexBooksSyncService implements OnModuleDestroy {
  private readonly logger = new Logger(YandexBooksSyncService.name);
  private readonly jobs = new Set<Promise<void>>();
  private stopping = false;

  constructor(
    private readonly repo: YandexBooksRepository,
    private readonly settings: YandexBooksSettingsService,
    private readonly client: YandexBooksClientService,
    private readonly catalog: ExternalCatalogService,
  ) {}

  async start(user: RequestUser, preview = false): Promise<{ started: boolean }> {
    return this.begin(user.id, preview ? 'preview' : 'sync');
  }

  async importEntries(user: RequestUser, entryIds?: number[]): Promise<{ started: boolean }> {
    return this.begin(user.id, 'import', entryIds);
  }

  async list(userId: number, page: number, pageSize: number, state?: string): Promise<YandexBooksEntryList> {
    const result = await this.repo.listEntries(userId, page, pageSize, state);
    return { items: result.rows.map((row) => this.entry(row)), total: result.total, page, pageSize };
  }

  async link(user: RequestUser, entryId: number, bookId: number): Promise<YandexBooksEntry> {
    return this.repo.withUserLock(user.id, async () => {
      const connection = await this.idleConnection(user.id);
      const freshUser = await this.settings.requireImportAccess(user.id, connection);
      const entry = await this.requiredEntry(user.id, entryId);
      if (entry.bookId && entry.bookId !== bookId) {
        const result = await this.catalog.relinkItem(freshUser, connection, entry.snapshot, entry.bookId, bookId, entry.id, entry.statusPolicy);
        if (result) return this.entry(await this.requiredEntry(user.id, entryId));
      }
      await this.catalog.verifyLinkTarget(freshUser, bookId, entry.snapshot, connection.libraryId);
      return this.entry(await this.repo.updateEntry(entryId, user.id, { bookId, state: 'ready', conflict: null }));
    });
  }

  async resolve(user: RequestUser, entryId: number, policy: ExternalStatusPolicy): Promise<YandexBooksEntry> {
    return this.repo.withUserLock(user.id, async () => {
      const connection = await this.idleConnection(user.id);
      const freshUser = await this.settings.requireImportAccess(user.id, connection);
      const entry = await this.requiredEntry(user.id, entryId);
      if (!entry.bookId) throw new BadRequestException('Link this item to a book before resolving its reading status');
      const result = await this.catalog.importItem(freshUser, connection, entry.snapshot, entry.bookId, policy);
      const updated = await this.repo.updateEntry(entryId, user.id, {
        // Accepting Yandex resolves this conflict; a later local edit stays protected.
        statusPolicy: policy === 'remote' ? 'safe' : policy,
        state: result.statusConflict ? 'conflict' : 'imported',
        conflict: result.statusConflict ? 'Local reading status needs review' : null,
      });
      return this.entry(updated);
    });
  }

  async pollDue(): Promise<void> {
    if (this.stopping) return;
    for (const userId of await this.repo.due(20)) {
      if (this.jobs.size >= 2) break;
      try {
        await this.begin(userId, 'sync');
      } catch (error) {
        if (!(error instanceof ConflictException)) this.logger.warn(`[yandex_books.schedule] [fail] userId=${userId} - update could not start`);
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    await Promise.allSettled([...this.jobs]);
  }

  private async begin(userId: number, mode: 'preview' | 'sync' | 'import', ids?: number[]): Promise<{ started: boolean }> {
    if (this.stopping || this.jobs.size >= 2) throw new ServiceUnavailableException('Yandex Books importer is busy. Try again shortly.');
    const connection = await this.repo.findSettings(userId);
    if (!connection) throw new NotFoundException('Yandex Books integration not configured');
    await this.settings.requireImportAccess(userId, connection);
    if (mode !== 'import' && connection.needsReauth) throw new UnauthorizedException('Reconnect your Yandex Books account');
    if (mode === 'import' && !connection.completedGeneration) throw new BadRequestException('Run a complete preview first');
    if (ids)
      for (const id of ids) {
        const entry = await this.requiredEntry(userId, id);
        if (entry.generation !== connection.completedGeneration) throw new BadRequestException('Preview these entries again before importing');
      }
    const lease = await this.repo.acquireLease(userId);
    const job = this.run(lease, mode, ids).catch(() => {
      this.logger.error(`[yandex_books.sync] [fail] userId=${userId} - update cleanup failed`);
    });
    this.jobs.add(job);
    void job.finally(() => this.jobs.delete(job));
    return { started: true };
  }

  private async run(lease: YandexBooksLease, mode: 'preview' | 'sync' | 'import', ids?: number[]): Promise<void> {
    const started = Date.now();
    const result = emptyResult();
    this.logger.log(`[yandex_books.sync] [start] userId=${lease.userId} mode=${mode} - update started`);
    try {
      let generation = lease.completedGeneration;
      if (mode !== 'import') {
        const token = this.settings.decryptToken(lease.encryptedToken);
        for await (const page of this.client.collectPages(token, lease.accountLogin)) {
          await this.guarded(lease, async () => {
            await this.repo.stagePage(lease, page);
          });
          result.fetched += page.length;
        }
        await this.guarded(lease, async () => {
          await this.repo.promote(lease);
        });
        generation = lease.leaseId;
      }
      if (mode !== 'preview' && generation) {
        let afterId = 0;
        for (;;) {
          const batch = await this.repo.importableEntries(lease, generation, afterId, ids);
          if (!batch.length) break;
          for (const entry of batch) {
            await this.guarded(lease, async (user) => {
              await this.applyEntry(user, lease, entry, result);
            });
            afterId = entry.id;
          }
        }
      }
      await this.guarded(lease, async () => {
        await this.repo.finish(lease, result);
      });
      this.logger.log(
        `[yandex_books.sync] [end] userId=${lease.userId} durationMs=${Date.now() - started} fetched=${result.fetched} imported=${result.imported} updated=${result.updated} conflicts=${result.conflicts} - update completed`,
      );
    } catch (error) {
      const reauth = error instanceof UnauthorizedException;
      const message = reauth
        ? 'Reconnect your Yandex Books account'
        : error instanceof ForbiddenException
          ? 'Import permission or library access was removed'
          : error instanceof ConflictException
            ? 'Update was superseded or disconnected'
            : 'Update failed. Previous imported data is preserved; try again later.';
      await this.repo.fail(lease, message, reauth);
      this.logger.warn(
        `[yandex_books.sync] [fail] userId=${lease.userId} durationMs=${Date.now() - started} errorClass=${reauth ? 'Authorization' : 'Import'} - ${message}`,
      );
    } finally {
      await this.repo.release(lease);
    }
  }

  private guarded<T>(lease: YandexBooksLease, work: (user: RequestUser) => Promise<T>): Promise<T> {
    return this.repo.withLease(lease, async () => {
      if (this.stopping) throw new ServiceUnavailableException('Server is stopping');
      const user = await this.settings.requireImportAccess(lease.userId, lease);
      return work(user);
    });
  }

  private async applyEntry(
    user: RequestUser,
    destination: YandexBooksLease,
    entry: YandexBooksEntryRow,
    result: YandexBooksSyncResult,
  ): Promise<void> {
    try {
      const output = await this.catalog.importItem(user, destination, entry.snapshot, entry.bookId ?? undefined, entry.statusPolicy);
      await this.repo.updateEntry(entry.id, user.id, {
        bookId: output.bookId,
        state: output.statusConflict ? 'conflict' : 'imported',
        conflict: output.statusConflict ? 'Local reading status needs review' : null,
      });
      if (output.statusConflict) result.conflicts++;
      else if (output.created) result.imported++;
      else result.updated++;
    } catch (error) {
      if (!(error instanceof BadRequestException || error instanceof NotFoundException)) throw error;
      await this.repo.updateEntry(entry.id, user.id, {
        state: 'conflict',
        conflict: error instanceof BadRequestException ? error.message : 'Check the linked book, edition and destination library before retrying',
      });
      result.conflicts++;
    }
  }

  private async idleConnection(userId: number) {
    const connection = await this.repo.findSettings(userId);
    if (!connection) throw new NotFoundException('Yandex Books integration not configured');
    if (connection.leaseUntil && connection.leaseUntil > new Date()) throw new ConflictException('Wait for the current update to finish');
    return connection;
  }

  private async requiredEntry(userId: number, id: number) {
    const entry = await this.repo.findEntry(userId, id);
    if (!entry) throw new NotFoundException('Yandex Books entry not found');
    return entry;
  }

  private entry(row: YandexBooksEntryRow): YandexBooksEntry {
    return {
      id: row.id,
      item: row.snapshot,
      bookId: row.bookId,
      state: row.state,
      statusPolicy: row.statusPolicy,
      conflict: row.conflict,
      lastSeenAt: row.lastSeenAt.toISOString(),
    };
  }
}
