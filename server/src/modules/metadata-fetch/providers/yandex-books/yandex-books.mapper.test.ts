import { MetadataProviderKey } from '@bookorbit/types';

import { mapYandexBook } from './yandex-books.mapper';

describe('mapYandexBook', () => {
  it('maps only confirmed text-book metadata from a REST lookup', () => {
    const candidate = mapYandexBook({
      uuid: 'mqK3FFjg',
      title: 'Бюро темных дел',
      annotation: 'Аннотация',
      language: 'ru',
      paper_pages: 376,
      original_year: 2021,
      authors_objects: [{ name: 'Эрик Фуасье' }],
      publishers: [{ name: 'РИПОЛ Классик' }],
      topics: [{ title: 'Детективы' }, { name: 'Художественная литература' }, { title: 'Детективы' }],
      cover: { large: 'https://api.bookmate.ru/assets/books-covers/mqK3FFjg.jpeg' },
    });

    expect(candidate).toEqual(
      expect.objectContaining({
        provider: MetadataProviderKey.YANDEX_BOOKS,
        providerId: 'mqK3FFjg',
        title: 'Бюро темных дел',
        authors: ['Эрик Фуасье'],
        publisher: 'РИПОЛ Классик',
        genres: ['Детективы', 'Художественная литература'],
        language: 'ru',
        pageCount: 376,
        publishedYear: 2021,
        coverUrl: 'https://api.bookmate.ru/assets/books-covers/mqK3FFjg.jpeg',
        coverShape: 'portrait',
        sourceUrl: 'https://books.yandex.ru/books/mqK3FFjg',
      }),
    );
    expect(candidate).not.toHaveProperty('isbn13');
  });

  it('does not invent a year from a publication timestamp and rejects unsafe covers', () => {
    const candidate = mapYandexBook({
      uuid: 'abc123',
      name: 'Книга',
      authors: 'Первый, Второй',
      publication_date: 1733086800,
      cover: { large: 'javascript:alert(1)' },
    });

    expect(candidate).toEqual(
      expect.objectContaining({
        authors: ['Первый', 'Второй'],
        coverUrl: undefined,
        publishedYear: undefined,
      }),
    );
  });

  it('keeps only storage-safe opaque IDs and API-valid years', () => {
    expect(mapYandexBook({ uuid: 'book-id', title: 'Книга' })).toBeNull();
    expect(mapYandexBook({ uuid: 'A'.repeat(256), title: 'Книга' })).toBeNull();
    expect(mapYandexBook({ uuid: 'CaseSensitive123', title: 'Книга', original_year: 2201 })).toEqual(
      expect.objectContaining({ providerId: 'CaseSensitive123', publishedYear: undefined }),
    );
  });

  it('rejects records without an opaque provider id or title', () => {
    expect(mapYandexBook({ uuid: 'id-only' })).toBeNull();
    expect(mapYandexBook({ title: 'title-only' })).toBeNull();
  });
});
