import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { YandexBooksSettings } from '@bookorbit/types'

type YandexBooksApi = typeof import('../../api/yandex-books.api')

vi.mock('../../api/yandex-books.api', () => ({
  applyYandexBooksImport: vi.fn<YandexBooksApi['applyYandexBooksImport']>(),
  disconnectYandexBooks: vi.fn<YandexBooksApi['disconnectYandexBooks']>(),
  fetchYandexBooksEntries: vi.fn<YandexBooksApi['fetchYandexBooksEntries']>(),
  fetchYandexBooksSettings: vi.fn<YandexBooksApi['fetchYandexBooksSettings']>(),
  linkYandexBooksEntry: vi.fn<YandexBooksApi['linkYandexBooksEntry']>(),
  resolveYandexBooksEntry: vi.fn<YandexBooksApi['resolveYandexBooksEntry']>(),
  startYandexBooksSync: vi.fn<YandexBooksApi['startYandexBooksSync']>(),
  upsertYandexBooksSettings: vi.fn<YandexBooksApi['upsertYandexBooksSettings']>(),
}))

import { applyYandexBooksImport, fetchYandexBooksEntries, fetchYandexBooksSettings, startYandexBooksSync } from '../../api/yandex-books.api'
import { useYandexBooks } from '../useYandexBooks'

const SETTINGS: YandexBooksSettings = {
  tokenConfigured: true,
  encryptionConfigured: true,
  accountLogin: 'reader',
  accountName: 'Reader',
  libraryId: 1,
  libraryFolderId: 2,
  autoSync: true,
  intervalHours: 24,
  needsReauth: false,
  syncing: false,
  lastSyncedAt: null,
  nextSyncAt: null,
  lastError: null,
  lastResult: null,
}

describe('useYandexBooks', () => {
  beforeEach(() => vi.clearAllMocks())

  it('keeps per-view state private instead of sharing it with a later account session', async () => {
    vi.mocked(fetchYandexBooksSettings).mockResolvedValue(SETTINGS)
    const first = useYandexBooks()
    const second = useYandexBooks()

    await first.loadSettings()

    expect(first.settings.value?.accountLogin).toBe('reader')
    expect(second.settings.value).toBeNull()
  })

  it('updates all remote statuses by default and imports all staged pages without sending current-page ids', async () => {
    vi.mocked(startYandexBooksSync).mockResolvedValue(undefined)
    vi.mocked(applyYandexBooksImport).mockResolvedValue(undefined)
    vi.mocked(fetchYandexBooksSettings).mockResolvedValue(SETTINGS)
    vi.mocked(fetchYandexBooksEntries).mockResolvedValue({ items: [], total: 44, page: 1, pageSize: 20 })
    const integration = useYandexBooks()

    await integration.startSync()
    await integration.importEntries()

    expect(startYandexBooksSync).toHaveBeenCalledWith({ preview: false })
    expect(applyYandexBooksImport).toHaveBeenCalledWith(undefined)
    expect(fetchYandexBooksEntries).toHaveBeenCalledWith(1, 20, undefined)
  })
})
