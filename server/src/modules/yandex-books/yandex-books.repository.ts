import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, inArray, lte, ne, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Permission, type ExternalCatalogItem, type YandexBooksSyncResult } from '@bookorbit/types';

import { DB } from '../../db';
import * as schema from '../../db/schema';
import type { NewYandexBooksSetting, YandexBooksEntryRow, YandexBooksSetting } from '../../db/schema';

const settings = schema.yandexBooksSettings;
const entries = schema.yandexBooksEntries;
const staging = schema.yandexBooksStaging;
const LEASE_MS = 120_000;
type Db = NodePgDatabase<typeof schema>;
export type YandexBooksLease = YandexBooksSetting & { leaseId: string };

@Injectable()
export class YandexBooksRepository {
  private lockTail: Promise<void> = Promise.resolve();
  constructor(@Inject(DB) private readonly db: Db) {}

  // The advisory lock also spans the book module's transaction. Disconnect waits for
  // the current book write, then invalidates every subsequent write from that job.
  async withUserLock<T>(userId: number, work: () => Promise<T>): Promise<T> {
    const previous = this.lockTail;
    let release!: () => void;
    this.lockTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.db.transaction(async (tx) => {
        const result = await tx.execute<{ acquired: boolean }>(sql`select pg_try_advisory_xact_lock(73619841, ${userId}) as acquired`);
        if (!result.rows[0]?.acquired) throw new ConflictException('Yandex Books account is busy on another server');
        return work();
      });
    } finally {
      release();
    }
  }

  findSettings(userId: number): Promise<YandexBooksSetting | undefined> {
    return this.db.query.yandexBooksSettings.findFirst({ where: eq(settings.userId, userId) });
  }

  async saveSettings(userId: number, data: Omit<NewYandexBooksSetting, 'id' | 'userId'>): Promise<void> {
    await this.db
      .insert(settings)
      .values({ ...data, userId })
      .onConflictDoUpdate({
        target: settings.userId,
        set: { ...data, updatedAt: new Date() },
      });
  }

  async disconnect(userId: number): Promise<void> {
    await this.db.delete(settings).where(eq(settings.userId, userId));
    await this.db.delete(staging).where(eq(staging.userId, userId));
  }

  async hasImportPermission(userId: number): Promise<boolean> {
    const rows = await this.db
      .select({ superuser: schema.users.isSuperuser, permission: schema.userPermissions.permissionName })
      .from(schema.users)
      .leftJoin(
        schema.userPermissions,
        and(
          eq(schema.userPermissions.userId, schema.users.id),
          inArray(schema.userPermissions.permissionName, [Permission.YandexBooksSync, Permission.LibraryUpload]),
        ),
      )
      .where(and(eq(schema.users.id, userId), eq(schema.users.active, true)));
    if (rows.some((row) => row.superuser)) return true;
    const permissions = new Set(rows.map((row) => row.permission));
    return permissions.has(Permission.YandexBooksSync) && permissions.has(Permission.LibraryUpload);
  }

  async acquireLease(userId: number): Promise<YandexBooksLease> {
    return this.withUserLock(userId, async () => {
      const current = await this.findSettings(userId);
      if (!current) throw new NotFoundException('Yandex Books integration not configured');
      if (current.leaseUntil && current.leaseUntil > new Date()) throw new ConflictException('Yandex Books update is already running');
      const leaseId = randomUUID();
      const [row] = await this.db
        .update(settings)
        .set({ leaseId, leaseUntil: new Date(Date.now() + LEASE_MS), lastError: null })
        .where(eq(settings.userId, userId))
        .returning();
      await this.db.delete(staging).where(eq(staging.userId, userId));
      return { ...row!, leaseId };
    });
  }

  async withLease<T>(lease: YandexBooksLease, work: () => Promise<T>): Promise<T> {
    return this.withUserLock(lease.userId, async () => {
      const [owned] = await this.db
        .update(settings)
        .set({ leaseUntil: new Date(Date.now() + LEASE_MS) })
        .where(and(this.leaseCondition(lease), gt(settings.leaseUntil, new Date())))
        .returning({ id: settings.id });
      if (!owned) throw new ConflictException('Yandex Books update was superseded or disconnected');
      return work();
    });
  }

  async finish(lease: YandexBooksLease, result: YandexBooksSyncResult): Promise<void> {
    await this.db
      .update(settings)
      .set({
        lastSyncedAt: new Date(),
        lastResult: result,
        lastError: null,
        needsReauth: false,
        nextSyncAt: lease.autoSync ? new Date(Date.now() + lease.intervalHours * 3_600_000) : null,
        leaseId: null,
        leaseUntil: null,
      })
      .where(this.leaseCondition(lease));
  }

  async fail(lease: YandexBooksLease, message: string, reauth: boolean): Promise<void> {
    await this.db
      .update(settings)
      .set({
        lastError: message,
        needsReauth: reauth,
        leaseId: null,
        leaseUntil: null,
        nextSyncAt: lease.autoSync && !reauth ? new Date(Date.now() + 60 * 60_000) : null,
      })
      .where(this.leaseCondition(lease));
  }

  async release(lease: YandexBooksLease): Promise<void> {
    await this.db.update(settings).set({ leaseId: null, leaseUntil: null }).where(this.leaseCondition(lease));
    await this.db.delete(staging).where(and(eq(staging.userId, lease.userId), eq(staging.runId, lease.leaseId)));
  }

  async due(limit: number): Promise<number[]> {
    const rows = await this.db
      .select({ userId: settings.userId })
      .from(settings)
      .where(
        and(
          eq(settings.autoSync, true),
          eq(settings.needsReauth, false),
          lte(settings.nextSyncAt, new Date()),
          sql`(${settings.leaseUntil} is null or ${settings.leaseUntil} <= now())`,
        ),
      )
      .orderBy(asc(settings.nextSyncAt))
      .limit(limit);
    return rows.map((row) => row.userId);
  }

  async stagePage(lease: YandexBooksLease, items: ExternalCatalogItem[]): Promise<void> {
    if (!items.length) return;
    await this.db
      .insert(staging)
      .values(
        items.map((item) => ({
          userId: lease.userId,
          accountId: lease.accountId,
          runId: lease.leaseId,
          externalId: item.externalId,
          mediaKind: item.mediaKind,
          snapshot: item,
        })),
      )
      .onConflictDoUpdate({
        target: [staging.userId, staging.runId, staging.externalId, staging.mediaKind],
        set: { snapshot: sql`excluded.snapshot` },
      });
  }

  async promote(lease: YandexBooksLease): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`
        insert into yandex_books_entries (user_id, account_id, external_id, media_kind, snapshot, generation, last_seen_at)
        select user_id, account_id, external_id, media_kind, snapshot, run_id, now()
        from yandex_books_staging where user_id = ${lease.userId} and run_id = ${lease.leaseId}
        on conflict (user_id, account_id, external_id, media_kind)
        do update set snapshot = excluded.snapshot, generation = excluded.generation, last_seen_at = now(), updated_at = now()
      `);
      await tx.update(settings).set({ completedGeneration: lease.leaseId }).where(this.leaseCondition(lease));
    });
  }

  async listEntries(userId: number, page: number, pageSize: number, state?: string): Promise<{ rows: YandexBooksEntryRow[]; total: number }> {
    const connection = await this.findSettings(userId);
    if (!connection) return { rows: [], total: 0 };
    const condition = and(
      eq(entries.userId, userId),
      eq(entries.accountId, connection.accountId),
      state ? eq(entries.state, state as YandexBooksEntryRow['state']) : undefined,
    );
    const [rows, counts] = await Promise.all([
      this.db
        .select()
        .from(entries)
        .where(condition)
        .orderBy(asc(entries.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(entries)
        .where(condition),
    ]);
    return { rows, total: counts[0]?.count ?? 0 };
  }

  async importableEntries(lease: YandexBooksLease, generation: string, afterId: number, ids?: number[]): Promise<YandexBooksEntryRow[]> {
    return this.db
      .select()
      .from(entries)
      .where(
        and(
          eq(entries.userId, lease.userId),
          eq(entries.accountId, lease.accountId),
          eq(entries.generation, generation),
          gt(entries.id, afterId),
          ne(entries.state, 'ignored'),
          ids ? inArray(entries.id, ids) : undefined,
        ),
      )
      .orderBy(asc(entries.id))
      .limit(100);
  }

  async findEntry(userId: number, id: number): Promise<YandexBooksEntryRow | undefined> {
    const connection = await this.findSettings(userId);
    if (!connection) return undefined;
    return this.db.query.yandexBooksEntries.findFirst({
      where: and(eq(entries.userId, userId), eq(entries.accountId, connection.accountId), eq(entries.id, id)),
    });
  }

  async updateEntry(
    id: number,
    userId: number,
    data: Partial<Pick<YandexBooksEntryRow, 'bookId' | 'state' | 'statusPolicy' | 'conflict'>>,
  ): Promise<YandexBooksEntryRow> {
    const [row] = await this.db
      .update(entries)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(entries.id, id), eq(entries.userId, userId)))
      .returning();
    if (!row) throw new NotFoundException('Yandex Books entry not found');
    return row;
  }

  private leaseCondition(lease: YandexBooksLease) {
    return and(eq(settings.userId, lease.userId), eq(settings.revision, lease.revision), eq(settings.leaseId, lease.leaseId));
  }
}
