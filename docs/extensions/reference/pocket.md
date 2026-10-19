# pocket

`pocket` is the app's API for a browser module: the argument of the browser module's default export. With it, a browser module adds rail buttons, menu rows, launcher actions, pages, sheets, inline session controls and input hints, and sets how the calls of its tools show. It also calls its module's routes and gets its module's events. [Browser modules](../browser-modules.md) tells you how to write one, and what happens when it fails.

The types are `Pocket` and the types that it uses, in [types/pocket.d.ts](../../../types/pocket.d.ts). A browser module is JavaScript: [Types for your editor](types.md) tells you how to use the types in JSDoc.

## The browser module

### `default`

```ts
default(pocket: Pocket): void | (() => void) | Promise<void | (() => void)>;
```

Since 0.14.0 · Stable

The browser module's default export. The app imports the module and calls this function with `pocket`. When the function returns a function, that function runs when this version goes, as with `pocket.onDispose`.

### `pocketApi`

```ts
pocketApi?: number;
```

Since 0.14.0 · Stable

The version of the extension API that the browser module needs. An app with an older version does not set it up. The app reads it after it imports the module, so keep the module's top level to declarations. [API versions](api-versions.md) tells you more.

## About the module

### `version`

```ts
readonly version: number;
```

Since 0.14.0 · Stable

The version of the extension API. It is the same number as `web.api` on the server.

### `module`

```ts
readonly module: string;
```

Since 0.14.0 · Stable

The module's name: the name of its file without `.ts`.

### `title`

```ts
readonly title: string;
```

Since 0.14.0 · Stable

The module's title, as the Extensions sheet shows it.

## Drawing

These are the app's own Preact and htm. Use them, and not a copy of your own, so that your components draw as the app's components do.

### `h`

```ts
readonly h: typeof h;
```

Since 0.14.0 · Stable

Preact's `h`.

### `html`

```ts
html(strings: TemplateStringsArray, ...values: unknown[]): VNode | VNode[];
```

Since 0.14.0 · Stable

htm, bound to the app's Preact: write components as tagged templates, such as `` html`<p>${text}</p>` ``.

### `Fragment`

```ts
readonly Fragment: typeof Fragment;
```

Since 0.14.0 · Stable

Preact's `Fragment`.

### `useState`

```ts
readonly useState: typeof useState;
```

Since 0.14.0 · Stable

Preact's `useState` hook.

### `useEffect`

```ts
readonly useEffect: typeof useEffect;
```

Since 0.14.0 · Stable

Preact's `useEffect` hook.

### `useLayoutEffect`

```ts
readonly useLayoutEffect: typeof useLayoutEffect;
```

Since 0.14.0 · Stable

Preact's `useLayoutEffect` hook.

### `useRef`

```ts
readonly useRef: typeof useRef;
```

Since 0.14.0 · Stable

Preact's `useRef` hook.

### `useMemo`

```ts
readonly useMemo: typeof useMemo;
```

Since 0.14.0 · Stable

Preact's `useMemo` hook.

### `useCallback`

```ts
readonly useCallback: typeof useCallback;
```

Since 0.14.0 · Stable

Preact's `useCallback` hook.

### `useReducer`

```ts
readonly useReducer: typeof useReducer;
```

Since 0.14.0 · Stable

Preact's `useReducer` hook.

## Pieces

The app's own components, so that a module looks like the rest of the app.

### `Icon`

```ts
readonly Icon: FunctionComponent<IconProps>;
```

Since 0.14.0 · Stable

One of the app's icons by `name`, or an icon of your own by `path`. See [`IconProps`](#iconprops).

### `Spinner`

```ts
readonly Spinner: FunctionComponent<LoaderProps>;
```

Since 0.14.0 · Stable

The app's spinner. Screen readers read its `label`. See [`LoaderProps`](#loaderprops).

### `Loader`

```ts
readonly Loader: FunctionComponent<LoaderProps>;
```

Since 0.14.0 · Stable

The app's spinner with its `label` beside it, for a page or sheet that loads. See [`LoaderProps`](#loaderprops).

### `Markdown`

```ts
readonly Markdown: FunctionComponent<MarkdownProps>;
```

Since 0.14.0 · Stable

Shows Markdown. It cleans the HTML that it makes, as the app does for Pi's replies. See [`MarkdownProps`](#markdownprops).

### `Switch`

```ts
readonly Switch: FunctionComponent<SwitchProps>;
```

Since 0.14.0 · Stable

The app's on and off switch. See [`SwitchProps`](#switchprops).

### `AgentProfileTag`

```ts
readonly AgentProfileTag: FunctionComponent<AgentProfileTagProps>;
```

Since 0.15.0 · Experimental

A generic indicator for `profile`, a registered profile ID. It uses current profile metadata for its
label and icon, falling back to the raw ID when unavailable. `iconOnly: true` keeps an accessible label
without visible text. There is no browser-owned table of built-in role names or icons.

## Who and where

### `me`

```ts
me(): Person | null;
```

Since 0.14.0 · Stable

The person who uses this tab, as `{ id, name, role }`, or `null` before sign-in.

### `conversationId`

```ts
conversationId(): number | null;
```

Since 0.14.0 · Stable

The id of the session that this tab shows, a number as in its address (`/s/12`), or `null` when it shows none.

### `session`

```ts
session(): SessionSnapshot;
```

Since 0.15.0 · Experimental

Deeply frozen metadata copies: `id`, `me`, `conversation`, the existing access-filtered `sessions`
catalogue, `busy`, `canSteer` and public `profiles`. Catalogue/profile copies are cached per immutable
input object; the core's store objects are neither exposed nor frozen. `me` is a separate copy.
The conversation is `null` before its view loads, otherwise only `{ id, kind, title, threadType, cwd }`.
No settings, prompts or raw view are included. UI flags never grant authorization.

### `requestId`

```ts
requestId(): string;
```

Since 0.15.0 · Experimental

A fresh identity from core's existing ID generator. It also works on plain-HTTP LAN origins where
`crypto.randomUUID` is unavailable. Use it for submissions, draft revisions and sheet-opening tokens;
it is not a credential or authorization. Reuse a submission identity for retries of unchanged input,
not for edited input.

### `onSessionChange`

```ts
onSessionChange(listener: (session: SessionSnapshot) => void): () => void;
```

Since 0.15.0 · Experimental

Calls the listener on app-state changes, not only on navigation. Read `session()` for the initial
snapshot. The returned cleanup stops the subscription; module disposal also stops it. Components may
combine it with `useState`, and inline controls receive updated snapshots from their parent renderer.
Keep asynchronous reads and caches scoped to the current user and source, rejecting stale results.

## Routes and events

### `api`

```ts
api<T = unknown>(
    path: string,
    body?: object,
    options?: { method?: WebMethod; signal?: AbortSignal },
): Promise<T>;
```

Since 0.14.0 · Stable

Calls one of the module's own routes, and gives the JSON that it returns.

- Without `body`, it sends a GET. With `body`, it sends a POST with `body` as JSON. `method` sets another method: `api("items/3", undefined, { method: "DELETE" })`.
- A query string in `path` goes to the handler's `query`: `api("usage?days=7")`.
- `signal` stops the call.
- When the server answers with an error, the promise rejects with an error that has the server's words and its `status`.
- It rejects at once for a path out of the module's routes: a path with a `.` or `..` part, a leading `//`, or a scheme such as `https:`.

### `sessionApi`

```ts
sessionApi<T = unknown>(
    id: number,
    path: string,
    body?: object,
    options?: { method?: WebMethod; signal?: AbortSignal },
): Promise<T>;
```

Since 0.15.0 · Experimental

Calls only this module's scoped routes at `/api/c/:id/x/<module>/<path>`, registered with
[`web.sessionRoute`](web.md#sessionroute). GET/POST selection, errors, query strings, path validation
and cancellation work as for `api`. Core rechecks current source visibility and the route's role
access, including after body arrival. Static browser access does not authorize a request.

### `submit`

```ts
submit(id: number, request: SessionSubmitRequest): Promise<SessionSubmitReceipt>;
```

Since 0.15.0 · Experimental

Sends genuine normal human model input through the composer's authenticated submission journal.
Supply `text` and a stable `requestId` from `pocket.requestId()`; optional fields are `attachments`, `mode` (`"steer"` or
`"followUp"`) and `inlineFiles`. Reuse the identity for the same unresolved draft, not for edited input.
Core retains steering, driving, spend and conversation checks.

It resolves on durable acceptance with `{ submissionId, requestId, handoffRequestKey? }`, not when
an agent answers or a successor exists. The receipt's request ID is the server-owned input identity;
`handoffRequestKey` is an opaque correlation, not authority. Core owns passive acknowledgement and
transfer lookup and initiating-tab navigation, even while Work Item execution is paused. Do not add
another send/recovery journal, transfer poller, automatic resubmission or handoff-version flag.

### `on`

```ts
on<T = unknown>(event: string, run: (data: T) => void): () => void;
```

Since 0.14.0 · Stable

Calls `run` with the data of each `event` that the module sends with `web.send`. It returns a function: call it to stop. The app keeps no events for a page that is closed. Thus a page that opens must first get the data that is current, and then listen. [Events](../events.md) tells you more.

## Adding to the app

Each thing that a module adds has an `id` of its own. To add one with the same `id` again replaces it. [Names](names.md#what-a-browser-module-adds) gives the rules for ids.

What a module adds draws at the next frame, one time for all its changes since the last frame. Change what you added from an event, a timer, or an effect, and not while a component draws. A module that changes what it added each time that it draws is stopped in that browser. [Browser modules](../browser-modules.md) tells you about these rules.

### `rail`

```ts
rail(spec: RailSpec): Added<RailSpec>;
```

Since 0.14.0 · Stable

Adds a button on the rail, after the app's own tools. It shows in the sidebar, in the drawer, and on a phone's home screen. See [`RailSpec`](#railspec).

### `menu`

```ts
menu(spec: MenuSpec): Added<MenuSpec>;
```

Since 0.14.0 · Stable

Adds a row in the App group of the menu. See [`MenuSpec`](#menuspec).

### `launcher`

```ts
launcher(spec: LauncherSpec): Added<LauncherSpec>;
```

Since 0.14.0 · Stable

Adds an action in the launcher (Ctrl+K, or ⌘+K). See [`LauncherSpec`](#launcherspec).

### `page`

```ts
page(spec: PageSpec): Added<PageSpec>;
```

Since 0.14.0 · Stable

Adds a page. A page shows in the place of the session, as the subagents board does. See [`PageSpec`](#pagespec).

### `sheet`

```ts
sheet<P extends object = object>(spec: SheetSpec<P>): Added<SheetSpec<P>>;
```

Since 0.14.0 · Stable

Adds a sheet, as the app's own sheets. See [`SheetSpec`](#sheetspec).

### `sessionControl`

```ts
sessionControl(spec: SessionControlSpec): Added<SessionControlSpec>;
```

Since 0.15.0 · Experimental

Adds a guarded component in `slot: "header" | "composer"` for the current session. The component
receives `{ pocket, session }`; `session` is a `SessionSnapshot`. It shares the extension renderer's
failure and disposal boundaries. Non-session conversations do not render these controls. The
component must still respect current permissions and avoid retargeting delayed actions.

### `inputCommand`

```ts
inputCommand(spec: InputCommandSpec): Added<InputCommandSpec>;
```

Since 0.15.0 · Experimental

Contributes a normal-model-input command row and argument hints: `{ id, name, description, suggest }`.
`suggest(text, caret)` returns hint rows or a promise of rows. A row may have `name`, `description`,
`args`, `completion`, `completeOnEnter` and `disabled`. The app uses at most 512 rows. Picking a row
only edits the ordinary draft; this API has no execution or submission handler. Sending remains the
normal authenticated input path, unlike server-side `web.command`.

### `toolCall`

```ts
toolCall<A = Record<string, unknown>>(spec: ToolCallSpec<A>): { remove(): void };
```

Since 0.14.0 · Stable

Sets how the calls of one of the module's own tools show in transcripts and peek tiles. Without it, a call shows as the tool's name, with its arguments as JSON. It goes with the version that added it. See [`ToolCallSpec`](#toolcallspec). [How tool calls show](../tool-calls.md) tells you more.

## Opening and closing

A module opens and closes only its own pages and sheets. A version that is gone, or that failed, opens and closes nothing.

### `openPage`

```ts
openPage(id: string): void;
```

Since 0.14.0 · Stable

Opens the module's page with this `id`. A sheet or the launcher over the page closes.

### `closePage`

```ts
closePage(): void;
```

Since 0.14.0 · Stable

Closes the module's page that shows, whichever page it is.

### `openSheet`

```ts
openSheet(id: string, props?: object): void;
```

Since 0.14.0 · Stable

Opens the module's sheet with this `id`. Its component gets the fields of `props`.

### `navigate`

```ts
navigate(id: number): void;
```

Since 0.15.0 · Experimental

Opens a visible conversation through normal app routing and history. It grants no access to an
otherwise hidden conversation. Capture the intended ID before asynchronous work, rather than using
whatever thread happens to be current when it settles.

### `closeSheet`

```ts
closeSheet(): void;
```

Since 0.14.0 · Stable

Closes the module's sheet that shows.

## Notices, styles, and cleanups

### `notify`

```ts
notify(level: NoticeLevel, message: string): void;
```

Since 0.14.0 · Stable

Shows a notice, as the app's own notices: `"info"`, `"warning"`, or `"error"`. A module can show only a few notices in a short time, for all its versions together. Its actions that fail and its stylesheets that do not load count too. The app drops the rest. [Limits](limits.md#browser-modules) gives the numbers. A version that is gone, or that failed, shows none.

### `style`

```ts
style(path: string): void;
```

Since 0.14.0 · Stable

Loads a stylesheet from the browser module's folder, such as `pocket.style("look.css")`, into the app's own cascade layer (a theme's rules win over it). The stylesheet goes with this version. A path out of the folder throws. When the stylesheet does not load, a notice says so. A browser module that is one file has no folder, so it cannot load a stylesheet.

### `onDispose`

```ts
onDispose(dispose: () => void): void;
```

Since 0.14.0 · Stable

Runs `dispose` when this version goes: an edit replaces it, or the owner turns the module off. When the version is already gone, or failed, it runs `dispose` at once. The app does not wait for a browser cleanup: do at once what must be done.

## The objects you give

### `Action`

```ts
type Action =
    | { page: string; sheet?: never; run?: never }
    | { sheet: string; page?: never; run?: never }
    | { run: () => unknown; page?: never; sheet?: never };
```

Since 0.14.0 · Stable

What a rail button, a menu row, or a launcher action does when a person uses it. Give exactly one of these fields:

- `page`: the id of a page that the module adds. The button, row, or action opens it.
- `sheet`: the id of a sheet that the module adds. It opens it.
- `run`: a function that it calls. When the function throws, or its promise rejects, a notice says so.

A rail button that opens a page shows when the page is open. A second tap closes the page.

Buttons, rows, and actions of modules show in the order in which the server lists the modules. An edit keeps the module's place.

### `RailSpec`

```ts
type RailSpec = Action & {
    id: string;
    title: string;
    icon?: string;
    iconPath?: string;
    badge?: number | string | null | false;
};
```

Since 0.14.0 · Stable

A button on the rail.

- `id`: the button's id in the module.
- `title`: the button's label.
- `icon`: the name of one of the app's icons, such as `pulse`, `grid`, `globe`, `key`, `chat`, `folder`, or `search`. An unknown name shows `grid`.
- `iconPath`: an icon of your own, as the `d` of a stroked SVG path in a 24 × 24 box.
- `badge`: a short count or word on the button. `0`, `NaN`, `-Infinity`, `""`, `"0"`, `null`, and `false` show no badge, as the app's own counts do at 0. A count that is too large shows a maximum with `+`. Long text is cut, also in the button's label, without cutting a character in two. [Limits](limits.md#browser-modules) gives the numbers.

Modules' rail buttons have a fixed height together. When they need more, they scroll.

### `MenuSpec`

```ts
type MenuSpec = Action & {
    id: string;
    label: string;
    hint?: string;
};
```

Since 0.14.0 · Stable

A row in the App group of the menu.

- `id`: the row's id in the module.
- `label`: the row's words.
- `hint`: short words on the right of the row.

### `LauncherSpec`

```ts
type LauncherSpec = Action & {
    id: string;
    label: string;
    detail?: string;
    icon?: string;
    iconPath?: string;
    keywords?: string[];
};
```

Since 0.14.0 · Stable

An action in the launcher.

- `id`: the action's id in the module.
- `label`: the action's words.
- `detail`: a line under the label. The default is the module's title.
- `icon`, `iconPath`: the action's icon, as for a rail button.
- `keywords`: more words that find the action when a person types them.

### `PageSpec`

```ts
interface PageSpec {
    id: string;
    title: string;
    component: ComponentType<PageProps>;
    escape?: boolean;
    swipe?: boolean;
}
```

Since 0.14.0 · Stable

A page in the place of the session. It has its title and a close button. On a phone, it fills the screen.

- `id`: the page's id in the module.
- `title`: the page's title.
- `component`: what the page shows. It gets [`PageProps`](#pageprops).
- `escape`: with `false`, the page keeps Esc for itself. Esc still closes a sheet, the launcher, or PiP over the page. The close button and back still close the page.
- `swipe`: with `false`, no swipe on the page goes back, also at the screen's edge.

Esc and back close a page. Esc does not close it while an input method composes a character. On a narrow touch screen, a swipe to the right on the page goes back. This is not so in a field, or in an area that scrolls sideways. In an app added to the home screen of an iPhone or iPad, a swipe in from the left edge also goes back. A `data-no-swipe` attribute on an element stops the swipe on it and in it, for example on a slider. [Limits](limits.md#browser-modules) gives the width.

### `SheetSpec`

```ts
interface SheetSpec<P extends object = object> {
    id: string;
    title: string;
    component: ComponentType<SheetProps<P>>;
    wide?: boolean;
}
```

Since 0.14.0 · Stable

A sheet, as the app's own sheets.

- `id`: the sheet's id in the module.
- `title`: the sheet's title.
- `component`: what the sheet shows. It gets [`SheetProps`](#sheetprops).
- `wide`: with `true`, the sheet is wider.

A page or sheet can open with an id that the module never added. Then it says that the module no longer has it.

### `PageProps`

```ts
interface PageProps {
    pocket: Pocket;
    close(): void;
}
```

Since 0.14.0 · Stable

What the component of a page or sheet gets.

- `pocket`: the `pocket` of the version that added the page or sheet.
- `close`: closes this page or sheet, of this version, while it shows. When you call it later, it closes nothing else. To close whichever page of the module shows, use `pocket.closePage()`.

### `SheetProps`

```ts
type SheetProps<P extends object = object> = P &
    PageProps & {
        isOpen(): boolean;
    };
```

Since 0.14.0 · Stable

What a sheet's component gets: the flat fields passed to `openSheet`, plus `pocket`, `close` and
`isOpen`. Do not read a nested `props` property or create another outer sheet; the host supplies it.
`close` pins this actual opening, so an old callback cannot close a later opening of the same sheet ID.

#### `SheetProps.isOpen`

```ts
isOpen(): boolean;
```

Since 0.15.0 · Experimental

True only while this actual opening is current. Closing animation retention, a replacement opening
of the same ID, or a disposed module returns false. Use it before showing inline errors after an
await; also check user/source identity and draft revision before clearing saved work.

### `ToolCallSpec`

```ts
interface ToolCallSpec<A = Record<string, unknown>> {
    tool: string;
    icon?: string;
    iconPath?: string;
    label: (args: A) => string;
    subject?: (args: A) => string;
    summary?: (args: A) => CallSummary;
}
```

Since 0.14.0 · Stable

How the calls of one tool show, from their arguments.

- `tool`: the tool's name, exactly as Pi calls it. The tool must be one that the module's own extensions install. The app refuses any other tool, so no module changes how the calls of another module show. With a server that is too old to list the module's tools, `toolCall` does nothing.
- `label`: the words of the call's line, such as `"start session"`.
- `subject`: what the call acts on.
- `summary`: how a group of calls counts this call. See [`CallSummary`](#callsummary).
- `icon`, `iconPath`: the call's icon in peek tiles, as for a rail button.

Each function gets a copy of the call's arguments. What it returns shows as one line of text, never as HTML. When a function throws, or returns something that is not text, the call shows the default way. The browser's console has the error.

### `CallSummary`

```ts
interface CallSummary {
    verb: string;
    noun?: string;
    by?: string;
}
```

Since 0.14.0 · Stable

How a group of calls counts a call. The calls count by the values of their argument `by`. For example, `{ verb: "messaged", noun: "session", by: "to" }` gives "messaged 2 sessions" for calls to two addresses, however many calls there are. Without `noun`, the group shows only the verb, such as "checked linked sessions".

### `Added`

```ts
interface Added<S> {
    update(patch: Partial<S>): void;
    remove(): void;
}
```

Since 0.14.0 · Stable

What contribution registrations return, including `sessionControl` and `inputCommand`.

- `update`: changes the fields in `patch`. An update that changes nothing draws nothing again. Values count as the same only when they are the very same value: a new array or function is a change.
- `remove`: removes what was added.

### `SessionSnapshot`

```ts
interface SessionSnapshot {
    readonly id: number | null;
    readonly me: Readonly<Person> | null;
    readonly conversation: SessionConversation | null;
    readonly sessions: readonly SessionMetadata[];
    readonly busy: boolean;
    readonly canSteer: boolean;
    readonly profiles: readonly AgentProfileMetadata[];
}
```

Since 0.15.0 · Experimental

The snapshot contains deeply frozen metadata copies, not arbitrary server fields or raw prompt data.
Its catalogue retains the current person's visibility filter.

### `SessionConversation`

```ts
interface SessionConversation {
    readonly id: number;
    readonly kind: "session" | "conversation" | "subagent";
    readonly title: string;
    readonly cwd: string;
    readonly threadType?: AgentProfile["id"];
}
```

Since 0.15.0 · Experimental

Only these five fields describe the open conversation. No workflow projection, placement, settings,
transcript or raw view is exposed; use the filtered catalogue for supported session-row metadata.

### `SessionMetadata`

Since 0.15.0 · Experimental

Supported display fields from the existing filtered session catalogue:

- `id`, optional `title`, `cwd`, `createdAt`, `updatedAt` and optional `archived`.
- `threadType` and optional `projectId`, `workItemId`, `workItemTitle`, `activeThreadId`,
  `linkedFrom: { id }` and `linkedOrigin`. Group/link metadata retains core's visibility filtering.
- `workflow`, `busy`, `waiting`, optional `failed` and optional `model`.

Fields are read-only metadata, not execution or mutation authority.

### `SessionWorkflowMetadata`

Since 0.15.0 · Experimental

Display-only `status` (`"active"`, `"review-complete"`, `"landed"`, `"published"` or `"needs-review"`),
`readOnly`, `managed`, `preparing`, `profileAvailable`, optional `paused`, optional `summary` and
optional `readyForPublish`. The optional field `readonly paused?: boolean` reports the owner's
first-party Work Item execution pause for this thread. A paused thread can still have
`profileAvailable: true`: its profile and instructions remain installed, but execution is paused.
Neither an absent/false pause flag nor historical status values grant handoff, write or publication
permission.

### `AgentProfileMetadata`

```ts
type AgentProfileMetadata = Omit<AgentProfile, "prompt">;
```

Since 0.15.0 · Experimental

Public profile labels, descriptions, starter choices and optional icons, never prompt text. See
[`AgentProfile`](web.md#agentprofile).

### `SessionControlSpec`

```ts
interface SessionControlSpec {
    id: string;
    slot: "header" | "composer";
    component: ComponentType<SessionControlProps>;
}
```

Since 0.15.0 · Experimental

### `SessionControlProps`

```ts
interface SessionControlProps {
    pocket: Pocket;
    session: SessionSnapshot;
}
```

Since 0.15.0 · Experimental

### `InputCommandSpec`

```ts
interface InputCommandSpec {
    id: string;
    name: string;
    description: string;
    suggest(
        text: string,
        caret: number,
    ): readonly InputCommandHint[] | Promise<readonly InputCommandHint[]>;
}
```

Since 0.15.0 · Experimental

Names are lowercase command names beginning with a letter, at most 64 letters/digits/underscores or
hyphens.

### `InputCommandHint`

```ts
interface InputCommandHint {
    name: string;
    description?: string;
    args?: string;
    completion?: string;
    completeOnEnter?: boolean;
    disabled?: boolean;
}
```

Since 0.15.0 · Experimental

Hint rows have no action callback. Return no hints inside prose or while editing earlier
arguments unless your command explicitly supports it.

### `SessionSubmitRequest`

```ts
interface SessionSubmitRequest {
    text: string;
    requestId: string;
    attachments?: readonly SessionAttachment[];
    mode?: "steer" | "followUp";
    inlineFiles?: boolean;
}
```

Since 0.15.0 · Experimental

`inlineFiles` sends supported `@` mentions along with the input under the usual limits.

### `SessionAttachment`

```ts
interface SessionAttachment {
    path: string;
    name: string;
    mime: string;
    size: number;
}
```

Since 0.15.0 · Experimental

Attachments refer to existing uploads in the addressed conversation, not arbitrary server files.

### `SessionSubmitReceipt`

```ts
interface SessionSubmitReceipt {
    readonly submissionId: number;
    readonly requestId: string;
    readonly handoffRequestKey?: string;
}
```

Since 0.15.0 · Experimental

The receipt acknowledges durable input acceptance only; it contains no response text or successor ID.

## The props of the pieces

### `AgentProfileTagProps`

```ts
interface AgentProfileTagProps {
    profile: AgentProfile["id"];
    iconOnly?: boolean;
}
```

Since 0.15.0 · Experimental

### `IconProps`

```ts
interface IconProps {
    name?: string;
    path?: string;
    size?: number;
}
```

Since 0.14.0 · Stable

- `name`: the name of one of the app's icons.
- `path`: an icon of your own, as for `iconPath`.
- `size`: its width and height, in pixels.

### `LoaderProps`

```ts
interface LoaderProps {
    label?: string;
}
```

Since 0.14.0 · Stable

The props of `Loader` and `Spinner`. `label` says what loads, in words.

### `MarkdownProps`

```ts
interface MarkdownProps {
    text: string;
}
```

Since 0.14.0 · Stable

`text` is the Markdown to show.

### `SwitchProps`

```ts
interface SwitchProps {
    on: boolean;
    label: string;
    onChange: () => void;
    disabled?: boolean;
}
```

Since 0.14.0 · Stable

- `on`: whether the switch is on.
- `label`: the switch's name, for screen readers.
- `onChange`: runs when a person turns the switch. Set `on` again from it.
- `disabled`: with `true`, nobody can turn the switch.

## CSS names Pi Pocket keeps

To look like the app, use its colors and classes. The colors follow the theme. Pi Pocket keeps these names. The rest of its CSS can change. These names are a subset of [the theme surface](theme-surface.md#extensions-css-names), the one full list of the tokens, parts, and states Pi Pocket keeps.

- Colors: `var(--text)`, `var(--muted)`, `var(--accent)`, `var(--bg)`, `var(--card)`, `var(--line)`, `var(--err)`, `var(--warn)`, and `var(--ok)`.
- Classes: `button` (with `primary`), `error-box`, `muted`, `small`, `mono`, and `setting` (a row with a label and a control).
