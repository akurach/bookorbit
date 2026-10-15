# Yandex Books reading import

[Русская инструкция](YANDEX_BOOKS_READING.ru.md)

Import a personal Yandex Books library into BookOrbit, including fileless catalog
entries, statuses and progress. This is separate from the public metadata provider.
It runs inside the existing server and PostgreSQL database, without a companion
service or reader plugin. Quotes, subscription file downloads, bidirectional sync
and per-book reading-time statistics are outside this stage.

## Configuration

1. Generate a key with `openssl rand -hex 32`, set `YANDEX_BOOKS_ENCRYPTION_KEY`
   in the server environment and restart. Back up the key with database recovery
   material. Without a key, credentials cannot be saved. A changed or lost key
   requires reconnecting the account.
2. Grant **Yandex Books import**, **Upload books**, and editing access to the
   destination library. Superusers already have these permissions.
3. Open **Settings > Accounts > Yandex Books**, enter the account access token
   and select the library and folder for later file attachments. Save and verify
   the account identity returned by Yandex.
4. Run a preview, inspect the paginated entries, then import them.
5. Enable automatic updates and choose an interval. The settings page shows the
   last result, next update and authentication or synchronization errors.

The token is sent only to the fixed Yandex API host and stored encrypted in the
database. It is never returned by the settings API. Connect to your own server
using HTTPS or a trusted private connection. Never publish tokens in issue reports.

Catalog entries and metadata follow the destination library's sharing rules.
Credentials, import records, statuses and progress belong to the BookOrbit user.
The account endpoints are unofficial and can change independently of BookOrbit.

## Import semantics

Provider, media kind and remote ID identify an edition. Text and audio stay
distinct. Before creating a card, import reuses an existing provider link, a valid
ISBN match, or an exact normalized title and author set in the destination library.
Ambiguous matches, conflicting editions or author spellings require an explicit
link; they do not create another card. Short titles and saturated candidate lists
also fail safely. Repeated imports update the same entries. A missing source item
does not delete a local book. A preview stages snapshots without creating books.
Incomplete fetches do not become a new complete import snapshot.

| Source                    | Treatment                                             |
| ------------------------- | ----------------------------------------------------- |
| Text progress             | Percentage validated from 0 to 100                    |
| Audio progress / duration | Playback position / duration, converted to percentage |
| Comic progress            | Percentage unknown until units are established        |
| finished                  | Read independently of percentage                      |
| reading / listening       | Reading                                               |
| pending with progress     | On hold, retaining the original source state          |
| pending without progress  | Unread                                                |
| Missing or zero date      | Unknown, never January 1970                           |

Playback position is not listening time. No sessions or reading durations are
fabricated. External progress is a source snapshot, not a local file position.
Local CFI, page coordinates, KOReader positions and local progress rows are never
overwritten. A locally changed status requires an explicit choice when a later
remote value conflicts. That choice still does not alter reader coordinates.

## Files and recovery

Imported entries have no dummy files and survive filesystem scans. Open a book
and use the existing attachment action to upload a supported file, preserving the
book ID and external reading data. Different translations and editions need their
own local reading position.

Refresh uses paginated pulls and a database lease to prevent overlapping runs.
An expired lease allows recovery after restart. Authentication errors require
reconnection; other failures preserve imported data and retry later. Disconnecting
removes credentials and stops updates, keeping books and local reading data.

## Correcting an imported duplicate

Use **Change linked book** beside an imported entry to select its existing local
book. This requires **Delete books** as well as import/upload permissions. The
operation moves the Yandex source and its import record atomically, then removes
only the untouched, fileless placeholder. It preserves the target book ID, files,
metadata, notes and reader positions. A conflicting local status still needs review.

If the placeholder has a file, edited metadata/status, notes, collections or other
references (including another user's data), the operation refuses to delete it.
Review those books manually. Selecting the same card is never a deletion operation.
This is not a general-purpose merge of two books with local history.

## Development boundaries

Shared contracts live in `packages/types/src/yandex-books.ts`. Account access and
scheduling belong to `server/src/modules/yandex-books/`. Fileless catalog and
reading snapshots belong to the public `ExternalCatalogService` in the book module.

Use anonymized fixtures in tests. Never commit personal API dumps or tokens.
