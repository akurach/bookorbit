import { computed, ref } from 'vue'
import type { ExternalStatusPolicy, UpsertYandexBooksSettingsPayload, YandexBooksEntryList, YandexBooksSettings } from '@bookorbit/types'
import {
  applyYandexBooksImport,
  disconnectYandexBooks,
  fetchYandexBooksEntries,
  fetchYandexBooksSettings,
  linkYandexBooksEntry,
  resolveYandexBooksEntry,
  startYandexBooksSync,
  upsertYandexBooksSettings,
} from '../api/yandex-books.api'

export function useYandexBooks() {
  const settings = ref<YandexBooksSettings | null>(null)
  const entries = ref<YandexBooksEntryList | null>(null)
  const loading = ref(false)
  const saving = ref(false)
  const syncing = ref(false)
  const importing = ref(false)
  const error = ref<string | null>(null)
  let pollTimer: ReturnType<typeof setTimeout> | null = null

  function clearPollTimer(): void {
    if (!pollTimer) return
    clearTimeout(pollTimer)
    pollTimer = null
  }
  const connected = computed(() => settings.value?.tokenConfigured === true)

  async function loadSettings(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      settings.value = await fetchYandexBooksSettings()
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : 'Failed to load Yandex Books settings'
    } finally {
      loading.value = false
    }
  }

  async function saveSettings(payload: UpsertYandexBooksSettingsPayload): Promise<boolean> {
    saving.value = true
    error.value = null
    try {
      settings.value = await upsertYandexBooksSettings(payload)
      return true
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : 'Failed to save Yandex Books settings'
      return false
    } finally {
      saving.value = false
    }
  }

  async function disconnect(): Promise<boolean> {
    saving.value = true
    error.value = null
    try {
      await disconnectYandexBooks()
      settings.value = null
      entries.value = null
      return true
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : 'Failed to disconnect Yandex Books'
      return false
    } finally {
      saving.value = false
    }
  }

  async function loadEntries(page = 1, state?: string): Promise<void> {
    try {
      entries.value = await fetchYandexBooksEntries(page, 20, state)
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : 'Failed to load Yandex Books entries'
    }
  }

  async function refreshAfterSync(): Promise<void> {
    await loadSettings()
    if (settings.value?.syncing) {
      clearPollTimer()
      pollTimer = setTimeout(() => void refreshAfterSync(), 1500)
      return
    }
    syncing.value = false
    importing.value = false
    await loadEntries(entries.value?.page ?? 1)
  }

  async function startSync(preview = false): Promise<boolean> {
    syncing.value = true
    error.value = null
    try {
      await startYandexBooksSync({ preview })
      await refreshAfterSync()
      return true
    } catch (cause) {
      syncing.value = false
      error.value = cause instanceof Error ? cause.message : 'Failed to start Yandex Books update'
      return false
    }
  }

  async function importEntries(entryIds?: number[]): Promise<boolean> {
    importing.value = true
    error.value = null
    try {
      await applyYandexBooksImport(entryIds)
      await refreshAfterSync()
      return true
    } catch (cause) {
      importing.value = false
      error.value = cause instanceof Error ? cause.message : 'Failed to import Yandex Books'
      return false
    }
  }

  async function resolveEntry(entryId: number, policy: ExternalStatusPolicy): Promise<boolean> {
    error.value = null
    try {
      await resolveYandexBooksEntry(entryId, policy)
      await loadEntries(entries.value?.page ?? 1)
      return true
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : 'Failed to resolve Yandex Books conflict'
      return false
    }
  }

  async function linkEntry(entryId: number, bookId: number): Promise<boolean> {
    error.value = null
    try {
      await linkYandexBooksEntry(entryId, bookId)
      await loadEntries(entries.value?.page ?? 1)
      return true
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : 'Failed to link Yandex Books entry'
      return false
    }
  }

  function stopPolling(): void {
    clearPollTimer()
  }

  return {
    settings,
    entries,
    loading,
    saving,
    syncing,
    importing,
    error,
    connected,
    loadSettings,
    saveSettings,
    disconnect,
    loadEntries,
    startSync,
    importEntries,
    resolveEntry,
    linkEntry,
    stopPolling,
  }
}
