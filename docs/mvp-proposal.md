# Product direction and proposed MVP

Status: the importer and owner-only private Herdr mirror are implemented as a Pocket fork. The user explicitly revised the earlier Durable-only direction: private sessions stay running in Herdr until imported and shared. Pi Durable owns all managed execution. See [private sessions](private-sessions.md) and [import validation](import-implementation.md). Finer-grained membership and connection management remain next.

## The product

One place for private and shared Pi sessions, accessible from a mobile-first web app and eventually a desktop client. A daemon owns execution, so closing a client does not end the work.

Use Pi Durable as the runtime for new and adopted sessions. Build on Pocket as a coherent application base, retaining its Durable-backed state, multiplayer and mobile web client. Existing private sessions are an owner-only Herdr mirror, with Collie-like bridge behavior and Pocket's look. The app does not launch a second ordinary-Pi RPC writer alongside those processes.

This gives Durable a purpose beyond importing existing work. It persists admitted requests, agent state, task checkpoints and application documents, and provides committed views for connected clients. Recovery still depends on each tool's replay policy; arbitrary shell effects are not exactly-once operations.

Start with trusted collaborators. Sandboxing is later work. Desktop is also later, with GPUI an appealing but unselected candidate. iOS is last.

## Adoption means stop, import, continue

The original interactive Pi does not need to remain active. Adoption is a one-way history import, not process migration or synchronization between runtimes.

1. Select a running Pi from the local Herdr session list. Its current work must be settled.
2. Preview the last saved branch, compatibility warnings and destination model.
3. Choose Move to Durable. The server rechecks and stops only the selected Pi, leaving its Herdr pane and shell alone.
4. Preserve the original as an archive and import supported history into a new Durable conversation.
5. Continue through the app's clients using Pocket's configured tools and extensions.

The user requested automatic discovery and shutdown after trying the initial file-based UI. That flow is now implemented for local Herdr sessions on macOS and Linux. The owner can still stop Pi and select a file/branch manually as a fallback. Private browsing now uses a bounded, on-demand Herdr bridge. Adoption remains an explicit stop/import operation rather than live process migration.

```text
Before: Herdr pane -> ordinary Pi -> saved Pi session

Adoption: original Pi exits -> archive + one-way import

After:  web clients -> daemon / Pocket / Pi Durable -> Durable storage
        future desktop --^
```

Several people can view a conversation and submit requests without becoming separate storage writers. The daemon authorizes and orders those requests. One daemon process owns a Durable storage; prevent duplicate managed owners. The upstream library does not provide cross-process storage locking.

New work is not written back to the original Pi file. Reopening that file later resumes the archived state, not work subsequently done in Durable. A future terminal client would connect to the daemon instead of opening its database independently.

## What import carries over

Support one selected branch's messages, completed tool calls/results, summaries, compaction boundaries and supported context edits. Keep the complete source archive, source IDs and import provenance. Retain unknown extension records as data, without pretending their runtime behavior migrated.

Preserve cwd and title where valid. Validate the destination model and thinking level. Use the destination's current instructions, tools and extensions rather than blindly activating the old system/tool configuration.

Do not promise migration of live tools, unsaved drafts, pending dialogs, arbitrary extension memory or a complete branch tree. Ordinary Pi extensions are not drop-in Durable extensions. Start with settled sessions and reject unsupported or ambiguous histories rather than guessing at lost side effects.

An isolated probe converted four generated fixtures from Pi 1.1.0 to Durable 1.0.2. It verified selected-branch context, compaction and edits, stored tool/image history, zero execution or new spend from import, continuation after reopen, and prompt deduplication. This is feasibility evidence, not a production converter or a Pocket integration test. See [Durable import findings](research/durable-import.md).

## Reuse first

The user explicitly authorizes copying and adapting useful code from the reference repositories. Preserve licenses, attribution and relevant tests.

| Source     | Reuse                                                                                                                | Avoid copying unnecessarily                                                            |
| ---------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Pi Pocket  | Application base, Durable runtime integration, mobile web, authentication/invites, rooms, commands and collaboration | Its assumption that every unscoped user can see every session                          |
| Collie     | Herdr discovery/session-reference validation when adding automatic discovery                                         | Its whole terminal-control bridge, mux projection and continuous observation machinery |
| Herdr GPUI | Evaluate native client and webview code when desktop is in scope                                                     | Committing to its framework or building desktop now                                    |

Keep Pocket's conversation creation and default documents. Add the importer beside its existing create-session path. Historical entries must be appended as history, never resubmitted as fresh prompts. Imported authorship, note rendering and usage accounting need explicit integration. The converter must not turn historical costs into new collaborator spending.

Pocket has no ordinary-Pi importer in the inspected revision, so conversion is new work. It is nevertheless a smaller and more coherent boundary than replacing Pocket's Durable-dependent rooms, commands and collaboration to accommodate another runtime.

The earlier [native Pi RPC resume check](research/reuse-and-takeover.md) remains valid evidence about ordinary Pi. It is no longer the proposed product execution path.

## Proposed core MVP

- One headless daemon and a mobile-first web client based on Pocket.
- New Durable sessions and bounded import of stopped ordinary Pi sessions.
- Owner-only Private tab mirroring all local Herdr instances, workspaces, tabs and panes.
- Explicit import-and-share under Pocket's existing authenticated/scoped access rules, with the source archive staying owner-only. Finer-grained invitations and membership follow.
- A single server-side command path with an explicit policy for input while busy.
- A connection screen for adding and switching servers using scoped credentials.
- Reconnect without duplicating accepted prompts or losing saved history.
- Durable reopen/resume using its existing task and tool-replay policies.

Reuse Pocket's collaboration behavior where it fits. Do not invent another command queue or state protocol before testing what is already there.

Private means access is restricted through the app. It does not promise isolation from the machine owner or a malicious collaborator with shell-capable agent access. That limitation remains until sandboxing is added. Imported source archives need the same access controls as their sessions.

Do not add a separate gateway deployment, worker scheduler, federation protocol, compatibility engine or general-purpose plugin architecture to the first implementation.

## First implementation slice

Implemented as an owner-only Pocket-based daemon with imported conversations:

1. Establish the Pocket-derived application base with licenses, pinned dependencies and existing tests.
2. Add an explicit stopped-session import with source archive, selected branch, validation and import provenance.
3. Verify history/context and send a new prompt through Durable.
4. Open two browser views of the same conversation and observe the resulting updates.
5. Disconnect/reconnect one browser, then restart the daemon and verify stored state and request deduplication.

Import deduplication is separate from prompt deduplication. Generated fixtures cover the supported format, compaction, context edits, malformed/unknown records, incomplete tools, author labeling, source preservation and accounting. SQLite rollback and real-browser reconnect checks are included. Compatibility remains deliberately bounded; do not broaden it silently.

The user subsequently requested a Collie-like owner-only bridge instead of forcing every private session through import. That separate Private tab now renders saved Pi history and terminal snapshots, with guarded prompts to idle Pi. Import-and-share is the explicit transition to Durable. Connection management, broader controls and finer-grained membership remain later work.

## Later

1. Discovery outside Herdr and broader source compatibility.
2. Shared daemon-owned browser and session-scoped screenshots/notes, reusing Pocket where practical.
3. Desktop evaluation, including whether GPUI is the right choice.
4. iOS Simulator, last.

Sandboxing remains separate work. Durable recovery is part of the core, but its presence must not be described as automatic rollback or safe replay of every external side effect.
