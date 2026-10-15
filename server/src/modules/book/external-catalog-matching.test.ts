import { describe, expect, it } from 'vitest';

import type { ExternalCatalogItem } from '@bookorbit/types';

import {
  canonicalExternalCatalogIsbn,
  externalCatalogTitleSearchKind,
  isSafeExternalCatalogTitleMatch,
  normalizeExternalCatalogAuthors,
  normalizeExternalCatalogTitle,
  type ExternalCatalogMatchCandidate,
} from './external-catalog-matching';

const item: ExternalCatalogItem = {
  provider: 'yandexBooks',
  externalId: 'edition-1',
  mediaKind: 'ebook',
  title: 'Путь к реальности',
  authors: ['Юдковский'],
  description: null,
  language: 'ru',
  coverUrl: null,
  pageCount: null,
  isbn: '978-0-306-40615-7',
  sourceUrl: 'https://books.yandex.ru/books/edition-1',
  remoteStatus: 'reading',
  status: 'reading',
  percentage: null,
  positionSeconds: null,
  durationSeconds: null,
  startedAt: null,
  finishedAt: null,
  sourceUpdatedAt: null,
};

const candidate = (changes: Partial<ExternalCatalogMatchCandidate> = {}): ExternalCatalogMatchCandidate => ({
  id: 1,
  title: item.title,
  language: 'ru',
  isbn10: null,
  isbn13: '9780306406157',
  yandexBooksId: null,
  catalogMediaKind: null,
  format: 'epub',
  authors: ['Юдковский'],
  ...changes,
});

describe('external catalog matching keys', () => {
  it('normalizes Cyrillic title case and punctuation without making transliteration equivalent', () => {
    expect(normalizeExternalCatalogTitle(' Гарри Поттер: и Кубок огня ')).toBe('гаррипоттерикубокогня');
    expect(normalizeExternalCatalogTitle('Harry Potter')).not.toBe(normalizeExternalCatalogTitle('Гарри Поттер'));
  });

  it('treats author order as irrelevant while retaining a different spelling as a different author', () => {
    expect(normalizeExternalCatalogAuthors(['Нил Гейман', 'Терри Пратчетт'])).toEqual(
      normalizeExternalCatalogAuthors(['Терри Пратчетт', 'Нил Гейман']),
    );
    expect(normalizeExternalCatalogAuthors(['Юдковский'])).not.toEqual(normalizeExternalCatalogAuthors(['Юдковски']));
    expect(normalizeExternalCatalogAuthors(['Йошкар-Ола'])).not.toEqual(normalizeExternalCatalogAuthors(['Иошкар-Ола']));
  });

  it('canonicalizes valid ISBN-10 and ISBN-13 forms and rejects invalid checksums', () => {
    expect(canonicalExternalCatalogIsbn('0-306-40615-2')).toBe('9780306406157');
    expect(canonicalExternalCatalogIsbn('978-0-306-40615-7')).toBe('9780306406157');
    expect(canonicalExternalCatalogIsbn('978-0-306-40615-8')).toBeNull();
  });

  it('uses exact indexed title lookup for short titles instead of skipping matching', () => {
    expect(externalCatalogTitleSearchKind('It')).toBe('exact');
    expect(externalCatalogTitleSearchKind('Оно')).toBe('probe');
  });

  it('rejects incompatible media, language, edition, and author candidates', () => {
    expect(isSafeExternalCatalogTitleMatch(candidate(), item)).toBe(true);
    expect(isSafeExternalCatalogTitleMatch(candidate({ format: 'm4b' }), item)).toBe(false);
    expect(isSafeExternalCatalogTitleMatch(candidate({ language: 'en' }), item)).toBe(false);
    expect(isSafeExternalCatalogTitleMatch(candidate({ isbn13: '9780441172719' }), item)).toBe(false);
    expect(isSafeExternalCatalogTitleMatch(candidate({ yandexBooksId: 'edition-2' }), item)).toBe(false);
    expect(isSafeExternalCatalogTitleMatch(candidate({ authors: ['Юдковски'] }), item)).toBe(false);
  });
});
