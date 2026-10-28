import { existsSync } from 'fs';
import { join } from 'path';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';

import { createPostgresClientConfig } from '../db/postgres-connection-config';
import { dropUnreleasedMigrationRows, reconcileMigrationLedgerTimestamps } from './migration-ledger-compatibility';
import { installPostgresExtensions } from './postgres-extensions';
import { prepareLegacySeriesIndexColumns } from './series-index-migration-compatibility';
import { readLegacyYandexCatalog, legacyYandexCatalogsEqual } from './legacy-yandex-schema';
import legacyYandexManifest from './legacy-yandex-schema-manifest';
import { bridgeYandexMigrations } from './yandex-migration-compatibility';
import { backfillYandexProviderIds } from './yandex-provider-id-backfill';

function resolveMigrationsFolder(): string {
  const candidates = [
    join(__dirname, '..', '..', 'migrations'),
    join(__dirname, '..', 'db', 'migrations'),
    join(process.cwd(), 'migrations'),
    join(process.cwd(), 'src', 'db', 'migrations'),
  ];

  const match = candidates.find((path) => existsSync(path));
  if (!match) {
    throw new Error(`Unable to locate migrations folder. Checked: ${candidates.join(', ')}`);
  }
  return match;
}

async function runMigrations() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required');
  }

  const pool = new Pool(
    createPostgresClientConfig(connectionString, {
      max: 3,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
    }),
  );

  let lockClient: PoolClient | undefined;
  let locked = false;
  try {
    lockClient = await pool.connect();
    // This session lock spans compatibility preparation and Drizzle's own transactions.
    // Keep a dedicated client: the helpers also take their own transaction locks.
    await lockClient.query(`SELECT pg_advisory_lock(hashtext('bookorbit'), hashtext('migration-runner-session'))`);
    locked = true;
    const migrationsFolder = resolveMigrationsFolder();
    const migrationFiles = readMigrationFiles({ migrationsFolder });
    await bridgeYandexMigrations(lockClient, migrationFiles, async (client) => {
      const catalog = await readLegacyYandexCatalog(client);
      if (!legacyYandexCatalogsEqual(catalog, legacyYandexManifest)) {
        throw new Error('Legacy Yandex schema differs from the validated catalog manifest; refusing migration');
      }
    });
    await installPostgresExtensions(pool);
    await dropUnreleasedMigrationRows(pool, migrationFiles);
    await reconcileMigrationLedgerTimestamps(pool, migrationFiles);
    await prepareLegacySeriesIndexColumns(pool);

    await migrate(drizzle(pool), { migrationsFolder });
    await lockClient.query('BEGIN');
    try {
      await backfillYandexProviderIds(lockClient);
      await lockClient.query('COMMIT');
    } catch (error) {
      await lockClient.query('ROLLBACK');
      throw error;
    }

    console.log(`Migrations applied successfully from ${migrationsFolder}`);
  } finally {
    try {
      if (locked) await lockClient!.query(`SELECT pg_advisory_unlock(hashtext('bookorbit'), hashtext('migration-runner-session'))`);
    } finally {
      lockClient?.release();
      await pool.end();
    }
  }
}

void runMigrations();
