# Handoffs and Work Items

A handoff starts a fresh thread with a compact brief and transfers responsibility for the work. It does not reset, fork or compact the source conversation. Earlier conversations remain available for reading and discussion, but they cannot regain write access.

## The flow

```text
Worker → Reviewer → Land → Publish (optional)
            ↓
         Follow-up → Land

Pull: human-selected upstream reads/integration at any point
```

Reviewer performs a bounded review and concrete fixes, not an indefinite review/worker loop. Small remaining gaps go to Follow-up for a repair and one short self-review of its delta; significant implementation goes to a fresh Worker. If a browser, environment or check is unavailable, the agent abandons it and reports the verification gap. It may retry once for a clearly transient failure, but never bypass policy or recommend successors just to repeat the same blocked check. Required unresolved checks still prevent claiming readiness.

Pull reads upstream/GitHub data and handles requested local rebases. Humans can start it independently from New Session or select it in the handoff chooser at any stage. It does not inherit review/landing readiness or authorize external publication.

Land handles local work: rebases, conflict resolutions, commits, commit-hook fixes and safe worktree cleanup. It performs a bounded impact review of changes introduced during landing, runs appropriate checks and recommends a follow-up review, more implementation or Publish. A successful local landing does not claim that the code has been published.

Publish handles pushes, PRs, ticket updates and push-hook fixes. Every external mutation requires separate human approval. Starting a Publish thread is not blanket permission to perform its actions. MCP is not required; the first implementation uses repository CLI tools.

## Stage agents

Each thread type receives its own system-level working playbook, selected before every model request. These are separate agent responsibilities, not one end-to-end checklist repeated in every thread:

| Type      | Working loop and stopping point                                                                                                                                                                                                                                                                                                        |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat      | Clarify, explore or perform the bounded requested task; stop when the answer or next decision is clear.                                                                                                                                                                                                                                |
| Worker    | Implement in small increments, write focused tests and iterate on relevant checks. Hand off reviewable work with evidence and deferred checks; leave independent review and wider regression assessment to Reviewer.                                                                                                                   |
| Reviewer  | Independently inspect code and test quality in the wider application; run impact-driven regression checks, fix concrete findings and retest. After at most two review/fix passes, record passed review or unresolved work; recommend Land, Follow-up for small repairs, or Worker for substantial implementation only when actionable. |
| Follow-up | Repair specific review findings, run focused checks and self-review only the repair and immediate integration points once. Reuse current review evidence for untouched work; request independent review only if scope/risk expanded materially.                                                                                        |
| Pull      | Read supported external sources/fetch upstream, perform requested local rebases, check the integration delta and report sources/conflicts/risks. Stop on unavailable sources rather than repeating failures.                                                                                                                           |
| Land      | Integrate locally, resolve conflicts and hook failures, then check the impact of integration changes. Record local landing/readiness, or recommend further review/implementation.                                                                                                                                                      |
| Publish   | Verify the landed checkpoint, obtain approval for each supported external mutation, inspect receipts and report actual delivery. Reconcile uncertain effects before continuing.                                                                                                                                                        |

The bundled playbooks live in `src/server/thread-prompts.ts`. Settings → **Agents** lets the owner edit each type's role instructions app-wide; overrides persist in `config.json` and apply on the next model request, including to existing threads and delegated helpers. Restore default followed by Save removes the override. These edits do not change thread types, shared scope guidance or runtime authorization/readiness gates. Private Herdr agents are not configured here. Each thread is a separate durable conversation/agent with its own context and agent configuration; the non-toggleable core supplies that agent's `thread_role` system-prompt amendment separately from dynamic `workflow` state and copied briefs. Handoffs reuse cwd/model/thinking choices, not the predecessor's custom session instructions. Those instructions remain with their source agent; set any destination-specific instructions on the new thread. Work-wide requirements belong in shared global/project context or the original specification. A delegated helper inherits its parent thread's role and reports its assigned task; it does not take over main-thread completion. Retired threads keep their historical role, but current read-only workflow state overrides its working loop.

Shared safety, coding/style guidance, explicit human limits and repository instructions still apply. Validation defaults adapt to risk: Workers can run broader checks when necessary or required, and Land reuses still-current review evidence rather than repeating independent review by default. Explicit plan mode and `/until` check goals remain unchanged. These prompts guide agents; they do not implement a runtime pass counter or independently certify test adequacy. Completion, write ownership, fingerprints and publication approvals remain enforced by the runtime.

## Starting a handoff

The thread header and `/handoff` use the same operation:

```text
/handoff
/handoff reviewer
/handoff land
/handoff publish
/handoff follow-up
/handoff pull
/handoff chat
/handoff worker --same
/handoff worker --new
```

Without a destination, the command opens the handoff picker. A human-issued command is a manual activation, not a request for the model to invent thread-management steps. The header always opens a chooser showing all successor roles, recommendations with their reasons, and unavailable choices with their blocking reasons. Recommendations never restrict the human's selection. Every chosen role receives the complete prepared brief, even when it differs from the recommendation. Additional fresh history is bounded separately so long briefs keep their final check results and risks. Explicit native commands select a destination directly and report unmet prerequisites. Review cannot start from an untouched thread: a completed assistant report is the minimum input, not proof of implementation quality. Land and Publish retain code-bound readiness gates.

The agent writes its brief, completion summary and recommendation, then explains the next step in the conversation. Humans choose whether to activate it; there are no human brief, summary or outcome forms. A Reviewer or Follow-up records code-bound review completion internally before Land becomes available. Choosing Land continues a passed review; choosing a fresh Worker means more implementation is needed. Publish requires a local landing and readiness to publish. Changes after a recorded checkpoint invalidate those prerequisites.

The runtime `handoff` tool prepares a brief, records stage outcomes and recommends successors. Autonomous activation and cross-thread prompting belong to a future orchestrator, not this release. The backend keeps authorization separate from the UI entry point so that future authorized agent operations can use the same transitions. Manual activation can use the backend's bounded persisted-history brief when no prepared brief exists.

Preparation and completion wait for all delegated helpers and background work; only the invoking main-thread tool/run is exempt so the agent can record its final report. Pending helper reports are work too: the main agent ends its current turn so queued reports can be delivered, then resumes on arrival instead of polling or repeatedly attempting completion. A readiness-recording failure is not a reason to create another Reviewer. The source and other writers must all be idle before responsibility moves. The chooser uses the same task-graph idle check as activation, not merely the main thread's visible busy flag. An activation never kills an active tool or silently interrupts a run. Invalid or cancelled requests create no thread. This checks Durable's registered runs, tools, descendant agents and background tasks; external terminals or detached daemons are not ownership leases. Stop externally managed writers before activating a handoff.

## Work Items

The first same-work handoff wraps the source thread and its successor in a Work Item. The sidebar replaces the single row with an expandable item bearing the first thread's title. Its children are the individual conversations; its leading icon and status follow the thread currently responsible for the work. An expand/collapse chevron sits below that icon in the disclosure button. Paths and model metadata stay on one truncated line. Leading stage icons replace duplicate sidebar role badges. Workflow status and predecessor/active-thread links are compact icons inside the chatbox, not a separate bar above the transcript.

Further same-work handoffs join that item. There are no nested Work Items. A new-work handoff starts a separate item linked to the preceding work. Once work lands, substantial subsequent implementation normally starts a new item; Publish can still follow within the landed item.

An item can stand alone, belong to a project or belong to one of its goals. Move, archive and restore apply to the whole item. Member conversations cannot be archived independently, even through a direct metadata request. Goal archive and restore retain their existing atomic behavior.

Placement and grouping never grant access. Hidden threads and their full histories remain hidden. The compact handoff brief is copied content belonging to the destination conversation; sharing that destination also shares its brief. A session-scoped invitation is not authority to create unrelated conversations or publish code.

## Durable state

Handoff records identify the source, destination type, relationship, source checkpoint, brief, requester and destination conversation. Work Items record their origin, membership, placement and active thread. Thread workflow state records permanent read-only status, milestones and recommendations.

Destination creation, source write withdrawal, relationship records and membership publish in one commit. Initial prompt delivery has a durable task and request identity. Retrying the same request after a disconnect or restart finds the same destination instead of creating or prompting twice.

The brief includes the original request and references, implementation decisions, check results, risks and the relevant code checkpoint. It is orientation, not evidence of correctness: the successor still inspects the actual code and diff.

These are additive Pi Durable documents. Existing document kinds, versions, scope and fork contracts remain unchanged. Workflow kinds have their own explicit fork behavior and do not turn handoff conversations into task-owned subagents.

## Execution and approvals

Write authority belongs to the current thread, not every thread in an item. Predecessors remain read-only when prompted again, after restart, or through nested tool calls. Verified read-only local inspection remains available; write authority never returns. The execution gate covers filesystem operations, shell commands and descendant agents, not only the `write` and `edit` tools.

Managed shell execution and Git subprocesses—including worktree creation, cloning, cleanup and checkpoint inspection—currently require macOS `sandbox-exec`. Local commands run without network access, including their child hooks and interpreters. Pull has a separate constrained external-read tool; it does not enable online shell access. It supports `git fetch <configured-remote>` into remote-tracking branches (main thread only) and `gh pr/issue view/list` with an explicit `--repo owner/repository`. Online Git uses an isolated bare staging repository without checkout hooks/config/credential helpers; local-file reads and ref import remain sandboxed offline. Fetch admission checks the complete Work Item/descendant task graph under the workflow mutation lock, exempting its own main invocation/run and the exact incoming brief courier already placed into that run (which only waits for its answer). Queued/unrelated deliveries and existing helper/background work cause refusal before Git inspection or external execution; they are never aborted. Managed filesystem operations and shell children also hold writer reservations until settlement, so already-running operations exclude Pull/publication and later writers are denied while the lock is held. Import refuses symbolic destination tracking refs, including chained/dangling symbols and `origin/HEAD` when upstream advertises a branch named `HEAD`; ordinary `origin/HEAD` remains untouched. Before import, the effective staging URL is checked against checkout URL rewrites so the imported heads must come from the inspected staging repository. External terminals and detached daemons are not ownership leases and must be stopped separately. Arbitrary APIs, publication, tags/pruning and interactive authentication are unsupported. GitHub helpers inherit the read capability and do not require an idle main run. Dependency downloads, HTTP/server tests and signing through network or OS brokers may therefore fail; they are not silently retried outside the sandbox. Both fail closed on other platforms until an equivalent environment is available. Browser, artifact and unknown extension tools are blocked for managed agents. Existing artifacts and executable reply previews cannot run in managed conversations; static code previews remain available. These restrictions also prevent unapproved network mutations on a viewer’s device. Unrelated Chats retain their existing behavior.

These rules govern normal runtime execution. The app administrator and trusted server/provider extensions remain trusted code with server rights; this is not a hostile-tenant sandbox.

Local execution must not provide an unapproved route to external publication. Public actions use an exact command and content checkpoint for approval. If the command or reviewed content changes while approval is pending, fresh authorization is required.

The first publication interface accepts an explicit Git push remote/refspec and supported `gh pr` or `gh issue` commands with an explicit repository. Git sources are pinned to concrete commits. Shell wrappers, interactive payloads, implicit pushes and arbitrary CLI extensions are not publication adapters. Managed shell refuses direct Git/GitHub publication commands, including pushes to local file remotes. Trusted local programs still have the active writer’s local filesystem authority; this is not a hostile-code filesystem sandbox.

External actions are not replay-safe merely because their surrounding task is durable. An interrupted or failed push or PR update can have succeeded remotely. Its receipt preserves that uncertainty and requires human reconciliation before another mutation or handoff is attempted. Starting a fresh successor cannot erase an unresolved publication receipt.

Repository rules govern local integration and delivery details. They cannot disable the public-action approval requirement. Worktree cleanup must preserve dirty work and the resulting commits; successors must not depend on a deleted checkout.

## Scope

This release adds typed successors, Work Items, manual activation, runtime preparation and milestones, and mandatory publication approval. It does not add an autonomous project/goal orchestrator, automatic merge monitoring or an MCP host.
