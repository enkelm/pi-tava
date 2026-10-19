# host

The host is the first argument of a module's default export. A module uses it to read from Pi Pocket and to report to it. To add to the app, a module uses [`web`](web.md), the second argument.

The host does not change when a module reloads. It changes only when the server restarts. Server and browser source target the same current API; restart after changing host code rather than adding older-host aliases or fallback branches. See [Using the host](../host.md).

The types are `Host` and the types that it uses, in [types/pocket.d.ts](../../../types/pocket.d.ts). [Types for your editor](types.md) tells you how to import them.

## Folders

### `dataDir`

```ts
readonly dataDir: string;
```

Since 0.1.0 · Stable

Pi Pocket's data folder. It is `~/.pi-pocket`, unless `PI_POCKET_DIR` or the `--data` option gives another folder. The drop-in folder is `extensions/` in it.

### `agentDir`

```ts
readonly agentDir: string;
```

Since 0.1.0 · Stable

Pi's own folder, usually `~/.pi/agent`. Pi keeps its sign-ins, models, settings, skills, and prompt templates there.

## Skills

### `skillPaths`

```ts
skillPaths(): string[];
```

Since 0.1.0 · Stable

The extra skill folders that Pi's settings give.

### `skills`

```ts
skills(cwd: string): Skill[];
```

Since 0.12.0 · Stable

Pi's skills for a session that works in the folder `cwd`. The list has the skills from all the places where Pi looks.

### `globalSkills`

```ts
globalSkills(): Skill[];
```

Since 0.14.0 · Stable

The Coop host’s configured global skills, without consulting a project directory or project trust. SSH threads use this list with `host_skill` to read host resources without treating their paths as remote files.

### `projectResources`

```ts
projectResources(conversationId: ConversationId, context: Context): Promise<{ skills: Skill[] }>;
```

Since 0.15.0 · Experimental

The thread’s trusted project skills merged with the Coop host’s global skills, in normal project-first precedence. SSH resources are read through the pinned execution environment and require explicit host-owned project trust; their `sourceInfo.source` identifies the remote filesystem. Host-global paths remain host paths. Use `read` for remote resources and `host_skill` for registered host-global resources. The supplied context cancels remote reads. Remote failures never substitute a host-local project namesake.

### `workspace`

```ts
workspace(conversationId: ConversationId): {
    location?: { kind: "ssh"; host: string };
    env: ExecutionEnv;
};
```

Since 0.14.0 · Stable

A conversation’s actual file namespace and policy-gated execution environment. An omitted location means the Coop host, not the browser device. Subagents inherit their root thread’s location. Remote failures never return a local environment. Managed commands require native offline confinement on the target; unavailable confinement fails that operation without unrestricted fallback. Cached environments retain live requester, access, writer and publication controls. Trusted extensions must use this environment for project operations rather than interpreting remote cwd strings with Node filesystem APIs.

## Models

### `resolveModel`

```ts
resolveModel(spec: string): ModelRef;
```

Since 0.1.0 · Stable

Finds a model from `provider/modelId`, or from a model id alone. The model must be signed in, and its sign-in must work. When there is no such model, it throws an error. The error names no other models: the choice of model is the person's.

### `subagentModels`

```ts
subagentModels(): readonly string[];
```

Since 0.13.1 · Stable

The owner's shared model list, as `provider/modelId`, empty by default. The owner sets it in Settings → Providers → Models for subagents. Its meaning depends on the consumer:

- **Background subagents** always offer an optional `model` parameter. Omission inherits the parent model. An empty list leaves explicit model choices unrestricted; a nonempty list restricts extra models to its entries. The parent's model is always allowed. Thinking is fitted to the nearest supported level, including `max` and levels above the parent's; sending more work does not lower it.
- **Linked sessions (Agent Teams)** always treat this list as an allowlist of extra models. An empty list means parent-model only, not unrestricted. Thinking is capped at the source's level, then fitted to a supported level at or below that cap.

Neither policy bypasses model availability or sign-in checks. A drop-in reading this list must choose its own policy; the host returns the list, not a universal permission decision.

### `modelProblem`

```ts
modelProblem(ref: ModelRef, fresh?: boolean): Promise<string | undefined>;
```

Since 0.13.1 · Stable

Why Pi cannot use a model now, in words that Pi can tell a person. For example, Pi Pocket does not know the model, its provider is not signed in, or its sign-in expired. It is `undefined` when Pi can use the model. With `fresh: true`, it asks the provider about the sign-in again first.

### `thinkingLevels`

```ts
readonly thinkingLevels: readonly ModelThinkingLevel[];
```

Since 0.14.0 · Stable

The thinking levels, lowest first. They have the names that models and sessions use.

## People and limits

### `requesterOf`

```ts
requesterOf(conversationId: ConversationId): string | undefined;
```

Since 0.3.0 · Stable

The id of the person that Pi works for in a session now. This is the person whose message started Pi's current work.

### `heldBack`

```ts
heldBack(conversationId: ConversationId): string | undefined;
```

Since 0.12.0 · Stable

Why Pi cannot start work in a session now when nobody asked for it, for example to read a subagent's report. The reason is a spend limit: the session's limit, or the limit of the person who pays there. It is `undefined` when Pi can start.

### `onLimitsChanged`

```ts
onLimitsChanged(listener: () => void): () => void;
```

Since 0.12.0 · Stable

Calls `listener` each time the owner changes a spend limit. It returns a function: call it to stop.

## Notices and text

### `notice`

```ts
notice(level: NoticeLevel, message: string, conversationId?: ConversationId): void;
```

Since 0.1.0 · Stable

Reports something to the server's log and to the app. `level` is `"info"`, `"warning"`, or `"error"`. With `conversationId`, only the tabs of that session show the notice. Pi Pocket 0.13.1 added `conversationId`.

### `text`

```ts
readonly text: SafeText;
```

Since 0.14.0 · Stable

Makes text from other places safe for Pi to read: from a web page, an issue, or a file that a person did not write. In the same place, tell Pi that the text is data.

#### `text.quoted`

```ts
quoted(text: string, max?: number): string;
```

Since 0.14.0 · Stable

Gives the text as one line in quotes that the text cannot close. It removes invisible characters and tags, and it cuts the line to `max` characters. [Limits](limits.md#host) gives the default `max`.

#### `text.defang`

```ts
defang(text: string): string;
```

Since 0.14.0 · Stable

Keeps the lines of the text, but leaves no closing tag in it. Use it for text that you put between tags of your own.

## Independent sessions

### `sessions`

```ts
readonly sessions: SessionServices;
```

Since 0.15.0 · Experimental

Shared session machinery for workflow extensions. `sessions.linked` is the sole linked-peer entry
point. Agent Teams and Work Items are sibling consumers, not dependencies of each other.

#### `sessions.handoff`

```ts
handoff(
    request:
        | { action: "status" }
        | {
              action: "start";
              targetType: string;
              relationship?: "same-work" | "new-work";
              summary: string;
          },
    api: ToolExecutionApi,
    context: Context,
): Promise<unknown>;
```

Since 0.15.0 · Experimental

Accepts a request from a tool's actual `ToolExecutionApi` and Chord context. It returns a filtered state/options projection or the durable successor receipt.
`relationship` defaults to `"same-work"`; `summary` is nonempty and at most 12,000 characters.

Core derives the requester from the invocation and verifies an actually placed written human input
in its owning main run. A caller cannot supply a human identity or authority flag. Explicit slash
routes must match; schedules, helpers, synthetic summaries and incoming agent couriers do not confer
handoff authority. Missing or unavailable transitions reject, never substitute another destination.

The operation retains access, driving, spend, idleness, writer reservations and atomic transfer
checks. A committed receipt can be recovered after source retirement. Core retains summary and delivery
tasks solely to recover already-accepted data, including when Work Items is disabled; there is no
public summary-first admission or retry API. See [Handoffs](../../handoffs.md) and
[`web.workflow`](web.md#workflow).

## Linked sessions

### `sessions.linked`

```ts
readonly linked: LinkedSessions;
```

Since 0.15.0 · Experimental

Lets a tool start sessions from the session that it runs in, and send messages between them, as Agent Teams does. A linked session is an ordinary session. [Starting and messaging sessions](../linked-sessions.md) tells you how they work, what they cannot do, and how to call them.

Each call acts as the person that Pi works for in `source`, and that person's checks apply. Give each call a `key` that stays the same when the call runs again, such as `${api.taskId}:${api.callId}`. A second call with the same `key` does nothing again: it returns what the first call returned.

#### `sessions.linked.start`

```ts
start(
    source: ConversationId,
    request: { title?: string; message: string; model?: string; thinking?: string },
    key: string,
): Promise<{ session: ConversationId; address: string }>;
```

Since 0.14.0 · Experimental

Makes a session linked to `source` and sends it `message` as its first message. It returns the new session's id, and the address that `source` uses for it.

- The new session works in the folder of `source`. It gets a copy of the agent settings of `source`, but not its history.
- Without `title`, the title is the first line of `message`.
- `model` is `provider/modelId`. It must be the model of `source`, or an entry in `subagentModels()`. An empty list permits only the source's model for linked sessions, unlike background subagents. Without `model`, the session uses the model of `source`.
- `thinking` defaults to the level of `source`. A requested level above the source's is capped there, then fitted to the highest supported level at or below that cap. If the model has no such level, the start is refused.
- When Pi cannot use the model now, `start` makes nothing and throws an error.

#### `sessions.linked.send`

```ts
send(
    source: ConversationId,
    request: { to: string; message: string; steer?: boolean },
    key: string,
): Promise<void>;
```

Since 0.14.0 · Experimental

Sends `message` to the linked session at the address `to`. Without `steer`, the message is a follow-up. With `steer: true`, the session gets it at its next pause. `send` returns when the session takes the message, not when it answers.

The session that gets the message reads it between tags. Words before it say that the agent of another session wrote it, and that it is a request, not a person's order. They also give the address to reply to.

#### `sessions.linked.list`

```ts
list(source: ConversationId): Promise<LinkedSession[]>;
```

Since 0.14.0 · Experimental

The sessions linked to `source`, at any distance, that the person Pi works for can see. Each has an address of the `source` session's own, so no session id goes into its transcript.

#### `LinkedSession`

```ts
interface LinkedSession {
    address: string;
    title?: string;
    cwd?: string;
    busy?: boolean;
    archived?: boolean;
}
```

Since 0.14.0 · Experimental

A linked session, as `list` gives it.

- `address`: the address that the asking session uses for it. It is never the session's id.
- `title`, `cwd` (its folder), `busy` (Pi works in it now), and `archived`: these are there only when all the people who see the asking session see this session too.

## Internal members

The host has more members, for Pi Pocket's built-in modules only. They are not in the types file, and they can change in any release without notice. Do not use them in a drop-in. [API stability](../policies/api-stability.md) tells you what this means.

- `approvals`: tool calls that wait for a person to allow them.
- `guard`: Lancet Guard.
- `schedules`: scheduled messages, for the schedule tool.
- `goals`: Done when, for the goals module.
- `browsers`: the built-in browser, for the browser tool.
- `memory`: the lessons that Pi keeps across sessions, for the memory tool.
- `watches`: the pull request watches of sessions, for the `watch_pr` tool.
- `repoWatches`: the task of repository watches, for the triggers module.
- `pip`: what the tools of PiP, the owner's assistant, do.
- `pipCompaction`: PiP's own summaries when its context is compacted.
- `gallery`: the extension gallery, for its own routes.
