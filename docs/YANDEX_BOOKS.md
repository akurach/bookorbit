# Yandex Books metadata provider / Источник метаданных Яндекс Книги

Development: [test coverage and fork CI](YANDEX_BOOKS_TESTING.md).

Personal library import: [English](YANDEX_BOOKS_READING.md) /
[Импорт книг, статусов и прогресса](YANDEX_BOOKS_READING.ru.md).

## English

The Yandex Books provider adds the public Russian-language ebook catalog to
BookOrbit's existing metadata workflow. It runs in the BookOrbit server and needs
no separate service, Python package, API key, or Yandex account.

### Use

1. Open **Settings > Metadata > Providers** and enable **Yandex Books**.
2. Save the settings. The row's **Configure > Test** checks public catalog access.
3. Open a book's metadata search, select **Yandex Books**, and search by title and
   optionally author. Review the candidates before applying fields.
4. Applying a candidate stores its case-sensitive Yandex Books ID. Later metadata
   refreshes can look up that exact catalog entry. The ID is editable with the
   other provider IDs and links to the public book page.

Enabling a source does not change existing **Field Rules**. Manual search can
use it immediately. For automatic fetch, add Yandex Books to the desired fields
in **Field Rules** and choose its priority.

Supported fields: title, authors, description, cover, publisher, language, page
count, genres, and original publication year when returned by the source.
Search results can contain fewer fields than an ID lookup. Missing fields remain
missing; the provider does not manufacture ISBNs or publication dates.

This initial version covers ebooks only. It does not search by ISBN alone, return
audiobooks or comics, download book files, import a personal library or quotes,
or synchronize reading progress. A title/author search still runs if an ISBN is
also supplied. An ISBN-only search makes no Yandex request.

### Implementation and verification

- Uses the existing provider registry, request throttling, cancellation, cache,
  settings, metadata preview/apply, provider-ID storage, and file sidecar paths.
- Disabled by default. Other provider settings are preserved when it is enabled.
- One bounded GraphQL request per search, with a `TEXTBOOK` filter. Exact ID
  lookups use the public REST catalog. No per-result request fan-out.
- Search cache keys include the fields and result limit that affect the answer.
  HTTP failures, malformed responses, and GraphQL errors are not cached as
  trustworthy misses; a REST 404 is a definitive miss.
- Migration `0111_yandex_books_id` adds one nullable column; existing book records
  need no backfill.
- Unit tests cover mapping, mixed media, malformed responses, cancellation,
  throttling, cache declarations, settings/DTO validation, ID persistence,
  sidecar round trips, and the existing web integration paths.

The public endpoints are unofficial and can change independently of BookOrbit.
Yandex currently allowlists GraphQL documents; the full Search document is
adapted from [stepan163s/yandex-book-api](https://github.com/stepan163s/yandex-book-api).
Its MIT attribution and license are preserved in the provider directory. The
connectivity button checks REST availability; an actual metadata search also
checks the GraphQL endpoint.

Before submitting upstream, follow `CONTRIBUTING.md`, including issue approval
and assignment. Translation changes are limited to the English source locale,
as required by the project's Crowdin workflow.

## Русский

Источник добавляет публичный каталог электронных книг Яндекса в обычный поиск
метаданных BookOrbit. Всё выполняется в существующем сервере: отдельный сервис
на Raspberry, Python, ключ API и авторизация Яндекса не требуются.

В настройках метаданных включите **Yandex Books** и сохраните изменения. Кнопка
**Configure > Test** проверяет доступ к каталогу. Затем откройте поиск метаданных
в карточке книги, выберите Яндекс и укажите название, при необходимости автора.
Проверьте найденное издание и примените нужные поля.

Включение источника не меняет существующие **Field Rules**. Ручной поиск
доступен сразу. Для автоматического заполнения добавьте Яндекс в правила
нужных полей и укажите его приоритет.

Источник возвращает доступные название, авторов, аннотацию, обложку,
издательство, язык, число страниц, жанры и исходный год публикации.
В поисковой выдаче полей может быть меньше, чем при запросе по ID. После
применения результата ID Яндекса сохраняется в карточке и используется для
повторного обновления. Его также можно ввести вручную среди ID других
источников. Регистр символов имеет значение.

По одному ISBN Яндекс пока не ищет. Если вместе с ISBN указано название,
используются название и автор. Аудиокниги, комиксы, скачивание файлов,
импорт личной библиотеки, цитат и прогресса чтения в эту версию не входят.

Интеграция использует существующие настройки, кэш, ограничения запросов,
предпросмотр метаданных и механизм сохранения ID BookOrbit. Миграция добавляет
одно необязательное поле в базу. Сетевые ошибки и некорректные ответы не
сохраняются в кэше как отсутствие книги.

API неофициальный, поэтому изменения со стороны Яндекса могут потребовать
обновления провайдера. Проверка подключения проверяет REST, а реальный поиск
дополнительно проверяет GraphQL. Полный запрос и MIT-атрибуция взяты из
указанного выше открытого клиента. Интерфейс выполнен по образцу других
интеграций; новые строки добавляются в английский исходный перевод согласно
правилам проекта.
