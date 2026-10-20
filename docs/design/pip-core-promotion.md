# PiP core promotion: implementation checkpoint and lifecycle evidence

Research checkpoint: `4f291f8b29b71db75d2a283dc3b13a593df5be9e` (2026-10-20).
All first-party `path:line` citations below refer to that commit. Dependency observations refer to the
locally installed Pi Durable 1.1.0 (`package.json:52`), not a new upstream fetch.
The research sections below describe that historical baseline, not the current working tree.
The implementation checkpoint records subsequent source/test changes; the baseline investigation
itself performed no application-data access, credential use or external reads.

**Human direction:** promote PiP fully into core. PiP settings get their own top-level
**Settings → PiP** page, alongside Agents and Providers, not a nested Agents section. The overall
core-promotion direction was accepted with this placement adjustment. The human also confirmed
**separate model choices** for private **PiP chats** and the **PiP collaborator** (explicit mentions
in collab chat or review discussions). Changing either must not change the other. Reviewer finding
publication still uses the actual Reviewer run, with no extra PiP generation. See
[the integration checkpoint](pip-collaborator-core-integration.md) for current implementation,
validation limits and remaining collaboration policy proposals.

## Worker implementation checkpoint (2026-10-20)

- All first-party private PiP wiring moved to `src/server/pip/private-agent.ts`, installed by
  `Pip.registration()` before Harness recovery with the preserved `pocket-pip` selection identity.
  The first-party optional extension was deleted, not replaced with a trampoline. Its basename
  and tools remain reserved. Ordinary conversations still exclude the private registration.
  Private registration also clears provider-supplied native result claims without selecting
  `pocket-core` or exposing the shared publication tool.
- Native `pipEnabled` takes precedence, with read-only legacy extension-choice fallback while
  absent. Old disabled installations remain paused. Paused startup fences unfinished private
  generations; compaction/follow/report identities and private replay contracts remain intact.
  The internal host forwarding was removed except the schedules module's real `countSchedule` use.
- Top-level **Settings → PiP** owns native pause, private compaction and independent **PiP chats** /
  **Collaborator** model/thinking controls. Collaborator starts unset and saves without creating
  or waiting for private chat. Private picker changes retain owner/idle checks and ordinary model
  defaults remain unchanged. Collaborator now drives explicit work-scoped shared mention answers
  with app-provided work reads. Custom public-web/search code was removed; search is deferred to a future common thread/PiP capability.
- `app.pip` now also owns Reviewer inspect/post publication and native assessment references,
  without exposing private history/tools or launching a second model. The conservative native
  pause blocks new Reviewer posts; an exception was proposed but never approved.
- `pip/mentions.ts` adds human-mention admission and a hidden independent durable task lane,
  with pinned model/authority, no private tools/history, source-bound delivery and native live
  status updates. Existing steering/turn/spend rights are preserved, not broadened for viewers.
  Spend owns immutable requester/source usage receipts. Uncertain attempts are interrupted on
  restart rather than silently regenerated; saved results recover without another model call.
- Human review composers share person/PiP autocomplete with chat. Inclusive ranges are picked
  directly in the diff gutter by drag, Shift-click or touch endpoints, not numeric inputs;
  complete bounded evidence, old/new omitted-line reads, drafts and retry identity are preserved.
- `pip/shared-context.ts` binds `work_context` to current requester/source and delegates filesystem
  policy/discovery to Workspace; Pi Agent Core owns generic tool continuation. Recent
  coding history and current thread/Work Item metadata arrive with the question; the tool pulls
  more visible work history, code and diffs without private powers. Model/read/time bounds and
  per-response immutable accounting apply to every continuation. See the integration checkpoint's
  user-feedback continuations for the current behavior and verification.
- Review composers contain no routine instruction/limit banners. Human and PiP suggestion fences
  render as proposed code with **Apply suggestion**; only an authorized human click edits the file
  through Workspace's existing save policy. Durable one-way claims prevent duplicate application;
  **Check result** only confirms expected bytes after interruption. This never adds a model call.
- Foundation checks passed formatting/lint/type/reference validation, **55/55** focused tests
  and the **1/1** extension-inventory/restart case. The continuation passed **65/65** focused
  server tests, **7/7** non-socket Reviews cases, **2/2** real denial/private-claim clearing cases and **52/52**
  socket-free UI/lifecycle cases. See the integration checkpoint for exact scope and final checks.
- Full Reviewer-positive runtime proof is blocked during real Worker-to-Reviewer setup by
  `sandbox-exec: sandbox_apply: Operation not permitted`; its six dependent cases are not green.
  Browser/phone checks cannot bind a disposable server (`listen EPERM`); broader watcher suites
  hit `fs.watch EMFILE`. These are limits, not permission to bypass confinement or passing claims.

No live data was read or changed, no real provider request made, and no server restarted, commit
created or publication performed. The earlier work-tool feedback checkpoint passed **199** focused
server/UI/Reviews/compatibility tests. Later continuations add human-applied suggestions and quiet
composers, remove the temporary custom search tool, and consolidate filesystem policy, model/anchor
validation, mention/suggestion grammar and the generic model/tool loop under their existing owners.
The integration checkpoint records the current 277 focused passes separately from historical
results and names remaining environmental limits. The implementation is reviewable in the working
tree; independent review, real-device QA and the six blocked Reviewer integrations are not implied.

## Historical ownership at the research baseline

- `PocketApp` already constructs `Pip` and `PipCompaction` (`src/server/app.ts:313-315`). The optional
  wrapper only wires Durable tools, prompt sections, the compaction hook and the follow task
  (`src/server/extensions/pip.ts:653-699`). PiP is not currently an ordinary shared-chat assistant.
- Wrapper tools: `sessions`, `session_read/start/send/follow/stop/archive/schedule`, `approvals`
  (list/deny, never allow), `repo_watch`, `session_watch_pr`. It owns schemas, replay policies,
  result formatting, tool-call keys, the `pip.session` memo, private prompt/rules/environment and
  GitHub guidance (`src/server/extensions/pip.ts:28-57,137-138,147-344,347-651`). Its `reply()` is
  only a result formatter, not a durable discussion reply mechanism (`:25`).
- `Pip` owns private identity/create/tune, authorization and cross-session actions, recent-read and
  action limits, human-named-model checks, repo checkout/watch dispatch, follows and reports
  (`src/server/pip.ts:184-225,298-377,381-432,475-525,655-754,946-1025,1033-1337,1341-1707`).
  `#person()` requires catalogue `meta.pip` plus an extant user, but does **not** itself check current
  owner role/availability (`:475-483`); callers/entry gates currently supply that separation.
- `PIP_EXTENSION = "pocket-pip"` is an internal TypeScript export, not the public drop-in SDK.
  It is also a persisted selection identity: `PIP_EXTENSIONS` includes it, and both creation and
  `ensure()` tuning write those names into `AgentDoc.extensions`, excluding bash/write/edit
  (`src/server/pip.ts:54-75,343-344,365-375`). Changing the display name need not rename that identity.
- `PocketHost.pip` and `.pipCompaction` are internal built-in-module host services, not declared public
  APIs: `src/server/host.ts:277-304`; `docs/extensions/reference/host.md:334-349` explicitly labels
  them internal and absent from `types/pocket.d.ts`. Removing that forwarding is not an SDK break,
  but `src/server/extensions/schedules.ts:83-87` still uses `host.pip.countSchedule`; keep or rewire it.

## Isolation and startup facts

- App's default Harness selection excludes `pocket-pip` (`src/server/app.ts:1052-1063`). Simply moving
  all private tools/sections into globally selected `pocket-core` would expose them in ordinary chats.
  Conversely, old PiP's explicit extension array omits `pocket-core`; moving its hook/prompt there
  alone would make it disappear for existing private PiP conversations.
- Pi Durable resolves an explicit stored extension array instead of defaults, looks each name up in
  the installed registry, and derives tools/sections/hooks from selected registrations
  (`node_modules/@earendil-works/pi-durable/dist/harness/agent.js:127-204`). Task definitions instead
  come from all installed registrations, independently of per-conversation selection; duplicate task
  names throw (`.../harness/registry.js:14-25,70-75`).
- App installs its `pocket-core` registration before loader loading and Harness open, recovers metadata
  and attribution before calling `harness.resume()` (`src/server/app.ts:549-576,650-675,717-722,730-790`).
  There is no PiP startup tuning pass: `#tune` runs when `ensure` opens an existing private assistant
  (`src/server/pip.ts:307-312,362-377`). Recovery cannot rely on someone reopening its panel first.
- Private visibility is catalogue-derived: `canSee` rejects `meta.pip` belonging to somebody else
  (`src/server/app.ts:1659-1689`). Do not set that field on a shared mention/Reviewer conversation.

## Proposed end state (not implementation)

1. `Pip` owns a stable registration (e.g. `registration`), constructing its tool/prompt/hook wiring
   directly or through private non-loader files under `src/server/pip/`. `PocketApp.open()` installs
   it before `Harness.open`; no first-party source or compatibility trampoline remains under
   `src/server/extensions/pip.ts`. A core-owned Durable registration may still be named `pocket-pip`:
   this is registry composition/storage compatibility, **not** an optional loader extension.
2. Keep that private registration excluded from ordinary default selections. Retain `PIP_EXTENSIONS`
   and its old `pocket-pip` entry, tool names/parameters/replay policies, prompt section keys and
   compaction hook behavior for this promotion. No destructive AgentDoc rewrite is needed merely
   to move ownership. Keep `PIP_WITHOUT` and private catalogue identities unchanged.
3. Register `pocket.pip-follow` exactly once, always, including while execution is paused. Keeping it
   on Pip's always-installed registration is simplest; a task-only `pocket-core` registration is also
   possible, but never install both. Tasks' ownership and their tools' model exposure are distinct.
4. Reserve `pip.ts` in `CORE_MODULE_FILES`, removing its loader ORDER/title entry. This follows
   WorkItems' pattern: excludes imports from either folder, blocks hot reload and preserves the
   reserved basename after source deletion (`src/server/reload.ts:61-66,343-380,892-895`). Keep
   `pocket-*`/PiP tool-name reservations (`:90,110-121`); a drop-in must not shadow the promoted module.
5. Future shared mentions/Reviewer-comment operations need separate scoped core entry points with
   actual requester/run/thread authorization. Do not add `pocket-pip` to shared AgentDoc selections,
   map shared threads to an owner private PiP, or use private `#person` as shared authority. A scoped
   shared reply capability is not permission to list/start/stop other sessions or deny approvals.
6. Replace wrapper's old-hot-server feature probes (`src/server/extensions/pip.ts:125-135,206-207,
249-253,671-677`) with the current core contract rather than preserving a faux loader lifecycle.
   This move requires a coordinated server restart, not hot deletion while old core is still running.

## Durable migration and disabled-state constraints

- Preserve `pocket.pip-follow` version 1, its `{wait, report}` checkpoints/input and abort settlement
  (`src/server/pip.ts:110-119,198-219`). Preserve `pocket.pip-follows`, `pocket.pip-asked`,
  `pocket.pip-compaction` kind/version/scope/history/fork contracts (`src/server/docs.ts:716-759`).
- Preserve follow tool-call keys (`pip-${taskId}-${callId}`), `pip.session` memo, hashed message request
  keys, `FollowsDoc` task receipts and `doneAt`, and `pip-report-${taskId}` request IDs
  (`src/server/extensions/pip.ts:137-138,255-282`; `src/server/pip.ts:439-465,1363-1423,1629-1704`).
  Follows deliberately retain completed receipts for 24 hours (constant at `:86`; cleanup at `:1376-1398`),
  not forever. Moving code does not justify remaking tasks, clearing receipts or replaying deliveries.
- Durable pending tool recovery resolves the current selected tool by **name**; replay after intent
  requires both stored and current policies to be safe (`.../harness/tool.js:22-27,62-84`). Preserve
  names, safe/unsafe policy and memo/request-ID formats, not only the follow task name.
- Current off behavior unloads wrapper registration and calls `stopAll`, which aborts active private
  runs and compactions, not a sweep of follows (`src/server/app.ts:2939-2941`; `src/server/pip.ts:240-264`).
  Reports explicitly hold until availability returns (`src/server/pip.ts:1651-1661`). Core promotion
  should preserve durable registration while gating execution; disabled must not mean “missing tools”.
- Availability currently equals owner role plus loader presence (`src/server/pip.ts:224-225`). It must
  become core availability/execution policy, not retain `loader.extensionNames()` after promotion.
  Native-setting precedence over legacy `extensionChoice("pip.ts") === false` should preserve an
  explicit prior pause. WorkItems provides the concrete precedent (`src/server/config.ts:304-324`;
  `src/server/work-items.ts:83-85,103-105,146-162`; `src/server/app.ts:565-575`).
- A paused private PiP must not consume direct human input (`src/server/commands.ts:910-914`), automatic
  early compaction (`src/server/pip-compact.ts:511-519`), follow reports, schedules, hooks or repo-watch
  delivery. Existing downstream checks: `src/server/schedules.ts:120-133,193-204` (holds without advancing
  runs), `src/server/hooks.ts:591-594` (503; no server-side deferred inbox),
  `src/server/repo-watches.ts:747-756` (poll/hold). Repoint all to one live core policy, preserving receipts.
- Keep schedules/triggers' **own** optional switches independent; PiP core promotion alone does not
  make all automation core (`src/server/schedules.ts:248-259`; `src/server/repo-watches.ts:747-750`).
- Compaction must not silently fall back to ordinary summarization of untrusted session output:
  `PipCompaction.summarize` returns `decline` on failure because throwing allows Durable fallback
  (`src/server/pip-compact.ts:325-359`). Keep private hook installed before any resumed work.
- Spend holds remain different from pause: report delivery writes a deduplicated note instead of
  starting a model run, then settles its follow (`src/server/pip.ts:1663-1704`). Do not conflate the two.

## Acceptance proposals (not audited tests)

- Disposable-app upgrade: old private AgentDoc arrays retain private tools/rules/compaction hook before
  panel opening; ordinary Chat, managed Reviewer and helper agent selections expose none of those
  owner cross-session tools. Direct calls from non-PiP and unauthorized identities fail without effects.
- Restart with follows in both phases, interrupted safe tool intents, old `pip.session` memo and completed
  follow receipts: no duplicate session/message/report/follow or usage accounting; preserve task IDs.
- Explicit old disabled state remains paused after upgrade; pause/resume/restart retains registration,
  history and receipts. No report/schedule/watch/direct-input model run while paused; webhook remains
  retryable 503, not falsely accepted. Current owner/access/spend checks still apply after resumption.
- Failed/declined and cancelled PiP compactions do not fall back to unfiltered summaries; ordinary
  conversation compaction is unaffected. Removing optional schedules/triggers does not unload PiP.
- Loader list/reload/enable paths and same-named built-in/drop-in files cannot replace/unload PiP;
  no first-party PiP module remains under `extensions/`. Retained internal host schedule helper works.

## Unsettled product/policy choices

- One global PiP execution pause versus distinct private/shared capabilities; pause's effect on accepted
  shared replies/Reviewer work; default behavior for absent legacy choice. Main owns this decision.
- Owner removal/demotion while a follow is pending: current report hold breaks when user is missing
  (`src/server/pip.ts:1653-1657`), unlike schedules' unavailable-person hold. Strengthen/reconcile live
  authority rather than accidentally carrying private-owner power into shared operation.
- What shared PiP may read, who can invoke it, where replies appear, and whether it may autonomously
  act on Reviewer comments remain new scoped contracts, not implied by core installation.
