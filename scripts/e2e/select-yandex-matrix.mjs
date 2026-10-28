import { execFileSync } from "node:child_process";
import { matchesGlob, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { E2E_GLOBAL_CHANGE_PATHS, getE2ESuite } from "./suite-registry.mjs";

const SUITE_IDS = ["yandex-books-metadata", "yandex-books-reading", "yandex-migration-upgrade"];
const GLOBAL_PATHS = [
  ...E2E_GLOBAL_CHANGE_PATHS,
  ".github/workflows/yandex-integration.yml",
  ".github/actions/setup-node-pnpm/**",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "package.json",
  "server/package.json",
  "client/package.json",
  "client/src/locales/en.json",
  "server/src/modules/auth/**",
  "server/src/modules/user/**",
  "server/src/modules/role/**",
  "server/src/common/guards/**",
  "server/src/config/**",
];

export function selectYandexSuites(changedFiles) {
  const suites = SUITE_IDS.map((id) => {
    const suite = getE2ESuite(id);
    if (!suite) throw new Error(`Missing integration suite: ${id}`);
    return suite;
  });
  const runAll = changedFiles === null || changedFiles.some((file) => GLOBAL_PATHS.some((pattern) => matchesGlob(file, pattern)));
  return suites
    .filter((suite) => runAll || changedFiles.some((file) => suite.changedPaths.some((pattern) => matchesGlob(file, pattern))))
    .map(({ id, name, timeout }) => ({ id, name, timeout }));
}

export function changedFilesForPush(base, head) {
  // First branch push or unavailable history: run both suites rather than skip them.
  if (!base || !head || /^0+$/.test(base)) return null;
  try {
    const output = execFileSync("git", ["diff", "--name-only", base, head, "--"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    return output ? output.split("\n") : [];
  } catch {
    return null;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const changedFiles =
    process.env.GITHUB_EVENT_NAME === "push" ? changedFilesForPush(process.env.GITHUB_BASE_SHA, process.env.GITHUB_HEAD_SHA) : null;
  process.stdout.write(JSON.stringify(selectYandexSuites(changedFiles)));
}
