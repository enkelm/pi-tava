# Private Herdr mirror

The user explicitly changed the earlier Durable-only direction on 2026-10-09. Existing private sessions stay in Herdr, with a Collie-like bridge and Pocket's interface. Only the app owner can see or control them. Import is the explicit transition to a shared, Durable-managed conversation.

"Shared" or "public" means available under this app's signed-in access rules, not anonymous access from the internet. Scoped invitations remain scoped. A full source archive can include other branches, so it remains owner-only after the selected conversation is shared.

## What the owner sees

The sidebar has **Sessions** and **Private** tabs. Sessions retains Pocket's existing Recent/Folders/Archived views. Private mirrors local Herdr instances, workspaces, tabs and panes, including empty groups, shells and non-Pi agents. Discovery and Chat do not focus or rearrange the user's terminal. Opening Terminal automatically connects its native client and may resize shared panes. Unreachable instances are marked unavailable rather than shown as empty or stale.

A private pane has its own route and view. Pi panes show the last persisted branch with the same transcript layout, user bubbles, assistant messages, collapsible thinking and paired tool cards as Durable chats. A recent read-only terminal snapshot is collapsed below the messages. The prompt uses the same compact, auto-sizing message box and arrow send control as Durable, but sends only to the verified Herdr Pi. Enter sends on desktop; Shift+Enter or a touch keyboard inserts a line (the bridge still accepts only single-line plain text). Terminal snapshots also work for other panes. These are not Durable entries, tasks, billing records, shared rooms or imports. Closing a browser or this app does not stop the original Pi.

Chat sends guarded text to a verified idle/done Pi and previews import. Working/blocked Pi stays read-only in Chat. The user subsequently chose a separate structured **Terminal** mode for full Herdr control, with GPUI-style desktop navigation and mobile-first agent Chat. See [terminal-mode.md](terminal-mode.md). The text snapshot described here is a fallback, not the Terminal renderer.

## Routes and authorization

| Route                                  | Operation                                           |
| -------------------------------------- | --------------------------------------------------- |
| `GET /api/private`                     | Instance/workspace/tab/pane tree                    |
| `GET /api/private/:id`                 | Bounded saved-history and terminal view             |
| `POST /api/private/:id/prompt`         | Explicit, agent-aware Pi prompt                     |
| `POST /api/private/:id/import-preview` | Existing takeover preview without stopping anything |

Every operation requires the actual configured owner before any socket, process or file access. Writes also use Pocket's existing `X-Pocket` check. Responses are `no-store`. HTTP route IDs are server-generated hashes, not client-selected socket paths, PIDs or journal paths. Owner-only hierarchy records also include `nativeId` for workspace, tab and pane navigation over an already authorized native connection. HTTP pane routes still reject those raw native IDs. No private content is added to shared session lists, peek tiles, room broadcasts or durable documents.

The browser polls only when the private view is mounted, visible and online, with no overlapping requests per resource. Chat clears private data on unmount or loss of owner access and ignores responses for old routes/identities. Terminal connections have a separate owner-only in-memory pool so navigation does not detach them. That pool closes and clears on owner-access loss. Private Markdown disables app-file links and executable rich blocks. External images are not fetched, and inline journal images are counted rather than displayed.

## Bridge safety

The bridge shares the existing local Herdr socket discovery, bounded JSON-line transport and foreground Pi identity checks with the importer. A revision binds the selected pane to its terminal, Pi session reference, OS process lifetime/fingerprint and the current app instance. Switching sessions, replacing a process or restarting the app invalidates old prompt destinations. Reads check the identity again before returning their contents.

Sending rechecks a fresh snapshot and process identity, then calls Herdr's `agent.prompt` with `{ target, text }`. It never falls back to `pane.send_text` or `pane.send_keys`. The wire contract was checked against the installed protocol-22 `herdr api schema --json`; its optional `wait` is an object or null, not a boolean. The bridge omits it because it waits for delivery acknowledgment, not the whole agent turn. No live agent input was used to verify the schema.

Chat prompts are limited to 32 KiB, reject terminal-control characters, multiline text and leading Pi command prefixes, and require a request ID. Use explicit Terminal mode for native commands and paste. Duplicate IDs return the same in-process outcome; reusing an ID for different content is rejected. The bounded receipt table never evicts a send and later replays it. After 4,096 admitted IDs, the app requires a restart; its new epoch rejects old revisions. This is not Durable exactly-once execution.

Bridge input and takeover use one pane-operation lock. The app commits an opaque admission receipt before sending a prompt. Only a matching `agent_prompted` acknowledgement settles it. A lost or invalid reply leaves a durable restriction on further Chat prompts and takeover. Restarting Pocket does not clear it and cannot cancel Herdr's queued Enter. Other terminal clients remain outside this lock, and process checks are not atomic OS handles. No guarantee is made about a process swap between checks and Herdr dispatch.

A connected web Terminal holds an instance lease that excludes automatic takeover, not guarded Chat. A separate operation lock prevents newly forwarded native input from overlapping an active Chat admission inside Pocket. It is not a PTY-drain or cross-transport acknowledgement. Native keyboard input has no PTY-drain acknowledgement, so the app also records terminal use before forwarding input. Automatic shutdown/import remains restricted afterward; disconnecting or restarting is not proof of cancellation. Private transcripts and input text never enter these receipts. Stopped-file import remains available after the owner exits Pi directly.

## Saved history and limits

The reader opens a regular file read-only with a bounded descriptor read. It never calls Pi's mutating `SessionManager.open`. It accepts v3 journal envelopes, follows the last persisted branch and tolerates only an unfinished final JSONL line while Pi is writing. Corrupt earlier lines produce an explanatory fallback to terminal output, not silent repairs.

Limits are 16 MiB and 20,000 entries per journal, the latest 400 selected-branch records, and 512 KiB of projected history. Text parts and tool arguments have visible caps. Terminal reads request 200 unwrapped lines and cap the returned text at 64 KiB. Large/unsupported journals can still be viewed through their terminal snapshot. Unsaved TUI branch selection, drafts and in-progress assistant text are not reconstructed from JSONL; use the terminal snapshot for live output.

Discovery covers same-owner default and named local Herdr sockets plus the inherited socket path. It does not discover remote SSH instances, arbitrary external socket roots or non-Herdr Pi processes. Multi-server connections remain separate work.

## Import and share

**Import & share** opens the existing preview with source hash/leaf and destination model. Its confirmation explains both stopping the selected Pi and making the selected conversation visible to other signed-in users under their access rules. It sends `visibility: "shared"` to the existing active import route. Preview alone never stops or publishes anything.

The importer validates visibility before sending a signal. New shared imports publish history, archive/provenance, catalogue visibility and retry identity atomically. Existing private imports can be explicitly promoted on retry; legacy owner-only retries never downgrade shared sessions. Conflicting visibility choices for the same move are rejected rather than silently ignored. The saved-file and older import API remain owner-only by default for compatibility.

The existing shutdown safeguards still apply: no busy work, unresolved real tool calls, protected ancestors, children, uncertain process identities, process-group signals or SIGKILL. An app restart never automatically stops Herdr agents. Source files remain unchanged; subsequent shared work stays in Durable.

## Reuse and verification

The bridge reuses Pocket's projection/rendering, authorization and transport conventions, and the existing importer/Herdr module. Its journal text handling is adapted from Collie's MIT-licensed `bridge/journal/{pi,text}.ts`; its hierarchy and pane-read contract follow Collie's Herdr client. The full Collie license and revision are recorded in [../FORK.md](../FORK.md). The first Chat mirror used GPUI only as a reference. Structured Terminal mode now links its pinned client/protocol crates and includes attributed protocol declarations and fixtures.

Tests use generated journals, synthetic Herdr/process tables, isolated SQLite/configuration and temporary Chromium profiles. No personal session was stopped, sent input or imported during development. The protocol schema check was read-only.

Focused coverage lives in `test/private-sessions.test.ts`, `test/shared-imports.test.ts` and `test/private-ui.test.ts`, alongside the existing import regressions. It covers authorization before I/O, hierarchy, stale identities, busy/shell refusal, partial writes, bounded display, request deduplication, uncertain delivery, bridge/import exclusion, shared publication/archive access, and mobile/desktop routing. The Chat-reuse browser regression compares computed layout and composer styling with a real Durable conversation at mobile and desktop widths. It also checks paired tool results, local thinking expansion, memory-only drafts, acknowledged clearing and private-only Enter delivery. It fails on the pre-refactor copy at the missing Durable user-bubble layout. The full regression run completed with 376 tests: 369 passed, seven failed, no skips or cancellations (`/tmp/pi-chat-all-tests.log`). The private Chat regression passed. The terminal-prefix shortcut failure reproduced in the pre-refactor copy (`/tmp/pi-chat-terminal-baseline.log`); the other failures concern existing branch paths, browser status, default branch and model-switch attribution.
