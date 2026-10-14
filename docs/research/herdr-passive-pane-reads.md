# Passive pane polling and alternate-screen history

## Finding (2026-10-14)

Pi Coop's background pane-detail request asked Herdr for `pane.read` with
`source: "recent_unwrapped"`, `lines: 200`, and `format: "text"`.
That is not necessarily an observational read: Herdr can collect an idle
alternate-screen agent's application-owned history by sending mouse-wheel events
into its PTY, then attempting to restore the original view.

This explains a path that the browser's structured-terminal diagnostics do not
observe. The HTTP detail poll invokes a separate server-side JSON RPC. Its
resulting application scroll is not a browser WebSocket input event, and the
terminal's ordinary scrollback offset can remain zero in alternate-screen mode.

## Evidence

- [`web/private.js`](../../web/private.js), `PrivatePaneView`: subscribes to the
  pane-detail resource with a 2-second refresh interval before choosing Chat or
  Terminal presentation. Terminal mode does not stop that resource.
- [`src/server/http/api.ts`](../../src/server/http/api.ts): the private pane GET
  invokes `app.privateSessions.pane`.
- [`src/server/private-sessions.ts`](../../src/server/private-sessions.ts): that
  method reads the saved Pi journal and requests the live terminal snapshot.
  Before this repair its snapshot source was `recent_unwrapped`.
- The installed Homebrew Herdr formula identifies version 0.9.3 and points to
  `herdrdev/herdr` tag `v0.9.3`. The running daemon's version was **not** queried;
  no live Herdr command was run for this investigation.

Primary upstream sources inspected at that tag:

1. [API common types](https://github.com/herdrdev/herdr/blob/v0.9.3/src/api/schema/common.rs):
   `ReadSource` distinguishes `visible`, `recent`, `recent_unwrapped`, and
   `detection`. Internal `ReadIntent` defaults to `Interactive`.
2. [Pane-read parameters](https://github.com/herdrdev/herdr/blob/v0.9.3/src/api/schema/panes.rs):
   `PaneReadParams.intent` is an internal field skipped by Serde, not an external
   JSON option that a web client can use to request passive history traversal.
3. [Headless API processing](https://github.com/herdrdev/herdr/blob/v0.9.3/src/server/headless.rs),
   `alt_screen_read_spec`: recent text reads can start a history traversal when
   the target is a recognized idle agent, mouse reporting routes wheel events,
   the active screen is alternate, and the requested line count exceeds the
   visible rows. `Visible` does not enter this path.
4. [Alternate-screen history reader](https://github.com/herdrdev/herdr/blob/v0.9.3/src/server/alt_screen_read.rs):
   `PendingAltScreenRead` probes the bottom, harvests upward, and restores using
   wheel events. `start_harvest` sends `ScrollUp`; `send_wheel` encodes the events
   and calls `runtime.try_send_bytes`. Traversal and restoration have separate
   15-second and 5-second limits; ending a browser request is not a PTY-cancel
   acknowledgement.

These are source-level findings, not a live execution of Herdr's history reader.
The user's content-free trace showed alternate-screen mouse-reporting panes,
zero browser scroll input and zero native scrollback offset, consistent with
this mechanism. Live confirmation after the server repair remains necessary.

## Repair and regression

Automatic pane snapshots now request `source: "visible"`, with the same 200-line
and 64 KiB bounds. Saved conversation history still comes from the Pi journal.
This preserves intentional viewport/scrollback position instead of driving an
application to obtain extra history. There is no fallback to interactive recent
history, and no invented wire `intent` parameter.

`test/private-sessions.test.ts` owns the protocol regression: repeated real
`PrivateSessions.pane` calls in idle, working and blocked states must request only
visible snapshots and still return the sanitized terminal view. It failed before
the repair on three `recent_unwrapped` requests and passed after changing the
production source. No personal pane, socket or process was used by the test.

The change is server-side and requires an owner-coordinated Pi Coop restart.
It does not require restarting Herdr or its agents. Any history traversal already
started by an old request may still be finishing; do not send cancellation keys
or force scroll-to-bottom as a cleanup substitute.
