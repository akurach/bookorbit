import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { ExternalCatalogItem, ExternalStatusPolicy } from '@bookorbit/types';

import { buildContentFilterClauses } from '../../common/utils/content-filter-sql.utils';
import type { RequestUser } from '../../common/types/request-user';
import { DB } from '../../db';
import * as schema from '../../db/schema';
import { externalCatalogProviderId, matchExternalCatalogBook } from './external-catalog-matching';
import { assertPristineExternalPlaceholder } from './external-catalog-placeholder';

type Db = NodePgDatabase<typeof schema>;
type Transaction = Parameters<Parameters<Db['transaction']>[0]>[0];
type Destination = { libraryId: number; libraryFolderId: number };
type Source = typeof schema.externalBookSources.$inferSelect;

@Injectable()
export class ExternalCatalogRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async findSource(userId: number, item: ExternalCatalogItem): Promise<Source | null> {
    return this.findSourceIn(this.db, userId, item);
  }

  async findBook(bookId: number): Promise<{ libraryId: number; catalogMediaKind: string | null; format: string | null } | null> {
    const [book] = await this.db
      .select({ libraryId: schema.books.libraryId, catalogMediaKind: schema.books.catalogMediaKind, format: schema.bookFiles.format })
      .from(schema.books)
      .leftJoin(schema.bookFiles, eq(schema.bookFiles.id, schema.books.primaryFileId))
      .where(eq(schema.books.id, bookId))
      .limit(1);
    return book ?? null;
  }

  async hasLibraryFolder(libraryId: number, folderId: number): Promise<boolean> {
    const [folder] = await this.db
      .select({ id: schema.libraryFolders.id })
      .from(schema.libraryFolders)
      .where(and(eq(schema.libraryFolders.id, folderId), eq(schema.libraryFolders.libraryId, libraryId)))
      .limit(1);
    return Boolean(folder);
  }

  async isVisibleToUser(user: RequestUser, bookId: number): Promise<boolean> {
    const [visible] = await this.db
      .select({ id: schema.books.id })
      .from(schema.books)
      .where(and(eq(schema.books.id, bookId), ...buildContentFilterClauses(user.contentFilters, this.db)))
      .limit(1);
    return Boolean(visible);
  }

  importItem(
    user: RequestUser,
    destination: Destination,
    item: ExternalCatalogItem,
    existingBookId: number | undefined,
    statusPolicy: ExternalStatusPolicy,
    verifyExistingTarget: (bookId: number) => Promise<void>,
  ): Promise<{ bookId: number; created: boolean; statusConflict: boolean }> {
    return this.db.transaction((tx) => this.importInTransaction(tx, user, destination, item, existingBookId, statusPolicy, verifyExistingTarget));
  }

  relinkItem(
    userId: number,
    item: ExternalCatalogItem,
    previousBookId: number,
    targetBookId: number,
    entryId: number,
    statusPolicy: ExternalStatusPolicy,
  ): Promise<{ bookId: number; statusConflict: boolean }> {
    return this.db.transaction(async (tx) => {
      await tx
        .select({ id: schema.books.id })
        .from(schema.books)
        .where(inArray(schema.books.id, [previousBookId, targetBookId]))
        .orderBy(schema.books.id)
        .for('update');
      const source = await this.findSourceIn(tx, userId, item, true);
      if (!source || source.bookId !== previousBookId) throw new ConflictException('The source link changed. Reload the entries and try again.');
      const migratedAttempt = await assertPristineExternalPlaceholder(tx, userId, previousBookId, entryId, targetBookId, item, source);
      await this.ensureProviderId(tx, targetBookId, item, true);
      const statusConflict = await this.upsertSourceAndStatus(tx, userId, targetBookId, item, source, statusPolicy);
      await tx
        .update(schema.yandexBooksEntries)
        .set({
          bookId: targetBookId,
          state: statusConflict ? 'conflict' : 'imported',
          conflict: statusConflict ? 'Local reading status needs review' : null,
          updatedAt: new Date(),
        })
        .where(and(eq(schema.yandexBooksEntries.id, entryId), eq(schema.yandexBooksEntries.userId, userId)));
      if (migratedAttempt)
        await tx
          .update(schema.readingAttempts)
          .set({ bookId: targetBookId, updatedAt: migratedAttempt.updatedAt })
          .where(eq(schema.readingAttempts.id, migratedAttempt.id));
      await tx.delete(schema.books).where(eq(schema.books.id, previousBookId));
      return { bookId: targetBookId, statusConflict };
    });
  }

  private async importInTransaction(
    tx: Transaction,
    user: RequestUser,
    destination: Destination,
    item: ExternalCatalogItem,
    existingBookId: number | undefined,
    statusPolicy: ExternalStatusPolicy,
    verifyExistingTarget: (bookId: number) => Promise<void>,
  ) {
    const existingSource = await this.findSourceIn(tx, user.id, item);
    let bookId: number | null = existingBookId ?? existingSource?.bookId ?? null;
    let created = false;
    if (bookId == null) bookId = await matchExternalCatalogBook(tx, user, destination.libraryId, item);
    if (bookId == null) {
      const folderPath = await this.externalFolderPath(tx, destination.libraryFolderId, item);
      const inserted = await tx
        .insert(schema.books)
        .values({
          libraryId: destination.libraryId,
          libraryFolderId: destination.libraryFolderId,
          folderPath,
          status: 'present',
          isFileless: true,
          catalogMediaKind: item.mediaKind,
        })
        .onConflictDoNothing()
        .returning({ id: schema.books.id });
      if (inserted[0]) {
        bookId = inserted[0].id;
        created = true;
      } else {
        const [samePath] = await tx
          .select({ id: schema.books.id })
          .from(schema.books)
          .where(and(eq(schema.books.libraryId, destination.libraryId), eq(schema.books.folderPath, folderPath)))
          .limit(1);
        if (!samePath) throw new BadRequestException('Could not reserve a catalog location for this book');
        bookId = samePath.id;
      }
    }
    if (bookId == null) throw new BadRequestException('Could not determine the catalog book');
    if (created) {
      await this.upsertMetadata(tx, bookId, item);
      await this.upsertAuthors(tx, bookId, item.authors);
    } else await verifyExistingTarget(bookId);
    await this.ensureProviderId(tx, bookId, item, existingBookId != null || existingSource?.bookId === bookId);
    const statusConflict = await this.upsertSourceAndStatus(tx, user.id, bookId, item, existingSource, statusPolicy);
    return { bookId, created, statusConflict };
  }

  private async ensureProviderId(tx: Transaction, bookId: number, item: ExternalCatalogItem, allowDifferent: boolean): Promise<void> {
    // Preserve an explicitly selected multi-format mapping; never replace a different provider ID.
    const [providerId] = await tx
      .select()
      .from(schema.bookProviderIds)
      .where(and(eq(schema.bookProviderIds.bookId, bookId), eq(schema.bookProviderIds.provider, 'yandexbooks')))
      .for('update');
    if (!providerId) {
      await tx
        .insert(schema.bookProviderIds)
        .values({ bookId, provider: 'yandexbooks', externalId: externalCatalogProviderId(item), sourceUrl: item.sourceUrl })
        .onConflictDoNothing();
      const [stored] = await tx
        .select()
        .from(schema.bookProviderIds)
        .where(and(eq(schema.bookProviderIds.bookId, bookId), eq(schema.bookProviderIds.provider, 'yandexbooks')));
      if (stored?.externalId !== externalCatalogProviderId(item))
        throw new ConflictException('The Yandex Books provider ID changed. Reload and try again.');
    } else if (providerId.externalId !== externalCatalogProviderId(item) && !allowDifferent) {
      throw new ConflictException('The book has a different Yandex Books provider ID. Link it explicitly.');
    }
  }

  private async externalFolderPath(tx: Transaction, libraryFolderId: number, item: ExternalCatalogItem): Promise<string> {
    const [folder] = await tx
      .select({ path: schema.libraryFolders.path })
      .from(schema.libraryFolders)
      .where(eq(schema.libraryFolders.id, libraryFolderId))
      .limit(1);
    if (!folder) throw new NotFoundException('Library folder not found');
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(item.externalId)) throw new BadRequestException('Invalid external catalog identifier');
    return `${folder.path.replace(/\/+$/, '')}/Yandex Books/${item.mediaKind}-${item.externalId}`;
  }

  private async findSourceIn(tx: Db | Transaction, userId: number, item: ExternalCatalogItem, lock = false): Promise<Source | null> {
    const query = tx
      .select()
      .from(schema.externalBookSources)
      .where(
        and(
          eq(schema.externalBookSources.userId, userId),
          eq(schema.externalBookSources.provider, item.provider),
          eq(schema.externalBookSources.externalId, item.externalId),
          eq(schema.externalBookSources.mediaKind, item.mediaKind),
        ),
      )
      .limit(1);
    const [source] = await (lock ? query.for('update') : query);
    return source ?? null;
  }

  private async upsertMetadata(tx: Transaction, bookId: number, item: ExternalCatalogItem): Promise<void> {
    await tx
      .insert(schema.bookMetadata)
      .values({
        bookId,
        title: item.title,
        description: item.description,
        language: item.language,
        pageCount: item.pageCount,
        isbn13: item.isbn?.replace(/[^0-9Xx]/g, '').slice(-13) || null,
      })
      .onConflictDoUpdate({
        target: schema.bookMetadata.bookId,
        set: {
          title: item.title,
          description: item.description,
          language: item.language,
          pageCount: item.pageCount,
          isbn13: item.isbn?.replace(/[^0-9Xx]/g, '').slice(-13) || null,
          updatedAt: new Date(),
        },
      });
  }

  private async upsertAuthors(tx: Transaction, bookId: number, authorsToUpsert: string[]): Promise<void> {
    const names = [...new Set(authorsToUpsert.map((name) => name.trim()).filter(Boolean))].slice(0, 50);
    if (!names.length) return;
    await tx.delete(schema.bookAuthors).where(eq(schema.bookAuthors.bookId, bookId));
    for (const [displayOrder, name] of names.entries()) {
      const [inserted] = await tx.insert(schema.authors).values({ name, sortName: name }).onConflictDoNothing().returning({ id: schema.authors.id });
      const author = inserted ?? (await tx.select({ id: schema.authors.id }).from(schema.authors).where(eq(schema.authors.name, name)).limit(1))[0];
      if (author) await tx.insert(schema.bookAuthors).values({ bookId, authorId: author.id, displayOrder });
    }
    await tx.update(schema.books).set({ primaryAuthorSortName: names[0], updatedAt: new Date() }).where(eq(schema.books.id, bookId));
  }

  private async upsertSourceAndStatus(
    tx: Transaction,
    userId: number,
    bookId: number,
    item: ExternalCatalogItem,
    source: Source | null,
    policy: ExternalStatusPolicy,
  ): Promise<boolean> {
    const now = new Date();
    const [currentStatus] = await tx
      .select()
      .from(schema.userBookStatus)
      .where(and(eq(schema.userBookStatus.userId, userId), eq(schema.userBookStatus.bookId, bookId)))
      .limit(1)
      .for('update', { of: schema.userBookStatus });
    const differs = item.status != null && (currentStatus?.status ?? 'unread') !== item.status;
    const canApplySafely =
      currentStatus == null ||
      (source == null && currentStatus.status === 'unread' && currentStatus.source === 'auto') ||
      (source?.bookId === bookId &&
        source.lastAppliedStatusAt != null &&
        currentStatus.source === 'auto' &&
        currentStatus.updatedAt <= source.lastAppliedStatusAt);
    let applyStatus = item.status != null && (policy === 'remote' || (policy === 'safe' && canApplySafely));
    let statusConflict = differs && policy === 'safe' && !canApplySafely;
    const startedAt = this.toDate(item.startedAt);
    const finishedAt = this.toDate(item.finishedAt);
    const validFinishedAt = startedAt && finishedAt && finishedAt < startedAt ? null : finishedAt;
    const projectionChanged =
      currentStatus == null ||
      currentStatus.status !== item.status ||
      currentStatus.source !== 'auto' ||
      (currentStatus.startedAt?.getTime() ?? null) !== (startedAt?.getTime() ?? null) ||
      (currentStatus.finishedAt?.getTime() ?? null) !== (validFinishedAt?.getTime() ?? null);
    applyStatus = applyStatus && projectionChanged;
    if (applyStatus) {
      if (currentStatus == null && policy === 'safe') {
        const inserted = await tx
          .insert(schema.userBookStatus)
          .values({ userId, bookId, status: item.status!, source: 'auto', startedAt, finishedAt: validFinishedAt, updatedAt: now })
          .onConflictDoNothing()
          .returning({ bookId: schema.userBookStatus.bookId });
        if (!inserted.length) {
          applyStatus = false;
          statusConflict = differs;
        }
      } else
        await tx
          .insert(schema.userBookStatus)
          .values({ userId, bookId, status: item.status!, source: 'auto', startedAt, finishedAt: validFinishedAt, updatedAt: now })
          .onConflictDoUpdate({
            target: [schema.userBookStatus.userId, schema.userBookStatus.bookId],
            set: { status: item.status!, source: 'auto', startedAt, finishedAt: validFinishedAt, updatedAt: now },
          });
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
      startedAt,
      finishedAt,
      sourceUpdatedAt: this.toDate(item.sourceUpdatedAt),
      syncedAt: now,
      lastAppliedStatusAt: applyStatus ? now : source?.bookId === bookId ? source.lastAppliedStatusAt : null,
    };
    await tx
      .insert(schema.externalBookSources)
      .values(values)
      .onConflictDoUpdate({
        target: [
          schema.externalBookSources.userId,
          schema.externalBookSources.provider,
          schema.externalBookSources.externalId,
          schema.externalBookSources.mediaKind,
        ],
        set: { ...values, bookId },
      });
    return statusConflict;
  }

  private toDate(value: string | null): Date | null {
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
}
