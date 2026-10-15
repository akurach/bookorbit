import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { getE2ESuite } from "./suite-registry.mjs";
import { changedFilesForPush, selectYandexSuites } from "./select-yandex-matrix.mjs";

const both = ["yandex-books-metadata", "yandex-books-reading"];
const ids = (files) => selectYandexSuites(files).map((suite) => suite.id);

for (const id of both) {
  test(`${id} is discoverable with an existing spec, isolated database and unique JUnit output`, () => {
    const suite = getE2ESuite(id);
    assert.ok(suite);
    assert.equal(suite.lane, "full");
    assert.equal(suite.prepareDedicatedDatabase, true);
    assert.equal(suite.useDedicatedDatabase, true);
    assert.ok(existsSync(new URL(`../../server/${suite.vitestTarget}`, import.meta.url)));
    assert.equal(suite.junitOutput, `../test-results/server/${id}-e2e-junit.xml`);
    const registered = JSON.parse(execFileSync(process.execPath, ["scripts/e2e/list-matrix.mjs"], { encoding: "utf8" }));
    assert.ok(registered.some((entry) => entry.id === id));
  });
}

test("metadata provider and settings changes select the real metadata contract suite", () => {
  for (const path of [
    "server/src/modules/metadata-fetch/providers/yandex-books/yandex-books.provider.ts",
    "server/src/modules/metadata-preferences/provider-config.service.ts",
    "server/src/modules/metadata-cache/metadata-cache.service.ts",
    "server/test/yandex-books-metadata.e2e-spec.ts",
  ])
    assert.deepEqual(ids([path]), [both[0]], path);
});

test("reading API, UI and file-attachment changes select the reading suite", () => {
  for (const path of [
    "server/src/modules/yandex-books/yandex-books-sync.service.ts",
    "client/src/features/yandex-books/components/YandexBooksSettings.vue",
    "client/src/features/admin/__tests__/UserFormDrawer.spec.ts",
    "server/src/modules/upload/upload.service.ts",
    "server/src/modules/scanner/scanner.service.ts",
    "server/test/yandex-books-reading.e2e-spec.ts",
  ])
    assert.deepEqual(ids([path]), [both[1]], path);
});

test("shared book logic, schema, contracts and harness changes select both suites", () => {
  for (const path of [
    "server/src/modules/book/external-catalog.service.ts",
    "server/src/db/schema/books.ts",
    "server/src/db/migrations/0111_yandex_books_id.sql",
    "packages/types/src/book.ts",
    "server/test/e2e/app-harness.ts",
    "server/src/modules/auth/auth.service.ts",
    "server/src/common/guards/permission.guard.ts",
    "scripts/e2e/suite-registry.mjs",
    ".github/workflows/yandex-integration.yml",
    "pnpm-lock.yaml",
  ])
    assert.deepEqual(ids([path]), both, path);
});

test("unrelated docs and feature code do not run Yandex E2E", () => {
  assert.deepEqual(ids(["README.md", "docs/TESTING.md", "client/src/features/notifications/Notifications.vue"]), []);
  assert.deepEqual(ids([]), []);
});

test("manual runs and missing history conservatively run both suites", () => {
  assert.deepEqual(ids(null), both);
  assert.equal(changedFilesForPush("0".repeat(40), "HEAD"), null);
  assert.equal(changedFilesForPush("does-not-exist", "HEAD"), null);
  assert.deepEqual(changedFilesForPush("HEAD", "HEAD"), []);
});

test("CLI emits the exact bounded matrix consumed by the workflow", () => {
  const stdout = execFileSync(process.execPath, ["scripts/e2e/select-yandex-matrix.mjs"], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_EVENT_NAME: "workflow_dispatch" },
  });
  assert.deepEqual(JSON.parse(stdout), selectYandexSuites(null));
});
