# Plan 002: Add behavioral regressions for mobile-native guardrails

## Status

- State: DONE — both reviewed test files transferred; all18 added counts pass. Font contract has three initial-preference GREEN runs and intended baseline RED; file-view and Mention bounds have independent RED/GREEN. Original live-preference/CDP stalls are not repaired.
- Priority: P1
- Effort: M
- Risk: LOW
- Depends on: none for development; plan 001 for integrated passing verification
- Category: tests
- Planned at: commit `9d9fcad`, 2026-10-10, including current uncommitted Reviews work
- Execution: isolated detached worktree; no commits or live-data tests

## Context

This app uses Preact/htm without a build, Node's test runner, real Chromium via src/server/browser/page.ts, and temporary app data + scripted models via test/helpers.ts. The owner mostly prompts agents from a phone. Existing mobile-ui and theme-ui tests passed 32/32 on the preserved baseline. iOS Safari physical behavior is not covered and must not be claimed as tested.

Read AGENTS.md, PRODUCT.md, docs/self-editing.md, docs/map.md, docs/architecture.md, .agents/skills/mobile-native/SKILL.md, and /Users/enkelm/.pi/agent/skills/test-audit/SKILL.md. Match four-space Prettier and existing test fixtures. Do not introduce production exports/hooks or source-string inventories just to test CSS.

Scope: only test/mobile-ui.test.ts and test/private-input-ui.test.ts. Extend strongest existing behavioral coverage rather than duplicating fixtures. Do not modify source, server/native code, package files, unrelated tests, or baseline test expectations to hide failures.

## Independent contracts to protect

1. Actual rendered New-folder, Go-to-file, Changes-filter and launcher inputs have font size >=16px for coarse pointers at text preferences 12,13,14,15,16. Composers already work and are a useful comparison. The baseline has .new-folder input at .85rem (11.9px at root14), .ft-filter/.dr-filter at .8rem (11.2px), launcher at1.02rem (14.28px). New folder autofocuses. Exercise controls through existing app boundary; do not just grep declarations. Restore preferences after the scenario.
2. Representative controls retain desktop hover, but touch capability does not apply hover-only visual effects. Keyboard focus feedback remains independent of hover support. Use actual rendered style and trusted input where supported; do not claim physical sticky hover was reproduced. Inspect BrowserPage's real CDP/pointer interface before constructing held presses. Programmatic PointerEvent alone does not prove CSS :active.
3. The title/model chip press feedback changes visibly during a trusted held press (before release) and returns to normal afterward; disabled controls remain disabled. Use existing action/focus helpers, no test-only exports.
4. Rendered control touch defaults do not suppress selectable message/content text or pinch-zoom capability. Extend existing platform-contract tests rather than building a source inventory.
5. Root/ordinary sheet/session/launcher have an appropriate vertical overscroll policy in computed styles; ordinary scrolling, mobile Back/dismissal and existing swipe tests still work. This proves the CSS contract, not hardware pull-to-refresh.
6. Nonzero horizontal safe areas keep edge-aligned controls inside the safe rectangle, across mobile portrait/landscape/320px layouts; zero insets preserve desktop tiling and ordinary width. Production CSS executor will introduce --safe-left and --safe-right tokens backed by env(). Inject token values only through normal DOM style in tests, then measure actual layout/control points and overflow. Confirm not double-padding nested screens where feasible. Do not invent test-only production flags.
7. Private attachment removal has an actually reachable >=40px target inside clipped attachment chips, including long adjacent filenames. Use the existing private-input-ui fixture's uploaded files and real removal callbacks. Baseline .icon-button.small is24px, enlarged by ::before but .chip overflow:hidden clips it. Extend elementFromPoint-style probing (test/mobile-ui.test.ts around957–985) to private removal; check actual hit ownership above/below visual icon and that adjacent attachment labels/removal controls keep their own targets. Removal must affect only the intended attachment. Keep filename truncation/no overflow.

## Steps and verification

1. Read complete owning tests/fixtures and relevant production owners. For each new test state in your report: observable contract, credible regression, why existing coverage misses it, and no production-only seam.
2. Add a compact coherent set of regressions to the two owned files. Prefer table-driven text preference cases and extending existing private upload behavior instead of another full fixture.
3. Run the new regressions against the untouched source in this worktree, using node --test --test-name-pattern='<specific pattern>' test/<owner>.test.ts when feasible. Record RED failures and why they demonstrate the intended bug. Mark baseline-passing characterization tests honestly (do not force them to fail).
4. Format/check only the two owned files: node_modules/.bin/prettier --write <files>, node_modules/.bin/prettier --check <files>, node_modules/.bin/eslint <files>, git diff --check. Resolve authoring/type/lint errors without modifying source.
5. Export a task-only diff against external snapshot baseline copies of the two files, not HEAD. Report exact new test names and commands/logs. No commits.

## Integration done criteria

The integration executor combines plan001 CSS and these tests in a separate worktree and runs:

- node --test test/mobile-ui.test.ts test/private-input-ui.test.ts test/theme-ui.test.ts
- node --test test/private-terminal-ui.test.ts test/terminal-grid.test.ts test/reviews-ui.test.ts
- npm run check
- npm run lint
- npm test

All new/focused regressions must pass after the fix and fail on baseline where claiming regression. Full-suite failures must be disclosed and compared with the baseline; README.md/docs/terminal-mode.md already warn about inherited failures. No weakening tests, skip-if-fails behavior, source inventories, or disconnected mocks that supply expected behavior. No claims of physical Safari verification.

## STOP conditions and maintenance

Stop/report if tests need a production seam, new package, real Herdr interaction, or a different out-of-scope fixture. Do not duplicate terminal release/modifier/repeat/focus coverage: terminal-grid.test.ts already owns it. Keep hardware QA explicit. Future input/hover/layout changes should fail these observable contracts without tying tests to CSS formatting or source organization.
