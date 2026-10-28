import type { PoolClient } from 'pg';

/** Must run inside the caller's transaction. Never overwrite a different provider ID. */
export async function backfillYandexProviderIds(client: Pick<PoolClient, 'query'>): Promise<void> {
  const conflict = await client.query(`
    SELECT m.book_id
    FROM book_metadata m JOIN book_provider_ids p ON p.book_id = m.book_id AND p.provider = 'yandexbooks'
    WHERE m.yandex_books_id IS NOT NULL AND p.external_id <> 'book-' || m.yandex_books_id
    LIMIT 1
  `);
  if (conflict.rows.length > 0) {
    throw new Error('Yandex Books provider ID conflicts with legacy book_metadata.yandex_books_id');
  }
  await client.query(`
    INSERT INTO book_provider_ids (book_id, provider, external_id, source_url)
    SELECT m.book_id, 'yandexbooks', 'book-' || m.yandex_books_id, 'https://books.yandex.ru/books/' || m.yandex_books_id
    FROM book_metadata m
    WHERE m.yandex_books_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM book_provider_ids p WHERE p.book_id = m.book_id AND p.provider = 'yandexbooks'
      )
  `);
}
