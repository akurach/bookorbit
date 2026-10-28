import type { MigrationMeta } from 'drizzle-orm/migrator';
import type { PoolClient } from 'pg';

import { backfillYandexProviderIds } from './yandex-provider-id-backfill';

// SHA-256 of the exact SQL files in c7cabf5. These rows remain as audit history.
export const LEGACY_YANDEX_HASHES = [
  '0b87edd7679460cd5228d26f5c5e0ae6b5e2acede361b7469e598323f9da8c4a',
  '49b713464b183760ee0cb9b88ca93f16eba7e0a6595a2e623c42c741207925f7',
] as const;
export const CONSOLIDATED_YANDEX_HASH = '65c222546658eb13313d5a1374b1d0fb8a5bada981043fe1736ba4f32d1bb771';

type LedgerRow = { hash: string; createdAt: string };

/** Caller holds the session-wide migration lock. The callback must compare the entire legacy schema. */
export async function bridgeYandexMigrations(
  client: PoolClient,
  migrations: readonly MigrationMeta[],
  validateLegacySchema: (client: PoolClient) => Promise<void>,
): Promise<'normal' | 'bridged'> {
  if (migrations.length < 133 || migrations[132].hash !== CONSOLIDATED_YANDEX_HASH) {
    throw new Error('Unexpected migration chain; expected published 0000–0131 and consolidated 0132');
  }
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL search_path = public, pg_catalog');
    const table = await client.query<{ name: string | null }>(`SELECT to_regclass('drizzle.__drizzle_migrations')::text AS name`);
    const ledger = table.rows[0]?.name
      ? (await client.query<LedgerRow>(`SELECT hash, created_at::text AS "createdAt" FROM drizzle.__drizzle_migrations ORDER BY id`)).rows
      : [];
    const legacy = ledger.filter((row) => LEGACY_YANDEX_HASHES.some((hash) => hash === row.hash));
    if (legacy.length === 0) {
      // The existing compatibility helper removes this one known unreleased upstream row.
      const unreleasedHash = '1ec15e36d30f9bf4e79f92cb59eb461e5f76f53f43293d1b08a15253f22f35cf';
      const unreleased = ledger.filter((row) => row.hash === unreleasedHash);
      const published = ledger.filter((row) => row.hash !== unreleasedHash);
      if (unreleased.length > 1 || published.length > migrations.length || published.some((row, index) => row.hash !== migrations[index].hash)) {
        throw new Error('Unexpected migration ledger; refusing migration');
      }
      const artifacts = await client.query<{ found: boolean }>(`
        SELECT to_regclass('public.external_book_sources') IS NOT NULL
          OR to_regclass('public.yandex_books_settings') IS NOT NULL
          OR to_regclass('public.yandex_books_entries') IS NOT NULL
          OR to_regclass('public.yandex_books_staging') IS NOT NULL
          OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
            AND ((table_name = 'book_metadata' AND column_name = 'yandex_books_id')
              OR (table_name = 'books' AND column_name IN ('is_fileless', 'catalog_media_kind')))) AS found
      `);
      // A completed fresh 0132 is valid, but a partial unrecorded custom schema is not.
      if (artifacts.rows[0]?.found && !ledger.some((row) => row.hash === migrations[132].hash)) {
        throw new Error('Unrecorded or partial Yandex schema; refusing migration');
      }
      await client.query('COMMIT');
      return 'normal';
    }

    const expectedPrefix = migrations.slice(0, 111).map((m) => m.hash);
    const expectedLegacy = [...expectedPrefix, ...LEGACY_YANDEX_HASHES];
    const expectedComplete = [...expectedLegacy, ...migrations.slice(111).map((m) => m.hash)];
    const hashes = ledger.map((row) => row.hash);
    const matchesLegacy = hashes.length === expectedLegacy.length && hashes.every((hash, i) => hash === expectedLegacy[i]);
    const matchesComplete =
      hashes.length >= expectedLegacy.length + 22 &&
      hashes.length <= expectedComplete.length &&
      hashes.every((hash, i) => hash === expectedComplete[i]);
    if (!matchesLegacy && !matchesComplete) {
      throw new Error('Unexpected or partial legacy migration ledger; refusing migration');
    }
    const legacyTimes = ['1791923768935', '1792049794975'];
    if (ledger[111].createdAt !== legacyTimes[0] || ledger[112].createdAt !== legacyTimes[1]) {
      throw new Error('Unexpected legacy migration timestamps; refusing migration');
    }
    if (matchesComplete) {
      await client.query('COMMIT');
      return 'bridged';
    }

    await validateLegacySchema(client);
    for (const migration of migrations.slice(111, 132)) {
      for (const statement of migration.sql) await client.query(statement);
      await client.query('INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)', [migration.hash, migration.folderMillis]);
    }
    await backfillYandexProviderIds(client);
    await client.query('INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)', [
      migrations[132].hash,
      migrations[132].folderMillis,
    ]);
    await client.query('COMMIT');
    return 'bridged';
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
