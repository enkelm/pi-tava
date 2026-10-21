# Pip collaboration: mentions, Reviewer findings and range comments

Research checkpoint: local commit `61a25cf171e18c26e5c50cabf0437d76f1ef68b4` (2026-10-19).
Scope: human `@Pip` questions in side chat/review discussion, Reviewer-authored diff findings
labelled Pip while retaining the final review report, and comments anchored to multiple diff lines.
The last requirement is interpreted as line ranges; multiline comment text already exists.
No work-item takeover/automation, Land/Publish actions, sidebar reorganization, feature/source/test
changes, app-data access, restart or publication. This note combines inspection of Pip internals
with delegated investigations of chat, review collaboration and Reviewer finding publication.
User requirements are distinguished below from proposed defaults; the permission questions remain open.

## Recommendation

Keep **one visible Pip service identity**, but execute mention questions in **isolated,
discussion-scoped lanes**, not the owner's private PiP conversation. Reuse the ordinary chat/review
HTTP, persistence and room projection boundaries; add durable question admission and an internal,
idempotent in-place answer sink. Do not route questions through the destination coding agent's input
queue, fabricate a human account for Pip, or give this lane Pip's existing session-control tools.

For v1, allow steering collaborators to ask; viewers continue to chat/review without invoking AI
unless an explicit, bounded viewer-Q&A permission is approved. Exact driver semantics, payer, model
selection and cancellation rights need product decisions below. These are proposed policies, not
facts already implemented.

## Confirmed current behavior

### Side chat

- `POST /api/c/:id/chat` authenticates through the general API and checks conversation visibility;
  it validates text/request ID, then calls `Collab.postChat`. It deliberately does **not** require
  steering or driving (`src/server/http/api.ts:672-684`,
  `src/server/http/conversation-routes.ts:158-184`, `src/server/collab.ts:83-154`).
- Chat is a separate durable `pocket.chat` document, not main model input. It holds 500 messages,
  oldest first, and forks inherit its current contents (`src/server/docs.ts:440-472`).
  Main transcript quoting resolves an actual entry from that same conversation and stores a
  bounded snippet, not arbitrary client-supplied quote text (`src/server/collab.ts:101-115`).
- Mentions currently identify **configured people**, case-insensitively, excluding the author.
  Matching checks only the character after `@Name` for a letter/number/underscore; there is no
  preceding-boundary check or Markdown/code/quote exclusion. It is a notification parser, not a
  safe service-invocation grammar (`src/server/collab.ts:159-179`). A human named Pip could collide
  with naive service-name matching.
- New posts trigger best-effort notices/push after the commit. This is a detached call, not a
  durable execution outbox (`src/server/collab.ts:145-154,182-234`). It must not become the sole
  trigger for a model task: a restart between commit and dispatch could lose the question.
- The UI's suggestions and highlighting use the human `users` list; chat text is plain content,
  not the rich main-transcript renderer (`web/chat.js:166-208,225-281,414-436,502-527`).
  The label explicitly promises “Pi does not see this chat” (`web/chat.js:459-461`).
- API deduplication uses an author-prefix plus client key, finding the existing message in the
  retained chat list; no operation fingerprint is stored, and eviction removes that dedupe
  evidence (`src/server/collab.ts:117-145`). Browser `actions.chat` generates a **new** request ID
  on every invocation (`web/store.js:1631-1637`); a manual retry after a lost acknowledgement can
  therefore duplicate the human message and, without a new journal, a future AI question.
- Chat updates already have a scoped room event carrying new IDs only; opening/reopening a room
  loads the stored chat (`src/server/room.ts:344-346,406-422`). Reuse this path for final answers.

### Review discussions

- Review routes live beside chat under the same visible-conversation API; comment/reply/resolve
  do not submit to Pi (`src/server/http/conversation-routes.ts:50-92`). `Reviews.#person` resolves
  the **current** configured user and rechecks visibility; comment commit rechecks after awaited
  operations (`src/server/reviews.ts:159-171,397-520`). Viewers may comment while Pi works.
- Conversation-, file- and line-level comments are durable top-level threads; a reply names only
  its existing thread and cannot nominate a new anchor. Author ID/name, original cwd and optional
  client excerpt are retained (`src/server/reviews.ts:397-520`; `src/server/docs.ts:237-253,311-327`).
  Anchors/excerpts are advisory, not authoritative current file content.
- The author/owner alone may resolve/reopen a thread; bulk resolution authorizes the whole batch
  before mutations. A successful retry does not overwrite a later reopen
  (`src/server/reviews.ts:526-583`). Replies do not assign reviewer status; status derives from
  top-level authors' unresolved threads (`web/reviews.js:28-53`). A Pip answer should remain a
  reply, not create a new reviewer or automatically resolve the human's concern.
- Review retry receipts are author-bound, operation-fingerprinted and retained in a bounded
  document; reused IDs with changed payload conflict. They are not projected into the room
  (`src/server/reviews.ts:61-100,446-465`; `src/server/docs.ts:320-327`). Forks start without
  comment-review state. This is materially stronger than the current chat retry path.
- Review draft/request state is tab-local and user/conversation/anchor scoped; it saves the request
  ID before transmission, retains uncertain receipts, and captures the original target conversation.
  No saved request automatically resubmits (`web/reviews.js:55-159`). Anchor-context changes do not
  turn unchanged retries into new comments (`web/reviews.js:656-691`). Reuse these properties.
- Review composers/replies currently have no people/service mention parser or completion; text is
  rendered as plain paragraphs (`web/reviews.js:633-715,842-862`). Explicit “Send reviews to Pi” is
  a separate normal submission with steering/driver restrictions and quoted feedback, not an
  in-place reply (`web/reviews.js:21-26,188-225,261-272`). Do not repurpose that action as @Pip.
- Live review reads are narrower than Files: listed changed files inside cwd, canonical-path
  checking, and bounded UTF-8/no-follow context reads. Membership/cwd/file identity are rechecked
  around I/O (`src/server/reviews.ts:183-253,254-393`). Do not use an arbitrary filesystem `read`
  as the collaborator's review-context tool.

### Permissions and Pip are different boundaries

- Viewers currently “never make Pi do anything”; `requireSteer` rejects them, while `requireDriver`
  adds take-turns rules (`src/server/app.ts:1641-1676`). `SECURITY.md:12-14` documents that reading,
  chatting and reviewing do not grant prompting or Files access. Adding viewer AI invocation
  would intentionally change that contract; merely hiding completion from viewers is insufficient.
- Visibility propagates through scoped handoff ancestry but preserves every PiP/owner-only hop
  (`src/server/app.ts:1600-1639`). Human directory projection is filtered for scoped people
  (`src/server/app.ts:1538-1567`). A service entry should not widen this directory or mint access.
- Existing PiP is owner-only while enabled; its private conversation is found/created for its
  owner (`src/server/pip.ts:224-237,298-361`). `#person/#session` resolve that owner and owner-visible
  sessions (`src/server/pip.ts:475-506`). **Even an owner's mention in a shared thread must not enter
  this private context:** a generated answer could disclose earlier private owner messages.
- Existing Pip tool configuration is not an answer-only policy: it retains coding read, codemode,
  artifacts, schedules, memory and session-control facilities while removing bash/write/edit
  (`src/server/pip.ts:54-75`). Removing those three tools does not stop delegated mutations,
  cross-session disclosure, schedules, memory changes or application effects.
- Pip's `read` is bounded main-transcript projection plus approvals/schedules, not ChatDoc,
  CommentReviewDoc, live diffs or handoff metadata (`src/server/pip.ts:841-937`). Its `sessions`
  projection omits workflow fields available in the app catalogue (`src/server/pip.ts:779-838`;
  `src/server/app.ts:2080-2092`). Neither is a ready-made mention-context API.
- Existing Pip `send/#submit` generates owner-attributed `via` inputs, not Pip-authored discussion
  replies (`src/server/pip.ts:439-473,1001-1029`). `Commands.submit` requires visibility, driving,
  model and spend checks, queues/steers the destination coding run, and distinguishes assisted
  requests from human words (`src/server/commands.ts:830-960`). The handoff runtime requires actual
  written human input in the current main run (`src/server/handoffs.ts:1149-1182`). A mention or
  service answer must never be converted into synthetic human authority to hand off.

## Smallest sound design: affected boundaries

1. **Service identity, not authentication identity.** Add explicit, additive actor metadata to
   chat/review messages (for example `actor: { kind: "service", id: "pip" }`, plus reply provenance),
   retaining legacy `userId/name` compatibility as needed. Do not create `config.User`, token, role,
   owner attribution or online human presence for Pip. Only a server-internal sink may write a
   service actor; client-supplied actor fields must be rejected/ignored. Keep requesting human,
   payer and model provenance separately from the visible author. Preserve existing document
   kind/version/scope/history/fork contracts; use a new additive receipt/task document where useful.
2. **Shared invocation grammar.** Use one server-side parser for new human chat/review text, with
   token boundaries and an unambiguous reserved service target. Prefer only explicit @Pip outside
   quoted/code text; do not infer questions with an LLM classifier. Name-collision and literal-quote
   rules need a written decision. Persist canonical target IDs/spans so render and execution agree.
   No triggers from service posts, imported/forked history, event lines or model-generated text.
3. **Atomic admission.** Accept the human discussion message and a durable mention receipt/task in
   the same transaction. Bind identity to `(conversation, surface, sourceMessageId, serviceId)` and
   store an immutable payload/context-version fingerprint. If receipt/task capacity or invocation
   authorization fails, explicitly reject the invocation or post the human message with durable
   “not invoked” state—never silently accept a question that has no recoverable job.
4. **Narrow context lane.** One lane per side-chat discussion or review thread, serialized within
   that lane, isolated from private PiP and other destinations. Build context from the accepted
   question, bounded same-chat history/quote, or the exact review thread/anchor/excerpt/replies.
   Optional tools are only typed reads bound to this destination and the current requester. Review
   diffs/context should reuse the review-only restrictions; show when live context changed from
   the anchor. Do not load private Pip history, global memory, unrelated sessions, owner schedules,
   secrets, host-global files or other discussions. Treat all captured content as untrusted data.
5. **Question-only execution.** A dedicated tool allowlist and context builder, not full
   `PIP_EXTENSIONS` minus a few tools. No general read/bash/codemode, send/start/stop/follow, handoff,
   approvals, scheduling, writes, memory mutation, browser or external publication. Start with
   supplied context and safe typed reads; answer “not enough context” rather than borrowing owner's
   wider access. No hidden automation when a question asks for an action.
6. **Idempotent in-place sink.** A task's completed result is checkpointed before delivery; append
   one service answer and mark the delivery receipt in one commit, with a deterministic answer ID.
   Chat gets a source-message reference (existing `quote` refers only to main transcript entries);
   review gets a reply on the original thread, regardless of browser navigation. Never submit
   answer prose to the coding agent, reopen/resolve reviews, mutate files or change writer state.
7. **Projection/UI.** Reuse chat/review room updates, add service badge/avatar and completion in both
   composers, and render pending/failed/cancelled/retry state near the question. Update “Pi does not
   see this chat” to distinguish the main coding Pi from explicitly invited Pip; disclose which
   bounded history Pip receives. Plain text is the smallest safe renderer; rich Markdown can wait.
   Do not expose private task payloads, request IDs or owner-only failure details in room projections.
8. **Fix chat retry identity as part of admission.** Pin payload + request ID before send, capture
   conversation/user and draft revision, retain uncertain acknowledgement state, and explicitly
   retry the same attempt. Keep durable dedupe evidence independently of the rolling 500 messages.
   A second intentionally identical human message is a distinct request; a delivery retry is not.

## Lifecycle, restarts and concurrency

- Durable receipts are the guarantee for **at-most-one visible answer**, not a claim of exactly-one
  provider request. A crash during a provider call can produce uncertain spend. Prefer the existing
  Durable generation/request/result machinery over a detached model call. Its isolated lane ownership,
  access projection and usage accounting still need an implementation design; this investigation
  does not establish a ready-made collaborator runner. Never restart generation merely because a
  delivery ACK was lost. Retry failures with stable question identity and explicit attempt transitions.
- Re-resolve the requesting user and check current permission/visibility before context reads,
  generation and result publication, including after awaits; revocation blocks new disclosures.
  Scope the source to its original conversation/cwd/destination and retain captured context versions.
  Do not use a cached supplied role or replace the requester with the owner. Review membership
  rechecks provide an existing pattern; chat's pre-await check alone is not enough
  (`src/server/reviews.ts:159-171,446-503`; `src/server/collab.ts:89-92`).
- Ordinary coding work may stay busy: collaboration comments already work independently of it
  (`web/reviews.js:623-630`; `test/reviews.test.ts:748-788`). Mention generation must not steer, stop,
  enqueue work in, or claim the active writer of that run. Display stale/live context honestly.
- Retired threads should remain discussion locations if the human can still see them. A mention
  must answer there without resurrecting write authority or redirecting into the successor. Decide
  whether archived/deleted threads accept new questions; do not infer that from private PiP state.
- **Task ownership matters:** handoff idleness scans all nonterminal tasks attached to every work-item
  conversation, including background tasks (`src/server/handoffs.ts:1380-1443`), whereas `isBusy` is
  only the in-memory run set (`src/server/app.ts:2098-2105`). Naively attaching a mention job to the
  coding conversation would block handoffs/fetch and violate the separation above. Choose isolated
  non-writer task ownership/lane storage explicitly; do not weaken general workflow idleness.
- Forks inherit chat but start with empty reviews (`src/server/docs.ts:320-327,458-469`). Historical
  @Pip text must not fire again in a fork/recovery scan. Invocation ledgers/tasks should start empty
  in forks; already visible service answers can remain historical chat content. Pending jobs stay
  bound to the original source. Do not reconstruct jobs by scanning all retained mention text.
- Keep pending jobs durable while nobody has a room open. Extension/provider unavailability, quota,
  missing model and cancellation must have explicit status and no silent fallback or busy-loop retry.
  Disabling the collaborator stops/holds it according to a documented policy; private PiP lifecycle
  must not accidentally remove this lane's restrictions. Bound queue, context, response and receipts.

## Decisions requiring user/product input

- Steering collaborators only (recommended v1) or explicit viewer-Q&A permission? Does take-turns
  restrict Pip questions too, or only steering the coding agent? Viewers' plain discussion text must
  remain allowed, with clear feedback if their @Pip cannot invoke a job.
- Which bounded context is disclosed: whole current side-chat window vs question/quote only, and
  review-thread-only vs same-conversation main transcript/diff excerpts? Default to destination-only
  context even when the asker can see other private sessions; answers are shared with all readers.
- How is the collaborator model chosen? A possible default is the user-selected Pip model, with no
  silent fallback. How do nonowners see/configure an available model without gaining the private
  popup? Pin model/thinking settings per accepted job so later configuration changes are predictable.
- Who pays: asker, owner, or destination budget? Which existing user/session/provider spend limits
  apply? Check before admission/request and record usage once; surface holds without revealing
  another person's private spend. Bound/rate-limit repeated mentions and response length.
- Who can cancel/retry another person's job, and does cancellation leave a visible explanation?
  What happens on extension disable, model removal, author revocation or source deletion?
- Exact `@Pip` spelling, reserved-name collision rules, literal/code/quote exclusions, and whether a
  reply to Pip still needs another mention. Recommended first slice: every invocation is explicit;
  one consolidated answer per question; no self-triggering, unsolicited participation or escalation.
- Does the first item also include mentions in the main coding-agent composer, or just human chat
  and review discussion? The proposal above covers the latter. Main-composer routing needs a separate
  explicit design so `@Pip` does not collide with file mentions or accidentally prompt both agents.

## Added scope: Reviewer-authored findings displayed as Pip

### Human direction and proposed behavior

The human explicitly wants the existing Reviewer thread to leave comments on the diff labelled as
Pip, **in addition to** its final recommendations and validation report. This is a second producer
of Pip contributions, not a second independent review and not a question sent into private PiP.

- Reviewer findings create top-level file/line/range discussions. Human `@Pip` requests get replies
  within their existing discussion. Both show the same Pip service identity, with distinct purposes
  such as `reviewer-finding` and `mention-answer`.
- Display provenance such as “Pip · via Reviewer” with a visibility-checked origin thread reference.
  Store the originating review episode/run and reviewed version separately from visible authorship.
  The label must not imply that a second global Pip agent independently checked the Reviewer.
- Record actionable, code-local findings at their relevant anchors; broader findings can be file-
  or all-changes comments. Keep validation results, unavailable checks and overall recommendations
  in the final assessment rather than scattering a test transcript across the diff.
- Preserve the current Reviewer repair policy unless the human separately changes it. The default
  role explicitly makes bounded repairs and retests (`src/server/extensions/_work-item-profiles.ts:61-68`).
  A fixed finding and a remaining finding must not be presented as equally outstanding. Automatic
  resolve/reopen is not implied by publishing or answering a comment.

### Location, provenance and authority

Store findings in the **Reviewer conversation where the review happened**, not in the retired Worker
or every member of the Work Item. `CommentReviewDoc` is conversation-local and forks start empty
(`src/server/docs.ts:311-327`); rooms project only their own discussion (`src/server/room.ts:372-377,449-453`).
Handoffs create independent roots and retire the source without copying review documents
(`src/server/handoffs.ts:1908-2003`). A later Work Item-wide index can reference original discussions;
this slice should not silently relocate/copy them or promise they appear in Follow-up automatically.
Final assessments/handoff briefs should preserve the origin and finding references. Stable navigation
from transcript links into a specific discussion may need a new route: existing `reviewFocus` is
client state (`web/store.js:1796-1813`), not evidence of a persistent comment deep link.

The Reviewer can read live checkout changes from its own thread. Do not require its own transcript's
`byPi` attribution to include earlier Worker edits: live diff contents and transcript attribution are
separate (`src/server/reviews.ts:233-290`; `src/server/changes.ts:275-309,370-387`).

There is currently **no native tool for Reviewer-authored discussion**. The HTTP writer authenticates
a human and writes that human's identity (`src/server/reviews.ts:159-170,397-520`;
`src/server/http/conversation-routes.ts:50-92`). Recommended implementation:

1. Add a narrow, local-only finding tool/sink used during the existing main Reviewer run. Do not
   invoke another model or private Pip merely to turn that run's findings into comments.
2. Derive destination, Reviewer identity, requester and originating run from the actual invocation.
   Model arguments describe the finding/anchor, not arbitrary author, owner or target conversation.
3. Recheck live access, active main Reviewer type, writer ownership, destination and reviewed version
   at admission and commit. Helpers/non-Reviewers must not create fresh Reviewer-authored findings.
4. Recognize this exact capability in mandatory workflow policy: current hooks block unknown tools
   and restrict retired writers (`src/server/workflow-policy.ts:349-360,375-475`). A prompt-only
   instruction cannot grant it. Do not allow generic HTTP, unknown tools, filesystem or network escapes.
5. Reserve against handoff before the first await and release only after durable settlement, following
   `reserveWorkflowLocalWrite` (`src/server/workflow-policy.ts:268-317`). The initial tool hook alone
   cannot prevent a retirement race during awaited reads. Handoff admission takes the corresponding
   exclusive lock (`src/server/handoffs.ts:1317-1330`); retain both the lock and commit-time rechecks.
6. Use a server-bound review-episode/finding identity and immutable payload/version/anchor fingerprint.
   Append the finding, revision increment and delivery receipt atomically; replay returns the same
   finding ID. Changed payload under the same identity conflicts. Distinct review episodes may
   intentionally report similar concerns; do not globally deduplicate by text/path.
7. Prefer synchronous durable tool delivery within the review run rather than loose background tasks.
   If handoff wins admission, reject fresh finding publication without writing to either thread. If
   publication wins, handoff cannot advance until its reservation/tool settles. Do not redirect into
   a successor. Recovery after retirement, if supported, may only return an already-committed receipt
   under current visibility checks: no new anchor reads, findings or amendments.
8. A crash before commit leaves no visible finding; after commit, the receipt proves delivery. Lost
   acknowledgement returns original IDs without another model call. The final review report must
   disclose persistent comment-publication failures rather than claim the findings were posted.

Current human anchor admission checks scope and shape, not that the line/excerpt exists in the live
patch (`src/server/reviews.ts:421-438,484-515`). Reviewer publication should use server-observed anchor
text and a reviewed-version fingerprint. That means the version actually inspected, not merely HEAD
observed at delivery; a server-created diff/context version token is one option. On drift, preserve
the reviewed anchor as outdated or request fresh inspection; never silently substitute current text
and imply it was assessed, or attach old findings to unrelated code.

Top-level human authors currently define reviewer grouping; replies do not create a reviewer row
(`web/reviews.js:28-53`). Extend grouping to a stable Pip actor key, retaining run provenance per
finding. Pip Q&A replies must not create a reviewer entry; top-level Reviewer/Pip findings should.
Do not render Pip as Owner or as an online human (`web/reviews.js:10-18`).

The smallest proposed resolution policy is **owner resolution for service-authored findings**;
existing human author/owner permissions remain unchanged. The requesting human does not automatically
become the service comment's author. Giving steering collaborators broader resolve rights would be
an explicit policy change (`src/server/reviews.ts:543-581`; `web/reviews.js:346,744`). This is a proposed
default, not a human-approved new permission rule.

## Added scope: multi-line diff-range comments

### What exists and what changes

The current composer is a normal multiline textarea; the server preserves interior line breaks
(`web/reviews.js:632-730`; `src/server/reviews.ts:33-43,406`). No runtime/browser reproduction of a
multiline-text defect was performed. The missing storage/interaction is a **range anchor**: current
threads have only `path`, one `side` and one `line` (`src/server/docs.ts:237-253`).

Proposed representation and behavior:

- Add optional `startLine`; retain existing `line` as the inclusive end. An old comment without
  `startLine` is the one-line case. Do not rename stored fields or introduce competing canonical ends.
- One file, one old/new side, positive ordered inclusive range. Reject cross-file/mixed-side anchors,
  invalid/inverted ranges and unbounded captures. Exact line/byte limits need to be chosen explicitly.
- Use the same anchor representation for human comments and Reviewer/Pip findings. Replies inherit
  it and cannot move it, extending the existing reply rule (`src/server/reviews.ts:421-430`).
- Keep existing single-line `context` semantics compatible; add bounded full-range evidence/version
  rather than silently replacing it with a truncated multiline excerpt. Include the whole range
  and its evidence in retry fingerprints and browser draft/receipt identity.
- Verify the **entire range**, not just both endpoints, before inline placement. A middle-line edit
  must make it outdated even if the first and last lines remain identical. Do not partially attach
  a range or collapse it onto its end line. Retain the original range/excerpt for outdated discussion.
- Extend exact-anchor filtering, location labels, review feedback export, focus/navigation and unified/
  split rendering, not just the document shape (`web/reviews.js:180-226,565-590`;
  `web/diff.js:610-740`). Existing placement deliberately checks captured text rather than relocating
  comments merely because their line numbers still exist.

### Interaction direction (proposed, not device-tested)

Preserve the existing inline composer and review visual language; this is not a diff redesign.
Support desktop start/end selection through line numbers, with Shift-click as an accelerator.
Offer an explicit range-selection action with selectable endpoints for touch and keyboard users;
no mouse-drag-only interaction and no long-press/drag that takes over normal code copying or scrolling.
Show the selected range before submission (for example “new lines 42–48”), highlight it, allow
correction/cancellation, and place one discussion after the range endpoint with its range label intact.
Delay touch keyboard focus until selection is accepted. Keep code selectable and pinch zoom available;
coarse-pointer iPad layouts need explicit controls even at desktop-sized widths.

A range spanning hidden context must capture/verify that full interval, expanding safely when available
or explaining why it cannot be selected. Never claim that only the visible rows constitute a contiguous
source range. Real iPhone/iPad Safari, native keyboard and selection-versus-scroll behavior remain
hardware verification work; desktop emulation is not that evidence.

### Additional acceptance criteria for these two additions

- One actual Reviewer episode can create Pip-labelled file/line/range findings and still produce its
  final recommendations, actual checks, gaps and risks. The label/provenance does not claim another
  independent review, approve Land/Publish or create a workflow gate.
- HTTP clients cannot forge service authorship/provenance; non-Reviewer, helper, cross-conversation
  and retired fresh invocations are denied by the actual native path. A handoff racing admission
  cannot leave new findings attributed to a retired active run.
- Concurrent/restarted delivery has one visible finding per stable identity; conflicting retries do
  not overwrite it. No private Pip run, coding-agent submission, self-triggered mention or GitHub post.
- Pip top-level findings group as Pip; Pip replies do not alter reviewer membership or auto-resolve
  human concerns. Existing resolution permissions and durable reopen protection remain intact.
- Old one-line comments/drafts work. Human and Pip range comments survive reload, retries and layout
  changes. Reversed/invalid/cross-file/mixed-side inputs are rejected at the server.
- Unified and split views highlight the correct old/new interval. Changed middle lines, deletion,
  commit, rename and cwd drift preserve original evidence as outdated rather than misplacing it.
- Mouse, keyboard and wide coarse-pointer interaction have executable UI coverage; real-device
  selection, scrolling, keyboard and Safari checks are reported separately when available.

## Suggested acceptance criteria / focused tests (not implemented)

- Parser: @Pip casing/punctuation and start/end boundaries; no @PipExtra/email/quote/file/code triggers;
  human named Pip cannot redirect/spoof service identity; repeated tokens make one job.
- Auth: owner, scoped steering guest, nondriver and viewer matrices; direct forged HTTP requests;
  role/session revocation while body/context/model request is in flight; owner asks a shared
  question after putting a unique secret in private PiP—secret never enters lane context/output.
- Durable admission: concurrent duplicate requests, conflicting ID payload, lost acknowledgement,
  chat eviction then retry, restart after message commit/before provider call, after result/before
  answer commit, and after answer commit/before ACK. One visible answer and one usage record;
  explicit provider uncertainty where the transport cannot guarantee one call.
- Surface behavior: same review thread/source chat reference after navigation and reload; Pip reply
  preserves author, anchor, reviewer status and resolve permissions. Plain comments remain plain;
  “Send reviews to Pi” continues to require steering/driver rights.
- Isolation: busy coding agent is unchanged; background mention does not block handoff/fetch,
  acquire write ownership or wake retired coding work. Fork/reopen/recovery does not replay old
  mentions. Cross-chat/review/private-Pip context does not bleed between lanes.
- Failure policy: unavailable extension/provider/model, quota hold, cancellation, oversized context,
  max review/chat metadata and reply length give durable bounded status and retain human drafts;
  retries do not clear newer drafts or target a newly selected conversation.
- Existing test neighborhoods: `test/app.test.ts:648-777,984-989` (chat/access/mentions) and
  `test/reviews.test.ts:76-292,294-433,620-675,748-788` (HTTP/receipts/restart/live authorization/busy),
  plus `test/reviews-ui.test.ts`, `test/pip-chat-ui.test.ts` and submission-recovery UI patterns.

## Evidence limits

Code/document inspection only; no tests or browser checks executed and no new behavior proven.
`git diff --check` passed, and a direct scan of this new note found no trailing whitespace. The
Prettier check could not run because `node_modules/.bin/prettier` is absent; no dependencies were
installed. Read the live canonical `docs/index.md`, `map.md`, `architecture.md`, `features.md` and `SECURITY.md`
under `/Users/enkelm/.pi-durable-app/worktrees/pi-coop-fe2203`; implementation citations above refer
specifically to local commit `61a25cf171e18c26e5c50cabf0437d76f1ef68b4`. Canonical docs discuss newer
SSH/backend boundaries; local `reviews.ts` here is the host-local implementation, so those docs are
not proof this checkpoint already has all described remote review support. Any shared adapter must
respect the real destination and fail closed rather than read a host namesake. No external sources
were necessary. Only this design-research note was written. It is retained in
`docs/design/pip-collaborator-mentions.md`: `docs-site/src/repo-docs.mjs:46-52` includes research notes
but excludes `docs/design/`, so this proposal does not add an unregistered docs-site page. No site
files changed; docs-site build was not run. Product choices above remain proposals awaiting the human.
