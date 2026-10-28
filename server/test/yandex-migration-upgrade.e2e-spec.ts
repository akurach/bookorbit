import { randomUUID } from 'crypto';
import { join } from 'path';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { Client, Pool } from 'pg';

import manifest from '../src/scripts/legacy-yandex-schema-manifest';
import { readLegacyYandexCatalog } from '../src/scripts/legacy-yandex-schema';
import { installPostgresExtensions } from '../src/scripts/postgres-extensions';
import { bridgeYandexMigrations, LEGACY_YANDEX_HASHES } from '../src/scripts/yandex-migration-compatibility';
import { backfillYandexProviderIds } from '../src/scripts/yandex-provider-id-backfill';

// Requires a disposable PostgreSQL with CREATEDB and the BookOrbit extensions. Never point at production.
const url = process.env.YANDEX_MIGRATION_TEST_DATABASE_URL ?? process.env.E2E_DATABASE_URL;
const migrations = readMigrationFiles({ migrationsFolder: join(process.cwd(), 'src/db/migrations') });
const quoted = (value: string) => `"${value.replace(/"/g, '""')}"`;
const validate = async (client: Parameters<typeof readLegacyYandexCatalog>[0]) => {
  if (JSON.stringify(await readLegacyYandexCatalog(client)) !== JSON.stringify(manifest)) throw new Error('legacy catalog mismatch');
};

async function apply(client: Client, entries: typeof migrations) {
  await client.query('BEGIN');
  try {
    for (const migration of entries) {
      for (const [index, sql] of migration.sql.entries()) {
        const started = Date.now();
        try {
          await client.query(sql);
        } catch (error) {
          console.error('Migration fixture statement failed', {
            migration: migration.folderMillis,
            statement: index,
            durationMs: Date.now() - started,
            sql: sql.trim().slice(0, 100),
          });
          throw error;
        }
      }
      await client.query('INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)', [migration.hash, migration.folderMillis]);
    }
    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('Migration fixture rollback failed after the original error', rollbackError);
    }
    throw error;
  }
}

async function normalizedSchema(client: Client) {
  return (
    await client.query(`
    SELECT jsonb_build_object(
      'columns', (SELECT jsonb_agg(to_jsonb(c) ORDER BY table_name, column_name) FROM (
        SELECT table_name, column_name, data_type, udt_name, character_maximum_length, is_nullable, column_default
        FROM information_schema.columns WHERE table_schema = 'public') c),
      'constraints', (SELECT jsonb_agg(to_jsonb(c) ORDER BY table_name, name) FROM (
        SELECT r.relname AS table_name, x.conname AS name, pg_get_constraintdef(x.oid, true) AS definition
        FROM pg_constraint x JOIN pg_class r ON r.oid=x.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace
        WHERE n.nspname='public') c),
      'indexes', (SELECT jsonb_agg(to_jsonb(i) ORDER BY table_name, name) FROM (
        SELECT t.relname AS table_name, x.relname AS name, pg_get_indexdef(x.oid) AS definition
        FROM pg_index p JOIN pg_class t ON t.oid=p.indrelid JOIN pg_class x ON x.oid=p.indexrelid
        JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public') i)
    ) AS schema
  `)
  ).rows[0].schema;
}

describe.skipIf(!url)('Yandex migration upgrade on disposable PostgreSQL', { timeout: 300_000 }, () => {
  it('rejects partial and damaged legacy states, rolls back errors, then matches fresh and repeats safely', async () => {
    const adminUrl = new URL(url!);
    adminUrl.pathname = '/postgres';
    const names = ['fresh', 'legacy'].map((s) => `yandex_${s}_${randomUUID().replace(/-/g, '').slice(0, 12)}`);
    const admin = new Client({ connectionString: adminUrl.toString(), connectionTimeoutMillis: 5000, query_timeout: 60000 });
    const clients: Client[] = [];
    let failure: unknown;
    let cleanupFailure: AggregateError | undefined;
    await admin.connect();
    try {
      for (const name of names) {
        await admin.query(`CREATE DATABASE ${quoted(name)}`);
        const dbUrl = new URL(url!);
        dbUrl.pathname = `/${name}`;
        const client = new Client({ connectionString: dbUrl.toString(), connectionTimeoutMillis: 5000, query_timeout: 30000 });
        await client.connect();
        clients.push(client);
        await installPostgresExtensions(client);
        await client.query(
          'CREATE SCHEMA drizzle; CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)',
        );
      }
      const [fresh, legacy] = clients;
      await apply(fresh, migrations);
      await apply(legacy, migrations.slice(0, 111));
      // Generated 0132 has the same operators as the two old migrations; the ledger retains the old hashes.
      for (const sql of migrations[132].sql) await legacy.query(sql);
      for (const [i, hash] of LEGACY_YANDEX_HASHES.entries()) {
        await legacy.query('INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)', [
          hash,
          ['1791923768935', '1792049794975'][i],
        ]);
      }
      await legacy.query(`INSERT INTO libraries (id, name) VALUES (1, 'fixture');
        INSERT INTO library_folders (id, library_id, path) VALUES (1, 1, '/fixture');
        INSERT INTO books (id, library_id, library_folder_id, folder_path, is_fileless) VALUES (1, 1, 1, '/fixture/book', true);
        INSERT INTO book_metadata (book_id, yandex_books_id) VALUES (1, 'CaseSensitive');`);
      const pool = new Pool({ connectionString: new URL(`/${names[1]}`, url!).toString(), connectionTimeoutMillis: 5000, query_timeout: 30000 });
      const bridgeClient = await pool.connect();
      try {
        await legacy.query('DELETE FROM drizzle.__drizzle_migrations WHERE hash=$1', [LEGACY_YANDEX_HASHES[1]]);
        await expect(bridgeYandexMigrations(bridgeClient, migrations, validate)).rejects.toThrow('partial legacy');
        await legacy.query('INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)', [LEGACY_YANDEX_HASHES[1], '1792049794975']);
        await legacy.query('ALTER TABLE books DROP CONSTRAINT books_catalog_media_kind_chk');
        await expect(bridgeYandexMigrations(bridgeClient, migrations, validate)).rejects.toThrow('catalog mismatch');
        const check = migrations[132].sql.find((sql) => sql.includes('ADD CONSTRAINT "books_catalog_media_kind_chk"'))!;
        await legacy.query(check);
        const broken = migrations.map((m, i) => (i === 115 ? { ...m, sql: [...m.sql, 'SELECT 1/0'] } : m));
        await expect(bridgeYandexMigrations(bridgeClient, broken, validate)).rejects.toThrow();
        expect((await legacy.query('SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations')).rows[0].count).toBe(113);
        expect((await legacy.query("SELECT to_regclass('public.book_provider_ids') AS name")).rows[0].name).toBeNull();
        const conflicting = migrations.map((m, i) =>
          i === 129
            ? { ...m, sql: [...m.sql, "INSERT INTO book_provider_ids (book_id, provider, external_id) VALUES (1, 'yandexbooks', 'different')"] }
            : m,
        );
        await expect(bridgeYandexMigrations(bridgeClient, conflicting, validate)).rejects.toThrow('provider ID conflicts');
        expect((await legacy.query('SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations')).rows[0].count).toBe(113);
        await expect(bridgeYandexMigrations(bridgeClient, migrations, validate)).resolves.toBe('bridged');
        expect((await legacy.query("SELECT external_id FROM book_provider_ids WHERE book_id=1 AND provider='yandexbooks'")).rows[0].external_id).toBe(
          'book-CaseSensitive',
        );
        expect(await normalizedSchema(legacy)).toEqual(await normalizedSchema(fresh));
        await expect(bridgeYandexMigrations(bridgeClient, migrations, validate)).resolves.toBe('bridged');
        await bridgeClient.query('BEGIN');
        await backfillYandexProviderIds(bridgeClient);
        await bridgeClient.query('COMMIT');
        expect((await legacy.query('SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations')).rows[0].count).toBe(135);
      } finally {
        bridgeClient.release();
        await pool.end();
      }
    } catch (error) {
      failure = error;
      console.error('Migration upgrade scenario failed before cleanup', error);
      throw error;
    } finally {
      await Promise.allSettled(clients.map((client) => client.end()));
      await admin.end().catch(() => undefined);
      const cleanup = new Client({ connectionString: adminUrl.toString(), connectionTimeoutMillis: 5000, query_timeout: 60000 });
      const cleanupErrors: unknown[] = [];
      try {
        await cleanup.connect();
        for (const name of names) {
          try {
            await cleanup.query(`DROP DATABASE IF EXISTS ${quoted(name)} WITH (FORCE)`);
          } catch (error) {
            cleanupErrors.push(error);
            console.error('Test database cleanup failed', name, error);
          }
        }
      } catch (error) {
        cleanupErrors.push(error);
        console.error('Test database cleanup unavailable', names, error);
      } finally {
        await cleanup.end().catch(() => undefined);
      }
      if (!failure && cleanupErrors.length) cleanupFailure = new AggregateError(cleanupErrors, 'Migration test database cleanup failed');
    }
    if (cleanupFailure) throw cleanupFailure;
  });
});
