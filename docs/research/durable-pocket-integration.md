# Code Context

Verified Pocket HEAD `d01f763b02f06ff6144d4366eb966a76dbb35577`; read `AGENTS.md` and architecture guidance. All source paths below are relative to `/Users/enkelm/Projects/oss/pi-pocket/`. Research only; no application execution.

## Files Retrieved

- `src/server/commands.ts:145–198` — ownerless conversation creation and catalogue transaction.
- `src/server/app.ts:285–444` — Harness setup, default documents, recovery, commit coordination.
- `src/server/docs.ts:18–56,111–125` — session metadata, authors, subagents and fork policies.
- `src/server/attribution.ts:28–112,140–215` — author insertion, recovery and submission attribution.
- `src/server/spend.ts:46–160` — usage baselines, payer selection and accounting.
- `src/server/projection.ts:244–362`; `src/server/transcripts.ts:29–181`; `src/server/room.ts:179–230` — history, images, live views and defaults.
- `src/server/reload.ts:29–74,169–220,233–251,318–356`; `src/server/host.ts:106–131`; `src/server/extensions/prompt.ts:9–85` — extension ABI and selection.

## Key Code

**Reuse creation, not message submission.** `Commands.createSession` calls `harness.createConversation({ ownership: { kind: "ownerless" }, agent: { cwd, model, thinkingLevel }, init })`. Its `init` writes `SessionsDoc.items[id]` with cwd, timestamps, creator and optional title/worktree (`commands.ts:145–198`). Adapt this transaction for imported metadata and the parent-validated historical-entry API; submitting old user messages as new work is not an import.

`conversationCreated` creates `AuthorsDoc`, `ArtifactsDoc`, `SubagentsDoc` (`app.ts:303–307`). Keep that hook. Other UI documents have empty/off fallbacks (`room.ts:179–230`); do not invent schedules, goals, tool tasks or subagents from textual history. Stored document kinds and history/fork policies are contracts (`docs.ts:1–6,43–56,111–125`).

**Authorship needs explicit mapping.** `AuthorsDoc.entries` maps Durable entry IDs to Pocket user IDs; `requesters` means work requested for someone, not written by them (`docs.ts:41–56`). Preserve a source-to-Durable ID map and decide imported-user identity explicitly. `Attribution.recover` seeds its newest-author cache from the document, then repairs missing authors by scanning submission request IDs (`attribution.ts:66–112,140–171`). A raw historical append cannot be assumed to create those submissions. Furthermore, live author-cache updates follow submissions, not AuthorsDoc edits (`app.ts:429–439`; `attribution.ts:175–215`): import needs explicit cache initialization or controlled recovery before continuation.

**Usage is a real side-effect hazard.** Every published UsageDoc change is accounted before submissions (`app.ts:415–439`). Positive deltas become personal spend; payer falls back from requester to session creator to owner (`spend.ts:95–124`). Startup also charges uncounted usage unless creating the first SpendDoc baseline (`spend.ts:49–81`). If historical appends update UsageDoc, they can create phantom spend and trigger limits (`spend.ts:127–160`). Whether append does so is for the parent's Durable probe; Pocket alone does not settle it. Import must establish a deliberate historical-usage baseline/exclusion, both live and after restart—not merely suppress one listener.

## Architecture

One Harness/SQLite runtime feeds Pocket rooms and history. `Room.open` subscribes to `conversation.viewState`; transcript readers paginate Durable entries, reverse to chronological order and enforce fork ancestry (`room.ts:179–181`; `transcripts.ts:68–156`). `projectEntry` expects native `pi.user`, `pi.assistant`, `pi.tool-result`, compaction/reset kinds and reads only `entry.model[0]`; system entries disappear and unknown kinds become generic cards (`projection.ts:244–362`). Convert messages individually; explicitly handle ordinary-Pi compaction/custom records rather than silently claiming equivalent rendering/context.

Keeping Pocket/Durable intact retains live committed views, history/image/export access, durable recovery, collaboration defaults, and built-in artifacts, browser, subagents, schedules, goals, plan and codemode modules. Recovery and spend load precede subscription and final `harness.resume()` (`app.ts:314–410`); imported historical tool calls must not become resumable work.

Ordinary Pi extensions are **not drop-in**: Pocket invokes `default(host: PocketHost)` and installs returned Durable `Extension` objects (`host.ts:106–131`; `reload.ts:318–356`). Built-ins load in fixed order; prompt is mandatory, guard defaults off, all drop-ins default off, reserved tools/names are protected (`reload.ts:29–74,169–220`). Reusing coding-agent skill/context helpers is resource compatibility, not extension ABI compatibility (`extensions/prompt.ts:9–15,64–85`).

## Start Here

Open `src/server/commands.ts:145–198`. Required integration: authorized import entry point; stopped-session validation and source-ID/provenance mapping; transactional catalogue/default-document creation; explicit author-cache initialization; usage baseline policy; native history projection and restart tests. Keep the single Durable runtime. Package-level append/compaction feasibility remains with the parent; no Collie claims were investigated.

```acceptance-report
{
  "criteriaSatisfied": [{"id":"criterion-1","status":"satisfied","evidence":"Cited creation, attribution, usage, history and extension boundaries with required integration changes."}],
  "changedFiles":["docs/research/durable-pocket-integration.md"],
  "testsAddedOrUpdated":[],
  "commandsRun":[{"command":"git -C /Users/enkelm/Projects/oss/pi-pocket rev-parse HEAD","result":"passed","summary":"Verified requested revision."}],
  "validationOutput":["Read-only source inspection; no apps or tests run."],
  "residualRisks":["Durable append usage/recovery semantics and ordinary-Pi compaction conversion require parent validation."],
  "diffSummary":"Research artifact only.",
  "reviewFindings":[],
  "manualNotes":"Reference repository unchanged; no personal state or sockets accessed."
}
```
