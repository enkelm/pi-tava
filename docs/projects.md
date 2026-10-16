# Projects, goals and typed threads

Collab's sidebar opens **Projects** first, followed by **Recent** and **Archived**. Projects replace the former grouping by working directory. Herdr remains a separate owner-only view.

## Organization

A project has a name and a default server-local working directory. A goal belongs to exactly one project and groups threads; even a single-thread goal keeps its own section. Goals are **Active** or **Completed**. Completion is descriptive: it does not stop an agent, run a check or archive anything.

Threads retain their existing durable conversation IDs, histories, permissions, model configuration and actual working directory. Their optional project and goal IDs organize them independently of paths. Two projects can use the same folder; a worktree or directory override does not move a thread between projects.

Thread type is separate from placement:

- **Worker** has a blue agent tag. New project threads still default to Worker; research, optional planning and implementation can stay in the same thread.
- **Researcher** can start a new Work Item or investigate a pointed question mid-work. It produces cited findings and application guidance rather than implementing the feature; humans choose the next destination.
- **Chat** has a green speech-bubble tag. The one-time-chat flow starts an unassigned Chat.
- **Reviewer**, **Follow-up**, **Land** and **Publish** are successor types created through human-selected handoffs. Reviewer owns bounded independent review; Follow-up makes bounded review or Pull-intake repairs with a short delta self-review; Land performs authorized local integration and impact checks; Publish follows Land for individually approved external delivery. Entering Land is a human workflow choice, not a review/readiness/risk-acceptance gate or mutation permission.
- **Pull** reads upstream repository/PR/issue state and handles requested local rebases. It can start independently or be selected as a handoff at any stage.
- Moving a thread does not change its type. Threads grouped in a Work Item move together.

The first same-work handoff groups its source and successor in a **Work Item** named after the first thread. Later same-work successors join that item. Every active stage also offers Worker, Researcher and Pull as new-work starters, including the same starter type because it creates a distinct linked item. Same-work cannot repeat the current role consecutively. The human chooses from state/history-based destinations without model recommendations; the app then requests a tools-free source summary and creates the successor only after its reply. Items can stand alone or belong to a project and optional goal. Member threads cannot be archived independently. See [handoffs.md](handoffs.md) for the complete matrix and `/handoff` commands.

On upgrade, ordinary Collab catalogue entries without a type are durably marked Worker; untyped linked roots remain independent Chats. They stay unassigned and appear as ordinary rows, with no synthetic project or Unassigned section. Explicit types are not changed on later restarts. Private Herdr processes are not migrated.

Projects and goals collapse independently; a project’s leading chevron controls its fold. Goal rows align with project rows without an extra left indent. Their **+** actions open the same New Session popup, prefilled for that location. Opening a popup does not create a thread or goal. Create projects inside **New Session → New Project** rather than from a separate sidebar button. The goal’s leading title icon shows status: a target for Active and a green check for Completed, with a tooltip. Click that icon to change status without folding the goal, or use Options → **Mark completed / Mark active**. For readers, the leading icon is noninteractive. Project Add/Edit and goal Add/Archive appear on desktop hover or keyboard focus. Right-click a header, use the Context Menu key / Shift+F10, or hold it on touch for Options; touch also has an explicit Options button. All existing actions, including **Rename goal…**, remain in that menu. Cancel leaves a goal’s name unchanged and Save applies a nonempty, trimmed name.

Unrestricted steering participants can drag a sidebar thread onto a project or an unarchived goal. Hovering a collapsed section opens it; hovering **Projects** while dragging from Recent switches tabs, and the list scrolls at its edges. Dropping on a project's header places the thread directly in that project with no goal. The **No project** drop target appears only during a drag and clears both memberships. Dropping onto a nested goal moves to that goal, not its parent. Dropping outside a destination or pressing Escape cancels. Rows are not manually reordered.

Threads keep hover Archive/Pin; Move is available through Options → **Move to project or goal…** using the existing project/goal picker. On touch, hold a thread row, then slide onto **Drag** or **Options** and dwell: the selected half expands across the row and briefly fills before activating. A stationary initial hold never chooses a half. Switching halves restarts the dwell; early release, leaving the row, a second finger or cancellation does nothing. Drag continues under the same finger, including across sidebar tab changes; Options opens as a bottom sheet. The gear opens Options directly. Reduced motion keeps the activation delay without the expanding motion. Selected rows can be dragged together or moved using **Move…** in the selection bar. Multi-row moves use separate transactions per independent thread or whole Work Item, so a rejected target stays put and partial failure is reported; the picker retries only failed targets. Moving never archives/restores a thread or starts model work. Archived goals must be restored before accepting a thread.

## New threads and goals

**Start new** begins with projects. Selecting a project expands its goal choices, with **+ New Goal** first, followed by existing unarchived goals. A goal is optional. The project's directory is the default; it can be overridden without changing membership. A git worktree can still be requested. **Start a one-time chat** escapes project selection.

New Goal is a creation intent, not a naming form. Confirming Start creates the selected Worker, Researcher or Pull thread and an Active goal named **New goal** together. Cancelling leaves neither behind. The first message reserves a durable background naming task. A small available model of that thread's provider writes the goal's name; the response does not replace or interrupt the thread's ordinary answer. Usage, the accepted name and task completion commit together. A short message-derived name is the fallback when no naming model is available or the request fails. A manual rename wins over a delayed AI result.

A restart resumes a reserved naming task. Scheduled first messages also reserve naming. Startup repairs an admission interrupted before naming was reserved; a later message also repairs it using the durable first input, not the later message. An untouched empty thread leaves its goal unnamed until the first message. Project goals are unrelated to the existing **Done when** `/until` completion-check documents and tools.

Project defaults affect new threads only. Moving an existing thread changes organization, never its directory. Ungrouped forks and resends retain source placement and thread type, actual directory/worktree and owner-only restrictions. Grouped handoff threads cannot fork or resend around Work Item ownership. A fork within an archived goal remains archived. Imports retain their source directory and initially remain unassigned Chats; import destination selection is not extended by this feature.

## Archive

Archiving a goal atomically archives the goal and all of its threads. The bulk operation does not stop running work or delete history. Previously archived threads are left archived when the goal is restored; only threads marked by that goal's bulk archive are restored with it.

For an independent thread, a later explicit archive/unarchive removes its bulk-archive marker. Restoring one thread reveals its goal but does not restore other archived threads. Bulk archive operations retain thread recency ordering. Completing a goal is independent of archiving it.

## Storage and access

`pocket.projects` is a new session-scoped durable document beside the existing catalogue. `pocket.session-creates` stores creation retry receipts. The existing `pocket.sessions` kind, version and scope are unchanged; membership, type and bulk-archive markers are additive fields.

Project membership never grants access or changes the Durable ownership tree. Existing owner-only imports, scoped invitations, steering rights, take-turns rules and spend limits still apply. Unrestricted steering participants can edit projects and goals. Viewers can read the filtered catalogue but cannot edit. Session-scoped participants see only the projects/goals associated with their visible threads, without project default directories or unrelated empty groups. Goals occupied exclusively by threads hidden from a participant are omitted, and a remembered goal ID cannot be used to join them. Bulk edits that would touch a hidden thread reject as a whole.

The server sends the filtered catalogue in `projects` events on connection, membership changes and catalogue updates. `hello.server.projects >= 1` gates the project UI so saving web files before restarting the server does not break the running older server. `hello.server.handoffs >= 2` enables independent Pull creation on updated servers. Version 3 adds Researcher handoffs and constrained Worker/Researcher/Follow-up research access. Version 4 adds Researcher starters and human-chosen state-based summary handoffs; neither changes the Worker default or legacy migration.

## Interface

- `GET /api/projects`: filtered project and goal catalogue.
- `POST /api/projects`: create a project with name, directory and retry ID.
- `POST /api/projects/:id`: rename a project or change its creation-time directory default.
- `POST /api/project-goals/:id`: rename, complete/reopen, archive/restore a goal.
- `POST /api/sessions`: existing thread creation, with optional project, goal, new-goal intent, type and retry ID.
- `POST /api/sessions/:id`: existing metadata editing, extended with project/goal placement.

`app.projects` owns validation, filtered projection and atomic organization changes; HTTP is only an adapter. Work Item movement uses the same placement validation and updates all members together. Durable handoffs derive the authenticated requester, persist the chosen destination before asking for a source summary, then commit successor creation, relationships, active-writer reservation and source retirement together. Summary delivery and guarded destination naming retain retry identity and exactly-once usage accounting. The agent handoff tool reports status only. Autonomous project/goal creation or arbitrary cross-thread prompting is not provided; adding project IDs alone does not grant that authority.
