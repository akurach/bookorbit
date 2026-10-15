import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { ConcreteBookMediaKind, ExternalCatalogItem, ExternalStatusPolicy } from '@bookorbit/types';

import { DB } from '../../db';
import * as schema from '../../db/schema';
import { authors, bookAuthors, bookFiles, bookMetadata, books, externalBookSources, libraryFolders, userBookStatus } from '../../db/schema';
import type { RequestUser } from '../../common/types/request-user';
import { LibraryService } from '../library/library.service';
import { buildContentFilterClauses } from '../../common/utils/content-filter-sql.utils';
import { BookCoverStore } from '../book-cover-store/book-cover-store.service';

const YANDEX_COVER_HOSTS = new Set(['api.bookmate.ru']);
const MAX_YANDEX_COVER_BYTES = 5 * 1024 * 1024;

export function isAllowedYandexCoverUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      YANDEX_COVER_HOSTS.has(url.hostname) &&
      (!url.port || url.port === '443') &&
      url.username === '' &&
      url.password === ''
    );
  } catch {
    return false;
  }
}

type Db = NodePgDatabase<typeof schema>;
type Transaction = Parameters<Parameters<Db['transaction']>[0]>[0];

type Destination = { libraryId: number; libraryFolderId: number };

@Injectable()
export class ExternalCatalogService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly libraryService: LibraryService,
    private readonly coverStore: BookCoverStore,
  ) {}

  async importItem(
    user: RequestUser,
    destination: Destination,
    item: ExternalCatalogItem,
    existingBookId?: number,
    statusPolicy: ExternalStatusPolicy = 'safe',
  ): Promise<{ bookId: number; created: boolean; statusConflict: boolean }> {
    await this.verifyDestination(user, destination);
    if (existingBookId != null) await this.verifyExplicitTarget(user, destination, item.mediaKind, existingBookId);
    const priorSource = await this.findSource(this.db, user.id, item);
    if (priorSource) await this.verifyLinkTarget(user, priorSource.bookId);

    const result = await this.db.transaction((tx) => this.importInTransaction(tx, user, destination, item, existingBookId, statusPolicy));
    if (result.created && item.coverUrl) await this.savePublicCover(result.bookId, item.mediaKind, item.coverUrl);
    return result;
  }

  /** Validates an explicit link without moving files or changing reader state. */
  async verifyLinkTarget(user: RequestUser, bookId: number, item?: ExternalCatalogItem, libraryId?: number): Promise<void> {
    const [book] = await this.db.select({ libraryId: books.libraryId }).from(books).where(eq(books.id, bookId)).limit(1);
    if (!book) throw new NotFoundException(`Book ${bookId} not found`);
    await this.libraryService.verifyUserAccess(user.id, book.libraryId, user.isSuperuser);
    if (libraryId != null && item) {
      await this.verifyExplicitTarget(user, { libraryId, libraryFolderId: 0 }, item.mediaKind, bookId);
    }
    if (!user.isSuperuser && user.contentFilters) {
      const [visible] = await this.db
        .select({ id: books.id })
        .from(books)
        .where(and(eq(books.id, bookId), ...buildContentFilterClauses(user.contentFilters, this.db)))
        .limit(1);
      if (!visible) throw new NotFoundException(`Book ${bookId} not found`);
    }
  }

  private async importInTransaction(
    tx: Transaction,
    user: RequestUser,
    destination: Destination,
    item: ExternalCatalogItem,
    existingBookId: number | undefined,
    statusPolicy: ExternalStatusPolicy,
  ): Promise<{ bookId: number; created: boolean; statusConflict: boolean }> {
    const existingSource = await this.findSource(tx, user.id, item);
    let bookId = existingBookId ?? existingSource?.bookId ?? null;
    let created = false;

    if (bookId == null && item.mediaKind === 'ebook') {
      const exactMatches = await tx
        .select({ id: books.id })
        .from(books)
        .innerJoin(bookMetadata, eq(bookMetadata.bookId, books.id))
        .where(and(eq(books.libraryId, destination.libraryId), eq(bookMetadata.yandexBooksId, item.externalId)))
        .limit(2);
      if (exactMatches.length === 1) bookId = exactMatches[0]!.id;
      if (exactMatches.length > 1) throw new BadRequestException('More than one book has this Yandex Books edition. Link one explicitly.');
    }

    if (bookId == null) {
      const folderPath = await this.externalFolderPath(tx, destination.libraryFolderId, item);
      const inserted = await tx
        .insert(books)
        .values({
          libraryId: destination.libraryId,
          libraryFolderId: destination.libraryFolderId,
          folderPath,
          status: 'present',
          isFileless: true,
          catalogMediaKind: item.mediaKind,
        })
        .onConflictDoNothing()
        .returning({ id: books.id });
      if (inserted[0]) {
        bookId = inserted[0].id;
        created = true;
      } else {
        const [samePath] = await tx
          .select({ id: books.id })
          .from(books)
          .where(and(eq(books.libraryId, destination.libraryId), eq(books.folderPath, folderPath)))
          .limit(1);
        if (!samePath) throw new BadRequestException('Could not reserve a catalog location for this book');
        bookId = samePath.id;
      }
    }

    if (created) {
      await this.upsertMetadata(tx, bookId, item);
      await this.upsertAuthors(tx, bookId, item.authors);
    } else {
      await this.verifyLinkTarget(user, bookId, item, destination.libraryId);
    }
    const statusConflict = await this.upsertSourceAndStatus(tx, user.id, bookId, item, existingSource, statusPolicy);
    return { bookId, created, statusConflict };
  }

  private async verifyDestination(user: RequestUser, destination: Destination): Promise<void> {
    await this.libraryService.verifyUserAccessLevel(user.id, destination.libraryId, user.isSuperuser, 'editor');
    const [folder] = await this.db
      .select({ id: libraryFolders.id })
      .from(libraryFolders)
      .where(and(eq(libraryFolders.id, destination.libraryFolderId), eq(libraryFolders.libraryId, destination.libraryId)))
      .limit(1);
    if (!folder) throw new NotFoundException('Library folder not found');
  }

  private async verifyExplicitTarget(user: RequestUser, destination: Destination, mediaKind: ConcreteBookMediaKind, bookId: number): Promise<void> {
    await this.verifyLinkTarget(user, bookId);
    const [book] = await this.db
      .select({ libraryId: books.libraryId, catalogMediaKind: books.catalogMediaKind, format: bookFiles.format })
      .from(books)
      .leftJoin(bookFiles, eq(bookFiles.id, books.primaryFileId))
      .where(eq(books.id, bookId))
      .limit(1);
    if (!book) throw new NotFoundException(`Book ${bookId} not found`);
    if (book.libraryId !== destination.libraryId) throw new BadRequestException('An external item can only be linked inside its destination library');
    const currentKind = this.mediaKindForFormat(book.format, book.catalogMediaKind);
    if (currentKind && currentKind !== mediaKind) throw new BadRequestException('The selected book has an incompatible media type');
  }

  private async externalFolderPath(tx: Transaction, libraryFolderId: number, item: ExternalCatalogItem): Promise<string> {
    const [folder] = await tx.select({ path: libraryFolders.path }).from(libraryFolders).where(eq(libraryFolders.id, libraryFolderId)).limit(1);
    if (!folder) throw new NotFoundException('Library folder not found');
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(item.externalId)) throw new BadRequestException('Invalid external catalog identifier');
    return `${folder.path.replace(/\/+$/, '')}/Yandex Books/${item.mediaKind}-${item.externalId}`;
  }

  private async findSource(tx: Db | Transaction, userId: number, item: ExternalCatalogItem) {
    const [source] = await tx
      .select()
      .from(externalBookSources)
      .where(
        and(
          eq(externalBookSources.userId, userId),
          eq(externalBookSources.provider, item.provider),
          eq(externalBookSources.externalId, item.externalId),
          eq(externalBookSources.mediaKind, item.mediaKind),
        ),
      )
      .limit(1);
    return source ?? null;
  }

  private async upsertMetadata(tx: Transaction, bookId: number, item: ExternalCatalogItem): Promise<void> {
    await tx
      .insert(bookMetadata)
      .values({
        bookId,
        title: item.title,
        description: item.description,
        language: item.language,
        pageCount: item.pageCount,
        isbn13: item.isbn?.replace(/[^0-9Xx]/g, '').slice(-13) || null,
        yandexBooksId: item.mediaKind === 'ebook' ? item.externalId : null,
      })
      .onConflictDoUpdate({
        target: bookMetadata.bookId,
        set: {
          title: item.title,
          description: item.description,
          language: item.language,
          pageCount: item.pageCount,
          isbn13: item.isbn?.replace(/[^0-9Xx]/g, '').slice(-13) || null,
          ...(item.mediaKind === 'ebook' ? { yandexBooksId: item.externalId } : {}),
          updatedAt: new Date(),
        },
      });
  }

  private async upsertAuthors(tx: Transaction, bookId: number, authorsToUpsert: string[]): Promise<void> {
    const names = [...new Set(authorsToUpsert.map((name) => name.trim()).filter(Boolean))].slice(0, 50);
    if (names.length === 0) return;
    await tx.delete(bookAuthors).where(eq(bookAuthors.bookId, bookId));
    for (const [displayOrder, name] of names.entries()) {
      const [inserted] = await tx.insert(authors).values({ name, sortName: name }).onConflictDoNothing().returning({ id: authors.id });
      const author = inserted ?? (await tx.select({ id: authors.id }).from(authors).where(eq(authors.name, name)).limit(1))[0];
      if (author) await tx.insert(bookAuthors).values({ bookId, authorId: author.id, displayOrder });
    }
    await tx.update(books).set({ primaryAuthorSortName: names[0], updatedAt: new Date() }).where(eq(books.id, bookId));
  }

  private async upsertSourceAndStatus(
    tx: Transaction,
    userId: number,
    bookId: number,
    item: ExternalCatalogItem,
    source: typeof externalBookSources.$inferSelect | null,
    policy: ExternalStatusPolicy,
  ): Promise<boolean> {
    const now = new Date();
    const [currentStatus] = await tx
      .select()
      .from(userBookStatus)
      .where(and(eq(userBookStatus.userId, userId), eq(userBookStatus.bookId, bookId)))
      .limit(1)
      .for('update', { of: userBookStatus });
    const incomingStatus = item.status;
    const differs = incomingStatus != null && (currentStatus?.status ?? 'unread') !== incomingStatus;
    const canApplySafely =
      currentStatus == null ||
      (source == null && currentStatus.status === 'unread' && currentStatus.source === 'auto') ||
      (source?.bookId === bookId &&
        source.lastAppliedStatusAt != null &&
        currentStatus.source === 'auto' &&
        currentStatus.updatedAt <= source.lastAppliedStatusAt);
    let applyStatus = incomingStatus != null && (policy === 'remote' || (policy === 'safe' && canApplySafely));
    let statusConflict = differs && policy === 'safe' && !canApplySafely;

    if (applyStatus) {
      const startedAt = this.toDate(item.startedAt);
      const finishedAt = this.toDate(item.finishedAt);
      const validFinishedAt = startedAt && finishedAt && finishedAt < startedAt ? null : finishedAt;
      if (currentStatus == null && policy === 'safe') {
        const inserted = await tx
          .insert(userBookStatus)
          .values({ userId, bookId, status: incomingStatus!, source: 'auto', startedAt, finishedAt: validFinishedAt, updatedAt: now })
          .onConflictDoNothing()
          .returning({ bookId: userBookStatus.bookId });
        if (inserted.length === 0) {
          applyStatus = false;
          statusConflict = differs;
        }
      } else {
        await tx
          .insert(userBookStatus)
          .values({ userId, bookId, status: incomingStatus!, source: 'auto', startedAt, finishedAt: validFinishedAt, updatedAt: now })
          .onConflictDoUpdate({
            target: [userBookStatus.userId, userBookStatus.bookId],
            set: { status: incomingStatus!, source: 'auto', startedAt, finishedAt: validFinishedAt, updatedAt: now },
          });
      }
    }

    const values = {
      userId,
      bookId,
      provider: item.provider,
      externalId: item.externalId,
      mediaKind: item.mediaKind,
      sourceUrl: item.sourceUrl,
      remoteStatus: item.remoteStatus,
      percentage: item.percentage,
      positionSeconds: item.positionSeconds,
      durationSeconds: item.durationSeconds,
      startedAt: this.toDate(item.startedAt),
      finishedAt: this.toDate(item.finishedAt),
      sourceUpdatedAt: this.toDate(item.sourceUpdatedAt),
      syncedAt: now,
      lastAppliedStatusAt: applyStatus ? now : (source?.lastAppliedStatusAt ?? null),
    };
    await tx
      .insert(externalBookSources)
      .values(values)
      .onConflictDoUpdate({
        target: [externalBookSources.userId, externalBookSources.provider, externalBookSources.externalId, externalBookSources.mediaKind],
        set: { ...values, bookId },
      });
    return statusConflict;
  }

  private mediaKindForFormat(format: string | null, catalogMediaKind: string | null): ConcreteBookMediaKind | null {
    if (format) {
      const normalized = format.toLowerCase();
      if (['m4b', 'mp3', 'm4a', 'opus', 'ogg', 'flac'].includes(normalized)) return 'audiobook';
      if (['cbz', 'cbr', 'cb7', 'cbx'].includes(normalized)) return 'comic';
      return 'ebook';
    }
    return catalogMediaKind === 'ebook' || catalogMediaKind === 'audiobook' || catalogMediaKind === 'comic' ? catalogMediaKind : null;
  }

  private toDate(value: string | null): Date | null {
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  private async savePublicCover(bookId: number, mediaKind: ConcreteBookMediaKind, coverUrl: string): Promise<void> {
    if (!isAllowedYandexCoverUrl(coverUrl)) return;
    try {
      const response = await fetch(coverUrl, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
      if (!response.ok || !response.body || response.type === 'opaqueredirect') return;
      const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
      if (!contentType.startsWith('image/')) return;
      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_YANDEX_COVER_BYTES) return;
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_YANDEX_COVER_BYTES) {
          await reader.cancel();
          return;
        }
        chunks.push(value);
      }
      if (total === 0) return;
      await this.coverStore.saveExtracted(bookId, mediaKind === 'audiobook' ? 'audio' : 'ebook', Buffer.concat(chunks), {
        origin: 'provider',
        fill: {},
        skipIfUnchanged: true,
      });
    } catch {
      // A catalog import must not fail when an optional public cover is unavailable.
    }
  }
}
