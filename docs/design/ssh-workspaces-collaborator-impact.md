# SSH workspaces: collaborator/access impact at 8618832

## Evidence boundary

- Bounded investigation of `c79cf3f...8618832`, not an exhaustive security review.
- Head: `861883244a1275aa6471f140913c20541f17a1fc`; verified parent: `c79cf3f14dd0c7ec7d38cfdac36b171c729eb0fa`.
- All citations are **at that head**, read with `git show 8618832:<path>` and numbered
  from committed blobs, not the dirty checkout. Intent: `docs/projects.md:44–86`; `SECURITY.md:12–14,21–23`.
- Read test-audit first. No tests executed; no network, SSH target, app data or credentials accessed.
  Only this note written, with no source/test edits, restarts or other notes changed.
- Earlier baseline61a notes are not evidence that these new contracts existed then.

## Bottom line

SSH adds pinned workspaces and owner-controlled sharing, not a new role or exposed credential.
Visibility, execution, project trust and authentication remain separate authorities, but project
access can authorize real remote effects through owner passwords (`docs/projects.md:48–54,78–86`;
`src/server/ssh-sessions/authentication.ts:96–180`). No confirmed access defect found in this
bounded slice; risks below describe documented contracts, not a full-audit verdict.

## Project grants and visibility

- `User`/invites gain optional `{all?,local?,hosts?,projectIds?}`; `sessions` takes
  precedence. Sources: `src/server/config.ts:21–34,55–66`; `src/server/project-access.ts:7–12`.
- Selectors combine by **union**. Hosts match exact SSH destination strings, not paths,
  resolved machines or equivalent aliases. `{}` grants none; all/local/host grants include
  future matches. Source: `src/server/project-access.ts:14–82`; `docs/projects.md:78–80`.
- New non-owner invites default to `{}`; only the live owner/token issues them, redemption rechecks
  authority, and no host Pi-history grants are accepted (`src/server/auth.ts:118–170,184–192,235–263`).
- **Absent is not empty:** missing grants preserve legacy scope; there is no restrictive
  migration. Any explicit grant disables legacy `continuePiSessions`, even `{all:true}`.
  Sources: `src/server/project-access.ts:67–82`; `src/server/config.ts:44–52,491–497`.
- Access checks both the current project and the thread's pinned namespace. Host-only
  grants exclude an old override on another host; changing project defaults can remove
  visibility without retargeting that thread. **Project IDs and `all` deliberately match
  across namespaces**, not as machine restrictions. Sources: `src/server/projects.ts:168–190`;
  `src/server/project-access.ts:67–82`; `test/project-permissions.test.ts:99–214`.
- All-projects excludes unassigned threads. PiP-person/owner-only restrictions survive ancestry;
  session invitations flow forward through handoffs, not across a project (`src/server/app.ts:1678–1723`).
- Session-scoped catalogues contain only visible threads' projects, omitting default cwd/location;
  project grants can expose granted empty projects (`src/server/projects.ts:208–229`).

## Owner controls versus collaborator/viewer rights

- Only current owner/token edits grants; owner rights cannot be narrowed. Project create/update/move
  are core owner-only (`src/server/app.ts:2418–2474`; `src/server/projects.ts:137–157,232–261,295–320,405–428`).
- Steering collaborators create only in granted projects at saved host/cwd. Matching defaults work;
  overrides/worktrees/unassigned Chat fail. Preparation and placement reauthorize; changed defaults
  reject placement (`src/server/projects.ts:192–205,351–402`; `src/server/commands.ts:483–515`).
- Collaborator SSH creation uses saved metadata, with no SSH preparation/remote model defaults;
  those remain owner paths (`src/server/commands.ts:510–584`).
- Viewers cannot steer/create. Files list/view and ordinary Changes require steering;
  review changes/diff/context require visibility with an explicit human requester.
  Sources: `src/server/app.ts:1731–1760`; `src/server/workspace.ts:505–511,647–656,988–995`;
  `src/server/reviews.ts:206–219,346–428`; `src/server/workflow-policy.ts:488–519`.
- Discovery, arbitrary preparation/browsing, password login/status/forget and trust are
  owner-only. Password submission also needs HTTPS/localhost; mutations need `X-Pocket`.
  Sources: `src/server/ssh-sessions.ts:59–95,319–345,408–447`;
  `src/server/ssh-sessions/authentication.ts:56–63,183–224`;
  `src/server/http/api.ts:169–175,718–755,811–845`; `src/server/app.ts:2694–2756`.

## Pinned execution and delegated passwords

- Threads store their own location/cwd; defaults and placement do not retarget them.
  Root namespace drives environment dispatch, not equal path strings. Sources:
  `src/server/commands.ts:548–561`; `src/server/app.ts:1118–1126,2645–2653`; `docs/projects.md:48`.
- Actor = actual human/current requester, not creator/previous requester; identity/grants/target recheck
  across awaits/output (`src/server/ssh-sessions.ts:97–118,144–185,194–241`; `src/server/ssh-sessions/backend.ts:26–68`).
- Delegation needs a visible project thread, explicit grant, no session-only scope and exact pinned
  host/cwd/membership. Owner/token and exact-host credential are captured; actor stays collaborator.
  Legacy implicit access cannot borrow it (`src/server/ssh-sessions/authentication.ts:96–180`).
- Viewer review reads may use passwords; writes/commands still need steering/workflow rights
  (`src/server/ssh-sessions/backend.ts:50–67`; `src/server/workflow-policy.ts:488–519`; `src/server/reviews.ts:346–428`).
- Login needs SFTP success and password consumption. Memory-only cache is person/token/exact-host,
  with 30-minute idle/eight-hour absolute TTL. Private one-use askpass FIFO binds one SSH PID;
  password is not argv/environment data (`src/server/ssh-sessions/authentication.ts:66–94,245–305`;
  `src/server/ssh-passwords.ts:12–14,60–98,143–180,198–208,225–249,286–328`).
- Password mode disables keys/multiplexing and requires strict host-key checks; agent/port
  forwarding is disabled. No password capability does **not** imply no key/config SSH access.
  Source: `src/server/ssh-env.ts:81–104`; `docs/projects.md:46,50`.
- `protectSshEnv` reuses shared workflow policy. Managed commands need target macOS `sandbox-exec`,
  failing on non-Darwin without raw fallback; unmanaged Chat invokes normal shell (`src/server/ssh-policy.ts:7–21`;
  `src/server/workflow-policy.ts:718–772`; `src/server/ssh-env.ts:1432–1464`).

## Revocation and two material operational risks

- Grant/role changes invalidate captured identities without token rotation; access/catalogue
  updates evict unauthorized conversations/peeks. Selected credentials cannot silently
  switch after forget/rotation/expiry. Sources: `src/server/app.ts:1025–1040,2498–2522`;
  `src/server/ssh-sessions/authentication.ts:39–50,122–154`.
- Logout/removal/expiry revoke cached password authority, not rollback or guaranteed remote
  job termination. Sources: `src/server/http/api.ts:239–243`; `src/server/app.ts:2556–2569`;
  `src/server/ssh-passwords.ts:198–208,234–249`; `SECURITY.md:22`; `src/server/ssh-env.ts:1455–1464`.
- **Risk 1 — project sharing is not account isolation.** A steering collaborator can create
  ordinary Chat in a granted project and run allowed commands with the remote account's
  rights beyond app folder boundaries. Documented behavior, not a newly proven bypass;
  use least-privileged OS accounts. Sources: `src/server/projects.ts:351–368`;
  `src/server/workflow-policy.ts:724–731`; `src/server/ssh-env.ts:1449–1464`; `SECURITY.md:13–14,21–22`.
- **Risk 2 — upgrade/future-sharing surprise.** Absent grants stay broad and broad grants
  include future projects; installing this commit or forgetting passwords does not revoke
  existing key access. Inventory members through owner controls before sensitive sharing.
  Sources: `src/server/app.ts:1691–1695`; `src/server/project-access.ts:67–82`;
  `src/server/ssh-env.ts:81–104`; `docs/projects.md:78–84`.

## Evidence strength and integration seam

- Inspected grant/effect/no-reconnect/pre-dispatch-revocation/same-token-fencing contracts
  (`test/ssh-project-permissions.test.ts:61–438`): source assertions, not runs here.
- The fixture replaces `ssh` on PATH with a local protocol peer (`test/ssh-fixture.ts:9–29,89–110`);
  it proves neither actual SSH authentication nor target sandbox enforcement (`docs/projects.md:64`).
- Main reports `node --test test/ssh-hosts.test.ts test/ssh-passwords.test.ts`: password fixture
  11 pass; hosts cannot load missing chord. This is main-reported, not independently rerun.
- Useful acceptance contracts: both project/thread namespace checks, viewer/steering split,
  no-transport denials, same-token revocation and credential replacement across awaits.
  Actual target checks need separate authorization; no broad suite or remote check here.
- Factory distinguishes UI human from core requester (`src/server/workspace-backend-factory.ts:15–58`);
  handoff fingerprints hash `backend.id`; successors copy location (`src/server/handoffs.ts:243,2005`).
  Reviews uses actual-user token checks, backend canonicalization and pinned reads
  (`src/server/reviews.ts:206–219,236–291,346–428`), superseding host-local-only assumptions.
- Design implication, not a schema mandate: comments can inherit namespace from their pinned
  conversation. Cross-thread aggregates/caches/receipts need target/version-qualified identity;
  proposed findings stay in the current Reviewer conversation, with no propagation.
- Future Pip should receive narrowly scoped, caller-bound **read operations** on Reviews/Workspace,
  not an entire `WorkspaceBackend`/`ExecutionEnv` with trusted command/write capabilities.

## Reconciled Work Items and Pip implications

These are design implications, not implemented behavior or authorization to change it.

- The first-class `app.workItems` recommendation is strengthened, not made mandatory by SSH.
  It should own membership, eligible transfers, active-writer lifecycle and a filtered work view.
  Keep transport, authentication and confinement in Workspace/SshSessions; use the existing
  factory rather than teaching Pip or the workflow extension raw SSH dispatch.
- Resolve the active thread's pinned destination, never today's project default. Successors
  inherit cwd and location even for new-work; project movement changes organization only
  (`src/server/handoffs.ts:1954–2005`; `src/server/projects.ts:465–480`). Work Items need not
  duplicate destination metadata or become part of the local-history PiSessions module.
- Shared `@Pip` still needs discussion-isolated context and narrow caller-bound reads, not private
  Pip context or a synthesized owner. Explicit human reads and agent execution have different
  admission requirements (`src/server/workflow-policy.ts:488–519`). SSH does not decide whether
  viewers may invoke a model, nor grant shared Pip shell, handoff or publication authority.
- Proposed Reviewer findings should still come from the existing Reviewer run and remain in its
  conversation. Their native sink must validate the inspected remote diff/version through the
  destination-aware review operations. Do not read a same-path host file or redirect a late
  finding to a successor (`src/server/reviews.ts:236–291,346–478`).
- Range anchors and Pip actor/provenance remain separate additions: stored comments still have
  single-line anchors and human authors (`src/server/docs.ts:242–256,316–331`). The pinned
  conversation already supplies namespace; an explicit host field is not automatically needed.
  Cross-thread indexing must preserve source conversation, target and version identities, not
  copy discussions or imply Work Item-wide finding propagation.
- Pull/publication retain host-owned external acquisition and staged remote artifacts, not
  unrestricted online SSH (`src/server/workflow-pull.ts:408–452`;
  `src/server/workflow-publication.ts:885–924,972–984`). Future Pip takeover remains a separate
  authority decision; uncertain effects still require reconciliation, not automatic replay.

Original baseline61a design notes remain unchanged. Use this note to supersede their host-local
review assumption; it does not establish independent implementation review or live SSH safety.
