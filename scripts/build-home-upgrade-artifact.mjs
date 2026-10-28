import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const sha = process.env.GITHUB_SHA;
if (!/^[a-f0-9]{40}$/.test(sha ?? "")) throw new Error("A full GITHUB_SHA is required");
const output = join(root, "test-results/home-upgrade");
for (const path of ["server/dist/scripts/migrate.js", "server/dist/scripts/legacy-yandex-schema-manifest.js", "client/dist/index.html"]) {
  if (!existsSync(join(root, path))) throw new Error(`Missing runtime build artifact: ${path}`);
}

const stage = join(output, "stage");
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const [source, target] of [
  ["server/dist", "server-dist"],
  ["client/dist", "public"],
  ["packages/types/dist", "types-dist"],
  ["server/src/db/migrations", "migrations"],
])
  cpSync(join(root, source), join(stage, target), { recursive: true });
const manifests = {};
for (const path of [
  "package.json",
  "server/package.json",
  "client/package.json",
  "packages/types/package.json",
  "packages/plugin-api/package.json",
  "pnpm-lock.yaml",
]) {
  manifests[path] = createHash("sha256")
    .update(readFileSync(join(root, path)))
    .digest("hex");
}
writeFileSync(
  join(stage, "build-manifest.json"),
  JSON.stringify(
    {
      sourceCommit: sha,
      workflowRun: process.env.GITHUB_RUN_ID,
      node: process.version,
      upstreamTag: "v3.6.0",
      upstreamCommit: "a96ff0c85a4c25e9126dfa4c71ea87537a3baf7a",
      manifests,
    },
    null,
    2,
  ) + "\n",
);
execFileSync("tar", ["-czf", join(output, "home-library-3.6-application.tar.gz"), "-C", stage, "."]);
rmSync(stage, { recursive: true });
