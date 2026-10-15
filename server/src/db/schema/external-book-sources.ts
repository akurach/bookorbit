import { sql } from 'drizzle-orm';
import type { ConcreteBookMediaKind } from '@bookorbit/types';
import { check, index, integer, pgTable, real, serial, timestamp, unique, varchar } from 'drizzle-orm/pg-core';

import { users } from './auth';
import { books } from './books';

/** A user-private snapshot from an external reading catalog. It never stores reader coordinates. */
export const externalBookSources = pgTable(
  'external_book_sources',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    bookId: integer('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    provider: varchar('provider', { length: 50 }).notNull(),
    externalId: varchar('external_id', { length: 255 }).notNull(),
    mediaKind: varchar('media_kind', { length: 20 }).$type<ConcreteBookMediaKind>().notNull(),
    sourceUrl: varchar('source_url', { length: 2048 }).notNull(),
    remoteStatus: varchar('remote_status', { length: 64 }).notNull(),
    percentage: real('percentage'),
    positionSeconds: integer('position_seconds'),
    durationSeconds: integer('duration_seconds'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    sourceUpdatedAt: timestamp('source_updated_at', { withTimezone: true }),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
    /** Guards safe status imports from overwriting a later local edit. */
    lastAppliedStatusAt: timestamp('last_applied_status_at', { withTimezone: true }),
  },
  (t) => [
    unique('external_book_sources_user_book_provider_external_media_unique').on(t.userId, t.bookId, t.provider, t.externalId, t.mediaKind),
    unique('external_book_sources_user_provider_external_media_unique').on(t.userId, t.provider, t.externalId, t.mediaKind),
    index('external_book_sources_user_book_idx').on(t.userId, t.bookId),
    index('external_book_sources_book_idx').on(t.bookId),
    check('external_book_sources_media_kind_chk', sql`${t.mediaKind} in ('ebook', 'audiobook', 'comic')`),
    check('external_book_sources_percentage_chk', sql`${t.percentage} is null or (${t.percentage} >= 0 and ${t.percentage} <= 100)`),
    check('external_book_sources_position_seconds_chk', sql`${t.positionSeconds} is null or ${t.positionSeconds} >= 0`),
    check('external_book_sources_duration_seconds_chk', sql`${t.durationSeconds} is null or ${t.durationSeconds} >= 0`),
  ],
);

export type ExternalBookSource = typeof externalBookSources.$inferSelect;
export type NewExternalBookSource = typeof externalBookSources.$inferInsert;
