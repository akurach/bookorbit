import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Library, YandexBooksEntry, YandexBooksSettings } from '@bookorbit/types'

type ApiModule = typeof import('@/lib/api')

const apiMock = vi.hoisted(() => vi.fn<ApiModule['api']>())

vi.mock('@/lib/api', () => ({ api: apiMock }))
vi.mock('@/features/auth/composables/usePermissions', () => ({
  usePermissions: () => ({ hasPermission: vi.fn<(permission: string) => boolean>().mockReturnValue(true) }),
}))

import { api } from '@/lib/api'
import { resetLibraries } from '@/features/library/composables/useLibraries'
import YandexBooksSettingsPage from '../YandexBooksSettings.vue'

const libraries: Library[] = [
  {
    id: 7,
    type: 'books',
    name: 'Books',
    icon: null,
    displayOrder: 0,
    coverAspectRatio: '2/3',
    watch: false,
    autoScanCronExpression: null,
    metadataPrecedence: [],
    formatPriority: [],
    allowedFormats: [],
    organizationMode: 'book_per_file',
    addedAtSource: 'imported',
    excludePatterns: [],
    readingThreshold: 10,
    markAsFinishedPercentComplete: 90,
    fileNamingPattern: null,
    fileWriteEnabled: false,
    fileWriteWriteCover: false,
    fileWriteEpubEnabled: false,
    fileWriteEpubMaxFileSizeMb: 100,
    fileWriteFb2Enabled: false,
    fileWriteFb2MaxFileSizeMb: 100,
    fileWritePdfEnabled: false,
    fileWritePdfMaxFileSizeMb: 100,
    fileWriteCbxEnabled: false,
    fileWriteCbxMaxFileSizeMb: 500,
    fileWriteKindleEnabled: false,
    fileWriteKindleMaxFileSizeMb: 100,
    fileWriteAudioEnabled: false,
    fileWriteAudioMaxFileSizeMb: 500,
    fileWriteAllFiles: false,
    fileWriteReadAlongEnabled: false,
    fileWriteReadAlongMaxFileSizeMb: 1000,
    fileRenameEnabled: false,
    folders: [{ id: 9, path: '/books', role: 'downloads', createdAt: '2026-10-15T00:00:00.000Z' }],
    createdAt: '2026-10-15T00:00:00.000Z',
    updatedAt: '2026-10-15T00:00:00.000Z',
  },
]

const settings: YandexBooksSettings = {
  tokenConfigured: true,
  encryptionConfigured: true,
  accountLogin: 'reader',
  accountName: 'Reader',
  libraryId: 7,
  libraryFolderId: 9,
  autoSync: true,
  intervalHours: 24,
  needsReauth: false,
  syncing: false,
  lastSyncedAt: null,
  nextSyncAt: null,
  lastError: null,
  lastResult: null,
}

function entry(overrides: Partial<YandexBooksEntry> = {}): YandexBooksEntry {
  return {
    id: 4,
    bookId: 31,
    state: 'imported',
    statusPolicy: 'safe',
    conflict: null,
    lastSeenAt: '2026-10-15T00:00:00.000Z',
    item: {
      provider: 'yandexBooks',
      externalId: 'y-4',
      mediaKind: 'ebook',
      title: 'Imported duplicate',
      authors: ['Author'],
      description: null,
      language: null,
      coverUrl: null,
      pageCount: null,
      isbn: null,
      sourceUrl: 'https://books.yandex.ru/books/y-4',
      remoteStatus: 'reading',
      status: 'reading',
      percentage: 20,
      positionSeconds: null,
      durationSeconds: null,
      startedAt: null,
      finishedAt: null,
      sourceUpdatedAt: null,
    },
    ...overrides,
  }
}

function response(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: vi.fn<() => Promise<unknown>>().mockResolvedValue(body) } as unknown as Response
}

function buttonByText(wrapper: ReturnType<typeof mount>, text: string) {
  const button = wrapper.findAll('button').find((candidate) => candidate.text().trim() === text)
  if (!button) throw new Error(`Button not found: ${text}`)
  return button
}

function mockApi(entries: (page: number, state?: string) => { items: YandexBooksEntry[]; total: number; page: number; pageSize: number }): void {
  vi.mocked(api).mockImplementation(async (input) => {
    const path = String(input)
    if (path === '/api/v1/libraries') return response(libraries)
    if (path === '/api/v1/yandex-books/settings') return response(settings)
    if (path.startsWith('/api/v1/yandex-books/entries?')) {
      const url = new URL(path, 'http://bookorbit.test')
      return response(entries(Number(url.searchParams.get('page')), url.searchParams.get('state') ?? undefined))
    }
    if (path === '/api/v1/yandex-books/sync') return response({})
    if (path === '/api/v1/yandex-books/entries/4/link') return response({})
    if (path === '/api/v1/libraries/7/books') {
      return response({ items: [{ id: 42, title: 'Original book', authors: ['Author'], files: [{ id: 1 }] }], total: 1, page: 0, size: 10 })
    }
    throw new Error(`Unexpected request: ${path}`)
  })
}

beforeEach(() => {
  resetLibraries()
  apiMock.mockReset()
})

afterEach(() => vi.useRealTimers())
enableAutoUnmount(afterEach)

describe('YandexBooksSettings integration', () => {
  it('filters entries and follows the server page selected by the user', async () => {
    mockApi((page, state) => {
      if (state === 'ready' && page === 2)
        return {
          items: [entry({ id: 8, bookId: null, state: 'ready', item: { ...entry().item, title: 'Second ready' } })],
          total: 21,
          page,
          pageSize: 20,
        }
      if (state === 'ready')
        return {
          items: [entry({ id: 7, bookId: null, state: 'ready', item: { ...entry().item, title: 'First ready' } })],
          total: 21,
          page,
          pageSize: 20,
        }
      return { items: [entry()], total: 1, page, pageSize: 20 }
    })

    const wrapper = mount(YandexBooksSettingsPage, { props: { embedded: true } })
    await flushPromises()

    const stateSelect = wrapper.findAll('select').at(-1)
    if (!stateSelect) throw new Error('Entry state selector was not rendered')
    await stateSelect.setValue('ready')
    await flushPromises()
    expect(wrapper.text()).toContain('First ready')
    expect(api).toHaveBeenCalledWith('/api/v1/yandex-books/entries?page=1&pageSize=20&state=ready')

    await buttonByText(wrapper, 'Next').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Second ready')
    expect(api).toHaveBeenCalledWith('/api/v1/yandex-books/entries?page=2&pageSize=20&state=ready')
  })

  it('selects an existing book and relinks an imported duplicate through the API', async () => {
    vi.useFakeTimers()
    mockApi((page) => ({ items: [entry()], total: 1, page, pageSize: 20 }))

    const wrapper = mount(YandexBooksSettingsPage, { props: { embedded: true } })
    await flushPromises()
    await buttonByText(wrapper, 'Change linked book').trigger('click')

    const picker = wrapper.get('input[placeholder="Search this library by title or author"]')
    await picker.setValue('original')
    await vi.advanceTimersByTimeAsync(200)
    await flushPromises()
    const originalBook = wrapper.findAll('button').find((candidate) => candidate.text().includes('Original book'))
    expect(originalBook).toBeTruthy()
    await originalBook!.trigger('mousedown')
    await buttonByText(wrapper, 'Link').trigger('click')
    await flushPromises()

    expect(api).toHaveBeenCalledWith(
      '/api/v1/yandex-books/entries/4/link',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ bookId: 42 }) }),
    )
    expect(wrapper.text()).not.toContain('The empty imported card is removed only when it has no files or local changes')
  })

  it('shows an update error and retries the same action successfully', async () => {
    let syncAttempts = 0
    mockApi((page) => ({ items: [entry()], total: 1, page, pageSize: 20 }))
    vi.mocked(api).mockImplementation(async (input, init) => {
      const path = String(input)
      if (path === '/api/v1/yandex-books/sync') {
        syncAttempts += 1
        return syncAttempts === 1 ? response({ message: 'Connection rejected' }, false) : response({})
      }
      return mockApiResponse(path, init)
    })

    const wrapper = mount(YandexBooksSettingsPage, { props: { embedded: true } })
    await flushPromises()
    await buttonByText(wrapper, 'Update preview').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Connection rejected')

    await buttonByText(wrapper, 'Update preview').trigger('click')
    await flushPromises()
    expect(syncAttempts).toBe(2)
    expect(wrapper.text()).not.toContain('Connection rejected')
  })
})

async function mockApiResponse(input: string, _init?: RequestInit): Promise<Response> {
  if (input === '/api/v1/libraries') return response(libraries)
  if (input === '/api/v1/yandex-books/settings') return response(settings)
  if (input.startsWith('/api/v1/yandex-books/entries?')) return response({ items: [entry()], total: 1, page: 1, pageSize: 20 })
  if (input === '/api/v1/libraries/7/books') {
    return response({ items: [{ id: 42, title: 'Original book', authors: ['Author'], files: [{ id: 1 }] }], total: 1, page: 0, size: 10 })
  }
  throw new Error(`Unexpected request: ${input}`)
}
