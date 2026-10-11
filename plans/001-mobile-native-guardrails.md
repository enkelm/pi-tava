# Plan 001: Finish the mobile-native platform guardrails

## Status

- State: DONE — reviewed round3 source transferred on2026-10-11; focused UI51/51 and geometry5/5 pass. All original Reviews work preserved. Details in plan004 and final browser evidence.
- Priority: P1
- Effort: M
- Risk: MED
- Depends on: none (test development in plan 002 runs in parallel)
- Category: bug
- Planned at: commit `9d9fcad`, 2026-10-10, including the operator's current uncommitted Reviews work
- Execution: isolated detached worktree; no commits, pushes, restart, deployment, or live-data tests

## Why this matters

The owner primarily reads and prompts agents on a phone. Several component styles defeat the existing 16px touch-input protection. Hover-only states, missing press feedback, uncontained scroll boundaries, incomplete landscape safe areas, and a clipped private attachment-removal target make the app less reliable on touch devices. Preserve the existing Pocket appearance and Herdr desktop behavior; this is not a redesign.

## Current state and constraints

Preact/htm plain ES modules; no frontend build. Four-space Prettier, 100 columns. Use existing palette/pressed/motion tokens. Read AGENTS.md, PRODUCT.md, docs/self-editing.md, docs/map.md, docs/architecture.md, docs/features.md, and .agents/skills/mobile-native/SKILL.md in the supplied worktree. Read /Users/enkelm/.pi/agent/skills/impeccable/reference/craft-floor.md immediately before UI edits; incumbent visual identity wins over generic design advice.

Verified excerpts in web/style.css:

```css
@media (pointer: coarse) {
    input,
    textarea,
    select {
        font-size: 16px;
    }
}

.new-folder input {
    /* around line 3805 */
    font-size: 0.85rem;
}

.dr-filter,
.ft-filter {
    /* around line 6555 */
    font-size: 0.8rem;
}

.launcher-input input {
    /* around line 4995 */
    font-size: 1.02rem;
}

.chip {
    /* around line 1856 */
    overflow: hidden;
}
```

Root font follows text preferences 12–16px. At 14px, a coarse-pointer Chromium browser renders New folder at 11.9px (auto-focused by web/sheets/folder.js) and Go to file at 11.2px; composers remain 16px. Actual Safari zoom was not tested. New-folder/filters remain below 16px even at the largest supported preference.

There are many ungated :hover rules in web/style.css and web/reviews.css. Some share a selector list with :focus-visible or root resizing state; split those rather than putting keyboard or selected states behind a hover query. terminal-grid.css gates its keyboard hover by hover capability only.

html/body have no root overscroll policy. .session-items, .sheet-body and .launcher-list have overflow-y:auto without containment. Transcript and terminal already contain scrolling. Legitimate drag handling in gestures.js must not be replaced or blanket-blocked.

Viewport metadata already enables viewport-fit=cover and unrestricted zoom; app/layout/pane use 100dvh. Header/composer/session/sheet/terminal surfaces have top/bottom insets but no left/right insets. Keep dynamic theme-color behavior; do not add redundant theme tags or restrict zoom.

Private attachments are rendered in web/private-input.js as .chip containing .private-attachment-name and a removal .icon-button.small. The name already truncates independently. The small control is 24px tall, with a larger pseudo-element hit area clipped by .chip overflow. A physically adequate touch removal control can fix this without making the whole chip overflow visible.

Terminal key delivery intentionally occurs on release, with scroll/cancel handling and synchronous native-keyboard opt-in. Do not change that behavior or keyboard focus. Do not use real Herdr panes.

## Scope

Only modify:

- web/style.css
- web/reviews.css (pre-existing untracked user file, supplied unchanged in baseline)
- web/terminal-grid.css
- web/ui.js — reviewer-authorized revision limited to horizontal safe-area bounds in popAnchor()

Do not modify other JavaScript, test files, server/native code, package files, data, or unrelated visual identity. Tests are owned by plan 002. If more files are necessary, report before touching them.

## Steps

1. Confirm baseline excerpts and current dirty Reviews file are present. Save a scoped before-copy/diff in the external task directory. Do not erase pre-existing changes.
2. Repair component-specific font overrides under coarse input capability. Preserve desktop typography and any larger selected font size (use an appropriate max(16px, ...) where applicable). No blanket !important and no maximum-scale/user-scalable restriction.
3. Gate every hover-only rule in the three owned stylesheets behind (hover: hover) and (pointer: fine). Keep :focus-visible, selected/active, disabled and root resizing behavior unconditional. Preserve cascade order and existing tokens.
4. Add narrowly scoped touch defaults for genuine application controls: manipulation without suppressing pinch zoom; unprefixed/prefixed control selection suppression and appropriate touch callout handling. Content, messages, errors, URLs, editor text and terminal selection must remain copyable. Do not blanket-disable selection on body or gesture scrolling. Preserve specialized terminal/browser gesture rules.
5. Add restrained :active:not(:disabled) background/color feedback to the title, composer chips and custom private terminal navigation/footer buttons that currently have only hover feedback. Use existing pressed/theme tokens and preserve selected/disabled states. Do not change terminal input delivery timing.
6. Add app-scoped root overscroll protection and containment to the three missing inner scrollers. Prefer vertical-only root suppression if it preserves native horizontal browser Back behavior. Do not add touchmove preventDefault listeners or alter gestures.js.
7. Introduce actual reusable platform tokens --safe-left and --safe-right backed by env(safe-area-inset-left/right, 0px). Protect edge-owning mobile layout/screens, overlays/drawer, composer and terminal controls without padding nested owners twice. Preserve desktop tiled gaps, max-width dialogs, existing top/bottom padding and normal zero-inset layout. Account for fixed/absolute full-screen panels, not just headers. Explain ownership choices in report. Tokens also permit realistic synthetic inset geometry tests without test-only production exports.
   7a. Reviewer refinement: anchored menus already receive coordinates from popAnchor(), so do not blanket-pad .pop-menu:not(.free) by full horizontal insets. In web/ui.js, read the actual --safe-left/--safe-right lengths from computed root styles and clamp popup width/left into that safe rectangle with existing 8px margins. Keep vertical/keyboard anchoring unchanged. Do not introduce a test-only export or viewport hack. Remove unconditional anchored-menu inset padding, and run node --check web/ui.js immediately after every edit. The root tokens and bounding geometry—not duplicated padding—own popup safety.
   7b. Reviewer round2: the new file-view regression proved the early mobile left/right rule is later reset by the global .ft:not(.side) > .ft-view { inset:0 }. Move that selector's mobile left/right override into the existing max-width1099 block after the covering-view inset declaration. Keep the earlier Browser typing-bar override, global/docked zero-inset behavior and all other approved CSS unchanged. No !important, higher-specificity workaround or duplicated interior padding. Export the round2-only delta and rerun parsing/format/scope checks; integrated geometry must turn GREEN without changing its assertions.\n7c. Final browser review at320px with28/44px insets found the file toolbar's Mention button extending to299.97px beyond the276px safe edge. Its metadata already has flex-basis0/min-width0; the row is nowrap. Authorize a mobile-only .ft-view .file-tools flex-wrap:wrap fallback in the existing max-width1099 safe-owner block. Preserve normal/desktop rows, labels, targets and callbacks; let insufficient-width toolbars gain a second row rather than clipping. Extend the existing geometry case with the actual Mention control and demonstrate RED before import, GREEN after; no new fixture or production seam.\n8. Give private attachment-removal controls a physically reachable coarse-pointer target of at least 40px each dimension inside the clipped chip, preserving filename truncation and adjacent-control ownership. Disable unnecessary pseudo-element overreach for this adequately sized control if it would overlap neighboring chips.
8. Format only owned files (including the narrowly scoped ui.js revision) using node_modules/.bin/prettier --write <owned files>; do not format unrelated user changes. Run git diff --check and node_modules/.bin/prettier --check <owned files>. Export a task-only unified diff against the external baseline copies (not against HEAD, which contains user work) for integration. No commits.

## Verification

CSS executor: formatting and diff checks exit 0; no out-of-scope changes. The integrated test executor runs:

- node --test test/mobile-ui.test.ts test/private-input-ui.test.ts test/theme-ui.test.ts
- node --test test/private-terminal-ui.test.ts test/terminal-grid.test.ts test/reviews-ui.test.ts
- npm run check
- npm run lint
- npm test

A prior focused Chromium run of mobile-ui + theme-ui passed 32/32. Full-suite known failures are documented in README.md and docs/terminal-mode.md; classify by comparison against the preserved baseline, never claim the full suite is green when it is not. Check browser phone/desktop layout and console on test/serve.ts disposable data, not the live app.

## Done criteria

- All four input surfaces render at least 16px for coarse pointers across preferences 12–16; desktop sizes preserved.
- Hover feedback is capability-gated, while keyboard focus/selected/disabled states remain working.
- Held-press feedback exists for targeted controls; content selection and pinch zoom remain enabled.
- Missing scroll policies are repaired without changing gesture/input semantics.
- Synthetic nonzero horizontal insets keep edge controls in safe bounds without doubling or horizontal overflow.
- Private attachment removal remains reachable at a 40px target and cannot steal adjacent chip taps.
- Formatting/lint/typecheck and focused regressions pass; all full-suite failures are disclosed and compared with baseline.
- User's existing Reviews work remains intact. No commit/push/restart/deploy.

## STOP conditions and maintenance

Stop if baseline drift prevents safe integration, a solution requires changing server/native/input delivery behavior, or horizontal insets break existing desktop tiling/terminal key reachability. Do not implement a speculative software-keyboard viewport hack; plan 003 is a separate investigation. Real Safari touch/keyboard/notch/PWA verification remains mandatory before claiming hardware parity. New component font/hover rules must follow these safeguards.
