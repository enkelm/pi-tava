# Plan 004: disposable-browser review

Reviewed 2026-10-10 using the stage 1 `integrated/` sources and `test/serve.ts` on loopback port 8908. The server used fresh temporary data, scripted models and disabled real Herdr discovery. No live session, real terminal, provider action, send, folder creation or import was exercised. Disposable sign-in credentials are omitted here.

## Results

- Phone 390×844: coarse pointer true, hover capability false, root font14px. Composer font16px; document width390px, no horizontal overflow. Phone and desktop screenshots retain the existing dark, square, monospace identity.
- Synthetic insets24px left/14px right at390px: pane occupies24–376px. Composer occupies32.39–367.61px, with controls inside the safe rectangle. This is one shell inset, not repeated composer padding. Message text remains selectable (`user-select:auto`); title controls use `none` and `touch-action:manipulation`.
- Files: Go-to-file font16px at each root preference12,13,14,15,16. Its fixed panel owns the viewport padding once; the filter begins at31px with the24px left inset. Document width remains390px.
- Model popup: actual box32–368px, width336px within24–376px safe bounds plus8px margins. Horizontal padding is0px. Search font16px; coarse opening focuses the menu section, not its input.
- New-folder naming: actual auto-focused input font16px at preferences12–16. Ordinary sheet occupies24–376px and its body computes vertical overscroll `contain`. No folder was created.
- Narrow320×844: coarse pointer remains true. With24/14px insets, sheet occupies24–306px; naming input stays inside that rectangle and font16px; document width320px. At root16px, all composer buttons remain inside24–306px and there is no horizontal overflow.
- Launcher at320px: input font16px at preferences12–15 and16.32px at16, preserving larger text. Popup occupies34–296px within24–306px safe bounds, without repeated inset padding; list overscroll is `contain`.
- Landscape-size844×390: synthetic44/28px insets produce pane44–816px and composer52.39–807.61px, no overflow. Already-safe anchored popup stays420px wide,104.875–524.875px, with no added inset padding. **The shared browser tool uses a fine pointer at this custom width; this is geometry evidence, not a coarse-pointer landscape or device test.**
- Desktop1280×800 after reload: fine pointer/hover true, zero platform insets, tiling on, document and layout width1280px. Screenshot shows intact tiled gaps/borders. Title background changes from transparent to its hover fill under trusted mouse hover. Trusted Tab navigation produces `:focus-visible`, a solid1px accent outline.
- Back closes Files and model overlays after the normal render frame; Escape dismisses the launcher. This checks browser history/key dismissal, not a physical edge-swipe gesture.
- Returning to phone390px, trusted mouse hover still establishes `:hover`, but the title stays transparent under coarse/no-hover capability. This checks rendered capability gating, not real Safari sticky hover.
- Root/body vertical overscroll computes `none`; the viewport metadata keeps initial scale1 and has no zoom-disabling limit. This does not physically test pull-to-refresh or pinch zoom.
- Browser console contains navigation markers only, with no errors.

## Limits and continuation

Changes-filter was absent because the disposable workspace was not a Git repository. Actual file-view/editor and private attachment geometry require the behavioral fixtures, not invented DOM. Held-pointer press evidence comes from the test executor's trusted-pointer regressions; no synthetic `PointerEvent` claim is made here.

The initial viewport call timed out on `Emulation.setTouchEmulationEnabled`; one fresh navigation succeeded, and subsequent viewport/actions/evaluations completed. No browser/server restart or product fix was made for that transient tool error.

This review approves the unchanged four stage1 source hashes and the factual documentation notes, subject to completed regression/full-suite verification and final fingerprint checks. No live transfer is authorized yet. If source changes during integration, repeat the affected browser checks. Physical Safari/Android touch, notches, OS keyboard and installed-PWA behavior remain unverified; plan003 records the hardware gate.

Temporary audit-server PID69888 was verified as this task's `test/serve.ts` process, gracefully stopped with SIGTERM, and its fixture data confirmed removed. The live server was not stopped. Launch a fresh disposable copy if further source changes require browser checks; do not reuse this stale PID.
