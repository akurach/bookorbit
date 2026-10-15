import { api } from '@/lib/api'
import type {
  ExternalStatusPolicy,
  UpsertYandexBooksSettingsPayload,
  YandexBooksEntryList,
  YandexBooksSettings,
  YandexBooksSyncPayload,
} from '@bookorbit/types'

const BASE = '/api/v1/yandex-books'

async function errorMessage(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => ({}))
  return (body as { message?: string }).message ?? fallback
}

export async function fetchYandexBooksSettings(): Promise<YandexBooksSettings> {
  const res = await api(`${BASE}/settings`)
  if (!res.ok) throw new Error(await errorMessage(res, 'Failed to fetch Yandex Books settings'))
  return res.json()
}

export async function upsertYandexBooksSettings(payload: UpsertYandexBooksSettingsPayload): Promise<YandexBooksSettings> {
  const res = await api(`${BASE}/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(await errorMessage(res, 'Failed to save Yandex Books settings'))
  return res.json()
}

export async function disconnectYandexBooks(): Promise<void> {
  const res = await api(`${BASE}/settings`, { method: 'DELETE' })
  if (!res.ok) throw new Error(await errorMessage(res, 'Failed to disconnect Yandex Books'))
}

export async function startYandexBooksSync(payload: YandexBooksSyncPayload = {}): Promise<void> {
  const res = await api(`${BASE}/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(await errorMessage(res, 'Failed to start Yandex Books update'))
}

export async function applyYandexBooksImport(entryIds?: number[]): Promise<void> {
  const res = await api(`${BASE}/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entryIds ? { entryIds } : {}),
  })
  if (!res.ok) throw new Error(await errorMessage(res, 'Failed to import Yandex Books'))
}

export async function fetchYandexBooksEntries(page = 1, pageSize = 20, state?: string): Promise<YandexBooksEntryList> {
  const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) })
  if (state) query.set('state', state)
  const res = await api(`${BASE}/entries?${query.toString()}`)
  if (!res.ok) throw new Error(await errorMessage(res, 'Failed to fetch Yandex Books entries'))
  return res.json()
}

export async function linkYandexBooksEntry(entryId: number, bookId: number): Promise<void> {
  const res = await api(`${BASE}/entries/${entryId}/link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bookId }),
  })
  if (!res.ok) throw new Error(await errorMessage(res, 'Failed to link Yandex Books entry'))
}

export async function resolveYandexBooksEntry(entryId: number, policy: ExternalStatusPolicy): Promise<void> {
  const res = await api(`${BASE}/entries/${entryId}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ policy }),
  })
  if (!res.ok) throw new Error(await errorMessage(res, 'Failed to resolve Yandex Books conflict'))
}
