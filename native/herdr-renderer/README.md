# Herdr GPUI/WASM renderer

The pinned Herdr Rust painter, running through GPUI 0.3.6’s browser/wgpu backend, is the sole terminal painter. There is no Canvas2D alternative or renderer toggle. `PrivateTerminal`, its connection, `TerminalGrid`, input textarea and transparent DOM interaction surface remain authoritative.

The iframe is paint-only, behind the interaction layer. Input, IME, touch, keyboard, selection, clipboard, cursor and geometry remain in the parent. GPUI receives complete reconstructed presentations and explicit parent cell width, cell height and font size; it never measures a font to resize a PTY. There is no runtime demo, generated content, transport decoder, shell or separate input path. The extracted painter is reusable Rust source, not a desktop application or a claim that a native desktop target has been validated. See [UPSTREAM.md](UPSTREAM.md) for provenance.

## Build offline

Required tools: Rust **1.96.0** with `wasm32-unknown-unknown`, cached dependencies and `wasm-bindgen-cli` matching Cargo.lock (**0.2.129** at extraction). The installed stable toolchain works; no nightly, atomics, shared memory or cross-origin isolation is required. Fetching dependencies or installing tools is a separate human-authorized setup step, not part of this script.

```sh
npm run build:terminal-renderer
```

`npm run build:terminal` builds both the connection helper and this renderer. `npm run build:terminal-renderer` rebuilds only WASM assets; `npm run test:terminal-renderer` runs the production parser/font and parent bridge/hook tests.

The renderer script builds release WASM offline/locked with an explicit local target directory, checks the binding-tool version, validates WASM and JS syntax, and exercises the real generated JS→WASM interface without starting graphics. It installs a complete immutable revision into ignored `web/herdr-renderer/` before atomically replacing `build.json`. Existing revisions are never rewritten. Build staging is removed afterwards. The font is embedded once in WASM; asset distributions retain its notices and OFL without a redundant standalone TTF. The browser reads `/herdr-renderer/build.json` and requires a live-renderer manifest. Previously generated prototype assets remain available only for frames already using their immutable URLs; there is no legacy source path, loader or build command. No server changes or restart are needed for renderer assets.

After a visible, online owner signs in, app startup schedules an idle background download and compilation of the public WASM module (including its embedded font). It does not instantiate WASM, open a GPU window, connect to Herdr, resize a PTY or send input. Terminal entry and retry check the manifest afresh and share the same in-flight or completed compilation for that revision. The parent passes the compiled `WebAssembly.Module` to each authenticated child, so iframe replacement does not download WASM again. The page retains at most two revisions; immutable HTTP caching also permits reuse across page reloads. Failed preloads are evicted and explicit entry/retry can recover. Queued idle work is cancelled on hide, offline, departure or access loss; an already-started public-code load may finish for a foreground consumer.

Opening Terminal starts GPUI automatically. Readiness follows asynchronous GPU/window/scene setup, not the return from `start()`. Input remains disabled until the current input context has completed its first CPU paint callback. Geometry-only repaints keep that acknowledged input context and active IME composition intact while old pixels remain hidden. A missing build, rejected presentation, GPU setup failure or paint timeout shows a fixed redacted error and **Retry renderer**. Retry replaces only the iframe/session, not the terminal connection; it never replays input. No fallback painter is retained.

## Presentation and lifecycle

`web/terminal-renderer.js` is the single renderer entry used by `TerminalGrid`; it mounts the paint iframe and supplies `{surface, images, metrics, theme, selection}`. Every complete presentation includes its images, so replacing a waiting presentation cannot drop an image-before-surface dependency. Its internal `web/terminal-renderer-bridge.js` keeps one in-flight presentation and one replaceable pending presentation, serializing only sends, with a **32 MiB UTF-8** limit. Authentication requires the exact iframe window, same origin and a fresh random session.

Boot, projection, input epoch, popup/target geometry and parent metrics changes invalidate the visible GPU surface immediately. A bounded clear barrier cancels old receipts before sending the latest presentation. Missing/paused surfaces clear frame and image state; fence cleanup cancels image decode tasks and releases ready GPU atlas images before acknowledging. Disposal and explicit retry retire the old child and startup work. No terminal content, images, exceptions or raw identifiers are logged or stored by this bridge.

Cold manifest checks have a 15-second deadline; download/compilation has a separate 120-second budget. Only after those assets are ready does the iframe's 20-second bootstrap deadline begin. Binding JS, CSS and HTML load normally on iframe entry. Hashed build files have immutable caching, validators and streaming delivery; large WASM/code transfers support negotiated gzip. `build.json` and editable app source stay fresh. The app CSP permits WASM compilation (`wasm-unsafe-eval`), not arbitrary script evaluation. These HTTP/CSP server changes require an owner-requested server restart; asset-only rebuilds do not.

The Rust `font` package embeds the exact licensed face used by GPUI startup and its glyph-coverage tests. The Rust `frame` package validates bounded presentation fields independently of GPUI. `Scene` paints root and popup layers, pane content masks, selection and structured images with the actual extracted painter. Native cursor painting is disabled because the existing DOM cursor remains authoritative. The former generated demo-frame crate has been removed; tests build synthetic presentations at the parser’s own interface.

## Current limits

- GPUI runs single-threaded on the main thread, not in a worker or OffscreenCanvas. Auto tries WebGPU, then WebGL; the selected backend is not reported. It uses the browser’s backing DPR. A mount/resize exceeding 16 million physical pixels fails closed; retry cannot bypass the cap. Image parsing/decoding/cache code targets a 32 MiB budget, but review found an unresolved PNG declared-versus-decoded-dimension allocation gap. Image-cache replacement at its 128-entry cap and redundant base64 decoding also remain deferred; this loading repair does not fix those findings.
- The embedded OFL **JetBrains Mono Nerd Font Mono Regular** supplies ordinary terminal symbols and Nerd private-use icons without relying on installed browser fonts. Coverage tests check actual glyph outlines and GPUI’s font-family selection. Parent cell geometry is preserved. The regular face alone does not establish bold/italic, shaping or universal glyph parity; emoji/CJK still use GPUI’s approximate browser fallback.
- Presentations are full JSON snapshots, not a new compact wire format. Oversized or unsupported presentations report renderer failure. The painter does not remove server/network scrolling latency.
- A callback acknowledges **CPU scene construction**, not GPU completion or visible pixels. Compilation and parser/bridge tests do not establish successful browser presentation, Safari/iOS compatibility or a speed improvement.

## Focused checks

```sh
cargo +1.96.0 test --offline --locked \
  --manifest-path native/herdr-renderer/Cargo.toml \
  -p herdr-renderer-frame -p herdr-renderer-font

node --test test/terminal-renderer.test.ts test/terminal-renderer-preload.test.ts \
  test/terminal-renderer-child.test.ts test/terminal-renderer-assets.test.ts \
  test/terminal-grid-render.test.ts \
  test/terminal-touch.test.ts \
  test/terminal-viewport.test.ts test/terminal-diagnostics.test.ts
```

Font tests cover actual embedded glyphs, outlines and family selection. Parser tests cover live-envelope validation, metrics, clipping, Unicode, selection, exact image identities and limits. The grid’s public-handler tests check swipe distance and reject blind input while the renderer is unavailable; they supply painter readiness and do not test Preact lifecycle or phone responsiveness. Bridge and real-Preact hook tests cover authenticated receipts, coalescing, full image snapshots, fence barriers, deadlines, disposal, renderer-only retry and redacted errors. Preload tests compile a small real WASM module and cover startup/auth/visibility admission, concurrent and repeated use, cancellation, failures and manifest updates. Child-script tests use the inspected asynchronous GPUI contract through a bindings stub; they establish scheduling and protocol behavior, not GPU initialization. Socket-free HTTP tests exercise the actual router's static caching, compression, MIME and CSP behavior. Private browser fixtures cover UI prefix/focus and renderer lifecycle behavior using a mock paint child, not a GPU. They were not executed during the GPUI-only migration because the listener capability was unavailable. Real browser/device execution remains a separate check. All test data is generated; do not attach to owner panes to validate this renderer.
