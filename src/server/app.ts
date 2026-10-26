/**
 * The pi-tava server core: one durable Harness over one SQLite file, shared by every session, every subagent, and
 * every connected browser. Browsers attach to a conversation's committed view; nothing a browser sees exists only in
 * memory, except who is connected, who is typing, and which tool calls wait for approval.
 *
 * What people ask of Pi lives in `commands.ts`, the people's side of a session in `collab.ts`, push notifications in
 * `alerts.ts`, provider sign-ins in `providers.ts`, and each conversation's shared live view in `room.ts`.
 */
import { randomUUID } from "node:crypto";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { clampThinkingLevel, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
    type CreateModelRuntimeOptions,
    getAgentDir,
    ModelRuntime,
    resolveModelScopeWithDiagnostics,
    SettingsManager,
    type Skill,
} from "@earendil-works/pi-coding-agent";
import {
    AgentDoc,
    type AgentState,
    type CommitPublication,
    type Conversation,
    type ConversationId,
    type Cursor,
    createRegistry,
    defineExtension,
    type DocumentCommitChange,
    Harness,
    type HarnessSettings,
    LiveDoc,
    type LiveState,
    type Registry,
    type Storage,
    UsageDoc,
    type UsageState,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { Alerts } from "./alerts.ts";
import { Diagnostics } from "./diagnostics.ts";
import { scopeTaskRegistry } from "./task-scope.ts";
import {
    committedDiagnostics,
    observeEnvironment,
    observeRegistry,
} from "./diagnostics/runtime.ts";
import { Attribution, type Missing } from "./attribution.ts";
import { Browsers } from "./browser.ts";
import type { BrowserState } from "./browser/page.ts";
import { Collab, REACTIONS } from "./collab.ts";
import { Commands } from "./commands.ts";
import { LinkedSessions } from "./linked-sessions.ts";
import { APP_ROOT, canContinuePiSessions, ConfigStore, type User } from "./config.ts";
import { parseProjectAccess, type ProjectAccess } from "./project-access.ts";
import {
    ArtifactBodyDoc,
    type ArtifactMeta,
    ArtifactsDoc,
    AuthorsDoc,
    BrowserDoc,
    ChatDoc,
    type ChatMessage,
    DecisionsDoc,
    FolderFavoritesDoc,
    MemoryDoc,
    AgentIdentitiesDoc,
    ProjectsDoc,
    type SessionMeta,
    SessionsDoc,
    type SubagentRecord,
    SubagentsDoc,
    TurnsDoc,
} from "./docs.ts";
import { describe, HttpError } from "./errors.ts";
import { ExtensionCommands } from "./extension-commands.ts";
import { ExtensionWebs, mayUse, mayUseClient } from "./extension-web.ts";
import { defang, quoted } from "./fence.ts";
import { FolderFavorites } from "./folder-favorites.ts";
import { Gallery } from "./gallery.ts";
import { Goals } from "./goals.ts";
import { type ApprovalRequest, Approvals, type PocketHost, type WebClientAccess } from "./host.ts";
import { PrivateSessions } from "./private-sessions.ts";
import { PrivateTerminals } from "./private-terminals.ts";
import { type GuardStatus, LancetGuard } from "./lancet.ts";
import { takeLock } from "./lock.ts";
import { Memory } from "./memory.ts";
import { isThinkingLevel, modelList, resolveModel, THINKING_LEVELS } from "./models.ts";
import { configureHttp } from "./net.ts";
import { PiSessions } from "./pi-sessions.ts";
import { Hooks } from "./hooks.ts";
import { Pip, PIP_EXTENSION } from "./pip.ts";
import { PIP_COMPACT_CHOICES, PipCompaction } from "./pip-compact.ts";
import { RepoWatches } from "./repo-watches.ts";
import { snippet } from "./projection.ts";
import { loadPromptTemplates, type PromptTemplate, type SkillCommand } from "./prompts.ts";
import { BASE_THEME, Themes } from "./themes.ts";
import { THEME_ID } from "./themes/format.ts";
import { measureModelStreams } from "./timing.ts";
import { Providers } from "./providers.ts";
import { PushStore } from "./push.ts";
import { type ExtensionInfo, ExtensionLoader, linkTypes, prepareDropInFolder } from "./reload.ts";
import { ResendTask } from "./resend.ts";
import { type Client, reportingOf, Room, ROOM_DOCS, subagentView } from "./room.ts";
import { DestinationHeads } from "./destination-heads.ts";
import type { RemoteProjectSkill } from "./remote-project-resources.ts";
import { Schedules } from "./schedules.ts";
import { Shell } from "./shell.ts";
import {
    loadGlobalSkills,
    loadSessionSkills,
    projectDistrusted,
    type ProjectTrust,
    readProjectTrust,
    saveProjectTrust,
    type SkillSources,
    type TrustChoice,
} from "./skills.ts";
import { Spend } from "./spend.ts";
import { Transcripts } from "./transcripts.ts";
import { Watches } from "./watches.ts";
import { Workspace } from "./workspace.ts";
import { workflowWorkspaceBackend } from "./workspace-backend-factory.ts";
import type { WorkspaceLocation } from "./workspace-location.ts";
import { SshSessions } from "./ssh-sessions.ts";
import { createStageUploadTool } from "./ssh-uploads.ts";
import { LanguageServices } from "./language-services.ts";
import { Reviews } from "./reviews.ts";
import { Projects } from "./projects.ts";
import { WorkItems } from "./work-items.ts";
import { HandoffsDoc, WorkflowDoc } from "./workflow-docs.ts";
import { createWorkflowEnv, createWorkflowHooks } from "./workflow-policy.ts";
import { createPublicationTool } from "./workflow-publication.ts";
import { createPullTool } from "./workflow-pull.ts";
import { createResearchTool } from "./workflow-research.ts";
import { PI_PROVIDERS_FILE, ProviderPackages } from "./provider-packages.ts";
import { ProviderExtensions } from "./provider-extensions.ts";

const context = BACKGROUND_CONTEXT;

/** How other devices reach this server, as reported by the launcher (`bin/pi-coop.js`). */
export type AccessInfo = {
    mode: string;
    label: string;
    /** The address other devices should use, such as a tunnel's public https URL. */
    url?: string;
};

/** The extension module that runs Lancet Guard on tool calls. */
const GUARD_FILE = "guard.ts";
/** How long the server waits, when it stops, for extension modules' cleanups that wait. */
const CLEANUP_LIMIT_MS = 3000;
/** The extension module with the browser tool. While it is off, the Browser panel is off too. */
const BROWSER_FILE = "browser.ts";
const BROWSER_EXTENSION = "pocket-browser";
/** The extension module with the subagent tool, rebuilt when the models subagents may use change. */
const SUBAGENTS_FILE = "subagents.ts";
/** The most models the owner may allow subagents besides their session's own. */
const MAX_SUBAGENT_MODELS = 50;

/** The most peek tiles a tab gets live at once: the ones on its screen, which a tall screen fits a handful of. */
export const MAX_PEEKS = 12;
/**
 * How a run that failed leaves its messages: the model or its provider answered with an error, no model was there to
 * ask, or the run broke. Stopped (`aborted`), cleared (`reset`), and replaced (`stale`) runs did not fail.
 */
const FAILED_RUN = new Set(["model_error", "no_model", "faulted"]);

/** A conversation's subagents document, as far as the app reads it. */
type SubagentsValue = {
    agents?: Record<string, SubagentRecord>;
    outbox?: readonly { name: string }[];
    sending?: { reports: readonly { name: string }[] };
};

type SubagentsOf = { agents: Record<string, SubagentRecord>; reporting: Set<string> };

/** One subagent on the subagents board: the subagents bar's view, the session it works in, and the call it waits on. */
export type SubagentEntry = ReturnType<typeof subagentView> & {
    id: number;
    waiting?: true;
    approval?: { tool: string; subject: string };
};

/** Where a subagent is. Waiting for an approval comes before working: it is working, held up. */
export type SubagentState = "waiting" | "working" | "failed" | "stopped" | "done";

export function subagentState(entry: SubagentEntry): SubagentState {
    if (entry.waiting === true) {
        return "waiting";
    }

    if (entry.busy) {
        return "working";
    }

    return entry.stopped === true ? "stopped" : entry.failed === true ? "failed" : "done";
}

/**
 * On the subagents board, a session's finished subagents (done, stopped, or failed and dealt with) past this many, the
 * oldest, are left out: the session list counts them, and the board says how many more there are. Those that work,
 * wait, failed with nobody dealing with it yet, or have a report on its way always show.
 */
const BOARD_FINISHED = 24;

/** How long a read of Pi's settings serves skills and trust before it is read again. */
const SETTINGS_STALE_MS = 30_000;

/** A session's subagents as the board gets them: all but its oldest finished ones past `BOARD_FINISHED`. */
function forBoard(entries: readonly SubagentEntry[]): SubagentEntry[] {
    const finished = (entry: SubagentEntry) =>
        entry.reporting !== true &&
        (["done", "stopped"].includes(subagentState(entry)) ||
            (subagentState(entry) === "failed" && entry.dealt === true));
    const done = entries.filter(finished);

    if (done.length <= BOARD_FINISHED) {
        return [...entries];
    }

    const when = (entry: SubagentEntry) => entry.answeredAt ?? entry.askedAt ?? 0;
    const kept = new Set(done.sort((a, b) => when(b) - when(a)).slice(0, BOARD_FINISHED));

    return entries.filter((entry) => !finished(entry) || kept.has(entry));
}

/**
 * How many of a session's subagents are in each state, without the empty ones, and how many of those that failed a
 * person dealt with (`dealt`): the rest need someone. Undefined for none at all.
 */
function countSubagents(
    entries: readonly SubagentEntry[],
): (Partial<Record<SubagentState, number>> & { dealt?: number }) | undefined {
    if (entries.length === 0) {
        return undefined;
    }

    const counts: Partial<Record<SubagentState, number>> & { dealt?: number } = {};

    for (const entry of entries) {
        const state = subagentState(entry);

        counts[state] = (counts[state] ?? 0) + 1;

        if (state === "failed" && entry.dealt === true) {
            counts.dealt = (counts.dealt ?? 0) + 1;
        }
    }

    return counts;
}

export interface OpenOptions {
    dataDir: string;
    defaultCwd: string;
    supervised: boolean;
    log?: (line: string) => void;
    /** Tests register scripted providers here. */
    configureModels?: (models: ModelRuntime) => void;
    /** The clock durable work runs by, such as scheduled messages. Tests move it ahead. */
    now?: () => number;
    /** The browser to run for the Browser panel and tool; null for none. Undefined finds one on this machine. */
    browser?: string | null;
    /** The home folder, whose `.agents/skills/` every session has. Undefined is Pi's: `$HOME`. Tests use their own. */
    home?: string;
}

export class PocketApp {
    readonly config: ConfigStore;
    /** Push subscriptions and their keys; undefined until the server opened. */
    pushStore: PushStore | undefined;
    readonly approvals = new Approvals((id) => this.attribution.requesterOf(id));
    readonly guard = new LancetGuard();
    readonly dataDir: string;
    readonly defaultCwd: string;
    readonly supervised: boolean;
    readonly startedAt = Date.now();
    /** Set by the launcher over IPC; undefined when the server runs on its own. */
    access: AccessInfo | undefined;
    harness!: Harness;
    models!: ModelRuntime;
    settings!: SettingsManager;
    readonly providerPackages: ProviderPackages;
    providerExtensions!: ProviderExtensions;
    loader!: ExtensionLoader;
    readonly commands = new Commands(this);
    readonly extensionCommands = new ExtensionCommands(this);
    readonly linkedSessions = new LinkedSessions(this);
    /** Local Pi history, available only to the owner and explicitly permitted collaborators. */
    readonly piSessions = new PiSessions(this);
    readonly privateSessions = new PrivateSessions(this);
    readonly privateTerminals = new PrivateTerminals(this);
    readonly collab = new Collab(this);
    readonly reviews = new Reviews(this);
    readonly projects = new Projects(this);
    readonly workItems = new WorkItems(this);
    /** Bounded private diagnostic capture/reads, independent of Bash, SSH and private persona work. */
    readonly diagnostics = new Diagnostics(this);

    readonly alerts = new Alerts(this);
    readonly providers = new Providers(this);
    readonly schedules = new Schedules(this);
    readonly goals = new Goals(this);
    readonly shell = new Shell(this);
    readonly spend = new Spend(this);
    /** Who Pi works for in each conversation, and who wrote and queued each message. */
    readonly attribution = new Attribution(this);
    /** The conversation's folder: files, the viewer, changes, and uploads. */
    readonly workspace = new Workspace(this);
    readonly languages = new LanguageServices(this);
    /** The conversation's stored history, as people read it. */
    readonly transcripts = new Transcripts(this);
    /** PiP, the owner's assistant: its conversation, what its tools do, and the follows that report to it. */
    readonly pip = new Pip(this);
    /** PiP's context kept small: compacted sooner than a session's, with summaries of its own (`pip-compact.ts`). */
    readonly pipCompaction = new PipCompaction(this);
    /** Sessions' watches of their pull requests (`watches.ts`). */
    readonly watches = new Watches(this);
    /** PiP's standing orders on GitHub repositories: what happens there goes to PiP or a session (`repo-watches.ts`). */
    readonly repoWatches = new RepoWatches(this);
    /** Webhooks: addresses other services post to, each a message to a session or PiP (`hooks.ts`). */
    readonly hooks = new Hooks(this);
    /** Lessons Pi keeps across sessions, for a project or everywhere. */
    readonly memory = new Memory(this);
    /** Each person's favorite working folders, shared by their devices. */
    readonly folderFavorites = new FolderFavorites(this);
    /** Other people's drop-ins, from a reviewed index: found, installed off, read, updated, removed (`gallery.ts`). */
    readonly gallery = new Gallery(this);
    /** Theme folders: the app's look and layout, built in and the owner's (`themes.ts`). */
    readonly themes: Themes;
    /** Each conversation's browser page, which Pi and the people in the conversation share. */
    readonly browsers: Browsers;
    /** What extension modules add to the app: their routes, browser modules, and events (`extension-web.ts`). */
    readonly webs: ExtensionWebs;
    #websTimer: NodeJS.Timeout | undefined;
    /** Whose tabs the next `hello` for browser modules goes to: those who may use any of these. */
    readonly #websFor = new Set<WebClientAccess>();
    /** Whether everyone's tabs must hear `hello` again, for a change to the modules' commands. */
    #websAll = false;
    readonly #clients = new Set<Client>();
    readonly #rooms = new Map<ConversationId, Promise<Room>>();
    readonly #envs = new Map<string, ExecutionEnv>();
    readonly #destinationHeads = new DestinationHeads(this);
    readonly sshSessions: SshSessions;
    readonly #busy = new Set<ConversationId>();
    readonly #answeringApprovals = new Set<string>();
    /** When each conversation's last run ended, since this server started: peek tiles show sessions done since a look. */
    readonly #endedAt = new Map<ConversationId, number>();
    /**
     * Conversations whose last run ended because the model or provider failed (not stopped by someone), since this
     * server started: the session list marks them until their next run starts.
     */
    readonly #failed = new Set<ConversationId>();
    readonly #agents = new Map<ConversationId, AgentState>();

    /** The newest chat message (not activity) of each conversation, for unread dots in the session list. */
    readonly #lastChat = new Map<string, { at: number; userId: string }>();
    /** Subagent conversation → the conversation that spawned it. */
    readonly #parents = new Map<ConversationId, ConversationId>();
    /** Each conversation's subagents, and those with a report on its way to it: for the board and the session list. */
    readonly #subagents = new Map<ConversationId, SubagentsOf>();
    #sessions: Record<string, SessionMeta> = {};
    #sessionsTimer: NodeJS.Timeout | undefined;
    /** The extensions installed now: every conversation runs with them, except PiP's own, which PiP alone selects. */
    #registry: Registry | undefined;
    #unsubscribeCommits: (() => void) | undefined;
    #unsubscribeApprovals: (() => void) | undefined;
    #unsubscribeBrowsers: (() => void) | undefined;
    #lockFile: string;
    #releaseLock: (() => void) | undefined;
    /** Owned here until Harness.open succeeds, including a failed partial open. */
    #openingStorage: Storage | undefined;
    /** If the library rejects before returning storage, it may also have failed to close its partial connection. */
    #storageOpening = false;
    /** A failed Harness.open may own native work even if it did not return a handle. */
    #harnessOpening = false;
    #closing: Promise<void> | undefined;
    readonly #log: (line: string) => void;
    readonly #configureModels: ((models: ModelRuntime) => void) | undefined;
    readonly #home: string;
    /** The clock durable work runs by. */
    readonly now: () => number;

    private constructor(options: OpenOptions) {
        this.#configureModels = options.configureModels;
        this.#home = options.home ?? (process.env.HOME || homedir());
        this.sshSessions = new SshSessions(this, this.#home);
        this.now = options.now ?? Date.now;
        this.dataDir = options.dataDir;
        this.defaultCwd = options.defaultCwd;
        this.supervised = options.supervised;
        this.config = new ConfigStore(options.dataDir);
        this.providerPackages = new ProviderPackages(this.config, this.dataDir, getAgentDir());
        this.#lockFile = join(options.dataDir, "harness.lock");
        this.#log = options.log ?? ((line) => console.log(line));
        this.browsers = new Browsers({
            dataDir: options.dataDir,
            researchReader: (id) => this.workItems.isManaged(id as ConversationId),
            ...(options.browser === undefined ? {} : { executable: options.browser }),
            log: (line) => this.#log(line),
            load: async (id) =>
                (await this.harness.snapshot(
                    BrowserDoc,
                    id as unknown as ConversationId,
                    context,
                )) ?? undefined,
            save: (id, saved) => {
                void this.harness
                    .commit(async (tx) => {
                        const doc = await tx.doc(BrowserDoc, id as unknown as ConversationId);

                        if (saved.url !== undefined && doc.url !== saved.url) {
                            doc.url = saved.url;
                        }

                        const viewport = saved.viewport;

                        if (
                            viewport !== undefined &&
                            JSON.stringify(doc.viewport) !== JSON.stringify(viewport)
                        ) {
                            doc.viewport = { ...viewport };
                        }
                    }, context)
                    .catch((error: unknown) =>
                        this.#log(`browser page not saved: ${describe(error)}`),
                    );
            },
        });
        this.themes = new Themes({
            builtIn: join(APP_ROOT, "web", "themes"),
            dataDir: options.dataDir,
            notify: (message) => this.ownerNotice("warning", message),
            // Everyone's tabs: a theme anyone may have chosen changed, or one came or went.
            changed: () => {
                const lists = { owner: this.themes.list(true), others: this.themes.list(false) };

                for (const client of this.#clients) {
                    client.send(
                        "themes",
                        client.user.role === "owner" ? lists.owner : lists.others,
                    );
                }

                void this.#themeDefaultStillHere();
            },
            log: (line) => this.#log(line),
        });
        this.webs = new ExtensionWebs({
            changed: (access) => this.#websChanged(access),
            deliver: (part, access, event, data, to) => {
                for (const client of this.#clients) {
                    if (
                        (to === undefined || client.user.id === to) &&
                        mayUse(client.user, access)
                    ) {
                        client.send("ext", { module: part.module, event, data });
                    }
                }
            },
            // Everyone's tabs hear the new list in `hello`: commands are for guests too, not by a browser module's access.
            commandsChanged: () => this.#websChanged("all"),
            log: (line) => this.#log(line),
            // Something about a module only the owner can mend: their tabs, as what it says can name the server's folders.
            warn: (message) => this.ownerNotice("warning", message),
        });
    }

    /**
     * Browser modules came, went, or changed: the tabs of the people they are for hear which to load, once for changes
     * that come together.
     */
    #websChanged(access: readonly WebClientAccess[] | "all"): void {
        if (this.#closing !== undefined) {
            return;
        }

        if (access === "all") {
            this.#websAll = true;
        } else {
            for (const each of access) {
                this.#websFor.add(each);
            }
        }

        if (this.#websTimer !== undefined) {
            return;
        }

        this.#websTimer = setTimeout(() => {
            const changed = [...this.#websFor];
            const all = this.#websAll;

            this.#websTimer = undefined;
            this.#websFor.clear();
            this.#websAll = false;
            void this.#refreshClients(
                (user) => all || changed.some((each) => mayUseClient(user, each)),
            );
        }, 50);
    }

    /** Write a line to the server log. */
    log(line: string): void {
        this.#log(line);
    }

    static async open(options: OpenOptions): Promise<PocketApp> {
        const app = new PocketApp(options);

        try {
            await app.#open();
        } catch (error) {
            // A refused lock grants no right to clean up that holder's files or services.
            if (app.#releaseLock !== undefined) {
                try {
                    await app.close();
                } catch (cleanup) {
                    throw new AggregateError(
                        [error, cleanup],
                        "pi-tava startup and cleanup failed.",
                    );
                }
            }

            throw error;
        }

        return app;
    }

    async #open(): Promise<void> {
        this.#releaseLock = takeLock(this.#lockFile);

        try {
            this.pushStore = new PushStore(this.dataDir);
        } catch (error) {
            this.#log(`Push notifications are off: ${describe(error)}`);
        }

        this.settings = SettingsManager.create(this.defaultCwd);

        try {
            configureHttp(
                this.settings.getHttpIdleTimeoutMs() || 2_147_483_647,
                this.settings.getGlobalSettings().httpProxy,
            );
        } catch (error) {
            this.#log(`HTTP setup failed, using Node defaults: ${describe(error)}`);
        }

        // The initial profile must not let models.json's global-API fallback bypass hosted hooks.
        // Ordinary custom model configuration stays unchanged and is used when the module is off.
        const modelOptions: Readonly<CreateModelRuntimeOptions> = Object.freeze({
            ...(this.config.extensionChoice(PI_PROVIDERS_FILE) === true
                ? { modelsPath: null }
                : {}),
        });

        this.models = await ModelRuntime.create(modelOptions);
        this.providers.modelRefresh.watch(this.models, modelOptions);
        this.#configureModels?.(this.models);
        measureModelStreams(this.models, this.diagnostics.recorder);
        this.providerExtensions = new ProviderExtensions(
            this.providerPackages,
            this.models,
            join(getAgentDir(), "auth.json"),
            (message) => this.#log(message),
        );
        await this.providerExtensions.open();
        await this.models.getAvailable().catch(() => []);

        const registry = createRegistry();

        registry.install(CodingTools);
        registry.install(this.pip.registration());
        // Durable work of the app itself, whatever extension modules are on.
        registry.install(
            defineExtension({
                name: "pocket-core",
                tools: [
                    createPublicationTool(this, (id, context) =>
                        workflowWorkspaceBackend(this, id, context),
                    ),
                    createPullTool(this, (id, context) =>
                        workflowWorkspaceBackend(this, id, context),
                    ),
                    createResearchTool(this),
                    createStageUploadTool(this),
                    this.workItems.tool,
                    this.pip.reviewTool,
                ],
                tasks: [
                    ResendTask,
                    this.shell.task,
                    this.commands.followTask,
                    this.extensionCommands.task,
                    ...this.workItems.tasks,
                ],
                sections: this.workItems.sections,
                hooks: [
                    ...createWorkflowHooks(this),
                    ...this.pip.reviewHooks,
                    ...this.pip.agents.supervision.hooks,
                    ...this.pip.agents.execution.hooks,
                    ...this.pip.agents.contacts.hooks,
                ],
                wraps: [...this.pip.agents.execution.wraps, ...this.pip.agents.contacts.wraps],
            }),
        );
        const host: PocketHost = {
            guard: this.guard,
            approvals: this.approvals,
            agentDir: getAgentDir(),
            dataDir: this.dataDir,
            skillPaths: () => {
                try {
                    return this.settings.getSkillPaths();
                } catch {
                    return [];
                }
            },
            skills: (cwd) => this.skills(cwd),
            globalSkills: () => loadGlobalSkills(this.#skillSources()),
            projectResources: (id, context) => this.projectResources(id, context),
            workspace: (id) => ({ location: this.locationOf(id), env: this.envFor(id) }),
            resolveModel: (spec) => resolveModel(this.models, spec, this.signInNeeded),
            subagentModels: () => this.config.subagentModels,
            modelProblem: (ref, fresh) => this.providers.problem(ref, fresh),
            requesterOf: (conversationId) => this.attribution.requesterOf(conversationId),
            notice: (level, message, conversationId) => this.notice(level, message, conversationId),
            heldBack: (conversationId) => this.spend.heldBack(conversationId),
            onLimitsChanged: (listener) => this.spend.onLimitsChanged(listener),
            sessions: Object.freeze<PocketHost["sessions"]>({
                linked: this.linkedSessions,
                handoff: (request, api, ctx) => this.workItems.invoke(request, api, ctx),
            }),
            schedules: this.schedules,
            goals: this.goals,
            browsers: this.browsers,
            pip: this.pip,
            watches: this.watches,
            repoWatches: this.repoWatches,
            memory: this.memory,
            gallery: this.gallery,
            text: Object.freeze({ quoted, defang }),
            thinkingLevels: THINKING_LEVELS,
        };

        this.#registry = registry;
        const dropIn = join(this.dataDir, "extensions");

        try {
            prepareDropInFolder(dropIn, join(APP_ROOT, "node_modules"));
        } catch (error) {
            this.#log(`Drop-in extensions cannot import pi-tava's packages: ${describe(error)}`);
        }

        try {
            linkTypes(dropIn, join(APP_ROOT, "types", "pocket.d.ts"));
        } catch (error) {
            this.#log(`The drop-in folder has no _pocket.d.ts: ${describe(error)}`);
        }

        this.loader = new ExtensionLoader(
            registry,
            host,
            { builtIn: join(APP_ROOT, "src", "server", "extensions"), dropIn },
            (file) => this.config.extensionChoice(file),
            // What a module's load says can name the server's folders, or quote a provider: the owner's to read.
            { webs: this.webs, notify: (level, message) => this.ownerNotice(level, message) },
        );
        await this.themes.load().catch((error: unknown) => {
            this.#log(`Themes could not be read: ${describe(error)}`);
        });
        // A gallery update the server stopped in the middle of goes back first, so no extension loads half of one, and
        // a theme it had out of its folder is back before the owner's default is checked.
        await this.gallery.recover().catch((error: unknown) => {
            this.#log(`The extension gallery could not check its updates: ${describe(error)}`);
        });
        await this.#themeDefaultStillHere();
        this.workItems.installWeb();
        await this.loader.loadAll();

        this.#storageOpening = true;
        const storage = await openNodeSqliteStorage(join(this.dataDir, "pocket.sqlite"));

        this.#openingStorage = storage;
        this.#storageOpening = false;
        this.#harnessOpening = true;
        this.harness = await Harness.open(
            storage,
            {
                models: this.models,
                registry: scopeTaskRegistry(
                    observeRegistry(registry, this.diagnostics.recorder),
                    (run) =>
                        this.pip.agents.execution.taskScope(() =>
                            this.pip.agents.contacts.taskScope(run),
                        ),
                ),
                settings: this.#harnessSettings(),
                now: this.now,
                env: ({ conversationId, cwd }) =>
                    observeEnvironment(
                        this.diagnostics.recorder,
                        conversationId,
                        () => this.#env(conversationId, cwd ?? this.defaultCwd),
                        this.locationOf(conversationId) === undefined ? "local" : "ssh",
                    ),
                conversationCreated: async (tx, conversation) => {
                    // Every conversation gets the app's documents up front, so views can read them from the start.
                    await tx.doc(AuthorsDoc, conversation.id);
                    await tx.doc(ArtifactsDoc, conversation.id);
                    await tx.doc(SubagentsDoc, conversation.id);
                    await tx.doc(WorkflowDoc, conversation.id);
                },
                onReport: (error) => this.notice("warning", describe(error)),
            },
            context,
        );

        this.#harnessOpening = false;
        this.#openingStorage = undefined;
        await this.pip.open();
        const conversations = await this.#recover(storage);

        await this.pip.orchestration.recover(storage);
        await this.spend.load(conversations);

        this.#unsubscribeCommits = this.harness.subscribeCommits((publication) =>
            this.#committed(publication),
        );
        this.#unsubscribeApprovals = this.approvals.subscribe((id) => {
            void this.#rooms.get(id)?.then(
                (room) => room.schedule(),
                () => {},
            );
            const root = this.rootOf(id);

            // A subagent's call waits on its session's peek tile too.
            if (root !== id) {
                void this.#rooms.get(root)?.then(
                    (room) => room.schedulePeek(),
                    () => {},
                );
            }

            this.scheduleSessions();
            this.alerts.announceApprovals();
        });
        // A browser page's address, title, and loading go to the tabs watching its conversation, as they change.
        this.#unsubscribeBrowsers = this.browsers.subscribe((id, state) => {
            const conversationId = id as unknown as ConversationId;

            void this.#rooms.get(conversationId)?.then(
                (room) => {
                    for (const client of room.clients) {
                        client.send("browser", this.#browserEvent(conversationId, state));
                    }
                },
                () => {},
            );
        });

        await this.pip.orchestration.open();
        await this.pip.agents.supervision.open();
        this.privateSessions.startAlerts((ownerId, paneId, kind, signal) =>
            this.alerts.herdr(ownerId, paneId, kind, signal),
        );
        await this.pip.agents.contacts.open();

        if (this.guardOn()) {
            void this.guard.warm().catch(() => {});
        }

        // A legacy/native pause must not resume stored private generations merely because PiP is now core.
        if (!this.config.pipEnabled) {
            await this.pip.stopAll();
        }

        // Work a previous process left unfinished continues only with a usable provider runtime.
        if (!this.providerExtensions.recoveryRequired) {
            this.spend.startEnforcement();
            this.harness.resume();
        }
    }

    /**
     * What this process keeps in memory about every conversation, read back from storage at startup: which are busy,
     * their agents, chat, subagents, and who Pi works for in each. Authors a crash kept out of the authors documents are
     * written back, in one commit. Returns every conversation's id.
     */
    async #recover(storage: Storage): Promise<ConversationId[]> {
        const savedSessions = (await this.harness.snapshot(SessionsDoc, context))?.items ?? {};

        // Untyped legacy PiP and linked roots stay Chats; ordinary legacy threads become Workers.
        // Explicit types are never rewritten.
        if (Object.values(savedSessions).some((meta) => meta.threadType === undefined)) {
            await this.harness.commit(async (tx) => {
                const sessions = await tx.doc(SessionsDoc);

                for (const meta of Object.values(sessions.items)) {
                    meta.threadType ??=
                        meta.pip !== undefined || meta.linkedFrom !== undefined ? "chat" : "worker";
                }
            }, context);
        }

        this.#sessions = { ...((await this.harness.snapshot(SessionsDoc, context))?.items ?? {}) };
        await this.projects.recover();
        const conversations: ConversationId[] = [];
        const unrecorded = new Map<ConversationId, Missing[]>();
        let cursor: Cursor | undefined;

        do {
            const page = await this.harness.commit(
                (tx) => tx.scanConversations({}, 256, cursor),
                context,
            );

            for (const { id } of page.items) {
                conversations.push(id);
                const live = await this.harness.snapshot(LiveDoc, id, context);

                if (live?.run !== undefined) {
                    this.#busy.add(id);
                }

                const agent = await this.harness.snapshot(AgentDoc, id, context);

                if (agent !== undefined) {
                    this.#agents.set(id, agent as AgentState);
                }

                this.#noteChat(id, (await this.harness.snapshot(ChatDoc, id, context))?.messages);
                const missing = await this.attribution.recover(
                    storage,
                    id,
                    await this.harness.snapshot(AuthorsDoc, id, context),
                );

                if (missing.length > 0) {
                    unrecorded.set(id, missing);
                }

                this.#noteSubagents(id, await this.harness.snapshot(SubagentsDoc, id, context));
            }

            cursor = page.next;
        } while (cursor !== undefined);

        await this.attribution.repair(unrecorded);
        await this.workItems.recover();
        await this.pip.agents.recover();

        return conversations;
    }

    /** Every commit, as Pi Durable publishes it: what the app keeps in memory follows it, and so do the open views. */
    #committed(publication: CommitPublication): void {
        // Metadata only; observer faults cannot fail a native commit or replay business work.
        try {
            committedDiagnostics(publication, this.diagnostics.recorder);
        } catch {
            this.diagnostics.recorder.dropped++;
        }

        let sessionsChanged = false;

        // Usage in a commit is from the work that was going on before it: it is counted before a message the same
        // commit places changes whom Pi works for.
        for (const change of publication.changes) {
            if (
                change.type === "document" &&
                change.record.kind === UsageDoc.definition.kind &&
                change.conversationId !== undefined
            ) {
                this.spend.usageChanged(change.conversationId, change.value as UsageState | null);

                // A team's top session with a limit shows the team's spend: it follows a linked session's too.
                const root = this.rootOf(change.conversationId);
                const top = this.spend.teamRoot(root);

                if (top !== root && this.#sessions[String(top)]?.budget !== undefined) {
                    void this.#rooms.get(top)?.then(
                        (room) => room.schedule(),
                        () => {},
                    );
                }
            }
        }

        for (const change of publication.changes) {
            if (change.type === "document") {
                if (this.#documentCommitted(change)) {
                    sessionsChanged = true;
                }
            } else if (change.type === "submission") {
                this.attribution.submissionCommitted(change.value);

                // A run that failed because its provider's sign-in could not be renewed marks that provider; one that
                // was answered shows its provider works, and a mark it had (signed in again in Pi's terminal app, say)
                // is asked again.
                if (change.value.status === "unanswered" && change.value.reason === "model_error") {
                    this.providers.runFailed(change.value.detail);
                } else if (change.value.status === "done") {
                    const provider = this.#agents.get(change.value.conversationId)?.model?.provider;

                    if (provider !== undefined) {
                        this.providers.runAnswered(provider);
                    }
                }

                // Its run failed: the commit that settles it ends the run too, so the list hears of both at once.
                if (
                    change.value.status === "unanswered" &&
                    FAILED_RUN.has(change.value.reason) &&
                    this.#sessions[String(change.value.conversationId)] !== undefined &&
                    !this.#failed.has(change.value.conversationId)
                ) {
                    this.#failed.add(change.value.conversationId);
                    sessionsChanged = true;
                }
            }
        }

        this.alerts.committed(publication);
        this.pip.orchestration.committed(publication);
        this.pip.agents.supervision.committed(publication);
        this.pip.agents.execution.changed();
        this.pip.agents.contacts.committed(publication);

        if (sessionsChanged) {
            this.browsers.reconcilePolicy();
            this.scheduleSessions();
        }
    }

    /**
     * Pi started work in session `id` at `at`: it moves up the list, as a message sent there does, whatever started it
     * (a scheduled message, a subagent's report, a message sent again after a restart). One moved up since `at` (a
     * message through `Commands.submit` moves it too) is left as it is. A commit listener may not commit, so this commits
     * after it.
     */
    #movedUp(id: ConversationId, at: number): void {
        setImmediate(() => {
            this.harness
                .commit(async (tx) => {
                    const meta = (await tx.doc(SessionsDoc)).items[String(id)];

                    if (meta !== undefined && meta.updatedAt < at) {
                        meta.updatedAt = Date.now();
                    }
                }, context)
                .catch((error: unknown) => this.log(`session not moved up: ${describe(error)}`));
        });
    }

    /** A document changed: the views that show it update. True when the session list changed too. */
    #documentCommitted(change: Extract<DocumentCommitChange, { type: "document" }>): boolean {
        const kind = change.record.kind;
        const id = change.conversationId;
        let sessionsChanged = false;

        if (kind === "pi.live" && id !== undefined) {
            const busy = (change.value as LiveState | null)?.run !== undefined;

            if (busy !== this.#busy.has(id)) {
                if (busy) {
                    this.#busy.add(id);
                    // A new run starts over: whether it fails is its own to say.
                    this.#failed.delete(id);

                    if (this.#sessions[String(id)] !== undefined) {
                        this.#movedUp(id, Date.now());
                    }
                } else {
                    this.#busy.delete(id);
                }

                sessionsChanged = true;
                this.alerts.runChanged(id, busy);

                if (!busy) {
                    this.spend.runEnded(id);
                    this.pipCompaction.runEnded(id);

                    if (this.#sessions[String(id)] !== undefined) {
                        this.#endedAt.set(id, Date.now());
                    }
                }

                // A parent shows its subagents' busy state.
                for (const pending of this.#rooms.values()) {
                    void pending.then((room) => {
                        if (
                            Object.values(room.subagents).some(
                                (record) => record.conversationId === id,
                            )
                        ) {
                            room.schedule();
                        }
                    });
                }
            }
        } else if (kind === "pi.agent" && id !== undefined) {
            if (change.value !== null) {
                this.#agents.set(id, change.value as AgentState);
            }

            sessionsChanged = true;
        } else if (kind === SessionsDoc.definition.kind) {
            this.#sessions = {
                ...((change.value as { items?: Record<string, SessionMeta> } | null)?.items ?? {}),
            };
            sessionsChanged = true;

            // Views show a session's title, limit, and worktree from here.
            for (const pending of this.#rooms.values()) {
                void pending.then(
                    (room) => room.schedule(),
                    () => {},
                );
            }
        } else if (kind === FolderFavoritesDoc.definition.kind) {
            this.folderFavorites.committed(
                change.value as { users: Record<string, string[]> } | null,
            );
        } else if (kind === AgentIdentitiesDoc.definition.kind) {
            this.pip.agents.committed(change.value);
            sessionsChanged = true;
        } else if (kind === MemoryDoc.definition.kind) {
            this.memory.committed(change.value);
        } else if (kind === HandoffsDoc.definition.kind) {
            this.workItems.committed(change.value);
            sessionsChanged = true;
        } else if (kind === WorkflowDoc.definition.kind && id !== undefined) {
            this.workItems.workflowCommitted(id, change.value);
            sessionsChanged = true;
        } else if (kind === ProjectsDoc.definition.kind) {
            this.projects.committed(change.value);
            sessionsChanged = true;
        } else if (ROOM_DOCS.has(kind) && id !== undefined) {
            if (kind === ChatDoc.definition.kind) {
                if (
                    this.#noteChat(
                        id,
                        (change.value as { messages?: ChatMessage[] } | null)?.messages,
                    )
                ) {
                    sessionsChanged = true;
                }
            } else if (kind === SubagentsDoc.definition.kind) {
                this.#noteSubagents(id, change.value as SubagentsValue | null);
                // The list counts each session's subagents, and the board lists them.
                sessionsChanged = true;
            }

            void this.#rooms.get(id)?.then(
                (room) => room.setDoc(kind, change.value as Record<string, unknown> | null),
                () => {},
            );

            if (kind === TurnsDoc.definition.kind) {
                for (const pending of this.#rooms.values()) {
                    void pending.then(
                        (room) => {
                            if (room.id !== id && this.rootOf(room.id) === id) {
                                room.setDoc(kind, change.value as Record<string, unknown> | null);
                            }
                        },
                        () => {},
                    );
                }
            }
        }

        if (kind === ProjectsDoc.definition.kind || kind === SessionsDoc.definition.kind) {
            for (const client of this.#clients) {
                if (
                    client.conversationId !== undefined &&
                    !this.canSee(client.user, client.conversationId)
                ) {
                    this.#evict(client, "The owner changed access to this project.");
                }

                for (const peek of client.peeks ?? []) {
                    if (!this.canSee(client.user, peek)) {
                        client.peeks?.delete(peek);
                        this.#unpeek(client, peek);
                    }
                }
            }
        }

        return sessionsChanged;
    }

    /** How model requests stream here: Pi's timeout and retries. Pi Durable's requests and PiP's summaries use them. */
    streamSettings(): { timeoutMs: number; maxRetryDelayMs?: number; maxRetries?: number } {
        const read = <T>(get: () => T): T | undefined => {
            try {
                return get();
            } catch {
                return undefined;
            }
        };

        const provider = read(() => this.settings.getProviderRetrySettings());
        const idle = read(() => this.settings.getHttpIdleTimeoutMs()) ?? 300_000;

        return {
            timeoutMs: provider?.timeoutMs ?? (idle === 0 ? 2_147_483_647 : idle),
            ...(provider?.maxRetryDelayMs === undefined
                ? {}
                : { maxRetryDelayMs: provider.maxRetryDelayMs }),
            ...(provider?.maxRetries === undefined ? {} : { maxRetries: provider.maxRetries }),
        };
    }

    #harnessSettings(): HarnessSettings {
        const settings = this.settings;

        const safe = <T>(read: () => T): T | undefined => {
            try {
                return read();
            } catch {
                return undefined;
            }
        };

        const registry = () => this.#registry;
        const stream = () => this.streamSettings();

        return {
            // Park five consecutive cutoffs without progress; never spin an unbounded crash-recovery loop.
            restartLimit: 5,
            // Every installed extension, in install order, but PiP's: its tools and prompt are for its conversation only,
            // which selects it by name (`pip.ts`).
            get extensions() {
                return registry()
                    ?.snapshot()
                    .installed()
                    .filter((extension) => extension.name !== PIP_EXTENSION);
            },
            get stream() {
                return stream();
            },
            get compaction() {
                return safe(() => settings.getCompactionSettings()) ?? {};
            },
            get retry() {
                return safe(() => settings.getRetrySettings()) ?? {};
            },
            get steeringMode() {
                return safe(() => settings.getSteeringMode());
            },
            get followUpMode() {
                return safe(() => settings.getFollowUpMode());
            },
        } as HarnessSettings;
    }

    /** An actual viewer's HEAD observation; only an opened thread starts remote inspection. */
    workspaceHead(id: ConversationId, user?: User) {
        return this.locationOf(id) !== undefined &&
            user !== undefined &&
            !this.watching(user.id, id)
            ? this.#destinationHeads.peek(id, user)
            : this.#destinationHeads.get(id, user);
    }

    /** The conversation's pinned filesystem and command destination, with live workflow/requester checks. */
    envFor(id: ConversationId, user?: User): ExecutionEnv {
        return this.#env(id, this.cwdOf(id), user);
    }

    #env(id: ConversationId, cwd: string, user?: User): ExecutionEnv {
        if (this.locationOf(id) !== undefined) {
            return this.sshSessions.envFor(id, cwd, user);
        }

        const key = JSON.stringify([
            id,
            cwd,
            user?.id,
            user?.tokenHash,
            user?.role,
            user?.sessions,
            user?.projectAccess,
        ]);
        let env = this.#envs.get(key);

        if (env === undefined) {
            env = createWorkflowEnv(this, id, cwd, user);
            this.#envs.set(key, env);
        }

        return env;
    }

    // ─── Clients ────────────────────────────────────────────────────────────

    notice(
        level: "info" | "warning" | "error",
        message: string,
        conversationId?: ConversationId,
    ): void {
        this.#log(`[${level}] ${message}`);

        for (const client of this.#clients) {
            // Server-wide notices can name other sessions' folders: people invited to one session do not get them. One
            // about PiP reaches the tabs with its panel open too: the panel has no notices of its own.
            const reaches =
                conversationId === undefined
                    ? client.user.sessions === undefined && client.user.projectAccess === undefined
                    : (client.conversationId === conversationId ||
                          client.pip?.conversationId === conversationId) &&
                      this.canSee(client.user, conversationId);

            if (reaches) {
                client.send("notice", { level, message });
            }
        }
    }

    /** A notice for the owner's tabs alone: about what only they may change. */
    ownerNotice(level: "info" | "warning" | "error", message: string): void {
        this.#log(`[${level}] ${message}`);

        for (const client of this.#clients) {
            if (client.user.role === "owner") {
                client.send("notice", { level, message });
            }
        }
    }

    /** Every open view builds itself again: what it shows from outside its documents changed (a model's sign-in). */
    refreshViews(): void {
        for (const pending of this.#rooms.values()) {
            void pending.then(
                (room) => room.schedule(),
                () => {},
            );
        }
    }

    /** Every connected tab. */
    get clients(): ReadonlySet<Client> {
        return this.#clients;
    }

    #webRevision = randomUUID();

    /** The served document and reconnect hello share this revision, including while no tabs are attached. */
    get webRevision(): string {
        return this.#webRevision;
    }

    /** Tell every browser to reload, after a web file changed. */
    reloadClients(file: string): void {
        this.#webRevision = randomUUID();

        for (const client of this.#clients) {
            client.send("reload", { file });
        }
    }

    /**
     * Start sending a tab its events. The tab may close during the waits here (opening a room, or the guard's status
     * right after a restart, when every browser reconnects at once): `detach` has then run, and the tab must not be added.
     */
    async attach(client: Client): Promise<void> {
        const arriving = !this.#online(client.user.id);

        client.sessionsSent = undefined;
        client.namedAgentsSent = undefined;
        this.#clients.add(client);
        const hello = await this.hello(client.user);

        if (!this.#clients.has(client)) {
            return;
        }

        client.send("hello", this.#helloFor(client, hello));
        this.#sendSessions(client);
        this.#sendPip(client);

        if (client.user.role === "owner" && this.themes.failure !== undefined) {
            client.send("notice", { level: "warning", message: this.themes.failure });
        }

        client.send("projects", this.projects.list(client.user));

        if (arriving) {
            this.#peopleChanged(client.user.id);
        }

        if (client.conversationId === undefined) {
            return;
        }

        if (!this.canSee(client.user, client.conversationId)) {
            client.send("missing", {
                conversationId: client.conversationId,
                message: "This session is not shared with you.",
            });
            // Keep the tab for app-wide events only: nothing about that conversation reaches it, and it is not "there".
            client.conversationId = undefined;

            return;
        }

        try {
            const id = client.conversationId;
            const room = await this.room(id);

            if (!this.#clients.has(client)) {
                this.releaseRoom(room);

                return;
            }

            room.keepOpen();
            room.clients.add(client);
            room.push(client, true);
            client.send("chat", { conversationId: room.id, full: true, messages: room.chat });
            client.send("notes", { conversationId: room.id, ...room.notes });
            // Also while the browser is off: turned on later, the panel has its state at once.
            client.send(
                "browser",
                this.#browserEvent(room.id, this.browsers.state(Number(room.id))),
            );

            for (const other of room.clients) {
                if (other !== client) {
                    room.push(other, false);
                }
            }

            room.pushPresence();
            this.scheduleSessions();
        } catch (error) {
            client.send("missing", {
                conversationId: client.conversationId,
                message: describe(error),
            });
        }
    }

    detach(client: Client): void {
        if (!this.#clients.delete(client)) {
            return;
        }

        for (const id of client.peeks ?? []) {
            this.#unpeek(client, id);
        }

        client.peeks = undefined;
        this.#closePip(client);
        this.#destinationHeads.releaseUnwatched();

        if (!this.#online(client.user.id)) {
            this.#peopleChanged(client.user.id);
        }

        if (client.conversationId === undefined) {
            return;
        }

        this.#leaveRoom(client, client.conversationId);
    }

    /** Take a tab out of a conversation's room: the others see it go, and the room closes once no tab is left. */
    #leaveRoom(client: Client, id: ConversationId): void {
        void this.#rooms.get(id)?.then(
            (room) => {
                if (!room.clients.delete(client)) {
                    return;
                }

                if (!room.has(client.user.id)) {
                    room.setTyping(client.user.id, null);
                }

                room.pushPresence();
                room.schedule();
                this.scheduleSessions();
                this.releaseRoom(room);
            },
            () => {},
        );
    }

    /**
     * The sessions a connection shows as peek tiles on its screen now, and the subagents its subagents bar shows. Each
     * gets short `peek` updates while it stays there; the rest stop, and their views close as they do when the last tab
     * leaves. Conversations this person may not see are left out. `connection` is the id its `hello` carried. A list
     * numbered `seq` below one already taken arrived late, and is dropped.
     */
    setPeeks(user: User, connection: string, ids: readonly ConversationId[], seq?: number): void {
        // Sessions, and the subagents of sessions: the subagents bar shows what each does now.
        const wanted = new Set(
            ids
                .filter(
                    (id) =>
                        this.#sessions[String(this.rootOf(id))] !== undefined &&
                        this.canSee(user, id),
                )
                .slice(0, MAX_PEEKS),
        );

        for (const client of this.#clients) {
            if (client.user.id !== user.id || client.connection !== connection) {
                continue;
            }

            if (seq !== undefined) {
                if (seq <= (client.peekSeq ?? -Infinity)) {
                    continue;
                }

                client.peekSeq = seq;
            }

            const had = client.peeks ?? new Set<ConversationId>();

            client.peeks = new Set(wanted);

            for (const id of had) {
                if (!wanted.has(id)) {
                    this.#unpeek(client, id);
                }
            }

            for (const id of wanted) {
                if (!had.has(id)) {
                    void this.#peek(client, id);
                }
            }
        }
    }

    async #peek(client: Client, id: ConversationId): Promise<void> {
        let room: Room;

        try {
            room = await this.room(id);
        } catch {
            // A session that is gone has no tile to show.
            return;
        }

        // The tab left, or scrolled the tile away, while the view opened.
        if (!this.#clients.has(client) || client.peeks?.has(id) !== true) {
            this.releaseRoom(room);

            return;
        }

        // Scrolled away and back while the view opened: the first of the two calls added it already.
        if (room.peekers.has(client)) {
            return;
        }

        room.keepOpen();
        room.peekers.add(client);
        room.pushPeek(client);
    }

    #unpeek(client: Client, id: ConversationId): void {
        void this.#rooms.get(id)?.then(
            (room) => {
                if (room.peekers.delete(client)) {
                    this.releaseRoom(room);
                }
            },
            () => {},
        );
    }

    /**
     * A tab opened or closed its PiP panel. While it is open, the tab gets PiP's conversation as `pipview` events, from a
     * view of its own beside the one the tab shows, and counts as looking at PiP, so its answers push nothing. Opening
     * makes this person's PiP the first time. A request numbered `seq` below one already taken arrived late, and is
     * dropped.
     */
    async setPip(user: User, connection: string, on: boolean, seq?: number): Promise<void> {
        const id = on ? await this.pip.ensure(user) : undefined;

        for (const client of this.#clients) {
            if (client.user.id !== user.id || client.connection !== connection) {
                continue;
            }

            if (seq !== undefined) {
                if (seq <= (client.pipSeq ?? -Infinity)) {
                    continue;
                }

                client.pipSeq = seq;
            }

            if (client.pip !== undefined && client.pip.conversationId !== id) {
                this.#closePip(client);
            }

            if (id !== undefined && client.pip === undefined) {
                void this.#openPip(client, id);
            }
        }

        // Made just now: the tab learns its id from the PiP state.
        this.scheduleSessions();
    }

    async #openPip(tab: Client, id: ConversationId): Promise<void> {
        const panel: Client = {
            id: tab.id,
            user: tab.user,
            connection: tab.connection,
            conversationId: id,
            get visible() {
                return tab.visible;
            },
            // The same code shows it: what the tab understands, the panel does.
            ...(tab.protocol === undefined ? {} : { protocol: tab.protocol }),
            sentEntries: new Set<number>(),
            orderKey: "",
            // Only the view: the panel has no chat, notes, or browser of its own.
            send: (event, data) => {
                if (event === "view") {
                    tab.send("pipview", data);
                }
            },
        };

        tab.pip = panel;
        let room: Room;

        try {
            room = await this.room(id);
        } catch (error) {
            if (tab.pip === panel) {
                tab.pip = undefined;
            }

            this.#log(`PiP's view did not open: ${describe(error)}`);

            return;
        }

        // The tab left, or closed the panel, while the view opened.
        if (!this.#clients.has(tab) || tab.pip !== panel) {
            this.releaseRoom(room);

            return;
        }

        room.keepOpen();
        room.clients.add(panel);
        room.push(panel, true);
    }

    #closePip(tab: Client): void {
        const panel = tab.pip;

        tab.pip = undefined;

        if (panel?.conversationId !== undefined) {
            this.#leaveRoom(panel, panel.conversationId);
        }
    }

    /** Send a tab its person's PiP state, unless it is what the tab last got. */
    #sendPip(client: Client): void {
        const json = JSON.stringify(this.pip.state(client.user));

        if (json !== client.pipSent) {
            client.pipSent = json;
            client.send("pip", JSON.parse(json) as unknown);
        }
    }

    /** A tab was hidden or shown: hidden tabs show their person as away, and let push notifications through. */
    setVisible(user: User, tab: string, visible: boolean): void {
        for (const client of this.#clients) {
            if (client.user.id !== user.id || client.id !== tab || client.visible === visible) {
                continue;
            }

            client.visible = visible;
            const id = client.conversationId;

            if (id !== undefined) {
                void this.#rooms.get(id)?.then(
                    (room) => room.pushPresence(),
                    () => {},
                );
            }
        }

        this.#destinationHeads.releaseUnwatched();
    }

    #online(userId: string): boolean {
        for (const client of this.#clients) {
            if (client.user.id === userId) {
                return true;
            }
        }

        return false;
    }

    /** Is this person looking at this conversation right now, in a visible tab? */
    watching(userId: string, id: ConversationId): boolean {
        for (const client of this.#clients) {
            if (
                client.user.id === userId &&
                (client.conversationId === id || client.pip?.conversationId === id) &&
                client.visible !== false
            ) {
                return true;
            }
        }

        return false;
    }

    /** Private pane presence is owner-only and expires with the normal visible event connection. */
    watchingHerdr(userId: string, paneId: string): boolean {
        return [...this.#clients].some(
            (client) =>
                client.user.id === userId &&
                client.user.role === "owner" &&
                client.privateId === paneId &&
                client.visible !== false,
        );
    }

    /** Change someone's name: shown at once on their messages, in the people lists, and on their avatar. */
    rename(user: User, name: string): void {
        this.config.updateUser(user.id, { name });
        this.#peopleChanged();

        for (const pending of this.#rooms.values()) {
            void pending.then(
                (room) => room.has(user.id) && room.pushPresence(),
                () => {},
            );
        }
    }

    /** Someone came, went, or changed: remember when they were last here and tell everyone. */
    #peopleChanged(userId?: string): void {
        if (userId !== undefined && this.config.userById(userId) !== undefined) {
            this.config.updateUser(userId, { lastSeen: Date.now() });
        }

        for (const client of this.#clients) {
            client.send("users", this.people(client.user));
        }
    }

    /**
     * The people with access to this server as `viewer` may see them: who is online now, and when the others were last
     * here. People invited to one session see only those who share it, and not which sessions others are limited to.
     */
    people(viewer: User) {
        const scope = viewer.sessions;

        return this.config.users
            .filter(
                (each) =>
                    scope === undefined ||
                    each.sessions === undefined ||
                    each.sessions.some((id) => scope.includes(id)),
            )
            .filter(
                (each) =>
                    viewer.projectAccess === undefined ||
                    each.id === viewer.id ||
                    each.role === "owner" ||
                    Object.keys(this.#sessions).some(
                        (id) =>
                            this.canSee(viewer, Number(id) as ConversationId) &&
                            this.canSee(each, Number(id) as ConversationId),
                    ),
            )
            .map((each) => ({
                id: each.id,
                name: each.name,
                role: each.role,
                online: this.#online(each.id),
                ...(viewer.role === "owner" && canContinuePiSessions(each)
                    ? { continuePiSessions: true as const }
                    : {}),
                ...(viewer.role === "owner" && each.projectAccess !== undefined
                    ? { projectAccess: structuredClone(each.projectAccess) }
                    : {}),
                ...(each.lastSeen === undefined ? {} : { lastSeen: each.lastSeen }),
                ...(each.sessions === undefined ||
                scope !== undefined ||
                viewer.projectAccess !== undefined
                    ? {}
                    : { sessions: each.sessions.map(Number) }),
            }));
    }

    // ─── Access ─────────────────────────────────────────────────────────────

    /** A session's conversations: itself and the subagents under it that are known here. */
    conversationsOf(root: ConversationId): ConversationId[] {
        return [
            ...new Set([
                root,
                ...[...this.#agents.keys()].filter((id) => this.rootOf(id) === root),
            ]),
        ];
    }

    /** Bounded cached membership for passive diagnostics; no task/storage traversal or workspace access. */
    diagnosticConversations(roots: readonly ConversationId[], limit: number) {
        const selected = new Set(roots.slice(0, limit));
        const members = new Set(selected);
        let scanned = 0;
        let limited = roots.length > limit;

        for (const id of this.#agents.keys()) {
            if (++scanned > limit || members.size >= limit) {
                limited = true;
                break;
            }

            if (selected.has(this.rootOf(id))) {
                members.add(id);
            }
        }

        return { members: [...members], limited };
    }

    /** The conversation that spawned a subagent's; undefined for any other conversation. */
    parentOf(id: ConversationId): ConversationId | undefined {
        return this.#parents.get(id);
    }

    /** The session a conversation belongs to: itself, or the session its subagent chain started from. */
    rootOf(id: ConversationId): ConversationId {
        let current = id;

        for (let depth = 0; depth < 32; depth++) {
            const parent = this.#parents.get(current);

            if (parent === undefined) {
                return current;
            }

            current = parent;
        }

        return current;
    }

    /** Scoped grants flow forward through handoff ancestry; every PiP/owner-only hop still restricts it. */
    canSee(user: User, id: ConversationId): boolean {
        if (this.pip.isInternal(id)) {
            return false;
        }

        const currentUser = this.config.userById(user.id);

        if (currentUser === undefined || currentUser.tokenHash !== user.tokenHash) {
            return false;
        }

        user = currentUser;
        const root = this.rootOf(id);
        const seen = new Set<ConversationId>();
        let current = root;
        const rootMeta = this.sessionMeta(root);
        let granted =
            user.sessions === undefined &&
            (user.role === "owner" ||
                user.projectAccess === undefined ||
                (rootMeta !== undefined && this.projects.canAccessThread(user, rootMeta)));

        while (!seen.has(current)) {
            seen.add(current);
            const meta = this.sessionMeta(current);

            if (
                (current !== root && meta === undefined) ||
                (meta?.pip !== undefined && meta.pip !== user.id) ||
                (meta?.ownerOnly === true && user.role !== "owner")
            ) {
                return false;
            }

            granted ||= user.sessions?.includes(String(current)) === true;

            if (meta?.accessFrom === undefined) {
                return granted;
            }

            if (!Number.isSafeInteger(meta.accessFrom) || meta.accessFrom <= 0) {
                return false;
            }

            current = meta.accessFrom as ConversationId;
        }

        return false;
    }

    requireSee(user: User, id: ConversationId): void {
        if (!this.canSee(user, id)) {
            throw new HttpError(404, "This session is not shared with you.");
        }
    }

    /** Viewers read, chat, and react; they never make Pi do anything. */
    requireSteer(user: User): void {
        const current = this.config.userById(user.id);

        if (current === undefined || current.tokenHash !== user.tokenHash) {
            throw new HttpError(401, "Your access was removed or changed");
        }

        if (current.role === "viewer") {
            throw new HttpError(
                403,
                "You can view this session but not steer Pi. Ask the owner for steering rights.",
            );
        }

        if (this.providerExtensions?.recoveryRequired) {
            throw new HttpError(
                503,
                "Durable work is paused after provider startup failed. The owner must fix Providers and restart.",
            );
        }
    }

    /** While take turns is on, only the driver sends to Pi or changes its settings. */
    async requireDriver(id: ConversationId, user: User): Promise<void> {
        this.requireSteer(user);
        const turns = await this.harness.snapshot(TurnsDoc, this.rootOf(id), context);

        this.requireSteer(user);
        this.requireSee(user, id);

        if (turns?.on !== true || turns.driver === user.id) {
            return;
        }

        const driver = turns.driver === undefined ? undefined : this.config.userById(turns.driver);

        throw new HttpError(
            409,
            driver === undefined
                ? "Take turns is on: take the wheel first."
                : `${driver.name} is driving. Ask to drive first.`,
        );
    }

    #noteChat(id: ConversationId, messages: readonly ChatMessage[] | undefined): boolean {
        const last = messages?.findLast((message) => message.kind !== "event");
        const key = String(id);
        const before = this.#lastChat.get(key);

        if (last === undefined) {
            return this.#lastChat.delete(key);
        }

        if (before?.at === last.at && before.userId === last.userId) {
            return false;
        }

        this.#lastChat.set(key, { at: last.at, userId: last.userId });

        return true;
    }

    #noteSubagents(id: ConversationId, doc: SubagentsValue | null | undefined): void {
        const agents = doc?.agents ?? {};

        for (const record of Object.values(agents)) {
            this.#parents.set(record.conversationId, id);
        }

        if (Object.keys(agents).length === 0) {
            this.#subagents.delete(id);
        } else {
            this.#subagents.set(id, { agents: { ...agents }, reporting: reportingOf(doc) });
        }
    }

    /**
     * Every subagent, by the session it works in (its parent's, or the session its parent's chain started from), as the
     * subagents board shows it: the subagents bar's view, with the session and the call it waits on, if any.
     */
    #subagentsBySession(): Map<string, SubagentEntry[]> {
        const asks = new Map<ConversationId, ApprovalRequest>();

        for (const approval of this.approvals.all()) {
            if (!asks.has(approval.conversationId)) {
                asks.set(approval.conversationId, approval);
            }
        }

        const sessions = new Map<string, SubagentEntry[]>();

        for (const [parent, { agents, reporting }] of this.#subagents) {
            const session = String(this.rootOf(parent));

            if (this.#sessions[session] === undefined) {
                continue;
            }

            const list = sessions.get(session) ?? [];

            for (const [name, record] of Object.entries(agents)) {
                const ask = asks.get(record.conversationId);

                list.push({
                    id: Number(session),
                    ...subagentView(
                        name,
                        record,
                        this.#busy.has(record.conversationId),
                        reporting.has(name),
                    ),
                    ...(ask === undefined
                        ? {}
                        : {
                              waiting: true,
                              approval: { tool: ask.tool, subject: ask.subject.slice(0, 200) },
                          }),
                });
            }

            sessions.set(session, list);
        }

        return sessions;
    }

    /**
     * Every subagent in the sessions this person can see, for the subagents board, but a session's oldest finished ones
     * past `BOARD_FINISHED`. Archived sessions are left out, unless one of their subagents works or waits there.
     */
    subagents(user?: User): SubagentEntry[] {
        const all: SubagentEntry[] = [];

        for (const [id, list] of this.#subagentsBySession()) {
            if (user?.sessions !== undefined && !user.sessions.includes(id)) {
                continue;
            }

            if (this.#sessions[id]?.archived === true && !list.some((entry) => entry.busy)) {
                continue;
            }

            all.push(...forBoard(list));
        }

        return all;
    }

    /**
     * A tab opened or closed the subagents board: while open, it gets every subagent with each session list. A request
     * numbered `seq` below one already taken arrived late, and is dropped.
     */
    setBoard(user: User, connection: string, on: boolean, seq?: number): void {
        for (const client of this.#clients) {
            if (client.user.id !== user.id || client.connection !== connection) {
                continue;
            }

            if (seq !== undefined) {
                if (seq <= (client.boardSeq ?? -Infinity)) {
                    continue;
                }

                client.boardSeq = seq;
            }

            client.board = on;
            client.boardSent = undefined;

            if (on) {
                this.#sendBoard(client, this.subagents(client.user));
            }
        }
    }

    /** Send a tab's board its subagents, unless they are what it last got. */
    #sendBoard(client: Client, entries: SubagentEntry[]): void {
        const json = JSON.stringify(entries);

        if (json !== client.boardSent) {
            client.boardSent = json;
            client.send("subagents", entries);
        }
    }

    /** A conversation's shared view, opened when no tab has it open. Hand it to `releaseRoom` when done with it. */
    async room(id: ConversationId): Promise<Room> {
        if (this.pip.isInternal(id)) {
            throw new HttpError(404, "This session is not shared with you.");
        }

        let pending = this.#rooms.get(id);

        if (pending === undefined) {
            pending = (async () => {
                const conversation = await this.harness.conversation(id, context);

                if (conversation === undefined || this.pip.isInternal(id)) {
                    throw new HttpError(404, `Conversation ${String(id)} does not exist`);
                }

                const room = new Room(this, id);

                await room.open(conversation);

                return room;
            })();
            this.#rooms.set(id, pending);
            pending.catch(() => this.#rooms.delete(id));
        }

        return pending;
    }

    /** A conversation's shared view if it is open now; undefined otherwise, without opening it. */
    openRoom(id: ConversationId): Promise<Room> | undefined {
        return this.#rooms.get(id);
    }

    /** Close a room shortly after its last tab (or peek tile) left, unless one comes back first. */
    releaseRoom(room: Room): void {
        if (room.clients.size === 0 && room.peekers.size === 0) {
            room.closeLater(() => this.#rooms.delete(room.id));
        }
    }

    /** All signed-in models, with Pi's enabledModels scope marked for the picker. */
    async modelList() {
        // Pi settings are read from JSON; the SDK expects an array of strings.
        const configured = this.settings.getEnabledModels();
        const patterns = Array.isArray(configured)
            ? configured.filter((pattern): pattern is string => typeof pattern === "string")
            : [];
        // The scope asks Pi which models are available, which reads its sign-ins: one that cannot be read leaves the
        // scope out, as in a picker without one, rather than failing `hello` and with it every tab.
        const { scopedModels } =
            patterns.length > 0
                ? await resolveModelScopeWithDiagnostics(patterns, this.models).catch(() => ({
                      scopedModels: [],
                  }))
                : { scopedModels: [] };

        return modelList(this.models, this.signInNeeded, scopedModels);
    }

    async hello(user: User) {
        return {
            user: {
                id: user.id,
                name: user.name,
                role: user.role,
                ...(canContinuePiSessions(user) ? { continuePiSessions: true as const } : {}),
                ...(user.sessions === undefined ? {} : { sessions: user.sessions.map(Number) }),
                ...(user.projectAccess === undefined
                    ? {}
                    : { projectAccess: structuredClone(user.projectAccess) }),
            },
            users: this.people(user),
            models: await this.modelList(),
            guard: await this.guardStatus(),
            server: {
                supervised: this.supervised,
                startedAt: this.startedAt,
                webRevision: this.webRevision,
                home: homedir(),
                defaultCwd: this.defaultCwd,
                extensions: this.loader.extensionNames(),
                // The browser modules this person's tabs load (`extension-ui.js`), each with the tools its module
                // installs: the only ones whose calls it may describe (`pocket.toolCall`).
                ui: this.webs.clients(user),
                // The commands this person may run: viewers none, guests the ones for conversations.
                extensionCommands: this.webs
                    .commands()
                    .filter(
                        (command) =>
                            user.role === "owner" ||
                            (user.role === "guest" && command.scope === "conversation"),
                    ),
                // Tells the web app this server has people chat and typing indicators.
                chat: true,
                // Manual refresh reloads shared model configuration and catalogs; only the owner may start it.
                refreshModels: user.role === "owner",
                // Tells the web app this server sends peek tiles (`POST /api/peeks`, `peek` events).
                peeks: true,
                // This server's clock: peek tiles compare the browser's looks with when runs ended here.
                now: Date.now(),
                // Collaboration features: 2 adds roles, take turns, reactions, pins, notes, mentions, and push.
                collab: 2,
                // Comment-first reviews and session-folder-scoped live diffs, including viewers.
                localReviews: 2,
                reviewSuggestions: 1,
                // Durable project organization and independently typed threads.
                projects: 1,
                workItems: 1,
                workItemsEnabled: this.workItems.enabled,
                sshWorkspaces: 1,
                sshPasswords: 1,
                hostName: hostname(),
                agentProfiles: this.workItems
                    .profiles()
                    .map(({ id, name, description, title, starter, icon }) => ({
                        id,
                        name,
                        description,
                        title,
                        starter: starter === true,
                        ...(icon === undefined ? {} : { icon }),
                    })),
                // Owner-editable system instructions for the built-in thread agents.
                agentSettings: 1,
                // Owner-managed, restart-only Pi provider package compatibility.
                providerPackages: 1,
                providerRecovery: this.providerExtensions.recoveryRequired,
                reactions: REACTIONS,
                approvalRule: this.config.approvalRule,
                // The model and thinking level new sessions start with, or null for the last one picked.
                defaultModel: this.config.defaultModel ?? null,
                // The theme and colors of browsers that have not chosen their own, or null for the app's own.
                themeDefault: this.config.themeDefault ?? null,
                // The models Pi may start subagents on besides their session's own: the owner's to see and change.
                ...(user.role === "owner"
                    ? { subagentModels: [...this.config.subagentModels] }
                    : {}),
                // This person may have a PiP, the assistant over every screen (`pip.ts`).
                pip: this.pip.available(user),
                pipSettings: 1,
                privateAgents: 4,
                agentChatArchiveChildren: 1,
                // First-send drafts preserve an explicit project or explicit no-project intent.
                agentDraftProjects: 1,
                // Identity/project links in owner catalogues and revision-checked settings.
                projectAgentLinks: 1,
                pipEnabled: this.config.pipEnabled,
                // Shared mentions are separate from the owner's private PiP panel availability.
                pipMentions: true,
                // Tokens of context above which PiP compacts itself once idle; 0: only as sessions do.
                pipCompactAt: this.pipCompaction.compactAt,
            },
            // Read after the guard's wait, so a connecting device does not replace a live update with an older list.
            folderFavorites: await this.folderFavorites.list(user),
            // Every theme folder, for Appearance and for the look this tab uses (`theme.js`).
            themes: this.themes.list(user.role === "owner"),
        };
    }

    /** A tab's hello: what everyone gets, and the id of its own connection, which its peek lists name. */
    #helloFor(client: Client, hello: Awaited<ReturnType<PocketApp["hello"]>>) {
        return { ...hello, connection: client.connection };
    }

    /** Coalesce catalogue refreshes, including derived checkout context detected by rooms. */
    scheduleSessions(): void {
        if (this.#sessionsTimer !== undefined) {
            return;
        }

        this.#sessionsTimer = setTimeout(() => {
            this.#sessionsTimer = undefined;
            let board: SubagentEntry[] | undefined;

            for (const client of this.#clients) {
                this.#sendSessions(client);
                this.#sendPip(client);

                if (client.board === true) {
                    board ??= this.subagents();
                    this.#sendBoard(
                        client,
                        board.filter((entry) =>
                            this.canSee(client.user, entry.id as ConversationId),
                        ),
                    );
                }

                client.send("projects", this.projects.list(client.user));
            }
        }, 400);
    }

    /** Equality is per connection and per person: never reuse another person's catalogue projection. */
    #sendSessions(client: Client, user = client.user): void {
        const sessions = this.sessions(user);
        const json = JSON.stringify(sessions);

        if (json !== client.sessionsSent) {
            client.send("sessions", sessions);
            client.sessionsSent = json;
        }

        const current = this.config.userById(user.id);
        const agents =
            current?.role === "owner" && current.tokenHash === user.tokenHash
                ? this.pip.agents.list(user)
                : [];
        const privateJson = JSON.stringify(agents);

        if (privateJson !== client.namedAgentsSent) {
            client.send("namedAgents", agents);
            client.namedAgentsSent = privateJson;
        }
    }

    /** The session list, with who is in each session and its newest chat message. Scoped people see only theirs. */
    sessions(user?: User) {
        const waiting = new Set(
            this.approvals.all().map((approval) => String(this.rootOf(approval.conversationId))),
        );
        const people = new Map<string, Map<string, string>>();
        const subagents = this.#subagentsBySession();

        for (const client of this.#clients) {
            if (client.conversationId === undefined) {
                continue;
            }

            const key = String(client.conversationId);
            const here = people.get(key) ?? new Map<string, string>();

            here.set(client.user.id, client.user.name);
            people.set(key, here);
        }

        return Object.entries(this.#sessions)
            .filter(
                ([id, meta]) =>
                    meta.pip === undefined &&
                    (user === undefined || this.canSee(user, Number(id) as ConversationId)),
            )
            .map(([id, meta]) => {
                const model = this.#agents.get(Number(id) as unknown as ConversationId)?.model;
                const branch =
                    meta.location === undefined
                        ? this.workspace.head(Number(id) as ConversationId)
                        : this.#destinationHeads.peek(Number(id) as ConversationId, user);
                const busy = this.#busy.has(Number(id) as unknown as ConversationId);
                const here = [...(people.get(id) ?? new Map<string, string>())].map(
                    ([userId, name]) => ({ id: userId, name }),
                );
                const chat = this.#lastChat.get(id);
                const endedAt = this.#endedAt.get(Number(id) as unknown as ConversationId);
                const counts = countSubagents(subagents.get(id) ?? []);
                const { linkedFrom } = meta;
                // Linking does not share the origin: do not leak its id to someone who only sees the new chat.
                const origin =
                    linkedFrom === undefined ? undefined : this.#sessions[String(linkedFrom.id)];
                const visibleOrigin =
                    origin !== undefined &&
                    origin.pip === undefined &&
                    (user === undefined ||
                        this.canSee(user, linkedFrom!.id as unknown as ConversationId));

                const linkage: { linkedFrom?: SessionMeta["linkedFrom"]; linkedOrigin?: true } =
                    linkedFrom === undefined
                        ? {}
                        : visibleOrigin
                          ? { linkedFrom }
                          : { linkedOrigin: true };

                // Only current public catalogue fields belong in the session list.
                return {
                    id: Number(id),
                    cwd: meta.cwd,
                    ...(meta.location === undefined ? {} : { location: meta.location }),
                    createdAt: meta.createdAt,
                    updatedAt: meta.updatedAt,
                    ...(meta.title === undefined ? {} : { title: meta.title }),
                    ...(meta.createdBy === undefined ? {} : { createdBy: meta.createdBy }),
                    ...(meta.archived === undefined ? {} : { archived: meta.archived }),
                    ...(meta.projectId === undefined ? {} : { projectId: meta.projectId }),
                    ...(meta.workItemId === undefined ? {} : { workItemId: meta.workItemId }),
                    ...(meta.ownerOnly === undefined ? {} : { ownerOnly: meta.ownerOnly }),
                    ...(meta.imported === true || meta.fromPi !== undefined
                        ? { imported: true }
                        : {}),
                    ...(meta.forkedFrom === undefined ? {} : { forkedFrom: meta.forkedFrom }),
                    ...(meta.budget === undefined ? {} : { budget: meta.budget }),
                    ...(meta.worktree === undefined ? {} : { worktree: meta.worktree }),
                    ...linkage,
                    threadType: meta.threadType ?? "worker",
                    ...this.workItems.projection(Number(id) as ConversationId, user),
                    ...(user === undefined
                        ? {}
                        : this.pip.orchestration.navigation(Number(id) as ConversationId, user)),
                    busy,
                    waiting: waiting.has(id),
                    ...(endedAt === undefined ? {} : { endedAt }),
                    ...(this.#failed.has(Number(id) as unknown as ConversationId)
                        ? { failed: true }
                        : {}),
                    ...(model === undefined ? {} : { model: model.modelId }),
                    ...(branch === undefined ? {} : { branch }),
                    ...(here.length === 0 ? {} : { people: here }),
                    ...(chat === undefined ? {} : { chatAt: chat.at, chatBy: chat.userId }),
                    ...(counts === undefined ? {} : { subagents: counts }),
                };
            })
            .sort((a, b) => b.updatedAt - a.updatedAt);
    }

    isBusy(id: ConversationId): boolean {
        return this.#busy.has(id);
    }

    /** The conversations with a run going. */
    busyConversations(): ConversationId[] {
        return [...this.#busy];
    }

    /** The catalogue entry of a session; undefined for subagents and other conversations. */
    sessionMeta(id: ConversationId): SessionMeta | undefined {
        return this.#sessions[String(id)];
    }

    /** Every session's catalogue entry, PiP's included, by id. */
    sessionCatalogue(): Readonly<Record<string, SessionMeta>> {
        return this.#sessions;
    }

    /** When a session's last run ended, since this server started. */
    endedAt(id: ConversationId): number | undefined {
        return this.#endedAt.get(id);
    }

    async conversationTitle(id: ConversationId): Promise<string> {
        const meta = this.#sessions[String(id)];

        if (meta !== undefined) {
            return meta.title ?? "New session";
        }

        return `Conversation ${String(id)}`;
    }

    conversationInfo(room: Room, user?: User) {
        const meta = this.#sessions[String(room.id)];
        const agent = (room.value?.docs["pi.agent"] ?? {}) as AgentState;
        const forkedFrom = meta?.forkedFrom;
        const root = this.rootOf(room.id);
        const budget = this.#sessions[String(root)]?.budget;
        const workSupervisor =
            meta?.pipWorkItemId !== undefined && user !== undefined
                ? this.pip.orchestration.navigation(room.id, user).supervisor
                : undefined;

        return {
            id: room.id,
            kind:
                meta === undefined
                    ? room.parent === undefined
                        ? "conversation"
                        : "subagent"
                    : "session",
            title:
                meta?.title ??
                room.subagentName ??
                (meta === undefined ? `Conversation ${String(room.id)}` : "New session"),
            cwd: agent.cwd ?? meta?.cwd ?? this.cwdOf(room.id),
            ...(this.locationOf(room.id) === undefined
                ? {}
                : { location: this.locationOf(room.id) }),
            archived: meta?.archived === true,
            pipMentionAvailable: user !== undefined && this.pip.canMention(room.id, user),
            // PiP's own conversation, opened as a page: some session things (a PR to watch) are not for it.
            ...(meta?.pip === undefined ? {} : { pip: true }),
            ...(meta?.pipAgent === true ? { pipAgent: true, pipAgentId: meta.pipAgentId } : {}),
            ...(workSupervisor?.conversationId === Number(room.id) ? { workSupervisor } : {}),
            workflow: this.workItems.projection(room.id).workflow,
            ...(meta === undefined
                ? {}
                : {
                      threadType: meta.threadType ?? "worker",
                      ...(meta.projectId === undefined ? {} : { projectId: meta.projectId }),
                  }),
            ...(meta?.imported === true || meta?.fromPi !== undefined ? { imported: true } : {}),
            ...(meta?.ownerOnly === true ? { ownerOnly: true } : {}),
            ...(room.parent === undefined ? {} : { parent: room.parent }),
            ...(room.subagentName === undefined ? {} : { subagentName: room.subagentName }),
            // Each browser finds the source's title in its own session list, so only people who can open it get a link.
            ...(forkedFrom === undefined ? {} : { forkedFrom }),
            // The session's spend with its subagents', and its limit, with what counts against it.
            spend: {
                spent:
                    budget === undefined
                        ? this.spend.sessionSpent(root)
                        : this.spend.budgetSpent(root),
                ...(budget === undefined ? {} : { budget }),
            },
            ...(meta?.worktree === undefined
                ? {}
                : { worktree: { branch: meta.worktree.branch, source: meta.worktree.source } }),
            // Whether a fork could get a worktree of its own.
            ...(meta === undefined
                ? {}
                : {
                      inRepository:
                          this.locationOf(room.id) === undefined
                              ? this.workspace.inRepository(agent.cwd ?? meta.cwd)
                              : this.workspaceHead(room.id, user) !== undefined,
                  }),
        };
    }

    /** What a conversation runs with: its model, thinking level, folder, and instructions. */
    async agentState(id: ConversationId): Promise<AgentState | undefined> {
        return (
            this.#agents.get(id) ??
            ((await this.harness.snapshot(AgentDoc, id, context)) as AgentState | undefined)
        );
    }

    /** A conversation's handle; 404 when it does not exist. */
    async conversation(id: ConversationId): Promise<Conversation> {
        const conversation = await this.harness.conversation(id, context);

        // The lane may have been created while this read waited on the commit line.
        if (conversation === undefined || this.pip.isInternal(id)) {
            throw new HttpError(404, `Conversation ${String(id)} does not exist`);
        }

        return conversation;
    }

    /**
     * Why this person may not allow a call, or undefined when they may. With the "others" rule, a guest cannot allow a
     * call their own message led to; the owner always can. Denying is open to anyone who can steer.
     */
    cannotAllow(user: User, request: ApprovalRequest): string | undefined {
        if (user.role === "viewer") {
            return "You can view this session but not steer Pi.";
        }

        if (this.config.approvalRule !== "others" || user.role === "owner") {
            return undefined;
        }

        // Not knowing who asked is not knowing that it was someone else.
        if (request.requestedBy === undefined) {
            return "Nobody is known to have asked for this call, so only the owner can allow it.";
        }

        return request.requestedBy === user.id
            ? "Someone else has to allow a call that your message led to."
            : undefined;
    }

    async answerApproval(id: string, allow: boolean, user: User): Promise<boolean> {
        this.requireSteer(user);
        const request = this.approvals.all().find((each) => each.id === id);

        if (request === undefined || !this.canSee(user, request.conversationId)) {
            return false;
        }

        const refused = allow ? this.cannotAllow(user, request) : undefined;

        if (refused !== undefined) {
            throw new HttpError(403, refused);
        }

        if (this.#answeringApprovals.has(id)) {
            return false;
        }

        this.#answeringApprovals.add(id);
        const conversationId = request.conversationId;

        try {
            if (request.callId !== undefined) {
                const callId = request.callId;

                await this.harness.commit(async (tx) => {
                    if (this.approvals.all().find((each) => each.id === id) !== request) {
                        throw new HttpError(409, "This approval was superseded");
                    }

                    const current = this.config.userById(user.id);

                    if (current === undefined) {
                        throw new HttpError(401, "Your access was removed");
                    }

                    this.requireSteer(current);
                    this.requireSee(current, conversationId);
                    const denied = allow ? this.cannotAllow(current, request) : undefined;

                    if (denied !== undefined) {
                        throw new HttpError(403, denied);
                    }

                    (await tx.doc(DecisionsDoc, conversationId)).calls[callId] = {
                        allow,
                        by: current.name,
                        userId: current.id,
                        at: Date.now(),
                    };
                }, context);
            }

            if (
                this.approvals.all().find((each) => each.id === id) !== request ||
                !this.approvals.answer(id, { allow, by: user.name })
            ) {
                return false;
            }
        } finally {
            this.#answeringApprovals.delete(id);
        }

        await this.collab.activity(
            conversationId,
            user,
            `${allow ? "allowed" : "denied"} the ${request.tool} call: ${snippet(request.subject, 120)}`,
        );

        return true;
    }

    /** The owner changes someone's role, session scope, or explicit access to local Pi history. */
    setAccess(
        owner: User,
        userId: string,
        patch: {
            role?: unknown;
            sessions?: unknown;
            continuePiSessions?: unknown;
            projectAccess?: unknown;
        },
    ): void {
        const currentOwner = this.config.userById(owner.id);

        if (currentOwner?.role !== "owner" || currentOwner.tokenHash !== owner.tokenHash) {
            throw new HttpError(403, "Only the owner can do that");
        }

        const target = this.config.userById(userId);

        if (target === undefined) {
            throw new HttpError(404, "No such person");
        }

        if (target.role === "owner") {
            throw new HttpError(400, "The owner can do everything");
        }

        const change: {
            role?: "guest" | "viewer";
            sessions?: string[] | undefined;
            continuePiSessions?: true | undefined;
            projectAccess?: ProjectAccess;
        } = {};

        if (patch.role !== undefined) {
            if (patch.role !== "guest" && patch.role !== "viewer") {
                throw new HttpError(400, "role must be guest or viewer");
            }

            change.role = patch.role;
        }

        if (patch.sessions !== undefined) {
            if (patch.sessions === null) {
                change.sessions = undefined;
            } else if (
                Array.isArray(patch.sessions) &&
                patch.sessions.every((each) => this.#sessions[String(each)] !== undefined)
            ) {
                change.sessions = patch.sessions.map(String);
            } else {
                throw new HttpError(400, "sessions must be null or a list of session ids");
            }
        }

        if (patch.projectAccess !== undefined) {
            change.projectAccess = parseProjectAccess(patch.projectAccess);
        }

        if (patch.continuePiSessions !== undefined) {
            if (typeof patch.continuePiSessions !== "boolean") {
                throw new HttpError(400, "continuePiSessions must be a boolean");
            }

            const role = change.role ?? target.role;
            const sessions = "sessions" in change ? change.sessions : target.sessions;
            const projectAccess = change.projectAccess ?? target.projectAccess;

            if (
                patch.continuePiSessions &&
                (role !== "guest" || sessions !== undefined || projectAccess !== undefined)
            ) {
                throw new HttpError(
                    400,
                    "Only legacy unrestricted steering guests can continue Pi sessions; project collaborators cannot browse host history",
                );
            }

            change.continuePiSessions = patch.continuePiSessions ? true : undefined;
        }

        this.config.updateUser(userId, change);
        const updated = this.config.userById(userId);

        for (const client of [...this.#clients]) {
            if (client.user.id !== userId || updated === undefined) {
                continue;
            }

            if (
                client.conversationId !== undefined &&
                !this.canSee(updated, client.conversationId)
            ) {
                this.#evict(client, "This session is no longer shared with you.");
            }

            for (const id of client.peeks ?? []) {
                if (!this.canSee(updated, id)) {
                    client.peeks?.delete(id);
                    this.#unpeek(client, id);
                }
            }
        }

        void this.#refreshUser(userId);
        this.#peopleChanged();
    }

    removeUser(owner: User, userId: string): void {
        if (owner.role !== "owner") {
            throw new HttpError(403, "Only the owner can do that");
        }

        if (this.config.userById(userId)?.role === "owner") {
            throw new HttpError(400, "The owner cannot be removed");
        }

        this.#forget(userId);
    }

    /**
     * How other devices reach this server, from the launcher. People who signed in through another Cloudflare quick
     * tunnel can never sign in again (its address is gone, and their cookie works only there), so they are removed.
     */
    setReach(access: AccessInfo | undefined): void {
        this.access = access;
        let current: string | undefined;

        try {
            current = access?.url === undefined ? undefined : new URL(access.url).host;
        } catch {}

        for (const user of [...this.config.users]) {
            if (user.role !== "owner" && user.tunnel !== undefined && user.tunnel !== current) {
                this.#forget(user.id);
            }
        }
    }

    #forget(userId: string): void {
        this.sshSessions.revoke(userId);
        this.config.removeUser(userId);
        this.pushStore?.removeUser(userId);

        // Their open tabs end now; reconnecting fails, so they land on the sign-in screen.
        for (const client of [...this.#clients]) {
            if (client.user.id !== userId) {
                continue;
            }

            client.send("closing", {});
            this.detach(client);
            client.close?.();
        }

        this.#peopleChanged();
    }

    /** Take a tab out of a conversation it may no longer see; it keeps app-wide events. */
    #evict(client: Client, message: string): void {
        const id = client.conversationId;

        if (id === undefined) {
            return;
        }

        client.conversationId = undefined;
        client.send("missing", { conversationId: id, message });
        this.#leaveRoom(client, id);
    }

    /** Someone's rights changed: their tabs get a fresh hello and session list. */
    async #refreshUser(userId: string): Promise<void> {
        const user = this.config.userById(userId);

        if (user === undefined) {
            return;
        }

        for (const client of this.#clients) {
            if (client.user.id !== userId) {
                continue;
            }

            client.send("hello", this.#helloFor(client, await this.hello(user)));
            this.#sendSessions(client, user);

            // An open board too: it must not keep subagents of sessions no longer shared.
            if (client.board === true) {
                client.boardSent = undefined;
                this.#sendBoard(client, this.subagents(user));
            }

            client.send("projects", this.projects.list(user));
        }
    }

    async artifactBody(id: ConversationId, artifact: string, version: number | undefined) {
        const index = await this.harness.snapshot(ArtifactsDoc, id, context);
        const meta = index?.items[artifact] as ArtifactMeta | undefined;

        if (meta === undefined) {
            throw new HttpError(404, "No such artifact");
        }

        const chosen =
            version === undefined
                ? meta.versions.at(-1)
                : meta.versions.find((each) => each.version === version);

        if (chosen === undefined) {
            throw new HttpError(404, "No such version");
        }

        const body = await this.harness.snapshot(
            ArtifactBodyDoc,
            id,
            `${artifact}@${chosen.version}`,
            context,
        );

        if (body === undefined) {
            throw new HttpError(404, "Artifact content is missing");
        }

        return { meta, version: chosen.version, content: body.content };
    }

    /** The bound namespace is inherited by locally running subagents, never inferred from a path. */
    locationOf(id: ConversationId): WorkspaceLocation | undefined {
        return this.#sessions[String(this.rootOf(id))]?.location;
    }

    /** The folder a conversation works in. */
    cwdOf(id: ConversationId): string {
        return this.#agents.get(id)?.cwd ?? this.#sessions[String(id)]?.cwd ?? this.defaultCwd;
    }

    /** When Pi's settings were last read: Pi's CLI, or a person, can change them while pi-tava runs. */
    #settingsReadAt = Date.now();

    /**
     * What says where Pi's skills are, besides a session's folder: Pi's folder and settings, and the home folder. Pi's
     * settings are read again when the copy is older than `SETTINGS_STALE_MS`, in the background: a change (such as
     * `defaultProjectTrust`) counts from the request after.
     */
    #skillSources(): SkillSources {
        if (Date.now() - this.#settingsReadAt >= SETTINGS_STALE_MS) {
            this.#settingsReadAt = Date.now();
            this.settings.reload().catch(() => {
                // Unreadable now: the last good settings stay.
            });
        }

        let settingsPaths: string[] = [];
        let defaultProjectTrust: SkillSources["defaultProjectTrust"] = "ask";

        try {
            settingsPaths = this.settings.getSkillPaths();
            defaultProjectTrust = this.settings.getDefaultProjectTrust();
        } catch {
            // Unreadable settings: the default folders still count, and no project is trusted unasked.
        }

        return { agentDir: getAgentDir(), home: this.#home, settingsPaths, defaultProjectTrust };
    }

    /** Pi's skills for a session working in `cwd`, from the places Pi looks (`skills.ts`). */
    skills(cwd: string): Skill[] {
        return loadSessionSkills(cwd, this.#skillSources());
    }

    /**
     * Whether Pi trusts the project a conversation works in, and the project skills that wait for it. The owner's: the
     * skills may be in folders above the session's, which someone invited to it cannot see.
     */
    async projectTrust(id: ConversationId, user: User): Promise<ProjectTrust> {
        user = { ...user };
        this.#resourceOwner(id, user);

        if (this.locationOf(id) !== undefined) {
            return this.sshSessions.projectTrust(id, user);
        }

        return readProjectTrust(this.cwdOf(id), this.#skillSources());
    }

    /** The owner's answer to "trust this project?", saved where Pi's CLI keeps its own, as its `/trust` does. */
    async setProjectTrust(
        id: ConversationId,
        user: User,
        choice: TrustChoice,
    ): Promise<ProjectTrust> {
        user = { ...user };
        this.#resourceOwner(id, user);
        const cwd = this.cwdOf(id);
        const location = this.locationOf(id);
        const key = JSON.stringify(location);

        if (location !== undefined) {
            return this.sshSessions.setProjectTrust(id, user, choice);
        }

        const now = await this.projectTrust(id, user);

        if (now.unreadable) {
            throw new HttpError(
                409,
                "Pi's trust store (~/.pi/agent/trust.json) cannot be read, so no answer can be saved. Mend or delete it first.",
            );
        }

        if (choice === "trust-parent" && now.parent === undefined) {
            throw new HttpError(400, "This folder has no folder above it.");
        }

        this.#resourceOwner(id, user);

        if (cwd !== this.cwdOf(id) || key !== JSON.stringify(this.locationOf(id))) {
            throw new HttpError(
                409,
                "The workspace changed. Reload project trust before choosing.",
            );
        }

        saveProjectTrust(cwd, getAgentDir(), choice);

        return this.projectTrust(id, user);
    }

    #resourceOwner(id: ConversationId, supplied: User): User {
        const user = this.config.userById(supplied.id);

        if (user === undefined || user.tokenHash !== supplied.tokenHash || user.role !== "owner") {
            throw new HttpError(403, "Only the signed-in owner decides project trust.");
        }

        this.requireSee(user, id);

        return user;
    }

    /** Host orchestration resources, with remote project content read only through its pinned namespace. */
    async projectResources(
        id: ConversationId,
        context: Context,
        user?: User,
    ): Promise<{
        skills: Skill[];
        remoteSkills: RemoteProjectSkill[];
        templates: PromptTemplate[];
    }> {
        const cwd = this.cwdOf(id);

        if (this.locationOf(id) === undefined) {
            return {
                skills: this.skills(cwd),
                remoteSkills: [],
                templates: this.#templates(cwd, !projectDistrusted(cwd, this.#skillSources())),
            };
        }

        const remote = await this.sshSessions.projectResources(id, user, context);
        const skills = [...remote.skills, ...loadGlobalSkills(this.#skillSources())];

        return {
            skills: skills.filter(
                (skill, index) => skills.findIndex((each) => each.name === skill.name) === index,
            ),
            remoteSkills: remote.skills,
            templates: this.#templates(this.#home, false, remote.templates),
        };
    }

    /** Content-aware slash expansion never opens an SSH skill path on the Coop host. */
    async skillCommands(id: ConversationId, user?: User): Promise<SkillCommand[]> {
        const resources = await this.projectResources(id, BACKGROUND_CONTEXT, user);
        const remote = new Map(resources.remoteSkills.map((skill) => [skill.name, skill]));

        return resources.skills.map((skill) => {
            const base = {
                name: skill.name,
                description: skill.description,
                path: skill.filePath,
                baseDir: skill.baseDir,
            };
            const project = remote.get(skill.name);

            return project === undefined
                ? { ...base, source: "host" as const }
                : { ...base, source: "ssh" as const, content: project.content };
        });
    }

    /** Pi's prompt templates, as a conversation in its folder offers them. */
    async promptTemplates(id: ConversationId, user?: User): Promise<PromptTemplate[]> {
        return (await this.projectResources(id, BACKGROUND_CONTEXT, user)).templates;
    }

    #templates(
        cwd: string,
        project: boolean,
        projectTemplates?: readonly PromptTemplate[],
    ): PromptTemplate[] {
        let paths: string[] = [];

        try {
            paths = this.settings.getPromptTemplatePaths();
        } catch {
            // Unreadable settings: the default folders still count.
        }

        return loadPromptTemplates(cwd, getAgentDir(), paths, { project, projectTemplates });
    }

    // ─── Extensions ─────────────────────────────────────────────────────────

    /** Whether Lancet Guard's module is on here; Pi's own setting may still turn the guard off. */
    guardOn(): boolean {
        return this.loader.enabled(GUARD_FILE);
    }

    /** Lancet Guard as it applies here: Pi's own setting, unless the guard extension is off in pi-tava. */
    async guardStatus(): Promise<GuardStatus> {
        const status = await this.guard.status();

        if (this.guardOn()) {
            return status;
        }

        return {
            available: status.available,
            enabled: false,
            detail: "Lancet Guard is off in pi-tava: bash, write, and edit calls run unchecked here.",
        };
    }

    /** The extension modules, as this person may see them: where the server keeps files is for the owner only. */
    async extensions(
        user: User,
    ): Promise<{ modules: ExtensionInfo[]; guard: GuardStatus; dropIns?: string }> {
        const owner = user.role === "owner";
        // A load error can name the server's folders too.
        const packages = this.providerPackages.moduleState();
        const compatibility: ExtensionInfo = {
            file: PI_PROVIDERS_FILE,
            title: "Pi provider compatibility",
            source: "built-in",
            summary:
                "Hosts supported Pi provider packages headlessly. Changes apply after restart.",
            enabled: packages.enabled,
            active: packages.activeEnabled,
            required: false,
            restartOnly: true,
            restartRequired: packages.restartRequired,
            extensions: [],
            ...(packages.error === undefined ? {} : { error: packages.error }),
        };
        const modules = [...this.loader.list(), compatibility].map(
            ({ path, error, web, ...module }) =>
                owner
                    ? {
                          ...module,
                          ...(path === undefined ? {} : { path }),
                          ...(web === undefined ? {} : { web }),
                          ...(error === undefined ? {} : { error }),
                      }
                    : {
                          ...module,
                          ...(web?.client === undefined || !mayUseClient(user, web.client)
                              ? {}
                              : { web: { routes: [], client: web.client } }),
                          ...(error === undefined ? {} : { error: "It failed to load." }),
                      },
        );

        // The guard row shows Pi's own setting, so the owner can tell "off here" from "off everywhere".
        return {
            modules,
            guard: await this.guard.status(),
            ...(owner ? { dropIns: join(this.dataDir, "extensions") } : {}),
        };
    }

    /** Native owner setting: profiles and controls stay installed while managed execution is paused. */
    async setWorkItemsEnabled(supplied: User, enabled: unknown): Promise<void> {
        const user = this.config.userById(supplied.id);

        if (user === undefined || user.tokenHash !== supplied.tokenHash) {
            throw new HttpError(401, "Your access was removed or changed; sign in again");
        }

        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner can pause or resume Work Item execution");
        }

        if (typeof enabled !== "boolean") {
            throw new HttpError(400, "workItemsEnabled must be a boolean");
        }

        this.config.workItemsEnabled = enabled;
        this.scheduleSessions();

        for (const pending of this.#rooms.values()) {
            void pending.then(
                (room) => room.schedule(),
                () => {},
            );
        }

        await this.#refreshClients();
    }

    /** PiP stays installed while paused, preserving recovery tasks and private compaction safety. */
    async setPipEnabled(supplied: User, enabled: unknown): Promise<void> {
        const user = this.config.userById(supplied.id);

        if (user === undefined || user.tokenHash !== supplied.tokenHash) {
            throw new HttpError(401, "Your access was removed or changed; sign in again");
        }

        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner can pause or resume PiP");
        }

        if (typeof enabled !== "boolean") {
            throw new HttpError(400, "enabled must be a boolean");
        }

        this.config.pipEnabled = enabled;

        if (!enabled) {
            await this.pip.stopAll();
        }

        await this.#refreshClients();
    }

    /** Turn an extension module on or off for every session, now and after restarts. */
    async setExtensionEnabled(user: User, file: string, enabled: boolean): Promise<void> {
        if (file === PI_PROVIDERS_FILE) {
            if (user.role !== "owner") {
                throw new HttpError(403, "Only the owner can manage provider packages.");
            }

            await this.providerPackages.setModuleEnabled(enabled);
            await this.#refreshClients();
            this.notice("info", "Pi provider compatibility selection saved; restart to apply it.");

            return;
        }

        const module = this.loader.list().find((each) => each.file === file);

        if (module === undefined) {
            throw new HttpError(404, `There is no extension module ${file}`);
        }

        if (module.required && !enabled) {
            throw new HttpError(400, `${module.title} is required and cannot be turned off`);
        }

        if (module.enabled === enabled) {
            return;
        }

        this.config.setExtensionEnabled(file, enabled);

        try {
            await this.loader.apply(file);
        } catch (error) {
            throw new HttpError(
                500,
                `${module.title} is on but failed to load: ${describe(error)}`,
            );
        } finally {
            await this.#refreshClients();
        }

        if (file === GUARD_FILE && enabled) {
            void this.guard.warm().catch(() => {});
        }

        if (file === BROWSER_FILE && !enabled) {
            await this.browsers.closeAll();
        }

        this.notice(
            enabled ? "info" : "warning",
            `${user.name} turned ${module.title} ${enabled ? "on" : "off"}.`,
        );
    }

    async reloadExtension(file: string): Promise<void> {
        if (file === PI_PROVIDERS_FILE) {
            throw new HttpError(409, "Pi provider compatibility changes require a server restart.");
        }

        const module = this.loader.list().find((each) => each.file === file);

        if (module === undefined) {
            throw new HttpError(404, `There is no extension module ${file}`);
        }

        if (!module.enabled) {
            throw new HttpError(409, `${module.title} is off`);
        }

        try {
            await this.loader.reload(file);
        } catch (error) {
            throw new HttpError(500, `${module.title} failed to load: ${describe(error)}`);
        } finally {
            await this.#refreshClients();
        }
    }

    /** The owner changes who may allow risky calls. */
    async setApprovalRule(user: User, rule: unknown): Promise<void> {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner can do that");
        }

        if (rule !== "anyone" && rule !== "others") {
            throw new HttpError(400, "approvalRule must be anyone or others");
        }

        if (rule === this.config.approvalRule) {
            return;
        }

        this.config.approvalRule = rule;
        await this.#refreshClients();
        this.notice(
            "info",
            rule === "others"
                ? `${user.name} made approvals need someone other than who asked.`
                : `${user.name} let anyone who can steer allow risky calls.`,
        );
    }

    /** The owner chooses when PiP compacts itself: above so many tokens of context once idle, or (0) as sessions do. */
    async setPipCompactAt(supplied: User, tokens: unknown): Promise<void> {
        const user = this.config.userById(supplied.id);

        if (user === undefined || user.tokenHash !== supplied.tokenHash) {
            throw new HttpError(401, "Your access was removed or changed; sign in again");
        }

        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner can do that");
        }

        if (typeof tokens !== "number" || !PIP_COMPACT_CHOICES.includes(tokens)) {
            throw new HttpError(
                400,
                `pipCompactAt must be one of ${PIP_COMPACT_CHOICES.join(", ")}`,
            );
        }

        if (tokens === this.pipCompaction.compactAt) {
            return;
        }

        this.config.pipCompactAt = tokens;
        await this.#refreshClients();
    }

    /**
     * The theme and colors browsers start with until their person chooses (`config.themeDefault`): the owner's to set,
     * or `null` for the app's own. Everyone's tabs hear it in `hello`.
     */
    async setThemeDefault(user: User, choice: unknown): Promise<void> {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner sets the default theme");
        }

        if (choice === null) {
            this.config.themeDefault = undefined;
        } else {
            const { look, colors } = (choice ?? {}) as { look?: unknown; colors?: unknown };

            if (
                typeof look !== "string" ||
                typeof colors !== "string" ||
                !THEME_ID.test(look) ||
                !THEME_ID.test(colors.replace(/@(dark|light)$/, ""))
            ) {
                throw new HttpError(
                    400,
                    "The default is { look, colors }: a theme's id and colors' id, or null",
                );
            }

            if (!this.themes.list().some((each) => each.id === look && each.usable)) {
                throw new HttpError(404, "No such theme");
            }

            // Unavailable colors would leave new browsers without a usable palette.
            if (!(await this.themes.hasColors(colors))) {
                throw new HttpError(404, "No such colors here");
            }

            this.config.themeDefault = { look, colors };
        }

        await this.#refreshClients();
    }

    /**
     * The owner's default after a theme went (removed in Appearance or the gallery, or its folder deleted): a theme that
     * is gone gives way to Pocket, and its unavailable colors to Tokyo Night; with both gone, no default.
     * Everyone's tabs hear it.
     */
    async #themeDefaultStillHere(): Promise<void> {
        const before = this.config.themeDefault;

        // When the owner's themes could not be read at the start, they are not gone: keep the default for the next start.
        if (before === undefined || this.themes.failure !== undefined) {
            return;
        }

        try {
            const lookGone =
                before.look !== BASE_THEME &&
                !this.themes.list().some((each) => each.id === before.look);
            const colorsGone = !(await this.themes.hasColors(before.colors));

            if (!lookGone && !colorsGone) {
                return;
            }

            const look = lookGone ? BASE_THEME : before.look;
            const colors = colorsGone ? "tokyo-night" : before.colors;

            this.config.themeDefault =
                look === BASE_THEME && colors === "tokyo-night" ? undefined : { look, colors };
            await this.#refreshClients();
        } catch (error) {
            this.#log(`The default theme could not be checked: ${describe(error)}`);
        }
    }

    /**
     * The owner picks the model and thinking level new sessions start with: a signed-in model, its level kept to one it
     * has. Null leaves it to the last model picked, as before there was a choice.
     */
    async setDefaultModel(user: User, choice: unknown): Promise<void> {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner can do that");
        }

        if (choice === null) {
            if (this.config.defaultModel !== undefined) {
                this.config.defaultModel = undefined;
                await this.#refreshClients();
            }

            return;
        }

        const asked = (typeof choice === "object" ? choice : {}) as {
            provider?: unknown;
            modelId?: unknown;
            thinkingLevel?: unknown;
        };

        if (
            typeof asked.provider !== "string" ||
            typeof asked.modelId !== "string" ||
            (asked.thinkingLevel !== undefined && !isThinkingLevel(asked.thinkingLevel))
        ) {
            throw new HttpError(
                400,
                `defaultModel must be null, or { provider, modelId, thinkingLevel? } with thinkingLevel one of ${THINKING_LEVELS.join(", ")}`,
            );
        }

        const model = this.models
            .getAvailableSnapshot()
            .find((each) => each.provider === asked.provider && each.id === asked.modelId);

        if (model === undefined) {
            throw new HttpError(
                400,
                `Model ${asked.provider}/${asked.modelId} is not available: sign in to its provider first.`,
            );
        }

        const thinkingLevel = clampThinkingLevel(
            model,
            (asked.thinkingLevel ?? "off") as ModelThinkingLevel,
        );
        const before = this.config.defaultModel;

        if (
            before?.provider === model.provider &&
            before.modelId === model.id &&
            before.thinkingLevel === thinkingLevel
        ) {
            return;
        }

        this.config.defaultModel = { provider: model.provider, modelId: model.id, thinkingLevel };
        await this.#refreshClients();
    }

    /**
     * Whether a provider's sign-in expired and needs a person to sign in again: the model menu and a session's model chip
     * mark its models, and subagents on another model are refused them (`resolveModel`). A session's own run still tries.
     */
    readonly signInNeeded = (provider: string): boolean =>
        this.providers.needsSignIn(provider) !== undefined;

    /**
     * Replace the owner's shared model list (`provider/modelId`, models Pi knows). Background subagents always offer
     * an optional model parameter: empty leaves explicit choices unrestricted; nonempty restricts extra models, never
     * the parent's own. Linked sessions always require extra models to be listed, so empty means parent only. The
     * Providers sheet changes one entry at a time (`allowSubagentModel`). Availability checks are separate.
     */
    async setSubagentModels(user: User, models: unknown): Promise<void> {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner can do that");
        }

        if (
            !Array.isArray(models) ||
            models.length > MAX_SUBAGENT_MODELS ||
            models.some((each) => typeof each !== "string")
        ) {
            throw new HttpError(
                400,
                `subagentModels must be a list of at most ${String(MAX_SUBAGENT_MODELS)} models, each provider/modelId`,
            );
        }

        const chosen: string[] = [];

        for (const spec of models as string[]) {
            const slash = spec.indexOf("/");
            const model =
                slash > 0
                    ? this.models.getModel(spec.slice(0, slash), spec.slice(slash + 1))
                    : undefined;

            if (model === undefined) {
                throw new HttpError(400, `${spec} is not a model Pi knows (provider/modelId).`);
            }

            const key = `${model.provider}/${model.id}`;

            if (!chosen.includes(key)) {
                chosen.push(key);
            }
        }

        await this.#saveSubagentModels(chosen);
    }

    /**
     * Add or remove one entry in the shared model list, keeping the rest: what the Providers sheet sends, so two
     * quick taps, or two tabs, never undo each other. The list is read and written with no wait between, so changes
     * that come together all count. Removing the last entry restores unrestricted background model choices, but
     * leaves linked sessions parent-only. A removed model need not be one Pi still knows. Returns the current list.
     */
    async allowSubagentModel(
        user: User,
        model: unknown,
        allowed: unknown,
    ): Promise<readonly string[]> {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner can do that");
        }

        if (typeof model !== "string" || typeof allowed !== "boolean") {
            throw new HttpError(400, "Send model (provider/modelId) and allowed (true or false).");
        }

        const current = this.config.subagentModels;
        let chosen = current.filter((each) => each !== model);

        if (allowed) {
            const slash = model.indexOf("/");
            const found =
                slash > 0
                    ? this.models.getModel(model.slice(0, slash), model.slice(slash + 1))
                    : undefined;

            if (found === undefined) {
                throw new HttpError(400, `${model} is not a model Pi knows (provider/modelId).`);
            }

            const key = `${found.provider}/${found.id}`;

            chosen = current.includes(key) ? [...current] : [...current, key];

            if (chosen.length > MAX_SUBAGENT_MODELS) {
                throw new HttpError(
                    400,
                    `At most ${String(MAX_SUBAGENT_MODELS)} models can be allowed for subagents.`,
                );
            }
        }

        await this.#saveSubagentModels(chosen);

        return this.config.subagentModels;
    }

    /**
     * Save the shared model list, reload subagents to refresh their guidance, and tell the owner's tabs, the only
     * ones whose hello carries the list. The optional model parameter stays present even when the list is empty.
     */
    async #saveSubagentModels(chosen: readonly string[]): Promise<void> {
        const before = this.config.subagentModels;

        if (JSON.stringify(before) === JSON.stringify(chosen)) {
            return;
        }

        this.config.subagentModels = chosen;

        // Refresh the guidance for the next request of every session; explicit model choices remain in the schema.
        if (this.loader.enabled(SUBAGENTS_FILE)) {
            try {
                await this.loader.reload(SUBAGENTS_FILE);
            } catch (error) {
                // A module's error can name the server's folders: the owner's to read.
                this.ownerNotice("error", `Subagents failed to reload: ${describe(error)}`);
            }
        }

        await this.#refreshClients((user) => user.role === "owner");
        this.ownerNotice(
            "info",
            chosen.length === 0
                ? "Background subagent model restrictions cleared. New linked sessions use their source model."
                : `Additional model choices restricted to ${chosen.join(", ")}. Parent/source models remain allowed.`,
        );
    }

    /** Send clients a fresh hello, every one or those of the people `to` names: what it carries changed. */
    async #refreshClients(to: (user: User) => boolean = () => true): Promise<void> {
        for (const client of this.#clients) {
            if (to(client.user)) {
                client.send("hello", this.#helloFor(client, await this.hello(client.user)));
            }
        }
    }

    // ─── Browser ────────────────────────────────────────────────────────────

    /** The browser is on while its extension module is: the owner turns both off together in Extensions. */
    browserOn(): boolean {
        return this.loader.extensionNames().includes(BROWSER_EXTENSION);
    }

    #browserEvent(conversationId: ConversationId, state: BrowserState) {
        return { conversationId: Number(conversationId), ...state };
    }

    // ─── Shutdown ───────────────────────────────────────────────────────────

    close(): Promise<void> {
        this.#closing ??= (async () => {
            const failures: unknown[] = [];

            const attempt = async (name: string, close: () => unknown): Promise<boolean> => {
                try {
                    await close();

                    return true;
                } catch (error) {
                    failures.push(new Error(`pi-tava could not close ${name}.`, { cause: error }));

                    return false;
                }
            };

            const headsClosed = attempt("destination reads", () => this.#destinationHeads.close());
            const sshClosed = attempt("SSH sessions", () => this.sshSessions.close());
            const agentsClosed = attempt("private agents", () => this.pip.agents.close());
            const privateClosed = attempt("private sessions", () => this.privateSessions.close());
            const alertsClosed = attempt("alerts", () => this.alerts.close());
            const pipClosed = attempt("PiP", () => this.pip.close());

            clearTimeout(this.#sessionsTimer);
            await attempt("themes", () => this.themes.close());
            await attempt("spend", () => this.spend.close());
            await attempt("commit subscription", () => this.#unsubscribeCommits?.());
            await attempt("approval subscription", () => this.#unsubscribeApprovals?.());
            await attempt("browser subscription", () => this.#unsubscribeBrowsers?.());

            // Attach rejection handling immediately, including when a partial startup never made a loader.
            const cleaned = attempt("extensions", () => this.loader?.close());

            clearTimeout(this.#websTimer);

            for (const client of this.#clients) {
                await attempt("client", () => client.send("closing", {}));
            }

            for (const pending of this.#rooms.values()) {
                await attempt("room", async () => (await pending).close());
            }

            await attempt("provider sign-ins", () => this.providers.close());
            await attempt("language services", () => this.languages.close());
            await Promise.all([headsClosed, agentsClosed, pipClosed, sshClosed]);
            await attempt("private terminals", () => this.privateTerminals.close());
            await Promise.all([privateClosed, alertsClosed]);

            // Preserve the bounded extension cleanup policy, without letting a rejection skip storage close.
            let limit: NodeJS.Timeout | undefined;

            try {
                await Promise.race([
                    cleaned,
                    new Promise<void>((resolve) => {
                        limit = setTimeout(resolve, CLEANUP_LIMIT_MS);
                    }),
                ]);
            } finally {
                clearTimeout(limit);
            }

            await attempt("diagnostics", () => this.diagnostics.close());
            // Database closure and native-work settlement are separate facts. SQLite can reject before
            // any Harness exists: retain its lock, but still dispose providers and other unused resources.
            let nativeWorkStopped = this.harness === undefined && !this.#harnessOpening;
            const storageClosed = await attempt("storage", async () => {
                if (this.harness !== undefined) {
                    await this.harness.close(context);
                    nativeWorkStopped = true;

                    return;
                }

                if (this.#harnessOpening) {
                    throw new Error(
                        "Harness startup did not return a handle; native work and storage closure are unconfirmed.",
                    );
                }

                if (this.#openingStorage !== undefined) {
                    await this.#openingStorage.close(context);

                    return;
                }

                if (this.#storageOpening) {
                    throw new Error(
                        "SQLite startup did not confirm closure; retaining the data-directory lock.",
                    );
                }
            });

            if (storageClosed) {
                this.#openingStorage = undefined;
            }

            if (nativeWorkStopped) {
                // Never unregister providers or tear down execution resources beneath native work.
                await attempt("provider extensions", () => this.providerExtensions?.close());

                for (const env of this.#envs.values()) {
                    await attempt("execution environment", () => env.cleanup(context));
                }

                // A cut-off browser call is interrupted before its browser resources disappear.
                await attempt("browsers", () => this.browsers.closeAll({ final: true }));
            }

            if (storageClosed) {
                await attempt("data-directory lock", () => this.#releaseLock?.());
            }

            if (failures.length > 0) {
                throw new AggregateError(failures, "pi-tava shutdown was incomplete.");
            }
        })();

        return this.#closing;
    }
}
