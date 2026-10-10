# Import slice implementation and validation

Implemented on 2026-10-09 as a fork of Pocket `d01f763b02f06ff6144d4366eb966a76dbb35577`. This document records the original owner-only import slice and its regressions, not the whole product MVP.

Current addition: the user chose an owner-only live [Private Herdr mirror](private-sessions.md). **Import & share** now explicitly publishes the selected conversation using Pocket's authenticated/scoped access rules. The archive remains owner-only. Legacy import requests still default to owner-only; the private bridge and shared-import validation are documented separately.

## Running-session takeover

The import sheet now opens a list of local Herdr Pi sessions rather than a file-path form. Select a session, review its model and choose **Move to Durable**. The server stops the verified Pi process, imports its last saved branch and opens the Durable conversation. The saved-file form remains available as a fallback.

New owner-only routes:

| Route                              | Purpose                                                     |
| ---------------------------------- | ----------------------------------------------------------- |
| `GET /api/imports/active`          | List discovered sessions and unfinished moves               |
| `POST /api/imports/active/preview` | Preview a server-discovered session ID without stopping it  |
| `POST /api/imports/active`         | Confirm the move, validate, stop the selected Pi and import |

`imports/herdr.ts` reads default/named Herdr sockets under the local config root, plus the inherited `HERDR_SOCKET_PATH`. It accepts only same-user socket files. It uses `session.snapshot` and `pane.process_info`, then checks the foreground Pi against the local OS process table, including UID, start time, command fingerprint and ancestry under the pane's shell. It excludes the app and its ancestors. Raw process arguments are not persisted or sent to browsers.

Discovery and control currently support macOS and Linux. Herdr may omit foreground `argv` on macOS; in that case the detector accepts only a local process titled exactly `pi` whose PID is the foreground job leader. UID, shell ancestry, process lifetime and all other stop checks still apply. When Herdr supplies arguments, they must still match the local command. The app explains an ancestor-process refusal separately from a process it cannot identify.

Busy states, missing/stale references, duplicate session paths, child processes, unsupported commands and identity changes are refused. A recently resumed session whose file predates its process needs a completed turn before automatic takeover can verify it. Process checks reduce stale-PID risks but are not an OS-level atomic process handle.

Source compatibility, the preview hash and destination settings must pass before any signal. The server sends SIGTERM only to the selected PID, waits for exit and validates the source again. It never sends keys, closes a pane, signals a process group or escalates to SIGKILL. The browser may disconnect while the server finishes.

The `pocket.takeovers` session document reserves a move before stopping Pi and stores its result in the same transaction as the import. Completed retries return that result. Pending moves remain selectable after a daemon restart and require an explicit preview/retry; startup does not issue stop signals. A source change during shutdown requires a fresh preview instead of silently changing the imported context.

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

## Initial import slice

`app.imports` adds three authenticated HTTP operations:

| Route                          | Purpose                                                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/imports/preview`    | Read and validate the source, resolve the selected branch, and return warnings and available destination models                       |
| `POST /api/imports`            | Confirm the unchanged source hash, stopped-process acknowledgment and destination configuration; import or return the existing import |
| `GET /api/imports/:id/archive` | Download the exact original UTF-8 JSONL, including unselected branches, as the owner                                                  |

The existing `X-Pocket` request-header check protects writes. The import service checks ownership itself too, before opening any source file. The UI uses Pocket's existing sheet controls and command/event transport. It is available without creating a session first, through **Import** beside **New**.

The importer starts no second executor or JSONL writer. Live private terminal views now belong to the separate Private bridge. The existing Pocket rooms serve the imported Durable conversation to every signed-in owner device.

## Conversion contract

The importer accepts ordinary Pi format v3, with an absolute, existing same-machine cwd. Files must be valid UTF-8, regular files, at most 16 MiB, and contain at most 20,000 entries plus the header. It validates every entry envelope and selected-branch record. Unknown selected-branch types, invalid references, malformed JSONL and unsupported messages fail without skipping lines.

A branch entry ID may be supplied explicitly. Otherwise the last persisted entry is used; this does not recover an unsaved TUI branch selection. The selected branch must end in a saved assistant response, including `error` or `aborted`, rather than a pending user prompt or tool round. Failed/cancelled attempts remain in history but do not contribute to model context or start work. Deferred provider requests and incomplete or interleaved tool histories are still rejected, even when earlier history has since been compacted.

The conversion uses the pinned Pi session projection and message helpers. It maps source IDs to Durable IDs for compaction heads and context edits, preserves model-visible messages and images, and archives source-only records. It excludes historical system instructions and tool declarations from active context. The destination builds its own current prompt and tools. Image-bearing context requires an image-capable destination model.

The source is read through a bounded file descriptor and checked for changes during the read. It is never opened through `SessionManager.open`, which can repair or migrate its input. The import request rereads the source and checks the preview's SHA-256. A valid file without a final newline remains byte-identical.

For the saved-file fallback, stopping the original process is an explicit owner responsibility. The app does not claim that acknowledgment proves no other Pi process can write that file. Future work stays in Durable, not the original file.

## Atomic state and access

One harness transaction creates the conversation, agent settings and app documents, appends historical entries, writes the session catalogue, stores the full original in `pocket.imported-session`, and adds the source-hash/leaf key to `pocket.imports`. No filesystem archive transaction is needed. An injected failure before commit leaves none of those changes visible, including after reopening SQLite.

Import deduplication is distinct from prompt deduplication. Concurrent retries for the same source bytes and selected branch find the same conversation. A different selected branch has a different import key.

Historical entry writes do not create model/tool tasks or update `pi.usage`. Imported human messages are labeled `Imported user`, not assigned to the owner. Imported notes are distinguished from human prompts. The first new submission establishes the requester through Pocket's existing attribution path.

Imported sessions have `ownerOnly` in their catalogue metadata. `canSee` applies it to the root session and its subagents; app-created forks propagate it. Both initial and live session lists use that access check. The full source archive is not a room document and is downloadable only by the owner. It can contain branches that were not imported.

Other sessions still use Pocket's upstream access rules. General private-by-default membership, collaborator sharing controls and multi-server connections remain next. Shell-capable collaborators and the machine owner are not isolated by these app checks.

## Initial slice verification

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

## Evidence

Temporary logs and screenshots from this implementation:

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

- General private/shared membership and invitations that can share imported conversations while keeping their full source archives owner-only.
- Multi-server connection management.
- More compatibility fixtures, especially deferred provider requests, interrupted tool rounds and provider-specific content.
- Actual-provider smoke tests and process-crash fault injection. The current rollback test throws before commit; it is not a power-loss or mid-tool crash test.
- Discovery outside local Herdr, and cooperative handoff for sessions whose persistent helper processes prevent the conservative stop check.
- Upstream test stabilization, followed separately from import development.

The browser, extensions and other features already present in Pocket were retained. This slice does not newly implement or certify all of them. Desktop, sandboxing and iOS remain deferred.
