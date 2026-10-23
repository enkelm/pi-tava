# Handoffs and Work Items

A handoff starts a fresh thread with a compact brief and transfers responsibility for the work. It does not reset, fork or compact the source conversation. Earlier conversations remain available for reading and discussion, but they cannot regain write access.

## Handoff file

The existing handoff tool writes the summary and exact human direction to an actual
`handoff.md` in a private `pi-coop-handoff-*` temporary directory before creating the successor.
The successor receives a short prompt with that absolute path and uses the existing `read` tool.
For SSH work the file is written on the SSH target, where the successor also runs.
There is no separate context-file UI, API, reader tool, preparation model or file database.
New records and recurring workflow instructions retain only the path, not another inline summary.
Historical inline handoffs and already-accepted legacy summary tasks keep their original recovery path.
There is no handoff-specific 8k/12k editorial limit;
normal request/model/tool limits still apply. Temporary files are not an archive or part of database
backups: if the OS or a person removes one, it must be recreated before it can be read again.
Optional naming failure does not suppress the successor's read prompt; its normal `read` reports
an unavailable file rather than pretending to have received the context.

## Availability and execution pause

Work Items is part of the app, not an optional extension. Its built-in profiles, role instructions,
picker and status controls remain available while execution is paused. The owner pauses or resumes
**Work Item execution** in Settings → **Agents**. Work Items is not listed in Extensions.

The native `workItemsEnabled` setting controls execution. When it is absent, the legacy disabled
`work-items.ts` choice is read only as migration input, so an earlier disabled installation stays
paused after upgrade. Explicit native changes persist `workItemsEnabled`; extension-enablement
controls cannot change it. Owner-only `POST /api/agents` accepts `{ workItemsEnabled: boolean }`;
`GET /api/agents` and `hello` metadata expose effective state. Promotion to core never silently resumes
execution. While paused, non-Chat built-in starters and new built-in handoffs are unavailable, and managed writes are
blocked. Accepted legacy transfers and receipts still recover through their existing durable paths,
with live authorization checks, but recovery does not authorize new managed effects while paused.
Already-accepted legacy summaries may finish their atomic transfer while paused, but fresh destination delivery is blocked. Resuming execution does not automatically retry a blocked courier; the human can continue in the active thread using the saved handoff. A pause fences new effects rather than rolling back or promising to terminate already-dispatched work. Histories, owner prompt overrides, stable profile IDs and permanent writer retirement remain intact.

Ordinary ungrouped Chat and Agent Teams continue without mandatory Work Item membership. Third-party
namespaced profiles and graphs keep their independent extension lifecycle. Missing or unknown managed
profiles remain restricted and unavailable, never fall back to unrestricted Chat.

Public `host.sessions.handoff`, `web.workflow`, scoped routes, browser controls and input hints remain
supported. The built-in browser assets retain their `work-items` namespace and URLs. This is a
product-contract change for the next minor release, not a patch-level removal of a public interface.

## The flow

Humans request handoffs; agents execute them. A request may name a type explicitly or describe the next task in ordinary English. The agent infers a clear intended type, or asks a focused follow-up if the request is ambiguous, confusing or unavailable. The app deterministically enforces transitions from thread type/history, current diff, access and write ownership. Agents do not invent readiness gates, pick an unrelated fallback or advance the workflow autonomously. A common path is Worker → Reviewer → Land → Publish, with eligible Follow-up between Reviewer and Land for bounded repairs. This is not a mandatory checklist: routine post-review repairs do not restart a Worker → Reviewer cycle.

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

Land handles only authorized local work: rebases, conflict resolutions, scoped commits, stash preservation/restoration, local main fast-forwards, commit-hook fixes and safe worktree cleanup. It uses ordinary offline bash/Git; there is no separate Land tool/API, second native Land action or required approval receipt. Settled Git exit/output, the resulting checkpoint and dirty-work preservation evidence are the local integration receipt. It checks the impact of its integration changes and reports cleanliness, checks and risks. Entering Land does not attest that review or tests passed and does not authorize a commit, rebase or cleanup. A successful local landing is distinct from publication.

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
| Land       | Perform only authorized local integration, resolve conflicts and hook failures, then check the impact. Report actual integration, checkpoint, cleanliness, checks and risks; execute a clear human-requested handoff without advancing autonomously.  |
| Publish    | Inspect the current clean Publish checkout, obtain approval for each exact external mutation, inspect receipts and report concrete PR/ticket/delivery outcomes. Reconcile uncertain effects before continuing.                                        |

The bundled playbooks, labels, starters and declarative transitions live in `src/server/work-item-profiles.ts`, owned by the application's WorkItems module. Core retains non-editable shared guidance and an unavailable-profile response in `src/server/thread-prompts.ts`. Settings → **Agents** lets the owner edit each type's role instructions app-wide; overrides persist in `config.json` and apply on the next model request, including to existing threads and delegated helpers. Restore default followed by Save removes the override. These edits do not change thread types, shared scope guidance or runtime authorization gates. Non-editable common rules override saved legacy instructions that make handoffs status-only, prohibit executing a clear human request, attest readiness or demand a human risk-acceptance gate for Land. Private Herdr agents are not configured here. Each thread is a separate durable conversation/agent with its own context and agent configuration; the non-toggleable core supplies that agent's `thread_role` system-prompt amendment separately from dynamic `workflow` state and copied briefs. Handoffs reuse cwd/model/thinking choices, not the predecessor's custom session instructions. Those instructions remain with their source agent; set any destination-specific instructions on the new thread. Work-wide requirements belong in shared global/project context or the original specification. A delegated helper inherits its parent thread's role and reports its assigned task; it does not take over human workflow control. Retired threads keep their historical role, but current read-only workflow state overrides its working loop.

Shared safety, coding/style guidance, explicit human limits and repository instructions still apply. Validation defaults adapt to risk: Workers can run broader checks when necessary or required, and Land reuses still-current review evidence rather than repeating independent review by default. Explicit plan mode still blocks working-checkout edits; it permits isolated research downloads but not research cleanup. Handoff status and human-requested handoffs remain available without approving implementation; their normal authority and transition checks still apply. `/until` check goals pause during summary-only requests and when execution is blocked by retirement, an unavailable profile or the owner's pause, without running checks or consuming attempts; otherwise their loop is unchanged. These prompts guide agents; they do not implement a runtime pass counter or independently certify test adequacy. Write ownership, source-summary restrictions, publication content pinning and individual action approvals remain enforced by the runtime.

## Starting a handoff

Use the header's **Choose next thread** button, ask in ordinary English, such as “Hand this to a researcher to investigate retries,” or use the message box's `/handoff` command. The popup first lets you choose a role and same/new Work Item, then **Next** opens an optional steering box. **Back** preserves your selection and instructions. **Start thread** submits one real human input through the same acceptance/recovery path as the composer. The popup closes on input acceptance, not after the summary or successor is ready. Close, Escape, outside tap, drag and browser Back remain available during a slow send; dismissing the popup does not cancel a submitted request. Rejections preserve the form, and its per-tab draft survives closing/reopening or reload. A late response cannot close a newer popup or clear its edited draft.

The picker, header/composer controls, argument hints and styles live in
`src/server/work-items/browser/`. Core registers `src/server/work-items` with client entry `browser`,
preserving `/x/work-items/…` asset URLs. No first-party Work Items entry or source module remains
under `src/server/extensions/`. The controls intentionally reuse the shared web registry and public
browser presentation APIs for compatibility. Eligibility comes from scoped `GET /api/c/:id/x/work-items/handoffs`; group edits use
`POST /api/c/:id/x/work-items/work-item`. Each route rechecks current source visibility and role, including
after asynchronous body arrival; its services are bound to that person and source. Static browser
assets opt into conversation access, not app-wide route access. Source and browser target the same
current API without older-host guards or version flags.

For **New Work Item**, the owner can select **Own Git worktree** on the instructions step.
It is off by default. This is checkout isolation, not parallel dispatch: a successful transfer
still permanently retires the source writer.

The command supports:

```text
/handoff
/handoff investigate retries in a research thread; do not implement yet
/handoff reviewer
/handoff land
/handoff publish
/handoff follow-up
/handoff researcher
/handoff pull
/handoff worker --new --worktree Implement in a separate checkout
/handoff worker
/handoff worker --new
/handoff researcher --new
/handoff pull --new
/handoff researcher Investigate the retry bug; do not implement yet
/handoff worker --new Build the settings page
```

Type `/handoff ` to see role and relationship completions from the server's current state, including reasons for unavailable choices. Arrow keys and Tab complete a choice; tapping a suggestion only fills the draft. Add instructions before sending. Desktop Enter completes a partial argument or an explicitly arrow-selected choice; Enter after a complete role otherwise sends it. Escape hides suggestions. Completion stops when your instructions begin and does not replace text while editing earlier in the draft. Without an explicit type, the agent interprets your request. A bare `/handoff` with insufficient context asks which thread type you intend; it never silently chooses a default stage.

Same-work is the default; `/handoff worker` needs no `--same` flag. `--new` starts a separate Work Item. Put `--same` or `--new` before instructions (role-first or flag-first is accepted). The remaining text is your direction for the brief and successor, not a request to do more work before handing off. Instructions are saved verbatim in the handoff file so they do not depend on the agent remembering them in its summary. Multiline instructions are supported without a handoff-specific character cap. Choices follow the state rules above, not agent-authored readiness decisions. An unavailable type is not permission to pick another: the agent explains and asks you to clarify. No completed assistant report or readiness declaration is required before executing; Worker → Reviewer needs the actual current diff instead.

After the human asks:

1. The actual message is accepted as ordinary durable model input and the composer clears on acceptance, without waiting for a brief or successor. A rejected send preserves the draft. The app does not inject a second source message pretending to be the human.
2. The agent clarifies the type if needed, checks `handoff status` for available transitions and supplies `handoff start` with the type, relationship and a concise summary. The brief includes the original ask, steering, direction, files/checkpoint, actual changes/checks/results, blockers, deferred checks, risks and mutation limits. It distinguishes new scope from unfinished earlier work.
3. The tool verifies a real human input in its current main run, not a copied courier, helper or schedule; saves the Markdown file before admission, rechecks runtime state and atomically creates the successor, pins its receipt, reserves the writer position and permanently retires the source. An explicit slash-command type/relationship cannot be changed by the tool. A repeated accepted call returns the existing successor rather than creating another. Summary text alone is not authorization to publish or mutate the checkout.
4. The existing durable courier sends an application-attributed prompt telling the successor to read the file, without duplicating its contents. Naming reads the same file. Completed naming responses and usage apply once, and a manual rename takes precedence. The source agent stops work after its successful tool call.

Before submitting, the initiating tab pins the payload and retry identity in `sessionStorage`. If the HTTP acknowledgement is lost, an explicit retry keeps that identity rather than submitting the human message twice. Recovery uses the passive `GET /api/c/:id/submit?requestId=…` receipt lookup, never an automatic resubmission; a missing receipt creates no input or handoff intent. Accepted inputs retain an opaque handoff correlation. Core `GET /api/c/:id/transfers` passively looks up only the current person's accepted outgoing receipts from this exact source, including while Work Item execution is paused. Session updates or reload resolve a matching outgoing handoff; redirect is limited to the initiating tab/user while still on the source. Other viewers, switched users and people who navigated elsewhere are not pulled into the successor. Ordinary English requests use the same correlation path; the browser does not guess intent from keywords. Delayed acceptance clears only the submitted draft revision, not edits made later—even when undo restores identical text.

The human is not asked to write paperwork or fill in an outcome/risk-acceptance form. The tool exposes **status** and **start**, not prepare, complete, record-review or readiness/recommendation controls. Semantic inference and clarification are the agent's job; deterministic transition and authority enforcement belong to the runtime.

### Earlier summary-first requests

Core keeps legacy summary/delivery task registrations solely to recover already-accepted data.
There is no public summary-first admission or retry API, no `recoverOnly` command path and no old
handoff HTTP writer. A previously accepted summary-only input still forbids tools, delegation and
further work. Failed summaries are not automatically rerun. These recovery registrations preserve
stored document/task identities; they are not an alternate current handoff flow.

A successor must still inspect the actual checkout and evidence. Summaries and old milestones do not prove correctness, review independence, passed checks or authorization. Follow-up preserves the source, scope and limitations of applicable prior review, self-reviews its bounded repair and discloses changes that make earlier evidence stale. Material rewrites may make an earlier assessment inapplicable; unavailable checks alone do not invalidate a code inspection. Neither circumstance controls which thread the human can create.

### Review evidence and historical validation-risk decisions

Independent code inspection, validation results and human risk decisions are separate facts. Reports preserve review scope, actual results, known baseline failures and named failed, unavailable or deliberately deferred checks. Research findings, a link alone and self-attestation do not establish independent review. A check the human elects not to run has no invented result.

Earlier versions stored code-bound `review-complete`/`needs-review` milestones, separate `reviewAssessment` findings and validation gaps, `reviewApplicability` declarations, external-review provenance and human validation-risk decisions. These records remain historical evidence; they no longer enable or block Land or any other thread creation. There is no risk-acceptance checkbox to unlock a destination and no required agent completion call. Land's availability is a state/history choice, not a passed assessment.

Existing `validationAcceptances` retain their append-only history: human identity, time, thread, exact code fingerprint, assessment identity and accepted gaps. The first recorded acceptance remains a durable decision, not a replaceable readiness flag. A later report, review or code change cannot retroactively rewrite what was accepted. An old decision may no longer apply after assessment or integration drift; carrying it forward as context does not make failed/deferred checks pass, manufacture review provenance, certify the current checkout or authorize publication. Reports must state those limitations honestly.

Follow-up reuses applicable evidence for untouched work, self-reviews its bounded delta and explains remaining risks once. Unavailable infrastructure or deferred checks alone are not reasons to create another Reviewer or Follow-up. Historical acceptance and outcome records do not alter offline execution, writer reservations or individual publication approvals. Completion, external-review intake and validation-acceptance writers have been removed; the stored records are not a current write API.

### External review intake

Paste the review source (a GitHub review URL or another system/reviewer reference), actual findings and full reviewed commit/checkpoint in a message to the active thread. For example: “Follow up on Casey's review at https://github.com/org/repo/pull/42#pullrequestreview-123, reviewed commit `<full SHA>`: ‘Add a retry guard; the rest of the feature is sound.’” No outcome form or handoff paperwork is required. A link alone is not enough: supply the findings and reviewed checkpoint, or obtain them through an existing permitted read path. Authenticated GitHub reads still belong to Pull. Review evidence grants no new browser, shell or credential access.

The handoff tool cannot `record-review`. Existing grounded `Workflow.externalReview` records keep their source, verbatim findings, assessed scope, full reviewed checkpoint, durable human-input identity, submitter and recorder/time. Public workflow metadata omits raw findings, private submission/request IDs and inspected Git status; the original review text remains in its human input. These records are human-supplied third-party evidence, not a claim that Coop authenticated the remote reviewer. Assess independence, scope and applicability rather than treating any quote as a passed review.

There is no external-review intake HTTP writer or `record-review` tool action. Supply new review
evidence in an ordinary attributed human message, preserving its source, findings and checkpoint.
Historical records neither grant handoff authority nor replace a current human request.

Before requesting a handoff, wait for all delegated helpers and background work. Pending helper reports are work too: the main agent ends its current turn so queued reports can be delivered, then resumes on arrival rather than polling. The transfer checks the full Work Item/descendant task graph, not merely the main thread's visible busy flag. It exempts only the handoff tool's own invocation/run and the exact incoming courier already placed in that run, not unrelated tools, helpers or reports. Recovery of already-accepted summary tasks retains its task exemption. Transfers also count in-flight local writer reservations, including Browser-panel requests waiting for their body or action to settle. The authority-transfer commit holds the workflow mutation lock so no new panel mutation can enter after its final idle check. Panel mutations recheck current access, driver and active write ownership after body arrival and before effects; passive state, frame and console reads remain available to people who can see the thread. An activation never kills an active tool or silently interrupts a run. Invalid or cancelled requests create no thread. This checks Durable's registered runs, tools, descendant agents and background tasks; external terminals or detached daemons are not ownership leases. Stop externally managed writers before activating a handoff.

## Optional handoff worktrees

Same-work handoffs and new-work handoffs normally inherit the source's actual checkout,
including an existing worktree. Only an explicit owner-selected **new-work + own worktree**
request allocates another checkout. Use `/handoff worker --new --worktree`, select the checkbox,
or ask for new work on its own Git worktree in ordinary English. The tool's optional
`worktree: true` must match an explicit slash route; it cannot silently add isolation to
`/handoff worker --new`. `--worktree` without `--new`, non-Git/unborn checkouts, denied owner
access and unsupported native confinement fail explicitly rather than falling back to inheritance.
Legacy summary recovery and PiP controller handoffs retain their inherited-checkout behavior.

The new checkout stays on the source's pinned destination and in the corresponding repository
subdirectory. Local worktrees use the app's worktree storage; SSH worktrees use the existing private
`0700` target directory `~/.pi-coop-worktrees`, never a host-local namesake. The Markdown brief
remains in that same destination's private temporary directory, readable from the new checkout.
A destination change is not part of this option.

The snapshot uses existing worktree behavior: HEAD, dirty tracked changes and ordinary nonignored
untracked files come along. Ignored dependencies such as `node_modules` do not. New files have a
50 MiB aggregate copy budget; files exceeding the remaining budget are skipped. The tool result
and handoff record list those skipped paths; the agent must disclose them. The completed checkout
must also fit the existing safe workflow fingerprint limits (50,000 paths, 64 MiB tracked/untracked
content, no dirty submodules or escaping paths). This is a bounded snapshot, not an atomic snapshot
against external editors, terminals or detached daemons; stop them separately.

The explicit choice participates in retry identity. Core reserves stable branch/path coordinates
durably **before** Git mutations, holds the workflow exclusion lock during preparation and publishing,
and keeps filesystem/Git work outside Durable transactions. It revalidates the current owner/token,
source cwd/location/worktree/project, actual source Git root/directory/HEAD, main human input, authority,
spending and whole-item task idleness before admitting the successor. Source content and the prepared checkout
have separate fingerprints. A bounded source baseline is captured before copying and compared after
copying, using the same untracked-file budget planner as Worktrees; changed source content, skipped-file
metadata or skip choices refuse transfer while retaining the reservation and checkout. Recovery also
refuses changed source files or a changed target instead of publishing a stale snapshot. Skipped source
files contribute metadata, not unbounded content bytes. These checks are not an atomic filesystem
snapshot: edits reverted between inspections, metadata-preserving changes to skipped files and edits
after the final inspection can remain undetected. Stop external writers separately.
The target's branch, root and Git common directory must also match the reserved repository. A committed retry
returns the same successor, snapshot disclosure and delivery identity without running setup again.

An interrupted or failed setup never retires the source by itself. If effects are proven absent
(path, branch and Git worktree registration), a retry can reuse those exact reserved coordinates.
A partial, changed or uncertain setup is **retained**, not force-removed or retried: the error names
its destination, path and branch. Inspect it, preserve all human changes and remove only a confirmed
abandoned setup using authorized cleanup. Submit a fresh human request after reconciliation.
An unresolved older setup blocks allocating another own worktree from that source. Cleanup is
not automatic, and a new request cannot erase uncertainty. Missing SSH access, a lost transport or
unavailable confinement can prevent even proving absence; resolve that capability before cleanup.
The app does not delete possible human work merely to make a handoff succeed.

## Work Items

The first same-work handoff wraps the source thread and its successor in a Work Item. Creating a standalone root or upgrading the app does not enroll it automatically. The sidebar replaces the single row with an expandable item bearing the first thread's title. Its children are the individual conversations; its leading icon and status follow the thread currently responsible for the work. An expand/collapse chevron sits below that icon in the disclosure button. Paths and model metadata stay on one truncated line. Leading stage icons replace duplicate sidebar role badges. A compact workflow status indicator remains inside the chatbox, without predecessor, source or active-thread navigation buttons. Open individual threads from the sidebar’s child rows; the header’s **Choose next thread** and **PiP** controls remain available where applicable.

Further same-work handoffs join that item. There are no nested Work Items. A new-work handoff starts a separate item linked to the preceding work. Once work lands, substantial subsequent implementation normally starts a new item; Publish can still follow within the landed item.

A Work Item has exactly two control states: **PiP active** or **human control**, shown by its row's
PiP status icon and accessible label. The row's PiP action replaces mark-read and opens the same
owner-only PiP Thread without a goal form. Opening creates an inert controller or reuses the existing
Thread without activating it. A newly accepted owner message in that exact controller, or a fresh
owner-authorized named-agent send to it, activates PiP; duplicate or stale retries never activate it.
Named-agent contact steers an already-active controller without stopping separate execution threads.
It automatically associates the controller, but cannot bypass an exact pending question or individual
publication approval. Discovery, navigation and passive reports never activate work. Legacy persisted paused/reclaimed states both mean
human control. Activation preserves the pending question, scope, history, cumulative usage and caps. The grouped row, folded rails, launcher, Home
and keyboard navigation open the same owner-only PiP conversation and keep that row selected;
explicit execution-child links still open those exact threads. Questions, answers, checks and sends
are read in that PiP conversation, including expandable tool activity. Saved questions remain in its
transcript after an answer clears the pending state. Collaborators receive no private controller
destination or controls.

PiP reads canonical Work Item context, current execution and relevant discussion/evidence first.
Private `work_context status` supplies the actual active role and description, recent role history
(last 12 visible members, with `historyOmitted`) and live workflow choices/reasons from the existing
handoff service, even when the read is anchored at an older Worker. PiP uses eligible Follow-up for
concrete bounded post-review/Pull repairs, with focused checks and one delta/integration self-review.
It carries applicable prior review for untouched work and discloses stale evidence/material rewrites.
Unavailable infrastructure or deferred full-suite gaps alone never call for another Reviewer or
Follow-up or retries of unchanged checks. Material new implementation may need an initial independent
Reviewer for that new scope; this is guidance, not a new runtime gate, and human overrides still apply.
PiP honors required manual-testing green lights before Land and separate exact publication approvals.
It recovers actual human scope rather than inventing a goal, and asks one or two focused questions
in chat only when the next goal is unclear. The normal **Stop** button fences PiP and returns the
item to human control even while PiP is idle or waiting; execution Threads are left untouched.
There are no separate Pause, Resume, Reclaim or sidebar takeover buttons.
Optional dollar **Limits…** live in the selected Work Item’s right-click or long-press menu, not in
the composer, and address that item without opening or steering a different conversation. Loads and
saves remain bound to the current owner, selected item and controller; saves use an epoch
compare-and-swap so a changed grant cannot accept stale limits.
A new grant has no additional work cap unless the owner sets an optional dollar cap in **Limits**.
That pop-up contains budgets only, not goals, questions or action controls. Cumulative spend remains
visible; existing explicit caps survive activation and omitted changes. Saving limits returns the
item to human control; a newly accepted owner message in its exact PiP Thread activates PiP again.
Clearing the optional dollar field removes only that work cost cap, not account/session limits. Work-wide token limits are deferred until historical auxiliary token usage can be included
soundly; no unenforced token field is displayed.
Account/session budgets and publication approvals remain separate. PiP checks the actual independent
review outcome and unresolved findings before directing staging/commits by default; role availability,
idle state, resolved comments and a finish report are not review approval. Execution threads report
meaningful results/questions/blockers and yield, automatically notifying PiP rather than sending
periodic status messages. PiP waits between meaningful outcomes, checking alignment at those points.

An item can stand alone or belong directly to a project. Move, archive and restore apply to the whole item. Member conversations cannot be archived independently, even through a direct metadata request.

Placement and grouping never grant access. Hidden threads and their full histories remain hidden, and hidden members block whole-item mutations. Moving an item between projects changes organization, not the threads' pinned local/SSH destination or cwd. Both same-work and new-work handoffs inherit the source's pinned destination; an explicitly selected own worktree changes only the new-work successor's checkout; access and execution remain the responsibility of the workspace and SSH modules. The destination receives the path to the handoff file, which contains exported source context. A session-scoped invitation is not authority to create unrelated conversations or publish code.

## Durable state

`app.workItems` owns lifecycle, membership, active-writer ownership, filtered work views and receipts,
and whole-item organization. Its private Handoffs engine retains transfer admission, durable tasks,
recovery and atomic successor transactions. PiSessions remains responsible for local Pi history
and import, not work lifecycle.

Agent-executed handoffs correlate to the real human submission through an opaque key and pin the accepted type, relationship and brief in a durable receipt. Legacy pending summary-first intent retains the source, selected destination/relationship, requester, retry identity, summary task and settlement. Handoff records identify the resulting source, destination type, relationship, temporary file path, requester and destination conversation; historical records retain inline briefs and may also retain a source checkpoint. Work Items record their origin, membership, placement and active thread. Thread workflow state records permanent read-only status and retains historical milestone/recommendation data, external-review provenance, applicability declarations, separate code/validation assessments and append-only human validation-risk decisions. Historical readiness and recommendations are not exposed as destination controls.

At successful tool execution (or settlement of an older summary task), destination creation, active-writer reservation, source write withdrawal, relationship records and membership publish in one commit. Initial prompt delivery has a durable task and request identity. After successor creation, recovering the same request after a disconnect or restart finds that destination instead of creating or delivering its initial prompt twice. Recovery does not rerun failed source summaries or expose legacy summary admission/retry writers. Naming uses the received summary and a durable response memo; accepted naming, exactly-once usage and task settlement commit together, with a manual rename protected from delayed application.

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

The first publication interface accepts an explicit Git push remote/refspec and supported `gh pr` or `gh issue` commands with an explicit repository. Git sources are pinned to concrete commits. Shell wrappers, interactive payloads, implicit pushes and arbitrary CLI extensions are not publication adapters. Managed shell refuses direct Git/GitHub publication commands, including pushes to local file remotes. Supported local Git commands such as `stash push` and `rebase` remain local operations, not publication merely because their arguments include `push`. Supported global options and command boundaries are parsed; nested shell/configuration text, unknown Git operations/options and unsupported shell syntax retain conservative lexical publication refusal. The refusal distinguishes a detected operation from an unparsed command or embedded script with publication-like tokens. The latter can match local `git stash push` in a Node/Python script or heredoc: it is not proof of publication, a Git conflict or an executed command. Arbitrary embedded programs cannot be statically proven local by this parser. Trusted local programs still have the active writer’s local filesystem authority; this is not a hostile-code filesystem sandbox.

### Supported local integration forms

Prefer separate ordinary Git commands for already-authorized local work, with supported global
options such as `-C`, `--git-dir`, `--work-tree` and `--no-pager`. For example, path-scoped
`git stash push --include-untracked -m <label> -- <exact-paths>`, `git rebase main`,
`git stash apply --index <saved-stash-sha>` and
`git -C <local-target> merge --ff-only --no-edit <candidate-sha>` are local forms, not publication.
These examples grant no mutation authority or permission to touch another writer's checkout.

Preserve unrelated staged, unstaged and untracked work before staging the new scoped commit;
stash records index state too. Record the exact preservation reference and compare index/worktree
state and file bytes before/after, in both source and target. Do not drop recovery references or
clean up a checkout without authorization. When main has advanced after an earlier local Land,
inspect and integrate against its current head rather than assuming the old base is still current.

On a conservative guard refusal, report that nothing was executed. Do not retry the rejected script
unchanged, disguise it in another wrapper or translate hidden publication into a different mechanism.
Supported standalone commands are the normal form for already-authorized local integration, not a
way to obtain publication permission. Stop if the requested scope or prior effects are unclear.
Git push/send-pack/receive-pack, even to file remotes, and GitHub mutations still require the Publish
adapter and individual approval. No second Land API, review milestone or receipt gate is needed.

External actions are not replay-safe merely because their surrounding task is durable. An interrupted or failed push or PR update can have succeeded remotely. Its receipt preserves that uncertainty and requires human reconciliation before another mutation or handoff is attempted. Starting a fresh successor cannot erase an unresolved publication receipt.

Repository rules govern local integration and delivery details. They cannot disable the public-action approval requirement. Worktree cleanup must preserve dirty work and the resulting commits; successors must not depend on a deleted checkout.

## Scope

This release supports agent-executed human-requested handoffs with state-based transitions, typed successors, Work Items, guarded destination naming and mandatory individual publication approval. Core task registrations recover already-accepted summary/delivery data only; new requests use the current human-input/tool path. Historical milestone/review/risk-acceptance records remain evidence, not thread-creation gates. A newly accepted owner message in the exact Work Item PiP Thread activates a bounded private supervisor: it observes running work, uses this same file/courier engine for settled controller handoffs, manages discussions and asks durable human questions. The controller bypasses historical role/diff eligibility but retains access, spend, driver, writer/helper-idle and publication safeguards. Direct human execution input and normal Stop return it to human control without stopping execution Threads; publication is never preapproved by activation. This is not a general project scheduler, generic context-relay/file service, automatic merge monitor or MCP host.
