import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { YandexBooksEntry, YandexBooksSettings } from '@bookorbit/types'

const state = vi.hoisted(() => ({
  linkEntry: vi.fn<(entryId: number, bookId: number) => Promise<boolean>>(),
  loadEntries: vi.fn<() => Promise<void>>(),
  loadSettings: vi.fn<() => Promise<void>>(),
  fetchLibraries: vi.fn<() => Promise<void>>(),
}))

const settings = ref<YandexBooksSettings | null>(null)
const entries = ref<{ items: YandexBooksEntry[]; total: number; page: number; pageSize: number } | null>(null)

vi.mock('vue-sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/features/auth/composables/usePermissions', () => ({ usePermissions: () => ({ hasPermission: () => true }) }))
vi.mock('@/features/library/composables/useLibraries', () => ({
  useLibraries: () => ({
    libraries: ref([{ id: 7, name: 'Books', type: 'books', folders: [{ id: 9, path: '/books' }] }]),
    fetchLibraries: state.fetchLibraries,
  }),
}))
vi.mock('../../composables/useYandexBooks', () => ({
  useYandexBooks: () => ({
    settings,
    entries,
    loading: ref(false),
    saving: ref(false),
    syncing: ref(false),
    importing: ref(false),
    error: ref(null),
    connected: ref(true),
    loadSettings: state.loadSettings,
    saveSettings: vi.fn(),
    disconnect: vi.fn(),
    loadEntries: state.loadEntries,
    startSync: vi.fn(),
    importEntries: vi.fn(),
    resolveEntry: vi.fn(),
    linkEntry: state.linkEntry,
    stopPolling: vi.fn(),
  }),
}))

import YandexBooksSettingsPage from '../YandexBooksSettings.vue'

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

beforeEach(() => {
  settings.value = {
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
  entries.value = { items: [entry()], total: 1, page: 1, pageSize: 20 }
  state.linkEntry.mockReset().mockResolvedValue(true)
  state.loadEntries.mockReset().mockResolvedValue(undefined)
  state.loadSettings.mockReset().mockResolvedValue(undefined)
  state.fetchLibraries.mockReset().mockResolvedValue(undefined)
})

describe('YandexBooksSettings', () => {
  it('offers duplicate repair for imported entries and excludes the current card from the picker', async () => {
    const wrapper = mount(YandexBooksSettingsPage)
    await flushPromises()

    const changeLink = wrapper.findAll('button').find((button) => button.text().trim() === 'Change linked book')
    expect(changeLink).toBeTruthy()
    await changeLink!.trigger('click')

    expect(wrapper.text()).toContain('The empty imported card is removed only when it has no files or local changes')
    const picker = wrapper.findComponent({ name: 'YandexBooksBookPicker' })
    expect(picker.props('excludeBookId')).toBe(31)
  })
})
