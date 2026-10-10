# Pi Coop

A self-hosted Pi collaboration app built by extending [Pi Pocket](https://github.com/TannerMidd/pi-pocket), with Pi Durable for managed conversations and an owner-only Herdr bridge for existing terminal sessions. The package and command are named `pi-coop`. This is not the upstream `@earendil-works/pi-durable` package.

The Private tab mirrors local Herdr instances without stopping their work. Explicit import can turn a private Pi session into a shared Durable conversation. Pocket's daemon, mobile web client, authentication, conversation views and Durable execution remain in place.

## Run locally

Requires Node 22.19 or newer. Development checks ran with Node 24.19.0.

```sh
cd /Users/enkelm/Projects/oss/pi-coop
npm ci --ignore-scripts
npm start -- --access local --port 8790 --data "$HOME/.pi-durable-app"
```

Open the owner sign-in link printed by the launcher. Keep that link private.

Pi Coop keeps this fork's existing default, `~/.pi-durable-app`, separate from upstream Pocket's `~/.pi-pocket`. The rename does not move existing data. `--data` and `PI_POCKET_DIR` still override it. Do not point the fork at an existing Pocket database while evaluating it. As in Pocket, normal operation uses your Pi provider configuration and sign-ins; tests use isolated configuration and mock providers.

## Private Herdr sessions

Open **Private** in the sidebar to see local Herdr instances, workspaces, tabs and every pane, including shells and other agents. Only the app owner can access this list or its contents. The same tab is available in the mobile session list and drawer.

Private has two views. **Chat** shows Pi's last persisted branch and accepts guarded text for verified idle Pi. **Terminal** uses Herdr GPUI's structured client protocol for live terminal display and semantic input, including shells and other agents. Desktop defaults to Terminal; mobile agent panes default to Chat. Pi stays in Herdr in both views. No managed conversation or historical work is created merely by opening it.

The Private desktop layout follows Herdr GPUI's compact Spaces and Agents lists, top tabs and split panes. Appearance controls the same tiled gaps and active window borders in Private and shared sessions; turning tiling off keeps the compact flat layout. Bundled themes work independently of the server's desktop. Desktop operation is keyboard-first; a bottom helper bar belongs on mobile. Terminal mode requires the native helper: `npm run build:terminal`. See [Terminal mode](docs/terminal-mode.md) for supported behavior, parity limits and validation results. Opening Terminal automatically connects and keeps its instance connection across navigation. It can resize shared panes or resume a pending agent. Status and help explain that behavior without a blocking Connect step. Transport recovery starts from a fresh snapshot and never replays input.

Choose **Import & share** to preview the selected branch and destination model. Confirming stops only that Pi, keeps its terminal and shell, and publishes a Durable conversation under the app's existing signed-in access rules. "Shared" does not mean anonymous internet access. The full original archive remains owner-only.

Chat snapshots refresh while their view is open and visible. They are not Durable history or restartable tasks. Chat journal images are counted rather than displayed; structured Terminal graphics use their own bounded renderer. History and terminal output have explicit size limits. Failed or uncertain prompt delivery is never automatically retried. A changed process/session invalidates the draft's destination until you review it again.

See [the private bridge contract](docs/private-sessions.md) for limits and safety checks.

## Move a running Pi into Durable

1. Click **Import** beside **New**, or **Import Pi session** in the menu.
2. Pick a Pi from the running-session list. No JSONL path is needed.
3. Review its saved history and destination model, then choose **Move to Durable**.
4. The server stops that Pi, leaves its Herdr pane and shell open, imports its last saved branch and opens the new Durable conversation.

Discovery currently supports local Herdr sessions on macOS and Linux. Herdr's Pi integration must report the session file. Busy sessions, child processes and unverifiable identities are shown with a reason instead of being force-killed. Finish their work and refresh.

The move continues if the browser disconnects. If stopping or importing fails, the original file stays intact. An unfinished move can be selected again, including after a daemon restart, to preview and retry. A completed retry opens the existing import.

For sessions outside Herdr, choose **Use a saved session file instead**. Stop that Pi yourself, enter its absolute JSONL path and optionally a branch entry ID, then preview and confirm. This fallback still uses the last saved entry when no branch is specified.

The source stays unchanged. The complete original JSONL, its hash and source-to-Durable entry IDs are stored atomically with the imported history in SQLite. **Download original Pi session** in the conversation menu retrieves the archive. Subsequent work stays in Durable; there is no write-back to ordinary Pi.

Import retries for the same source bytes and selected branch return the existing conversation, including after a daemon restart. Historical prompts and tools are never re-executed, and historical usage does not count as new spending.

### Current limits

- Imports accept ordinary Pi session format v3, valid UTF-8, up to 16 MiB and 20,000 records. One selected branch is continued, not the whole branch tree.
- The selected branch must end in a saved assistant response, including a failed or cancelled attempt. Those attempts stay in the history and archive but are excluded from model context and never restarted. Deferred provider requests, incomplete or interleaved tool rounds, malformed records and unknown message types are rejected rather than guessed at.
- Compaction, supported context edits, completed tool history, images and custom context messages carry over. Original transcript text stays visible where appropriate; context-edit markers explain changes to what Pi sees.
- Runtime instructions and tools come from the destination. Ordinary Pi extensions, running tools, pending dialogs and in-memory state do not migrate. Opaque extension records stay in the archive.
- Imported human messages are labeled **Imported user**. Importing does not claim you authored them.
- **Import & share** from Private publishes the selected conversation using Pocket's existing access rules. Scoped invitations remain scoped. The older Import flow/API defaults to owner-only, preserving existing behavior; retries never make a shared session private. Archive downloads always remain owner-only because they include unselected branches. Per-session membership management is not implemented yet.
- Automatic moves verify and stop the selected local Herdr Pi only. They do not discover every Pi outside Herdr or recover unsaved TUI drafts/branch selections. The file fallback still requires you to stop Pi yourself.

Trusted collaborators first. App access controls do not isolate files from the machine owner or an agent with shell access. Durable's replay policies do not make arbitrary external side effects exactly once. See [SECURITY.md](SECURITY.md) for Pocket's inherited security model.

## Development

```sh
npm run check
npm run lint
node --test --test-concurrency=1 test/*imports.test.ts test/import-failures.test.ts test/import-ui.test.ts test/private-sessions.test.ts test/private-ui.test.ts
npm test
```

The import tests cover SQLite persistence, context equivalence, concurrent retries, rollback, source integrity, authorization, two views and reconnect. The UI test runs real Chromium at phone and desktop sizes when a supported browser is installed; otherwise it reports a skip.

The inherited suite has known failures on this machine that also reproduce on the unmodified upstream revision. See [implementation and validation](docs/import-implementation.md) for exact results and commands. Do not treat the full suite as green.

## Fork and next steps

- [Fork provenance and licensing](FORK.md)
- [Original Pocket README](README.upstream.md)
- [Current product plan](docs/mvp-proposal.md)
- [Import research](docs/research/durable-import.md)
- [Code map](docs/map.md) and [architecture](docs/architecture.md)
- [Project language](CONTEXT.md)

Next: finish structured-terminal parity checks, test actual iOS Safari devices, and add multi-server connection management and finer-grained sharing. Discovery outside Herdr remains future work. Native desktop and iOS packaging are separate from the web client.

## Credits

Inspired by [Mario Zechner's demo](https://x.com/badlogicgames/status/2106452296087302173) of his own Pi app. Pi Pocket is an independent project, not affiliated with Earendil. JetBrains Mono and Geist are bundled under the SIL Open Font License ([JetBrains Mono](web/fonts/OFL.txt), [Geist](web/fonts/Geist-OFL.txt)).

## License

[MIT](LICENSE). To report a security problem, see [SECURITY.md](SECURITY.md).
