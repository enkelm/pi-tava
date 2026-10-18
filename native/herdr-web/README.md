# Native Herdr web helper

A JSON-lines stdin/stdout adapter around the pinned `herdr_client::connect_with_connector`.
It uses Herdr's structured generation-1 endpoint, not CLI ANSI, a PTY, or xterm.
It preserves complete snapshots, reconstructed terminal frames, popup frames,
graphics placements and pixels, and non-frame messages. Upstream owns binary
framing, partial-read retention, boot/projection fences, patch reconstruction,
optional delta/reuse/scroll codecs, and the ordered command queue.

This helper is one part of the web client. The Node gateway owns authentication,
server-side endpoint selection, browser/WebSocket limits, and authorization for
all effects. The browser renderer owns display, clipboard permission, URL policy,
IME, and interaction. A built helper alone does not establish browser GPUI parity.

## Build and test

The pinned crates require **Rust 1.96**, newer than Rust 1.89. Inspect installed
versions with `rustup toolchain list`. Use a named toolchain without changing the
global default. If 1.96.0 is absent, an operator can install it with
`rustup toolchain install 1.96.0 --profile minimal`.

From the repository root, `npm run build:terminal` builds both this connection
helper and the canonical [GPUI/WASM renderer](../herdr-renderer/README.md).
The helper-only build and tests remain available separately:

```sh
node scripts/build-herdr-web.mjs --test
# Result: native/herdr-web/target/release/herdr-web

# Or directly:
cargo +1.96.0 test --locked --manifest-path native/herdr-web/Cargo.toml
cargo +1.96.0 build --release --locked --manifest-path native/herdr-web/Cargo.toml
```

The build script always sets `--target-dir native/herdr-web/target`, even when
`CARGO_TARGET_DIR` is set. `--debug` selects a debug build. `HERDR_WEB_TOOLCHAIN`
can select another installed named toolchain compatible with the dependencies.
It never installs a toolchain or changes the default. Cargo.lock pins transitive
dependencies, while both Herdr git dependencies pin
`e370bf0a55b1bf3e7e7fcb5b3f130ebc1a9e68bf`. No neighboring checkout is used.

Tests launch only this helper and disposable synthetic Unix socket endpoints in
unique `/tmp/herdr-web-test-*` directories. They never launch Herdr, inspect
personal data, send live input, or discover/attach/restart a live daemon.

## Invocation and ownership

```text
herdr-web --socket /server/resolved/herdr-client.sock --cols 80 --rows 24
          [--cell-width 8] [--cell-height 16]
```

The path must be absolute and end in `herdr-client.sock`. Do not pass the JSON
API's `herdr.sock`. The gateway must derive and authorize the path; it must not
accept a browser-supplied filesystem path. There is no default endpoint, discovery,
CLI fallback, environment-based socket override, remote bridge, daemon launch,
reconnect, process signal, or config mutation in the helper.

Columns and rows default to 80 and 24; cell dimensions default to 0, unknown.
The initial handshake requests an **active** client surface. This is an explicit
native client connection, not passive CLI observation. Geometry, focus, navigation,
and terminal input can affect the shared Herdr session. Owner authorization and
clear UI intent belong in the gateway and browser.

Closing stdin, sending `{"type":"close"}`, or losing stdout disconnects the
native client and exits. EOF discards an unterminated final line and may discard
queued commands. It does not close panes or stop their processes. Sent input
cannot be cancelled by detaching. The helper does not replay any operation.
The parent must still reap the child and may terminate its own helper child if it
fails to exit. Do not signal Herdr itself.

Runtime stdout contains JSONL only; diagnostics go to stderr without input/event
payloads. `--help` prints usage instead. Invalid startup flags exit 2; helper I/O
failures exit 1; native disconnect/EOF/explicit close exit 0 with a `closed` event
when stdout can still be written. A broken or backpressured stdout cannot be
promised a final `closed` line. Treat process exit as closure too.

## JSON contract v1

[`interface.ts`](interface.ts) declares the input/output envelopes, semantic
input enums, full frame and image types. Envelope fields use camelCase. Nested
protocol data uses the pinned crate's **snake_case fields and externally tagged
Serde enums**, without browser-specific renaming or filtering.

### Stdout

```text
{type:"connected", welcome: EndpointServerWelcome}
{type:"snapshot", snapshot: ClientShellSnapshot}
{type:"surface", surface: PaneSurfaceFrame}
{type:"images", images: [{key: SurfaceGraphicsAssetKey, serial, encoding:"base64", data}]}
{type:"message", message: ServerMessage}
{type:"response", requestId, response: <complete Herdr API JSON envelope>}
{type:"rejected", requestId?: string, reason: string}
{type:"closed", reason: string}
```

All snapshot fields are preserved, including workspace/tab/pane order, agents,
commands, diagnostics, announcements, worktree information, and release notes.
Receiving snapshot commands never executes them. An explicit owner request can
invoke an advertised configured command, as described below.

`surface` is a full reconstructed frame, never a JSON patch. It includes
`boot_id`, `projection_revision`, `surface_revision`, row-major cells, cursor,
hyperlink table, pane geometry/scroll/mouse flags, splits, optional popup, and
graphics placements/retained keys. Clear an old displayed frame when its
`boot_id` or `projection_revision` no longer matches the latest snapshot's
`boot_id` and `revision`. Do not combine a new hierarchy with stale cells.

After validation, the Node gateway may supersede an unsent complete surface with
the newest one having the same exact boot/projection and frame dimensions while
WebSocket writes are outstanding. Surface revision gaps are therefore valid.
Snapshots, image-set replacements, messages, replies and rejections are ordering
barriers; the held surface is written before them. This does not change the
helper's lossless native patch reconstruction or its stdout queue policy. The
gateway rechecks byte bounds and owner access before delayed writes and discards
held content on closure. A write callback is not a browser paint acknowledgement.

Colors are **not ARGB**: `0..16` are named colors with 0 meaning reset,
`0x010000XX` is an indexed color, and `0x02RRGGBB` is RGB. Preserve `modifier`,
`skip`, grapheme `symbol`, hyperlinks, cursor visibility and DECSCUSR `shape`.

`images` replaces the previous pixel set. A key contains the exact source,
format, dimensions, byte length, and fingerprint. Formats are `Rgb`, `Rgba`,
and `Png`; `data` contains base64-encoded raw RGB/RGBA or PNG bytes respectively.
The native client removes pixel bytes from `surface.graphics.assets`; placements
refer to `images[].key`. Match the whole key, not only image ID. `serial` changes
when the client stores a new copy of an asset.

The pinned `SurfaceImages` API provides `get(key)` but no iterator. The helper
retains each image-store update and discovers keys in emitted surfaces' placements
and retained keys. It publishes newly discoverable pixels before that surface.
Images for a future projection can therefore be deferred until the matching
snapshot/surface arrives. Previously published keys remain available as long as
the upstream store retains them. Empty and redundant replacement events are
valid. The adapter does not copy or patch private upstream internals.

Every integral JSON value outside JavaScript's safe integer range is encoded as
an exact decimal **string**, recursively. Other numbers remain numbers. This
prevents 64-bit graphics fingerprints from being rounded. Compare IDs/revisions
without lossy Number coercion, and keep complete image keys exact.

Examples of `message`:

```json
{"type":"message","message":{"Clipboard":{"data":"text"}}}
{"type":"message","message":{"TerminalBell":{"count":1}}}
{"type":"message","message":{"WindowTitle":{"title":"synthetic title"}}}
{"type":"message","message":"ReloadSoundConfig"}
```

Other variants include semantic notifications, mouse capture, keyboard modes,
endpoint controls, shutdown, and graphics metadata. They are forwarded intact.
Never read `GraphicsFile.path`, execute commands from messages, automatically
open hyperlinks, or write to the browser clipboard without the gateway/UI's
explicit policy. Direct graphics are not enabled by the upstream hello.
Version-mismatch advice is included in the final native disconnect reason.

### Stdin

```json
{"type":"input","bootId":"boot-v1","paneId":"w1:p1","events":[{"TextCommit":"hello"}]}
{"type":"popup-input","bootId":"boot-v1","terminalId":"popup-1","events":[{"Paste":"line one\nline two"}]}
{"type":"resize","bootId":"boot-v1","cols":80,"rows":24,"cellWidth":8,"cellHeight":16}
{"type":"request","bootId":"boot-v1","method":"pane.focus","params":{"pane_id":"w1:p1"},"requestId":"web-1"}
{"type":"focus","bootId":"boot-v1","focused":true}
{"type":"close"}
```

Wait for a snapshot before issuing boot-fenced commands. Use its `boot_id` and
explicit pane/tab/workspace IDs. `focus` reports client focus; selecting a pane
uses the separate `pane.focus` request. Theme input is
`{type:"theme",bootId,theme:{foreground:{r,g,b},background:{r,g,b},palette:[...256 RGB colors],appearance:"Dark"|"Light"}}`.
The client diffs subsequent themes and sends the native updates in order.

Key example:

```json
{
    "Key": {
        "code": "Enter",
        "modifiers": 0,
        "kind": "Press",
        "repeat_count": 1,
        "shifted_codepoint": null,
        "generated_text": null,
        "tracks_release": false,
        "physical_key_id": null,
        "windows_record": null
    }
}
```

Code is a named key, `{"Char":"a"}`, or `{"F":1}`. Kinds are `Press`, `Repeat`,
and `Release`. Modifier bits are Shift=1, Control=2, Alt=4, Super=8, Hyper=16,
Meta=32. Preserve generated text, physical identity, and release tracking when
provided; committed IME text belongs in `TextCommit`, paste in `Paste`.

Mouse example:

```json
{
    "Mouse": {
        "kind": { "Down": "Left" },
        "position": { "Cell": { "column": 3, "row": 2 } },
        "geometry": null,
        "modifiers": 0,
        "lines": 1
    }
}
```

Kinds also include `Up`, `Drag`, `Moved`, `ScrollUp`, `ScrollDown`, `ScrollLeft`,
and `ScrollRight`. Buttons are `Left`, `Middle`, and `Right`. Pixel positions use
`{"Pixels":{"x":24,"y":32,"column":3,"row":2}}`. Optional geometry is
`{cols,rows,width_px,height_px}`. The pinned protocol is the authority for
pane-relative coordinate behavior.

Input objects reject unknown fields, including nested semantic event fields.
Optional upstream key fields may be omitted and become null. Theme palettes must
contain exactly 256 entries. Invalid lines produce `rejected` without echoing
user content; overlong lines or queue overflow close the connection.

### PNG clipboard input

```json
{
    "type": "clipboard-image",
    "bootId": "boot-v1",
    "target": { "Pane": "w1:p1" },
    "encoding": "base64",
    "format": "png",
    "data": "..."
}
```

`target` is either `{"Pane":"current-pane-id"}` or `{"Popup":"current-popup-id"}`.
The helper checks panes against the latest snapshot and popup identity against
the latest matching surface. A snapshot revision change invalidates the popup
until a matching surface arrives. Direct-terminal targets, file paths, other
formats, and unknown fields are rejected. No server file is read or written by
the helper.

The decoded payload is capped at 8 MiB. Base64 is strict; the PNG signature and
IHDR dimensions must be present, with each side at most 10,000 pixels and at most
16,777,216 pixels total. This is header validation, not full image decoding; the
native destination remains responsible for interpreting valid PNG content.
The helper uses `reserve_clipboard_image(...).complete("png", bytes)`, retaining
the client's single-image lease, FIFO position, cancellation, framing, and boot
fences. Admission produces no success event and is not an acknowledgement.

### Requests and acknowledgement

`Method` in `interface.ts` is a closed allowlist mapped to actual pinned
`herdr_client::Method` variants. It includes pane/workspace/tab navigation and
manipulation, split geometry, copy/search/selection/scroll, worktree operations,
surface interest, and explicit configured-command invocation. The client also
checks that the peer advertised each method in `welcome.methods`.

`command.invoke` requires a `command_id` advertised in the latest connected
snapshot's `commands`. Optional `workspace_id`, `tab_id`, and `pane_id` must exist
in that snapshot and agree with one another when supplied. `selection` metadata
is also accepted for configured plugin actions. These are the only allowed
parameter keys. A received snapshot or keybinding definition never invokes a
command automatically. The gateway must apply owner authorization and explicit
user intent. Advertised commands can run configured shell, pane, popup, or plugin
actions, matching the user's configured Herdr shortcuts; arbitrary command text
cannot be supplied through this request.

Standalone plugin APIs, integration installation, config reload, external
scrollback editor, external link activation, and arbitrary execution APIs remain
excluded. Creation APIs accept only these parameter keys:

| Method             | Permitted keys                                                |
| ------------------ | ------------------------------------------------------------- |
| `pane.split`       | `target_pane_id`, `direction`, `cwd`, `focus`, `label`        |
| `tab.create`       | `workspace_id`, `cwd`, `focus`, `label`                       |
| `workspace.create` | `source_workspace_id`, `cwd`, `focus`, `label`                |
| `worktree.create`  | `workspace_id`, `base`, `branch`, `focus`, `trust_repository` |
| `worktree.open`    | `workspace_id`, `path`, `focus`, `trust_repository`           |
| `worktree.remove`  | `workspace_id`, `force`, `trust_repository`                   |

`trust_repository` may only be false. The gateway must confirm destructive
operations and apply any stricter policy. Semantic terminal input intentionally
can execute shell commands; this is not a safe plain-prompt submission channel.

Request IDs are caller-supplied strings, translated to the native client's IDs
and back on `response`/`rejected`. Duplicate IDs while pending are rejected.
`response` retains the original Herdr envelope and original internal `id`; use
outer `requestId` for browser correlation. Preserve error responses as errors.
Unknown delivery on disconnect must not be retried automatically.

**No queue-admission success event is emitted.** Successful enqueueing is not
Herdr acknowledgement, process acceptance, or durable completion. Input, popup
input, clipboard images, resize, focus, and theme do not have protocol acknowledgements. Upstream
asynchronous rejection of those commands has no correlation ID. A request can be
rejected after queue admission; the adapter translates its native rejection ID
back to the caller ID. `rejected` without `requestId` must never be interpreted
as cancelling or settling every pending request.

## Bounds and backpressure

| Resource                            | Bound                                                              |
| ----------------------------------- | ------------------------------------------------------------------ |
| Stdin line, before newline          | 24 MiB, checked while reading; non-image commands limited to 1 MiB |
| Stdin queued lines                  | 16; 32 MiB total including the consumer-held line                  |
| Events per input                    | 1..256                                                             |
| Boot/pane/terminal/request ID       | 1..256 UTF-8 bytes, no controls                                    |
| Terminal geometry                   | 1..512 columns, 1..256 rows, at most 131,072 cells                 |
| Cell pixel dimension                | 0..4096                                                            |
| Pending caller request mappings     | 64                                                                 |
| Output JSON event                   | 32 MiB including newline                                           |
| Output queued events                | 2; 32 MiB total including the writer-held event                    |
| Published image bytes before base64 | 16 MiB                                                             |
| Clipboard image input, decoded      | 8 MiB                                                              |
| Upstream binary command frame       | 2 MiB; clipboard images use the client's dedicated larger frame    |
| Upstream incoming/graphics frame    | 32 MiB                                                             |
| Upstream command/event queues       | 64 / 8                                                             |
| Upstream image store                | 256 images, 256 MiB; 10,000-pixel side limit                       |
| Upstream placements                 | 4096                                                               |

Surface and image events serialize directly from native data, without rebuilding
or reparsing a cell `Value` tree. A linear JSON-token scan quotes unsafe integers;
it allocates a replacement buffer only when such a number occurs. Stdin is read
in chunks with amortized-linear buffer growth. Queue byte accounting includes
consumer-held buffers, not only channel entries. There is no repeated shifting or
concatenation of an accumulated frame.

Invalid or oversized surface geometry fails closed rather than truncating cells.
Output queue admission waits at most 100 ms; a blocked stdout then closes the
connection rather than dropping individual frame events. A separate EOF channel
bypasses a full stdin queue. Shutdown never joins a blocked stdin/stdout worker;
the process exits after a short bounded output flush wait. Upstream can reject
invalid assets under its own limits before they reach the adapter.

## Verification and remaining boundaries

The synthetic suite verifies binary handshake/partial framing, semantic input,
popup input, resize, focus/theme, patch/delta/reuse/scroll reconstruction, complete
snapshot metadata, messages, image formats and exact keys, response chunks and
correlation, rejected methods/boots, future projection ordering, partial-frame
boot fencing, invalid binary frames/patches, stdin bounds, and EOF/close during
handshake. Unit tests verify nested schema rejection, geometry, line allocation
bounds, and exact large integers.

Tests also exercise explicit configured-command invocation, removal from a newer
snapshot, native PNG clipboard framing, invalid/stale targets, image bounds, and
queue byte accounting. These are synthetic protocol checks, not live execution.

No live daemon or personal session has been exercised. Browser rendering,
mobile IME, permission UX, file upload, external editor, standalone plugin/config
APIs, and end-to-end live parity are not claimed by this native adapter. See NOTICE.md, PROTOCOL-NOTICE.md, and LICENSE-APACHE for provenance.
