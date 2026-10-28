import { randomUUID } from 'crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readdir } from 'fs/promises';
import { join } from 'path';

import { and, eq } from 'drizzle-orm';
import * as schema from '../src/db/schema';
import { closeE2EContext, createE2EContext, type E2EContext } from './e2e/app-harness';

const KEY = 'yandexbooks';
const ID = 'book-MWxAop5b';
const COVER_URL = 'https://8.8.8.8/bookorbit-yandex-e2e-cover.png';
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWPgUbL4D8IMGAwAaEMIX38E8cgAAAAASUVORK5CYII=',
  'base64',
);
const nativeFetch = globalThis.fetch;
const authHeader = (token: string) => ({ authorization: `Bearer ${token}` });

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

describe('Yandex Books external metadata provider (e2e)', { timeout: 60_000 }, () => {
  let ctx: E2EContext;
  let server: Server;
  let baseUrl: string;
  let origin: string;
  let providerId: number;
  let unavailable = false;
  const calls: string[] = [];
  const record = (id: string) => ({
    providerId: id,
    title: 'Selected Yandex title',
    authors: ['Yandex Author'],
    description: 'Fixture description',
    publisher: 'Yandex Publisher',
    cover: COVER_URL,
    url: `https://books.yandex.ru/books/${id}`,
  });
  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
    ctx.app.inject({ method, url: `/api/v1${url}`, headers: authHeader(ctx.adminToken), ...(payload ? { payload } : {}) });

  beforeAll(async () => {
    server = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://fixture').pathname;
      calls.push(path);
      expect(req.headers.authorization).toBeUndefined();
      if (unavailable) {
        res.writeHead(503);
        res.end();
        return;
      }
      res.setHeader('content-type', 'application/json');
      if (path === '/provider/info')
        res.end(
          JSON.stringify({
            name: 'Yandex Books',
            key: KEY,
            version: '0.1.0',
            lookup: true,
            mediaTypes: ['book', 'audiobook', 'comic'],
            searchParams: ['limit'],
            supportedFields: ['title', 'description', 'publisher'],
          }),
        );
      else if (path === '/search') res.end(JSON.stringify({ matches: [record(ID)] }));
      else if (['/book/book-MWxAop5b', '/book/audiobook-VTVT8GzC', '/book/comicbook-yjrd9dHo'].includes(path))
        res.end(JSON.stringify(record(path.slice('/book/'.length))));
      else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    ctx = await createE2EContext({ isolateAppData: true, realMetadata: true });
    await ctx.app.listen(0, '127.0.0.1');
    origin = await ctx.app.getUrl();
    const created = await call('POST', '/metadata-http-providers', { baseUrl, allowPrivateAddress: true });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ key: KEY, enabled: false, hasAuthorization: false });
    providerId = created.json().id;
  });

  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => {
    if (ctx) await closeE2EContext(ctx);
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('searches, looks up all media IDs, and applies metadata and cover to the database', async () => {
    const { bookId, tagName } = await seedBook(ctx);
    expect((await call('PATCH', `/metadata-http-providers/${providerId}`, { enabled: true })).statusCode).toBe(200);
    const search = await nativeFetch(
      `${origin}/api/v1/metadata-fetch/stream?bookId=${bookId}&title=Selected%20Yandex%20title&providers=${KEY}&cache=refresh`,
      { headers: authHeader(ctx.adminToken), signal: AbortSignal.timeout(30_000) },
    );
    expect(search.status).toBe(200);
    const events = (await search.text()).split('\n\n').flatMap((frame) =>
      frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => JSON.parse(line.slice(5).trim())),
    );
    const candidate = events.find((event) => event.providerId === ID);
    expect(candidate).toMatchObject({
      provider: KEY,
      providerId: ID,
      title: 'Selected Yandex title',
      authors: ['Yandex Author'],
      coverUrl: COVER_URL,
    });
    for (const id of [ID, 'audiobook-VTVT8GzC', 'comicbook-yjrd9dHo']) {
      const lookup = await call('GET', `/metadata-fetch/lookup?provider=${KEY}&id=${id}`);
      expect(lookup.statusCode).toBe(200);
      expect(lookup.json()).toMatchObject({ provider: KEY, providerId: id });
      expect(calls).toContain(`/book/${id}`);
    }
    const applied = await call('PATCH', `/books/${bookId}/metadata`, {
      title: candidate.title,
      authors: candidate.authors,
      description: candidate.description,
      publisher: candidate.publisher,
      externalProviderIds: { [KEY]: ID },
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toMatchObject({ providerIds: { [KEY]: ID }, isbn13: '9780306406157', tags: [tagName] });
    const [storedId] = await ctx.db
      .select()
      .from(schema.bookProviderIds)
      .where(and(eq(schema.bookProviderIds.bookId, bookId), eq(schema.bookProviderIds.provider, KEY)));
    expect(storedId).toMatchObject({ externalId: ID });
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      return url === COVER_URL
        ? Promise.resolve(new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } }))
        : nativeFetch(input, init);
    });
    const cover = await call('POST', `/books/${bookId}/cover/from-url?medium=ebook`, { url: candidate.coverUrl });
    expect(cover.statusCode).toBe(204);
    const detail = await call('GET', `/books/${bookId}`);
    expect(detail.json()).toMatchObject({ providerIds: { [KEY]: ID }, covers: { ebook: { source: 'custom' } } });
    const files = await readdir(join(ctx.isolatedAppData!.path, 'covers', String(bookId), 'ebook'));
    expect(files.some((file) => file.startsWith('cover_custom.'))).toBe(true);
  });

  it('excludes a disabled provider and reports an unavailable provider as a failure', async () => {
    expect((await call('PATCH', `/metadata-http-providers/${providerId}`, { enabled: false })).statusCode).toBe(200);
    const providers = await call('GET', '/metadata-fetch/providers');
    expect(providers.json().map((provider: { key: string }) => provider.key)).not.toContain(KEY);
    const count = calls.length;
    const lookup = await call('GET', `/metadata-fetch/lookup?provider=${KEY}&id=${ID}`);
    expect(lookup.json()).toBeNull();
    expect(calls).toHaveLength(count);
    unavailable = true;
    const tested = await call('POST', `/metadata-http-providers/${providerId}/test`, {});
    expect(tested.statusCode).toBe(200);
    expect(tested.json()).toMatchObject({ ok: false, resultCount: null, error: expect.any(String) });
    unavailable = false;
  });
});
