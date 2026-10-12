/**
 * Persistent background subagents, after Pi Durable's example 23. One `subagent` tool spawns named subagents,
 * messages them, stops them, and lists them. Each subagent is its own conversation, so a user can open it, watch it
 * work, and talk to it. Their answers go back to the parent at its next pause: after a tool call, or, when it is idle,
 * a moment after. Answers that arrive meanwhile wait together, and go as one message, so many subagents cost the
 * parent one extra turn at most rather than one each, and its queue holds one message of theirs at a time.
 *
 * Everything survives a restart: anchors, reporters, and the courier that delivers reports are durable tasks, and
 * request IDs keep a restarted task from delivering a message or a report twice.
 *
 * Subagents retain Coop's explicit model selection and nearest-supported thinking levels. A nonempty owner model
 * list limits additional choices; the default empty list retains the existing unrestricted selection. A model or
 * provider failure is reported to Pi and the user, never silently retried on another model.
 */
import type { AssistantMessage, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { clampThinkingLevel, Type } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/chord";
import {
    AgentDoc,
    AssistantEntry,
    type ConversationId,
    configure,
    defineExtension,
    defineTask,
    defineTool,
    type Extension,
    InboxDoc,
    LiveDoc,
    type ModelRef,
    section,
    type SubmissionId,
    type SubmissionRecord,
    type TaskRuntime,
    type Tx,
} from "@earendil-works/pi-durable";
import { type PendingReport, REPORT_PREFIX, SubagentsDoc } from "../docs.ts";
import { describe } from "../errors.ts";
import type { PocketHost } from "../host.ts";
import { THINKING_LEVELS } from "../models.ts";
import { requestFor } from "../requests.ts";
import { whyUnanswered } from "../subagent-runs.ts";

// Exclude Agent Teams by name even while it is off; enabling it later must not give nested agents delegation.
const AgentTeams = defineExtension({ name: "pocket-agent-teams" });

function textOf(message: AssistantMessage | undefined): string {
    return (message?.content ?? [])
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("");
}

/** Why a report says its subagent went idle: its run ended without taking the message, and none will. */
const IDLE = "went idle without taking the message; send it again";
/** Stored atomically with queue removal, so a restarted reporter can distinguish withdrawal from Stop. */
const IDLE_WITHDRAWAL = "pocket.subagent-idle-withdrawal";

/**
 * A subagent's conversation is owned by an anchor: a background task that finishes at once. Background tasks are a
 * boundary, so the parent's Esc and idle waits do not reach the subagent, while `abort({ background: true })` still does.
 */
const Anchor = defineTask<null, { phase: "done" }, null>({
    name: "pocket.subagent-anchor",
    version: 1,
    initial: () => ({ phase: "done" }),
    phases: {
        done: (_anchor, runtime, context) =>
            runtime.commit(
                () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
                context,
            ),
    },
    abort: (_anchor, runtime, context) =>
        runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

/** `requestedBy`: whom the parent worked for when it sent the message, whose work the subagent's then is. */
type ReporterInput = {
    name: string;
    conversationId: ConversationId;
    message: string;
    followUp: boolean;
    requestedBy?: string;
};
type ReporterState = { phase: "deliver" } | { phase: "report"; report?: string };

/** Delivers one message to a subagent, waits for the answer, and reports it to the parent, through `Courier`. */
function reporterFor(Courier: CourierTask, host: Pick<PocketHost, "notice">) {
    return defineTask<ReporterInput, ReporterState, null>({
        name: "pocket.subagent-reporter",
        version: 1,
        initial: () => ({ phase: "deliver" }),
        phases: {
            deliver: async (reporter, runtime, context) => {
                const { name, conversationId, message, followUp, requestedBy } = reporter.input;
                const subagent = (await runtime.conversation(conversationId, context))!;
                const request = {
                    type: "input",
                    content: message,
                    whenBusy: followUp ? "followUp" : "steer",
                } as const;
                const requestId =
                    requestedBy === undefined
                        ? `subagent:${reporter.id}`
                        : requestFor(requestedBy, `subagent-${reporter.id}`);
                const submission = await subagent.submit({ ...request, requestId }, context);
                // Pi Durable leaves a failed run's inbox alone, so a queued follow-up waits for a boundary that never
                // comes: once the subagent is idle with it still queued, withdraw it, which ends the wait below.
                const watch = await runtime.watchDoc(LiveDoc, conversationId, context);
                // The withdrawal under way, if any; stopping a watch leaves its current callback running.
                let withdrawing: Promise<unknown> = Promise.resolve();
                let settled: Awaited<ReturnType<typeof submission.wait>>;

                try {
                    if (watch !== undefined) {
                        const strand = async (live: NonNullable<typeof watch>["value"]) => {
                            if (live !== null && live.run === undefined) {
                                // Recheck the live state and exact queued input together: a watch may be stale.
                                const withdrawal = runtime.commit(async (tx) => {
                                    const current = await tx.submissionByRequest(
                                        conversationId,
                                        requestId,
                                    );
                                    const latest = await tx.doc(LiveDoc, conversationId);

                                    if (
                                        latest.run !== undefined ||
                                        current?.id !== submission.id ||
                                        current.type !== "input" ||
                                        current.status !== "queued"
                                    ) {
                                        return undefined;
                                    }

                                    const items = (await tx.doc(InboxDoc, conversationId)).items;
                                    const index = items.findIndex(
                                        (item) => item.id === submission.id,
                                    );

                                    if (index < 0) {
                                        return undefined;
                                    }

                                    tx.settleSubmission(submission.id, {
                                        status: "unanswered",
                                        reason: "aborted",
                                        detail: IDLE_WITHDRAWAL,
                                    });
                                    items.splice(index, 1);

                                    return undefined;
                                }, context);

                                withdrawing = withdrawal;
                                await withdrawal;
                            }
                        };

                        // A listener is never called inline, so the value it started on is this one's to check.
                        await strand(watch.value);
                        watch.start(strand);
                    }

                    settled = await submission.wait(context);
                } finally {
                    // On every way out, so no watch outlives the phase.
                    await watch?.stop();
                    // Join a withdrawal already under way before ending the phase. Its reason is durable, not a
                    // callback-local flag, and a failed withdrawal surfaces where it was made.
                    await withdrawing.catch(() => {});
                }

                const withdrawn =
                    settled.status === "unanswered" &&
                    settled.reason === "aborted" &&
                    settled.detail === IDLE_WITHDRAWAL;
                // A failure of its model or provider (a sign-in, a model that is gone, a quota): named, with the model.
                const modelFailed =
                    !withdrawn &&
                    settled.status === "unanswered" &&
                    modelFailure(settled.reason, settled.detail);
                const ran = modelFailed
                    ? (await runtime.snapshot(AgentDoc, conversationId, context))?.model
                    : undefined;
                const ranOn = ran === undefined ? "" : `${ran.provider}/${ran.modelId}: `;

                await runtime.commit(async (tx) => {
                    const next = (report?: string) =>
                        ({ status: "running", checkpoint: { phase: "report", report } }) as const;

                    const agent = (await tx.doc(SubagentsDoc, runtime.conversationId)).agents[name];

                    if (settled.status === "unanswered") {
                        const why = withdrawn
                            ? IDLE
                            : `${ranOn}${whyUnanswered(settled.reason, settled.detail)}`;

                        if (agent !== undefined) {
                            agent.answeredAt = Date.now();
                            agent.failed = true;
                            agent.error = why;
                        }

                        // Coop keeps an explicit Stop silent. Its own idle withdrawal is durable and must still
                        // report resend-needed, including when this reporter resumed after a restart.
                        if (settled.reason === "aborted" && !withdrawn) {
                            return next();
                        }

                        // Model/provider trouble tells Pi to stop and tell its person, not try another model.
                        return next(
                            `${REPORT_PREFIX}${name} failed: ${why}]${modelFailed ? ` ${MODEL_FAILED}` : ""}`,
                        );
                    }

                    if (settled.type !== "input") {
                        return next();
                    }

                    if (agent === undefined || agent.reported.includes(settled.answer)) {
                        return next();
                    }

                    agent.reported.push(settled.answer);
                    agent.answeredAt = Date.now();
                    agent.failed = false;
                    delete agent.error;
                    const answer = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0] as
                        AssistantMessage | undefined;

                    return next(
                        `${REPORT_PREFIX}${name} answered, no reply needed] ${textOf(answer)}`,
                    );
                }, context);

                // The people in the session see it at once, as well as in its report.
                if (modelFailed && settled.status === "unanswered") {
                    host.notice(
                        "warning",
                        `Subagent ${name} failed: ${ranOn}${whyUnanswered(settled.reason, settled.detail)}. Pi was told to stop and tell you, not to switch models.`,
                        runtime.conversationId,
                    );
                }
            },
            // The report waits with the others for the courier, which this starts when none is at work. A batch still in the
            // parent's queue takes it too: it is taken back out, and goes again with this one, so the queue holds one
            // message of reports, with all of them.
            report: (reporter, runtime, context) =>
                runtime.commit(async (tx) => {
                    const report = reporter.state.checkpoint.report;

                    // Before 0.12 a reporter sent its report itself, under this request: one stopped by a restart (an
                    // upgrade) after sending it, and before it ended, has nothing left to send.
                    const sentBefore =
                        report !== undefined &&
                        (await tx.submissionByRequest(
                            runtime.conversationId,
                            `subagent-report:${reporter.id}`,
                        )) !== undefined;

                    if (report !== undefined && !sentBefore) {
                        const id = runtime.conversationId;
                        const state = await tx.doc(SubagentsDoc, id);
                        // Reads first: a commit reads the tables only before it writes one.
                        const queued = await queuedBatch(tx, id, state.sending?.request);
                        const idle = !(await working(tx, state.courier));
                        const taken = queued === undefined ? [] : (state.sending?.reports ?? []);

                        if (queued !== undefined) {
                            await unqueue(tx, id, queued);
                            delete state.sending;
                        }

                        // Assigned whole: a document keeps its own copy of what is assigned to it.
                        state.outbox = [
                            ...taken,
                            ...(state.outbox ?? []),
                            { name: reporter.input.name, text: report },
                        ];

                        if (idle) {
                            state.courier = await tx.createTask(Courier, null, BACKGROUND);
                        }
                    }

                    return { status: "terminal", outcome: { status: "completed", result: null } };
                }, context),
        },
        abort: (_reporter, runtime, context) =>
            runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
    });
}

/** Tasks of a conversation that run beside its work: its Esc and idle waits do not reach them. */
const BACKGROUND = { ownership: { kind: "conversation" }, background: true } as const;

/**
 * What a provider says when the model or its account is the problem (a sign-in, a model that is gone or refused, a
 * quota or rate limit, an overload), not the request: a context that will not fit, say, is Pi's to work around.
 */
const PROVIDER_TROUBLE =
    /oauth|sign.?in|auth|api.?key|unauthori[sz]ed|forbidden|permission|\b(401|402|403|404|429|503|529)\b|not found|does not exist|no such model|not available|not configured|unsupported model|quota|rate.?limit|insufficient|billing|credit|usage limit|overloaded/i;

/** Whether a run ended unanswered because of its model or provider: no model to use, or the provider's trouble. */
function modelFailure(reason: string, detail: unknown): boolean {
    return (
        reason === "no_model" ||
        (reason === "model_error" && typeof detail === "string" && PROVIDER_TROUBLE.test(detail))
    );
}

/** What a report of a subagent its model failed tells Pi, after why. */
export const MODEL_FAILED =
    "Its model or provider failed. Do not start it again on another model, and do not work around it: stop, and tell the user what failed and why. Only the user chooses models, and signs in again.";

/** The submission of the batch `request`, while it waits in `conversationId`'s queue; undefined once it has left. */
async function queuedBatch(
    tx: Tx,
    conversationId: ConversationId,
    request: string | undefined,
): Promise<SubmissionId | undefined> {
    if (request === undefined) {
        return undefined;
    }

    const record = await tx.submissionByRequest(conversationId, request);

    return record?.status === "queued" ? record.id : undefined;
}

/** Take a waiting batch back out of the queue, as withdrawing it does, to send its reports again with more. */
async function unqueue(tx: Tx, conversationId: ConversationId, id: SubmissionId): Promise<void> {
    const items = (await tx.doc(InboxDoc, conversationId)).items;
    const index = items.findIndex((item) => item.id === id);

    if (index !== -1) {
        items.splice(index, 1);
    }

    tx.settleSubmission(id, { status: "unanswered", reason: "merged" });
}

/** Whether a task is there and can still take reports. */
async function working(tx: Tx, task: number | undefined): Promise<boolean> {
    if (task === undefined) {
        return false;
    }

    const status = (await tx.task(task as never))?.state.status;

    // One completing has taken its last reports already.
    return status === "pending" || status === "running" || status === "waiting";
}

/** Wait until the submission `id` has left `conversationId`'s queue: placed, withdrawn, or aborted. */
async function leftQueue(
    runtime: TaskRuntime<null, CourierState, null, object>,
    conversationId: ConversationId,
    id: SubmissionId,
    context: Context,
): Promise<void> {
    const queued = (value: { items?: readonly { id: SubmissionId }[] } | null) =>
        (value?.items ?? []).some((item) => item.id === id);
    const watch = await runtime.watchDoc(InboxDoc, conversationId, context);

    if (watch === undefined || !queued(watch.value)) {
        await watch?.stop();

        return;
    }

    try {
        await new Promise<void>((resolve, reject) => {
            watch.start(async (value) => {
                if (!queued(value)) {
                    resolve();
                }
            });
            // The watch ends with the invocation (a restart, say): the phase runs again then.
            void watch.closed.then(() => reject(new Error("The queue's watch ended")), reject);
        });
    } finally {
        await watch.stop();
    }
}

/**
 * `batch` and `text`: where an earlier build kept the batch, for a courier it left in "send". "hold": a spend limit
 * holds the reports back.
 */
type CourierState =
    | { phase: "gather" }
    | { phase: "next" }
    | { phase: "hold" }
    | { phase: "send"; batch?: number; text?: string };

/** What the courier asks Pi Pocket about spend limits. */
type Limits = Pick<PocketHost, "heldBack" | "onLimitsChanged" | "notice">;

type CourierTask = ReturnType<typeof courierFor>;

/**
 * How long reports a limit holds back wait before the courier looks again, at most: a changed limit wakes it at once,
 * and this catches the rest (someone else, with spend left, now pays there).
 */
const HOLD_MS = 30_000;

/** How long a courier that met something unexpected waits before it tries again. */
const RETRY_MS = 5_000;

/**
 * What became of the batch a courier took (`state.sending`), from its submission, settled in `state`: kept while it is
 * still to send or waits in the parent's queue; gone once Pi has it. Taken out of the queue before Pi had it, it is
 * gone if a person did that (the queue's ×, or Stop, which mark it `discarded`), and otherwise (a spend limit's stop, a
 * new context) its reports wait again, first.
 */
function settleBatch(
    state: { outbox?: PendingReport[]; sending?: { reports: PendingReport[]; discarded?: true } },
    record: SubmissionRecord | undefined,
): void {
    const sending = state.sending;

    if (sending === undefined || record === undefined || record.status === "queued") {
        return;
    }

    if (
        record.status === "unanswered" &&
        record.entry === undefined &&
        sending.discarded !== true
    ) {
        state.outbox = [...sending.reports, ...(state.outbox ?? [])];
    }

    delete state.sending;
}

/** Quiescence includes stranded batches, but not reports already placed or explicitly discarded. */
export async function hasPendingSubagentReports(tx: Tx, id: ConversationId): Promise<boolean> {
    const state = await tx.doc(SubagentsDoc, id);
    // Settlement only replaces these fields: a shallow view applies the courier's rules without changing storage.
    const pending = { outbox: state.outbox, sending: state.sending };
    const record =
        state.sending === undefined
            ? undefined
            : await tx.submissionByRequest(id, state.sending.request);

    settleBatch(pending, record);

    return (pending.outbox?.length ?? 0) > 0 || (pending.sending?.reports.length ?? 0) > 0;
}

/** How long a courier waits, for a parent that is idle, for more reports to go with the first. */
const GATHER_MS = 2_000;

/** Wait `ms`, or until `signal` ends the wait, as Pi Durable's own waits do. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();

    return new Promise((resolve, reject) => {
        const stop = () => {
            clearTimeout(timer);
            reject(signal.reason);
        };

        const timer = setTimeout(() => {
            signal.removeEventListener("abort", stop);
            resolve();
        }, ms);

        signal.addEventListener("abort", stop, { once: true });
    });
}

/**
 * Takes all the reports waiting and sends them to the parent as one message, to steer it at its next pause, or to wake
 * it when it is idle, after a moment for others. It sends the next ones only once that message has left the parent's
 * queue, so the queue holds one at a time; reports that arrive meanwhile join it there, or go in the next. It ends
 * when none are waiting. The batch it took stays in `sending` until it has left the queue, so a courier that stops
 * early loses none: the next sends it, once. While the parent's session, or whoever pays there, is past a spend limit,
 * the reports wait (saying why, in `held`) rather than start a turn nobody may pay for, and go once the limit is raised.
 */
function courierFor(limits: Limits) {
    // A server older than this module has neither: extension modules reload into the running server, while the
    // server's own part waits for a restart. Then nothing is held back, as before limits held reports.
    const { heldBack, onLimitsChanged } = limits as Partial<Limits>;
    const heldFor = (id: ConversationId) =>
        typeof heldBack === "function" ? heldBack(id) : undefined;

    const whenLimitsChange = (listener: () => void) =>
        typeof onLimitsChanged === "function" ? onLimitsChanged(listener) : () => {};

    // Couriers that said so already: a courier that keeps meeting a problem says it once.
    const told = new Set<string>();

    /**
     * Run a phase; if it meets something unexpected, say so once, wait, and start over from "gather" rather than end with the
     * reports left waiting (the next courier starts only with the next report). A fixed module reloads into the running
     * server, and the courier carries on with it.
     */
    const orRetry = async (
        courier: { id: string | number },
        runtime: TaskRuntime<null, CourierState, null, object>,
        context: Context,
        phase: () => Promise<void>,
    ) => {
        const signals = [runtime.signal, context.abortSignal].filter(
            (signal): signal is AbortSignal => signal !== undefined,
        );

        try {
            await phase();
        } catch (error) {
            if (signals.some((signal) => signal.aborted)) {
                throw error;
            }

            if (!told.has(String(courier.id))) {
                told.add(String(courier.id));
                limits.notice?.("warning", `Subagents' reports wait: ${describe(error)}`);
            }

            await pause(RETRY_MS, AbortSignal.any(signals));
            // From "gather", not the phase that failed: committing the same step again is no progress, which faults.
            await runtime.commit(
                () => ({ status: "running", checkpoint: { phase: "gather" } }),
                context,
            );
        }
    };

    return defineTask<null, CourierState, null>({
        name: "pocket.subagent-courier",
        version: 1,
        initial: () => ({ phase: "gather" }),
        phases: {
            // A parent that is idle would start a turn for the first report alone: subagents started together often finish
            // a moment apart, so it waits that moment for theirs. A busy parent takes the batch at its next pause, and
            // reports that come meanwhile join it in its queue.
            gather: async (_courier, runtime, context) => {
                const live = await runtime.snapshot(LiveDoc, runtime.conversationId, context);

                if (live?.run === undefined) {
                    // Ended by the invocation's signal, or the phase's own, as Pi Durable's waits are.
                    const signals = [runtime.signal, context.abortSignal].filter(
                        (signal): signal is AbortSignal => signal !== undefined,
                    );

                    await pause(GATHER_MS, AbortSignal.any(signals));
                }

                await runtime.commit(
                    () => ({ status: "running", checkpoint: { phase: "next" } }),
                    context,
                );
            },
            next: (courier, runtime, context) =>
                orRetry(courier, runtime, context, async () => {
                    await runtime.commit(async (tx) => {
                        const state = await tx.doc(SubagentsDoc, runtime.conversationId);
                        // Reads first: a commit reads the tables only before it writes one.
                        const record =
                            state.sending === undefined
                                ? undefined
                                : await tx.submissionByRequest(
                                      runtime.conversationId,
                                      state.sending.request,
                                  );

                        delete state.delivering;

                        // A batch an earlier courier sent that still waits in Pi's queue: see it leave first. It is
                        // Pi's already, whatever the limits say now.
                        if (record?.status === "queued") {
                            return { status: "running", checkpoint: { phase: "send" } };
                        }

                        settleBatch(state, record);

                        if (state.sending === undefined && (state.outbox ?? []).length === 0) {
                            delete state.courier;
                            delete state.held;

                            return {
                                status: "terminal",
                                outcome: { status: "completed", result: null },
                            };
                        }

                        // Past a spend limit, the parent may start no turn for them: they wait, and say why.
                        const held = heldFor(runtime.conversationId);

                        if (held !== undefined) {
                            if (state.held !== held) {
                                state.held = held;
                            }

                            return { status: "running", checkpoint: { phase: "hold" } };
                        }

                        delete state.held;

                        // A batch taken and not sent yet goes first, under its own id.
                        if (state.sending === undefined) {
                            const reports = state.outbox ?? [];
                            const batch = (state.batches ?? 0) + 1;

                            state.batches = batch;
                            state.outbox = [];
                            state.sending = {
                                request: `subagent-reports:${courier.id}:${batch}`,
                                reports,
                            };
                        }

                        return { status: "running", checkpoint: { phase: "send" } };
                    }, context);
                }),
            // Until a limit changes (the owner raised it) or a while passes, then look again.
            hold: async (_courier, runtime, context) => {
                const signals = [runtime.signal, context.abortSignal].filter(
                    (signal): signal is AbortSignal => signal !== undefined,
                );
                const changed = new AbortController();
                const stop = whenLimitsChange(() => changed.abort());

                try {
                    await pause(HOLD_MS, AbortSignal.any([...signals, changed.signal]));
                } catch (error) {
                    // A changed limit ends the wait early; anything else (the task stopping) is the task's to handle.
                    if (!changed.signal.aborted) {
                        throw error;
                    }
                } finally {
                    stop();
                }

                await runtime.commit(
                    () => ({ status: "running", checkpoint: { phase: "next" } }),
                    context,
                );
            },
            send: (courier, runtime, context) =>
                orRetry(courier, runtime, context, async () => {
                    const checkpoint = courier.state.checkpoint as Extract<
                        CourierState,
                        { phase: "send" }
                    >;
                    const parentId = runtime.conversationId;
                    const sending =
                        checkpoint.text === undefined
                            ? (await runtime.snapshot(SubagentsDoc, parentId, context))?.sending
                            : {
                                  request: `subagent-reports:${courier.id}:${checkpoint.batch}`,
                                  reports: [{ name: "", text: checkpoint.text }],
                              };

                    if (sending !== undefined) {
                        const parent = (await runtime.conversation(parentId, context))!;
                        // Under its own id: a batch sent before is not sent again, and its submission is what it was.
                        const submission = await parent.submit(
                            {
                                type: "input",
                                content: sending.reports.map((report) => report.text).join("\n\n"),
                                whenBusy: "steer",
                                requestId: sending.request,
                            },
                            context,
                        );

                        await leftQueue(runtime, parentId, submission.id, context);
                    }

                    await runtime.commit(async (tx) => {
                        const state = await tx.doc(SubagentsDoc, parentId);
                        // Reads first: a commit reads the tables only before it writes one.
                        const record =
                            sending === undefined
                                ? undefined
                                : await tx.submissionByRequest(parentId, sending.request);

                        if (
                            state.sending !== undefined &&
                            state.sending.request === sending?.request
                        ) {
                            settleBatch(state, record);
                        }

                        delete state.delivering;

                        return { status: "running", checkpoint: { phase: "next" } };
                    }, context);
                }),
        },
        // Stopped with its conversation: what waits, and the batch it took, stay for the next courier.
        abort: (_courier, runtime, context) =>
            runtime.commit(async (tx) => {
                delete (await tx.doc(SubagentsDoc, runtime.conversationId)).courier;

                return { status: "terminal", outcome: { status: "aborted" } };
            }, context),
    });
}

const GUIDE = `You can delegate to background subagents with the subagent tool. A subagent is a separate agent with its own transcript that works while you keep talking to the user; its answer comes back to you at your next pause (after a tool call, or when you are done) as a message starting with "${REPORT_PREFIX}<name> answered". Answers that arrive together come in one message. Use them for independent, self-contained work (research, long builds, test runs, a second opinion). Give each message everything the subagent needs: it does not see this conversation. Do not poll: wait for the report. The user can open a subagent and talk to it directly.
A subagent defaults to your model and thinking level. You may specify a model and thinking level for its task; unsupported thinking levels become the nearest supported level. If a subagent fails because of its model or provider (a sign-in, a missing model, a quota), stop and tell the user what failed; never start it again on another model.`;

/** Explicit model references retain Coop's tool contract. */
const NO_CHOICE =
    "model must be a provider/modelId string; leave it out to use this session's model.";

/** An optional owner restriction on additional models; an empty list preserves Coop's existing model choices. */
function allowedModels(host: PocketHost): readonly string[] {
    return typeof host.subagentModels === "function" ? host.subagentModels() : [];
}

/** `provider/modelId` as a model reference. */
function refOf(spec: string): ModelRef | undefined {
    const slash = spec.indexOf("/");

    return slash > 0
        ? { provider: spec.slice(0, slash), modelId: spec.slice(slash + 1) }
        : undefined;
}

const keyOf = (ref: ModelRef) => `${ref.provider}/${ref.modelId}`;

const same = (a: ModelRef | undefined, b: ModelRef | undefined) =>
    a !== undefined && b !== undefined && keyOf(a) === keyOf(b);

/** Why Pi may not use a model now (its sign-in, say), or undefined; nothing to say on a server older than the check. */
async function problemOf(host: PocketHost, ref: ModelRef, fresh: boolean) {
    return typeof host.modelProblem === "function" ? host.modelProblem(ref, fresh) : undefined;
}

/** The guide, and the models the owner also allows, each that cannot be used now saying why. */
async function guide(host: PocketHost): Promise<string> {
    const allowed = allowedModels(host);

    if (allowed.length === 0) {
        return GUIDE;
    }

    const listed = await Promise.all(
        allowed.map(async (spec) => {
            const ref = refOf(spec);
            const problem = ref === undefined ? undefined : await problemOf(host, ref, false);

            return problem === undefined ? spec : `${spec} (not now: ${problem})`;
        }),
    );

    return `${GUIDE}\nThe user also allows subagents on these models, passed as model: ${listed.join(", ")}. Leave model out unless the work needs one of them; no others.`;
}

/**
 * Resolve an explicit model without changing Coop's default choices; omission inherits the parent's model.
 * A nonempty owner list restricts additional models. A failed sign-in tells Pi to go to the user, not fall back.
 */
async function chosenModel(
    host: PocketHost,
    asked: unknown,
    own: ModelRef | undefined,
): Promise<ModelRef | undefined> {
    if (asked === undefined) {
        return undefined;
    }

    if (typeof asked !== "string") {
        throw new Error(NO_CHOICE);
    }

    const allowed = allowedModels(host);

    let ref: ModelRef;
    const named = refOf(asked.trim());

    // Its sign-in asked afresh first, so a mark that is out of date neither refuses it nor lets it through.
    if (named !== undefined) {
        await problemOf(host, named, true);
    }

    try {
        ref = host.resolveModel(asked);
    } catch (error) {
        throw new Error(
            `${describe(error)} Do not pick another model: leave model out to use this session's model, or stop and tell the user.`,
        );
    }

    if (allowed.length > 0 && !same(ref, own) && !allowed.includes(keyOf(ref))) {
        throw new Error(
            `${keyOf(ref)} is not one of the models the user allows for subagents (${allowed.join(", ")}). Do not pick another model on your own: leave model out to use this session's model, or stop and ask the user.`,
        );
    }

    const problem = await problemOf(host, ref, named === undefined);

    if (problem !== undefined) {
        throw new Error(
            `${keyOf(ref)} cannot be used now: ${problem}. Stop and tell the user; do not use another model instead.`,
        );
    }

    return ref;
}

export default function createSubagents(host: PocketHost) {
    const Courier = courierFor(host);
    const Reporter = reporterFor(Courier, host);
    const base = {
        action: Type.Union([
            Type.Literal("spawn"),
            Type.Literal("send"),
            Type.Literal("stop"),
            Type.Literal("status"),
        ]),
        name: Type.Optional(
            Type.String({ description: "Short kebab-case name, for example test-runner." }),
        ),
        message: Type.Optional(Type.String()),
        followUp: Type.Optional(Type.Boolean()),
        thinking: Type.Optional(
            Type.Union(
                THINKING_LEVELS.map((level) => Type.Literal(level)),
                {
                    description:
                        "spawn only: its thinking level. One its model lacks becomes the nearest it has.",
                },
            ),
        ),
        tools: Type.Optional(
            Type.Array(Type.String(), {
                description: "spawn only: the tool names it may use. Default: your tools.",
            }),
        ),
    };
    const offered = Type.Object({
        ...base,
        model: Type.Optional(
            Type.String({
                description:
                    "spawn only: provider/modelId. Default: your model. A nonempty owner model list restricts additional choices.",
            }),
        ),
    });
    const parameters = offered;

    const subagent = defineTool({
        name: "subagent",
        description:
            "Manage persistent background subagents. Actions: spawn (name, message; optional model as provider/modelId, " +
            "thinking level, and tools to allow), send (name, message; followUp: true queues it after the current answer " +
            "instead of steering), stop (name: aborts its current work), status (one name, or all). Answers come back " +
            "at your next pause; those that arrive together come in one.",
        parameters,
        // Not rerun after a crash: repeating stop could stop newer work. The model sees the interruption and can check
        // with status.
        replay: "unsafe",
        execute: async (args, api, context) => {
            const { action, name, message, followUp } = args;
            const reply = (text: string, conversationId?: ConversationId) => ({
                content: [{ type: "text" as const, text }],
                ...(conversationId === undefined || name === undefined
                    ? {}
                    : {
                          details: {
                              action,
                              name,
                              conversationId,
                              ...(message === undefined ? {} : { message }),
                          },
                      }),
            });
            const registry = (await api.snapshot(SubagentsDoc, api.conversationId, context)) ?? {
                agents: {},
                reporters: {},
            };

            if (action === "status") {
                const names = name === undefined ? Object.keys(registry.agents) : [name];
                const lines: string[] = [];

                for (const each of names) {
                    const found = Object.hasOwn(registry.agents, each)
                        ? registry.agents[each]
                        : undefined;

                    if (found === undefined) {
                        continue;
                    }

                    const busy =
                        (await api.snapshot(LiveDoc, found.conversationId, context))?.run !==
                        undefined;

                    lines.push(`${each}: ${busy ? "working" : "idle"}`);
                }

                return reply(lines.length === 0 ? "No subagents." : lines.join("\n"));
            }

            if (name === undefined || name.trim() === "") {
                return reply(`${action} needs a name.`);
            }

            const agent = Object.hasOwn(registry.agents, name) ? registry.agents[name] : undefined;

            if (action !== "spawn" && agent === undefined) {
                return reply(`No subagent named ${name}.`);
            }

            if (action === "stop") {
                await (await api.conversation(agent!.conversationId, context))!.abort(context);

                return reply(`Stopped ${name}.`, agent!.conversationId);
            }

            if (message === undefined || message.trim() === "") {
                return reply(`${action} needs a message.`);
            }

            const parent = await api.agent(context);

            // Preserve existing child model/thinking choices when sending more work. Only an explicit owner model
            // restriction or a current provider failure prevents another send.
            if (action === "send") {
                const child = await api.snapshot(AgentDoc, agent!.conversationId, context);
                const runs = child?.model;

                if (runs !== undefined && !same(runs, parent.model)) {
                    const allowed = allowedModels(host);

                    if (allowed.length > 0 && !allowed.includes(keyOf(runs))) {
                        throw new Error(
                            `${name} runs on ${keyOf(runs)}, which is neither this session's model nor one the user allows for subagents. Do not send it work: start a new subagent, which runs on this session's model, or ask the user.`,
                        );
                    }

                    const problem = await problemOf(host, runs, true);

                    if (problem !== undefined) {
                        throw new Error(
                            `${name} runs on ${keyOf(runs)}, which cannot be used now: ${problem}. Stop and tell the user; do not use another model instead.`,
                        );
                    }
                }
            }

            // Resolve spawn options before the commit, so a refused model fails without side effects.
            const model =
                action === "spawn"
                    ? await chosenModel(host, (args as { model?: unknown }).model, parent.model)
                    : undefined;
            const parentTools = action === "spawn" && args.tools !== undefined ? parent.tools : [];
            const tools =
                args.tools === undefined
                    ? undefined
                    : args.tools.map((tool) => {
                          const found = parentTools.find((each) => each.name === tool);

                          if (found === undefined) {
                              throw new Error(
                                  `Unknown tool ${tool}. Available: ${parentTools.map((each) => each.name).join(", ")}`,
                              );
                          }

                          return found;
                      });
            // TypeBox infers no type from a union built from a list; the schema itself checks the value.
            const asked = args.thinking as ModelThinkingLevel | undefined;
            let wanted = asked;
            let thinking = asked;

            // Preserve Coop's model-picker semantics: fit explicit or inherited thinking to the chosen model,
            // including its nearest higher level when that is all the model supports.
            if (action === "spawn" && (asked !== undefined || model !== undefined)) {
                const ref = model ?? parent.model;
                const found =
                    ref === undefined ? undefined : api.models.getModel(ref.provider, ref.modelId);

                wanted = asked ?? parent.thinkingLevel;
                thinking = found === undefined ? wanted : clampThinkingLevel(found, wanted);
            }

            const result = await api.commit(async (tx) => {
                const state = await tx.doc(SubagentsDoc, api.conversationId);

                if (action === "spawn") {
                    if (Object.hasOwn(state.agents, name)) {
                        return `${name} already exists; use send.`;
                    }

                    const anchor = await tx.createTask(Anchor, null, BACKGROUND);
                    // Owned by a task of this conversation, so it starts as a copy of this agent.
                    const child = await tx.createConversation({
                        ownership: { kind: "task", taskId: anchor },
                    });

                    await configure(tx, child.id, {
                        extensions: { remove: [SubagentTools, AgentTeams] },
                        instructions: `You are the subagent "${name}". You work for another agent, not directly for a person, although a person may open your conversation and talk to you. Answer requests completely but concisely: your final answer is what gets reported back.`,
                        ...(model === undefined ? {} : { model }),
                        ...(thinking === undefined ? {} : { thinkingLevel: thinking }),
                        ...(tools === undefined ? {} : { tools }),
                    });
                    state.agents[name] = { conversationId: child.id, reported: [] };
                }

                const record = state.agents[name]!;
                const conversationId = record.conversationId;
                const requestedBy = host.requesterOf(api.conversationId);

                // For the subagents bar: what it works on now, and since when.
                record.asked = message.trim().slice(0, 300);
                record.askedAt = Date.now();
                const input = {
                    name,
                    conversationId,
                    message,
                    followUp: action === "send" && followUp === true,
                    ...(requestedBy === undefined ? {} : { requestedBy }),
                };

                state.reporters[api.taskId] = await tx.createTask(Reporter, input, BACKGROUND);

                if (action === "send") {
                    return `Sent to ${name}.`;
                }

                const runs = model ?? parent.model;
                const on = runs === undefined ? "" : ` on ${keyOf(runs)}`;

                return thinking === wanted
                    ? `Started ${name}${on}.`
                    : `Started ${name}${on}, thinking at ${thinking}: its model has no ${wanted}.`;
            }, context);
            const current = (await api.snapshot(SubagentsDoc, api.conversationId, context))?.agents[
                name
            ];

            return reply(result, current?.conversationId);
        },
    });

    const SubagentTools: Extension = defineExtension({
        name: "pocket-subagents",
        tasks: [Anchor, Reporter, Courier],
        tools: [subagent],
        sections: [section("subagents", () => guide(host))],
    });

    return SubagentTools;
}
