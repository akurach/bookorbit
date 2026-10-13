import { MetadataCandidate, MetadataProviderKey } from '@bookorbit/types';

import { boundProviderId } from '../../../../common/utils/provider-id.utils';
import { YandexBook, YandexBookPublisher, YandexBookTopic } from './yandex-books.types';

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function objects(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item))
    : [];
}

function valuesByName(value: unknown, field: 'name' | 'title'): string[] | undefined {
  const values = objects(value)
    .map((item) => text(item[field]))
    .filter((item): item is string => item !== undefined);
  return values.length > 0 ? [...new Set(values)] : undefined;
}

function authorsOf(book: YandexBook): string[] | undefined {
  const objectAuthors = valuesByName(book.authors_objects, 'name') ?? valuesByName(book.authors, 'name');
  if (objectAuthors) return objectAuthors;
  return text(book.authors)
    ?.split(',')
    .map((author) => author.trim())
    .filter(Boolean);
}

function publisherOf(book: YandexBook): string | undefined {
  const publisher = book.publisher;
  if (typeof publisher === 'object' && publisher !== null && !Array.isArray(publisher)) {
    const name = text((publisher as YandexBookPublisher).name);
    if (name) return name;
  }
  return valuesByName(book.publishers, 'name')?.[0];
}

function genresOf(book: YandexBook): string[] | undefined {
  const values = objects(book.topics)
    .map((topic) => text((topic as YandexBookTopic).title) ?? text((topic as YandexBookTopic).name))
    .filter((item): item is string => item !== undefined);
  return values.length > 0 ? [...new Set(values)] : undefined;
}

function safeUrl(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && url.hostname.length > 0 && !url.username && !url.password ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function coverOf(book: YandexBook): string | undefined {
  if (typeof book.cover !== 'object' || book.cover === null || Array.isArray(book.cover)) return undefined;
  const cover = book.cover as { url?: unknown; large?: unknown; small?: unknown };
  return safeUrl(cover.large) ?? safeUrl(cover.url) ?? safeUrl(cover.small);
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function yearOf(book: YandexBook): number | undefined {
  const year = positiveInteger(book.original_year);
  return year !== undefined && year >= 1000 && year <= 2200 ? year : undefined;
}

function providerIdOf(book: YandexBook): string | undefined {
  const value = text(book.uuid);
  return value ? (boundProviderId('yandexBooksId', value) ?? undefined) : undefined;
}

export function mapYandexBook(book: YandexBook): MetadataCandidate | null {
  const providerId = providerIdOf(book);
  const title = text(book.title) ?? text(book.name);
  if (!providerId || !title) return null;

  const coverUrl = coverOf(book);
  return {
    provider: MetadataProviderKey.YANDEX_BOOKS,
    providerId,
    title,
    authors: authorsOf(book),
    description: text(book.annotation) ?? text(book.editor_annotation) ?? text(book.editorAnnotation),
    publisher: publisherOf(book),
    language: text(book.language),
    pageCount: positiveInteger(book.paper_pages),
    publishedYear: yearOf(book),
    genres: genresOf(book),
    coverUrl,
    ...(coverUrl ? { coverShape: 'portrait' as const } : {}),
    sourceUrl: `https://books.yandex.ru/books/${encodeURIComponent(providerId)}`,
  };
}
