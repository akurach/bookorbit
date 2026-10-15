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
    session = await createUserAndLogin(ctx, { permissions: [Permission.YandexBooksSync, Permission.LibraryUpload, Permission.LibraryDeleteBooks] });
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
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fixture-${bookId}.fb2"\r\nContent-Type: application/octet-stream\r\n\r\n${buildFb2Fixture({ title: `Fixture ${bookId}` })}\r\n--${boundary}--\r\n`,
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

  async function localBook(destination: Awaited<ReturnType<typeof createLibraryWithFolder>>, source: ExternalCatalogItem) {
    const imported = await catalog.importItem(await user(), destination, { ...source, title: `Fixture ${randomUUID()}` });
    expect((await attach(imported.bookId)).statusCode).toBe(201);
    await ctx.db.delete(schema.externalBookSources).where(eq(schema.externalBookSources.bookId, imported.bookId));
    await ctx.db.delete(schema.userBookStatus).where(eq(schema.userBookStatus.bookId, imported.bookId));
    await ctx.db.update(schema.bookMetadata).set({ title: source.title, yandexBooksId: null }).where(eq(schema.bookMetadata.bookId, imported.bookId));
    return imported.bookId;
  }

  async function importedEntry(bookId: number, source: ExternalCatalogItem) {
    const [entry] = await ctx.db
      .insert(schema.yandexBooksEntries)
      .values({
        userId: session.userId,
        accountId: 'dedup-fixture',
        externalId: source.externalId,
        mediaKind: source.mediaKind,
        snapshot: source,
        bookId,
        state: 'imported',
        generation: randomUUID(),
      })
      .returning();
    return entry;
  }

  it('matches a pre-existing local file without a Yandex id and preserves metadata and local positions', async () => {
    const destination = await createLibraryWithFolder(ctx, { mode: 'book_per_folder' });
    await grantLibraryAccess(ctx, session.userId, destination.libraryId, 'editor');
    const source = item({ title: 'Морана и Тень. Видящий', authors: ['Лия Арден'], language: 'ru' });
    const bookId = await localBook(destination, source);
    const [file] = await ctx.db.select().from(schema.bookFiles).where(eq(schema.bookFiles.bookId, bookId));
    await ctx.db.insert(schema.readingProgress).values({ userId: session.userId, bookFileId: file.id, percentage: 12, cfi: 'local-position' });
    const before = await ctx.db.select().from(schema.bookMetadata).where(eq(schema.bookMetadata.bookId, bookId));
    const imported = await catalog.importItem(await user(), destination, { ...source, title: 'МОРАНА И ТЕНЬ: ВИДЯЩИЙ', percentage: 90 });
    expect(imported).toEqual({ bookId, created: false, statusConflict: false });
    expect(await ctx.db.select().from(schema.bookMetadata).where(eq(schema.bookMetadata.bookId, bookId))).toEqual(before);
    const book = await detail(bookId);
    expect(book.files).toHaveLength(1);
    expect(book.externalReading?.[0]?.percentage).toBe(90);
    expect((await ctx.db.select().from(schema.readingProgress).where(eq(schema.readingProgress.bookFileId, file.id)))[0].cfi).toBe('local-position');
    expect(await ctx.db.select().from(schema.books).where(eq(schema.books.libraryId, destination.libraryId))).toHaveLength(1);
    expect((await catalog.importItem(await user(), destination, source)).bookId).toBe(bookId);
  });

  it('reuses an equivalent ISBN-10 and refuses two equally matching local copies', async () => {
    const destination = await createLibraryWithFolder(ctx, { mode: 'book_per_folder' });
    await grantLibraryAccess(ctx, session.userId, destination.libraryId, 'editor');
    const source = item({ title: 'ISBN fixture', isbn: '978-0-306-40615-7' });
    const bookId = await localBook(destination, source);
    await ctx.db.update(schema.bookMetadata).set({ isbn10: '0306406152', isbn13: null }).where(eq(schema.bookMetadata.bookId, bookId));
    expect((await catalog.importItem(await user(), destination, { ...source, title: 'Alternate catalog title' })).bookId).toBe(bookId);
    await ctx.db.delete(schema.externalBookSources).where(eq(schema.externalBookSources.bookId, bookId));
    const [copy] = await ctx.db
      .insert(schema.books)
      .values({
        libraryId: destination.libraryId,
        libraryFolderId: destination.libraryFolderId,
        folderPath: '/duplicate-copy',
        isFileless: true,
        catalogMediaKind: 'ebook',
      })
      .returning();
    await ctx.db.insert(schema.bookMetadata).values({ bookId: copy.id, title: 'Another copy', isbn13: '9780306406157' });
    await expect(catalog.importItem(await user(), destination, source)).rejects.toThrow('More than one');
    expect(await ctx.db.select().from(schema.books).where(eq(schema.books.libraryId, destination.libraryId))).toHaveLength(2);
  });

  it('refuses ambiguous authors without making a duplicate, and lets an explicit link resolve the match', async () => {
    const destination = await createLibraryWithFolder(ctx, { mode: 'book_per_folder' });
    await grantLibraryAccess(ctx, session.userId, destination.libraryId, 'editor');
    const source = item({ title: 'Гарри Поттер и методы рационального мышления', authors: ['Элиезер Юдковский'], language: 'ru' });
    const bookId = await localBook(destination, source);
    const remote = { ...source, authors: ['Элиезер Юдковски'] };
    await expect(catalog.importItem(await user(), destination, remote)).rejects.toThrow('Link');
    expect(await ctx.db.select().from(schema.books).where(eq(schema.books.libraryId, destination.libraryId))).toHaveLength(1);
    expect((await catalog.importItem(await user(), destination, remote, bookId)).bookId).toBe(bookId);
    const audio = await catalog.importItem(await user(), destination, { ...source, mediaKind: 'audiobook' });
    expect(audio.bookId).not.toBe(bookId);
  });

  it('repairs an existing empty duplicate atomically and keeps the physical book, manual status and progress', async () => {
    const destination = await createLibraryWithFolder(ctx, { mode: 'book_per_folder' });
    await grantLibraryAccess(ctx, session.userId, destination.libraryId, 'editor');
    const source = item({ title: 'Repair fixture' });
    // Simulate the previous importer: the fileless card predates the local copy.
    const duplicate = await catalog.importItem(await user(), destination, source);
    const entry = await importedEntry(duplicate.bookId, source);
    const bookId = await localBook(destination, { ...source, externalId: randomUUID() });
    await ctx.db.insert(schema.userBookStatus).values({ userId: session.userId, bookId, status: 'read', source: 'manual' });
    const [file] = await ctx.db.select().from(schema.bookFiles).where(eq(schema.bookFiles.bookId, bookId));
    await ctx.db.insert(schema.readingProgress).values({ userId: session.userId, bookFileId: file.id, percentage: 99, cfi: 'keep-me' });
    const before = await ctx.db.select().from(schema.bookFiles).where(eq(schema.bookFiles.bookId, bookId));
    await expect(catalog.relinkItem(await user(), destination, source, duplicate.bookId, duplicate.bookId, entry.id, 'safe')).rejects.toThrow(
      'different',
    );
    const moved = await catalog.relinkItem(await user(), destination, source, duplicate.bookId, bookId, entry.id, 'safe');
    expect(moved).toEqual({ bookId, statusConflict: true });
    expect(await ctx.db.select().from(schema.books).where(eq(schema.books.id, duplicate.bookId))).toEqual([]);
    expect(await ctx.db.select().from(schema.bookFiles).where(eq(schema.bookFiles.bookId, bookId))).toEqual(before);
    expect((await detail(bookId)).readStatus?.status).toBe('read');
    expect((await ctx.db.select().from(schema.readingProgress).where(eq(schema.readingProgress.bookFileId, file.id)))[0].cfi).toBe('keep-me');
    const [saved] = await ctx.db.select().from(schema.yandexBooksEntries).where(eq(schema.yandexBooksEntries.id, entry.id));
    expect(saved.bookId).toBe(bookId);
    const [sourceRow] = await ctx.db.select().from(schema.externalBookSources).where(eq(schema.externalBookSources.externalId, source.externalId));
    expect(sourceRow.bookId).toBe(bookId);
    expect(sourceRow.lastAppliedStatusAt).toBeNull();
    expect((await catalog.importItem(await user(), destination, source)).bookId).toBe(bookId);
  });

  it.each(['file', 'note', 'metadata', 'manualStatus', 'otherUser', 'permission'] as const)(
    'preserves an imported card with %s when relinking is unsafe',
    async (reason) => {
      const destination = await createLibraryWithFolder(ctx, { mode: 'book_per_folder' });
      await grantLibraryAccess(ctx, session.userId, destination.libraryId, 'editor');
      const source = item({ title: `Protected ${reason}` });
      const duplicate = await catalog.importItem(await user(), destination, source);
      const entry = await importedEntry(duplicate.bookId, source);
      const bookId = await localBook(destination, { ...source, externalId: randomUUID() });
      if (reason === 'file') expect((await attach(duplicate.bookId)).statusCode).toBe(201);
      if (reason === 'note')
        await ctx.db.insert(schema.userBookNotes).values({ userId: session.userId, bookId: duplicate.bookId, note: 'Keep my note' });
      if (reason === 'metadata')
        await ctx.db.update(schema.bookMetadata).set({ title: 'Edited title' }).where(eq(schema.bookMetadata.bookId, duplicate.bookId));
      if (reason === 'manualStatus')
        await ctx.db
          .update(schema.userBookStatus)
          .set({ status: 'read', source: 'manual' })
          .where(eq(schema.userBookStatus.bookId, duplicate.bookId));
      if (reason === 'otherUser')
        await ctx.db.insert(schema.userBookStatus).values({ userId: viewer.userId, bookId: duplicate.bookId, status: 'read' });
      const actor = await user();
      if (reason === 'permission') actor.permissions = actor.permissions.filter((permission) => permission !== Permission.LibraryDeleteBooks);
      await expect(catalog.relinkItem(actor, destination, source, duplicate.bookId, bookId, entry.id, 'safe')).rejects.toThrow();
      expect(await ctx.db.select().from(schema.books).where(eq(schema.books.id, duplicate.bookId))).toHaveLength(1);
      expect(
        (await ctx.db.select().from(schema.externalBookSources).where(eq(schema.externalBookSources.externalId, source.externalId)))[0].bookId,
      ).toBe(duplicate.bookId);
      expect((await ctx.db.select().from(schema.yandexBooksEntries).where(eq(schema.yandexBooksEntries.id, entry.id)))[0].bookId).toBe(
        duplicate.bookId,
      );
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

    const existingLocalBook = await localBook(destination, { ...source[0]!, externalId: randomUUID() });
    const relinked = await request('POST', `entries/${first.id}/link`, { bookId: existingLocalBook });
    expect(relinked.statusCode, relinked.body).toBe(201);
    expect(relinked.json().bookId).toBe(existingLocalBook);
    expect((await detail(existingLocalBook)).externalReading?.[0]?.percentage).toBe(66);
    expect(await ctx.db.select().from(schema.books).where(eq(schema.books.id, first.bookId))).toEqual([]);
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
