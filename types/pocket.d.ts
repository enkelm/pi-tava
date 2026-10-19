/**
 * Pi Pocket's public extension API: what a module gets on the server (`Host`, `Web`, `CommandContext`), and what its
 * browser module gets in the app (`Pocket`).
 *
 * Import these types with `import type`. Node erases that import, so it has no effect when the module runs. Do not use
 * `import { type … }`: the gallery's check reads it as an import that runs.
 *
 * ```ts
 * import type { Host, Web } from "./_pocket.d.ts";
 * ```
 *
 * `@since` gives the first Pi Pocket release that has a member. `@experimental` marks a member that can change in any
 * release. A member without it is stable. The reference is in `docs/extensions/reference/`. `test/public-types.ts`
 * fails when this file and Pi Pocket's code do not agree.
 */
import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Skill } from "@earendil-works/pi-coding-agent";
import type {
    ConversationId,
    DocumentReader,
    Extension,
    ModelRef,
    Tx,
    ToolExecutionApi,
} from "@earendil-works/pi-durable";
import type { ComponentType, Fragment, FunctionComponent, h, VNode } from "preact";
import type {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useReducer,
    useRef,
    useState,
} from "preact/hooks";

// ─── Common ──────────────────────────────────────────────────────────────────

/**
 * A person's role in Pi Pocket.
 * @since 0.14.0
 */
export type Role = "owner" | "guest" | "viewer";

/**
 * A person: who sent a request, ran a command, or uses a tab.
 * @since 0.14.0
 */
export interface Person {
    /**
     * The person's id.
     * @since 0.14.0
     */
    readonly id: string;
    /**
     * The person's name, as the app shows it.
     * @since 0.14.0
     */
    readonly name: string;
    /**
     * The person's role.
     * @since 0.14.0
     */
    readonly role: Role;
}

/**
 * How important a notice is.
 * @since 0.1.0
 */
export type NoticeLevel = "info" | "warning" | "error";

// ─── The module ──────────────────────────────────────────────────────────────

/**
 * A module: one `.ts` file in the drop-in folder (or `src/server/extensions/`) that default-exports a setup function.
 * @since 0.1.0
 */
export interface Module {
    /**
     * Sets up the module. Returns its extensions: one, a list, or nothing when it only adds to the app. It can be async.
     * @since 0.1.0
     */
    default(
        host: Host,
        web: Web,
    ): Extension | readonly Extension[] | void | Promise<Extension | readonly Extension[] | void>;
    /**
     * The version of the extension API that the module needs. An older Pi Pocket does not set it up.
     * @since 0.14.0
     */
    pocketApi?: number;
}

/** Independent-session operations shared by workflow extensions.
 * @since 0.15.0
 * @experimental
 */
export interface SessionServices {
    /**
     * Linked peers retain their existing permissions, model limits, receipts and nonhuman relay provenance.
     * @since 0.15.0
     * @experimental
     */
    readonly linked: LinkedSessions;
    /**
     * Core derives authority from actual placed human input in this invocation; declarations grant none.
     * @since 0.15.0
     * @experimental
     */
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
}

// ─── The host ────────────────────────────────────────────────────────────────

/**
 * What the app gives a module: the first argument of its default export. The host stays the same while modules reload.
 * It changes only when the server restarts.
 * @since 0.1.0
 */
export interface Host {
    /**
     * Pi Pocket's data folder.
     * @since 0.1.0
     */
    readonly dataDir: string;
    /**
     * Pi's own folder, usually `~/.pi/agent`.
     * @since 0.1.0
     */
    readonly agentDir: string;
    /**
     * The extra skill folders in Pi's settings.
     * @since 0.1.0
     */
    skillPaths(): string[];
    /**
     * Pi's skills for a session that works in `cwd`, from all the places where Pi looks.
     * @since 0.12.0
     */
    skills(cwd: string): Skill[];
    /** Host-global skills only, without consulting any project directory. @since 0.14.0 */
    globalSkills(): Skill[];
    /**
     * Skills in this conversation's actual namespace. SSH threads merge explicitly trusted remote project skills
     * before host-global skills; local threads retain normal discovery. Host paths are never remote file paths.
     * Read-only remote discovery can fail; no host-local project namesake is substituted. Bind during module setup
     * so a module needing this API cannot install on a live host that predates it.
     * @since 0.15.0
     * @experimental
     */
    projectResources(
        conversationId: ConversationId,
        context: Context,
    ): Promise<{ skills: Skill[] }>;
    /** The actual thread namespace and policy-gated environment; subagents inherit the root target. @since 0.14.0 */
    workspace(conversationId: ConversationId): {
        location?: { kind: "ssh"; host: string };
        env: ExecutionEnv;
    };
    /**
     * Finds a model by `provider/modelId` (or a model id alone) that is signed in and whose sign-in works. Throws an
     * error when there is none. The error names no other models.
     * @since 0.1.0
     */
    resolveModel(spec: string): ModelRef;
    /**
     * The owner's shared model list, as `provider/modelId`, empty by default. For background subagents, empty leaves
     * explicit choices unrestricted; nonempty restricts extra models. The parent's model is always allowed. Linked
     * sessions always use this as an extra-model allowlist: empty means parent only. Availability checks still apply.
     * @since 0.13.1
     */
    subagentModels(): readonly string[];
    /**
     * Why Pi cannot use a model now (not known, not signed in, or the sign-in expired), or undefined when it can. With
     * `fresh`, it asks the provider again first.
     * @since 0.13.1
     */
    modelProblem(ref: ModelRef, fresh?: boolean): Promise<string | undefined>;
    /**
     * The id of the person that Pi works for in a session now: the person whose message started its current work.
     * @since 0.3.0
     */
    requesterOf(conversationId: ConversationId): string | undefined;
    /**
     * Reports something to the server log and to the app. With `conversationId` (since 0.13.1), only that session's
     * tabs show it.
     * @since 0.1.0
     */
    notice(level: NoticeLevel, message: string, conversationId?: ConversationId): void;
    /**
     * Why Pi cannot start work in a session when nobody asked for it (a spend limit), or undefined when it can.
     * @since 0.12.0
     */
    heldBack(conversationId: ConversationId): string | undefined;
    /**
     * Calls `listener` when the owner changes a spend limit. Returns a function that stops it.
     * @since 0.12.0
     */
    onLimitsChanged(listener: () => void): () => void;
    /** Shared session operations; workflow declarations cannot widen core permissions.
     * @since 0.15.0
     * @experimental
     */
    readonly sessions: SessionServices;
    /**
     * Makes text from other places safe for Pi to read.
     * @since 0.14.0
     */
    readonly text: SafeText;
    /**
     * The thinking levels, lowest first, with the names that models and sessions use.
     * @since 0.14.0
     */
    readonly thinkingLevels: readonly ModelThinkingLevel[];
}

/**
 * Makes text from other places safe for Pi to read. Tell Pi in the same place that the text is data.
 * @since 0.14.0
 */
export interface SafeText {
    /**
     * The text as one line in quotes that it cannot close, cut to `max` characters, without invisible characters or
     * tags.
     * @since 0.14.0
     */
    quoted(text: string, max?: number): string;
    /**
     * The text with its lines, but with no closing tag left in it: for text between tags of your own.
     * @since 0.14.0
     */
    defang(text: string): string;
}

/**
 * Sessions that a session starts and sends messages to. Each call acts as the person that Pi works for in `source`,
 * with that person's checks. A call again with the same `key` acts once, and returns what the first call returned.
 * @since 0.14.0
 * @experimental
 */
export interface LinkedSessions {
    /**
     * Starts a session linked to `source`, in its folder, and sends it `message` as its first message. `model` is
     * `provider/modelId`: the source's or an entry in `subagentModels()` (empty means source only). Thinking is capped
     * at the source's, then fitted to the highest level the model supports at or below that cap.
     * @since 0.14.0
     * @experimental
     */
    start(
        source: ConversationId,
        request: { title?: string; message: string; model?: string; thinking?: string },
        key: string,
    ): Promise<{ session: ConversationId; address: string }>;
    /**
     * Sends `message` to the linked session at the address `to`: as a follow-up, or with `steer` at its next pause.
     * @since 0.14.0
     * @experimental
     */
    send(
        source: ConversationId,
        request: { to: string; message: string; steer?: boolean },
        key: string,
    ): Promise<void>;
    /**
     * The sessions linked to `source`, at any distance, that the person Pi works for there can see.
     * @since 0.14.0
     * @experimental
     */
    list(source: ConversationId): Promise<LinkedSession[]>;
}

/**
 * A linked session, as `list` gives it to the session that asks.
 * @since 0.14.0
 * @experimental
 */
export interface LinkedSession {
    /**
     * The asking session's address for it. It is never the session's id.
     * @since 0.14.0
     * @experimental
     */
    address: string;
    /**
     * Its title: only when everyone who sees the asking session also sees this one.
     * @since 0.14.0
     * @experimental
     */
    title?: string;
    /**
     * Its folder, with the same condition as `title`.
     * @since 0.14.0
     * @experimental
     */
    cwd?: string;
    /**
     * Whether Pi works in it now, with the same condition as `title`.
     * @since 0.14.0
     * @experimental
     */
    busy?: boolean;
    /**
     * Whether it is archived, with the same condition as `title`.
     * @since 0.14.0
     * @experimental
     */
    archived?: boolean;
}

// ─── web: the module's part of the app ───────────────────────────────────────

/**
 * Role access for routes and browser modules. App-wide parts exclude session invitees;
 * conversation-scoped routes also require current source visibility and permit scoped invitees.
 * @since 0.14.0
 */
export type WebAccess = "owner" | "steer" | "view";

/**
 * Static browser assets may opt into conversation-scoped use, including session invitees.
 * This grants no app-wide route access.
 * @since 0.15.0
 * @experimental
 */
export type WebClientAccess = WebAccess | "conversation";

/**
 * The HTTP methods of routes.
 * @since 0.14.0
 */
export type WebMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * A request to a route, as its handler gets it.
 * @since 0.14.0
 */
export interface WebRequest {
    /**
     * The request's method.
     * @since 0.14.0
     */
    readonly method: WebMethod;
    /**
     * The values of the path's `:name` parts, by name.
     * @since 0.14.0
     */
    readonly params: Readonly<Record<string, string>>;
    /**
     * The query string.
     * @since 0.14.0
     */
    readonly query: URLSearchParams;
    /**
     * The JSON object that the browser sent. It is empty for GET and DELETE.
     * @since 0.14.0
     */
    readonly body: Readonly<Record<string, unknown>>;
    /**
     * The person who sent the request.
     * @since 0.14.0
     */
    readonly user: Person;
    /**
     * Aborts when the browser stops waiting for the answer.
     * @since 0.14.0
     */
    readonly signal: AbortSignal;
}

/**
 * Answers a route's requests. The value it returns goes back as JSON (`undefined` as `{}`).
 * @since 0.14.0
 */
export type WebHandler = (request: WebRequest) => unknown;

/**
 * Core operations bound to the authenticated route's current person and visible conversation.
 * @since 0.15.0
 * @experimental
 */
export interface SessionRequestServices {
    readonly transfers: {
        /** Access-filtered state and choices; does not start or retry a transfer. */
        status(): Promise<unknown>;
        /** Update the visible group under core's access, driving and membership checks. */
        updateGroup(patch: Readonly<Record<string, unknown>>): Promise<void>;
    };
}

/**
 * A conversation-scoped extension request. Services cannot be rebound to another user or source.
 * @since 0.15.0
 * @experimental
 */
export interface SessionWebRequest extends WebRequest {
    readonly conversationId: ConversationId;
    readonly session: SessionRequestServices;
}

/**
 * Answers a conversation-scoped extension route with JSON, as WebHandler does.
 * @since 0.15.0
 * @experimental
 */
export type SessionWebHandler = (request: SessionWebRequest) => unknown;

/**
 * A named agent playbook. Profiles are descriptive data, never execution capabilities or mutation permission.
 * @since 0.15.0
 * @experimental
 */
export interface AgentProfile {
    /**
     * Stable identity, prefixed with the registering module's name and `:`. Keep it once sessions use it.
     * @since 0.15.0
     * @experimental
     */
    readonly id: string;
    /**
     * The display name.
     * @since 0.15.0
     * @experimental
     */
    readonly name: string;
    /**
     * A short description of the agent's responsibility.
     * @since 0.15.0
     * @experimental
     */
    readonly description: string;
    /**
     * Role-specific system instructions. Core's shared safety and workflow rules remain in effect.
     * @since 0.15.0
     * @experimental
     */
    readonly prompt: string;
    /**
     * The default title for a session with this profile.
     * @since 0.15.0
     * @experimental
     */
    readonly title: string;
    /**
     * The name of an app icon, used by generic profile indicators.
     * @since 0.15.0
     * @experimental
     */
    readonly icon?: string;
    /**
     * Whether people may choose this profile when starting independent work; defaults to false.
     * @since 0.15.0
     * @experimental
     */
    readonly starter?: boolean;
}

/**
 * A declarative handoff choice between profiles within one workflow. Core still checks permission and live state.
 * @since 0.15.0
 * @experimental
 */
export interface SessionWorkflowTransition {
    /**
     * The source profile's stable identity.
     * @since 0.15.0
     * @experimental
     */
    readonly from: string;
    /**
     * The destination profile's stable identity.
     * @since 0.15.0
     * @experimental
     */
    readonly to: string;
    /**
     * Whether the successor continues the Work Item or begins new work.
     * @since 0.15.0
     * @experimental
     */
    readonly relationship: "same-work" | "new-work";
    /**
     * When supplied, at least one of these profile identities must occur in the Work Item's thread history.
     * @since 0.15.0
     * @experimental
     */
    readonly historyAny?: readonly string[];
    /**
     * When supplied, core requires the current checkout to have this dirty (true) or clean (false) state.
     * @since 0.15.0
     * @experimental
     */
    readonly currentDiff?: boolean;
}

/**
 * Profiles and handoff choices installed atomically with one extension module. Disabling it removes availability,
 * never stored identities or core's safety checks. Definitions are validated, cloned and deeply frozen.
 * @since 0.15.0
 * @experimental
 */
export interface SessionWorkflow {
    /**
     * Stable identity, prefixed with the registering module's name and `:`. Keep it once sessions use it.
     * @since 0.15.0
     * @experimental
     */
    readonly id: string;
    /**
     * The workflow's profiles, with unique stable identities.
     * @since 0.15.0
     * @experimental
     */
    readonly profiles: readonly AgentProfile[];
    /**
     * Handoff choices. Each from/to/relationship tuple is unique and references profiles in this workflow only.
     * @since 0.15.0
     * @experimental
     */
    readonly transitions: readonly SessionWorkflowTransition[];
}

/**
 * What a module adds to the app: the second argument of its default export. Register routes, the browser module,
 * commands and workflows while the module loads. They go when this version of the module goes.
 * @since 0.14.0
 */
export interface Web {
    /**
     * The version of the extension API.
     * @since 0.14.0
     */
    readonly api: number;
    /**
     * The module's name: its file's name without `.ts`.
     * @since 0.14.0
     */
    readonly module: string;
    /**
     * Adds a route at `/api/x/<module>/<path>`. A part of `path` written `:name` matches any one part.
     * @since 0.14.0
     */
    route(
        method: WebMethod,
        path: string,
        handle: WebHandler,
        options?: { access?: WebAccess },
    ): void;
    /**
     * Sets the browser module: a `.js` file beside the module, or a folder with an `index.js`.
     * @since 0.14.0
     */
    client(entry: string, options?: { access?: WebClientAccess }): void;
    /**
     * Adds a route at `/api/c/:id/x/<module>/<path>`, after current visibility and role checks.
     * Scoped invitees may use it; services are bound to the authenticated person and conversation.
     * @since 0.15.0
     * @experimental
     */
    sessionRoute(
        method: WebMethod,
        path: string,
        handle: SessionWebHandler,
        options?: { access?: WebAccess },
    ): void;
    /**
     * Adds the command `/name` to the message box.
     * @since 0.14.0
     */
    command(name: string, command: Command): void;
    /**
     * Registers declarative profiles and handoff choices while the module loads. They go with this module version.
     * IDs use `<module>:<local-id>`; only the built-in work-items module may register the reserved legacy identities.
     * Definitions grant no capabilities and cannot relax core's access, ownership, spend or execution checks.
     * @since 0.15.0
     * @experimental
     */
    workflow(definition: SessionWorkflow): void;
    /**
     * Sends an event to the browser module: to everyone it loads for, or to the person `to`. It never throws.
     * @since 0.14.0
     */
    send(event: string, data?: unknown, options?: { to?: string }): void;
    /**
     * Makes an error for a route or command to throw. The person who asked gets `status` and `message` as they are.
     * @since 0.14.0
     */
    error(status: number, message: string): Error;
    /**
     * Runs `dispose` when this version of the module goes. It can return a promise.
     * @since 0.14.0
     */
    onDispose(dispose: () => unknown): void;
}

// ─── Commands ────────────────────────────────────────────────────────────────

/**
 * A command that people run from the message box, without asking Pi.
 * @since 0.14.0
 */
export interface Command {
    /**
     * What the command does, for the message box's suggestions.
     * @since 0.14.0
     */
    description: string;
    /**
     * A hint for the arguments, in words, such as `"[zone]"`.
     * @since 0.14.0
     */
    args?: string;
    /**
     * Who can run it: `"conversation"`, a person who can steer the session; `"global"`, the owner alone.
     * @since 0.14.0
     */
    scope: "conversation" | "global";
    /**
     * Runs the command. `args` is all the text after the name.
     * @since 0.14.0
     */
    handler(args: string, context: CommandContext): CommandResult | Promise<CommandResult>;
}

/**
 * Who ran a command and where, with the durable task that runs it.
 * @since 0.14.0
 */
export interface CommandContext {
    /**
     * The person who ran the command.
     * @since 0.14.0
     */
    readonly user: Person;
    /**
     * The session where the person ran it.
     * @since 0.14.0
     */
    readonly conversationId: ConversationId;
    /**
     * The session's folder.
     * @since 0.14.0
     */
    readonly cwd: string;
    /**
     * Aborts when a person stops the command.
     * @since 0.14.0
     */
    readonly signal: AbortSignal;
    /**
     * Reads a document: `ctx.snapshot(Doc, ctx.conversationId, ctx.context)`.
     * @since 0.14.0
     */
    readonly snapshot: DocumentReader["snapshot"];
    /**
     * The task's context, for `snapshot` and other calls to Pi Durable.
     * @since 0.14.0
     */
    readonly context: Context;
    /**
     * Changes documents in one commit, and returns what `change` returns.
     * @since 0.14.0
     */
    commit<T>(change: (tx: Tx) => T | Promise<T>): Promise<T>;
}

/**
 * What a command returns: a notice for the person who ran it, or a card of plain text in the session.
 * @since 0.14.0
 */
export type CommandResult =
    { type: "toast"; level: NoticeLevel; message: string } | { type: "card"; output: string };

// ─── pocket: the browser module's API ────────────────────────────────────────

/**
 * A browser module: the `.js` file that the app loads in the tabs of the people it is for.
 * @since 0.14.0
 */
export interface BrowserModule {
    /**
     * Sets up the browser module. A function that it returns runs when this version goes.
     * @since 0.14.0
     */
    default(pocket: Pocket): void | (() => void) | Promise<void | (() => void)>;
    /**
     * The version of the extension API that the browser module needs.
     * @since 0.14.0
     */
    pocketApi?: number;
}

/**
 * What a rail button, menu row, or launcher action does when a person uses it: exactly one of these.
 * @since 0.14.0
 */
export type Action =
    | { page: string; sheet?: never; run?: never }
    | { sheet: string; page?: never; run?: never }
    | { run: () => unknown; page?: never; sheet?: never };

/**
 * A button on the rail.
 * @since 0.14.0
 */
export type RailSpec = Action & {
    /**
     * The button's id in the module.
     * @since 0.14.0
     */
    id: string;
    /**
     * The button's label.
     * @since 0.14.0
     */
    title: string;
    /**
     * The name of one of the app's icons.
     * @since 0.14.0
     */
    icon?: string;
    /**
     * An icon of your own: a stroked path in a 24 × 24 box.
     * @since 0.14.0
     */
    iconPath?: string;
    /**
     * A short count or word on the button.
     * @since 0.14.0
     */
    badge?: number | string | null | false;
};

/**
 * A row in the menu's App group.
 * @since 0.14.0
 */
export type MenuSpec = Action & {
    /**
     * The row's id in the module.
     * @since 0.14.0
     */
    id: string;
    /**
     * The row's label.
     * @since 0.14.0
     */
    label: string;
    /**
     * A short hint on the right of the row.
     * @since 0.14.0
     */
    hint?: string;
};

/**
 * An action in the launcher.
 * @since 0.14.0
 */
export type LauncherSpec = Action & {
    /**
     * The action's id in the module.
     * @since 0.14.0
     */
    id: string;
    /**
     * The action's label.
     * @since 0.14.0
     */
    label: string;
    /**
     * A line under the label. By default, the module's title.
     * @since 0.14.0
     */
    detail?: string;
    /**
     * The name of one of the app's icons.
     * @since 0.14.0
     */
    icon?: string;
    /**
     * An icon of your own: a stroked path in a 24 × 24 box.
     * @since 0.14.0
     */
    iconPath?: string;
    /**
     * More words that find the action when a person types them.
     * @since 0.14.0
     */
    keywords?: string[];
};

/**
 * What the component of a page or sheet gets.
 * @since 0.14.0
 */
export interface PageProps {
    /**
     * The `pocket` of the module's version that added the page or sheet.
     * @since 0.14.0
     */
    pocket: Pocket;
    /**
     * Closes this page or sheet while it shows. Later, it closes nothing.
     * @since 0.14.0
     */
    close(): void;
}

/**
 * What a sheet's component gets: the flat props that `openSheet` gave, plus the host's callbacks.
 * @since 0.14.0
 */
export type SheetProps<P extends object = object> = P &
    PageProps & {
        /**
         * Whether this actual opening is still current, not merely retained for its closing animation.
         * A newer opening of the same sheet ID does not match.
         * @since 0.15.0
         * @experimental
         */
        isOpen(): boolean;
    };

/**
 * A page in the place of the session.
 * @since 0.14.0
 */
export interface PageSpec {
    /**
     * The page's id in the module.
     * @since 0.14.0
     */
    id: string;
    /**
     * The page's title.
     * @since 0.14.0
     */
    title: string;
    /**
     * What the page shows.
     * @since 0.14.0
     */
    component: ComponentType<PageProps>;
    /**
     * With `false`, Esc does not close the page.
     * @since 0.14.0
     */
    escape?: boolean;
    /**
     * With `false`, no swipe on the page goes back.
     * @since 0.14.0
     */
    swipe?: boolean;
}

/**
 * A sheet, as the app's own sheets.
 * @since 0.14.0
 */
export interface SheetSpec<P extends object = object> {
    /**
     * The sheet's id in the module.
     * @since 0.14.0
     */
    id: string;
    /**
     * The sheet's title.
     * @since 0.14.0
     */
    title: string;
    /**
     * What the sheet shows.
     * @since 0.14.0
     */
    component: ComponentType<SheetProps<P>>;
    /**
     * With `true`, the sheet is wider.
     * @since 0.14.0
     */
    wide?: boolean;
}

/**
 * How a group of tool calls counts a call: "messaged 2 sessions".
 * @since 0.14.0
 */
export interface CallSummary {
    /**
     * The verb: `"messaged"`.
     * @since 0.14.0
     */
    verb: string;
    /**
     * The noun that the calls count: `"session"`.
     * @since 0.14.0
     */
    noun?: string;
    /**
     * The argument whose values the calls count by: `"to"`.
     * @since 0.14.0
     */
    by?: string;
}

/**
 * How the calls of one of the module's tools show in transcripts and peek tiles. Each function gets a copy of the
 * call's arguments.
 * @since 0.14.0
 */
export interface ToolCallSpec<A = Record<string, unknown>> {
    /**
     * The tool's name, as Pi calls it. It must be a tool of the module's own extensions.
     * @since 0.14.0
     */
    tool: string;
    /**
     * The name of one of the app's icons, for peek tiles.
     * @since 0.14.0
     */
    icon?: string;
    /**
     * An icon of your own, for peek tiles: a stroked path in a 24 × 24 box.
     * @since 0.14.0
     */
    iconPath?: string;
    /**
     * The words of the call's line: `"start session"`.
     * @since 0.14.0
     */
    label: (args: A) => string;
    /**
     * What the call acts on.
     * @since 0.14.0
     */
    subject?: (args: A) => string;
    /**
     * How a group of calls counts this call.
     * @since 0.14.0
     */
    summary?: (args: A) => CallSummary;
}

/**
 * What browser contribution registrations return, including `sessionControl` and `inputCommand`.
 * @since 0.14.0
 */
export interface Added<S> {
    /**
     * Changes some of its fields.
     * @since 0.14.0
     */
    update(patch: Partial<S>): void;
    /**
     * Removes it.
     * @since 0.14.0
     */
    remove(): void;
}

/**
 * The props of `pocket.Icon`.
 * @since 0.14.0
 */
export interface IconProps {
    /**
     * The name of one of the app's icons.
     * @since 0.14.0
     */
    name?: string;
    /**
     * An icon of your own: a stroked path in a 24 × 24 box.
     * @since 0.14.0
     */
    path?: string;
    /**
     * Its width and height, in pixels.
     * @since 0.14.0
     */
    size?: number;
}

/**
 * The props of `pocket.Loader` and `pocket.Spinner`.
 * @since 0.14.0
 */
export interface LoaderProps {
    /**
     * What is loading, in words.
     * @since 0.14.0
     */
    label?: string;
}

/**
 * The props of `pocket.Markdown`.
 * @since 0.14.0
 */
export interface MarkdownProps {
    /**
     * The Markdown to show.
     * @since 0.14.0
     */
    text: string;
}

/**
 * The props of `pocket.Switch`.
 * @since 0.14.0
 */
export interface SwitchProps {
    /**
     * Whether it is on.
     * @since 0.14.0
     */
    on: boolean;
    /**
     * Its name, for screen readers.
     * @since 0.14.0
     */
    label: string;
    /**
     * Runs when a person turns it.
     * @since 0.14.0
     */
    onChange: () => void;
    /**
     * Whether it cannot be turned now.
     * @since 0.14.0
     */
    disabled?: boolean;
}

/**
 * Public profile metadata, without role prompts or owner settings.
 * @since 0.15.0
 * @experimental
 */
export type AgentProfileMetadata = Omit<AgentProfile, "prompt">;

/**
 * Display-only workflow metadata. It grants no execution or transfer authority.
 * @since 0.15.0
 * @experimental
 */
export interface SessionWorkflowMetadata {
    readonly status: "active" | "review-complete" | "landed" | "published" | "needs-review";
    readonly readOnly: boolean;
    readonly managed: boolean;
    readonly preparing: boolean;
    readonly profileAvailable: boolean;
    readonly summary?: string;
    readonly readyForPublish?: boolean;
}

/**
 * Supported metadata from the existing access-filtered session catalogue, not a server/store handle.
 * @since 0.15.0
 * @experimental
 */
export interface SessionMetadata {
    readonly id: number;
    readonly title?: string;
    readonly cwd: string;
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly archived?: boolean;
    readonly threadType: AgentProfile["id"];
    readonly projectId?: string;
    readonly workItemId?: string;
    readonly workItemTitle?: string;
    readonly activeThreadId?: number;
    readonly linkedFrom?: { readonly id: number };
    readonly linkedOrigin?: boolean;
    readonly workflow: SessionWorkflowMetadata;
    readonly busy: boolean;
    readonly waiting: boolean;
    readonly failed?: boolean;
    readonly model?: string;
}

/**
 * The five-field metadata copy for the conversation open in this tab. No raw view, settings or prompts.
 * @since 0.15.0
 * @experimental
 */
export interface SessionConversation {
    readonly id: number;
    readonly kind: "session" | "conversation" | "subagent";
    readonly title: string;
    readonly cwd: string;
    readonly threadType?: AgentProfile["id"];
}

/**
 * Deeply frozen metadata copies for the current tab, retaining the person's catalogue visibility filter.
 * @since 0.15.0
 * @experimental
 */
export interface SessionSnapshot {
    readonly id: number | null;
    readonly me: Readonly<Person> | null;
    readonly conversation: SessionConversation | null;
    readonly sessions: readonly SessionMetadata[];
    readonly busy: boolean;
    readonly canSteer: boolean;
    readonly profiles: readonly AgentProfileMetadata[];
}

/**
 * A generic profile indicator, using current registered metadata or the raw ID when unavailable.
 * @since 0.15.0
 * @experimental
 */
export interface AgentProfileTagProps {
    profile: AgentProfile["id"];
    iconOnly?: boolean;
}

/**
 * Props for a guarded inline session control.
 * @since 0.15.0
 * @experimental
 */
export interface SessionControlProps {
    pocket: Pocket;
    session: SessionSnapshot;
}

/**
 * A contribution inside the current session's header or composer.
 * @since 0.15.0
 * @experimental
 */
export interface SessionControlSpec {
    id: string;
    slot: "header" | "composer";
    component: ComponentType<SessionControlProps>;
}

/**
 * A draft-only input hint. No action handler or alternative submission path.
 * @since 0.15.0
 * @experimental
 */
export interface InputCommandHint {
    name: string;
    description?: string;
    args?: string;
    completion?: string;
    completeOnEnter?: boolean;
    disabled?: boolean;
}

/**
 * A normal-model-input command row and optional asynchronous argument hints, never an executor.
 * @since 0.15.0
 * @experimental
 */
export interface InputCommandSpec {
    id: string;
    name: string;
    description: string;
    suggest(
        text: string,
        caret: number,
    ): readonly InputCommandHint[] | Promise<readonly InputCommandHint[]>;
}

/**
 * An existing upload in this conversation, not a local File or an arbitrary server-file capability.
 * @since 0.15.0
 * @experimental
 */
export interface SessionAttachment {
    path: string;
    name: string;
    mime: string;
    size: number;
}

/**
 * Genuine human input, submitted through the same journal and checks as the composer.
 * @since 0.15.0
 * @experimental
 */
export interface SessionSubmitRequest {
    text: string;
    requestId: string;
    attachments?: readonly SessionAttachment[];
    mode?: "steer" | "followUp";
    inlineFiles?: boolean;
}

/**
 * Durable input acceptance, not an agent response or a successor receipt.
 * @since 0.15.0
 * @experimental
 */
export interface SessionSubmitReceipt {
    readonly submissionId: number;
    readonly requestId: string;
    readonly handoffRequestKey?: string;
}

/**
 * The app's API for a browser module: the argument of its default export.
 * @since 0.14.0
 */
export interface Pocket {
    /**
     * The version of the extension API.
     * @since 0.14.0
     */
    readonly version: number;
    /**
     * The module's name.
     * @since 0.14.0
     */
    readonly module: string;
    /**
     * The module's title.
     * @since 0.14.0
     */
    readonly title: string;
    /**
     * The app's Preact `h`.
     * @since 0.14.0
     */
    readonly h: typeof h;
    /**
     * The app's htm, bound to its Preact.
     * @since 0.14.0
     */
    html(strings: TemplateStringsArray, ...values: unknown[]): VNode | VNode[];
    /**
     * The app's Preact `Fragment`.
     * @since 0.14.0
     */
    readonly Fragment: typeof Fragment;
    /**
     * Preact's `useState`.
     * @since 0.14.0
     */
    readonly useState: typeof useState;
    /**
     * Preact's `useEffect`.
     * @since 0.14.0
     */
    readonly useEffect: typeof useEffect;
    /**
     * Preact's `useLayoutEffect`.
     * @since 0.14.0
     */
    readonly useLayoutEffect: typeof useLayoutEffect;
    /**
     * Preact's `useRef`.
     * @since 0.14.0
     */
    readonly useRef: typeof useRef;
    /**
     * Preact's `useMemo`.
     * @since 0.14.0
     */
    readonly useMemo: typeof useMemo;
    /**
     * Preact's `useCallback`.
     * @since 0.14.0
     */
    readonly useCallback: typeof useCallback;
    /**
     * Preact's `useReducer`.
     * @since 0.14.0
     */
    readonly useReducer: typeof useReducer;
    /**
     * One of the app's icons, or an icon of your own.
     * @since 0.14.0
     */
    readonly Icon: FunctionComponent<IconProps>;
    /**
     * The app's spinner.
     * @since 0.14.0
     */
    readonly Spinner: FunctionComponent<LoaderProps>;
    /**
     * The app's spinner with a line of text.
     * @since 0.14.0
     */
    readonly Loader: FunctionComponent<LoaderProps>;
    /**
     * Markdown, cleaned as the app cleans Pi's replies.
     * @since 0.14.0
     */
    readonly Markdown: FunctionComponent<MarkdownProps>;
    /**
     * The app's on and off switch.
     * @since 0.14.0
     */
    readonly Switch: FunctionComponent<SwitchProps>;
    /**
     * A generic indicator for a registered agent profile, falling back to its raw ID.
     * @since 0.15.0
     * @experimental
     */
    readonly AgentProfileTag: FunctionComponent<AgentProfileTagProps>;
    /**
     * Deeply frozen copies of current-tab context, filtered session catalogue and public profile metadata.
     * @since 0.15.0
     * @experimental
     */
    session(): SessionSnapshot;
    /**
     * A fresh core-generated request identity, also available on plain-HTTP LAN origins.
     * Reuse an identity for retries of unchanged input; it is not a credential or authority.
     * @since 0.15.0
     * @experimental
     */
    requestId(): string;
    /**
     * Calls the listener on app-state changes. The returned cleanup is also run on module disposal.
     * @since 0.15.0
     * @experimental
     */
    onSessionChange(listener: (session: SessionSnapshot) => void): () => void;
    /**
     * The person who uses this tab, or null before sign-in.
     * @since 0.14.0
     */
    me(): Person | null;
    /**
     * The id of the session that this tab shows, a number as in its address (`/s/12`), or null.
     * @since 0.14.0
     */
    conversationId(): number | null;
    /**
     * Calls one of the module's routes: a GET without `body`, a POST with it.
     * @since 0.14.0
     */
    api<T = unknown>(
        path: string,
        body?: object,
        options?: { method?: WebMethod; signal?: AbortSignal },
    ): Promise<T>;
    /**
     * Listens for an event that the module sends. Returns a function that stops it.
     * @since 0.14.0
     */
    on<T = unknown>(event: string, run: (data: T) => void): () => void;
    /**
     * Calls only this module's conversation-scoped routes; core rechecks visibility and role.
     * @since 0.15.0
     * @experimental
     */
    sessionApi<T = unknown>(
        id: number,
        path: string,
        body?: object,
        options?: { method?: WebMethod; signal?: AbortSignal },
    ): Promise<T>;
    /**
     * Submits normal human model input. Resolves on durable acceptance, not successor creation.
     * Core owns uncertain-input recovery, accepted transfer lookup and initiating-tab navigation.
     * @since 0.15.0
     * @experimental
     */
    submit(id: number, request: SessionSubmitRequest): Promise<SessionSubmitReceipt>;
    /**
     * Navigates to a visible conversation through the app's normal routing.
     * @since 0.15.0
     * @experimental
     */
    navigate(id: number): void;
    /**
     * Shows a notice, as the app's own.
     * @since 0.14.0
     */
    notify(level: NoticeLevel, message: string): void;
    /**
     * Adds a button on the rail.
     * @since 0.14.0
     */
    rail(spec: RailSpec): Added<RailSpec>;
    /**
     * Adds a row in the menu.
     * @since 0.14.0
     */
    menu(spec: MenuSpec): Added<MenuSpec>;
    /**
     * Adds an action in the launcher.
     * @since 0.14.0
     */
    launcher(spec: LauncherSpec): Added<LauncherSpec>;
    /**
     * Adds a page.
     * @since 0.14.0
     */
    page(spec: PageSpec): Added<PageSpec>;
    /**
     * Adds a sheet.
     * @since 0.14.0
     */
    sheet<P extends object = object>(spec: SheetSpec<P>): Added<SheetSpec<P>>;
    /**
     * Adds a guarded inline component to the current session's header or composer.
     * @since 0.15.0
     * @experimental
     */
    sessionControl(spec: SessionControlSpec): Added<SessionControlSpec>;
    /**
     * Adds command and argument hints only. Picking a row edits the normal input draft, never submits it.
     * @since 0.15.0
     * @experimental
     */
    inputCommand(spec: InputCommandSpec): Added<InputCommandSpec>;
    /**
     * Sets how the calls of one of the module's tools show.
     * @since 0.14.0
     */
    toolCall<A = Record<string, unknown>>(spec: ToolCallSpec<A>): { remove(): void };
    /**
     * Opens one of the module's pages.
     * @since 0.14.0
     */
    openPage(id: string): void;
    /**
     * Closes the module's page that shows.
     * @since 0.14.0
     */
    closePage(): void;
    /**
     * Opens one of the module's sheets. Its component gets `props`.
     * @since 0.14.0
     */
    openSheet(id: string, props?: object): void;
    /**
     * Closes the module's sheet that shows.
     * @since 0.14.0
     */
    closeSheet(): void;
    /**
     * Loads a stylesheet from the browser module's folder.
     * @since 0.14.0
     */
    style(path: string): void;
    /**
     * Runs `dispose` when this version of the browser module goes.
     * @since 0.14.0
     */
    onDispose(dispose: () => void): void;
}
