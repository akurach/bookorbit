import { Injectable, Logger } from '@nestjs/common';
import { MetadataCandidate, MetadataProviderKey } from '@bookorbit/types';

import { markProviderDegraded, markProviderFailed } from '../../../../common/provider-cache/provider-call-context';
import type { ProviderCacheSpec } from '../../../../common/provider-cache/provider-cache-spec';
import { sanitizeLogValue } from '../../../../common/utils/log-sanitize.utils';
import { boundProviderId } from '../../../../common/utils/provider-id.utils';
import { ProviderConfigService } from '../../../metadata-preferences/provider-config.service';
import { fetchWithThrottle } from '../../fetch-with-throttle';
import { ProviderThrottleError } from '../../provider-throttle.error';
import { IdentifiableProvider } from '../metadata-provider';
import { MetadataSearchParams } from '../metadata-search-params';
import { pickSearchInputs, providerCacheContext, requestedMax } from '../provider-cache';
import { PROVIDER_LIMITS, PROVIDER_TIMEOUT_MS } from '../provider-constants';
import { buildRequestSignal, normalizeMaxCandidates } from '../provider-utils';
import { mapYandexBook } from './yandex-books.mapper';
import { YANDEX_BOOKS_SEARCH_QUERY } from './yandex-books.query';
import { YandexBook, YandexBookLookupResponse, YandexBooksSearchPageEntry, YandexBooksSearchResponse } from './yandex-books.types';

const GRAPHQL_URL = 'https://api-gateway.bookmate.yandex.net/graphql';
const REST_BASE_URL = 'https://api.bookmate.yandex.net/api/v5/books';
const MAX_RESULTS = PROVIDER_LIMITS.DEFAULT_SEARCH_RESULTS;

const YANDEX_HEADERS = {
  Accept: 'multipart/mixed; deferSpec=20220824, application/json',
  'Content-Type': 'application/json',
  'App-Language': 'ru',
  'App-Locale': 'ru',
  'App-Platform': 'android',
  'Bookmate-Version': '20200305',
  'Device-Os': 'Android',
  'User-Agent': 'okhttp/4.12.0',
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isYandexBook(value: unknown): value is YandexBook {
  return isRecord(value);
}

function isTextBookEntry(value: unknown): value is YandexBooksSearchPageEntry & { __typename: 'TextBook'; book: YandexBook } {
  return isRecord(value) && value.__typename === 'TextBook' && isYandexBook(value.book);
}

function isSearchResponse(value: unknown): value is YandexBooksSearchResponse {
  return isRecord(value) && (value.errors === undefined || Array.isArray(value.errors)) && (value.data === undefined || isRecord(value.data));
}

function isLookupResponse(value: unknown): value is YandexBookLookupResponse {
  return isRecord(value) && (value.book === undefined || isYandexBook(value.book));
}

@Injectable()
export class YandexBooksProvider implements IdentifiableProvider {
  readonly key = MetadataProviderKey.YANDEX_BOOKS;
  readonly label = 'Yandex Books';
  readonly identifiable = true as const;
  readonly coverShape = 'portrait' as const;
  readonly mediaKinds = ['ebook'] as const;

  private readonly logger = new Logger(YandexBooksProvider.name);

  readonly cache: ProviderCacheSpec<MetadataSearchParams> = {
    version: 1,
    trustEmpty: true,
    authoritativeLookupStatuses: [404],
    context: async () => providerCacheContext((await this.providerConfig.getConfig()).yandexBooks.enabled),
    describeSearch: (params) => ({
      // Yandex Books has no documented ISBN search. A title wins when both are supplied.
      inputs: { ...pickSearchInputs(params, ['title', 'author']), isAudiobook: params.isAudiobook === true },
      maxCandidates: requestedMax(params),
    }),
    describeLookup: (providerId) => ({ inputs: { id: providerId } }),
  };

  constructor(private readonly providerConfig: ProviderConfigService) {}

  async search(params: MetadataSearchParams): Promise<MetadataCandidate[]> {
    const { enabled } = (await this.providerConfig.getConfig()).yandexBooks;
    if (!enabled || params.isAudiobook) return [];

    const query = this.buildQuery(params);
    if (!query) return [];

    const maxCandidates = normalizeMaxCandidates(params.maxCandidatesPerProvider, MAX_RESULTS);
    const startedAt = Date.now();
    const safeQuery = sanitizeLogValue(query);
    this.logger.log(`[yandex-books.search] [start] query="${safeQuery}" maxCandidates=${maxCandidates}`);

    try {
      const res = await fetchWithThrottle(GRAPHQL_URL, {
        method: 'POST',
        headers: YANDEX_HEADERS,
        body: JSON.stringify({
          operationName: 'Search',
          query: YANDEX_BOOKS_SEARCH_QUERY,
          variables: { query: { cursor: '', noMisspell: false, query, types: ['TEXTBOOK'] } },
        }),
        signal: buildRequestSignal(PROVIDER_TIMEOUT_MS.DEFAULT, params.signal),
      });
      if (!res.ok) {
        markProviderFailed(`yandexBooks.search: HTTP ${res.status}`);
        this.logger.warn(
          `[yandex-books.search] [fail] query="${safeQuery}" status=${res.status} durationMs=${Date.now() - startedAt} errorClass=HttpError error="non-ok response"`,
        );
        return [];
      }

      const body: unknown = await res.json();
      if (!isSearchResponse(body) || body.errors !== undefined || !Array.isArray(body.data?.search?.page)) {
        markProviderFailed('yandexBooks.search: malformed GraphQL response');
        this.logger.warn(
          `[yandex-books.search] [fail] query="${safeQuery}" status=${res.status} durationMs=${Date.now() - startedAt} errorClass=ResponseError error="unusable GraphQL response"`,
        );
        return [];
      }

      const candidates: MetadataCandidate[] = [];
      const ids = new Set<string>();
      for (const pageEntry of body.data.search.page) {
        if (isRecord(pageEntry) && pageEntry.__typename === 'TextBook' && !isTextBookEntry(pageEntry)) {
          markProviderDegraded('yandexBooks.search: malformed TextBook entry');
          continue;
        }
        if (!isTextBookEntry(pageEntry)) continue;
        const candidate = mapYandexBook(pageEntry.book);
        if (!candidate) {
          markProviderDegraded('yandexBooks.search: TextBook entry did not map');
          continue;
        }
        if (ids.has(candidate.providerId)) continue;
        ids.add(candidate.providerId);
        candidates.push(candidate);
        if (candidates.length >= maxCandidates) break;
      }

      this.logger.log(
        `[yandex-books.search] [end] query="${safeQuery}" status=${res.status} resultCount=${candidates.length} durationMs=${Date.now() - startedAt}`,
      );
      return candidates;
    } catch (error) {
      if (error instanceof ProviderThrottleError) {
        this.logger.warn(
          `[yandex-books.search] [fail] query="${safeQuery}" durationMs=${Date.now() - startedAt} errorClass=ProviderThrottleError error="throttled"`,
        );
        throw error;
      }
      markProviderFailed('yandexBooks.search: request failed');
      this.logger.warn(
        `[yandex-books.search] [fail] query="${safeQuery}" durationMs=${Date.now() - startedAt} errorClass=${error instanceof Error ? error.name : 'UnknownError'} error="${sanitizeLogValue(error instanceof Error ? error.message : String(error))}"`,
      );
      throw error;
    }
  }

  async lookupById(providerId: string, signal?: AbortSignal): Promise<MetadataCandidate | null> {
    const { enabled } = (await this.providerConfig.getConfig()).yandexBooks;
    const normalizedProviderId = boundProviderId('yandexBooksId', providerId.trim());
    if (!enabled || !normalizedProviderId) return null;

    const startedAt = Date.now();
    const safeId = sanitizeLogValue(normalizedProviderId);
    const url = `${REST_BASE_URL}/${encodeURIComponent(normalizedProviderId)}`;
    this.logger.log(`[yandex-books.lookup] [start] providerId="${safeId}"`);

    try {
      const res = await fetchWithThrottle(url, {
        headers: YANDEX_HEADERS,
        signal: buildRequestSignal(PROVIDER_TIMEOUT_MS.DEFAULT, signal),
      });
      if (!res.ok) {
        if (res.status !== 404) markProviderFailed(`yandexBooks.lookup: HTTP ${res.status}`);
        this.logger.warn(
          `[yandex-books.lookup] [fail] providerId="${safeId}" status=${res.status} durationMs=${Date.now() - startedAt} errorClass=HttpError error="non-ok response"`,
        );
        return null;
      }

      const body: unknown = await res.json();
      if (!isLookupResponse(body)) {
        markProviderFailed('yandexBooks.lookup: malformed REST response');
        this.logger.warn(
          `[yandex-books.lookup] [fail] providerId="${safeId}" status=${res.status} durationMs=${Date.now() - startedAt} errorClass=ResponseError error="unusable REST response"`,
        );
        return null;
      }
      if (!body.book) {
        markProviderFailed('yandexBooks.lookup: missing book body');
        return null;
      }

      const candidate = mapYandexBook(body.book);
      if (!candidate || candidate.providerId !== normalizedProviderId) {
        markProviderFailed('yandexBooks.lookup: unusable book body');
        return null;
      }
      this.logger.log(`[yandex-books.lookup] [end] providerId="${safeId}" status=${res.status} found=true durationMs=${Date.now() - startedAt}`);
      return candidate;
    } catch (error) {
      if (error instanceof ProviderThrottleError) {
        this.logger.warn(
          `[yandex-books.lookup] [fail] providerId="${safeId}" durationMs=${Date.now() - startedAt} errorClass=ProviderThrottleError error="throttled"`,
        );
        throw error;
      }
      markProviderFailed('yandexBooks.lookup: request failed');
      this.logger.warn(
        `[yandex-books.lookup] [fail] providerId="${safeId}" durationMs=${Date.now() - startedAt} errorClass=${error instanceof Error ? error.name : 'UnknownError'} error="${sanitizeLogValue(error instanceof Error ? error.message : String(error))}"`,
      );
      throw error;
    }
  }

  private buildQuery(params: MetadataSearchParams): string | null {
    const terms = [params.title, params.author]
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter(Boolean);
    return terms.length > 0 ? terms.join(' ') : null;
  }
}
