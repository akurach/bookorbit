import type { ConcreteBookMediaKind, ReadStatus } from "./book";

export type YandexBooksMediaKind = "ebook" | "audiobook" | "comic";
export type YandexBooksEntryState = "ready" | "imported" | "conflict" | "ignored";
export type ExternalStatusPolicy = "safe" | "remote" | "local";

/** A source snapshot, never a local reader position or a reading session. */
export type ExternalCatalogItem = {
  provider: "yandexBooks";
  externalId: string;
  mediaKind: ConcreteBookMediaKind;
  title: string;
  authors: string[];
  description: string | null;
  language: string | null;
  coverUrl: string | null;
  pageCount: number | null;
  isbn: string | null;
  sourceUrl: string;
  remoteStatus: string;
  status: ReadStatus | null;
  percentage: number | null;
  positionSeconds: number | null;
  durationSeconds: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  sourceUpdatedAt: string | null;
};

export type ExternalBookReading = {
  provider: "yandexBooks";
  externalId: string;
  mediaKind: ConcreteBookMediaKind;
  sourceUrl: string;
  remoteStatus: string;
  percentage: number | null;
  positionSeconds: number | null;
  durationSeconds: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  syncedAt: string;
};

export type YandexBooksSettings = {
  tokenConfigured: boolean;
  encryptionConfigured: boolean;
  accountLogin: string | null;
  accountName: string | null;
  libraryId: number | null;
  libraryFolderId: number | null;
  autoSync: boolean;
  intervalHours: number;
  needsReauth: boolean;
  syncing: boolean;
  lastSyncedAt: string | null;
  nextSyncAt: string | null;
  lastError: string | null;
  lastResult: YandexBooksSyncResult | null;
};

export type UpsertYandexBooksSettingsPayload = {
  apiToken?: string;
  libraryId: number;
  libraryFolderId: number;
  autoSync?: boolean;
  intervalHours?: number;
};

export type YandexBooksSyncResult = {
  fetched: number;
  imported: number;
  updated: number;
  conflicts: number;
};

export type YandexBooksEntry = {
  id: number;
  item: ExternalCatalogItem;
  bookId: number | null;
  state: YandexBooksEntryState;
  statusPolicy: ExternalStatusPolicy;
  conflict: string | null;
  lastSeenAt: string;
};

export type YandexBooksEntryList = {
  items: YandexBooksEntry[];
  total: number;
  page: number;
  pageSize: number;
};

export type YandexBooksSyncPayload = { preview?: boolean };
export type YandexBooksImportPayload = { entryIds?: number[] };
export type YandexBooksLinkPayload = { bookId: number };
export type YandexBooksResolvePayload = { policy: "remote" | "local" | "safe" };
