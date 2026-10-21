# Handoff failures, file-backed briefs, and Pip-only control

Date: 2026-10-20. Source checkpoint: `add93ee6c9ccb8b321b928f0375cceecf646cee6`.
Research only: no application source/test edits, real workflows, real models, publication or live-data inspection.

**Design update:** the later human direction supersedes proposal sections below wherever they retain
workflow admission gates or a prose preview. The current direction is file-only information, no
handoff-specific summary/steering character limits, reusable files with independent retryable
attempts, and delivery to existing threads/Work Items as well as new ones. See the
[revised design](../design/pip-work-item-orchestration.md). The reproduced current-code findings
below remain evidence; historical implementation recommendations are not the current contract.

## Human direction

The follow-up to the initial orchestration proposal specifies:

1. Investigate frequent handoff failures, particularly the suspected character limit.
2. Prefer a Markdown file/reference to a large inline handoff. Brief length should primarily be
   prompt guidance rather than the current strict editorial limit.
3. Execution-thread agents should **not** have the handoff tool. Pip may invoke it only while
   orchestrating an authorized Work Item. Humans retain handoff control through the UI.
4. Extend **private Pip's configuration/capabilities**, not the read-only mention collaborator.
   Include comment resolution and Work Item coordination.

These are design directions, not permission to mutate the running app or start orchestration.

## What the investigation establishes

**Size limits are real and independently sufficient to reject a handoff, but there is no evidence
here that they explain the production failure rate.** No particular failed production thread/error
was supplied. Two separate delivery/recovery problems were also reproduced in isolated app instances.

A handoff has distinct stages: input acceptance, source-agent/tool admission, atomic successor
creation/writer transfer, courier placement/answer, and initiating-tab navigation. A failure in one
stage must not be described as a failure in all of them.

## Reproduced: hard length rejections

A stdin Node probe imported the repository's `test/helpers.ts`, opened temporary app data with
`scriptedModel`/faux, submitted real human `/handoff researcher ...` input through Commands, and
had the model call the actual registered tool. No handoff receipt/successor was fabricated.
The probe awaited source/courier settlement, asserted successor counts, then closed/cleaned the
isolated app. Invocation: `node --input-type=module <<'NODE' ... NODE`; full probe is in this
research conversation's tool transcript.

| Input | Result | Successors created |
| --- | --- | --- |
| Summary of 12,000 ASCII characters | Accepted | 1 |
| Summary of 12,001 ASCII characters | Tool validation error | 0 |
| Human slash-command steering of 8,000 characters, short summary | Accepted | 1 |
| Human slash-command steering of 8,001 characters, short summary | Engine/parser error | 0 |

The summary failure contained:

```text
Validation failed for tool "handoff":
  targetType: schema is false
  relationship: schema is false
  summary: schema is false
  root: must not have additional properties
  action: must be equal to constant
  summary: must not have more than 12000 characters
  root: must match a schema in anyOf
```

The unrelated-looking branch errors come from the status/start union schema. The actual invalid
field in this probe was **only the summary's length**. The installed validator also constructs its
error with the full received arguments, making an oversized rejected brief expensive/error-prone
context to repeat. [Validator](../../node_modules/@earendil-works/pi-ai/dist/utils/validation.js#L280).

The steering failure was explicit:

```text
Handoff direction must be at most 8000 characters without NULs
```

Length enforcement exists in multiple places:

- Tool schema: [work-items.ts:183–216](../../src/server/work-items.ts#L183).
- Independent engine string validator and summary call:
  [handoffs.ts:68–74](../../src/server/handoffs.ts#L68),
  [1008–1016](../../src/server/handoffs.ts#L1008).
- Slash steering parser: [handoff-input.ts:84–87](../../src/server/handoff-input.ts#L84).
- Ordinary-English original input is separately checked at 8,000 characters:
  [handoffs.ts:1053–1057](../../src/server/handoffs.ts#L1053).
- Picker reserves space for its own `Instructions:` prefix and imposes a textarea maxlength:
  [sheet.js:4–6](../../src/server/work-items/browser/sheet.js#L4),
  [334](../../src/server/work-items/browser/sheet.js#L334).

Removing only `maxLength` from the tool schema does not fix the engine check. Moving only the
summary into a file does not fix overlong human steering. The JavaScript engine length check
uses UTF-16 code units, so it is not a byte/token/visible-grapheme policy.

Current accepted tool briefs are stored/delivered unchanged, not silently cut to 12,000 in the
courier. The 3,000-character slice is a **naming preview**, not the delivered brief. Legacy
persisted-context fallback has separate slices; do not mistake it for the current tool path.
[Creation](../../src/server/handoffs.ts#L1653),
[courier](../../src/server/handoffs.ts#L641),
[naming](../../src/server/handoffs.ts#L803).

## Reproduced: unsuccessful successor marked delivered

A second isolated stdin probe used the same real Commands/tool/transfer/courier path, but returned
a faux provider error specifically for the successor's initial work input (not the naming request).
Observed/asserted state:

```json
{"probe":"PROBE_SUCCESSOR_ERROR","delivery":"delivered","submissionStatus":"unanswered","reason":"model_error"}
```

The courier waits for the destination submission but checks only the special idle-withdrawal
case; other terminal `unanswered` outcomes fall through to `delivery = "delivered"`.
[handoffs.ts:716–745](../../src/server/handoffs.ts#L716).
Durable explicitly distinguishes successful `done` from `unanswered`.
[Submission contract](../../node_modules/@earendil-works/pi-durable/dist/types.d.ts#L316).
The legacy source-summary path does check `answered.status === "done"`.
[handoffs.ts:445–450](../../src/server/handoffs.ts#L445).

This proves an observability defect: a failed successor can look like handoff success. It does not
prove the brief was never placed. Model response failure and input placement must be represented
as different facts, not conflated under one delivered label.

## Reproduced: blocked courier remains blocked after same-request retry

The probe created a handoff as a temporary guest, revoked steering immediately after atomic
creation but before the source's final turn ended, then waited for courier refusal. After restoring
steering, resubmitting the original request identity and reading receipts created no new target
tasks and left delivery blocked:

```json
{"probe":"PROBE_BLOCKED","afterSameRequestRetry":"blocked","newTargetTasks":0,"deliveryReason":"You can view this session but not steer Pi. Ask the owner for steering rights."}
```

This behavior preserves exactly-once creation, but it is **not delivery recovery**:

- Accepted-input replay returns the existing receipt: [handoffs.ts:1066–1081](../../src/server/handoffs.ts#L1066).
- Source was already permanently retired at creation: [handoffs.ts:1723–1747](../../src/server/handoffs.ts#L1723).
- Passive receipt reads do not schedule work: [work-items.ts:400–424](../../src/server/work-items.ts#L400).
- Courier catches the failure, records blocked and ends: [handoffs.ts:727–748](../../src/server/handoffs.ts#L727).
- The idle-withdrawal error nonetheless says “retry this handoff request”:
  [handoffs.ts:718–720](../../src/server/handoffs.ts#L718).
- `deliveryAttempt` is declared and read, but repository search found no increment/assignment.

A future explicit, authorized delivery retry should recover the **same** successor/content/receipt,
record a new delivery attempt and reauthorize current access/spend/pause/ownership. It must not
create a replacement successor or blindly rerun uncertain work. Automatic resume after pause is
not authorized by this research; retry semantics must be made explicit to the human/Pip.

## Other confirmed guards and static gaps

These can reject a handoff independently of brief size; they are not all bugs:

- Real current main-run human input, not a forwarded Pip message/courier/schedule/helper.
- Explicit route and relationship match; no newer conflicting human input; no different arguments
  for an already-used request.
- Current steering/driver, source ownership, unarchived item, visibility of all members.
- Allowed transition and, for Worker→Reviewer, an actual current Pi diff.
- All member/descendant runs, inbox entries, helper reports and background tasks settled.
- No conflicting writer reservation/exclusive operation or unresolved publication receipt.

Sources: [human authority](../../src/server/handoffs.ts#L946),
[pinning/retries](../../src/server/handoffs.ts#L1010),
[quiescence](../../src/server/handoffs.ts#L1208),
[source/state](../../src/server/handoffs.ts#L1447),
[transfer](../../src/server/handoffs.ts#L1619).

Creation returns before complete delivery. Courier may still be waiting for the source's full
turn, destination naming or changed authorization/spend/execution-pause state.
[handoffs.ts:595–664](../../src/server/handoffs.ts#L595).

Additional **static finding, not reproduced**: courier abort terminates its task without updating
the handoff's pending delivery record/reason, unlike source-summary abort.
[handoffs.ts:751–752](../../src/server/handoffs.ts#L751).

Navigation is a separate, intentionally initiating-tab/user/source-bound receipt flow. It can
navigate to a created-but-blocked successor. Current transfer receipt projection contains no
delivery state/reason. [store.js:715–780](../../web/store.js#L715),
[receipt projection](../../src/server/work-items.ts#L400).

## File-backed handoffs: useful, but not a raw mutable filepath

Accept the human's direction: make the authoritative brief a Markdown file, with a short preview
and stable reference in the transfer. Use prompt guidance for concise content, not a 12k editorial
rejection. Long files should be read in sections, not force-fed into every model request.

Recommended implementation properties:

1. App-owned immutable attachment bytes, hash and byte count; an opaque read reference is not
   itself permission to read it. Keep a short orientation/title preview.
2. Persist/verify the file **before** retiring the source. Bind exact reference/hash into the
   idempotent transfer receipt. Never reread a mutable source path during replay.
3. A dedicated read-only, access-checked capability for destination threads/helpers and Pip.
   Do not rely on host filesystem paths, ordinary upload ancestry or a globally readable app-data
   exception. Source/destination handoffs are independent roots, not forks.
4. Host-owned attachment reads work for local and SSH execution threads without shell/network,
   local-namesake fallback or dependence on a checkout/worktree that may be removed.
5. Keep human direction exact and separate; decide how to move long steering into the same
   attachment/reference model rather than retaining the unrelated 8k rejection unnoticed.
6. Update **both** the initial courier and recurring workflow section. Today the full inbound
   brief is injected into the system workflow section on every request as well as the initial
   input; changing only the initial input does not solve context duplication.
7. Adapt naming and status/list projection to bounded previews/references. Keep old inline records
   and stored task/document identities readable for recovery.
8. Distinguish soft editorial guidance from generous infrastructure bounds (storage/request
   admission, per-read pagination and provider context capacity). Do not silently truncate the
   authoritative brief. Exact operational caps remain a design choice, not a researched number.

Sources: [stored handoff](../../src/server/workflow-docs.ts#L81),
[repeated system injection](../../src/server/work-items.ts#L219),
[current list payload](../../src/server/work-items.ts#L497),
[protected source paths](../../src/server/workspace.ts#L754),
[upload lineage](../../src/server/workspace.ts#L1248).

A raw checkout pathname alone can change, disappear, cross a local/SSH namespace or be unreadable
by the recipient. An immutable app-managed file reference preserves the requested file workflow
without introducing those failure modes. Crash-safe file storage, orphan cleanup, retention and
backup/restore of referenced files are required.

## Pip-only control and human UI

Use private Pip's configuration/selection/controller, not the mention answer loop. Scope new
control tools to the item it is actively authorized to orchestrate. Ordinary execution agents
produce work, reports and handoff material; they cannot execute transfers, even through codemode,
helpers or an overlooked compatibility facade.

Moving the current tool unchanged is insufficient: it binds `api.conversationId`, live source run
and placed human submission. Pip's invocation is in a different conversation; its forwarded inputs
use deliberately nonhuman `p:` authorship. Introduce a typed core authorization path for authenticated
human UI intent and live Pip orchestration grants. Reuse existing transition/quiescence/writer-transfer
logic rather than spoofing human messages/tool identities.

**Human UI must change too.** The current picker merely submits `/handoff ...` to the source and
expects its model to call the tool. Removing the source tool without replacing that path breaks
human handoffs. Add a durable authenticated request/receipt service: pin human choice/instructions,
prepare/snapshot the file if needed, wait for settled execution, reauthorize and transfer atomically.
Source can supply summary content without receiving the transfer tool. The app can persist its
summary response; do not resurrect legacy recovery-only admission by accident.
[Picker](../../src/server/work-items/browser/sheet.js#L152),
[private selection](../../src/server/pip.ts#L61),
[source-bound authority](../../src/server/handoffs.ts#L947),
[public facade](../../types/pocket.d.ts#L99).

Private Pip should also gain scoped current-context reads and review discussion actions, including
resolve/reopen. Reuse `Reviews.resolve`'s whole-batch validation, owner/author permission and retry
receipts. Add visible Pip/on-behalf-of provenance rather than making an automated resolution look
human-authored. Resolution is not proof the code is fixed, review passed or the reviewer agreed.
[Reviews.resolve](../../src/server/reviews.ts#L1170).

Reusing private configuration does not settle whether each item has separate chat history or who
can read that chat. Shared `@Pip` must not silently acquire private context/owner control. Any exported
brief shared with execution-thread participants is an explicit audience boundary.

## Actual checks and remaining evidence

- Main researcher: four length-boundary scenarios through real registered handoff tool; assertions
  passed with the accepted/rejected outcomes above.
- Main researcher: successor model-error and blocked-courier/replay scenarios; assertions passed
  with the defective/blocked states above.
- Delegated researcher: `node --test test/handoff-execution.test.ts`: **13 passed, 0 failed**,
  about 10.8 seconds; existing isolated faux-model harness only.
- No application source, committed tests, live data, UI, external service or real-model checks.
- No production failed thread was supplied, so relative frequency/root cause of the human's actual
  incidents remains unestablished. Request exact error/thread/time before claiming one dominant cause.

## Focused follow-up acceptance criteria

- Remove editorial length rejection without leaving a second engine/steering check behind; retain
  meaningful file validation and paginated reads.
- Successor placement and model/run failure have separate visible outcomes, with actionable error.
- Authorized blocked-delivery recovery reuses one successor/brief/receipt and never replays uncertain
  external effects. Aborted couriers do not remain falsely pending forever.
- All handoff stages/statuses and reasons are available to the human UI and orchestrating Pip.
- Pip-only tool exposure cannot be bypassed through another execution-thread/helper facade; human
  picker/composer remains functional without that tool.
- Private Pip can resolve/reopen authorized same-item discussions with truthful service provenance;
  mention jobs remain read-only.
- Files survive restarts, worktree cleanup and local/SSH transitions; missing/corrupt/unauthorized
  attachment reads fail before a fresh transfer, without restoring a retired writer.
