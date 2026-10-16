// Public app/Durable boundaries own human handoffs: policy, summary isolation, atomic transfer,
// attribution, retries and recovery. Changes fixtures below exercise policy, not real Git inspection.
// Superseded prepare/complete/recommendation/validation-gate assertions belonged to the old contract;
// the human chooser no longer depends on those milestones. Execution/publication safety stays separate.
import {
    type App,
    cleanUp,
    context,
    lastText,
    modelTexts,
    newSession,
    openApp,
    owner,
    recordCost,
    root,
    say,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
    type ConversationId,
    InboxDoc,
    type SubmissionId,
    type TaskId,
    UsageDoc,
} from "@earendil-works/pi-durable";
import type { Changes } from "../src/server/changes.ts";
import { REPORT_PREFIX, SessionsDoc, SubagentsDoc, TurnsDoc } from "../src/server/docs.ts";
import { HttpError } from "../src/server/errors.ts";
import { createHandler } from "../src/server/http.ts";
import { TITLE_PROMPT } from "../src/server/titles.ts";
import { type ThreadType, HandoffsDoc, WorkflowDoc } from "../src/server/workflow-docs.ts";
import { PublicationsDoc } from "../src/server/workflow-publication.ts";
import { withWorkflowPublicationLock } from "../src/server/workflow-policy.ts";

let app: App;
const data = join(root, "handoffs-data");
const cid = (id: number) => id as ConversationId;
const status = (expected: number) => (error: unknown) =>
    error instanceof HttpError && error.status === expected;
const changed: Changes = {
    files: [{ path: "code.ts", kind: "modified", byPi: true }],
    piOnly: [],
    more: 0,
};
const unchanged: Changes = { files: [], piOnly: [], more: 0 };
const summary =
    "Original ask: repair retry delivery. Decisions: durable source summary, independent successor. " +
    "Files: src/server/handoffs.ts. Tests: focused lifecycle checks passed. " +
    "Deferred: Chromium unavailable. Risks: interrupted delivery. Limits: no commit, push or restart.";
const title = "Repair durable retry delivery";
const summaryPrompts: string[] = [];
const titlePrompts: string[] = [];

type Gate = { promise: Promise<void>; release: () => void };
let summaryGate: Gate | undefined;
let titleGate: Gate | undefined;
let childGate: Gate | undefined;
let courierGate: Gate | undefined;
let summaryMode: "text" | "empty" | "error" | "aborted" | "length" | "tools" = "text";

function gate(): Gate {
    let release = () => {};

    const promise = new Promise<void>((resolve) => {
        release = resolve;
    });

    return { promise, release };
}

async function held(gate: Gate | undefined, options: SimpleStreamOptions | undefined) {
    if (gate === undefined) {
        return;
    }

    const signal = options?.signal;

    let abort = () => {};

    try {
        await Promise.race([
            gate.promise,
            new Promise<void>((_resolve, reject) => {
                abort = () => reject(new Error("Fixture model request interrupted"));
                signal?.addEventListener("abort", abort, { once: true });

                if (signal?.aborted) {
                    abort();
                }
            }),
        ]);
    } finally {
        signal?.removeEventListener("abort", abort);
    }
}

const model = scriptedModel(async (input, options) => {
    const last = lastText(input as never);

    if (last.role === "user" && last.text.startsWith(TITLE_PROMPT)) {
        titlePrompts.push(last.text);
        await held(titleGate, options);

        return fauxAssistantMessage(title);
    }

    if (
        last.role === "user" &&
        /^(?:\[from:[^\]]+\]\s*)?The human has requested a /.test(last.text)
    ) {
        summaryPrompts.push(last.text);
        await held(summaryGate, options);

        if (summaryMode === "empty") {
            return fauxAssistantMessage("   ");
        }

        if (summaryMode === "error" || summaryMode === "aborted" || summaryMode === "length") {
            return fauxAssistantMessage(
                "Nonempty partial source summary; do not treat this as a successful handoff.",
                {
                    stopReason: summaryMode,
                    errorMessage: `Fixture summary provider stopped with ${summaryMode}`,
                },
            );
        }

        if (summaryMode === "tools") {
            return fauxAssistantMessage(
                [
                    fauxToolCall("write", { path: "forbidden-summary.txt", content: "bad" }),
                    fauxToolCall("subagent", {
                        action: "spawn",
                        name: "forbidden",
                        message: "work",
                    }),
                    fauxToolCall("handoff", { action: "status" }),
                ],
                { stopReason: "toolUse" },
            );
        }

        return fauxAssistantMessage(summary);
    }

    const toolRequest = /CALL_HANDOFF (\{[^\n]+\})$/.exec(last.text);

    if (last.role === "user" && toolRequest !== null) {
        return fauxAssistantMessage([fauxToolCall("handoff", JSON.parse(toolRequest[1]!))], {
            stopReason: "toolUse",
        });
    }

    if (last.role === "user" && last.text.endsWith("SPAWN_CHILD")) {
        return fauxAssistantMessage(
            [fauxToolCall("subagent", { action: "spawn", name: "writer", message: "HOLD_CHILD" })],
            { stopReason: "toolUse" },
        );
    }

    if (last.role === "user" && last.text.includes("HOLD_CHILD")) {
        await held(childGate, options);
    }

    if (last.role === "user" && last.text.includes("Continue as the ")) {
        await held(courierGate, options);
    }

    return fauxAssistantMessage(last.role === "toolResult" ? summary : "Fixture answer.");
});

before(async () => {
    app = await openApp(model, data);
});
after(async () => {
    summaryGate?.release();
    titleGate?.release();
    childGate?.release();
    courierGate?.release();
    await app.close();
    cleanUp();
});

async function source(threadType: ThreadType = "worker", cwd = work) {
    const { id } = await app.commands.createSession(owner(app), {
        cwd,
        threadType,
        title: "Retry delivery origin",
    });

    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });

    return id;
}

function start(
    id: ConversationId,
    targetType: ThreadType,
    requestId: string,
    relationship = "same-work",
    brief?: string,
) {
    return app.handoffs.start(id, owner(app), {
        targetType,
        relationship,
        requestId,
        ...(brief === undefined ? {} : { brief }),
    });
}

async function delivered(id: ConversationId) {
    await until(async () => {
        const list = await app.handoffs.list(id, owner(app));

        return (
            !app.isBusy(id) &&
            list.handoffs.some(
                (record) => record.targetThreadId === Number(id) && record.delivery === "delivered",
            )
        );
    }, "handoff delivery and answer");
    await app.harness.commit((tx) => app.handoffs.requireIdle(tx, id), context);
}

// Attribution, not slash text, decides whether submission is a native human command.
test("assistant relays of /handoff remain model input while a person's command opens only the passive picker", async () => {
    const id = await newSession(app);
    const before = await modelTexts(app, id);
    const count = app.sessions().length;
    const picker = await app.commands.submit(id, owner(app), {
        text: "/handoff",
        requestId: "human-picker",
    });

    assert.equal(picker.handoffPicker, true);
    assert.deepEqual(await modelTexts(app, id), before);
    const relay = await app.commands.submit(
        id,
        owner(app),
        {
            text: "/handoff",
            requestId: "relay-not-command",
        },
        "PiP",
    );

    assert.equal(
        relay.handoffPicker,
        undefined,
        "an assistant cannot open the human handoff picker",
    );
    assert.equal(relay.handoffThreadId, undefined);
    await (await app.harness.submission(relay.submissionId, context))!.wait(context);
    assert.ok((await modelTexts(app, id)).some((text) => text.includes("[via PiP] /handoff")));
    assert.equal(app.sessions().length, count);
});

// Real reporters/couriers author every batch; public task abort interrupts before or after submission admission.
test("handoff quiescence rejects stranded reports but allows delivered and explicitly discarded batches", async (t) => {
    for (const mode of ["outbox", "sending", "placed", "discarded"] as const) {
        await t.test(mode, async () => {
            let releaseParent!: () => void;
            const parentGate = new Promise<void>((resolve) => {
                releaseParent = resolve;
            });
            let releaseChild!: () => void;
            const childGate = new Promise<void>((resolve) => {
                releaseChild = resolve;
            });
            const reportTurns: string[] = [];
            const scripted = scriptedModel(async (input) => {
                const last = lastText(input);

                if (last.role === "user" && last.text.endsWith("CREATE_REPORT")) {
                    return fauxAssistantMessage(
                        [
                            fauxToolCall("subagent", {
                                action: "spawn",
                                name: "reporter",
                                message: "Finish this delegated task.",
                            }),
                        ],
                        { stopReason: "toolUse" },
                    );
                }

                if (last.role === "user" && last.text.endsWith("RESUME_REPORTS")) {
                    return fauxAssistantMessage(
                        [
                            fauxToolCall("subagent", {
                                action: "send",
                                name: "reporter",
                                message: "Finish one more delegated task.",
                            }),
                        ],
                        { stopReason: "toolUse" },
                    );
                }

                if (
                    mode === "outbox" &&
                    last.role === "user" &&
                    last.text === "Finish this delegated task."
                ) {
                    await childGate;
                }

                if (
                    mode === "discarded" &&
                    last.role === "toolResult" &&
                    last.text.includes("Started reporter")
                ) {
                    await parentGate;
                }

                if (last.role === "user" && last.text.includes(REPORT_PREFIX)) {
                    reportTurns.push(last.text);
                }

                return fauxAssistantMessage([fauxText("Completed delegated work.")]);
            });
            const isolated = await openApp(scripted, join(root, `stranded-reports-${mode}`));
            const id = await newSession(isolated);
            let courier: TaskId | undefined;
            let request: string | undefined;
            let queued: SubmissionId | undefined;
            let interrupted: Promise<void> | undefined;

            const interrupt = () => {
                if (courier === undefined || interrupted !== undefined) {
                    return;
                }

                const task = courier;

                interrupted = (async () => {
                    await isolated.harness.abortTask(task, context);
                    await isolated.harness.waitForTask(task, context);
                })();
            };

            const unsubscribe = isolated.harness.subscribeCommits((publication) => {
                for (const change of publication.changes) {
                    if (
                        change.type === "document" &&
                        change.conversationId === id &&
                        change.record.kind === SubagentsDoc.definition.kind
                    ) {
                        const state = change.value;

                        courier = state?.courier as TaskId | undefined;
                        request =
                            (state?.sending as { request?: string } | undefined)?.request ??
                            request;

                        if (mode === "sending" && request !== undefined) {
                            interrupt();
                        }
                    }

                    if (
                        change.type === "submission" &&
                        change.value.conversationId === id &&
                        change.value.requestId === request
                    ) {
                        if (mode === "placed" && change.value.status === "placed") {
                            interrupt();
                        } else if (mode === "discarded" && change.value.status === "queued") {
                            queued = change.value.id;
                            interrupt();
                        }
                    }
                }
            });

            try {
                const answer = say(isolated, id, "CREATE_REPORT");

                if (mode === "outbox") {
                    await answer;
                    // Finish the real child only after the parent turn ends, so the courier gathers at idle.
                    releaseChild();
                    await until(async () => {
                        const state = await isolated.harness.snapshot(SubagentsDoc, id, context);
                        const child = state?.agents.reporter;

                        return (
                            child?.reported.length === 1 &&
                            !isolated.isBusy(child.conversationId) &&
                            state?.outbox?.length === 1
                        );
                    }, "a genuine completed answer waiting for its courier");
                    await recordCost(isolated, id, 2);
                    await isolated.spend.setSessionBudget(owner(isolated), id, 1);
                    await until(
                        async () =>
                            (await isolated.harness.snapshot(SubagentsDoc, id, context))?.held !==
                            undefined,
                        "the courier's real spend hold",
                    );
                    interrupt();
                } else {
                    await until(() => interrupted !== undefined, `the ${mode} batch interruption`);
                }

                await interrupted;

                if (mode === "discarded") {
                    assert.ok(queued);
                    await isolated.commands.withdraw(id, owner(isolated), Number(queued));
                    releaseParent();
                }

                await answer;
                await until(async () => {
                    const tasks = await isolated.harness.commit(
                        (tx) => tx.scanTasks({ conversationId: id }, 100),
                        context,
                    );

                    return tasks.items.every((task) => task.state.status === "terminal");
                }, "all parent background tasks terminal");
                const state = await isolated.harness.snapshot(SubagentsDoc, id, context);
                const batch = state?.sending;
                const receipt =
                    batch === undefined
                        ? undefined
                        : await isolated.harness.commit(
                              (tx) => tx.submissionByRequest(id, batch.request),
                              context,
                          );

                assert.equal(state?.courier, undefined);
                assert.equal(isolated.isBusy(id), false);
                assert.equal(
                    (await isolated.harness.snapshot(InboxDoc, id, context))?.items.length,
                    0,
                );

                if (mode === "outbox" || mode === "sending") {
                    assert.equal((state?.outbox?.length ?? 0) + (batch?.reports.length ?? 0), 1);
                    assert.equal(receipt, undefined, "the pending batch has never been admitted");
                    await assert.rejects(
                        isolated.harness.commit(
                            (tx) => isolated.handoffs.requireIdle(tx, id),
                            context,
                        ),
                        /pending subagent reports/,
                    );
                    await isolated.spend.setSessionBudget(owner(isolated), id, null);
                    await say(isolated, id, "RESUME_REPORTS");
                    await until(async () => {
                        const current = await isolated.harness.snapshot(SubagentsDoc, id, context);

                        return (
                            current?.courier === undefined &&
                            !current?.outbox?.length &&
                            current?.sending === undefined &&
                            !isolated.isBusy(id)
                        );
                    }, "recovered reports delivered and courier settled");
                    assert.ok(
                        reportTurns.length > 0,
                        "recovery actually delivers the delegated reports",
                    );
                } else {
                    assert.ok(batch, "interruption leaves durable sending metadata behind");
                    assert.ok(receipt);

                    if (mode === "discarded") {
                        assert.equal(batch.discarded, true);
                        assert.equal(receipt.status, "unanswered");
                        assert.equal(receipt.entry, undefined);
                    } else {
                        assert.equal(reportTurns.length, 1);
                        assert.notEqual(
                            receipt.entry,
                            undefined,
                            "the model already received this batch",
                        );
                    }
                }

                await isolated.harness.commit(
                    (tx) => isolated.handoffs.requireIdle(tx, id),
                    context,
                );
            } finally {
                releaseParent();
                releaseChild();
                unsubscribe();
                await isolated.close();
            }
        });
    }
});

async function move(id: ConversationId, kind: ThreadType, key: string, relationship = "same-work") {
    const result = await start(id, kind, key, relationship);
    const next = cid(result.id);

    await delivered(next);

    return next;
}

async function entries(id: ConversationId) {
    return (
        await (await app.conversation(id)).entries({ order: "ascending" }, 200, undefined, context)
    ).items;
}

// Authenticated transport without sockets/listeners; only byte capture is substituted.
async function http(
    id: ConversationId,
    path: string,
    body?: unknown,
    token: string | null = app.config.ownerToken,
    pocket = true,
) {
    const request = new IncomingMessage(new Socket());
    const response = new ServerResponse(request);
    let output = "";

    request.url = `/api/c/${id}${path}`;
    request.method = body === undefined ? "GET" : "POST";
    request.headers = {
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        ...(pocket ? { "x-pocket": "1" } : {}),
        "content-type": "application/json",
    };

    response.end = (chunk?: unknown) => {
        output = String(chunk ?? "");

        return response;
    };

    const handled = createHandler({
        app,
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
    })(request, response);

    if (body !== undefined) {
        request.push(Buffer.from(JSON.stringify(body)));
    }

    request.push(null);
    await handled;

    return { status: response.statusCode, output };
}

// One public policy owner, with independent role/relationship expectations rather than copied predicates.
test("state policy offers only permitted edges; Review needs Changes, not a completed model answer", async (t) => {
    let changes = changed;

    t.mock.method(app.workspace, "changes", async () => changes);
    const rows: [ThreadType, ThreadType[]][] = [
        ["worker", ["reviewer", "researcher", "pull"]],
        ["reviewer", ["follow-up", "worker", "land", "researcher", "pull"]],
        ["land", ["publish", "worker", "follow-up", "pull"]],
        ["follow-up", ["land", "worker", "pull"]],
        ["researcher", ["worker", "pull"]],
        ["pull", ["worker", "researcher", "follow-up"]],
        ["publish", ["land", "pull"]],
    ];

    for (const [role, expected] of rows) {
        let id = await source(["worker", "researcher", "pull"].includes(role) ? role : "worker");

        if (["reviewer", "follow-up", "land", "publish"].includes(role)) {
            id = await move(id, "reviewer", `matrix-${role}-review`);

            if (role === "follow-up") {
                id = await move(id, "follow-up", "matrix-follow-up");
            } else if (["land", "publish"].includes(role)) {
                id = await move(id, "land", `matrix-${role}-land`);

                if (role === "publish") {
                    id = await move(id, "publish", "matrix-publish");
                }
            }
        }

        const list = await app.handoffs.list(id, owner(app));

        assert.deepEqual(
            list.options
                .filter((option) => option.relationship === "same-work")
                .map((option) => option.targetType)
                .sort(),
            expected.sort(),
            `${role} same-work edges in its admitted history`,
        );
        assert.deepEqual(
            list.options
                .filter((option) => option.relationship === "new-work")
                .map((option) => option.targetType)
                .sort(),
            ["pull", "researcher", "worker"],
            "new Work Items always have the three starter roles, including the current role",
        );
        assert.ok(list.options.every((option) => option.enabled));
        assert.equal("validation" in list, false);
        assert.equal("proposal" in list.workflow, false);
        assert.equal("recommendations" in list.workflow, false);
    }

    const worker = await source();
    const count = app.sessions().length;

    changes = unchanged;
    assert.equal(
        (await app.handoffs.list(worker, owner(app))).options.some(
            (option) => option.targetType === "reviewer",
        ),
        false,
    );
    await assert.rejects(start(worker, "reviewer", "no-diff"), /no current Pi diff/i);
    assert.equal(app.sessions().length, count);
    changes = { files: [], piOnly: [{ path: "committed-by-pi.ts", entryId: 123 }], more: 0 };
    assert.equal(
        (await app.handoffs.list(worker, owner(app))).options.some(
            (option) => option.targetType === "reviewer",
        ),
        false,
        "piOnly is historical committed/non-repository activity, not current reviewable diff",
    );
    await assert.rejects(start(worker, "reviewer", "historical-edits-only"), /no current Pi diff/i);
    changes = changed;
    const reviewer = await move(worker, "reviewer", "current-diff-review");

    assert.equal(app.sessionMeta(reviewer)?.threadType, "reviewer");
    assert.equal(
        (await entries(worker)).filter((entry) => entry.kind === "pi.user").length,
        1,
        "an empty source needs only the human-requested summary input, not an earlier completion",
    );
});

test("history permits Land globally and Follow-up after Review or Pull without readiness gates", async (t) => {
    t.mock.method(app.workspace, "changes", async () => changed);
    const initial = await source();

    await assert.rejects(start(initial, "follow-up", "missing-history"), status(409));
    await assert.rejects(start(initial, "worker", "same-worker"), status(409));
    const reviewer = await move(initial, "reviewer", "history-review");

    // Stored historical blockers remain history, not admission gates and not projected suggestions.
    await app.harness.commit(async (tx) => {
        const state = await tx.doc(WorkflowDoc, reviewer);

        state.status = "needs-review";
        state.readyForPublish = false;
        state.reviewApplicability = "invalidated";
        state.reviewAssessment = { outcome: "blocked", validationGaps: ["Checks unavailable"] };
        state.proposal = { targetType: "worker", relationship: "same-work", brief: "Old proposal" };
        state.recommendations = [{ targetType: "worker", relationship: "same-work" }];
    }, context);
    const research = await move(reviewer, "researcher", "history-research");
    const choices = await app.handoffs.list(research, owner(app));

    assert.deepEqual(
        choices.options
            .filter((option) => option.relationship === "same-work")
            .map((option) => option.targetType)
            .sort(),
        ["follow-up", "land", "pull", "worker"],
    );
    const land = await move(research, "land", "history-land");
    const publication = await move(land, "publish", "history-publish");
    const publishedPull = await move(publication, "pull", "history-published-pull");
    const repair = await move(publishedPull, "follow-up", "history-repair");
    const landedAgain = await move(repair, "land", "history-reland");

    assert.equal((await app.handoffs.list(landedAgain, owner(app))).workflow.status, "active");
    const pull = await source("pull");
    const pulledRepair = await move(pull, "follow-up", "pull-repair");

    assert.equal(
        (await app.handoffs.list(pulledRepair, owner(app))).options.some(
            (option) => option.targetType === "land",
        ),
        true,
        "Follow-up's direct Land edge does not require a separate milestone",
    );
    const independent = await source("researcher");

    await assert.rejects(start(independent, "follow-up", "research-without-history"), status(409));
    const newWorker = await move(landedAgain, "worker", "fresh-item", "new-work");

    assert.equal(
        (await app.handoffs.list(newWorker, owner(app))).options.some(
            (option) =>
                option.relationship === "same-work" &&
                ["land", "follow-up"].includes(option.targetType),
        ),
        false,
        "history from a predecessor Work Item cannot grant new-item edges",
    );
});

test("agent handoff calls are status-only and cannot write proposals, milestones or recommendations", async () => {
    const id = await source();
    const count = app.sessions().length;

    for (const args of [
        { action: "prepare", targetType: "reviewer", relationship: "same-work", brief: "Invented" },
        { action: "complete", status: "review-complete", summary: "Invented" },
        {
            action: "record-review",
            source: "Invented",
            findings: "Invented",
            checkpoint: "a".repeat(40),
        },
        { action: "recommend", targetType: "land" },
        { action: "unknown" },
        { action: "status", targetType: "land" },
        { action: "status", unknown: true },
    ]) {
        await say(app, id, `CALL_HANDOFF ${JSON.stringify(args)}`);
        await until(() => !app.isBusy(id), "agent rejection settles");
        const tool = (await entries(id)).findLast((entry) => entry.kind === "pi.tool-result");

        assert.ok(tool, "the attempted real tool call produces a result");
        const result = tool.model?.[0];

        assert.ok(result?.role === "toolResult" && result.isError === true);
        assert.equal((await app.harness.snapshot(WorkflowDoc, id, context))?.proposal, undefined);
        assert.equal(
            (await app.harness.snapshot(WorkflowDoc, id, context))?.recommendations,
            undefined,
        );
    }

    await say(app, id, 'CALL_HANDOFF {"action":"status"}');
    await until(() => !app.isBusy(id), "status call settles");
    const output = JSON.stringify(
        (await entries(id)).findLast((entry) => entry.kind === "pi.tool-result")?.model,
    );

    assert.match(output, /workflow/);
    assert.doesNotMatch(output, /proposal|recommendations/);
    assert.equal(app.sessions().length, count, "agent calls never create a successor");
    const state = await app.harness.snapshot(WorkflowDoc, id, context);

    assert.equal(state?.status ?? "active", "active");
    assert.equal(state?.externalReview, undefined);
    assert.equal(state?.summary, undefined);
    assert.equal(app.handoffs.isReadOnly(id), false);
});

test("human request persists before summary, blocks work/tools and creates one fixed destination only after the answer", async (t) => {
    t.mock.method(app.workspace, "changes", async () => changed);
    const id = await source();
    const count = app.sessions().length;
    const prompts = summaryPrompts.length;

    summaryGate = gate();
    const pending = start(
        id,
        "researcher",
        "human-summary",
        "same-work",
        "Investigate receipt replay only",
    );

    await until(() => summaryPrompts.length > prompts, "source is asked for the selected summary");
    const retry = app.handoffs.start(id, owner(app), {
        targetType: "researcher",
        relationship: "same-work",
        requestId: "human-summary",
        brief: "Investigate receipt replay only",
        recoverOnly: true,
    });

    // Observe both promises even when an intermediate assertion fails, so fixture work cannot leak.
    void pending.catch(() => {});
    void retry.catch(() => {});

    try {
        const doc = await app.harness.snapshot(HandoffsDoc, context);
        const intent = Object.values(doc?.pending ?? {}).find(
            (request) => request.sourceThreadId === Number(id),
        );

        assert.equal(intent?.targetType, "researcher");
        assert.equal(intent?.relationship, "same-work");
        assert.equal(intent?.requestedBy, owner(app).id);
        assert.equal(intent?.status, "pending");
        assert.equal(app.sessions().length, count, "no provisional successor before summary");
        assert.equal(
            app.handoffs.isReadOnly(id),
            false,
            "source not retired before creation commits",
        );
        assert.equal(app.handoffs.isPreparing(id), true);
        assert.match(summaryPrompts.at(-1)!, /same-work handoff to researcher/);
        assert.match(summaryPrompts.at(-1)!, /Investigate receipt replay only/);
        assert.match(summaryPrompts.at(-1)!, /Do not call tools/);
        await assert.rejects(start(id, "pull", "different-concurrent"), status(409));
        await assert.rejects(start(id, "pull", "human-summary"), status(409));
        await assert.rejects(
            app.commands.submit(id, owner(app), { text: "More work", requestId: "during-summary" }),
            /summary/,
        );
        const refused = await app.envFor(id).writeFile("forbidden-summary.txt", "bad", context);

        assert.equal(refused.ok, false);
        assert.equal(existsSync(join(work, "forbidden-summary.txt")), false);
        assert.ok(
            (await app.handoffs.list(id, owner(app))).options.every((option) => !option.enabled),
        );
    } finally {
        summaryGate.release();
        summaryGate = undefined;
    }

    const [created, retried] = await Promise.all([pending, retry]);

    assert.deepEqual(retried, created);
    assert.equal(app.sessions().length, count + 1);
    assert.equal(app.handoffs.isReadOnly(id), true);
    const destination = cid(created.id);

    await delivered(destination);
    const record = (await app.harness.snapshot(HandoffsDoc, context))?.handoffs[created.handoffId];

    assert.equal(record?.targetType, "researcher");
    assert.match(record?.brief ?? "", /Original ask: repair retry delivery/);
    assert.match(record?.brief ?? "", /Deferred: Chromium unavailable/);
    assert.match(record?.brief ?? "", /no commit, push or restart/);
    assert.equal((await entries(id)).filter((entry) => entry.kind === "pi.user").length, 1);
    assert.equal(
        (await entries(destination)).filter((entry) => entry.kind === "pi.user").length,
        1,
    );
    assert.equal(app.attribution.requesterOf(destination), owner(app).id);
    assert.equal(
        (await app.harness.commit((tx) => tx.conversation(destination), context))?.owner,
        undefined,
    );
    assert.deepEqual(
        await app.handoffs.start(id, owner(app), {
            targetType: "researcher",
            relationship: "same-work",
            requestId: "human-summary",
            brief: "Investigate receipt replay only",
            recoverOnly: true,
        }),
        created,
    );
    await assert.rejects(app.commands.configure(id, owner(app), { cwd: work }), status(409));
    await say(app, id, "Discuss the earlier design without modifications");
    assert.equal(app.handoffs.isReadOnly(id), true, "discussion never reacquires the writer");
});

test("lookup-only recovery cannot create an intent or retry a failed summary; only a human retry restarts it", async () => {
    for (const native of [false, true]) {
        const id = await source();
        const count = app.sessions().length;
        const attempts = summaryPrompts.length;
        const tasksBefore = (
            await app.harness.commit((tx) => tx.scanTasks({ conversationId: id }, 100), context)
        ).items.map((task) => task.id);
        const recovered = await http(id, native ? "/submit" : "/handoffs", {
            requestId: "not-admitted",
            ...(native
                ? { text: "/handoff researcher", handoffRecoverOnly: true }
                : { targetType: "researcher", relationship: "same-work", recoverOnly: true }),
        });

        assert.equal(recovered.status, 409, recovered.output);
        assert.equal(summaryPrompts.length, attempts, "lookup cannot initiate a source model call");
        assert.equal((await entries(id)).filter((entry) => entry.kind === "pi.user").length, 0);
        assert.equal(app.sessions().length, count);
        assert.equal(app.handoffs.isPreparing(id), false);
        assert.equal(app.handoffs.isReadOnly(id), false);
        assert.equal(
            Object.values((await app.harness.snapshot(HandoffsDoc, context))?.pending ?? {}).some(
                (intent) => intent.sourceThreadId === Number(id),
            ),
            false,
            "lookup cannot leave a blocked or pending intent",
        );
        assert.deepEqual(
            (
                await app.harness.commit((tx) => tx.scanTasks({ conversationId: id }, 100), context)
            ).items.map((task) => task.id),
            tasksBefore,
            "lookup cannot schedule a summary task",
        );
    }

    for (const mode of ["empty", "error", "aborted", "length"] as const) {
        const id = await source();
        const count = app.sessions().length;

        summaryMode = mode;

        try {
            await assert.rejects(start(id, "researcher", `failed-${mode}`), status(409));
            const attempts = summaryPrompts.length;
            const inputs = (await entries(id)).filter((entry) => entry.kind === "pi.user").length;

            if (mode === "empty") {
                await assert.rejects(
                    app.handoffs.start(id, owner(app), {
                        targetType: "researcher",
                        relationship: "same-work",
                        requestId: `failed-${mode}`,
                        recoverOnly: true,
                    }),
                    status(409),
                );
            } else {
                const recovered = await http(id, "/submit", {
                    text: "/handoff researcher",
                    requestId: `failed-${mode}`,
                    handoffRecoverOnly: true,
                });

                assert.equal(recovered.status, 409, recovered.output);
            }

            assert.equal(
                summaryPrompts.length,
                attempts,
                "a reconnect recovery cannot autonomously call the source model again",
            );
            assert.equal(
                (await entries(id)).filter((entry) => entry.kind === "pi.user").length,
                inputs,
                "recovery does not enqueue another synthetic summary input",
            );
            assert.equal(app.sessions().length, count);
            assert.equal(app.handoffs.isReadOnly(id), false);
            assert.equal(app.handoffs.isPreparing(id), false);
            assert.equal((await app.handoffs.list(id, owner(app))).handoffs.length, 0);
            await say(app, id, "Continue after the failed summary");
        } finally {
            summaryMode = "text";
        }

        const beforeExplicitRetry = summaryPrompts.length;
        const next = await move(id, "researcher", `failed-${mode}`);

        assert.equal(
            summaryPrompts.length,
            beforeExplicitRetry + 1,
            "an explicit human retry of the same request makes exactly one new source-summary attempt",
        );
        assert.equal(app.sessions().length, count + 1);
        assert.equal(app.handoffs.isReadOnly(next), false);
    }
});

test("a summary pauses an existing until goal without running checks or consuming attempts", async (t) => {
    const id = await source();

    await app.commands.setGoal(id, owner(app), "test -f goal-done.txt");
    const goal = await app.goals.get(id);
    const run = t.mock.method(app.goals, "run", async () => ({
        passed: false,
        code: -1,
        tail: "The work goal is still unmet",
    }));
    const attempts = summaryPrompts.length;
    const next = await move(id, "researcher", "summary-with-goal");

    assert.equal(run.mock.callCount(), 0);
    assert.deepEqual(
        await app.goals.get(id),
        goal,
        "handoff does not exhaust or complete the goal",
    );
    assert.equal(summaryPrompts.length, attempts + 1);
    assert.equal((await entries(id)).filter((entry) => entry.kind === "pi.assistant").length, 1);
    assert.equal(
        await app.goals.get(next),
        undefined,
        "a source goal is not inherited as new work",
    );
    await say(app, id, "Discuss this retired thread without resuming its goal");
    assert.equal(run.mock.callCount(), 0, "read-only discussion does not resume the work goal");
    assert.deepEqual(await app.goals.get(id), goal);
});

test("summary final admission rechecks the human's current steering rights", async () => {
    const id = await source();
    const guest = app.config.addUser("Summary requester", "guest", [String(id)]).user;
    const count = app.sessions().length;
    const prompts = summaryPrompts.length;

    summaryGate = gate();
    const request = {
        targetType: "researcher",
        relationship: "same-work",
        requestId: "revoked-summary",
    };
    const pending = app.handoffs.start(id, guest, request);
    const refused = assert.rejects(pending, status(409));

    try {
        await until(() => summaryPrompts.length > prompts, "authorized human summary starts");
        app.config.updateUser(guest.id, { role: "viewer" });
    } finally {
        summaryGate.release();
        summaryGate = undefined;
    }

    await refused;
    assert.equal(app.sessions().length, count);
    assert.equal(app.handoffs.isReadOnly(id), false);
    assert.equal(app.handoffs.isPreparing(id), false);
    app.config.updateUser(guest.id, { role: "guest" });
    const next = await app.handoffs.start(id, guest, request);

    await delivered(cid(next.id));
    assert.equal(app.attribution.requesterOf(cid(next.id)), guest.id);
});

test("legacy external review intake never treats the app's synthetic summary request as human evidence", async () => {
    const id = await source();
    const evidence = {
        source: "Independent reviewer Casey",
        scope: "Retry feature",
        findings: "Repair the retry guard.",
        checkpoint: "a".repeat(40),
    };

    summaryMode = "empty";

    try {
        await assert.rejects(
            start(
                id,
                "researcher",
                "synthetic-external-review",
                "same-work",
                JSON.stringify(evidence),
            ),
            status(409),
        );
    } finally {
        summaryMode = "text";
    }

    assert.equal(app.handoffs.isPreparing(id), false);
    assert.equal(app.handoffs.isReadOnly(id), false);
    assert.match(
        JSON.stringify(await modelTexts(app, id)),
        /Independent reviewer Casey/,
        "the synthetic, attributed summary input really contains the matching evidence",
    );
    await assert.rejects(
        app.handoffs.recordExternalReview(id, owner(app), evidence),
        /No matching human-supplied|Paste the external review/,
    );
    assert.equal((await app.harness.snapshot(WorkflowDoc, id, context))?.externalReview, undefined);
});

test("summary generation cannot dispatch write, delegate or status tools from Worker or an initial Chat", async () => {
    for (const role of ["worker", "chat"] as const) {
        const id = await source(role);

        assert.equal(app.sessionMeta(id)?.workItemId, undefined);
        assert.equal(
            app.handoffs.isManaged(id),
            role === "worker",
            "an initial Chat is unmanaged before its first human handoff request",
        );
        summaryMode = "tools";

        try {
            const result = await start(id, "researcher", `summary-no-tools-${role}`);

            await delivered(cid(result.id));
            assert.equal(
                existsSync(join(work, "forbidden-summary.txt")),
                false,
                JSON.stringify(await modelTexts(app, id)),
            );
            assert.equal(
                (await app.harness.snapshot(SubagentsDoc, id, context))?.agents.forbidden,
                undefined,
            );
            const results = (await entries(id)).filter((entry) => entry.kind === "pi.tool-result");

            assert.equal(
                results.length,
                3,
                `${role}: each attempted model tool is rejected at the real invocation boundary`,
            );

            for (const entry of results) {
                const result = entry.model?.[0];

                assert.ok(
                    result?.role === "toolResult" && result.isError === true,
                    `${role}: even status tools are forbidden during summary generation`,
                );
                assert.match(JSON.stringify(entry.model), /summary|handoff|prepar/i);
            }

            assert.match(JSON.stringify(await modelTexts(app, id)), /summary|prepar/i);
        } finally {
            summaryMode = "text";
        }
    }
});

test("HTTP/native handoffs enforce steering, driving, scope and whole-item privacy without a listener", async () => {
    const id = await source();
    const scoped = app.config.addUser("Scoped steering", "guest", [String(id)]);
    const viewer = app.config.addUser("Scoped viewer", "viewer", [String(id)]);
    const elsewhere = app.config.addUser("Elsewhere", "guest", ["999999"]);
    const request = {
        targetType: "researcher",
        relationship: "same-work",
        requestId: "native-research",
    };

    for (const [token, pocket, expected] of [
        [null, true, 401],
        [app.config.ownerToken, false, 403],
        [viewer.token, true, 403],
        [elsewhere.token, true, 404],
    ] as const) {
        assert.equal((await http(id, "/handoffs", request, token, pocket)).status, expected);
    }

    assert.equal((await http(id, "/handoffs", undefined, viewer.token)).status, 200);
    const before = await modelTexts(app, id);
    const picker = await http(
        id,
        "/submit",
        { text: "/handoff", requestId: "picker" },
        scoped.token,
    );

    assert.equal(picker.status, 200);
    assert.equal(JSON.parse(picker.output).handoffPicker, true);
    assert.deepEqual(await modelTexts(app, id), before, "opening the chooser sends no model work");
    await app.harness.commit(async (tx) => {
        const turns = await tx.doc(TurnsDoc, id);

        turns.on = true;
        turns.driver = owner(app).id;
    }, context);
    assert.equal((await http(id, "/handoffs", request, scoped.token)).status, 409);
    await app.harness.commit(async (tx) => {
        (await tx.doc(TurnsDoc, id)).on = false;
    }, context);
    assert.equal(
        (await http(id, "/handoffs", { ...request, relationship: "new-work" }, scoped.token))
            .status,
        403,
    );
    const response = await http(
        id,
        "/submit",
        { text: "/handoff researcher", requestId: "native-research" },
        scoped.token,
    );
    const result = JSON.parse(response.output);

    assert.equal(response.status, 200, response.output);
    const next = cid(result.handoffThreadId);

    await delivered(next);
    assert.equal(app.canSee(scoped.user, next), true);
    assert.equal(app.canSee(viewer.user, next), true);
    assert.equal(app.canSee(elsewhere.user, next), false);
    assert.equal(app.cwdOf(next), work);
    assert.equal(app.attribution.requesterOf(next), scoped.user.id);
    assert.equal(
        JSON.parse(
            (
                await http(
                    id,
                    "/submit",
                    { text: "/handoff researcher", requestId: "native-research" },
                    scoped.token,
                )
            ).output,
        ).handoffThreadId,
        Number(next),
    );
    const limited = app.config.addUser("Only successor", "guest", [String(next)]).user;
    const projected = await app.handoffs.list(next, limited);

    assert.equal(projected.workItem?.title, "Work item");
    assert.deepEqual(projected.workItem?.threadIds, [Number(next)]);
    assert.equal(projected.workItem?.originThreadId, undefined);
    assert.deepEqual(projected.handoffs, []);
    assert.equal("accessFrom" in app.sessions(limited)[0]!, false);
    await assert.rejects(
        app.handoffs.updateWorkItem(next, limited, { archived: true }),
        status(404),
    );
    const hidden = await source();

    await app.harness.commit(async (tx) => {
        (await tx.doc(SessionsDoc)).items[String(hidden)]!.ownerOnly = true;
    }, context);
    const hiddenNext = await move(hidden, "researcher", "owner-only");
    const guest = app.config.addUser("Unrestricted guest", "guest").user;

    assert.equal(app.canSee(guest, hiddenNext), false);
    assert.equal(app.sessionMeta(hiddenNext)?.ownerOnly, true);
});

test("descendant writers and unresolved publications block human handoff without stopping work", async (t) => {
    t.mock.method(app.workspace, "changes", async () => changed);
    const id = await source();

    childGate = gate();

    try {
        await say(app, id, "SPAWN_CHILD");
        const child = (await app.harness.snapshot(SubagentsDoc, id, context))?.agents.writer
            ?.conversationId;

        assert.ok(child);
        await until(() => app.isBusy(child), "helper writer running");
        const count = app.sessions().length;

        await assert.rejects(start(id, "researcher", "writer-busy"), status(409));
        await assert.rejects(start(child, "researcher", "child-handoff"), /main thread/);
        assert.equal(app.sessions().length, count);
        assert.equal(app.isBusy(child), true);
        assert.ok(
            (await app.handoffs.list(id, owner(app))).options.every((option) => !option.enabled),
        );
    } finally {
        childGate.release();
        childGate = undefined;
    }

    await until(async () => {
        try {
            await app.harness.commit((tx) => app.handoffs.requireIdle(tx, id), context);

            return true;
        } catch {
            return false;
        }
    }, "helper and reporter settle");
    await withWorkflowPublicationLock(app, id, async () => {
        await assert.rejects(
            start(id, "researcher", "exclusive-activation"),
            /Another publication/,
        );
    });
    await app.harness.commit(async (tx) => {
        (await tx.doc(PublicationsDoc, id)).receipts.uncertain = {
            id: "uncertain",
            command: ["git", "push", "origin", "HEAD:topic"],
            cwd: work,
            fingerprint: "historical",
            requester: owner(app).id,
            approver: owner(app).id,
            approvedAt: 1,
            reason: "Historical uncertain effect",
            state: "executing",
        };
    }, context);
    await assert.rejects(
        start(id, "researcher", "uncertain-activation"),
        /Reconcile uncertain publication/,
    );
    await app.harness.commit(async (tx) => {
        delete (await tx.doc(PublicationsDoc, id)).receipts.uncertain;
    }, context);
    await move(id, "researcher", "writer-busy");
    const child = (await app.harness.snapshot(SubagentsDoc, id, context))!.agents.writer!
        .conversationId;

    assert.equal(app.handoffs.isReadOnly(child), true);
    assert.equal(
        (await app.envFor(child).writeFile("forbidden-child.txt", "bad", context)).ok,
        false,
    );
});

test("pending source summary recovers after restart without duplicate intent, source input or successor", async () => {
    const id = await source();
    const count = app.sessions().length;
    const prompts = summaryPrompts.length;

    summaryGate = gate();
    const interrupted = start(id, "researcher", "restart-summary").catch((error: unknown) => error);

    await until(() => summaryPrompts.length > prompts, "summary generation started before restart");
    await app.close();
    summaryGate.release();
    summaryGate = undefined;
    await interrupted;
    app = await openApp(model, data);
    const result = await start(id, "researcher", "restart-summary");
    const next = cid(result.id);

    await delivered(next);
    assert.equal(app.sessions().length, count + 1);
    assert.equal((await entries(id)).filter((entry) => entry.kind === "pi.user").length, 1);
    assert.equal((await entries(next)).filter((entry) => entry.kind === "pi.user").length, 1);
    assert.equal(
        Object.values((await app.harness.snapshot(HandoffsDoc, context))?.pending ?? {}).filter(
            (request) => request.sourceThreadId === Number(id),
        ).length,
        1,
    );
    assert.equal(app.handoffs.isReadOnly(id), true);
    assert.deepEqual(await start(id, "researcher", "restart-summary"), result);
});

// Observe real committed activation, then request cancellation before the summary task's final
// settlement. A stored successor is authoritative even if its source task is cancelled afterward.
test("human cancellation respects the atomic activation boundary and preserves a committed redirect", async () => {
    for (const phase of ["before-activation", "activation-frame"] as const) {
        const id = await source();
        const count = app.sessions().length;
        const prompts = summaryPrompts.length;

        summaryGate = gate();
        const pending = start(id, "researcher", `cancel-${phase}`);

        void pending.catch(() => {});
        await until(() => summaryPrompts.length > prompts, "cancellable source summary started");
        const doc = await app.harness.snapshot(HandoffsDoc, context);
        const intent = Object.entries(doc?.pending ?? {}).find(
            ([, request]) => request.sourceThreadId === Number(id),
        );

        assert.ok(intent);
        const [key, request] = intent;
        const taskId = request.taskId as TaskId;
        const watch = await app.harness.watchDoc(HandoffsDoc, context);

        assert.ok(watch);
        let cancellation: Promise<"marked" | "terminal"> | undefined;
        let activationTarget: number | undefined;

        if (phase === "activation-frame") {
            watch.start(async (frame) => {
                if (frame?.requests[key] === undefined || cancellation !== undefined) {
                    return;
                }

                activationTarget = frame.requests[key].id;
                // No await before abortTask: its real cancellation races the final task commit.
                cancellation = app.harness.abortTask(taskId, context);
                await cancellation;
            });
        }

        try {
            if (phase === "before-activation") {
                await app.commands.abort(id, owner(app));
                await assert.rejects(pending, status(409));
                const settled = await app.harness.waitForTask(taskId, context);

                assert.equal(
                    settled.state.outcome.status,
                    "aborted",
                    "human Stop aborts the durable background summary task, not just its foreground input",
                );
                assert.equal(app.sessions().length, count);
                assert.equal(app.handoffs.isReadOnly(id), false);
                assert.equal(app.handoffs.isPreparing(id), false);
                const stopped = await app.harness.snapshot(HandoffsDoc, context);

                assert.equal(stopped?.requests[key], undefined);
                assert.equal(stopped?.pending?.[key]?.status, "blocked");
                summaryGate.release();
                summaryGate = undefined;
                await move(id, "researcher", `cancel-${phase}`);
                assert.equal(
                    app.sessions().length,
                    count + 1,
                    "an explicit human retry may restart the stopped request after source ownership is restored",
                );
            } else {
                summaryGate.release();
                const created = await pending;

                assert.ok(cancellation, "activation observer actually requested cancellation");
                assert.equal(
                    await cancellation,
                    "marked",
                    "cancellation arrived before terminal settlement, not after an already-completed task",
                );
                assert.equal(activationTarget, created.id);
                const settled = await app.harness.waitForTask(taskId, context);

                assert.equal(settled.state.outcome.status, "completed");

                if (settled.state.outcome.status === "completed") {
                    assert.deepEqual(settled.state.outcome.result, created);
                }

                const activated = await app.harness.snapshot(HandoffsDoc, context);

                assert.equal(activated?.pending?.[key]?.status, "completed");
                assert.equal(activated?.requests[key]?.id, created.id);
                assert.equal(app.sessions().length, count + 1);
                assert.equal(app.handoffs.isReadOnly(id), true);
                assert.deepEqual(
                    await app.handoffs.start(id, owner(app), {
                        targetType: "researcher",
                        relationship: "same-work",
                        requestId: `cancel-${phase}`,
                        recoverOnly: true,
                    }),
                    created,
                    "the caller recovers the authoritative redirect, never a fresh admission error",
                );
                await delivered(cid(created.id));
            }
        } finally {
            summaryGate?.release();
            summaryGate = undefined;
            await watch.stop();

            if (cancellation !== undefined) {
                await cancellation;
            }
        }
    }
});

test("successor names from received summary, bills once and resumes its courier after restart", async (t) => {
    const id = await source();
    const titlesBefore = titlePrompts.length;
    const actualComplete = app.models.completeSimple.bind(app.models);
    let titleUsage: Awaited<ReturnType<typeof actualComplete>>["usage"] | undefined;

    t.mock.method(
        app.models,
        "completeSimple",
        async (...args: Parameters<typeof actualComplete>) => {
            const response = await actualComplete(...args);

            titleUsage = response.usage;

            return response;
        },
    );
    courierGate = gate();
    const result = await start(id, "researcher", "restart-courier", "new-work");
    const next = cid(result.id);

    await until(
        async () =>
            (await app.harness.snapshot(HandoffsDoc, context))?.handoffs[result.handoffId]
                ?.titleNamed === true,
        "destination title commits before courier answer",
    );
    assert.equal(app.sessionMeta(next)?.title, title);
    assert.equal((await app.handoffs.list(next, owner(app))).workItem?.title, title);
    assert.equal(titlePrompts.length, titlesBefore + 1);
    assert.match(titlePrompts.at(-1)!, /Original ask: repair retry delivery/);
    assert.match(titlePrompts.at(-1)!, /Deferred: Chromium unavailable/);
    assert.ok(titleUsage);
    const namedLedger = await app.harness.snapshot(UsageDoc, next, context);

    assert.deepEqual(
        namedLedger?.models["faux/faux-1"],
        titleUsage,
        "naming's actual response usage is committed to the destination, before its first assistant answer",
    );
    assert.equal(app.handoffs.isReadOnly(id), true);
    assert.equal(
        app.handoffs.isReadOnly(next),
        false,
        "start resolves with writer transfer, not courier completion",
    );
    await app.close();
    courierGate.release();
    courierGate = undefined;
    app = await openApp(model, data);
    await delivered(next);
    const settledLedger = await app.harness.snapshot(UsageDoc, next, context);
    const count = app.sessions().length;

    await withWorkflowPublicationLock(app, next, async () => {
        assert.deepEqual(await start(id, "researcher", "restart-courier", "new-work"), result);
        await assert.rejects(start(id, "pull", "restart-courier", "new-work"), /different handoff/);
    });
    assert.deepEqual(await app.harness.snapshot(UsageDoc, next, context), settledLedger);
    assert.equal(
        titlePrompts.length,
        titlesBefore + 1,
        "recovered courier never names or bills a second title",
    );
    assert.equal(app.sessions().length, count);
    assert.equal((await entries(next)).filter((entry) => entry.kind === "pi.user").length, 1);
    assert.equal(app.attribution.requesterOf(next), owner(app).id);

    // A real courier may be blocked after atomic creation if its human loses steering rights.
    // Recovery is a receipt lookup, not permission to restart that destination's provider work.
    const blockedSource = await source();
    const requester = app.config.addUser("Blocked courier requester", "guest").user;
    const blockedRequest = {
        targetType: "researcher",
        relationship: "new-work",
        requestId: "blocked-courier-lookup",
    };
    const watch = await app.harness.watchDoc(HandoffsDoc, context);

    assert.ok(watch);
    let revoked = false;

    watch.start(async (frame) => {
        const activated = Object.values(frame?.handoffs ?? {}).some(
            (record) => record.sourceThreadId === Number(blockedSource),
        );

        if (activated && !revoked) {
            revoked = true;
            app.config.updateUser(requester.id, { role: "viewer" });
        }
    });
    let blocked: Awaited<ReturnType<typeof app.handoffs.start>>;

    try {
        blocked = await app.handoffs.start(blockedSource, requester, blockedRequest);
        await until(
            async () =>
                (await app.harness.snapshot(HandoffsDoc, context))?.handoffs[blocked.handoffId]
                    ?.delivery === "blocked",
            "courier observes the real post-activation authorization loss",
        );
    } finally {
        await watch.stop();
        app.config.updateUser(requester.id, { role: "guest" });
    }

    const blockedTarget = cid(blocked.id);

    await app.harness.commit((tx) => app.handoffs.requireIdle(tx, blockedTarget), context);
    const tasksBeforeLookup = (
        await app.harness.commit(
            (tx) => tx.scanTasks({ conversationId: blockedTarget }, 100),
            context,
        )
    ).items.map((task) => task.id);
    const callsBeforeLookup = model.state.callCount;

    assert.equal(revoked, true);
    assert.deepEqual(
        await app.handoffs.start(blockedSource, requester, {
            ...blockedRequest,
            recoverOnly: true,
        }),
        blocked,
    );
    assert.equal(
        (await app.harness.snapshot(HandoffsDoc, context))?.handoffs[blocked.handoffId]?.delivery,
        "blocked",
    );
    assert.deepEqual(
        (
            await app.harness.commit(
                (tx) => tx.scanTasks({ conversationId: blockedTarget }, 100),
                context,
            )
        ).items.map((task) => task.id),
        tasksBeforeLookup,
        "automatic receipt recovery schedules no new destination task",
    );
    assert.equal(
        model.state.callCount,
        callsBeforeLookup,
        "automatic recovery never repeats blocked courier/provider work",
    );
    assert.deepEqual(await app.handoffs.start(blockedSource, requester, blockedRequest), blocked);
    await delivered(blockedTarget);
    assert.ok(
        model.state.callCount > callsBeforeLookup,
        "an explicit human retry still authorizes delivery of the existing successor",
    );
});

test("a human successor rename wins over an in-flight title model response", async () => {
    const id = await source();
    const titlesBefore = titlePrompts.length;

    titleGate = gate();
    const result = await start(id, "researcher", "manual-name");
    const next = cid(result.id);

    try {
        await until(() => titlePrompts.length > titlesBefore, "destination naming model entered");
        await app.commands.updateSession(next, owner(app), { title: "Human-owned thread name" });
    } finally {
        titleGate.release();
        titleGate = undefined;
    }

    await delivered(next);
    assert.equal(app.sessionMeta(next)?.title, "Human-owned thread name");
    assert.equal(
        (await app.harness.snapshot(HandoffsDoc, context))?.handoffs[result.handoffId]?.titleNamed,
        true,
    );
    await app.close();
    app = await openApp(model, data);
    assert.equal(app.sessionMeta(next)?.title, "Human-owned thread name");
});

test("same-work organization is atomic, new-work starts independent history and receipts survive restart", async () => {
    const id = await source("pull");
    const repair = await move(id, "follow-up", "group-repair");
    const worker = await move(repair, "worker", "group-worker");
    const item = (await app.handoffs.list(worker, owner(app))).workItem!;
    const native = await http(worker, "/submit", {
        text: "/handoff worker --new",
        requestId: "new-worker-item",
    });

    assert.equal(native.status, 200, native.output);
    const next = cid(JSON.parse(native.output).handoffThreadId);

    await delivered(next);
    const nextItem = (await app.handoffs.list(next, owner(app))).workItem!;
    const doc = await app.harness.snapshot(HandoffsDoc, context);

    assert.notEqual(item.id, nextItem.id);
    assert.deepEqual(item.threadIds, [Number(id), Number(repair), Number(worker)]);
    assert.deepEqual(nextItem.threadIds, [Number(next)]);
    assert.equal(nextItem.originThreadId, Number(next));
    assert.equal(doc?.workItems[nextItem.id]?.predecessorWorkItemId, item.id);
    const project = await app.projects.create(owner(app), {
        name: "Grouped",
        cwd: work,
        requestId: "grouped-project",
    });

    await app.projects.assign(owner(app), repair, { projectId: project.id });
    assert.ok(
        [id, repair, worker].every((member) => app.sessionMeta(member)?.projectId === project.id),
    );
    assert.equal(app.sessionMeta(next)?.projectId, undefined);
    await app.commands.updateSession(repair, owner(app), { archived: true });
    assert.ok([id, repair, worker].every((member) => app.sessionMeta(member)?.archived === true));
    assert.equal(app.sessionMeta(next)?.archived, undefined);
    await app.commands.updateSession(id, owner(app), { archived: false, title: "Renamed origin" });
    assert.ok([id, repair, worker].every((member) => app.sessionMeta(member)?.archived !== true));
    assert.equal((await app.handoffs.list(repair, owner(app))).workItem?.title, "Renamed origin");
    await app.close();
    app = await openApp(model, data);
    const count = app.sessions().length;
    const retry = await start(id, "follow-up", "group-repair");

    assert.equal(retry.id, Number(repair));
    assert.equal(app.sessions().length, count);
    assert.equal(app.handoffs.isReadOnly(id), true);
    assert.equal(app.handoffs.isReadOnly(repair), true);
    assert.equal(app.handoffs.isReadOnly(worker), true);
    assert.equal(app.handoffs.isReadOnly(next), false);
    assert.deepEqual(
        (await app.handoffs.list(worker, owner(app))).workItem?.threadIds,
        item.threadIds,
    );
});

// Fingerprints still secure publication execution even though they no longer gate human Land.
// Retain the raw-byte/configured-filter regression without any agent milestone assertions.
test("Git fingerprint inspection contains configured filters and binds physical tracked bytes", async () => {
    const cwd = join(root, "fingerprint-filters");
    const marker = join(root, "escaped-clean-filter");
    const textconv = join(root, "executed-textconv");

    mkdirSync(cwd);
    const git = (...args: string[]) =>
        execFileSync("git", ["-c", "core.fsmonitor=false", ...args], { cwd, encoding: "utf8" });

    git("init", "-q");
    writeFileSync(join(cwd, "code.txt"), "original\n");
    writeFileSync(join(cwd, ".gitattributes"), "code.txt filter=alias diff=offline\n");
    git("config", "filter.alias.clean", "printf 'normalized\\n'");
    git("config", "diff.offline.textconv", `touch ${JSON.stringify(textconv)}`);
    git("add", ".");
    git(
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.test",
        "commit",
        "-qm",
        "normalized baseline",
    );
    assert.equal(git("show", "HEAD:code.txt"), "normalized\n");
    const filter = join(root, "clean-filter.sh");

    writeFileSync(
        filter,
        `printf escaped > ${JSON.stringify(marker)} 2>/dev/null\nprintf 'normalized\\n'\n`,
    );
    git("config", "filter.alias.clean", `/bin/sh ${JSON.stringify(filter)}`);
    const id = await source("worker", cwd);

    writeFileSync(join(cwd, "code.txt"), "changedA\n");
    const first = await app.handoffs.fingerprint(id);

    writeFileSync(join(cwd, "code.txt"), "changedB\n");
    assert.notEqual(
        await app.handoffs.fingerprint(id),
        first,
        "equal-length tracked bytes cannot alias through configured clean normalization",
    );
    assert.equal(
        existsSync(marker),
        false,
        "configured Git filters cannot escape read-only inspection",
    );
    assert.equal(
        existsSync(textconv),
        false,
        "workflow fingerprints never execute configured textconv",
    );
});

// Retained inherited Chord regression: initializing [] stores a clone, so pushing a detached
// local array used to lose the FIRST human acceptance. Legacy HTTP/storage clients still exist;
// this proves their durable ledger only, not a requirement for human Land admission.
// Requires real offline Git fingerprinting. Do not run in a nested sandbox lacking that capability.
test("Git legacy first validation acceptance persists once across HTTP retry and restart", async (t) => {
    const cwd = join(root, "legacy-validation-ledger");

    mkdirSync(cwd);
    writeFileSync(join(cwd, "code.txt"), "baseline\n");
    const git = (...args: string[]) =>
        execFileSync("git", ["-c", "core.fsmonitor=false", ...args], { cwd });

    git("init", "-q");
    git("add", "code.txt");
    git("-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "baseline");
    writeFileSync(join(cwd, "code.txt"), "reviewed repair\n");
    t.mock.method(app.workspace, "changes", async () => changed);
    const id = await source("worker", cwd);
    const reviewer = await move(id, "reviewer", "legacy-ledger-review");

    await app.handoffs.complete(reviewer, owner(app), {
        status: "needs-review",
        summary: "Independent findings clear; checks are unavailable.",
        reviewAssessment: { outcome: "clear", validationGaps: ["Chromium unavailable."] },
    });
    const historical = await app.harness.snapshot(WorkflowDoc, reviewer, context);

    assert.ok(historical?.fingerprint);
    assert.equal(
        historical.validationAcceptances,
        undefined,
        "the first acceptance must initialize and append to the real Chord draft",
    );
    // Legacy clients submit an opaque assessment identity computed from these persisted fields.
    // This fixture exercises that old wire identity; list() intentionally no longer offers a gate.
    const request = {
        checkpoint: historical.fingerprint.digest,
        assessment: createHash("sha256")
            .update(
                JSON.stringify([
                    historical.reviewAssessmentId,
                    historical.fingerprint,
                    historical.completedAt,
                    historical.completedBy,
                    historical.summary,
                    historical.reviewAssessment,
                ]),
            )
            .digest("hex"),
    };
    const response = await http(reviewer, "/handoffs/accept-validation", request);

    assert.equal(response.status, 200, response.output);
    const first = (await app.harness.snapshot(WorkflowDoc, reviewer, context))
        ?.validationAcceptances;

    assert.equal(
        first?.length,
        1,
        "one successful request, not a second retry, persists the first record",
    );
    assert.equal(first[0]?.acceptedBy, owner(app).id);
    assert.deepEqual(first[0]?.gaps, ["Chromium unavailable."]);
    assert.equal(first[0]?.checkpoint, request.checkpoint);
    assert.equal((await http(reviewer, "/handoffs/accept-validation", request)).status, 200);
    assert.deepEqual(
        (await app.harness.snapshot(WorkflowDoc, reviewer, context))?.validationAcceptances,
        first,
    );
    await app.close();
    app = await openApp(model, data);
    assert.deepEqual(
        (await app.harness.snapshot(WorkflowDoc, reviewer, context))?.validationAcceptances,
        first,
    );
    assert.equal((await http(reviewer, "/handoffs/accept-validation", request)).status, 200);
    assert.deepEqual(
        (await app.harness.snapshot(WorkflowDoc, reviewer, context))?.validationAcceptances,
        first,
    );
    assert.equal(
        "validation" in (await app.handoffs.list(reviewer, owner(app))),
        false,
        "historical acceptance persistence does not resurrect the chooser's validation gate",
    );
});
