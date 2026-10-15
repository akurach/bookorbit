import { ConflictException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { YandexBooksSyncService } from './yandex-books-sync.service';

const user = { id: 7, active: true, isSuperuser: false, permissions: [], contentFilters: {} } as any;
const item = {
  provider: 'yandexBooks',
  externalId: 'remote-1',
  mediaKind: 'ebook',
  title: 'Remote',
  authors: [],
  description: null,
  language: null,
  coverUrl: null,
  pageCount: null,
  isbn: null,
  sourceUrl: 'https://books.yandex.ru/books/remote-1',
  remoteStatus: 'reading',
  status: 'reading',
  percentage: 20,
  positionSeconds: null,
  durationSeconds: null,
  startedAt: null,
  finishedAt: null,
  sourceUpdatedAt: null,
} as any;
const entry = (id: number, generation = 'lease-1') =>
  ({
    id,
    userId: 7,
    accountId: 'account-1',
    externalId: `remote-${id}`,
    mediaKind: 'ebook',
    snapshot: item,
    bookId: null,
    state: 'ready',
    statusPolicy: 'safe',
    conflict: null,
    generation,
    lastSeenAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  }) as any;
const lease = {
  userId: 7,
  encryptedToken: 'cipher',
  accountId: 'account-1',
  accountLogin: 'reader',
  libraryId: 4,
  libraryFolderId: 9,
  intervalHours: 24,
  autoSync: false,
  needsReauth: false,
  completedGeneration: null,
  revision: 'revision-1',
  leaseId: 'lease-1',
} as any;

function make() {
  const repo = {
    findSettings: vi.fn().mockResolvedValue(lease),
    acquireLease: vi.fn().mockResolvedValue(lease),
    withLease: vi.fn((_lease: any, work: any) => work()),
    stagePage: vi.fn(),
    promote: vi.fn(),
    finish: vi.fn(),
    fail: vi.fn(),
    release: vi.fn(),
    importableEntries: vi.fn().mockResolvedValue([]),
    updateEntry: vi.fn(),
    listEntries: vi.fn(),
    due: vi.fn().mockResolvedValue([]),
    findEntry: vi.fn(),
    withUserLock: vi.fn((_id: number, work: any) => work()),
  };
  const settings = { requireImportAccess: vi.fn().mockResolvedValue(user), decryptToken: vi.fn().mockReturnValue('plain') };
  const client = { collectPages: vi.fn() };
  const catalog = { importItem: vi.fn(), verifyLinkTarget: vi.fn() };
  return { service: new YandexBooksSyncService(repo as any, settings as any, client as any, catalog as any), repo, settings, client, catalog };
}

async function wait() {
  for (let index = 0; index < 8; index++) await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('YandexBooksSyncService lifecycle', () => {
  it('does not promote or write books when fetching fails after a staged page', async () => {
    const { service, repo, client, catalog } = make();
    client.collectPages.mockImplementation(async function* () {
      await Promise.resolve();
      yield [item];
      throw new ServiceUnavailableException('offline');
    });
    await expect(service.start(user, true)).resolves.toEqual({ started: true });
    await wait();
    expect(repo.stagePage).toHaveBeenCalledTimes(1);
    expect(repo.promote).not.toHaveBeenCalled();
    expect(catalog.importItem).not.toHaveBeenCalled();
    expect(repo.fail).toHaveBeenCalledWith(lease, expect.any(String), false);
  });

  it('promotes a complete preview without creating catalog books', async () => {
    const { service, repo, client, catalog } = make();
    client.collectPages.mockImplementation(async function* () {
      await Promise.resolve();
      yield [item];
    });
    await service.start(user, true);
    await wait();
    expect(repo.promote).toHaveBeenCalledWith(lease);
    expect(catalog.importItem).not.toHaveBeenCalled();
    expect(repo.finish).toHaveBeenCalled();
  });

  it('walks import pages by id without skipping records after the first hundred', async () => {
    const { service, repo, catalog } = make();
    const importLease = { ...lease, completedGeneration: 'gen-1' };
    repo.findSettings.mockResolvedValue(importLease);
    repo.acquireLease.mockResolvedValue(importLease);
    repo.importableEntries
      .mockResolvedValueOnce(Array.from({ length: 100 }, (_, index) => entry(index + 1, 'gen-1')))
      .mockResolvedValueOnce([entry(101, 'gen-1')])
      .mockResolvedValueOnce([]);
    catalog.importItem.mockResolvedValue({ bookId: 1, created: true, statusConflict: false });
    await service.importEntries(user);
    await wait();
    expect(catalog.importItem).toHaveBeenCalledTimes(101);
    expect(repo.importableEntries.mock.calls.map((call: any[]) => call[2])).toEqual([0, 100, 101]);
  });

  it('returns accepted only after it acquires the durable lease', async () => {
    const { service, repo } = make();
    repo.acquireLease.mockRejectedValue(new ConflictException());
    await expect(service.start(user)).rejects.toBeInstanceOf(ConflictException);
  });

  it('checks current access inside the write fence before staging remote data', async () => {
    const { service, repo, settings, client } = make();
    settings.requireImportAccess.mockResolvedValueOnce(user).mockRejectedValueOnce(new ForbiddenException());
    client.collectPages.mockImplementation(async function* () {
      await Promise.resolve();
      yield [item];
    });
    await service.start(user, true);
    await wait();
    expect(repo.stagePage).not.toHaveBeenCalled();
    expect(repo.fail).toHaveBeenCalledWith(lease, expect.stringContaining('permission'), false);
  });
});
