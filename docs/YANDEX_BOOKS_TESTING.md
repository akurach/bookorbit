# Yandex Books test coverage and fork CI

This branch prepares the two proposals in [#1817](https://github.com/bookorbit/bookorbit/issues/1817)
and [#1818](https://github.com/bookorbit/bookorbit/issues/1818). The fork workflow does
not represent upstream approval or replace checks on the eventual PR branches.

## Coverage

| Layer                       | Scenarios                                                                                                                                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server unit                 | Provider mapping and request limits, account credentials, matching, sync leases, safe relinking and preservation rules                                                                                |
| Vue component/composable    | Entry filtering and pagination through the real composable, choosing and relinking a local book, retry after an error, attach-file action                                                             |
| `yandex-books-metadata` E2E | Enable provider, search through its real implementation, apply a candidate, retain unrelated metadata and persist the provider ID and cover; disabled and ISBN-only searches make no provider request |
| `yandex-books-reading` E2E  | Idempotent import, local-file matching and attachment, duplicate repair and deletion guards, status preservation, invalid/expired credentials, reconnect, user isolation and optional cover failure   |

The E2E suites boot NestJS against a disposable PostgreSQL database. External
Yandex responses and credentials are synthetic. CI never needs an account token,
access to the home Raspberry Pi, or availability of the Yandex service.

These are HTTP/database E2E tests and Vue integration tests, not a browser
automation recording. A real-client recording and fresh checks against the
approved upstream target remain part of PR preparation.

## Run locally

Use the normal development dependencies and PostgreSQL setup in [TESTING.md](TESTING.md).
The existing migration command expects the dedicated `bookorbit_e2e` database
on localhost port 5432. It resets only this test database before each suite.

```bash
pnpm run e2e:run -- yandex-books-metadata
pnpm run e2e:run -- yandex-books-reading
pnpm --dir client exec vitest run src/features/yandex-books
node --test scripts/e2e/select-yandex-matrix.test.mjs
pnpm verify
```

Each suite writes its own JUnit report under `test-results/server/`.

## Fork workflow

`.github/workflows/yandex-integration.yml` runs only in `akurach/bookorbit`:

- Pushes to `BO-1817-*`, `BO-1818-*`, and `feat/yandex-books-*` select affected suites
  from the registry's changed paths.
- The first push, unavailable comparison history, or a manual run selects both.
- Shared book logic, schemas/migrations, types, test infrastructure and dependency
  changes select both suites. Unrelated changes select neither.
- A selected run executes `pnpm verify` and the existing reusable E2E runner with
  PostgreSQL 18. Each suite publishes its JUnit report as a seven-day artifact.
- The final gate requires all selected checks to succeed. Replaced runs on the
  same branch are cancelled.

The two registry entries also participate in the existing full-suite matrix.
The fork-specific workflow and selector can stay out of upstream PRs; include the
relevant tests and registry entry with each feature, following maintainer guidance.

## Кратко по-русски

Проверки покрывают источник метаданных и импорт библиотеки: повторный импорт без
дублей, привязку файла, защиту локальных изменений, ошибки входа, переподключение
и разделение данных пользователей. Ответы Яндекса заменены тестовыми данными.

В форке тесты запускаются при отправке изменений в ветки двух задач. CI использует
штатный E2E-инструмент проекта, отдельную PostgreSQL и сохраняет отчёты. Это
подготовка к PR; одобрение сопровождающего проекта и запись работы интерфейса
остаются отдельными шагами.
