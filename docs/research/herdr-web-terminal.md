# Full Herdr access from the web

This research began after the first Private mirror. The user chose the full structured GPUI protocol over the smaller CLI ANSI prototype described below. The native helper, Node gateway and browser renderer now exist and are under validation. See [the current Terminal contract](../terminal-mode.md). Development tests use synthetic endpoints, never owner panes.

The subsequent UX decisions are desktop Terminal by default, mobile agent Chat by default, direct Herdr keyboard shortcuts on desktop, and a mobile-only helper bar. Opening Terminal now connects automatically and keeps an instance connection across navigation. This supersedes the initial per-connection Connect acknowledgement screen. Reconnect starts with fresh state and never repeats user input.

## Intended experience

- Agent panes default to Pocket-style Chat, with Terminal available for native commands, approvals and interactive tools.
- Shell and non-agent panes are terminal-first, with a mobile command-entry/key bar.
- Desktop can show split panes; phones show a focused pane and quick switcher instead of squeezing desktop splits onto the screen.
- The private interface remains owner-only. Import & share remains the explicit transition to a managed Durable conversation.
- Changing views must not restart the process or silently take over the desktop client's control or geometry.

The first implementation in `web/private.js` is a bounded saved-history/terminal-snapshot view, not this full terminal client. Its 56 focused tests passed before the terminal follow-up; the complete regression suite has not yet been run for this addition. Do not report full terminal support or a finished release.

## Reusable protocol

Herdr GPUI's `crates/herdr-client/src/session.rs` negotiates an endpoint hello and live pane surfaces. `crates/herdr-protocol/src/wire.rs` defines `PaneSurfaceFrame`, incremental patches, cell/cursor data, `ClientShellPaneInput`, endpoint requests, and a separate `TerminalFrame` carrying bytes. `crates/herdr-client/src/frame.rs` retains partial length-prefixed frames across reads; throwing away partial reads would corrupt framing.

A browser needs a server-side bridge to the local socket. Reusing the existing client/protocol is preferable to scraping text or starting a second terminal session.

The scout's final source review identified a smaller first prototype. Herdr 0.9.1 at `856b64b9bfd41b9d3d82e2375ed5b4bf941fda28`, `src/client/terminal_sessions.rs:17–275` and `src/cli.rs:44–47`, provides these CLI streams:

```text
herdr terminal session observe <target> [--cols N] [--rows N]
herdr terminal session control <target> [--takeover] [--cols N] [--rows N]
```

They connect to the existing binary endpoint without starting a daemon. Use a known executable, argument arrays and a server-resolved instance/target. Verify the installed CLI's instance-selection syntax before spawning it.

Each stdout line is JSON. A frame has `{ type: "terminal.frame", seq, encoding: "ansi", width, height, full, bytes }`, where `bytes` is base64. These are Herdr-generated ANSI screen updates, not original PTY output. Feed decoded bytes to xterm in order. Incremental frames depend on previous frames; queue overflow must disconnect and obtain a new baseline, not drop arbitrary updates. EOF or `terminal.closed` ends the stream.

Control stdin accepts `terminal.input` with either text or base64 bytes, `terminal.resize`, `terminal.scroll`, and `terminal.release`. These have no request IDs or per-input acknowledgements. Closing stdin detaches. They are CLI stream messages, not RPC methods on `herdr.sock`.

Observation leaves PTY size unchanged. **Control immediately changes the shared PTY size**, claims its direct-attach resize lock, and can start a pending agent resume. Only one direct controller is allowed; `--takeover` disconnects the prior controller. Never use it as an automatic fallback. Detach releases control without stopping the process. Other Herdr clients can still send input. The source for these effects is `src/server/headless.rs:1078–1090,1365–1396,1798–1900,2230–2266`.

The proposed first prototype is CLI JSON lines, an owner-authenticated WebSocket, and xterm.js. Its scroll gestures must call `terminal.scroll`; xterm's local scrollback is not authoritative because the stream repaints a screen. Preserve complete bracketed-paste envelopes. On mobile, keep the grid unwrapped, handle IME as committed text, and make any shared-PTY resize explicit.

The CLI wrapper omits mouse-capture and keyboard-protocol notifications, clipboard/title notifications, standalone graphics and host-theme reporting. An interactive shell or text TUI is plausible, but mouse-aware apps, graphics, advanced keys and clipboard fidelity require separate testing. This is not full GPUI parity. None of these CLI paths has been exercised against the installed daemon.

Full GPUI parity would use the generation-1 endpoint protocol on `herdr-client.sock`, a little-endian u32 length followed by bincode 2. It negotiates `endpoint.hello.v1`, snapshot/surface codecs and semantic input. It supports keys, text commits, paste and structured mouse events. Its snapshots and patches require matching boot, projection and base-surface revisions. Reusing the Rust client/protocol avoids maintaining another decoder. Keep the JSON `herdr.sock` connection for existing discovery; do not confuse these endpoints.

The installed `herdr api schema --json` advertised protocol 22. Its command schema includes pane input, resize/scroll, splits, and workspace/tab management. `pane.resize` changes split geometry, not terminal columns/rows. Viewing must not focus a desktop pane; focus is a separate action. Preserve snapshot workspace/tab array order, since tab numbers do not track reordering. The schema was read without sending terminal input. Temporary evidence is `/tmp/pi-private-herdr-schema.json`.

## Prompt protocol and a blocking safety finding

Installed protocol-22 `AgentPromptParams` requires `{ target: string, text: string }`. Optional `wait` is a lifecycle-wait object or null, not a boolean. The private prototype was corrected to omit `wait`, with a failing/passing regression recorded in `/tmp/pi-private-prompt-protocol-red.log` and subsequent focused results.

The read-only scout additionally verified Herdr 0.9.1 source at `856b64b9bfd41b9d3d82e2375ed5b4bf941fda28`:

- `src/app/api/agents.rs:111–215`
- `src/app/agents.rs:426–445`
- `src/pty/actor/unix.rs:74–81,580–591,637–669,860–897`

That implementation checks the current agent kind before queuing a submission. Its PTY actor queues text, waits 300 ms after writing the text, writes Enter, then acknowledges. The queued operation carries no expected PID/session or cancellation token and does not revalidate the process before Enter. The successful response is `{ type: "agent_prompted", agent }`; that agent description was captured before submission, not after Pi accepted the prompt.

A seven-second client timeout does not cancel queued input. Lifecycle `wait.timeout_ms` does not impose a Unix PTY submission deadline. Closing the RPC socket cannot prove that a delayed Enter will not subsequently reach the shell or a replacement process.

The first prototype shared a pane lock with import and quarantined a pane on unknown delivery. The following finding describes that superseded prototype. **Its quarantine is only in memory. Restarting Pocket clears it, so the current instruction to check Herdr and restart the app is not proof of cancellation and is not an adequate recovery protocol. This must be addressed before enabling/releasing private input plus automatic takeover.** A fresh process snapshot alone cannot settle an unknown queued submission.

The current implementation commits an opaque durable admission receipt before sending Chat input and settles it only on a matching `agent_prompted` response. Unknown Chat delivery blocks future Chat and takeover across restart. Terminal input has a separate durable takeover restriction; it does not permanently disable Chat. Connection leases block automatic takeover, while short operation reservations coordinate active Chat submissions with native writes. See `src/server/private-sessions/control.ts` and `test/private-control.test.ts`.

A future protocol could retain the transport/operation for a late acknowledgement and keep prompts and import blocked while unresolved. Crash/restart handling needs durable admission/uncertainty records or an equivalent protocol-level fence, containing no private transcript. Do not clear that fence just because Pocket restarted. Prefer native endpoint input fencing where available, and distinguish explicit raw-terminal control from guarded Chat submission.

Also verify multiline behavior when bracketed paste is disabled. The first prototype accepted multiline text and Pi command prefixes. Guarded Chat now rejects both before discovery, with an explanation to use Terminal. Do not advertise it as a process-safe plain-prompt channel: `/` and `!` invoke Pi commands, and raw multiline fallback needs a deliberate policy. Full terminal mode intentionally permits shell input, but must not inherit claims that it is confined to a previously identified Pi.

These timing findings are source-verified for 0.9.1, not live-tested against the installed daemon. No real Pi session, shell or pane was sent input or stopped during this research.

## Next proof

Build an isolated transport/rendering prototype with generated/disposable sessions. Verify interactive shell and full-screen TUI behavior, mobile keyboard/IME and control keys, paste, scrollback, cursor/colors, resize/control ownership, reconnect, and stale-pane fencing. Then attach that terminal view to the existing Private hierarchy and consolidate the Chat presentation with Pocket's public-session components. No production restart, commit or publication has been requested.
