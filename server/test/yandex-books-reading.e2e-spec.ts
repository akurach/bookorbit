import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { Permission, type BookDetail, type ExternalCatalogItem } from '@bookorbit/types';

import * as schema from '../src/db/schema';
import { ExternalCatalogService } from '../src/modules/book/external-catalog.service';
import { UserService } from '../src/modules/user/user.service';
import { YandexBooksClientService } from '../src/modules/yandex-books/yandex-books-client.service';
import { buildFb2Fixture } from './e2e/authorization-matrix/authorization-matrix-fixture-builder';
import {
  authHeader,
  closeAuthorizationMatrixE2EContext,
  createAuthorizationMatrixE2EContext,
  createLibraryWithFolder,
  createUserAndLogin,
  grantLibraryAccess,
  triggerAndWaitForLibraryScan,
  type AuthorizationMatrixE2EContext,
  type TestUserSession,
} from './e2e/authorization-matrix/authorization-matrix-harness';

function item(overrides: Partial<ExternalCatalogItem> = {}): ExternalCatalogItem {
  const externalId = randomUUID();
  return {
    provider: 'yandexBooks',
    externalId,
    mediaKind: 'ebook',
    title: 'An imported test edition',
    authors: ['Fixture Author'],
    description: 'A synthetic source record, with no personal account data.',
    language: 'en',
    coverUrl: null,
    pageCount: 120,
    isbn: null,
    sourceUrl: `https://books.yandex.ru/books/${externalId}`,
    remoteStatus: 'reading',
    status: 'reading',
    percentage: 45,
    positionSeconds: null,
    durationSeconds: null,
    startedAt: '2025-01-02T00:00:00.000Z',
    finishedAt: null,
    sourceUpdatedAt: '2025-01-03T00:00:00.000Z',
    ...overrides,
  };
}

describe('Yandex Books catalog and reading state (e2e)', { timeout: 60_000 }, () => {
  let ctx: AuthorizationMatrixE2EContext;
  let catalog: ExternalCatalogService;
  let session: TestUserSession;
  let viewer: TestUserSession;
  const previousEncryptionKey = process.env.YANDEX_BOOKS_ENCRYPTION_KEY;

  beforeAll(async () => {
    process.env.YANDEX_BOOKS_ENCRYPTION_KEY = 'a1'.repeat(32);
    ctx = await createAuthorizationMatrixE2EContext();
    catalog = ctx.app.get(ExternalCatalogService);
    session = await createUserAndLogin(ctx, { permissions: [Permission.YandexBooksSync, Permission.LibraryUpload] });
    viewer = await createUserAndLogin(ctx);
  });

  afterAll(async () => {
    if (ctx) await closeAuthorizationMatrixE2EContext(ctx);
    if (previousEncryptionKey === undefined) delete process.env.YANDEX_BOOKS_ENCRYPTION_KEY;
    else process.env.YANDEX_BOOKS_ENCRYPTION_KEY = previousEncryptionKey;
  });

  async function user() {
    const result = await ctx.app.get(UserService).findByIdWithPermissions(session.userId);
    if (!result) throw new Error('Test user missing');
    return result;
  }

  async function detail(bookId: number, token = session.accessToken): Promise<BookDetail> {
    const response = await ctx.app.inject({ method: 'GET', url: `/api/v1/books/${bookId}`, headers: authHeader(token) });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<BookDetail>();
  }

  async function attach(bookId: number) {
    const boundary = `----bookorbit-yandex-${randomUUID()}`;
    const body = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fixture.fb2"\r\nContent-Type: application/octet-stream\r\n\r\n${buildFb2Fixture()}\r\n--${boundary}--\r\n`,
    );
    return ctx.app.inject({
      method: 'POST',
      url: `/api/v1/books/${bookId}/files`,
      headers: { ...authHeader(session.accessToken), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
  }

  it('imports idempotently without a file and retains the card across a full scan', async () => {
    const destination = await createLibraryWithFolder(ctx, { mode: 'book_per_folder' });
    await grantLibraryAccess(ctx, session.userId, destination.libraryId, 'editor');
    const source = item();
    const imported = await catalog.importItem(await user(), destination, source);
    const repeated = await catalog.importItem(await user(), destination, source);
    expect(repeated.bookId).toBe(imported.bookId);
    expect(imported.created).toBe(true);
    expect(repeated.created).toBe(false);
    expect(await ctx.db.select().from(schema.bookFiles).where(eq(schema.bookFiles.bookId, imported.bookId))).toHaveLength(0);

    const scan = await triggerAndWaitForLibraryScan(ctx, destination.libraryId);
    expect(scan.status).toBe('completed');
    const book = await detail(imported.bookId);
    expect(book.isFileless).toBe(true);
    expect(book.status).toBe('present');
    expect(book.files).toEqual([]);
    expect(book.externalReading).toEqual([expect.objectContaining({ percentage: 45, remoteStatus: 'reading' })]);
  });

  it('keeps snapshots private and preserves locally edited metadata and status', async () => {
    const destination = await createLibraryWithFolder(ctx, { mode: 'book_per_folder' });
    await grantLibraryAccess(ctx, session.userId, destination.libraryId, 'editor');
    await grantLibraryAccess(ctx, viewer.userId, destination.libraryId, 'viewer');
    const source = item();
    const imported = await catalog.importItem(await user(), destination, source);
    await ctx.db
      .update(schema.bookMetadata)
      .set({ title: 'My corrected title', lockedFields: ['title'] })
      .where(eq(schema.bookMetadata.bookId, imported.bookId));
    await ctx.db
      .update(schema.userBookStatus)
      .set({ status: 'abandoned', source: 'manual', updatedAt: new Date(Date.now() + 1_000) })
      .where(and(eq(schema.userBookStatus.userId, session.userId), eq(schema.userBookStatus.bookId, imported.bookId)));
    const next = { ...source, remoteStatus: 'finished', status: 'read' as const, percentage: 17 };
    const updated = await catalog.importItem(await user(), destination, next);
    expect(updated.statusConflict).toBe(true);
    const ownBook = await detail(imported.bookId);
    expect(ownBook.title).toBe('My corrected title');
    expect(ownBook.readStatus?.status).toBe('abandoned');
    expect(ownBook.externalReading?.[0]?.percentage).toBe(17);
    const otherBook = await detail(imported.bookId, viewer.accessToken);
    expect(otherBook.externalReading ?? []).toEqual([]);
    expect(otherBook.readStatus).toBeNull();

    await catalog.importItem(await user(), destination, next, imported.bookId, 'remote');
    expect((await detail(imported.bookId)).readStatus?.status).toBe('read');
    expect(await ctx.db.select().from(schema.readingSessions).where(eq(schema.readingSessions.bookId, imported.bookId))).toHaveLength(0);
  });

  it.each(['book_per_folder', 'book_per_file'] as const)(
    'attaches the first file in %s without changing identity or local positions',
    async (mode) => {
      const destination = await createLibraryWithFolder(ctx, { mode });
      await grantLibraryAccess(ctx, session.userId, destination.libraryId, 'editor');
      const source = item();
      const imported = await catalog.importItem(await user(), destination, source);
      const attached = await attach(imported.bookId);
      expect(attached.statusCode, attached.body).toBe(201);
      const [file] = await ctx.db.select().from(schema.bookFiles).where(eq(schema.bookFiles.bookId, imported.bookId));
      expect(file).toBeDefined();
      await ctx.db.insert(schema.readingProgress).values({
        userId: session.userId,
        bookFileId: file.id,
        percentage: 12,
        cfi: 'epubcfi(/6/2!/4/2:5)',
        koreaderProgress: '/body/DocFragment[1]/body/p[2]/text().4',
      });
      const before = await ctx.db
        .select()
        .from(schema.readingProgress)
        .where(and(eq(schema.readingProgress.userId, session.userId), eq(schema.readingProgress.bookFileId, file.id)));

      await catalog.importItem(await user(), destination, { ...source, percentage: 90 });
      const after = await ctx.db
        .select()
        .from(schema.readingProgress)
        .where(and(eq(schema.readingProgress.userId, session.userId), eq(schema.readingProgress.bookFileId, file.id)));
      expect(after).toEqual(before);
      const book = await detail(imported.bookId);
      expect(book.isFileless).toBe(false);
      expect(book.files).toHaveLength(1);
      expect(book.externalReading?.[0]?.percentage).toBe(90);
      await triggerAndWaitForLibraryScan(ctx, destination.libraryId);
      const catalogRows = await ctx.db.select().from(schema.books).where(eq(schema.books.libraryId, destination.libraryId));
      expect(catalogRows.map((row) => row.id)).toEqual([imported.bookId]);
    },
  );

  it('requires the new permission at the HTTP boundary', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/api/v1/yandex-books/settings', headers: authHeader(viewer.accessToken) });
    expect(response.statusCode).toBe(403);
  });

  it('previews and imports through HTTP, updates idempotently and fences an in-flight disconnect', async () => {
    const destination = await createLibraryWithFolder(ctx, { mode: 'book_per_folder' });
    await grantLibraryAccess(ctx, session.userId, destination.libraryId, 'editor');
    const client = ctx.app.get(YandexBooksClientService);
    vi.spyOn(client, 'getProfile').mockResolvedValue({ id: 'fixture-account', login: 'fixture-reader', name: 'Fixture Reader' });
    const source = [item(), item({ mediaKind: 'audiobook', percentage: 75 }), item({ mediaKind: 'comic', percentage: null })];
    const pages = vi.spyOn(client, 'collectPages').mockImplementation(async function* () {
      yield await Promise.resolve(source);
    });
    const request = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, payload?: Record<string, unknown>) =>
      ctx.app.inject({ method, url: `/api/v1/yandex-books/${path}`, headers: authHeader(session.accessToken), ...(payload ? { payload } : {}) });
    const waitForIdle = async () => {
      await vi.waitFor(
        async () => {
          const settings = (await request('GET', 'settings')).json();
          expect(settings.syncing).toBe(false);
          expect(settings.lastError).toBeNull();
        },
        { timeout: 10_000, interval: 20 },
      );
    };
    const saved = await request('PATCH', 'settings', {
      apiToken: 'fixture-only-secret',
      libraryId: destination.libraryId,
      libraryFolderId: destination.libraryFolderId,
      autoSync: true,
      intervalHours: 24,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.body).not.toContain('fixture-only-secret');
    expect(saved.json().tokenConfigured).toBe(true);
    const stored = await ctx.db.query.yandexBooksSettings.findFirst({ where: eq(schema.yandexBooksSettings.userId, session.userId) });
    expect(stored?.encryptedToken).not.toContain('fixture-only-secret');
    expect((await request('POST', 'sync', { preview: true })).statusCode).toBe(202);
    await waitForIdle();
    const staged = await request('GET', 'entries?page=1&pageSize=2');
    expect(staged.statusCode, staged.body).toBe(200);
    expect(staged.json().items).toHaveLength(2);
    expect(staged.json().total).toBe(3);
    expect(await ctx.db.select().from(schema.books).where(eq(schema.books.libraryId, destination.libraryId))).toHaveLength(0);

    expect((await request('POST', 'import', {})).statusCode).toBe(202);
    await waitForIdle();
    expect(await ctx.db.select().from(schema.books).where(eq(schema.books.libraryId, destination.libraryId))).toHaveLength(3);
    source[0] = { ...source[0]!, percentage: 66 };
    expect((await request('POST', 'sync', {})).statusCode).toBe(202);
    await waitForIdle();
    const imported = (await request('GET', 'entries?pageSize=10')).json();
    const first = imported.items.find((entry: { item: ExternalCatalogItem }) => entry.item.externalId === source[0]!.externalId);
    expect((await detail(first.bookId)).externalReading?.[0]?.percentage).toBe(66);
    expect(await ctx.db.select().from(schema.books).where(eq(schema.books.libraryId, destination.libraryId))).toHaveLength(3);

    let unblock!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      reached = resolve;
    });
    pages.mockImplementation(async function* () {
      yield [item()];
      reached();
      await gate;
      yield [item()];
    });
    expect((await request('POST', 'sync', {})).statusCode).toBe(202);
    await entered;
    try {
      expect((await request('DELETE', 'settings')).statusCode).toBe(200);
    } finally {
      unblock();
    }
    await vi.waitFor(async () => {
      expect(await ctx.db.select().from(schema.yandexBooksStaging).where(eq(schema.yandexBooksStaging.userId, session.userId))).toHaveLength(0);
    });
    expect((await request('GET', 'settings')).json().tokenConfigured).toBe(false);
    expect((await request('GET', 'entries')).json().total).toBe(0);
    expect(await ctx.db.select().from(schema.books).where(eq(schema.books.libraryId, destination.libraryId))).toHaveLength(3);
    vi.restoreAllMocks();
  });
});
