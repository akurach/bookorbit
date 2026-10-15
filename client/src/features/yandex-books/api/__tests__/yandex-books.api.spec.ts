import { beforeEach, describe, expect, it, vi } from 'vitest'

type ApiFn = (input: RequestInfo | URL, init?: RequestInit & { _isRetry?: boolean }) => Promise<Response>

vi.mock('@/lib/api', () => ({
  api: vi.fn<ApiFn>(),
}))

import { api } from '@/lib/api'
import {
  applyYandexBooksImport,
  fetchYandexBooksEntries,
  fetchYandexBooksSettings,
  linkYandexBooksEntry,
  resolveYandexBooksEntry,
  startYandexBooksSync,
  upsertYandexBooksSettings,
} from '../yandex-books.api'

const mockApi = vi.mocked(api)

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: vi.fn<() => Promise<unknown>>().mockResolvedValue(body) } as unknown as Response
}

describe('yandex-books.api', () => {
  beforeEach(() => mockApi.mockReset())

  it('gets connection settings', async () => {
    const settings = { tokenConfigured: true, encryptionConfigured: true, accountLogin: 'reader' }
    mockApi.mockResolvedValueOnce(jsonResponse(settings))

    await expect(fetchYandexBooksSettings()).resolves.toEqual(settings)
    expect(mockApi).toHaveBeenCalledWith('/api/v1/yandex-books/settings')
  })

  it('saves a token and destination only in the PATCH body', async () => {
    mockApi.mockResolvedValueOnce(jsonResponse({ tokenConfigured: true }))

    await upsertYandexBooksSettings({ apiToken: 'private-token', libraryId: 4, libraryFolderId: 9, autoSync: true, intervalHours: 24 })

    expect(mockApi).toHaveBeenCalledWith(
      '/api/v1/yandex-books/settings',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ apiToken: 'private-token', libraryId: 4, libraryFolderId: 9, autoSync: true, intervalHours: 24 }),
      }),
    )
  })

  it('starts a preview update and imports explicitly selected staged entries', async () => {
    mockApi.mockResolvedValueOnce(jsonResponse({})).mockResolvedValueOnce(jsonResponse({}))

    await startYandexBooksSync({ preview: true })
    await applyYandexBooksImport([12, 14])

    expect(mockApi).toHaveBeenNthCalledWith(
      1,
      '/api/v1/yandex-books/sync',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ preview: true }) }),
    )
    expect(mockApi).toHaveBeenNthCalledWith(
      2,
      '/api/v1/yandex-books/import',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ entryIds: [12, 14] }) }),
    )
  })

  it('requests bounded entry pages and sends an explicit conflict policy', async () => {
    mockApi.mockResolvedValueOnce(jsonResponse({ items: [], total: 0, page: 2, pageSize: 20 })).mockResolvedValueOnce(jsonResponse({}))

    await fetchYandexBooksEntries(2, 20, 'conflict')
    await resolveYandexBooksEntry(7, 'local')

    expect(mockApi).toHaveBeenNthCalledWith(1, '/api/v1/yandex-books/entries?page=2&pageSize=20&state=conflict')
    expect(mockApi).toHaveBeenNthCalledWith(
      2,
      '/api/v1/yandex-books/entries/7/resolve',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ policy: 'local' }) }),
    )
  })

  it('uses the same link endpoint to repair an imported duplicate', async () => {
    mockApi.mockResolvedValueOnce(jsonResponse({}))

    await linkYandexBooksEntry(7, 42)

    expect(mockApi).toHaveBeenCalledWith(
      '/api/v1/yandex-books/entries/7/link',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ bookId: 42 }) }),
    )
  })

  it('surfaces the API message', async () => {
    mockApi.mockResolvedValueOnce(jsonResponse({ message: 'Token expired' }, false))

    await expect(startYandexBooksSync()).rejects.toThrow('Token expired')
  })
})
