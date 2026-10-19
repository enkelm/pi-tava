# iPad battery investigation: GPUI renderer scheduling and teardown

Research only, 2026-10-19. Repository examined at `61a25cf171e18c26e5c50cabf0437d76f1ef68b4`; renderer introduction is `511c6fdad719514fd3cf304986cc34d41e95dc21`.

## Answer to the narrowed report

The owner's clarified sequence is **open a live Herdr Terminal → return to an ordinary Collab thread → leave the PWA**. **The inspected pinned renderer does not have a perpetual idle `requestAnimationFrame` loop.** Frame requests are demand-driven, and its GPUI/wgpu rendering runs inside the terminal iframe, not the parent application. Because the switch to Collab already unmounts that iframe, later hiding/leaving the parent app does not establish any surviving renderer execution.

Given the parallel investigation's confirmed premise that switching to Collab unmounts `PrivatePane` and its `TerminalGrid`/iframe, **no continuing WASM/GPU animation path after that iframe's destruction was found in source**. This is stronger evidence against an always-running renderer than merely assuming Safari throttles a hidden canvas. It does not establish the battery cause or prove Safari releases every GPU allocation immediately.

Important distinction: the app does **not** explicitly close the GPUI window or destroy its GPU device on iframe removal. Rust `Drop` cleanup exists for a logical GPUI window close, but that is not an app-invoked teardown API here. Browser document destruction stops the child document's tasks/rendering; memory reclamation and actual GPU-process behavior require device evidence. Retained native WebSocket/pool traffic is a separate investigation owned by the main agent, not evidence that the GPU renderer survived.

## Evidence and exact pins

All application paths below are relative to this repository at the examined HEAD. Dependency paths use:

```text
C = /Users/enkelm/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f
```

- `native/herdr-renderer/Cargo.toml:18-27` pins `gpui-pre =0.3.6`, `gpui-pre-web =0.3.6` with `default-features = false`, Herdr protocol revision `e370bf0a55b1bf3e7e7fcb5b3f130ebc1a9e68bf`, and wasm-bindgen `0.2.129`.
- `native/herdr-renderer/Cargo.lock:1633-1685` locks `gpui-pre-web` and `gpui-pre-wgpu` to `0.3.6`; `Cargo.lock:4572-4600` locks wgpu to `29.0.4`.
- `C/gpui-pre-web-0.3.6/Cargo.toml:24-36`, `C/gpui-pre-wgpu-0.3.6/Cargo.toml:24-32`, and `C/gpui-pre-0.3.6/Cargo.toml:47-50` identify the GPUI snapshot as Zed revision [`bcf6582ce3500df93a8a39366640173e6786cea6`](https://github.com/zed-industries/zed/tree/bcf6582ce3500df93a8a39366640173e6786cea6). This is package provenance, not a claim that arbitrary current Zed source is identical.
- The Herdr extraction records its original commit and deliberate adaptations in `native/herdr-renderer/UPSTREAM.md:1-21`: [`penso/herdr-gpui@e370bf0a55b1bf3e7e7fcb5b3f130ebc1a9e68bf`](https://github.com/penso/herdr-gpui/tree/e370bf0a55b1bf3e7e7fcb5b3f130ebc1a9e68bf). The application uses the locally adapted extracted painter, not the full desktop Herdr application.

Exact published package source references corresponding to the local inspection:

- [gpui-pre-web 0.3.6 / window.rs](https://docs.rs/crate/gpui-pre-web/0.3.6/source/src/window.rs)
- [gpui-pre-web 0.3.6 / events.rs](https://docs.rs/crate/gpui-pre-web/0.3.6/source/src/events.rs)
- [gpui-pre-web 0.3.6 / dispatcher.rs](https://docs.rs/crate/gpui-pre-web/0.3.6/source/src/dispatcher.rs)
- [gpui-pre-web 0.3.6 / platform.rs](https://docs.rs/crate/gpui-pre-web/0.3.6/source/src/platform.rs)
- [gpui-pre 0.3.6 / window.rs](https://docs.rs/crate/gpui-pre/0.3.6/source/src/window.rs)
- [gpui-pre-wgpu 0.3.6 / wgpu_renderer.rs](https://docs.rs/crate/gpui-pre-wgpu/0.3.6/source/src/wgpu_renderer.rs)
- [gpui-pre-wgpu 0.3.6 / wgpu_context.rs](https://docs.rs/crate/gpui-pre-wgpu/0.3.6/source/src/wgpu_context.rs)
- [wgpu 29.0.4 / backend/webgpu.rs](https://docs.rs/crate/wgpu/29.0.4/source/src/backend/webgpu.rs)

The dependency investigation used **local cached source**, not external package fetches. SHA-256 of each cached `.crate` archive matched its Cargo.lock checksum for `gpui-pre`, `gpui-pre-web`, `gpui-pre-wgpu`, and `wgpu`. The inspected files above byte-matched their archive members. This verifies the scheduling evidence against the lockfile rather than trusting an unrelated installed version. One initial verification script failed because the system Python lacks `tomllib`; a standard-library regex/tarfile/hashlib version completed the checks successfully.

## 1. The exact frame path is on-demand

### Application admission

`native/herdr-renderer/src/web.rs:15-19,54-106` creates one GPUI application/window per WASM instance and retains its host in iframe-local Rust thread-local state. It sets the runtime threading argument to `false` and chooses `WebBackendPreference::Auto`.

Only incoming `present` and `clear` calls update the host and invoke `cx.notify()` (`src/web.rs:112-148`). The JavaScript child forwards authenticated parent `gpui-present`/`gpui-clear` messages to these exports (`native/herdr-renderer/renderer.js:41-99`). Its startup instantiates WASM and calls `wasm.start` inside the iframe (`renderer.js:129-170`).

The scene performs terminal painting, not a self-scheduling animation (`src/scene.rs:93-216`). A source search of `native/herdr-renderer/src` found no `request_animation_frame`, `on_next_frame`, animation, or recurring timer call. Native cursor arguments are `None` when this scene invokes the painter (`scene.rs:180-211,229-248`); the parent owns its cursor. Image decoding creates finite tasks and refreshes once on completion (`src/upstream/terminal_painter/images.rs:393-415`), rather than a ticker.

### Pinned GPUI web scheduler

In `C/gpui-pre-web-0.3.6/src/window.rs`:

1. `WebWindow::new` creates the rAF closure and wakes it initially (`:233-234`).
2. `create_raf_closure` clears the fired request's `raf_id`, then invokes the registered frame callback with `require_presentation: false` and `force_render: false` (`:437-455`). **It does not request another frame itself.**
3. `wake_frame_loop` returns if one rAF is already pending; otherwise it calls that iframe's `browser_window.request_animation_frame` once (`:464-473`).
4. `frame_waker` holds `WebWindowInner` weakly and invokes `wake_frame_loop` only when called (`:918-929`). It explicitly avoids a strong-reference invalidator cycle.

The GPUI core callback is equally important; reading the browser rAF wrapper alone would not settle whether core re-arms it forever:

- `C/gpui-pre-0.3.6/src/window.rs:168-237`: the invalidator wakes the platform when a clean window becomes dirty; installing a waker wakes existing initial demand.
- `:1700-1839`: the frame callback consumes next-frame callbacks, draws/presents when dirty or forced, and otherwise presents only when presentation demand exists. At the end it re-arms the platform **only if the invalidator remains dirty or next-frame callbacks remain** (`:1820-1836`).
- `:2610-2633`: animation requests explicitly enqueue another next-frame callback. The extracted terminal scene does not call this API.
- `:3283` clears the dirty flag during draw. `:3444-3459` presents via `platform_window.draw` and clears `needs_present`.

The core has a high-rate-input presentation heuristic and inactive/thermal frame throttling (`:1741-1769,1791-1797`). Those are not proof of perpetual work: on this backend they do not independently re-arm idle rAF. The extracted child is paint-only, not the app's terminal input transport.

### Actual GPU submission, not just CPU receipts

`C/gpui-pre-web-0.3.6/src/window.rs:975-990` calls `state.renderer.draw(scene)` from the platform draw entry. `C/gpui-pre-wgpu-0.3.6/src/wgpu_renderer.rs:1265-1403` acquires a surface texture, writes buffers, records the frame, and presents it; `:1535-1538` submits the command encoder. These are call-driven operations, not an independent GPU animation loop.

The app's `gpui-painted` acknowledgement is deliberately a **CPU scene-construction receipt**, not proof of GPU/display completion (`native/herdr-renderer/src/web.rs:34-40`). It cannot by itself measure GPU idle or battery draw.

## 2. Unmount, logical GPUI close, and browser destruction are different

### Parent renderer cleanup

`web/terminal-grid.js:1993-2007` owns the iframe as an ordinary conditional Preact child. Its `src` is `gpui.source`; there is no detached iframe/worker cache in the asset loader.

On hook unmount, `web/terminal-renderer.js`:

- removes resize/DPR listeners (`:95-108`);
- aborts its startup waiter and prevents late asset completion from mounting a child (`:111-147`);
- marks the bridge dead, calls `connection.dispose()`, removes the parent `message` listener, and drops the bridge ref (`:149-193`).

`web/terminal-renderer-bridge.js:292-297` sets `disposed`, releases waiting/in-flight presentation refs, and cancels its deadline timer. It sends **no GPUI close/dispose command**. Its queue and timeout behavior are bounded, not a recurring render timer (`:48-77,115-131`).

This note accepts the main investigation's separately traced premise that Collab navigation removes `PrivatePane`/`TerminalGrid`. It does not re-audit the native connection pool or its suspension request.

### Child pagehide is not explicit Rust teardown

`native/herdr-renderer/renderer.js:102-108` handles `pagehide` by setting `disposed`, clearing receipt state/bootstrap, and disconnecting its MutationObserver. It does not call a Rust disposal export, cancel a GPUI rAF directly, clear the Rust `HOST`, or destroy a GPU device. `src/web.rs` exports only `start`, `present`, and `clear`.

Do **not** rely on this pagehide handler firing when an iframe element is removed. The HTML Standard's [iframe removing steps](https://html.spec.whatwg.org/multipage/iframe-embed-object.html#the-iframe-element) destroy its child navigable; its accompanying note says this happens without unload events because the document is destroyed, not unloaded.

### What the pinned backend's Drop actually does

`C/gpui-pre-web-0.3.6/src/window.rs:592-627` implements `Drop for WebWindow`:

- cancels a pending rAF before its closure is freed;
- removes the stored rAF function so surviving frame wakers cannot re-arm it;
- disconnects resize/safe-area observers;
- breaks the DPR listener reference cycle;
- removes canvas/IME nodes and marks the logical window closed.

`events.rs:77-86` unregisters each listener when its handle drops. `window.rs:663-669` unregisters the DPR media listener. These are concrete cleanups for **a Rust GPUI window being dropped**, not evidence that iframe DOM removal calls Rust destructors. The host does not invoke GPUI `remove_window`; `platform.rs:349-350` also says platform `quit` is unsupported.

At the lower WebGPU layer, `C/wgpu-29.0.4/src/backend/webgpu.rs:2573-2582` separates explicit device `destroy()` from a no-op `WebDevice::drop`; `:3940-3953` has a no-op surface Drop and automatic web presentation. Thus even a Rust Drop should not be described as a synchronous browser GPU-device destroy. These details are specific to the WebGPU backend; they are not a complete audit of WebGL resource cleanup.

### Why an unreferenced destroyed iframe is not a supported background renderer

Primary browser lifecycle rules were checked through the constrained research reader:

- [Destroy a child navigable](https://html.spec.whatwg.org/multipage/document-sequences.html#destroy-a-child-navigable) nulls the container's content navigable and destroys its active document and descendants.
- [Destroy a document](https://html.spec.whatwg.org/multipage/document-lifecycle.html#destroy-a-document) aborts it, runs cleanup, removes its queued tasks without running them, and nulls its browsing context. The standard expressly allows the Document object to remain script-accessible afterward; reachability is not ongoing execution.
- [Update the rendering](https://html.spec.whatwg.org/multipage/webappapis.html#update-the-rendering) processes fully active documents and filters hidden/non-renderable documents before rendering and animation-frame callbacks. [Animation frames](https://html.spec.whatwg.org/multipage/imagebitmap-and-animations.html#animation-frames) removes each callback before invoking it; a subsequent frame requires a new request.

Together with the child-local scheduler and disabled worker threading, these provide no ordinary source path for continued terminal WASM/GPU animation after iframe destruction. Already-submitted GPU work or asynchronous release can have a finite tail. A Safari/WebKit defect or unexpected retained active iframe requires a trace; neither is established here. Browser rules are expected behavior, not observations from the affected iPad.

## 3. Hidden or blank is not destroyed

`gpui-pre-web/window.rs:512-539,644-655` observes the iframe document's `visibilityState`, updates active/visible state, and notifies GPUI. Core GPUI updates visibility observers (`gpui-pre/src/window.rs:1917-1927,2162-2176`). The browser handler does **not** itself cancel rAF or destroy the GPU context on visibilitychange. Background document rAF behavior comes from the browser rendering rules above.

CSS visibility is distinct: `web/terminal-grid.js:2003` uses `visibility: hidden` until the current receipt is ready. That is not iframe destruction, nor a document-visibility suspend API.

For a mounted but non-drawable surface, `web/terminal-renderer.js:203-206` sends `clear`, not shutdown. `Scene::clear` releases the presentation/assets and requests image-cache clearing on the next paint (`src/scene.rs:82-104`), while the GPU window/context remains allocated. A single clear paint is demand, not an endless blank render loop.

## 4. Memory and startup work worth distinguishing from idle rendering

### Images

`native/herdr-renderer/src/upstream/terminal_painter/images.rs` uses a 32 MiB per-image decode allocation limit, 4096 texture-side limit, 32 MiB decoded texture accounting target, 128 entries, two simultaneous decodes, and 60-second idle age (`:28-39`). Ready images are single-frame `RenderImage`s (`:417-419`), not animated image players.

`ImageCache::clear` cancels retained decode tasks, isolates late completions, calls `window.drop_image` for ready images, and resets accounting (`:233-248`). Finished decode work refreshes the window once (`:393-414`). Eviction is performed from paint/cache preparation (`:250-260,313-360`), **not a 60-second timer**. An otherwise idle retained iframe can therefore keep unused texture memory until another paint/clear/destruction.

The 32 MiB target is **not** a total WASM/GPU memory cap: in-flight decodes and entries used in the current paint are protected from that eviction loop, encoded bytes/temporary pixel copies coexist, and framebuffers/GPUI atlases/pipelines are outside that number (`:313-348`; separate DPR pixel admission limit in `web/terminal-renderer.js:66-70`). Memory pressure is a measurement question, not evidence of continuing frame submission.

### Prefetch is compile-only

`web/app.js:902` starts `startTerminalRendererPrefetch(store)`. `web/terminal-renderer-assets.js:1-5,50-86,90-132,135-210` downloads/compiles public WASM, retains at most two revision promises, and schedules one eligible owner prefetch attempt. It calls `WebAssembly.compileStreaming`/`compile`, **not instantiate or start**, and creates no renderer iframe.

Scheduled prefetch is canceled when ineligible; already-started public download/compilation intentionally survives hide/sign-out/mount cancellation so another mount can share it (`:147-174`). This can produce finite CPU/network work while Collab is open, including for an owner who has not mounted Herdr in that page lifetime. It does not establish sustained GPU activity. The per-revision cache retains compiled **Modules**, not running WASM Instances or terminal content.

### Adapter and resolution choices

`C/gpui-pre-wgpu-0.3.6/src/wgpu_context.rs:154-194` requests Auto WebGPU/WebGL selection and `PowerPreference::HighPerformance`. That is a requested adapter hint, not evidence of the iPad's chosen hardware/power state. The high-DPR backing pixel admission ceiling is 16 million (`web/terminal-renderer.js:66-70`), not an energy budget. These matter to active rendering/allocation experiments; neither explains a surviving animation after the child was removed.

## Focused measurements and acceptance criteria

No device, browser, live Herdr, personal session data, or energy profiling was used. No feature/test/source changes were made. Do not turn this static investigation into a battery-cause claim.

A later authorized disposable/device investigation should compare the same idle Collab content in these states, with fixed brightness, refresh-rate settings, thermal conditions and radio conditions. Reproduce the actual sequence through leaving/backgrounding the app, not just a mounted hidden terminal; even finding a mounted animation loop would not establish detached-iframe/background activity:

1. Fresh PWA page on Collab; record the one-time prefetch/compile interval separately from steady state.
2. Open a static Herdr terminal once, then return to that same Collab thread.
3. Stay on a static visible Herdr terminal; distinguish native output, parent updates, child CPU paint, GPUI rAF callbacks and actual GPU submissions.
4. Repeat foreground/background and several Herdr/Collab cycles, using synthetic image/no-image presentations.

Record only counters/timestamps, never terminal text: mounted renderer iframe count; child rAF callback count; `present`/`clear` admission and CPU-paint counts; GPU submit rate/energy trace; WASM-instance/context counts and memory trend; parent/native receive rate separately. An inspector can perturb scheduling, so battery comparison also needs an uninstrumented run.

Acceptance criteria for the **renderer lifecycle**, not a universal numeric battery threshold:

- A settled static visible terminal produces no ongoing renderer rAF/CPU paints/GPU submissions absent output, image-decode completion, resize, or another explicit invalidation.
- After switching to Collab, zero renderer iframes remain; no renderer-child rAF, paint receipts or new GPU submissions continue after destruction settles. A finite already-submitted tail is not an endless loop.
- Repeated open/close cycles do not monotonically accumulate live renderer instances/contexts. Resource release may be asynchronous; quantify the tail rather than asserting immediate Rust Drop.
- Hiding a mounted terminal and returning must not produce sustained hidden renderer work or stale-content/input receipts. Clearing cancels obsolete image work before its CPU receipt, without claiming that receipt is a GPU fence.
- Separate retained native transport activity and one-time module compilation from renderer work. Correlation with either still needs an energy comparison to establish the cause of the reported drain.

Unresolved choice only if profiling warrants it: an explicit child shutdown handshake could make logical GPUI cleanup testable before iframe removal, but would need an actual Rust disposal export/window handle and startup-race handling; a JS disposed flag alone is not GPU teardown. Selecting lower-power hints or unmounting on background also changes recovery/latency behavior. None is justified as a battery fix by this investigation alone.
