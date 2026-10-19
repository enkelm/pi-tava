# Pi session copies and historical validation

`PiSessions` in `src/server/pi-sessions.ts`, exposed as `app.piSessions`, is the only service for local Pi discovery, preview, history copies and source archives. `pi-sessions/source.ts`, `history.ts`, `herdr.ts` and `active.ts` own parsing/conversion, saved-file discovery, Herdr discovery/identity and live-instance selection. The old `Imports` service and `imports/` directory are removed.

`web/sheets/pi-sessions.js` owns the shared Live/History picker and confirmation, used by New Session → Import, launcher continuation and private Import & share. `web/sheets/import.js` is removed. Both sources use one Move confirmation, which copies the selected saved branch while Pi keeps running, including when busy. It never aborts work, sends Escape or signals, stops Pi, closes panes or writes its journal. A changed process/session fingerprint requires refreshing the list; changed source bytes require a fresh preview before a new copy. A successful copy has a durable receipt: its confirmed retry opens the existing conversation even after the original changes or exits. There are no takeover reservations or recovery APIs. `TakeoversDoc` remains registered with its original stored identity only for inert legacy records.

Local Pi history is owner-only by default. `canContinuePiSessions(user)` also admits a retained legacy guest explicitly granted `continuePiSessions: true`, but only with steering access and neither session nor explicit project scope. New collaborator invitations always have project grants and cannot grant host-history access, including with `all: true`. The owner can manage retained legacy grants in Account & access; guests cannot issue invitations. Redemption rechecks creator authority, and role/scope restrictions clear the grant. The Import tab follows that capability. Guests select discovered sources and must explicitly acknowledge sharing their copy. Manual arbitrary file paths, full source archives and [private Herdr panes](private-sessions.md) remain owner-only. Owner copies default to private; private Import & share explicitly publishes under authenticated/scoped access rules, never anonymously.

Every new copied conversation is explicitly a Chat. The header's Imported from Pi label records origin, not a new thread type. Nothing in historical input starts work; the first new human submission uses Coop's current instructions and tools.

## Consolidation validation

The focused socket-free batch passed **130 tests**, covering generated journals, canonical context, busy Pi copies, unchanged sources, no historical work/spend, atomic rollback, concurrent/reopened retries, sharing, permissions/revocation, private input fences, project placement and linked-session privacy. The real HTTP handler is exercised in memory for the canonical continuation routes and invite/access validation; no listener is needed for those cases. `npm run check`, `npm run lint`, `npm run format` and `npm run format:check` passed, along with edited browser-JS syntax and whitespace checks.

Listener-dependent HTTP, Herdr transport, terminal and browser integration remain unvalidated here. An existing attachment-path fixture returned `listen EPERM` and was excluded from the final batch, as were the other known listener fixtures. No listener workaround or server restart was performed. Browser scenarios were updated and statically checked, not executed. This is focused implementation evidence, not a passing full `npm test` run or an independent review.

The original slice began on 2026-10-09 from Pocket `d01f763b02f06ff6144d4366eb966a76dbb35577`. Sections marked historical below retain its earlier checks and retired stop-and-takeover behavior. Those logs and totals do not establish validation of the current copy-only implementation.

## Previous stop-and-takeover implementation (historical)

Everything in this section, including its routes, process controls and test totals, describes the previous implementation. Its stop operations and recovery flow no longer exist. For the current copy-only contract, use the sections above and the canonical service/conversion sections below.

The **Import** tab in **New Session** has explicit **Live** and **History** source tabs. **Live** lists local Herdr Pi sessions. Select a session, review its model and choose **Move to Durable**. The server stops the verified Pi process, imports its last saved branch and opens the Durable conversation. **History** lists saved Pi journals; manual file/branch entry remains under **Advanced import**, not a source-switching text link.

New owner-only routes:

| Route                              | Purpose                                                     |
| ---------------------------------- | ----------------------------------------------------------- |
| `GET /api/imports/active`          | List discovered sessions and unfinished moves               |
| `POST /api/imports/active/preview` | Preview a server-discovered session ID without stopping it  |
| `POST /api/imports/active`         | Confirm the move, validate, stop the selected Pi and import |

`imports/herdr.ts` reads default/named Herdr sockets under the local config root, plus the inherited `HERDR_SOCKET_PATH`. It accepts only same-user socket files. It uses `session.snapshot` and `pane.process_info`, then checks the foreground Pi against the local OS process table, including UID, start time, command fingerprint and ancestry under the pane's shell. It excludes the app and its ancestors. Raw process arguments are not persisted or sent to browsers.

Discovery and control currently support macOS and Linux. Herdr may omit foreground `argv` on macOS; in that case the detector accepts only a local process titled exactly `pi` whose PID is the foreground job leader. UID, shell ancestry, process lifetime and all other stop checks still apply. When Herdr supplies arguments, they must still match the local command. The app explains an ancestor-process refusal separately from a process it cannot identify.

Idle sessions remain selectable after terminal use and while a web Terminal is attached. Working/blocked Pi can be selected, but moving it requires separate `abortRunning: true` consent; the preview warns that running operations will be aborted and tool changes are not undone. Missing/stale references, duplicate session paths, unsupported commands, protected ancestors and identity changes are still refused. A recently resumed session whose file predates its process needs a completed turn before automatic takeover can verify it. Process checks reduce stale-PID risks but are not an OS-level atomic process handle.

Source compatibility, destination settings and either the idle preview hash or live preview's branch ancestry must pass before external control. A running preview may show an unfinished tail but cannot publish it. After confirmed abort, the server sends one targeted Escape, waits for idle status and child tools to exit, rereads the final journal and validates complete tool history. It then sends SIGTERM only to the selected PID, waits for exit and validates the source again. It never closes a pane, signals a process group or escalates to SIGKILL. Idle moves keep the unchanged-preview check. The browser may disconnect while the server finishes.

The `pocket.takeovers` session document reserves a move before stopping Pi and stores its result in the same transaction as the import. Completed retries return that result. Pending moves remain selectable after a daemon restart and require an explicit preview/retry; startup does not issue stop signals. An idle source change during shutdown requires a fresh preview instead of silently changing the imported context. Explicit abort consent allows importing Pi's newly saved cancellation tail after revalidation, not silently importing an unrelated branch.

This does not discover arbitrary Pi processes outside Herdr or read an unsaved TUI branch selection or draft. It checks for other discovered writers, not every possible external program that could open the source file. The stopped-file fallback remains an explicit owner responsibility.

Verification for this addition uses synthetic Herdr replies and generated sessions, plus a disposable Node child to exercise real SIGTERM and confirm its parent shell remains alive. No real Pi or Herdr sessions were stopped. Backend tests cover preflight refusal, stale identity, working/child-process states, timeout without force-kill, recovery after reopen, auth and a browser disconnect during takeover. Chromium exercises both the picker and the saved-file fallback at phone and desktop sizes.

The initial takeover addition passed all 24 importer/takeover tests, including both real-browser flows. TypeScript and lint passed. A complete serial run of all 261 tests finished with 255 passing and the same six inherited failures documented below, with no skips. The run is recorded in `/tmp/pi-active-all-tests.log`.

Other logs: `/tmp/pi-active-tests.log`, `/tmp/pi-active-ui.log`, `/tmp/pi-active-check.log`, `/tmp/pi-active-lint.log`. Inspected screenshots: `/tmp/pi-active-ui/` and the final confirmation views in `/tmp/pi-active-final/`. The mechanical design detector only flagged inherited CSS outside the import changes, recorded in `/tmp/pi-active-design.json`.

### PID-only discovery regression

The first real-machine trial exposed a gap in the synthetic fixture: macOS Herdr returned a foreground PID without `argv`, while the fixture always supplied arguments. The detector therefore rejected real Pi processes as unidentifiable. A focused test reproduced that exact message before the fix. Three regression tests now cover PID-only discovery/takeover, refusal of unrelated processes and the app-ancestor guard. The browser picker test also uses PID-only replies.

A read-only check against the reported live Herdr session now identifies its real foreground Pi PID. The diagnostic runs beneath that Pi, so its ancestor guard correctly refuses stopping it. No stop was requested during the live check. Regression logs are in `/tmp/pi-herdr-pid-only-red.log`, `/tmp/pi-herdr-tests.log` and `/tmp/pi-herdr-import-regression.log`. All 27 import/takeover tests now pass. The complete serial suite finished with 258 of 264 passing and the same six inherited failures, with no skips; see `/tmp/pi-herdr-all-tests.log`. TypeScript, lint and whitespace checks also passed.

### Failed-assistant history regression

The next real-machine preview failed because the validator rejected every assistant `error` or `aborted` entry, including old attempts followed by successful work. Read-only structural inspection found one old error with empty content and no tool calls. A generated fixture reproduced the exact preview error before the fix.

Failed and cancelled assistant attempts now stay in stored history and the source archive. They are excluded from preview/model context, matching Durable's context derivation. They can also be the final saved assistant response. Pi ends these generations before dispatching their tool calls; partial calls from these attempts do not become tasks or pending tool cards. The transcript explains that they were not executed. Validation still rejects real tool calls with missing results, failures interleaved into an unfinished tool round, orphan results and deferred provider requests.

`test/import-failures.test.ts` covers old and final failures, cancellation, partial tool calls, compaction, archive fidelity, SQLite reopen, zero historical tasks/usage and explicit continuation. The browser picker fixture now includes the old empty error that caused the reported failure. All test inputs are generated; no personal session was imported or stopped.

All 33 importer/takeover tests passed, including both Chromium flows. The complete serial suite finished with 264 of 270 passing and the same six inherited failures, with no skips or cancellations. Formatting, TypeScript, lint and whitespace checks passed. The failing regression is recorded in `/tmp/pi-import-failure-red.log`; final results are in `/tmp/pi-import-failure-regression.log`, `/tmp/pi-import-failure-all-tests.log` and `/tmp/pi-import-failure-{format,check,lint}.log`.

### Terminal-use and busy-handoff regression

The idle-session picker originally treated every saved web-terminal input marker as a permanent takeover block. The focused regression reproduced the screenshot's exact reason before the fix. Known terminal use and an attached Terminal no longer disable import; unknown Chat delivery receipts still do. Short operation reservations prevent new app input or attachment from crossing an active move, without disconnecting an existing Terminal at preview.

Busy selection now previews without control and requires separate abort consent. Confirmed takeover uses Herdr's `pane.send_keys` with one Escape, waits for idle status and child tools to exit, then validates the final saved journal before stopping Pi. Herdr's generic `ok` result is transport acknowledgment only, not proof that Pi consumed Escape. PID/session/source-branch checks remain in place. A cancelled user or complete tool-result tail may be imported through active handoff without replay; saved-file defaults remain strict. Missing actual tool results, unrelated branch changes and cancellation timeouts do not publish history.

Generated journals, synthetic Herdr/processes, isolated storage and mobile/desktop Chromium cover this change. No personal Herdr pane was controlled or imported. The installed protocol schema and `herdr pane send-keys --help` were inspected read-only; the request uses the canonical `esc` key.

Formatting, TypeScript, ESLint, edited browser-JS syntax and whitespace checks passed. A final review found that initial terminal focus and runtime resize/layout writes could cross takeover despite the short upgrade lock. Attachment now reserves through handshake and initial focus pipe enqueue, and geometry/focus changes use separate short reservations without input receipts. Failure cleanup and isolation from an initializing connection have gateway regressions. In the final full `npm test` run, all import/parser/control/terminal-gateway/private-session/shared-import checks passed, including all eleven gateway tests, busy confirmation in Chromium and attached-terminal takeover. The complete run had 446 tests: 437 passed and nine failed, with no skips or cancellations. Failures were in existing branch paths, browser frames, default branch, model-attribution ordering, terminal prefix shortcuts, shell-stop output and the parallel file-editor suggestion check. The editor check passed in isolation; so did an earlier drop-in reload timeout. Other browser permission/navigation retries showed transient CDP failures, but all import browser checks passed in the final full run. The full suite is not green. Logs: `/tmp/pi-import-safety-all-tests.log`, `/tmp/pi-import-abort-unrelated-retry.log`, `/tmp/pi-import-safety-{format,check,lint}.log`. The exact idle reason and busy-row failures were reproduced before repair in `/tmp/pi-idle-import-red.log` and `/tmp/pi-abort-import-ui-red.log`.

## Saved-history picker

`GET /api/pi-sessions/history` requires the local Pi continuation capability and returns `Cache-Control: no-store`. It discovers regular JSONL files in Pi's configured sessions root and its immediate project directories, honoring `PI_CODING_AGENT_SESSION_DIR`, Pi settings and the normal `PI_CODING_AGENT_DIR` fallback. Rows show the saved branch's title (or first user text), source path, cwd, file modification time and active-message count. Known local Herdr files are omitted in favor of Live. Listing does not establish that every writer has stopped; history is copied without controlling those writers.

Discovery refuses symbolic links and rechecks candidate identity. It scans at most 10,000 directory entries, retains the 100 most recently modified candidates, applies the existing 16 MiB file bound and reads at most 64 MiB sequentially per scan. Concurrent authorized requests share only an in-flight scan and recheck access afterward. Omitted, unreadable or truncated results produce notes; complete records remain subject to snapshot validation. Source files are never repaired, migrated or written.

Both Live and History retain the upstream working-directory layout: a folder name and shortened parent path above one compact bordered list of sessions. Groups use the full working directory as their identity, so identically named folders under different parents remain separate. History preserves discovery recency order, both between folders and within them; filtering title/cwd/path metadata happens before grouping, so empty groups disappear. A saved row’s tooltip identifies its source file. Clicking a row opens the shared destination-model and copy/visibility confirmation through `POST /api/pi-sessions/preview`; its `history` field contains at most six user/assistant text snippets of 400 characters each from the selected branch, folded under saved history and import limits. No tool output, images, thinking or unselected branches are sent as snippets. There is no intermediate Continue screen or stopped-process acknowledgment. Search and confirmation state survive New Session's outer tab changes. Manual path and branch fields remain owner-only for files outside the discovered folder; a guest's submitted path must still be in current discovery results.

### Previous History-picker validation (historical)

These checks and totals predate the canonical `PiSessions` copy-only migration. They describe the earlier picker and importer, not a current validation run.

Validation used generated journals, synthetic Herdr replies and isolated app/browser data only. The browser regression failed on the old missing History tab, then passed with searchable paths, lazy selected-branch disclosure, preserved outer-tab state, responsive bounds and confirmation without premature import. All 60 history/import/parser/takeover regression tests passed. The legacy manual-file browser flow passed in isolation; the aggregate UI run still encountered the earlier navigation/guest-evaluate CDP flakes. Formatting, TypeScript, ESLint, edited-JS syntax and whitespace checks passed. Mobile and desktop were inspected in a throwaway app, then stopped. The design detector reported only inherited CSS outside the import changes. Logs: `/tmp/pi-historic-ui-red.log`, `/tmp/pi-historic-ui-final.log`, `/tmp/pi-historic-backend-regression.log`, `/tmp/pi-historic-manual-ui.log`, `/tmp/pi-historic-{format,check,lint}.log`, `/tmp/pi-historic-design.json`. A full run exposed reuse of the older browser test's app data in the new History case; that fixture now opens its own empty app directory. Review also found a concurrent-growth gap in the aggregate read budget. History now passes each charged candidate size as a trusted file-descriptor cap; the reader bounds allocation and actual reads, retaining its stability checks and unchanged default sentinel behavior. Real-FD before/after-stat growth regressions demonstrated red→green, and the safety review found no remaining concrete issues.

Final formatting, TypeScript, ESLint, edited-JS syntax and whitespace checks passed. All 107 focused backend regressions passed. The final full `npm test` run completed with 467 tests: 457 passed, nine failed, one Windows-only browser-profile case skipped, and none cancelled. All four import browser flows, saved-history discovery and both FD-growth regressions passed. The remaining failures were in branch paths, browser frames, default-branch expectations, model-attribution ordering, terminal prefix shortcuts, shell-stop output and editor suggestions; this is not a fresh untouched-baseline comparison. Logs: `/tmp/pi-historic-all-tests-final.log`, `/tmp/pi-historic-ui-isolated-app.log`, `/tmp/pi-import-history-fd-{red,green,regressions}.log`, `/tmp/pi-historic-{format,check,lint}-final.log`. The full suite is not green.

## Canonical Pi session service

`app.piSessions` owns these authenticated operations under `/api/pi-sessions`:

| Route                                  | Purpose                                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------- |
| `GET /api/pi-sessions`                 | Search capability-gated saved-session metadata; retain visible prior-copy markers           |
| `GET /api/pi-sessions/history`         | Discover bounded saved-session metadata                                                     |
| `GET /api/pi-sessions/active`          | Discover local Herdr Pi instances, including busy Pi                                        |
| `POST /api/pi-sessions/active/preview` | Preview an opaque discovered instance ID without controlling it                             |
| `POST /api/pi-sessions/active`         | Confirm and copy the unchanged saved branch; never abort or stop Pi                         |
| `POST /api/pi-sessions/preview`        | Validate a saved source and return branch warnings and destination models                   |
| `POST /api/pi-sessions/continue`       | Confirm the source hash, selected branch, copy acknowledgment and destination configuration |
| `GET /api/pi-sessions/:id/archive`     | Owner-only download of the exact source UTF-8 JSONL, including other branches               |

`POST /api/pi-sessions` uses the same creation method as `/continue`; `GET /api/pi-sessions/preview?path=…` uses the same preview method. These entry points are not separate continuation implementations. The old `/api/imports` routes are removed.

The normal `X-Pocket` request-header check protects POSTs. The service rechecks current membership/capability before and after asynchronous reads and during the publication transaction. A revoked guest cannot retain access through a stale browser response. Guest source choices must resolve through live IDs or current History discovery; owner-only manual paths do not become an unrestricted guest file reader.

The UI uses the existing sheet controls and command/event transport. New Session is available below sidebar search without creating a session first. Its Import tab is capability-gated; Start new retains project/folder selection. The importer starts no executor or JSONL writer. Private terminal control remains a separate owner-only bridge, while the copied conversation uses ordinary Durable rooms.

## Conversion contract

The importer accepts ordinary Pi format v3, with an absolute, existing same-machine cwd. Files must be valid UTF-8, regular files, at most 16 MiB, and contain at most 20,000 entries plus the header. It validates entry envelopes, complete snapshot records and the selected branch. Unknown selected-branch types, invalid references, complete malformed JSONL and unsupported messages fail without silently skipping records.

Copies use snapshot mode. Only a final cut-off JSON object may be left out of projected history, and those exact bytes stay in the archive. Earlier malformed records, malformed complete final records and invalid tool ordering still fail. A branch entry ID may be supplied explicitly; otherwise the last complete persisted entry is used. Unsaved TUI branch selection, editor drafts and streaming output are not recovered.

A valid pending user/tool tail may be copied, but starts no tasks. Pending tool results become synthetic error results saying the result was unavailable at snapshot time and the tool may have run or may still run in the original Pi. This is an uncertainty marker, not a claim that the original tool never executed. Context edits cannot manufacture missing results outside that valid pending tail. Failed/cancelled assistant attempts remain in history and the archive but do not contribute to model context and are not restarted. Deferred provider requests and interleaved or otherwise invalid tool history remain unsupported.

Strict parsing remains available through `parsePiSession`/`readPiSession` in `pi-sessions/source.ts`; it is their default mode, not the service's snapshot-copy mode. Strict mode requires complete tool history ending in a saved assistant response, including a failed or cancelled response, and rejects a cut-off JSONL record.

The conversion uses the pinned Pi session projection and message helpers. It maps source IDs to Durable IDs for compaction heads and context edits, preserves model-visible messages and images, and archives source-only records. It excludes historical system instructions and tool declarations from active context. The destination builds its own current prompt and tools. Image-bearing context requires an image-capable destination model.

The source is read through a bounded file descriptor and checked for changes during the read. It is never opened through `SessionManager.open`, which can repair or migrate its input. The import request rereads the source and checks the preview's SHA-256. A valid file without a final newline remains byte-identical.

No saved-file or live copy requires stopping the original process. Confirmation acknowledges the saved snapshot and destination visibility. The source can keep advancing after the checked read; the new Chat and original Pi are independent, not synchronized writers. No pending source request or tool is resumed in the copy.

## Atomic state and access

One harness transaction creates the conversation, agent settings and app documents, appends historical entries, writes an explicitly `chat`-typed catalogue entry, stores the full original in `pocket.imported-session`, and adds the source-hash/leaf key to `pocket.imports`. Imported from Pi is origin metadata displayed separately from that Chat type, including for older `fromPi` sessions. No filesystem archive transaction or takeover reservation is needed. A failed transaction publishes none of these changes.

Import deduplication is distinct from prompt deduplication. Concurrent retries for the same source bytes and selected branch reuse the same conversation, including after restart; a different branch has a different key. Guests have person-specific keys, separate from the owner's, so a shared guest copy cannot publish or reuse an existing owner-private import. Stored `TakeoversDoc` records remain inert; no recovery route or startup stop operation consumes them.

Historical entry writes do not create model/tool tasks or update `pi.usage`. Imported human messages are labeled `Imported user`, not assigned to the owner. Imported notes are distinguished from human prompts. The first new submission establishes the requester through Pocket's existing attribution path.

Owner copies default to `ownerOnly` in their catalogue metadata. A shared copy requires explicit `visibility: "shared"`; guests must choose shared visibility and acknowledge the copy before creation. An explicit owner retry can promote a private import to shared, while owner-only retries do not downgrade a shared import. `canSee` applies it to the root session and its subagents; app-created forks propagate it. Both initial and live session lists use that access check. The full source archive is not a room document and is downloadable only by the owner. It can contain branches that were not imported.

Other sessions still use Pocket's existing access rules. General per-conversation membership editing and multi-server connections remain separate work. Shell-capable collaborators and the machine owner are not isolated by these app checks.

Current behavior has focused fixtures in `test/pi-snapshot.test.ts`, `test/pi-sessions.test.ts`, `test/active-imports.test.ts`, the import/history/failure tests and `test/invite-{auth,permissions}.test.ts`. Browser flows live in `test/import-ui.test.ts` and the invite portion of `test/mobile-ui.test.ts`. This lists coverage owners, not current pass results. No test or browser run was performed for this documentation-only update.

## Initial slice verification (historical)

These results describe the original owner-only importer before the `PiSessions` copy-only and permission changes. They do not establish current parser, Move, browser or full-suite validation.

Environment: Node `v24.19.0`, macOS, locked Pocket dependencies with Pi packages `1.0.2`. Test helpers isolate Pi configuration, storage and working directories. Providers are scripted; real Chromium uses temporary browser profiles.

Passing import checks:

```sh
npm run check
npm run lint
node --test --test-concurrency=1 --test-timeout=60000 \
  test/imports.test.ts test/import-ui.test.ts
```

All 13 new tests passed, with no skips. They cover:

- Selected branches, an explicitly selected alternate branch, compaction, repeated compaction, no-kept-entry compaction and context edits.
- SQLite context equivalence, provenance, exact archive retrieval and unchanged source files.
- Zero historical execution, no phantom usage and no invented author mapping.
- Concurrent import retries, reopen, prompt retry and continuation.
- An injected transaction failure, rollback, reopen and successful retry.
- Stale previews, confirmations, model/thinking validation and image capability checks.
- File-size and UTF-8 limits, missing final newline, malformed/unsupported records and incomplete tools.
- HTTP auth/CSRF checks, owner-only archives and conversations, live lists and fork visibility.
- Real-browser mobile/desktop preview, error recovery, confirmation, two views, disconnect during a model request and reconnect to the completed answer.

The production parser also accepted all four generated Pi 1.1.0 archives from the earlier feasibility probe. Those are temporary research fixtures, not a promise of compatibility with every Pi extension or provider.

### Inherited regression suite

The default parallel `npm test` exceeded the 300-second tool limit. The suite was then partitioned so Chromium suites ran serially and every test file could complete. Six failures reproduced in an untouched checkout at the exact upstream revision, using the same installed dependencies:

| Test                                        | Failure reproduced upstream                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------ |
| `branches.test.ts`, branch/worktree listing | macOS `/private/var/...` versus `/var/...` path expectation                    |
| `changes.test.ts`, initial branch name      | This machine's Git default is `develop`; the test expects `main` or `master`   |
| `goals.test.ts`, successful goal            | An initial model-change activity precedes the expected goal activity           |
| `plan.test.ts`, plan approval               | The same initial model-change activity precedes the expected plan activities   |
| `schedules.test.ts`, scheduled message      | The same initial model-change activity precedes the expected schedule activity |
| `browser.test.ts`, browser-panel frame      | Frame request returns 204 where the test expects 200                           |

The initial slice's partitioned results covered all 250 tests: 244 passed, six failed, none skipped. The non-browser run completed with 186 of 191 passing; the inherited browser/mobile/peek run completed with 57 of 58 passing; the new browser import test passed separately. All 13 new importer tests also passed together in their focused run.

The inherited mobile navigation and peek UI tests passed. These existing failures were not hidden with skips or changed expectations, and no unrelated production fixes were mixed into the importer. The full inherited suite must not be reported as green.

A documentation-link failure while this report was still being written was corrected by completing the document. A drop-in reload test timed out in one parallel run and passed on the final serial run. These transient results are separate from the six reproduced failures above.

## Historical evidence

Temporary logs and screenshots from the original implementation, not a current run:

- `/tmp/pi-durable-import-final.log`: all 13 import tests passing.
- `/tmp/pi-durable-check.log`, `/tmp/pi-durable-lint.log`: static checks.
- `/tmp/pi-durable-all-tests.log`: interrupted default parallel suite.
- `/tmp/pi-durable-browser-existing.log`: inherited browser/mobile/peek suites, 57 passing and the reproduced frame failure.
- `/tmp/pi-durable-validation.log`: final serial non-browser run, 186 passing and five reproduced failures.
- `/tmp/pi-durable-ui-settled.log`: final browser import test passing.
- `/tmp/pi-durable-nonbrowser-final.log`: earlier non-browser run before final documentation was complete.
- `/tmp/pi-pocket-baseline-tests.log`, `/tmp/pi-pocket-baseline-plan-schedules.log`, `/tmp/pi-pocket-baseline-browser.log`: matching upstream failures.
- `/tmp/pi-durable-ui-settled/`: inspected phone preview, confirmation, conversation and desktop preview images, captured after finite animations settle.
- `/tmp/pi-durable-design-diagnostics.json`: detector warnings in inherited CSS, outside the added import rules. The existing Pocket visual system was retained, not redesigned. No delegated design review was performed.

The original Pocket, Collie and Herdr GPUI reference worktrees were not changed. No personal conversations were imported, no real model provider was called, and no application was left running on personal data. No commits, pushes or publishing operations were performed.

## Remaining work

- General per-conversation membership editing beyond the explicit import visibility and local-history invitation capability.
- Multi-server connection management.
- More compatibility fixtures for deferred provider requests, provider-specific content and interrupted histories beyond the supported snapshot tail.
- Actual-provider smoke tests and process-crash fault injection. Historical pre-commit rollback evidence is not a power-loss or mid-tool crash test.
- Live-process discovery outside local Herdr. History already discovers ordinary saved files; stopping sources or cancelling their helper processes is not part of Move.
- Upstream test stabilization, followed separately from import development.

The historical runs above retained Pocket's existing browser, extensions and other features; they did not certify the whole app. Current browser, Safari/iOS and actual-provider validation must be reported separately from those old results.
