# Private Herdr mirror

The user explicitly changed the earlier Durable-only direction on 2026-10-09. Existing private sessions stay in Herdr, with a Collie-like bridge and pi-tava's interface. Only the app owner can see or control them. Import explicitly copies saved history into a Durable-managed conversation; the original Pi keeps running. Owners may separately grant unrestricted steering guests access to local Pi discovery and shared copies, but never to this private pane/terminal UI.

"Shared" or "public" means available under this app's signed-in access rules, not anonymous access from the internet. Scoped invitations remain scoped. A full source archive can include other branches, so it remains owner-only after the selected conversation is shared.

## What the owner sees

The sidebar has **Collab** and **Herdr** tabs. Collab opens the [Projects](projects.md) view first, alongside Recent and Archived. Private mirrors local Herdr instances, workspaces, tabs and panes, including empty groups, shells and non-Pi agents. Spaces groups linked worktrees beneath their repository, with branch lines on roots and full branch names on children. Repository folds are local to this browser view; they never focus or change Herdr. Orphan worktrees stay visible as standalone spaces. Discovery and Chat do not focus or rearrange the user's terminal. Opening Terminal automatically connects its native client and may resize shared panes. Unreachable instances are marked unavailable rather than shown as empty or stale.

On wide screens, Appearance's **Tiled windows** setting applies to both Private views: sidebar and pane gaps, inactive borders and the active border on hover or keyboard focus. Turning it off restores the flat layout. The compact Spaces, Agents and terminal controls remain the same; phones remain edge-to-edge.

A private pane has its own route and view. Pi panes show the last persisted branch with the same transcript layout, user bubbles, assistant messages, collapsible thinking and paired tool cards as Durable chats. A current visible terminal snapshot is collapsed below the messages. The prompt uses the same compact, auto-sizing message box and arrow send control as Durable, but sends only to the verified Herdr Pi. Enter sends on desktop; Shift+Enter or a touch keyboard inserts a line (the bridge still accepts only single-line input). Slash suggestions complete commands with arrows and Tab/Enter; completing a command does not send it. Commands, skills and templates run in the target Pi, not through Durable's command parser.

The model chip opens the shared searchable picker with private delivery: a selection sends an exact `/model provider/id` command. The chip follows the selected branch's saved configuration, never an optimistic switch. Selecting that already-observed model is a no-op, avoiding a selector if Pi's scope has since changed. The app's model catalogue may differ from the target Pi's scoped or authenticated models. If the saved model does not change, Chat holds further sends until the owner checks Pi's editor in Terminal; an unavailable model can open a terminal selector. This local readiness check is not an OS/editor-focus lease and is lost on reload.

Attach files with the paperclip, drag/drop or clipboard paste. Uploads are owner-only server files, bound to the selected pane revision by opaque tokens. The prompt lists their paths and asks Pi to read them, including images; this is not direct image injection, and document formats depend on Pi's tools. Files and ordinary drafts stay ready when switching models. Attachment-only messages work; commands and attachments must be sent separately. Changed sessions require removing and reattaching files. Terminal snapshots also work for other panes. These are not Durable entries, tasks, billing records, shared rooms or imports. Closing a browser or this app does not stop the original Pi.

Chat sends guarded prompts and agent commands to a verified idle/done Pi and previews import. Working/blocked Pi stays read-only in Chat. The user subsequently chose a separate structured **Terminal** mode for full Herdr control, with GPUI-style desktop navigation and mobile-first agent Chat. See [terminal-mode.md](terminal-mode.md). The text snapshot described here is a fallback, not the Terminal renderer.

## Background notifications

The server observes Herdr agent metadata even with every browser/PWA closed, but only while the
owner has a push subscription and completion or approval notifications enabled. It never attaches
a terminal client or reads journals, transcripts, terminal text or history for notifications. The
existing **Pi finished** preference covers Herdr turn completion; **Pi needs approval** covers
blocked-agent attention, without notification Allow/Deny actions. A push contains fixed generic
text and an exact opaque `/private/:id` pane link, never titles, paths or private content. A visible
owner event connection on that exact pane suppresses its pushes; hidden/disconnected views do not.

Only an observed working-to-done/idle transition of the same verified foreground agent emits
completion. A new blocked transition emits attention. Initial discovery, reconnect, unknown or
missing state, disappearance, changed process/session/terminal identity and owner credential
changes rebaseline silently. Eligibility is rechecked between native reads, and a second snapshot
must agree with the first on pane identity, status and sequence after process-info reads. These
checks are not an atomic native identity lease. This is an observed agent-turn ending, not
verification of task success. Polling can miss turns shorter than its four-second interval. Shutdown
cancels and joins discovery, process/socket reads and admitted push delivery. Synthetic coverage is in
`test/herdr-alerts.test.ts` and `test/alerts.test.ts`; it is not live Herdr or device-push validation.

## Routes and authorization

| Route                                  | Operation                                            |
| -------------------------------------- | ---------------------------------------------------- |
| `GET /api/private`                     | Instance/workspace/tab/pane tree                     |
| `GET /api/private/:id`                 | Bounded saved-history and terminal view              |
| `POST /api/private/:id/prompt`         | Explicit, agent-aware Pi prompt or slash command     |
| `POST /api/private/:id/upload`         | Raw file upload with revision and name query fields  |
| `DELETE /api/private/:id/upload`       | Remove an unsubmitted file by opaque token           |
| `POST /api/private/:id/import-preview` | Preview a saved-branch copy through `app.piSessions` |

Every operation requires the actual configured owner before any socket, process or file access. Writes also use pi-tava's existing `X-Pocket` check. Responses are `no-store`. HTTP route IDs are server-generated hashes, not client-selected socket paths, PIDs or journal paths. Owner-only hierarchy records also include `nativeId` for workspace, tab and pane navigation over an already authorized native connection. HTTP pane routes still reject those raw native IDs. No private content is added to shared session lists, peek tiles, room broadcasts or durable documents.

The browser polls only when the private view is mounted, visible and online, with no overlapping requests per resource. Chat clears private data on unmount or loss of owner access and ignores responses for old routes/identities. Terminal connections have a separate owner-only in-memory pool so navigation does not detach them. That pool closes and clears on owner-access loss. Private Markdown disables app-file links and executable rich blocks. External images are not fetched, and inline journal images are counted rather than displayed.

## Bridge safety

The bridge shares the existing local Herdr socket discovery, bounded JSON-line transport and foreground Pi identity checks with the importer. A revision binds the selected pane to its terminal, Pi session reference, OS process lifetime/fingerprint and the current app instance. Switching sessions, replacing a process or restarting the app invalidates old prompt destinations. Reads check the identity again before returning their contents. Automatic terminal snapshots use `pane.read` with `source: "visible"`, never recent-history reads: Herdr can actively wheel-scroll idle alternate-screen agents to harvest their application history. Polling must not drive the application or change the shared view. See [the source investigation](research/herdr-passive-pane-reads.md).

Sending rechecks a fresh snapshot and process identity, then calls Herdr's `agent.prompt` with `{ target, text }`. It never falls back to `pane.send_text` or `pane.send_keys`. The wire contract was checked against the installed protocol-22 `herdr api schema --json`; its optional `wait` is an object or null, not a boolean. The bridge omits it because it waits for delivery acknowledgment, not the whole agent turn. No live agent input was used to verify the schema.

Chat input, including assembled attachment paths, is limited to 32 KiB. It rejects terminal-control characters, multiline text, tabs and leading `!` shell commands, and requires a request ID. Slash commands intentionally execute agent operations. Built-in commands that need terminal dialogs, including `/import` and `/bug`, and argument-less model/thinking commands, require Terminal mode instead. Custom commands can also open dialogs: finish those in Terminal before using Chat again. Process and lifecycle checks cannot prove that the editor, rather than a selector, has focus. Use explicit Terminal mode for multiline input and shell commands. Duplicate IDs return the same in-process outcome; reusing an ID for different content is rejected. The bounded receipt table never evicts a send and later replays it. After 4,096 admitted IDs, the app requires a restart; its new epoch rejects old revisions. This is not Durable exactly-once execution.

Private attachments are stored under `private-uploads/` in the app's data folder, outside Durable conversation uploads, with private directory/file permissions. Each file is bounded to 50 MiB, each message to ten tokens, and staging to 100 files. Unsubmitted files expire after an hour or can be removed explicitly, including after a known-unsent input rejection. Tokens and their previews are memory-only; an app restart invalidates tokens. The first verified upload in the new process removes old staging epochs, without touching retained files. Old staging can remain on disk until that next upload. Admission promotes files to retained storage before external input. Retained files have no automatic deletion path because Pi may read them later, including after uncertain delivery. Uploads recheck the current owner and Pi revision before and after streaming; browser paths are never accepted as attachments.

Guarded Chat and terminal input use a shared pane-operation lock. The app commits an opaque admission receipt before sending a prompt. Only a matching `agent_prompted` acknowledgement settles it. A lost or invalid reply leaves a durable restriction on further Chat prompts; the private UI also withholds import preparation while delivery is uncertain. Restarting pi-tava does not clear that receipt and cannot cancel Herdr's queued Enter. Other terminal clients remain outside this lock, and process checks are not atomic OS handles. No guarantee is made about a process swap between checks and Herdr dispatch.

A connected web Terminal and recorded terminal input do not disable copying saved history. Terminal attachment and newly forwarded input take short reservations alongside guarded Chat, but copy-only Move does not reserve an input lock or wait for Pi to become idle. Copying does not settle or erase an uncertain Chat receipt. Terminal use is recorded before forwarding input; private transcripts and input text never enter these receipts. Preview and Move keep the browser's terminal attached and send no abort, stop or process signal.

## Saved history and limits

The reader opens a regular file read-only with a bounded descriptor read. It never calls Pi's mutating `SessionManager.open`. It accepts v3 journal envelopes, follows the last persisted branch and tolerates only an unfinished final JSONL line while Pi is writing. Corrupt earlier lines produce an explanatory fallback to terminal output, not silent repairs.

Limits are 16 MiB and 20,000 entries per journal, the latest 400 selected-branch records, and 512 KiB of projected history. Text parts and tool arguments have visible caps. Terminal snapshots request up to 200 currently visible lines and cap the returned text at 64 KiB. They do not request application-owned scrollback; saved history comes from the journal. Large/unsupported journals can still be viewed through their terminal snapshot. Unsaved TUI branch selection, drafts and in-progress assistant text are not reconstructed from JSONL; use the terminal snapshot for live output.

Discovery covers same-owner default and named local Herdr sockets plus the inherited socket path. It does not discover remote SSH instances, arbitrary external socket roots or non-Herdr Pi processes. Multi-server connections remain separate work.

## Import and share

The private **Import & share** entry opens the shared `ImportPanel` from `web/sheets/pi-sessions.js`, with a source hash/leaf and destination model. Confirmation acknowledges copying saved history and sharing that copied conversation under the app's signed-in access rules. It sends `visibility: "shared"` to `/api/pi-sessions/active`. The one live Move action only copies history, including from busy Pi; it never sends Escape, aborts work, stops or signals Pi, closes panes or writes its journal. Preview alone publishes nothing.

`app.piSessions` is the canonical service for this flow and New Session's Live/History picker. New copies commit history, exact archive/provenance, catalogue visibility and source-hash/leaf retry identity atomically. Each new conversation is explicitly a Chat; Imported from Pi is a separate origin label in its header. Owner copies outside the private sharing entry default to owner-only and show an explicit **Private / Shared** choice with optional project placement. An existing private imported Chat can be shared later through **Share imported Chat…** in its menu or sidebar Options, without its original file. This shares the entire current Chat and future messages, not only the first copied snapshot. The owner can select a project for project-scoped collaborators; an unassigned shared Chat instead uses existing unrestricted access or a session invitation. No older import is shared automatically, and private forks are not promoted with their original. Explicit owner retries may promote private copies to shared; owner-only retries do not downgrade shared copies. Guest retry keys are separate, so their shared copies cannot publish an owner's private import.

Local Pi discovery/continuation requires `canContinuePiSessions`: the owner, or an explicitly granted guest with unrestricted steering access. The owner grants or revokes `continuePiSessions: true` through invites or Account & access; granted guests cannot delegate it. Guests must select discovered sources and explicitly confirm a shared copy. Arbitrary manual paths, full archives and the private Herdr UI stay owner-only. Sharing a branch does not expose the other branches in its source archive.

Changed process/session fingerprints require refreshing the live list. Changed saved bytes require a fresh preview; the server never silently replaces confirmed history with later output. Source reads are bounded and read-only. Snapshot parsing tolerates only a cut-off final JSONL record, preserving it in the exact archive while excluding it from history. Valid unfinished tool tails receive synthetic unavailable-result errors, which say the original tool may have run or may still run. No request or tool is resumed here. Malformed complete records and invalid tool ordering remain refused; strict parsing remains available. Unsaved terminal drafts and streaming text do not migrate.

There are no takeover reservations, stop operations or recovery APIs. `TakeoversDoc` remains registered under its existing stored identity only for inert legacy records. Subsequent work in the copied Chat runs through Durable independently of the original Pi.

## Reuse and verification

The bridge reuses the projection/rendering, authorization and transport conventions inherited from upstream Pi Pocket, and the `PiSessions` Herdr module. Its journal text handling is adapted from Collie's MIT-licensed `bridge/journal/{pi,text}.ts`; its hierarchy and pane-read wire structure follow Collie's Herdr client, while automatic polling deliberately uses the passive visible source. The full Collie license and revision are recorded in [../FORK.md](../FORK.md). The first Chat mirror used GPUI only as a reference. Structured Terminal mode now links its pinned client/protocol crates and includes attributed protocol declarations and fixtures.

Tests use generated journals, synthetic Herdr/process tables, isolated SQLite/configuration and temporary Chromium profiles. No personal session was stopped, sent input or imported during development. The protocol schema check was read-only.

Focused coverage lives in `test/private-sessions.test.ts`, `test/shared-imports.test.ts` and `test/private-ui.test.ts`, alongside the import/snapshot regressions. These cover authorization before I/O, hierarchy, worktree membership and branches, local folding, native worktree navigation without reconnecting, stale identities, busy/shell prompt refusal, partial writes, bounded display, request deduplication, uncertain delivery, copy-only shared publication/archive access, and mobile/desktop routing. Test locations do not establish that the current revision has passed them.

### Previous implementation validation

The results below were recorded before the canonical `PiSessions` copy-only migration. They describe earlier Private Chat/Terminal implementations and fixtures, not validation of the current Move action or permissions. Retired takeover behavior in those older checks is not a current contract.

The Chat-reuse browser regression compares computed layout and composer styling with a real Durable conversation at mobile and desktop widths. It also checks tiled gaps and both window borders in Private Chat and Terminal, active-border hover and toggling back to flat layout. The tiling regression failed before removing Private's zero-gap/zero-border overrides and passed afterward. It also checks paired tool results, local thinking expansion, memory-only drafts, acknowledged clearing and private-only Enter delivery. It fails on the pre-refactor copy at the missing Durable user-bubble layout. The earlier Chat-layout regression run completed with 376 tests: 369 passed, seven failed, no skips or cancellations (`/tmp/pi-chat-all-tests.log`). The private Chat regression passed. The terminal-prefix shortcut failure reproduced in the pre-refactor copy (`/tmp/pi-chat-terminal-baseline.log`); the other failures concern existing branch paths, browser status, default branch and model-switch attribution.

Private Chat commands, uploads and model reflection passed **60/60** focused backend, real-browser, journal, receipt, import and documentation checks (`/tmp/pi-private-input-focused-final.log`). TypeScript, repository ESLint, formatting, edited browser-JS syntax and `git diff --check` passed. After the final review fixes, the full checkout run had **418 tests, 410 passed and eight failed**, with no skips or cancellations (`/tmp/pi-private-input-review-all-tests.log`); none of this feature's tests failed. That checkout also contained parallel file-editor work. The remaining failures concern branch/browser/model-attribution/terminal-shortcut behavior and shell-stop output; the full suite is not green. The current-model no-op, rejected-upload removal and terminal-dialog guards have regressions that failed before their fixes and passed afterward. Browser checks used synthetic Pi processes, generated journals and temporary upload bytes, not personal Herdr panes.
