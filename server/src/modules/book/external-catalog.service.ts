import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { Permission } from '@bookorbit/types';
import type { ConcreteBookMediaKind, ExternalCatalogItem, ExternalStatusPolicy } from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import { LibraryService } from '../library/library.service';
import { BookCoverStore } from '../book-cover-store/book-cover-store.service';
import { ExternalCatalogRepository } from './external-catalog.repository';

const YANDEX_COVER_HOSTS = new Set(['api.bookmate.ru']);
const MAX_YANDEX_COVER_BYTES = 5 * 1024 * 1024;

export function isAllowedYandexCoverUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      YANDEX_COVER_HOSTS.has(url.hostname) &&
      (!url.port || url.port === '443') &&
      url.username === '' &&
      url.password === ''
    );
  } catch {
    return false;
  }
}

type Destination = { libraryId: number; libraryFolderId: number };

@Injectable()
export class ExternalCatalogService {
  private readonly logger = new Logger(ExternalCatalogService.name);
  constructor(
    private readonly repository: ExternalCatalogRepository,
    private readonly libraryService: LibraryService,
    private readonly coverStore: BookCoverStore,
  ) {}

  async importItem(
    user: RequestUser,
    destination: Destination,
    item: ExternalCatalogItem,
    existingBookId?: number,
    statusPolicy: ExternalStatusPolicy = 'safe',
  ): Promise<{ bookId: number; created: boolean; statusConflict: boolean }> {
    await this.verifyDestination(user, destination);
    if (existingBookId != null) await this.verifyExplicitTarget(user, destination, item.mediaKind, existingBookId);
    const priorSource = await this.repository.findSource(user.id, item);
    if (priorSource) await this.verifyLinkTarget(user, priorSource.bookId);

    const result = await this.repository.importItem(user, destination, item, existingBookId, statusPolicy, (bookId) =>
      this.verifyLinkTarget(user, bookId, item, destination.libraryId),
    );
    if (result.created && item.coverUrl) await this.savePublicCover(result.bookId, item.mediaKind, item.coverUrl);
    return result;
  }

  async relinkItem(
    user: RequestUser,
    destination: Destination,
    item: ExternalCatalogItem,
    previousBookId: number,
    targetBookId: number,
    entryId: number,
    statusPolicy: ExternalStatusPolicy,
  ): Promise<{ bookId: number; statusConflict: boolean } | null> {
    if (previousBookId === targetBookId) throw new BadRequestException('Choose a different existing book');
    await this.verifyDestination(user, destination);
    await this.verifyExplicitTarget(user, destination, item.mediaKind, targetBookId);
    const priorSource = await this.repository.findSource(user.id, item);
    if (!priorSource) return null;
    if (!user.isSuperuser && !user.permissions.includes(Permission.LibraryDeleteBooks)) {
      throw new ForbiddenException('Deleting the imported placeholder requires permission to delete books');
    }
    await this.verifyExplicitTarget(user, destination, item.mediaKind, previousBookId);
    const started = Date.now();
    this.logger.log(`[external_catalog.relink] [start] userId=${user.id} bookId=${previousBookId} targetBookId=${targetBookId} - relink started`);
    try {
      const result = await this.repository.relinkItem(user.id, item, previousBookId, targetBookId, entryId, statusPolicy);
      // Only cached provider cover images exist on a pristine fileless placeholder.
      try {
        await this.coverStore.removeCoverDirectory(previousBookId);
      } catch {
        this.logger.warn(`[external_catalog.relink] [fail] userId=${user.id} bookId=${previousBookId} - obsolete cover cache cleanup failed`);
      }
      this.logger.log(
        `[external_catalog.relink] [end] userId=${user.id} bookId=${previousBookId} targetBookId=${targetBookId} durationMs=${Date.now() - started} - relink completed`,
      );
      return result;
    } catch (error) {
      this.logger.warn(
        `[external_catalog.relink] [fail] userId=${user.id} bookId=${previousBookId} targetBookId=${targetBookId} durationMs=${Date.now() - started} - relink rejected; books preserved`,
      );
      throw error;
    }
  }

  /** Validates an explicit link without moving files or changing reader state. */
  async verifyLinkTarget(user: RequestUser, bookId: number, item?: ExternalCatalogItem, libraryId?: number): Promise<void> {
    const book = await this.repository.findBook(bookId);
    if (!book) throw new NotFoundException(`Book ${bookId} not found`);
    await this.libraryService.verifyUserAccess(user.id, book.libraryId, user.isSuperuser);
    if (libraryId != null && item) {
      await this.verifyExplicitTarget(user, { libraryId, libraryFolderId: 0 }, item.mediaKind, bookId);
    }
    if (!user.isSuperuser && user.contentFilters) {
      if (!(await this.repository.isVisibleToUser(user, bookId))) throw new NotFoundException(`Book ${bookId} not found`);
    }
  }

  private async verifyDestination(user: RequestUser, destination: Destination): Promise<void> {
    await this.libraryService.verifyUserAccessLevel(user.id, destination.libraryId, user.isSuperuser, 'editor');
    if (!(await this.repository.hasLibraryFolder(destination.libraryId, destination.libraryFolderId)))
      throw new NotFoundException('Library folder not found');
  }

  private async verifyExplicitTarget(user: RequestUser, destination: Destination, mediaKind: ConcreteBookMediaKind, bookId: number): Promise<void> {
    await this.verifyLinkTarget(user, bookId);
    const book = await this.repository.findBook(bookId);
    if (!book) throw new NotFoundException(`Book ${bookId} not found`);
    if (book.libraryId !== destination.libraryId) throw new BadRequestException('An external item can only be linked inside its destination library');
    const currentKind = this.mediaKindForFormat(book.format, book.catalogMediaKind);
    if (currentKind && currentKind !== mediaKind) throw new BadRequestException('The selected book has an incompatible media type');
  }

  private mediaKindForFormat(format: string | null, catalogMediaKind: string | null): ConcreteBookMediaKind | null {
    if (format) {
      const normalized = format.toLowerCase();
      if (['m4b', 'mp3', 'm4a', 'opus', 'ogg', 'flac'].includes(normalized)) return 'audiobook';
      if (['cbz', 'cbr', 'cb7', 'cbx'].includes(normalized)) return 'comic';
      return 'ebook';
    }
    return catalogMediaKind === 'ebook' || catalogMediaKind === 'audiobook' || catalogMediaKind === 'comic' ? catalogMediaKind : null;
  }

  private async savePublicCover(bookId: number, mediaKind: ConcreteBookMediaKind, coverUrl: string): Promise<void> {
    if (!isAllowedYandexCoverUrl(coverUrl)) return;
    try {
      const response = await fetch(coverUrl, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
      if (!response.ok || !response.body || response.type === 'opaqueredirect') return;
      const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
      if (!contentType.startsWith('image/')) return;
      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_YANDEX_COVER_BYTES) return;
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_YANDEX_COVER_BYTES) {
          await reader.cancel();
          return;
        }
        chunks.push(value);
      }
      if (total === 0) return;
      await this.coverStore.saveExtracted(bookId, mediaKind === 'audiobook' ? 'audio' : 'ebook', Buffer.concat(chunks), {
        origin: 'provider',
        fill: {},
        skipIfUnchanged: true,
      });
    } catch {
      // A catalog import must not fail when an optional public cover is unavailable.
    }
  }
}
