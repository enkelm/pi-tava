/** Requester-bound public work reads for shared PiP. Never the private assistant's authority or tool registry. */
import { Type, type Tool, type ToolCall } from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import type { Context } from "@earendil-works/chord";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { PocketApp } from "../app.ts";
import type { User } from "../config.ts";
import type { ClientEntry } from "../projection.ts";
import { ChatDoc } from "../docs.ts";
import { HttpError } from "../errors.ts";

export const sharedContextTool: Tool = {
    name: "work_context",
    description:
        "Read the current shared work, without changing it. status shows the thread, project, workflow and visible Work Item threads. thread reads public coding-agent history (before paginates, query filters literal text). discussion reads human chat/review discussions. files discovers paths (query filters names); file reads current UTF-8 code with line numbers (startLine/limit paginate, query finds text). changes/diff inspect current Changes (startLine/limit also page diff lines). threadId defaults to the source and may name only a visible thread in this same Work Item. All paths are relative to that thread's folder. No private PiP, arbitrary sessions, shell, writes or external access.",
    parameters: Type.Object(
        {
            action: Type.Union(
                ["status", "thread", "discussion", "files", "file", "changes", "diff"].map(
                    (action) => Type.Literal(action),
                ),
            ),
            threadId: Type.Optional(Type.Integer({ minimum: 1 })),
            path: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
            query: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
            before: Type.Optional(Type.Integer({ minimum: 1 })),
            startLine: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000_000 })),
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        },
        { additionalProperties: false },
    ),
};

type ReadInput = {
    action: string;
    threadId?: number;
    path?: string;
    query?: string;
    before?: number;
    startLine?: number;
    limit?: number;
};

/** Only public display text is eligible: no system prompts, thinking blocks, tool details or raw entry metadata. */
function publicEntry(entry: ClientEntry) {
    const text =
        entry.kind === "assistant"
            ? entry.blocks.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
            : "text" in entry
              ? (entry.text ?? "")
              : entry.kind === "compaction"
                ? entry.summary
                : "";

    return {
        id: entry.id,
        kind: entry.kind,
        text: text.slice(0, 4000),
        ...(text.length > 4000 ? { truncated: true } : {}),
    };
}

export class PipSharedContext {
    readonly #app: PocketApp;
    readonly #source: ConversationId;
    readonly #authorize: () => Promise<User>;
    readonly #context: Context;
    readonly #destinations = new Map<number, string>();

    constructor(
        app: PocketApp,
        source: ConversationId,
        authorize: () => Promise<User>,
        context: Context,
    ) {
        this.#app = app;
        this.#source = source;
        this.#authorize = authorize;
        this.#context = context;
    }

    async #target(requested?: number) {
        const user = await this.#authorize();
        const id = (requested ?? Number(this.#source)) as ConversationId;
        const app = this.#app;
        const allowed = app.workItems.context(this.#source, user).workItem?.threadIds ?? [];
        const root = app.rootOf(id);
        const meta = app.sessionMeta(root);

        app.requireSee(user, id);

        if (
            !meta ||
            meta.pip !== undefined ||
            meta.ownerOnly ||
            app.pip.isInternal(id) ||
            (root !== app.rootOf(this.#source) && !allowed.includes(Number(root)))
        ) {
            throw new HttpError(404, "That thread is outside this shared work");
        }

        const destination = JSON.stringify([app.cwdOf(id), app.locationOf(id), meta.projectId]);
        const pinned = this.#destinations.get(Number(id));

        if (pinned !== undefined && destination !== pinned) {
            throw new HttpError(409, "The work's destination changed during this answer");
        }

        this.#destinations.set(Number(id), destination);
        this.#context.abortSignal?.throwIfAborted();

        return { id, user };
    }

    async summary() {
        const { id, user } = await this.#target();
        const app = this.#app;
        const root = app.rootOf(id);
        const meta = app.sessionMeta(root)!;
        const { workflow, workItem } = app.workItems.context(id, user);
        const members = new Set(workItem?.threadIds ?? [Number(root)]);
        const threads = app
            .sessions(user)
            .filter((thread) => members.has(thread.id))
            .slice(0, 12);
        const project = app.projects
            .list(user)
            .projects.find((entry) => entry.id === meta.projectId);

        return {
            thread: {
                id: Number(id),
                title: (await app.conversationTitle(id)).slice(0, 200),
                type: meta.threadType ?? "worker",
            },
            ...(project ? { project: { id: project.id, name: project.name.slice(0, 200) } } : {}),
            workflow: {
                status: workflow.status,
                readOnly: workflow.readOnly,
                paused: workflow.paused,
                preparing: workflow.preparing,
            },
            workItem: workItem
                ? {
                      id: workItem.id,
                      title: workItem.title.slice(0, 300),
                      activeThreadId: workItem.activeThreadId,
                      originThreadId: workItem.originThreadId,
                      threads: threads.map((thread) => ({
                          id: thread.id,
                          title: (thread.title ?? "Thread").slice(0, 120),
                          type: thread.threadType,
                      })),
                      truncated: workItem.threadIds.length > threads.length,
                  }
                : null,
        };
    }

    async initial() {
        const summary = await this.summary();
        const page = await this.#app.transcripts.page(this.#source, { limit: 8 }, this.#context);

        await this.#target();

        return { ...summary, transcript: page.entries.map(publicEntry), before: page.before };
    }

    async read(call: ToolCall): Promise<unknown> {
        const input = validateToolArguments(sharedContextTool, call) as ReadInput;
        const { id, user } = await this.#target(input.threadId);
        const app = this.#app;
        let result: unknown;

        switch (input.action) {
            case "status":
                // Work Item identity is always rooted at the actual question, not a model-selected destination.
                result = await this.summary();
                break;

            case "thread": {
                const page = await app.transcripts.page(
                    id,
                    { before: input.before, limit: input.limit ?? 20 },
                    this.#context,
                );
                const entries = page.entries.map(publicEntry);

                result = {
                    ...page,
                    entries: input.query
                        ? entries.filter((entry) =>
                              entry.text.toLowerCase().includes(input.query!.toLowerCase()),
                          )
                        : entries,
                };
                break;
            }

            case "discussion": {
                const chat = await app.harness.snapshot(ChatDoc, id, this.#context);
                const reviews = await app.reviews.list(id, user);
                const messages = (chat?.messages ?? []).filter((entry) => entry.kind !== "event");

                result = {
                    chat: messages
                        .slice(-(input.limit ?? 12))
                        .map(({ name, text }) => ({ name, text })),
                    reviews: reviews.threads.slice(-(input.limit ?? 8)).map((thread) => ({
                        id: thread.id,
                        name: thread.name,
                        text: thread.text,
                        path: thread.path,
                        side: thread.side,
                        startLine: thread.startLine,
                        line: thread.line,
                        context: thread.context,
                        resolved: thread.resolved,
                        replies: thread.replies.slice(-6).map(({ name, text }) => ({ name, text })),
                    })),
                };
                break;
            }

            case "files": {
                const listing = await app.workspace.sourceFiles(id, user, this.#context);
                const matching = listing.files.filter(
                    (path) =>
                        !input.query || path.toLowerCase().includes(input.query.toLowerCase()),
                );

                result = {
                    files: matching.slice(0, input.limit ?? 80),
                    truncated: listing.truncated || matching.length > (input.limit ?? 80),
                };
                break;
            }

            case "file": {
                const path = input.path ?? "";
                const { text, revision } = await app.workspace.sourceFile(
                    id,
                    user,
                    path,
                    this.#context,
                );
                const lines = text.replace(/\r\n/g, "\n").split("\n");
                const start = (input.startLine ?? 1) - 1;
                const matching = lines.flatMap((text, index) =>
                    index >= start &&
                    (!input.query || text.toLowerCase().includes(input.query.toLowerCase()))
                        ? [{ line: index + 1, text }]
                        : [],
                );
                const selected = matching.slice(0, input.limit ?? 80);

                result = {
                    path,
                    revision,
                    lines: selected,
                    nextLine:
                        matching.length > selected.length ? selected.at(-1)!.line + 1 : undefined,
                };
                break;
            }

            case "changes": {
                const changes = await app.reviews.changes(id, user, this.#context);
                const matches = changes.files.filter(
                    (file) =>
                        !input.query || file.path.toLowerCase().includes(input.query.toLowerCase()),
                );
                const files = matches.slice(0, input.limit ?? 60);

                result = {
                    ...changes,
                    files,
                    piOnly: changes.piOnly.slice(0, input.limit ?? 60),
                    more: changes.more + matches.length - files.length,
                };
                break;
            }

            case "diff": {
                const path = app.workspace.sourcePath(input.path);
                const lines = (await app.reviews.diff(id, user, path, this.#context)).split("\n");
                const start = (input.startLine ?? 1) - 1;
                const end = Math.min(lines.length, start + (input.limit ?? 80));

                result = {
                    path,
                    diff: lines.slice(start, end).join("\n"),
                    startLine: start + 1,
                    nextLine: end < lines.length ? end + 1 : undefined,
                };
                break;
            }

            default:
                throw new HttpError(400, "Unknown shared work read");
        }

        await this.#target(Number(id));

        return result;
    }
}
