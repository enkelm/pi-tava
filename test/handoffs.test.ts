// Public app/Durable boundaries own policy, grouping, naming, delivery and passive receipt navigation.
// Setup uses genuine human input and the registered tool. Changes fixtures exercise policy, not Git inspection.
// Superseded prepare/complete/recommendation/validation-gate assertions belonged to the old contract;
// the human chooser no longer depends on those milestones. Execution/publication safety stays separate.
import {
    type App,
    cleanUp,
    context,
    executeHandoff,
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
import { REPORT_PREFIX, SessionsDoc, SubagentsDoc } from "../src/server/docs.ts";
import { HttpError } from "../src/server/errors.ts";
import { createHandler } from "../src/server/http.ts";
import { TITLE_PROMPT } from "../src/server/titles.ts";
import {
    type Relationship,
    type ThreadType,
    HandoffsDoc,
    WorkflowDoc,
} from "../src/server/workflow-docs.ts";
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
const titlePrompts: string[] = [];

type Gate = { promise: Promise<void>; release: () => void };
let titleGate: Gate | undefined;
let childGate: Gate | undefined;
let courierGate: Gate | undefined;

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
    direction: string,
    relationship: Relationship = "same-work",
) {
    return executeHandoff(app, id, targetType, { relationship, summary, instructions: direction });
}

async function delivered(id: ConversationId) {
    await until(async () => {
        const list = await app.workItems.list(id, owner(app));

        return (
            !app.isBusy(id) &&
            list.handoffs.some(
                (record) => record.targetThreadId === Number(id) && record.delivery === "delivered",
            )
        );
    }, "handoff delivery and answer");
    await app.harness.commit((tx) => app.workItems.requireIdle(tx, id), context);
}

// Both inputs reach the model, but only genuine human input receives human handoff correlation.
test("human /handoff is model input while assistant relays receive no human handoff correlation", async () => {
    const id = await newSession(app);
    const before = await modelTexts(app, id);
    const count = app.sessions().length;
    const human = await app.commands.submit(id, owner(app), {
        text: "/handoff",
        requestId: "human-handoff-input",
    });

    assert.equal(typeof human.handoffRequestKey, "string");
    await (await app.harness.submission(human.submissionId, context))!.wait(context);
    assert.ok(
        (await modelTexts(app, id)).slice(before.length).some((text) => text.includes("/handoff")),
        "the human command reaches the model instead of opening a passive picker",
    );
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
        relay.handoffRequestKey,
        undefined,
        "an assistant relay is not genuine human handoff input",
    );
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
                            (tx) => isolated.workItems.requireIdle(tx, id),
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
                    (tx) => isolated.workItems.requireIdle(tx, id),
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

async function move(
    id: ConversationId,
    kind: ThreadType,
    key: string,
    relationship: Relationship = "same-work",
) {
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

        const list = await app.workItems.list(id, owner(app));

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
        (await app.workItems.list(worker, owner(app))).options.some(
            (option) => option.targetType === "reviewer",
        ),
        false,
    );
    await assert.rejects(start(worker, "reviewer", "no-diff"), /no current Pi diff/i);
    assert.equal(app.sessions().length, count);
    changes = { files: [], piOnly: [{ path: "committed-by-pi.ts", entryId: 123 }], more: 0 };
    assert.equal(
        (await app.workItems.list(worker, owner(app))).options.some(
            (option) => option.targetType === "reviewer",
        ),
        false,
        "piOnly is historical committed/non-repository activity, not current reviewable diff",
    );
    await assert.rejects(start(worker, "reviewer", "historical-edits-only"), /no current Pi diff/i);
    changes = changed;
    const reviewer = await move(worker, "reviewer", "current-diff-review");

    assert.equal(app.sessionMeta(reviewer)?.threadType, "reviewer");
});

test("history permits Land globally and Follow-up after Review or Pull without readiness gates", async (t) => {
    t.mock.method(app.workspace, "changes", async () => changed);
    const initial = await source();

    await assert.rejects(
        start(initial, "follow-up", "missing-history"),
        /not available from the current thread state/,
    );
    await assert.rejects(
        start(initial, "worker", "same-worker"),
        /not available from the current thread state/,
    );
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
    const choices = await app.workItems.list(research, owner(app));

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

    assert.equal((await app.workItems.list(landedAgain, owner(app))).workflow.status, "active");
    const pull = await source("pull");
    const pulledRepair = await move(pull, "follow-up", "pull-repair");

    assert.equal(
        (await app.workItems.list(pulledRepair, owner(app))).options.some(
            (option) => option.targetType === "land",
        ),
        true,
        "Follow-up's direct Land edge does not require a separate milestone",
    );
    const independent = await source("researcher");

    await assert.rejects(
        start(independent, "follow-up", "research-without-history"),
        /not available from the current thread state/,
    );
    const newWorker = await move(landedAgain, "worker", "fresh-item", "new-work");

    assert.equal(
        (await app.workItems.list(newWorker, owner(app))).options.some(
            (option) =>
                option.relationship === "same-work" &&
                ["land", "follow-up"].includes(option.targetType),
        ),
        false,
        "history from a predecessor Work Item cannot grant new-item edges",
    );
});

test("agent handoff rejects obsolete proposals, milestones and recommendations", async () => {
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
    assert.equal(
        app.sessions().length,
        count,
        "unsupported actions and status create no successor",
    );
    const state = await app.harness.snapshot(WorkflowDoc, id, context);

    assert.equal(state?.status ?? "active", "active");
    assert.equal(state?.externalReview, undefined);
    assert.equal(state?.summary, undefined);
    assert.equal(app.workItems.isReadOnly(id), false);
});

test("a handoff retires the source until goal without running checks or consuming attempts", async (t) => {
    const id = await source();

    await app.commands.setGoal(id, owner(app), "test -f goal-done.txt");
    const goal = await app.goals.get(id);
    const run = t.mock.method(app.goals, "run", async () => ({
        passed: false,
        code: -1,
        tail: "The work goal is still unmet",
    }));
    const next = await move(id, "researcher", "summary-with-goal");

    assert.equal(run.mock.callCount(), 0);
    assert.deepEqual(
        await app.goals.get(id),
        goal,
        "handoff does not exhaust or complete the goal",
    );
    assert.equal(
        await app.goals.get(next),
        undefined,
        "a source goal is not inherited as new work",
    );
    await say(app, id, "Discuss this retired thread without resuming its goal");
    assert.equal(run.mock.callCount(), 0, "read-only discussion does not resume the work goal");
    assert.deepEqual(await app.goals.get(id), goal);
});

test("handoff grouping preserves scoped and owner-only visibility", async () => {
    const id = await source();
    const scoped = app.config.addUser("Scoped steering", "guest", [String(id)]);
    const viewer = app.config.addUser("Scoped viewer", "viewer", [String(id)]);
    const elsewhere = app.config.addUser("Elsewhere", "guest", ["999999"]);
    const result = await executeHandoff(app, id, "researcher", { user: scoped.user, summary });
    const next = cid(result.id);

    await delivered(next);
    assert.equal(app.canSee(scoped.user, next), true);
    assert.equal(app.canSee(viewer.user, next), true);
    assert.equal(app.canSee(elsewhere.user, next), false);
    assert.equal(app.cwdOf(next), work);
    assert.equal(app.attribution.requesterOf(next), scoped.user.id);
    const limited = app.config.addUser("Only successor", "guest", [String(next)]).user;
    const projected = await app.workItems.list(next, limited);

    assert.equal(projected.workItem?.title, "Work item");
    assert.deepEqual(projected.workItem?.threadIds, [Number(next)]);
    assert.equal(projected.workItem?.originThreadId, undefined);
    assert.deepEqual(projected.handoffs, []);
    assert.equal("accessFrom" in app.sessions(limited)[0]!, false);
    await assert.rejects(
        app.workItems.updateWorkItem(next, limited, { archived: true }),
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

// Receipt lookup recovers a lost HTTP acknowledgement, not a second input or a legacy summary retry.
// Unlike tool replay tests, this exercises the authenticated browser-facing, lookup-only transport.
test("input receipt lookup is passive, human-bound and available after a successful tool retires its source", async () => {
    const id = await source();
    const requestId = "lost-input-acknowledgement";
    const path = `/submit?requestId=${requestId}`;
    const count = app.sessions().length;
    const before = (await entries(id)).length;

    assert.equal((await http(id, path)).status, 404);
    assert.equal((await entries(id)).length, before);
    assert.equal(app.sessions().length, count);
    const accepted = await app.commands.submit(id, owner(app), {
        text: '/handoff researcher CALL_HANDOFF {"action":"start","targetType":"researcher","summary":"Investigate receipt recovery only."}',
        requestId,
    });

    await (await app.harness.submission(accepted.submissionId, context))!.wait(context);
    const record = Object.values((await app.harness.snapshot(HandoffsDoc, context))!.handoffs).find(
        (record) => record.sourceThreadId === Number(id),
    );

    assert.ok(record);
    assert.equal(app.workItems.isReadOnly(id), true);
    const recovered = await http(id, path);

    assert.equal(recovered.status, 200, recovered.output);
    assert.deepEqual(JSON.parse(recovered.output), accepted);
    assert.equal(JSON.parse(recovered.output).handoffRequestKey, record.requestKey);
    const guest = app.config.addUser("Other receipt requester", "guest");
    const viewer = app.config.addUser("Receipt viewer", "viewer");
    const elsewhere = app.config.addUser("Receipt outside scope", "guest", ["999999"]);

    assert.equal((await http(id, path, undefined, guest.token)).status, 404);
    assert.equal((await http(id, path, undefined, viewer.token)).status, 403);
    assert.equal((await http(id, path, undefined, elsewhere.token)).status, 404);
    assert.equal((await http(id, path, undefined, null)).status, 401);
    assert.equal((await http(id, "/submit?requestId=")).status, 400);
    assert.equal((await http(id, path)).status, 200);
    assert.equal((await entries(id)).filter((entry) => entry.kind === "pi.user").length, 1);
    assert.equal(app.sessions().length, count + 1);
    await delivered(cid(record.targetThreadId));
});

// New owner: the core navigation projection is person-bound, exact-source and passive even after
// retirement/module disposal. Tool provenance/replay tests do not exercise this read-only API contract.
test("transfer receipts expose only the current person's visible exact-source transfers without workflow admission", async () => {
    const id = await source();

    await say(app, id, "SPAWN_CHILD");
    const child = (await app.harness.snapshot(SubagentsDoc, id, context))?.agents.writer
        ?.conversationId;

    assert.ok(child);
    await until(async () => {
        try {
            await app.harness.commit((tx) => app.workItems.requireIdle(tx, id), context);

            return true;
        } catch {
            return false;
        }
    }, "receipt fixture's helper and report settle");
    const transfer = await executeHandoff(app, id, "researcher");
    const target = cid(transfer.id);

    await delivered(target);
    const record = (await app.harness.snapshot(HandoffsDoc, context))!.handoffs[
        transfer.handoffId
    ]!;
    const expected = {
        transfers: [
            {
                sourceThreadId: Number(id),
                targetThreadId: Number(target),
                requestKey: record.requestKey,
            },
        ],
    };
    const other = app.config.addUser("Other transfer requester", "guest").user;
    const outside = app.config.addUser("Hidden transfer source", "guest", ["999999"]).user;

    assert.deepEqual(app.workItems.receipts(id, owner(app)), expected);
    assert.deepEqual(app.workItems.receipts(id, other), { transfers: [] });
    assert.deepEqual(app.workItems.receipts(target, owner(app)), { transfers: [] });
    assert.deepEqual(
        app.workItems.receipts(child, owner(app)),
        { transfers: [] },
        "a helper ID does not alias its root's outgoing receipts",
    );
    assert.throws(() => app.workItems.receipts(id, outside), status(404));
    const otherSource = await source();
    const otherTransfer = await executeHandoff(app, otherSource, "researcher", { user: other });
    const otherTarget = cid(otherTransfer.id);

    await delivered(otherTarget);
    const otherRecord = (await app.harness.snapshot(HandoffsDoc, context))!.handoffs[
        otherTransfer.handoffId
    ]!;
    const own = {
        transfers: [
            {
                sourceThreadId: Number(otherSource),
                targetThreadId: Number(otherTarget),
                requestKey: otherRecord.requestKey,
            },
        ],
    };

    app.config.updateUser(other.id, { role: "viewer" });
    assert.deepEqual(
        app.workItems.receipts(otherSource, other),
        own,
        "lookup needs no steering rights",
    );
    await app.harness.commit(async (tx) => {
        (await tx.doc(SessionsDoc)).items[String(otherTarget)]!.ownerOnly = true;
    }, context);
    assert.deepEqual(app.workItems.receipts(otherSource, other), { transfers: [] });
    await app.harness.commit(async (tx) => {
        delete (await tx.doc(SessionsDoc)).items[String(otherTarget)]!.ownerOnly;
    }, context);
    await app.setWorkItemsEnabled(owner(app), false);

    try {
        await withWorkflowPublicationLock(app, otherTarget, async () => {
            assert.deepEqual(app.workItems.receipts(id, owner(app)), expected);
            assert.deepEqual(app.workItems.receipts(otherSource, other), own);
        });
    } finally {
        await app.setWorkItemsEnabled(owner(app), true);
    }

    app.config.removeUser(other.id);
    assert.throws(() => app.workItems.receipts(otherSource, other), status(401));
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

        await assert.rejects(
            start(id, "researcher", "writer-busy"),
            /delegated helpers|pending subagent reports/,
        );
        assert.equal(app.sessions().length, count);
        assert.equal(app.isBusy(child), true);
        assert.ok(
            (await app.workItems.list(id, owner(app))).options.every((option) => !option.enabled),
        );
    } finally {
        childGate.release();
        childGate = undefined;
    }

    await until(async () => {
        try {
            await app.harness.commit((tx) => app.workItems.requireIdle(tx, id), context);

            return true;
        } catch {
            return false;
        }
    }, "helper and reporter settle");
    await withWorkflowPublicationLock(app, id, async () => {
        await assert.rejects(
            start(id, "researcher", "exclusive-activation"),
            /publication.*(?:executing|in flight)/i,
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

    assert.equal(app.workItems.isReadOnly(child), true);
    assert.equal(
        (await app.envFor(child).writeFile("forbidden-child.txt", "bad", context)).ok,
        false,
    );
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
    assert.equal((await app.workItems.list(next, owner(app))).workItem?.title, title);
    assert.equal(titlePrompts.length, titlesBefore + 1);
    assert.match(titlePrompts.at(-1)!, /Original ask: repair retry delivery/);
    assert.match(titlePrompts.at(-1)!, /Deferred: Chromium unavailable/);
    assert.ok(titleUsage);
    const namedLedger = await app.harness.snapshot(UsageDoc, next, context);

    assert.deepEqual(
        namedLedger?.models["faux/faux-1"],
        titleUsage,
        "naming usage is committed before the destination's first assistant answer",
    );
    assert.equal(app.workItems.isReadOnly(id), true);
    assert.equal(app.workItems.isReadOnly(next), false);
    const receipts = app.workItems.receipts(id, owner(app));

    await app.close();
    courierGate.release();
    courierGate = undefined;
    app = await openApp(model, data);
    await delivered(next);
    const settledLedger = await app.harness.snapshot(UsageDoc, next, context);
    const count = app.sessions().length;

    await withWorkflowPublicationLock(app, next, async () => {
        assert.deepEqual(app.workItems.receipts(id, owner(app)), receipts);
    });
    assert.deepEqual(await app.harness.snapshot(UsageDoc, next, context), settledLedger);
    assert.equal(titlePrompts.length, titlesBefore + 1, "recovery does not name or bill twice");
    assert.equal(app.sessions().length, count);
    assert.equal((await entries(next)).filter((entry) => entry.kind === "pi.user").length, 1);
    assert.equal(app.attribution.requesterOf(next), owner(app).id);

    // Revocation after atomic creation can block a real courier. Passive receipts must not retry it.
    const blockedSource = await source();
    const requester = app.config.addUser("Blocked courier requester", "guest").user;
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
    let blocked: Awaited<ReturnType<typeof executeHandoff>>;

    try {
        blocked = await executeHandoff(app, blockedSource, "researcher", {
            relationship: "new-work",
            user: requester,
            summary,
        });
        await until(
            async () =>
                (await app.harness.snapshot(HandoffsDoc, context))?.handoffs[blocked.handoffId]
                    ?.delivery === "blocked",
            "courier observes post-activation authorization loss",
        );
    } finally {
        await watch.stop();
    }

    const blockedTarget = cid(blocked.id);

    await app.harness.commit((tx) => app.workItems.requireIdle(tx, blockedTarget), context);
    const tasksBeforeLookup = (
        await app.harness.commit(
            (tx) => tx.scanTasks({ conversationId: blockedTarget }, 100),
            context,
        )
    ).items.map((task) => task.id);
    const callsBeforeLookup = model.state.callCount;

    assert.equal(revoked, true);
    const lookup = app.workItems.receipts(blockedSource, requester);

    assert.deepEqual(
        lookup.transfers.map(({ sourceThreadId, targetThreadId }) => ({
            sourceThreadId,
            targetThreadId,
        })),
        [{ sourceThreadId: Number(blockedSource), targetThreadId: Number(blockedTarget) }],
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
        "passive receipt recovery creates no destination task",
    );
    assert.equal(model.state.callCount, callsBeforeLookup, "lookup never retries provider work");
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
    const item = (await app.workItems.list(worker, owner(app))).workItem!;
    const created = await start(worker, "worker", "new-worker-item", "new-work");
    const next = cid(created.id);

    await delivered(next);
    const nextItem = (await app.workItems.list(next, owner(app))).workItem!;
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
    assert.equal((await app.workItems.list(repair, owner(app))).workItem?.title, "Renamed origin");
    await app.close();
    app = await openApp(model, data);
    const count = app.sessions().length;
    const receipts = app.workItems.receipts(id, owner(app));

    assert.equal(receipts.transfers.length, 1);
    assert.equal(receipts.transfers[0]?.targetThreadId, Number(repair));
    assert.equal(app.sessions().length, count);
    assert.equal(app.workItems.isReadOnly(id), true);
    assert.equal(app.workItems.isReadOnly(repair), true);
    assert.equal(app.workItems.isReadOnly(worker), true);
    assert.equal(app.workItems.isReadOnly(next), false);
    assert.deepEqual(
        (await app.workItems.list(worker, owner(app))).workItem?.threadIds,
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
    const first = await app.workItems.fingerprint(id, owner(app));

    writeFileSync(join(cwd, "code.txt"), "changedB\n");
    assert.notEqual(
        await app.workItems.fingerprint(id, owner(app)),
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

// The public declaration, not a hardcoded role union, controls starter and diff-constrained admission.
// Existing builtin matrix tests cannot catch a registry ignored by project creation or final transfer.
test("a namespaced workflow creates typed starters and enforces declared dirty and clean handoffs", async (t) => {
    const profiles = ["start", "dirty", "clean"].map((name) => ({
        id: `custom-flow:${name}`,
        name,
        description: `A ${name} profile supplied by an extension.`,
        title: `Custom ${name}`,
        prompt: `Act as the custom ${name} agent; follow shared runtime restrictions.`,
        starter: name === "start",
    }));
    const definition = {
        id: "custom-flow:work",
        profiles,
        transitions: [
            {
                from: "custom-flow:start",
                to: "custom-flow:dirty",
                relationship: "same-work",
                currentDiff: true,
            },
            {
                from: "custom-flow:start",
                to: "custom-flow:clean",
                relationship: "same-work",
                currentDiff: false,
            },
        ],
    };

    writeFileSync(
        join(app.dataDir, "extensions", "custom-flow.ts"),
        `export default (_host, web) => { web.workflow(${JSON.stringify(definition)}); };`,
    );
    await app.setExtensionEnabled(owner(app), "custom-flow.ts", true);
    let changes = unchanged;

    t.mock.method(app.workspace, "changes", async () => changes);

    try {
        await assert.rejects(
            app.commands.createSession(owner(app), {
                cwd: work,
                threadType: "custom-flow:dirty",
            }),
            /starter profile/,
        );
        const { id } = await app.commands.createSession(owner(app), {
            cwd: work,
            threadType: "custom-flow:start",
        });

        await app.commands.configure(id, owner(app), {
            model: { provider: "faux", modelId: "faux-1" },
        });
        assert.equal(app.sessionMeta(id)?.threadType, "custom-flow:start");
        assert.deepEqual(
            (await app.workItems.list(id, owner(app))).options.map((option) => option.targetType),
            ["custom-flow:clean"],
        );
        await assert.rejects(
            start(id, "custom-flow:dirty", "custom-dirty-rejected"),
            /no current Pi diff/i,
        );
        changes = changed;
        assert.deepEqual(
            (await app.workItems.list(id, owner(app))).options.map((option) => option.targetType),
            ["custom-flow:dirty"],
        );
        await assert.rejects(
            start(id, "custom-flow:clean", "custom-clean-rejected"),
            /no current Pi diff matching.*requirements/i,
        );
        const target = await move(id, "custom-flow:dirty", "custom-dirty-accepted");

        assert.equal(app.sessionMeta(target)?.threadType, "custom-flow:dirty");
        assert.equal(app.sessionMeta(target)?.workItemId, app.sessionMeta(id)?.workItemId);
        assert.equal(app.workItems.isReadOnly(id), true);
        const fresh = await app.commands.createSession(owner(app), {
            cwd: work,
            threadType: "custom-flow:start",
        });

        await app.commands.configure(fresh.id, owner(app), {
            model: { provider: "faux", modelId: "faux-1" },
        });
        changes = unchanged;
        const clean = await move(fresh.id, "custom-flow:clean", "custom-clean-accepted");

        assert.equal(app.sessionMeta(clean)?.threadType, "custom-flow:clean");
        await app.setWorkItemsEnabled(owner(app), false);

        try {
            const project = await app.projects.create(owner(app), {
                name: "Custom starter",
                cwd: work,
                requestId: crypto.randomUUID(),
            });
            const initial = await app.commands.createSession(owner(app), { projectId: project.id });

            assert.equal(app.sessionMeta(initial.id)?.threadType, "custom-flow:start");
        } finally {
            await app.setWorkItemsEnabled(owner(app), true);
        }
    } finally {
        await app.setExtensionEnabled(owner(app), "custom-flow.ts", false);
    }
});
