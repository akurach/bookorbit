#!/usr/bin/env python3
"""Create a disposable, locally branded BookOrbit source copy.

The script never changes SOURCE. OUTPUT must not exist. Build OUTPUT with the
normal BookOrbit image workflow after this script finishes.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
from datetime import date
from pathlib import Path


EXCLUDED_NAMES = {".git", "node_modules", "dist", "coverage", ".cache", ".turbo"}

BOOK_ICON_SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Home Library">
  <rect width="64" height="64" rx="14" fill="#1e1e18"/>
  <path d="M14 15c7-3 14-2 18 2v32c-4-4-11-5-18-2V15Zm36 0c-7-3-14-2-18 2v32c4-4 11-5 18-2V15Z" fill="#fafaf8"/>
  <path d="M32 17v32" stroke="#f97316" stroke-width="3"/>
</svg>
"""


def copy_ignore(_: str, names: list[str]) -> set[str]:
    return {name for name in names if name in EXCLUDED_NAMES}


def replace_once(path: Path, old: str, new: str) -> None:
    content = path.read_text(encoding="utf-8")
    count = content.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one occurrence, found {count}: {old!r}")
    path.write_text(content.replace(old, new), encoding="utf-8")


def replace_all_exact(path: Path, old: str, new: str, expected_count: int) -> None:
    content = path.read_text(encoding="utf-8")
    count = content.count(old)
    if count != expected_count:
        raise RuntimeError(f"{path}: expected {expected_count} occurrences, found {count}: {old!r}")
    path.write_text(content.replace(old, new), encoding="utf-8")


def insert_once(path: Path, anchor: str, text: str) -> None:
    content = path.read_text(encoding="utf-8")
    count = content.count(anchor)
    if count != 1:
        raise RuntimeError(f"{path}: expected one anchor, found {count}: {anchor!r}")
    path.write_text(content.replace(anchor, f"{anchor}{text}"), encoding="utf-8")


def insert_before_once(path: Path, anchor: str, text: str) -> None:
    content = path.read_text(encoding="utf-8")
    count = content.count(anchor)
    if count != 1:
        raise RuntimeError(f"{path}: expected one anchor, found {count}: {anchor!r}")
    path.write_text(content.replace(anchor, f"{text}{anchor}"), encoding="utf-8")


def json_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def validate_source_url(value: str) -> str:
    match = re.fullmatch(r"https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/tree/[0-9a-f]{7,64}", value)
    if not match:
        raise argparse.ArgumentTypeError(
            "must be an exact GitHub commit tree URL, for example "
            "https://github.com/akurach/bookorbit/tree/0123456789abcdef"
        )
    return value


def apply_branding(root: Path, source_url: str, modified_date: str) -> None:
    index = root / "client/index.html"
    replace_once(index, '<meta name="apple-mobile-web-app-title" content="BookOrbit" />', '<meta name="apple-mobile-web-app-title" content="Home Library" />')
    replace_once(index, '<title>BookOrbit</title>', '<title>Home Library</title>')
    replace_once(index, '<link rel="icon" href="/favicon.ico" sizes="any" />', '<link rel="icon" href="/home-library-book.svg" type="image/svg+xml" />')
    replace_once(index, '<link rel="icon" href="/pwa-icon-source.svg" type="image/svg+xml" />', '<link rel="icon" href="/home-library-book.svg" type="image/svg+xml" />')
    replace_once(index, '<link rel="apple-touch-icon" href="/apple-touch-icon-180x180.png" />', '<link rel="apple-touch-icon" href="/home-library-book.svg" />')
    (root / "client/public/home-library-book.svg").write_text(BOOK_ICON_SVG, encoding="utf-8")

    vite_config = root / "client/vite.config.ts"
    replace_once(
        vite_config,
        """includeAssets: [
        'favicon.ico',
        'pwa-icon-source.svg',
        'apple-touch-icon-180x180.png',
        'pwa-64x64.png',
        'pwa-192x192.png',
        'pwa-512x512.png',
        'maskable-icon-512x512.png',
      ],""",
        "includeAssets: ['home-library-book.svg'],",
    )
    replace_once(vite_config, "name: 'BookOrbit',\n        short_name: 'BookOrbit',\n        description: 'Your personal book library and reading space',", "name: 'Home Library',\n        short_name: 'Home Library',\n        description: 'Home library and reading space',")
    replace_once(
        vite_config,
        """icons: [
          {
            src: 'pwa-64x64.png',
            sizes: '64x64',
            type: 'image/png',
          },
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: 'maskable-icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],""",
        "icons: [{ src: 'home-library-book.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],",
    )
    replace_all_exact(
        vite_config,
        "icons: [{ src: 'pwa-192x192.png', sizes: '192x192' }],",
        "icons: [{ src: 'home-library-book.svg', sizes: 'any', type: 'image/svg+xml' }],",
        expected_count=3,
    )

    replace_once(root / "client/src/lib/page-title.ts", "export const APP_TITLE = 'BookOrbit'", "export const APP_TITLE = 'Home Library'")

    sidebar = root / "client/src/components/AppSidebar.vue"
    replace_once(sidebar, "Aperture, BookCopy, CircleArrowUp, FolderOpen, Heart, Orbit, Podcast", "Aperture, BookCopy, BookOpen, CircleArrowUp, FolderOpen, Heart, Podcast")
    replace_once(sidebar, '<Orbit :size="21" class="text-primary-foreground" />', '<BookOpen :size="21" class="text-primary-foreground" />')
    replace_once(
        sidebar,
        '<span class="truncate font-serif text-[18px] font-semibold leading-none text-sidebar-foreground group-data-[collapsible=icon]:hidden">\n          Book<span class="text-primary"> Orbit</span>\n        </span>',
        '<span class="truncate font-serif text-[18px] font-semibold leading-none text-sidebar-foreground group-data-[collapsible=icon]:hidden">\n          Home Library\n        </span>',
    )

    login = root / "client/src/features/auth/LoginPage.vue"
    insert_once(login, "import { computed, onMounted, ref } from 'vue'\n", "import { BookOpen } from '@lucide/vue'\n")
    replace_once(
        login,
        '<h1 class="text-2xl font-serif font-semibold text-foreground">Book<span class="text-primary"> Orbit</span></h1>',
        '<h1 class="inline-flex items-center gap-2 text-2xl font-serif font-semibold text-foreground"><BookOpen :size="23" class="text-primary" aria-hidden="true" />Home Library</h1>',
    )

    for filename, heading in {
        "ForgotPasswordPage.vue": '<h1 class="text-2xl font-serif font-semibold text-foreground">Book<span class="text-primary"> Orbit</span></h1>',
        "ResetPasswordPage.vue": '<h1 class="text-2xl font-serif font-semibold text-foreground">Book<span class="text-primary"> Orbit</span></h1>',
        "OidcCallbackPage.vue": '<h1 class="text-2xl font-serif font-semibold text-foreground mb-6">Book<span class="text-primary"> Orbit</span></h1>',
    }.items():
        auth_page = root / "client/src/features/auth" / filename
        insert_once(auth_page, '<script setup lang="ts">\n', "import { BookOpen } from '@lucide/vue'\n")
        replacement = heading.replace('class="', 'class="inline-flex items-center gap-2 ', 1)
        replacement = replacement.replace('Book<span class="text-primary"> Orbit</span>', '<BookOpen :size="23" class="text-primary" aria-hidden="true" />Home Library')
        replace_once(auth_page, heading, replacement)

    legal = root / "client/src/components/legal/LegalNotices.vue"
    insert_once(
        legal,
        'const ADDITIONAL_TERMS_URL = `${PROJECT_URL}/blob/main/ADDITIONAL_TERMS.md`\n',
        f"const MODIFIED_SOURCE_URL = {json_string(source_url)}\nconst MODIFICATION_DATE = {json_string(modified_date)}\n",
    )
    replace_once(
        legal,
        '          <p class="text-foreground">{{ t(\'components.legalNotices.licenseSummary\') }}</p>\n\n          <div class="grid gap-2 sm:grid-cols-3">',
        '          <div class="rounded-md border border-amber-500/35 bg-amber-500/10 p-3 text-foreground">\n'
        '            <p class="font-medium">{{ t(\'components.legalNotices.modifiedNotice\') }}</p>\n'
        '            <p class="mt-1 text-xs text-muted-foreground">{{ t(\'components.legalNotices.modifiedDate\', { date: MODIFICATION_DATE }) }}</p>\n'
        '          </div>\n\n'
        '          <p class="text-foreground">{{ t(\'components.legalNotices.licenseSummary\') }}</p>\n\n'
        '          <div class="grid gap-2 sm:grid-cols-2">',
    )
    insert_before_once(
        legal,
        '            <a\n              :href="LICENSE_URL"',
        '            <a\n              :href="MODIFIED_SOURCE_URL"\n              target="_blank"\n              rel="noopener noreferrer"\n              class="inline-flex items-center justify-center gap-1.5 rounded-md border border-border px-3 py-2 font-medium text-foreground outline-hidden hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"\n            >\n              {{ t(\'components.legalNotices.modifiedSource\') }}\n              <ExternalLink :size="14" aria-hidden="true" />\n            </a>\n',
    )

    locale = root / "client/src/locales/en.json"
    replace_once(locale, '      "about": "About BookOrbit",\n      "trigger": "Legal notices",\n      "title": "About BookOrbit",\n      "description": "BookOrbit attribution, licensing, and source code.",', '      "about": "About Home Library",\n      "trigger": "Legal notices",\n      "title": "About Home Library",\n      "description": "Home Library attribution, licensing, and source code.",')
    replace_once(
        locale,
        '      "sourceCode": "Source code",\n      "license": "AGPLv3 license",',
        '      "sourceCode": "Original source code",\n      "modifiedSource": "Source code for this version",\n      "modifiedNotice": "This is a modified version of BookOrbit and is not an official BookOrbit release.",\n      "modifiedDate": "Modification date: {date}.",\n      "license": "AGPLv3 license",',
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True, help="tracked BookOrbit source tree; it is only read")
    parser.add_argument("--output", type=Path, required=True, help="new disposable destination; it must not exist")
    parser.add_argument("--source-url", type=validate_source_url, required=True, help="exact fork commit tree URL for this deployed version")
    parser.add_argument("--modified-date", default=date.today().isoformat(), help="ISO 8601 modification date shown in About")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    source = args.source.resolve()
    output = args.output.resolve()
    if not (source / ".git").is_dir():
        raise SystemExit(f"--source is not a Git working tree: {source}")
    if output.exists():
        raise SystemExit(f"--output already exists: {output}")
    if source == output or source in output.parents:
        raise SystemExit("--output must be outside --source")
    try:
        date.fromisoformat(args.modified_date)
    except ValueError as exc:
        raise SystemExit("--modified-date must use YYYY-MM-DD") from exc

    shutil.copytree(source, output, ignore=copy_ignore, symlinks=True)
    try:
        apply_branding(output, args.source_url, args.modified_date)
    except Exception:
        shutil.rmtree(output)
        raise

    print(f"Prepared branded source at {output}")
    print(f"Exact corresponding source: {args.source_url}")


if __name__ == "__main__":
    main()
