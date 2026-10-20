# PiP collaborator: core integration checkpoint

Research baseline: **`4f291f8b29b71db75d2a283dc3b13a593df5be9e`** (2026-10-20).
The worker checkpoints below describe the current uncommitted implementation and actual checks.
The later research sections retain historical `path:line` citations to that baseline; statements
there about missing features are not current implementation status. Earlier
`pip-collaborator-mentions.md` and `ssh-workspaces-collaborator-impact.md` remain unchanged.

The requested product is one visible PiP collaborator: explicit mentions receive in-place
answers, and the existing Reviewer can publish code-local findings as PiP. These are distinct
producers, not two independent reviews. “A view” is provisionally interpreted as a review/diff
discussion; main-composer routing remains a clarification, not approved scope.

**Human decision (2026-10-20):** visible authorship is simply **PiP**, with no “via Reviewer”
label. Retain originating role/run/model as internal provenance, not an additional visible
identity. This supersedes the extra-label recommendation in the earlier research note.
The human also asked for model/version settings. The initial shared-model recommendation is
superseded by the explicit separate-model decision recorded below.

**Subsequent human direction (2026-10-20): PiP itself must become core, not an extension.**
This covers the existing private assistant as well as shared collaboration. The proposed end state
has no first-party `src/server/extensions/pip.ts`, no PiP loader/reload lifecycle and no PiP row in
Extensions. Earlier advice to retain that private extension adapter is superseded. Preserve private
conversation authority and durable identities; promotion is not permission to reuse private history
for shared answers. See [the focused promotion research](pip-core-promotion.md).

**Settings placement confirmed by the human (2026-10-20):** PiP gets its **own top-level Settings
page**, alongside Agents and Providers: **Settings → PiP**, not nested under Agents. The human
accepted the overall core-promotion direction with this adjustment. Invocation-rights and
pause-scope policies remain open.

**Model split confirmed by the human (2026-10-20):** the **PiP collaborator model**—used for
explicit mentions in collab chat or review discussions—must be separate from the **PiP chat
model** used in private PiP conversations. Keep two independently configurable selections on
Settings → PiP; changing either must not change the other. This supersedes the earlier proposal
to share one selection. Reviewer finding publication still uses the actual Reviewer run and
requires no additional PiP model generation.

## Worker checkpoint: core/settings foundation (2026-10-20)

This first checkpoint implemented the private/core/settings foundation, not the complete
collaborator feature. The continuation checkpoint below records the subsequent Reviewer slice:

- PiP's private tools, prompt, compaction hook and follow task are installed by `app.pip` before
  Harness recovery. Wiring moved to `src/server/pip/private-agent.ts`; the first-party optional
  extension is removed and its basename remains reserved against stale/drop-in replacements.
- Native `pipEnabled` preserves a legacy disabled installation until an explicit native change.
  Pausing retains durable registrations/receipts and stops private runs/compactions. Paused startup
  stops unfinished private generations before general resumption; ordinary threads retain their
  exclusion of private PiP tools.
- Top-level Settings → PiP owns pause, private compaction and independent **PiP chats** /
  **Collaborator** model/thinking controls. Private chat keeps its stored model and owner/idle
  configure transaction. Collaborator is separately revisioned, starts unset, can be configured
  while private PiP works, and neither creates private chat nor changes ordinary model defaults.
  At this foundation checkpoint, the UI explicitly said mention replies were not connected yet.
- Owner-only settings routes pin authenticated identity across body reads. Invalid/stale selections
  do not overwrite settings; failed native-setting saves roll back live config.

Verification: `npm run format`, `npm run lint`, `npm run check`, changed-web `node --check` and
`git diff --check` passed. The final focused server run passed **55/55** tests across PiP,
compaction/models/settings, schedules, agent settings and native Work Item settings; the isolated
app extension-inventory/restart case passed **1/1**. These use disposable data and scripted models.

Validation blockers remain explicit: the new mobile Settings/model-picker test cannot run here
because its disposable server gets `listen EPERM` on `127.0.0.1`. Socket/browser tests and full
`npm test` are deferred, not passing claims. A broader 75-test run had 71 passes, three `fs.watch`
`EMFILE` failures and an unchanged repo-watch fixture's `/var` versus `/private/var` assertion.
Serializing the affected suites did not resolve watcher availability; a temporary canonical-path
fixture probe also exposed a checkout clone race, and that unrelated fixture edit was reverted.
The UI detector reported only an existing `transition: width` warning at `web/style.css:735`.
No restart, real model call, commit or publication was performed.

### Continuation: Reviewer publication, ranges and native results

The current diff also implements:

- `app.pip` owns the core `review_comment` tool and generation hooks through its private
  `pip/reviewer.ts` implementation. Only the actual active main Reviewer can inspect/post;
  runtime task ancestry, current requester, source/destination and writer authority are checked.
  The existing Reviewer produces findings; publication creates no additional model request.
- Inspection returns a complete bounded single-file diff and destination-bound observation.
  Posting rechecks the observation and every old/new captured line. Ranges use additive
  `startLine`, existing inclusive-end `line`, at most 100 lines and 8,000 characters of complete
  evidence; legacy single-line context keeps its 1,000-character contract. Human range controls
  were added in the next continuation, described below.
- `Reviews.commentAsPiP` shares human anchor/reply/retry/capacity validation inside the caller's
  transaction. A successful comment and its bounded durable receipt settle atomically, with
  visible author **PiP** and internal requester/role/task/call/generation/provider/model provenance.
  Publication holds the existing exclusive workflow reservation across evidence reads and settlement.
- Successful receipts are grouped by the first input submission of the real episode, not changing
  generation task IDs. Core clears provider-supplied native claims in ordinary and private PiP
  selections; the latter intentionally omits `pocket-core` and installs the scrubber itself.
  On yield, it attaches only that
  episode's successfully posted references, with bounded public projection. Another hook may
  continue a yielded candidate answer; this attachment does not attest ultimate episode completion.
- The native **Diff comments** disclosure follows newest/older answer defaults and preserves manual
  state. Tool-card **Open in diff** and list rows share original-conversation/thread navigation,
  with source-access preflight, superseding-link/person/route/pagehide fencing, and the existing
  lazy diff reveal/focus machinery. Whole-range mismatch retains an outdated original discussion.
  Long tool receipt metadata is allowlisted rather than losing its navigation at generic clipping.
- Native PiP pause conservatively blocks new Reviewer posts; Plan mode also blocks posting.
  The previously proposed Reviewer exception was never approved. Inspection/recovery receipts do
  not authorize a fresh effect. Owner prompt overrides and existing resolution permissions remain
  unchanged.

Continuation checks: **65/65** focused server/private/settings/projection tests, **7/7** non-socket
Reviews tests, **2/2** registered denial/private-claim clearing cases, and **52/52** socket-free disclosure,
navigation, range, diff and lifecycle tests passed. The pagehide navigation, long-receipt
projection and private-provider claim regressions were first observed failing at their owning
modules, then passed after repair.
Final `npm run format` (excluding the three preserved preexisting notes), `npm run lint`,
`npm run check`, changed-browser JavaScript syntax and whitespace checks passed.

Reviewer runtime validation is incomplete: the helper's full attempt fails during genuine
Worker-to-Reviewer setup with `sandbox-exec: sandbox_apply: Operation not permitted`. The six
Reviewer-dependent cases—including positive publication, revocation/locking, nested codemode,
restart and fork receipt/link behavior—are written and typechecked but not verified at runtime.
Do not substitute mock authority or bypass native Git confinement to make them green. Browser,
phone/Back/scroll/focus and full-suite validation remain unavailable/deferred for the socket,
confinement and watcher reasons above. Component/store fixtures are not real-device evidence.

### Earlier continuation: shared mentions, human ranges and accounting

This checkpoint added explicit mentions and human multi-line review comments. Its tool-free runner and numeric range inputs were superseded by the user-feedback continuation below:

- `app.pip` owns `pip/mentions.ts`: admission is atomic with a human chat/review post; generated
  service messages cannot recursively invoke it. Existing steering, current visibility/token,
  take-turns and budget checks remain in force. Viewers keep ordinary discussion access but gain
  no spend permission. Private/owner-only context is excluded. PiP pause blocks new generation
  and Reviewer posts; no proposed exception or broadened viewer authority was enabled.
- The Collaborator selection is required, pinned by model/thinking/revision, and independent
  from private PiP and the Reviewer. Registered model execution receives bounded source JSON,
  no tools/private context/session reuse, and bounded public text only. Unsupported/tool-call
  results fail closed and raw provider failures never become shared status text.
- A core durable task runs in an independent ownerless lane, not on the source's GenerationTask
  or workflow-idle reservation. Explicit visibility/room/conversation checks hide the lane even
  while reads wait on its first creation commit. The active index is bounded at 64; historical
  jobs and usage receipts live in separate bounded document families, not a lifetime global map.
  Source-message deduplication survives the rolling 500-message chat and restart; forks inherit
  no jobs. Terminal receipts retain identity, usage and reply references, not execution prompts
  or a duplicate answer body.
- Dispatch commits an uncertain checkpoint before the external request. Recovery interrupts an
  uncertain attempt without automatically generating again; a saved ready result delivers once
  without another model call. Remote execution is not claimed to be exactly-once. Delivery
  rechecks requester authority, turn and exact source. Source disappearance suppresses delivery.
- Spend's auxiliary ledger atomically records actual reported model/provider/usage against the
  immutable requester and original source. Exact replay is deduplicated, conflicting reuse
  rejected, rollback/restart preserved, and person/source/linked-team totals include the usage.
  It never changes source UsageDoc attribution. Cancellation can retain reported usage but
  cannot publish or resurrect a terminal job.
- Chat replies carry an exact parent snapshot. Review replies stay in the original thread,
  preserving its inclusive anchor and unresolved/resolved state. Native queued/working/final
  status replacements traverse Room and the real browser store without duplicate notices.
  Chat autocomplete adds a service choice, never a synthetic user. Settings guidance points
  to the independent Collaborator picker.
- Human line composers expose Start/End inputs on one file/side and disclose complete captured
  context. They reuse scoped omitted-line reads and old/new numbering; invalid, missing,
  excessive or over-100-line evidence disables submission. Draft endpoints and uncertain retry
  identity survive reopening; changed ranges get a new request. Single-line requests retain
  the old limit and omit `startLine`. CRLF evidence follows the displayed diff convention;
  Reviewer observations still hash the raw patch to detect drift.

The new runtime/transport run passed **15/15** cases (10 runtime cases plus five counted
store/lifecycle cases), using temporary application data and registered scripted providers only.
It covers in-place replies, source-only generation, immutable payer/model, non-invocations and
permission/turn/budget/pause/model denials, tool-result rejection, bounded escaped context,
workflow idleness, revocation, source eviction, cancellation, restart and first-lane privacy.
Live-status replacement, late-turn delivery and lane-creation race regressions were first observed
failing at their real owners, then passed after repair. Auxiliary accounting has its own **3/3**
focused cases. These cases are included in, not additional to, the final integrated batches:

- **78/78** server/private/settings/model/compaction/projection/schedules/prompt/timing/native
  Work Item settings, mention-runtime and auxiliary-accounting cases.
- **89/89** socket-free Changes/diff/range/mention/Reviewer/navigation/clock/store/lifecycle cases.
- **7/7** positively selected non-socket Reviews cases.
- **2/2** real registered Chat/Worker denial and private provider-claim clearing cases.
- **1/1** extension-inventory/native-pause/restart compatibility case.

Total: **177 focused passing tests**, with no full-suite success claim. `npm run format`
(excluding the three preserved preexisting notes), `npm run lint`, `npm run check`, browser
JavaScript syntax checks and tracked/untracked whitespace checks passed. The preserved notes
were compared byte-for-byte against their backups.

The unavailable genuine Reviewer/browser/device/full-suite checks above remain unavailable;
these new checks do not replace them. No live application data, real application provider call,
restart, commit or publication was used.

### User-feedback continuation: work tools and direct review interaction

The human rejected the missing review mention picker, discussion-only PiP context and numeric
Start/End fields. Those choices have been replaced, not treated as accepted product behavior:

- Chat and new/reply review composers now share `web/mention-composer.js`: caret-aware person
  and PiP choices, click/arrow/Tab/Enter/Escape handling, IME safety and posted highlighting.
  Viewers can select people; PiP keeps existing invocation permissions.
- Diff gutters own inclusive selection and live highlights through drag, Shift-click or touch
  endpoint taps. There are no numeric range inputs in the composer. Evidence, old/new omitted
  context, CRLF, retry identity and saved endpoint drafts retain their previous contracts.
- Shared PiP receives current thread/project/Work Item metadata and recent public coding history.
  Its app-provided `work_context` tool reads more history, visible same-item threads, discussions,
  current folder-confined code/file discovery, Changes and paged diffs. `Transcripts.page` owns
  cancellable paging and `WorkItems.context` reuses the owning public member/title projection
  without executing handoff eligibility or Git probes. Source thinking/system/private metadata
  is not included; private PiP tools, sessions/history, app data, shell and writes remain excluded.
- Reads use the actual requester's local/SSH backend and recheck source, access, turn, destination
  and current membership before/after awaits. SSH code inspection uses the existing native
  descriptor-checked reader and does not fall back to weaker reads if unavailable. Bounds are
  four model responses, eight reads, one minute, fixed context/results and no automatic retries.
- Each returned response is atomically recorded under its own immutable usage receipt. Model,
  payer and source stay pinned across continuations; a changed Collaborator selection affects
  later questions only. Budget exhaustion or revocation stops further model calls. This model's
  own reasoning/signatures remain ephemeral for provider protocol continuity, never public.
  Recovery still interrupts an uncertain attempt, including a partially completed tool loop.

Owning regressions first failed for the missing review picker/highlights, range interaction,
IME/caret behavior and work-reading runner, then passed after their production fixes. Checks use
scripted providers and isolated temporary data, not real providers or live application data.
Current Work Item read scope reuses its existing filtered projection; the unavailable genuine
multi-role Reviewer/transfer and SSH-native integration proofs are not implied by local tests.

Final feedback validation passed **82/82** focused server cases (including 14 mention-runtime
and three auxiliary-accounting cases), **107/107** socket-free UI/lifecycle cases, **7/7** selected
non-socket Reviews cases, **2/2** registered denial/private-claim cases and **1/1** extension
inventory/restart compatibility case: **199 focused tests total**. The lifecycle fixtures gained
an inert range-hook import and valid captured line evidence; no production guard was relaxed to
make them pass. Formatting, lint, type/reference checks, browser-JavaScript syntax and whitespace
checks passed. The UI detector found only the preexisting `transition: width` warning in
`web/style.css:735`. The three preserved notes remain byte-identical. Full `npm test`, native
Reviewer-positive cases, actual SSH-native reads and browser/device QA are not claimed; the known
sandbox/socket limits were not retried or bypassed. No commit, publication or live restart.

### Further feedback: quiet composers and human-applied suggestions

The human asked to remove routine warnings/instructions and let people apply code suggestions
proposed by either a human or PiP. This phase also attempted custom public search; the latest
human direction below supersedes and removes that attempt.

- Review composers now show their location, text and actions, without routine busy notices,
  range/context ceilings, duplicate context panels or instructions for mentioning PiP/selecting
  lines. Server validation remains; a genuinely invalid selection has a short actionable error.
- The temporary custom public-search/document tool and its tests were subsequently removed
  entirely, not hidden or replaced. One earlier credential-free endpoint check returned a CAPTCHA;
  no bypass, fallback or retry was attempted and the isolated research download was cleaned up.
  Search is now deliberately deferred until a common capability can serve ordinary threads and
  PiP. The existing public-document reader remains owned by Research/browser, not a PiP tool.
- A fully closed top-level `suggestion` fence replaces the thread's exact inclusive new-side
  range. Humans can insert one with current captured code, and PiP can propose one after reading
  current code. Ordinary examples and incomplete/quoted/nested fences are not edit actions.
  The read view escapes code, retains mentions, makes public citations clickable and exposes
  **Apply suggestion**. Posting or invoking PiP never applies it.
- `Reviews.applySuggestion` derives the saved message/anchor and pinned destination, verifies
  complete current evidence, and reuses the existing Workspace editor's live writer, turn, busy,
  path/protected-file, UTF-8, revision and local/SSH save rules. Workspace carries an internal
  destination guard through save authorization, including remote finalization. Human application
  makes no model call, Git commit or automatic resolution. Viewer discussion rights still do
  not grant file edits. New suggestion replies can bind a current destination on legacy threads
  without promoting legacy roots or allowing detached/stale comments to write.
- A bounded private `ReviewSuggestionsDoc` claim precedes the filesystem effect. Calls serialize
  through settlement; once claimed, an application is never written again. Manual **Check result**
  only compares the complete file to its expected output revision, including after restart or a
  lost acknowledgement. A nonmatching uncertain result stays unconfirmed. HTTP success means
  applied; uncertain outcomes are 409, not a misleading success. Native message status carries
  only state/actor/time. New controls require `reviewSuggestions >= 1`.

Owning missing-feature and destination-retarget regressions were demonstrated red before repair.
A registered-provider review mention now reads actual temporary code, posts a PiP suggestion in
its original thread, leaves the file untouched, and then lets a human apply it without another
provider call. Tests use only isolated app data, scripted models and controlled network transport.
The **historical pre-consolidation checkpoint** passed **88/88** core/settings/mention/search/accounting tests,
**125/125** socket-free UI/lifecycle tests, **42/42** suggestion/file-save/native-helper fixtures,
**7/7** selected Reviews tests, **2/2** Reviewer denial/private-claim tests, **1/1** compatibility
inventory case and **1/1** public-reader transport case: **266 focused passing tests total**, not
an addition to the earlier checkpoints. Format, lint, type/reference and browser syntax checks
passed. The UI detector still reports only the preexisting width-transition warning. The native
helper fixtures do not prove SSH transport/confinement. A sibling HTTP check hit the known
`listen EPERM`; full `npm test`, browser/device and genuine native Reviewer/SSH integration are
not claimed. The live CAPTCHA check is not a passing search-availability proof.
No live restart, commit, publication or application-provider request was made.

### Latest continuation: remove duplication and defer common search

The human explicitly directed removal of the custom web implementation and other avoidable
copies. No interchangeable search capability was established in Coop: known-URL document reads
and installed Pi extension/MCP availability do not establish a shared search interface. There is
no replacement scraper, provider fallback, tool exposure or open provider-choice question.

- Deleted the custom web implementation and search-only tests, and removed its tool/prompt
  plumbing. `work_context` remains the only shared PiP tool. A real registered-provider negative
  case still verifies that a fabricated claim to the removed tool cannot execute it.
- Pi Agent Core's installed public `runAgentLoop` now owns continuation, schema validation,
  tool execution and ephemeral result assembly. It is a direct pinned 1.1.0 dependency; only the
  root dependency entry changed in the existing lockfile, with no install/download. Requests
  still use Coop's canonical bound model runtime. PiP owns admission, private isolation,
  authorization, four-response/eight-read/one-minute limits, zero retries, awaited per-response
  accounting, durable uncertainty and exact-source delivery. Error/aborted responses remain billed
  when usage is reported; a restart never regenerates uncertain work.
- Workspace owns `sourceFiles`/`sourceFile`, including narrow relative-path policy, owner-independent
  folder/private-root confinement, bounded UTF-8 bytes, live requester/destination rechecks and
  remote descriptor-checked reads. It reuses `fileList`'s local Git-aware versus remote dispatch,
  not another walker. One private-root policy also serves existing local/remote readers and
  editors without turning shared reads into owner-strength file access. The discovery regression
  first failed for exposing an ignored file and omitting tracked dotfiles, then passed after repair.
  Canonical target names are also checked so an in-folder alias cannot bypass protected `.ssh`/
  `.git` segments; the real shared-tool denial regression was demonstrated red before that fix.
- Models owns explicit picker model/thinking/catalogue validation for Commands and both PiP
  selections. Independent storage/revision and private owner/idle policies remain with their
  existing owners. Reviews owns generic anchor constraints; Reviewer still validates complete
  strict patch evidence and provenance rather than reusing the tolerant display parser.
- The DOM-free `web/review-message.js` is the single suggestion grammar and action-index owner
  for authoritative stored-message application and native rendering. The UI regression applies
  the second eligible suggestion among ordinary, quoted and differently fenced code using index 1.
  `web/pip-mention-text.js` likewise shares literal mention parsing between admission and display.
  The real admission regression first showed code-separated fragments purchasing a false mention;
  it now rejects that input without a provider request. Short or suffixed closing fences also
  cannot turn a code example into paid work; the short-fence case was demonstrated red first.
  UI fixtures separately retain literal code, human mentions and native highlighting behavior.

Fresh, non-overlapping validation passed **277 focused tests**: **82** core/settings/mentions/
accounting/role/native-setting cases, **125** socket-free UI/lifecycle cases, **50** suggestion/
file-save/native-helper/source/discovery fixtures, **8** selected Reviews cases, **2** Reviewer
negative/private-claim cases, **8** Commands/resend cases, **1** extension compatibility case and
**1** public-reader transport case. These results supersede, rather than add to, the earlier
266/199 checkpoints. The shared-parser backend application tests pass alongside the UI index
cases. `npm run format`, `npm run lint`, `npm run check`, browser JavaScript syntax, tracked and
untracked whitespace and protected-note byte checks passed. Logs: `/tmp/coop-pip-dedup-*.log`;
red regressions: `/tmp/coop-pip-mention-parser-before.log` and
`/tmp/coop-workspace-source-before.log`; the protected-alias regression is recorded in
`/tmp/coop-pip-source-alias-before.log`. The fence regression is recorded in
`/tmp/coop-pip-mention-fence-before.log`.

Tests use isolated temporary data, registered faux/scripted providers and local native-helper
fixtures. No live application-provider request, live application-data read, server restart,
commit or publication was performed. The six native Reviewer-positive setups remain blocked
by confinement and were not retried. An owning Reviewer CRLF integration regression remains
unverified with those setups; byte-preserving suggestion/native-helper fixtures are not a
substitute. Browser/device/Safari/layout/touch, genuine SSH transport/confinement and full-suite
validation remain unavailable or deferred, not passing claims.

## Historical research: confirmed constraints at the baseline

- **Private PiP is not the collaborator runner.** `Pip.available/ensure` are owner-only;
  `#person` resolves the private conversation's owner, and `#session` grants that person's
  visible sessions (`src/server/pip.ts:224-237,298-361,475-506`). Its stored selection retains
  session controls, schedules, artifacts, codemode and memory; removing bash/write/edit is
  not an answer-only boundary (`src/server/pip.ts:54-75`). `canSee` protects private PiP even
  along handoff ancestry (`src/server/app.ts:1651-1701`). Never pass shared questions through
  that private history, even when the asker is the owner.
- **Chat posting is discussion, not model admission.** `postChat` checks visibility, trims and
  bounds text, resolves an optional transcript quote, and deduplicates inside the rolling chat
  document; it does not require steering/driving/spend or create model work. Mentions currently
  resolve only configured people and produce notifications (`src/server/collab.ts:82-224`).
  `ChatMessage` has human `userId/name`, no service actor or chat-to-chat reply reference;
  chat retains 500 messages and forks current content (`src/server/docs.ts:447-474`). A retry
  record that disappears with the oldest chat message is insufficient for durable invocation.
- **Do not deliver through `Pip.send`/`Commands.submit`.** Pip's submit uses an assisted-person
  request and `PIP_NAME` as `via` (`src/server/pip.ts:439-473`). `Commands.submit` checks live
  identity, visibility, driver, model and spend, then queues/steers the coding agent; `via` is
  server-only and changes the request from the person's own words to work sent for them
  (`src/server/commands.ts:889-1033`). A collaborator answer must instead append discussion.
- **Work Items is now core.** `app.workItems` owns the catalogue, projections and writer rules;
  it delegates transfer mechanics to private `Handoffs` (`src/server/work-items.ts:74-109`).
  Core installs its tools/tasks/hooks independently of optional extensions
  (`src/server/app.ts:550-576`). Management includes missing/non-Chat profiles, membership and
  workflow state; retirement is enforced from active-thread ownership and durable workflow state
  (`src/server/work-items.ts:280-347`). Do not put a Pip service lane into Work Item membership,
  activate it as a writer, or loosen these checks to allow discussion replies.
- **`background: true` does not solve handoff blocking.** Transfer/fetch idleness scans
  `LiveDoc`, inbox, pending reports, **every nonterminal task attached to each member**, and
  descendant subagents (`src/server/handoffs.ts:1207-1269,1334-1348`). Its exemptions are narrow
  main-invocation/placed-courier rules, not a general background-task exemption
  (`src/server/handoffs.ts:1272-1331`). Existing Pip follows avoid this by living in private Pip's
  conversation, not the followed source (`src/server/pip.ts:1369-1423`), but that private
  conversation is not safe to reuse for collaborative Q&A.
- **Spend needs an explicit integration, not just an admission check.** Existing accounting
  charges usage to `requesterOf(id)`, else root `createdBy`, else owner
  (`src/server/spend.ts:114-145`). Attribution follows the newest attributed input, with a root
  fallback (`src/server/attribution.ts:179-218,250-256`). Budgets aggregate subagents and linked
  families, not Work Item membership (`src/server/spend.ts:180-259`); owner person-budget checks
  are exempt (`src/server/spend.ts:252-255`). A detached `completeSimple` call has no automatic
  ledger update. Pip compaction provides an auxiliary-call pattern: same selected model,
  persisted result memo and once-per-task `UsageDoc` accounting, including unsuccessful model
  output (`src/server/pip-compact.ts:371-496`). This is not proof of exactly-once provider calls.
- **Do not use compaction as the new lane's security policy.** It strips known outside fences
  and non-own tool output when summarizing private Pip; it does not isolate shared audiences
  (`src/server/pip-compact.ts:65-164`). Keep the lane's supplied context bounded from inception.

## Proposed narrow implementation seam (not implemented)

1. **Extend the existing `app.pip` module**, with collaboration as an isolated internal
   implementation rather than a second app-level collaborator module. See the module-ownership
   follow-up below. Do not widen private-owner tools or install `PIP_EXTENSIONS` for mention work.
   The smallest runner is a durable task making a bounded, tool-free model request over explicit
   source context. If iterative reads are later required, expose only typed source-bound read
   operations, not coding tools, arbitrary paths, codemode, memory, sessions, approvals, schedules
   or handoffs.
2. In the same transaction as a newly accepted human message, create a durable invocation receipt
   keyed by source conversation/surface/message/service, immutable question payload and explicit
   attempt. Persist pending/not-admitted state rather than relying on the fire-and-forget
   notification callback. Do not discover work by rescanning chat text after restart or fork.
3. **Choose a separate, internal ownerless conversation as the task anchor**, not a source task
   and not a delegated child. Keep source ID as data only; no `SubagentsDoc`, `linkedFrom`,
   Work Item membership, writer reservation or inbox entry in the coding thread. A per-invocation
   anchor simplifies immutable payer/model provenance; a shared service anchor requires explicit
   per-job billing and serialization. Either requires a new internal lane/access/retention
   contract: simply omitting a catalogue entry is not sufficient authorization, and using
   `pip: ownerId` would select private Pip semantics. Core must prevent ordinary room access,
   prompting, configuration, listing and tool execution against internal anchors.

    Supporting SDK evidence, **installed dependency rather than repository-commit evidence**:
    `@earendil-works/pi-durable` **1.1.0**, `dist/types.d.ts:219-246`, supports conversation-owned
    or task-owned tasks and separate ownerless conversations; there is no ownerless-task option.
    Background tasks are excluded from ordinary SDK idle/abort cascades, unlike Coop's explicit
    Work Item scan. App recovery already scans all stored conversations, not just catalogue
    entries (`src/server/app.ts:730-790`), but recovery/accounting for a new internal lane still
    needs design. This research does not establish a ready-made safe collaborator runner.

4. Bind actual requester/token/scope, original source/destination/cwd, surface/thread, model and
   thinking at admission. Re-resolve and reauthorize before/after context I/O, before generation
   and before publication. Answer in the original discussion even after handoff; do not borrow
   the successor's writer authority. For initial scope use question/quote plus bounded same-
   discussion context. Destination reads must retain the captured human and pinned source;
   source-backed backend factories distinguish explicit user authority from agent attribution
   (`src/server/workspace-backend-factory.ts:16-67`). Do not run remote reads at an internal
   anchor's default host/cwd. Review-specific read/range policy belongs to the Reviewer section.
5. Explicitly pin the authorized model and use the existing provider runtime without fallback.
   Private Pip's named-model authorization searches its owner's private messages and standing
   instructions (`src/server/pip.ts:526-620,652-717`): do not reuse it for shared invocations.
   `providers.problem` is an available fresh sign-in check (`src/server/pip.ts:706-717`). Check
   provider startup recovery and invocation permissions explicitly; chat visibility is not enough
   (`src/server/app.ts:1704-1725`). Choose budgets before coding: checking source limits while
   charging a hidden anchor will otherwise let source-budget spend escape. Conversely writing
   auxiliary usage onto the source uses whoever is currently asking there, not necessarily this
   asker. Add explicit durable payer/source accounting, or a fully specified fixed-payer lane and
   source aggregation; preserve once-per-attempt accounting and expose quota holds safely.
6. Checkpoint a bounded generated result before delivery. In one delivery transaction, recheck
   access, append a deterministic service-authored answer, and mark its receipt delivered.
   **Actor is server-authored metadata, never a `config.User`, token, human role or caller-supplied
   identity.** Keep visible actor `pip` separate from requester/payer/model/producer provenance.
   Human chat/review APIs must not accept service authority; service posts never trigger mentions.
   Review's current human sink is a useful recheck/receipt precedent but not directly reusable as
   Pip: it constructs `userId/name` from the current human (`src/server/reviews.ts:597-714`).
   Add an internal capability, not a public `asPip` flag. Preserve document kinds/scopes/history/
   fork contracts and project only safe answer/status metadata, not job payloads or raw errors.

## Product choices still required

- “A view” likely means review discussion, but main-composer mentions are a separate routing choice.
- Steering collaborators only (recommended first slice), or an explicit viewer-Q&A permission?
  Viewers can currently chat but must not be upgraded to model invocation merely by spelling
  `@Pip` (`src/server/app.ts:1704-1740`; `SECURITY.md`, viewer/steering sections).
- Does take-turns cover Pip questions? Does Work Item execution pause also pause tool-free Q&A,
  or only managed work? Keep these choices distinct from retired-writer file restrictions.
- Private PiP chat and collaborator mention models are confirmed separate; see the settings
  follow-up below. Still open: initial collaborator default, who pays, and whether source
  budgets include Q&A.
- Bound context to question/quote only or include same-chat history/main transcript excerpts?
  All eventual source readers share the answer, not just the asker.
- Reserved `@Pip` grammar/name collisions; quoted/code literal handling; explicit mention on every
  follow-up; archived/deleted-source admission; cancellation/retry authority, rate/capacity limits,
  result retention, and behavior on disable, revocation or provider failure.

## Follow-up: extend the existing PiP deep module

### Human direction and confirmed code

The human wants to extend an existing PiP module if one exists, rather than scatter new reply/review
logic into unrelated callers. **It exists:** `PocketApp` constructs `readonly pip = new Pip(this)`
(`src/server/app.ts:313`), implemented by `Pip` in `src/server/pip.ts:182`.

The existing module already hides meaningful behavior: private-conversation creation/tuning,
owner/session checks, bounded action counts, durable follow/report tasks and replay-aware session
submission (`src/server/pip.ts:182-218,298-382,439-506,1341-1425`). Its interface is broader than
“a couple of reply functions”; its current responsibility is the owner's session-management
assistant, not shared discussion. A large class alone is not evidence of depth, but reimplementing
these behaviors in callers would clearly lose locality.

Important distinctions:

- `Pip.send` sends work to another **coding agent**, through `#submit`/`Commands.submit`; it does
  not append a people-chat response or review comment (`src/server/pip.ts:439-473,1001-1028`).
- The `reply()` helper in `extensions/pip.ts:25` only formats a tool result. It is not a discussion
  reply writer. That file declares the tools/prompt/tasks selected in private PiP's conversation
  (`src/server/extensions/pip.ts:147-155,290-325,653-690`).
- Existing discussion writers belong to `Collab.postChat` (`src/server/collab.ts:82-154`) and
  `Reviews.comment` (`src/server/reviews.ts:597-720`). They currently write human-authored records.
  Their generic persistence/anchor rules should not be duplicated inside PiP.
- Private tools resolve authority from the owner of the private PiP conversation
  (`src/server/pip.ts:475-506`). Extending the **module** does not justify sharing that runner,
  history or authority with collaborators. `available()` also means owner + private extension
  enabled today (`src/server/pip.ts:224-226`), not shared collaborator availability.

### Recommended locality and interface

Retain `src/server/pip.ts` as the entry point and `app.pip` as the app-facing module. Add an internal
same-named folder as this repository already does for larger modules:

```text
src/server/pip.ts                 core entry point; private + collaboration interface
src/server/pip/private-agent.ts   moved private tools/prompt/hooks; no loader module
src/server/pip/collaboration.ts   isolated question/publication implementation
src/server/reviews.ts            generic diff anchors, evidence, comments, replies, status
src/server/collab.ts             generic chat persistence and discussion replies
```

These are proposed file locations, not an instruction to move/rewrite all existing PiP code.
Additional internal files are justified only if the implementation actually needs them. Preserve
`pip-compact.ts` behavior and move the private agent adapter under the application-owned PiP
implementation, removing its optional extension entry. No parallel `app.collaborator` or public
framework is needed. Core can still use Durable's tool/prompt/hook registration machinery without
making PiP a loader-managed extension.

A small app-facing interface could express these operations (names are illustrative):

- **Accept a newly committed human discussion message**, within its existing transaction. PiP
  hides mention parsing, invocation authorization, settings snapshot, lane/task creation and
  bounded durable receipt/status; callers do not coordinate those steps or spawn detached work.
- **Publish a Reviewer finding**, derived from the actual tool invocation. PiP hides producer
  checks, active-main-Reviewer admission, reservation lifetime, service authorship/provenance and
  stable publication identity. The existing Reviewer run supplies the finding; it starts no PiP
  generation. Return the actual durable source/thread reference for tool and final-summary links.
- **Expose safe review-result references/settings** where needed for native projection/configuration.
  Do not expose raw internal lane histories, arbitrary service-author writing or owner authority.

The mention runner's answer delivery can remain private implementation: no general public
`replyAsPiP(userId, text)` escape is needed. Keep mention and Reviewer-finding inputs distinct:
a mention receipt authorizes only that isolated answer, never a Reviewer action. Finding identity
comes from actual tool `conversationId/taskId/callId` and verified run ancestry, not a caller's
claimed role or mention receipt (`src/server/handoffs.ts:1190-1205` is an existing task-ancestry
precedent, not a ready-made Reviewer guard). A deep interface hides context isolation, source/payer
binding, durability and replay—not merely forwards a renamed `Reviews.comment` call.

### Division of responsibilities

- **PiP:** its visible identity/settings, explicit-mention orchestration and isolated generation,
  source-bound context and accounting, and Reviewer-to-PiP publication orchestration. Internal
  isolated lanes are still required even though both modes live behind the same module entry.
- **Reviews/Collab:** generic records, threads/replies, anchor/range evidence and limits,
  idempotent transaction-aware append and ordinary human permissions. Add narrowly scoped internal
  service-author sinks rather than a browser-controlled `asPiP` parameter. Avoid nesting their
  existing public commit methods inside another commit; share the accepted transaction where
  message/job admission or reply/delivery receipt must be atomic.
- **WorkItems/workflow policy:** existing main-thread role, pause, writer and exclusive-operation
  rules. PiP consumes them; it does not become a second workflow engine or private-owner bypass.
- **Tool registration:** all first-party PiP registration becomes app-owned. Private tools/prompt
  remain selected only in the actual private PiP conversation; installing them into the general
  core tool list indiscriminately would be a regression. The Reviewer comment tool is a separate
  thin adapter backed by `app.pip`, registered alongside native managed capabilities
  (`src/server/app.ts:550-576`). Its mandatory policy permission and runtime checks are both
  required. Core installs follow/collaboration tasks before recovery, preserving legacy follow
  task names, versions, checkpoints and receipt keys; no task depends on a PiP extension load.
- **Presentation:** keep private panel code in `web/pip.js`; use `web/chat.js`/`web/reviews.js` for
  in-place discussion, `web/diff.js` for anchors/navigation and `web/transcript.js` for the tool
  result/final collapsible index. These adapters consume committed references, not reimplement
  PiP admission, authorship or billing. A common navigation/result-rendering helper is worthwhile
  where tool-card and final-summary callers genuinely share behavior.

`PocketHost.pip` deliberately exposes a Pick of the existing owner-assistant operations
(`src/server/host.ts:277-303`). It is an internal built-in-only host member, not a public drop-in
contract (`docs/extensions/policies/api-stability.md`, “host”). New collaboration entry points need
not become extension-facing members. Moving the private adapter removes its need for this host
indirection, but remaining real callers matter: the schedules extension still uses
`host.pip.countSchedule` (`src/server/extensions/schedules.ts:79-87`). Do not remove that behavior
just because PiP is promoted.

Preserve owner checks, stored task/doc identities, follow receipts and deliberate execution pause.
Replace loader-dependent availability with native policy; the shared collaborator's pause policy
and its relationship to Reviewer publication remain explicit product choices. Do not change
`available()`/`stopAll()` semantics by accident while replacing their extension coupling.

This refines the earlier “small core collaborator” proposal: **same core PiP module, separate
internal execution contexts, existing generic discussion storage**. It is design research only,
not a source refactor or an assertion that a safe shared reply runner already exists.

## Follow-up: implications of full core promotion

The human's direction removes the optional-extension premise entirely. Model/budget policy,
service authorship, durable recovery and invocation permissions belong to the app under the
repository's C1-C5 rules; first-party Work Items is a directly applicable precedent
(`docs/extensions/policies/core-or-extension.md`). This is more than marking the existing module
“required” or hiding its Extensions row.

Recommended migration, preserving current private behavior before adding collaboration:

1. Move private tools, prompt, hooks and follow-task registration into application-owned PiP
   startup. Keep private capability selection separate from ordinary and
   mention conversations. The persisted `pocket-pip` registration name may remain as an internal
   compatibility identity; it does not require a file/loader extension or an owner toggle.
2. Remove the PiP entry/source from `src/server/extensions/` and loader order/title inventory.
   Reserve `pip.ts` as an app-owned module name, as for Work Items; do not let a drop-in or stale
   built-in file recreate a second PiP lifecycle (`src/server/reload.ts:44-107`). Preserve reserved
   existing private tool names.
3. Put native PiP controls on their own top-level Settings → PiP page: execution pause/resume, existing compaction
   threshold, and separate chat/collaborator model selections. Storage/migration details and
   independent thinking controls remain design work. Compaction
   already has a native settings setter; only its control currently lives in Extensions
   (`web/sheets/extensions.js:151-185,359-361`; `src/server/app.ts:2999-3015`). Core presence does not
   imply unpausable automation, unconditional model requests or a change to provider credentials.
4. Add an explicit native execution setting. As a compatibility recommendation, read the old
   `extensionChoice("pip.ts")` only while the new field is absent, following `workItemsEnabled`
   (`src/server/config.ts:304-326`). A previously disabled PiP must not silently wake on upgrade;
   thereafter native settings, not extension controls, own execution.
5. Reconnect **all** current hold/stop paths to that policy: direct private submission, follow
   report delivery, scheduled inputs, webhook targeting, repository-watch delivery and automatic
   compaction. Preserve once-only delivery and settle pause/resume behavior for admitted shared
   jobs separately (`src/server/commands.ts:910-914`; `src/server/pip.ts:1652-1664`;
   `src/server/schedules.ts:192-204`; `src/server/hooks.ts:590-594`;
   `src/server/repo-watches.ts:752-756`; `src/server/pip-compact.ts:515-519`).
6. Extend the resulting core `app.pip` with source-bound mentions and Reviewer publication;
   Reviews/Collab and native transcript/diff presentation retain their responsibilities above.

The human has separately decided that private and mention modes use independent model settings.
Promotion itself does **not** decide whether viewers may invoke PiP, whether paused PiP blocks
Reviewer comments that need no generation, or whether private history remains readable while
execution is paused. Those require explicit policy, not consequences of whether a module happens
to be loaded.

No application source, application settings or durable data were changed by this research.

## Follow-up: PiP model/version settings

### Existing behavior

- PiP already has a provider/model and thinking selector in its private panel header
  (`web/pip.js:931-943`). The shared `ModelPicker` uses the private PiP view and configuration
  route, not the open coding thread (`web/sheets/model.js:69-94`). Saving through that path
  requires PiP ownership and idle private generation/compaction; it deliberately does not
  change the last-picked model for ordinary new sessions
  (`src/server/commands.ts:1480-1500,1564-1597`).
- That selection currently lives in private PiP's `AgentDoc`; first creation takes the normal
  new-session default (`src/server/pip.ts:325-353`). It is not yet a standalone collaborator
  configuration usable without opening/creating the owner's private conversation.
- Settings already has **Agents**, alongside Providers and Usage & limits
  (`web/sheets/settings.js:14-23`). Agents currently manages Work Item execution and role prompts,
  owner-only (`web/sheets/agents.js`). Providers remains the place for credentials/catalogue;
  a PiP selection should reuse the same picker, not create a second provider registry.
- Runtime model references identify `{ provider, modelId }`
  (`src/server/models.ts:119-142`). Inspection found no collaborator-specific immutable model
  snapshot/version-resolution mechanism. Pinning this reference is not evidence that a provider
  alias's underlying implementation is immutable.

### Confirmed settings placement and model split; remaining proposed details

Use **Settings → PiP**, its own top-level settings page alongside Agents and Providers, not a
nested Agents section. The human has also confirmed **two independent model selections**:

- **PiP chats:** the model used for private PiP conversations.
- **Collaborator:** the model used when explicitly mentioned in collab chat or review comments.
  This is one collaborator selection across both discussion surfaces, not the Reviewer's model.

Changing one selection must not change the other. The shared visible PiP identity does not imply
shared model configuration, history, tools or authority. This supersedes the earlier one-selection
recommendation. Independent per-selection supported thinking levels are recommended as a paired
control; that UI detail is not a separately confirmed human decision.

PiP's existing compaction threshold, execution controls and availability/needs-sign-in status also
belong on this page. Providers still owns credentials; Usage & limits still owns budgets. Reuse
the existing model-picker implementation for both choices. The private header shortcut targets
only the **PiP chats** selection, not the collaborator setting. Do not add version-history/release
management UI unless usage justifies it.

Remaining storage/execution proposals:

- Persist the choices independently with revision/conflict protection. Preserve the existing
  explicit private selection during migration; do not reset it to the current coding thread or
  latest global default. The collaborator choice must be usable without opening/creating private
  PiP. Its initial value/first-run behavior is still open; do not implement a live “follow private
  model” link or silently borrow the other mode's model on failure.
- Every admitted mention snapshots the **collaborator** provider/model ID, supported thinking
  level and settings revision. Changes affect later questions, never swap an accepted/running job.
  Retries retain their original model; using another is an explicit new attempt with honest
  usage/delivery state. A private-model change has no effect on collaborator jobs.
- Private PiP's running generation/compaction stays on its selected private model. Private model
  changes must respect existing owner/idle configuration checks or a defined pending-change
  mechanism. Saving the collaborator setting must neither reconfigure private PiP nor require
  private PiP to be idle. Conversely, active collaborator jobs do not block private model changes.
- Prefer provider-exposed fixed/versioned IDs where available. Persist each exact chosen
  identifier; no automatic newer/cheaper substitution. A moving provider alias is only
  identifier-pinned, not a promise of reproducible weights. Keep original result provenance.
- Missing/removed models or expired sign-in leave the affected mode visibly unavailable/held,
  with an owner action. Never silently use the other mode's model, private context or broader
  privileges. Shared readers see only safe collaborator-model/status fields, not private chat
  model details or a private conversation ID merely because they mentioned PiP.
- **Reviewer-authored findings use the existing Reviewer's model**, because they publish that
  run's findings without another generation. They still display only **PiP**. Neither PiP model
  setting changes the Reviewer's selected model. A subsequent explicit mention in that finding's
  discussion uses the **collaborator** model and records a distinct invocation.

Acceptance additions: changing either model leaves the other unchanged; private header and chat
settings agree; mentions on both discussion surfaces use the collaborator setting; running/retried
questions retain their captured selection; private busy state does not prevent collaborator-setting
saves; ordinary session defaults remain unchanged; stale saves conflict; unavailable models never
cross-fallback; Reviewer findings record their actual producer without a visible “via” label.
Only source inspection and note changes were performed for this follow-up; no UI was implemented.

## Acceptance evidence to collect later

No tests were run or reviewed. A future implementation should demonstrate: busy coding runs are
untouched; pending Pip jobs do not block handoff/fetch; retired writers stay retired; every job
remains bound to its original source; no private Pip/cross-discussion/host-namesake context leaks;
service identity cannot be forged through human routes; no service/self/historical mention loops;
restart/retry yields at most one visible answer; generation errors and uncertain provider spend
are honest; explicit payer/model/source-limit behavior survives concurrent human inputs and
revocation. These are proposed acceptance scenarios, not tested claims.

## Evidence limits

Source inspection only; no app data, credentials, server calls, model calls, test execution,
external fetches or implementation changes. Test names/locations were located, not audited or
executed. The dependency declarations establish API shape, not live scheduler behavior. No
independent review is established. The earlier companion research notes remain unchanged; this
checkpoint was updated and the focused `pip-core-promotion.md` note was added during follow-up.
Note-only formatting/whitespace checks are recorded below.

## Reviewer findings: current seam and recommended change

### Confirmed at this checkpoint

- Review messages have human `userId/name`; anchors have optional `path/side/line`, but no range
  start or service provenance (`src/server/docs.ts:242-258,316-331`). `Reviews.comment` constructs
  authorship from the current human and accepts advisory excerpts, not server-certified inspected
  versions (`src/server/reviews.ts:597-720`). Replies must use their existing thread's anchor
  (`src/server/reviews.ts:621-630`). There is no native finding publication tool in core's tool
  list (`src/server/app.ts:550-576`); repository callers of `Reviews.comment` consist of the
  authenticated human route (`src/server/http/conversation-routes.ts:65-105`).
- Human comments and replies are deliberately independent of the coding run. Review receipts
  bind the author and payload fingerprint; a changed-payload retry conflicts, and retries cannot
  replay a resolve over a later reopen (`src/server/reviews.ts:76-109,646-664,723-785`). Preserve
  those guarantees rather than making the model call a human HTTP endpoint.
- The bundled Reviewer still independently inspects, makes bounded repairs, and reports actual
  findings/checks/gaps; it does not yet instruct inline publication
  (`src/server/work-item-profiles.ts:62-69`). Custom owner prompts override that bundled playbook
  (`src/server/work-items.ts:218-230`). Do not silently replace an owner's override or assume a
  default-only prompt change reaches every existing Reviewer.
- Review storage and live projection are conversation-local, with empty state on forks
  (`src/server/docs.ts:325-331`; `src/server/room.ts:371-377,454-459`). Current reviewer grouping
  keys top-level threads by `userId`, while replies add no reviewer
  (`web/reviews.js:28-53`). Resolution remains author/owner only
  (`src/server/reviews.ts:746-766`; `web/reviews.js:745-750`).

### Proposed native path

1. Add a narrow internal `Reviews` publication capability plus a core tool for the **existing
   main Reviewer run**, not another model/agent, private PiP, or a broad HTTP client. Derive
   source conversation, current human requester, Reviewer type, run/task and pinned destination
   from actual invocation. Arguments describe the finding and anchor, not author or target thread.
2. Permit that exact capability in mandatory workflow policy. Unknown tools are currently
   denied, and paused/retired writers are blocked (`src/server/workflow-policy.ts:525-634`;
   `src/server/work-items.ts:146-162,321-347`). Recheck live requester, main-root identity,
   Reviewer role and writer availability. Helpers/non-Reviewers cannot mint Reviewer findings.
3. Reserve before the first await and hold through settlement; use the existing workflow writer
   reservation/exclusive-lock boundary rather than trusting a one-time tool hook
   (`src/server/workflow-policy.ts:398-478`; `src/server/handoffs.ts:1136-1175`). If handoff wins,
   reject fresh publication; never move a late finding to the successor. If publication wins,
   handoff waits for its reservation/tool. Returning an existing receipt after retirement, if
   supported, must not create new findings or perform new anchor reads.
4. Share the internal-only PiP actor model with mention answers. Display simply **PiP**, without
   a “via Reviewer” label, following the human's direction. Retain origin conversation/run/model,
   finding identity and inspected-version evidence separately.
   This records the Reviewer's work, not another independent review or a workflow/publication
   approval. Human clients cannot forge it. Keep comments in the actual Reviewer conversation;
   references in final assessments/handoff briefs retain that origin. Copying them across the
   Work Item is not implicit and would need its own access/index design.
5. Acquire a server-observed, destination-bound diff/context token for the version actually
   inspected. A path/line and the current HEAD at delivery are insufficient for uncommitted
   changes. Publish against that token with full anchor evidence; on drift report outdated
   context or require renewed inspection. Reuse destination-aware `Reviews.changes/diff/context`
   scope and native-read boundaries, not arbitrary Files/host reads
   (`src/server/reviews.ts:236-594`; `src/server/changes.ts:439-486`).
6. Commit finding, revision and stable delivery receipt atomically. Bind retries to the episode,
   finding and immutable payload/anchor/version, not text alone. A lost acknowledgement returns
   the original ID. The final review report must disclose posting failures and still state the
   actual validation results, limitations and remaining risks.
7. Keep the current repair policy unless explicitly changed. Smallest v1: publish **remaining
   actionable code-local findings after the bounded repairs**, and summarize repaired findings
   in the final report. This avoids leaving already-fixed issues falsely open. If all findings
   must appear as a running audit trail, decide service amendment/resolution rights explicitly;
   current human author/owner permissions do not settle this. A mention reply never resolves a
   human concern automatically. Owner-only resolution of service findings is a conservative
   proposed default, not an approved new permission.

## Follow-up: collapsible diff-comment list in the final review

### Human-requested behavior

The final Reviewer assessment must include the comments actually left on the diff as a clickable,
expandable/collapsible list, using the thread's existing tool/thought disclosure language. Keep
that list distinct from the overall findings, repairs, validation and recommendation prose. Earlier
comment tool calls remain visible during the work; the final list is a convenient index, not another
publication or duplicate set of comments. Visible author remains simply **PiP**.

### Current evidence and integration gap

- `ActivityGroup` already provides a chevron, `aria-expanded`, manual open-state retention and the
  live/newest-open, older-closed convention (`web/transcript.js:1161-1297`). `ToolStep` provides
  expandable detail and separate result-navigation actions (`web/transcript.js:1007-1108`). Reuse
  their presentation language, but a final comment index is a static result block, not a fake
  executable tool call or thinking record.
- Final assistant text is currently ordinary `Markdown`, with no review-comment result attachment
  (`web/transcript.js:1422-1490`). The existing rich-block seam specializes code/HTML/SVG/diff
  rendering (`web/rich.js:167-259`; `web/ui.js:333-365`), not authoritative comment membership.
  Do not infer saved comment IDs from generated prose, parse file/line text into comment identity,
  or allow arbitrary assistant HTML to create trusted app controls.
- The Reviews index already displays a location/excerpt row and invokes precise thread navigation
  (`web/reviews.js:403-453`). `DiffReview.jumpToThread` clears filters, unfolds the file, sets the
  exact conversation/thread target, waits for lazy diff/context rendering, scrolls and focuses it
  (`web/diff.js:1962-2067`). This currently relies on component-local `jumpRequest` identity, not
  merely a public store setter. `revealReviewReviewer` opens Changes for a person, not an exact
  durable discussion link (`web/store.js:1798-1816`). External transcript/tool-card entry points
  need a real shared navigation path, including reloadable source/thread references.

### Recommended behavior and implementation boundary

1. Add a native **Diff comments · N** result section associated with the final review episode/run.
   Derive membership from successful publication receipts and actual returned comment IDs, not
   every PiP comment in that conversation or the model's self-reported count. Persist the association
   to the final assessment/episode so reload and saved-history rendering reproduce the same list.
   Exact storage/attachment shape remains implementation work; preserve existing entry/doc contracts.
2. Reuse the tool-group chevron/spacing and newest/older disclosure convention, respecting a manual
   open/close choice. Expanded rows show file + single line/range, a short comment excerpt, and
   current open/resolved/outdated status where available. Use posting order initially; no new
   severity taxonomy or second model call is needed. The header expands the list; a row opens
   its discussion. Do not overload the same tap with both actions or add nested disclosure to
   every short row. Leave the final recommendations/checks readable outside the collapsed list.
3. Have comment tools return structured `{ sourceConversation, threadId }` references and safe
   display metadata after actual durable delivery. Tool-card **Open in diff** and final-list rows
   must call the same production navigation operation. It opens Changes, clears incompatible
   filters, unfolds the file and comment, loads necessary context and focuses/highlights the exact
   discussion. On phones, Back returns to the final report without losing its reading position.
4. Links identify **source conversation + thread**, not file/line alone. Changed code should open
   the retained outdated discussion, not a coincidentally matching new line. Archived/retired
   sources remain read-only discussion destinations subject to current access. Missing/revoked
   sources show a safe unavailable state without revealing private titles or redirecting to a
   successor. Inherited/forked history must not reinterpret references as local comments.
5. Count successfully published comments only, deduplicated by stable finding identity. A failed
   posting remains a failed tool call and is disclosed in the final report; it cannot appear as
   a successful clickable item. An interrupted review may expose already-posted comments through
   its tool cards, but should not fabricate a completed final assessment. Expanding/navigating the
   list never invokes a model, reposts, resolves feedback or changes files.
6. The index is a historical set of findings; live status can change as humans resolve or reply.
   Do not mutate the original final review prose or replace reviewed-version evidence with current
   code. Preserve useful safe excerpts when live detail is unavailable, within current access rules.

Focused acceptance additions: one successful publication yields one item and the same target from
both tool card and final list; another review episode/mention answer is excluded; duplicates and
failed publication do not inflate counts; final membership survives restart/reload; lazy/collapsed/
filtered diffs reveal the correct original discussion; outdated ranges and missing/revoked sources
are honest; keyboard/touch disclosure and navigation remain separate; Back preserves report position;
new results/status updates do not override a manual collapse. No UI/test implementation or browser
validation was performed for this follow-up.

## Multi-line means diff ranges, not textarea line breaks

### Confirmed current behavior

Comment text preserves interior newlines (`src/server/reviews.ts:42-52,606`), the composer is a
textarea (`web/reviews.js:696-715`), and `.rv-text` uses `white-space: pre-wrap`
(`web/reviews.css:406-413`). No runtime defect in multiline text was reproduced.

The missing capability is a range anchor. A line-number button supplies one side, line and up
to 1000 characters of that line (`web/diff.js:258-280`). `locate` verifies only that single line
against captured text, with outdated fallback; insertion/rendering is keyed by side/end line
(`web/diff.js:614-765`). Composer/draft/retry scope, labels and feedback export likewise assume
one line (`web/reviews.js:180-225,565-615,641-691`). The current context endpoint returns **current
file text**, not an old-side snapshot (`src/server/reviews.ts:414-594`).

### Proposed compatible representation and interaction

- Add optional `startLine`, keeping stored `line` as the inclusive end. Absence means the existing
  one-line case. Same file, same old/new side, positive ordered safe integers; reject mixed-side,
  reversed, cross-file, oversized and unverifiable ranges. Replies cannot change the range.
  Choose line/evidence-byte bounds before implementation; preserve current metadata limits.
- Keep legacy single-line `context` semantics. Add bounded range/version evidence rather than
  treating a truncated multiline preview as proof. Verify every line in the interval, not just
  endpoints. Old-side evidence must come from the inspected old-side source/patch; do not compare
  deleted text with current file text. Never treat omitted diff context as a verified interval.
- Update validation, payload receipts, tab-local draft identity, exact-anchor filtering, labels,
  feedback export, navigation, unified/split placement and range highlighting together. Render
  one discussion after the endpoint while keeping its full range label. Existing one-line
  comments/drafts continue to work. New-range retries retain the originally submitted evidence
  even if the diff refreshes before acknowledgement.
- Preserve outdated fallback: changed middle lines, removed files, rename or cwd/version drift
  must not attach an old range to unrelated code or silently shrink it to one line. Current
  `locate` is a useful principle, not already a whole-range implementation.
- Desktop: select start/end through the line-number controls, with Shift-click as an accelerator.
  Touch/keyboard: offer explicit **Select range** and endpoint controls, preview the highlighted
  range, then confirm/open the composer. Support correction/cancel without forcing textarea focus
  during selection. No mouse-drag-only or long-press-only design; keep code copying, page scroll
  and pinch zoom intact. Wide coarse-pointer iPads need touch controls too. Real Safari/phone
  interaction remains a device check, not something desktop emulation proves.

## Bounded implementation sequence and acceptance

These are suggested slices, not authorization to implement or change unresolved product policy.

1. **Shared foundations:** additive service actor/provenance and range anchors/evidence; internal
   output sinks; existing human discussion behavior/permissions unchanged. Human and Pip comments
   use the same anchor and rendering rules.
2. **Reviewer contribution:** core publication tool and mandatory policy, destination/version
   validation, replay receipts, Pip grouping/provenance, bundled Reviewer instructions plus
   capability guidance that preserves owner overrides. Final review report remains required.
3. **Explicit mentions:** durable human-message admission and source-isolated runner/accounting,
   shared parsing/completion for chat and review, answer sink and visible job states. Fix chat
   retry identity beyond its rolling message window. Do not route through `Commands.submit`.

Primary contracts to exercise at their real boundaries:

- Extend review HTTP/storage coverage (`test/reviews.test.ts`) for compatible one-line and new
  range comments, newline text, invalid full ranges, unchanged-payload retry/conflict, restart,
  revocation and unchanged human author/owner resolution. Do not duplicate existing basic receipt
  coverage in private predicate tests.
- Exercise the actual core tool path for active main Reviewer publication and denial to helper,
  other role, wrong source and retired/paused run; race it against handoff. Assert one visible
  finding, server-authored provenance and no author spoofing. Core tool registration alone is
  not evidence of safe execution.
- Extend actual review UI coverage (`test/reviews-ui.test.ts`) for mouse/keyboard/coarse-pointer
  endpoint selection, both sides, unified/split layouts, range labels/highlights, hidden context,
  draft/uncertain retry preservation, navigation and whole-range outdated detection. Include a
  middle-line-only change with identical endpoints. No claim of real-device Safari proof.
- Mention integration must demonstrate at most one visible in-place answer across duplicate
  sends, result/delivery restart windows and lost ACKs; explicit failures/holds; stable payer,
  selected model and source budget despite concurrent coding requests; revocation during reads
  and delivery; no private-context/host-namesake leak or historical/self-trigger loop. Pending
  mention work must not change coding inbox/writer state or block handoff/fetch.

No feature tests, browser checks or model calls were executed for this research. Only the new
Markdown checkpoint is intended to change. `docs/design/` is excluded from docs-site page discovery
(`docs-site/src/repo-docs.mjs:46-52,319`), so no navigation entry is required for this note.

Note-only validation: Prettier formatting/check passed after formatting this file. The untracked-file
`git diff --no-index --check` printed no whitespace warnings (exit 1 reflects the new-file diff).
No application formatting sweep, tests, docs-site build, restart, commit or publication was performed.
