import type { MigrationMeta } from 'drizzle-orm/migrator';
import type { PoolClient } from 'pg';

import { bridgeYandexMigrations, CONSOLIDATED_YANDEX_HASH, LEGACY_YANDEX_HASHES } from './yandex-migration-compatibility';

const migrations: MigrationMeta[] = Array.from({ length: 133 }, (_, i) => ({
  hash: i === 132 ? CONSOLIDATED_YANDEX_HASH : `published-${i}`,
  folderMillis: i,
  sql: [`SQL-${i}`],
  bps: true,
}));

function clientFor(hashes: string[], failSql?: string, providerConflict = false, artifacts = false) {
  const query = vi.fn<(sql: string, params?: unknown[]) => { rows: Record<string, unknown>[]; rowCount?: number }>((sql) => {
    if (sql.includes('SELECT to_regclass') && sql.includes('AS found')) return { rows: [{ found: artifacts }] };
    if (sql.includes('to_regclass')) return { rows: [{ name: 'drizzle.__drizzle_migrations' }] };
    if (sql.startsWith('SELECT hash'))
      return {
        rows: hashes.map((hash, i) => ({
          hash,
          createdAt: i === 111 ? '1791923768935' : i === 112 ? '1792049794975' : String(i),
        })),
      };
    if (sql === failSql) throw new Error('injected failure');
    if (providerConflict && sql.includes('SELECT m.book_id')) return { rows: [{ book_id: 1 }] };
    return { rows: [], rowCount: 0 };
  });
  return { client: { query } as unknown as PoolClient, query };
}

describe('Yandex upgrade bridge', () => {
  const prefix = migrations.slice(0, 111).map((m) => m.hash);
  const legacy = [...prefix, ...LEGACY_YANDEX_HASHES];

  it('leaves a clean published prefix for the ordinary migrator', async () => {
    const { client } = clientFor(prefix);
    await expect(bridgeYandexMigrations(client, migrations, vi.fn())).resolves.toBe('normal');
  });

  it('rejects unrecorded custom schema and duplicate published rows', async () => {
    const partialSchema = clientFor(prefix, undefined, false, true);
    await expect(bridgeYandexMigrations(partialSchema.client, migrations, vi.fn())).rejects.toThrow('partial Yandex schema');
    const duplicate = clientFor([...prefix, prefix[110]]);
    await expect(bridgeYandexMigrations(duplicate.client, migrations, vi.fn())).rejects.toThrow('Unexpected migration ledger');
  });

  it('applies all published SQL and records 0132 after ID backfill', async () => {
    const { client, query } = clientFor(legacy);
    await expect(bridgeYandexMigrations(client, migrations, vi.fn())).resolves.toBe('bridged');
    expect(query).toHaveBeenCalledWith('SQL-111');
    expect(query).toHaveBeenCalledWith('SQL-131');
    expect(query).not.toHaveBeenCalledWith('SQL-132');
    expect(query).toHaveBeenCalledWith('INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)', [
      migrations[132].hash,
      migrations[132].folderMillis,
    ]);
    expect(query).toHaveBeenLastCalledWith('COMMIT');
  });

  it('treats a fully bridged ledger as a repeated no-op', async () => {
    const hashes = [...legacy, ...migrations.slice(111).map((m) => m.hash)];
    const { client, query } = clientFor(hashes);
    await expect(bridgeYandexMigrations(client, migrations, vi.fn())).resolves.toBe('bridged');
    expect(query).not.toHaveBeenCalledWith('SQL-111');
  });

  it('rejects a partial legacy ledger before running any published SQL', async () => {
    const { client, query } = clientFor([...migrations.slice(0, 111).map((m) => m.hash), LEGACY_YANDEX_HASHES[0]]);
    await expect(bridgeYandexMigrations(client, migrations, vi.fn())).rejects.toThrow('partial legacy');
    expect(query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(query).not.toHaveBeenCalledWith('SQL-111');
  });

  it('rolls back when a published statement fails', async () => {
    const { client, query } = clientFor(legacy, 'SQL-115');
    await expect(bridgeYandexMigrations(client, migrations, vi.fn())).rejects.toThrow('injected failure');
    expect(query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(query).not.toHaveBeenCalledWith('SQL-116');
  });

  it('rolls back before published SQL when the catalog differs', async () => {
    const { client, query } = clientFor(legacy);
    await expect(bridgeYandexMigrations(client, migrations, () => Promise.reject(new Error('missing constraint')))).rejects.toThrow(
      'missing constraint',
    );
    expect(query).not.toHaveBeenCalledWith('SQL-111');
    expect(query).toHaveBeenLastCalledWith('ROLLBACK');
  });

  it('rolls back published SQL and does not mark 0132 when an ID conflicts', async () => {
    const { client, query } = clientFor(legacy, undefined, true);
    await expect(bridgeYandexMigrations(client, migrations, vi.fn())).rejects.toThrow('provider ID conflicts');
    expect(query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(
      query.mock.calls.some(
        ([sql, params]) => sql.startsWith('INSERT INTO drizzle.') && (params as unknown[] | undefined)?.[0] === migrations[132].hash,
      ),
    ).toBe(false);
  });
});
