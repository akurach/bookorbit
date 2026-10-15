import { BadRequestException } from '@nestjs/common';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { getBookMediaKind, type ConcreteBookMediaKind, type ExternalCatalogItem } from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import { buildContentFilterClauses } from '../../common/utils/content-filter-sql.utils';
import { canonicalIsbn13 } from '../../common/text-match/isbn-normalize';
import * as schema from '../../db/schema';

const MAX_CANDIDATES = 24;

type Db = NodePgDatabase<typeof schema>;
type Transaction = Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Db | Transaction;

export type ExternalCatalogMatchCandidate = {
  id: number;
  title: string | null;
  language: string | null;
  isbn10: string | null;
  isbn13: string | null;
  yandexBooksId: string | null;
  catalogMediaKind: string | null;
  format: string | null;
  authors: string[];
};
type Candidate = ExternalCatalogMatchCandidate;
type CandidateSearch = { candidates: Candidate[]; saturated: boolean };

export function normalizeExternalCatalogTitle(value: string | null | undefined): string | null {
  const normalized = (value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
  return normalized || null;
}

export function normalizeExternalCatalogAuthors(values: readonly string[]): string[] {
  return [...new Set(values.map(normalizeExternalCatalogTitle).filter((value): value is string => value != null))].sort();
}

function isbn10ForCanonicalIsbn13(value: string): string | null {
  if (!value.startsWith('978')) return null;
  const body = value.slice(3, 12);
  let sum = 0;
  for (let index = 0; index < body.length; index += 1) sum += Number(body[index]) * (10 - index);
  const check = (11 - (sum % 11)) % 11;
  return `${body}${check === 10 ? 'X' : check}`;
}

export function canonicalExternalCatalogIsbn(value: string | null | undefined): string | null {
  return canonicalIsbn13(value) ?? null;
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function mediaKindForCandidate(candidate: Candidate): ConcreteBookMediaKind | null {
  if (candidate.format) {
    const kind = getBookMediaKind(candidate.format);
    return kind === 'unknown' ? null : kind;
  }
  if (candidate.catalogMediaKind === 'ebook' || candidate.catalogMediaKind === 'audiobook' || candidate.catalogMediaKind === 'comic') {
    return candidate.catalogMediaKind;
  }
  return null;
}

function normalizeLanguage(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLocaleLowerCase();
  return normalized || null;
}

function hasContradictoryEdition(candidate: Candidate, item: ExternalCatalogItem): boolean {
  const candidateLanguage = normalizeLanguage(candidate.language);
  const itemLanguage = normalizeLanguage(item.language);
  if (candidateLanguage && itemLanguage && candidateLanguage !== itemLanguage) return true;

  const candidateIsbn = canonicalExternalCatalogIsbn(candidate.isbn13) ?? canonicalExternalCatalogIsbn(candidate.isbn10);
  const itemIsbn = canonicalExternalCatalogIsbn(item.isbn);
  if (candidateIsbn && itemIsbn && candidateIsbn !== itemIsbn) return true;

  return item.mediaKind === 'ebook' && candidate.yandexBooksId != null && candidate.yandexBooksId !== item.externalId;
}

export function isSafeExternalCatalogTitleMatch(candidate: ExternalCatalogMatchCandidate, item: ExternalCatalogItem): boolean {
  if (mediaKindForCandidate(candidate) !== item.mediaKind || hasContradictoryEdition(candidate, item)) return false;
  const itemAuthors = normalizeExternalCatalogAuthors(item.authors);
  return itemAuthors.length > 0 && sameSet(normalizeExternalCatalogAuthors(candidate.authors), itemAuthors);
}

function titleProbe(title: string): string | null {
  return (
    title
      .normalize('NFKC')
      .split(/[^\p{L}\p{N}]+/u)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3)
      .sort((left, right) => right.length - left.length)[0] ?? null
  );
}

export function externalCatalogTitleSearchKind(title: string): 'probe' | 'exact' {
  return titleProbe(title) ? 'probe' : 'exact';
}

function candidateClauses(user: RequestUser, libraryId: number, executor: Executor) {
  return [eq(schema.books.libraryId, libraryId), ...(user.isSuperuser ? [] : buildContentFilterClauses(user.contentFilters, executor as Db))];
}

async function hydrateCandidates(executor: Executor, rows: Omit<Candidate, 'authors'>[]): Promise<Candidate[]> {
  if (rows.length === 0) return [];
  const authorRows = await executor
    .select({ bookId: schema.bookAuthors.bookId, name: schema.authors.name })
    .from(schema.bookAuthors)
    .innerJoin(schema.authors, eq(schema.authors.id, schema.bookAuthors.authorId))
    .where(
      inArray(
        schema.bookAuthors.bookId,
        rows.map((row) => row.id),
      ),
    );
  const authorsByBook = new Map<number, string[]>();
  for (const row of authorRows) authorsByBook.set(row.bookId, [...(authorsByBook.get(row.bookId) ?? []), row.name]);
  return rows.map((row) => ({ ...row, authors: authorsByBook.get(row.id) ?? [] }));
}

async function findCandidates(executor: Executor, user: RequestUser, libraryId: number, where: ReturnType<typeof and>): Promise<CandidateSearch> {
  const rows = await executor
    .select({
      id: schema.books.id,
      title: schema.bookMetadata.title,
      language: schema.bookMetadata.language,
      isbn10: schema.bookMetadata.isbn10,
      isbn13: schema.bookMetadata.isbn13,
      yandexBooksId: schema.bookMetadata.yandexBooksId,
      catalogMediaKind: schema.books.catalogMediaKind,
      format: schema.bookFiles.format,
    })
    .from(schema.books)
    .innerJoin(schema.bookMetadata, eq(schema.bookMetadata.bookId, schema.books.id))
    .leftJoin(schema.bookFiles, eq(schema.bookFiles.id, schema.books.primaryFileId))
    .where(and(...candidateClauses(user, libraryId, executor), where))
    .limit(MAX_CANDIDATES + 1);
  return { candidates: await hydrateCandidates(executor, rows.slice(0, MAX_CANDIDATES)), saturated: rows.length > MAX_CANDIDATES };
}

function uniqueOrConflict(candidates: Candidate[], message: string): number | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!.id;
  throw new BadRequestException(message);
}

/**
 * Finds a local edition only when its identity is unambiguous. A title collision is deliberately
 * surfaced as a manual-link conflict: assigning somebody else's progress is worse than a new card.
 */
export async function matchExternalCatalogBook(
  tx: Executor,
  user: RequestUser,
  libraryId: number,
  item: ExternalCatalogItem,
): Promise<number | null> {
  const sourceRows = await tx
    .select({ id: schema.books.id })
    .from(schema.externalBookSources)
    .innerJoin(schema.books, eq(schema.books.id, schema.externalBookSources.bookId))
    .where(
      and(
        ...candidateClauses(user, libraryId, tx),
        eq(schema.externalBookSources.userId, user.id),
        eq(schema.externalBookSources.provider, item.provider),
        eq(schema.externalBookSources.externalId, item.externalId),
        eq(schema.externalBookSources.mediaKind, item.mediaKind),
      ),
    )
    .limit(2);
  const sourceMatch = uniqueOrConflict(
    sourceRows.map((row) => ({ id: row.id }) as Candidate),
    'More than one local book has this external source. Link one explicitly.',
  );
  if (sourceMatch != null) return sourceMatch;

  if (item.mediaKind === 'ebook') {
    const yandexSearch = await findCandidates(tx, user, libraryId, eq(schema.bookMetadata.yandexBooksId, item.externalId));
    if (yandexSearch.saturated) throw new BadRequestException('Too many local books have this Yandex Books edition. Link one explicitly.');
    const yandexMatch = uniqueOrConflict(yandexSearch.candidates, 'More than one book has this Yandex Books edition. Link one explicitly.');
    if (yandexMatch != null && mediaKindForCandidate(yandexSearch.candidates[0]!) !== item.mediaKind) {
      throw new BadRequestException('A Yandex Books edition is attached to an incompatible local media type. Link one explicitly.');
    }
    if (yandexMatch != null) return yandexMatch;
  }

  const canonicalIsbn = canonicalExternalCatalogIsbn(item.isbn);
  if (canonicalIsbn) {
    const equivalentIsbn10 = isbn10ForCanonicalIsbn13(canonicalIsbn);
    const isbnSearch = await findCandidates(
      tx,
      user,
      libraryId,
      equivalentIsbn10
        ? or(eq(schema.bookMetadata.isbn13, canonicalIsbn), eq(schema.bookMetadata.isbn10, equivalentIsbn10))!
        : eq(schema.bookMetadata.isbn13, canonicalIsbn),
    );
    if (isbnSearch.saturated) throw new BadRequestException('Too many local books have this ISBN. Link one explicitly.');
    const sameMediumMatches = isbnSearch.candidates.filter((candidate) => mediaKindForCandidate(candidate) === item.mediaKind);
    if (sameMediumMatches.some((candidate) => hasContradictoryEdition(candidate, item))) {
      throw new BadRequestException('A local book has this ISBN but conflicting edition metadata. Link one explicitly.');
    }
    const compatibleMatches = sameMediumMatches;
    const isbnMatch = uniqueOrConflict(compatibleMatches, 'More than one local book has this ISBN and media type. Link one explicitly.');
    if (isbnMatch != null) return isbnMatch;
  }

  const normalizedTitle = normalizeExternalCatalogTitle(item.title);
  if (!normalizedTitle) return null;
  const probe = externalCatalogTitleSearchKind(item.title) === 'probe' ? titleProbe(item.title) : null;
  const titleSearch = await findCandidates(
    tx,
    user,
    libraryId,
    probe
      ? sql`public.bookorbit_unaccent(${schema.bookMetadata.title}) ILIKE public.bookorbit_unaccent(${`%${probe}%`})`
      : sql`lower(${schema.bookMetadata.title}) = lower(${item.title.trim()})`,
  );
  if (titleSearch.saturated) throw new BadRequestException('Too many local books match this title. Link one explicitly.');
  const sameTitle = titleSearch.candidates.filter((candidate) => normalizeExternalCatalogTitle(candidate.title) === normalizedTitle);
  const sameMedium = sameTitle.filter((candidate) => mediaKindForCandidate(candidate) === item.mediaKind);
  if (sameMedium.length === 0) return null;

  const compatible = sameMedium.filter((candidate) => isSafeExternalCatalogTitleMatch(candidate, item));
  if (compatible.length !== sameMedium.length) {
    throw new BadRequestException('A local book has the same title but cannot be matched safely. Link it explicitly.');
  }
  const match = uniqueOrConflict(compatible, 'More than one local book matches this title and authors. Link one explicitly.');
  if (match != null) return match;

  throw new BadRequestException('A local book has the same title but cannot be matched safely. Link it explicitly.');
}
