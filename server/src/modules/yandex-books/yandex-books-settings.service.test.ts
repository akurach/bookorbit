import { BadRequestException, ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { YandexBooksSettingsService } from './yandex-books-settings.service';

const user = { id: 7, active: true, isSuperuser: false, permissions: [], contentFilters: {} } as any;
const connection = {
  userId: 7,
  revision: 'old',
  encryptedToken: 'cipher',
  accountId: 'account-1',
  accountLogin: 'reader',
  accountName: 'Reader',
  libraryId: 4,
  libraryFolderId: 9,
  autoSync: false,
  intervalHours: 24,
  needsReauth: false,
  leaseUntil: null,
  lastSyncedAt: null,
  nextSyncAt: null,
  lastError: null,
  lastResult: null,
} as any;

function make() {
  const repo = {
    findSettings: vi.fn().mockResolvedValue(connection),
    hasImportPermission: vi.fn().mockResolvedValue(true),
    withUserLock: vi.fn((_id: number, work: any) => work()),
    saveSettings: vi.fn(),
    disconnect: vi.fn(),
  };
  const client = { getProfile: vi.fn().mockResolvedValue({ id: 'account-1', login: 'reader', name: 'Reader' }) };
  const credentials = { isConfigured: vi.fn().mockReturnValue(true), encrypt: vi.fn().mockReturnValue('encrypted') };
  const libraries = { verifyUserAccessLevel: vi.fn(), findOne: vi.fn().mockResolvedValue({ type: 'books', folders: [{ id: 9 }] }) };
  const users = { findByIdWithPermissions: vi.fn().mockResolvedValue(user) };
  return {
    service: new YandexBooksSettingsService(repo as any, client as any, credentials as any, libraries as any, users as any),
    repo,
    client,
    credentials,
    libraries,
    users,
  };
}

describe('YandexBooksSettingsService', () => {
  it('refuses storing a token when encryption is unavailable', async () => {
    const { service, credentials, client, repo } = make();
    credentials.isConfigured.mockReturnValue(false);
    await expect(service.upsert(7, { apiToken: 'secret', libraryId: 4, libraryFolderId: 9 })).rejects.toBeInstanceOf(BadRequestException);
    expect(client.getProfile).not.toHaveBeenCalled();
    expect(repo.saveSettings).not.toHaveBeenCalled();
  });
  it('rejects replacing one Yandex account with another without disconnecting', async () => {
    const { service, client, repo } = make();
    client.getProfile.mockResolvedValue({ id: 'other', login: 'other', name: null });
    await expect(service.upsert(7, { apiToken: 'secret', libraryId: 4, libraryFolderId: 9 })).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.saveSettings).not.toHaveBeenCalled();
  });
  it('does not change settings while an importer lease is active', async () => {
    const { service, repo } = make();
    repo.findSettings.mockResolvedValue({ ...connection, leaseUntil: new Date(Date.now() + 60_000) });
    await expect(service.upsert(7, { libraryId: 4, libraryFolderId: 9 })).rejects.toBeInstanceOf(ConflictException);
    expect(repo.saveSettings).not.toHaveBeenCalled();
  });
  it('requires a live editor library destination rather than trusting a stale session', async () => {
    const { service, repo, libraries } = make();
    libraries.findOne.mockResolvedValue({ type: 'podcasts', folders: [{ id: 9 }] });
    await expect(service.requireImportAccess(7, { libraryId: 4, libraryFolderId: 9 })).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.hasImportPermission).toHaveBeenCalledWith(7);
  });
});
