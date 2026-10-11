# Projects, goals and typed threads

Collab's sidebar opens **Projects** first, followed by **Recent** and **Archived**. Projects replace the former grouping by working directory. Herdr remains a separate owner-only view.

## Organization

A project has a name and a default server-local working directory. A goal belongs to exactly one project and groups threads; even a single-thread goal keeps its own section. Goals are **Active** or **Completed**. Completion is descriptive: it does not stop an agent, run a check or archive anything.

Threads retain their existing durable conversation IDs, histories, permissions, model configuration and actual working directory. Their optional project and goal IDs organize them independently of paths. Two projects can use the same folder; a worktree or directory override does not move a thread between projects.

Thread type is separate from placement:

- **Worker** has a blue agent tag. New project threads default to Worker.
- **Chat** has a green speech-bubble tag. The one-time-chat flow starts an unassigned Chat.
- Moving a Chat into a project or goal does not turn it into a Worker, and moving a Worker out does not turn it into a Chat.

On upgrade, existing Collab catalogue entries without a type are durably marked Worker. They stay unassigned and appear as ordinary rows, with no synthetic project or Unassigned section. Explicitly typed Chats are not changed on later restarts. Private Herdr processes are not migrated.

Projects and goals collapse independently; a project’s leading chevron controls its fold. Their **+** actions open the same New Session popup, prefilled for that location. Opening a popup does not create a thread or goal. Create projects inside **New Session → New Project** rather than from a separate sidebar button. A goal’s pencil opens **Rename goal**; Cancel leaves its name unchanged and Save applies a nonempty, trimmed name.

Unrestricted steering participants can drag a sidebar thread onto a project or an unarchived goal. Hovering a collapsed section opens it; hovering **Projects** while dragging from Recent switches tabs, and the list scrolls at its edges. Dropping on a project's header places the thread directly in that project with no goal. The **No project** drop target appears only during a drag and clears both memberships. Dropping onto a nested goal moves to that goal, not its parent. Dropping outside a destination or pressing Escape cancels. Rows are not manually reordered.

The row's **Move session** button opens a project/goal picker for touch and keyboard use. Selected rows can be dragged together or moved using **Move…** in the selection bar. Multi-thread moves use separate thread transactions, so a rejected thread stays put and partial failure is reported; the picker retries only failed threads. Moving never archives/restores a thread or starts model work. Archived goals must be restored before accepting a thread.

## New threads and goals

**Start new** begins with projects. Selecting a project expands its goal choices, with **+ New Goal** first, followed by existing unarchived goals. A goal is optional. The project's directory is the default; it can be overridden without changing membership. A git worktree can still be requested. **Start a one-time chat** escapes project selection.

New Goal is a creation intent, not a naming form. Confirming Start creates the worker and an Active goal named **New goal** together. Cancelling leaves neither behind. The first worker message reserves a durable background naming task. A small available model of that worker's provider writes the goal's name; the response does not replace or interrupt the worker's ordinary answer. Usage, the accepted name and task completion commit together. A short message-derived name is the fallback when no naming model is available or the request fails. A manual rename wins over a delayed AI result.

A restart resumes a reserved naming task. Scheduled first messages also reserve naming. Startup repairs an admission interrupted before naming was reserved; a later message also repairs it using the durable first input, not the later message. An untouched empty worker leaves its goal unnamed until the first message. Project goals are unrelated to the existing **Done when** `/until` completion-check documents and tools.

Project defaults affect new threads only. Moving an existing thread changes organization, never its directory. Forks and resends retain source placement and thread type, actual directory/worktree and owner-only restrictions. A fork within an archived goal remains archived. Imports retain their source directory and initially remain unassigned Chats; import destination selection is not extended by this feature.

## Archive

Archiving a goal atomically archives the goal and all of its threads. The bulk operation does not stop running work or delete history. Previously archived threads are left archived when the goal is restored; only threads marked by that goal's bulk archive are restored with it.

A later explicit archive/unarchive of one thread removes its bulk-archive marker. Restoring one thread reveals its goal but does not restore other archived threads. Bulk archive operations retain thread recency ordering. Completing a goal is independent of archiving it.

## Storage and access

`pocket.projects` is a new session-scoped durable document beside the existing catalogue. `pocket.session-creates` stores creation retry receipts. The existing `pocket.sessions` kind, version and scope are unchanged; membership, type and bulk-archive markers are additive fields.

Project membership never grants access or changes the Durable ownership tree. Existing owner-only imports, scoped invitations, steering rights, take-turns rules and spend limits still apply. Unrestricted steering participants can edit projects and goals. Viewers can read the filtered catalogue but cannot edit. Session-scoped participants see only the projects/goals associated with their visible threads, without project default directories or unrelated empty groups. Goals occupied exclusively by threads hidden from a participant are omitted, and a remembered goal ID cannot be used to join them. Bulk edits that would touch a hidden thread reject as a whole.

The server sends the filtered catalogue in `projects` events on connection, membership changes and catalogue updates. `hello.server.projects >= 1` gates the new UI so saving web files before restarting the server does not break the running older server.

## Interface

- `GET /api/projects`: filtered project and goal catalogue.
- `POST /api/projects`: create a project with name, directory and retry ID.
- `POST /api/projects/:id`: rename a project or change its creation-time directory default.
- `POST /api/project-goals/:id`: rename, complete/reopen, archive/restore a goal.
- `POST /api/sessions`: existing thread creation, with optional project, goal, new-goal intent, type and retry ID.
- `POST /api/sessions/:id`: existing metadata editing, extended with project/goal placement.

`app.projects` owns validation, filtered projection and atomic organization changes; HTTP is only an adapter. Durable agent tools for creating independent threads and prompting other threads remain later work. Those tools will need authenticated requester derivation, invocation-bound commits, durable delivery and task/call retry identity; adding project IDs is not sufficient to make cross-thread prompting safe.
