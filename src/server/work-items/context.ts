/** Source-bound Work Item reads shared by private PiP and the read-only mention adapter. */
import { Type, type Tool, type ToolCall } from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import type { Context } from "@earendil-works/chord";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { PocketApp } from "../app.ts";
import type { User } from "../config.ts";
import type { ClientEntry } from "../projection.ts";
import { ChatDoc } from "../docs.ts";
import { HttpError } from "../errors.ts";

export const workContextParameters = Type.Object(
    {
        action: Type.Union(
            ["status", "thread", "discussion", "files", "file", "changes", "diff"].map((action) =>
                Type.Literal(action),
            ),
        ),
        threadId: Type.Optional(Type.Integer({ minimum: 1 })),
        path: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
        query: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
        before: Type.Optional(
            Type.Integer({
                minimum: 1,
                description:
                    "thread: transcript cursor. discussion: exclusive 1-based review creation position; pass reviewPage.before for older threads (not chat).",
            }),
        ),
        startLine: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000_000 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    },
    { additionalProperties: false },
);

export const sharedContextTool: Tool = {
    name: "work_context",
    description:
        "Read the current shared work, without changing it. status shows the thread, project, workflow and visible Work Item threads. thread reads public coding-agent history (before paginates, query filters literal text). discussion reads recent chat and pages review threads (pass reviewPage.before until null; reviewPage counts all/omitted/unresolved threads, chatOmitted and omittedReplies disclose other truncation; query is not supported). files discovers paths (query filters names); file reads current UTF-8 code with line numbers (startLine/limit paginate, query finds text). changes/diff inspect current Changes (startLine/limit also page diff lines). threadId defaults to the source and may name only a visible thread in this same Work Item. All paths are relative to that thread's folder. No private PiP, arbitrary sessions, shell, writes or external access.",
    parameters: workContextParameters,
};

export type WorkReadInput = {
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

export class WorkContext {
    readonly #app: PocketApp;
    readonly #source: ConversationId;
    readonly #authorize: () => Promise<User>;
    readonly #context: Context;
    readonly #audience: "shared" | "private";
    readonly #destinations = new Map<number, string>();

    constructor(
        app: PocketApp,
        source: ConversationId,
        authorize: () => Promise<User>,
        context: Context,
        audience: "shared" | "private",
    ) {
        this.#app = app;
        this.#source = source;
        this.#authorize = authorize;
        this.#context = context;
        this.#audience = audience;
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
            (this.#audience === "shared" && meta.ownerOnly) ||
            app.pip.isInternal(id) ||
            (root !== app.rootOf(this.#source) && !allowed.includes(Number(root)))
        ) {
            throw new HttpError(404, "That thread is outside this work");
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
        const active = (workItem?.activeThreadId ?? Number(root)) as ConversationId;
        const routes =
            this.#audience === "private" ? await app.workItems.list(active, user) : undefined;
        const currentType = app.sessionMeta(active)?.threadType ?? "worker";
        const role = app.workItems.profile(currentType);
        const history = [...members].slice(-12).map((member) => ({
            id: member,
            type: app.sessionMeta(member as ConversationId)?.threadType ?? "worker",
        }));

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
                ...(routes === undefined
                    ? {}
                    : {
                          activeThreadId: Number(active),
                          currentType,
                          ...(role === undefined
                              ? {}
                              : { role: { name: role.name, description: role.description } }),
                          history,
                          historyOmitted: members.size - history.length,
                          options: routes.options,
                          ...(routes.diffReason === undefined
                              ? {}
                              : { diffReason: routes.diffReason }),
                      }),
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
        const input = validateToolArguments(sharedContextTool, call) as WorkReadInput;
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
                if (input.query !== undefined) {
                    throw new HttpError(
                        400,
                        "discussion does not support query; omit it and use reviewPage.before to read older review threads",
                    );
                }

                const chat = await app.harness.snapshot(ChatDoc, id, this.#context);
                const reviews = await app.reviews.list(id, user);
                const messages = (chat?.messages ?? []).filter((entry) => entry.kind !== "event");
                const recentChat = messages.slice(-(input.limit ?? 12));
                // Reviews appends threads without reordering/removing them. Creation positions stay
                // stable across new comments, replies and resolution changes between page requests.
                const end = Math.min(reviews.threads.length, (input.before ?? Infinity) - 1);
                const start = Math.max(0, end - (input.limit ?? 8));
                const threads = reviews.threads.slice(start, end);
                const unresolved = reviews.threads.filter((thread) => !thread.resolved).length;

                result = {
                    chat: recentChat.map(({ name, text }) => ({ name, text })),
                    chatOmitted: messages.length - recentChat.length,
                    reviewPage: {
                        total: reviews.threads.length,
                        unresolved,
                        omitted: reviews.threads.length - threads.length,
                        omittedUnresolved:
                            unresolved - threads.filter((thread) => !thread.resolved).length,
                        before: start > 0 ? start + 1 : null,
                    },
                    reviews: threads.map((thread) => ({
                        id: thread.id,
                        userId: thread.userId,
                        name: thread.name,
                        service: thread.service,
                        onBehalfOf: thread.onBehalfOf,
                        text: thread.text,
                        path: thread.path,
                        side: thread.side,
                        startLine: thread.startLine,
                        line: thread.line,
                        context: thread.context,
                        resolved: thread.resolved,
                        resolution: thread.resolution,
                        omittedReplies: Math.max(0, thread.replies.length - 6),
                        replies: thread.replies
                            .slice(-6)
                            .map(({ id, name, text, service, onBehalfOf }) => ({
                                id,
                                name,
                                text,
                                service,
                                onBehalfOf,
                            })),
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
