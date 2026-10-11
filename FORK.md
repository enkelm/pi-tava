# Fork provenance

Pi Coop starts from [Tanner Middleton's Pi Pocket](https://github.com/TannerMidd/pi-pocket), revision `d01f763b02f06ff6144d4366eb966a76dbb35577`, version `0.11.0`.

The repository retains the upstream Git history, MIT [LICENSE](LICENSE), author metadata, pinned dependency lockfile, bundled asset licenses and tests. The upstream README is preserved at [README.upstream.md](README.upstream.md). Upstream is [TannerMidd/pi-pocket](https://github.com/TannerMidd/pi-pocket); `origin` points to the private [enkelm/pi-coop](https://github.com/enkelm/pi-coop) repository.

Development is on `main`. The project, package and CLI are named `pi-coop`, with Pi Coop as the app's display name. The existing `~/.pi-durable-app` data directory, `PI_POCKET_*` environment variables and internal `pocket.*` identifiers remain unchanged. Inherited guides retain some Pocket terminology. The upstream public website in `site/` and its publishing script have been removed. Desktop-theme and wallpaper synchronization are also removed; the app keeps its bundled palettes and tiled-window appearance. `README.upstream.md` is an archived upstream reference, not this fork's feature list.

## Initial changes

- An owner-only running-session picker for local Herdr Pi sessions, guarded process stop, preview and one-way import. The stopped-file form remains a fallback.
- One-way conversion of selected-branch history into the existing Durable runtime.
- An atomic source archive, provenance and import-deduplication index in the existing SQLite database.
- Import-specific transcript labels, owner-only visibility and archive downloads.
- A separate default data directory, `~/.pi-durable-app`, to avoid opening upstream Pocket data by default.
- New importer and real-browser integration tests, plus the product research and plan.

The initial importer retained Durable as the only runtime and copied no Collie or Herdr GPUI source. The user subsequently chose a live private Herdr mirror: existing private Pi processes stay in Herdr until explicitly imported and shared. Durable still owns all app-managed execution; the bridge does not start a second writer on a source file.

The private journal display adapts text-block handling and text caps from Collie's `bridge/journal/{pi,text}.ts`. Its snapshot hierarchy and pane-read protocol follow `bridge/mux/herdr/client.ts`, at revision `cfaf95a93df3c9404a03f5f840bf222f0cd6c2ee`. Copyright (c) 2026 Altan Sarisin; the full MIT notice is preserved in [LICENSES/Collie-MIT.txt](LICENSES/Collie-MIT.txt). Pocket's projection/rendering and the existing local Herdr transport are reused rather than importing Collie's Bun/React stack.

The theme-colored `web/herdr-mark.svg` adapts the ram-and-terminal silhouette from GPUI's `assets/icons/herdr-ui-icon-clean.svg` at revision `e370bf0a55b1bf3e7e7fcb5b3f130ebc1a9e68bf`. It removes the ivory tile and retains the upstream Herdr logo attribution in its metadata; the Apache-2.0 license is preserved at `native/herdr-web/LICENSE-APACHE`.

The first mirror used GPUI only as a reference. The user then chose GPUI's structured protocol for full Terminal mode and its desktop navigation as the design reference. `native/herdr-web` now links the unmodified `herdr-client` and `herdr-protocol` crates at GPUI revision `e370bf0a55b1bf3e7e7fcb5b3f130ebc1a9e68bf`. Cargo.toml pins that Git revision and Cargo.lock pins transitive dependencies. Adapted protocol declarations, renderer rules and synthetic fixtures retain attribution. See [native/herdr-web/NOTICE.md](native/herdr-web/NOTICE.md), its [Apache-2.0 license](native/herdr-web/LICENSE-APACHE), and the preserved protocol notice.

The Node gateway adds pinned `ws` for authenticated WebSocket transport. It does not add a second terminal emulator or source-journal writer. The reference worktrees remain unchanged.

## Selective upstream backports

On 2026-10-10, upstream was reviewed through [v0.12.2](https://github.com/TannerMidd/pi-pocket/releases/tag/v0.12.2), revision `e1298a0e8e674211d37ef71ecabef0ec8a9af13c`. This is a selective backport, not a merge of the complete 0.12 UI or a change to the fork's version.

- Pi Durable, pi-ai, pi-coding-agent, pi-codemode and chord are pinned to `1.1.0`. Fork-only dependencies and the Pi-pinned `undici` version remain in place.
- The failed-subagent follow-up fix (`dc46edb`, `67c53d5`, `fa88cae`) withdraws a message stranded in a failed run's queue and tells the parent to send it again. Watch cleanup follows the reviewed upstream implementation. The fork additionally commits the withdrawal reason with its settlement and queue removal, so a crash before the reporter's next checkpoint cannot lose the resend-needed report. Existing reporter task names, versions and request IDs are retained.
- Subagents accept `max` and fit explicit or inherited thinking levels to their selected model (`7feab64`, `fa88cae`). Session configuration and the tool share the same thinking-level definitions.
- A session-scoped invite cannot change its working directory (`708ff25`). Spend summaries aggregate conversation costs once rather than walking them for each session (`cef6468`).

The upstream session importer is not included: the fork already has bounded saved-history discovery, source archives and guarded Herdr takeover. The new transcript/composer layout, sidebar rail, subagent board/report batching, default-model control and project-trust UI are deferred. Their supporting interfaces should be integrated deliberately, not mixed piecemeal into this fork's private and shared views. Unrelated UI and development-tool dependency upgrades are also left out.

After installing the updated dependencies, restart through Menu → Restart server. Do not open live app data in a second server to test the upgrade. Pi's Azure provider key changed from `azure-openai-responses` to `azure`; existing Azure users may need to sign in again through Providers and select the renamed provider's model.

## Keeping upstream changes manageable

Keep existing stored document kinds and wire formats stable. Add narrowly scoped modules and fields rather than renaming internal Pocket identifiers throughout the code. The Pi Coop name changes package metadata, the launcher command and app branding, not stored data.

Future merges should run both the upstream tests and the import tests, especially source-format handling, transaction rollback, session visibility and reconnect behavior. Durable and Pi APIs are pinned to the versions in the lockfile; upgrading them needs those checks again.
