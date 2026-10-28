# Yandex Books on BookOrbit 3.6

Metadata search now uses the official external provider in BookOrbit 3.6.
The fork retains account-library import, statuses, progress, scheduling, local
file attachment and safe matching. The old built-in metadata provider has been removed.

## Metadata search

Run the official provider beside BookOrbit on the same Docker network:

```yaml
services:
  yandexbooks:
    image: ghcr.io/bookorbit/yandexbooks-provider:0.1.0
    restart: unless-stopped
```

Register `http://yandexbooks:8080` in Settings > Metadata > Providers > External
providers and enable it. It needs no account token. Follow the upstream
[metadata provider guide](METADATA_PROVIDERS.md) for field rules and defaults.

The provider key is `yandexbooks`. Identifiers include the medium:
`book-MWxAop5b`, `audiobook-VTVT8GzC`, and `comicbook-yjrd9dHo`.

## Account synchronization

Use Settings > Accounts > Yandex Books. This remains inside BookOrbit, with
private credentials and snapshots scoped to the signed-in user. Its internal
source key `yandexBooks` and raw remote identifiers are separate from metadata
provider identifiers. Account synchronization continues if metadata search is unavailable.

See [account sync](YANDEX_BOOKS_READING.md),
[upgrade and rollback](YANDEX_BOOKS_UPGRADE_3_6.md), and
[test coverage](YANDEX_BOOKS_TESTING.md).

## По-русски

Поиск использует официальный контейнер Яндекса и стандартные настройки внешних
провайдеров BookOrbit 3.6. Наш встроенный поиск удалён. В форке остаются импорт
личной библиотеки, статусов и прогресса, расписание, прикрепление файла и защита
от дубликатов. Аккаунт и его токен доступны только основной синхронизации.
