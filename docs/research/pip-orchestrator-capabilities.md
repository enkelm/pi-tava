# Current PiP capabilities relevant to a Work Item orchestrator

Source checkpoint: `add93ee6c9ccb8b321b928f0375cceecf646cee6` (local `HEAD`, inspected 2026-10-20). This is a source-only investigation, not a runtime/UI evaluation or implementation proposal. No tests were run for this note. All line ranges below refer to this checkout. Historical design notes are not used as evidence of shipped behavior.

## Answer in brief

There are two separate PiP execution contexts, plus a separate Reviewer publication adapter:

- **Private owner assistant:** a durable, owner-only Chat conversation with cross-session list/read/control tools. Its tools work against visible catalogued managed threads too, but its session summaries discard Work Item metadata, and it has **no `handoff` or `work_context` tool**.
- **Mention collaborator:** an ephemeral model loop invoked by an explicit human `@PiP` in side chat or a review discussion. Its **only tool is `work_context`**, which can read the source and visible same-Work-Item threads, discussions, current source and Changes/diffs. It receives the Work Item's visible active-thread identity, but has no session control or handoff powers.
- **Reviewer comments:** `review_comment` publishes the active main Reviewer's existing findings as PiP, without invoking either PiP model. It is not the collaborator runner.

Evidence: `src/server/pip.ts:69–80,258–284,472–557,653–687,960–1121`; `src/server/pip/private-agent.ts:642–687`; `src/server/pip/mentions.ts:62–75,575–615,669–724,888–906`; `src/server/pip/shared-context.ts:12–34,80–169`; `src/server/app.ts:548–576`; `src/server/pip/reviewer.ts:234–245`.

**Important asymmetry:** private `session_read` omits tool-result bodies, whereas collaborator transcript reads **include textual tool results**, clipped to 4,000 characters per entry. Neither supplies a complete live runtime/task view. See the context sections below.

## 1. Private owner PiP

### Identity, scope and tool registration

Creation/reopening validates the current owner and PiP execution setting. New private PiP is explicitly `threadType: "chat"`, `pip: ownerId`, rooted at the server's default cwd. Its stored agent selects only `coding-tools`, `pocket-pip`, `pocket-artifacts`, `pocket-schedules`, `pocket-guard`, `pocket-codemode`, and `pocket-memory`; `bash`, `write`, and `edit` are removed. Reopening tunes that selection to the current list. It does **not** select `pocket-core`, where `handoff`, research, publication, upload staging and `review_comment` are registered. Installing a registration globally is not the same as selecting it for this conversation. (`src/server/pip.ts:69–80,269–283,395–398,472–557`; `src/server/app.ts:548–576`; `src/server/pip/private-agent.ts:658–662`.)

The complete private PiP-owned tool set is:

| Tool | Actual operation |
| --- | --- |
| `sessions` | List visible sessions, with title/folder/branch text search, state filter, archived-vs-unarchived selection and bounded limit. |
| `session_read` | Read a bounded newest slice of one session, plus approvals and schedules. |
| `session_start` | Start an independent session; optional folder **or** GitHub repo, title, worktree, model, initial message, automatic follow/report. No Work Item, project, relationship, destination-thread or thread-type parameter. |
| `session_send` | Send self-contained text, queued by default or steering now; report defaults on. |
| `session_follow` | Follow the current run; if already idle, return last answer immediately. |
| `session_stop` | Stop the run and withdraw queued work through Commands. |
| `session_archive` | Archive/restore through Commands. |
| `session_schedule` | Add/list/cancel scheduled text in another session. |
| `approvals` | List/deny waiting approvals; no allow operation. |
| `repo_watch` | Add/list/remove a watch with event filters, instructions and optional target session. It cannot set `anyone: true`. |
| `session_watch_pr` | Start/status/stop a PR watch from a session. |

Exact schemas and dispatch: `src/server/pip/private-agent.ts:151–276,278–470,471–640,642–657`. Creation implementation: `src/server/pip.ts:1129–1174`.

Other selected registrations supply `read`, and—when those optional modules are installed—`artifact`, `schedule` (private-conversation reminders), `codemode`, and `memory`. Guard supplies hooks, not an extra tool. The installed Durable coding-tools package contains exactly read/write/edit/bash; removing the last three leaves `read`. Codemode enumerates **the current agent's tools**; it does not recover unselected core capabilities. (`node_modules/@earendil-works/pi-durable/dist/tools/index.js:1–14`; `src/server/extensions/artifacts.ts:58–60`; `src/server/extensions/schedules.ts:18–20`; `src/server/extensions/memory.ts:42–53`; `src/server/extensions/guard.ts:15–19`; `src/server/extensions/codemode.ts:184–205`.)

Private PiP has no browser, subagent, shared-work reader or handoff registration in this selection. Tests explicitly check read/control presence and bash/write/edit/browser/subagent absence (`test/pip.test.ts:371–396`). The ordinary `read` is not the requester-bound, same-item `work_context` adapter; private cwd defaults to the server folder, not the thread behind the panel (`src/server/pip.ts:498–516`; `src/server/pip/shared-context.ts:12–34`).

### What private PiP can see through its session tools

`sessions` maps the richer app catalogue into only: id, title, coarse state (`needs approval`/`working`/`idle`), folder, archived, optional model, optional worktree branch, updatedAt, and a textual subagent-count summary. Default limit is 25, maximum 100; it returns a remaining count, not a cursor, and at most 12 folders. Search covers title/folder/branch. This mapping **drops project, thread type, Work Item id/title, active-thread identity, workflow state, pinned SSH location, failure flag, budget, people and chat metadata** even though the app catalogue supplies many of them. (`src/server/pip.ts:960–1020`; compare `src/server/app.ts:2111–2185`.)

`session_read` defaults to 40 newest stored entries, clamped to 4–200, with no `before`/cursor parameter. It produces:

- Title, folder/worktree branch, archived flag and coarse run/approval state.
- Pending approval ids/tool/subject and scheduled-message descriptions/text excerpts.
- User display text, capped at 600 characters; assistant text at 600 except the latest text-bearing assistant entry at 3,000. The tool description's “last answer in full” is therefore not literally guaranteed.
- Tool-call **name and first nonempty string argument** (argument snippet 120); failed marker if its error result is in the fetched page. It does **not** emit tool-result text/details/images.
- Notes (300-character snippet), shell command (200), stopped/error markers, and markers—not summary content—for compaction/reset.

It does not fetch `ChatDoc` or review discussions, current diffs, workflow/Work Item state, helper transcripts, live streamed generations, full task graphs, spending holds or inbox contents. Its visible messages are coding-agent conversation entries, not every surface shown around that conversation. (`src/server/pip.ts:133–135,178–190,1022–1121`; schema `src/server/pip/private-agent.ts:194–207`.)

Attachment handling is lossy in session reads: `projectEntry` exposes user text and separate files/image metadata, but `Pip.read` uses only `entry.text`. Text already containing an attachment-path heading can survive the 600-character cap; image parts and separately projected file metadata are not forwarded. Inline file-content blocks are removed by projection. This is not an attachment-content reader. In contrast, files attached **directly to private PiP's own input** use normal Commands attachment handling, including supported image parts for image-capable models. (`src/server/projection.ts:337–372`; `src/server/pip.ts:1050–1053`; `src/server/commands.ts:921–978`; `docs/features.md:97,124`.)

The status added after control operations also counts waiting inbox messages and can say “about to start”; list/read use only their coarser states. Thus “idle” from list/read is not proof of an empty queue or settled descendant/background work. (`src/server/pip.ts:938–957,974–979,1087–1094`; `src/server/pip/private-agent.ts:132–138`.)

### Authority, mutation and follows

Private tools derive authority from the live owner of **the actual PiP conversation**, refuse while PiP is disabled, and require target visibility. A target must be a catalogued session other than PiP/another private PiP; there is no rejection based on managed thread type, retirement or Work Item membership in this target resolver. Private PiP is cross-session, not item-scoped. (`src/server/pip.ts:653–687`.)

Reads, starts and reports establish a 15-minute “looked at” record in memory. Most control actions require a recent look; restart loses this record. Starts are limited to 20/hour, actions to 60/hour, with at most 50 concurrent follows. Model choices/names are checked against the owner's actual words; PiP cannot independently substitute a model. (`src/server/pip.ts:82–112,211–226,560–573,690–706,832–935,1523–1608`.)

Sending goes through `Commands.submit` with `via: PiP`, with live visibility, steering, turn, model and spend checks. Starting uses `Commands.createSession`; there is no handoff invocation or Work Item activation in it. Sending a message is not an ownership transfer, and only the active thread's own guarded tools can perform managed writes. (`src/server/pip.ts:617–649,1157–1173,1181–1207`; `src/server/commands.ts:890–1016`; `src/server/workflow-policy.ts:403–410,522–650`.)

Follows are durable tasks owned by **private PiP**, not a Work Item or the followed source. They wait for the identified submission or run idle, then send a bounded textual answer/report. Idle lookup examines only 16 newest entries; answer text is capped at 3,000. A report conveys completion/abort/error/delivery outcome, not verified checks, full logs, workflow status or a handoff successor. The followed id is fixed; the code does not switch a follow to the next active Work Item thread. Pause holds reports; a spend hold turns them into notes instead of a new PiP run. (`src/server/pip.ts:1523–1608,1664–1811,1825–1888`.)

Private PiP's durable conversation is also not an exact archival memory of session evidence: its compaction source deliberately strips fenced session/webhook/GitHub content, file-read results and script output. Own tool outcomes and preferences/open work can remain, but fenced external evidence does not survive as its summary. (`src/server/pip-compact.ts:65–164`.)

## 2. Shared mention collaborator

### Invocation and execution scope

Only the human discussion sink calls admission; it requires an actual human-authored, non-service message containing a parsed mention. Sources are side-chat messages or review openings/replies, not arbitrary agent transcript outputs. Admission rejects private PiP, owner-only and internal-lane sources. It requires current steering/visibility, current turn, enabled PiP, a configured/authenticated collaborator model, spend availability and global active capacity (64). The shared model selection is separate from private PiP's and pinned into each job. (`src/server/collab.ts:145–151`; `src/server/reviews.ts:858–868`; `src/server/pip/mentions.ts:35–37,177–330`; `docs/features.md:93–95`.)

The job runs in an independent, ownerless, non-viewable durable lane. The provider conversation itself is an ephemeral agent-core loop with one tool, not the private conversation's extension registry. It never enters either coding-agent/private conversation history as a model conversation. The final text is posted to the exact parent chat message or original review thread. There is no `session_read`, `sessions`, `handoff`, schedule, memory, shell, browser, publication, session-start/send/stop or direct file-write tool. (`src/server/pip/mentions.ts:62–75,80–119,122–176,282–323,575–615,669–724,851–909`.)

### Initial context

At admission, the captured discussion JSON contains the exact question's name/text; for reviews, captured path/side/line/range/context and opening text when replying; for chat, quoted-message text when present; and up to six preceding non-event messages/replies, newest first. Context addition is bounded and marks omissions. It does not capture all chat/reviews or synchronize that excerpt continuously. (`src/server/pip/mentions.ts:357–417`.)

At execution, this is supplemented with **current** thread/project/Work Item summary and up to eight newest stored public transcript entries from the source. Context is capped at 32,000 characters; discussion context and transcript entries can be removed to fit. The initial active-thread id does not automatically pull that active thread's transcript: source transcript is initial, and the model must request another thread explicitly. (`src/server/pip/mentions.ts:616–645`; `src/server/pip/shared-context.ts:120–178`.)

### Exact `work_context` surface

All reads reauthorize the requester, check visibility and restrict targets to the source root or visible member roots of the **source's current Work Item**. Private PiP/owner-only/internal-lane targets are denied even to the owner. Cwd/location/project are pinned per selected target and rechecked after reads. A standalone source has no access to unrelated sessions merely because their cwd matches. (`src/server/pip/shared-context.ts:80–117,180–184,314–316`; `src/server/work-items.ts:382–398,517–532`.)

| Action | Returned evidence and limits |
| --- | --- |
| `status` | Always source-rooted summary: source id/title/type; project id/name when visible; source workflow status/readOnly/paused/preparing; Work Item id/title, visible activeThreadId/originThreadId, up to 12 visible threads (id/title/type), truncation flag. Not a handoff eligibility probe. |
| `thread` | Stored public history for target, newest first; `before` pagination; default 20, max 100 entries; optional case-insensitive literal query filters **only the fetched page**. Per-entry text cap 4,000. |
| `discussion` | Non-event chat name/text (default last 12); last review threads (default 8), including anchor/context/resolved and last six reply name/text pairs. `limit` caps chat and review counts (max 100). No earlier-discussion cursor or effective query filtering. |
| `files` | Current source paths, optional name query; default 80/max 100, truncation flag. No cursor/start offset. |
| `file` | Current UTF-8 source: relative path, revision, numbered lines, nextLine; default 80/max 100 matching lines, startLine and optional literal query. |
| `changes` | Current native Changes result with bounded file list and Pi-only edit list (default 60/max 100); optional path-name query filters `files`; remaining count. No pagination cursor. |
| `diff` | Current native diff for a relative source path, paged by diff-output line number, default 80/max 100 lines and nextLine. |

Schemas/implementations: `src/server/pip/shared-context.ts:12–34,120–316`; transcript storage pagination `src/server/transcripts.ts:117–146`. Source readers reject absolute/traversal/protected paths, escaped symlinks and private application/Pi roots, use the local/SSH workspace dispatcher and canonical rechecks, and require UTF-8 text (`src/server/workspace.ts:672–797`). Changes/diff use existing requester-bound local/SSH review machinery (`src/server/reviews.ts:463–513`).

### What “public transcript” includes and omits

The transformer returns only `{id, kind, text, truncated?}`:

- Assistant **text** only; no thinking, tool-call blocks/arguments, provider/model, stop/error metadata, native finding references or author metadata.
- Text from any other projected entry having a `text` property. **This includes `toolResult.text`**, as well as user/note/reset text.
- Compaction summary text. Shell/command entries expose `command`/`output`, not `text`, so they arrive with empty text; other entries without eligible display text can also be present with empty text.

Tool-result **details**, call id/name/error status, image payloads/counts, user file metadata, timestamps and raw entry metadata are discarded. User text can still include literal attachment path headings; inline file-content blocks are stripped by `projectEntry`. There is no attachment/image-read action. The comment “no … tool details” is not a ban on textual tool-result content. (`src/server/pip/shared-context.ts:46–64`; `src/server/projection.ts:337–372,405–444,487–516`.)

Neither initial context nor `status` supplies live busy/streaming state, approval queue, queued inputs, helper/background task status, model availability per work thread, spend/hold values or complete Work Item execution graph. Status's workflow flags and active-thread identity are useful but not a runtime-idleness/readiness proof. Its 12-thread list can omit the active thread from the listed titles when there are more members; activeThreadId remains independently exposed when visible. (`src/server/pip/shared-context.ts:120–178`; compare richer app catalogue `src/server/app.ts:2154–2185`.)

### Budgets, lifecycle and output

The run permits at most four model responses/eight read calls within a 60-second cancellation window, maxTokens 1,600 per response; tools are removed before the last response. Each read's serialized output is limited to 16,000 characters, each tool argument object to 8,000, and continuation context to 128,000. Denied/oversized reads yield a generic narrowing/unavailable error, not partial unlimited evidence. Responses are metered before subsequent policy/delivery failure; permission/turn/source/budget are rechecked. (`src/server/pip/mentions.ts:524–570,581–615,648–795`.)

Only final text is posted, capped at 4,000 characters (prompt asks for 3,800). Thinking and claimed native references/tool calls are not published as findings. Review suggestions may be emitted as text after checking the current selection, but only the human Apply operation writes code. Pause aborts shared work; uncertain provider calls are not regenerated after restart, while saved ready results may finish delivery. These jobs are independent of the source's idle lane, not its delegated writers. (`src/server/pip/mentions.ts:62–75,94–119,163–176,831–909`; `test/pip-mentions.test.ts:297–363,789–861,863–1028`.)

## 3. Handoff/session-read availability in managed work

**Do not conflate tool registration with exposure or authority.**

1. **Private PiP can `session_read` a managed Work Item thread.** The target resolver checks catalogued identity and visibility, not Work Item type. It reads stored conversation history directly. It does not use the target agent's tool selection or inspect that target's handoff state. This still returns the limited private summary above, not Work Item-aware context. (`src/server/pip.ts:669–687,1022–1121`.)
2. **A normal managed agent does not automatically get `session_read`.** That name belongs only to the private PiP registration; core registers `handoff` and `review_comment`, not private session tools. Managed hooks reject unrecognized extension tools; manually assuming PiP tool availability in a work thread is incorrect. (`src/server/pip/private-agent.ts:642–657`; `src/server/app.ts:548–576`; `src/server/workflow-policy.ts:522–650`; `test/pip.test.ts:371–396`.)
3. **The mention collaborator has no handoff/session-read control registry.** It gets `work_context` only. Its `thread` read provides requester-bound same-item history instead. (`src/server/pip/mentions.ts:575–615`; `src/server/pip/shared-context.ts:12–34`.)
4. **`handoff` is real for normal core-selected main threads.** Actions are `status` and `start`; start takes targetType, optional same/new-work relationship and 1–12,000-character summary. Core derives requester from the actual invocation and enforces main-thread/current placed human-input authority, source ownership, transitions and settled work; status is permitted in managed read-only state as well. It is not a generic cross-session transfer function. (`src/server/work-items.ts:183–211,435–490`; `src/server/handoffs.ts:324–346,932–1005`; `src/server/workflow-policy.ts:556–563`; `docs/handoffs.md:124–128,164`.)
5. **Forwarding an owner request via `session_send` does not itself authorize handoff.** PiP messages use `p:` request ids (`requestFor`); `Commands.submit` with `via` deliberately retains non-human authorship. Handoff's current-run input scan requires `requestPerson(...).wrote === true` (`u:`) and excludes couriers/schedules. A run containing a separate qualifying real human input is different; PiP forwarding alone is insufficient. (`src/server/pip.ts:617–649`; `src/server/commands.ts:975–1016`; `src/server/requests.ts:14–30`; `src/server/handoffs.ts:945–1005`.)

The new/legacy private-PiP lifecycle regression verifies Chat classification and list/read/send/report against a normal created session across restart; it separately asserts that explicit managed metadata is not erased or exempted. It does not turn private PiP into a managed orchestrator or test a handoff tool in private PiP. (`test/pip.test.ts:161–305`.)

## 4. Reviewer publication is a third, separate capability

The `review_comment` tool is selected with ordinary core tools, not private PiP or shared mentions. It uses inspect/post, pins an observation/diff and exact old/new inclusive context, and obtains the active main Reviewer's identity from the real tool invocation; it checks writable state/current requester and does not accept an arbitrary author/destination. It makes no additional PiP model request. A PiP-authored finding visible in a review therefore does **not** demonstrate collaborator session-control/review-write power. (`src/server/app.ts:554–576`; `src/server/pip/reviewer.ts:201–229,234–245,469–515,527–565`; `docs/features.md:95`.)

## 5. Existing evidence and limits of this investigation

Read, but not executed here:

- `test/pip.test.ts:133–159,161–305,371–435,514–585,603–667`: owner isolation, private selection/lifecycle, send/follow recovery and fencing.
- `test/pip-mentions.test.ts:212–295,365–458`: collaborator/private model isolation, current code/history reads, usage and reasoning continuation. The current-work reader fixture is a **Chat** source; it is not proof of complete managed Work Item coverage.
- `test/pip-mentions.test.ts:460–616`: foreign/private/path escapes denied, loop limits and read-time revocation.
- `test/pip-mentions.test.ts:679–861,863–1100`: admission constraints, no invented tool powers, bounded public output, model pinning, source-idle independence, pause/restart/revocation behavior.
- `docs/features.md:91–98` and `docs/handoffs.md:124–128,164,221` describe these separate surfaces and explicitly do not claim an autonomous project orchestrator.

Confirmed gaps are **different across contexts**, not a single “PiP cannot see work” limitation: private PiP has cross-session control but loses Work Item identity/discussions/tool-result evidence; shared PiP has bounded same-item reads and visible active-writer identity but no control/handoff powers and no full runtime state; Reviewer PiP authorship is a publication adapter, not an orchestration agent. This note makes no UI/design recommendations and claims no live validation.
