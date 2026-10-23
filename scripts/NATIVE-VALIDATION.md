# Native validation in an isolated worktree

## Supported commands

Run from the checkout root, through the current authorized native execution profile:

```sh
# Only when node_modules is absent. The donor must be explicitly trusted and belong to this repository.
node scripts/prepare-worktree.ts --from /path/to/matching/checkout
node scripts/native-preflight.ts
node --test --test-concurrency=1 test/native-environment.test.ts
npm run check
npm run lint
```

Preparation is opt-in, not a worktree-creation hook or a new admission gate. It requires the same
Git common directory and byte-identical `package.json` and npm v3 `package-lock.json`. It checks
installed package versions/integrity metadata against the lock, all direct runtime/dev dependencies,
and required transitive dependencies at their locked locations: a missing nested version cannot
borrow a different ancestor version. Omitted optional platform packages are allowed.

It then makes an independent native copy, verifies a SHA-256 byte/mode snapshot and the copied
metadata, and rechecks both manifests before publishing. A synchronous commit exclusively creates
an empty `node_modules` reservation, then renames the verified staging copy over that reservation.
An installation appearing before this reservation is refused, not replaced. Cancellation is honored
up to this commit point; cancellation after commit does not roll back the published installation.
A forced process kill between reservation and rename can leave an empty `node_modules` requiring
inspection; it is not automatically repaired. Existing installations (including dangling symlinks),
escaping dependency links, special files, trees over
100,000 entries or 512 MiB, and changed inputs are refused. The fixed `/bin/cp` inherits the caller's
confinement and has a 30-second copy deadline (not an elapsed-time bound on snapshot/metadata reads).
Cancellation, deadline expiry or child error sends `SIGTERM` to that exact child, then `SIGKILL` if
it has not closed within 1 second. Another 1-second settlement window bounds the final wait. Only
its `close` event permits staging cleanup; no cancellation/timeout path publishes an installation.
If closure remains unconfirmed, preparation fails explicitly with the PID and retained staging path,
unrefs the child without claiming a join, and leaves staging untouched even if the child later exits.
That is an uncertain/blocking outcome requiring inspection, not a safe transfer or retry. Signal
refusal under a more restrictive profile is not permission to bypass confinement. CLI progress also
identifies staging for an interrupted attempt. No network, package install scripts, mutable donor
symlink/hardlink, source writes, or fallback installation is used.

This trusts the explicitly chosen installation. Installed integrity labels are not a fresh audit
of npm archive contents. Equal snapshot hashes establish donor-to-copy equality, not package
provenance. Run the relevant checks after preparation. An incomplete cache/donor is a provisioning
blocker, not permission to download packages or silently borrow another dependency tree.

Preflight emits JSON lines and exits nonzero for any failed requested probe. Its default scope is:

- Installed dependency metadata, without executing package code.
- A fresh private `0700` directory under native `os.tmpdir()` / target-authorized `$TMPDIR`, and a
  private log round-trip.
- Its own bounded Node child writing to that directory, receiving `SIGTERM`, and reaching `close`
  before the directory is removed. This does not certify termination of arbitrary detached daemons.

Use `--listen` **only when listener availability is unknown or the execution profile has changed**:

```sh
node scripts/native-preflight.ts --listen
```

That adds one bind-and-close probe on ephemeral `127.0.0.1`. It does not exercise client connections,
HTTP assertions, Chromium, the Browser panel, or a device. A default preflight pass makes no claim
about those capabilities. Do not repeat a known denial unchanged. Tests must keep their assertions;
listener failures are not test passes or reasons to add skips.

For longer checks, use a private log directory allocated under the target's authorized `$TMPDIR`,
not a fixed shared `/tmp` path. Keep the exact command and exit/signal separate from the log text.
A log saying some assertions failed remains failure evidence even if the process is later stopped.
After interruption or authority revocation, inspect the actual outcome and obtain fresh authority
where required; never replay stale commands. Do not remove or reuse an interrupted staging directory
automatically. A forced `SIGKILL` cannot run application cleanup.

## Remaining capability decision

`src/server/workflow-shell.ts` deliberately denies `network*`, Mach lookup and Apple events.
`workflow-policy.ts` applies that sandbox on local managed commands; `ssh-env.ts` applies the same
profile on the SSH target. Private execution additionally supplies per-identity/target scratch and
write roots in `pip/agent-execution.ts`. Use that invocation's `$TMPDIR`; a literal `/tmp` path may
be outside its roots even when it works in an ordinary Worker. None of these gates changed here.

Listener-backed tests and `test/serve.ts` remain unsupported in the current offline managed profile.
The managed browser is independently a credential-free public-document reader: it cannot run the
JavaScript of a disposable local app. Do not substitute the live app/data or memory-only tests for
rendered acceptance.

A future first-class native validation runner needs an explicit capability decision and separate
runtime activation. Its acceptance criteria should include:

- Existing caller/source/identity/owner-token, role, plan, writer, question, model, budget and
  approval checks at admission and continuation; no generic online-shell escape hatch.
- Fresh disposable app/config/profile data and private logs, with a fixed supervisor that cancels
  **and joins** its exact process/helper tree before releasing writer reservations.
- A narrowly isolated listener/client channel that cannot connect to the live app or arbitrary
  localhost services. Blanket `allow network*` or wildcard loopback access is not this capability.
  The appropriate supported native isolation/endpoint mechanism still needs primary-source design
  validation; this note does not assert an untested Seatbelt exception is sufficient.
- Separate scoped local-app browser support, with no imported accounts or owner live-data access.
- A real-profile bind/client/render/cancellation/revocation regression, not only mocked policy flags.

No runner/network exception/browser privilege was added, and no restart is requested as part of
this patch. Controller/owner direction is needed to pursue and activate that remaining capability.

## Evidence ledger — this Work Item, 2026-10-23

Intake: branch `pocket/execution-environment-reliable-tests-and-9608e7`, HEAD
`8c0a075384a7871878a423a7cba7c5d0457bca66`, current managed Worker, Node `v24.20.0`, macOS.
Native commands ran through the real `bash` tool, not an unrestricted substitute. No authority
revocation message was returned in these attempts. That is not evidence about historical private
agent epochs or permission profiles.

| Classification                              | Actual observation and disposition                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reproduced deliberate restriction           | One minimal native `node --input-type=module` probe tried `server.listen(0, '127.0.0.1')`: `EPERM`, combined probe exit 1, no server started. Source confirms offline sandbox policy. No unchanged listener retry.                                                                                                                                                                                            |
| Historical temp symptom not reproduced here | The same intake probe wrote/read/removed a native temp log and a unique `/tmp/coop-env-intake-42576.log` successfully. Native temp root was `/var/folders/5s/cj8c9_rd501491vf3zjk04l40000gn/T`. This does not establish permission in private-agent scratch confinement.                                                                                                                                      |
| Confirmed preparation gap, fixed locally    | No checkout `node_modules`; all five reported packages returned `ERR_MODULE_NOT_FOUND`. Worktree creation intentionally excludes ignored dependencies and provides no bootstrap. Manifest and lock agreed; all 40 direct dependencies had lock records.                                                                                                                                                       |
| New bootstrap defect found and repaired     | First real preparation using Node recursive copy timed out at 120 seconds. No `node_modules` published. Replaced that step with native `/bin/cp`, retaining the sandbox, byte/mode verification and cancel/join handling. A fresh attempt after that code change succeeded: 301 installed records; snapshot `f2107dbd31a74638b8c9ae3fd1b1032fe68076fbd6b54911f63e4eb20323fa05`.                               |
| Retained interrupted staging                | First attempt left `.coop-dependencies-fOrhBx/node_modules` (observed 17,423 entries, 195,526,693 file bytes). No automatic replay, reuse, or destructive removal. `ps` inspection returned `Operation not permitted` and was not bypassed. The installed Node execution implementation requests group `SIGKILL` on timeout and waits for child settlement, but no independent process-list proof is claimed. |
| Separate actual native fixture failure      | A race-test fixture's `fs.watch` returned `EMFILE`. The watcher check was abandoned, not retried or called a pass; neither descriptor exhaustion nor Mach-denial causality was established. Final tests use the CLI's own bounded progress output, without watchers or extra privilege.                                                                                                                       |
| Regression caught during implementation     | Manifest drift during real staging initially published stale dependencies (exit 0 instead of 1). The final input recheck fixes it. Both drift and in-flight cancellation now refuse publication and clean their own stage after child settlement.                                                                                                                                                             |
| Fixture error corrected                     | Initial escaping-link test accidentally supplied a dangling path, producing `ENOENT` rather than its intended escape refusal. Corrected the fixture to point to an existing out-of-tree manifest; the specific escape assertion now passes. No assertion was removed.                                                                                                                                         |
| Verified post-fix native behavior           | `node scripts/native-preflight.ts`: exit 0; 301 dependency records, temp log success, child closed with `code: null`, `signal: SIGTERM`, `joined: true`. Pre-preparation invocation exited 1 for missing dependencies while the other two probes succeeded.                                                                                                                                                   |
| Verified real dependency consumers          | All five historical packages resolve inside this worktree. Real imports of Pi Durable, Preact and CodeMirror CSS succeed. `npm run check` and `npm run lint` pass with this independent installation.                                                                                                                                                                                                         |
| Historical failures still unclassified      | Herdr transport, agent-panel modal, HTTP/artifact/browser/profile assertions and the historical signal-9/exit-137 run were not rerun or repaired here. Resource pressure, test concurrency and authority revocation are distinct hypotheses, not one proven cause.                                                                                                                                            |
| Deferred checks                             | No full `npm test`, listener-backed test suite, `test/serve.ts` startup, Chromium/local-app render, mobile/browser/device acceptance, or real private-agent revocation exercise. The CLI's optional listener branch was not retried against the known unchanged denial.                                                                                                                                       |

Worker's final focused command: `node --test --test-concurrency=1 test/native-environment.test.ts` —
15 passed, 0 failed, 0 cancelled, 0 skipped. This covers independent resolution/executable copying,
invalid donor rejection, no overwrite, default preflight failure propagation/temp/child cleanup,
real in-flight cancellation and manifest drift, and cancellation before staging. It is not the
application test suite. Formatting is limited to this patch's files; no broad formatter was run.

No source-checkout changes, inherited-tab-patch edits, Git staging/commits, Land, publication, deployment,
restart, model fallback, permission widening, or unrelated-writer intervention occurred.

## Independent review — 2026-10-23

The Reviewer inspected the five-file implementation separately from inherited work, with read-only
Standards and Spec helper reviews. Required documentation and the real local/SSH confinement and
private-agent scratch code were inspected. `network*` remains denied; private write-root profiles
also deny signals. The ordinary managed Worker's successful temp/child probe does not certify a
private-agent invocation's scratch permissions or cancellation/revocation lifecycle.

Review repairs:

- Dependency resolution now requires the location selected by the main lockfile, rather than
  accepting any installed ancestor with the same name. A missing locked nested version was
  reproduced: the new invalid-donor case initially failed with `Missing expected rejection`.
- Copied metadata is revalidated against the pinned inputs, closing the inspection-to-snapshot
  metadata drift gap instead of relying only on the donor's initial inspection.
- The final asynchronous absence-check/rename sequence was replaced by an exclusive directory
  reservation and synchronous commit. There is no awaited destination lookup after the last
  cancellation check. This repair is supported by code inspection and the real filesystem fixture
  suite; no adversarial final-syscall scheduling proof is claimed. The reservation/crash and
  post-commit cancellation semantics are documented above.
- Preflight checks cancellation after each awaited probe, and both CLIs record a nonzero status
  immediately on handled cancellation, including cleanup. A real SIGTERM scheduled after the last
  preflight JSON probe reproduced exit `0` before the repair and exits `130` afterward, with private
  logs removed. It uses Node's standard preload interface; no production test hook was added.

Reviewer validation actually run:

- Final `node --test --test-concurrency=1 test/native-environment.test.ts`: **17 passed**, no
  failures, cancellations or skips.
- Combined native-environment, worktrees, remote-project-resources and ssh-project-resources test
  files: **28 passed**, no failures, cancellations or skips. These exercise ignored-dependency
  isolation, real worktree operations, target resource boundaries and trust/token revocation; the
  remote fixtures do not establish real SSH confinement.
- Three selected workflow-permissions tests for local stash/rebase, literal command delivery and
  pre-spawn publication refusal: **3 passed**, no failures, cancellations or skips. Other tests in
  that file were not selected; listener-backed cases were not attempted.
- Final `npm run check`, `npm run lint`, syntax checks of both scripts, targeted formatting and
  `git diff --check`: passed. Initial lint runs caught Reviewer-introduced declaration-spacing errors;
  targeted fixes were applied before the final passing checks. No baseline failure was observed in
  the selected regressions.
- Final default preflight: exit `0`, **301** installed records, private temp round-trip and own child
  closed with `SIGTERM`/`joined: true`. No listener was requested.
- All **16 inherited SHA-256 values** matched again. HEAD remains
  `8c0a075384a7871878a423a7cba7c5d0457bca66`; there are no staged changes. The retained interrupted
  staging directory was not removed, reused or treated as an installation.

At this review checkpoint, the remaining actionable finding was: copier lifetime has no independent deadline/escalation supervisor;
its promise waits for `close`, and the test's SIGTERM timer likewise does not bound a stalled child.
This is an inspection finding, not a reproduced stalled native copier. It was published as a native
Diff comment. Tree-size limits do not establish elapsed-time bounds. Do not delete staging ahead of
child settlement or claim the future supervisor capability exists.

The in-flight preparation fixture proves cancellation prevents publication and cleans its own
stage, but its copy-start progress event occurs before spawn; it does not independently prove the
copier was still active when the parent signal arrived. Close-before-cleanup ordering was confirmed
by inspection, while the default preflight independently exercised its own Node child's join.

No new full-size donor copy was attempted after review changes: the existing independent installation
was preserved, the revised copy/publication path ran against real filesystem fixtures, and its
metadata/preflight plus application checks used the actual installed tree. Full `npm test`, listener,
`test/serve.ts`, rendered browser/device acceptance and real private-agent lifecycle checks remain
unverified for the capability reasons above. No runtime policy change, commit, publication, restart
or handoff was performed. Review findings are evidence for the human's next decision, not a workflow
gate.

## Bounded Follow-up — 2026-10-23

Source: the initial independent Reviewer's unresolved inspection finding in `/s/167600`, comment
`c-7c686e7947fbcf2a9569f71dd9c8694002d2b7b16e52aabdb7bf98c427ff97ff`, at the former
`scripts/prepare-worktree.ts:219-229`. This continuation repairs that copier-lifetime gap only.
It is post-review repair, not Pull intake, a fresh independent review or a resolution of the review
comment. The review checkpoint and its limitations above remain historical evidence.

Repair:

- The fixed `/bin/cp` now has an owned 30-second deadline and exact-child cancellation/error
  handling: `SIGTERM`, then `SIGKILL` after 1 second without close, then a final 1-second settlement
  window. Repeated cancellation cannot reset those windows. Timers/listeners are released on close;
  signals are not sent after Node observes exit. There is no detached/group signalling, process
  inspection, arbitrary-executable production option, new dependency or runtime policy change.
- Failure/cancellation/timeout never reaches publication. Confirmed close precedes staging removal.
  Unconfirmed close instead returns an explicit uncertain/blocking error with PID and retained
  staging path. The child is unrefed, not called joined; a later close does not retroactively delete
  that retained stage. Inspection is required before any safe transfer or retry can be claimed.
- The real CLI race fixture now has a bounded watchdog with TERM/KILL escalation and a final
  unconfirmed-close failure instead of an indefinite teardown await. A watchdog expiry retains the
  fixture because a forced CLI exit cannot certify its copier's settlement.

Regression evidence through this actual managed native profile:

- New tests use Node's standard preload and built-in export synchronization to substitute a real
  owned Node child at the fixed spawn boundary. That fixture continuously writes staging and
  acknowledges but ignores `SIGTERM`; the test observes the actual OS `SIGKILL` close event and
  checks that staging still exists at close, followed by cleanup and no published installation.
  No fake clock, mocked close event or production test hook is used. Normal copy/resolution tests
  still exercise the real `/bin/cp`.
- Before the production repair, the new deadline regression **failed**: the child ran until its
  35-second fixture safety exit (`code: 88`, no signal), rather than being stopped by an owned
  deadline. This is a deterministic real-process regression, not a reproduced stall of `/bin/cp`.
- After repair, the same deadline case closes with `SIGKILL` in about **31.2 seconds**; cancellation
  after the child reports ready closes with `SIGKILL` in about **1.2 seconds**. Staging exists at
  close and is absent when the CLI finishes; `node_modules` is absent in both cases.
- A third case simulates signal refusal by returning false from that exact child's `kill` method
  while the real child continues running. Both TERM and KILL are attempted, the CLI reports
  termination unconfirmed and retains staging at about **2.2 seconds**, and only then does separate
  test-owned teardown use the original child handle to kill/join it. The stage remains retained
  after that late close. This validates the fallback path, **not** real private-profile signal
  denial, authority revocation or successful termination where the OS refuses signals.

Final checks actually run:

- `node --test --test-concurrency=1 test/native-environment.test.ts`: **20 passed**, no failures,
  cancellations or skips.
- Combined native-environment, worktrees, remote-project-resources and ssh-project-resources files:
  **31 passed**, no failures, cancellations or skips. The final combined run includes the watchdog
  retention adjustment and all three real-process regression cases.
- `npm run check`, `npm run lint`, syntax checks of both scripts and the test, targeted ESLint/
  Prettier formatting and `git diff --check`: passed. No broad formatter was run.
- Default preflight: exit **0**, **301** installed records, private temp round-trip and own child
  closed with `SIGTERM` / `joined: true`; no listener was requested.
- One self-review of this follow-up delta and its immediate snapshot/publication/CLI integration
  points was performed. This is not independent review. Earlier Reviewer evidence is reused only
  for untouched work; the copier supervisor and test watchdog have changed materially since that
  checkpoint.
- All **16 inherited SHA-256 values** still match; HEAD is unchanged at
  `8c0a075384a7871878a423a7cba7c5d0457bca66`, with no staged changes. The original interrupted
  `.coop-dependencies-fOrhBx` was not removed, reused or retried. No new full-size donor copy was
  needed; the installed independent dependency tree was preserved.

Remaining limits are unchanged: no full `npm test`, listener-backed suite, disposable app,
rendered browser/device acceptance, real SSH confinement or real private-agent revocation/signal
refusal validation. No known listener/process-inspection denial was retried or bypassed. The copy
phase deadline does not bound stalled filesystem snapshot/metadata operations or forced process
termination/host failure. A real unkillable copier remains an explicit blocking uncertainty, not a
success. Historical Herdr/modal/HTTP/artifact/browser/profile/full-suite failures remain unclassified.
No commit, staging, local Land, publication, deployment, restart, permission widening or review
resolution was performed.

## Inherited-byte register

Recorded before edits. The final inventory check matched all 16 SHA-256 values. These files are
inherited work, not this implementation's delta; none was staged or reconstructed.

| Path                                                       | Intake SHA-256                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------------ |
| `docs/architecture.md`                                     | `b9bba9e2d58e4122a7a43a12f694fe2653c1052514638eb0216cdd31e8151162` |
| `docs/features.md`                                         | `777fa03811b5285259fe31b0f2bab8f14253243d60a91deec63d16d950daeaef` |
| `docs/map.md`                                              | `dd44ba48a58d78f0353e5dd90c177042e29eb64857f621909abfaea3252ddf0f` |
| `docs/research/handoff-failures-and-file-briefs.md`        | `4640a7775b78e1194b34b259899f0736c8920c4c1214611ff4f3f687da387e91` |
| `docs/research/pip-orchestrator-capabilities.md`           | `63f1fb7111bfc6d34be130bae90ea882f148376f6c3313f9a94d8e8dd04b6630` |
| `test/agent-tab-lifecycle.test.ts`                         | `e656ee1beff393eb8b82203723916e6ab7e1b045db63de3a9dbfc6aa363f04ee` |
| `test/pip-orchestration-feedback.test.ts`                  | `cb9e85e75471a8fc1804562d02cfb8b50a57c448ffbb56a34e5e32340d4e01a9` |
| `test/pip-orchestration-workflow.test.ts`                  | `f0a6b11a5e77683ba40cee5b1a423876540e30fff17c94c03476bd2078da589b` |
| `web/agent-tabs.js`                                        | `155bf14b85b1ed2e1058f77ba0a5b30fba9059b71525271157d1f5906363cb54` |
| `web/named-agents.js`                                      | `1bf96ce0893fba96a5f38c547067679f562208abed1720191326d7ab968400a7` |
| `docs/research/orchestration-experience-next-work-item.md` | `ef591bc6be4d1b9012a10f9ca6b0378682830b7d6f0bf7f5b18605c261f0625a` |
| `docs/research/pi-personas-current-supervision.md`         | `b26d9a97d68b14345414c5c4d84314246df2f3a0a8ae0d90c67a755a88aabf62` |
| `docs/research/pi-personas-durable-upgrade.md`             | `54bcca9dca2ec6925335c8e2e66a08d24d6da44c8fc3c20db087feb63c91c834` |
| `docs/research/pi-personas-observability.md`               | `b67145e13eedf0d3132e6ced52830d4d530cb1268ecfc252b26a79660efdaf39` |
| `docs/research/pi-personas-proposal.md`                    | `cac51236324243eecd24513ddb8dcc7b880977e45607d0a535db6324a05c1261` |
| `web/agent-tab-state.js`                                   | `649c877f390aa39137fd286462506271a30f41e2a5075deaa347d726f7f358a0` |
