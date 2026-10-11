# Mobile-native implementation plans

Audited 2026-10-10 against `9d9fcad` and the existing uncommitted Reviews work. Implemented through isolated executor subagents and safely transferred on 2026-10-11. The advisor changed only plans. Implementation and transfer used no commit, push, server restart, install or deployment.

The user subsequently requested a commit and explicitly approved combining the Reviews work and mobile improvements. That approval covers one combined commit, including the project-scoped mobile skill and these plans; it does not authorize a push, restart or deployment. Earlier no-commit instructions describe the implementation phase.

| Plan | Goal                                                                                                    | Priority | Depends on              | Status                                                     |
| ---- | ------------------------------------------------------------------------------------------------------- | -------- | ----------------------- | ---------------------------------------------------------- |
| 001  | Field size, hover/press/touch defaults, scroll containment, safe edges and reachable attachment removal | P1       | None                    | DONE — reviewed round3 source applied                      |
| 002  | Rendered behavioral regressions with intended RED/GREEN evidence                                        | P1       | 001 for GREEN           | DONE — all 18 added counts pass                            |
| 003  | Keyboard viewport investigation and physical-device matrix                                              | P2       | None                    | DONE for investigation; physical verification BLOCKED      |
| 004  | Integration, verification, browser review and fingerprint-guarded transfer                              | P1       | 001, 002, full baseline | DONE — exact eight files applied; post-transfer gates pass |

## Applied scope

- `web/style.css`, `web/reviews.css`, `web/terminal-grid.css`: coarse-pointer 16px field floors that preserve larger type; capability-gated hover; control-only touch/selection defaults and held-press feedback; vertical scroll containment; horizontal safe-area ownership; genuine unclipped 40px private removal controls.
- `web/ui.js`: only existing `popAnchor()` horizontal safe bounds, with its original 8px margins. Vertical/keyboard behavior unchanged.
- `test/mobile-ui.test.ts`, `test/private-input-ui.test.ts`: actual fields, styles, trusted held presses, bounds/hit ownership and existing upload/removal callbacks. No source inventories, production-only test seams, weakened expectations or newly skipped tests.
- `docs/features.md`, `docs/architecture.md`: brief factual notes. Existing Reviews prose and all other user work preserved against complete working-state copies, not HEAD.

New geometry tests caught a later `inset:0` resetting the mobile covering-file bounds. Final browser review then caught Mention extending beyond a narrow safe edge even though document width looked correct. The fixes move the inset override after its owner and wrap only insufficient-width mobile toolbars. Both have intended rendered RED/GREEN evidence; normal phone and desktop rows retain their appearance.

## Verification

| Gate                                         | Result                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------ |
| Isolated horizontal geometry                 | 5/5 pass                                                                 |
| Mobile/private-input/theme UI                | 51/51 pass                                                               |
| Terminal/Reviews                             | 22 pass, 1 proven baseline prefix failure                                |
| Full suite                                   | 504 total: 494 pass, 9 baseline-reproduced failures, 1 skip, 0 cancelled |
| Formatting, JS syntax, diff, typecheck, lint | Pass in integration and read-only after transfer                         |

All 25 font samples across preferences 12–16 pass, including launcher16.32px at16. The revised fixture loads real persisted preferences as initial typography, fresh per surface; three isolated GREEN runs and fresh baseline CSS RED at10.2px are retained. This isolates the CSS floor contract, **not** the original live preference-change/render-lifecycle stall.

Initial full baseline was486 total/476 pass/9 fail/1 skip. Final failures retain branch-path/default-branch assertions, Browser HTTP204/200, editor Suggest timeout, model-switch activity assertions and the native prefix chord failure. The additional final QoL cancellation stderr signature was actually reproduced on unchanged baseline. An earlier schedule requester-row reversal was also reproduced on unchanged baseline at attempt23; its suspected numeric-key mechanism is not established. The original import-dialog timeout did not recur; no fix is claimed. Exact names, logs and failure-set comparisons are in the final integration report. Full suite is **not green**.

Parent inspected the disposable app at390px,320px, landscape-size844px and desktop1280px, including synthetic asymmetric insets, actual file view/editor, popup bounds without duplicate padding, focus, Back, selection/zoom metadata, scroll policy and console. Landscape-size parent checks were fine-pointer geometry, not touch-device evidence. The final temporary audit was gracefully stopped and its fixture data removed; live server untouched. See `004-mobile-browser-evidence.md` and `004-mobile-file-browser-evidence.md`.

## Transfer and preservation

Executor atomically replaced exactly the eight approved complete files after fresh original-destination and final-candidate hash checks. Original modes, UID/GID, flags, ACLs and xattrs were preserved. Immediate `node --check web/ui.js` ran before continuing. Read-only post-transfer formatting/diff/type/lint/syntax passed, and parent independently verified all final hashes and every captured other non-plan file/symlink. All 353 ignored Rust build outputs remained intact.

Transfer attempts1/2 stopped before any live write: unsupported Python xattr API, then an overbroad ignored-build inventory guard. Only the external helper was corrected with native metadata operations and a narrowly reviewed inventory rule. Both failed-attempt records remain; successful attempt3 did not change candidate code.

## Explicit remaining limits

- Physical Safari/Android touch, actual notch values, pull-to-refresh/edge swipes, OS keyboards and installed-PWA behavior remain unverified. No clipping was reproduced in the bounded investigation; no speculative keyboard adaptation or hardware-parity claim.
- Original live-preference/CDP renderer stalls remain unresolved. Initial-typography regression coverage does not repair or prove that lifecycle.
- One earlier full-run browser-navigation `The browser closed` observation remains unresolved/nonreproduced, **not** labelled inherited or fixed. It is absent in both later full runs and all baseline/integrated owner reruns; its raw engine fixture does not load changed UI assets. Reviewer accepted this bounded frontend task with all current new regressions passing and all final full failures baseline-reproduced, retaining the observation as a follow-up.
- Terminal canvas, native focus/input, retained control, release-time delivery and drag/repeat cancellation remain unchanged. No real Herdr/session input or personal-device control was used.

## Evidence locations

Task root: `/private/tmp/pi-coop-mobile-native-u2t3fcxl`. Original fingerprints: `baseline-manifest.json`; complete copies: `baseline-files/`. Detached lanes remain for inspection; none were merged or committed.

- `integrated-round3-report.md`, `integrated-round3-task-only.patch`, `integrated-round3-final-hashes.json`: final reviewed implementation, verification and failure classification.
- `live-round3-attempt3-report.md`, final preservation/hash/metadata manifests and gate logs: successful transfer and post-checks.
- Earlier baseline, font, geometry, keyboard, browser-owner and schedule/QoL replay logs remain under the task root.
- `003-mobile-keyboard-evidence.md`: source investigation and manual physical-device matrix.
