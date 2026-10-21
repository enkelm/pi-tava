/** Internal WorkItems transfer engine: human admission, atomic successors, durable delivery and recovery. */
import { isUtf8 } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
    AgentDoc,
    type ConversationId,
    type Cursor,
    type SubmissionId,
    type SubmissionRecord,
    type ToolExecutionApi,
    defineTask,
    InboxDoc,
    LiveDoc,
    type Tx,
    type TaskId,
    type TaskRuntime,
    UsageDoc,
} from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { SessionsDoc, SubagentsDoc, TurnsDoc } from "./docs.ts";
import { HttpError } from "./errors.ts";
import { hasPendingSubagentReports } from "./subagent-reports.ts";
import { handoffInputKey, parseHandoffCommand } from "./handoff-input.ts";
import { ownRequest, requestFor, requestPerson } from "./requests.ts";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { PublicationsDoc } from "./workflow-publication.ts";
import { userContent } from "./resend.ts";
import { createSessionRoot } from "./session-roots.ts";
import { addUsage, cleanTitle, titleModel, TITLE_PROMPT } from "./titles.ts";
import { withWorkflowPublicationLock, workflowExclusiveReason } from "./workflow-policy.ts";
import { type WorkspaceBackend, isMissingWorkspaceFile } from "./workspace-backend.ts";
import { workflowWorkspaceBackend, userWorkspaceBackend } from "./workspace-backend-factory.ts";
import {
    type CodeFingerprint,
    type Handoff,
    HandoffsDoc,
    type Relationship,
    type ThreadType,
    type Workflow,
    WorkflowDoc,
    type WorkItem,
} from "./workflow-docs.ts";

const context = BACKGROUND_CONTEXT;
const finished = { status: "terminal", outcome: { status: "completed", result: null } } as const;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export type HandoffResult = { id: number; handoffId: string; workItemId: string };
type HandoffAdmission = {
    kind: ThreadType;
    relation: Relationship;
    brief: string;
    key: string;
    input: string;
    instructions?: string;
    requestKey?: string;
    accepted?: boolean;
    /** Internal controller policy, never authority supplied by a tool argument. */
    controller?: true;
    targetTitle?: string;
    file?: string;
};
/** Pi Durable implements this transaction read but omits it from its public Tx declaration. */
type SubmissionTx = Tx & {
    submission(id: SubmissionId): Promise<SubmissionRecord | undefined>;
};

function text(value: unknown, name: string): string {
    if (
        typeof value !== "string" ||
        !value.trim() ||
        value.includes("\0") ||
        Buffer.from(value, "utf8").toString("utf8") !== value
    ) {
        throw new HttpError(400, `${name} must be nonempty valid text without NULs`);
    }

    return value;
}

export function humanDirection(instructions: string): string {
    return `Human direction for the successor (verbatim; subject to its role, safety and mutation limits):\n<human_handoff_direction>\n${instructions}\n</human_handoff_direction>`;
}

function target(value: unknown): ThreadType {
    if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,128}$/.test(value)) {
        throw new HttpError(400, "Choose a registered agent profile");
    }

    return value;
}

function relationship(value: unknown): Relationship {
    if (value !== "same-work" && value !== "new-work") {
        throw new HttpError(400, "Choose same-work or new-work explicitly");
    }

    return value;
}

/** Git may execute filters: inspection and all descendants stay target-native read-only/offline. */
async function fingerprintGit(backend: WorkspaceBackend, ...args: string[]): Promise<string> {
    const bytes = await backend.gitBytes(backend.cwd, args, {
        offline: true,
        readOnly: true,
        maxBuffer: 32 * 1024 * 1024,
        timeoutMs: 15_000,
        env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    });

    if (!isUtf8(bytes)) {
        throw new Error("Non-UTF-8 Git paths are unsupported for workflow fingerprints");
    }

    return bytes.toString("utf8");
}

function fingerprintPaths(value: string): string[] {
    if (value !== "" && !value.endsWith("\0")) {
        throw new Error("Incomplete Git pathname list");
    }

    return value === "" ? [] : value.slice(0, -1).split("\0");
}

function requireContainedPath(backend: WorkspaceBackend, root: string, path: string): void {
    const relative = backend.paths.relative(root, path);

    if (
        relative === ".." ||
        relative.startsWith(`..${backend.paths.sep}`) ||
        backend.paths.isAbsolute(relative)
    ) {
        throw new Error("Git pathname escapes the workspace root");
    }
}

/** Physical files, not normalized Git blobs. This is bounded inspection, not an atomic snapshot. */
async function fingerprint(backend: WorkspaceBackend): Promise<CodeFingerprint> {
    try {
        const cwd = await backend.canonical(backend.cwd);
        const work = backend.at(cwd);
        const reported = await fingerprintGit(work, "rev-parse", "--show-toplevel");
        const reportedRoot = reported.endsWith("\n") ? reported.slice(0, -1) : reported;

        if (!backend.paths.isAbsolute(reportedRoot) || reportedRoot.includes("\0")) {
            throw new Error("Git did not report an absolute workspace root");
        }

        const root = await backend.canonical(reportedRoot);

        requireContainedPath(backend, root, cwd);
        const repository = backend.at(root);
        const head = (await fingerprintGit(repository, "rev-parse", "--verify", "HEAD")).trim();

        if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head)) {
            throw new Error("Git did not report a concrete HEAD commit");
        }

        const status = await fingerprintGit(
            repository,
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--ignore-submodules=none",
        );
        const modules = await fingerprintGit(
            repository,
            "status",
            "--porcelain=v2",
            "-z",
            "--untracked-files=all",
            "--ignore-submodules=none",
        );

        if (/(?:^|\0)[12] \S+ S(?!\.\.\.)/.test(modules)) {
            throw new Error("Changed or dirty submodules are unsupported for workflow readiness");
        }

        const index = await fingerprintGit(repository, "ls-files", "--stage", "-z");
        const tracked = await fingerprintGit(
            repository,
            "ls-files",
            "--cached",
            "--recurse-submodules",
            "-z",
        );
        const untracked = await fingerprintGit(
            repository,
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z",
        );
        const paths = [
            ...new Set([...fingerprintPaths(tracked), ...fingerprintPaths(untracked)]),
        ].sort();

        if (paths.length > 50_000) {
            throw new Error("Code exceeds the 50,000-path fingerprint limit");
        }

        const hash = createHash("sha256");

        hash.update(JSON.stringify([backend.id, root, cwd, head, status, modules, index]));
        let size = 0;

        for (const path of paths) {
            if (
                backend.paths.isAbsolute(path) ||
                path
                    .split("/")
                    .some(
                        (part) =>
                            part === "" ||
                            part === "." ||
                            part === ".." ||
                            part.toLowerCase() === ".git",
                    )
            ) {
                throw new Error("Unsafe Git pathname");
            }

            const file = backend.paths.resolve(root, path);

            requireContainedPath(backend, root, file);
            requireContainedPath(
                backend,
                root,
                await repository.canonicalWithMissingTail(backend.paths.dirname(file)),
            );
            const info = await repository.lstat(file).catch((error: unknown) => {
                if (isMissingWorkspaceFile(error)) {
                    return undefined;
                }

                throw error;
            });

            if (info === undefined) {
                hash.update(JSON.stringify([path, "deleted"]));
                continue;
            }

            // Final symlinks contribute target bytes, but parents must never escape the checkout.
            requireContainedPath(
                backend,
                root,
                await repository.canonical(backend.paths.dirname(file)),
            );
            size += info.size;

            if (!Number.isSafeInteger(info.size) || info.size < 0 || size > 64 * 1024 * 1024) {
                throw new Error("Code exceeds the 64 MiB fingerprint limit");
            }

            hash.update(JSON.stringify([path, info.mode, info.size]));
            let bytes: Buffer;

            if (info.kind === "symlink") {
                bytes = await repository.readlink(file);
            } else if (info.kind === "file") {
                requireContainedPath(backend, root, await repository.canonical(file));
                bytes = await repository.readBytes(file, info.size);
                requireContainedPath(backend, root, await repository.canonical(file));
            } else {
                throw new Error("Unsupported tracked or untracked file type");
            }

            const after = await repository.lstat(file);

            if (
                bytes.length !== info.size ||
                after.kind !== info.kind ||
                after.size !== info.size ||
                after.mode !== info.mode ||
                after.mtimeMs !== info.mtimeMs
            ) {
                throw new Error("Code changed during fingerprint inspection");
            }

            hash.update(bytes);
        }

        return { digest: hash.digest("hex"), cwd, head, status: status.slice(0, 4000) };
    } catch {
        throw new HttpError(
            409,
            "Cannot fingerprint this checkout safely; use a supported OS sandbox and a Git checkout with a HEAD, safe contained paths, at most 64 MiB of tracked/untracked files, and no dirty submodules",
        );
    }
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

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /** Extensions supply the tool; core derives authority from the actual placed invocation. */
    async invoke(
        request:
            | { action: "status" }
            | {
                  action: "start";
                  targetType: string;
                  relationship?: "same-work" | "new-work";
                  summary: string;
              },
        api: ToolExecutionApi,
        ctx: Context,
    ): Promise<unknown> {
        return request.action === "start"
            ? this.#startFromInput(api, ctx, request)
            : this.#app.workItems.list(
                  api.conversationId,
                  this.#requester(api.conversationId),
                  api.conversationId === this.#app.rootOf(api.conversationId)
                      ? api.taskId
                      : undefined,
              );
    }

    /** A real private PiP invocation controls an explicit source through WorkItems' live grant. */
    async controllerStart(
        controllerId: ConversationId,
        sourceId: ConversationId,
        epoch: number,
        request: { targetType: string; summary: string; instructions?: string },
        api: ToolExecutionApi,
        ctx: Context,
        inspect: () => void,
    ): Promise<HandoffResult> {
        if (api.conversationId !== controllerId) {
            throw new HttpError(403, "Use the controller's own invocation for this handoff");
        }

        const kind = target(request.targetType);
        const brief = text(request.summary, "summary");
        const instructions =
            request.instructions === undefined
                ? undefined
                : text(request.instructions, "instructions");
        const key = digest(["controller-handoff", controllerId, api.taskId, api.callId]);
        const input = digest([sourceId, kind, brief, instructions ?? null]);
        let file: { path: string; host: string | null; input: string } | undefined;

        const activate = async (tx: Tx, create: boolean): Promise<HandoffResult | undefined> => {
            const user = await this.#app.workItems.requireController(
                tx,
                controllerId,
                epoch,
                sourceId,
                false,
            );
            const doc = await tx.doc(HandoffsDoc);
            const saved = doc.requests[key];

            if (saved !== undefined) {
                if (saved.input !== input) {
                    throw new HttpError(
                        409,
                        "This controller action already started a different handoff",
                    );
                }

                this.#app.requireSee(user, saved.id as ConversationId);

                return { id: saved.id, handoffId: saved.handoffId, workItemId: saved.workItemId };
            }

            if (!create) {
                return undefined;
            }

            const current = await this.#app.workItems.requireController(
                tx,
                controllerId,
                epoch,
                sourceId,
                true,
            );

            if (
                new Set([...Object.keys(doc.requests), ...Object.keys(doc.pending ?? {})]).size >=
                10_000
            ) {
                throw new HttpError(413, "The handoff request limit was reached");
            }

            if (
                file === undefined ||
                file.input !== input ||
                file.host !== (this.#app.locationOf(sourceId)?.host ?? null)
            ) {
                throw new HttpError(
                    409,
                    "The handoff file's destination changed; start a fresh request",
                );
            }

            inspect();
            const result = await this.#create(
                tx,
                sourceId,
                current,
                {
                    kind,
                    relation: "same-work",
                    brief,
                    instructions,
                    key,
                    requestKey: key,
                    input,
                    file: file.path,
                    controller: true,
                },
                new Set<TaskId>(),
            );

            // Same-work creation has retired sourceId and moved this grant to the new active member.
            await this.#app.workItems.requireController(
                tx,
                controllerId,
                epoch,
                result.id as ConversationId,
                true,
            );

            return result;
        };

        const saved = await api.commit((tx) => activate(tx, false), ctx);

        if (saved !== undefined) {
            return saved;
        }

        // Freshness is caller policy for new effects, never a prerequisite to recover a saved receipt.
        inspect();
        const user = await api.commit(
            (tx) => this.#app.workItems.requireController(tx, controllerId, epoch, sourceId, true),
            ctx,
        );

        this.#controllerWritable(sourceId, kind);
        file = await api.memo<{ path: string; host: string | null; input: string }>(
            "controller-handoff-file",
            ctx,
        );

        if (file === undefined) {
            const person = structuredClone(user);
            const host = this.#app.locationOf(sourceId)?.host ?? null;
            const env = this.#app.envFor(sourceId, person);
            const directory = getOrThrow(await env.createTempDir("pi-coop-handoff-", ctx));
            const path = getOrThrow(await env.joinPath([directory, "handoff.md"], ctx));
            const markdown =
                [
                    `# Handoff from thread ${sourceId}`,
                    brief,
                    ...(instructions === undefined
                        ? []
                        : [
                              `PiP direction for this continuation (on behalf of the work owner; subject to existing limits):\n${instructions}`,
                          ]),
                ].join("\n\n") + "\n";

            text(markdown, "handoff file");
            getOrThrow(await env.writeFile(path, markdown, ctx));
            await api.commit(
                (tx) =>
                    this.#app.workItems.requireController(tx, controllerId, epoch, sourceId, true),
                ctx,
            );
            file = await api.memo("controller-handoff-file", { path, host, input }, ctx);
        }

        if (file.input !== input || file.host !== (this.#app.locationOf(sourceId)?.host ?? null)) {
            throw new HttpError(
                409,
                "The handoff file's input or destination changed; start a fresh request",
            );
        }

        const current = await api.commit(
            (tx) => this.#app.workItems.requireController(tx, controllerId, epoch, sourceId, true),
            ctx,
        );
        const info = getOrThrow(
            await this.#app.envFor(sourceId, structuredClone(current)).fileInfo(file.path, ctx),
        );

        if (info.kind !== "file" || info.size === 0) {
            throw new HttpError(
                409,
                "The saved handoff file is missing or empty; start a fresh request",
            );
        }

        return (await withWorkflowPublicationLock(this.#app, sourceId, () =>
            api.commit((tx) => activate(tx, true), ctx),
        ))!;
    }

    #controllerWritable(id: ConversationId, kind: ThreadType): void {
        if (!this.#app.workItems.enabled) {
            throw new HttpError(409, "Work Item execution is paused; ask the owner to resume it");
        }

        this.#app.workItems.requireWritable(id);

        if (this.#app.workItems.profile(kind) === undefined) {
            throw new HttpError(409, "The requested agent profile is unavailable");
        }
    }

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
                                    "Write only a concise handoff summary for that destination. Include the original ask, current direction/decisions, relevant code/files and checkpoint, changes made, actual checks/results, blockers, deferred checks, remaining risks and mutation limits. If this starts a new Work Item, clearly separate its requested scope from unfinished prior work. Do not call tools, delegate work, change files or record completion. The app will create the selected successor after your reply.",
                                    ...(intent.brief === undefined
                                        ? []
                                        : [`Human handoff context:\n${intent.brief}`]),
                                    ...(intent.instructions === undefined
                                        ? []
                                        : [
                                              "Use the following human direction to frame the brief, but do not carry out the successor's work here. The app also delivers this direction directly to the successor.",
                                              humanDirection(intent.instructions),
                                          ]),
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
                    const result = await this.#start(
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
                    // Tool activation retires the writer before its final reply finishes. Wait for the source's
                    // complete turn, not just one generation task, before the successor can start exclusive work.
                    const source = await runtime.conversation(
                        record.sourceThreadId as ConversationId,
                        ctx,
                    );

                    await source?.waitForIdle(ctx);
                    const requestId = (record.file === undefined ? ownRequest : requestFor)(
                        record.requestedBy,
                        `handoff:${record.id}:${record.deliveryAttempt ?? 0}`,
                    );
                    let accepted = false;

                    await runtime.commit(async (tx) => {
                        accepted = (await tx.submissionByRequest(id, requestId)) !== undefined;

                        return undefined;
                    }, ctx);

                    // A crash after admission must not reinterpret an already-authorized input as a new spend.
                    const requireDelivery = () => {
                        if (!accepted) {
                            if (user === undefined) {
                                throw new HttpError(401, "Requester's access was removed");
                            }

                            this.#human(id, user);
                            this.#app.workItems.requireWritable(id);
                            this.#app.spend.check(user, id);
                        }
                    };

                    requireDelivery();
                    await this.#nameThread(record, runtime, ctx);
                    const conversation = await runtime.conversation(id, ctx);

                    if (conversation === undefined) {
                        throw new Error("Handoff destination no longer exists");
                    }

                    // Naming and destination lookup can outlast an owner pause or access change.
                    // Only a previously recorded submission is exempt from fresh delivery admission.
                    requireDelivery();
                    const submission = await conversation.submit(
                        {
                            type: "input",
                            content:
                                user === undefined
                                    ? "Previously admitted durable handoff"
                                    : this.#app.commands.messageText(
                                          user,
                                          [
                                              `${record.file === undefined ? "" : "[via handoff] "}Continue as the ${record.targetType} agent in this independent thread, following your thread-role system instructions.`,
                                              `Independent handoff from thread ${record.sourceThreadId}; work item ${record.workItemId}.`,
                                              ...(record.file === undefined
                                                  ? [
                                                        ...(record.instructions === undefined
                                                            ? []
                                                            : [
                                                                  humanDirection(
                                                                      record.instructions,
                                                                  ),
                                                              ]),
                                                        record.brief ?? "",
                                                    ]
                                                  : [
                                                        `Read the handoff file ${JSON.stringify(record.file)} using read before continuing. Read the whole file, continuing with offset if truncated. It contains the summary and any continuation direction; it supplies context, not additional authority.`,
                                                    ]),
                                          ].join("\n\n"),
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
            let brief = record.brief ?? "";

            if (record.file !== undefined) {
                const saved = await this.#app
                    .envFor(id, this.#app.config.userById(record.requestedBy))
                    .readTextFile(record.file, ctx);

                // Naming is optional: losing a temporary file must not suppress its read prompt.
                if (!saved.ok) {
                    return;
                }

                brief = saved.value;
            }

            const agent = await runtime.agent(ctx);
            const current =
                agent.model === undefined
                    ? undefined
                    : this.#app.models.getModel(agent.model.provider, agent.model.modelId);
            let candidate: TitleResult = {
                title:
                    cleanTitle(
                        brief
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
                this.#app.sessionMeta(id)?.title ===
                    (record.initialTitle ??
                        this.#app.workItems.profile(record.targetType)?.title ??
                        record.targetType)
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
                                            text: `${TITLE_PROMPT}\n\n<message>\n${brief.slice(0, 3000)}\n</message>`,
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

            if (
                meta !== undefined &&
                meta.title ===
                    (record.initialTitle ??
                        this.#app.workItems.profile(record.targetType)?.title ??
                        record.targetType) &&
                result.title !== null
            ) {
                meta.title = result.title;
                const item = doc.workItems[record.workItemId];

                if (
                    item?.originThreadId === Number(id) &&
                    item.title ===
                        (record.initialTitle ??
                            this.#app.workItems.profile(record.targetType)?.title ??
                            record.targetType)
                ) {
                    item.title = result.title;
                }
            }

            saved.titleNamed = true;

            return undefined;
        }, ctx);
    }

    /** Stop also cancels a summary task that has not yet placed its foreground model input. */
    async abortSummary(id: ConversationId, supplied: User): Promise<void> {
        this.#human(id, supplied);
        const doc = await this.#app.harness.snapshot(HandoffsDoc, context);
        const pending = Object.values(doc?.pending ?? {}).filter(
            (request) => request.sourceThreadId === Number(id) && request.status === "pending",
        );

        await Promise.all(
            pending.map((request) =>
                this.#app.harness.abortTask(request.taskId as TaskId, context),
            ),
        );
    }

    /** Publication approvals bind the exact same checkout fingerprint as workflow completion. */
    async fingerprint(id: ConversationId, user?: User, ctx: Context = context): Promise<string> {
        const root = this.#app.rootOf(id);
        const backend =
            user === undefined
                ? workflowWorkspaceBackend(this.#app, root, ctx)
                : userWorkspaceBackend(this.#app, root, ctx, user);

        return (await fingerprint(backend)).digest;
    }

    #human(id: ConversationId, supplied: User): User {
        const user = this.#app.config.userById(supplied.id);

        if (user === undefined || user.tokenHash !== supplied.tokenHash) {
            throw new HttpError(401, "Your access was removed or changed; sign in again");
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

    /** Only inputs actually placed in this owning run can supply human authority, not attribution alone. */
    async #humanInput(tx: Tx, id: ConversationId, taskId: TaskId, pinned?: number) {
        if (id !== this.#app.rootOf(id)) {
            throw new HttpError(403, "Start a handoff from the main thread, not its subagent");
        }

        const allowed = await this.#exclusiveInvocationTasks(tx, id, taskId);
        const live = await tx.doc(LiveDoc, id);
        const ids = [...live.run!.inputs].reverse();

        for (const submissionId of ids) {
            if (pinned !== undefined && Number(submissionId) !== pinned) {
                continue;
            }

            const submission = await (tx as SubmissionTx).submission(submissionId);
            const person = requestPerson(submission?.requestId);

            if (
                submission?.type !== "input" ||
                submission.status !== "placed" ||
                submission.conversationId !== id ||
                submission.entry === undefined ||
                person?.wrote !== true ||
                /^u:[^:]+:handoff(?:-summary)?:/.test(submission.requestId ?? "") ||
                // Human-created schedules are attributed as ownRequest too, but are not fresh human input.
                /^u:[^:]+:schedule-\d+-\d+$/.test(submission.requestId ?? "")
            ) {
                continue;
            }

            const entry = await tx.entry(submission.entry);

            if (entry?.kind !== "pi.user" || entry.conversationId !== id) {
                continue;
            }

            const supplied = this.#app.config.userById(person.userId);

            if (supplied === undefined) {
                throw new HttpError(401, "Requester's access was removed");
            }

            const user = this.#human(id, supplied);
            const body = userContent(entry.model?.[0]).text.replace(/^\[from:[^\]]+\]\s*/, "");

            return {
                user,
                body,
                allowed,
                submissionId: Number(submissionId),
                key: handoffInputKey(user.id, id, submission.requestId!),
            };
        }

        throw new HttpError(
            403,
            "A handoff requires written human input in the current main run; incoming briefs, scheduled messages and helper reports cannot authorize one",
        );
    }

    async #startFromInput(
        api: ToolExecutionApi,
        ctx: Context,
        request: { targetType: unknown; relationship?: unknown; summary: unknown },
    ): Promise<HandoffResult> {
        const id = api.conversationId;
        const kind = target(request.targetType);
        const relation = relationship(request.relationship ?? "same-work");
        const brief = text(request.summary, "summary");
        let pin = await api.memo<{ submissionId: number; key: string }>("handoff-input", ctx);

        if (pin === undefined) {
            const input = await api.commit((tx) => this.#humanInput(tx, id, api.taskId), ctx);

            pin = await api.memo(
                "handoff-input",
                { submissionId: input.submissionId, key: input.key },
                ctx,
            );
        }

        const pinned = pin;
        let file: { path: string; host: string | null } | undefined;

        const activate = async (
            tx: Tx,
            create: boolean,
            currentDiff?: boolean,
        ): Promise<HandoffResult | undefined> => {
            const source = await this.#humanInput(tx, id, api.taskId, pinned.submissionId);

            if (source.key !== pinned.key) {
                throw new HttpError(409, "The handoff's human input identity changed");
            }

            const route = parseHandoffCommand(source.body);

            if (
                (route?.targetType !== undefined && route.targetType !== kind) ||
                (route?.relationship !== undefined && route.relationship !== relation)
            ) {
                throw new HttpError(
                    409,
                    "The handoff target and relationship must match the human's explicit /handoff route",
                );
            }

            const instructions =
                route === undefined ? text(source.body, "human direction") : route.instructions;
            const input = digest([kind, relation, brief, instructions ?? null]);
            const doc = await tx.doc(HandoffsDoc);
            const saved = doc.requests[source.key];
            const turns = await tx.doc(TurnsDoc, id);

            if (turns.on && turns.driver !== source.user.id) {
                throw new HttpError(409, "Take the wheel before starting a handoff");
            }

            if (saved !== undefined) {
                if (saved.input !== input) {
                    throw new HttpError(
                        409,
                        "This human input already started a different handoff",
                    );
                }

                this.#app.requireSee(source.user, saved.id as ConversationId);

                return {
                    id: saved.id,
                    handoffId: saved.handoffId,
                    workItemId: saved.workItemId,
                };
            }

            const workItemId = (await tx.doc(SessionsDoc)).items[String(id)]?.workItemId;
            const grant =
                workItemId === undefined ? undefined : doc.workItems[workItemId]?.supervisor;

            if (grant?.status === "running") {
                throw new HttpError(
                    409,
                    "PiP currently controls this Work Item. Send a new human instruction or use the human handoff controls to reclaim control before handing off here.",
                );
            }

            if (!create) {
                return undefined;
            }

            const latest = await this.#humanInput(tx, id, api.taskId);

            if (latest.key !== source.key) {
                throw new HttpError(
                    409,
                    "Newer human input arrived; clarify the current direction before handing off",
                );
            }

            if (
                Object.values(doc.pending ?? {}).some(
                    (pending) =>
                        pending.sourceThreadId === Number(id) && pending.status === "pending",
                )
            ) {
                throw new HttpError(409, "Another human-requested handoff summary is in progress");
            }

            if (
                new Set([...Object.keys(doc.requests), ...Object.keys(doc.pending ?? {})]).size >=
                10_000
            ) {
                throw new HttpError(413, "The handoff request limit was reached");
            }

            if (file === undefined || file.host !== (this.#app.locationOf(id)?.host ?? null)) {
                throw new HttpError(
                    409,
                    "The handoff file's destination changed; start a fresh request",
                );
            }

            return this.#create(
                tx,
                id,
                source.user,
                {
                    kind,
                    relation,
                    brief,
                    instructions,
                    file: file.path,
                    key: source.key,
                    requestKey: source.key,
                    input,
                },
                source.allowed,
                currentDiff,
            );
        };

        // Receipt recovery has no effects and must not depend on the successor still being idle.
        const saved = await api.commit((tx) => activate(tx, false), ctx);

        if (saved !== undefined) {
            return saved;
        }

        this.#app.workItems.requireWritable(id);
        file = await api.memo<{ path: string; host: string | null }>("handoff-file", ctx);

        if (file === undefined) {
            const source = await api.commit(
                (tx) => this.#humanInput(tx, id, api.taskId, pinned.submissionId),
                ctx,
            );
            const person = structuredClone(source.user);
            const host = this.#app.locationOf(id)?.host ?? null;
            const route = parseHandoffCommand(source.body);
            const instructions =
                route === undefined ? text(source.body, "human direction") : route.instructions;
            const env = this.#app.envFor(id, person);
            const directory = getOrThrow(await env.createTempDir("pi-coop-handoff-", ctx));
            const path = getOrThrow(await env.joinPath([directory, "handoff.md"], ctx));
            const markdown =
                [
                    `# Handoff from thread ${id}`,
                    brief,
                    ...(instructions === undefined ? [] : [humanDirection(instructions)]),
                ].join("\n\n") + "\n";

            text(markdown, "handoff file");
            getOrThrow(await env.writeFile(path, markdown, ctx));
            this.#human(id, person);
            file = await api.memo("handoff-file", { path, host }, ctx);
        }

        const source = await api.commit(
            (tx) => this.#humanInput(tx, id, api.taskId, pinned.submissionId),
            ctx,
        );
        const info = getOrThrow(
            await this.#app.envFor(id, structuredClone(source.user)).fileInfo(file.path, ctx),
        );

        if (info.kind !== "file" || info.size === 0) {
            throw new HttpError(
                409,
                "The saved handoff file is missing or empty; start a fresh request",
            );
        }

        return (await withWorkflowPublicationLock(this.#app, id, async () => {
            let currentDiff: boolean | undefined;

            if (
                this.#app.workItems
                    .optionsFor(id)
                    .find(
                        (choice) => choice.targetType === kind && choice.relationship === relation,
                    )?.currentDiff !== undefined
            ) {
                const user = await api.commit(async (tx) => {
                    const source = await this.#humanInput(tx, id, api.taskId, pinned.submissionId);

                    await this.#admit(tx, id, source.user, kind, relation, source.allowed);

                    return source.user;
                }, ctx);

                // Workspace reads use Durable's serialized read line, so they cannot run inside a
                // commit. Hold the exclusive writer lock from this fresh read through final admission.
                currentDiff = await this.#hasDiff(id, user);
            }

            return api.commit((tx) => activate(tx, true, currentDiff), ctx);
        }))!;
    }

    #writable(state: Readonly<Workflow>): void {
        if (state.readOnly) {
            throw new HttpError(409, "This previous writer is permanently read-only");
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

    /** Main invocation/run and exact placed incoming courier; never arbitrary delivery or helper tasks. */
    async #exclusiveInvocationTasks(
        tx: Tx,
        id: ConversationId,
        taskId: TaskId,
    ): Promise<Set<TaskId>> {
        const live = await tx.doc(LiveDoc, id);
        const allowed = await this.#invocationTasks(tx, taskId, live.run?.taskId);

        if (live.run === undefined || !allowed.has(live.run.taskId)) {
            throw new HttpError(
                409,
                "An exclusive workflow action requires its current main invocation/run",
            );
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
                      (incoming.file === undefined ? ownRequest : requestFor)(
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

        return allowed;
    }

    /** Fetch admission exempts its main invocation/run and its already-placed incoming brief, never other work. */
    async requireFetchIdle(tx: Tx, id: ConversationId, taskId: TaskId): Promise<void> {
        if (id !== this.#app.rootOf(id)) {
            throw new HttpError(403, "Only the main Pull thread may fetch");
        }

        const allowed = await this.#exclusiveInvocationTasks(tx, id, taskId);

        await this.#idle(tx, this.#app.workItems.members(id).map(Number), allowed, false);
    }

    /** Human cleanup callers must prove the complete group and descendant task graph quiescent. */
    async requireIdle(tx: Tx, id: ConversationId): Promise<void> {
        await this.#idle(tx, this.#app.workItems.members(id).map(Number));
    }

    /** Internal inspection shared by the human picker and tool status; it grants no transfer authority. */
    async availability(
        id: ConversationId,
        user: User,
        invocation: TaskId | undefined,
        needsDiff: boolean,
    ) {
        const root = this.#app.rootOf(id);
        let busyReason = workflowExclusiveReason(this.#app, root);
        let driverReason: string | undefined;

        try {
            await this.#app.harness.commit(async (tx) => {
                const turns = await tx.doc(TurnsDoc, root);

                if (turns.on && turns.driver !== user.id) {
                    driverReason = "Take the wheel before starting a handoff";
                }

                await this.#requireResolvedPublications(
                    tx,
                    this.#app.workItems.members(root).map(Number),
                );

                if (invocation === undefined) {
                    await this.requireIdle(tx, root);
                } else {
                    const allowed = await this.#exclusiveInvocationTasks(tx, root, invocation);

                    await this.#idle(
                        tx,
                        this.#app.workItems.members(root).map(Number),
                        allowed,
                        false,
                    );
                }
            }, context);
        } catch (error) {
            if (!(error instanceof HttpError)) {
                throw error;
            }

            busyReason ??= error.message;
        }

        if (this.#app.workItems.isPreparing(root)) {
            busyReason = "Preparing the human-requested handoff summary";
        }

        let hasDiff: boolean | undefined;
        let diffReason: string | undefined;

        if (needsDiff) {
            // Do not inspect a changing checkout, a retired writer, or a caller who cannot steer.
            if (
                busyReason === undefined &&
                root === id &&
                !this.#app.workItems.isReadOnly(root) &&
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
        }

        return { busyReason, driverReason, hasDiff, diffReason };
    }

    async #hasDiff(id: ConversationId, user: User): Promise<boolean> {
        const changes = await this.#app.workspace.changes(id, user);

        // piOnly is historical tool activity (including files already committed), not a current diff.
        return changes.files.length > 0;
    }

    #requireMembers(item: WorkItem, user: User): void {
        if (item.threadIds.some((id) => !this.#app.canSee(user, id as ConversationId))) {
            throw new HttpError(404, "This work item is not shared with you");
        }
    }

    async #admit(
        tx: Tx,
        id: ConversationId,
        supplied: User,
        kind: ThreadType,
        relation: Relationship,
        allowed = new Set<TaskId>(),
        accepted = false,
        controller = false,
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

        if (controller) {
            this.#controllerWritable(id, kind);
        }

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

        if (!controller) {
            const history = (item?.threadIds ?? [Number(id)]).map(
                (member) => sessions.items[String(member)]?.threadType ?? "worker",
            );
            const reason = this.#app.workItems
                .options(meta.threadType ?? "worker", history)
                .some((option) => option.targetType === kind && option.relationship === relation)
                ? undefined
                : "This handoff is not available from the current thread state";

            // A durably accepted intent already fixed its workflow choice. Extension unload/reload must
            // not strand it, but all live ownership, access, spend and task-graph checks still apply.
            if (!accepted && reason !== undefined) {
                throw new HttpError(409, reason);
            }
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
            `Source checkpoint: thread ${id}, latest transcript entry ${last.items[0]?.id ?? "none"}; cwd ${this.#app.cwdOf(id)}; Git HEAD ${code?.head ?? "unavailable"}; fingerprint ${code?.digest ?? "unavailable"}; status ${code === undefined ? "unavailable" : code.status === "" ? "clean" : "dirty (inspect the current checkout)"}.`,
        ]
            .join("\n\n")
            .slice(0, 12_000);
    }

    async #start(
        id: ConversationId,
        supplied: User,
        request: HandoffAdmission,
        runtime: SummaryRuntime,
        ctx: Context,
    ): Promise<HandoffResult> {
        return this.#app.workItems.withControl(id, () =>
            withWorkflowPublicationLock(this.#app, id, () =>
                this.#startAccepted(id, supplied, request, runtime, ctx),
            ),
        );
    }

    async #startAccepted(
        id: ConversationId,
        supplied: User,
        request: HandoffAdmission,
        runtime: SummaryRuntime,
        ctx: Context,
    ): Promise<HandoffResult> {
        const { kind, key, input } = request;
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

            const doc = await tx.doc(HandoffsDoc);
            const intent = doc.pending?.[key];

            if (
                intent?.taskId !== Number(runtime.taskId) ||
                intent.status !== "pending" ||
                intent.input !== input ||
                intent.requestedBy !== user.id
            ) {
                throw new HttpError(409, "The human's handoff request is no longer current");
            }

            result = await this.#create(
                tx,
                id,
                supplied,
                {
                    ...request,
                    instructions: intent.instructions,
                    accepted: true,
                    targetTitle: intent.targetTitle,
                },
                new Set([runtime.taskId]),
                kind === "reviewer",
            );
            intent.status = "completed";

            return undefined;
        }, ctx);

        return result!;
    }

    /** Both new tool activation and already-persisted summary tasks publish the same atomic transfer. */
    async #create(
        tx: Tx,
        id: ConversationId,
        supplied: User,
        request: HandoffAdmission,
        allowed: Set<TaskId>,
        currentDiff?: boolean,
    ): Promise<HandoffResult> {
        const { kind, relation, brief, key, input, instructions, requestKey, file } = request;
        const {
            user,
            doc,
            meta,
            state,
            item: oldItem,
        } = await this.#admit(
            tx,
            id,
            supplied,
            kind,
            relation,
            allowed,
            request.accepted === true,
            request.controller === true,
        );

        // The caller inspected this diff while holding the same exclusive lock, not at status time.
        const diffRequirement =
            request.accepted === true || request.controller === true
                ? undefined
                : this.#app.workItems
                      .optionsFor(id)
                      .find(
                          (choice) =>
                              choice.targetType === kind && choice.relationship === relation,
                      )?.currentDiff;

        if (diffRequirement !== undefined && currentDiff !== diffRequirement) {
            throw new HttpError(
                409,
                "There is no current Pi diff matching this handoff's requirements",
            );
        }

        const agent = await tx.doc(AgentDoc, id);
        const cwd = agent.cwd ?? meta.cwd;

        if (cwd !== this.#app.cwdOf(id)) {
            throw new HttpError(409, "Source checkout changed; try again");
        }

        const persisted =
            requestKey === undefined
                ? await this.#brief(
                      tx,
                      id,
                      (oldItem?.originThreadId ?? Number(id)) as ConversationId,
                  )
                : undefined;
        const initialBrief =
            persisted === undefined
                ? brief
                : `Human-requested handoff summary:\n${brief}\n\nPersisted source context:\n${persisted.slice(0, 4000)}`;
        const sourceEntry = (await tx.scanEntries({ conversationId: id, order: "descending" }, 1))
            .items[0]?.id;
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
                      ...(relation === "new-work" && oldItem !== undefined
                          ? { predecessorWorkItemId: oldItem.id }
                          : {}),
                      createdAt: now,
                  };

        this.#human(id, supplied);
        this.#app.spend.check(user, id);
        const initialTitle =
            request.targetTitle ?? this.#app.workItems.profile(kind)?.title ?? kind;
        const targetId = await createSessionRoot(tx, {
            agent: {
                cwd,
                ...(agent.model === undefined ? {} : { model: agent.model }),
                ...(agent.thinkingLevel === undefined
                    ? {}
                    : { thinkingLevel: agent.thinkingLevel }),
            },
            meta: {
                cwd,
                ...(meta.location === undefined ? {} : { location: meta.location }),
                title: initialTitle,
                createdAt: now,
                updatedAt: now,
                createdBy: user.id,
                threadType: kind,
                accessFrom: Number(id),
                workItemId: item.id,
                ...(meta.ownerOnly === true ? { ownerOnly: true } : {}),
                ...(meta.projectId === undefined ? {} : { projectId: meta.projectId }),
                ...(meta.worktree === undefined ? {} : { worktree: { ...meta.worktree } }),
                ...(meta.budget === undefined ? {} : { budget: meta.budget }),
            },
        });

        item.activeThreadId = Number(targetId);
        item.threadIds.push(Number(targetId));

        if (relation === "new-work") {
            item.originThreadId = Number(targetId);
            item.title = initialTitle;
        } else {
            meta.workItemId = item.id;
        }

        doc.workItems[item.id] = item;
        state.readOnly = true;
        const handoffId = `h-${randomUUID()}`;

        doc.handoffs[handoffId] = {
            id: handoffId,
            sourceThreadId: Number(id),
            targetThreadId: Number(targetId),
            targetType: kind,
            initialTitle,
            relationship: relation,
            workItemId: item.id,
            ...(file === undefined
                ? { brief: initialBrief, ...(instructions === undefined ? {} : { instructions }) }
                : { file }),
            ...(requestKey === undefined ? {} : { requestKey }),
            ...(sourceEntry === undefined ? {} : { sourceEntryId: Number(sourceEntry) }),
            requestedBy: user.id,
            createdAt: now,
            delivery: "pending",
        };
        doc.requests[key] = { input, id: Number(targetId), handoffId, workItemId: item.id };
        await tx.createTask(
            this.task,
            { handoffId },
            {
                conversationId: targetId,
                ownership: { kind: "conversation" },
                background: true,
            },
        );

        // Native pause and workflow registration can change outside Durable's mutation line while
        // the awaited setup above runs. Reject before returning so all prospective writes roll back.
        // Ordinary ungrouped Chat remains writable paused, but its fresh handoff edges do not.
        if (request.controller === true) {
            this.#controllerWritable(id, kind);
        } else if (request.accepted !== true) {
            this.#app.workItems.requireWritable(id);

            if (
                !this.#app.workItems
                    .optionsFor(id)
                    .some(
                        (choice) => choice.targetType === kind && choice.relationship === relation,
                    )
            ) {
                throw new HttpError(
                    409,
                    "This handoff is not available from the current thread state",
                );
            }
        }

        return { id: Number(targetId), handoffId, workItemId: item.id };
    }
}
