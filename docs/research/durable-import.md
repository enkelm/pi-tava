# Ordinary Pi import into a Durable-centered app

Research date: 2026-10-09. This replaced the provisional ordinary-Pi RPC runtime recommendation. The user wants Pi Durable at the center of the product. This is the pre-implementation research record; the subsequent [Pocket-fork implementation](../import-implementation.md) is documented separately.

## Recommendation

Use Pocket as a coherent application base, keep its Pi Durable runtime, and add one-way import of a stopped ordinary Pi session's selected branch. Do not maintain an ordinary-Pi execution backend alongside it.

This is worthwhile for the MVP. Pocket already builds its views, commands and collaboration on Durable. Converting history once is a more contained change than replacing those dependencies just to preserve native JSONL execution. The trade-off is explicit: conversation continuity, not complete ordinary-Pi runtime compatibility.

Durable also provides value for new sessions. It persists admitted inputs, request IDs, agent choices, task checkpoints and application documents. Clients observe committed views; they do not own execution. A browser disconnect need not stop work, and a restarted daemon can resume Durable work. Recovery does not guarantee exactly-once external effects. Interrupted tool calls rerun only when declared replay-safe; other calls return an interrupted result. These are documented runtime capabilities, not all verified by this import probe. [D1]

## API findings

`Harness.createConversation({ ownership, agent, init })` runs creation, configuration and initialization in one commit. Its `init` callback can append historical entries with `tx.appendEntry`. That operation stores entries; it does not submit old prompts or reconstruct generation/tool tasks. [D2]

Entries separate model-facing messages from application data. The standard kinds cover user messages, assistant messages, tool results, system changes and compaction. Compaction heads and context edits can refer to remapped Durable entry IDs. The source Pi branch tree does not need to become a Durable task graph. [D3]

Ordinary Pi provides the branch and context projection needed to check conversion. Its current projection accounts for compaction, branch summaries, custom messages and context edits. Plain extension-state entries are not model messages. Do not import Collie's display projection instead. [P1]

## Isolated feasibility probe

Command:

```sh
node /tmp/pi-durable-import.o4MLvz/probe.mjs
```

Pinned dependencies matched Pocket's runtime generation:

- Node `v24.19.0`.
- Source session APIs from installed Pi coding-agent `1.1.0`.
- `@earendil-works/pi-durable`, `pi-ai` and `chord`, each `1.0.2`.
- JSONL Durable storage. Pocket's SQLite backend was not exercised.
- The in-process faux provider, with no network or credentials.

The probe generated ordinary Pi files, copied them, and read the copies. It imported the selected branch in a conversation-creation transaction. Each source entry retained its original record as application data, alongside a source-to-Durable ID map and source hash. Original system instructions and tool declarations were archived but excluded from active model context. The destination supplied fresh runtime instructions.

| Fixture                                                         | Imported source entries | Active non-system messages | Result |
| --------------------------------------------------------------- | ----------------------: | -------------------------: | ------ |
| Selected branch, including a branch summary                     |                      18 |                         10 | PASS   |
| Compaction retaining recent history, with a context replacement |                      20 |                          8 | PASS   |
| Compaction retaining no earlier entries                         |                      19 |                          3 | PASS   |
| Repeated compaction retaining an earlier summary's range        |                      20 |                          8 | PASS   |

Across these fixtures, assertions verified:

1. Durable's derived non-system model messages exactly matched ordinary Pi's canonical projection after its message conversion.
2. The abandoned branch and context-omitted note were absent from model context.
3. Selected-branch user/assistant messages, completed tool calls/results, embedded images, summary text and custom context messages survived where still active. Older selected-branch entries remained in stored history.
4. Opaque extension state was retained as data, not activated as an extension.
5. Import created no tasks. Starting the scheduler with only imported history made no model request.
6. Historical assistant messages containing nonzero usage did not increase `pi.usage`, including after reopen.
7. Closing and reopening storage preserved the imported context.
8. A new prompt reached the faux provider with that history and produced a stored answer. There was exactly one provider request per fixture.
9. After another reopen, retrying the same prompt request ID returned the existing submission without another model call.
10. Source and archive hashes stayed unchanged.

The first run exposed a converter mistake: a compaction retaining nothing can store its own source ID as `firstKeptEntryId`, rather than `null`. Mapping that sentinel to Durable's `head: "self"` fixed the fixture. The final run passed all four cases.

Evidence:

- Probe: `/tmp/pi-durable-import.o4MLvz/probe.mjs`.
- Output: `/tmp/pi-durable-import.o4MLvz/probe-output.log`.
- Final results and generated fixtures: `/tmp/pi-durable-import.o4MLvz/run-f0ZCWg/`, including `results.json`.
- Dependency lockfile: `/tmp/pi-durable-import.o4MLvz/package-lock.json`.

These are temporary research artifacts, not production importer code. The probe cleared inherited environment variables before loading Pi libraries and used isolated HOME/Pi/XDG directories. It installed no tools or personal extensions. No personal conversation, Herdr daemon, real provider, browser client or simulator was exercised.

This does not prove arbitrary-version import, all branch/edit combinations, provider-specific thinking/signature compatibility, interrupted-tool recovery, crash atomicity, SQLite integration or browser behavior. Those remain tests for implementation.

## Bounded MVP contract

The initial importer should:

- Accept an explicitly selected, stopped same-machine session and one selected branch. Require the owner to stop the original Pi manually at first.
- Take a stable byte copy, validate format/version and parent/target references, and show a compatibility preview before publishing the import. Verify that the source did not change during the copy.
- Keep the complete original as an access-controlled archive. Work from a copy, not the original: Pi's loader can repair a missing final newline, and session opening may migrate older formats. [P2]
- Import supported history, compaction boundaries and context edits with remapped IDs. Preserve original records for inspection.
- Create a new Durable conversation identity with source provenance. Do not promise to preserve the ordinary Pi session ID as the runtime ID.
- Preserve cwd and title where valid. Resolve the chosen model and thinking level against the destination configuration, with an explicit fallback choice rather than silently changing them.
- Use Pocket's current tools, instructions and extensions. Retain old system/tool configuration only as history; warn that runtime behavior changes.
- Keep historical usage out of new spend totals. If displayed later, label it imported usage rather than updating `pi.usage`.
- Record unknown extension state without executing it. Preview unsupported records and require acknowledgment or refuse the import where context cannot be represented safely.
- Refuse unsettled/incomplete tool histories in the first supported contract rather than guessing whether a shell effect completed.
- Deduplicate imports using source provenance and selected leaf. Runtime request-ID deduplication does not itself deduplicate imports.

The source file remains unchanged. New work is stored only in Durable. There is no write-back synchronization, live TUI bridge, or full branch-tree conversion in the MVP. Returning to ordinary Pi means opening the old archive without subsequent Durable work; reverse export is separate work.

## Pocket integration

Keep Pocket's conversation creation, default documents, rooms, transport and browser application. Its `createSession` already supplies cwd/model/thinking and writes the session catalogue in `init`; `conversationCreated` initializes author, artifact and subagent documents. Add an authorized import path alongside this flow, not a new parallel runtime. [R1]

A few integration changes are necessary:

- Import provenance, validation, preview and atomic publication.
- Explicit imported-author labels or owner-confirmed mapping. Do not present extension-generated context notes as human-authored prompts. Pocket's author cache follows submissions, so direct historical writes need deliberate cache initialization. [R2]
- Projection of imported notes and bookkeeping. Native user/assistant/tool/compaction kinds mostly fit, but unknown kinds currently become generic cards. The probe did not test Pocket rendering or context-edit presentation. [R3]
- New-usage-only accounting, verified in the bare runtime and still requiring Pocket-level restart tests. Pocket accounts positive UsageDoc deltas during live commits and startup. Do not copy historical totals into that document. [R4]
- Private-by-default membership. This was already a product requirement and remains an application change, not an importer problem.

Ordinary Pi extensions are not drop-in compatible. Pocket loads a factory receiving `PocketHost` and installs Durable `Extension` objects. Importing extension records cannot port callbacks, tools, UI or task code. Keep compatibility promises narrow; do not add a general extension adapter to this MVP. [R5]

## Research execution note

The parallel Pocket scout ended in `failed` state with the exact error `Subagent produced no output (possible model cold-start or empty response).` Run ID: `00bb830c-ba43-4381-acfd-3bc2d9cf548f`. Its cwd was `/Users/enkelm/Projects/oss`, with no managed worktree or branch. The reference repository was `pi-pocket`, branch `main`, revision `d01f763b02f06ff6144d4366eb966a76dbb35577`.

It wrote [a partial research artifact](durable-pocket-integration.md) before failing final settlement. That file is retained as produced; its embedded attestation is not a successful-run gate. The parent checked the creation, attribution, spend, projection and extension-loading claims cited here against source, and completed its separately assigned API/probe work. No runner fallback or retry was used. Pocket, Collie and Herdr GPUI worktrees remained clean. The planning directory `pi-durable` is not a Git repository.

Status evidence is retained under `/var/folders/mp/gx961znj185f96txf5g5y_ch0000gn/T/pi-subagents-uid-501/async-subagent-runs/00bb830c-ba43-4381-acfd-3bc2d9cf548f/`.

## Sources

Durable package paths below are relative to `/tmp/pi-durable-import.o4MLvz/node_modules/@earendil-works/pi-durable/`, version `1.0.2`:

- [D1] `README.md`, sections Persist and Resume, Tools, Watching a Conversation, Busy Conversations, Your Own State and Storage. The API is experimental and storage has no cross-process locking.
- [D2] `dist/harness/harness.js:193-242`; `dist/session/transaction.js:150-174`.
- [D3] `dist/types.d.ts:262-306`; `dist/entries.js:10-30`; `dist/harness/context.js:31-114`; `dist/harness/usage.js:3-22`.

Ordinary Pi paths are relative to the installed `@earendil-works/pi-coding-agent/`, version `1.1.0`:

- [P1] `dist/core/session-manager.js:150-280`; `dist/core/messages.js:75-124`.
- [P2] `dist/core/session-manager.js`, `loadEntriesFromFile`, migration and open paths. The loader appends a missing trailing newline after validating a header.

Pocket paths are relative to `/Users/enkelm/Projects/oss/pi-pocket/`, revision `d01f763b02f06ff6144d4366eb966a76dbb35577`:

- [R1] `src/server/commands.ts:145-198`; `src/server/app.ts:293-358`.
- [R2] `src/server/attribution.ts:66-112,140-215`; `src/server/app.ts:415-439`.
- [R3] `src/server/projection.ts:244-362`.
- [R4] `src/server/spend.ts:49-124`.
- [R5] `src/server/host.ts:106-131`; `src/server/reload.ts:318-356`.
