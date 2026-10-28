import manifest from './legacy-yandex-schema-manifest';
import { legacyYandexCatalogsEqual } from './legacy-yandex-schema';

// Observed pg_dump/restore catalog strings, independent of the canonicalization.
const restoredChecks = [
  {
    table: 'books',
    name: 'books_catalog_media_kind_chk',
    definition:
      "CHECK (catalog_media_kind IS NULL OR (catalog_media_kind::text = ANY (ARRAY['ebook'::character varying::text, 'audiobook'::character varying::text, 'comic'::character varying::text])))",
  },
  {
    table: 'external_book_sources',
    name: 'external_book_sources_media_kind_chk',
    definition:
      "CHECK (media_kind::text = ANY (ARRAY['ebook'::character varying::text, 'audiobook'::character varying::text, 'comic'::character varying::text]))",
  },
  {
    table: 'yandex_books_entries',
    name: 'yandex_books_entries_media_chk',
    definition:
      "CHECK (media_kind::text = ANY (ARRAY['ebook'::character varying::text, 'audiobook'::character varying::text, 'comic'::character varying::text]))",
  },
  {
    table: 'yandex_books_entries',
    name: 'yandex_books_entries_policy_chk',
    definition:
      "CHECK (status_policy::text = ANY (ARRAY['safe'::character varying::text, 'remote'::character varying::text, 'local'::character varying::text]))",
  },
  {
    table: 'yandex_books_entries',
    name: 'yandex_books_entries_state_chk',
    definition:
      "CHECK (state::text = ANY (ARRAY['ready'::character varying::text, 'imported'::character varying::text, 'conflict'::character varying::text, 'ignored'::character varying::text]))",
  },
];

function restoredCatalog() {
  const catalog = structuredClone(manifest);
  for (const fixture of restoredChecks) {
    const constraint = catalog.constraints.find((c) => c.table_name === fixture.table && c.name === fixture.name)!;
    constraint.definition = fixture.definition;
  }
  return catalog;
}

describe('legacy Yandex catalog compatibility', () => {
  it.each(restoredChecks)('accepts the exact restored CHECK for $table.$name', (fixture) => {
    const catalog = structuredClone(manifest);
    catalog.constraints.find((c) => c.table_name === fixture.table && c.name === fixture.name)!.definition = fixture.definition;
    expect(legacyYandexCatalogsEqual(catalog, manifest)).toBe(true);
  });

  it('accepts all five restored forms together', () => {
    expect(legacyYandexCatalogsEqual(restoredCatalog(), manifest)).toBe(true);
  });

  it.each(['enum', 'null', 'table', 'name', 'type', 'unvalidated', 'missing', 'column'] as const)(
    'rejects an altered %s despite the known deparse alias',
    (change) => {
      const catalog = restoredCatalog();
      const constraint = catalog.constraints.find((c) => c.name === 'books_catalog_media_kind_chk')!;
      if (change === 'enum') constraint.definition = constraint.definition.replace("'ebook'", "'unknown'");
      if (change === 'null') constraint.definition = constraint.definition.replace('IS NULL OR', 'IS NOT NULL OR');
      if (change === 'table') constraint.table_name = 'other';
      if (change === 'name') constraint.name = 'other';
      if (change === 'type') constraint.type = 'f';
      if (change === 'unvalidated') constraint.validated = false;
      if (change === 'missing') catalog.constraints.splice(catalog.constraints.indexOf(constraint), 1);
      if (change === 'column') catalog.columns[0].type = 'bigint';
      expect(legacyYandexCatalogsEqual(catalog, manifest)).toBe(false);
    },
  );
});
