# Writing extensions

An extension gives Pi something new:

- a **tool** that Pi can call,
- a **section** of Pi's system prompt,
- a **hook** that checks or changes Pi's tool calls and answers,
- or a durable **task**.

A module can also add to the app itself: **routes** on the server, a **browser module** with rail buttons, pages, sheets, menu rows, launcher actions, inline session controls and draft-only input hints, and **commands** that people run from the message box without Pi ([Adding to the app](extensions/app.md)). Pi Pocket's own features are modules too (`src/server/extensions/`). The owner can add modules of their own, without a change to Pi Pocket's code.

Extensions come from Pi Durable. Its README tells about the parts in depth: `node_modules/@earendil-works/pi-durable/README.md` in Pi Pocket's folder (Extensions, Tools, System Prompt, Hooks, Your Own State). These pages tell what Pi Pocket adds, and how to write an extension that works well. The rules for extensions are in [the policies](extensions/policies/index.md).

## Where to read next

This page is the map. Read all of it, then only the pages that your task needs.

| To                                                             | Read                                                                                                            |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Make a first extension, step by step                           | [Your first extension](extensions/first-extension.md)                                                           |
| Know what the file must be, and how it loads and fails         | [Modules, loading, and errors](extensions/modules.md)                                                           |
| Give Pi a tool                                                 | [Tools](extensions/tools.md)                                                                                    |
| Add a rule to Pi's system prompt                               | [Prompt sections](extensions/prompt-sections.md)                                                                |
| Check or change Pi's tool calls and answers                    | [Hooks](extensions/hooks.md)                                                                                    |
| Use the app's current public services                          | [Using the host](extensions/host.md)                                                                            |
| Start sessions, and send messages between them                 | [Starting and messaging sessions](extensions/linked-sessions.md)                                                |
| Add to the app: routes, a browser module, commands             | [Adding to the app](extensions/app.md)                                                                          |
| Answer requests on the server, and say who may use them        | [Routes](extensions/routes.md)                                                                                  |
| Add rail buttons, pages, sheets, menu rows, launcher actions   | [Browser modules](extensions/browser-modules.md)                                                                |
| Run something from the message box, without Pi                 | [Slash commands](extensions/commands.md)                                                                        |
| Show your tool's calls in words                                | [How tool calls show](extensions/tool-calls.md)                                                                 |
| Send live updates to the browser                               | [Events](extensions/events.md)                                                                                  |
| Stop timers and close connections when a module loads again    | [Cleanups](extensions/cleanups.md)                                                                              |
| Test a module                                                  | [Testing](extensions/testing.md)                                                                                |
| Share a module, or install one that other people wrote         | [Publishing to the gallery](extensions/publishing.md)                                                           |
| Move a module into Pi Pocket itself                            | [Making it built in](extensions/built-in.md)                                                                    |
| Find a member of `host`, `web`, `pocket`, or a command's `ctx` | [The reference](extensions/reference/host.md), and the exact types in [types/pocket.d.ts](../types/pocket.d.ts) |
| Find a limit, or what a word means                             | [Limits](extensions/reference/limits.md), [Glossary](extensions/reference/glossary.md)                          |
| Know the rules: core or extension, the API, security, gallery  | [The policies](extensions/policies/index.md)                                                                    |

## Drop-in or built-in

**A drop-in** is a file in the drop-in folder, `~/.pi-durable-app/extensions/` (the `extensions/` folder in the data folder). Use a drop-in for all that one person or one machine wants.

- It stays when Pi Pocket updates.
- It starts off. The owner turns it on in Menu → Extensions.
- Drop-ins that other people wrote come from the gallery, and the owner can share their own there ([Publishing to the gallery](extensions/publishing.md)).

A drop-in runs inside the server, with the owner's rights. It can read `config.json`, with the owner's token, and each session. Lancet Guard never sees what its code does. Its browser module, if it has one, runs in the app's own page, with the rights of the person whose tab loads it. Before you ask the owner to turn on a drop-in, show the owner the whole module, its browser files too, and say what it does.

**A built-in** is a file in `src/server/extensions/`. It is a part of Pi Pocket for each person who uses this copy. Use a built-in only for a change to Pi Pocket itself, and read [self-editing.md](self-editing.md) first ([Making it built in](extensions/built-in.md)).

## A module

A module is one `.ts` file with a default export: a function. Pi Pocket calls it with the host ([Using the host](extensions/host.md)) and `web`, what the module adds to the app ([Adding to the app](extensions/app.md)). Then it installs what the function returns: one extension, a list of extensions, or nothing, for a module that only adds to the app.

- The function can be `async`. Pi Pocket loads the module when the promise settles, and the module can register with `web` until then.
- Pi Pocket installs all that the module returns, or none of it. When it refuses one extension, the version before stays as it was.
- Pi Pocket refuses an extension without a name, and two extensions with the same name.
- Pi Pocket refuses a module that returns nothing and adds nothing to the app (no route, browser module, command, or cleanup): it most likely did not return its extensions.

```typescript
/**
 * A clock tool: the date and time now, in any time zone. The first sentence of this comment is the module's
 * description in the Extensions sheet.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

export const durableToolApi = 2;

const clock = defineTool({
    name: "clock",
    description: "The date and time now, in a time zone such as Europe/Berlin.",
    parameters: Type.Object({ zone: Type.Optional(Type.String()) }),
    replay: "safe",
    execute: async (args) => ({
        output: [
            {
                type: "text" as const,
                text: new Date().toLocaleString("en-US", { timeZone: args.zone }),
            },
        ],
    }),
});

export default function createClock() {
    return defineExtension({ name: "example-clock", tools: [clock] });
}
```

The rules for the file, and how it loads, are in [Modules, loading, and errors](extensions/modules.md).

These examples work. `npm test` runs them (`test/docs-examples.test.ts`):

- [examples/my-words.ts](examples/my-words.ts): the module of [Your first extension](extensions/first-extension.md), a tool and a command.
- [examples/clock.ts](examples/clock.ts): a tool, and a command (`/clock-zone`) that sets the time zone that it uses in a session.
- [examples/no-force-push.ts](examples/no-force-push.ts): a hook that stops some bash calls, and a prompt section that tells Pi so.
- [examples/server-status.ts](examples/server-status.ts) with [examples/server-status.js](examples/server-status.js): a page on the rail, with a route that reads the machine's load and memory, and events that keep it live.

## The workflow core

Workflow enforcement belongs to the non-toggleable `pocket-core`. First-party Work Items is application-owned through `app.workItems`, with declarative built-in profiles and transitions in `src/server/work-item-profiles.ts`. It owns lifecycle, membership, active-writer ownership, filtered work views and whole-item organization; a private Handoffs engine retains transfer admission, durable tasks, recovery and atomic transactions. Core verifies actual placed written human input, explicit routing, access, idleness and exclusive ownership before creating a successor. The `handoff` tool exposes status/start, not readiness or completion gates. The picker sends genuine human `/handoff` input through `pocket.submit` and core's sole submission journal. Already-accepted summary/delivery data keeps its recovery tasks; there is no public summary-first admission/retry path. Historical workflow records remain evidence, not handoff authority.

Work Items no longer unloads or appears in Extensions. The owner pauses or resumes **Work Item execution** in native Settings → **Agents**, which persists additive `workItemsEnabled`. Only when that setting is absent does the legacy disabled `work-items.ts` choice serve as read-only migration input, so an earlier disabled installation stays paused on upgrade. Extension-enablement controls cannot change WorkItems. Profiles and controls remain visible; non-Chat built-in starters, new built-in handoffs and managed writes are blocked. Accepted recovery does not bypass that pause. Ordinary ungrouped Chat and Agent Teams remain independent. Third-party namespaced [`web.workflow`](extensions/reference/web.md#workflow) declarations retain their own loader lifecycle; missing/unknown managed profiles stay restricted, never become Chats. Owner prompt overrides and stored identities remain intact. The core `publication` tool still requires individual human approval from active Publish after Land; `pull` and role-gated `research` remain separate from offline shell and grant no publication authority.

Public [`host.sessions.handoff`](extensions/reference/host.md#sessionshandoff), `web.workflow`, scoped routes and browser controls remain supported. Browser assets live in `src/server/work-items/browser/`; core registers `src/server/work-items` with client entry `browser`, preserving `/x/work-items/…` asset URLs. There is no first-party Work Items entry or source module under `src/server/extensions/`. Its picker, controls, hints and styles intentionally reuse `sessionControl`, `sheet`, `inputCommand`, filtered snapshots and generic profile tags for compatibility. Scoped `GET /api/c/:id/x/work-items/handoffs` and `POST /api/c/:id/x/work-items/work-item` use request-bound WorkItems operations, rechecking current visibility and role after body arrival. Static conversation access never widens app-wide routes. Generic Settings/sidebar rendering, passive own-transfer lookup (`GET /api/c/:id/transfers`) and initiating-tab navigation remain in core while execution is paused. Source and browser target the same current API without older-host branches. See [handoffs.md](handoffs.md) and [the core/extension decision](extensions/policies/core-or-extension.md#first-party-work-items).

The core's extension name and the `handoff`, `publication`, `pull` and `research` tool names are reserved alongside the existing [extension and tool names](extensions/reference/names.md). Drop-ins cannot claim `coding-tools` or any `pocket-` name, even when an optional built-in is off. A rejected edit leaves the previous working version installed. Managed execution gates also apply to nested tool calls; wrapping a tool does not grant authority to bypass a block.

## Ordinary Pi provider packages

Pi coding-agent extensions are not Durable drop-ins. The separate **Pi provider compatibility** module hosts explicitly supported provider packages through Pi's public loader/runner; the first profile is LiteLLM API-key chat. Its owner controls live in Settings → Providers. Selection, enablement, configuration, update and rollback wait for restart. `pi-providers.ts` is a reserved virtual module identity, not a file to create in either extension folder, and it has no Reload action. See [provider-extensions.md](provider-extensions.md).

## Rules that are easy to break

- **Nothing two times.** A restart can run a hook or a safe tool again. Some work must occur one time only: a message that you send, money that you spend, a line that you add to a file. Put it behind `api.memo`, or behind a key that lets a second run find the first.
- **No hidden state.** Keep state in Pi Durable documents or memos, not in variables. A reload starts the module again, and a restart starts the process again.
- **Your documents are stored data.** Name a document kind after your module (`x.<module>.<name>`, for example `x.word-count.totals`), so that no other module uses the same kind. Name your tasks and your entries' kinds the same way. After anyone has run the module, never rename a kind or a name, and never change what its fields mean. Add new ones beside them.
- **Name your browser data too.** A browser module that keeps data in `localStorage` or `sessionStorage` uses keys that start with `x.<module>.`, for example `x.word-count.open`. Pi Pocket's own keys start with `pocket.`, and it never uses `x.` keys.
- **Do not block.** Tools run in the server process. Use async file and process calls, never `execSync` or a busy loop. A slow tool delays only its call; a blocked event loop delays everyone.
- **Do not get around a block.** A guard or a person said no for a reason.
- **Keep secrets out.** The text of a section, a tool's description, and a result go to the model provider.
