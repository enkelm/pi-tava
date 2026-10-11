# Plan 004: covering-file browser review

Fresh disposable file fixture on loopback port8910, integrated sources, scripted model and helper-owned temporary data. Only a dummy README was seeded; no Git commit, real Herdr discovery, live session or actual provider input. Temporary credentials are omitted.

## Round2

At390×844 with coarse input and synthetic28/44px insets:

- Actual covering view occupies28–346px, width318px.
- Back control occupies30.796875–74.796875px, width44px; center hit belongs to that control.
- Document width390px, no overflow. Screenshot retains existing styling.

At320×700, coarse input:

- View occupies28–276px, width248px; Back retains the correct bounds.
- **A further toolbar defect:** Mention occupies213.59375–299.96875px, beyond the276px safe edge. Document width320px does not catch this clipped control.
- Toolbar computes `flex-wrap:nowrap`; metadata is `flex:1 1 0%` with `min-width:0`. All four buttons retain intrinsic minimum widths.
- Changing only the temporary DOM toolbar style to `flex-wrap:wrap` puts Edit, Source and Copy within100.19–267.61px and Mention on a second row at36.39–122.77px. Every center remains hit-owned. The temporary style was immediately restored; no source implementation was made by the advisor.

Round3 is authorized in the CSS executor's isolated lane: mobile-only toolbar wrapping. The integrator extends the existing geometry test to Mention and must record RED on current CSS before importing the reviewed fix. This is not a clipping/hiding/target-shrink workaround. Final source review and browser recheck remain required.

## Round3 final candidate recheck

Actual imported stylesheet computes toolbar wrap without a temporary DOM override. Candidate SHA256 is `5c6a51ae894437e2987ce55ea6db34ee029e88592e366d35dc0323e349bf9da6`.

-320×700/coarse/28–276 safe bounds: Back remains30.80–74.80px. Edit, Source, Copy and second-row Mention all fit; Mention36.39–122.77px. Every center is hit-owned; screenshot shows intact labels. Document width320.

- Actual Edit opens the production editor without typing/saving. Editor viewport37.39–266.61px; footer36.39–267.61px, all five controls inside safe bounds and hit-owned. Long code scrolls within its229px scroller, not the document. Cancel returns normally.
  -390×844/coarse/28–346: all toolbar controls remain on their original single row; Mention251.23–337.61px. Zero-inset390 is also a single row inside0–390.
  -844×390 was **fine-pointer geometry**, not touch/hardware evidence: side mode is retained, all controls fit28–800, no viewport overflow.
  -1280×800/fine: after normal resize animations settle, zero-inset view716.61–1268 sits within tile715.61–1270; toolbar remains nowrap/single-row and hit-owned. First intermediate measurement during the transition is not stable geometry or a claimed defect. With28/44 insets the docked view704.28–1224 sits within tile703.28–1226, with no second view inset. Document width1280.
- Real Tab navigation from file Back focuses Edit with `:focus-visible` and a solid1px accent outline. Ordinary browser Back dismisses the covering file; after its normal animation no file view remains and Files tree remains visible.
- Console contains navigation notices only, no errors. Earlier unchanged-source browser gates remain applicable; no physical parity or original live-preference-renderer repair is claimed.

Verified exact external-script command for PID48985, sent graceful SIGTERM only to it, confirmed process exit and helper-owned temporary root removal. Live server untouched. Hardware Safari/Android/notch/OS-keyboard/PWA behavior remains unverified. No credentials in this evidence.
