# Herdr renderer extraction

Source: [penso/herdr-gpui](https://github.com/penso/herdr-gpui/tree/e370bf0a55b1bf3e7e7fcb5b3f130ebc1a9e68bf), revision `e370bf0a55b1bf3e7e7fcb5b3f130ebc1a9e68bf`. Copyright 2026 Fabien Penso, Apache-2.0. See `LICENSE-APACHE`, `NOTICE-HERDR`, and `NOTICE-PROTOCOL.md`. No Herdr icons, audio, desktop services or app assets are included.

`src/upstream/terminal_painter.rs` and its five submodules are the actual pinned terminal painter: glyph shaping/cache, backgrounds, borders/block graphics, decorations, cursor, selection and image painting. They submit a GPUI scene; this is not the JavaScript Canvas2D painter rewritten in Rust. `upstream-files.json` records the original and extracted SHA-256 hashes.

Adaptations:

- Use `web_time::{Duration, Instant}` instead of the unsupported browser `std::time::Instant` clock.
- Omit upstream test modules, which depend on the full desktop application. Integration-test-only code remains disabled.
- Extract only the rendering helpers from `terminal.rs`, and the default theme and primary accent from `config/theme.rs`. The retained theme contrast field has only its default `Standard` value; native theme-file discovery is not included.
- Extract `SurfaceImage`, `SurfaceImages` and asset validation from `herdr-client/src/surface_images.rs`. A local `herdr_client` facade exposes these types and the exact pinned `herdr-protocol`. Stable live image identities reuse their image objects; no sockets, transport reconstruction or input are included.
- Keep the browser’s 32 MiB decoded-image budget in the live parser, decoder and texture cache (the desktop extraction originally allowed 128 MiB decoding/256 MiB textures).
- Add explicit painter appearance updates and GPU image-cache clearing. Retain cancellable decode tasks instead of detaching them; fence clearing cancels those tasks and calls `window.drop_image` for ready entries before acknowledging.
- Add a bounded live-presentation parser, `Scene` and a paint-only GPUI host. They consume the parent terminal’s reconstructed frames, theme, selection, images and explicit cell metrics. Native cursor painting is disabled; existing parent input and geometry remain authoritative. Generated demo-frame scaffolding is not retained; parser and font tests exercise the production packages directly.

GPUI is pinned to `gpui-pre =0.3.6` and `gpui-pre-web =0.3.6`. Cargo.lock pins the transitive renderer/backend dependencies. The web platform’s `multithreaded` feature and runtime flag are disabled. Using it directly avoids `gpui-pre-platform` transitively enabling the nightly-only `wasm_thread` dependency. These packages have an existing browser platform and wgpu backend; no new GPU renderer backend was written here.

`fonts/JetBrainsMonoNerdFontMono-Regular.ttf` is the unmodified Mono Regular face from Nerd Fonts v3.5.1 / JetBrains Mono 2.304, extracted from an existing public release archive cache. Its OFL, upstream attribution/icon-set license table, source URL and checksums are retained in `fonts/`. The production `font` package embeds these exact bytes for startup and coverage tests. The earlier Fira face was missing ordinary terminal symbols and private-use icons; it is no longer bundled. GPUI’s browser emoji/CJK fallback remains enabled. Parent-provided cell geometry is used regardless; this regular face does not establish universal or all-style glyph parity.
