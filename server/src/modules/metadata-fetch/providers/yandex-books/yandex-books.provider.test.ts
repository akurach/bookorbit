import { ProviderConfigService } from '../../../metadata-preferences/provider-config.service';
import { ProviderCallRecord, runWithProviderCallRecord } from '../../../../common/provider-cache/provider-call-context';
import { fetchWithThrottle } from '../../fetch-with-throttle';
import { ProviderThrottleError } from '../../provider-throttle.error';
import { YandexBooksProvider } from './yandex-books.provider';

vi.mock('../../fetch-with-throttle', () => ({ fetchWithThrottle: vi.fn() }));

const mockFetchWithThrottle = vi.mocked(fetchWithThrottle);

function config(enabled = true): ProviderConfigService {
  return {
    getConfig: vi.fn().mockResolvedValue({ yandexBooks: { enabled } }),
  } as unknown as ProviderConfigService;
}

function searchResponse(page: unknown[]) {
  return { data: { search: { page } } };
}

describe('YandexBooksProvider', () => {
  afterEach(() => vi.restoreAllMocks());

  it('does nothing while disabled', async () => {
    const provider = new YandexBooksProvider(config(false));

    await expect(provider.search({ title: 'Бюро темных дел' })).resolves.toEqual([]);
    expect(mockFetchWithThrottle).not.toHaveBeenCalled();
  });

  it('declares ebook-only media support and cache inputs that change its result', () => {
    const provider = new YandexBooksProvider(config());

    expect(provider.mediaKinds).toEqual(['ebook']);
    expect(
      provider.cache.describeSearch({ title: 'Книга', author: 'Автор', isbn: 'ignored', isAudiobook: true, maxCandidatesPerProvider: 3 }),
    ).toEqual({
      inputs: { title: 'Книга', author: 'Автор', isAudiobook: true },
      maxCandidates: 3,
    });
  });

  it('searches text books by title and author when an ISBN is also present', async () => {
    mockFetchWithThrottle.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi
        .fn()
        .mockResolvedValue(
          searchResponse([{ __typename: 'TextBook', book: { uuid: 'text1', name: 'Бюро темных дел', authors: [{ name: 'Эрик Фуасье' }] } }]),
        ),
    } as unknown as Response);
    const provider = new YandexBooksProvider(config());

    const result = await provider.search({ title: 'Бюро темных дел', author: 'Эрик Фуасье', isbn: '9798688591507' });

    expect(result).toHaveLength(1);
    expect(mockFetchWithThrottle).toHaveBeenCalledWith(
      'https://api-gateway.bookmate.yandex.net/graphql',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('Бюро темных дел Эрик Фуасье'),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(JSON.parse(mockFetchWithThrottle.mock.calls[0]?.[1]?.body as string).variables.query.types).toEqual(['TEXTBOOK']);
  });

  it('does not pretend to support ISBN-only search', async () => {
    const provider = new YandexBooksProvider(config());

    await expect(provider.search({ isbn: '9798688591507' })).resolves.toEqual([]);
    expect(mockFetchWithThrottle).not.toHaveBeenCalled();
  });

  it('returns only unique TextBook results within the requested cap', async () => {
    mockFetchWithThrottle.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue(
        searchResponse([
          { __typename: 'AudioBook', book: { uuid: 'audio1', name: 'Audio' } },
          { __typename: 'ComicBook', book: { uuid: 'comic1', name: 'Comic' } },
          { __typename: 'TextBook', book: { uuid: 'text1', name: 'First' } },
          { __typename: 'TextBook', book: { uuid: 'text1', name: 'First duplicate' } },
          { __typename: 'TextBook', book: { uuid: 'text2', name: 'Second' } },
        ]),
      ),
    } as unknown as Response);
    const provider = new YandexBooksProvider(config());

    const result = await provider.search({ title: 'query', maxCandidatesPerProvider: 1 });

    expect(result).toEqual([expect.objectContaining({ providerId: 'text1', title: 'First' })]);
    expect(mockFetchWithThrottle).toHaveBeenCalledOnce();
  });

  it('returns no candidates for audiobook requests and degrades malformed TextBook entries', async () => {
    const provider = new YandexBooksProvider(config());
    await expect(provider.search({ title: 'query', isAudiobook: true })).resolves.toEqual([]);
    expect(mockFetchWithThrottle).not.toHaveBeenCalled();

    mockFetchWithThrottle.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue(searchResponse([{ __typename: 'TextBook', book: { uuid: 'book-id', name: 'Invalid' } }])),
    } as unknown as Response);
    const record = new ProviderCallRecord();
    await expect(runWithProviderCallRecord(record, () => provider.search({ title: 'query' }))).resolves.toEqual([]);
    expect(record.degradationReasons).toContain('yandexBooks.search: TextBook entry did not map');
  });

  it('does not turn GraphQL errors or malformed responses into trustworthy empty results', async () => {
    mockFetchWithThrottle.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ errors: [{ message: 'Whitelist: query not found' }] }),
    } as unknown as Response);
    const provider = new YandexBooksProvider(config());

    await expect(provider.search({ title: 'query' })).resolves.toEqual([]);
  });

  it('propagates cancellation and throttling to the search pipeline', async () => {
    const provider = new YandexBooksProvider(config());
    mockFetchWithThrottle.mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await expect(provider.search({ title: 'query', signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });

    mockFetchWithThrottle.mockRejectedValueOnce(new ProviderThrottleError());
    await expect(provider.search({ title: 'query' })).rejects.toBeInstanceOf(ProviderThrottleError);
  });

  it('rejects invalid ids locally and treats a REST 404 as an absent book', async () => {
    const provider = new YandexBooksProvider(config());

    await expect(provider.lookupById('../unsafe')).resolves.toBeNull();
    await expect(provider.lookupById('book-id')).resolves.toBeNull();
    expect(mockFetchWithThrottle).not.toHaveBeenCalled();

    mockFetchWithThrottle.mockResolvedValue({ ok: false, status: 404 } as Response);
    await expect(provider.lookupById('mqK3FFjg')).resolves.toBeNull();
    expect(mockFetchWithThrottle).toHaveBeenCalledWith(
      'https://api.bookmate.yandex.net/api/v5/books/mqK3FFjg',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
