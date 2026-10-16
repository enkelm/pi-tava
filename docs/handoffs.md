# Handoffs and Work Items

A handoff starts a fresh thread with a compact brief and transfers responsibility for the work. It does not reset, fork or compact the source conversation. Earlier conversations remain available for reading and discussion, but they cannot regain write access.

## The flow

Humans choose the next destination from the app's current state. Agents report their work and evidence; they do not prepare, recommend, select or activate successor threads, or record readiness to unlock one. A common path is Worker → Reviewer → Land → Publish, but it is not a mandatory checklist.

The same-work choices are:

| Current type | Destinations                        |
| ------------ | ----------------------------------- |
| Worker       | Reviewer, Researcher                |
| Reviewer     | Follow-up, Worker, Land, Researcher |
| Land         | Publish, Worker, Follow-up          |
| Follow-up    | Land, Worker                        |
| Researcher   | Worker, Follow-up                   |
| Pull         | Worker, Researcher, Follow-up       |
| Publish      | — (delivery/end stage)              |

These choices have a few state rules:

- **Pull** is additionally available at any stage except Pull itself.
- **Land** stays available after any earlier Reviewer in the same Work Item. There is no review, readiness, checkpoint or risk-acceptance admission gate.
- **Follow-up** requires a Reviewer or Pull in that Work Item's history, counting the current source thread.
- **Reviewer** from Worker requires a nonempty current Pi diff. Historical Pi edits that have since been committed, or edits recorded outside a repository, are not a current diff. A new checkpoint alone does not qualify.
- The current role cannot immediately follow itself within one Work Item.
- **Publish** is the delivery/end stage, not a same-work route back to Worker or Follow-up. The global Pull and earlier-Reviewer Land rules still apply.
- Every active stage also offers **Worker**, **Researcher** and **Pull** as **new-work** starters. Repeating the current starter type is allowed here because it starts a distinct Work Item.

State eligibility does not waive access, driving, idleness or single-writer checks. Choosing a role is not evidence that the code is correct or permission to perform its mutations.

Worker remains the default for project work. It can research deeply, plan, compact when useful and implement without changing threads. Researcher can start a Work Item or investigate a pointed question mid-work: it gathers cited evidence and application guidance, keeping feature implementation outside that investigation. The human can choose Worker to apply research-only findings or Follow-up for bounded repairs when history permits. Research findings do not establish independent review.

Reviewer performs a bounded independent review, fixes concrete findings and reports the actual results. Follow-up makes bounded repairs after review or Pull and self-reviews its delta and immediate integration points once. If a browser, environment or check is unavailable or blocked, the agent abandons it and reports the verification gap; it never bypasses policy, retries unchanged failures or creates successor loops merely to repeat unavailable checks. Failed or deferred checks remain failed or deferred, even if the human chooses to proceed.

Pull reads ticket/PR/repository data, settles direction with the human and handles specifically requested local rebases. It can start independently or occur at any stage, but not consecutively within the same Work Item. It does not authorize external publication. Preserve dirty work before rebasing or resolving conflicts; report the integration delta and remaining risks.

Land handles only authorized local work: rebases, conflict resolutions, commits, commit-hook fixes and safe worktree cleanup. It checks the impact of its integration changes and reports the actual checkpoint, cleanliness, checks and risks. Entering Land does not attest that review or tests passed and does not authorize a commit, rebase or cleanup. A successful local landing is distinct from publication.

Publish follows Land for pushes, PR creation and ticket updates. Each external mutation requires its own human approval against the actual current clean Publish checkout and pinned action inputs, not an inherited readiness milestone. Starting Publish is never blanket permission. MCP is not required; supported repository CLI tools use the separate publication adapter.

## Stage agents

Each thread type receives its own system-level working playbook, selected before every model request. These are separate agent responsibilities, not one end-to-end checklist repeated in every thread:

| Type       | Working loop and stopping point                                                                                                                                                                                                                       |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat       | Clarify, explore or perform the bounded requested task; report the answer or next decision and wait for the human.                                                                                                                                    |
| Researcher | Investigate a bounded question using primary docs and code; cite evidence, distinguish facts from hypotheses and explain application and validation. Keep changes to research notes, report findings and wait for the human.                          |
| Worker     | Research and plan at the depth needed, implement in small increments, write focused tests and iterate on relevant checks. Report reviewable work, actual evidence, deferred checks and risks; leave independent review to Reviewer.                   |
| Reviewer   | Independently inspect code and test quality in the wider application; run impact-driven regressions, fix concrete findings and retest for at most two review/fix passes. Report findings, results and gaps without turning them into a workflow gate. |
| Follow-up  | Apply bounded review or Pull-intake repairs, run applicable checks and self-review the delta and immediate integration points once. Preserve earlier evidence for untouched work, disclose material rewrites and report remaining gaps.               |
| Pull       | Read supported ticket/PR/repository sources, clarify direction and perform specifically requested upstream integration. Preserve dirty work; report sources, changes, checks and risks. Stop on unavailable sources rather than repeating failures.   |
| Land       | Perform only authorized local integration, resolve conflicts and hook failures, then check the impact. Report actual integration, checkpoint, cleanliness, checks and risks without selecting or recommending a successor.                            |
| Publish    | Inspect the current clean Publish checkout, obtain approval for each exact external mutation, inspect receipts and report concrete PR/ticket/delivery outcomes. Reconcile uncertain effects before continuing.                                        |

The bundled playbooks live in `src/server/thread-prompts.ts`. Settings → **Agents** lets the owner edit each type's role instructions app-wide; overrides persist in `config.json` and apply on the next model request, including to existing threads and delegated helpers. Restore default followed by Save removes the override. These edits do not change thread types, shared scope guidance or runtime authorization gates. Non-editable common rules override saved legacy instructions to prepare/recommend handoffs, attest readiness or demand a human risk-acceptance gate for Land. Private Herdr agents are not configured here. Each thread is a separate durable conversation/agent with its own context and agent configuration; the non-toggleable core supplies that agent's `thread_role` system-prompt amendment separately from dynamic `workflow` state and copied briefs. Handoffs reuse cwd/model/thinking choices, not the predecessor's custom session instructions. Those instructions remain with their source agent; set any destination-specific instructions on the new thread. Work-wide requirements belong in shared global/project context or the original specification. A delegated helper inherits its parent thread's role and reports its assigned task; it does not take over human workflow control. Retired threads keep their historical role, but current read-only workflow state overrides its working loop.

Shared safety, coding/style guidance, explicit human limits and repository instructions still apply. Validation defaults adapt to risk: Workers can run broader checks when necessary or required, and Land reuses still-current review evidence rather than repeating independent review by default. Explicit plan mode still blocks working-checkout edits; it permits isolated research downloads but not research cleanup. `/until` check goals pause during summary-only requests and on retired writers, without running checks or consuming attempts; otherwise their loop is unchanged. These prompts guide agents; they do not implement a runtime pass counter or independently certify test adequacy. Write ownership, source-summary restrictions, publication content pinning and individual action approvals remain enforced by the runtime.

## Starting a handoff

The thread header and human-issued `/handoff` command use the same operation:

```text
/handoff
/handoff reviewer
/handoff land
/handoff publish
/handoff follow-up
/handoff researcher
/handoff pull
/handoff worker
/handoff worker --new
/handoff researcher --new
/handoff pull --new
```

Without a destination, the command opens the picker. Same-work is the default; `/handoff worker` needs no `--same` flag. `--new` starts a separate Work Item. Choices follow the state rules above, not model recommendations. Direct commands select a destination and report unmet state or authorization requirements. No agent-prepared brief, completed assistant report or readiness declaration is needed before choosing; Worker → Reviewer needs the actual current diff instead.

After the human chooses:

1. The app persists durable intent with the fixed destination and relationship.
2. It asks the source agent for a compact summary only: the original ask, current direction, code/files/checkpoint, changes, actual checks/results, blockers, deferred checks, remaining risks and mutation limits. For new work, the summary distinguishes the new scope from unfinished prior work. The source may not use tools, delegate, write files, record completion or do further implementation during this request.
3. A durable task waits for that reply. It then atomically creates the independent successor, stores its relationship/retry receipt/membership, reserves the active-writer position and permanently retires the source. A failed or stopped summary creates no successor. Recovery of an existing request joins a pending summary or returns its completed destination; it does not rerun a blocked or failed summary. Only an explicit human retry can start another summary attempt for that saved choice.
4. The app opens the successor and delivers the summary. A model names that thread from the received summary; completed naming responses and usage are applied once, and a manual rename takes precedence.

The initiating tab saves its original request in `sessionStorage`. After reconnect or reload, it recovers that choice with `recoverOnly: true`: pending work is joined, a completed request returns the same successor, and a failed summary stays failed until the human explicitly retries (`recoverOnly` omitted or false). Automatic redirect follows the result only in the initiating tab, for the same signed-in user, while still on the source thread. Other viewers, switched users and people who navigated elsewhere are not pulled into the successor.

The human is not asked to write handoff paperwork or fill in an outcome/risk-acceptance form. The agent `handoff` tool is **status only**. It rejects prepare, complete, record-review, destinations and recommendations. Agents finish their own work and report results; only humans choose the next thread.

A successor must still inspect the actual checkout and evidence. Summaries and old milestones do not prove correctness, review independence, passed checks or authorization. Follow-up preserves the source, scope and limitations of applicable prior review, self-reviews its bounded repair and discloses changes that make earlier evidence stale. Material rewrites may make an earlier assessment inapplicable; unavailable checks alone do not invalidate a code inspection. Neither circumstance controls which thread the human can create.

### Review evidence and historical validation-risk decisions

Independent code inspection, validation results and human risk decisions are separate facts. Reports preserve review scope, actual results, known baseline failures and named failed, unavailable or deliberately deferred checks. Research findings, a link alone and self-attestation do not establish independent review. A check the human elects not to run has no invented result.

Earlier versions stored code-bound `review-complete`/`needs-review` milestones, separate `reviewAssessment` findings and validation gaps, `reviewApplicability` declarations, external-review provenance and human validation-risk decisions. These records remain historical evidence; they no longer enable or block Land or any other thread creation. There is no risk-acceptance checkbox to unlock a destination and no required agent completion call. Land's availability is a state/history choice, not a passed assessment.

Existing `validationAcceptances` retain their append-only history: human identity, time, thread, exact code fingerprint, assessment identity and accepted gaps. The first recorded acceptance remains a durable decision, not a replaceable readiness flag. A later report, review or code change cannot retroactively rewrite what was accepted. An old decision may no longer apply after assessment or integration drift; carrying it forward as context does not make failed/deferred checks pass, manufacture review provenance, certify the current checkout or authorize publication. Reports must state those limitations honestly.

Follow-up reuses applicable evidence for untouched work, self-reviews its bounded delta and explains remaining risks once. Unavailable infrastructure or deferred checks alone are not reasons to create another Reviewer or Follow-up. Historical acceptance and outcome compatibility records do not alter offline execution, writer reservations or individual publication approvals.

### External review intake

Paste the review source (a GitHub review URL or another system/reviewer reference), actual findings and full reviewed commit/checkpoint in a message to the active thread. For example: “Follow up on Casey's review at https://github.com/org/repo/pull/42#pullrequestreview-123, reviewed commit `<full SHA>`: ‘Add a retry guard; the rest of the feature is sound.’” No outcome form or handoff paperwork is required. A link alone is not enough: supply the findings and reviewed checkpoint, or obtain them through an existing permitted read path. Authenticated GitHub reads still belong to Pull. Review evidence grants no new browser, shell or credential access.

The status-only agent tool cannot `record-review`. Existing grounded `Workflow.externalReview` records keep their source, verbatim findings, assessed scope, full reviewed checkpoint, durable human-input identity, submitter and recorder/time. Public workflow metadata omits raw findings, private submission/request IDs and inspected Git status; the original review text remains in its human input. These records are human-supplied third-party evidence, not a claim that Coop authenticated the remote reviewer. Assess independence, scope and applicability rather than treating any quote as a passed review.

The compatibility `POST /api/c/:id/handoffs/external-review` intake still references an already persisted human message and checks its request/submission/entry identity, visibility, steering, driving, active ownership, idleness and matching inspected checkpoint. It performs no external read and refuses stale checkpoints, invented quotes, assistant messages and handoff couriers. This evidence path does not establish readiness or control Land admission. There is no agent-side replacement for human destination selection.

Before requesting a handoff, wait for all delegated helpers and background work. Pending helper reports are work too: the main agent ends its current turn so queued reports can be delivered, then resumes on arrival rather than polling. The source and other writers must be idle before the app admits the fixed source-summary request. After that request, only its own summary task/run is exempt when authority transfers. The chooser uses the same complete task-graph idle check, not merely the main thread's visible busy flag. Both also count in-flight local writer reservations, including Browser-panel requests waiting for their body or action to settle. The authority-transfer commit holds the workflow mutation lock so no new panel mutation can enter after its final idle check. Panel mutations recheck current access, driver and active write ownership after body arrival and before effects; passive state, frame and console reads remain available to people who can see the thread. An activation never kills an active tool or silently interrupts a run. Invalid or cancelled requests create no thread. This checks Durable's registered runs, tools, descendant agents and background tasks; external terminals or detached daemons are not ownership leases. Stop externally managed writers before activating a handoff.

## Work Items

The first same-work handoff wraps the source thread and its successor in a Work Item. The sidebar replaces the single row with an expandable item bearing the first thread's title. Its children are the individual conversations; its leading icon and status follow the thread currently responsible for the work. An expand/collapse chevron sits below that icon in the disclosure button. Paths and model metadata stay on one truncated line. Leading stage icons replace duplicate sidebar role badges. Workflow status and predecessor/active-thread links are compact icons inside the chatbox, not a separate bar above the transcript.

Further same-work handoffs join that item. There are no nested Work Items. A new-work handoff starts a separate item linked to the preceding work. Once work lands, substantial subsequent implementation normally starts a new item; Publish can still follow within the landed item.

An item can stand alone, belong to a project or belong to one of its goals. Move, archive and restore apply to the whole item. Member conversations cannot be archived independently, even through a direct metadata request. Goal archive and restore retain their existing atomic behavior.

Placement and grouping never grant access. Hidden threads and their full histories remain hidden. The compact handoff brief is copied content belonging to the destination conversation; sharing that destination also shares its brief. A session-scoped invitation is not authority to create unrelated conversations or publish code.

## Durable state

Pending handoff intent identifies the source, human-selected destination/relationship, requester, retry identity, summary task and settlement. Handoff records identify the resulting source, destination type, relationship, brief, requester and destination conversation; older records may also retain a source checkpoint. Work Items record their origin, membership, placement and active thread. Thread workflow state records permanent read-only status and retains historical milestone/recommendation data, external-review provenance, applicability declarations, separate code/validation assessments and append-only human validation-risk decisions. Historical readiness and recommendations are not exposed as destination controls.

After the source replies, destination creation, active-writer reservation, source write withdrawal, relationship records and membership publish in one commit. Initial prompt delivery has a durable task and request identity. After successor creation, recovering the same request after a disconnect or restart finds that destination instead of creating or delivering its initial prompt twice. Recovery does not rerun failed source summaries; retrying those requires a fresh explicit human action. Naming uses the received summary and a durable response memo; accepted naming, exactly-once usage and task settlement commit together, with a manual rename protected from delayed application.

The requested summary includes the original request and references, implementation decisions, actual check results, risks and the relevant code checkpoint when known. It is orientation, not evidence of correctness: the successor still inspects the actual code and diff.

These are additive Pi Durable documents. Existing document kinds, versions, scope and fork contracts remain unchanged. Workflow kinds have their own explicit fork behavior and do not turn handoff conversations into task-owned subagents.

## Execution and approvals

Write authority belongs to the current thread, not every thread in an item. Predecessors remain read-only when prompted again, after restart, or through nested tool calls. Verified read-only local inspection remains available; write authority never returns. The execution gate covers filesystem operations, shell commands and descendant agents, not only the `write` and `edit` tools.

Managed shell execution and Git subprocesses—including worktree creation, cloning, cleanup and checkpoint inspection—currently require macOS `sandbox-exec`. Local commands run without network access, including their child hooks and interpreters. Pull has a separate constrained external-read tool; it does not enable online shell access. It supports `git fetch <configured-remote>` into remote-tracking branches (main thread only) and `gh pr/issue view/list` with an explicit `--repo owner/repository`. Online Git uses an isolated bare staging repository without checkout hooks/config/credential helpers; local-file reads and ref import remain sandboxed offline. Fetch admission checks the complete Work Item/descendant task graph under the workflow mutation lock, exempting its own main invocation/run and the exact incoming brief courier already placed into that run (which only waits for its answer). Queued/unrelated deliveries and existing helper/background work cause refusal before Git inspection or external execution; they are never aborted. Managed filesystem operations and shell children also hold writer reservations until settlement, so already-running operations exclude Pull/publication and later writers are denied while the lock is held. Import refuses symbolic destination tracking refs, including chained/dangling symbols and `origin/HEAD` when upstream advertises a branch named `HEAD`; ordinary `origin/HEAD` remains untouched. Before import, the effective staging URL is checked against checkout URL rewrites so the imported heads must come from the inspected staging repository. External terminals and detached daemons are not ownership leases and must be stopped separately. Arbitrary APIs, publication, tags/pruning and interactive authentication are unsupported. GitHub helpers inherit the read capability and do not require an idle main run. Dependency downloads, HTTP/server tests and signing through network or OS brokers may therefore fail; they are not silently retried outside the sandbox. Both fail closed on other platforms until an equivalent environment is available. Artifacts and unknown extension tools remain blocked for managed agents. Worker, Researcher and Follow-up have the separate read-oriented research and browser capabilities below; other managed roles do not gain them. Existing artifacts and executable reply previews cannot run in managed conversations; static code previews remain available. These restrictions also prevent unapproved network mutations on a viewer’s device. Unrelated Chats retain their existing behavior.

### Research access

The non-toggleable `research` tool is available to active Worker, Researcher and Follow-up threads and their helpers, including Workers in plan mode. Access requires a currently writable managed thread; historical handoff recommendations do not confer authority, and retired predecessors have no research access. It supports:

- `read` with an explicit public HTTPS URL: credential-free GET, public IPv4 DNS validation pinned at the transport, destination validation on every redirect, at most four redirects, a 20-second total budget and a 2 MiB uncompressed document limit. HTML, plain text, Markdown and JSON are supported. Local/private/reserved addresses, IP literals, non-443 ports and credentials are rejected. IPv6-only sources are not supported. This is a document reader, not a general HTTP/API or dedicated web-search tool.
- `clone` with a public `https://github.com/owner/repository` URL: a shallow default-branch clone in app-owned storage, never a fetch into the working checkout. It uses no credentials, checkout configuration, hooks, templates, redirects, submodules or LFS. Git runs in the Darwin sandbox with writes limited to staging and outbound traffic limited to HTTPS; its GitHub destination is DNS-validated and pinned through curl. Online staging is time-bounded to 120 seconds and monitored at 128 MiB (not a disk quota); admission bounds expanded content to 128 MiB and 20,000 files before offline checkout. Symlinks become text files. Unsupported platforms fail closed.
- `cleanup`: remove that root thread’s downloaded material, not its predecessors’ cited sources or checkout. This is blocked in plan mode. Downloaded evidence lives under the data directory’s `research/<thread-id>/` until cleanup; source URLs, local paths and clone commits are returned. Storage admission stops new downloads after 256 MiB; an in-flight download can temporarily exceed that admission threshold.

The browser extension must be enabled for browsing. Managed pages always use temporary isolated Chromium contexts, even with an imported profile selected. Worker, Researcher and Follow-up agents can navigate public HTTPS documents, snapshot, screenshot, scroll, change viewport, inspect the console or wait. The document reader performs the only network read; Chromium networking and page scripts are disabled, and content is reduced to semantic HTML without forms, live links, remote resources or event handlers. Follow links by navigating the URL printed in the snapshot. Clicking, typing, evaluation and history tools are blocked for agents. The shared panel also renders this static content. JavaScript-only or authenticated sites and local dev-server browser checks are unavailable in this reader and must be reported as verification gaps.

Research does not enable online bash, transfer write ownership, complete review, or authorize external mutations. External content is untrusted data. Pull’s upstream-ref integration and Publish’s individually approved mutations remain separate.

These rules govern normal runtime execution. The app administrator and trusted server/provider extensions remain trusted code with server rights; this is not a hostile-tenant sandbox.

Local execution must not provide an unapproved route to external publication. Publish follows Land, but entry into that thread is not an inherited `ready` attestation or action approval. Each public action inspects the actual current clean Publish checkout and pins its exact command, content checkpoint, destination and relevant executable inputs for human approval. If those inputs change while approval is pending, fresh authorization is required.

The first publication interface accepts an explicit Git push remote/refspec and supported `gh pr` or `gh issue` commands with an explicit repository. Git sources are pinned to concrete commits. Shell wrappers, interactive payloads, implicit pushes and arbitrary CLI extensions are not publication adapters. Managed shell refuses direct Git/GitHub publication commands, including pushes to local file remotes. Supported local Git commands such as `stash push` and `rebase` remain local operations, not publication merely because their arguments include `push`. Supported global options and command boundaries are parsed; nested shell/configuration text, unknown Git operations/options and unsupported shell syntax retain conservative lexical publication refusal. Trusted local programs still have the active writer’s local filesystem authority; this is not a hostile-code filesystem sandbox.

External actions are not replay-safe merely because their surrounding task is durable. An interrupted or failed push or PR update can have succeeded remotely. Its receipt preserves that uncertainty and requires human reconciliation before another mutation or handoff is attempted. Starting a fresh successor cannot erase an unresolved publication receipt.

Repository rules govern local integration and delivery details. They cannot disable the public-action approval requirement. Worktree cleanup must preserve dirty work and the resulting commits; successors must not depend on a deleted checkout.

## Scope

This release adds human-chosen state-based destinations, durable summary-only handoffs, typed successors, Work Items, guarded destination naming and mandatory individual publication approval. Historical milestone/review/risk-acceptance records remain evidence, not thread-creation gates. It does not add an autonomous project/goal orchestrator, automatic merge monitoring or an MCP host.
