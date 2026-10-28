import type { PoolClient } from 'pg';

/** Catalog-only query: no user records, tokens, sequence values, or database identifiers. */
export const LEGACY_YANDEX_CATALOG_SQL = `
WITH target AS (
  SELECT c.oid, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
    AND c.relname IN ('external_book_sources','yandex_books_settings','yandex_books_entries','yandex_books_staging','books','book_metadata')
), cols AS (
  SELECT t.relname AS table_name, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
    a.attnotnull AS not_null, pg_get_expr(d.adbin, d.adrelid) AS default_value,
    a.attidentity AS identity, a.attgenerated AS generated,
    pg_get_serial_sequence(format('%I.%I', 'public', t.relname), a.attname) AS sequence
  FROM target t JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped
  LEFT JOIN pg_attrdef d ON d.adrelid = t.oid AND d.adnum = a.attnum
  WHERE t.relname NOT IN ('books','book_metadata') OR
    (t.relname = 'books' AND a.attname IN ('is_fileless','catalog_media_kind')) OR
    (t.relname = 'book_metadata' AND a.attname = 'yandex_books_id')
), catalog_constraints AS (
  SELECT t.relname AS table_name, c.conname AS name, c.contype AS type,
    pg_get_constraintdef(c.oid, true) AS definition, c.convalidated AS validated,
    c.condeferrable AS "deferrable", c.condeferred AS "deferred"
  FROM target t JOIN pg_constraint c ON c.conrelid = t.oid
  WHERE t.relname NOT IN ('books','book_metadata') OR
    (t.relname = 'books' AND c.conname = 'books_catalog_media_kind_chk')
), indexes AS (
  SELECT t.relname AS table_name, i.relname AS name, pg_get_indexdef(i.oid) AS definition,
    x.indisvalid AS valid, x.indisready AS ready
  FROM target t JOIN pg_index x ON x.indrelid = t.oid JOIN pg_class i ON i.oid = x.indexrelid
  WHERE t.relname NOT IN ('books','book_metadata') OR
    (t.relname = 'books' AND i.relname = 'books_fileless_library_idx')
), sequences AS (
  SELECT c.table_name, c.name AS column_name, c.sequence,
    format_type(s.seqtypid, NULL) AS type, s.seqstart::text AS start_value, s.seqincrement::text AS increment,
    s.seqmax::text AS max_value, s.seqmin::text AS min_value, s.seqcache::text AS cache, s.seqcycle AS cycle
  FROM cols c JOIN pg_class seq ON seq.oid = to_regclass(c.sequence) JOIN pg_sequence s ON s.seqrelid = seq.oid
)
SELECT jsonb_build_object(
  'tables', (SELECT coalesce(jsonb_agg(relname ORDER BY relname), '[]'::jsonb) FROM target WHERE relname NOT IN ('books','book_metadata')),
  'columns', (SELECT coalesce(jsonb_agg(to_jsonb(cols) ORDER BY table_name, name), '[]'::jsonb) FROM cols),
  'constraints', (SELECT coalesce(jsonb_agg(to_jsonb(catalog_constraints) ORDER BY table_name, name), '[]'::jsonb) FROM catalog_constraints),
  'indexes', (SELECT coalesce(jsonb_agg(to_jsonb(indexes) ORDER BY table_name, name), '[]'::jsonb) FROM indexes),
  'sequences', (SELECT coalesce(jsonb_agg(to_jsonb(sequences) ORDER BY table_name, column_name), '[]'::jsonb) FROM sequences)
) AS catalog`;

export async function readLegacyYandexCatalog(client: Pick<PoolClient, 'query'>): Promise<unknown> {
  const result = await client.query<{ catalog: unknown }>(LEGACY_YANDEX_CATALOG_SQL);
  return result.rows[0].catalog;
}
