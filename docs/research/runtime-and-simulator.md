# Runtime, session adoption, and iOS research

Research date: 2026-10-09. This is source and documentation research, not an integration test. No personal Pi sessions, Herdr daemons, or simulators were inspected or controlled.

Scope update: iOS is deferred to the last delivery step. The live-attachment proposal below is historical and has been superseded by stop-and-resume takeover. See [takeover and reuse findings](reuse-and-takeover.md) for the verified simpler path and the [current plan](../mvp-proposal.md). This note records the original research, not current implementation commitments.

## Summary

The proposed application has two separate jobs: make existing Pi work accessible to people, and manage new work independently of its clients. Neither a terminal multiplexer nor a native UI should own the application's session identity or access policy.

Three findings constrain the design:

1. `@earendil-works/pi-durable` already exists. It is an experimental execution library, not the proposed desktop/web product. Its tools, extensions, and storage contracts differ from the coding-agent contracts.
2. Pi RPC is a subprocess interface selected at startup. It is not a documented network attachment endpoint for an arbitrary running Pi TUI. A cooperative extension is the promising route to live adoption.
3. iOS support means a Simulator running on a Mac with Xcode. Other devices can control its display remotely. It does not mean running an iOS emulator inside a browser or on a Linux worker.

## Pi offers two different runtime foundations

### Standard Pi coding agent

The installed `@earendil-works/pi-coding-agent` is version 1.1.0. Its SDK embeds an `AgentSession` in Node or Bun. RPC runs a long-lived child process with JSONL commands on stdin and events on stdout. Both expose prompting, steering, follow-ups, abort, and session operations. RPC also forwards supported extension dialogs. Custom TUI components do not become web or GPUI components automatically. [P1][P2][P3]

An accepted prompt is not a completed run. This version distinguishes `agent_end`, which can precede further automatic work, from `agent_settled`, which means Pi will not continue automatically. Consumers need the latter for reliable completion displays. Command IDs correlate responses, but the RPC documentation does not promise persistent idempotency for repeated prompts. [P1][P2]

Persisted Pi sessions are JSONL entry trees with branches, compaction, custom state, and an active leaf. Opening a saved file restores conversation state; that alone does not transfer ownership of its running process, shell children, extension resources, or uncommitted tool effects. The documented session APIs do not establish a safe concurrent-writer protocol for two independently running agents on the same file. Our application must prevent that situation. [P1][P4]

**Implication:** Standard Pi is the lower-risk MVP foundation when adoption and existing extension compatibility matter most. Use TypeScript to supervise isolated RPC children for new sessions. Keep Pi's own session files authoritative for their transcripts. Store membership, sharing, request attribution, and app metadata separately.

This gives durable history and client-independent execution. It does not give transparent continuation of every interrupted tool after a runtime crash. Show interruption explicitly and require a deliberate resume when side effects are uncertain.

### Existing Pi Durable library

The upstream Pi Durable README describes committed conversations, tasks, documents, and progress. It supports persistent SQLite or JSONL storage, recovery of pending work, request-ID deduplication, and snapshot-based watches with bounded slow-consumer handling. It declares its API experimental. [D1]

Important limits:

- One process owns a storage backend at a time. The library does not supply cross-process locking.
- A tool interrupted mid-execution reruns only when declared `replay: "safe"`; otherwise it produces an interrupted result. Durable does not mean arbitrary shell effects are exactly once.
- SQLite uses WAL with `synchronous = NORMAL`. The README distinguishes process-crash recovery from possible loss of recent commits on power or host failure.
- Extensions are installed into its registry using its own `defineExtension`, tool, hook, and task contracts. Standard Pi coding-agent extensions use a different `ExtensionAPI`. Do not assume drop-in compatibility.
- The reviewed README says built-in file reading does not yet support images. Other application extensions may supply that capability. [D1][P5]

Pi Pocket pins its Pi packages to 1.0.2. This research also consulted installed coding-agent 1.1.0 documentation and upstream Durable main. These are not one tested dependency set. Pin and test a coherent set before copying implementation details. [D2]

**Recommendation:** Do not choose this library solely because its name matches the proposed project. If crash-resumable app-owned work matters more than ordinary Pi compatibility, it is a strong alternative. That choice creates two real runtime adapters once live external Pi sessions are added. Avoid adding both managed engines in the first release.

The upstream README is the basis for the capability claims here. The much larger design specification was not used as proof that a behavior currently works.

## What adopting a Herdr session should mean

Keep these operations separate in both implementation and UI:

| Operation   | Meaning                                                                | Ownership                                               |
| ----------- | ---------------------------------------------------------------------- | ------------------------------------------------------- |
| Discover    | Find a pane that appears to contain Pi                                 | Herdr and the original Pi process retain ownership      |
| Observe     | Show a validated transcript and status                                 | Read-only, no execution control                         |
| Attach live | Connect a cooperative Pi extension to the app runtime                  | The existing Pi process remains the sole session writer |
| Transfer    | Stop the old writer at a safe point, then resume under app supervision | Ownership changes explicitly                            |
| Fork/import | Create a separate continuation from history                            | A new session, not live adoption                        |

Herdr session metadata needs validation. Collie's research records that Pi may report an absolute session-file path, metadata may be missing before integration installation, and a pane can retain the last session reference after its occupant changes. Match the reported agent kind and verify a live bridge handshake rather than trusting a pane ID or file path alone. [H1]

Pi extensions can subscribe to session and tool events and send user messages. The official examples demonstrate externally triggered messages and explicit steering/follow-up delivery. The extension documentation says to start sockets and watchers in `session_start`, not the extension factory, and clean them up on shutdown. These are the building blocks for a bridge, not evidence of an already-complete remote attachment feature. [P5][P6]

A proposed bridge would:

- Register the real Pi session identity, selected branch, working directory, process instance, and Herdr context when available.
- Use a private local transport with a challenge-response handshake and restrictive OS permissions.
- Advertise supported controls and UI limitations.
- Publish a snapshot and ordered updates. A reconnect replaces uncertain projections rather than guessing missing state.
- Receive prompts, steering, follow-ups, and abort through Pi's extension controls.
- Bind every command to the current session and process generation, rejecting commands from stale attachments.
- Make app-level request IDs and actor attribution visible without having another process write the Pi transcript.

An existing TUI will need the extension loaded. An owner-triggered reload at an idle point may avoid restarting Pi, but the exact supported-version behavior needs a spike. Do not reload a busy session automatically. If the bridge is absent, show observer-only status and an explicit setup action.

A remote control lease cannot fence arbitrary local keyboard input by itself. The bridge must cooperate with Pi's input path, or local input must explicitly revoke remote control. Terminal-specific dialogs can stay local in the first release and appear remotely as "needs local attention." Do not promise generic forwarding of every third-party TUI extension.

## iOS Simulator feasibility

Apple documents command-line simulator startup and device management, and screenshot/video capture through its device UI. Those capabilities alone do not establish a complete low-latency remote display and input protocol. [I1][I2]

Meta's idb supplies a stronger implementation reference:

- Its companion runs on macOS; the client can run elsewhere.
- `FBSimulatorControl` manages simulators without requiring Simulator.app to be open.
- The implementation uses private Apple frameworks. The project's CLI and gRPC contracts are its more stable integration interfaces; direct framework consumers should expect more churn.
- Its protobuf includes `video_stream`, `screenshot`, and streamed HID input. Available video formats include H.264 and MJPEG.
- The video library exposes hardware-assisted encoding and framebuffer access. The README also documents framebuffer ownership considerations when Apple's host UI is displaying the same simulator. [I3][I4][I5][I6]

The reviewed idb main requires macOS 15+ and Xcode 26.0+ to build from source. These are the requirements of that revision, not a promise that every historical release has the same floor. Pin a tested release or commit and a specific Xcode/runtime pair. [I3]

### Proposed first adapter

Use official CLI operations where adequate for device discovery, boot, app installation, launch, and screenshots. Use an idb companion for interactive display/input if the spike succeeds. Keep the companion on loopback or a private socket behind the application's authorization, not exposed directly to guests.

Start with a bounded encoded-frame stream and discrete tap, swipe, text, and Home actions. MJPEG can make the first prototype simpler than a full WebRTC stack, but bandwidth and motion quality need measurement. If it cannot meet the acceptance test on an actual iPhone, select H.264/WebRTC before committing to the transport. An H.264 byte stream by itself is not a browser video player.

Use an explicit simulator UDID and runtime identity. Avoid implicit `booted` targeting when multiple devices exist. Authorize target access separately from session chat, serialize human and agent input, and fence input after rotation, resize, disconnect, or controller changes. A dedicated simulator device set avoids accidentally taking over the owner's everyday simulator.

"Headless" means the app does not need an open desktop client. It does not remove the Mac/Xcode requirement or prove reliable operation in every launchd, login, sleep, and display configuration. Test those conditions.

### Required spike

Prove this with one clean sample app and a disposable simulator:

1. Boot, install, and launch using an explicit target.
2. Stream to Safari on a physical iPhone and a desktop browser.
3. Tap, scroll, enter text, rotate, and press Home.
4. Give two viewers the same display; only the controller can send input.
5. Disconnect the controller and reject stale input after handoff.
6. Close the desktop app and confirm the worker remains available.
7. Measure latency, frame rate, bandwidth, idle CPU, and recovery behavior. Record numbers rather than assuming GPUI improves a remote stream.

Physical iPhones, Android, arbitrary device farms, and App Store distribution of the worker are outside this first adapter.

## Sources

### Pi coding agent

Local documentation is installed under `/Users/enkelm/.pi/agent/install/releases/1.1.0/node_modules/@earendil-works/pi-coding-agent/`.

- [P1] [SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md), reviewed local `docs/sdk.md` and `examples/sdk/11-sessions.ts`.
- [P2] [RPC protocol](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md), reviewed local `docs/rpc.md` and `docs/cli-integration.md`.
- [P3] [RPC extension UI](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-extension-ui.md), reviewed local `docs/rpc-extension-ui.md`.
- [P4] [Session format](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md), reviewed local `docs/session-format.md`.
- [P5] [Extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md), reviewed local `docs/extensions.md` and `docs/tui.md`.
- [P6] Official local examples `examples/extensions/file-trigger.ts`, `examples/extensions/send-user-message.ts`. The trigger example is illustrative, not a security-ready network bridge.

### Pi Durable and Pocket

- [D1] [Pi Durable README](https://github.com/earendil-works/pi/blob/f1b2e77f5b13b2a199b1052cb79c235451afe7d7/packages/durable/README.md). Upstream main resolved to this commit during research. MIT licensed.
- [D2] Pi Pocket [`package.json`](https://github.com/TannerMidd/pi-pocket/blob/d01f763b02f06ff6144d4366eb966a76dbb35577/package.json) and [`docs/architecture.md`](https://github.com/TannerMidd/pi-pocket/blob/d01f763b02f06ff6144d4366eb966a76dbb35577/docs/architecture.md).

### Herdr adoption

- [H1] Collie [`HERDR_API.md`, lines 303-317](https://github.com/AltanS/collie/blob/cfaf95a93df3c9404a03f5f840bf222f0cd6c2ee/HERDR_API.md#L303-L317). This is Collie's recorded integration evidence, not a fresh live test in this investigation.

### iOS

- [I1] Apple, [Interacting with devices using the command line](https://developer.apple.com/documentation/xcode/interacting-with-devices-using-the-command-line). Retrieved through Apple's documentation JSON at `https://developer.apple.com/tutorials/data/documentation/xcode/interacting-with-devices-using-the-command-line.json`.
- [I2] Apple, [Capturing screenshots and videos from devices](https://developer.apple.com/documentation/xcode/capturing-screenshots-and-videos-from-devices). Retrieved through the corresponding Apple documentation JSON.
- [I3] idb [README](https://github.com/facebook/idb/blob/97d90f8871158338a51f4a90cfe20da1342f9471/README.md). Upstream main resolved to this commit during research. MIT licensed.
- [I4] [FBSimulatorControl README](https://github.com/facebook/idb/blob/97d90f8871158338a51f4a90cfe20da1342f9471/FBSimulatorControl/README.md).
- [I5] [idb protobuf contract](https://github.com/facebook/idb/blob/97d90f8871158338a51f4a90cfe20da1342f9471/proto/idb.proto).
- [I6] [FBSimulatorVideo README](https://github.com/facebook/idb/blob/97d90f8871158338a51f4a90cfe20da1342f9471/FBSimulatorVideo/README.md).
