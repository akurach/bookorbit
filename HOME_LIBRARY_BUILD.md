# Home Library reading import build

Modified BookOrbit 3.4.0 distribution. Functional changes are on
`feat/yandex-books-reading-import`; this branch adds distribution branding only.

Set `VITE_MODIFIED_SOURCE_URL` to the exact GitHub commit tree URL of this branch
when building the client. This build-time value avoids a self-referential source
commit hash. Keep the original license and attribution notices.

No runtime dependencies differ from upstream 3.4.0. Runtime version is
`3.4.0-yandex.2`. The deployment uses the original ARM64 runtime with the built
server, shared types, client and generated migrations replaced.
