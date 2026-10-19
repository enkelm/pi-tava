# iPad PWA battery drain: idle-work audit

Date: 2026-10-19. Source checkpoint: `61a25cf171e18c26e5c50cabf0437d76f1ef68b4`.

## Implementation follow-up

The audit below describes that source checkpoint, before the repair. The same work item now closes Herdr sockets on hidden/offline/pagehide, cancels pending connection/retry work when the last Terminal view leaves, and permits automatic reconnection only with mounted Terminal listeners. Existing foreground connections remain reusable across Chat/navigation. Work Items eligibility reads and polling now suspend too, abort and fence stale responses, and refresh the current scope once on return. See [Terminal lifecycle](../terminal-mode.md).

Memory-only tests exercise the actual browser modules with fake events, HTTP, sockets and timers; the terminal lifecycle regressions fail against the original source. The worker's focused run passed **35/35**, including existing push, diagnostics, touch and viewport tests. After review repairs, the expanded focused run passed **49/49**, adding handshake stages, picker/service lifecycle integration and renderer preload/child scheduling coverage. The new handshake regression failed before its repair; four picker regressions failed against the pre-review sheet loaded in memory and passed after repair. These hook fixtures do not exercise real Preact reconciliation. Browser coverage was updated but could not execute with missing checkout dependencies. `npm run format` and `npm run lint` cannot load `@stylistic/eslint-plugin`; `npm run check` cannot find Node type definitions. The full `npm test` attempt reported 72 passes, 132 failures and one skip: missing dependencies prevent most suites loading, and it also reports an out-of-scope theme-surface assertion mismatch. Do not treat the full suite as green.

The earlier internal Reviewer thread found two remaining repair gaps: a Terminal welcome could arrive before the first snapshot and escape last-view startup cleanup, and cancellation could strand an already-open Handoff picker on Retry. Cleanup now includes that unfinished handshake. The picker tracks lifecycle identity through batched hide/return, joins the resumed eligibility read/cache instead of fetching again, and preserves its draft. The three new investigation pages are also registered in the docs sidebar. The docs build attempt could not find Astro, and an independent surrounding web-lifecycle test attempt could not load Preact; neither check passed. Syntax checks and `git diff --check` passed. Notification delivery policy and the WASM renderer are unchanged. No real iPad/network/energy profiling, dependency installation, commit, restart, deployment or publication was performed. Removing these confirmed background workloads is not proof that they caused the reported battery drain. At that review checkpoint, remaining opportunities included hidden elapsed-time UI clocks during live/waiting work, demand-gating foreground eligibility polling, quieter Herdr list/detail polling, and a pagehide latch for Herdr snapshot reads. The human selected a same-work Follow-up for those opportunities; its bounded repairs are recorded next. The historical audit below remains a description of the original source.

### Same-work Follow-up: clocks and foreground demand

- Live transcript/group and subagent elapsed labels share one visible clock. Hidden/pagehide stops the interval; visible/pageshow resumes immediately from real timestamps, including batched hide/return. It changes no agent state or subscriptions. Last-user cleanup stops timing; a passive pageshow listener releases a departure latch if all users unmount before return.
- Work Items keeps its initial/context-change read, but mounted header/composer controls no longer admit a recurring eligibility timer. Only an open Picker admits the shared 10-second interval. Relevant scope, access, busy, workflow, Work Item membership and profile changes invalidate old options; invalidation during a request coalesces into a serialized current read. Opening, explicit Refresh and routing hints request fresh eligibility. Hints are re-evaluated on semantic invalidation, not request completion. Poll results update open choices without routine loading/focus resets. Failed verification hides cached choices and offers Retry; a retry cannot make the failed cache actionable while its request is pending. Draft, selection and request identity remain intact.
- Without an open Picker, an unannounced filesystem, driver or task-only change waits for a relevant public event or an explicit opening/hint/Refresh request. The public session snapshot has no diff/driver/task revision. Server admission still rechecks current authority; no context cache becomes authorization.
- Herdr list/detail reads now latch pagehide until pageshow and retain stale-response/owner fences. Equal payloads no longer republish the view solely because `capturedAt` changed; retained content keeps its original capture timestamp. Changes to content, model, state, revision and prompt/import permission still publish. **Freshness is not slowed:** list reads remain 4 seconds after completion and pane reads 2 seconds. Each GET still performs the existing live server checks and passive visible-source read. This reduces redundant UI work, not full-payload network traffic or server journal work. Longer quiet-state backoff or change-only responses remain deferred rather than silently delaying native Herdr updates.

These repairs have local fake-event/hook/timer/request evidence and a self-review of their delta/immediate integration; the earlier internal Reviewer thread does not cover this new delta. The integration self-review found the failed-verification cache regression above, which was repaired and regression-tested. No iPad energy improvement is established.

**Final Follow-up validation:** 75 tests passed, with no failures, skips or cancellations:

```sh
node --test test/private-terminal-lifecycle.test.ts test/handoff-state.test.ts \
  test/handoff-picker-lifecycle.test.ts test/private-snapshot-lifecycle.test.ts \
  test/visible-clock.test.ts test/turns.test.ts test/push.test.ts \
  test/terminal-diagnostics.test.ts test/terminal-touch.test.ts \
  test/terminal-viewport.test.ts test/terminal-renderer-preload.test.ts \
  test/terminal-renderer-child.test.ts
```

The new snapshot suite passed 10/10; loading only original-HEAD `private.js` through a memory-only Node loader produced 6 intended failures and 4 passes. The clock helper recorded four intended pre-repair failures, then 5/5 new tests passed. The revised eligibility state suite initially recorded eight failures and four passes; the final state/Picker run passed 22/22, including three failed-verification regressions observed red before repair. Changed JavaScript/test syntax checks and `git diff --check` passed. The harnesses do not establish real Preact reconciliation, GPU behavior, iPad lifecycle delivery or energy savings.

The known missing-dependency format/lint/type/full-suite/docs/browser checks above were not repeated unchanged. They remain unavailable or failing, not green; no dependencies were installed and no local-browser workaround, personal Herdr access, live notifications, commit, publication, restart or deployment was attempted.

## Question and limits

The owner reports heavy iPad PWA battery drain and initially suspected the new Herdr WASM renderer (`511c6fd`). Follow-up asks what else can consume power while idle, rather than during active terminal use.

This is an audit of **work performed without user interaction**, not a measured battery diagnosis. Distinguish:

- Visible, idle Collab with no active agent work.
- Visible Herdr Chat or Terminal, including static panes.
- A visible app showing active/waiting agents elsewhere.
- An app hidden by switching apps or locking the iPad.

No iPad CPU/GPU/energy trace, running-server revision verification, personal Herdr access, or live-network measurements were available. The first investigation was interrupted by a publication lock; successful local reads resumed on the follow-up. At the research checkpoint only notes were changed; no fix, restart, commit, deployment, or publication had been performed. The later implementation is recorded above.

## Clarified reproduction: ordinary thread after previously opening Herdr

The owner's final clarification is the specific sequence **open a live Terminal pane → return to a normal Collab thread → leave the app**. This makes the editor/Running now loops poor candidates unless they were actually still mounted, and establishes that Terminal was instantiated in the same page lifecycle before backgrounding. There is still no device trace identifying the events iPadOS delivered or measuring energy.

Confirmed route lifecycle:

- [`web/app.js:441–499`](../../web/app.js) conditionally renders `PrivatePane` **or** the ordinary transcript/composer. A normal thread route does not keep `PrivatePane` mounted behind it.
- [`web/private-terminal.js:1317–1335`](../../web/private-terminal.js): leaving Terminal removes its UI listener and requests native surface-interest suspension. It deliberately **does not disconnect** the pooled transport.
- [`web/terminal-grid.js:1994–2007`](../../web/terminal-grid.js): the painter iframe belongs to the grid's DOM subtree, so leaving the private route removes the iframe rather than merely clearing its pixels.
- [`web/terminal-renderer.js:109–194`](../../web/terminal-renderer.js): unmount cleanup cancels startup ownership, disposes the parent bridge and removes the parent's message listener. [`web/terminal-renderer-bridge.js:293–298`](../../web/terminal-renderer-bridge.js) clears pending/in-flight state and the bridge deadline.
- The earlier observation that non-drawable rendering clears a still-mounted child is **not the same lifecycle as returning to a normal thread**. Code alone does not establish a detached iframe/WebKit GPU leak.
- [`web/private-terminal.js:597–646`](../../web/private-terminal.js): retry requires a desired connection and online/visible state, **not a mounted listener**. A retained, unused connection can therefore reconnect after a transport failure while Collab is visible. The native helper starts with surface activity enabled ([`native/herdr-web/src/main.rs:415–419`](../../native/herdr-web/src/main.rs)), then the browser requests inactive interest after a snapshot if no UI listener remains. Reconnects can cause fresh handshake/snapshot/surface work before suspension; no evidence here establishes an actual reconnect storm on this iPad.
- Each retained connection still has its 15-second WebSocket heartbeat. Explicit Disconnect, pagehide/reload, access loss or pool eviction closes it; simply navigating to Collab does not. No personal pane was accessed.

**Memory-only diagnostic run:** extracted the actual `acquire` factory with synthetic transport/timers. Removing its last listener retained the connection, requested `active:false` and left `desired:true`. A simulated transport loss then caused one more connect with zero listeners; the replacement requested surface suspension. Explicit Disconnect prevented the next retry. This verifies pool policy, not live WebSocket/native acknowledgements, GPU work or battery cost.

For other reproduction cases, opening only the Herdr **sidebar** does not necessarily instantiate a Terminal or create that transport. [`web/private.js:221–242`](../../web/private.js) only switches `sidebarTab`; an ordinary thread can remain open alongside the visible Herdr list, whose 4-second polling then continues. Terminal instantiation requires entering the private pane's Terminal mode. A fresh reload directly into the same Collab thread, without revisiting Herdr and after startup settles, is the lowest-effort comparison against post-Herdr retained state. Reloading the web client does not stop Herdr or its agents; it also does not by itself prove a root cause.

### Backgrounding after leaving Terminal: a confirmed lifecycle distinction

[`web/private-terminal.js:147–168`](../../web/private-terminal.js) treats two events differently:

- `visibilitychange` updates the paused UI state and surface interest, but **does not close the retained socket**.
- `pagehide` drops the socket with non-retryable page-departure cleanup.

Therefore, if app backgrounding produces visibility loss without pagehide, an already-opened Terminal's retained connection remains open even though the owner has navigated back to Collab. The server can continue its 15-second WebSocket ping, and the connection can receive metadata/control messages even with surface streaming disabled. Whether iPadOS suspends the page/network, how often it wakes, and how much battery this consumes were **not measured**. This must not be described as a proven iPad drain or as continuous hidden GPU rendering.

**Memory-only diagnostic run:** executed the actual `terminalConnection` function with synthetic API/WebSocket/event targets. After connection and snapshot, a hidden `visibilitychange` left the socket open and marked local state paused, without a close callback. A subsequent `pagehide` closed it non-retryably. Disposal removed event handlers/timers. This verifies application event handling, not actual iPad lifecycle delivery or TCP power behavior.

**Best-matched implementation candidate, if the human requests a repair:** explicitly suspend/disconnect unused terminal transports on backgrounding rather than relying solely on pagehide. Preserve the intentional retained-foreground Terminal behavior where needed, ensure surface-deactivation requests are bounded, and decide explicitly whether a user returning to Collab should reconnect a dormant terminal at all. Keep owner authorization, input non-replay and shared-pane/PTY side effects unchanged. Such a behavior change needs compatibility consideration because the current documented contract intentionally retains connections across navigation.

**Focused acceptance:** reproduce Terminal → Collab → visibility hidden without pagehide using synthetic transport; no unused socket or reconnect timer should survive the chosen background policy. Returning to Collab must not silently reactivate/resize a terminal. Returning to Terminal may establish a fresh snapshot under explicit approved behavior and must never replay input. Verify on-device request/network/energy traces afterward. A unit-only lifecycle pass is not a battery result.

## Confirmed idle work, ranked by context

### 1. An open code editor polls language support every 350 ms without typing

- [`web/file-language.js:6–76`](../../web/file-language.js): the live language transport has a **350 ms interval**. When no request is pending it enqueues an HTTP `action: "poll"`; typing or new diagnostics are not prerequisites.
- [`web/file-editor.js:235–249`](../../web/file-editor.js): the mounted editor starts this language support automatically.
- [`src/server/language-services.ts:121–136`](../../src/server/language-services.ts) and [`src/server/lsp.ts:561–564`](../../src/server/lsp.ts): poll returns the currently queued messages immediately, rather than holding an idle request until a message arrives.
- [`web/file-language.js:81–94,117–168`](../../web/file-language.js): owner authorization, foreground visibility and online state gate support; retirement stops the transport and clears its interval. A supported file and successfully opened LSP lease are required.

For quick responses this approaches **171 requests/minute**, even when the owner is not editing. Pending requests cap the actual rate; slow responses reduce it. This is the fastest confirmed foreground idle network loop found in this audit. It does not apply to a closed editor, unsupported file, failed LSP startup, or hidden/offline page. It is a stronger conditional suspect than the Work Items interval, but actual energy remains unmeasured.

**Application:** replace rapid empty polling with cancellable long polling or event-driven delivery, retaining ordered messages, bounded queues, lease renewal, stale-client fences and hidden/offline teardown. A naive interval increase would delay completion/diagnostics unless a separate wakeup path is provided. **No-code A/B:** close the editor and compare content-free `/lsp` request counts and idle CPU.

### 2. Work Items polls even with the handoff UI closed, hidden, or offline

- [`state.js:4–10`](../../src/server/extensions/work-items/state.js): a signed-in session scope admits ordinary session threads, irrespective of busy state, managed/unmanaged status, or read-only state.
- [`state.js:103–139`](../../src/server/extensions/work-items/state.js): observing a scope immediately refreshes and starts a **10,000 ms interval**. It is not conditional on a picker being open or any hook subscribers existing.
- [`state.js:47–99`](../../src/server/extensions/work-items/state.js): refresh has scope/disposal/in-flight guards, but no visibility, connectivity, or page-lifecycle guard.
- [`index.js:8–13`](../../src/server/extensions/work-items/index.js): the state service is created when the extension is installed, not only on opening a sheet.
- [`web/extension-ui.js:794–805`](../../web/extension-ui.js): `sessionApi` delegates to the ordinary API wrapper; it does not suspend requests when hidden/offline.
- [`web/store.js:464–502`](../../web/store.js): the wrapper fetches and parses a response; it has no global visibility gate.

This is approximately **6 status requests/minute per open session page**, plus event-triggered refreshes. Read-only/retired threads also keep the interval. Hidden iPad pages may be OS-suspended or timer-throttled, so this does not establish six requests per real background minute. When JavaScript is allowed to run, the application itself does not stop this poller.

**Measured locally, with the actual state module and synthetic pocket/timers:** initialization made one request and installed a 10-second interval with zero UI subscribers. Three simulated ticks while `document.hidden=true` and `navigator.onLine=false` made three further requests. A read-only thread still requested on the next tick. Disposal removed the interval. This measures request admission, not real browser scheduling or energy.

**Application:** prioritize lifecycle suspension and demand-driven status reads. Preserve fresh handoff eligibility on picker open, command completion and relevant session/workflow changes. Simply deleting refreshes risks stale role choices.

### 3. Herdr has substantial polling independent of WASM

- [`web/private.js:201`](../../web/private.js): the shared list resource refreshes **4 seconds after completion**.
- [`web/private.js:422–428`](../../web/private.js): lists subscribe while their layout is visible. [`PrivatePane:730–733`](../../web/private.js) also subscribes while a private pane is open, even when the sidebar is not visible.
- [`web/private.js:804–807`](../../web/private.js): pane detail refreshes **2 seconds after completion** in both Chat and Terminal. The subscription precedes the mode branch at lines 1113–1122.
- [`web/private.js:68–175`](../../web/private.js): resource eligibility requires listeners, an owner and visible/online state, but not content changes or an active agent. Successful responses always publish fresh state.
- [`web/private.js:921–931`](../../web/private.js): each new detail object can also trigger transcript/terminal follow-to-bottom layout work.
- [`src/server/private-sessions.ts:516–587`](../../src/server/private-sessions.ts): pane detail reads/project the saved Pi journal where available, reads the visible terminal, returns entries and terminal text, and stamps a fresh `capturedAt`. It is not a small change-only response.
- [`journal.ts:291–325`](../../src/server/private-sessions/journal.ts): the server opens and reads the saved journal again, up to the existing display size limit, without an unchanged-file cache in this function. Server CPU is not iPad CPU; the relevant iPad costs are transfer, response parsing and view updates.

With quick responses, an open private pane approaches **30 detail requests + 15 list requests/minute**, even when static. This is not fixed-cadence 45/minute: actual request duration adds to each delay. Shared subscribers reuse each resource, so do not multiply the list rate by the number of list components.

**Measured locally:** a memory-only harness extracted the actual `snapshots` factory and supplied a synthetic resource. Three simulated 2-second periods produced four total reads including initial load and five UI notifications including initial state, despite unchanged content. Hiding cancelled timers; showing refreshed once; unsubscribe cleared timers. This confirms idle refresh behavior and its existing hidden-page protection, not rendering or battery cost.

**Application:** adaptive quiet-state backoff or change-driven invalidation, cache unchanged journal projection, avoid redundant full payloads/renders, and avoid polling Chat history at the same frequency while Terminal already provides a live connection. Preserve identity/revision checks for private prompt safety; do not reuse a cached identity as authorization. Automatic `pane.read` must remain passive `source: "visible"`, as documented in [the earlier polling investigation](herdr-passive-pane-reads.md).

### 4. Running now polls even when nothing is running

[`web/sheets/running.js:8–29`](../../web/sheets/running.js) makes an immediate read and then polls `running` every **2 seconds** while the sheet is mounted. There is no hidden/offline gate or nothing-running backoff. It stops on unmount.

This is relevant only when the sheet remains open, not a universal Collab background loop. Application: suspend when hidden/offline and refresh on return; consider event-driven updates or quiet-state backoff.

### 5. Retained Herdr sockets still have heartbeat traffic

[`web/private-terminal.js:470–775`](../../web/private-terminal.js) retains up to four instance connections, even after leaving Terminal. Surface interest is disabled when no listeners or when hidden, subject to native acknowledgement. An older endpoint not advertising `client_shell.surface.set` cannot honor that suspension through this code path.

[`src/server/private-terminals.ts:602–621`](../../src/server/private-terminals.ts) sends a WebSocket ping every **15 seconds per connected instance**. The 1-second authorization check in the same block is **server-only**; it is not a browser poll every second. The browser answers WebSocket control pings at the transport layer. These connections are retained on visibility loss but closed on pagehide; see [`web/private-terminal.js:151–168`](../../web/private-terminal.js).

This is a plausible network baseline after opening Herdr, not proof of high CPU or a hidden renderer loop. Compare a never-opened-Herdr page against a previously connected page, and use explicit Disconnect for an A/B. Avoid replaying input or changing shared pane geometry merely to measure energy.

### 6. Even completed/unread and empty idle views can keep animating

- [`web/sessions.js:375–394,520–527`](../../web/sessions.js): fresh/unread completed results, manually marked unread threads and unread people-chat can give rendered sidebar rows the `pulse` class. Unread failed results also pulse. [`web/style.css:2738–2750`](../../web/style.css) repeats an opacity animation every **1.4 seconds indefinitely**. No agent needs to be running; read/seen rows are static. Sidebar approval-waiting marks themselves are static.
- [`web/transcript.js:2740–2746`](../../web/transcript.js): an empty conversation explicitly requires no entries and `!view.live.busy`, yet [`web/style.css:10774–10775`](../../web/style.css) animates its π opacity every **3 seconds indefinitely**. This is genuinely idle, not a loading indicator.
- [`web/transcript.js:2334–2345`](../../web/transcript.js): `LiveLine` updates elapsed time every **1 second** for its entire mounted lifetime, including waiting-for-approval state (lines 2381–2385), without a hidden-page guard.
- [`web/transcript.js:1132–1143`](../../web/transcript.js): live activity-group clocks also tick every second.
- [`web/subagents.js:209–220`](../../web/subagents.js) and [`web/subagents-board.js:497–506`](../../web/subagents-board.js): elapsed-time renders repeat while agents are considered working, without a hidden-page guard. The board explicitly counts approval-waiting as live too (lines 35–37,481).
- [`web/style.css:2569–2583`](../../web/style.css): the live dot keeps its 1.4-second opacity pulse when waiting for approval. Waiting changes its colors, not its animation.
- [`web/style.css:4983–5008`](../../web/style.css): working sidebar marks animate repeatedly, even if work is in another thread. This is conditional active-state UI, not an always-animating idle state.

A user can be idle while agents or an approval are not. The clocks above matter in that scenario; they are not evidence of one-second rendering on a fully idle completed thread. The unread/empty-view animations, however, need no active agent. CSS compositing costs need a real Safari timeline; do not assume an opacity animation repaints or that a small indicator explains heavy drain. The CSS-only `.state-warn` box-shadow animation has no repository UI usage and is not evidence of currently executing work.

**No-code A/B:** Appearance → Motion → **Reduced**. [`web/sheets/appearance.js:624–644`](../../web/sheets/appearance.js) exposes the choice; [`web/style.css:520–529`](../../web/style.css) reduces animation iterations to one globally. This isolates animations, not JavaScript timers or network requests.

## Lower-suspicion paths / things not established

- Main Collab event transport already closes when hidden/offline/pagehide: [`web/store.js:1085–1130`](../../web/store.js), [`1885–1894`](../../web/store.js). A prior lifecycle repair is `2257fd5`; this audit does not verify which frontend/server revision the iPad currently has.
- In foreground, SSE has a **15-second comment heartbeat**; idle long-poll fallback can wait **25 seconds**. [`src/server/http/events.ts:13,32,126`](../../src/server/http/events.ts). This is not a tight success-path busy loop: immediate responses may be legitimate queued events.
- Reconnects after real transport errors are another source of work. [`web/store.js:1195–1230`](../../web/store.js) checks `me` after an SSE error and can retry up to a 10-second delay; no evidence here shows the iPad actually in such a storm.
- Peeks report an empty visible list when hidden and deduplicate subscriptions: [`web/peeks.js:208–277`](../../web/peeks.js). Reporting retries after failures are timer-driven and not fully offline-gated; traces are needed before blaming them.
- Browser-panel frame polling stops when the document is hidden and the component unmounts when its panel closes: [`web/browser-panel.js:50–159,714–722`](../../web/browser-panel.js), [`web/app.js:377–431`](../../web/app.js). An open panel displaying remote activity can still transfer/decode images even when nobody is tapping.
- [`web/sw.js`](../../web/sw.js) is event-driven push/notification/share handling, not periodic synchronization or a background timer loop.
- WASM prefetch is once per owner/page lifecycle, downloads/compiles only, and does not initialize a GPU window: [`web/terminal-renderer-assets.js:134–209`](../../web/terminal-renderer-assets.js). It can cause startup work but is not a demonstrated sustained idle loop. The [completed pinned-backend investigation](ipad-battery-renderer.md) found demand-driven GPUI 0.3.6 scheduling, not a perpetual idle rAF loop, and no ordinary continuing renderer execution path after the child iframe is destroyed. Browser teardown and GPU-memory reclamation were not measured on this iPad; source evidence does not exclude a WebKit defect.

## How to settle causality

Record comparable **foreground idle** Safari CPU / JavaScript & Events / Layout & Rendering / Network timelines on the actual iPad PWA after startup settles. Keep brightness, workload, thermal state and network constant. Record iPad model, iPadOS version and actual served revision. Prefer short traces to identify recurring work, then a longer uninspected battery comparison; percent-battery over a few seconds is not a reliable metric.

Compare, changing one variable at a time:

1. Completed Collab thread, all agents idle, Browser/Running now closed, Herdr never opened.
2. Same with Motion Reduced.
3. Same with a supported code file open in the editor, without typing; then close the editor.
4. Same with Running now open but no running sessions.
5. Static Herdr Chat, then static Terminal, then return to Collab.
6. Previously opened Herdr with explicit Disconnect versus a retained connection.
7. App hidden/locked, then return: inspect whether application requests continue before OS suspension and whether recovery causes a request storm.

Use content-free request timings/counts and stack traces. Do not export terminal text, prompts, credentials, HAR cookies, auth headers or full private response bodies.

Suggested acceptance criteria for a later implementation:

- Work Items and Running now start no periodic requests while hidden/offline; disposal still aborts requests and clears timers.
- Handoff controls/commands get fresh, correctly scoped eligibility on use and relevant state changes, including retired-thread access changes.
- Static Herdr substantially reduces full reads and UI updates; real journal/process/native changes still appear within an explicitly chosen freshness budget.
- Hidden UI has no application-driven elapsed-time rerenders; visible clocks resume correctly without mutating agent state.
- No replayed terminal input, accidental terminal reconnect, private-data persistence or weakened live authorization.
- Safari traces show idle CPU/rendering falling alongside request counts, rather than relying only on unit tests.

## Platform source

WebKit's first-party [How Web Content Can Affect Power Usage](https://webkit.org/blog/8970/how-web-content-can-affect-power-usage/) recommends minimizing timers, network polling and continually animated content; getting idle CPU near zero; and using Timelines to find script/layout/paint/network work. It explains that hidden pages are throttled/suspended where possible, but messages/network/timers can still wake them. Therefore code-level visibility gaps are relevant, but background code admission is not a measurement of iPad background execution or energy.

The local diagnostics above were run via `node --input-type=module` heredocs with synthetic data and simulated timers; no harness files were added. `git diff --check` passed before this note was written. Targeted Markdown formatting was unavailable because this checkout has no `node_modules/.bin/prettier`; no package installation or alternate-environment workaround was attempted. No full suite or browser/device test was run, because source behavior is not a hardware battery result.
