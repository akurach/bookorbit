import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';

import { mapAudio, mapComic, mapTextCard, type YandexProfile } from './yandex-books.types';
import type { ExternalCatalogItem } from '@bookorbit/types';
import { readBoundedText } from '../../common/utils/bounded-response';

const BASE_URL = 'https://api.bookmate.yandex.net/api/v5';
const PAGE_SIZE = 20;
const MAX_PAGES = 500;
const TIMEOUT_MS = 12_000;

@Injectable()
export class YandexBooksClientService {
  async getProfile(token: string): Promise<YandexProfile> {
    const payload = await this.get(token, '/profile');
    const user = payload.user && typeof payload.user === 'object' ? (payload.user as Record<string, unknown>) : null;
    const id = user && (typeof user.id === 'string' || typeof user.id === 'number') ? String(user.id) : null;
    const login = user && typeof user.login === 'string' ? user.login : null;
    if (!id || !login) throw new ServiceUnavailableException('Yandex Books returned an invalid profile');
    return { id, login, name: user && typeof user.name === 'string' ? user.name : null };
  }

  async *collectPages(token: string, login: string): AsyncGenerator<ExternalCatalogItem[]> {
    yield* this.paginate(token, '/profile/library_cards', 'library_cards', mapTextCard);
    yield* this.paginate(token, `/users/${encodeURIComponent(login)}/audiobooks`, 'audiobooks', mapAudio);
    yield* this.paginate(token, `/users/${encodeURIComponent(login)}/comicbooks`, 'comicbooks', mapComic);
  }

  private async *paginate(
    token: string,
    path: string,
    field: string,
    mapper: (value: unknown) => ExternalCatalogItem | null,
  ): AsyncGenerator<ExternalCatalogItem[]> {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const separator = path.includes('?') ? '&' : '?';
      const payload = await this.get(token, `${path}${separator}page=${page}&per_page=${PAGE_SIZE}`);
      const values = payload[field];
      if (!Array.isArray(values)) throw new ServiceUnavailableException('Yandex Books returned an invalid collection');
      const mapped: ExternalCatalogItem[] = [];
      for (const value of values) {
        const item = mapper(value);
        if (!item) throw new ServiceUnavailableException('Yandex Books returned an invalid library entry');
        mapped.push(item);
      }
      if (mapped.length > 0) yield mapped;
      if (values.length < PAGE_SIZE) return;
    }
    throw new ServiceUnavailableException('Yandex Books collection is too large');
  }

  private async get(token: string, path: string): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(`${BASE_URL}${path}`, {
        redirect: 'error',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'App-Language': 'ru',
          'App-Locale': 'ru',
          'App-Platform': 'android',
          'Bookmate-Version': '20200305',
          'Device-Os': 'Android',
          'User-Agent': 'BookOrbit/1.0',
          'Auth-Token': token,
        },
      });
      if (response.status === 401 || response.status === 403) throw new UnauthorizedException('Yandex Books authorization expired');
      if (!response.ok) throw new ServiceUnavailableException('Yandex Books is temporarily unavailable');
      const length = Number(response.headers.get('content-length') ?? 0);
      if (length > 2_000_000) throw new ServiceUnavailableException('Yandex Books response is too large');
      const payload: unknown = JSON.parse(await readBoundedText(response, 2_000_000));
      if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        throw new ServiceUnavailableException('Yandex Books returned an invalid response');
      return payload as Record<string, unknown>;
    } catch (error) {
      if (error instanceof UnauthorizedException || error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException('Yandex Books request failed');
    } finally {
      clearTimeout(timer);
    }
  }
}
