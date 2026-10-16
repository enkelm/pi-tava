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
    type TaskRuntime,
    UsageDoc,
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
import { addUsage, cleanTitle, titleModel, TITLE_PROMPT } from "./titles.ts";
import { withWorkflowPublicationLock, workflowExclusiveReason } from "./workflow-policy.ts";
import {
    type CodeFingerprint,
    type ExternalReview,
    type HandoffsData,
    type Handoff,
    HandoffsDoc,
    type Recommendation,
    type ReviewAssessment,
    type Relationship,
    type ThreadType,
    type Workflow,
    WorkflowDoc,
    type WorkflowStatus,
    type WorkItem,
} from "./workflow-docs.ts";

const context = BACKGROUND_CONTEXT;
const run = promisify(execFile);
const TYPES: ThreadType[] = [
    "chat",
    "researcher",
    "worker",
    "reviewer",
    "follow-up",
    "pull",
    "land",
    "publish",
];
const STATUSES: WorkflowStatus[] = ["review-complete", "landed", "published", "needs-review"];
const finished = { status: "terminal", outcome: { status: "completed", result: null } } as const;
const empty = (): HandoffsData => ({ workItems: {}, handoffs: {}, requests: {} });
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export type StartHandoff = {
    targetType?: unknown;
    relationship?: unknown;
    brief?: unknown;
    requestId?: unknown;
    /** Reconnect recovery must observe failures, never autonomously rerun a failed summary. */
    recoverOnly?: unknown;
};
export type CompleteHandoff = {
    status?: unknown;
    summary?: unknown;
    readyForPublish?: unknown;
    recommendations?: unknown;
    reviewApplicability?: unknown;
    reviewAssessment?: unknown;
};
/** Only the authenticated HTTP action records acceptance; never a model tool or parsed message. */
export type AcceptValidation = { checkpoint?: unknown; assessment?: unknown };
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
type HandoffAdmission = {
    kind: ThreadType;
    relation: Relationship;
    brief: string | undefined;
    key: string;
    input: string;
};
type Completion = {
    status: WorkflowStatus;
    summary: string;
    readyForPublish: boolean;
    recommendations: Recommendation[];
    reviewApplicability?: "preserved" | "invalidated";
    reviewAssessment?: ReviewAssessment;
};

function text(value: unknown, name: string, max = 12_000): string {
    if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) {
        throw new HttpError(400, `${name} must be nonempty text of at most ${max} characters`);
    }

    return value.trim();
}

function target(value: unknown): ThreadType {
    if (!TYPES.includes(value as ThreadType)) {
        throw new HttpError(
            400,
            "Choose chat, researcher, worker, reviewer, follow-up, pull, land or publish",
        );
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

        ...(state?.externalReview === undefined
            ? {}
            : { externalReview: publicExternalReview(state.externalReview) }),
        ...(state?.reviewAssessment === undefined
            ? {}
            : { reviewAssessment: state.reviewAssessment }),
        ...(state?.validationAcceptances === undefined
            ? {}
            : { validationAcceptances: state.validationAcceptances }),
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
    researcher: "Focused research",
    worker: "Implementation",
    reviewer: "Review",
    "follow-up": "Follow-up work",
    pull: "Pull upstream",
    land: "Land local work",
    publish: "Publish",
};

const NEXT: Record<ThreadType, ThreadType[]> = {
    chat: ["worker", "researcher"],
    worker: ["reviewer", "researcher"],
    reviewer: ["follow-up", "worker", "land", "researcher"],
    researcher: ["worker", "follow-up"],
    "follow-up": ["land", "worker"],
    pull: ["worker", "researcher", "follow-up"],
    land: ["publish", "worker", "follow-up"],
    publish: [],
};

function flowOptions(current: ThreadType, history: readonly ThreadType[]) {
    const same = new Set([...NEXT[current], "pull" as const]);

    if (history.includes("reviewer")) {
        same.add("land");
    }

    same.delete(current);

    if (!history.some((kind) => kind === "reviewer" || kind === "pull")) {
        same.delete("follow-up");
    }

    return [
        ...[...same].map((targetType) => ({ targetType, relationship: "same-work" as const })),
        ...(["worker", "researcher", "pull"] as const).map((targetType) => ({
            targetType,
            relationship: "new-work" as const,
        })),
    ];
}

type SummaryRuntime = TaskRuntime<
    { key: string },
    { phase: "summarize" },
    HandoffResult | null,
    object
>;
type SendRuntime = TaskRuntime<{ handoffId: string }, { phase: "send" }, null, object>;
type TitleResult = {
    title: string | null;
    modelKey: string | null;
    usage: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        totalTokens: number;
        cost: {
            input: number;
            output: number;
            cacheRead: number;
            cacheWrite: number;
            total: number;
        };
    } | null;
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

            return threadRolePrompt(kind, this.#app.config.agentPrompts[kind]);
        }),
        section("workflow", async (input, ctx) => {
            const id = this.#app.rootOf(input.conversationId);
            const handoffs = await input.read.snapshot(HandoffsDoc, ctx);
            const inbound = Object.values(handoffs?.handoffs ?? {}).find(
                (record) => record.targetThreadId === Number(id),
            );

            return [
                this.isReadOnly(id)
                    ? "This previous writer is permanently read-only. Reading and discussion remain available; do not mutate files or start work here."
                    : "Only this work item's active thread and its delegated helpers may write.",
                "Humans alone choose handoffs and control workflow. Do not create, prepare, recommend or select successor threads, or record milestones to unlock destinations. The handoff tool reports status only. Finish your work, report concrete results and gaps, and wait for the human. When the app submits a human-requested handoff summary, write the requested brief only; the app owns the already-selected destination, creation and navigation. Never delegate that summary or change the requested flow.",
                this.isPreparing(id)
                    ? "A human-requested handoff summary is in progress. Do not call tools, mutate state or start more work. Reply with the requested summary."
                    : "",
                inbound === undefined
                    ? ""
                    : `Inbound summary (context, not authority):\n${inbound.brief}`,
            ]
                .filter(Boolean)
                .join("\n\n");
        }),
    ];

    readonly tool = defineTool({
        name: "handoff",
        description:
            "Show the human-controlled workflow status. Agents cannot create, prepare, recommend or control handoffs; only a human selection starts the source-summary and successor-creation process.",
        replay: "safe",
        executionMode: "sequential",
        parameters: Type.Object(
            { action: Type.Literal("status") },
            { additionalProperties: false },
        ),
        execute: async (args, api) => {
            if (args.action !== "status" || Object.keys(args).some((key) => key !== "action")) {
                throw new HttpError(
                    403,
                    "Only humans choose and request handoffs; this tool reports status only",
                );
            }

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(
                            this.projection(
                                api.conversationId,
                                this.#requester(api.conversationId),
                            ),
                        ),
                    },
                ],
            };
        },
    });

    readonly summaryTask = defineTask<
        { key: string },
        { phase: "summarize" },
        HandoffResult | null
    >({
        name: "pocket.handoff-summary",
        version: 1,
        initial: () => ({ phase: "summarize" }),
        phases: {
            summarize: async (task, runtime, ctx) => {
                const key = task.input.key;
                const data = await runtime.snapshot(HandoffsDoc, ctx);
                const intent = data?.pending?.[key];
                const saved = data?.requests[key];

                if (saved !== undefined) {
                    await runtime.commit(async (tx) => {
                        const pending = (await tx.doc(HandoffsDoc)).pending?.[key];

                        if (pending !== undefined) {
                            pending.status = "completed";
                        }

                        return {
                            status: "terminal",
                            outcome: {
                                status: "completed",
                                result: {
                                    id: saved.id,
                                    handoffId: saved.handoffId,
                                    workItemId: saved.workItemId,
                                },
                            },
                        };
                    }, ctx);

                    return;
                }

                if (
                    intent === undefined ||
                    intent.taskId !== Number(runtime.taskId) ||
                    intent.status !== "pending"
                ) {
                    await runtime.commit(
                        () => ({
                            status: "terminal",
                            outcome: { status: "completed", result: null },
                        }),
                        ctx,
                    );

                    return;
                }

                try {
                    const id = runtime.conversationId;
                    const user = this.#app.config.userById(intent.requestedBy);

                    if (user === undefined) {
                        throw new HttpError(401, "Requester's access was removed");
                    }

                    this.#human(id, user);
                    this.#app.spend.check(user, id);
                    const conversation = await runtime.conversation(id, ctx);

                    if (conversation === undefined) {
                        throw new Error("The source thread no longer exists");
                    }

                    const submission = await conversation.submit(
                        {
                            type: "input",
                            content: this.#app.commands.messageText(
                                user,
                                [
                                    `The human has requested a ${intent.relationship} handoff to ${intent.targetType}. The destination is already chosen; do not recommend, choose or create any thread.`,
                                    "Write only a compact handoff summary for that destination (at most 12,000 characters). Include the original ask, current direction/decisions, relevant code/files and checkpoint, changes made, actual checks/results, blockers, deferred checks, remaining risks and mutation limits. If this starts a new Work Item, clearly separate its requested scope from unfinished prior work. Do not call tools, delegate work, change files or record completion. The app will create the selected successor after your reply.",
                                    ...(intent.brief === undefined
                                        ? []
                                        : [`Human handoff context:\n${intent.brief}`]),
                                ].join("\n\n"),
                            ),
                            requestId: ownRequest(
                                user.id,
                                `handoff-summary:${key}:${intent.attempt}`,
                            ),
                            whenBusy: "followUp",
                        },
                        ctx,
                    );
                    const answered = await submission.wait(ctx);

                    if (answered.type !== "input" || answered.status !== "done") {
                        throw new HttpError(
                            409,
                            "The source summary was stopped or failed; no successor was created",
                        );
                    }

                    await conversation.waitForIdle(ctx);
                    const entry = await runtime.entry(answered.answer, ctx);
                    const response = entry?.model?.[0];

                    if (response?.role !== "assistant" || response.stopReason !== "stop") {
                        throw new HttpError(
                            409,
                            "The source did not finish a successful handoff summary; no successor was created",
                        );
                    }

                    const brief = text(userContent(response).text, "handoff summary");
                    const result = await withWorkflowPublicationLock(this.#app, id, () =>
                        this.#start(
                            id,
                            user,
                            {
                                kind: intent.targetType,
                                relation: intent.relationship,
                                key,
                                input: intent.input,
                                brief,
                            },
                            runtime,
                            ctx,
                        ),
                    );

                    await runtime.commit(async (tx) => {
                        const pending = (await tx.doc(HandoffsDoc)).pending?.[key];

                        if (pending !== undefined) {
                            pending.status = "completed";
                        }

                        return { status: "terminal", outcome: { status: "completed", result } };
                    }, ctx);
                } catch (error) {
                    if (runtime.signal.aborted) {
                        throw error;
                    }

                    const reason =
                        error instanceof Error ? error.message : "The handoff summary failed";

                    await runtime.commit(async (tx) => {
                        const doc = await tx.doc(HandoffsDoc);
                        const pending = doc.pending?.[key];
                        const saved = doc.requests[key];

                        if (saved !== undefined) {
                            if (pending !== undefined) {
                                pending.status = "completed";
                            }

                            return {
                                status: "terminal",
                                outcome: {
                                    status: "completed",
                                    result: {
                                        id: saved.id,
                                        handoffId: saved.handoffId,
                                        workItemId: saved.workItemId,
                                    },
                                },
                            };
                        }

                        if (pending?.taskId === Number(runtime.taskId)) {
                            pending.status = "blocked";
                            pending.reason = reason.slice(0, 1000);
                        }

                        return {
                            status: "terminal",
                            outcome: { status: "failed", error: { message: reason } },
                        };
                    }, ctx);
                }
            },
        },
        abort: async (task, runtime, ctx) => {
            const intent = (await runtime.snapshot(HandoffsDoc, ctx))?.pending?.[task.input.key];

            if (intent?.taskId === Number(runtime.taskId) && intent.status === "pending") {
                // The summary input is the only admitted work while this request holds the source.
                const conversation = await runtime.conversation(runtime.conversationId, ctx);

                await conversation?.abort(ctx);
            }

            await runtime.commit(async (tx) => {
                const doc = await tx.doc(HandoffsDoc);
                const pending = doc.pending?.[task.input.key];
                const saved = doc.requests[task.input.key];

                // Cancellation cannot undo an atomic activation or report it as an uncreated successor.
                if (saved !== undefined) {
                    if (pending !== undefined) {
                        pending.status = "completed";
                    }

                    return {
                        status: "terminal",
                        outcome: {
                            status: "completed",
                            result: {
                                id: saved.id,
                                handoffId: saved.handoffId,
                                workItemId: saved.workItemId,
                            },
                        },
                    };
                }

                if (pending?.taskId === Number(runtime.taskId)) {
                    pending.status = "blocked";
                    pending.reason =
                        "The human-requested handoff was stopped; no successor was created";
                }

                return { status: "terminal", outcome: { status: "aborted" } };
            }, ctx);
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

                    await this.#nameThread(record, runtime, ctx);
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

    /** Destination-owned naming uses the received summary, preserves manual renames and bills once. */
    async #nameThread(
        record: Readonly<Handoff>,
        runtime: SendRuntime,
        ctx: Context,
    ): Promise<void> {
        if (record.titleNamed === true) {
            return;
        }

        const id = runtime.conversationId;
        let named = await runtime.memo<TitleResult>("handoff-title", ctx);

        if (named === undefined) {
            const agent = await runtime.agent(ctx);
            const current =
                agent.model === undefined
                    ? undefined
                    : this.#app.models.getModel(agent.model.provider, agent.model.modelId);
            let candidate: TitleResult = {
                title:
                    cleanTitle(
                        record.brief
                            .split("\n")
                            .slice(1)
                            .find((line) => line.trim()) ?? "",
                    ) ?? null,
                modelKey: null,
                usage: null,
            };

            if (
                current !== undefined &&
                this.#app.spend.heldBack(id) === undefined &&
                this.#app.sessionMeta(id)?.title === TITLES[record.targetType]
            ) {
                try {
                    const model = titleModel(this.#app.models.getAvailableSnapshot(), current);
                    const reply = await this.#app.models.completeSimple(
                        model,
                        {
                            messages: [
                                {
                                    role: "user",
                                    content: [
                                        {
                                            type: "text",
                                            text: `${TITLE_PROMPT}\n\n<message>\n${record.brief.slice(0, 3000)}\n</message>`,
                                        },
                                    ],
                                    timestamp: Date.now(),
                                },
                            ],
                        },
                        { maxTokens: 256, signal: runtime.signal },
                    );

                    candidate = {
                        title:
                            reply.stopReason === "error"
                                ? candidate.title
                                : (cleanTitle(
                                      reply.content
                                          .flatMap((part) =>
                                              part.type === "text" ? [part.text] : [],
                                          )
                                          .join(""),
                                  ) ?? candidate.title),
                        modelKey: `${model.provider}/${model.id}`,
                        usage: reply.usage,
                    };
                } catch (error) {
                    if (runtime.signal.aborted) {
                        throw error;
                    }

                    runtime.report(error);
                }
            }

            named = await runtime.memo("handoff-title", candidate, ctx);
        }

        const result = named;

        await runtime.commit(async (tx) => {
            const doc = await tx.doc(HandoffsDoc);
            const saved = doc.handoffs[record.id];
            const sessions = await tx.doc(SessionsDoc);
            const meta = sessions.items[String(id)];

            if (saved === undefined || saved.titleNamed === true) {
                return;
            }

            if (result.usage !== null && result.modelKey !== null) {
                const ledger = await tx.doc(UsageDoc, id);

                ledger.models[result.modelKey] ??= {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 0,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                };
                addUsage(ledger.models[result.modelKey]!, result.usage);
            }

            if (meta?.title === TITLES[record.targetType] && result.title !== null) {
                meta.title = result.title;
                const item = doc.workItems[record.workItemId];

                if (
                    item?.originThreadId === Number(id) &&
                    item.title === TITLES[record.targetType]
                ) {
                    item.title = result.title;
                }
            }

            saved.titleNamed = true;

            return undefined;
        }, ctx);
    }

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
            this.isPreparing(root) ||
            this.#app.sessionMeta(root)?.workItemId !== undefined ||
            ["researcher", "worker", "reviewer", "follow-up", "pull", "land", "publish"].includes(
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

    isPreparing(id: ConversationId): boolean {
        return Object.values(this.#doc.pending ?? {}).some(
            (request) =>
                request.sourceThreadId === Number(this.#app.rootOf(id)) &&
                request.status === "pending",
        );
    }

    /** Stop also cancels a summary task that has not yet placed its foreground model input. */
    async abortSummary(id: ConversationId, supplied: User): Promise<void> {
        this.#human(id, supplied);
        const pending = Object.values(this.#doc.pending ?? {}).filter(
            (request) => request.sourceThreadId === Number(id) && request.status === "pending",
        );

        await Promise.all(
            pending.map((request) =>
                this.#app.harness.abortTask(request.taskId as TaskId, context),
            ),
        );
    }

    requireWritable(id: ConversationId): void {
        if (this.isPreparing(id)) {
            throw new HttpError(
                409,
                "A human-requested handoff summary is in progress; wait for it to settle",
            );
        }

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
                preparing: this.isPreparing(root),
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
            !["chat", "worker", "researcher", "pull", "follow-up"].includes(
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
                    /^u:[^:]+:handoff(?:-summary)?:/.test(submission.requestId ?? "") ||
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
            /^u:[^:]+:handoff(?:-summary)?:/.test(submission.requestId ?? "") ||
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
        delete state.reviewAssessment;
        delete state.reviewAssessmentId;
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

        let reviewAssessment: ReviewAssessment | undefined;

        if (request.reviewAssessment !== undefined) {
            const assessment = request.reviewAssessment as Partial<ReviewAssessment> | null;

            if (
                assessment === null ||
                typeof assessment !== "object" ||
                !["clear", "blocked"].includes(assessment.outcome ?? "") ||
                !Array.isArray(assessment.validationGaps) ||
                assessment.validationGaps.length > 20
            ) {
                throw new HttpError(
                    400,
                    "reviewAssessment needs outcome clear/blocked and at most 20 named validationGaps",
                );
            }

            reviewAssessment = {
                outcome: assessment.outcome!,
                validationGaps: assessment.validationGaps.map((gap) =>
                    text(gap, "validation gap", 1000),
                ),
            };

            if (
                (status !== "needs-review" && status !== "review-complete") ||
                (status === "review-complete" &&
                    (reviewAssessment.outcome !== "clear" ||
                        reviewAssessment.validationGaps.length > 0)) ||
                (status === "needs-review" &&
                    reviewAssessment.outcome === "clear" &&
                    reviewAssessment.validationGaps.length === 0) ||
                (request.reviewApplicability === "invalidated" &&
                    reviewAssessment.outcome === "clear")
            ) {
                throw new HttpError(
                    409,
                    "Clear review with validation gaps requires needs-review; blocked or invalidated review cannot claim readiness",
                );
            }
        }

        return {
            status: status as WorkflowStatus,
            summary: text(request.summary, "summary", 8000),
            readyForPublish: request.readyForPublish === true,
            reviewApplicability: request.reviewApplicability,
            reviewAssessment,
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
                            meta?.threadType !== "researcher" &&
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

            if (meta?.threadType !== "researcher" && meta?.threadType !== "follow-up") {
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
        // New reports invalidate earlier acceptance even when fingerprint inspection subsequently fails.
        delete state.reviewAssessment;
        delete state.reviewAssessmentId;

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
            (request.reviewApplicability !== undefined || request.reviewAssessment !== undefined) &&
            !["reviewer", "follow-up"].includes(kind)
        ) {
            throw new HttpError(409, "Only review or repair threads assess review applicability");
        }

        // A replay of an already-recorded outcome must not revoke a newer milestone or fresh review.
        if (key !== undefined && this.#receipt(state, key, digest(request))) {
            return { user, state, group };
        }

        if (
            (request.status === "review-complete" ||
                request.reviewAssessment?.outcome === "clear") &&
            state.reviewApplicability === "invalidated"
        ) {
            throw new HttpError(
                409,
                "Material changes require fresh independent review, not a new self-attestation",
            );
        }

        if (request.status === "review-complete" || request.reviewAssessment?.outcome === "clear") {
            const reason = await this.#reviewProvenanceReason(tx, id);

            if (reason !== undefined) {
                throw new HttpError(409, reason);
            }
        }

        // Every new admitted report retires the current acceptance identity before inspection,
        // including a replacement review-complete attempt whose inspection may subsequently fail.
        delete state.reviewAssessment;
        delete state.reviewAssessmentId;

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
        state.reviewAssessment = request.reviewAssessment;
        state.reviewAssessmentId =
            request.reviewAssessment === undefined ? undefined : randomUUID();
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

    async #hasDiff(id: ConversationId, user: User): Promise<boolean> {
        const changes = await this.#app.workspace.changes(id, user);

        // piOnly is historical tool activity (including files already committed), not a current diff.
        return changes.files.length > 0;
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
        const current = meta?.threadType ?? "worker";
        const history = (item?.threadIds ?? [Number(root)]).map(
            (member) => this.#app.sessionMeta(member as ConversationId)?.threadType ?? "worker",
        );
        let choices = flowOptions(current, history);
        let diffReason: string | undefined;

        let busyReason = workflowExclusiveReason(this.#app, root);

        try {
            await this.#app.harness.commit((tx) => this.requireIdle(tx, root), context);
        } catch (error) {
            if (!(error instanceof HttpError)) {
                throw error;
            }

            busyReason ??= error.message;
        }

        if (this.isPreparing(root)) {
            busyReason = "Preparing the human-requested handoff summary";
        }

        if (choices.some((choice) => choice.targetType === "reviewer")) {
            let hasDiff = false;

            // Do not inspect a changing checkout, a retired writer, or a caller who cannot steer.
            if (
                busyReason === undefined &&
                root === id &&
                !this.isReadOnly(root) &&
                user.role !== "viewer"
            ) {
                try {
                    hasDiff = await this.#hasDiff(root, user);
                    diffReason = hasDiff
                        ? undefined
                        : "Reviewer requires a nonempty current Pi diff.";
                } catch {
                    diffReason =
                        "Review is unavailable because the current Pi diff could not be read.";
                }
            }

            if (!hasDiff) {
                choices = choices.filter((choice) => choice.targetType !== "reviewer");
            }
        }

        const options = choices.map((choice) => {
            let reason: string | undefined;

            if (user.role === "viewer") {
                reason = "Steering rights are required";
            } else if (choice.relationship === "new-work" && user.sessions !== undefined) {
                reason = "People invited to particular sessions cannot start new work";
            } else if (root !== id || this.isReadOnly(root)) {
                reason = "Continue from the active main thread";
            } else if (meta?.archived === true || item?.archived === true) {
                reason = "Restore the work item first";
            } else if (
                item?.threadIds.some((member) => !this.#app.canSee(user, member as ConversationId))
            ) {
                reason = "Every work-item member must be visible to activate a handoff";
            } else {
                reason = busyReason;
            }

            return {
                ...choice,
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
            ...(diffReason === undefined ? {} : { diffReason }),
        };
    }

    /** An offer is an exact completed assessment, never inferred from a summary or failed check text. */
    #validationOffer(state?: Readonly<Workflow>, code?: CodeFingerprint) {
        if (
            state?.status !== "needs-review" ||
            state.reviewApplicability === "invalidated" ||
            state.reviewAssessment?.outcome !== "clear" ||
            state.reviewAssessmentId === undefined ||
            state.reviewAssessment.validationGaps.length === 0 ||
            state.completedAt === undefined ||
            state.completedBy === undefined ||
            code === undefined ||
            state.fingerprint?.digest !== code.digest
        ) {
            return undefined;
        }

        return {
            checkpoint: code.digest,
            assessment: digest([
                state.reviewAssessmentId,
                state.fingerprint,
                state.completedAt,
                state.completedBy,
                state.summary,
                state.reviewAssessment,
            ]),
            gaps: state.reviewAssessment.validationGaps,
        };
    }

    #acceptedValidation(state?: Readonly<Workflow>, code?: CodeFingerprint) {
        const offer = this.#validationOffer(state, code);

        return offer === undefined
            ? undefined
            : state?.validationAcceptances?.findLast(
                  (each) =>
                      each.checkpoint === offer.checkpoint && each.assessment === offer.assessment,
              );
    }

    async #validationState(tx: Tx, id: ConversationId, supplied: User) {
        const user = this.#human(id, supplied);

        this.requireWritable(id);
        const state = await tx.doc(WorkflowDoc, id);
        const sessions = await tx.doc(SessionsDoc);
        const turns = await tx.doc(TurnsDoc, id);
        const doc = await tx.doc(HandoffsDoc);
        const meta = sessions.items[String(id)];
        const item = meta?.workItemId === undefined ? undefined : doc.workItems[meta.workItemId];

        this.#writable(state);

        if (
            id !== this.#app.rootOf(id) ||
            !["reviewer", "follow-up"].includes(meta?.threadType ?? "") ||
            meta?.archived ||
            item?.archived ||
            (item !== undefined && item.activeThreadId !== Number(id))
        ) {
            throw new HttpError(
                409,
                "Accept validation only in the active review or Follow-up main thread",
            );
        }

        if (turns.on && turns.driver !== user.id) {
            throw new HttpError(409, "Take the wheel before accepting validation risk");
        }

        if (item !== undefined) {
            this.#requireMembers(item, user);
        }

        await this.requireIdle(tx, id);
        await this.#requireResolvedPublications(tx, item?.threadIds ?? [Number(id)]);
        const reason = await this.#reviewProvenanceReason(tx, id);

        if (reason !== undefined) {
            throw new HttpError(409, reason);
        }

        return { state, user };
    }

    /** Human HTTP action only. There is deliberately no tool action or message-intake equivalent. */
    async acceptValidation(
        id: ConversationId,
        supplied: User,
        request: AcceptValidation,
    ): Promise<void> {
        this.#human(id, supplied);
        this.requireWritable(id);
        await this.#app.requireDriver(id, supplied);
        const checkpoint = text(request.checkpoint, "checkpoint", 64);
        const assessment = text(request.assessment, "assessment", 64);

        await withWorkflowPublicationLock(this.#app, id, async () => {
            await this.#app.harness.commit(async (tx) => {
                await this.#validationState(tx, id, supplied);
            }, context);
            const code = await fingerprint(this.#app.cwdOf(id));

            await this.#app.harness.commit(async (tx) => {
                const { state, user } = await this.#validationState(tx, id, supplied);
                const offer = this.#validationOffer(state, code);

                if (offer?.checkpoint !== checkpoint || offer.assessment !== assessment) {
                    throw new HttpError(
                        409,
                        "Validation assessment or checkpoint changed; refresh the named risks before accepting",
                    );
                }

                if (
                    this.#app.cwdOf(id) !== code.cwd ||
                    (await fingerprint(code.cwd)).digest !== code.digest
                ) {
                    throw new HttpError(409, "Checkout changed while accepting validation risk");
                }

                if (this.#acceptedValidation(state, code) === undefined) {
                    // Assignments store a clone; read back the draft before appending to a new ledger.
                    state.validationAcceptances ??= [];
                    const ledger = state.validationAcceptances;

                    if (ledger.length >= 100) {
                        throw new HttpError(413, "Validation acceptance history limit reached");
                    }

                    ledger.push({
                        threadId: Number(id),
                        checkpoint,
                        assessment,
                        gaps: [...offer.gaps],
                        acceptedBy: user.id,
                        acceptedAt: Date.now(),
                    });
                }

                this.#human(id, supplied);
            }, context);
        });
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

    /** Role history, rather than agent-authored milestones, determines which paths exist. */
    #transitionReason(
        kind: ThreadType,
        relation: Relationship,
        current: ThreadType,
        history: ThreadType[],
    ) {
        return flowOptions(current, history).some(
            (option) => option.targetType === kind && option.relationship === relation,
        )
            ? undefined
            : "This handoff is not available from the current thread state";
    }

    async #admit(
        tx: Tx,
        id: ConversationId,
        supplied: User,
        kind: ThreadType,
        relation: Relationship,
        allowed = new Set<TaskId>(),
    ) {
        const user = this.#human(id, supplied);
        const doc = await tx.doc(HandoffsDoc);
        const sessions = await tx.doc(SessionsDoc);
        const meta = sessions.items[String(id)];
        const state = await tx.doc(WorkflowDoc, id);
        const turns = await tx.doc(TurnsDoc, id);
        const item = meta?.workItemId === undefined ? undefined : doc.workItems[meta.workItemId];

        if (meta === undefined) {
            throw new HttpError(404, "Not a session");
        }

        this.#writable(state);

        if (relation === "new-work" && user.sessions !== undefined) {
            throw new HttpError(
                403,
                "You were invited to particular sessions and cannot start new work",
            );
        }

        if (item !== undefined && item.activeThreadId !== Number(id)) {
            throw new HttpError(409, "Only the active work-item thread can hand off");
        }

        if (turns.on && turns.driver !== user.id) {
            throw new HttpError(409, "Take the wheel before starting a handoff");
        }

        if (meta.archived === true || item?.archived === true) {
            throw new HttpError(409, "Restore the work item first");
        }

        if (item !== undefined) {
            this.#requireMembers(item, user);
        }

        const history = (item?.threadIds ?? [Number(id)]).map(
            (member) => sessions.items[String(member)]?.threadType ?? "worker",
        );
        const reason = this.#transitionReason(kind, relation, meta.threadType ?? "worker", history);

        if (reason !== undefined) {
            throw new HttpError(409, reason);
        }

        await this.#requireResolvedPublications(tx, item?.threadIds ?? [Number(id)]);
        await this.#idle(tx, item?.threadIds ?? [Number(id)], allowed, false);

        return { user, doc, sessions, meta, state, item };
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
            ...(this.#acceptedValidation(state, code) === undefined
                ? []
                : [
                      `Human validation-risk acceptance (not passing checks): ${JSON.stringify(this.#acceptedValidation(state, code))}. This permits entry to local Land only, for this checkpoint; integration drift needs a fresh assessment. It does not authorize publication.`,
                  ]),
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

        if (request.recoverOnly !== undefined && typeof request.recoverOnly !== "boolean") {
            throw new HttpError(400, "recoverOnly must be a boolean");
        }

        if (id !== this.#app.rootOf(id)) {
            throw new HttpError(403, "Start a handoff from the main thread, not its subagent");
        }

        // Recover an already-created successor even after the predecessor is retired or its checkout is gone.
        if (this.#doc.requests[key] !== undefined) {
            return this.#app.harness.commit(async (tx) => {
                this.#human(id, supplied);
                const doc = await tx.doc(HandoffsDoc);
                const saved = doc.requests[key]!;

                if (saved.input !== input) {
                    throw new HttpError(409, "This requestId already started a different handoff");
                }

                this.#app.requireSee(user, saved.id as ConversationId);

                if (request.recoverOnly !== true) {
                    await this.#retryDelivery(tx, doc, saved);
                }

                return { id: saved.id, handoffId: saved.handoffId, workItemId: saved.workItemId };
            }, context);
        }

        const taskId = await withWorkflowPublicationLock(this.#app, id, async () => {
            await this.#app.requireDriver(id, user);
            const existing = this.#doc.pending?.[key];

            if (existing !== undefined && existing.input !== input) {
                throw new HttpError(409, "This requestId already requested a different handoff");
            }

            if (existing?.status === "pending") {
                const task = await this.#app.harness.getTask(existing.taskId as TaskId, context);

                if (task !== undefined && task.state.status !== "terminal") {
                    return existing.taskId as TaskId<HandoffResult | null>;
                }

                await this.#app.harness.commit(async (tx) => {
                    const pending = (await tx.doc(HandoffsDoc)).pending?.[key];

                    if (pending?.status === "pending") {
                        pending.status = "blocked";
                        pending.reason =
                            "The previous handoff summary did not complete; a human may explicitly retry";
                    }
                }, context);
            }

            if (request.recoverOnly === true) {
                throw new HttpError(
                    409,
                    this.#doc.pending?.[key]?.reason ??
                        (existing === undefined
                            ? "No saved handoff request exists; a human may explicitly start it"
                            : "The handoff summary failed; choose whether to retry"),
                );
            }

            if (kind === "reviewer" && !(await this.#hasDiff(id, user))) {
                throw new HttpError(409, "There is no current Pi diff to review");
            }

            return this.#app.harness.commit(async (tx) => {
                const { doc } = await this.#admit(tx, id, user, kind, relation);
                const pending = Object.entries(doc.pending ?? {}).find(
                    ([, value]) =>
                        value.sourceThreadId === Number(id) && value.status === "pending",
                );

                if (pending !== undefined && pending[0] !== key) {
                    throw new HttpError(
                        409,
                        "Another human-requested handoff summary is in progress",
                    );
                }

                if (
                    doc.pending?.[key] === undefined &&
                    new Set([...Object.keys(doc.requests), ...Object.keys(doc.pending ?? {})])
                        .size >= 10_000
                ) {
                    throw new HttpError(413, "The handoff request limit was reached");
                }

                const attempt = (doc.pending?.[key]?.attempt ?? -1) + 1;
                const taskId = await tx.createTask(
                    this.summaryTask,
                    { key },
                    {
                        conversationId: id,
                        ownership: { kind: "conversation" },
                        background: true,
                    },
                );

                doc.pending ??= {};
                doc.pending[key] = {
                    sourceThreadId: Number(id),
                    targetType: kind,
                    relationship: relation,
                    requestedBy: user.id,
                    input,
                    ...(brief === undefined ? {} : { brief }),
                    taskId: Number(taskId),
                    attempt,
                    status: "pending",
                };

                return taskId;
            }, context);
        });
        const settled = await this.#app.harness.waitForTask(taskId, context);

        const outcome = settled.state.outcome;

        if (outcome?.status !== "completed" || outcome.result === null) {
            throw new HttpError(
                409,
                this.#doc.pending?.[key]?.reason ??
                    "The handoff summary did not complete; retry the same request",
            );
        }

        return outcome.result;
    }

    async #start(
        id: ConversationId,
        supplied: User,
        request: HandoffAdmission,
        runtime: SummaryRuntime,
        ctx: Context,
    ): Promise<HandoffResult> {
        const { kind, relation, brief, key, input } = request;
        const user = this.#human(id, supplied);

        await this.#app.requireDriver(id, user);

        if (kind === "reviewer" && !(await this.#hasDiff(id, user))) {
            throw new HttpError(409, "There is no current Pi diff to review");
        }

        let result: HandoffResult | undefined;

        await runtime.commit(async (tx) => {
            const saved = (await tx.doc(HandoffsDoc)).requests[key];

            if (saved !== undefined) {
                result = { id: saved.id, handoffId: saved.handoffId, workItemId: saved.workItemId };

                return;
            }

            const {
                doc,
                sessions,
                meta,
                state,
                item: oldItem,
            } = await this.#admit(tx, id, supplied, kind, relation, new Set([runtime.taskId]));
            const intent = doc.pending?.[key];

            if (
                intent?.taskId !== Number(runtime.taskId) ||
                intent.status !== "pending" ||
                intent.input !== input ||
                intent.requestedBy !== user.id
            ) {
                throw new HttpError(409, "The human's handoff request is no longer current");
            }

            const agent = await tx.doc(AgentDoc, id);
            const cwd = agent.cwd ?? meta.cwd;

            if (cwd !== this.#app.cwdOf(id)) {
                throw new HttpError(409, "Source checkout changed; try again");
            }

            const fresh = await this.#brief(
                tx,
                id,
                (oldItem?.originThreadId ?? Number(id)) as ConversationId,
            );
            const initialBrief = `Human-requested handoff summary:\n${brief}\n\nPersisted source context:\n${fresh.slice(0, 4000)}`;
            const sourceEntry = (
                await tx.scanEntries({ conversationId: id, order: "descending" }, 1)
            ).items[0]?.id;
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

            this.#human(id, supplied);
            this.#app.spend.check(user, id);
            const destination = await tx.createConversation({ ownership: { kind: "ownerless" } });
            const targetId = destination.id;

            await configure(tx, targetId, {
                cwd,
                ...(agent.model === undefined ? {} : { model: agent.model }),
                ...(agent.thinkingLevel === undefined
                    ? {}
                    : { thinkingLevel: agent.thinkingLevel }),
            });
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
                createdBy: user.id,
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
                requestedBy: user.id,
                createdAt: now,
                delivery: "pending",
            };
            doc.requests[key] = { input, id: Number(targetId), handoffId, workItemId: item.id };
            intent.status = "completed";
            await tx.createTask(
                this.task,
                { handoffId },
                {
                    conversationId: targetId,
                    ownership: { kind: "conversation" },
                    background: true,
                },
            );
            result = { id: Number(targetId), handoffId, workItemId: item.id };

            return undefined;
        }, ctx);

        return result!;
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
