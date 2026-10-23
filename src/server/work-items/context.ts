/** Source-bound project/Work Item reads shared by private PiP and the read-only mention adapter. */
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
        "Read the source and its actually bound work, without changing it. status shows the source, actual project, workflow and visible project/Work Item threads. thread reads visible human/assistant text (before paginates, query filters literal text), never tool results, prompts or thinking. discussion reads recent chat and pages review threads (pass reviewPage.before until null; reviewPage counts all/omitted/unresolved threads, chatOmitted and omittedReplies disclose other truncation; query is not supported). files discovers paths (query filters names); file reads current UTF-8 code with line numbers (startLine/limit paginate, query finds text). changes/diff inspect current Changes (startLine/limit also page diff lines). threadId defaults to the actual source. Collaborator mentions may name visible non-private threads in that same project or Work Item; private PiP work reads stay in the source Work Item. A private named-agent source permits its own history/discussion only unless actually bound to project/work, never sibling chats, Memory or a project inferred from remit/name/folder. All paths are relative to the target thread's folder. No arbitrary sessions, shell, writes or external access.",
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

/** Visible conversation text only: tool results/commands and derived summaries may contain private Memory or secrets. */
function publicEntry(entry: ClientEntry) {
    if (
        entry.kind !== "assistant" &&
        entry.kind !== "user" &&
        entry.kind !== "note" &&
        entry.kind !== "agentAnswer" &&
        entry.kind !== "pipQuestion"
    ) {
        return [];
    }

    const text =
        entry.kind === "assistant"
            ? entry.blocks.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
            : entry.text;

    return [
        {
            id: entry.id,
            kind: entry.kind,
            text: text.slice(0, 4000),
            ...(text.length > 4000 ? { truncated: true } : {}),
        },
    ];
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

    #members(user: User): Set<number> {
        const app = this.#app;
        const root = app.rootOf(this.#source);
        const meta = app.sessionMeta(root);
        const members = new Set(
            app.workItems.context(this.#source, user).workItem?.threadIds ?? [],
        );

        members.add(Number(root));

        if (
            this.#audience === "shared" &&
            meta?.projectId !== undefined &&
            app.projects.canAccessThread(user, meta)
        ) {
            for (const thread of app.sessions(user)) {
                const target = app.sessionMeta(thread.id as ConversationId);

                if (
                    target?.projectId === meta.projectId &&
                    app.projects.canAccessThread(user, target)
                ) {
                    members.add(thread.id);
                }
            }
        }

        return members;
    }

    #eligible(id: ConversationId, user: User): boolean {
        const app = this.#app;
        const root = app.rootOf(id);
        const meta = app.sessionMeta(root);

        if (!meta || !app.canSee(user, id) || app.pip.isInternal(id)) {
            return false;
        }

        if (meta.pip !== undefined || meta.pipAgent === true || meta.pipWorkItemId !== undefined) {
            return (
                this.#audience === "shared" &&
                id === this.#source &&
                id === root &&
                user.role === "owner" &&
                app.pip.agents.scope(root)?.ownerId === user.id
            );
        }

        return this.#audience !== "shared" || !meta.ownerOnly;
    }

    async #target(requested?: number) {
        const user = await this.#authorize();
        const id = (requested ?? Number(this.#source)) as ConversationId;
        const app = this.#app;
        const allowed = this.#members(user);
        const root = app.rootOf(id);
        const meta = app.sessionMeta(root);

        app.requireSee(user, id);

        if (
            !meta ||
            !this.#eligible(id, user) ||
            !allowed.has(Number(root)) ||
            (app.sessionMeta(app.rootOf(this.#source))?.pip !== undefined &&
                root === app.rootOf(this.#source) &&
                id !== this.#source)
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
        const members = this.#members(user);
        const visible = app
            .sessions(user)
            .filter(
                (thread) =>
                    members.has(thread.id) && this.#eligible(thread.id as ConversationId, user),
            );
        const threads = visible.slice(0, 12);
        const itemThreads = visible
            .filter((thread) => workItem?.threadIds.includes(thread.id))
            .slice(0, 12);
        const project = app.projects
            .list(user)
            .projects.find((entry) => entry.id === meta.projectId);
        const active = (workItem?.activeThreadId ?? Number(root)) as ConversationId;
        const routes =
            this.#audience === "private" ? await app.workItems.list(active, user) : undefined;
        const currentType = app.sessionMeta(active)?.threadType ?? "worker";
        const role = app.workItems.profile(currentType);
        const history = (workItem?.threadIds ?? [Number(root)])
            .filter((member) => this.#eligible(member as ConversationId, user))
            .slice(-12)
            .map((member) => ({
                id: member,
                type: app.sessionMeta(member as ConversationId)?.threadType ?? "worker",
            }));

        const title = (await app.conversationTitle(id)).slice(0, 200);

        await this.#target();

        return {
            thread: {
                id: Number(id),
                title,
                type: meta.threadType ?? "worker",
            },
            ...(project
                ? {
                      project: {
                          id: project.id,
                          name: project.name.slice(0, 200),
                          ...(this.#audience === "shared"
                              ? {
                                    threads: threads.map((thread) => ({
                                        id: thread.id,
                                        title: (thread.title ?? "Thread").slice(0, 120),
                                        type: thread.threadType,
                                    })),
                                    truncated: visible.length > threads.length,
                                }
                              : {}),
                      },
                  }
                : {}),
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
                          historyOmitted: (workItem?.threadIds.length ?? 1) - history.length,
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
                      threads: itemThreads.map((thread) => ({
                          id: thread.id,
                          title: (thread.title ?? "Thread").slice(0, 120),
                          type: thread.threadType,
                      })),
                      truncated: workItem.threadIds.length > itemThreads.length,
                  }
                : null,
        };
    }

    async initial() {
        const summary = await this.summary();
        const page = await this.#app.transcripts.page(this.#source, { limit: 8 }, this.#context);

        await this.#target();

        return { ...summary, transcript: page.entries.flatMap(publicEntry), before: page.before };
    }

    async read(call: ToolCall): Promise<unknown> {
        const input = validateToolArguments(sharedContextTool, call) as WorkReadInput;
        const { id, user } = await this.#target(input.threadId);
        const app = this.#app;
        const meta = app.sessionMeta(app.rootOf(id))!;

        if (
            meta.pip !== undefined &&
            meta.projectId === undefined &&
            meta.workItemId === undefined &&
            meta.pipWorkItemId === undefined &&
            ["files", "file", "changes", "diff"].includes(input.action)
        ) {
            throw new HttpError(404, "This private discussion has no bound workspace");
        }

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
                const entries = page.entries.flatMap(publicEntry);

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
