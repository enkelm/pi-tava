# API versions

This page tells how Pi Pocket marks the age and the stability of each part of the extension API. Server and browser source target the same current API. [API stability](../policies/api-stability.md) gives the rules for changes and for removals.

## The API version

`web.api` on the server and `pocket.version` in the browser give the version of the extension API. It is 1 now.

The version goes up when the app's own public host/web/browser contract breaks. Additions do not
change it. The pinned experimental Durable tool-result ABI has a separate declaration below.

## `pocketApi`

A module can export `pocketApi`: the server module, the browser module, or both.

```typescript
export const pocketApi = 1;
```

A Pi Pocket with an older API version does not set up such a module. It says why in the Extensions sheet.

The browser reads `pocketApi` after it imports the browser module. Thus keep the browser module's top level to declarations, and do its work in the default export.

## Pi Durable 1.4 cutover (unreleased)

This is a breaking source migration in the pending upgrade, not a deployed release. Pi Coop keeps
`pocketApi`, `web.api` and `pocket.version` at **1**: no upstream API-2 browser features are implied.
Existing absent/version-1 declarations still load compatible web-only modules. Raising `pocketApi`
alone would not refuse old tools, because both loaders accept older declarations.

A server drop-in providing tools, tool wrappers or `afterTool` hooks must now declare:

```typescript
export const durableToolApi = 2;
```

The number 2 versions Coop's loader declaration, not the persisted ToolTask format or upstream
`pocketApi`. Only this value is supported. A missing declaration on a tool-result participant, or an unsupported
declared value on any drop-in, produces an actionable load error. A failed edit leaves the old
extension and web registrations installed. Web-only modules and `beforeTool`-only guards need no
such export. Browser modules do not use it. It is not a gallery index field; gallery filtering still
checks `pocketApi`/`minPocket`, and the server loader performs tool-ABI admission on enablement.

Migration requires `{ output: [...] }` from Durable tools, updated result readers in wrappers/hooks,
and matching `outputWindow`/`retainedOutput` when intercepting streams. Document definitions require
an explicit `checkpointWhen`; preserve their stored contracts. Transcript/model messages, artifacts
and agent-core tools still have their own `content`. Do not rename those fields. See [Tools](../tools.md).

This explicitly narrows the former single-number package-compatibility policy (A2): the experimental
Durable ABI is cut over without old-result aliases or its former deprecation guarantee. Stable app
host/web/browser members retain their existing version/deprecation rules. Keep the previous code,
dependencies and pre-upgrade data together for rollback; a package downgrade alone is not rollback.
The [upgrade ledger](../../upstream-differences.md#pi-14-upgrade-source-work-in-progress) records
isolated installed-runtime checks, disposable SQLite migration/paired rollback and native journal
recovery evidence, with their limits. Full-suite and native HTTP/browser/Reviewer validation remain
unavailable; a live cutover and coordinated owner-controlled restart are not authorized by those
checks. Source edits and declarations alone do not establish compatibility.

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
| Experimental `durableToolApi` tool-result declaration          | 0.15.0 |

## 0.15.0 WorkItems consolidation notes (unreleased)

This change is scheduled for the next minor release. It changes first-party availability and the
location of Work Item execution controls and migration of the saved disabled choice; it is not a
patch-level public-interface removal. These
notes cover the consolidation only.

### For extension authors

#### Added

- Optional read-only [`SessionWorkflowMetadata.paused`](pocket.md#sessionworkflowmetadata) distinguishes an execution pause from an unavailable profile. The metadata remains experimental.

#### Changed

- First-party Work Items is application-owned through `app.workItems`, not an optional extension. Built-in roles and transitions stay declarative; Projects and Commands use its lifecycle, filtered view and whole-item organization. The private Handoffs engine retains durable transfer/recovery contracts. See [architecture](../../architecture.md#cross-thread-handoffs).
- Work Items is no longer listed or controlled in Extensions. Native Settings → **Agents** owns **Work Item execution** pause/resume through additive `workItemsEnabled`. The legacy disabled `work-items.ts` choice is read-only migration input only when the native field is absent, so existing disabled installations stay paused on upgrade. Explicit native changes persist `workItemsEnabled`; the extension-enablement endpoint cannot change WorkItems. Owner-only `POST /api/agents` accepts `{ workItemsEnabled: boolean }`, with effective state in `GET /api/agents` and `hello` metadata. Profiles and controls remain visible, but non-Chat built-in starters, new built-in handoffs and managed effects are blocked. Accepted recovery retains its durable path without bypassing that pause. Ordinary ungrouped Chat, Agent Teams and namespaced third-party workflow declarations remain independent. See [availability](../../handoffs.md#availability-and-execution-pause).
- [`web.workflow`](web.md#workflow), [`host.sessions.handoff`](host.md#sessionshandoff), scoped routes, static conversation access, browser controls and input hints remain public. Browser assets moved to `src/server/work-items/browser/`, registered by core from `src/server/work-items` with client entry `browser`. No first-party Work Items entry or source module remains under `src/server/extensions/`. The first-party `work-items` route/asset namespace is retained, including `/x/work-items/…` and the scoped route URLs; controls intentionally reuse generic public presentation infrastructure for compatibility. Stable built-in IDs and owner prompt overrides are preserved; unknown managed profiles remain fail-closed. See [core or extension](../policies/core-or-extension.md#first-party-work-items).

#### Deprecated

None by this consolidation.

#### Removed

No public members. `pocketApi` remains 1.

#### Reserved names

No new names. Existing built-in profile, module and tool reservations remain in force, including
`work-items` and `handoff`; pausing execution does not free them.

#### Security

No authority policy is relaxed. Single-writer retirement, live access/idleness checks, offline
execution and individual publication approvals remain mandatory. Grouping grants no access;
hidden members block whole-item mutations.

#### Packages

No pinned package changes for this consolidation.
