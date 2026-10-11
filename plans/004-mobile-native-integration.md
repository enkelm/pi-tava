# Plan 004: Integrate, verify and safely transfer approved mobile guardrails

## Status

- State: DONE — exact eight approved files transferred by executor on2026-10-11; immediate UI syntax and all read-only post-transfer gates pass. Parent independently verified final hashes and preserved non-plan working state. No commit/restart/deployment.
- Priority: P1
- Effort: M
- Risk: MED
- Depends on: completed plan001 CSS and plan002 test deltas, and preserved baseline full-verification report; plan003 investigation supplies hardware limits
- Category: bug/tests
- Planned at: `9d9fcad`, 2026-10-10, plus exact captured dirty working state

## Current reviewed authorizations and evidence

Earlier phase freezes below are historical. The reviewer subsequently approved CSS-only round2/round3 source changes from plan0017b/7c: move covering-file mobile safe bounds after the later global inset reset, then allow the mobile file toolbar to wrap when controls cannot fit. Final candidate style SHA256 is `5c6a51ae894437e2987ce55ea6db34ee029e88592e366d35dc0323e349bf9da6`. The sole further test change adds the actual Mention action to the existing bounds/ownership measurement; hash `72ed9f26fe9ea625df943e6ad098cb3b289676d3b92699b4d132d13eadfe2ca3`. Its intended RED320 is299.97px versus safe276px. Other six files remain reviewed bytes. The integrator is authorized to import only that stylesheet and run fresh serial final gates, then stop. Parent final browser review is required after import.

Round2 gates were geometry5/5 and focused51/51; terminal/Reviews22 pass and1 inherited prefix failure; full504 total/494 pass/9 fail/1 skip. The previously novel schedule raw-snapshot requester-row reversal was reproduced on exact preserved baseline at attempt23 (22 pass,1 exact fail), all293 original entries unchanged before/after. It is now an observed baseline failure signature, not a demonstrated numeric-key root cause and not repaired. Prior browser-navigation `The browser closed` remains nonreproduced/unclassified, absent in round2 full and all baseline/integrated owner reruns; its raw inline HTTP/about:blank fixtures do not load changed UI assets. Do not call it inherited or fixed. Original live-preference/CDP stalls likewise are not repaired by the initial-preference font fixture.

## Final reviewer decision — transfer authorized

The reviewer read the complete2176-line round3 task-only patch, final report/hashes and actual baseline QoL failure. All51 focused UI tests and5 geometry counts pass; terminal/Reviews22 pass/1 proven baseline prefix failure; final full504 total/494 pass/9 fail/1 skip/0 cancelled. Every final failing signature has actual baseline evidence, including unchanged-baseline QoL cancellation stderr. The separate earlier schedule-order failure is also baseline-reproduced. No expectation was weakened, skipped or replaced by a source inventory.

Parent independently checked all eight live destination hashes against the original working-state manifest and all eight candidate hashes against the reviewed final manifest; every captured non-plan file/symlink remains unchanged, including user Reviews work. In-memory application of every exported diff hunk reconstructs the exact eight final bytes/hashes. A literal Python-regenerated diff differed only in diff-alignment representation; this was resolved by full hunk/context and resulting-byte verification, not ignored as drift.

Affected actual file toolbar/editor, normal zero-inset phone, landscape-size side mode, desktop docked geometry, Tab focus, browser Back and console were rechecked successfully against the final candidate. The exact owned8910/PID48985 audit was gracefully stopped and temporary fixture data removed; live server untouched. See `004-mobile-file-browser-evidence.md` and earlier unchanged-source browser evidence.

Disposition: the earlier browser-close event remains an unresolved historical runtime observation, **not** inherited/fixed. It is absent in both later full runs and baseline/integrated owner reruns, and its raw engine fixture does not load changed UI assets. It does not block acceptance of this bounded frontend task with all current new regressions passing and all final full failures baseline-reproduced; no claim about its cause or general browser reliability is made. Keep it, the original live-preference/CDP stall and physical-device matrix as explicit follow-ups. No speculative backend/keyboard/native repair is authorized.

**APPROVED:** executor may perform step9 now, transferring exactly the eight complete files whose final hashes are in `integrated-round3-final-hashes.json`. Immediately before any write, revalidate ALL eight live destinations and candidate hashes; STOP on any drift. Preserve permissions and all other work; no merge/commit/restart/deploy. Check `web/ui.js` syntax immediately after its atomic transfer, before continuing. Follow with read-only syntax/format/diff/type/lint/scope/preservation checks and report. The advisor does not change source itself.

## Completion record

Executor completed the authorized transfer on attempt3. Attempts1/2 stopped before any live write (unsupported Python xattr metadata API; then an overbroad inventory guard for353 individually verified ignored Rust build outputs). Only the external helper was corrected; all candidate bytes stayed fixed and failed-attempt evidence remains. Native original-metadata staging and same-filesystem atomic replacement preserved modes/UID/GID/flags/ACLs/xattrs, other working files and all build outputs. Immediate UI syntax and read-only scoped Prettier/diff/type/lint checks pass. Parent independently repeated syntax and final-eight/all-other-captured-non-plan hash/symlink verification. No source changes remain pending; no restart/commit/deployment.

Final report: `/private/tmp/pi-coop-mobile-native-u2t3fcxl/live-round3-attempt3-report.md`. Final patch/hash/full-suite evidence: `integrated-round3-{task-only.patch,final-hashes.json,report.md}` in that task root. All51 focused UI tests pass; final full494 pass/9 baseline-reproduced fail/1 skip/0 cancelled. Residual browser-close, live-preference/CDP and physical-device limits remain explicitly recorded, not repaired or erased.

## Work locations and ownership

- Live source: /Users/enkelm/Projects/pi-coop (do NOT write until the reviewer explicitly authorizes transfer)
- Task root: /private/tmp/pi-coop-mobile-native-u2t3fcxl
- Baseline files: <task root>/baseline-files
- Original file fingerprints: <task root>/baseline-manifest.json
- CSS executor result: <task root>/css
- Test executor result: <task root>/tests
- Integration worktree: <task root>/integrated (detached, dependencies linked; no installs/commits)
- Baseline verification logs: <task root>/baseline-*.log

The operator's pre-existing Reviews work is intentionally present in every baseline. Never use git checkout/reset to erase it or treat HEAD..working-tree diff as this task's contribution. Compare complete files to baseline-files instead. Do not stage/commit/push/merge/restart/publish/deploy.

## Scope

Only task changes from these eight files can be integrated/transferred:

- web/style.css
- web/reviews.css
- web/terminal-grid.css
- web/ui.js (only safe horizontal popAnchor() bounds; reviewer-authorized CSS follow-up)
- test/mobile-ui.test.ts
- test/private-input-ui.test.ts
- docs/features.md (small accurate mobile behavior addition)
- docs/architecture.md (small CSS ownership/safeguard addition)

The reviewer owns plans/README.md and investigation evidence files. No other app/server/native/package/data/test files may be changed. Check web/ui.js syntax immediately after an edit or transfer.

## Context and conventions

Preact/htm, plain modules and CSS without a build. Platform guardrails in CSS and the existing horizontal menu-bounds helper only; no speculative JavaScript keyboard viewport fix. Four-space Prettier, 100 columns, braces and declaration/block spacing per AGENTS.md. Existing appearance, theme-color updates, dynamic viewport metadata/units, native gestures and terminal release/cancellation/focus/input semantics must remain.

Read AGENTS.md, PRODUCT.md, docs/self-editing.md, docs/map.md, docs/architecture.md, docs/features.md, plans001–003, /Users/enkelm/.pi/agent/skills/test-audit/SKILL.md and /Users/enkelm/.pi/agent/skills/impeccable/reference/craft-floor.md. If changing prose, use /Users/enkelm/.pi/agent/skills/unslop/SKILL.md to keep it factual and brief.

## Steps

1. Wait until the reviewer supplies completed executor reports and approves integration. Stage 1 is authorized while plan002 is pending: integrate only the four completed source files, add the two small documentation updates, format/check/lint, then stop and report. Do not import unfinished tests, run full verification or transfer live files. Resume steps 2–8 only after the reviewer supplies and approves the test report. Stage 2 is now authorized for validation of the authored plan002 deliverable: import only its two test files, first run the font regression in isolation with a bounded timeout and establish reliable integrated GREEN. The test executor stopped after repeated baseline Chromium/CDP hangs, although one run produced all 25 intended font measurements and the correct RED failure. Do not count cancellation as RED, accept unresolved hangs, weaken expectations, bypass production preference actions, or add test-only seams. Bounded test-harness revisions inside the two owned test files may be proposed/applied with evidence; any further source repair requires reviewer authorization. After stable font evidence, complete steps 3–8, still with no live transfer. Follow-up after four post-fix CDP stalls: authorize one bounded font-fixture revision that applies each real text preference at Home, reloads to make it the initial rendered preference, and starts fresh per input surface. Keep all 25 visible font measurements, root/preference assertions, New-folder autofocus and restoration. This isolates the CSS floor contract from live preference-change/render lifecycle behavior; it does not prove or repair the latter. For fresh RED proof only, the integrator may temporarily replace integrated/web/style.css with its captured baseline while no suite is running, run the revised regression, and restore the exact approved source bytes/hash in a finally block. No source repair is authorized. Then repeat post-fix GREEN, run the other focused regressions and remaining gates serially, and report any unresolved blocker. Validate the integrated worktree is unchanged from baseline on the eight owned files and all task-source files exist. Check executor changes are limited to their owned CSS or test paths, relative to baseline, not HEAD.
2. Copy the three completed CSS files and the narrowly revised web/ui.js from css, and the two test files from tests into integrated, preserving all baseline content. Do not copy entire worktrees or apply cumulative HEAD diffs.
3. Run the focused tests below. If any new test fails, diagnose owning behavior rather than weakening expectations. The reviewer may authorize bounded revisions inside the integration worktree. Report obstacles requiring out-of-scope files or speculative keyboard changes.
4. Add brief documentation to docs/features.md and docs/architecture.md explaining actual touch input/hover/press/scroll/safe-area CSS and test coverage. State Safari keyboard/touch/installed-PWA still needs hardware verification. Preserve existing Reviews documentation verbatim except normal formatting; no redesign or unrelated cleanup. docs/map.md does not require changing file locations because no source module is added.
5. Run npm run format in this DISPOSABLE integration worktree, recording any baseline-only formatting drift. Keep the exported task delta limited to the eight paths; if formatter writes outside them, restore those files from baseline-files (not HEAD), report what happened, then use scoped formatting/checking for final verification. Do not edit while the full tests are running.
6. Run checks serially with logs in task root:
    - node_modules/.bin/prettier --check <eight files>
    - git diff --check
    - npm run check
    - npm run lint
    - node --test test/mobile-ui.test.ts test/private-input-ui.test.ts test/theme-ui.test.ts
    - node --test test/private-terminal-ui.test.ts test/terminal-grid.test.ts test/reviews-ui.test.ts
    - npm test (bounded generous timeout)
7. Classify every failure by comparing with baseline logs and, when necessary, rerunning that owner file on the preserved baseline without new fixes. Do not call a novel failure inherited, weaken tests, or silently skip. All new mobile regressions must pass. A focused command may still include a proven baseline failure (notably the Private native prefix chord); disclose that explicitly instead of expanding scope to unrelated backend/shortcut repairs or claiming the command passed. Report actual pass/fail/skip/cancel counts and failure names.
8. Produce a task-only patch/diff from baseline-files for the eight paths and a manifest of integrated final hashes. Report changes, red/green evidence, command results and hardware limits. Stop: no live transfer until reviewer approval and browser inspection.
9. ONLY on explicit reviewer authorization, check every live destination file against baseline-manifest.json again. STOP if any differs, including absent/new/renamed files. Verify all approved final-file hashes match the reviewed version. Atomically transfer the eight complete approved files to live source, preserving permissions and leaving every other existing user modification untouched. This is an authorized file transfer, NOT a git merge/commit. Each web file save must leave the app loadable; these CSS changes and the small frontend safe-bounds helper require no server restart. Immediately run node --check web/ui.js after its transfer. Do not run live-data manual tests. Run read-only formatting/type/lint/diff checks after transfer and report exact changed paths.

## Verification and browser gates

The reviewer uses the browser tool on a test/serve.ts disposable app from integrated, with its own temp data, before authorization. Batched phone/desktop and synthetic safe-inset geometry checks should show inputs >=16px, intact normal appearance, focus/press feedback, no horizontal overflow and safe edge controls. Representative tests cover current private attachment removal using fake Herdr, not real panes.

Prior mobile-ui + theme-ui baseline passed32/32. The project warns of inherited full-suite failures in README.md/docs/terminal-mode.md. Baseline logs from this exact dirty tree are authoritative for comparison. Physical iOS Safari/Android touch feedback, pull-to-refresh, notches, OS keyboard and installed-PWA behavior are not established by Chromium emulation.

## STOP conditions

Stop/report on live-file drift, any attempted erasure of the user's Reviews changes, unreviewed outside-scope delta, novel unexplained test failure, broken desktop tiling/keyboard focus, or a repair requiring server/native/gesture-delivery changes. Do not transfer code unless explicitly approved after review. No secrets in patches/reports; no commit/push/restart/deploy.
