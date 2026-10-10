# Reference codebases

Research date: 2026-10-09. Source inspection only. No packages were installed, applications or tests launched, personal sessions read, or daemons contacted. The reference repositories were left unchanged.

## Revision anchors

| Repository                                           | Inspected commit                           | License    |
| ---------------------------------------------------- | ------------------------------------------ | ---------- |
| [Pi Pocket](https://github.com/TannerMidd/pi-pocket) | `d01f763b02f06ff6144d4366eb966a76dbb35577` | MIT        |
| [Collie](https://github.com/AltanS/collie)           | `cfaf95a93df3c9404a03f5f840bf222f0cd6c2ee` | MIT        |
| [Herdr GPUI](https://github.com/penso/herdr-gpui)    | `e370bf0a55b1bf3e7e7fcb5b3f130ebc1a9e68bf` | Apache-2.0 |

Paths below are relative to `/Users/enkelm/Projects/oss` and refer to these commits. Repository instructions were read before inspection. Runtime-library and iOS findings are in [the companion research note](runtime-and-simulator.md).

## Comparison

| Reference  | Existing implementation                                                                                        | Useful parts                                                           | Gaps in the inspected implementation                                                                                       |
| ---------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Pi Pocket  | SQLite-backed Pi Durable integration, mobile web, scoped invites, roles, driver handoff, shared server browser | Conversation commands, recovery ordering, collaboration and mobile UX  | Private sessions hidden from otherwise unscoped users, saved multi-server connections, adoption of another live Pi process |
| Collie     | Mobile PWA, Herdr session discovery, Pi journal reading, terminal input, multi-machine crew                    | Session identity validation, bounded journal reading, mux capabilities | Structured Pi prompt/steer/abort attachment rather than terminal typing                                                    |
| Herdr GPUI | Native terminal-cell client, separate protocol/client/UI crates, local and remote targets, native browser tabs | GPUI client architecture, webview integration and input handling       | Shared server-owned browser tabs, the proposed session authorization model, simulator integration                          |

Gap claims are limited to the cited modules and documentation, not every possible extension or branch of these projects.

## Pi Pocket

### Runtime and recovery

`PocketApp` opens `pocket.sqlite` with `openNodeSqliteStorage`, passes storage/models/registry/settings to `Harness.open`, reconstructs its in-memory state, subscribes to commits and approvals, and calls `harness.resume()` last. There is one harness, not a separate database/process for each browser tab.

Evidence: `pi-pocket/src/server/app.ts:293-358`; `pi-pocket/docs/architecture.md:35-67`.

Commands call the conversation directly rather than typing into a terminal:

```ts
await conversation.submit(
    {
        type: "input",
        content,
        whenBusy: request.mode === "steer" ? "steer" : "followUp",
        requestId,
    },
    context,
);
```

The command handler checks visibility, driver rights, model, and spending limits. Its request ID carries the user identity and client key, supporting attribution and retry deduplication.

Evidence: `pi-pocket/src/server/commands.ts:374-457`; `pi-pocket/docs/map.md:147-152`.

Conversations, entries, tasks, and app documents live in SQLite. Users/settings, subscriptions, uploads, and worktrees live beside it. Presence, typing, pending approval waits, live browser pages, and provider login attempts are process-local. Restart recovery does not mean every object or side effect survives.

Evidence: `pi-pocket/docs/architecture.md:5-18`; `pi-pocket/AGENTS.md:7`.

### Privacy and collaboration

The visibility rule is the important difference from the proposed app:

```ts
return user.sessions === undefined || user.sessions.includes(String(this.rootOf(id)));
```

A scoped invitee sees the selected root session and its subagents. An unscoped user sees all sessions. Viewers cannot steer, and optional turns restrict commands to the current driver. `SessionMeta` does not define a per-session visibility field. This supports restricted guests, but not private-by-default sessions hidden from other globally admitted users.

Evidence: `pi-pocket/src/server/app.ts:964-1001`; `pi-pocket/src/server/docs.ts:18-38,129-159`.

Authentication supports an HttpOnly, SameSite=Lax cookie, marked Secure over detected HTTPS, or a bearer token. Invites are hashed, expiring, and single-use. Owner invitations reuse the owner identity/token. The config stores token hashes and a plaintext owner token in a privately written file.

Evidence: `pi-pocket/src/server/auth.ts:58-105,112-175`; `pi-pocket/src/server/config.ts:18-35,54-59,71-100`.

The security documentation is explicit that steering gives access equivalent to the server user's shell privileges. Session visibility is not filesystem or network isolation. This is a product constraint to retain, not a detail that stronger invite tokens solve.

Evidence: `pi-pocket/SECURITY.md:7-21`.

### Browser and deployment

Pocket runs headless Chromium on the server and creates a separate browser context for each conversation. People and Pi share that page. This is a useful model for remote development previews, including pages reachable only from the worker.

Evidence: `pi-pocket/src/server/browser.ts:1-8,266-312`; `pi-pocket/docs/map.md:84-96`.

The browser client uses relative API, SSE, and polling URLs. The launcher supports local, LAN, tunnel, and tailnet access and non-terminal operation. This establishes a remotely accessible single-server app, not an independently deployable worker fleet or saved URL/key catalog.

Evidence: `pi-pocket/web/store.js:269,485,579-592`; `pi-pocket/README.md:57-101`.

Version 0.11.0 requires Node >=22.19 and pins the Pi packages, including `@earendil-works/pi-durable`, to 1.0.2. The frontend uses Preact/htm without a build step. Do not assume those contracts match installed Pi 1.1.0 without testing.

Evidence: `pi-pocket/package.json:1-45`; `pi-pocket/package-lock.json:511-524`.

## Collie

### Discovery and transcript attachment

Collie discovers Herdr's default socket and named `sessions/<name>/herdr.sock` sockets from a trusted configuration root. Client session names select discovered endpoints rather than becoming arbitrary filesystem paths. Its adapter declares capabilities for snapshots, agent detection, session references, terminal input, and layout operations.

Evidence: `collie/bridge/mux/herdr/sessions.ts:1-103`; `collie/bridge/mux/herdr/adapter.ts:80-121`.

Herdr's `agent_session` metadata becomes a validated ID-or-path reference. The Pi journal reader accepts session paths only within configured roots after realpath resolution; UUID fallback scans filenames. These are useful protections to retain when adopting external sessions.

Evidence: `collie/bridge/mux/herdr/client.ts:95-137,193-210`; `collie/bridge/journal/pi.ts:1-20,618-704`.

Herdr metadata may be absent before integration installation or stale after a pane changes occupants. Collie's recorded probes explicitly warn about this. A new app should confirm identity with the running Pi bridge, not trust pane metadata alone.

Evidence: `collie/HERDR_API.md:303-317`. These are historical probes by Collie's authors, not fresh tests in this research.

### Control is terminal input

The inspected Herdr implementation calls `pane.send_text` and `pane.send_keys`. It types text into a terminal rather than invoking Pi's structured conversation controls. Even the documented `agent.send` is literal text without Enter. No structured Pi takeover path was found in the inspected driver, journal, or harness registry.

Evidence: `collie/bridge/mux/herdr/client.ts:674-681`; `collie/HERDR_API.md:29-40`; `collie/web/src/lib/harness/registry.ts:17-49`.

Collie is therefore a useful discovery and viewing reference, not an existing implementation of live Pi RPC attachment. Importing its transcript reader does not transfer ownership of the running agent.

### Remote machines

Collie's crew design connects peers through Collie APIs, using pinned mutual TLS and a crew secret. Its local front door uses paired device credentials, including for reads. The bridge runs independently rather than inside a plugin pane.

Evidence: `collie/ARCHITECTURE.md:61-135`; `collie/CLAUDE.md:675-744`.

This is relevant to later multi-machine work. It does not establish private multi-user sessions, and it is more machinery than an initial URL/key connection catalog needs.

Version 1.18.1 uses a Bun bridge and React/Vite frontend. Its CLI checks Bun >=1.3.14. Herdr compatibility spans several API generations, so the new adapter should use version/capability checks rather than assume one schema.

Evidence: `collie/package.json:1-43`; `collie/web/package.json:1-50`; `collie/cli/update-check.ts:185,398-399`; `collie/bridge/mux/herdr/client.ts:35-57`.

## Herdr GPUI

### Client ownership and layering

The dependency direction is GPUI to client to protocol. The client crate does not depend on GPUI, a PTY, or Tokio. It separates queued commands from server acknowledgements and uses endpoint operations for navigation rather than synthesized keys.

This is structured Herdr control, not structured Pi control. It connects to Herdr's binary client endpoint, whereas Collie uses the JSON API.

Evidence: `herdr-gpui/crates/herdr-client/README.md:1-96`; `herdr-gpui/crates/herdr-client/src/discovery.rs:66-96`.

The daemon owns terminals independently of the GUI. There is a documentation conflict about starting it: `AGENTS.md` says the normal app never starts a personal daemon, while current code and the README allow startup for selected local/session targets. Do not copy the stronger claim into the new design.

Evidence: `herdr-gpui/AGENTS.md:87`; `herdr-gpui/crates/herdr-gpui/src/daemon.rs:23-55`; `herdr-gpui/README.md:200-204`.

### Browser implementation

Browser tabs belong to the GUI, not Herdr. Each window has its own page instances. Native child webviews sit above the GPUI rendering area, requiring explicit handling of overlapping menus and dialogs.

macOS uses WebKit; Windows uses WebView2. Linux opens the system browser and lacks embedded-page/local-file/annotation support. Windows native behavior is still described as experimental and unexercised. GPUI support does not imply identical browser behavior on every platform.

Evidence: `herdr-gpui/crates/herdr-gpui/README.md:1685-1747`; `herdr-gpui/crates/herdr-gpui/src/browser.rs:1-51`; `herdr-gpui/README.md:209-226`.

The native manager uses bounded channels, constrains navigation/download behavior, and treats page-originated annotation messages as untrusted. Those policies matter when adapting the browser integration.

Evidence: `herdr-gpui/crates/herdr-gpui/src/browser/native.rs:19-51,86-160`.

The project pins Rust 1.96.1, GPUI snapshot 0.3.6, `gpui-wry` 0.6.6, and `lb-wry` 0.53.3. Preserve Apache-2.0 notices and vendored Herdr protocol attribution if copying code. Protocol field and enum order are compatibility contracts. Branding and assets need separate review.

Evidence: `herdr-gpui/Cargo.toml:5-13,43-48`; `herdr-gpui/README.md:177-181`; `herdr-gpui/NOTICE`; `herdr-gpui/crates/herdr-protocol/NOTICE.md:1-37`.

## Consequences for the new app

1. Reuse specific modules and policies, not a merger of all three repositories. They have different owners of state, control mechanisms, runtimes, and UI models.
2. Define session membership explicitly and check it on every data and command path. Decide whether privacy means application access or hostile execution isolation.
3. Treat Herdr discovery, transcript observation, live Pi attachment, and execution transfer as different operations.
4. Give mobile and native clients one versioned session-control protocol. Keep the runtime alive independently of either client.
5. Distinguish shared worker-owned browsers from personal native webviews. Simulator support is another worker target, not an automatic benefit of embedding GPUI.

Still unverified: Pi-version interoperability, live attachment, dependency-internal replay correctness, complete authorization coverage, native performance, iOS integration, and compatibility with the installed Herdr daemon.
