# API versions

This page tells how Pi Pocket marks the age and the stability of each part of the extension API. Server and browser source target the same current API. [API stability](../policies/api-stability.md) gives the rules for changes and for removals.

## The API version

`web.api` on the server and `pocket.version` in the browser give the version of the extension API. It is 1 now.

The version goes up only when a change breaks something that modules use. Additions do not change it.

## `pocketApi`

A module can export `pocketApi`: the server module, the browser module, or both.

```typescript
export const pocketApi = 1;
```

A Pi Pocket with an older API version does not set up such a module. It says why in the Extensions sheet.

The browser reads `pocketApi` after it imports the browser module. Thus keep the browser module's top level to declarations, and do its work in the default export.

## Since, Stable, Experimental, and Internal

Each member in the reference and in [types/pocket.d.ts](../../../types/pocket.d.ts) has two marks:

- **Since 0.14.0**: the first release of Pi Pocket that has the member. A pre-release counts as its release. In the types file, this is `@since`.
- **Stable**: the member changes only as the stability policy says.
- **Experimental**: the member can change, or go, in any minor release (`0.15.0`), but never in a patch release (`0.14.1`). See A4 and A14 in [API stability](../policies/api-stability.md#experimental). In the types file, this is `@experimental`. The 0.15 session/workflow and browser-presentation additions are experimental.

Some members of the host are **internal**: only Pi Pocket's built-in modules use them. They are not in the types file. They can change in any release. [host](host.md#internal-members) lists them.

## Keep source versions aligned

Pi Pocket reloads extension modules when edited, but host changes need an owner-controlled restart.
Server and browser source target the same current API. The session/workflow cutover provides no
older-host guards, linked-peer aliases or legacy summary-admission branches. Version metadata marks
requirements; it does not add a second compatibility implementation.

### Gallery entries

A gallery entry gives `pocketApi` and `minPocket`: the API version and the oldest Pi Pocket that the extension needs. The gallery hides an entry that needs a newer API or a newer Pi Pocket. See [Gallery entry](gallery-entry.md#pocketapi).

## When each part came

Each member in the reference has its own Since line. These parts came together:

| Part                                                           | Since  |
| -------------------------------------------------------------- | ------ |
| Built-in modules, the host, tools, sections, hooks             | 0.1.0  |
| Drop-ins in the drop-in folder                                 | 0.3.0  |
| `web`: routes, browser modules, events, cleanups               | 0.14.0 |
| `pocketApi`, `web.api`, and `pocket.version`                   | 0.14.0 |
| Slash commands (`web.command`)                                 | 0.14.0 |
| `pocket.toolCall`                                              | 0.14.0 |
| `host.sessions`, `web.workflow`                                | 0.15.0 |
| Scoped routes and static conversation browser access           | 0.15.0 |
| Browser session metadata, controls, input hints and submission | 0.15.0 |
| Logical-opening `SheetProps.isOpen`                            | 0.15.0 |
