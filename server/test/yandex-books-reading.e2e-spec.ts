import { randomUUID } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { Permission, type BookDetail, type ExternalCatalogItem } from '@bookorbit/types';

import * as schema from '../src/db/schema';
import { ExternalCatalogService } from '../src/modules/book/external-catalog.service';
import { DashboardWidgetService } from '../src/modules/dashboard/dashboard-widget.service';
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

  afterEach(async () => {
    vi.restoreAllMocks();
    await ctx.db.delete(schema.yandexBooksSettings).where(eq(schema.yandexBooksSettings.userId, session.userId));
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

  async function reader(userId: number) {
    const result = await ctx.app.get(UserService).findByIdWithPermissions(userId);
    if (!result) throw new Error('Test reader missing');
    return result;
  }

  async function detail(bookId: number, token = session.accessToken): Promise<BookDetail> {
    const response = await ctx.app.inject({ method: 'GET', url: `/api/v1/books/${bookId}`, headers: authHeader(token) });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<BookDetail>();
  }

  async function attach(bookId: number) {
    return attachFor(session, bookId);
  }

  async function attachFor(actor: TestUserSession, bookId: number) {
    const boundary = `----bookorbit-yandex-${randomUUID()}`;
    const body = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fixture-${bookId}.fb2"\r\nContent-Type: application/octet-stream\r\n\r\n${buildFb2Fixture({ title: `Fixture ${bookId}` })}\r\n--${boundary}--\r\n`,
    );
    return ctx.app.inject({
      method: 'POST',
      url: `/api/v1/books/${bookId}/files`,
      headers: { ...authHeader(actor.accessToken), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
  }

  async function currentlyReading(token: string) {
    const response = await ctx.app.inject({ method: 'GET', url: '/api/v1/dashboard/widgets/currently-reading', headers: authHeader(token) });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ books: Array<{ bookId: number; progress: number }> }>().books;
  }

  function clearCurrentlyReadingCache(userId: number) {
    ctx.app.get(DashboardWidgetService).clearCacheForUser(userId);
  }

  async function createIsolatedReader() {
    const actor = await createUserAndLogin(ctx, {
      permissions: [Permission.YandexBooksSync, Permission.LibraryUpload, Permission.LibraryDeleteBooks],
    });
    const destination = await createLibraryWithFolder(ctx, { mode: 'book_per_folder' });
    await grantLibraryAccess(ctx, actor.userId, destination.libraryId, 'editor');
    return { actor, destination, actorUser: await reader(actor.userId) };
  }

  async function localBookFor(
    actor: TestUserSession,
    actorUser: Awaited<ReturnType<typeof reader>>,
    destination: Awaited<ReturnType<typeof createLibraryWithFolder>>,
    source: ExternalCatalogItem,
  ) {
    const imported = await catalog.importItem(actorUser, destination, { ...source, title: `Fixture ${randomUUID()}` });
    expect((await attachFor(actor, imported.bookId)).statusCode).toBe(201);
    await ctx.db.delete(schema.externalBookSources).where(eq(schema.externalBookSources.bookId, imported.bookId));
    await ctx.db.delete(schema.bookProviderIds).where(eq(schema.bookProviderIds.bookId, imported.bookId));
    await ctx.db.delete(schema.bookProviderIds).where(eq(schema.bookProviderIds.bookId, imported.bookId));
    await ctx.db
      .delete(schema.userBookStatus)
      .where(and(eq(schema.userBookStatus.userId, actor.userId), eq(schema.userBookStatus.bookId, imported.bookId)));
    await ctx.db.update(schema.bookMetadata).set({ title: source.title, yandexBooksId: null }).where(eq(schema.bookMetadata.bookId, imported.bookId));
    const [file] = await ctx.db.select().from(schema.bookFiles).where(eq(schema.bookFiles.bookId, imported.bookId));
    if (!file) throw new Error('Local fixture file missing');
    return { bookId: imported.bookId, fileId: file.id };
  }

  const request = (token: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, payload?: Record<string, unknown>) =>
    ctx.app.inject({
      method,
      url: `/api/v1/yandex-books/${path}`,
      headers: authHeader(token),
      ...(payload ? { payload } : {}),
    });

  async function waitForSync(token: string, expected: Partial<{ needsReauth: boolean; lastError: string | null }> = {}) {
    await vi.waitFor(
      async () => {
        const settings = (await request(token, 'GET', 'settings')).json();
        expect(settings.syncing).toBe(false);
        for (const [key, value] of Object.entries(expected)) expect(settings[key]).toBe(value);
      },
      { timeout: 10_000, interval: 20 },
    );
  }

  async function connect(token: string, destination: Awaited<ReturnType<typeof createLibraryWithFolder>>, apiToken: string) {
    const response = await request(token, 'PATCH', 'settings', {
      apiToken,
      libraryId: destination.libraryId,
      libraryFolderId: destination.libraryFolderId,
      autoSync: false,
      intervalHours: 24,
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
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
    expect(book.providerIds.yandexbooks).toBe(`book-${source.externalId}`);
    expect(book.externalReading).toEqual([expect.objectContaining({ percentage: 45, remoteStatus: 'reading' })]);
  });

  it.each(['ebook', 'audiobook', 'comic'] as const)('reuses a native %s provider ID despite different metadata', async (mediaKind) => {
    const destination = await createLibraryWithFolder(ctx, { mode: 'book_per_folder' });
    await grantLibraryAccess(ctx, session.userId, destination.libraryId, 'editor');
    const source = item({ mediaKind, title: `Native ${randomUUID()}`, externalId: `Case${randomUUID()}` });
    const first = await catalog.importItem(await user(), destination, source);
    const expected = `${{ ebook: 'book', audiobook: 'audiobook', comic: 'comicbook' }[mediaKind]}-${source.externalId}`;
    const [stored] = await ctx.db.select().from(schema.bookProviderIds).where(eq(schema.bookProviderIds.bookId, first.bookId));
    expect(stored).toEqual(expect.objectContaining({ provider: 'yandexbooks', externalId: expected, sourceUrl: source.sourceUrl }));
    expect((await detail(first.bookId)).providerIds.yandexbooks).toBe(expected);
    await ctx.db.delete(schema.externalBookSources).where(eq(schema.externalBookSources.bookId, first.bookId));
    await ctx.db.update(schema.bookMetadata).set({ title: 'A completely different title' }).where(eq(schema.bookMetadata.bookId, first.bookId));
    const second = await catalog.importItem(await user(), destination, { ...source, authors: ['Different Author'] });
    expect(second.bookId).toBe(first.bookId);
    expect(second.created).toBe(false);
  });

  it('does not rewrite an owned status for repeated identical safe or remote imports, but applies a changed remote status', async () => {
    const { actor, destination, actorUser } = await createIsolatedReader();
    const source = item({ title: 'Idempotent status ownership fixture', startedAt: '2025-01-02T00:00:00.000Z' });
    const imported = await catalog.importItem(actorUser, destination, source);
    const ownershipAt = new Date('2025-02-01T00:00:00.000Z');
    const staleSync = new Date('2025-01-01T00:00:00.000Z');
    await ctx.db
      .update(schema.userBookStatus)
      .set({ updatedAt: ownershipAt, source: 'auto' })
      .where(and(eq(schema.userBookStatus.userId, actor.userId), eq(schema.userBookStatus.bookId, imported.bookId)));
    await ctx.db
      .update(schema.externalBookSources)
      .set({ lastAppliedStatusAt: ownershipAt, syncedAt: staleSync })
      .where(and(eq(schema.externalBookSources.userId, actor.userId), eq(schema.externalBookSources.bookId, imported.bookId)));

    await catalog.importItem(actorUser, destination, source, imported.bookId, 'safe');
    await catalog.importItem(actorUser, destination, source, imported.bookId, 'remote');
    const [unchangedStatus] = await ctx.db
      .select()
      .from(schema.userBookStatus)
      .where(and(eq(schema.userBookStatus.userId, actor.userId), eq(schema.userBookStatus.bookId, imported.bookId)));
    const [unchangedSource] = await ctx.db
      .select()
      .from(schema.externalBookSources)
      .where(and(eq(schema.externalBookSources.userId, actor.userId), eq(schema.externalBookSources.bookId, imported.bookId)));
    expect(unchangedStatus.updatedAt).toEqual(ownershipAt);
    expect(unchangedSource.lastAppliedStatusAt).toEqual(ownershipAt);
    expect(unchangedSource.syncedAt.getTime()).toBeGreaterThan(staleSync.getTime());

    const changed = { ...source, remoteStatus: 'finished', status: 'read' as const, finishedAt: '2025-02-10T00:00:00.000Z' };
    await catalog.importItem(actorUser, destination, changed, imported.bookId, 'remote');
    const [appliedStatus] = await ctx.db
      .select()
      .from(schema.userBookStatus)
      .where(and(eq(schema.userBookStatus.userId, actor.userId), eq(schema.userBookStatus.bookId, imported.bookId)));
    const [appliedSource] = await ctx.db
      .select()
      .from(schema.externalBookSources)
      .where(and(eq(schema.externalBookSources.userId, actor.userId), eq(schema.externalBookSources.bookId, imported.bookId)));
    expect(appliedStatus).toMatchObject({ status: 'read', finishedAt: new Date('2025-02-10T00:00:00.000Z') });
    expect(appliedStatus.updatedAt.getTime()).toBeGreaterThan(ownershipAt.getTime());
    expect(appliedSource.lastAppliedStatusAt?.getTime()).toBeGreaterThan(ownershipAt.getTime());
  });

  it('keeps the status ownership marker when a local manual edit blocks a safe import', async () => {
    const { actor, destination, actorUser } = await createIsolatedReader();
    const source = item({ title: 'Manual ownership fixture' });
    const imported = await catalog.importItem(actorUser, destination, source);
    const ownershipAt = new Date('2025-02-01T00:00:00.000Z');
    const manualAt = new Date('2025-02-02T00:00:00.000Z');
    await ctx.db
      .update(schema.externalBookSources)
      .set({ lastAppliedStatusAt: ownershipAt })
      .where(and(eq(schema.externalBookSources.userId, actor.userId), eq(schema.externalBookSources.bookId, imported.bookId)));
    await ctx.db
      .update(schema.userBookStatus)
      .set({ status: 'abandoned', source: 'manual', updatedAt: manualAt })
      .where(and(eq(schema.userBookStatus.userId, actor.userId), eq(schema.userBookStatus.bookId, imported.bookId)));

    const result = await catalog.importItem(actorUser, destination, { ...source, status: 'read', remoteStatus: 'finished' }, imported.bookId, 'safe');
    const [status] = await ctx.db
      .select()
      .from(schema.userBookStatus)
      .where(and(eq(schema.userBookStatus.userId, actor.userId), eq(schema.userBookStatus.bookId, imported.bookId)));
    const [storedSource] = await ctx.db
      .select()
      .from(schema.externalBookSources)
      .where(and(eq(schema.externalBookSources.userId, actor.userId), eq(schema.externalBookSources.bookId, imported.bookId)));
    expect(result.statusConflict).toBe(true);
    expect(status).toMatchObject({ status: 'abandoned', source: 'manual', updatedAt: manualAt });
    expect(storedSource.lastAppliedStatusAt).toEqual(ownershipAt);
  });

  it('keeps a recent KOReader position first in the ten current books despite old or unknown Yandex source timestamps and reimports', async () => {
    const { actor, destination, actorUser } = await createIsolatedReader();
    const ko = await localBookFor(actor, actorUser, destination, item({ title: 'KOReader recent fixture' }));
    const koReadAt = new Date('2025-04-01T00:00:00.000Z');
    await ctx.db.insert(schema.readingProgress).values({
      userId: actor.userId,
      bookFileId: ko.fileId,
      percentage: 3.52,
      koreaderProgress: '/body/DocFragment[1]/body/p[4]/text().2',
      lastReadAt: koReadAt,
      updatedAt: koReadAt,
    });
    await ctx.db
      .insert(schema.userBookStatus)
      .values({ userId: actor.userId, bookId: ko.bookId, status: 'reading', source: 'auto', updatedAt: new Date('2025-01-01T00:00:00.000Z') });

    const yandexItems = Array.from({ length: 11 }, (_, index) =>
      item({ title: `Old Yandex ${index}`, sourceUpdatedAt: index % 2 === 0 ? null : '2025-02-01T00:00:00.000Z', percentage: index + 10 }),
    );
    const yandexBookIds: number[] = [];
    for (const yandex of yandexItems) {
      const imported = await catalog.importItem(actorUser, destination, yandex);
      yandexBookIds.push(imported.bookId);
      await ctx.db
        .update(schema.userBookStatus)
        .set({ updatedAt: new Date('2025-05-01T00:00:00.000Z') })
        .where(and(eq(schema.userBookStatus.userId, actor.userId), eq(schema.userBookStatus.bookId, imported.bookId)));
      await ctx.db
        .update(schema.externalBookSources)
        .set({ lastAppliedStatusAt: new Date('2025-05-01T00:00:00.000Z'), syncedAt: new Date('2025-05-01T00:00:00.000Z') })
        .where(and(eq(schema.externalBookSources.userId, actor.userId), eq(schema.externalBookSources.bookId, imported.bookId)));
    }

    clearCurrentlyReadingCache(actor.userId);
    const firstRead = await currentlyReading(actor.accessToken);
    expect(firstRead).toHaveLength(10);
    expect(firstRead[0]).toMatchObject({ bookId: ko.bookId, progress: 3.52 });
    await catalog.importItem(actorUser, destination, yandexItems[0]!, yandexBookIds[0]!, 'safe');
    clearCurrentlyReadingCache(actor.userId);
    const afterReimport = await currentlyReading(actor.accessToken);
    expect(afterReimport[0]).toMatchObject({ bookId: ko.bookId, progress: 3.52 });
  });

  it.each([
    ['newer local text', '2025-04-01T00:00:00.000Z', '2025-02-01T00:00:00.000Z', '2025-03-01T00:00:00.000Z', 31],
    ['newer audio', '2025-02-01T00:00:00.000Z', '2025-04-01T00:00:00.000Z', '2025-03-01T00:00:00.000Z', 62],
    ['newer external source', '2025-02-01T00:00:00.000Z', '2025-03-01T00:00:00.000Z', '2025-04-01T00:00:00.000Z', 84],
    ['equal local text and external source', '2025-04-01T00:00:00.000Z', '2025-02-01T00:00:00.000Z', '2025-04-01T00:00:00.000Z', 31],
  ])('uses %s to choose currently-reading progress', async (_caseName, textAt, audioAt, externalAt, expectedProgress) => {
    const { actor, destination, actorUser } = await createIsolatedReader();
    const local = await localBookFor(actor, actorUser, destination, item({ title: `Progress arbitration ${_caseName}` }));
    const source = item({ title: `Progress arbitration ${_caseName}`, percentage: 84, sourceUpdatedAt: externalAt });
    await ctx.db.insert(schema.readingProgress).values({
      userId: actor.userId,
      bookFileId: local.fileId,
      percentage: 31,
      cfi: 'epubcfi(/6/2!/4/2:5)',
      lastReadAt: new Date(textAt),
      textUpdatedAt: new Date(textAt),
      updatedAt: new Date(textAt),
    });
    await ctx.db.insert(schema.audiobookProgress).values({
      userId: actor.userId,
      bookId: local.bookId,
      currentFileId: local.fileId,
      percentage: 62,
      positionSeconds: 120,
      updatedAt: new Date(audioAt),
    });
    await catalog.importItem(actorUser, destination, source, local.bookId, 'safe');
    await ctx.db
      .update(schema.externalBookSources)
      .set({ sourceUpdatedAt: new Date(externalAt), syncedAt: new Date('2025-05-01T00:00:00.000Z') })
      .where(and(eq(schema.externalBookSources.userId, actor.userId), eq(schema.externalBookSources.bookId, local.bookId)));

    clearCurrentlyReadingCache(actor.userId);
    expect(await currentlyReading(actor.accessToken)).toEqual([expect.objectContaining({ bookId: local.bookId, progress: expectedProgress })]);
  });

  it('uses an undated external percentage only as a fallback and never treats its sync time as reading activity', async () => {
    const { actor, destination, actorUser } = await createIsolatedReader();
    const fallback = await localBookFor(actor, actorUser, destination, item({ title: 'Undated external fallback fixture' }));
    const undated = item({ title: 'Undated external fallback fixture', percentage: 73, sourceUpdatedAt: null });
    await catalog.importItem(actorUser, destination, undated, fallback.bookId, 'safe');
    await ctx.db
      .update(schema.externalBookSources)
      .set({ sourceUpdatedAt: null, syncedAt: new Date('2025-06-01T00:00:00.000Z') })
      .where(and(eq(schema.externalBookSources.userId, actor.userId), eq(schema.externalBookSources.bookId, fallback.bookId)));

    clearCurrentlyReadingCache(actor.userId);
    expect(await currentlyReading(actor.accessToken)).toEqual([expect.objectContaining({ bookId: fallback.bookId, progress: 73 })]);

    await ctx.db.insert(schema.readingProgress).values({
      userId: actor.userId,
      bookFileId: fallback.fileId,
      percentage: 22,
      cfi: 'epubcfi(/6/2!/4/2:8)',
      lastReadAt: new Date('2025-02-01T00:00:00.000Z'),
    });
    const rivalSource = item({ title: 'Known external activity fixture', percentage: 10, sourceUpdatedAt: '2025-03-01T00:00:00.000Z' });
    const rival = await catalog.importItem(actorUser, destination, rivalSource);
    await ctx.db
      .update(schema.externalBookSources)
      .set({ sourceUpdatedAt: new Date('2025-03-01T00:00:00.000Z') })
      .where(and(eq(schema.externalBookSources.userId, actor.userId), eq(schema.externalBookSources.bookId, rival.bookId)));

    clearCurrentlyReadingCache(actor.userId);
    const books = await currentlyReading(actor.accessToken);
    expect(books[0]).toMatchObject({ bookId: rival.bookId, progress: 10 });
    expect(books.find((book) => book.bookId === fallback.bookId)).toMatchObject({ progress: 22 });
  });

  it('uses all own external sources for activity without duplicating a book or allowing a null percentage to erase a known position', async () => {
    const { actor, destination, actorUser } = await createIsolatedReader();
    const main = await localBookFor(actor, actorUser, destination, item({ title: 'Multiple external sources fixture' }));
    const known = item({ title: 'Multiple external sources fixture', percentage: 67, sourceUpdatedAt: '2025-02-01T00:00:00.000Z' });
    const missing = item({ title: 'Multiple external sources fixture', percentage: null, sourceUpdatedAt: '2025-04-01T00:00:00.000Z' });
    await ctx.db.insert(schema.readingProgress).values({
      userId: actor.userId,
      bookFileId: main.fileId,
      percentage: 33,
      koreaderProgress: '/body/DocFragment[1]/body/p[6]/text().1',
      lastReadAt: new Date('2025-01-01T00:00:00.000Z'),
    });
    await catalog.importItem(actorUser, destination, known, main.bookId, 'safe');
    await catalog.importItem(actorUser, destination, missing, main.bookId, 'safe');
    const rivalSource = item({ title: 'Rival activity fixture', percentage: 11, sourceUpdatedAt: '2025-03-01T00:00:00.000Z' });
    const rival = await catalog.importItem(actorUser, destination, rivalSource);
    await ctx.db
      .update(schema.externalBookSources)
      .set({ sourceUpdatedAt: new Date('2025-02-01T00:00:00.000Z') })
      .where(and(eq(schema.externalBookSources.userId, actor.userId), eq(schema.externalBookSources.externalId, known.externalId)));
    await ctx.db
      .update(schema.externalBookSources)
      .set({ sourceUpdatedAt: new Date('2025-04-01T00:00:00.000Z') })
      .where(and(eq(schema.externalBookSources.userId, actor.userId), eq(schema.externalBookSources.externalId, missing.externalId)));
    await ctx.db
      .update(schema.externalBookSources)
      .set({ sourceUpdatedAt: new Date('2025-03-01T00:00:00.000Z') })
      .where(and(eq(schema.externalBookSources.userId, actor.userId), eq(schema.externalBookSources.bookId, rival.bookId)));

    clearCurrentlyReadingCache(actor.userId);
    const books = await currentlyReading(actor.accessToken);
    expect(books[0]).toMatchObject({ bookId: main.bookId, progress: 67 });
    expect(books.filter((book) => book.bookId === main.bookId)).toHaveLength(1);
    expect(books.some((book) => book.bookId === rival.bookId)).toBe(true);
  });

  it('ranks a recent manual mark ahead of older positions without leaking another reader source from the shared library', async () => {
    const { actor, destination, actorUser } = await createIsolatedReader();
    const manual = await localBookFor(actor, actorUser, destination, item({ title: 'Manual activity fixture' }));
    const other = await createUserAndLogin(ctx);
    await grantLibraryAccess(ctx, other.userId, destination.libraryId, 'viewer');
    const manualAt = new Date('2025-05-01T00:00:00.000Z');
    await ctx.db
      .insert(schema.userBookStatus)
      .values({ userId: actor.userId, bookId: manual.bookId, status: 'reading', source: 'manual', updatedAt: manualAt });
    await ctx.db.insert(schema.externalBookSources).values({
      userId: other.userId,
      bookId: manual.bookId,
      provider: 'yandexBooks',
      externalId: randomUUID(),
      mediaKind: 'ebook',
      sourceUrl: 'https://books.yandex.ru/books/private-reader-fixture',
      remoteStatus: 'reading',
      percentage: 99,
      sourceUpdatedAt: new Date('2025-06-01T00:00:00.000Z'),
      syncedAt: new Date('2025-06-01T00:00:00.000Z'),
    });
    for (let index = 0; index < 10; index += 1) {
      const old = await localBookFor(actor, actorUser, destination, item({ title: `Older local activity ${index}` }));
      const oldAt = new Date(`2025-04-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`);
      await ctx.db.insert(schema.readingProgress).values({
        userId: actor.userId,
        bookFileId: old.fileId,
        percentage: index + 1,
        koreaderProgress: `/body/DocFragment[1]/body/p[${index + 1}]/text().1`,
        lastReadAt: oldAt,
      });
      await ctx.db
        .insert(schema.userBookStatus)
        .values({ userId: actor.userId, bookId: old.bookId, status: 'reading', source: 'auto', updatedAt: oldAt });
    }

    clearCurrentlyReadingCache(actor.userId);
    const books = await currentlyReading(actor.accessToken);
    expect(books).toHaveLength(10);
    expect(books[0]).toMatchObject({ bookId: manual.bookId, progress: 0 });
    expect(books[0]?.progress).not.toBe(99);
  });

  it('rejects reusing a source from a different destination before changing its reading snapshot', async () => {
    const original = await createLibraryWithFolder(ctx, { mode: 'book_per_folder' });
    const other = await createLibraryWithFolder(ctx, { mode: 'book_per_folder' });
    await grantLibraryAccess(ctx, session.userId, original.libraryId, 'editor');
    await grantLibraryAccess(ctx, session.userId, other.libraryId, 'editor');
    const source = item();
    const imported = await catalog.importItem(await user(), original, source);
    const snapshot = await ctx.db.select().from(schema.externalBookSources).where(eq(schema.externalBookSources.bookId, imported.bookId));
    const status = await ctx.db.select().from(schema.userBookStatus).where(eq(schema.userBookStatus.bookId, imported.bookId));

    await expect(catalog.importItem(await user(), other, { ...source, percentage: 100, status: 'read', remoteStatus: 'finished' })).rejects.toThrow(
      'An external item can only be linked inside its destination library',
    );

    expect(await ctx.db.select().from(schema.externalBookSources).where(eq(schema.externalBookSources.bookId, imported.bookId))).toEqual(snapshot);
    expect(await ctx.db.select().from(schema.userBookStatus).where(eq(schema.userBookStatus.bookId, imported.bookId))).toEqual(status);
    expect(await ctx.db.select().from(schema.books).where(eq(schema.books.libraryId, other.libraryId))).toEqual([]);
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
    await ctx.db.delete(schema.bookProviderIds).where(eq(schema.bookProviderIds.bookId, imported.bookId));
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
    await ctx.db
      .update(schema.bookMetadata)
      .set({ embedding: Array.from({ length: 256 }, () => 0) })
      .where(eq(schema.bookMetadata.bookId, duplicate.bookId));
    const [migratedAttempt] = await ctx.db
      .insert(schema.readingAttempts)
      .values({ userId: session.userId, bookId: duplicate.bookId, origin: 'migration', startedOn: '2025-01-02' })
      .returning();
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
    const [retainedAttempt] = await ctx.db.select().from(schema.readingAttempts).where(eq(schema.readingAttempts.id, migratedAttempt.id));
    expect(retainedAttempt).toEqual({ ...migratedAttempt, bookId });
    expect((await catalog.importItem(await user(), destination, source)).bookId).toBe(bookId);
  });

  it.each([
    'file',
    'note',
    'metadata',
    'manualStatus',
    'otherUser',
    'permission',
    'manualAttempt',
    'editedAttempt',
    'targetAttempt',
    'providerId',
    'extraProviderId',
    'ratedAttempt',
  ] as const)('preserves an imported card with %s when relinking is unsafe', async (reason) => {
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
      await ctx.db.update(schema.userBookStatus).set({ status: 'read', source: 'manual' }).where(eq(schema.userBookStatus.bookId, duplicate.bookId));
    if (reason === 'otherUser')
      await ctx.db.insert(schema.userBookStatus).values({ userId: viewer.userId, bookId: duplicate.bookId, status: 'read' });
    if (reason === 'manualAttempt')
      await ctx.db.insert(schema.readingAttempts).values({ userId: session.userId, bookId: duplicate.bookId, origin: 'manual' });
    if (reason === 'editedAttempt')
      await ctx.db
        .insert(schema.readingAttempts)
        .values({ userId: session.userId, bookId: duplicate.bookId, origin: 'migration', updatedAt: new Date(Date.now() + 1000) });
    if (reason === 'providerId')
      await ctx.db.update(schema.bookProviderIds).set({ externalId: 'book-edited' }).where(eq(schema.bookProviderIds.bookId, duplicate.bookId));
    if (reason === 'extraProviderId')
      await ctx.db.insert(schema.bookProviderIds).values({ bookId: duplicate.bookId, provider: 'other', externalId: 'edited' });
    if (reason === 'ratedAttempt')
      await ctx.db.insert(schema.readingAttempts).values({ userId: session.userId, bookId: duplicate.bookId, origin: 'migration', rating: 5 });
    if (reason === 'targetAttempt') {
      await ctx.db.insert(schema.readingAttempts).values([
        { userId: session.userId, bookId: duplicate.bookId, origin: 'migration' },
        { userId: session.userId, bookId, origin: 'manual' },
      ]);
    }
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
  });

  it('requires the new permission at the HTTP boundary', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/api/v1/yandex-books/settings', headers: authHeader(viewer.accessToken) });
    expect(response.statusCode).toBe(403);
  });

  it('rejects invalid credentials without persisting a connection', async () => {
    const destination = await createLibraryWithFolder(ctx, { mode: 'book_per_folder' });
    await grantLibraryAccess(ctx, session.userId, destination.libraryId, 'editor');
    const client = ctx.app.get(YandexBooksClientService);
    vi.spyOn(client, 'getProfile').mockRejectedValueOnce(new UnauthorizedException('Yandex Books authorization expired'));

    const response = await request(session.accessToken, 'PATCH', 'settings', {
      apiToken: 'invalid-fixture-token',
      libraryId: destination.libraryId,
      libraryFolderId: destination.libraryFolderId,
    });

    expect(response.statusCode, response.body).toBe(401);
    expect((await request(session.accessToken, 'GET', 'settings')).json()).toMatchObject({ tokenConfigured: false, accountLogin: null });
    expect(await ctx.db.query.yandexBooksSettings.findFirst({ where: eq(schema.yandexBooksSettings.userId, session.userId) })).toBeUndefined();
    vi.restoreAllMocks();
  });

  it('keeps imported books and source snapshots when a later sync finds an expired credential', async () => {
    const destination = await createLibraryWithFolder(ctx, { mode: 'book_per_folder' });
    await grantLibraryAccess(ctx, session.userId, destination.libraryId, 'editor');
    const client = ctx.app.get(YandexBooksClientService);
    const source = item({ title: 'Credential retention fixture' });
    vi.spyOn(client, 'getProfile').mockResolvedValue({ id: 'expired-account', login: 'expired-reader', name: 'Expired Reader' });
    const pages = vi.spyOn(client, 'collectPages').mockImplementation(async function* () {
      yield await Promise.resolve([source]);
    });
    await connect(session.accessToken, destination, 'credential-retention-token');
    expect((await request(session.accessToken, 'POST', 'sync', {})).statusCode).toBe(202);
    await waitForSync(session.accessToken, { needsReauth: false, lastError: null });
    const entry = (await request(session.accessToken, 'GET', 'entries?pageSize=10')).json().items[0];
    const bookId = entry.bookId as number;
    const sourcesBefore = await ctx.db.select().from(schema.externalBookSources).where(eq(schema.externalBookSources.bookId, bookId));

    pages.mockImplementationOnce(async function* () {
      yield await Promise.resolve([]);
      throw new UnauthorizedException('Yandex Books authorization expired');
    });
    expect((await request(session.accessToken, 'POST', 'sync', {})).statusCode).toBe(202);
    await waitForSync(session.accessToken, { needsReauth: true, lastError: 'Reconnect your Yandex Books account' });

    const settings = (await request(session.accessToken, 'GET', 'settings')).json();
    expect(settings).toMatchObject({ tokenConfigured: true, needsReauth: true, syncing: false, lastResult: { imported: 1 } });
    expect(await ctx.db.select().from(schema.books).where(eq(schema.books.id, bookId))).toHaveLength(1);
    expect(await ctx.db.select().from(schema.externalBookSources).where(eq(schema.externalBookSources.bookId, bookId))).toEqual(sourcesBefore);
    expect((await request(session.accessToken, 'GET', 'entries?pageSize=10')).json().items).toEqual([
      expect.objectContaining({ id: entry.id, bookId, state: 'imported', item: expect.objectContaining({ externalId: source.externalId }) }),
    ]);
    vi.restoreAllMocks();
  });

  it('reconnects after disconnect without duplicating the existing imported book', async () => {
    const destination = await createLibraryWithFolder(ctx, { mode: 'book_per_folder' });
    await grantLibraryAccess(ctx, session.userId, destination.libraryId, 'editor');
    const client = ctx.app.get(YandexBooksClientService);
    const source = item({ title: 'Reconnect identity fixture', percentage: 20 });
    vi.spyOn(client, 'getProfile').mockResolvedValue({ id: 'stable-account', login: 'stable-reader', name: 'Stable Reader' });
    vi.spyOn(client, 'collectPages').mockImplementation(async function* () {
      yield await Promise.resolve([source]);
    });
    await connect(session.accessToken, destination, 'first-stable-token');
    expect((await request(session.accessToken, 'POST', 'sync', {})).statusCode).toBe(202);
    await waitForSync(session.accessToken, { needsReauth: false, lastError: null });
    const first = (await request(session.accessToken, 'GET', 'entries?pageSize=10')).json().items[0];
    const bookId = first.bookId as number;

    expect((await request(session.accessToken, 'DELETE', 'settings')).statusCode).toBe(200);
    expect((await request(session.accessToken, 'GET', 'settings')).json()).toMatchObject({ tokenConfigured: false, accountLogin: null });
    expect((await request(session.accessToken, 'GET', 'entries')).json().total).toBe(0);
    await connect(session.accessToken, destination, 'second-stable-token');
    source.percentage = 71;
    expect((await request(session.accessToken, 'POST', 'sync', {})).statusCode).toBe(202);
    await waitForSync(session.accessToken, { needsReauth: false, lastError: null });

    const refreshed = (await request(session.accessToken, 'GET', 'entries?pageSize=10')).json().items;
    expect(refreshed).toEqual([expect.objectContaining({ bookId, state: 'imported', item: expect.objectContaining({ percentage: 71 }) })]);
    expect(await ctx.db.select().from(schema.books).where(eq(schema.books.libraryId, destination.libraryId))).toHaveLength(1);
    expect((await detail(bookId)).externalReading).toEqual([expect.objectContaining({ externalId: source.externalId, percentage: 71 })]);
    vi.restoreAllMocks();
  });

  it('isolates settings, entries, links and imported reading status between authorized non-superusers', async () => {
    const other = await createUserAndLogin(ctx, { permissions: [Permission.YandexBooksSync, Permission.LibraryUpload] });
    const [ownDestination, otherDestination] = await Promise.all([
      createLibraryWithFolder(ctx, { mode: 'book_per_folder' }),
      createLibraryWithFolder(ctx, { mode: 'book_per_folder' }),
    ]);
    await Promise.all([
      grantLibraryAccess(ctx, session.userId, ownDestination.libraryId, 'editor'),
      grantLibraryAccess(ctx, other.userId, otherDestination.libraryId, 'editor'),
    ]);
    const client = ctx.app.get(YandexBooksClientService);
    const ownSource = item({ title: 'Owner one fixture' });
    const otherSource = item({ title: 'Owner two fixture' });
    vi.spyOn(client, 'getProfile').mockImplementation((token) =>
      Promise.resolve(
        token === 'owner-one-token'
          ? { id: 'owner-one-account', login: 'owner-one-reader', name: 'Owner One' }
          : { id: 'owner-two-account', login: 'owner-two-reader', name: 'Owner Two' },
      ),
    );
    vi.spyOn(client, 'collectPages').mockImplementation(async function* (token) {
      yield await Promise.resolve(token === 'owner-one-token' ? [ownSource] : [otherSource]);
    });
    await connect(session.accessToken, ownDestination, 'owner-one-token');
    await connect(other.accessToken, otherDestination, 'owner-two-token');
    for (const token of [session.accessToken, other.accessToken]) {
      expect((await request(token, 'POST', 'sync', {})).statusCode).toBe(202);
      await waitForSync(token, { needsReauth: false, lastError: null });
    }
    const ownSettings = (await request(session.accessToken, 'GET', 'settings')).json();
    const otherSettings = (await request(other.accessToken, 'GET', 'settings')).json();
    const ownEntry = (await request(session.accessToken, 'GET', 'entries?pageSize=10')).json().items[0];
    const otherEntries = (await request(other.accessToken, 'GET', 'entries?pageSize=10')).json().items;

    expect(ownSettings).toMatchObject({ accountLogin: 'owner-one-reader', libraryId: ownDestination.libraryId, lastResult: { imported: 1 } });
    expect(otherSettings).toMatchObject({ accountLogin: 'owner-two-reader', libraryId: otherDestination.libraryId, lastResult: { imported: 1 } });
    expect(otherEntries).toEqual([expect.objectContaining({ item: expect.objectContaining({ externalId: otherSource.externalId }) })]);
    expect(otherEntries).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: ownEntry.id })]));
    const link = await request(other.accessToken, 'POST', `entries/${ownEntry.id}/link`, { bookId: otherEntries[0].bookId });
    expect(link.statusCode, link.body).toBe(404);
    const hiddenBook = await ctx.app.inject({ method: 'GET', url: `/api/v1/books/${ownEntry.bookId}`, headers: authHeader(other.accessToken) });
    expect(hiddenBook.statusCode).toBe(404);
    vi.restoreAllMocks();
  });

  it('imports catalog metadata and reading status when an optional cover download fails', async () => {
    const destination = await createLibraryWithFolder(ctx, { mode: 'book_per_folder' });
    await grantLibraryAccess(ctx, session.userId, destination.libraryId, 'editor');
    const client = ctx.app.get(YandexBooksClientService);
    const source = item({ title: 'Cover failure fixture', coverUrl: 'https://api.bookmate.ru/covers/failing-cover.jpg' });
    vi.spyOn(client, 'getProfile').mockResolvedValue({ id: 'cover-account', login: 'cover-reader', name: 'Cover Reader' });
    vi.spyOn(client, 'collectPages').mockImplementation(async function* () {
      yield await Promise.resolve([source]);
    });
    const coverFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('cover fixture unavailable'));
    await connect(session.accessToken, destination, 'cover-failure-token');
    expect((await request(session.accessToken, 'POST', 'sync', {})).statusCode).toBe(202);
    await waitForSync(session.accessToken, { needsReauth: false, lastError: null });

    const entry = (await request(session.accessToken, 'GET', 'entries?pageSize=10')).json().items[0];
    const [metadata] = await ctx.db.select().from(schema.bookMetadata).where(eq(schema.bookMetadata.bookId, entry.bookId));
    const [status] = await ctx.db
      .select()
      .from(schema.userBookStatus)
      .where(and(eq(schema.userBookStatus.userId, session.userId), eq(schema.userBookStatus.bookId, entry.bookId)));
    expect(entry).toMatchObject({ state: 'imported', item: expect.objectContaining({ title: source.title }) });
    expect(metadata).toMatchObject({ title: source.title, coverSource: null });
    expect(status).toMatchObject({ status: 'reading', source: 'auto' });
    expect(coverFetch).toHaveBeenCalledWith(source.coverUrl, expect.objectContaining({ redirect: 'manual' }));
    expect((await request(session.accessToken, 'GET', 'settings')).json()).toMatchObject({
      lastError: null,
      needsReauth: false,
      lastResult: { imported: 1 },
    });
    vi.restoreAllMocks();
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
