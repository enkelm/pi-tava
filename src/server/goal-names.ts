/**
 * Names new project goals from their first worker message. Naming is a background durable task, independent of the
 * worker's answer; the name, usage and task completion commit together. A manual rename or a moved thread wins.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
    type ConversationId,
    type Cursor,
    defineTask,
    InboxDoc,
    type Task,
    type Tx,
    UsageDoc,
} from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import { ProjectsDoc, SessionsDoc } from "./docs.ts";
import { userContent } from "./resend.ts";
import { cleanTitle, titleModel } from "./titles.ts";

const context = BACKGROUND_CONTEXT;
const READ_CHARS = 3000;

export const GOAL_NAME_PROMPT =
    "You name project goals. Reply with only a concise goal name of 3 to 6 words describing the work requested below: plain words, no quotes, no punctuation at the end, in the message's language.";

type NameInput = { goalId: string; text: string };
type NameUsage = {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
};
type NameResult = { title: string; modelKey: string | null; usage: NameUsage | null };

const finished = { status: "terminal", outcome: { status: "completed", result: null } } as const;

export class GoalNames {
    readonly #app: PocketApp;
    readonly task: Task<NameInput, { phase: "name" }, null, object>;

    constructor(app: PocketApp) {
        this.#app = app;
        this.task = defineTask<NameInput, { phase: "name" }, null>({
            name: "pocket.project-goal-name",
            version: 1,
            initial: () => ({ phase: "name" }),
            phases: {
                name: async (task, runtime, taskContext) => {
                    const id = runtime.conversationId;
                    let result = await runtime.memo<NameResult>("name", taskContext);

                    if (result === undefined) {
                        const projects = await runtime.snapshot(ProjectsDoc, taskContext);
                        const sessions = await runtime.snapshot(SessionsDoc, taskContext);
                        const goal = projects?.goals[task.input.goalId];

                        if (
                            goal === undefined ||
                            goal.named === true ||
                            goal.namingThreadId !== Number(id) ||
                            sessions?.items[String(id)]?.goalId !== goal.id
                        ) {
                            await runtime.commit(() => finished, taskContext);

                            return;
                        }

                        const fallback = cleanTitle(task.input.text) ?? "New goal";
                        let candidate: NameResult = {
                            title: fallback,
                            modelKey: null,
                            usage: null,
                        };
                        const agent = await app.agentState(id);
                        const current =
                            agent?.model === undefined
                                ? undefined
                                : app.models.getModel(agent.model.provider, agent.model.modelId);

                        if (current !== undefined && app.spend.heldBack(id) === undefined) {
                            try {
                                const model = titleModel(
                                    app.models.getAvailableSnapshot(),
                                    current,
                                );
                                const reply = await app.models.completeSimple(
                                    model,
                                    {
                                        messages: [
                                            {
                                                role: "user",
                                                content: [
                                                    {
                                                        type: "text",
                                                        text: `${GOAL_NAME_PROMPT}\n\n<message>\n${task.input.text.slice(0, READ_CHARS)}\n</message>`,
                                                    },
                                                ],
                                                timestamp: Date.now(),
                                            },
                                        ],
                                    },
                                    { maxTokens: 256, signal: runtime.signal },
                                );
                                const title = cleanTitle(
                                    reply.content
                                        .flatMap((part) =>
                                            part.type === "text" ? [part.text] : [],
                                        )
                                        .join(""),
                                );

                                candidate = {
                                    title:
                                        reply.stopReason === "error"
                                            ? fallback
                                            : (title ?? fallback),
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

                        result = await runtime.memo("name", candidate, taskContext);
                    }

                    const named = result;

                    await runtime.commit(async (tx) => {
                        if (named.usage !== null && named.modelKey !== null) {
                            const ledger = await tx.doc(UsageDoc, id);

                            ledger.models[named.modelKey] ??= {
                                input: 0,
                                output: 0,
                                cacheRead: 0,
                                cacheWrite: 0,
                                totalTokens: 0,
                                cost: {
                                    input: 0,
                                    output: 0,
                                    cacheRead: 0,
                                    cacheWrite: 0,
                                    total: 0,
                                },
                            };
                            const usage = ledger.models[named.modelKey]!;

                            for (const field of [
                                "input",
                                "output",
                                "cacheRead",
                                "cacheWrite",
                                "totalTokens",
                            ] as const) {
                                usage[field] += named.usage[field];
                            }

                            for (const field of [
                                "input",
                                "output",
                                "cacheRead",
                                "cacheWrite",
                                "total",
                            ] as const) {
                                usage.cost[field] += named.usage.cost[field];
                            }
                        }

                        await app.projects.nameGoal(tx, id, named.title, task.input.goalId);

                        return finished;
                    }, taskContext);
                },
            },
            abort: (_task, runtime, taskContext) =>
                runtime.commit(
                    () => ({ status: "terminal", outcome: { status: "aborted" } }),
                    taskContext,
                ),
        });
    }

    /** Reserve the first worker's naming task in the same commit as its initial title. */
    async schedule(tx: Tx, id: ConversationId, text: string): Promise<void> {
        if (text.trim() === "") {
            return;
        }

        const sessions = await tx.doc(SessionsDoc);
        const projects = await tx.doc(ProjectsDoc);
        const meta = sessions.items[String(id)];
        const goal = meta?.goalId === undefined ? undefined : projects.goals[meta.goalId];

        if (
            goal === undefined ||
            goal.named === true ||
            goal.namingThreadId !== Number(id) ||
            goal.namingTaskId !== undefined
        ) {
            return;
        }

        const taskId = await tx.createTask(
            this.task,
            { goalId: goal.id, text: text.slice(0, READ_CHARS) },
            {
                conversationId: id,
                ownership: { kind: "conversation" },
                background: true,
            },
        );

        goal.namingTaskId = Number(taskId);
    }

    /** Read the durable first input, including a queued input, never a later caller's replacement text. */
    async firstMessage(id: ConversationId): Promise<string | undefined> {
        const app = this.#app;
        const meta = app.sessionMeta(id);

        if (meta?.goalId === undefined) {
            return undefined;
        }

        const projects = await app.harness.snapshot(ProjectsDoc, context);
        const goal = projects?.goals[meta.goalId];

        if (
            goal === undefined ||
            goal.named === true ||
            goal.namingThreadId !== Number(id) ||
            goal.namingTaskId !== undefined
        ) {
            return undefined;
        }

        const conversation = await app.harness.conversation(id, context);
        let cursor: Cursor | undefined;
        let text = "";

        if (conversation !== undefined) {
            do {
                const page = await conversation.entries(
                    { order: "ascending" },
                    128,
                    cursor,
                    context,
                );
                const entry = page.items.find((item) => item.kind === "pi.user");

                if (entry !== undefined) {
                    text = userContent(entry.model?.[0]).text;
                    break;
                }

                cursor = page.next;
            } while (cursor !== undefined);
        }

        if (text === "") {
            const inbox = await app.harness.snapshot(InboxDoc, id, context);
            const queued = inbox?.items.find((item) => item.mode !== "write");

            if (queued !== undefined) {
                text = userContent({ content: queued.content }).text;
            }
        }

        text = text.replace(/^\[from: [^\]]+\]\s*/, "").replace(/^\[scheduled\]\s*/, "");

        return text.trim() === "" ? undefined : text;
    }

    /** Called after non-UI admissions too; reservation and task creation remain one durable commit. */
    async admitted(id: ConversationId): Promise<void> {
        const text = await this.firstMessage(id);

        if (text !== undefined) {
            await this.#app.harness.commit((tx) => this.schedule(tx, id, text), context);
        }
    }

    /** Repair an admission cut off before the naming task was reserved; untouched empty workers stay unnamed. */
    async recover(): Promise<void> {
        const app = this.#app;
        const projects = await app.harness.snapshot(ProjectsDoc, context);
        const pending = Object.values(projects?.goals ?? {}).filter(
            (goal) =>
                goal.named !== true &&
                goal.namingTaskId === undefined &&
                goal.namingThreadId !== undefined,
        );

        if (pending.length === 0) {
            return;
        }

        for (const goal of pending) {
            const id = goal.namingThreadId as ConversationId;
            const meta = app.sessionMeta(id);

            if (meta?.goalId !== goal.id) {
                continue;
            }

            await this.admitted(id);
        }
    }
}
