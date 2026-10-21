# Pip orchestration and file-first handoffs

Date: 2026-10-20. Status: staged implementation in the working tree; remaining proposal/history is not a checklist or authorization.
Research baseline: `add93ee6c9ccb8b321b928f0375cceecf646cee6`.
This revision supersedes the earlier workflow-gated/preview-based proposal.

## Human correction: keep the implementation simple

The human explicitly rejected the added context-file subsystem. That implementation was removed.
That handoff correction writes a real `handoff.md` in a private temporary directory and sends the
next agent a prompt to read it using the existing `read` tool. For SSH work, that directory is on
the SSH target. No separate file UI/API, file database, preparation model or delivery framework
was retained. Those remain rejected, not outstanding implementation tasks.

The next approved private PiP increment added work-context reads and review reply/resolve/reopen,
reusing WorkItems, Reviews and existing exact-thread controls. The human then explicitly approved
**the actual orchestrator**. That increment now adds an opt-in owner/token/epoch grant, a separate
owner-only per-work conversation, coalesced durable work-event wakes, native Commands and handoff
adapters, correlated questions/answers, canonical action receipts, cumulative work spending,
optional cost caps and pause/reclaim. The owner takeover/management sheet uses native conversation
rendering; grouped Work Item navigation opens PiP while execution children retain exact links.
Busy takeover observes without resending. Source-agent handoffs cannot compete with a running
grant. Human execution input and Stop fence old decisions; pending questions fence mutations.
Publication still requires individual human approval. Finish saves a report and pauses; it is not
correctness certification. State and interrupted accepted actions recover in isolated restart tests.
No live installation was restarted or activated.

### Focused human feedback

New delegation defaults to no additional Work Item cost or action cap. The owner may add a positive
additional spend allowance; existing explicit cost/action grant caps survive resume and omitted
updates. Spending-limit changes pause PiP, and removing a legacy cap requires an explicit owner
action. Cumulative actual spending is shown whether capped or uncapped. Account/session budgets,
security restrictions and individual publication approvals stay independent.

The owner row shows PiP running/paused and an accessible quick orchestration action. Expanded and
folded sidebars, Home, launcher and keyboard navigation share the same grouped destination and
selection identity; execution children and mutation IDs remain exact. The management sheet works
from the row without switching the open conversation. The original scrawl capture was unavailable
at the handoff path, so exact indicated copy/affordance could not be verified against its frames.
The takeover explanation was shortened and the action-cap form control removed.

PiP's default is review before landing: inspect the actual independent Reviewer outcome and open
findings, direct bounded repairs/re-review when needed, and do not mistake idle, resolved discussion
or a finish report for approval to stage/commit. This is orchestration guidance, not a new handoff
admission or rigid preparation framework; explicit human direction and mutation limits still govern.

Execution threads report meaningful progress, evidence, blockers, questions and handoff needs and
then yield; native committed outcomes notify PiP automatically. Routine tool rounds must not buy
new controller responses. `work_supervise wait` ends its turn without another provider acknowledgement.
Alignment checks belong at meaningful outcomes/checkpoints, not a frequent timer. Existing durable
wake receipts, restart recovery and authority fences remain the mechanism.

Generic mid-conversation file relay, destination reselection/retry UI and removal of the legacy
human-requested execution-agent handoff tool are **not implemented here**. The latter still backs
the existing human UI; it does not grant autonomous controller authority to execution agents.
The broader research below is retained as proposal/history, not current behavior or permission to
expand this change. In particular its file registry/preparation machinery does not describe the
implementation.

## Direction from the human

- **Let Pip take over** makes the Work Item open a persistent Pip conversation with questions,
  decisions and inspectable action calls. Execution threads remain accessible underneath it.
- Extend **private Pip's configuration/controller**, not the bounded mention-answering lane.
  Add work-aware reads, orchestration and review discussion management, including resolve/reopen.
- Only Pip while orchestrating authorized work gets agent handoff controls; ordinary execution
  threads/helpers do not. Humans retain UI handoff controls.
- Handoff is a context packaging/delivery primitive, **not a workflow admission gate**.
- Produce a targeted compaction as a file. The file is the information: **no content preview,
  duplicate inline summary or separate competing source of truth**.
- Neither human steering nor generated compaction has a handoff-specific editorial character cap.
  A system prompt asks for concise, relevant material; it does not reject a longer useful file.
- Track whether the file exists, the destination was created/addressed, the read-file message
  arrived, and the receiving agent started. Success does not require the target to finish its task.
- Failed/unknown status or a failed attempt does not invalidate the file or poison future handoffs.
  Reuse the file, retry delivery/creation, choose a new type, or make a new attempt the current base.
- Support sending a targeted compaction into **existing threads or existing Work Items mid-conversation**,
  as well as starting new threads/Work Items.

These directions do not authorize activation in this research conversation. Current runtime rules
still apply until an implementation explicitly replaces the relevant handoff contract.

## Reference: Matt Pocock's handoff skill

Primary source, read 2026-10-20:
https://github.com/mattpocock/skills/blob/main/skills/productivity/handoff/SKILL.md

The actual skill asks an agent to:

- Summarize the conversation for another agent in a file in the OS temporary directory, not the workspace.
- Tailor the document to the focus provided by the human.
- Include suggested skills for the recipient.
- Reference existing specs/plans/ADRs/issues/commits/diffs rather than duplicate them.
- Redact secrets and sensitive information.

It specifies no handoff character limit or preview. It does **not** implement recipient creation,
delivery receipts, automatic retry, managed writer transfer or cross-thread authorization. Those
are Coop responsibilities, not behaviors to attribute to the skill.

For durable Coop delivery, use app-managed storage outside the checkout rather than a disposable
OS-temp path that can vanish. Preserve the skill's file-first, targeted, composable behavior.

## The key separation

### 1. Compaction file

A saved, targeted context document. Creation does not retire a thread, move a Work Item, reset the
source model context, or transfer write ownership. This is a compact export, not destructive `/compact`.

The human supplies unconstrained steering such as:

> Extract the retry-design decisions and unanswered compatibility questions for the API Work Item.

The document carries the relevant ask, human direction, decisions, useful evidence/references,
open questions, next focus and suggested skills. Source observations should remain distinguishable
from human instructions. Prompt concision and reference existing material; do not impose a new
fixed template size or repeat the document in metadata.

Store stable file identity, source/reference metadata and content integrity metadata. These are
not a prose preview. A file may be reused for many deliveries; editing/regenerating produces another
version/file without mutating the bytes a recipient already received.

### 2. Delivery attempt

One attempt to deliver an existing compaction file to a concrete destination. This is separate
from compaction generation and from the destination's later success/failure at its work.

Possible destinations:

| Destination             | Behavior                                                                                                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New continuation thread | Create the requested thread type, send the read-file instruction and observe start; apply Work Item writer selection separately where applicable                       |
| New Work Item           | Create a new item/thread and deliver the same kind of file reference                                                                                                   |
| Existing thread         | Submit an attributed read-file/context message into that conversation; preserve its history/type/membership                                                            |
| Existing Work Item      | Resolve its active execution thread at dispatch and record that exact target; Pip observes lifecycle events rather than automatically receiving/reading the file first |

For a Work Item selector, resolve only until acceptance is pinned. Replay of an accepted attempt
must use that exact recipient rather than silently delivering again to a later active thread.
Coordinate active-thread selection and acceptance so a retirement race cannot misroute the input.

Existing-thread delivery queues behind current work by default. Explicit steering can request
injection during a run; it is a human/Pip choice, not an automatic interrupt. A notification does
not retire the source, create a work relationship, enroll either side in the other's Work Item,
change the destination role or replace its current task.

### 3. Observation

Record distinct facts as they become available:

```text
File ready
Target created / existing target selected
Message accepted / queued
Message placed; recipient run started
File read (when actually observed)
```

Do not claim the file was read merely because the read-file instruction was delivered. Conversely,
do not wait for an entire successful model answer before saying work started. A provider failure
later is a work outcome, not retroactive loss of the file or thread-creation receipt.

A status lookup may report **unknown/unavailable**. That is an observation failure, not a new
handoff prohibition. Status does not issue a readiness token and is not required to authorize
another explicit attempt.

## Recovery without trapped workflows

- Compaction succeeds, spawn fails: keep the file and retry creation without compacting again.
- Target exists, submission fails: resend to that target; do not create another thread by accident.
- Message is queued: show queued; permit explicit steer, another target, or a new attempt.
- Target model/type is unsuitable or fails: choose another requested type for a fresh target and
  reuse the file. Do not rewrite the historical type of an agent that has already worked.
- Status lookup fails: preserve known receipts, report uncertainty and allow explicit recovery,
  a new attempt or a new compaction. No global blocked flag inherited by later attempts.
- New human instruction chooses a different destination/type: create a new attempt, not “this
  human input already started a different handoff.”
- A human/Pip may select a new attempt/file as the current continuation base. Previous attempts
  remain history, not permanent workflow gates.

Idempotency is **per attempt/action**, not a permanent lock on a source conversation or original
human input. Retrying the same creation identity recovers the same target. Explicit **Start new**
uses a fresh identity and may create another target even if an earlier status probe failed.
A changed destination/type is a new attempt using the same file, not silent reinterpretation of
an old receipt. Do not blindly duplicate an uncertain side effect under the label retry.

## What is deliberately outside the handoff abstraction

Handoff does not decide whether code is correct, tests passed, review is complete, a milestone is
satisfied, a role is the recommended next stage, or all earlier deliveries succeeded. The current
role-history graph, current-diff condition and historical-request blockers should not govern this
general context-delivery primitive. Role choice and orchestration decisions belong to the human/Pip.

Sending context to an existing conversation does not need source/whole-item quiescence. Packaging
an observed source snapshot does not require stopping its work either; record its source point so
later changes are not misrepresented as included.

Access, explicit delegation, destination execution permissions, spending and checkout writer
coordination remain the responsibility of their existing modules. They are not evidence/readiness
gates owned by a handoff status check. In particular:

- Context export must be authorized for the destination audience; access to private source data
  is not automatic permission to disclose private/global Pip history into a shared target.
- A Work Item's active-writer selection is separate from context notification. A new continuation
  can become the selected base without restoring a permanently retired writer or granting two
  execution threads concurrent checkout write authority.
- Superseding a thread/attempt must not claim already-dispatched commands were cancelled. Expose
  running effects honestly; handle their execution through the writer module, not a poisoned
  handoff receipt.
- Publication approvals/uncertain external effects retain their independent contracts. An unknown
  handoff status is not an uncertain push/PR receipt, and neither should be confused with the other.

This separates real permissions/effects from the workflow policy the human wants removed; it does
not retain every existing handoff gate under a different name.

## File delivery mechanics

Persist the file before presenting **File ready**. A reference handed to the recipient resolves
through a narrow authorized file reader, including on SSH threads. It must not depend on a mutable
checkout file, a matching host-local pathname or the fork-only lineage of ordinary uploads.

The target receives only a short instruction such as:

> Read handoff file <reference> and use it as context for the current task.

The compaction file already contains the information and steering; do not attach a second summary
or preview. Large files are readable in sections. Do not inject the complete file into every
recurring workflow prompt. Integrity/storage/request/read constraints are infrastructure concerns,
not a new handoff-specific limit on the amount of human steering or compaction.

Keep old inline records/task identities readable for compatibility. Existing `pocket.handoffs`
records need not be rewritten to pretend they were generated under the new model.

## Private Pip and the UI

Private Pip gains a work-aware coordination interface over file preparation, delivery and passive
status. Expose it only for authorized orchestration. Execution agents can produce reports/context,
but cannot invoke handoff control themselves. Shared mention jobs remain read-only.

Reuse current guarded Commands submission for queued/steering delivery and app-owned thread
creation where possible. Do not reuse Agent Teams' linked-family membership, unmanaged-only
restriction or relay limits for arbitrary Work Item context delivery.

The current human picker submits `/handoff` to the source model and depends on its transfer tool.
Replace that dependency with a durable human request interface, shared with Pip at the core seam.
An auxiliary compaction task can store its response as the file without granting transfer tools
to the source. The existing recovery-only source-summary task is not a public new admission path.

Suggested UI controls:

- **Create handoff** with a human steering box, no handoff-specific maxlength.
- Destination: **New thread / New Work Item / Existing thread or Work Item**.
- File row: open the actual Markdown file, reuse or regenerate. No prose preview card.
- Per-attempt creation/message/start observations with exact failure/unknown reasons.
- **Retry creation**, **Retry delivery**, **Choose another type/destination**, **Start new attempt**,
  or **Use as current base**, according to known state. Prior failure does not disable the whole flow.
- Orchestration chat shows these operations as compact expandable tool cards, questions and
  decisions. Work Item title opens Pip while orchestrated; children open exact execution threads.

Review resolve/reopen uses existing Reviews permission/atomic-batch/retry behavior with truthful
Pip/on-behalf-of provenance. Resolution is discussion management, not evidence of code correctness.
Configuration reuse does not yet decide whether per-item Pip chats share global private history
or who can read those chats; do not silently change their audience.

## Current implementation evidence and useful changes

- Current inline summary/steering caps, source-main-run handoff authority, stage checks, blocked
  courier and misleading delivered-state findings are documented/reproduced in
  [the failure investigation](../research/handoff-failures-and-file-briefs.md).
- [Private Pip](../../src/server/pip/private-agent.ts) already lists/reads/sends/follows sessions;
  [Pip.send](../../src/server/pip.ts#L1181) uses Commands with service provenance and stable request identity.
- [Commands.submit](../../src/server/commands.ts#L876) supports queued vs steering delivery, but its
  legacy `isPreparing` restriction must not become a blanket cross-thread compaction lock.
- [LinkedSessions](../../src/server/linked-sessions.ts#L105) rejects managed workflows and binds
  peers to a team. Its whole abstraction is not the requested general relay.
- [Current courier](../../src/server/handoffs.ts#L580) waits for the destination answer and conflates
  some unanswered results with delivery. Replace that interpretation with placement/start observations.
- [Current workflow section](../../src/server/work-items.ts#L219) repeats the complete inbound brief;
  new file-backed delivery must remove that duplication rather than only change the first message.

Acceptance cases: generate once/reuse after failed creation; retry an existing target; choose another
role after failure; status unavailable but new attempt permitted; direct thread-to-thread relay;
Work Item A to B while both are active; correct target binding when B changes active thread;
no history reset/membership transfer for notification; no implicit interrupt; truthful start/read
observations; authorization for shared file export; local/SSH file availability; restart/idempotency;
private Pip-only control; human UI independent of execution-thread tool selection.

## Pip observes handoffs; it is not a content proxy

The human clarified that Pip should know a handoff was created, but need not receive or reread its
contents: it already follows the relevant source conversation. Deliver to the actual destination;
Pip receives file-created/delivery/start/failure events and source/destination references. Reading
the file remains available on demand when genuinely needed, not a required orchestration step.
Accepted-attempt replay still pins the actual recipient.

## What private Pip still needs

Extend the existing private configuration/controller rather than pooling its history into the shared
mention lane. The required addition is a durable work-aware control loop, not unrestricted tools.

| Capability                | Current private Pip                                | Addition for orchestration                                                                                                  |
| ------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Read and message sessions | Present, with recent bounded reads and attribution | Work Item identity, full visible member history, active writer and source-bound reads                                       |
| Inspect work              | Ordinary file read; limited transcript summaries   | Current pinned local/SSH code, Changes/diffs, discussions, detailed addressable call/results and evidence                   |
| Follow work               | Fixed session/submission until answer/idle         | Work Item-level events across active-thread changes, significant outcomes/questions/errors and live run/helper/queue state  |
| Direct work               | Send/steer, start/stop/archive exist               | Work-scoped task routing, explicit permitted role creation/base selection and the new file/delivery operations              |
| Manage discussions        | No private review-management tool                  | Reply/resolve/reopen authorized same-item discussions with Pip provenance                                                   |
| Ask the human             | Ordinary private conversation                      | Durable pending questions, recipient/notification/deep link, answer-to-decision correlation and continuation                |
| Remember orchestration    | Global private conversational context/follows      | Per-item goal/scope, decisions, human limits, current task, pending actions/questions, event cursor and last acted-on state |
| Bound activity            | Per-person/session controls and action/follow caps | Cumulative Work Item spend/action accounting and explicit pause/reclaim state                                               |
| Explain actions           | Private panel summarizes activity                  | Persistent per-item conversation with expandable exact-action/result/receipt links                                          |

A working loop:

1. On takeover, establish the Work Item goal, scope and granted actions from the human/current work.
2. Read the actual current thread and relevant discussion/evidence; identify what is underway or missing.
3. Send a concrete next task to the appropriate execution thread, or choose a new thread when useful.
4. Wait on meaningful durable events instead of running the model on every token or timer.
5. Read the changed/relevant evidence on an event. Distinguish completed work, a conversational pause,
   a blocked operation, a question and an unavailable observation; do not infer success from idle alone.
6. Continue in scope, ask the human about a material ambiguity/change, or report completion/limits.
7. Persist the action/decision and cursor so restarts do not repeat it. A handoff event does not require
   rereading the already-known source as a generated file.

The human/Pip conversation sets goals and decisions; execution threads implement/investigate/review.
Private Pip need not gain general shell or code-edit authority to supervise them. It still cannot
approve external publication on the human's behalf. Global private history and credentials do not
become shared Work Item context merely because the configuration is reused.

For takeover of an already-busy item, first observe and attach to the running work; do not resend
its original task or silently interrupt it. Direct human steering/decisions must invalidate stale
queued Pip actions. Pause/reclaim prevents new orchestration actions without claiming dispatched
execution was cancelled. The per-item question/action history remains available after reclaim.

Existing capability evidence is in
[the private/shared capability audit](../research/pip-orchestrator-capabilities.md).
This section is a proposed application of that evidence, not implemented behavior.

## Architectural seam: deepen WorkItems, keep Pip a caller

**Yes: a deep application-owned work-control module, with thin Pip tool and human UI adapters,
is the right seam.** A core `app.workItems` already exists. This is not a proposal to repeat core
promotion or replace it with another forwarding class.

Current local evidence:

- [WorkItems](../../src/server/work-items.ts#L73) owns cached membership/workflow state, profiles,
  organization, writer projection and browser presentation, but its control entry still forwards
  `invoke` with the private Handoffs engine's tool-invocation interface (`ToolExecutionApi`).
- [Handoff registration](../../src/server/app.ts#L550) is selected with ordinary `pocket-core` tools;
  private Pip uses a separate [registration](../../src/server/pip.ts#L242). This exposure is opposite
  to the human's intended new handoff-control placement.
- [Common work reads](../../src/server/work-items/context.ts) are already implemented with scoped
  transcripts/Workspace/Reviews/WorkItems dependencies, but the adapter is owned by Pip and bound
  to a mention source. Reuse/deepen that implementation rather than writing duplicate readers.
- Human request services currently offer only [status/group updates](../../types/pocket.d.ts#L395),
  not the new orchestration control interface. The public host handoff facade still exposes an
  invocation-bound interface [here](../../types/pocket.d.ts#L109).
- The older `work-items-core-module.md` note predates this core promotion; its extension migration
  descriptions are historical, not the current architecture baseline.

### Responsibility split

| Owner              | Responsibility                                                                                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WorkItems          | Canonical item identity/membership/active execution thread/control delegation; scoped context and commands; work-level lifecycle observations                        |
| Context handoffs   | Targeted compaction files and independent delivery attempts across any permitted threads/items; not constrained to Work Item membership                              |
| Pip                | Model reasoning and durable supervision: goals/limits, plans, event cursor, questions/decision references, next action, pause/resume and action reconciliation       |
| Existing modules   | Commands owns input acceptance/queues, Workspace owns code/file namespaces, Reviews owns discussions, Spend owns accounting; no parallel copies inside Pip/WorkItems |
| Tools/HTTP/browser | Small adapters of the same application interface, not independent workflow implementations                                                                           |

WorkItems should provide an actor/item-bound control interface. Conceptual operations are:

- Read work, selected thread history/runtime/code/discussion evidence.
- Send a concrete instruction to an exact/current execution thread.
- Create/select an execution thread with the requested role/context.
- Manage authorized discussions via Reviews.
- Observe work events from a durable position.

Context preparation/delivery stays reusable outside an item, so it is a peer/dependency rather
than forcing every cross-thread message through a Work Item. Pip questions and the supervision
loop remain in Pip; WorkItems does not decide the plan by calling a model itself.

The interface must hide lookup/routing, root creation, metadata updates, destination pinning,
authorization, effect receipts and reconciliation. A caller should not supply a forged source
`ToolExecutionApi`, edit documents, manually send an initial brief and then repair membership.
The existing atomic mechanisms can be reused internally after the obsolete workflow eligibility
policy is separated from them. Do not reintroduce removed handoff readiness gates in the facade.

### Durable supervision, not another job framework

Use existing Durable tasks, documents, submission state and commit/watch machinery. Add per-item
supervisor state and correlated wakeups; do not build a second scheduler or make model calls in
commit listeners. The controller lives outside execution `threadIds`/descendant work so its passive
waiting does not masquerade as an active code writer.

Work-level events must follow active-thread changes and identify the actual source/submission/run.
Persist enough position/receipt state to recover actions after restart. Use exact submission
placement/start observations for handoff start, not private Pip's answer-completion follow alone.
Keep “known action result,” “unknown observation” and “failed work” separate.

### Tool exposure and the UI are adapters

Register work-control/handoff adapters only in private Pip's selected configuration, with a live
orchestration grant checked by the module. The model does not receive the WorkItems object or
unrestricted server capabilities. Ordinary execution agents keep code/research execution and a
handoff-file reader, not orchestration controls. Shared mentions get a read-only work-context
adapter. Humans get authenticated UI endpoints into the same commands, not a source-model detour.

The browser needs a stable mapping from Work Item to its Pip conversation, distinct from the
active execution-thread ID, and access-filtered work/controller/question/action projections.
Reuse native conversation/tool-card rendering where practical. Configuration reuse means reuse
of private Pip's model/tool construction; it need not merge unrelated per-item/global chat history.

The useful implementation unit is therefore **a deeper work-control interface + reusable context
delivery + a durable Pip supervisor + thin adapters**, not one enormous WorkItems module or a
longer prompt granting every tool to Pip. Validation should cross the common interface with
human/Pip callers, scope revocation, direct context relay, retries/restarts, active-thread routing,
comment provenance, model failure and no-control-tool exposure in execution threads.

## Research limits

This revision uses public primary documentation and local source inspection. It adds no implementation
or tests and runs no new app/runtime checks. The earlier investigation ran six isolated faux-model
probe scenarios and the existing handoff-execution suite (13 passed, 0 failed); those establish current
behavior, not validation of this redesigned contract. Production incident frequency remains unknown.
