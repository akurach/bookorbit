import { describe, expect, it, vi } from 'vitest';
import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';

import { YandexBooksClientService } from './yandex-books-client.service';

describe('YandexBooksClientService', () => {
  it('reads the real profile.user envelope', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ user: { id: 42, login: 'reader', name: 'Alexander' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new YandexBooksClientService().getProfile('secret')).resolves.toEqual({ id: '42', login: 'reader', name: 'Alexander' });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.bookmate.yandex.net/api/v5/profile');
    expect(fetchMock.mock.calls[0]?.[1].headers['Auth-Token']).toBe('secret');
    expect(fetchMock.mock.calls[0]?.[1].redirect).toBe('error');
    vi.unstubAllGlobals();
  });
  it('fails a malformed collection instead of silently dropping it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ library_cards: {} }), { status: 200 })));
    const pages = new YandexBooksClientService().collectPages('secret', 'reader');
    await expect(pages.next()).rejects.toBeInstanceOf(ServiceUnavailableException);
    vi.unstubAllGlobals();
  });
  it('refuses an unauthorized response without following a redirect with the token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 401 })));
    await expect(new YandexBooksClientService().getProfile('secret')).rejects.toBeInstanceOf(UnauthorizedException);
    vi.unstubAllGlobals();
  });
  it('refuses an oversized chunked body without buffering it all', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(2_000_001)));
        controller.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, { status: 200 })));
    await expect(new YandexBooksClientService().getProfile('secret')).rejects.toBeInstanceOf(ServiceUnavailableException);
    vi.unstubAllGlobals();
  });
  it('fails an invalid entry instead of silently omitting it', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ library_cards: [{ state: 'reading', book: { title: 'Missing identifier' } }] }), { status: 200 }),
        ),
    );
    const pages = new YandexBooksClientService().collectPages('secret', 'reader');
    await expect(pages.next()).rejects.toBeInstanceOf(ServiceUnavailableException);
    vi.unstubAllGlobals();
  });
});
