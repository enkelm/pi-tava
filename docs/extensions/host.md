# Using the host

The host is the first argument of a module's default export. A module gets the app's services only through the host, and adds to the app through `web` ([Adding to the app](app.md)). The host stays the same while modules load again. Its members are in [the host reference](reference/host.md).

## Public and internal members

[The host reference](reference/host.md) lists the public members, and the types file has them. The host has more members, for Pi Pocket's built-in modules only, such as `pip`, `gallery`, and `memory`. They are internal: they are not in the types file, and they can change in any release. Do not use them in a drop-in ([API stability](policies/api-stability.md)).

## Text from other places

Text from a web page, an issue, or a file that a person did not write can try to steer Pi. Before you put such text in a prompt section or a tool's result, make it safe with `host.text`, and tell Pi in the same place that it is data:

- `host.text.quoted(text, max)` gives one line in quotes that the text cannot close. It removes invisible characters and tags, and cuts the line to `max` characters, or to a [default length](reference/limits.md#host).
- `host.text.defang(text)` keeps the lines, but leaves no closing tag in them. Use it for text that you put between tags of your own.

## Keep source versions aligned

Pi Pocket reloads extension modules while the server runs, but host changes need a restart. Server
and browser source target the same current public API. After changing host code, finish the change
and ask the owner to restart; do not add compatibility aliases or older-host fallback branches.

Independent sessions use `host.sessions`: `sessions.linked` starts/messages linked peers, while
`sessions.handoff` derives handoff authority from the actual tool invocation and placed human input.
There is no top-level linked-peer alias. See [the session reference](reference/host.md#sessions).

## Types

To get the types of the host in your editor, import them from `_pocket.d.ts`. Pi Pocket links this file into the drop-in folder:

```typescript
import type { Host, Web } from "./_pocket.d.ts";

export default function createMyModule(host: Host, web: Web) {
    // …
}
```

Use `import type`. Node removes this import when the module runs, so the path only matters to your editor and the type checker. See [Types for your editor](reference/types.md).
