# Plan 003: Investigate keyboard viewport behavior without guessing a Safari fix

## Status

- State: DONE for source/Chromium investigation (10 existing tests passed, no clipping reproduced); physical Safari/Android/OS-keyboard/PWA verification remains BLOCKED. No keyboard adaptation was implemented. See plans/003-mobile-keyboard-evidence.md for the manual matrix.
- Priority: P2
- Effort: M
- Risk: MED if implemented
- Depends on: none
- Category: bug (investigation, not an established hardware failure)
- Planned at: commit `9d9fcad`, 2026-10-10

## Context and evidence

The owner primarily prompts from a phone. iOS Safari is a requested but unverified target (PRODUCT.md). The viewport meta has interactive-widget=resizes-content, an Android Chrome capability; it is not proof of Safari behavior. web/style.css uses100dvh for #app/layout/pane. web/message-box.js sizes textarea by innerHeight*.4 and reruns on value changes. Fixed dialog overlays follow the layout viewport. visualViewport is used by model/branch menu anchoring, not by the app shell.

No OS-keyboard occlusion was reproduced during the prior audit. Do not label this as a fixed Safari bug or add a speculative viewport hack. Preserve pinch zoom, intentional focus, native-keyboard opt-in, and Herdr resizing/input semantics. No real Herdr panes or live data.

Read AGENTS.md, PRODUCT.md, docs/self-editing.md, docs/architecture.md, .agents/skills/mobile-native/SKILL.md, /Users/enkelm/.pi/agent/skills/diagnosing-bugs/SKILL.md, and /Users/enkelm/.pi/agent/skills/test-audit/SKILL.md. Relevant source: web/app.js, web/message-box.js, web/composer.js, web/private.js, web/ui.js, web/sheets/model.js, web/terminal-grid.js, src/server/browser/page.ts and browser/cdp.ts. Existing constrained terminal keyboard tests are meaningful; they do not prove OS keyboard behavior.

## Scope and steps

This lane is read-only on source/tests. The only optional written deliverable is plans/003-mobile-keyboard-evidence.md in its worktree, containing no secrets.

1. Trace the visible-viewport/keyboard contracts and their focus/resize interactions across shared/private Chat and dialogs. Distinguish layout viewport, visual viewport, dynamic viewport units and pinch zoom.
2. Check whether a real Safari/device or meaningful WebKit runtime is actually accessible with permitted tools. Do not install packages, launch/control personal devices, or claim simulator/emulation is hardware. Do not use the shared browser tool (the parent owns it). If using executable browser experiments, isolate them with the app's own Chromium/temporary fixture infrastructure and no personal sessions.
3. Use primary platform sources, dependency/source facts or bounded reproducible experiments to establish what can be established. Synthetic visualViewport values may prove layout contract limitations but not an OS keyboard failure. No broad research detour.
4. Report either a reproduced failure with a minimal repair/test design, or BLOCKED physical verification with an exact phone checklist. No JavaScript/CSS fix without a demonstrated contract and reviewer approval.

## Report and done criteria

- Explain whether keyboard viewport clipping was reproduced and by which engine/method.
- Give exact file:line owner evidence, current safeguards and legitimate interactions to preserve.
- If blocked, provide a small manual matrix: shared/private Chat, New-folder/launcher/model/dialog search, terminal Native fallback, portrait/landscape, keyboard close/reopen, pinch zoom and installed-PWA vs browser.
- State what actions/measurements would justify implementing visible-viewport adaptation; do not conflate input font zoom with keyboard occlusion.
- No source/tests/package/data changes and no live-session input. No commits/push/restart.
