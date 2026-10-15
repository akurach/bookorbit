import { randomUUID } from 'crypto';
import { readdir } from 'fs/promises';
import { join } from 'path';

import { eq } from 'drizzle-orm';
import { MetadataProviderKey } from '@bookorbit/types';

import * as schema from '../src/db/schema';
import { closeE2EContext, createE2EContext, type E2EContext } from './e2e/app-harness';

const SCENARIO_TIMEOUT_MS = 60_000;
const YANDEX_GRAPHQL_URL = 'https://api-gateway.bookmate.yandex.net/graphql';
const COVER_URL = 'https://8.8.8.8/bookorbit-yandex-e2e-cover.png';
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWPgUbL4D8IMGAwAaEMIX38E8cgAAAAASUVORK5CYII=',
  'base64',
);
const nativeFetch = globalThis.fetch;

type SearchEvent = Record<string, unknown>;

function authHeader(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function parseSearchEvents(body: string): SearchEvent[] {
  return body
    .split('\n\n')
    .map((frame) => frame.split('\n').find((line) => line.startsWith('data:')))
    .filter((line): line is string => line !== undefined)
    .map((line) => JSON.parse(line.slice('data:'.length).trim()) as SearchEvent);
}

async function setYandexEnabled(ctx: E2EContext, enabled: boolean): Promise<void> {
  const response = await ctx.app.inject({
    method: 'PUT',
    url: '/api/v1/metadata-preferences/providers',
    headers: authHeader(ctx.adminToken),
    payload: { yandexBooks: { enabled } },
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ yandexBooks: { enabled } });
}

async function seedBook(ctx: E2EContext): Promise<{ bookId: number; tagName: string }> {
  const suffix = randomUUID();
  const [library] = await ctx.db
    .insert(schema.libraries)
    .values({ name: `yandex-metadata-e2e-${suffix}`, organizationMode: 'book_per_file', watch: false })
    .returning({ id: schema.libraries.id });
  const [folder] = await ctx.db
    .insert(schema.libraryFolders)
    .values({ libraryId: library.id, path: `/yandex-metadata-e2e/${suffix}` })
    .returning({ id: schema.libraryFolders.id });
  const [book] = await ctx.db
    .insert(schema.books)
    .values({
      libraryId: library.id,
      libraryFolderId: folder.id,
      folderPath: `/yandex-metadata-e2e/${suffix}/book`,
    })
    .returning({ id: schema.books.id });
  const [file] = await ctx.db
    .insert(schema.bookFiles)
    .values({
      bookId: book.id,
      libraryFolderId: folder.id,
      absolutePath: `/yandex-metadata-e2e/${suffix}/book.epub`,
      relPath: 'book.epub',
      ino: 1n,
      sizeBytes: 1,
      mtime: new Date(),
      format: 'epub',
      role: 'content',
    })
    .returning({ id: schema.bookFiles.id });
  await ctx.db.update(schema.books).set({ primaryFileId: file.id }).where(eq(schema.books.id, book.id));
  await ctx.db.insert(schema.bookMetadata).values({
    bookId: book.id,
    title: 'Selected Yandex title',
    subtitle: 'Original local subtitle',
    publisher: 'Original local publisher',
    isbn13: '9780306406157',
  });
  const tagName = `retain-this-tag-${suffix}`;
  const [tag] = await ctx.db.insert(schema.tags).values({ name: tagName }).returning({ id: schema.tags.id });
  await ctx.db.insert(schema.bookTags).values({ bookId: book.id, tagId: tag.id });
  return { bookId: book.id, tagName };
}

describe('Yandex Books metadata provider (e2e)', { timeout: SCENARIO_TIMEOUT_MS }, () => {
  let ctx!: E2EContext;
  let origin!: string;

  beforeAll(async () => {
    ctx = await createE2EContext({ isolateAppData: true, realMetadata: true });
    await ctx.app.listen(0, '127.0.0.1');
    origin = await ctx.app.getUrl();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    if (ctx) await closeE2EContext(ctx);
  });

  it('enables Yandex over HTTP, searches through the real provider, and applies the selected candidate without losing unrelated metadata', async () => {
    const { bookId, tagName } = await seedBook(ctx);
    const fetchMock = vi.fn((input: string | URL | Request): Promise<Response> => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url === YANDEX_GRAPHQL_URL) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                search: {
                  page: [
                    {
                      __typename: 'TextBook',
                      book: {
                        uuid: 'YandexE2E42',
                        title: 'Selected Yandex title',
                        authors: [{ name: 'Yandex Author' }],
                        annotation: 'Metadata returned by the deterministic Yandex fixture.',
                        publisher: { name: 'Yandex Publisher' },
                        language: 'ru',
                        paper_pages: 384,
                        original_year: 2024,
                        topics: [{ name: 'Science fiction' }],
                        cover: { url: COVER_URL },
                      },
                    },
                  ],
                },
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      if (url === COVER_URL) return Promise.resolve(new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } }));
      return Promise.reject(new Error(`Unexpected external request: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    await setYandexEnabled(ctx, true);

    const search = await nativeFetch(
      `${origin}/api/v1/metadata-fetch/stream?bookId=${bookId}&title=${encodeURIComponent('Selected Yandex title')}&providers=${MetadataProviderKey.YANDEX_BOOKS}&cache=refresh`,
      {
        headers: authHeader(ctx.adminToken),
        signal: AbortSignal.timeout(30_000),
      },
    );
    expect(search.status).toBe(200);
    expect(search.headers.get('content-type')).toContain('text/event-stream');

    const events = parseSearchEvents(await search.text());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(YANDEX_GRAPHQL_URL);
    expect(events).toContainEqual(expect.objectContaining({ provider: MetadataProviderKey.YANDEX_BOOKS, providerId: 'YandexE2E42' }));

    const [candidate] = events.filter((event) => event.providerId === 'YandexE2E42');
    expect(candidate).toMatchObject({
      provider: MetadataProviderKey.YANDEX_BOOKS,
      providerId: 'YandexE2E42',
      title: 'Selected Yandex title',
      authors: ['Yandex Author'],
      coverUrl: COVER_URL,
      coverShape: 'portrait',
    });

    const apply = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/books/${bookId}/metadata`,
      headers: authHeader(ctx.adminToken),
      payload: {
        title: candidate.title,
        authors: candidate.authors,
        description: candidate.description,
        publisher: candidate.publisher,
        language: candidate.language,
        pageCount: candidate.pageCount,
        publishedYear: candidate.publishedYear,
        genres: candidate.genres,
        yandexBooksId: candidate.providerId,
      },
    });
    expect(apply.statusCode).toBe(200);
    expect(apply.json()).toMatchObject({
      providerIds: { yandexBooks: 'YandexE2E42' },
      authors: [{ name: 'Yandex Author' }],
      genres: ['Science fiction'],
      isbn13: '9780306406157',
      tags: [tagName],
    });

    const uploadCover = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/books/${bookId}/cover/from-url?medium=ebook`,
      headers: authHeader(ctx.adminToken),
      payload: { url: candidate.coverUrl },
    });
    expect(uploadCover.statusCode).toBe(204);

    const [stored] = await ctx.db.select().from(schema.bookMetadata).where(eq(schema.bookMetadata.bookId, bookId));
    expect(stored).toMatchObject({
      title: 'Selected Yandex title',
      yandexBooksId: 'YandexE2E42',
      isbn13: '9780306406157',
    });

    const detail = await ctx.app.inject({ method: 'GET', url: `/api/v1/books/${bookId}`, headers: authHeader(ctx.adminToken) });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      providerIds: { yandexBooks: 'YandexE2E42' },
      isbn13: '9780306406157',
      authors: [{ name: 'Yandex Author' }],
      genres: ['Science fiction'],
      tags: [tagName],
      covers: { ebook: { source: 'custom' } },
    });
    const coverFiles = await readdir(join(ctx.isolatedAppData!.path, 'covers', String(bookId), 'ebook'));
    expect(coverFiles.some((file) => file.startsWith('cover_custom.'))).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not issue an upstream request while Yandex is disabled or when the request contains only an ISBN', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await setYandexEnabled(ctx, false);
    const disabled = await nativeFetch(
      `${origin}/api/v1/metadata-fetch/stream?title=Disabled&providers=${MetadataProviderKey.YANDEX_BOOKS}&cache=refresh`,
      {
        headers: authHeader(ctx.adminToken),
        signal: AbortSignal.timeout(30_000),
      },
    );
    expect(disabled.status).toBe(200);
    expect(parseSearchEvents(await disabled.text())).toEqual([]);

    await setYandexEnabled(ctx, true);
    const isbnOnly = await nativeFetch(
      `${origin}/api/v1/metadata-fetch/stream?isbn=9780306406157&providers=${MetadataProviderKey.YANDEX_BOOKS}&cache=refresh`,
      {
        headers: authHeader(ctx.adminToken),
        signal: AbortSignal.timeout(30_000),
      },
    );
    expect(isbnOnly.status).toBe(200);
    expect(parseSearchEvents(await isbnOnly.text())).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
