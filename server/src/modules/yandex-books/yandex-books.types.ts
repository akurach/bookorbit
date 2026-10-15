import type { ExternalCatalogItem, ReadStatus } from '@bookorbit/types';

export interface YandexProfile {
  id: string;
  login: string;
  name: string | null;
}

type YandexCard = {
  uuid?: unknown;
  state?: unknown;
  progress?: unknown;
  started_at?: unknown;
  finished_at?: unknown;
  accessed_at?: unknown;
  book?: unknown;
};

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function timestamp(value: unknown): string | null {
  const seconds = numberValue(value);
  return seconds && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
}

function authorsOf(book: Record<string, unknown>): string[] {
  const raw = book.authors_objects;
  if (Array.isArray(raw))
    return raw
      .map((author) => (author && typeof author === 'object' ? stringValue((author as Record<string, unknown>).name) : null))
      .filter((value): value is string => value !== null);
  const listed = book.authors;
  if (Array.isArray(listed))
    return listed
      .map((author) =>
        typeof author === 'string'
          ? stringValue(author)
          : author && typeof author === 'object'
            ? stringValue((author as Record<string, unknown>).name)
            : null,
      )
      .filter((value): value is string => value !== null);
  const flat = stringValue(listed);
  return flat ? [flat] : [];
}

function mapStatus(raw: string, progress: number | null): ReadStatus | null {
  if (raw === 'finished') return 'read';
  if (raw === 'reading' || raw === 'listening') return 'reading';
  if (raw === 'pending') return progress && progress > 0 ? 'on_hold' : 'unread';
  return null;
}

function sourceUrl(id: string, media: 'ebook' | 'audiobook' | 'comic'): string {
  const segment = media === 'ebook' ? 'books' : media === 'audiobook' ? 'audiobooks' : 'comicbooks';
  return `https://books.yandex.ru/${segment}/${encodeURIComponent(id)}`;
}

function coverUrl(value: unknown): string | null {
  if (typeof value === 'string') return stringValue(value);
  if (!value || typeof value !== 'object') return null;
  const cover = value as Record<string, unknown>;
  return stringValue(cover.large) ?? stringValue(cover.small);
}

function itemFromBook(input: {
  id: string;
  media: 'ebook' | 'audiobook' | 'comic';
  book: Record<string, unknown>;
  rawStatus: string;
  percentage: number | null;
  positionSeconds?: number | null;
  durationSeconds?: number | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  sourceUpdatedAt?: string | null;
}): ExternalCatalogItem {
  return {
    provider: 'yandexBooks',
    externalId: input.id,
    mediaKind: input.media,
    title: stringValue(input.book.title) ?? 'Untitled',
    authors: authorsOf(input.book),
    description: stringValue(input.book.annotation),
    language: stringValue(input.book.language),
    coverUrl: coverUrl(input.book.cover),
    pageCount: numberValue(input.book.paper_pages) ?? numberValue(input.book.pages_count),
    isbn: stringValue(input.book.isbn),
    sourceUrl: sourceUrl(input.id, input.media),
    remoteStatus: input.rawStatus,
    status: mapStatus(input.rawStatus, input.percentage),
    percentage: input.percentage,
    positionSeconds: input.positionSeconds ?? null,
    durationSeconds: input.durationSeconds ?? null,
    startedAt: input.startedAt ?? null,
    finishedAt: input.finishedAt ?? null,
    sourceUpdatedAt: input.sourceUpdatedAt ?? null,
  };
}

export function mapTextCard(value: unknown): ExternalCatalogItem | null {
  const card = value as YandexCard;
  const book = card?.book && typeof card.book === 'object' ? (card.book as Record<string, unknown>) : null;
  const id = book ? stringValue(book.uuid) : null;
  const state = stringValue(card?.state);
  if (!book || !id || !state) return null;
  const rawProgress = numberValue(card.progress);
  return itemFromBook({
    id,
    media: 'ebook',
    book,
    rawStatus: state,
    percentage: rawProgress === null || rawProgress < 0 || rawProgress > 100 ? null : rawProgress,
    startedAt: timestamp(card.started_at),
    finishedAt: timestamp(card.finished_at),
    sourceUpdatedAt: timestamp(card.accessed_at),
  });
}

export function mapAudio(value: unknown): ExternalCatalogItem | null {
  if (!value || typeof value !== 'object') return null;
  const book = value as Record<string, unknown>;
  const id = stringValue(book.uuid);
  const card = book.audio_card && typeof book.audio_card === 'object' ? (book.audio_card as Record<string, unknown>) : null;
  const state = card ? stringValue(card.state) : null;
  if (!id || !card || !state) return null;
  const duration = numberValue(book.duration);
  const position = numberValue(card.progress);
  const percentage = duration && duration > 0 && position !== null ? Math.max(0, Math.min(100, (position / duration) * 100)) : null;
  return itemFromBook({ id, media: 'audiobook', book, rawStatus: state, percentage, positionSeconds: position, durationSeconds: duration });
}

export function mapComic(value: unknown): ExternalCatalogItem | null {
  if (!value || typeof value !== 'object') return null;
  const book = value as Record<string, unknown>;
  const id = stringValue(book.uuid);
  const card = book.comic_card && typeof book.comic_card === 'object' ? (book.comic_card as Record<string, unknown>) : null;
  const state = card ? stringValue(card.state) : null;
  if (!id || !card || !state) return null;
  return itemFromBook({ id, media: 'comic', book, rawStatus: state, percentage: null });
}
