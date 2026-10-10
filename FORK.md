# Fork provenance

Pi Coop starts from [Tanner Middleton's Pi Pocket](https://github.com/TannerMidd/pi-pocket), revision `d01f763b02f06ff6144d4366eb966a76dbb35577`, version `0.11.0`.

The repository retains the upstream Git history, MIT [LICENSE](LICENSE), author metadata, pinned dependency lockfile, bundled asset licenses and tests. The upstream README is preserved at [README.upstream.md](README.upstream.md). The `upstream` remote points to the original project; `origin` points to the private [enkelm/pi-coop](https://github.com/enkelm/pi-coop) repository.

Development is on `main`. The project, package and CLI are named `pi-coop`, with Pi Coop as the app's display name. The existing `~/.pi-durable-app` data directory, `PI_POCKET_*` environment variables and internal `pocket.*` identifiers remain unchanged. Inherited guides retain some Pocket terminology. The upstream public website in `site/` and its publishing script have been removed.

## Initial changes

- An owner-only running-session picker for local Herdr Pi sessions, guarded process stop, preview and one-way import. The stopped-file form remains a fallback.
- One-way conversion of selected-branch history into the existing Durable runtime.
- An atomic source archive, provenance and import-deduplication index in the existing SQLite database.
- Import-specific transcript labels, owner-only visibility and archive downloads.
- A separate default data directory, `~/.pi-durable-app`, to avoid opening upstream Pocket data by default.
- New importer and real-browser integration tests, plus the product research and plan.

The initial importer retained Durable as the only runtime and copied no Collie or Herdr GPUI source. The user subsequently chose a live private Herdr mirror: existing private Pi processes stay in Herdr until explicitly imported and shared. Durable still owns all app-managed execution; the bridge does not start a second writer on a source file.

The private journal display adapts text-block handling and text caps from Collie's `bridge/journal/{pi,text}.ts`. Its snapshot hierarchy and pane-read protocol follow `bridge/mux/herdr/client.ts`, at revision `cfaf95a93df3c9404a03f5f840bf222f0cd6c2ee`. Copyright (c) 2026 Altan Sarisin; the full MIT notice is preserved in [LICENSES/Collie-MIT.txt](LICENSES/Collie-MIT.txt). Pocket's projection/rendering and the existing local Herdr transport are reused rather than importing Collie's Bun/React stack.

The first mirror used GPUI only as a reference. The user then chose GPUI's structured protocol for full Terminal mode and its desktop navigation as the design reference. `native/herdr-web` now links the unmodified `herdr-client` and `herdr-protocol` crates at GPUI revision `e370bf0a55b1bf3e7e7fcb5b3f130ebc1a9e68bf`. Cargo.toml pins that Git revision and Cargo.lock pins transitive dependencies. Adapted protocol declarations, renderer rules and synthetic fixtures retain attribution. See [native/herdr-web/NOTICE.md](native/herdr-web/NOTICE.md), its [Apache-2.0 license](native/herdr-web/LICENSE-APACHE), and the preserved protocol notice.

The Node gateway adds pinned `ws` for authenticated WebSocket transport. It does not add a second terminal emulator or source-journal writer. The reference worktrees remain unchanged.

## Keeping upstream changes manageable

Keep existing stored document kinds and wire formats stable. Add narrowly scoped modules and fields rather than renaming internal Pocket identifiers throughout the code. The Pi Coop name changes package metadata, the launcher command and app branding, not stored data.

Future merges should run both the upstream tests and the import tests, especially source-format handling, transaction rollback, session visibility and reconnect behavior. Durable and Pi APIs are pinned to the versions in the lockfile; upgrading them needs those checks again.
