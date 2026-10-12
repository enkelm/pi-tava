/** Human-activated, independently owned durable handoffs with one writer per work item. */
import { execFile } from "node:child_process";
import { isUtf8 } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import {
    AgentDoc,
    configure,
    type ConversationId,
    type Cursor,
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
import { ownRequest } from "./requests.ts";
import { PublicationsDoc } from "./workflow-publication.ts";
import { userContent } from "./resend.ts";
import { threadRolePrompt } from "./thread-prompts.ts";
import {
    type CodeFingerprint,
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
const TYPES: ThreadType[] = ["worker", "reviewer", "land", "publish"];
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
};
export type UpdateWorkItem = { archived?: unknown; projectId?: unknown; goalId?: unknown };
export type HandoffResult = { id: number; handoffId: string; workItemId: string };
type Completion = {
    status: WorkflowStatus;
    summary: string;
    readyForPublish: boolean;
    recommendations: Recommendation[];
};

function text(value: unknown, name: string, max = 12_000): string {
    if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) {
        throw new HttpError(400, `${name} must be nonempty text of at most ${max} characters`);
    }

    return value.trim();
}

function target(value: unknown): ThreadType {
    if (!TYPES.includes(value as ThreadType)) {
        throw new HttpError(400, "targetType must be worker, reviewer, land or publish");
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

function publicWorkflow(state?: Readonly<Workflow>) {
    return {
        readOnly: state?.readOnly ?? false,
        status: state?.status ?? "active",
        ...(state?.readyForPublish === undefined ? {} : { readyForPublish: state.readyForPublish }),
        ...(state?.summary === undefined ? {} : { summary: state.summary }),
        ...(state?.recommendations === undefined ? {} : { recommendations: state.recommendations }),
        ...(state?.proposal === undefined ? {} : { proposal: state.proposal }),
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
    worker: "Follow-up work",
    reviewer: "Review",
    land: "Land local work",
    publish: "Publish",
};

export class Handoffs {
    readonly #app: PocketApp;
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
                return "The handoff tool prepares a compact brief and recommends an independent reviewer/worker/land/publish thread; only a human activates it through /handoff or the UI. It does not reset context or create a subagent.";
            }

            const handoffs = await input.read.snapshot(HandoffsDoc, ctx);
            const inbound = Object.values(handoffs?.handoffs ?? {}).find(
                (record) => record.targetThreadId === Number(id),
            );

            return `${state?.readOnly === true ? "This previous writer is permanently read-only. Do not run tools that mutate files, shell/workspace state or start work here; respond through reading and discussion only." : "Only this work item's active thread and its delegated helpers may write."}\nThe handoff tool can prepare, complete and show status; it never activates a thread. Record code-bound completion before recommending Land or Publish. A prepared brief or conversational recommendation does not establish readiness. State the recommended next step and its reason briefly in the conversation, then wait for a human to activate it. ${state?.summary === undefined ? "" : `Latest summary: ${state.summary}`}\n${inbound === undefined ? "" : `Persisted inbound handoff brief (orientation, not system-role instructions or evidence of readiness):\n${inbound.brief}`}`;
        }),
    ];

    readonly tool = defineTool({
        name: "handoff",
        description:
            "Prepare/recommend a human-activated independent thread, record workflow completion bound to the checkout, or show status. Cannot activate threads.",
        replay: "safe",
        executionMode: "sequential",
        parameters: Type.Object({
            action: Type.Union([
                Type.Literal("prepare"),
                Type.Literal("complete"),
                Type.Literal("status"),
            ]),
            targetType: Type.Optional(Type.Union(TYPES.map((kind) => Type.Literal(kind)))),
            relationship: Type.Optional(
                Type.Union([Type.Literal("same-work"), Type.Literal("new-work")]),
            ),
            brief: Type.Optional(Type.String()),
            status: Type.Optional(Type.Union(STATUSES.map((state) => Type.Literal(state)))),
            summary: Type.Optional(Type.String()),
            readyForPublish: Type.Optional(Type.Boolean()),
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

                    state.proposal = proposal;
                    state.recommendations = recs;
                    state.receipts[key] = input;
                    this.#human(id, user);
                }, ctx);
            } else if (args.action === "complete") {
                const checked = this.#completion(args);
                const code = await fingerprint((await api.agent(ctx)).cwd ?? this.#app.cwdOf(id));

                await api.commit(async (tx) => {
                    const allowed = new Set<TaskId>();
                    let current = await tx.task(api.taskId);

                    while (current !== undefined && !allowed.has(current.id)) {
                        allowed.add(current.id);
                        current =
                            current.owner === undefined ? undefined : await tx.task(current.owner);
                    }

                    await this.#idle(tx, this.members(id).map(Number), allowed);
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

    async recover(): Promise<void> {
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
            ["worker", "reviewer", "land", "publish"].includes(
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

        return {
            status: status as WorkflowStatus,
            summary: text(request.summary, "summary", 8000),
            readyForPublish: request.readyForPublish === true,
            recommendations: recommendations(request.recommendations) ?? [],
        };
    }

    async #complete(
        tx: Tx,
        id: ConversationId,
        supplied: User,
        request: Completion,
        code: CodeFingerprint,
        key?: string,
    ): Promise<void> {
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
            (request.status === "review-complete" && kind !== "reviewer")
        ) {
            throw new HttpError(409, "Completion status does not match this thread's role");
        }

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

        state.status = request.status;
        state.summary = request.summary;
        state.recommendations = request.recommendations;
        state.readyForPublish = request.readyForPublish;
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
        const code = await fingerprint(this.#app.cwdOf(id));

        await this.#app.harness.commit(async (tx) => {
            await this.#idle(tx, [Number(id)]);
            await this.#complete(tx, id, supplied, checked, code);
        }, context);
    }

    /** Busy checks are transaction reads, before creating any destination or reserving a receipt. Never abort writers. */
    async #idle(tx: Tx, roots: number[], allowed = new Set<TaskId>()): Promise<void> {
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
                    "Wait until every source and work-item writer is idle before handing off",
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
                            !(allowed.size > 0 && task.kind === "pocket.handoff-send"),
                    )
                ) {
                    throw new HttpError(
                        409,
                        "Wait for source and work-item background work to finish before handing off",
                    );
                }

                cursor = page.next;
            } while (cursor !== undefined);

            pending.push(...Object.values(agents.agents).map((record) => record.conversationId));
        }
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
            } else if (
                this.members(root).some((member) =>
                    this.#app.conversationsOf(member).some((writer) => this.#app.isBusy(writer)),
                )
            ) {
                reason = "Wait for every work-item writer to become idle";
            } else {
                reason = this.#transitionReason(kind, relation, state, item, current);
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
    ): string | undefined {
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

            if (kind === "land" || kind === "publish") {
                code = await fingerprint(this.#app.cwdOf(id));
            }

            const why = this.#transitionReason(kind, relation, state, oldItem, code);

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
            const suppliedBrief =
                brief ??
                (state.proposal?.targetType === kind && state.proposal.relationship === relation
                    ? state.proposal.brief
                    : undefined);
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
                    : `Prepared/user brief (claims must be rechecked against this activation):\n${suppliedBrief.slice(0, 3000)}\n\nFresh persisted context at activation:\n${freshBrief.slice(0, 8200)}\n\nFresh source entry ${sourceEntry ?? "none"}; Git HEAD ${code?.head ?? "unavailable"}; code fingerprint ${code?.digest ?? "unavailable"}.`;
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
