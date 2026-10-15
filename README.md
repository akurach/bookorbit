# Yandex Books integration screenshots

Real screenshots of a personal modified BookOrbit deployment (Home Library).
No images were generated or retouched. This branch contains issue evidence only.
BookOrbit source and attribution: https://github.com/bookorbit/bookorbit

- metadata-search.jpg: metadata comparison on an isolated preview deployment, captured 13 October 2026 UTC.
- metadata-settings.jpg: public-catalog provider enabled and connectivity test on Raspberry Pi, captured 13 October 2026 UTC.
- reading-import.jpg: real account import with repeated refresh, captured 15 October 2026 UTC.
- linked-local-book.jpg: existing EPUB card with a Yandex reading snapshot after duplicate repair, captured 15 October 2026 UTC.

Functional source:
- Metadata: https://github.com/akurach/bookorbit/tree/59bb46e42bd478802fe1138b1c09e2886ed4d6a5
- Reading import and duplicate repair: https://github.com/akurach/bookorbit/tree/f924ce349a5196ff7a16d070effdf46f55bae641

These are personal-deployment checks, not upstream CI or acceptance evidence.
The metadata provider uses unofficial public Yandex Books endpoints. Account import uses authenticated unofficial endpoints.
