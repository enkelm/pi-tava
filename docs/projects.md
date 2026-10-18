# Projects and typed threads

Collab's sidebar opens **Projects** first, followed by **Recent** and **Archived**. Projects group threads and Work Items directly. Herdr remains a separate owner-only view.

## Organization

A project has a name and a default server-local working directory. Threads retain their existing durable conversation IDs, histories, permissions, model configuration and actual working directory. Their optional project ID organizes them independently of paths. Two projects can use the same folder; a worktree or directory override does not move a thread between projects.

Thread type is separate from placement:

- **Worker** has a blue agent tag. New project threads still default to Worker; research, optional planning and implementation can stay in the same thread.
- **Researcher** uses a brain icon and can start a new Work Item or investigate a pointed question mid-work. It produces cited findings and application guidance rather than implementing the feature; humans choose the next destination.
- **Chat** has a green speech-bubble tag. The one-time-chat flow starts an unassigned Chat.
- **Reviewer**, **Follow-up**, **Land** and **Publish** are successor types created through human-requested, agent-executed handoffs. Reviewer owns bounded independent review; Follow-up makes bounded review or Pull-intake repairs with a short delta self-review; Land performs authorized local integration and impact checks; Publish follows Land for individually approved external delivery. Entering Land is a human workflow choice, not a review/readiness/risk-acceptance gate or mutation permission.
- **Pull** reads upstream repository/PR/issue state and handles requested local rebases. It can start independently or be selected as a handoff at any stage.
- Moving a thread does not change its type. Threads grouped in a Work Item move together.

The first same-work handoff groups its source and successor in a **Work Item** named after the first thread. Later same-work successors join that item. Every active stage also offers Worker, Researcher and Pull as new-work starters, including the same starter type because it creates a distinct linked item. Same-work cannot repeat the current role consecutively. A human names a destination or describes the next task; the source agent infers a clear type or asks for clarification, then executes the handoff tool with its brief. Runtime state/history rules, not model readiness decisions, control which transitions can execute. Items can stand alone or belong directly to a project. Member threads cannot be archived independently. See [handoffs.md](handoffs.md) for the complete matrix and `/handoff` commands.

On upgrade, ordinary Collab catalogue entries without a type are durably marked Worker; untyped linked roots remain independent Chats. They stay unassigned and appear as ordinary rows, with no synthetic project or Unassigned section. Explicit types are not changed on later restarts. Private Herdr processes are not migrated.

A project's leading chevron folds its contents, and the thread count precedes its title. Its **+** action opens New Session prefilled for that project. Opening the popup does not create a thread. Create projects inside **New Session → New Project** rather than from a separate sidebar button. Project Add/Edit controls appear on desktop hover or keyboard focus. Right-click a header, use the Context Menu key / Shift+F10, or hold it on touch for Options; touch also has an explicit Options button.

Standalone threads show their path and current Git branch before any handoff groups them into a Work Item, including ordinary checkouts without a Coop-created worktree. A detached checkout shows its short commit instead; outside Git, the model remains the fallback context. On the right, the subagent count precedes the loading/state indicator, which is vertically centered with the time and other controls.

## Moving threads

Unrestricted steering participants can drag a sidebar thread onto a project. Hovering a collapsed project opens it; hovering **Projects** while dragging from Recent switches tabs, and the list scrolls at its edges. The **No project** drop target appears only during a drag, after the existing list content so project headers and rows do not shift. It clears project membership. Dropping outside a destination or pressing Escape cancels. Rows are not manually reordered.

Threads keep hover Archive/Pin; Move is available through Options → **Move to project…** using the project picker. On touch, hold a thread row, then slide onto **Drag** or **Options** and dwell: the selected half expands across the row and briefly fills before activating. A stationary initial hold never chooses a half. Switching halves restarts the dwell; early release, leaving the row, a second finger or cancellation does nothing. Drag continues under the same finger, including across sidebar tab changes; Options opens as a bottom sheet. Mobile rows omit the cog and use the hold chooser; desktop actions retain hover and context-menu access. Reduced motion keeps the activation delay without the expanding motion.

Selected rows can be dragged together or moved using **Move…** in the selection bar. Multi-row moves use separate transactions per independent thread or whole Work Item, so a rejected target stays put and partial failure is reported; the picker retries only failed targets. Moving never archives/restores a thread or starts model work. It changes project membership only, never history, thread type or working directory.

## New threads

**Start new** begins with projects. Selecting a project reveals the starter profile, directory and worktree controls. The project's directory is the default; it can be overridden without changing membership. **Start a one-time chat** skips project selection.

Starter choices come only from current registered profiles. The project default is the first starter other than core Chat; Work Items registers Worker before Researcher to retain its Worker default without a core role-name table. Explicit ordinary Chat still works independently when Work Items is off.

Confirming Start creates one thread directly in the selected project. Cancelling creates none. Creation retry receipts prevent duplicate conversations. Project selection performs no model request or naming work.

Project defaults affect new threads only. Moving an existing thread changes organization, never its directory. Ungrouped forks and resends retain source placement and thread type, actual directory/worktree and owner-only restrictions. Grouped handoff threads cannot fork or resend around Work Item ownership. Imports retain their source directory and initially remain unassigned Chats; import destination selection is not extended by this feature.

## Archive

Archive and restore operate on an independent thread or an entire Work Item. They do not remove project membership, change the thread's directory or delete its history. Member conversations cannot be archived independently. Existing archived threads stay archived until explicitly restored.

The separate **Done when** `/until` completion-check feature is unchanged.

## Storage and access

`pocket.projects` is a session-scoped durable document beside the existing catalogue. `pocket.session-creates` stores creation retry receipts. The existing document kinds, versions, scope and fork settings are unchanged. Project membership and thread type remain catalogue metadata.

Project membership never grants access or changes the Durable ownership tree. Existing owner-only imports, scoped invitations, steering rights, take-turns rules and spend limits still apply. Unrestricted steering participants can edit projects. Viewers can read the filtered catalogue but cannot edit. Session-scoped participants see only projects associated with their visible threads, without project default directories or unrelated empty projects. Whole-Work-Item edits that would touch a hidden thread reject as a whole.

The server sends the filtered catalogue in `projects` events on connection, membership changes and catalogue updates. Current handoff/profile choices come from the Work Items extension's registered declarations. Its browser picker and hints use public conversation-scoped interfaces and the normal human-input journal. Core tasks recover already-accepted summary/delivery data only; they do not provide an alternate admission path.

## Interface

- `GET /api/projects`: filtered project catalogue.
- `POST /api/projects`: create a project with name, directory and retry ID.
- `POST /api/projects/:id`: rename a project or change its creation-time directory default.
- `POST /api/sessions`: existing thread creation, with optional project, type and retry ID.
- `POST /api/sessions/:id`: existing metadata editing, including project placement.

`app.projects` owns validation, filtered projection and atomic organization changes; HTTP is only an adapter. Work Item movement uses the same placement validation and updates all members together. Agent-executed handoffs derive the authenticated requester from real human input in the current main run, enforce state-based transitions and commit successor creation, relationships, retry receipt, active-writer reservation and source retirement together. Summary delivery and guarded destination naming retain retry identity and exactly-once usage accounting. The tool supports status/start without readiness milestones. Autonomous project creation or arbitrary cross-thread prompting is not provided; adding project IDs alone does not grant that authority.
