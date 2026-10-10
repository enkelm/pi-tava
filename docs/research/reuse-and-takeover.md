# Takeover and code reuse

Research date: 2026-10-09. This follow-up replaced live Herdr attachment with stopped-session takeover. Its native-resume findings remain valid, but the current product direction is [one-way import into Pi Durable](durable-import.md), preserving Pocket's runtime rather than using ordinary Pi RPC as the execution backend.

## Result

Ordinary Pi can resume a stopped session directly in RPC mode. No new terminal rendering bridge, continuously observed Herdr pane, or second active Pi writer is necessary.

```sh
# Run only after the original Pi exits, in the original project directory.
pi --mode rpc --session /absolute/path/to/session.jsonl
```

Pi 1.1.0's CLI resolves an explicit session path through `SessionManager.open`. That restores its stored ID and entry tree. The SDK offers the same operation, and RPC provides history/state queries, prompts, steering, follow-ups, and events. Multiple app clients can use one daemon-owned executor. [P1][P2][P3]

The existing Pi Durable library also follows single-process storage ownership. Its README states: "One process owns a storage at a time; there is no cross-process locking." Multiple views are supported, but multiple independently running writers on one storage are not the architecture to use. [D1]

## Isolated verification

Executed `node /tmp/pi-takeover-check.xOm16J/probe.mjs` using Node 24.19.0 and installed Pi 1.1.0.

The probe generated a session with ordinary Pi's `SessionManager`, a prior user/assistant exchange, and a custom entry. It then:

1. Opened the file in a Pi RPC process and changed the session name.
2. Closed that process through stdin EOF and waited for its successful exit.
3. Started a second Pi RPC process with the same explicit session path.
4. Verified the same session ID, file, name, original entry IDs, and custom entry.
5. Sent a new prompt to a loopback-only mock OpenAI-compatible provider.
6. Verified that the provider received the earlier conversation marker and Pi persisted the new assistant answer.
7. Reopened the file after shutdown to verify that the continuation was stored.

Result: PASS. Exactly one mock model request was made.

The child processes used isolated HOME, Pi, and XDG directories with an explicit environment that did not inherit provider credentials. Automatic networking was disabled, and personal/project extensions, skills, themes, prompts, context files, and tools were disabled. No packages were installed. No personal session or Herdr daemon was accessed.

This proves saved-state resume and continuation between two sequential RPC processes. The original process in the probe was not a TUI running in Herdr. Real Herdr shutdown, third-party extension compatibility, provider behavior, branch-navigation edge cases, and a multi-client application remain untested.

## Limits of takeover

Resume is not process migration. It restores stored conversation state; it does not preserve an unsaved editor draft, a pending interactive approval, a running shell call, or arbitrary extension memory.

Prefer a settled session. Preserve its working directory and necessary configuration. Verify that the original process has exited before opening its file under the daemon. The first UI can ask the owner to exit Pi manually rather than automatically sending terminal keys or killing panes.

Ordinary Pi's inspected session writer appends to the file and reconstructs its index locally; it is not a distributed writer coordinator. The daemon must prevent duplicate managed executors, and the owner must not independently reopen a managed file in another Pi process. This research does not claim an app lock can constrain an unmodified external Pi. [P3]

## What can be reused

Reference revisions: Pocket `d01f763b02f06ff6144d4366eb966a76dbb35577`; Collie `cfaf95a93df3c9404a03f5f840bf222f0cd6c2ee`. Both are MIT licensed. Retain their notices when copying.

### Pocket already implements one writer and many views

`Room` holds a set of clients and one `AttachedReplicatedState<ConversationView>`. It obtains that view through `conversation.viewState()` and subscribes to updates. HTTP creates distinct clients and delivers events through SSE or long polling. Prompts go through one central conversation with author-scoped request IDs and explicit busy-session behavior. No per-browser executor is created by these paths. [R1]

Its multiplayer code is coupled to Durable state. Room snapshots include authors, chat, reactions, pins, notes, and turns; collaboration changes harness documents through transactions. The web store understands Pocket's view protocol. Copying only its transport does not bring the collaboration state model with it. [R2]

If using Durable execution, copy Pocket as a coherent app base rather than extracting a nominally standalone multiplayer library. Relevant modules include `app`, `room`, `projection`, `docs`, `commands`, `collab`, `attribution`, `requests`, `auth`, `config`, and `http`, plus `web/` and matching dependencies/tests.

If ordinary Pi resume is retained, adapt the parts of that app which expect Durable views and transactions. This is still work, but it is a different and narrower problem than synchronizing a live terminal and web controller.

### No ordinary-Pi importer found in Pocket

Pocket opens `pocket.sqlite` and resumes its own Durable tasks. Searches of Pocket source and source/documentation files for JSONL import and `SessionManager` did not locate an ordinary-Pi session importer. This is an absence claim about the inspected Pocket source, not every upstream library or future revision. [R3]

Importing into Pocket's runtime therefore remains separate from native Pi resume. It needs a conversion contract for history, branches, compaction, custom state, and extensions. Do not assume that two formats using JSONL are interchangeable.

### Collie is useful without copying its whole bridge

Reuse its Herdr socket/session discovery and validated agent references if automatic discovery is added. Small presentation helpers also exist for image URLs, unified diffs, and ANSI stripping. [R4]

Do not use Collie's rendered transcript as an executable import. Its Pi journal projection deliberately omits or summarizes some state and truncates text. Use ordinary Pi's session parser and actual session files instead. [R5]

## Sources

Installed Pi base: `/Users/enkelm/.pi/agent/install/releases/1.1.0/node_modules/@earendil-works/pi-coding-agent/`.

- [P1] `docs/cli.md`, session and RPC options; `docs/sessions.md`; `dist/main.js:265-320`.
- [P2] `docs/rpc-commands.md`, especially `prompt`, `get_state`, `get_messages`, `get_entries`, and `switch_session`; `examples/sdk/11-sessions.ts`.
- [P3] `dist/core/session-manager.js:665-743,790-819,1326-1350`; `dist/core/sdk.js:69-145`.
- [D1] [Pi Durable README, storage](https://github.com/earendil-works/pi/blob/f1b2e77f5b13b2a199b1052cb79c235451afe7d7/packages/durable/README.md#storage).

Reference paths below are relative to `/Users/enkelm/Projects/oss/` at the revisions listed above.

- [R1] `pi-pocket/src/server/room.ts:139-185`; `pi-pocket/src/server/http/events.ts:28-75`; `pi-pocket/src/server/commands.ts:374-456`.
- [R2] `pi-pocket/src/server/room.ts:185-210`; `pi-pocket/src/server/docs.ts:34-56`; `pi-pocket/src/server/collab.ts:120-121,421-422,464-465`; `pi-pocket/web/store.js:318-350,404,485`.
- [R3] `pi-pocket/src/server/app.ts:293-358`; source searches for `jsonl`, `SessionManager`, `importSession`, and resume paths.
- [R4] `collie/bridge/mux/herdr/sessions.ts`; `collie/bridge/mux/herdr/client.ts`; `collie/bridge/journal/pi.ts:110-128`; `collie/bridge/journal/diff.ts:24-55`; `collie/bridge/journal/text.ts:24-39`.
- [R5] `collie/bridge/journal/pi.ts:3-20,438-468`; `collie/bridge/journal/text.ts:9-13`.
