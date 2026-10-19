# web

`web` is the second argument of a module's default export. With it, a module adds to the app what a tool cannot: routes on the server, a browser module, and commands for the message box. [Adding to the app](../app.md) tells you how the parts work together.

Register routes, the browser module, and commands while the module loads. After that, these calls throw. What you register goes when this version of the module goes: an edit replaces it, or the owner turns the module off.

The types are `Web` and the types that it uses, in [types/pocket.d.ts](../../../types/pocket.d.ts).

## About the module

### `api`

```ts
readonly api: number;
```

Since 0.14.0 · Stable

The version of the extension API. [API versions](api-versions.md) tells you when it changes.

### `module`

```ts
readonly module: string;
```

Since 0.14.0 · Stable

The module's name: the name of its file without `.ts`. The routes of `server-status.ts` are under `/api/x/server-status/`.

## Registering

### `route`

```ts
route(method: WebMethod, path: string, handle: WebHandler, options?: { access?: WebAccess }): void;
```

Since 0.14.0 · Stable

Adds a route at `/api/x/<module>/<path>`. `handle` answers its requests.

- `method` is a [`WebMethod`](#webmethod).
- `path` is relative to the module's routes: `"status"`, or `"items/:id"`. A part written `:name` matches any one part of the address. [Names](names.md#routes) gives the characters that a part can have.
- When paths overlap, the most specific path answers, whatever the order of registration. From the left, a fixed part comes before a `:name` part: `items/new` comes before `items/:id`.
- `access` says who can use the route. The default is `"owner"`. See [`WebAccess`](#webaccess).
- A method and a path of the same shape can have only one route.

[Routes](../routes.md) tells you about the checks that come before a handler, errors, and what to check in a handler.

### `sessionRoute`

```ts
sessionRoute(
    method: WebMethod,
    path: string,
    handle: SessionWebHandler,
    options?: { access?: WebAccess },
): void;
```

Since 0.15.0 · Experimental

Adds a route at `/api/c/:id/x/<module>/<path>`, separate from the module's app-wide routes.
Path matching, JSON bodies, errors and `X-Pocket` requirements are the same as for `route`.
The default access is `"owner"`; `"steer"` and `"view"` also permit scoped invitees who can see
this source. Core checks current visibility and role again after reading an asynchronous body,
and each bound service call rechecks the current person and installed route. The handler receives
[`SessionWebRequest`](#sessionwebrequest), not unrestricted app services.

### `client`

```ts
client(entry: string, options?: { access?: WebClientAccess }): void;
```

Since 0.14.0 · Stable

Sets the module's browser module. A module has one browser module at most.

- `entry` is the name of a file or folder immediately beside the module. It must not be a link. [Names](names.md#browser-modules) gives the characters that it can have.
- A `.js` or `.mjs` file is served alone.
- A folder must have an `index.js`, which loads first and can import the other files of the folder.
- `access` says whose tabs load it. The default is `"owner"`. See [`WebClientAccess`](#webclientaccess).
- Since 0.15.0, experimental `"conversation"` access lets scoped invitees load static browser assets.
  It grants no app-wide route or conversation-data access; scoped routes still check their own source and role.

[Browser modules](../browser-modules.md) tells you which files a folder serves, and when tabs load a new version.

### `command`

```ts
command(name: string, command: Command): void;
```

Since 0.14.0 · Stable

Adds the command `/name` to the message box, for the people who can run it. The command runs on the server, and it does not ask Pi.

- [Names](names.md#commands) gives the rules for `name`.
- [Command context](command-context.md) gives the fields of `command` and what its handler gets and returns.
- [Slash commands](../commands.md) tells you who can run a command, how a run is kept, and how a person stops it.

### `workflow`

```ts
workflow(definition: SessionWorkflow): void;
```

Since 0.15.0 · Experimental

Registers declarative agent profiles and workflow choices while the module loads. A definition has
`id`, `profiles` and `transitions`. Each profile has `id`, `name`, `description`, `prompt`, `title` and
optional `starter` and `icon` fields. `icon` names an app icon for generic profile indicators. The
startup panel uses current profiles only and defaults projects to the first non-Chat starter. Work
Items orders Worker before Researcher; core does not hardcode those workflow names.

A transition has `from`, `to`, `relationship` (`"same-work"` or `"new-work"`), optional `historyAny`
profile IDs and optional `currentDiff`. `historyAny` requires at
least one named profile in the same Work Item's history. `currentDiff: true` requires a current Pi
diff; `false` requires none. Core inspects the checkout outside its Durable transaction while holding
the exclusive writer lock and rechecks the declaration at final admission.

Workflow and profile IDs must start with `<module>:` and end in a 1–64 character local ID (letters,
digits, `.`, `_`, `-`). The application's WorkItems catalog owns the legacy built-in IDs, including
`chat`, `worker` and `publish`; extensions cannot register them, and pausing execution does not free
those names. References must be within the same definition. Definitions allow at most 64 profiles
and 512 unique transitions. Prompts allow 32,000 characters. Unknown fields, duplicate identities, accessors and malformed data are refused.

Registrations are copied and frozen, staged with the module, and installed only after successful
validation and extension installation. Failed or superseded reloads keep the previous version.
Turning the module off removes new choices, not stored profile identities, histories, receipts or
write restrictions. Unknown/missing managed profiles get an unavailable-role prompt and cannot mutate
work; they never become unrestricted Chats. The explicit stored `chat` identity retains its original
core capabilities and Chat profile independently of optional declarations, so ordinary Chat and Agent
Teams do not require Work Items. Owner prompt overrides remain stored and take effect again when
that profile returns. The first-party **Work Item execution** pause does not unload declarations or
pause independently registered namespaced profiles.

Profiles and transitions do not grant tools, network access, publication approval, model choices or
write ownership. Core retains those checks and all durable transfer/recovery tasks. Use
[`host.sessions`](host.md#sessions) for a tool to request a handoff. Source and browser target the
same current API; there is no older-host compatibility branch.

First-party Work Items now uses the application-owned catalog in `src/server/work-item-profiles.ts`,
not an optional `web.workflow` declaration. Its browser assets live in `src/server/work-items/browser/`;
core registers `src/server/work-items` with client entry `browser`, preserving `/x/work-items/…` URLs.
There is no first-party Work Items entry or source module under `src/server/extensions/`. The
controls intentionally reuse generic public presentation infrastructure for compatibility. Core keeps
the existing scoped `GET handoffs` and `POST work-item` routes backed by request-bound WorkItems
operations. These public mechanisms
remain available to extensions; promotion removes no public member. Generic Settings/sidebar
presentation, durable input and transfer recovery remain in core. Registration grants no access to
internal browser imports, app-wide routes or DOM patching.

### `AgentProfile`

Since 0.15.0 · Experimental

A read-only playbook declaration with `id`, `name`, `description`, `prompt`, `title`, optional
`starter` and optional `icon`. Icons use the app's icon names. Profile order determines the first
non-Chat project starter; the core Chat profile remains available independently. The browser's
`AgentProfileMetadata` omits `prompt`.

### `SessionWorkflowTransition`

Since 0.15.0 · Experimental

Read-only `from`, `to` and `relationship` (`"same-work"` or `"new-work"`), optional `historyAny`
profile IDs and optional `currentDiff`. These filter available choices; they do not grant authority.

### `SessionWorkflow`

Since 0.15.0 · Experimental

Read-only `id`, `profiles` and `transitions`, installed atomically with a module version by `workflow`.

## Sending and answering

### `send`

```ts
send(event: string, data?: unknown, options?: { to?: string }): void;
```

Since 0.14.0 · Stable

Sends an event to the browser module. There, `pocket.on(event, run)` gets it.

- `data` is a value that JSON can hold.
- Without `to`, the event goes to the tabs of all the people that the browser module's `access` lets in. With `to`, it goes only to the tabs of the person with that id.
- Static `"conversation"` access uses the app-wide `"view"` event filter: scoped invitees receive no broadcast, even when named by `to`. Use `sessionRoute` for their conversation-bound data.
- Send events only after the module has loaded, and only from a module that has a browser module. Other events go nowhere.
- `send` never throws, because modules call it mostly from timers. When it cannot send an event, it writes the reason to the server's log, one time for each kind of mistake in a version.

[Events](../events.md) tells you about the limits, and about tabs that fall behind.

### `error`

```ts
error(status: number, message: string): Error;
```

Since 0.14.0 · Stable

Makes an error for a route or a command handler to throw: `throw web.error(404, "No such item")`. The person who asked gets `status` and `message` as they are. `status` is from 400 to 599.

Do not put text in `message` that this person must not see. Any other error that a handler throws gives a status of 500, and only the owner sees its words.

### `onDispose`

```ts
onDispose(dispose: () => unknown): void;
```

Since 0.14.0 · Stable

Runs `dispose` when this version of the module goes: an edit replaces it, the owner turns it off, or the server stops. Stop timers and close connections there. `dispose` can return a promise. [Cleanups](../cleanups.md) tells you how long a stopping server waits for it.

## Requests

### `WebHandler`

```ts
type WebHandler = (request: WebRequest) => unknown;
```

Since 0.14.0 · Stable

Answers the requests of a route. The value that it returns goes back as JSON, and `undefined` goes back as `{}`. It can be async.

### `WebRequest`

```ts
interface WebRequest {
    readonly method: WebMethod;
    readonly params: Readonly<Record<string, string>>;
    readonly query: URLSearchParams;
    readonly body: Readonly<Record<string, unknown>>;
    readonly user: Person;
    readonly signal: AbortSignal;
}
```

Since 0.14.0 · Stable

What a handler gets.

- `method`: the request's method.
- `params`: the values of the path's `:name` parts, by name. They are text from outside: check a value before you make a file path from it.
- `query`: the query string. `pocket.api("usage?days=7")` sends `days`.
- `body`: the JSON object that the browser sent. It is empty for GET and DELETE.
- `user`: the person who asked, as `{ id, name, role }`.
- `signal`: it aborts when the browser stops waiting for the answer. Give it to the work that the handler waits for.

### `SessionWebRequest`

```ts
interface SessionWebRequest extends WebRequest {
    readonly conversationId: ConversationId;
    readonly session: SessionRequestServices;
}
```

Since 0.15.0 · Experimental

The common request fields plus the addressed visible conversation and services bound to that
request's authenticated person. A handler cannot supply another person's identity or retarget a service.

### `SessionRequestServices`

```ts
interface SessionRequestServices {
    readonly transfers: {
        status(): Promise<unknown>;
        updateGroup(patch: Readonly<Record<string, unknown>>): Promise<void>;
    };
}
```

Since 0.15.0 · Experimental

`transfers.status()` reads filtered workflow state and choices without starting a transfer.
`transfers.updateGroup(patch)` applies group metadata under core's access, driving and membership
checks. Both recheck the current authenticated person, source visibility and route access when called.
They expose no arbitrary conversation, filesystem or server handle.

### `SessionWebHandler`

```ts
type SessionWebHandler = (request: SessionWebRequest) => unknown;
```

Since 0.15.0 · Experimental

Answers a scoped route with JSON; it may be async. Errors follow the same rules as `WebHandler`.

### `WebMethod`

```ts
type WebMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
```

Since 0.14.0 · Stable

The methods that a route can have.

## Access

### `WebAccess`

```ts
type WebAccess = "owner" | "steer" | "view";
```

Since 0.14.0 · Stable

Role access for routes and browser modules. The app-wide interpretation is:

- `"owner"`, the default: the owner alone.
- `"steer"`: the owner, and guests who can steer all sessions.
- `"view"`: the owner, guests, and viewers who can see all sessions.

A person invited to one session cannot use app-wide routes or browser modules with these access
values. Each route has its own `access`, so a browser module for everyone can call a route for the
owner alone. For `sessionRoute`, visibility is checked against the addressed conversation and scoped
invitees are included: `"steer"` excludes viewers, `"view"` includes them, and `"owner"` remains owner-only.

`access` is the same for all methods. A POST route with `"view"` lets viewers change something through it, though they cannot steer a session. Give `"owner"` or `"steer"` to a route that changes things.

To a person that its `access` does not let in, a route is not there. The person gets the same 404 as for a path that the module does not have. Thus another route whose path matches can answer the person. Give the same `access` to routes whose paths overlap, or check `user.role` in the handler.

### `WebClientAccess`

```ts
type WebClientAccess = WebAccess | "conversation";
```

Since 0.15.0 · Experimental

Adds an opt-in for signed-in conversation participants, including scoped invitees, to load static
browser-module files. Put no secrets in those files. This option applies only to `client`, not `route`
or `sessionRoute`; it does not widen app-wide routes, reveal other sessions or grant mutation rights.
