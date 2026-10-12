# Handoffs and Work Items

A handoff starts a fresh thread with a compact brief and transfers responsibility for the work. It does not reset, fork or compact the source conversation. Earlier conversations remain available for reading and discussion, but they cannot regain write access.

## The flow

```text
Worker → Reviewer → Land → Publish (optional)
            ↓
      fresh Worker → Reviewer → Land
```

Reviewer owns the review loop and its fixes. Significant remaining implementation goes to a fresh Worker rather than restarting the reviewed Worker.

Land handles local work: rebases, conflict resolutions, commits, commit-hook fixes and safe worktree cleanup. It performs a bounded impact review of changes introduced during landing, runs appropriate checks and recommends a follow-up review, more implementation or Publish. A successful local landing does not claim that the code has been published.

Publish handles pushes, PRs, ticket updates and push-hook fixes. Every external mutation requires separate human approval. Starting a Publish thread is not blanket permission to perform its actions. MCP is not required; the first implementation uses repository CLI tools.

## Stage agents

Each thread type receives its own system-level working playbook, selected before every model request. These are separate agent responsibilities, not one end-to-end checklist repeated in every thread:

| Type     | Working loop and stopping point                                                                                                                                                                                                                                         |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat     | Clarify, explore or perform the bounded requested task; stop when the answer or next decision is clear.                                                                                                                                                                 |
| Worker   | Implement in small increments, write focused tests and iterate on relevant checks. Hand off reviewable work with evidence and deferred checks; leave independent review and wider regression assessment to Reviewer.                                                    |
| Reviewer | Independently inspect code and test quality in the wider application; run impact-driven regression checks, fix concrete findings and retest. After a bounded three-pass review episode, record a passed review or unresolved work and recommend Land or a fresh Worker. |
| Land     | Integrate locally, resolve conflicts and hook failures, then check the impact of integration changes. Record local landing/readiness, or recommend further review/implementation.                                                                                       |
| Publish  | Verify the landed checkpoint, obtain approval for each supported external mutation, inspect receipts and report actual delivery. Reconcile uncertain effects before continuing.                                                                                         |

The bundled playbooks live in `src/server/thread-prompts.ts`. Settings → **Agents** lets the owner edit each type's role instructions app-wide; overrides persist in `config.json` and apply on the next model request, including to existing threads and delegated helpers. Restore default followed by Save removes the override. These edits do not change thread types, shared scope guidance or runtime authorization/readiness gates. Private Herdr agents are not configured here. Each thread is a separate durable conversation/agent with its own context and agent configuration; the non-toggleable core supplies that agent's `thread_role` system-prompt amendment separately from dynamic `workflow` state and copied briefs. Handoffs reuse cwd/model/thinking choices, not the predecessor's custom session instructions. Those instructions remain with their source agent; set any destination-specific instructions on the new thread. Work-wide requirements belong in shared global/project context or the original specification. A delegated helper inherits its parent thread's role and reports its assigned task; it does not take over main-thread completion. Retired threads keep their historical role, but current read-only workflow state overrides its working loop.

Shared safety, coding/style guidance, explicit human limits and repository instructions still apply. Validation defaults adapt to risk: Workers can run broader checks when necessary or required, and Land reuses still-current review evidence rather than repeating independent review by default. Explicit plan mode and `/until` check goals remain unchanged. These prompts guide agents; they do not implement a runtime pass counter or independently certify test adequacy. Completion, write ownership, fingerprints and publication approvals remain enforced by the runtime.

## Starting a handoff

The thread header and `/handoff` use the same operation:

```text
/handoff
/handoff reviewer
/handoff land
/handoff publish
/handoff worker --same
/handoff worker --new
```

Without a destination, the command opens the handoff picker. A human-issued command is a manual activation, not a request for the model to invent thread-management steps. The header uses the next stage's icon: one available path, such as Worker → Reviewer, starts directly; branching paths open a picker containing only valid choices. Explicit native commands retain advanced transitions and report unmet prerequisites.

The agent writes its brief, completion summary and recommendation, then explains the next step in the conversation. Humans choose whether to activate it; there are no human brief, summary or outcome forms. A Reviewer records code-bound review completion internally before Land becomes available. Choosing Land continues a passed review; choosing a fresh Worker means more implementation is needed. Publish requires a local landing and readiness to publish. Changes after a recorded checkpoint invalidate those prerequisites.

The runtime `handoff` tool prepares a brief, records stage outcomes and recommends successors. Autonomous activation and cross-thread prompting belong to a future orchestrator, not this release. The backend keeps authorization separate from the UI entry point so that future authorized agent operations can use the same transitions. Manual activation can use the backend's bounded persisted-history brief when no prepared brief exists.

The source and other writers must be idle before responsibility moves. An activation never kills an active tool or silently interrupts a run. Invalid or cancelled requests create no thread. This checks Durable's registered runs, tools, descendant agents and background tasks; external terminals or detached daemons are not ownership leases. Stop externally managed writers before activating a handoff.

## Work Items

The first same-work Reviewer handoff wraps the original Worker and its successor in a Work Item. The sidebar replaces the single row with an expandable item bearing the first thread's title. Its children are the individual conversations; its leading icon and status follow the thread currently responsible for the work. An expand/collapse chevron sits below that icon in the disclosure button. Paths and model metadata stay on one truncated line. Leading stage icons replace duplicate sidebar role badges. Workflow status and predecessor/active-thread links are compact icons inside the chatbox, not a separate bar above the transcript.

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

Managed shell execution and Git subprocesses—including worktree creation, cloning, cleanup and checkpoint inspection—currently require macOS `sandbox-exec`. Local commands run without network access, including their child hooks and interpreters. Dependency downloads, HTTP/server tests and signing through network or OS brokers may therefore fail; they are not silently retried outside the sandbox. Both fail closed on other platforms until an equivalent environment is available. Browser, artifact and unknown extension tools are blocked for managed agents. Existing artifacts and executable reply previews cannot run in managed conversations; static code previews remain available. These restrictions also prevent unapproved network mutations on a viewer’s device. Unrelated Chats retain their existing behavior.

These rules govern normal runtime execution. The app administrator and trusted server/provider extensions remain trusted code with server rights; this is not a hostile-tenant sandbox.

Local execution must not provide an unapproved route to external publication. Public actions use an exact command and content checkpoint for approval. If the command or reviewed content changes while approval is pending, fresh authorization is required.

The first publication interface accepts an explicit Git push remote/refspec and supported `gh pr` or `gh issue` commands with an explicit repository. Git sources are pinned to concrete commits. Shell wrappers, interactive payloads, implicit pushes and arbitrary CLI extensions are not publication adapters. Managed shell refuses direct Git/GitHub publication commands, including pushes to local file remotes. Trusted local programs still have the active writer’s local filesystem authority; this is not a hostile-code filesystem sandbox.

External actions are not replay-safe merely because their surrounding task is durable. An interrupted or failed push or PR update can have succeeded remotely. Its receipt preserves that uncertainty and requires human reconciliation before another mutation or handoff is attempted. Starting a fresh successor cannot erase an unresolved publication receipt.

Repository rules govern local integration and delivery details. They cannot disable the public-action approval requirement. Worktree cleanup must preserve dirty work and the resulting commits; successors must not depend on a deleted checkout.

## Scope

This release adds typed successors, Work Items, manual activation, runtime preparation and milestones, and mandatory publication approval. It does not add an autonomous project/goal orchestrator, automatic merge monitoring or an MCP host.
