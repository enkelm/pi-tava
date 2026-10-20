/** PiP publishes an active main Reviewer's own findings, with no additional model generation. */
import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { Type, type AssistantMessage } from "@earendil-works/pi-ai";
import {
    defineTool,
    GenerationTask,
    hook,
    LiveDoc,
    ToolTask,
    type ConversationId,
    type EntryId,
    type HookApi,
    type ToolExecutionApi,
    type Tx,
} from "@earendil-works/pi-durable";
import type { PocketApp } from "../app.ts";
import type { User } from "../config.ts";
import {
    PipReviewCommentsDoc,
    PlanDoc,
    type PipDiffComment,
    type PipReviewReceipt,
} from "../docs.ts";
import { HttpError } from "../errors.ts";
import { validateReviewAnchor } from "../reviews.ts";
import { requireWorkflowRequester, withWorkflowPublicationLock } from "../workflow-policy.ts";

export type ReviewCommentArgs =
    | { action: "inspect"; path: string }
    | {
          action: "post";
          path: string;
          observation: string;
          side: "old" | "new";
          /** Inclusive end; absent startLine means one line. */
          line: number;
          startLine?: number;
          context: string;
          text: string;
      };

export type ReviewCommentResult =
    { path: string; observation: string; diff: string } | PipDiffComment;

type Source = {
    conversationId: number;
    requesterId: string;
    /** Live identity, including sign-in and grants, without storing another copy of the User. */
    authority: string;
    cwd: string;
    location: string;
    projectId: string | null;
};

type Invocation = Source & {
    episode: number;
    generationId: number;
    provider: string;
    model: string;
};

type AnnotatedAnswer = AssistantMessage & { pocketDiffComments?: PipDiffComment[] };

const MAX_RECEIPTS = 500;
const MAX_PATCH_BYTES = 128 * 1024;
const MAX_PATCH_LINES = 20_000;
const MAX_LINE = 10_000_000;
const MEMO = "pip-review-source";

function digest(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function authority(user: User): string {
    return digest([
        user.id,
        user.tokenHash,
        user.role,
        user.sessions ?? null,
        user.projectAccess ?? null,
    ]);
}

function reference(receipt: PipReviewReceipt, textLimit = 4000): PipDiffComment {
    return {
        conversationId: receipt.conversationId,
        threadId: receipt.threadId,
        commentId: receipt.commentId,
        path: receipt.path,
        side: receipt.side,
        line: receipt.line,
        ...(receipt.startLine === undefined ? {} : { startLine: receipt.startLine }),
        text: receipt.text.slice(0, textLimit),
    };
}

/** Accept complete, ordinary single-file unified patches only; never anchor to a truncated display. */
function patchLines(patch: string): { old: Map<number, string>; new: Map<number, string> } {
    if (Buffer.byteLength(patch) > MAX_PATCH_BYTES || patch.includes("\0")) {
        throw new HttpError(413, "The diff is too large or is not text; choose a smaller finding");
    }

    // Match the native diff's displayed evidence; the observation still hashes the exact raw patch.
    const rows = patch.replace(/\r\n/g, "\n").split("\n");

    if (rows.length > MAX_PATCH_LINES) {
        throw new HttpError(413, "The diff has too many lines to publish a finding safely");
    }

    const lines = { old: new Map<number, string>(), new: new Map<number, string>() };
    let files = 0;
    let hunks = 0;
    let oldLine = 0;
    let newLine = 0;
    let oldLeft = 0;
    let newLeft = 0;

    const invalid = () => {
        throw new HttpError(409, "The diff is incomplete or unsupported; inspect it again");
    };

    const add = (side: "old" | "new", line: number, value: string) => {
        if (line < 1 || line > MAX_LINE || lines[side].has(line)) {
            invalid();
        }

        lines[side].set(line, value);
    };

    for (const row of rows) {
        if (row.startsWith("diff --git ")) {
            if (oldLeft !== 0 || newLeft !== 0 || ++files > 1) {
                invalid();
            }

            continue;
        }

        const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(row);

        if (header !== null) {
            if (files !== 1 || oldLeft !== 0 || newLeft !== 0) {
                invalid();
            }

            oldLine = Number(header[1]);
            newLine = Number(header[3]);
            oldLeft = Number(header[2] ?? 1);
            newLeft = Number(header[4] ?? 1);

            if (
                ![oldLine, newLine, oldLeft, newLeft].every(Number.isSafeInteger) ||
                oldLine > MAX_LINE ||
                newLine > MAX_LINE ||
                oldLeft > MAX_PATCH_LINES ||
                newLeft > MAX_PATCH_LINES
            ) {
                invalid();
            }

            hunks++;
            continue;
        }

        if (row === "\\ No newline at end of file") {
            continue;
        }

        if (oldLeft !== 0 || newLeft !== 0) {
            const prefix = row[0];
            const value = row.slice(1);

            if (prefix === " " && oldLeft > 0 && newLeft > 0) {
                add("old", oldLine++, value);
                add("new", newLine++, value);
                oldLeft--;
                newLeft--;
            } else if (prefix === "-" && oldLeft > 0) {
                add("old", oldLine++, value);
                oldLeft--;
            } else if (prefix === "+" && newLeft > 0) {
                add("new", newLine++, value);
                newLeft--;
            } else {
                invalid();
            }
        } else if (hunks > 0 && row !== "") {
            invalid();
        }
    }

    if (files !== 1 || hunks === 0 || oldLeft !== 0 || newLeft !== 0) {
        invalid();
    }

    return lines;
}

function validateAnchor(patch: string, args: Extract<ReviewCommentArgs, { action: "post" }>): void {
    validateReviewAnchor(args);

    // Reviewer findings require complete evidence even for a legacy-style single-line anchor.
    if (
        typeof args.context !== "string" ||
        (args.startLine === undefined && args.context.includes("\n"))
    ) {
        throw new HttpError(400, "Choose 1–100 inclusive lines and provide their complete context");
    }

    const start = args.startLine ?? args.line;
    const lines = patchLines(patch)[args.side];
    const expected: string[] = [];

    for (let line = start; line <= args.line; line++) {
        const value = lines.get(line);

        if (value === undefined) {
            throw new HttpError(409, "Every finding line must be present on that side of the diff");
        }

        expected.push(value);
    }

    if (expected.join("\n") !== args.context) {
        throw new HttpError(409, "The complete finding context does not match the inspected diff");
    }
}

export class PipReviewer {
    readonly #app: PocketApp;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    readonly tool = defineTool({
        name: "review_comment",
        description:
            "Publish the active main Reviewer's findings as PiP diff comments, without another model call. First inspect a changed file to obtain its observation. Then post against that exact observation with old/new side, inclusive end line, optional inclusive startLine (at most 100 lines), complete exact context, and the finding text. No arbitrary destination, author or role may be supplied. Successful comments appear in the assessment's native Diff comments list.",
        replay: "safe",
        executionMode: "sequential",
        outputLimits: { maxBytes: 1_300_000, maxLines: MAX_PATCH_LINES + 20 },
        parameters: Type.Union([
            Type.Object(
                {
                    action: Type.Literal("inspect"),
                    path: Type.String({ minLength: 1, maxLength: 4096 }),
                },
                { additionalProperties: false },
            ),
            Type.Object(
                {
                    action: Type.Literal("post"),
                    path: Type.String({ minLength: 1, maxLength: 4096 }),
                    observation: Type.String({ pattern: "^[a-f0-9]{64}$" }),
                    side: Type.Union([Type.Literal("old"), Type.Literal("new")]),
                    line: Type.Integer({ minimum: 1, maximum: MAX_LINE }),
                    startLine: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LINE })),
                    context: Type.String({ maxLength: 8000 }),
                    text: Type.String({
                        minLength: 1,
                        maxLength: 4000,
                        description:
                            "Finding text. A new-side finding may include a top-level, fully closed Markdown suggestion fence containing the full replacement for the exact selected lines. An empty suggestion proposes deletion. The human can apply it; publication itself never edits code. Ordinary examples use other fence languages.",
                    }),
                },
                { additionalProperties: false },
            ),
        ]),
        execute: async (args, api, ctx) => {
            const result = await this.invoke(args, api, ctx);
            const details:
                { path: string; observation: string } | { pipDiffComment: PipDiffComment } =
                "diff" in result
                    ? { path: result.path, observation: result.observation }
                    : { pipDiffComment: result };

            return {
                content: [{ type: "text", text: JSON.stringify(result) }],
                details,
            };
        },
    });

    readonly hooks = [
        hook(GenerationTask, {
            afterResponse: (answer) => {
                // Provider output never controls this native attachment, including failed responses.
                delete (answer as AnnotatedAnswer).pocketDiffComments;
            },
            onYield: async (answer, api, ctx) => {
                delete (answer as AnnotatedAnswer).pocketDiffComments;
                const comments = await this.#yieldReferences(api, ctx);

                if (comments.length > 0) {
                    (answer as AnnotatedAnswer).pocketDiffComments = comments;
                }
            },
        }),
    ];

    /** The only entry point: actual invocation identity, never model-authored target or provenance. */
    async invoke(
        args: ReviewCommentArgs,
        api: ToolExecutionApi,
        ctx: Context,
    ): Promise<ReviewCommentResult> {
        const id = api.conversationId;
        const candidate = this.#source(id);

        return withWorkflowPublicationLock(this.#app, id, async () => {
            let pin = await api.memo<Invocation>(MEMO, ctx);

            if (pin === undefined) {
                const admitted = await api.commit((tx) => this.#admit(tx, api, candidate), ctx);

                pin = await api.memo(MEMO, admitted, ctx);
            }

            const pinned = pin;
            const admitted = await api.commit((tx) => this.#admit(tx, api, pinned), ctx);
            const key = digest([Number(id), Number(api.taskId), api.callId]);
            const fingerprint =
                args.action === "post"
                    ? digest([
                          args.action,
                          args.path,
                          args.observation,
                          args.side,
                          args.line,
                          args.startLine ?? null,
                          args.context,
                          args.text,
                      ])
                    : "";

            if (args.action === "post") {
                const saved = (await api.snapshot(PipReviewCommentsDoc, id, ctx))?.receipts[key];

                this.#source(id, pinned);

                if (saved !== undefined) {
                    if (saved.fingerprint !== fingerprint) {
                        throw new HttpError(
                            409,
                            "This invocation already posted a different finding",
                        );
                    }

                    return reference(saved);
                }

                this.#requirePost(id, pinned);

                if ((await api.snapshot(PlanDoc, id, ctx))?.on === true) {
                    throw new HttpError(
                        409,
                        "Plan mode is on; posting a review comment changes discussion",
                    );
                }
            }

            const user = this.#user(id, admitted);
            const patch = await this.#app.reviews.diff(id, user, args.path, ctx);

            this.#source(id, pinned);
            patchLines(patch);
            const observation = digest([
                pinned.conversationId,
                pinned.cwd,
                pinned.location,
                pinned.projectId,
                args.path,
                patch,
            ]);

            if (args.action === "inspect") {
                await api.commit((tx) => this.#admit(tx, api, pinned), ctx);

                return { path: args.path, observation, diff: patch.replace(/\r\n/g, "\n") };
            }

            if (args.observation !== observation) {
                throw new HttpError(
                    409,
                    "The diff observation is stale; inspect this file again before posting",
                );
            }

            validateAnchor(patch, args);

            if (
                typeof args.text !== "string" ||
                args.text.trim() === "" ||
                args.text.length > 4000
            ) {
                throw new HttpError(400, "A finding needs 1–4000 characters of text");
            }

            return api.commit(async (tx) => {
                const actual = await this.#admit(tx, api, pinned);
                const doc = await tx.doc(PipReviewCommentsDoc, id);
                const saved = doc.receipts[key];

                if (saved !== undefined) {
                    if (saved.fingerprint !== fingerprint) {
                        throw new HttpError(
                            409,
                            "This invocation already posted a different finding",
                        );
                    }

                    return reference(saved);
                }

                this.#requirePost(id, pinned);

                if ((await tx.doc(PlanDoc, id)).on) {
                    throw new HttpError(
                        409,
                        "Plan mode is on; posting a review comment changes discussion",
                    );
                }

                if (Object.keys(doc.receipts).length >= MAX_RECEIPTS) {
                    throw new HttpError(413, "This conversation has reached its PiP finding limit");
                }

                const posted = await this.#app.reviews.commentAsPiP(
                    tx,
                    id,
                    this.#user(id, actual),
                    {
                        requestId: `review-${key}`,
                        path: args.path,
                        side: args.side,
                        line: args.line,
                        ...(args.startLine === undefined ? {} : { startLine: args.startLine }),
                        context: args.context,
                        text: args.text,
                    },
                );

                ctx.abortSignal?.throwIfAborted();
                this.#requirePost(id, pinned);
                const receipt: PipReviewReceipt = {
                    fingerprint,
                    episode: actual.episode,
                    conversationId: Number(id),
                    threadId: posted.id,
                    commentId: posted.id,
                    path: args.path,
                    side: args.side,
                    line: args.line,
                    ...(args.startLine === undefined ? {} : { startLine: args.startLine }),
                    text: args.text.trim(),
                    context: args.context,
                    observation,
                    origin: {
                        role: "reviewer",
                        requesterId: actual.requesterId,
                        taskId: Number(api.taskId),
                        callId: api.callId,
                        generationId: actual.generationId,
                        provider: actual.provider,
                        model: actual.model,
                    },
                    at: this.#app.now(),
                };

                doc.receipts[key] = receipt;

                return reference(receipt);
            }, ctx);
        });
    }

    #source(id: ConversationId, pinned?: Source): Source {
        const app = this.#app;

        if (id !== app.rootOf(id) || app.sessionMeta(id)?.threadType !== "reviewer") {
            throw new HttpError(403, "Only the active main Reviewer may publish PiP diff comments");
        }

        app.workItems.requireWritable(id);
        const requesterId = requireWorkflowRequester(app, id);
        const user = app.config.userById(requesterId)!;
        const source: Source = {
            conversationId: Number(id),
            requesterId,
            authority: authority(user),
            cwd: app.cwdOf(id),
            location: JSON.stringify(app.locationOf(id) ?? null),
            projectId: app.sessionMeta(id)?.projectId ?? null,
        };

        if (
            pinned !== undefined &&
            (Object.keys(source) as (keyof Source)[]).some((key) => source[key] !== pinned[key])
        ) {
            throw new HttpError(
                409,
                "The Reviewer requester or destination changed; no comment was posted",
            );
        }

        return source;
    }

    #user(id: ConversationId, pinned: Source): User {
        this.#source(id, pinned);

        return structuredClone(this.#app.config.userById(pinned.requesterId)!);
    }

    #requirePost(id: ConversationId, pinned: Source): void {
        this.#source(id, pinned);

        if (!this.#app.config.pipEnabled) {
            throw new HttpError(409, "PiP is paused; no new service comments may be posted");
        }
    }

    async #admit(tx: Tx, api: ToolExecutionApi, pinned: Source): Promise<Invocation> {
        const id = api.conversationId;
        const live = await tx.doc(LiveDoc, id);
        const task = await tx.task(api.taskId);

        if (
            live.run === undefined ||
            live.run.inputs[0] === undefined ||
            task?.kind !== ToolTask.definition.name ||
            task.conversationId !== id ||
            task.state.status !== "running" ||
            task.abortRequested
        ) {
            throw new HttpError(403, "A review comment requires its current main tool invocation");
        }

        let current = task;
        const seen = new Set<number>();

        while (current.id !== live.run.taskId) {
            if (seen.has(Number(current.id)) || seen.size >= 32 || current.owner === undefined) {
                throw new HttpError(
                    403,
                    "The review invocation does not belong to the current main run",
                );
            }

            seen.add(Number(current.id));
            const owner = await tx.task(current.owner);

            if (
                owner === undefined ||
                owner.conversationId !== id ||
                owner.abortRequested ||
                owner.state.status === "terminal" ||
                owner.state.status === "completing"
            ) {
                throw new HttpError(403, "The Reviewer's owning run is no longer active");
            }

            current = owner;
        }

        const input = task.input as { assistant?: unknown; callId?: unknown };

        if (
            current.kind !== GenerationTask.definition.name ||
            typeof input.assistant !== "number" ||
            typeof input.callId !== "string" ||
            !live.tools?.some((slot) => slot.taskId === task.id && slot.callId === input.callId)
        ) {
            throw new HttpError(403, "The finding has no current Reviewer generation provenance");
        }

        const entry = await tx.entry(input.assistant as EntryId);
        const message = entry?.model?.[0];
        const call =
            message?.role === "assistant"
                ? message.content.find(
                      (part) => part.type === "toolCall" && part.id === input.callId,
                  )
                : undefined;
        const direct =
            api.callId === input.callId &&
            call?.type === "toolCall" &&
            call.name === "review_comment";
        const nested =
            call?.type === "toolCall" &&
            call.name === "codemode" &&
            api.callId.startsWith(`${input.callId}/`) &&
            /^[1-9]\d*$/.test(api.callId.slice(input.callId.length + 1));

        if (
            entry?.kind !== "pi.assistant" ||
            entry.conversationId !== id ||
            entry.byTaskId !== current.id ||
            message?.role !== "assistant" ||
            typeof message.provider !== "string" ||
            typeof message.model !== "string" ||
            (!direct && !nested)
        ) {
            throw new HttpError(403, "The finding must originate in the actual Reviewer tool call");
        }

        const admitted: Invocation = {
            ...this.#source(id, pinned),
            episode: Number(live.run.inputs[0]),
            generationId: Number(current.id),
            provider: message.provider,
            model: message.model,
        };

        const original = pinned as Partial<Invocation>;

        if (
            original.episode !== undefined &&
            (admitted.episode !== original.episode ||
                admitted.generationId !== original.generationId ||
                admitted.provider !== original.provider ||
                admitted.model !== original.model)
        ) {
            throw new HttpError(
                409,
                "The pinned Reviewer invocation changed; no comment was posted",
            );
        }

        return admitted;
    }

    async #yieldReferences(api: HookApi, ctx: Context): Promise<PipDiffComment[]> {
        const id = api.conversationId;
        let source: Source;

        try {
            source = this.#source(id);
        } catch {
            return [];
        }

        const live = await api.snapshot(LiveDoc, id, ctx);

        if (live?.run?.taskId !== api.taskId || live.run.inputs[0] === undefined) {
            return [];
        }

        const episode = Number(live.run.inputs[0]);
        const doc = await api.snapshot(PipReviewCommentsDoc, id, ctx);
        const current = await api.snapshot(LiveDoc, id, ctx);

        if (current?.run?.taskId !== api.taskId || Number(current.run.inputs[0]) !== episode) {
            return [];
        }

        try {
            this.#source(id, source);
        } catch {
            return [];
        }

        return Object.values(doc?.receipts ?? {})
            .filter(
                (receipt) => receipt.episode === episode && receipt.conversationId === Number(id),
            )
            .sort((a, b) => a.at - b.at || a.commentId.localeCompare(b.commentId))
            .map((receipt) => reference(receipt, 280));
    }
}
