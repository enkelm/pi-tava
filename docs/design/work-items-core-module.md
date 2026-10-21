# Work Items as a deep application module

Status: architectural research, not an implementation plan approved for execution.
Evidence baseline: `61a25cf171e18c26e5c50cabf0437d76f1ef68b4` (2026-10-19).
All code references below refer to that commit in `enkelm/pi-coop`.
Scope: the extension seam and migration trade-offs; no source/test changes or runtime experiments.

## Conclusion

**Yes, a first-class WorkItems module is worth pursuing if Work Items is now the
product's default work model. No, moving files or folding it into PiSessions is
not itself the improvement.** Most difficult behavior is already application-owned.
The useful change is to give that behavior one coherent interface and lifecycle,
then make the handoff tool and browser presentation adapters of that interface.

For the immediate Pip collaborator, Reviewer attribution and range comments,
this migration is not a prerequisite. Do not combine those changes into a large
workflow rewrite. Future Pip takeover would strengthen the case for a shared
application module, but does not authorize autonomous handoffs or publication.

The current split was defensible: optional process in an extension, mandatory
mechanism in core. It still has real opt-out behavior and tested generic declarations.
Its diminishing return is a product decision, not evidence that extensions are broken.

## What the extension actually owns

- `src/server/extensions/work-items.ts:8-76` declares labels, icons, prompts,
  starter profiles and the same-work/new-work transition graph. Worker-to-Reviewer
  needs a current diff; some destinations depend on prior role history.
- `src/server/extensions/_work-item-profiles.ts` owns role playbooks; the entry
  module imports their data. It does not own durable work-item state.
- `src/server/extensions/work-items.ts:79-89` registers static conversation-access
  browser assets, status lookup and group updates through request-bound services.
- `src/server/extensions/work-items.ts:91-121` declares the safe, sequential
  `handoff` status/start tool. Execution is a thin call to `host.sessions.handoff`.
- `src/server/extensions/work-items/index.js:8-75` installs the header control,
  composer context, sheet and draft-only `/handoff` hints through public interfaces.
- `src/server/extensions/work-items/state.js:1-125` owns scoped, cancellable,
  deduplicated eligibility reads. It fences replies by person, role and source.
  This is useful presentation behavior, not duplicate transfer authority.

## What is already application-owned

- `src/server/app.ts:290-318` constructs `Handoffs` alongside Projects, Reviews,
  PiSessions and linked sessions; it resolves registered profiles and starters.
- `src/server/app.ts:566-588` permanently installs publication/Pull/research tools,
  workflow hooks, role sections and handoff recovery tasks in `pocket-core`.
  `src/server/app.ts:609-612` exposes handoff invocation through the public host.
- `src/server/handoffs.ts:319-386` owns role prompting and tool invocation.
  `src/server/thread-prompts.ts:1-10` keeps non-editable shared constraints and
  unavailable-role guidance outside optional role text.
- `src/server/handoffs.ts:1715-1780` checks current access, active ownership,
  driver, archive, complete membership, transition choice and full task idleness.
- `src/server/handoffs.ts:1879-2027` atomically creates the independent successor,
  transfers membership/writer ownership, retires the source and records a receipt
  plus durable delivery task. The extension does not implement this transaction.
- `src/server/handoffs.ts:2029-2063` owns group update/archive operations;
  Projects remains responsible for placement validation in the same transaction.
  `src/server/projects.ts:313-378` also reads HandoffsDoc, loops group members and
  calls `handoffs.organization(tx)`: the locality opportunity includes organization,
  not just moving the extension declaration or renaming Handoffs.
- `src/server/workflow-docs.ts:62-66,129-131` fixes stored workflow/handoff kinds,
  versions and scopes. These identities are not extension-owned storage.

This is already much closer to an application module with an optional declaration
and presentation adapter than to an entire workflow implemented as a plugin.
A new class forwarding every call to Handoffs would be a shallow module.

## Lifecycle cost: real, but already handled deliberately

`src/server/reload.ts:43-74` loads Work Items early and on by default, but only
`prompt.ts` is required. Owners can disable Work Items; this is not merely a label.
`src/server/reload.ts:518-526,633-676` fences superseded loads and installs staged
extensions and web declarations only after validation. Registry replacement rolls
back on failure (`reload.ts:728-784`). Failed edits keep the previous version.

`src/server/extension-web.ts:519-567,599-659` checks identity collisions,
resolves only active contributions, commits replacements, discards failed staging
and removes declarations on disposal. These mechanisms serve other extensions too;
a WorkItems migration would not delete the extension loader.

The work-item-specific consequences are distributed:

- `src/server/app.ts:130-140,302-317` retains exactly ordinary Chat as a core
  fallback. Missing managed profiles do not silently become unrestricted Chats.
- `src/server/handoffs.ts:954-1029` keeps managed/retired state and rejects writes
  when a profile disappears. Disabling the extension therefore blocks active
  Worker-style work, not only future creation or visible controls.
- `src/server/handoffs.ts:1766-1772` lets already-accepted intents retain their
  original choice without a declaration, while retaining live safety checks.
- `src/server/handoffs.ts:621-779` keeps delivery as a durable core task with
  blocked/delivered outcomes, rather than losing the receipt on module disposal.
- `web/store.js:339-342,1607` detects availability by the literal installed browser
  module name and calls a literal Work Items extension route. Sidebar grouping,
  movement and archive consumers use that availability (`web/sessions.js:85-98,951`;
  `web/session-moves.js:27-50`). The supposedly optional feature already shapes core UI.

A core module can simplify default-profile availability, initialization and UI
capability discovery. It cannot safely delete unknown-profile or historical-data
handling, especially while third-party workflow declarations remain supported.

## Is there a credible second adapter?

**Confirmed:** repository runtime search finds one `web.workflow(...)` producer:
`src/server/extensions/work-items.ts:65`. There is no second shipped workflow.
Agent Teams is a consumer of linked-session machinery, not a second Work Items
workflow adapter (`src/server/extensions/agent-teams.ts`).

**Also confirmed:** the generic seam genuinely works, rather than accepting inert
configuration. `test/handoffs.test.ts:1293-1399` exercises namespaced custom starters,
dirty/clean transition constraints and operation with default Work Items disabled.
`test/extension-loader.test.ts:227-458` covers frozen declarations, atomic reload,
superseded loads, disposal and reserved identity/privilege rejection.
Tests demonstrate capability, not adoption or a second maintained product workflow.

`src/server/session-workflows.ts:145-176` reserves legacy identities exclusively
for trusted built-in Work Items. Transitions reference profiles within their own
workflow (`session-workflows.ts:197-205`). A drop-in cannot transparently replace
Worker/Reviewer by registering their existing IDs while the built-in is disabled.
Moreover, research roles are fixed (`workflow-research.ts:18-30`), Pull requires
`pull` (`workflow-pull.ts:227`), and publication requires Publish after Land
(`workflow-publication.ts:508-550`). Declarations cannot define equivalent authority.

**Assessment:** alternate process graphs are credible; fully interchangeable
workflow implementations are not demonstrated. Keep this distinction explicit.
The deep-module heuristic “one adapter means a hypothetical seam” favors keeping
future customization internal until a maintained second workflow needs an external
seam. It does not justify silently breaking an interface already made public.
External installs, gallery use and operator dependence were not inspected.

## Recommended shape

Create an application-owned **WorkItems module**, sibling to PiSessions and Projects.
PiSessions owns importing/discovering local Pi history (`src/server/pi-sessions.ts:1,79-103`),
not application work ownership. Borrow its ownership pattern, not its responsibility.

The small caller-facing interface should express work-item context/eligibility,
human-authorized transfer and group organization. The implementation should hide
profile resolution, history evaluation, writer transfer, receipt recovery and prompt
selection. Avoid leaking ExtensionWebs or asking callers to coordinate these steps.
Handoffs can become an internal transfer implementation; it need not be rewritten.
Keep shared root creation in `session-roots.ts` and linked-peer behavior independent.
Reviews should remain its own generic module, with work-item references where useful.

Move the default catalog/graph and lifecycle under that module. Let browser code
and tool declarations remain small adapters, whether physically in core or retained
as bundled presentation code. An extension is not inherently shallow; making callers
learn lifecycle, unavailable profiles and literal route/module names is the cost here.
Use an explicit application capability instead of installed-client-name detection.

Do not add a generic `takeOver`, `advance` or arbitrary prompt-sending interface
for Pip now. Pip-labelled findings are attribution/evidence; range comments belong
to the review/diff model. A future automation caller must cross the same ownership,
access and receipt seam, with a separately decided authority contract. Land/Publish
control remains out of scope and individually approved publication remains unchanged.

## Invariants to retain

1. Single active writer; retired threads and descendant helpers cannot resume writes.
2. Authority comes from actual placed human input, never an inbound courier or role label.
3. Visibility, steering, driver, spend, archive, uncertainty and whole-item idleness
   are checked live, including after asynchronous work and at final admission.
4. Successor, membership, retirement, retry receipt and delivery task commit atomically.
5. Retry/restart does not create a second successor or charge/apply naming twice.
6. Group membership never grants access; hidden members prevent whole-group mutations.
7. Cwd/model/thinking may carry forward; source-local instructions do not become role authority.
8. Historical review/readiness evidence stays factual, not an admission or publication approval.
9. Preserve document/task names, scopes, versions, fork/history contracts and existing receipts.
10. Ordinary Chat and Agent Teams remain usable without mandatory work-item participation.

## Minimal migration stages

1. **Choose the product contract first.** Is Work Items essential application behavior,
   or an optional process? Define the meaning of an existing disabled setting; never
   silently turn a deliberate pause into execution authority. Decide custom-flow support.
2. **Deepen ownership without behavior changes.** Move default resolution and the
   transfer facade behind WorkItems; retain transactions, tasks, identities and existing
   public adapters. Avoid parallel admission implementations or an extra forwarding layer.
   Keep useful generic session controls and extension facilities even if first-party
   Work Items stops consuming them; removal needs its own evidence and contract decision.
3. **Integrate presentation.** Replace module-name availability checks with explicit
   capabilities; connect grouping, picker, hints and organization to the same module.
   Preserve the genuine human submission journal, drafts and initiating-tab navigation.
4. **Retire only unused surfaces.** Remove the default extension lifecycle if chosen;
   retain a thin adapter for real public consumers or remove experimental members in
   a documented release. Update types, reference, policies and tests together.
   Do not tie this stage to Pip takeover or a Land/Publish redesign.

## Compatibility, acceptance and open choices

Current policy favors optional workflows in extensions (C6-C8), mandatory authority,
storage and shared mechanisms in core (C1-C5), and public-only built-ins (C14):
`docs/extensions/policies/core-or-extension.md`. Making Work Items essential requires
an explicit product/policy revision, not an undocumented exception to those rules.

`web.workflow`, `host.sessions.handoff` and the scoped browser additions are public
but experimental since 0.15.0 (`types/pocket.d.ts:96-116,194-198,563-571`;
`docs/extensions/policies/api-stability.md:135-148`). Experimental removal still needs
a minor release and release notes; unrelated stable extension facilities remain protected.
Internal file moves alone are not a public compatibility break. Changed disable
behavior, reserved identities, route behavior and tool ownership require conscious review.

Acceptance should exercise the caller interface: identical graph/options and role
overrides; actual human slash/English transfer; rejection of courier/schedule/helper
authority; busy writers and revoked access; current-diff recheck; exact replay after
restart; accepted legacy recovery; unknown-profile fail-closed behavior; Chat/Teams
independence; whole-item visibility and organization; stale picker/draft/navigation races.
Reuse `test/handoff-execution.test.ts`, `test/session-workflows.test.ts`,
`test/handoffs.test.ts` and `test/handoffs-ui.test.ts`; change obsolete lifecycle
expectations only after the new product contract is decided. No tests ran for this note.

Unresolved: keep third-party graphs, or retire that experimental seam? Keep explicit
pause/new-work opt-out, and with what migration semantics? Keep role policy as private
data or support owner graph editing? Preserve route adapters, or change them atomically
with the bundled client? Who owns any future Pip authority is deliberately unanswered.

This note is excluded from the docs site by `docs-site/src/repo-docs.mjs:319`.
