import { BadRequestException } from '@nestjs/common';
import { and, eq, is, sql } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { ExternalCatalogItem } from '@bookorbit/types';
import * as schema from '../../db/schema';
import { externalCatalogProviderId } from './external-catalog-matching';

const { books, bookMetadata, bookAuthors, authors, bookCovers, externalBookSources, userBookStatus, yandexBooksEntries, readingAttempts } = schema;
type Transaction = Parameters<Parameters<NodePgDatabase<typeof schema>['transaction']>[0]>[0];
const protectedMessage = 'This imported card has files, local changes or other references. Keep it and review the books before changing the link.';
const explicitlyChecked = new Set<PgTable>([
  bookMetadata,
  bookAuthors,
  bookCovers,
  externalBookSources,
  userBookStatus,
  yandexBooksEntries,
  readingAttempts,
  schema.bookProviderIds,
]);

// Fail closed for new features referencing books, including references that cascade on deletion.
const protectedReferences = Object.values(schema).flatMap((table) => {
  if (!is(table, PgTable) || explicitlyChecked.has(table)) return [];
  return getTableConfig(table).foreignKeys.flatMap((key) => {
    const reference = key.reference();
    if (reference.foreignTable !== books) return [];
    const index = reference.foreignColumns.indexOf(books.id);
    return index < 0 ? [] : [{ table, column: reference.columns[index]! }];
  });
});

export async function assertPristineExternalPlaceholder(
  tx: Transaction,
  userId: number,
  bookId: number,
  entryId: number,
  targetBookId: number,
  item: ExternalCatalogItem,
  source: typeof externalBookSources.$inferSelect,
): Promise<typeof readingAttempts.$inferSelect | null> {
  const reject = () => {
    throw new BadRequestException(protectedMessage);
  };
  const [book] = await tx.select().from(books).where(eq(books.id, bookId)).for('update');
  if (!book?.isFileless || book.primaryFileId || book.catalogMediaKind !== item.mediaKind || book.status !== 'present') reject();
  if (book.primaryAuthorSortName !== (item.authors.map((name) => name.trim()).filter(Boolean)[0] ?? null)) reject();
  const [metadata] = await tx.select().from(bookMetadata).where(eq(bookMetadata.bookId, bookId)).for('update');
  if (!metadata) reject();
  const expected: Record<string, unknown> = {
    bookId,
    title: item.title,
    description: item.description,
    language: item.language,
    pageCount: item.pageCount,
    isbn13: item.isbn?.replace(/[^0-9Xx]/g, '').slice(-13) || null,
    yandexBooksId: metadata.yandexBooksId === null ? null : item.mediaKind === 'ebook' ? item.externalId : null,
    abridged: false,
    chapterCount: 0,
    numberedChapterCount: 0,
    manifestLegacyRecorded: false,
    lockedFields: [],
  };
  for (const [key, value] of Object.entries(metadata)) {
    // The search index is derived automatically when a catalog card is viewed.
    if (['updatedAt', 'coverUpdatedAt', 'embedding'].includes(key)) continue;
    if (key === 'coverSource') {
      if (value !== null && value !== 'extracted') reject();
      continue;
    }
    if (JSON.stringify(value) !== JSON.stringify(expected[key] ?? null)) reject();
  }
  const authorRows = await tx
    .select({ name: authors.name })
    .from(bookAuthors)
    .innerJoin(authors, eq(authors.id, bookAuthors.authorId))
    .where(eq(bookAuthors.bookId, bookId))
    .orderBy(bookAuthors.displayOrder)
    .for('update', { of: bookAuthors });
  if (
    JSON.stringify(authorRows.map((row) => row.name)) !==
    JSON.stringify([...new Set(item.authors.map((name) => name.trim()).filter(Boolean))].slice(0, 50))
  )
    reject();
  const providerIds = await tx.select().from(schema.bookProviderIds).where(eq(schema.bookProviderIds.bookId, bookId)).for('update');
  if (
    providerIds.some(
      (id) =>
        id.provider !== 'yandexbooks' ||
        id.externalId !== externalCatalogProviderId(item) ||
        (id.sourceUrl !== item.sourceUrl && !(id.sourceUrl === null && metadata.yandexBooksId === item.externalId)),
    )
  )
    reject();
  const covers = await tx.select().from(bookCovers).where(eq(bookCovers.bookId, bookId)).for('update');
  if (covers.some((cover) => cover.source !== 'extracted' || cover.origin !== 'provider')) reject();
  const sources = await tx.select().from(externalBookSources).where(eq(externalBookSources.bookId, bookId)).for('update');
  if (sources.length !== 1 || sources[0]!.id !== source.id || source.userId !== userId) reject();
  const entries = await tx.select().from(yandexBooksEntries).where(eq(yandexBooksEntries.bookId, bookId)).for('update');
  if (entries.length !== 1 || entries[0]!.id !== entryId || entries[0]!.userId !== userId) reject();
  const statuses = await tx.select().from(userBookStatus).where(eq(userBookStatus.bookId, bookId)).for('update');
  if (
    statuses.some(
      (status) =>
        status.userId !== userId || status.source !== 'auto' || !source.lastAppliedStatusAt || status.updatedAt > source.lastAppliedStatusAt,
    )
  )
    reject();
  // Startup backfill materializes a source status as one migration attempt. Preserve
  // that row when correcting its book link, but never combine two local histories.
  const attempts = await tx.select().from(readingAttempts).where(eq(readingAttempts.bookId, bookId)).limit(2).for('update');
  const migratedAttempt = attempts[0] ?? null;
  if (
    attempts.length > 1 ||
    (migratedAttempt &&
      (migratedAttempt.userId !== userId ||
        migratedAttempt.origin !== 'migration' ||
        migratedAttempt.deletedAt !== null ||
        migratedAttempt.externalProvider !== null ||
        migratedAttempt.externalId !== null ||
        migratedAttempt.rating !== null ||
        migratedAttempt.bookTitleSnapshot !== null ||
        migratedAttempt.bookAuthorsSnapshot !== null ||
        migratedAttempt.bookFormatSnapshot !== null ||
        migratedAttempt.bookPageCountSnapshot !== null ||
        migratedAttempt.bookLibraryIdSnapshot !== null ||
        migratedAttempt.bookRemovedAt !== null ||
        migratedAttempt.createdAt.getTime() !== migratedAttempt.updatedAt.getTime()))
  )
    reject();
  if (migratedAttempt) {
    const existing = await tx
      .select({ id: readingAttempts.id })
      .from(readingAttempts)
      .where(and(eq(readingAttempts.bookId, targetBookId), eq(readingAttempts.userId, userId)))
      .limit(1);
    if (existing.length) reject();
  }
  const [references] = await tx
    .select({
      found: sql<boolean>`(${sql.join(
        protectedReferences.map(({ table, column }) => sql`exists(select 1 from ${table} where ${column} = ${bookId})`),
        sql` or `,
      )})`,
    })
    .from(books)
    .where(eq(books.id, bookId));
  if (references?.found) reject();
  // The row lock on books also blocks concurrent FK inserts (e.g. a newly attached file).
  const [entry] = await tx
    .select({ id: yandexBooksEntries.id })
    .from(yandexBooksEntries)
    .where(and(eq(yandexBooksEntries.id, entryId), eq(yandexBooksEntries.bookId, bookId), eq(yandexBooksEntries.userId, userId)));
  if (!entry) reject();
  return migratedAttempt;
}
