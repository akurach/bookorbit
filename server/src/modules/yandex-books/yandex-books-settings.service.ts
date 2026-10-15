import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { UpsertYandexBooksSettingsPayload, YandexBooksSettings } from '@bookorbit/types';
import type { RequestUser } from '../../common/types/request-user';
import { LibraryService } from '../library/library.service';
import { UserService } from '../user/user.service';
import { YandexBooksClientService } from './yandex-books-client.service';
import { YandexBooksCredentialService } from './yandex-books-credential.service';
import { YandexBooksRepository } from './yandex-books.repository';

@Injectable()
export class YandexBooksSettingsService {
  constructor(
    private readonly repo: YandexBooksRepository,
    private readonly client: YandexBooksClientService,
    private readonly credentials: YandexBooksCredentialService,
    private readonly libraries: LibraryService,
    private readonly users: UserService,
  ) {}

  async getSettings(userId: number): Promise<YandexBooksSettings> {
    const row = await this.repo.findSettings(userId);
    return {
      tokenConfigured: Boolean(row?.encryptedToken),
      encryptionConfigured: this.credentials.isConfigured(),
      accountLogin: row?.accountLogin ?? null,
      accountName: row?.accountName ?? null,
      libraryId: row?.libraryId ?? null,
      libraryFolderId: row?.libraryFolderId ?? null,
      autoSync: row?.autoSync ?? false,
      intervalHours: row?.intervalHours ?? 24,
      needsReauth: row?.needsReauth ?? false,
      syncing: Boolean(row?.leaseUntil && row.leaseUntil > new Date()),
      lastSyncedAt: row?.lastSyncedAt?.toISOString() ?? null,
      nextSyncAt: row?.nextSyncAt?.toISOString() ?? null,
      lastError: row?.lastError ?? null,
      lastResult: row?.lastResult ?? null,
    };
  }

  async requireImportAccess(userId: number, destination: { libraryId: number; libraryFolderId: number }): Promise<RequestUser> {
    const user = await this.users.findByIdWithPermissions(userId);
    if (!user?.active || !(await this.repo.hasImportPermission(userId)))
      throw new ForbiddenException('Yandex Books import and upload permissions are required');
    await this.libraries.verifyUserAccessLevel(user.id, destination.libraryId, user.isSuperuser, 'editor');
    const library = await this.libraries.findOne(destination.libraryId);
    if (library.type !== 'books' || !library.folders.some((folder) => folder.id === destination.libraryFolderId)) {
      throw new BadRequestException('Select a folder in a book library');
    }
    return user;
  }

  async upsert(userId: number, dto: UpsertYandexBooksSettingsPayload): Promise<YandexBooksSettings> {
    await this.requireImportAccess(userId, dto);
    const previous = await this.repo.findSettings(userId);
    const supplied = dto.apiToken?.trim();
    if (!previous && !supplied) throw new BadRequestException('Yandex Books token is required to connect');
    if (supplied && !this.credentials.isConfigured()) throw new BadRequestException('Configure YANDEX_BOOKS_ENCRYPTION_KEY on the server first');
    const verified = supplied ? await this.client.getProfile(supplied) : null;
    await this.repo.withUserLock(userId, async () => {
      const current = await this.repo.findSettings(userId);
      if (current?.revision !== previous?.revision) throw new ConflictException('The connection changed. Reload settings and try again.');
      if (current?.leaseUntil && current.leaseUntil > new Date()) throw new ConflictException('Wait for the current update before changing settings');
      if (current && verified && current.accountId !== verified.id)
        throw new BadRequestException('Disconnect before connecting another Yandex account');
      await this.requireImportAccess(userId, dto);
      const autoSync = dto.autoSync ?? current?.autoSync ?? false;
      const intervalHours = dto.intervalHours ?? current?.intervalHours ?? 24;
      await this.repo.saveSettings(userId, {
        encryptedToken: supplied ? this.credentials.encrypt(supplied) : current!.encryptedToken,
        accountId: verified?.id ?? current!.accountId,
        accountLogin: verified?.login ?? current!.accountLogin,
        accountName: verified?.name ?? current?.accountName ?? null,
        libraryId: dto.libraryId,
        libraryFolderId: dto.libraryFolderId,
        autoSync,
        intervalHours,
        revision: randomUUID(),
        leaseId: null,
        leaseUntil: null,
        needsReauth: supplied ? false : (current?.needsReauth ?? false),
        nextSyncAt: autoSync ? new Date(Date.now() + intervalHours * 3_600_000) : null,
        lastError: supplied ? null : (current?.lastError ?? null),
      });
    });
    return this.getSettings(userId);
  }

  async disconnect(userId: number): Promise<void> {
    await this.repo.withUserLock(userId, async () => {
      if (!(await this.repo.findSettings(userId))) throw new NotFoundException('Yandex Books integration not configured');
      await this.repo.disconnect(userId);
    });
  }

  decryptToken(value: string): string {
    return this.credentials.decrypt(value);
  }
}
