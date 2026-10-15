import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import type { ExternalCatalogItem, ExternalStatusPolicy, YandexBooksEntryState, YandexBooksSyncResult } from '@bookorbit/types';

import { books } from './books';
import { users } from './auth';
import { libraries, libraryFolders } from './libraries';

export const yandexBooksSettings = pgTable(
  'yandex_books_settings',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' })
      .unique(),
    encryptedToken: text('encrypted_token').notNull(),
    accountId: varchar('account_id', { length: 255 }).notNull(),
    accountLogin: varchar('account_login', { length: 255 }).notNull(),
    accountName: varchar('account_name', { length: 500 }),
    libraryId: integer('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    libraryFolderId: integer('library_folder_id').notNull(),
    autoSync: boolean('auto_sync').notNull().default(false),
    intervalHours: integer('interval_hours').notNull().default(24),
    needsReauth: boolean('needs_reauth').notNull().default(false),
    revision: uuid('revision').notNull().defaultRandom(),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    leaseId: uuid('lease_id'),
    completedGeneration: uuid('completed_generation'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    nextSyncAt: timestamp('next_sync_at', { withTimezone: true }),
    lastError: varchar('last_error', { length: 500 }),
    lastResult: jsonb('last_result').$type<YandexBooksSyncResult>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    index('yandex_books_settings_due_idx')
      .on(t.nextSyncAt)
      .where(sql`${t.autoSync} = true and ${t.needsReauth} = false`),
    foreignKey({
      columns: [t.libraryFolderId, t.libraryId],
      foreignColumns: [libraryFolders.id, libraryFolders.libraryId],
      name: 'yandex_books_settings_folder_library_fk',
    }).onDelete('cascade'),
    check('yandex_books_settings_interval_chk', sql`${t.intervalHours} in (6, 12, 24, 168)`),
  ],
);

export const yandexBooksEntries = pgTable(
  'yandex_books_entries',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: varchar('account_id', { length: 255 }).notNull(),
    externalId: varchar('external_id', { length: 255 }).notNull(),
    mediaKind: varchar('media_kind', { length: 20 }).notNull(),
    snapshot: jsonb('snapshot').$type<ExternalCatalogItem>().notNull(),
    bookId: integer('book_id').references(() => books.id, { onDelete: 'set null' }),
    state: varchar('state', { length: 20 }).$type<YandexBooksEntryState>().notNull().default('ready'),
    statusPolicy: varchar('status_policy', { length: 20 }).$type<ExternalStatusPolicy>().notNull().default('safe'),
    conflict: varchar('conflict', { length: 500 }),
    generation: uuid('generation').notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    unique('yandex_books_entries_user_account_external_media_uidx').on(t.userId, t.accountId, t.externalId, t.mediaKind),
    index('yandex_books_entries_user_account_state_id_idx').on(t.userId, t.accountId, t.state, t.id),
    index('yandex_books_entries_generation_id_idx').on(t.userId, t.generation, t.id),
    check('yandex_books_entries_state_chk', sql`${t.state} in ('ready', 'imported', 'conflict', 'ignored')`),
    check('yandex_books_entries_policy_chk', sql`${t.statusPolicy} in ('safe', 'remote', 'local')`),
    check('yandex_books_entries_media_chk', sql`${t.mediaKind} in ('ebook', 'audiobook', 'comic')`),
  ],
);

export type YandexBooksSetting = typeof yandexBooksSettings.$inferSelect;
export type NewYandexBooksSetting = typeof yandexBooksSettings.$inferInsert;
export type YandexBooksEntryRow = typeof yandexBooksEntries.$inferSelect;

/** Failed paginated pulls never replace the last complete source snapshot. */
export const yandexBooksStaging = pgTable(
  'yandex_books_staging',
  {
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    runId: uuid('run_id').notNull(),
    accountId: varchar('account_id', { length: 255 }).notNull(),
    externalId: varchar('external_id', { length: 255 }).notNull(),
    mediaKind: varchar('media_kind', { length: 20 }).notNull(),
    snapshot: jsonb('snapshot').$type<ExternalCatalogItem>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.runId, t.externalId, t.mediaKind] })],
);
