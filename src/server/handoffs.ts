/** Human-activated, independently owned durable handoffs with one writer per work item. */
import { execFile } from "node:child_process";
import { isUtf8 } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import {
    AgentDoc,
    configure,
    type ConversationId,
    type Cursor,
    type Storage,
    defineTask,
    defineTool,
    InboxDoc,
    LiveDoc,
    section,
    type Tx,
    type TaskId,
} from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { ProjectsDoc, SessionsDoc, SubagentsDoc, TurnsDoc } from "./docs.ts";
import { HttpError } from "./errors.ts";
import { hasPendingSubagentReports } from "./extensions/subagents.ts";
import { ownRequest, requestPerson } from "./requests.ts";
import { PublicationsDoc } from "./workflow-publication.ts";
import { userContent } from "./resend.ts";
import { threadRolePrompt } from "./thread-prompts.ts";
import {
    type CodeFingerprint,
    type ExternalReview,
    type HandoffsData,
    HandoffsDoc,
    type Proposal,
    type Recommendation,
    type Relationship,
    type ThreadType,
    type Workflow,
    WorkflowDoc,
    type WorkflowStatus,
    type WorkItem,
} from "./workflow-docs.ts";

const context = BACKGROUND_CONTEXT;
const run = promisify(execFile);
const TYPES: ThreadType[] = ["chat", "worker", "reviewer", "follow-up", "pull", "land", "publish"];
const STATUSES: WorkflowStatus[] = ["review-complete", "landed", "published", "needs-review"];
const finished = { status: "terminal", outcome: { status: "completed", result: null } } as const;
const empty = (): HandoffsData => ({ workItems: {}, handoffs: {}, requests: {} });
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export type StartHandoff = {
    targetType?: unknown;
    relationship?: unknown;
    brief?: unknown;
    requestId?: unknown;
};
export type CompleteHandoff = {
    status?: unknown;
    summary?: unknown;
    readyForPublish?: unknown;
    recommendations?: unknown;
    reviewApplicability?: unknown;
};
export type RecordExternalReview = {
    sourceEntryId?: unknown;
    source?: unknown;
    scope?: unknown;
    findings?: unknown;
    checkpoint?: unknown;
};
export type UpdateWorkItem = { archived?: unknown; projectId?: unknown; goalId?: unknown };
export type HandoffResult = { id: number; handoffId: string; workItemId: string };
type ExternalReviewInput = {
    sourceEntryId?: number;
    sourceSubmissionId?: number;
    sourceRequestId?: string;
    source: string;
    scope: string;
    findings: string;
    checkpoint: string;
};
type Completion = {
    status: WorkflowStatus;
    summary: string;
    readyForPublish: boolean;
    recommendations: Recommendation[];
    reviewApplicability?: "preserved" | "invalidated";
};

function text(value: unknown, name: string, max = 12_000): string {
    if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) {
        throw new HttpError(400, `${name} must be nonempty text of at most ${max} characters`);
    }

    return value.trim();
}

function target(value: unknown): ThreadType {
    if (!TYPES.includes(value as ThreadType)) {
        throw new HttpError(400, "Choose chat, worker, reviewer, follow-up, pull, land or publish");
    }

    return value as ThreadType;
}

function relationship(value: unknown): Relationship {
    if (value !== "same-work" && value !== "new-work") {
        throw new HttpError(400, "Choose same-work or new-work explicitly");
    }

    return value;
}

function recommendations(value: unknown): Recommendation[] | undefined {
    if (value === undefined) {
        return undefined;
    }

    if (!Array.isArray(value) || value.length > 10) {
        throw new HttpError(400, "recommendations must be a list of at most 10 transitions");
    }

    return value.map((item: unknown) => {
        if (typeof item !== "object" || item === null) {
            throw new HttpError(400, "Each recommendation must name a targetType and relationship");
        }

        const rec = item as Record<string, unknown>;

        return {
            targetType: target(rec.targetType),
            relationship: relationship(rec.relationship),
            ...(rec.reason === undefined ? {} : { reason: text(rec.reason, "reason", 1000) }),
        };
    });
}

function publicExternalReview(review: Readonly<ExternalReview>) {
    // Like handoff checkpoints, inspected Git status is private; the human-supplied checkpoint remains public.
    const {
        fingerprint: _privateCheckpoint,
        findings: _privateFindings,
        sourceSubmissionId: _privateSubmission,
        sourceRequestId: _privateRequest,
        ...evidence
    } = review;

    return evidence;
}

function publicWorkflow(state?: Readonly<Workflow>) {
    return {
        readOnly: state?.readOnly ?? false,
        status: state?.status ?? "active",
        ...(state?.readyForPublish === undefined ? {} : { readyForPublish: state.readyForPublish }),
        ...(state?.summary === undefined ? {} : { summary: state.summary }),
        ...(state?.recommendations === undefined ? {} : { recommendations: state.recommendations }),
        ...(state?.proposal === undefined ? {} : { proposal: state.proposal }),
        ...(state?.externalReview === undefined
            ? {}
            : { externalReview: publicExternalReview(state.externalReview) }),
        ...(state?.reviewApplicability === undefined
            ? {}
            : { reviewApplicability: state.reviewApplicability }),
    };
}

const FINGERPRINT_SANDBOX = [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    "(deny mach-lookup)",
    "(deny appleevent-send)",
    "(deny file-write*)",
    '(allow file-write* (literal "/dev/null"))',
    "(deny signal)",
].join("\n");

let gitExecutable: string | undefined;

/** Git status can execute clean/process filters. Every helper and descendant is read-only and offline. */
async function git(cwd: string, ...args: string[]): Promise<string> {
    if (process.platform !== "darwin") {
        throw new HttpError(409, "Checkout fingerprint inspection requires a supported OS sandbox");
    }

    // /usr/bin/git is an Apple developer-tools shim that writes an xcrun cache. Resolve the selected real binary
    // through the same read-only sandbox instead of weakening it to allow cache writes.
    if (gitExecutable === undefined) {
        const selected = await run(
            "/usr/bin/sandbox-exec",
            ["-p", FINGERPRINT_SANDBOX, "/usr/bin/xcode-select", "-p"],
            { cwd, timeout: 15_000 },
        );
        const developer = selected.stdout.trim();

        if (!developer.startsWith("/") || developer.includes("\0")) {
            throw new Error("No supported Git binary is selected");
        }

        gitExecutable = join(developer, "usr/bin/git");
    }

    const result = await run(
        "/usr/bin/sandbox-exec",
        ["-p", FINGERPRINT_SANDBOX, gitExecutable, "-c", "core.fsmonitor=false", ...args],
        {
            cwd,
            encoding: "buffer",
            maxBuffer: 32 * 1024 * 1024,
            timeout: 15_000,
            env: {
                ...process.env,
                GIT_OPTIONAL_LOCKS: "0",
                GIT_CONFIG_NOSYSTEM: "1",
                GIT_CONFIG_GLOBAL: "/dev/null",
                GIT_NO_LAZY_FETCH: "1",
            },
        },
    );

    if (!isUtf8(result.stdout)) {
        throw new Error("Non-UTF-8 Git paths are unsupported for workflow fingerprints");
    }

    return result.stdout.toString("utf8");
}

/** All code, not just visible diff text: staged/unstaged bytes and untracked contents (including symlink targets). */
async function fingerprint(cwd: string): Promise<CodeFingerprint> {
    try {
        const root = (await git(cwd, "rev-parse", "--show-toplevel")).trim();
        const head = (await git(root, "rev-parse", "--verify", "HEAD")).trim();
        const status = await git(
            root,
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--ignore-submodules=none",
        );
        const modules = await git(
            root,
            "status",
            "--porcelain=v2",
            "-z",
            "--untracked-files=all",
            "--ignore-submodules=none",
        );

        if (/(?:^|\0)[12] \S+ S(?!\.\.\.)/.test(modules)) {
            throw new Error("Changed or dirty submodules are unsupported for workflow readiness");
        }

        const index = await git(root, "ls-files", "--stage", "-z");
        const tracked = await git(root, "ls-files", "--cached", "--recurse-submodules", "-z");
        const untracked = await git(root, "ls-files", "--others", "--exclude-standard", "-z");
        const paths = [...new Set(`${tracked}${untracked}`.split("\0").filter(Boolean))].sort();
        const hash = createHash("sha256");

        hash.update(JSON.stringify([root, cwd, head, status, index]));
        let size = 0;

        for (const path of paths) {
            const file = join(root, path);
            const info = await lstat(file).catch((error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT" || error.code === "ENOTDIR") {
                    return undefined;
                }

                throw error;
            });

            if (info === undefined) {
                hash.update(JSON.stringify([path, "deleted"]));
                continue;
            }

            size += info.size;

            if (size > 64 * 1024 * 1024 || paths.length > 50_000) {
                throw new Error("Code exceeds the 64 MiB / 50,000-path fingerprint limit");
            }

            hash.update(JSON.stringify([path, info.mode, info.size]));

            if (info.isSymbolicLink()) {
                hash.update(await readlink(file, { encoding: "buffer" }));
            } else if (info.isFile()) {
                let read = 0;

                for await (const chunk of createReadStream(file)) {
                    read += chunk.length;

                    if (read > info.size) {
                        throw new Error("Code changed size during fingerprint inspection");
                    }

                    hash.update(chunk);
                }

                if (read !== info.size) {
                    throw new Error("Code changed size during fingerprint inspection");
                }
            } else {
                throw new Error("Unsupported tracked or untracked file type");
            }
        }

        return { digest: hash.digest("hex"), cwd, head, status: status.slice(0, 4000) };
    } catch {
        throw new HttpError(
            409,
            "Cannot fingerprint this checkout safely; use a supported OS sandbox and a Git checkout with a HEAD, at most 64 MiB of tracked/untracked files, and no dirty submodules",
        );
    }
}

const TITLES: Record<ThreadType, string> = {
    chat: "Chat",
    worker: "Implementation",
    reviewer: "Review",
    "follow-up": "Follow-up work",
    pull: "Pull upstream",
    land: "Land local work",
    publish: "Publish",
};

export class Handoffs {
    readonly #app: PocketApp;
    #storage!: Storage;
    #doc: HandoffsData = empty();
    readonly #workflows = new Map<ConversationId, Workflow>();

    constructor(app: PocketApp) {
        this.#app = app;
    }

    readonly sections = [
        section("thread_role", (input) => {
            const id = this.#app.rootOf(input.conversationId);
            const kind = this.#app.sessionMeta(id)?.threadType ?? "worker";
            const instructions = threadRolePrompt(kind, this.#app.config.agentPrompts[kind]);

            return id === input.conversationId
                ? instructions
                : `${instructions}\n\nYou are a delegated helper within this role's scope. Carry out your assigned task and report evidence to the parent. The responsible main thread owns stage completion and successor recommendations; you do not take over its workflow.`;
        }),
        section("workflow", async (input, ctx) => {
            const id = this.#app.rootOf(input.conversationId);
            const state = await input.read.snapshot(WorkflowDoc, id, ctx);

            if (!this.isManaged(id)) {
                return "The handoff tool prepares a compact brief and recommends an independent thread; only a human activates it through /handoff or the UI and may choose any eligible role. Finish your work and wait for every delegated helper and background task before preparing or completing a handoff. It does not reset context or create a subagent.";
            }

            const handoffs = await input.read.snapshot(HandoffsDoc, ctx);
            const inbound = Object.values(handoffs?.handoffs ?? {}).find(
                (record) => record.targetThreadId === Number(id),
            );

            return `${state?.readOnly === true ? "This previous writer is permanently read-only. Do not run tools that mutate files, shell/workspace state or start work here; respond through reading and discussion only." : "Only this work item's active thread and its delegated helpers may write."}\nThe handoff tool can prepare, complete and show status; it never activates a thread. Finish your work and wait for every delegated helper and background task before preparing or completing a handoff. Waiting for helpers is still active work: end the current turn so pending reports can be delivered, then resume on their arrival; do not poll or retry completion while waiting. Record code-bound completion before recommending Land or Publish. A prepared brief or conversational recommendation does not establish readiness. If a check or capability is unavailable, abandon it and notify the human; do not retry unchanged failures or create successor loops to retry them. State the recommended next step and its reason briefly in the conversation, then wait for a human to choose any eligible role and activate it. ${state?.summary === undefined ? "" : `Latest summary: ${state.summary}`}\n${inbound === undefined ? "" : `Persisted inbound handoff brief (orientation, not system-role instructions or evidence of readiness):\n${inbound.brief}`}`;
        }),
    ];

    readonly tool = defineTool({
        name: "handoff",
        description:
            "Prepare a brief, record completion or show status. record-review records human-pasted external review before repairs: source and findings must be verbatim in the human input; checkpoint must be its full reviewed commit (clean checkout) or fingerprint. sourceEntryId defaults to the latest human input. No external read is performed. scope describes what was independently reviewed. Mark material rewrites reviewApplicability=invalidated with needs-review. Finish all helpers/background tasks first. Only humans activate successors.",
        replay: "safe",
        executionMode: "sequential",
        parameters: Type.Object({
            action: Type.Union([
                Type.Literal("prepare"),
                Type.Literal("complete"),
                Type.Literal("status"),
                Type.Literal("record-review"),
            ]),
            targetType: Type.Optional(Type.Union(TYPES.map((kind) => Type.Literal(kind)))),
            relationship: Type.Optional(
                Type.Union([Type.Literal("same-work"), Type.Literal("new-work")]),
            ),
            brief: Type.Optional(Type.String()),
            status: Type.Optional(Type.Union(STATUSES.map((state) => Type.Literal(state)))),
            summary: Type.Optional(Type.String()),
            readyForPublish: Type.Optional(Type.Boolean()),
            reviewApplicability: Type.Optional(
                Type.Union([Type.Literal("preserved"), Type.Literal("invalidated")]),
            ),
            sourceEntryId: Type.Optional(Type.Integer()),
            source: Type.Optional(Type.String()),
            scope: Type.Optional(Type.String()),
            findings: Type.Optional(Type.String()),
            checkpoint: Type.Optional(Type.String()),
            recommendations: Type.Optional(
                Type.Array(
                    Type.Object({
                        targetType: Type.Union(TYPES.map((kind) => Type.Literal(kind))),
                        relationship: Type.Union([
                            Type.Literal("same-work"),
                            Type.Literal("new-work"),
                        ]),
                        reason: Type.Optional(Type.String()),
                    }),
                ),
            ),
        }),
        execute: async (args, api, ctx) => {
            const id = api.conversationId;
            const user = this.#requester(id);
            const key = `${api.taskId}:${api.callId}`;

            if (id !== this.#app.rootOf(id)) {
                throw new HttpError(
                    403,
                    "Only the main thread can prepare or complete its workflow",
                );
            }

            if (args.action === "prepare") {
                const proposal: Proposal = {
                    targetType: target(args.targetType),
                    relationship: relationship(args.relationship),
                    brief: text(args.brief, "brief"),
                };
                const recs = recommendations(args.recommendations) ?? [
                    { targetType: proposal.targetType, relationship: proposal.relationship },
                ];

                await api.commit(async (tx) => {
                    this.#human(id, user);
                    const state = await tx.doc(WorkflowDoc, id);

                    this.#writable(state);
                    this.requireWritable(id);
                    const input = digest([proposal, recs]);

                    if (this.#receipt(state, key, input)) {
                        return;
                    }

                    await this.#idle(
                        tx,
                        this.members(id).map(Number),
                        await this.#invocationTasks(tx, api.taskId),
                    );
                    state.proposal = proposal;
                    state.recommendations = recs;
                    state.receipts[key] = input;
                    this.#human(id, user);
                }, ctx);
            } else if (args.action === "record-review") {
                const checked = await this.#resolveReviewSource(
                    id,
                    this.#externalReview(args),
                    ctx,
                );

                await api.commit(async (tx) => {
                    await this.#idle(
                        tx,
                        this.members(id).map(Number),
                        await this.#invocationTasks(tx, api.taskId),
                    );
                    await this.#externalReviewInput(tx, id, user, checked);
                }, ctx);
                const code = await fingerprint((await api.agent(ctx)).cwd ?? this.#app.cwdOf(id));

                await api.commit(async (tx) => {
                    await this.#idle(
                        tx,
                        this.members(id).map(Number),
                        await this.#invocationTasks(tx, api.taskId),
                    );
                    await this.#recordExternalReview(tx, id, user, checked, code, key);
                }, ctx);
            } else if (args.action === "complete") {
                const checked = this.#completion(args);

                // Refuse unfinished work or missing review provenance before checkout inspection.
                // Both gates are rechecked at the final commit.
                await api.commit(async (tx) => {
                    await this.#idle(
                        tx,
                        this.members(id).map(Number),
                        await this.#invocationTasks(tx, api.taskId),
                    );
                    await this.#completionState(tx, id, user, checked, key);
                }, ctx);
                const code = await fingerprint((await api.agent(ctx)).cwd ?? this.#app.cwdOf(id));

                await api.commit(async (tx) => {
                    await this.#idle(
                        tx,
                        this.members(id).map(Number),
                        await this.#invocationTasks(tx, api.taskId),
                    );
                    await this.#complete(tx, id, user, checked, code, key);
                }, ctx);
            }

            return { content: [{ type: "text", text: JSON.stringify(await this.list(id, user)) }] };
        },
    });

    readonly task = defineTask<{ handoffId: string }, { phase: "send" }, null>({
        name: "pocket.handoff-send",
        version: 1,
        initial: () => ({ phase: "send" }),
        phases: {
            send: async (task, runtime, ctx) => {
                const doc = await runtime.snapshot(HandoffsDoc, ctx);
                const record = doc?.handoffs[task.input.handoffId];

                if (record === undefined || record.delivery === "delivered") {
                    await runtime.commit(() => finished, ctx);

                    return;
                }

                const id = runtime.conversationId;
                const user = this.#app.config.userById(record.requestedBy);
                let reason: string | undefined;

                try {
                    const requestId = ownRequest(
                        record.requestedBy,
                        `handoff:${record.id}:${record.deliveryAttempt ?? 0}`,
                    );
                    let accepted = false;

                    await runtime.commit(async (tx) => {
                        accepted = (await tx.submissionByRequest(id, requestId)) !== undefined;

                        return undefined;
                    }, ctx);

                    // A crash after admission must not reinterpret an already-authorized input as a new spend.
                    if (!accepted) {
                        if (user === undefined) {
                            throw new HttpError(401, "Requester's access was removed");
                        }

                        this.#human(id, user);
                        this.requireWritable(id);
                        this.#app.spend.check(user, id);
                    }

                    const conversation = await runtime.conversation(id, ctx);

                    if (conversation === undefined) {
                        throw new Error("Handoff destination no longer exists");
                    }

                    const submission = await conversation.submit(
                        {
                            type: "input",
                            content:
                                user === undefined
                                    ? "Previously admitted durable handoff"
                                    : this.#app.commands.messageText(
                                          user,
                                          `Continue as the ${record.targetType} agent in this independent thread, following your thread-role system instructions.\n\nIndependent handoff from thread ${record.sourceThreadId}; work item ${record.workItemId}.\n\n${record.brief}`,
                                      ),
                            requestId,
                            whenBusy: "followUp",
                        },
                        ctx,
                    );
                    // A failed foreground run can strand a follow-up forever. Withdraw only our still-queued input
                    // when idle; an explicit retry uses a new recorded delivery attempt.
                    const watch = await runtime.watchDoc(LiveDoc, id, ctx);
                    let withdrawing: Promise<unknown> = Promise.resolve();
                    let stranded = false;

                    try {
                        if (watch !== undefined) {
                            const strand = async (live: typeof watch.value) => {
                                if (live?.run !== undefined) {
                                    return;
                                }

                                withdrawing = runtime.commit(async (tx) => {
                                    const current = await tx.submissionByRequest(id, requestId);
                                    const latest = await tx.doc(LiveDoc, id);

                                    if (
                                        latest.run !== undefined ||
                                        current?.id !== submission.id ||
                                        current.type !== "input" ||
                                        current.status !== "queued"
                                    ) {
                                        return undefined;
                                    }

                                    const items = (await tx.doc(InboxDoc, id)).items;
                                    const index = items.findIndex(
                                        (item) => item.id === submission.id,
                                    );

                                    if (index >= 0) {
                                        tx.settleSubmission(submission.id, {
                                            status: "unanswered",
                                            reason: "aborted",
                                            detail: "pocket.handoff-idle-withdrawal",
                                        });
                                        items.splice(index, 1);
                                        stranded = true;
                                    }

                                    return undefined;
                                }, ctx);
                                await withdrawing;
                            };

                            await strand(watch.value);
                            watch.start(strand);
                        }

                        const settled = await submission.wait(ctx);

                        if (stranded || settled.detail === "pocket.handoff-idle-withdrawal") {
                            throw new Error(
                                "The destination went idle before taking the brief; retry this handoff request",
                            );
                        }
                    } finally {
                        watch?.stop();
                        await withdrawing;
                    }
                } catch (error) {
                    reason =
                        error instanceof Error ? error.message : "Handoff delivery was blocked";
                }

                await runtime.commit(async (tx) => {
                    const current = (await tx.doc(HandoffsDoc)).handoffs[record.id];

                    if (current !== undefined) {
                        current.delivery = reason === undefined ? "delivered" : "blocked";

                        if (reason !== undefined) {
                            current.deliveryReason = reason.slice(0, 1000);
                        } else {
                            delete current.deliveryReason;
                        }
                    }

                    return finished;
                }, ctx);
            },
        },
        abort: (_task, runtime, ctx) =>
            runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
    });

    async recover(storage: Storage): Promise<void> {
        this.#storage = storage;
        this.committed(await this.#app.harness.snapshot(HandoffsDoc, context));

        for (const item of this.#app.sessions()) {
            const id = item.id as ConversationId;
            const state = await this.#app.harness.snapshot(WorkflowDoc, id, context);

            if (state !== undefined) {
                this.workflowCommitted(id, state);
            }
        }
    }

    committed(value: unknown): void {
        this.#doc = (value as HandoffsData | undefined) ?? empty();
    }

    workflowCommitted(id: ConversationId, value: unknown): void {
        if (value === null || value === undefined) {
            this.#workflows.delete(id);
        } else {
            this.#workflows.set(id, value as Workflow);
        }
    }

    isManaged(id: ConversationId): boolean {
        const root = this.#app.rootOf(id);

        const state = this.#workflows.get(root);

        return (
            this.#app.sessionMeta(root)?.workItemId !== undefined ||
            ["worker", "reviewer", "follow-up", "pull", "land", "publish"].includes(
                this.#app.sessionMeta(root)?.threadType ?? "",
            ) ||
            state?.proposal !== undefined ||
            state?.readOnly === true ||
            (state !== undefined && state.status !== "active")
        );
    }

    isReadOnly(id: ConversationId): boolean {
        const root = this.#app.rootOf(id);
        const meta = this.#app.sessionMeta(root);
        const item =
            meta?.workItemId === undefined ? undefined : this.#doc.workItems[meta.workItemId];

        return (
            this.#workflows.get(root)?.readOnly === true ||
            (item !== undefined && item.activeThreadId !== Number(root))
        );
    }

    requireWritable(id: ConversationId): void {
        if (this.isReadOnly(id)) {
            throw new HttpError(
                409,
                "This previous writer is permanently read-only; continue in the active thread",
            );
        }
    }

    /** Publication approvals bind the exact same checkout fingerprint as workflow completion. */
    async fingerprint(id: ConversationId): Promise<string> {
        return (await fingerprint(this.#app.cwdOf(this.#app.rootOf(id)))).digest;
    }

    projection(id: ConversationId, user?: User) {
        const root = this.#app.rootOf(id);
        const meta = this.#app.sessionMeta(root);
        const item =
            meta?.workItemId === undefined ? undefined : this.#doc.workItems[meta.workItemId];

        return {
            workflow: {
                ...publicWorkflow(this.#workflows.get(root)),
                readOnly: this.isReadOnly(root),
                managed: this.isManaged(root),
            },
            ...(item === undefined
                ? {}
                : {
                      workItemId: item.id,
                      workItemTitle:
                          user === undefined ||
                          this.#app.canSee(user, item.originThreadId as ConversationId)
                              ? item.title
                              : "Work item",
                      ...(user === undefined ||
                      this.#app.canSee(user, item.activeThreadId as ConversationId)
                          ? { activeThreadId: item.activeThreadId }
                          : {}),
                  }),
        };
    }

    #human(id: ConversationId, supplied: User): User {
        const user = this.#app.config.userById(supplied.id);

        if (user === undefined) {
            throw new HttpError(401, "Your access was removed");
        }

        this.#app.requireSee(user, id);
        this.#app.requireSteer(user);

        return user;
    }

    #requester(id: ConversationId): User {
        const requester = this.#app.attribution.requesterOf(id);
        const user = requester === undefined ? undefined : this.#app.config.userById(requester);

        if (user === undefined) {
            throw new HttpError(
                403,
                "No authenticated requester is associated with this invocation",
            );
        }

        return this.#human(id, user);
    }

    #writable(state: Readonly<Workflow>): void {
        if (state.readOnly) {
            throw new HttpError(409, "This previous writer is permanently read-only");
        }
    }

    #receipt(state: Workflow, key: string, input: string): boolean {
        const receipt = state.receipts[key];

        if (receipt !== undefined && receipt !== input) {
            throw new HttpError(409, "This invocation was already used with different arguments");
        }

        return receipt !== undefined;
    }

    #externalReview(request: RecordExternalReview): ExternalReviewInput {
        if (
            request.sourceEntryId !== undefined &&
            (!Number.isSafeInteger(request.sourceEntryId) || Number(request.sourceEntryId) < 1)
        ) {
            throw new HttpError(400, "sourceEntryId must identify a persisted human input");
        }

        const checkpoint = text(request.checkpoint, "checkpoint", 64);

        if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(checkpoint)) {
            throw new HttpError(400, "Give the full reviewed commit or code fingerprint");
        }

        return {
            ...(request.sourceEntryId === undefined
                ? {}
                : { sourceEntryId: Number(request.sourceEntryId) }),
            source: text(request.source, "source", 2000),
            scope: text(request.scope, "scope", 2000),
            findings: text(request.findings, "findings", 8000),
            checkpoint,
        };
    }

    /** Only genuine human input in this thread can ground intake, never assistant text or a copied courier. */
    async #externalReviewInput(
        tx: Tx,
        id: ConversationId,
        supplied: User,
        request: ExternalReviewInput,
    ) {
        const user = this.#human(id, supplied);

        this.requireWritable(id);
        const state = await tx.doc(WorkflowDoc, id);
        const sessions = await tx.doc(SessionsDoc);
        const turns = await tx.doc(TurnsDoc, id);

        this.#writable(state);

        if (turns.on && turns.driver !== user.id) {
            throw new HttpError(409, "Take the wheel before recording external review");
        }

        const groups = await tx.doc(HandoffsDoc);
        const meta = sessions.items[String(id)];
        const group =
            meta?.workItemId === undefined ? undefined : groups.workItems[meta.workItemId];

        if (group !== undefined && group.activeThreadId !== Number(id)) {
            throw new HttpError(409, "Only the active work-item thread can record external review");
        }

        if (
            id !== this.#app.rootOf(id) ||
            !["chat", "worker", "pull", "follow-up"].includes(
                sessions.items[String(id)]?.threadType ?? "worker",
            )
        ) {
            throw new HttpError(
                409,
                "Record external review in the active pre-landing main thread",
            );
        }

        const evidence = await this.#humanReviewSource(tx, id, request);
        const author = this.#app.config.userById(evidence.suppliedBy);

        if (author === undefined || author.role === "viewer") {
            throw new HttpError(409, "External review must come from a human with steering rights");
        }

        return { state, user, ...evidence };
    }

    /** Resolve immutable submission identity, not deferred AuthorsDoc attribution. Recheck it on the Tx line. */
    async #resolveReviewSource(
        id: ConversationId,
        request: ExternalReviewInput,
        ctx: Context = context,
    ): Promise<ExternalReviewInput> {
        let cursor: Cursor | undefined;

        do {
            const page = await this.#storage.scanSubmissions(
                { conversationId: id, order: "descending" },
                64,
                cursor,
                ctx,
            );

            for (const submission of page.items) {
                if (
                    submission.type !== "input" ||
                    requestPerson(submission.requestId)?.wrote !== true ||
                    /^u:[^:]+:handoff:/.test(submission.requestId ?? "") ||
                    submission.entry === undefined ||
                    (request.sourceEntryId !== undefined &&
                        request.sourceEntryId !== Number(submission.entry))
                ) {
                    continue;
                }

                return {
                    ...request,
                    sourceEntryId: Number(submission.entry),
                    sourceSubmissionId: Number(submission.id),
                    sourceRequestId: submission.requestId!,
                };
            }

            cursor = page.next;
        } while (cursor !== undefined);

        throw new HttpError(409, "No matching human-supplied external review input in this thread");
    }

    async #humanReviewSource(tx: Tx, id: ConversationId, request: ExternalReviewInput) {
        const submission =
            request.sourceRequestId === undefined
                ? undefined
                : await tx.submissionByRequest(id, request.sourceRequestId);
        const person = requestPerson(submission?.requestId);

        if (
            submission?.type !== "input" ||
            person?.wrote !== true ||
            /^u:[^:]+:handoff:/.test(submission.requestId ?? "") ||
            submission.conversationId !== id ||
            submission.entry === undefined ||
            Number(submission.id) !== request.sourceSubmissionId ||
            Number(submission.entry) !== request.sourceEntryId
        ) {
            throw new HttpError(
                409,
                "No matching human-supplied external review input in this thread",
            );
        }

        const entry = await tx.entry(submission.entry);
        const input = userContent(entry?.model?.[0]).text;

        if (
            entry?.kind !== "pi.user" ||
            entry.conversationId !== id ||
            ![request.source, request.findings, request.checkpoint].every((value) =>
                input.includes(value),
            )
        ) {
            throw new HttpError(
                409,
                "Paste the external review source, findings and reviewed checkpoint in a human message; agent briefs or links alone are not review evidence",
            );
        }

        return {
            sourceEntryId: Number(submission.entry),
            sourceSubmissionId: Number(submission.id),
            sourceRequestId: submission.requestId!,
            suppliedBy: person.userId,
        };
    }

    async #recordExternalReview(
        tx: Tx,
        id: ConversationId,
        supplied: User,
        request: ExternalReviewInput,
        code: CodeFingerprint,
        key?: string,
    ) {
        const { state, user, sourceEntryId, sourceSubmissionId, sourceRequestId, suppliedBy } =
            await this.#externalReviewInput(tx, id, supplied, request);
        const input = digest(request);

        if (key !== undefined && this.#receipt(state, key, input)) {
            return;
        }

        if (
            request.checkpoint !== code.digest &&
            (code.status !== "" || request.checkpoint !== code.head)
        ) {
            throw new HttpError(
                409,
                "External review checkpoint does not match the current code; record review before applying repairs",
            );
        }

        if (
            this.#app.cwdOf(id) !== code.cwd ||
            (await fingerprint(code.cwd)).digest !== code.digest
        ) {
            throw new HttpError(409, "Checkout changed while recording external review");
        }

        const review: ExternalReview = {
            source: request.source,
            scope: request.scope,
            findings: request.findings,
            checkpoint: request.checkpoint,
            sourceEntryId,
            sourceSubmissionId,
            sourceRequestId,
            suppliedBy,
            recordedBy: user.id,
            recordedAt: Date.now(),
            fingerprint: code,
        };

        state.externalReview = review;
        state.status = "active";
        state.readyForPublish = false;
        delete state.reviewApplicability;
        delete state.fingerprint;
        delete state.completedAt;
        delete state.completedBy;
        this.#human(id, supplied);

        if (key !== undefined) {
            state.receipts[key] = input;
        }
    }

    async recordExternalReview(
        id: ConversationId,
        supplied: User,
        request: RecordExternalReview,
    ): Promise<void> {
        this.#human(id, supplied);
        this.requireWritable(id);
        await this.#app.requireDriver(id, supplied);
        const checked = await this.#resolveReviewSource(id, this.#externalReview(request));

        await this.#app.harness.commit(async (tx) => {
            await this.requireIdle(tx, id);
            await this.#externalReviewInput(tx, id, supplied, checked);
        }, context);
        const code = await fingerprint(this.#app.cwdOf(id));

        await this.#app.harness.commit(async (tx) => {
            await this.requireIdle(tx, id);
            await this.#recordExternalReview(tx, id, supplied, checked, code);
        }, context);
    }

    #completion(request: CompleteHandoff) {
        const status = request.status;

        if (!STATUSES.includes(status as WorkflowStatus)) {
            throw new HttpError(400, "Choose review-complete, landed, published or needs-review");
        }

        if (request.readyForPublish !== undefined && typeof request.readyForPublish !== "boolean") {
            throw new HttpError(400, "readyForPublish must be a boolean");
        }

        if (request.readyForPublish === true && status !== "landed") {
            throw new HttpError(400, "Only landed work can be readyForPublish");
        }

        if (
            request.reviewApplicability !== undefined &&
            request.reviewApplicability !== "preserved" &&
            request.reviewApplicability !== "invalidated"
        ) {
            throw new HttpError(400, "reviewApplicability must be preserved or invalidated");
        }

        if (request.reviewApplicability === "invalidated" && status !== "needs-review") {
            throw new HttpError(
                409,
                "Material rewrites require needs-review and fresh independent review",
            );
        }

        return {
            status: status as WorkflowStatus,
            summary: text(request.summary, "summary", 8000),
            readyForPublish: request.readyForPublish === true,
            reviewApplicability: request.reviewApplicability,
            recommendations:
                recommendations(request.recommendations) ??
                (request.reviewApplicability === "invalidated"
                    ? [
                          {
                              targetType: "reviewer",
                              relationship: "same-work",
                              reason: "Material changes invalidate the original independent review.",
                          },
                      ]
                    : status === "review-complete"
                      ? [
                            {
                                targetType: "land",
                                relationship: "same-work",
                                reason: "Independent review and applicable repair checks support local landing.",
                            },
                        ]
                      : []),
        } satisfies Completion;
    }

    /** Reuse independent internal or human-supplied external review only across same-work repairs.
     * Unresolved checks do not invalidate review; a material rewrite does.
     * Research briefs and Follow-up attestations never substitute for independent evidence.
     */
    async #reviewProvenanceReason(tx: Tx, id: ConversationId): Promise<string | undefined> {
        const sessions = await tx.doc(SessionsDoc);
        const state = await tx.doc(WorkflowDoc, id);

        if (state.reviewApplicability === "invalidated") {
            return "Material changes invalidate the original review; fresh independent review is required";
        }

        if (sessions.items[String(id)]?.threadType !== "follow-up") {
            return undefined;
        }

        const doc = await tx.doc(HandoffsDoc);
        const workItemId = sessions.items[String(id)]?.workItemId;
        const group = workItemId === undefined ? undefined : doc.workItems[workItemId];
        const members = new Set(group?.threadIds);
        const incoming = new Map(
            Object.values(doc.handoffs)
                .filter((record) => record.workItemId === workItemId)
                .map((record) => [record.targetThreadId, record]),
        );
        const seen = new Set<number>();
        let current = Number(id);
        let transfer: CodeFingerprint | undefined;

        while (!seen.has(current)) {
            seen.add(current);
            const meta = sessions.items[String(current)];
            const review = await tx.doc(WorkflowDoc, current as ConversationId);

            if (review.reviewApplicability === "invalidated") {
                return "Material changes invalidate the original review; fresh independent review is required";
            }

            const external = review.externalReview;

            if (
                external?.recordedAt !== undefined &&
                external.recordedBy !== undefined &&
                external.suppliedBy !== undefined &&
                external.fingerprint?.cwd === this.#app.cwdOf(id) &&
                (external.checkpoint === external.fingerprint.digest ||
                    (external.fingerprint.status === "" &&
                        external.checkpoint === external.fingerprint.head))
            ) {
                try {
                    const evidence = await this.#humanReviewSource(tx, current as ConversationId, {
                        ...this.#externalReview(external),
                        sourceSubmissionId: external.sourceSubmissionId,
                        sourceRequestId: external.sourceRequestId,
                    });

                    if (evidence.suppliedBy === external.suppliedBy) {
                        if (
                            meta?.threadType !== "follow-up" &&
                            transfer?.digest !== external.fingerprint.digest
                        ) {
                            return "External review checkpoint changed before entering repairs; record fresh independent review of the implementation or integration checkpoint";
                        }

                        return undefined;
                    }
                } catch (error) {
                    if (!(error instanceof HttpError)) {
                        throw error;
                    }

                    // Historical or manufactured attestations without grounded human input are not provenance.
                }
            }

            if (meta?.threadType === "reviewer") {
                if (
                    review.readOnly &&
                    ["review-complete", "needs-review"].includes(review.status) &&
                    review.completedAt !== undefined &&
                    review.completedBy !== undefined &&
                    review.fingerprint?.cwd === this.#app.cwdOf(id)
                ) {
                    return undefined;
                }

                break;
            }

            if (meta?.threadType !== "follow-up") {
                break;
            }

            const record = incoming.get(current);

            if (
                !members.has(current) ||
                record?.relationship !== "same-work" ||
                !members.has(record.sourceThreadId) ||
                sessions.items[String(record.sourceThreadId)]?.workItemId !== workItemId
            ) {
                break;
            }

            transfer = record.codeCheckpoint;
            current = record.sourceThreadId;
        }

        return "Follow-up review completion requires a recorded independent Reviewer outcome or human-supplied external review in this work item's repair chain; research findings and self-attestations do not qualify";
    }

    /** Update the declared outcome without manufacturing a new inspected checkpoint. */
    #outcome(state: Workflow, request: Completion): void {
        state.status = request.status;
        state.summary = request.summary;
        state.recommendations = request.recommendations;
        state.readyForPublish = request.readyForPublish;

        if (state.proposal !== undefined && request.recommendations[0] !== undefined) {
            // Keep the authored brief, but do not let an earlier suggestion override the latest outcome.
            const recommendation = request.recommendations[0];

            state.proposal.targetType = recommendation.targetType;
            state.proposal.relationship = recommendation.relationship;
        }
    }

    /** Completion admission is shared by preflight and the final code-bound transaction. */
    async #completionState(
        tx: Tx,
        id: ConversationId,
        supplied: User,
        request: Completion,
        key?: string,
    ) {
        const user = this.#human(id, supplied);
        const sessions = await tx.doc(SessionsDoc);
        const state = await tx.doc(WorkflowDoc, id);
        const meta = sessions.items[String(id)];

        this.#writable(state);
        const groups = await tx.doc(HandoffsDoc);
        const group =
            meta?.workItemId === undefined ? undefined : groups.workItems[meta.workItemId];

        if (group !== undefined && group.activeThreadId !== Number(id)) {
            throw new HttpError(409, "Only the active work-item thread can record completion");
        }

        if (meta === undefined) {
            throw new HttpError(404, "Not a session");
        }

        const kind = meta.threadType ?? "worker";

        if (
            (request.status === "landed" && kind !== "land") ||
            (request.status === "published" && kind !== "publish") ||
            (request.status === "review-complete" && !["reviewer", "follow-up"].includes(kind))
        ) {
            throw new HttpError(409, "Completion status does not match this thread's role");
        }

        if (
            request.reviewApplicability !== undefined &&
            !["reviewer", "follow-up"].includes(kind)
        ) {
            throw new HttpError(409, "Only review or repair threads assess review applicability");
        }

        // A replay of an already-recorded outcome must not revoke a newer milestone or fresh review.
        if (key !== undefined && this.#receipt(state, key, digest(request))) {
            return { user, state, group };
        }

        if (request.status === "review-complete" && state.reviewApplicability === "invalidated") {
            throw new HttpError(
                409,
                "Material changes require fresh independent review, not a new self-attestation",
            );
        }

        if (request.status === "review-complete") {
            const reason = await this.#reviewProvenanceReason(tx, id);

            if (reason !== undefined) {
                throw new HttpError(409, reason);
            }
        }

        if (request.status === "needs-review") {
            // A blocker revokes readiness even if inspection fails. Preserve prior independent evidence
            // for ordinary repairs, without creating a new code-bound completion identity.
            this.#outcome(state, request);

            if (request.reviewApplicability === "invalidated") {
                state.reviewApplicability = "invalidated";
                delete state.fingerprint;
                delete state.completedAt;
                delete state.completedBy;
            }
        }

        return { user, state, group };
    }

    async #complete(
        tx: Tx,
        id: ConversationId,
        supplied: User,
        request: Completion,
        code: CodeFingerprint,
        key?: string,
    ): Promise<void> {
        const { user, state, group } = await this.#completionState(tx, id, supplied, request, key);

        if (request.status === "published") {
            await this.#requireResolvedPublications(tx, group?.threadIds ?? [Number(id)]);
        }

        const input = digest(request);

        if (key !== undefined && this.#receipt(state, key, input)) {
            return;
        }

        if (request.status === "landed" && code.status !== "") {
            throw new HttpError(
                409,
                "Land must commit local changes and leave a clean checkout before completing",
            );
        }

        if (
            request.status === "published" &&
            (state.readyForPublish !== true || state.fingerprint?.digest !== code.digest)
        ) {
            throw new HttpError(
                409,
                "Publication readiness changed; review and land the current code again",
            );
        }

        if (request.status === "published" && key !== undefined) {
            const publications = await tx.doc(PublicationsDoc, id);

            if (
                !Object.values(publications.receipts).some(
                    (receipt) => receipt.state === "completed" && receipt.exitCode === 0,
                )
            ) {
                throw new HttpError(
                    409,
                    "The model can mark published only after an approved publication action succeeds",
                );
            }
        }

        if (
            this.#app.cwdOf(id) !== code.cwd ||
            (await fingerprint(code.cwd)).digest !== code.digest
        ) {
            throw new HttpError(409, "Checkout changed while recording completion");
        }

        if (
            request.reviewApplicability !== undefined &&
            state.reviewApplicability !== "invalidated"
        ) {
            state.reviewApplicability = request.reviewApplicability;
        }

        this.#outcome(state, request);
        state.fingerprint = code;
        state.completedAt = Date.now();
        state.completedBy = user.id;
        this.#human(id, supplied);

        if (key !== undefined) {
            state.receipts[key] = input;
        }
    }

    async #requireResolvedPublications(tx: Tx, members: number[]): Promise<void> {
        for (const memberId of members) {
            const publications = await tx.doc(PublicationsDoc, memberId as ConversationId);

            if (
                Object.values(publications.receipts).some(
                    (receipt) => receipt.state === "executing",
                )
            ) {
                throw new HttpError(
                    409,
                    "Reconcile uncertain publication actions before completing or handing off this work item",
                );
            }
        }
    }

    async complete(id: ConversationId, supplied: User, request: CompleteHandoff): Promise<void> {
        this.#human(id, supplied);
        this.requireWritable(id);
        await this.#app.requireDriver(id, supplied);
        const checked = this.#completion(request);

        await this.#app.harness.commit(async (tx) => {
            await this.requireIdle(tx, id);
            await this.#completionState(tx, id, supplied, checked);
        }, context);
        const code = await fingerprint(this.#app.cwdOf(id));

        await this.#app.harness.commit(async (tx) => {
            await this.requireIdle(tx, id);
            await this.#complete(tx, id, supplied, checked, code);
        }, context);
    }

    /** Exempt only this tool invocation and its owning run; helpers are never part of the exemption. */
    async #invocationTasks(tx: Tx, taskId: TaskId, runId?: TaskId): Promise<Set<TaskId>> {
        const allowed = new Set<TaskId>();
        let current = await tx.task(taskId);

        while (current !== undefined && !allowed.has(current.id)) {
            allowed.add(current.id);

            if (current.id === runId) {
                break;
            }

            current = current.owner === undefined ? undefined : await tx.task(current.owner);
        }

        return allowed;
    }

    /** A completed report is the minimum review input, not proof of code changes or correctness. */
    async #hasCompletedWork(tx: Tx, id: ConversationId): Promise<boolean> {
        let cursor: Cursor | undefined;

        do {
            const page = await tx.scanEntries({ conversationId: id }, 256, cursor);

            if (
                page.items.some((entry) => {
                    const message = entry.model?.[0];

                    return (
                        entry.kind === "pi.assistant" &&
                        message?.role === "assistant" &&
                        message.stopReason === "stop" &&
                        userContent(message).text.trim().length > 0
                    );
                })
            ) {
                return true;
            }

            cursor = page.next;
        } while (cursor !== undefined);

        return false;
    }

    /** Busy checks are transaction reads, before creating any destination or reserving a receipt. Never abort writers. */
    async #idle(
        tx: Tx,
        roots: number[],
        allowed = new Set<TaskId>(),
        allowHandoffDelivery = allowed.size > 0,
    ): Promise<void> {
        const pending = roots.map((id) => id as ConversationId);
        const seen = new Set<ConversationId>();

        while (pending.length > 0) {
            const id = pending.pop()!;

            if (seen.has(id)) {
                continue;
            }

            seen.add(id);
            const live = await tx.doc(LiveDoc, id);
            const inbox = await tx.doc(InboxDoc, id);
            const agents = await tx.doc(SubagentsDoc, id);

            if (await hasPendingSubagentReports(tx, id)) {
                throw new HttpError(
                    409,
                    "Wait for pending subagent reports to be delivered or explicitly discarded before handing off",
                );
            }

            if (
                (live.run !== undefined && !allowed.has(live.run.taskId)) ||
                inbox.items.length > 0
            ) {
                throw new HttpError(
                    409,
                    "Wait until all thread work, including delegated helpers and queued reports, is idle before an exclusive workflow operation (handoff or fetch). End the current turn to receive pending reports; do not retry unchanged attempts.",
                );
            }

            let cursor: Cursor | undefined;

            do {
                const page = await tx.scanTasks({ conversationId: id }, 256, cursor);

                if (
                    page.items.some(
                        (task) =>
                            task.state.status !== "terminal" &&
                            !allowed.has(task.id) &&
                            !(allowHandoffDelivery && task.kind === "pocket.handoff-send"),
                    )
                ) {
                    throw new HttpError(
                        409,
                        "Wait for all work-item background tasks and delegated helpers to finish before an exclusive workflow operation (handoff or fetch)",
                    );
                }

                cursor = page.next;
            } while (cursor !== undefined);

            pending.push(...Object.values(agents.agents).map((record) => record.conversationId));
        }
    }

    /** Fetch admission exempts its main invocation/run and its already-placed incoming brief, never other work. */
    async requireFetchIdle(tx: Tx, id: ConversationId, taskId: TaskId): Promise<void> {
        if (id !== this.#app.rootOf(id)) {
            throw new HttpError(403, "Only the main Pull thread may fetch");
        }

        const live = await tx.doc(LiveDoc, id);
        const allowed = await this.#invocationTasks(tx, taskId, live.run?.taskId);

        if (live.run === undefined || !allowed.has(live.run.taskId)) {
            throw new HttpError(409, "Fetch requires its current main invocation/run");
        }

        // The incoming courier only waits for this run's answer after placing its brief. Counting it
        // as independent work deadlocks every successor's first fetch. Match the exact durable input;
        // never exempt a queued/unrelated delivery, another member's courier, or a helper reporter.
        const handoffs = await tx.doc(HandoffsDoc);
        const incoming = Object.values(handoffs.handoffs).find(
            (record) => record.targetThreadId === Number(id) && record.delivery === "pending",
        );
        const submission =
            incoming === undefined
                ? undefined
                : await tx.submissionByRequest(
                      id,
                      ownRequest(
                          incoming.requestedBy,
                          `handoff:${incoming.id}:${incoming.deliveryAttempt ?? 0}`,
                      ),
                  );

        if (submission?.status === "placed" && live.run.inputs.includes(submission.id)) {
            let cursor: Cursor | undefined;

            do {
                const page = await tx.scanTasks({ conversationId: id }, 256, cursor);

                for (const task of page.items) {
                    if (
                        task.kind === "pocket.handoff-send" &&
                        task.state.status === "running" &&
                        !task.abortRequested &&
                        task.background &&
                        task.owner === undefined &&
                        typeof task.input === "object" &&
                        task.input !== null &&
                        "handoffId" in task.input &&
                        task.input.handoffId === incoming!.id
                    ) {
                        allowed.add(task.id);
                    }
                }

                cursor = page.next;
            } while (cursor !== undefined);
        }

        await this.#idle(tx, this.members(id).map(Number), allowed, false);
    }

    /** Human cleanup callers must prove the complete group and descendant task graph quiescent. */
    async requireIdle(tx: Tx, id: ConversationId): Promise<void> {
        await this.#idle(tx, this.members(id).map(Number));
    }

    async list(id: ConversationId, supplied: User) {
        const user = this.#app.config.userById(supplied.id);

        if (user === undefined) {
            throw new HttpError(401, "Your access was removed");
        }

        this.#app.requireSee(user, id);
        const root = this.#app.rootOf(id);
        const meta = this.#app.sessionMeta(root);
        const item =
            meta?.workItemId === undefined ? undefined : this.#doc.workItems[meta.workItemId];
        const state = this.#workflows.get(root);
        let current: CodeFingerprint | undefined;

        try {
            current = await fingerprint(this.#app.cwdOf(root));
        } catch {
            // Listing remains available for non-Git conversations; gated transitions explain why they are unavailable.
        }

        const readiness = await this.#app.harness.commit(async (tx) => {
            const hasCompletedWork = await this.#hasCompletedWork(tx, root);
            let busyReason: string | undefined;

            try {
                await this.#idle(tx, this.members(root).map(Number));
            } catch (error) {
                if (!(error instanceof HttpError)) {
                    throw error;
                }

                busyReason = error.message;
            }

            const reviewReason =
                state?.status === "review-complete"
                    ? await this.#reviewProvenanceReason(tx, root)
                    : undefined;

            return { hasCompletedWork, busyReason, reviewReason };
        }, context);
        const options = TYPES.flatMap((kind) =>
            (kind === "worker"
                ? (["same-work", "new-work"] as const)
                : (["same-work"] as const)
            ).map((relation) => ({ kind, relation })),
        ).map(({ kind, relation }) => {
            let reason: string | undefined;

            if (user.role === "viewer") {
                reason = "Steering rights are required";
            } else if (relation === "new-work" && user.sessions !== undefined) {
                reason = "People invited to particular sessions cannot start new work";
            } else if (root !== id || this.isReadOnly(root)) {
                reason = "Continue from the active main thread";
            } else if (meta?.archived === true) {
                reason = "Restore the work item first";
            } else if (
                item?.threadIds.some((member) => !this.#app.canSee(user, member as ConversationId))
            ) {
                reason = "Every work-item member must be visible to activate a handoff";
            } else if (readiness.busyReason !== undefined) {
                reason = readiness.busyReason;
            } else if (kind === "land" && readiness.reviewReason !== undefined) {
                reason = readiness.reviewReason;
            } else {
                reason = this.#transitionReason(
                    kind,
                    relation,
                    state,
                    item,
                    current,
                    readiness.hasCompletedWork,
                );
            }

            return {
                targetType: kind,
                relationship: relation,
                enabled: reason === undefined,
                ...(reason === undefined ? {} : { reason }),
            };
        });

        return {
            workflow: this.projection(root).workflow,
            ...(item === undefined ? {} : { workItem: this.#publicItem(item, user) }),
            handoffs: Object.values(this.#doc.handoffs)
                .filter((record) =>
                    item === undefined
                        ? record.sourceThreadId === Number(root)
                        : record.workItemId === item.id,
                )
                .filter(
                    (record) =>
                        this.#app.canSee(user, record.sourceThreadId as ConversationId) &&
                        this.#app.canSee(user, record.targetThreadId as ConversationId),
                )
                .map(({ codeCheckpoint: _privateCheckpoint, ...record }) => record),
            options,
        };
    }

    #publicItem(item: WorkItem, user: User) {
        return {
            id: item.id,
            title: this.#app.canSee(user, item.originThreadId as ConversationId)
                ? item.title
                : "Work item",
            ...(this.#app.canSee(user, item.originThreadId as ConversationId)
                ? { originThreadId: item.originThreadId }
                : {}),
            ...(this.#app.canSee(user, item.activeThreadId as ConversationId)
                ? { activeThreadId: item.activeThreadId }
                : {}),
            threadIds: item.threadIds.filter((id) => this.#app.canSee(user, id as ConversationId)),
            ...(item.projectId === undefined ? {} : { projectId: item.projectId }),
            ...(item.goalId === undefined ? {} : { goalId: item.goalId }),
            archived: item.archived === true,
        };
    }

    #requireMembers(item: WorkItem, user: User): void {
        if (item.threadIds.some((id) => !this.#app.canSee(user, id as ConversationId))) {
            throw new HttpError(404, "This work item is not shared with you");
        }
    }

    #transitionReason(
        kind: ThreadType,
        relation: Relationship,
        state?: Readonly<Workflow>,
        item?: WorkItem,
        code?: CodeFingerprint,
        hasCompletedWork = false,
    ): string | undefined {
        if (kind === "reviewer" && !hasCompletedWork) {
            return "There is no completed work to review; finish work in this thread first";
        }

        if (relation === "new-work") {
            return kind !== "worker" ||
                (state?.status !== "landed" && state?.status !== "published")
                ? "New work needs a landed or published predecessor and a Worker target"
                : undefined;
        }

        if (kind === "land" || kind === "publish") {
            const expected = kind === "land" ? "review-complete" : "landed";

            if (
                state?.status !== expected ||
                (kind === "publish" && state.readyForPublish !== true)
            ) {
                return kind === "land"
                    ? "Complete review before landing"
                    : "Land and mark readyForPublish before publishing";
            }

            if (code === undefined || state.fingerprint?.digest !== code.digest) {
                return "Checkout changed since completion; review the current code again";
            }
        }

        if (item?.archived === true) {
            return "Restore the work item first";
        }

        return undefined;
    }

    /** Bounded useful fallback, read from persisted history; never compacts or changes the source transcript. */
    async #brief(
        tx: Tx,
        id: ConversationId,
        origin: ConversationId,
        code?: CodeFingerprint,
    ): Promise<string> {
        const first = await tx.scanEntries({ conversationId: origin, order: "ascending" }, 16);
        const last = await tx.scanEntries({ conversationId: id, order: "descending" }, 24);
        const source = await tx.latestHeadMarker(id);
        const state = await tx.doc(WorkflowDoc, id);
        const extract = (entry: { model?: readonly unknown[] } | undefined, max: number) =>
            userContent(entry?.model?.[0]).text.slice(0, max);
        const user = last.items.find((entry) => entry.kind === "pi.user");
        const assistant = last.items.find((entry) => entry.kind === "pi.assistant");

        return [
            `Original ask/spec references (origin thread ${origin}):\n${
                extract(
                    first.items.find((entry) => entry.kind === "pi.user"),
                    2800,
                ) ||
                "No original user message persisted; clarify the intended work before proceeding."
            }`,
            `Persisted compaction:\n${
                extract(
                    source?.kind === "pi.compaction"
                        ? source
                        : last.items.find((entry) => entry.kind === "pi.compaction"),
                    2200,
                ) || "None."
            }`,
            `Last user message:\n${extract(user, 2000) || "None."}`,
            `Last assistant report / tests / risks:\n${extract(assistant, 2800) || "No completed report. Inspect tests and risks rather than assuming they passed."}`,
            `Workflow summary:\n${state.summary?.slice(0, 1200) ?? "None; tests and unresolved risks must be checked."}`,
            `Source checkpoint: thread ${id}, latest transcript entry ${last.items[0]?.id ?? "none"}; cwd ${this.#app.cwdOf(id)}; Git HEAD ${code?.head ?? "unavailable"}; fingerprint ${code?.digest ?? "unavailable"}; status ${code === undefined ? "unavailable" : code.status === "" ? "clean" : "dirty (inspect the current checkout)"}.`,
        ]
            .join("\n\n")
            .slice(0, 12_000);
    }

    async start(id: ConversationId, supplied: User, request: StartHandoff): Promise<HandoffResult> {
        const user = this.#human(id, supplied);
        const kind = target(request.targetType);
        const relation = relationship(request.relationship);
        const brief = request.brief === undefined ? undefined : text(request.brief, "brief");
        const key = digest([user.id, Number(id), text(request.requestId, "requestId", 160)]);
        const input = digest([kind, relation, brief ?? null]);

        if (id !== this.#app.rootOf(id)) {
            throw new HttpError(403, "Start a handoff from the main thread, not its subagent");
        }

        // Successful retries must not depend on the predecessor still being writable or its checkout still existing.
        if (this.#doc.requests[key] !== undefined) {
            return this.#app.harness.commit(async (tx) => {
                this.#human(id, supplied);
                const doc = await tx.doc(HandoffsDoc);
                const saved = doc.requests[key]!;

                if (saved.input !== input) {
                    throw new HttpError(409, "This requestId already started a different handoff");
                }

                this.#app.requireSee(user, saved.id as ConversationId);
                await this.#retryDelivery(tx, doc, saved);

                return { id: saved.id, handoffId: saved.handoffId, workItemId: saved.workItemId };
            }, context);
        }

        await this.#app.requireDriver(id, user);
        await this.#app.harness.commit(async (tx) => {
            await this.requireIdle(tx, id);

            if (kind === "land") {
                const reason = await this.#reviewProvenanceReason(tx, id);

                if (reason !== undefined) {
                    throw new HttpError(409, reason);
                }
            }
        }, context);
        let code: CodeFingerprint | undefined;

        try {
            code = await fingerprint(this.#app.cwdOf(id));
        } catch (error) {
            if (kind === "land" || kind === "publish") {
                throw error;
            }
        }

        return this.#app.harness.commit(async (tx) => {
            const doc = await tx.doc(HandoffsDoc);
            const currentUser = this.#human(id, supplied);
            const saved = doc.requests[key];

            if (saved !== undefined) {
                if (saved.input !== input) {
                    throw new HttpError(409, "This requestId already started a different handoff");
                }

                this.#app.requireSee(currentUser, saved.id as ConversationId);
                await this.#retryDelivery(tx, doc, saved);

                return { id: saved.id, handoffId: saved.handoffId, workItemId: saved.workItemId };
            }

            if (Object.keys(doc.requests).length >= 10_000) {
                throw new HttpError(413, "The handoff request limit was reached");
            }

            const sessions = await tx.doc(SessionsDoc);
            const meta = sessions.items[String(id)];
            const state = await tx.doc(WorkflowDoc, id);
            const turns = await tx.doc(TurnsDoc, id);
            const oldItem =
                meta?.workItemId === undefined ? undefined : doc.workItems[meta.workItemId];

            if (meta === undefined) {
                throw new HttpError(404, "Not a session");
            }

            this.#writable(state);

            if (relation === "new-work" && currentUser.sessions !== undefined) {
                throw new HttpError(
                    403,
                    "You were invited to particular sessions and cannot start new work",
                );
            }

            if (oldItem !== undefined && oldItem.activeThreadId !== Number(id)) {
                throw new HttpError(409, "Only the active work-item thread can hand off");
            }

            if (turns.on && turns.driver !== currentUser.id) {
                throw new HttpError(409, "Take the wheel before starting a handoff");
            }

            if (meta.archived === true) {
                throw new HttpError(409, "Restore the work item first");
            }

            if (oldItem !== undefined) {
                this.#requireMembers(oldItem, currentUser);
            }

            // Uncertain external effects belong to the work, not just the Publish thread that attempted them.
            // Keep that writer available for reconciliation rather than retiring it into a fresh ledger or item.
            await this.#requireResolvedPublications(tx, oldItem?.threadIds ?? [Number(id)]);

            if (kind === "land") {
                const reason = await this.#reviewProvenanceReason(tx, id);

                if (reason !== undefined) {
                    throw new HttpError(409, reason);
                }
            }

            if (kind === "land" || kind === "publish") {
                code = await fingerprint(this.#app.cwdOf(id));
            }

            const why = this.#transitionReason(
                kind,
                relation,
                state,
                oldItem,
                code,
                await this.#hasCompletedWork(tx, id),
            );

            if (why !== undefined) {
                throw new HttpError(409, why);
            }

            await this.#idle(tx, oldItem?.threadIds ?? [Number(id)]);
            const agent = await tx.doc(AgentDoc, id);
            const cwd = agent.cwd ?? meta.cwd;

            if (cwd !== this.#app.cwdOf(id) || (code !== undefined && cwd !== code.cwd)) {
                throw new HttpError(409, "Source checkout changed; try again");
            }

            this.#app.spend.check(currentUser, id);
            // The brief describes the work, not a role-specific authorization. A human may override the recommendation.
            const suppliedBrief = brief ?? state.proposal?.brief;
            const freshBrief = await this.#brief(
                tx,
                id,
                (oldItem?.originThreadId ?? Number(id)) as ConversationId,
                code,
            );
            const sourceEntry = (
                await tx.scanEntries({ conversationId: id, order: "descending" }, 1)
            ).items[0]?.id;
            const initialBrief =
                suppliedBrief === undefined
                    ? freshBrief
                    : `Prepared/user brief (claims must be rechecked against this activation):\n${suppliedBrief}\n\nFresh persisted context at activation:\n${freshBrief.slice(0, 4000)}\n\nFresh source entry ${sourceEntry ?? "none"}; Git HEAD ${code?.head ?? "unavailable"}; code fingerprint ${code?.digest ?? "unavailable"}.`;
            const now = Date.now();
            const item: WorkItem =
                relation === "same-work" && oldItem !== undefined
                    ? oldItem
                    : {
                          id: `w-${randomUUID()}`,
                          originThreadId: relation === "new-work" ? 0 : Number(id),
                          activeThreadId: 0,
                          threadIds: relation === "new-work" ? [] : [Number(id)],
                          title: meta.title ?? "New work",
                          ...(meta.projectId === undefined ? {} : { projectId: meta.projectId }),
                          ...(meta.goalId === undefined ? {} : { goalId: meta.goalId }),
                          ...(relation === "new-work" && oldItem !== undefined
                              ? { predecessorWorkItemId: oldItem.id }
                              : {}),
                          createdAt: now,
                      };

            if (relation === "new-work" && this.#human(id, supplied).sessions !== undefined) {
                throw new HttpError(
                    403,
                    "You were invited to particular sessions and cannot start new work",
                );
            }

            this.#human(id, supplied);
            this.#app.spend.check(currentUser, id);
            // Every table read is above this first table write (Durable forbids reads after writes).
            const destination = await tx.createConversation({ ownership: { kind: "ownerless" } });
            const targetId = destination.id;

            await configure(tx, targetId, {
                cwd,
                ...(agent.model === undefined ? {} : { model: agent.model }),
                ...(agent.thinkingLevel === undefined
                    ? {}
                    : { thinkingLevel: agent.thinkingLevel }),
                // Thread-local instructions belong to the source agent, not its independent successor.
            });
            const targetState = await tx.doc(WorkflowDoc, targetId);

            if (kind === "publish") {
                targetState.fingerprint = { ...state.fingerprint! };
                targetState.readyForPublish = true;
                targetState.summary = state.summary;
            }

            item.activeThreadId = Number(targetId);
            item.threadIds.push(Number(targetId));

            if (relation === "new-work") {
                item.originThreadId = Number(targetId);
                item.title = TITLES[kind];
            } else {
                meta.workItemId = item.id;
            }

            doc.workItems[item.id] = item;
            sessions.items[String(targetId)] = {
                cwd,
                title: TITLES[kind],
                createdAt: now,
                updatedAt: now,
                createdBy: currentUser.id,
                threadType: kind,
                accessFrom: Number(id),
                workItemId: item.id,
                ...(meta.ownerOnly === true ? { ownerOnly: true } : {}),
                ...(meta.projectId === undefined ? {} : { projectId: meta.projectId }),
                ...(meta.goalId === undefined ? {} : { goalId: meta.goalId }),
                ...(meta.worktree === undefined ? {} : { worktree: { ...meta.worktree } }),
                ...(meta.budget === undefined ? {} : { budget: meta.budget }),
            };
            state.readOnly = true;
            const handoffId = `h-${randomUUID()}`;

            doc.handoffs[handoffId] = {
                id: handoffId,
                sourceThreadId: Number(id),
                targetThreadId: Number(targetId),
                targetType: kind,
                relationship: relation,
                workItemId: item.id,
                brief: initialBrief,
                ...(sourceEntry === undefined ? {} : { sourceEntryId: Number(sourceEntry) }),
                ...(code === undefined ? {} : { codeCheckpoint: code }),
                requestedBy: currentUser.id,
                createdAt: now,
                delivery: "pending",
            };
            doc.requests[key] = { input, id: Number(targetId), handoffId, workItemId: item.id };
            await tx.createTask(
                this.task,
                { handoffId },
                { conversationId: targetId, ownership: { kind: "conversation" }, background: true },
            );

            if (relation === "new-work" && this.#human(id, supplied).sessions !== undefined) {
                throw new HttpError(
                    403,
                    "You were invited to particular sessions and cannot start new work",
                );
            }

            this.#human(id, supplied);

            return { id: Number(targetId), handoffId, workItemId: item.id };
        }, context);
    }

    async #retryDelivery(
        tx: Tx,
        doc: HandoffsData,
        saved: HandoffsData["requests"][string],
    ): Promise<void> {
        const record = doc.handoffs[saved.handoffId];

        if (record?.delivery === "blocked") {
            record.deliveryAttempt = (record.deliveryAttempt ?? 0) + 1;
            record.delivery = "pending";
            delete record.deliveryReason;
            await tx.createTask(
                this.task,
                { handoffId: record.id },
                {
                    conversationId: saved.id as ConversationId,
                    ownership: { kind: "conversation" },
                    background: true,
                },
            );
        }
    }

    async updateWorkItem(id: ConversationId, supplied: User, patch: UpdateWorkItem): Promise<void> {
        this.#human(id, supplied);

        if (patch.archived !== undefined && typeof patch.archived !== "boolean") {
            throw new HttpError(400, "archived must be a boolean");
        }

        await this.#app.requireDriver(id, supplied);
        await this.#app.harness.commit(async (tx) => {
            if (patch.projectId !== undefined || patch.goalId !== undefined) {
                await this.#app.projects.assignTx(tx, supplied, id, patch);
            }

            if (patch.archived !== undefined) {
                await this.archive(tx, id, supplied, patch.archived as boolean);
            }
        }, context);
    }

    /** Shared by the legacy archive route: archive/restore never splits a work item. */
    async archive(tx: Tx, id: ConversationId, supplied: User, archived: boolean): Promise<void> {
        const user = this.#human(id, supplied);
        const sessions = await tx.doc(SessionsDoc);
        const doc = await tx.doc(HandoffsDoc);
        const meta = sessions.items[String(id)];
        const item = meta?.workItemId === undefined ? undefined : doc.workItems[meta.workItemId];

        if (item === undefined) {
            throw new HttpError(404, "Not a work item");
        }

        this.#requireMembers(item, user);

        for (const threadId of item.threadIds) {
            const member = sessions.items[String(threadId)];

            if (member === undefined) {
                throw new HttpError(409, "Work item membership is incomplete");
            }

            member.archived = archived;
            delete member.archivedByGoal;
        }

        item.archived = archived;

        if (!archived && item.goalId !== undefined) {
            const goal = (await tx.doc(ProjectsDoc)).goals[item.goalId];

            if (goal !== undefined) {
                goal.archived = false;
            }
        }
    }

    /** Projects owns validation and placement; this synchronizes durable group organization in the same commit. */
    async organization(tx: Tx): Promise<void> {
        const sessions = await tx.doc(SessionsDoc);
        const doc = await tx.doc(HandoffsDoc);

        for (const item of Object.values(doc.workItems)) {
            const origin = sessions.items[String(item.originThreadId)];

            if (origin === undefined) {
                continue;
            }

            item.title = origin.title ?? item.title;
            item.archived = origin.archived === true;

            for (const field of ["projectId", "goalId"] as const) {
                if (origin[field] === undefined) {
                    delete item[field];
                } else {
                    item[field] = origin[field];
                }
            }
        }
    }

    members(id: ConversationId): ConversationId[] {
        const meta = this.#app.sessionMeta(id);
        const item =
            meta?.workItemId === undefined ? undefined : this.#doc.workItems[meta.workItemId];

        return item === undefined ? [id] : item.threadIds.map((member) => member as ConversationId);
    }
}
