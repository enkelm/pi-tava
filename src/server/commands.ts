/**
 * What people ask of Pi: start and rename sessions, send messages (steer or queue), edit queued input, stop, withdraw,
 * and change a conversation's model, thinking level, or folder; compact or reset its context and set its instructions;
 * fork it or send a message again; set plan mode, a goal, or scheduled messages; and remove a session's worktree.
 * Every command checks access; changes others should know about become activity lines in the session's chat.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
    clampThinkingLevel,
    type ImageContent,
    type ModelThinkingLevel,
    type TextContent,
} from "@earendil-works/pi-ai";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import {
    type AgentChange,
    AgentDoc,
    type ConversationCreateOptions,
    type ConversationId,
    type ConversationHandle,
    configure as configureAgent,
    defineTask,
    type EntryId,
    InboxDoc,
    LiveDoc,
    type ModelRef,
    type SettledSubmissionRecord,
    type SubmissionId,
    type SubmissionRecord,
    type Task,
    type TaskRuntime,
    type Tx,
} from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import {
    AuthorsDoc,
    ChatDoc,
    NotesDoc,
    PinsDoc,
    PlanDoc,
    type Schedule,
    SessionCreatesDoc,
    SessionsDoc,
    STOPPED,
    type SubagentRecord,
    SubagentsDoc,
} from "./docs.ts";
import {
    ATTACHMENTS_HEADING,
    FILE_BLOCK,
    FROM_PREFIX,
    NOTE_ENTRY,
    isWorkItemEvent,
    type WorkItemEvent,
    splitAttachments,
} from "./entry-format.ts";
import { WorkflowDoc } from "./workflow-docs.ts";
import { handoffInputKey } from "./handoff-input.ts";
import { describe, HttpError, optionalText } from "./errors.ts";
import { homePath } from "./paths.ts";
import { type FileView, mentionedPaths } from "./files.ts";
import { modelSelection } from "./models.ts";
import { snippet } from "./projection.ts";
import { globalModelSettings, projectModelDefault } from "./project-model.ts";
import { parseWorkspaceLocation } from "./workspace-location.ts";
import { WorkspaceBackend } from "./workspace-backend.ts";
import { userWorkspaceBackend } from "./workspace-backend-factory.ts";
import { expandPromptTemplate, expandSkillCommand, unwrapSkill } from "./prompts.ts";
import { queuedInputText } from "./queued-input.ts";
import { clientKey, ownRequest, requestFor } from "./requests.ts";
import { type Resend, resendContent, resendRequest, ResendTask, userContent } from "./resend.ts";
import { whyUnanswered } from "./subagent-runs.ts";
import { createSessionRoot } from "./session-roots.ts";
import { wantsTitle, writeTitle } from "./titles.ts";
import { describeMoment, describeRepeat, knownZone } from "./when.ts";
import {
    createWorktree,
    discardWorktree,
    inWorktreeAt,
    removeWorktree,
    sourceFolder,
    worktreeStorage,
    type Worktree,
    type WorktreePolicy,
} from "./worktrees.ts";

const context = BACKGROUND_CONTEXT;

export type Attachment = { path: string; name: string; mime: string; size: number };

/** Trusted native creation carries its real invocation fence through preparation and publication. */
export type SessionCreationSource = {
    context: Context;
    requireCurrent(tx: Tx): Promise<void>;
};

type CreateSessionOptions = {
    projectDefaults?: boolean;
    source?: SessionCreationSource;
};

export type CreateSessionRequest = {
    cwd?: string;
    location?: unknown;
    title?: string;
    worktree?: unknown;
    projectId?: unknown;
    threadType?: unknown;
    requestId?: string;
};

export type SessionPatch = {
    title?: string;
    archived?: boolean;
    projectId?: unknown;
};

export interface SubmitRequest {
    text: string;
    attachments?: Attachment[];
    /** `steer` joins the running work after its current tool round; anything else queues a follow-up while busy. */
    mode?: "steer" | "followUp";
    /** Client-generated, so a retried POST does not submit twice. */
    requestId: string;
    /** Send the files the message mentions with `@` along with it, so Pi need not read them first. */
    inlineFiles?: boolean;
    /** The exact pending question shown in this Work Item's private PiP chat. */
    pipQuestionId?: string;
}

/** Attached images that also go to the model itself, when it takes images. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_INLINE_IMAGE = 5 * 1024 * 1024;
/** How many `@` mentioned files go along with a message, and how much of them. */
const MAX_MENTIONED = 10;
const MAX_MENTIONED_FILE = 100_000;
const MAX_MENTIONED_TOTAL = 300_000;
const IMAGE_MIME: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
};
const MAX_TITLE = 120;
/** A title as stored: one line, so it cannot pass for more lines where it is quoted (PiP's lists, reports). */
const oneLine = (title: string): string => title.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
/**
 * What a subagent's name drops where it is quoted, to keep its letters, marks, and digits, in every script ("हिन्दी",
 * "サーバー"), its spaces, and ". _ -": no mark of its own then closes the quotes. Every quote mark goes, and every other
 * sign or symbol ("″", "´"); every control, those that turn the text around, hide, or end its isolate too; and the
 * modifier letters that are quote marks or apostrophes in form ("ʺ", "ʼ", "ˮ", the Greek "ʹ", NKo's "ߴ", the saltillo
 * "ꞌ").
 */
const UNQUOTED = /[^\p{L}\p{M}\p{N}\s._-]|[\u02B0-\u02FF\u0374\u07F4\u07F5\uA78B\uA78C]/gu;
/** A mark with no letter or digit under it (first, or after a space), which would sit on the quote beside it. */
const UNBORNE = /(?<![\p{L}\p{M}\p{N}])\p{M}+/gu;

/**
 * A person's activity line when they dealt with a subagent's failure, in its parent session: Pi named it, so quoted, and
 * isolated (U+2068 … U+2069), so a name that ends in right-to-left letters keeps the closing quote and what follows (the
 * line's clock) after it. It cannot end the isolate itself: such controls are among what it drops.
 */
export const dealtWith = (name: string): string => {
    const shown = snippet(name.replace(UNQUOTED, "").replace(UNBORNE, ""), 60);

    return `dealt with the failure of subagent “\u2068${shown}\u2069”`;
};

/** What dismissing a subagent's failure came to: `newer` when it failed again since the failure seen. */
type Dismissal = { dismissed: boolean; newer?: true };
/** The extension that makes plan mode block changes; without it, plan mode would do nothing. */
const PLAN_EXTENSION = "pocket-plan";
/** What Pi is told when someone approves its plan. */
const PLAN_APPROVED = "The plan is approved. Go ahead and carry it out.";
/** Longest handoff note for a new context, and longest instructions for Pi. */
const MAX_HANDOFF = 20_000;
const MAX_INSTRUCTIONS = 8000;

/** Where a new session works: a folder, and the worktree it is in when the session has one of its own. */
type Place = { cwd: string; worktree?: Worktree; skipped: string[] };

/** Pi Durable 1.0.2 exposes this transaction read at runtime but omits it from the public Tx type. */
type SubmissionTx = Tx & {
    submission(id: SubmissionId): Promise<SubmissionRecord | undefined>;
};

/** An entry id from a request, or a 400. */
function entryIdOf(value: unknown): number {
    const id = Number(value);

    if (!Number.isInteger(id) || id < 0) {
        throw new HttpError(400, "entryId must be a message id");
    }

    return id;
}

/**
 * An image file for the model, at most 2000 pixels a side as Pi's read tool sends images: models refuse bigger ones once
 * a conversation holds many, and then every request fails until they leave its context.
 */
async function modelImage(bytes: Buffer, mimeType: string): Promise<ImageContent> {
    const image = await resizeImage(bytes, mimeType);

    if (image === null) {
        throw new Error("it could not be made small enough for the model");
    }

    return { type: "image", mimeType: image.mimeType, data: image.data };
}

/** A person's message to a failed subagent (`subagent`, its conversation), followed to its end; `failure`, its own then. */
type Followed = { subagent: number; requestId: string; failure: number; by: string };

/**
 * What a person's run of subagent `id` came to, on its record in its parent's `doc`, kept as its reports keep what Pi's
 * work came to: answered, it is done and needs nobody; unanswered, it failed again (or was stopped), which is its
 * failure now, and needs someone even if the one before was dismissed. Not while its record holds a failure newer than
 * `failure`, the one they wrote to: nobody saw that one. The subagent's name when this cleared its failure.
 */
function settle(
    doc: { agents: Record<string, SubagentRecord> },
    id: ConversationId,
    failure: number,
    result: { status: string; reason?: string; detail?: unknown },
): string | undefined {
    const name = Object.keys(doc.agents).find((each) => doc.agents[each]!.conversationId === id);
    const record = name === undefined ? undefined : doc.agents[name]!;

    if (record === undefined || (record.failed === true && (record.answeredAt ?? 0) !== failure)) {
        return undefined;
    }

    const cleared = record.failed === true && result.status !== "unanswered" ? name : undefined;

    record.answeredAt = Date.now();
    record.failed = result.status === "unanswered";

    if (result.status === "unanswered") {
        record.error = whyUnanswered(result.reason ?? "", result.detail);
    } else {
        delete record.error;
    }

    return cleared;
}

/**
 * What a person's message (`requestId`) to subagent `id` came to; undefined when it is not there, or is left in the
 * subagent's queue with no run to take it. Pi Durable leaves a failed run's queue alone, so a message sent while a run
 * went on, which then failed, waits for the next one someone sends, if anyone does: its follow ends then, and the
 * message stays where it is. Its known request id gives back the message sent, as it is now: nothing is sent again.
 */
async function followed(
    runtime: TaskRuntime<Followed, { phase: "wait" }, null, object>,
    id: ConversationId,
    requestId: string,
    context: Context,
): Promise<SettledSubmissionRecord | undefined> {
    // Where it is: gone, left (queued with no run), or sent. One commit reads both, and writes nothing.
    const where = async () => {
        let found = "gone" as "gone" | "left" | "sent";

        await runtime.commit(async (tx) => {
            const record = await tx.submissionByRequest(id, requestId);

            if (record !== undefined) {
                found =
                    record.status === "queued" && (await tx.doc(LiveDoc, id)).run === undefined
                        ? "left"
                        : "sent";
            }

            return undefined;
        }, context);

        return found;
    };

    if ((await where()) !== "sent") {
        return undefined;
    }

    const submission = await (
        await runtime.conversation(id, context)
    )?.submit({ type: "input", content: "", requestId }, context);
    const watch = await runtime.watchDoc(LiveDoc, id, context);
    let leave!: () => void;
    const left = new Promise<undefined>((resolve) => {
        leave = () => resolve(undefined);
    });
    // The look under way, if any: one the watch started may still be going when it stops.
    let looking: Promise<void> = Promise.resolve();

    // Each time the subagent has no run, a look at whether this message is left behind. A failed one is reported.
    const look = (live: { run?: unknown } | null) => {
        if (live !== null && live.run === undefined) {
            looking = where().then(
                (found) => (found === "left" ? leave() : undefined),
                (error: unknown) => runtime.report(error),
            );
        }

        return looking;
    };

    if (submission === undefined) {
        await watch?.stop();

        return undefined;
    }

    try {
        if (watch !== undefined) {
            // A listener is never called inline, so the value it started on is this one's to look at.
            await look(watch.value);
            watch.start(look);
        }

        return await Promise.race([submission.wait(context), left]);
    } finally {
        // On every way out, so no watch outlives the phase, nor a look its commit.
        await watch?.stop();
        await looking;
    }
}

export class Commands {
    readonly #app: PocketApp;
    /**
     * Follows a person's message to a failed subagent to its end and settles the failure by it (`settle`): a task of the
     * parent's, beside its work, so a restart before the run ends still settles it, as the subagent's reports do Pi's
     * work. It finds the message by its request id, and never sends one (`followed`). Answered, the parent's activity
     * says who dealt with the failure. A message left in the queue by a run that failed ends it, settling nothing.
     */
    readonly followTask: Task<Followed, { phase: "wait" }, null, object>;
    /** Close/Restore ordering must not hold the supervision lane that cancelled tools need. */
    readonly #namedChatUpdates = new Map<ConversationId, Promise<void>>();
    readonly #creating = new Map<
        string,
        { input: string; promise: Promise<{ id: ConversationId }> }
    >();

    constructor(app: PocketApp) {
        this.#app = app;
        this.followTask = defineTask<Followed, { phase: "wait" }, null>({
            name: "pocket.follow-failure",
            version: 1,
            initial: () => ({ phase: "wait" }),
            phases: {
                wait: async (task, runtime, context) => {
                    const { subagent, requestId, failure, by } = task.input;
                    const id = subagent as unknown as ConversationId;
                    const settled = await followed(runtime, id, requestId, context);
                    let cleared: string | undefined;

                    await runtime.commit(async (tx) => {
                        if (settled !== undefined) {
                            cleared = settle(
                                await tx.doc(SubagentsDoc, runtime.conversationId),
                                id,
                                failure,
                                settled,
                            );
                        }

                        return {
                            status: "terminal",
                            outcome: { status: "completed", result: null },
                        };
                    }, context);

                    const user = app.config.userById(by);

                    if (cleared !== undefined && user !== undefined) {
                        await app.collab.activity(runtime.conversationId, user, dealtWith(cleared));
                    }
                },
            },
            abort: (_task, runtime, context) =>
                runtime.commit(
                    () => ({ status: "terminal", outcome: { status: "aborted" } }),
                    context,
                ),
        });
    }

    /** Start a typed thread, deriving its directory from the project unless explicitly overridden. */
    async createSession(
        user: User,
        request: CreateSessionRequest,
        options: CreateSessionOptions = {},
    ): Promise<{ id: ConversationId }> {
        user = { ...user };
        this.#requireCreate(user);
        await this.#requireCreationSource(options.source);
        const asked = optionalText(request.requestId, "requestId");
        const key = asked === undefined ? undefined : `${user.id}:${clientKey(asked)}`;
        const input = JSON.stringify({
            cwd: optionalText(request.cwd, "cwd"),
            title: optionalText(request.title, "title"),
            worktree: request.worktree === true,
            projectId: request.projectId,
            threadType: request.threadType,
            ...(request.location === undefined
                ? {}
                : { location: parseWorkspaceLocation(request.location) ?? null }),
        });

        if (key === undefined) {
            return this.#createSession(user, request, undefined, options);
        }

        const pending = this.#creating.get(key);

        if (pending !== undefined) {
            if (pending.input !== input) {
                throw new HttpError(
                    409,
                    "This creation request already has a different destination.",
                );
            }

            const result = await pending.promise;

            await this.#requireCreationSource(options.source);

            return result;
        }

        const promise = this.#createSession(user, request, { key, input }, options);

        this.#creating.set(key, { input, promise });

        try {
            return await promise;
        } finally {
            this.#creating.delete(key);
        }
    }

    #requireCurrentUser(supplied: User): User {
        const user = this.#app.config.userById(supplied.id);

        if (user === undefined || user.tokenHash !== supplied.tokenHash) {
            throw new HttpError(401, "Your access changed. Sign in again.");
        }

        return user;
    }

    #requireCreate(supplied: User): void {
        const user = this.#requireCurrentUser(supplied);

        this.#app.requireSteer(user);

        if (user.sessions !== undefined) {
            throw new HttpError(403, "You were invited to one session and cannot start new ones.");
        }
    }

    async #requireCreationSource(source?: SessionCreationSource): Promise<void> {
        if (source !== undefined) {
            source.context.abortSignal?.throwIfAborted();
            await this.#app.harness.commit((tx) => source.requireCurrent(tx), source.context);
            source.context.abortSignal?.throwIfAborted();
        }
    }

    async #createSession(
        user: User,
        request: CreateSessionRequest,
        receipt: { key: string; input: string } | undefined,
        { projectDefaults = true, source }: CreateSessionOptions,
    ): Promise<{ id: ConversationId }> {
        const app = this.#app;
        const ctx = source?.context ?? context;
        const check = () => this.#requireCreationSource(source);

        if (receipt !== undefined) {
            const saved = (await app.harness.snapshot(SessionCreatesDoc, ctx))?.items[receipt.key];

            await check();

            if (saved !== undefined) {
                if (saved.input !== receipt.input) {
                    throw new HttpError(
                        409,
                        "This creation request already has a different destination.",
                    );
                }

                app.requireSee(user, saved.id as ConversationId);

                return { id: saved.id as ConversationId };
            }
        }

        await check();
        const selection = app.projects.prepare(user, request);
        const given = optionalText(request.title, "title");
        const title = (given === undefined ? undefined : oneLine(given)) || undefined;
        const location =
            request.location === undefined
                ? selection.location
                : parseWorkspaceLocation(request.location);

        const sameLocation = location?.host === selection.location?.host;
        const askedFolder =
            optionalText(request.cwd, "cwd") ??
            (sameLocation ? selection.cwd : undefined) ??
            (location === undefined ? app.defaultCwd : "~");

        if (
            user.role !== "owner" &&
            (selection.projectId === undefined ||
                !sameLocation ||
                askedFolder !== selection.cwd ||
                request.worktree === true)
        ) {
            throw new HttpError(
                403,
                "Collaborators use the shared project's fixed destination; only the owner can choose a different directory or worktree",
            );
        }

        const folder =
            user.role !== "owner"
                ? selection.cwd!
                : location === undefined
                  ? app.workspace.checkDirectory(askedFolder)
                  : await app.sshSessions.prepare(user, { cwd: askedFolder, location }, ctx);

        await check();
        const now = Date.now();
        const create = (backend?: WorkspaceBackend) =>
            this.#inPlace(
                folder,
                request.worktree === true,
                title ?? basename(folder),
                async ({ cwd, worktree }) => {
                    await check();
                    this.#requireCreate(user);
                    // An internal caller about to apply a person's explicit model keeps its previous starting pair.
                    const remoteDefault =
                        projectDefaults &&
                        user.role === "owner" &&
                        location !== undefined &&
                        app.config.defaultModel === undefined
                            ? await app.sshSessions.modelDefault(user, location.host, cwd, ctx)
                            : undefined;

                    await check();
                    const initial =
                        remoteDefault ??
                        this.#defaultModel(
                            undefined,
                            projectDefaults && location === undefined ? cwd : undefined,
                        );

                    return app.harness.commit(async (tx) => {
                        // ConversationInit runs after the first table write. Native source
                        // authority reads tasks/submissions, so check it here before creation.
                        ctx.abortSignal?.throwIfAborted();
                        await source?.requireCurrent(tx);
                        this.#requireCreate(user);
                        const placement = await app.projects.place(tx, selection);
                        const id = await createSessionRoot(tx, {
                            agent: {
                                cwd,
                                ...(initial.model === undefined ? {} : { model: initial.model }),
                                ...(initial.thinkingLevel === undefined
                                    ? {}
                                    : { thinkingLevel: initial.thinkingLevel }),
                            },
                            meta: {
                                cwd,
                                ...(location === undefined ? {} : { location }),
                                ...placement,
                                createdAt: now,
                                updatedAt: now,
                                createdBy: user.id,
                                ...(title === undefined ? {} : { title }),
                                ...(worktree === undefined ? {} : { worktree }),
                            },
                        });

                        if (receipt !== undefined) {
                            const creates = await tx.doc(SessionCreatesDoc);

                            creates.items[receipt.key] = {
                                id: Number(id),
                                input: receipt.input,
                            };
                        }

                        return { id };
                    }, ctx);
                },
                { offline: selection.threadType !== "chat", backend, context: ctx, check },
            );

        return location !== undefined && request.worktree === true
            ? app.sshSessions.prepare(user, { location, cwd: folder }, ctx, async (backend) => {
                  await check();

                  return create(backend);
              })
            : create();
    }

    /**
     * Run `create` with the folder a new session works in: `cwd` itself, or, when `isolated`, the matching folder in a
     * new git worktree made from it, named after `label`. A worktree whose session `create` did not make is discarded.
     */
    async #inPlace<T>(
        cwd: string,
        isolated: boolean,
        label: string,
        create: (place: Place) => Promise<T>,
        policy: WorktreePolicy = {},
    ): Promise<T> {
        if (!isolated) {
            return create({ cwd, skipped: [] });
        }

        await policy.check?.();
        const folder = await worktreeStorage(
            policy.backend ?? WorkspaceBackend.local(cwd, policy.context),
            join(this.#app.dataDir, "worktrees"),
            policy,
        );
        const made = await createWorktree(cwd, folder, label, policy);

        try {
            return await create(made);
        } catch (error) {
            await discardWorktree(made.worktree, policy).catch((cleanup: unknown) =>
                this.#app.log(`worktree ${made.worktree.path} left behind: ${describe(cleanup)}`),
            );

            throw error;
        }
    }

    /** Remove a session's worktree folder; its branch stays. One with uncommitted changes stays too, unless `force`. */
    async removeWorktree(id: ConversationId, user: User, force: unknown): Promise<void> {
        const app = this.#app;

        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner can remove a thread's worktree destination");
        }

        app.requireSee(user, id);
        await app.requireDriver(id, user);
        const worktree = app.sessionMeta(id)?.worktree;

        if (worktree === undefined) {
            throw new HttpError(404, "This session has no worktree");
        }

        app.workItems.requireWritable(id);
        const members = app.workItems.members(id);
        const memberIds = new Set(members.map(Number));

        if (app.sessionMeta(id)?.workItemId !== undefined && force === true) {
            throw new HttpError(409, "Workflow cleanup never force-removes dirty worktrees");
        }

        for (const member of members) {
            app.requireSee(user, member);
        }

        if (members.length > 1) {
            await app.harness.commit((tx) => app.workItems.requireIdle(tx, id), context);
        }

        const backend = userWorkspaceBackend(app, id, context, user);
        const destination = JSON.stringify(app.locationOf(id));
        const inside = (each: ConversationId) =>
            JSON.stringify(app.locationOf(each)) === destination
                ? inWorktreeAt(worktree, app.cwdOf(each), backend)
                : Promise.resolve(false);

        // Equal path strings on another destination do not share or occupy this worktree.
        const occupied = await Promise.all(app.busyConversations().map(inside));

        if (occupied.some(Boolean)) {
            throw new HttpError(409, "Pi is working in the worktree: stop it first.");
        }

        // A fork made without a worktree of its own works in this one.
        const candidates = app.sessions().filter((session) => !memberIds.has(session.id));
        const shared = await Promise.all(
            candidates.map((session) => inside(session.id as ConversationId)),
        );
        const sharing = candidates.find((_, index) => shared[index]);

        if (sharing !== undefined) {
            throw new HttpError(
                409,
                `“${sharing.title ?? "New session"}” works in this worktree too. Move it to another folder first.`,
            );
        }

        const policy = { offline: () => app.workItems.isManaged(id), backend };
        const moves: { id: ConversationId; cwd: string }[] = [];

        for (const each of members.flatMap((member) => app.conversationsOf(member))) {
            if (await inside(each)) {
                moves.push({
                    id: each,
                    cwd: await sourceFolder(worktree, app.cwdOf(each), policy),
                });
            }
        }

        await removeWorktree(worktree, force === true, policy);

        // The session and its subagents go back to the folders the worktree came from.
        for (const move of moves) {
            await (await app.conversation(move.id)).configure({ cwd: move.cwd }, context);
        }

        const cwd = app.cwdOf(id);

        await app.harness.commit(async (tx) => {
            const sessions = await tx.doc(SessionsDoc);

            for (const member of members) {
                const meta = sessions.items[String(member)];

                if (meta === undefined) {
                    continue;
                }

                delete meta.worktree;
                meta.cwd = app.cwdOf(member);

                if (meta.workItemId !== undefined) {
                    const workflow = await tx.doc(WorkflowDoc, member);

                    workflow.readyForPublish = false;

                    if (workflow.status === "landed" || workflow.status === "review-complete") {
                        workflow.status = "needs-review";
                    }
                }
            }
        }, context);
        await app.collab.activity(
            id,
            user,
            `removed the worktree; the branch ${worktree.branch} stays, and Pi works in ${homePath(cwd)} again`,
        );
    }

    /** The model and thinking level a new session starts with now. */
    defaultModel(): { model?: ModelRef; thinkingLevel?: ModelThinkingLevel } {
        return this.#defaultModel();
    }

    /**
     * The model a new session starts with, always one a person chose: `prefer` (with its thinking level) when it is
     * signed in here, or else the owner's default, even when it is not signed in now: the session then shows that, and
     * its first message fails in sight, where another model would spend on what nobody chose for it. Without an owner's
     * default, ordinary sessions consult trusted project defaults in their final cwd, then the last picked model,
     * then Pi's global default. A no-cwd caller (imports and PiP itself) keeps the legacy default selection. Never
     * the first model there is: with none chosen, the session starts without a model, and someone picks one.
     */
    #defaultModel(
        prefer?: {
            model: { provider: string; modelId: string } | null;
            thinkingLevel: string;
        },
        cwd?: string,
    ): {
        model?: ModelRef;
        thinkingLevel?: ModelThinkingLevel;
    } {
        const { models, config, settings } = this.#app;
        const available = models.getAvailableSnapshot();
        const pick = (provider: string | undefined, id: string | undefined) =>
            provider === undefined || id === undefined
                ? undefined
                : available.find((model) => model.provider === provider && model.id === id);
        const last = config.lastModel;
        const preferred = pick(prefer?.model?.provider, prefer?.model?.modelId);
        const chosen = config.defaultModel;
        const owners =
            chosen === undefined ? undefined : models.getModel(chosen.provider, chosen.modelId);
        const defaults =
            chosen === undefined && cwd !== undefined ? globalModelSettings(cwd) : settings;
        const project =
            chosen === undefined && cwd !== undefined
                ? projectModelDefault(cwd, defaults, models)
                : undefined;
        const lastPicked =
            chosen === undefined && project === undefined
                ? pick(last?.provider, last?.modelId)
                : undefined;
        // Ordinary sessions must not inherit a different project's settings from the server's starting folder.
        // Imported sessions and PiP's own conversation keep their existing selection behavior.
        const global = cwd === undefined ? undefined : defaults.getGlobalSettings();
        const pis =
            chosen === undefined && project === undefined && lastPicked === undefined
                ? pick(
                      cwd === undefined ? settings.getDefaultProvider() : global?.defaultProvider,
                      cwd === undefined ? settings.getDefaultModel() : global?.defaultModel,
                  )
                : undefined;
        const model = preferred ?? owners ?? project?.model ?? lastPicked ?? pis;

        if (model === undefined) {
            return {};
        }

        const level = ((preferred !== undefined
            ? prefer?.thinkingLevel
            : owners !== undefined
              ? chosen?.thinkingLevel
              : project !== undefined
                ? project.thinkingLevel
                : lastPicked !== undefined
                  ? last?.thinkingLevel
                  : cwd === undefined
                    ? settings.getDefaultThinkingLevel()
                    : global?.defaultThinkingLevel) ?? "off") as ModelThinkingLevel;

        return {
            model: { provider: model.provider, modelId: model.id },
            thinkingLevel: clampThinkingLevel(model, level),
        };
    }

    async updateSession(
        id: ConversationId,
        user: User,
        patch: SessionPatch,
        options: { archiveOwned?: true } = {},
    ): Promise<"unchanged" | void> {
        const app = this.#app;

        app.requireSee(user, id);
        app.requireSteer(user);
        optionalText(patch.title, "title");

        if (patch.archived !== undefined && typeof patch.archived !== "boolean") {
            throw new HttpError(400, "archived must be true or false");
        }

        if (patch.archived === false && app.workItems.itemFor(id) !== undefined) {
            user = await app.workItems.waitForRestore(id, user);
        }

        const before = app.sessionMeta(id);

        const namedChat = before?.pipAgent === true;

        if (options.archiveOwned && (!namedChat || patch.archived !== true)) {
            throw new HttpError(409, "Owned Close requires a saved named Chat.");
        }

        const placing = Object.hasOwn(patch, "projectId");

        if (
            (namedChat || before?.pip !== undefined || before?.pipWorkItemId !== undefined) &&
            (!namedChat ||
                app.pip.agents.scope(id)?.ownerId !== user.id ||
                patch.archived === undefined ||
                patch.title !== undefined ||
                placing)
        ) {
            throw new HttpError(
                409,
                "Use PiP settings for other changes. Only a bound saved named Chat can be archived or restored here.",
            );
        }

        if (placing) {
            if (patch.title !== undefined || patch.archived !== undefined) {
                throw new HttpError(400, "Move a thread separately from renaming or archiving it.");
            }

            await app.projects.assign(user, id, patch);

            return;
        }

        let unchanged = false;
        const update = () =>
            app.harness.commit(async (tx) => {
                return app.workItems.updateSession(
                    tx,
                    id,
                    user,
                    {
                        ...(patch.title === undefined ? {} : { title: oneLine(patch.title) }),
                        ...(patch.archived === undefined ? {} : { archived: patch.archived }),
                    },
                    options,
                );
            }, context);

        if (namedChat) {
            const previous = this.#namedChatUpdates.get(id) ?? Promise.resolve();
            const pending = previous
                .catch(() => {})
                .then(async () => {
                    // Fence source authority in order with tool admission, then release that lane
                    // before joining tools which may themselves already be queued on it.
                    const children = await app.pip.agents.supervision.perform(id, update);

                    if (children === undefined) {
                        unchanged = true;

                        return;
                    }

                    if (patch.archived === true) {
                        // Ownership was captured before revoking this source. Join outside the lane:
                        // children may have native tools waiting for the same admission locks.
                        await Promise.all([
                            (await app.conversation(id)).abort(context, { background: true }),
                            ...children.map((child) => app.workItems.interrupt(child)),
                        ]);
                        await app.pip.agents.execution.release(id, { exactChat: true });
                        await app.pip.agents.contacts.settleRevoked();
                    }
                });

            this.#namedChatUpdates.set(id, pending);

            try {
                // Only lifecycle requests share this wait; Restore cannot overtake native join.
                await pending;
            } finally {
                if (this.#namedChatUpdates.get(id) === pending) {
                    this.#namedChatUpdates.delete(id);
                }
            }
        } else {
            await update();
        }

        if (unchanged) {
            return "unchanged";
        }

        const title = patch.title === undefined ? undefined : oneLine(patch.title);

        if (title !== undefined && title !== "" && title !== before?.title) {
            await app.collab.activity(id, user, `renamed the session to “${title}”`);
        }

        if (patch.archived !== undefined && patch.archived !== (before?.archived === true)) {
            await app.collab.activity(
                id,
                user,
                patch.archived
                    ? "archived the session"
                    : "brought the session back from the archive",
            );
        }
    }

    /** Native lifecycle join only; callers must wait outside transactions and supervision locks. */
    namedChatLifecycle(id: ConversationId): Promise<void> | undefined {
        return this.#namedChatUpdates.get(id);
    }

    #requireOpenNamedChat(id: ConversationId): void {
        const root = this.#app.rootOf(id);
        const meta = this.#app.sessionMeta(root);

        if (meta?.pipAgent === true && meta.archived === true) {
            throw new HttpError(409, "This Chat is closed. Restore it before sending fresh input.");
        }
    }

    /** Passive recovery of this person's input acknowledgement; never submit or retry model work. */
    async submissionReceipt(id: ConversationId, user: User, requestId: unknown) {
        const app = this.#app;

        app.requireSee(user, id);
        app.requireSteer(user);

        if (
            typeof requestId !== "string" ||
            requestId.length > 160 ||
            !/[A-Za-z0-9_-]/.test(requestId)
        ) {
            throw new HttpError(400, "A valid input requestId is required");
        }

        const ownedRequest = ownRequest(user.id, clientKey(requestId));
        const submission = await app.harness.commit(
            (tx) => tx.submissionByRequest(id, ownedRequest),
            context,
        );

        if (submission?.type !== "input") {
            return undefined;
        }

        return {
            submissionId: submission.id,
            requestId: ownedRequest,
            handoffRequestKey: handoffInputKey(user.id, id, ownedRequest),
        };
    }

    /**
     * Send a message to Pi as `user`. With `via`, an assistant (PiP) sends it for them: it is marked as sent through it,
     * and is theirs to pay for and steer, but not their own words (`requestFor`). Only server code passes `via`.
     */
    async submit(
        id: ConversationId,
        user: User,
        request: SubmitRequest,
        via?: string,
        nativeSender?: ConversationHandle,
        appEvent?: WorkItemEvent,
    ): Promise<{
        submissionId: SubmissionId;
        requestId: string;
        handoffRequestKey?: string;
    }> {
        user = { ...user };
        const app = this.#app;

        if (nativeSender !== undefined && (nativeSender.id !== id || via === undefined)) {
            throw new HttpError(
                400,
                "An invocation-bound native sender must retain its exact service recipient.",
            );
        }

        if (
            appEvent !== undefined &&
            (via === undefined || !app.pip.orchestration.isScoped(id) || !isWorkItemEvent(appEvent))
        ) {
            throw new HttpError(
                400,
                "Application events require a native Work Item supervisor input.",
            );
        }

        const initialUser = this.#requireCurrentUser(user);

        app.requireSee(initialUser, id);
        this.#requireOpenNamedChat(id);
        await app.requireDriver(id, initialUser);

        // PiP turned off takes nothing, from its person either: it would run without its rules, and be compacted without
        // its own summary (`pip-compact.ts`). What else goes to it (reports, schedules, watches) waits meanwhile.
        if (app.pip.ownerOf(id) !== undefined && !app.pip.available(user)) {
            throw new HttpError(409, "PiP is turned off in Extensions.");
        }

        if (request.pipQuestionId !== undefined) {
            if (via !== undefined || (request.attachments?.length ?? 0) > 0) {
                throw new HttpError(400, "Reply to PiP's question with text in its private chat.");
            }

            return app.pip.orchestration.answerFromChat(id, initialUser, {
                questionId: request.pipQuestionId,
                text: request.text,
                requestId: request.requestId,
            });
        }

        if (
            via === undefined &&
            app.pip.orchestration.isScoped(id) &&
            request.requestId !== undefined
        ) {
            const receipt = await this.submissionReceipt(id, initialUser, request.requestId);

            if (receipt !== undefined) {
                return receipt;
            }
        }

        const conversation = await app.conversation(id);
        const typed = request.text.trim();

        if (app.workItems.isPreparing(id)) {
            throw new HttpError(
                409,
                "Wait for the requested handoff summary before sending more work",
            );
        }

        // `/skill:name request` sends the skill with the request; `/name arguments`, Pi's prompt template of that name.
        const text = /^\/handoff(?:\s|$)/i.test(typed)
            ? typed
            : typed.startsWith("/skill:")
              ? (expandSkillCommand(typed, await app.skillCommands(id, user)) ?? typed)
              : typed.startsWith("/")
                ? (expandPromptTemplate(typed, await app.promptTemplates(id, user)) ?? typed)
                : typed;
        const attachments = request.attachments ?? [];

        if (text === "" && attachments.length === 0) {
            throw new HttpError(400, "Nothing to send");
        }

        const agent = await app.agentState(id);
        const model =
            agent?.model === undefined
                ? undefined
                : app.models.getModel(agent.model.provider, agent.model.modelId);

        if (model === undefined) {
            throw new HttpError(409, "Pick a model for this conversation first.");
        }

        app.spend.check(user, id);

        const lines = attachments.map(
            (file) =>
                `- ${file.path} (${file.name}, ${file.mime || "unknown type"}, ${file.size} bytes)`,
        );
        // The heading whole, with files alone too: what reads the message splits it there.
        const written =
            lines.length === 0 ? text : `${text}${ATTACHMENTS_HEADING}${lines.join("\n")}`;
        const body = this.messageText(
            user,
            via === undefined ? written : `[via ${via}] ${written}`,
        );
        const mentioned =
            request.inlineFiles === true
                ? await this.#mentionedFiles(id, user, typed, model.input.includes("image"))
                : [];
        const first: TextContent & { pocketAppEvent?: WorkItemEvent } = {
            type: "text",
            text: body,
            ...(appEvent === undefined ? {} : { pocketAppEvent: appEvent }),
        };
        const parts: (TextContent | ImageContent)[] = [first, ...mentioned];

        for (const file of attachments) {
            if (
                !model.input.includes("image") ||
                !IMAGE_TYPES.has(file.mime) ||
                file.size > MAX_INLINE_IMAGE
            ) {
                continue;
            }

            try {
                parts.push(await modelImage(readFileSync(file.path), file.mime));
            } catch (error) {
                app.notice("warning", `Could not attach ${file.name}: ${describe(error)}`, id);
            }
        }

        const content = parts.length === 1 && appEvent === undefined ? body : parts;
        const requestId =
            via === undefined
                ? ownRequest(user.id, clientKey(request.requestId))
                : requestFor(user.id, clientKey(request.requestId));
        // A failed subagent's failure as the person writes to it: what their message comes to settles it.
        const failure = await this.#failureOf(id);

        await app.requireDriver(id, this.#requireCurrentUser(user));
        const current = this.#requireCurrentUser(user);

        app.requireSee(current, id);
        app.requireSteer(current);
        app.spend.check(current, id);

        const admit = async () => {
            const liveUser = this.#requireCurrentUser(user);

            await app.requireDriver(id, liveUser);
            app.requireSee(this.#requireCurrentUser(user), id);
            this.#requireOpenNamedChat(id);
            app.spend.check(liveUser, id);

            if (app.pip.orchestration.isScoped(id)) {
                const grant = app.workItems.itemFor(id)?.supervisor;

                app.workItems.controllerCurrent(id, grant?.epoch, via !== undefined);
            }

            // This is Durable's real invocation-bound admission, not an app preflight called atomic.
            // Private source/target activation is separately fenced from the already-persisted intent.
            return (nativeSender ?? conversation).submit(
                {
                    type: "input",
                    content,
                    whenBusy: request.mode === "steer" ? "steer" : "followUp",
                    requestId,
                },
                context,
            );
        };

        const submission = await app.pip.agents.input(
            id,
            current,
            requestId,
            () =>
                via === undefined
                    ? app.pip.agents.contacts.humanInput(id, () =>
                          app.pip.orchestration.input(id, current, requestId, admit),
                      )
                    : admit(),
            via !== undefined,
        );

        app.collab.setTyping(id, user, null);

        // Invocation-bound private contacts are fenced at native activation. Do not start the
        // separate ad-hoc title model (or rename its recipient) outside that accepted run.
        if (nativeSender === undefined) {
            await this.#touched(id, typed, text === typed ? undefined : text);
        }

        // A person's own words: linked sessions may message each other again (`linked-sessions.ts`).
        if (via === undefined) {
            await app.linkedSessions.personWrote(id);
        }

        this.#reportUnanswered(id, submission.wait(context));

        if (failure !== undefined) {
            await this.#followFailure(id, user, failure, requestId);
        }

        return {
            submissionId: submission.id,
            requestId,
            ...(via === undefined
                ? { handoffRequestKey: handoffInputKey(user.id, id, requestId) }
                : {}),
        };
    }

    /** When a subagent (`id`, its conversation) failed, if it is failed now (not stopped); undefined otherwise. */
    async #failureOf(id: ConversationId): Promise<number | undefined> {
        const parent = this.#app.parentOf(id);

        if (parent === undefined) {
            return undefined;
        }

        const agents = (await this.#app.harness.snapshot(SubagentsDoc, parent, context))?.agents;
        const record = Object.values(agents ?? {}).find((each) => each.conversationId === id);

        return record?.failed === true && record.error !== STOPPED
            ? (record.answeredAt ?? 0)
            : undefined;
    }

    /**
     * Follow a person's message (`requestId`) to failed subagent `id` to its end, in a task of its parent's (`followTask`).
     * The message went: a failure to start following it is logged, not answered.
     */
    async #followFailure(
        id: ConversationId,
        user: User,
        failure: number,
        requestId: string,
    ): Promise<void> {
        const app = this.#app;
        const parent = app.parentOf(id);

        if (parent === undefined) {
            return;
        }

        try {
            await app.harness.commit(async (tx) => {
                await tx.createTask(
                    this.followTask,
                    { subagent: Number(id), requestId, failure, by: user.id },
                    {
                        ownership: { kind: "conversation" },
                        background: true,
                        conversationId: parent,
                    },
                );
            }, context);
        } catch (error) {
            app.log(`not following a message to ${String(id)}: ${describe(error)}`);
        }
    }

    /**
     * A person dealt with a failed subagent (`id`, its conversation): seen or dismissed, it needs nobody now, on the
     * board, the rail, or the session list, until it fails again. `at` is the failure they saw (its `answeredAt`): a
     * newer one still needs them, and `newer` says so. Not dismissed either when it has no failure, or someone dealt
     * with it already.
     */
    async dismissSubagent(id: ConversationId, user: User, at: unknown): Promise<Dismissal> {
        const app = this.#app;

        app.requireSee(user, id);
        app.requireSteer(user);

        if (typeof at !== "number" || !Number.isFinite(at)) {
            throw new HttpError(400, "at must be the time of the failure seen");
        }

        if (app.parentOf(id) === undefined) {
            throw new HttpError(404, "Not a subagent");
        }

        return this.#dismissFailure(id, user, at);
    }

    /**
     * Mark a subagent's failure, the one at `at`, dealt with by `user`, as the parent's activity says: as
     * `dismissSubagent` answers.
     */
    async #dismissFailure(id: ConversationId, user: User, at: number): Promise<Dismissal> {
        const parent = this.#app.parentOf(id);
        let name: string | undefined;

        if (parent === undefined) {
            return { dismissed: false };
        }

        const answer = await this.#app.harness.commit(async (tx): Promise<Dismissal> => {
            const agents = (await tx.doc(SubagentsDoc, parent)).agents;

            name = Object.keys(agents).find((each) => agents[each]!.conversationId === id);
            const record = name === undefined ? undefined : agents[name]!;
            // Its failure is known by when it failed; a failure from before that was recorded has none.
            const failure = record?.answeredAt ?? 0;

            if (
                record === undefined ||
                record.failed !== true ||
                record.error === STOPPED ||
                record.dealtAt === failure
            ) {
                return { dismissed: false };
            }

            if (at !== failure) {
                return { dismissed: false, newer: true };
            }

            record.dealtAt = failure;

            return { dismissed: true };
        }, context);

        if (answer.dismissed && name !== undefined) {
            await this.#app.collab.activity(parent, user, dealtWith(name));
        }

        return answer;
    }

    /**
     * The files a message mentions with `@`, for Pi: text files as `<file>` blocks, as Pi's terminal app sends files
     * given on its command line, and images as images when the model takes them. Only files this person may load
     * through the session; anything else stays a mention, which Pi can read itself.
     */
    async #mentionedFiles(
        id: ConversationId,
        user: User,
        text: string,
        images: boolean,
    ): Promise<(TextContent | ImageContent)[]> {
        const app = this.#app;
        const parts: (TextContent | ImageContent)[] = [];

        const remote = app.locationOf(id) !== undefined;
        let total = 0;

        for (const mention of mentionedPaths(text).slice(0, MAX_MENTIONED)) {
            let file: string | undefined;
            let view: FileView | undefined;

            for (const candidate of mention.candidates) {
                try {
                    // Reuse the authorized Files boundary, including its namespace and read bounds.
                    const opened = await app.workspace.viewFile(id, user, candidate);

                    if (opened.kind !== "folder" && opened.kind !== "other") {
                        file = opened.path;
                        view = opened;
                        break;
                    }
                } catch {
                    // Not there, or not this person's to load. Never try the other machine.
                }
            }

            if (file === undefined || view === undefined) {
                continue;
            }

            try {
                const mime = IMAGE_MIME[extname(file).toLowerCase()];

                if (mime !== undefined) {
                    if (images && view.kind === "image" && view.size <= MAX_INLINE_IMAGE) {
                        const bytes = remote
                            ? await app.workspace.imageBytes(id, user, file)
                            : readFileSync(file);

                        parts.push(await modelImage(bytes, mime));
                    }

                    continue;
                }

                if (view.kind !== "text" || total >= MAX_MENTIONED_TOTAL) {
                    continue;
                }

                const room = Math.min(MAX_MENTIONED_FILE, MAX_MENTIONED_TOTAL - total);
                const content = view.text.slice(0, room);

                total += content.length;
                const cut =
                    view.truncated || view.text.length > room
                        ? "\n… (the rest of the file is left out)"
                        : "";

                parts.push({
                    type: "text",
                    text: `${FILE_BLOCK}${file}">\n${content}${cut}\n</file>`,
                });
            } catch (error) {
                app.notice("warning", `Could not send ${mention.written}: ${describe(error)}`, id);
            }
        }

        return parts;
    }

    /** A message to Pi as the model gets it: with more than one person on this server, it says who is talking. */
    messageText(user: Pick<User, "name">, text: string): string {
        return this.#app.config.users.length > 1
            ? `[from: ${user.name.replace(/[[\]]/g, "")}] ${text}`
            : text;
    }

    /**
     * A session just got a message: it moves up the list, and its first message names it. A long first message gets a
     * short title written for it afterwards (`titles.ts`), and so does a command (`/skill:name`, a prompt template),
     * whose name says little: written from the command and what it `expanded` to, which says what it asks (a skill's
     * instructions without the paths of its files, which would pull the title toward a folder's name).
     */
    async #touched(id: ConversationId, text: string, expanded?: string): Promise<void> {
        if (this.#app.sessionMeta(id) === undefined) {
            return;
        }

        let provisional: string | undefined;

        await this.#app.harness.commit(async (tx) => {
            const meta = (await tx.doc(SessionsDoc)).items[String(id)];

            if (meta === undefined) {
                return;
            }

            meta.updatedAt = Date.now();

            if (meta.title === undefined && text !== "") {
                meta.title = provisional = text.replace(/\s+/g, " ").slice(0, 80);
            }
        }, context);

        // Private chats use the first input itself, not an extra unbound paid title-model lane.
        if (
            provisional !== undefined &&
            !this.#app.pip.agents.isNamed(id) &&
            (expanded !== undefined || wantsTitle(text))
        ) {
            void writeTitle(
                this.#app,
                id,
                expanded === undefined ? text : `${text}\n\n${unwrapSkill(expanded)}`,
                provisional,
            );
        }
    }

    /**
     * A line in the transcript about something a person did that Pi should know about, such as undoing a file's
     * changes. Pi gets it too, with its next message; while Pi works, it waits for a place in the conversation.
     */
    async note(id: ConversationId, user: User, text: string): Promise<void> {
        const conversation = await this.#app.conversation(id);
        const model = [
            {
                role: "user" as const,
                content: [{ type: "text" as const, text: `[note] ${user.name} ${text}` }],
                timestamp: Date.now(),
            },
        ];

        // The person's, as their messages are: Pi works for them from there.
        await conversation.submit(
            {
                type: "write",
                entry: { kind: NOTE_ENTRY, data: { text, by: user.id, name: user.name }, model },
                requestId: ownRequest(user.id, `note-${randomUUID()}`),
            },
            context,
        );
    }

    /** A message Pi could not answer, other than one someone stopped, shows as an error to the people there. */
    #reportUnanswered(
        id: ConversationId,
        settled: Promise<{ status: string; reason?: string; detail?: unknown }>,
    ): void {
        const app = this.#app;

        void settled.then(
            (result) => {
                if (result.status === "unanswered" && result.reason !== "aborted") {
                    const detail =
                        result.detail === undefined
                            ? ""
                            : `: ${JSON.stringify(result.detail).slice(0, 400)}`;

                    app.notice("error", `No answer (${result.reason})${detail}`, id);
                }
            },
            (error: unknown) => app.notice("error", describe(error), id),
        );
    }

    /** Stop the run. Anyone who can steer may, even while someone else drives: stopping is the safe direction. */
    async abort(id: ConversationId, user: User, via?: string): Promise<void> {
        const app = this.#app;
        const current = this.#requireCurrentUser(user);

        app.requireSee(current, id);
        app.requireSteer(current);

        if (via === undefined) {
            // Fence prepared exact contacts before native abort: a delayed service admission must
            // not reactivate an ordinary Chat or helper after the human's Stop has finished.
            await app.harness.commit((tx) => app.pip.agents.contacts.fenceTarget(tx, id), context);
            await app.pip.agents.contacts.settleRevoked();
            const privateScope = app.pip.agents.scope(id);

            if (privateScope !== undefined) {
                await app.pip.agents.supervision.stop(privateScope.agentId, current);
            }

            await app.pip.orchestration.stopped(id, current);
        }

        const conversation = await app.conversation(id);
        const busy = app.isBusy(id) || app.workItems.isPreparing(id);

        // Stop withdraws what waits in the queue, subagents' reports too: a person meant them gone.
        await this.#discardReports(id);
        await app.workItems.abortSummary(id, user);

        // Scoped human Stop already captured its exact run/queue with the grant fence. A
        // conversation-wide abort here could cancel work started by a later explicit resume.
        if (via !== undefined || !app.pip.orchestration.isScoped(id)) {
            void conversation
                .abort(context)
                .catch((error: unknown) =>
                    app.notice("error", `Abort failed: ${describe(error)}`, id),
                );
        }

        if (busy) {
            await app.collab.activity(id, user, "stopped the run");
        }
    }

    /**
     * Mark the batch of subagents' reports in `id`'s queue (or, given `submissionId`, only if that is it) as a person's
     * to withdraw: the courier then lets it go instead of sending it again, as it does with one a spend limit's stop
     * withdrew.
     */
    async #discardReports(id: ConversationId, submissionId?: number): Promise<void> {
        await this.#app.harness.commit(async (tx) => {
            const state = await tx.doc(SubagentsDoc, id);
            const sending = state.sending;

            if (sending === undefined || sending.discarded === true) {
                return;
            }

            if (submissionId !== undefined) {
                const record = await tx.submissionByRequest(id, sending.request);

                if (record === undefined || Number(record.id) !== submissionId) {
                    return;
                }
            }

            state.sending = { ...sending, discarded: true };
        }, context);
    }

    /** Edit a queued input in place; a stale save conflicts unless its text is already the saved text. */
    async editQueued(
        id: ConversationId,
        user: User,
        submissionId: unknown,
        text: unknown,
        expectedText: unknown,
    ): Promise<void> {
        const app = this.#app;

        app.requireSee(user, id);
        await app.requireDriver(id, user);

        if (
            typeof submissionId !== "number" ||
            !Number.isSafeInteger(submissionId) ||
            submissionId < 0
        ) {
            throw new HttpError(400, "submissionId must be a submission id");
        }

        if (typeof text !== "string" || typeof expectedText !== "string") {
            throw new HttpError(400, "text and expectedText are required");
        }

        if (text.includes(ATTACHMENTS_HEADING)) {
            throw new HttpError(400, "text must not contain the attached files heading");
        }

        const queuedId = submissionId as unknown as SubmissionId;

        await app.harness.commit(async (tx) => {
            const record = await (tx as SubmissionTx).submission(queuedId);

            if (record === undefined || record.conversationId !== id) {
                throw new HttpError(404, "No such queued input");
            }

            if (record.status !== "queued") {
                throw new HttpError(409, "This input is no longer queued");
            }

            if (record.type !== "input") {
                throw new HttpError(409, "Only queued input can be edited");
            }

            const inbox = await tx.doc(InboxDoc, id);
            const item = inbox.items.find((each) => each.id === queuedId);

            if (item === undefined) {
                throw new HttpError(409, "This input is no longer queued");
            }

            if (item.mode === "write") {
                throw new HttpError(409, "Only queued input can be edited");
            }

            const main = queuedInputText(item.content);

            if (main.readOnly) {
                throw new HttpError(
                    409,
                    "Application events and agent answers are immutable service input. Send a new message instead.",
                );
            }

            if (text.trim() === "" && !main.hasAttachments) {
                throw new HttpError(400, "Nothing to send");
            }

            if (main.editableText === text) {
                return;
            }

            if (main.editableText !== expectedText) {
                throw new HttpError(
                    409,
                    "This queued input was edited. Open it again before saving.",
                );
            }

            const content = main.replace(text);

            if (queuedInputText(content).editableText !== text) {
                throw new HttpError(400, "text must not be interpreted as stored message metadata");
            }

            item.content = content;
        }, context);
    }

    /** Take back a queued message. Anyone may take back their own; someone else's needs the right to drive. */
    async withdraw(id: ConversationId, user: User, submissionId: number): Promise<string> {
        const app = this.#app;

        app.requireSee(user, id);
        app.requireSteer(user);
        const by = app.attribution.knownSubmitter(submissionId);

        if (by !== user.id) {
            await app.requireDriver(id, user);
        }

        await this.#discardReports(id, submissionId);
        const result = await app.harness.abortSubmission(
            submissionId as unknown as SubmissionId,
            context,
            id,
        );

        if (by !== undefined && by !== user.id) {
            const author = app.config.userById(by)?.name ?? "someone";

            await app.collab.activity(id, user, `withdrew ${author}’s queued message`);
        }

        return result;
    }

    async configure(
        id: ConversationId,
        user: User,
        request: {
            model?: { provider: string; modelId: string };
            thinkingLevel?: string;
            cwd?: string;
            pipPanel?: boolean;
        },
        source?: SessionCreationSource,
    ): Promise<void> {
        const app = this.#app;
        const ctx = source?.context ?? context;

        await this.#requireCreationSource(source);
        app.requireSee(user, id);
        await app.requireDriver(id, user);

        if (request.pipPanel === true && app.pip.ownerOf(id) !== user.id) {
            throw new HttpError(403, "Only your own PiP can use this control.");
        }

        optionalText(request.cwd, "cwd");
        const namedAgent = app.pip.agents.isNamed(id);

        if (namedAgent && request.cwd !== undefined) {
            throw new HttpError(
                409,
                "A private agent's focus is remit, not a working-directory change.",
            );
        }

        if (request.cwd !== undefined) {
            app.workItems.requireWritable(id);

            if (app.sessionMeta(app.rootOf(id))?.workItemId !== undefined) {
                throw new HttpError(
                    409,
                    "A work item keeps one checkout; use safe grouped worktree cleanup instead of changing one member's folder",
                );
            }
        }

        // Someone invited to one session sees files in its folder only: moving it would move what they see.
        if (request.cwd !== undefined && user.role !== "owner") {
            throw new HttpError(403, "Only the owner can change a thread's working directory.");
        }

        const conversation = await app.conversation(id);
        const current = await app.agentState(id);
        const selection = modelSelection(app.models, {
            model: request.model,
            thinkingLevel: optionalText(request.thinkingLevel, "thinkingLevel"),
        });
        const ref = selection.model ?? current?.model;
        const model =
            ref === undefined ? undefined : app.models.getModel(ref.provider, ref.modelId);

        const wanted = (selection.thinkingLevel ??
            current?.thinkingLevel ??
            "off") as ModelThinkingLevel;
        const thinkingLevel = model === undefined ? wanted : clampThinkingLevel(model, wanted);
        const cwd =
            request.cwd === undefined
                ? undefined
                : app.locationOf(id) === undefined
                  ? app.workspace.checkDirectory(request.cwd)
                  : await app.sshSessions.prepare(
                        user,
                        { cwd: request.cwd, location: app.locationOf(id)! },
                        context,
                    );

        const change = {
            ...(selection.model === undefined ? {} : { model: selection.model }),
            thinkingLevel,
            ...(cwd === undefined ? {} : { cwd }),
        };

        if (namedAgent) {
            await app.pip.agents.configure(id, user, change);
        } else if (request.pipPanel === true) {
            // Check and save together: a turn may have started while the picker was open.
            await app.harness.commit(async (tx) => {
                const live = await tx.doc(LiveDoc, id);

                if (live.run !== undefined || (live.compactions?.length ?? 0) > 0) {
                    throw new HttpError(409, "PiP is working. Change its model when it is idle.");
                }

                const agent = await tx.doc(AgentDoc, id);

                app.requireSee(user, id);
                app.requireSteer(user);
                Object.assign(agent, change);
            }, context);
        } else {
            await app.requireDriver(id, user);
            app.requireSee(user, id);

            if (source === undefined) {
                await conversation.configure(change, ctx);
            } else {
                await app.harness.commit(async (tx) => {
                    ctx.abortSignal?.throwIfAborted();
                    await source.requireCurrent(tx);
                    await configureAgent(tx, id, change);
                }, ctx);
            }
        }

        if (cwd !== undefined && app.sessionMeta(id) !== undefined) {
            await app.harness.commit(async (tx) => {
                const meta = (await tx.doc(SessionsDoc)).items[String(id)];

                if (meta !== undefined) {
                    meta.cwd = cwd;
                }
            }, context);
        }

        if (ref !== undefined && request.pipPanel !== true && !namedAgent) {
            app.config.lastModel = { provider: ref.provider, modelId: ref.modelId, thinkingLevel };
        }

        const changes: string[] = [];
        const modelChanged =
            request.model !== undefined &&
            (request.model.provider !== current?.model?.provider ||
                request.model.modelId !== current?.model?.modelId);

        if (modelChanged) {
            changes.push(`switched the model to ${model?.name ?? request.model!.modelId}`);
        }

        if (
            request.thinkingLevel !== undefined &&
            thinkingLevel !== (current?.thinkingLevel ?? "off")
        ) {
            changes.push(`set thinking to ${thinkingLevel}`);
        }

        if (cwd !== undefined && cwd !== current?.cwd) {
            changes.push(`moved the session to ${homePath(cwd)}`);
        }

        if (changes.length > 0) {
            await app.collab.activity(id, user, changes.join(" and "));
        }
    }

    /** Start a new context: Pi no longer sees what came before, though everyone still can. An optional note carries over. */
    async reset(id: ConversationId, user: User, note: unknown): Promise<void> {
        const app = this.#app;

        app.requireSee(user, id);
        await app.requireDriver(id, user);
        const handoff = optionalText(note, "note")?.trim() || undefined;

        if (handoff !== undefined && handoff.length > MAX_HANDOFF) {
            throw new HttpError(413, `Handoff notes are limited to ${MAX_HANDOFF} characters`);
        }

        await (await app.conversation(id)).reset(handoff, context);
        await app.collab.activity(
            id,
            user,
            handoff === undefined
                ? "started a new context"
                : "started a new context with a handoff note",
        );
    }

    /**
     * Set what Pi is told in every request of a session, after its own system prompt: ground rules everyone here shares.
     * Empty text clears them. Subagents keep theirs: they say who the subagent is.
     */
    async setInstructions(id: ConversationId, user: User, text: unknown): Promise<void> {
        const app = this.#app;

        app.requireSee(user, id);
        await app.requireDriver(id, user);

        if (app.sessionMeta(id) === undefined) {
            throw new HttpError(400, "Only sessions have instructions for Pi");
        }

        if (app.pip.agents.isNamed(id)) {
            throw new HttpError(
                409,
                "Edit this private PiP's revisioned instructions in PiP settings.",
            );
        }

        const instructions = (optionalText(text, "instructions") ?? "").trim();

        if (instructions.length > MAX_INSTRUCTIONS) {
            throw new HttpError(413, `Instructions are limited to ${MAX_INSTRUCTIONS} characters`);
        }

        const before = (await app.agentState(id))?.instructions ?? "";

        if (instructions === before) {
            return;
        }

        await (
            await app.conversation(id)
        ).configure({ instructions: instructions === "" ? null : instructions }, context);
        await app.collab.activity(
            id,
            user,
            instructions === ""
                ? "cleared the instructions for Pi"
                : "changed the instructions for Pi",
        );
    }

    /** Turn plan mode on or off: while it is on, Pi reads and proposes a plan, and anything that changes something is blocked. */
    async setPlan(id: ConversationId, user: User, on: unknown): Promise<void> {
        const app = this.#app;

        app.requireSee(user, id);
        await app.requireDriver(id, user);

        if (typeof on !== "boolean") {
            throw new HttpError(400, "on must be true or false");
        }

        this.#requireSession(id);

        if (on && !app.loader.extensionNames().includes(PLAN_EXTENSION)) {
            throw new HttpError(409, "Plan mode is turned off in Extensions.");
        }

        if (await this.#switchPlan(id, user, on)) {
            await app.collab.activity(
                id,
                user,
                on ? "turned on plan mode" : "turned off plan mode",
            );
        }
    }

    /** Approve Pi's plan: plan mode goes off, and Pi is told to carry the plan out. */
    async approvePlan(id: ConversationId, user: User): Promise<{ submissionId: SubmissionId }> {
        const app = this.#app;

        app.requireSee(user, id);
        await app.requireDriver(id, user);
        this.#requireSession(id);

        if (!(await this.#switchPlan(id, user, false))) {
            throw new HttpError(409, "Plan mode is not on.");
        }

        await app.collab.activity(id, user, "approved the plan");

        return this.submit(id, user, { text: PLAN_APPROVED, requestId: randomUUID() });
    }

    /** Plan mode is set for a whole session, not for one of its subagents. */
    #requireSession(id: ConversationId): void {
        if (this.#app.parentOf(id) !== undefined) {
            throw new HttpError(
                400,
                "Plan mode is set for the whole session, in its main conversation.",
            );
        }
    }

    /** Set plan mode for a session and the subagents under it; true when that changed it. */
    #switchPlan(id: ConversationId, user: User, on: boolean): Promise<boolean> {
        return this.#app.harness.commit(async (tx) => {
            if ((await tx.doc(PlanDoc, id)).on === on) {
                return false;
            }

            // Subagents follow their session: one already at work stops changing things too.
            const conversations = [id];

            for (let index = 0; index < conversations.length; index++) {
                for (const agent of Object.values(
                    (await tx.doc(SubagentsDoc, conversations[index]!)).agents,
                )) {
                    conversations.push(agent.conversationId);
                }
            }

            const at = Date.now();

            for (const each of conversations) {
                Object.assign(await tx.doc(PlanDoc, each), { on, by: user.id, at });
            }

            return true;
        }, context);
    }

    /** Set up a message to Pi for later, or on repeat: `when` is when, then what it says (`in 2h check the deploy`). */
    async schedule(
        id: ConversationId,
        user: User,
        request: { when?: unknown; zone?: unknown },
    ): Promise<Schedule> {
        const app = this.#app;

        app.requireSee(user, id);
        await app.requireDriver(id, user);
        const zone = optionalText(request.zone, "zone");

        if (zone !== undefined && !knownZone(zone)) {
            throw new HttpError(400, `Unknown time zone ${zone}`);
        }

        app.spend.check(user, id);
        const schedule = await app.schedules.add(id, {
            when: optionalText(request.when, "when") ?? "",
            by: user,
            ...(zone === undefined ? {} : { zone }),
        });
        const when =
            schedule.every === undefined
                ? `for ${describeMoment(schedule.next, schedule.zone)}`
                : describeRepeat(schedule.every);

        await app.collab.activity(id, user, `scheduled “${snippet(schedule.text, 60)}” ${when}`);

        return schedule;
    }

    async cancelSchedule(id: ConversationId, user: User, scheduleId: string): Promise<void> {
        const app = this.#app;

        app.requireSee(user, id);
        await app.requireDriver(id, user);
        const schedule = await app.schedules.cancel(id, scheduleId);

        if (schedule === undefined) {
            throw new HttpError(404, "No such scheduled message");
        }

        await app.collab.activity(
            id,
            user,
            `cancelled the scheduled “${snippet(schedule.text, 60)}”`,
        );
    }

    /** Watch the session's pull request (its branch's, or `pr`): Pi hears of failed checks, conflicts, and reviews. */
    async watchPr(id: ConversationId, user: User, pr: unknown): Promise<{ number: number }> {
        const app = this.#app;

        app.requireSee(user, id);
        await app.requireDriver(id, user);
        app.spend.check(user, id);
        const asked = optionalText(pr, "pr");
        const watch = await app.watches.start(
            id,
            user.id,
            asked === undefined ? {} : { pr: asked },
        );

        await app.collab.activity(
            id,
            user,
            `started watching PR #${watch.number} “${snippet(watch.title, 60)}”`,
        );

        return { number: watch.number };
    }

    /** Stop watching the session's pull request, or clear a watch that ended. */
    async unwatchPr(id: ConversationId, user: User): Promise<void> {
        const app = this.#app;

        app.requireSee(user, id);
        await app.requireDriver(id, user);
        const watch = await app.watches.stop(id);

        if (watch?.status === "watching") {
            await app.collab.activity(id, user, `stopped watching PR #${watch.number}`);
        }
    }

    /**
     * The webhooks a person may manage, each with where it sends (a session's title, or PiP), and the address other
     * services reach this server at, when it has a public one.
     */
    async hooks(user: User) {
        const app = this.#app;
        const hooks = (await app.hooks.list(user)).map((hook) => {
            const target = hook.target as unknown as ConversationId;
            const meta = app.sessionMeta(target);

            return {
                ...hook,
                // A session the person can no longer open keeps its title to itself.
                targetTitle:
                    meta?.pip !== undefined
                        ? "PiP"
                        : app.canSee(user, target)
                          ? (meta?.title ?? "New session")
                          : "a session you cannot open",
                pip: meta?.pip !== undefined,
            };
        });

        // Repository watches (`repo-watches.ts`), which PiP sets up: shown with the hooks, to see and remove.
        const repoWatches = (await app.repoWatches.list(user)).map((watch) => {
            const target = watch.target as unknown as ConversationId;
            const meta = app.sessionMeta(target);

            return {
                ...watch,
                targetTitle:
                    meta?.pip !== undefined
                        ? "PiP"
                        : app.canSee(user, target)
                          ? (meta?.title ?? "New session")
                          : "a session you cannot open",
                pip: meta?.pip !== undefined,
            };
        });

        return { hooks, repoWatches, base: app.access?.url ?? null };
    }

    /** Make a webhook that messages a session (or PiP) for this person. */
    async addHook(
        user: User,
        body: {
            target?: unknown;
            name?: unknown;
            instructions?: unknown;
            signed?: unknown;
            anyone?: unknown;
        },
    ) {
        const app = this.#app;
        // "pip": this person's PiP, made now if they have none yet.
        const target =
            body.target === "pip" && app.pip.available(user)
                ? Number(await app.pip.ensure(user))
                : Number(body.target);

        if (!Number.isSafeInteger(target) || target < 0) {
            throw new HttpError(400, "Say which session the webhook messages.");
        }

        const id = target as unknown as ConversationId;
        const hook = await app.hooks.add(user, id, body);

        if (app.sessionMeta(id)?.pip === undefined) {
            await app.collab.activity(id, user, `made the webhook “${snippet(hook.name, 60)}”`);
        }

        return hook;
    }

    async removeHook(user: User, hookId: string): Promise<void> {
        const app = this.#app;
        const hook = await app.hooks.remove(user, hookId);
        const target = hook.target as unknown as ConversationId;

        // No line where the remover can no longer go.
        if (
            app.sessionMeta(target) !== undefined &&
            app.sessionMeta(target)?.pip === undefined &&
            app.canSee(user, target)
        ) {
            await app.collab.activity(
                target,
                user,
                `removed the webhook “${snippet(hook.name, 60)}”`,
            );
        }
    }

    /** Pi keeps working until `command` passes, checked after each of its answers. */
    async setGoal(id: ConversationId, user: User, command: unknown): Promise<void> {
        const app = this.#app;

        app.requireSee(user, id);
        await app.requireDriver(id, user);

        if (app.sessionMeta(id) === undefined) {
            throw new HttpError(400, "Only sessions can have a goal");
        }

        const goal = await app.goals.set(id, user.id, optionalText(command, "command") ?? "");

        await app.collab.activity(
            id,
            user,
            `set a goal: keep going until \`${snippet(goal.command, 80)}\` passes`,
        );
    }

    /** Drop the goal: Pi stops checking. Anyone who can steer may, as with stopping a run. */
    async clearGoal(id: ConversationId, user: User): Promise<void> {
        const app = this.#app;

        app.requireSee(user, id);
        app.requireSteer(user);
        const goal = await app.goals.get(id);

        if (!(await app.goals.clear(id)) || goal === undefined) {
            return;
        }

        if (goal.status === "working") {
            await app.collab.activity(
                id,
                user,
                `dropped the goal \`${snippet(goal.command, 80)}\``,
            );
        }
    }

    /** A new session with this session's history through `entryId`, which then goes its own way. */
    async fork(
        id: ConversationId,
        user: User,
        request: { entryId?: unknown; worktree?: unknown },
    ): Promise<{ id: ConversationId }> {
        this.#requireForkable(id, user, request.worktree);
        const entryId = entryIdOf(request.entryId);
        const entry = await this.#app.transcripts.visibleEntry(id, entryId);

        if (entry === undefined) {
            throw new HttpError(404, "No such message");
        }

        // A fork goes on from one of Pi's replies. One that called tools would leave the fork waiting for their results.
        const reply = entry.model?.[0];

        if (
            entry.kind !== "pi.assistant" ||
            (reply?.role === "assistant" && reply.stopReason === "toolUse")
        ) {
            throw new HttpError(400, "Fork from one of Pi's finished replies.");
        }

        return {
            id: await this.#branch(id, user, {
                at: entryId,
                label: "fork",
                worktree: request.worktree === true,
            }),
        };
    }

    /**
     * Send one of this session's messages again in a fork that ends just before it: edited (`text`), or as it was, maybe
     * to another model (`model`). The original stays as it is.
     */
    async resend(
        id: ConversationId,
        user: User,
        request: { entryId?: unknown; text?: unknown; model?: unknown; worktree?: unknown },
    ): Promise<{ id: ConversationId }> {
        const app = this.#app;

        this.#requireForkable(id, user, request.worktree);
        const entryId = entryIdOf(request.entryId);
        const edited = optionalText(request.text, "text")?.trim();
        const asked = modelSelection(app.models, { model: request.model }).model;
        const entry = await app.transcripts.visibleEntry(id, entryId);

        if (entry?.kind !== "pi.user") {
            throw new HttpError(404, "No such message to Pi");
        }

        app.spend.check(user, id);
        const source = await app.agentState(id);
        const ref = asked ?? source?.model;
        const model =
            ref === undefined ? undefined : app.models.getModel(ref.provider, ref.modelId);

        if (ref === undefined || model === undefined) {
            throw new HttpError(
                400,
                ref === undefined
                    ? "Pick a model first."
                    : `Unknown model ${ref.provider}/${ref.modelId}`,
            );
        }

        const original = userContent(entry.model?.[0]);
        // Who sent it comes first, then the heading, whole or (from before 0.14.0) without its blank line.
        const [written, files] = splitAttachments(original.text.replace(FROM_PREFIX, ""));
        // An edit that changes nothing is the same as sending the message again.
        const edit = edited !== undefined && edited !== written.trim() ? edited : undefined;

        if (edit === "" && files === undefined) {
            throw new HttpError(400, "Nothing to send");
        }

        // Sent again, edited or not, the message is from whoever sent it again, with the original's files attached: what
        // Pi does next is on them.
        const body = edit ?? written.trim();
        const text = this.messageText(
            user,
            files === undefined ? body : `${body}${ATTACHMENTS_HEADING}${files}`,
        );
        const author =
            (await app.harness.snapshot(AuthorsDoc, id, context))?.entries[String(entryId)] ??
            user.id;
        const images = model.input.includes("image") ? original.images : [];
        const resend: Resend = {
            text,
            by: user.id,
            ...(images.length === 0 ? {} : { images: { entry: entryId as unknown as EntryId } }),
        };

        const previous = (
            await (
                await app.conversation(id)
            ).entries({ maxEntryId: (entryId - 1) as unknown as EntryId }, 1, undefined, context)
        ).items[0];
        const agent: AgentChange =
            asked === undefined
                ? {}
                : {
                      model: ref,
                      thinkingLevel: clampThinkingLevel(
                          model,
                          (source?.thinkingLevel ?? "off") as ModelThinkingLevel,
                      ),
                  };
        const label = edit !== undefined ? "edit" : asked !== undefined ? model.name : "retry";
        const forked = await this.#branch(id, user, {
            at: previous?.id as unknown as number | undefined,
            label,
            agent,
            worktree: request.worktree === true,
            resend,
        });
        const submission = await (
            await app.conversation(forked)
        ).submit(
            {
                type: "input",
                content: resendContent(text, images),
                requestId: resendRequest(resend),
            },
            context,
        );
        const whose =
            author === user.id
                ? "a message"
                : `${app.config.userById(author)?.name ?? "someone"}’s message`;
        const line =
            edit !== undefined
                ? "edited a message and sent it again"
                : asked !== undefined
                  ? `sent ${whose} again to ${model.name}`
                  : `sent ${whose} again`;

        await app.collab.activity(forked, user, line, false);
        this.#reportUnanswered(forked, submission.wait(context));

        return { id: forked };
    }

    /** Forks are new sessions: who may start one may fork, from a session they can see. */
    #requireForkable(id: ConversationId, user: User, worktree?: unknown): void {
        const app = this.#app;

        if (worktree === true && user.role !== "owner") {
            throw new HttpError(403, "Only the owner can choose a new worktree destination");
        }

        app.requireSee(user, id);
        app.requireSteer(user);
        app.workItems.requireWritable(id);

        if (app.sessionMeta(app.rootOf(id))?.workItemId !== undefined) {
            throw new HttpError(
                409,
                "Grouped handoff threads cannot be forked or resent; use an explicit handoff",
            );
        }

        if (user.sessions !== undefined) {
            throw new HttpError(403, "You were invited to one session and cannot start new ones.");
        }

        if (app.sessionMeta(id) === undefined) {
            throw new HttpError(400, "Only sessions can be forked");
        }

        // A fork would carry PiP's tools and none of PiP: they act as PiP's person, which a fork is not.
        if (app.sessionMeta(id)?.pip !== undefined) {
            throw new HttpError(400, "PiP's conversation cannot be forked. Start fresh instead.");
        }
    }

    /**
     * Start a session from this one's history through entry `at`, or from none of it, named after this one with
     * `label`; in a git worktree of its own when asked.
     */
    async #branch(
        id: ConversationId,
        user: User,
        branch: {
            at: number | undefined;
            label: string;
            agent?: AgentChange;
            worktree: boolean;
            resend?: Resend;
        },
    ): Promise<ConversationId> {
        const app = this.#app;

        const meta = app.sessionMeta(id)!;
        const source = await app.agentState(id);
        const sourceTitle = meta.title ?? "New session";
        const title = `${sourceTitle} · ${branch.label}`.slice(0, MAX_TITLE);

        return this.#inPlace(
            source?.cwd ?? meta.cwd,
            branch.worktree,
            title,
            (place) => this.#fork(id, user, { ...branch, title, sourceTitle, place }),
            {
                offline: () => app.workItems.isManaged(id),
                backend: branch.worktree ? userWorkspaceBackend(app, id, context, user) : undefined,
            },
        );
    }

    /**
     * Make the fork in `place`. It starts its own chat, with the pins of messages it inherited; both sessions get an
     * activity line about it. With `resend`, the fork comes with the task that sends that message.
     */
    async #fork(
        id: ConversationId,
        user: User,
        fork: {
            at: number | undefined;
            title: string;
            sourceTitle: string;
            agent?: AgentChange;
            place: Place;
            resend?: Resend;
        },
    ): Promise<ConversationId> {
        const app = this.#app;
        const source = await app.agentState(id);
        const { at, title, place } = fork;
        const agent: AgentChange = {
            ...fork.agent,
            ...(place.worktree === undefined ? {} : { cwd: place.cwd }),
        };
        const now = Date.now();
        // A new session rather than a fork gets plan mode and the notes by hand.
        const plan =
            at === undefined ? await app.harness.snapshot(PlanDoc, id, context) : undefined;
        const notes =
            at === undefined ? await app.harness.snapshot(NotesDoc, id, context) : undefined;

        const init: ConversationCreateOptions["init"] = async (tx, forked) => {
            const sessions = await tx.doc(SessionsDoc);
            const sourceMeta = sessions.items[String(id)];

            this.#requireForkable(id, this.#requireCurrentUser(user));

            sessions.items[String(forked)] = {
                cwd: place.cwd,
                ...(sourceMeta?.location === undefined ? {} : { location: sourceMeta.location }),
                title,
                createdAt: now,
                updatedAt: now,
                createdBy: user.id,
                threadType: sourceMeta?.threadType ?? "worker",
                ...(sourceMeta?.projectId === undefined ? {} : { projectId: sourceMeta.projectId }),
                forkedFrom: { id: Number(id), ...(at === undefined ? {} : { entryId: at }) },
                ...(app.sessionMeta(app.rootOf(id))?.ownerOnly === true ? { ownerOnly: true } : {}),
                ...(place.worktree === undefined ? {} : { worktree: place.worktree }),
            };

            if (fork.resend !== undefined) {
                await tx.createTask(ResendTask, fork.resend, {
                    ownership: { kind: "conversation" },
                    background: true,
                    conversationId: forked,
                });
            }

            if (at === undefined) {
                if (plan !== undefined) {
                    Object.assign(await tx.doc(PlanDoc, forked), structuredClone(plan));
                }

                if (notes !== undefined) {
                    Object.assign(await tx.doc(NotesDoc, forked), structuredClone(notes));
                }

                return;
            }

            // A fork copies its parent's documents. The chat is the parent's conversation, not this one's.
            const chat = await tx.doc(ChatDoc, forked);

            chat.messages.splice(0);
            const pins = await tx.doc(PinsDoc, forked);

            for (let index = pins.items.length - 1; index >= 0; index--) {
                const pin = pins.items[index]!;

                if (pin.entryId === undefined || pin.entryId > at) {
                    pins.items.splice(index, 1);
                }
            }

            // Authors of the parent's later messages did not take part here.
            const authors = await tx.doc(AuthorsDoc, forked);

            for (const entryId of Object.keys(authors.entries)) {
                if (Number(entryId) > at) {
                    delete authors.entries[entryId];
                }
            }
        };

        const ownership = { kind: "ownerless" } as const;
        const forked =
            at === undefined
                ? // Before the first message there is nothing to fork: a new session that runs like this one.
                  await app.harness.createConversation(
                      {
                          ownership,
                          agent: {
                              ...(source?.model === undefined ? {} : { model: source.model }),
                              ...(source?.thinkingLevel === undefined
                                  ? {}
                                  : { thinkingLevel: source.thinkingLevel }),
                              ...(source?.instructions === undefined
                                  ? {}
                                  : { instructions: source.instructions }),
                              cwd: place.cwd,
                              ...agent,
                          },
                          init,
                      },
                      context,
                  )
                : await (
                      await app.conversation(id)
                  ).fork(at as unknown as EntryId, { ownership, agent, init }, context);
        const where =
            place.worktree === undefined
                ? ""
                : ` into a worktree on ${place.worktree.branch}${place.skipped.length === 0 ? "" : ` (${place.skipped.length} big new files were not copied)`}`;

        await app.collab.activity(
            forked.id,
            user,
            `forked this from “${fork.sourceTitle}”${where}`,
            false,
        );
        await app.collab.activity(id, user, `forked “${title}” from this session${where}`, false);

        return forked.id;
    }

    async compact(id: ConversationId, user: User, instructions: string | undefined): Promise<void> {
        const app = this.#app;

        app.requireSee(user, id);
        await app.requireDriver(id, user);
        // PiP's summaries are its own, written by its extension's hook with outside text left out: while PiP is off,
        // there is no hook, and Pi Durable's summary would read what came from outside as it is.
        const pip = app.pip.ownerOf(id) !== undefined;

        if (pip && !app.pip.available(user)) {
            throw new HttpError(409, "PiP is turned off in Extensions.");
        }

        // Compacting asks the model for a summary, which costs like any other request.
        app.spend.check(user, id);
        const conversation = await app.conversation(id);
        const taskId = await conversation.compact(instructions, context);
        const done = pip ? "PiP's context compacted." : "Compacted.";

        app.notice("info", pip ? "Compacting PiP's context…" : "Compacting…", id);
        await app.collab.activity(id, user, "started compacting the context", false);
        void app.harness.waitForTask(taskId, context).then(
            (receipt) => {
                const outcome = receipt.state.outcome;

                if (outcome.status === "completed") {
                    const { entryId, submissionId } = outcome.result;
                    // PiP's own summary could not be written: it declined, rather than let Pi Durable write one.
                    const failed = pip ? app.pipCompaction.failure(Number(taskId)) : undefined;

                    if (failed !== undefined) {
                        app.notice("error", `PiP's context was not compacted: ${failed}`, id);
                    } else {
                        app.notice(
                            "info",
                            entryId === undefined && submissionId === undefined
                                ? "Nothing to compact: the context fits in the recent window."
                                : done,
                            id,
                        );
                    }
                } else if (outcome.status === "aborted") {
                    app.notice("info", "Compaction aborted.", id);
                } else {
                    const why = "error" in outcome ? outcome.error?.message : undefined;

                    app.notice("error", `Compaction ${outcome.status}${why ? `: ${why}` : ""}`, id);
                }
            },
            (error: unknown) => app.notice("error", describe(error), id),
        );
    }
}
