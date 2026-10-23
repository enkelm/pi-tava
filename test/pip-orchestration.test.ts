import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { createHandler } from "../src/server/http.ts";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { awaitWithContext } from "@earendil-works/chord/context";
import { PipWorkDoc, SubagentsDoc } from "../src/server/docs.ts";
import type { AuxiliaryUsage } from "../src/server/spend.ts";
import { HandoffsDoc, WorkflowDoc } from "../src/server/workflow-docs.ts";
import {
    activateWorkPip,
    cleanUp,
    context,
    fakeTab,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    say,
    setWorkPipLimits,
    scriptedModel,
    until,
    recordCost,
    type App,
} from "./helpers.ts";

const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
    fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const text = (value: string) => fauxAssistantMessage([fauxText(value)]);
const idOf = (value: number) => value as ConversationId;

after(cleanUp);

const execution = (app: App) => newSession(app, app.defaultCwd, "worker");

test("PiP owner input reads canonical work before asking and reopening never renews delegation", async (t) => {
    let source!: ConversationId;
    let step = 0;
    const model = scriptedModel((request) => {
        const system = JSON.stringify(
            request.messages.filter((message) => message.role === "system"),
        );
        const last = lastText(request);

        if (!system.includes("the private supervisor for Work Item")) {
            return text("Investigation settled; next priority is not yet decided.");
        }

        assert.match(
            system,
            /opening the chat alone grants no authority and dispatches nothing.*not a fabricated human task/,
        );
        assert.match(system, /one or two focused questions/);

        switch (step++) {
            case 0:
                assert.equal(last.text, "Read the current task and ask about its next priority.");

                return tool("work_context", { session: Number(source), action: "status" });
            case 1:
                assert.match(last.text, /workItem/);

                return tool("work_context", { session: Number(source), action: "thread" });
            case 2:
                assert.match(
                    last.text,
                    /Investigate the next task; no implementation or landing yet/,
                );

                return tool("work_context", { session: Number(source), action: "discussion" });
            case 3:
                assert.match(last.text, /Should we prioritize latency or clarity/);

                return tool("work_supervise", {
                    action: "ask",
                    text: "Is latency or clarity the next priority?",
                });
            case 4:
                assert.match(last.text, /Prioritize clarity; investigate only/);

                return tool("work_supervise", {
                    action: "finish",
                    text: "Clarification recorded; no execution or publication authorized.",
                });
            default:
                throw new Error("Opening an existing chat must not buy another response.");
        }
    });
    const directory = join(root, "orchestrator-one-click");
    let app = await openApp(model, directory);

    t.after(() => app.close());
    source = await execution(app);
    await say(app, source, "Investigate the next task; no implementation or landing yet.");
    await app.reviews.comment(source, owner(app), {
        requestId: "priority",
        text: "Should we prioritize latency or clarity?",
    });
    const handler = createHandler({
        app,
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
    });

    const openRoute = async (token: string, id = source, action = "open") => {
        const incoming = new IncomingMessage(new Socket());
        const response = new ServerResponse(incoming);
        let output = "";

        incoming.method = "POST";
        incoming.url = `/api/c/${id}/orchestrator`;
        incoming.headers = {
            authorization: `Bearer ${token}`,
            "x-pocket": "1",
            "content-type": "application/json",
        };

        response.end = (chunk?: unknown) => {
            output = String(chunk ?? "");

            return response;
        };

        const handled = handler(incoming, response);

        incoming.push(Buffer.from(JSON.stringify({ action })));
        incoming.push(null);
        await handled;

        return new Response(output, { status: response.statusCode });
    };

    const results = await Promise.all(
        [1, 2, 3].map(async () => {
            const response = await openRoute(app.config.ownerToken!, source, "open");

            assert.equal(response.status, 200);

            return response.json();
        }),
    );
    const controller = idOf(results[0]!.orchestration!.conversationId);

    assert.ok(
        results.every((result) => result.orchestration!.conversationId === Number(controller)),
    );
    assert.equal(step, 0, "opening is inert, even under concurrent navigation");
    await app.commands.submit(controller, owner(app), {
        requestId: "read-priority",
        text: "Read the current task and ask about its next priority.",
    });
    const guest = app.config.addUser("Collaborator", "guest");

    assert.equal((await openRoute(guest.token)).status, 403);
    assert.equal((await openRoute(guest.token, controller)).status, 404);
    assert.equal((await openRoute("invalid-owner-token")).status, 401);
    await until(
        async () =>
            (await app.harness.snapshot(PipWorkDoc, controller, context))?.question !== undefined &&
            !app.isBusy(controller),
        "context reads and material chat question",
    );
    const question = (await app.harness.snapshot(PipWorkDoc, controller, context))!.question!;

    assert.equal((await app.harness.snapshot(PipWorkDoc, controller, context))!.goal, "");
    assert.equal((await app.harness.snapshot(PipWorkDoc, controller, context))!.sequence, 0);
    assert.equal(step, 4);
    await recordCost(app, source, 0.3);
    await recordCost(app, controller, 0.1);
    await setWorkPipLimits(app, source, owner(app), { budget: 2 });
    const grant = { ...app.workItems.itemFor(source)!.supervisor! };

    await app.pip.orchestration.control(source, owner(app), { action: "open" });
    assert.deepEqual(
        app.workItems.itemFor(source)!.supervisor,
        grant,
        "opening never changes paused grants, usage or limits",
    );
    assert.equal(
        (await app.harness.snapshot(PipWorkDoc, controller, context))!.question!.id,
        question.id,
    );
    const tab = fakeTab(controller, owner(app));

    await app.attach(tab.client);
    assert.deepEqual(
        (tab.last("view")!.conversation as { workSupervisor?: unknown }).workSupervisor,
        { conversationId: Number(controller), status: "reclaimed", epoch: grant.epoch },
    );
    app.detach(tab.client);
    await app.pip.orchestration.control(source, owner(app), { action: "reclaim" });
    await assert.rejects(
        app.pip.orchestration.control(source, owner(app), { action: "takeover" }),
        /Send a new message in the PiP Thread/,
    );
    const delegated = await app.pip.orchestration.inspect(source, owner(app));

    assert.equal(delegated.orchestration!.conversationId, Number(controller));
    assert.equal(delegated.orchestration!.status, "reclaimed");
    assert.equal(delegated.orchestration!.question!.id, question.id);
    assert.equal(delegated.orchestration!.maxCost, grant.maxCost);
    assert.equal(delegated.orchestration!.actions, grant.actions);
    assert.equal(
        step,
        4,
        "takeover preserves the pending question instead of buying a new response",
    );
    await app.commands.submit(controller, owner(app), {
        pipQuestionId: question.id,
        requestId: "priority-answer",
        text: "Prioritize clarity; investigate only.",
    });
    await until(() => step === 5 && !app.isBusy(controller), "correlated chat continuation");
    await app.pip.orchestration.control(source, owner(app), { action: "reclaim" });
    const reclaimed = { ...app.workItems.itemFor(source)!.supervisor! };

    await app.close();
    app = await openApp(model, directory);
    await app.pip.orchestration.control(source, owner(app), { action: "open" });
    assert.deepEqual(
        app.workItems.itemFor(source)!.supervisor,
        reclaimed,
        "reopening after restart does not silently redelegate reclaimed work",
    );
    assert.equal(app.spend.workSpent(source), 0.4);
    assert.equal(step, 5);
});

test("a work supervisor attaches without resending, drives a real handoff, and recovers an exact human decision after restart", async (t) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    let source!: ConversationId;
    let target = 0;
    let discussion = "";
    let step = 0;
    const scopeRequests: string[] = [];
    const model = scriptedModel(async (request) => {
        const system = JSON.stringify(
            request.messages.filter((message) => message.role === "system"),
        );
        const last = lastText(request);

        if (!system.includes("the private supervisor for Work Item")) {
            if (
                last.text.replace(/^\[from: [^\]]+\] /, "") === "HELD_ORIGINAL_TASK" &&
                last.role === "user"
            ) {
                await held;

                return tool("handoff", {
                    action: "start",
                    targetType: "researcher",
                    summary:
                        "An old execution run must not advance roles while PiP controls the work.",
                });
            }

            return text("Execution report: inspected the requested work; no edits claimed.");
        }

        scopeRequests.push(JSON.stringify(request.messages));

        if (step === 4) {
            target = JSON.parse(last.text).id;
        }

        const plan = [
            () => tool("work_context", { session: Number(source), action: "thread" }),
            () =>
                tool("work_supervise", {
                    action: "wait",
                    text: "Attached to running work; waiting without resending.",
                }),
            () => tool("work_context", { session: Number(source), action: "thread" }),
            () =>
                tool("work_handoff", {
                    session: Number(source),
                    targetType: "researcher",
                    summary:
                        "Investigate the remaining uncertainty; retain observed evidence and human limits.",
                    instructions: "Report facts, not invented completion.",
                }),
            () => text(`Research continues in /s/${target}.`),
            () => tool("work_context", { session: target, action: "thread" }),
            () =>
                tool("work_supervise", {
                    action: "ask",
                    text: "Should the known discussion be resolved based on this evidence?",
                }),
            () => tool("work_context", { session: Number(source), action: "discussion" }),
            () =>
                tool("work_review", {
                    session: Number(source),
                    action: "resolve",
                    threadIds: [discussion],
                }),
            () =>
                tool("work_supervise", {
                    action: "finish",
                    text: "Discussion resolved as requested; code correctness and publication were not certified.",
                }),
        ];
        const next = plan[step++];

        assert.ok(
            next,
            "only meaningful lifecycle events and the explicit answer should buy a supervisor response",
        );

        return next();
    });
    const directory = join(root, "orchestrator-lifecycle");
    let app = await openApp(model, directory);

    t.after(async () => {
        release();
        await app.close();
    });
    source = await execution(app);
    const notifications: Parameters<typeof app.alerts.push>[] = [];

    t.mock.method(app.alerts, "push", async (...args: Parameters<typeof app.alerts.push>) => {
        notifications.push(args);
    });
    const me = owner(app);
    const global = await app.pip.ensure(me);

    await say(app, global, "GLOBAL_PRIVATE_HISTORY_SENTINEL");
    discussion = (
        await app.reviews.comment(source, me, {
            requestId: "existing-discussion",
            text: "Keep the evidence explicit.",
        })
    ).id;
    await app.commands.submit(source, me, {
        requestId: "original-task",
        text: "HELD_ORIGINAL_TASK",
    });
    await until(() => app.isBusy(source), "running source");
    const started = await activateWorkPip(app, source, me, {
        text: "Supervise this investigation, ask before resolving discussion, and stop with an honest report.",
        budget: 5,
        maxActions: 20,
    });
    const controller = idOf(started.orchestration!.conversationId);

    await until(
        async () =>
            (await app.harness.snapshot(PipWorkDoc, controller, context))?.reason ===
                "Attached to running work; waiting without resending." && !app.isBusy(controller),
        "observed attachment",
    );
    const sourceEntries = await app.transcripts.allEntries(source, true);

    assert.equal(
        sourceEntries.filter((entry) => entry.kind === "user").length,
        1,
        "takeover does not resend the original task",
    );
    assert.equal(app.pip.idOf(me.id), global, "the global panel retains its own identity");
    assert.ok(
        !app.workItems.members(source).includes(controller),
        "passive controller is not an execution writer or descendant",
    );
    assert.ok(!app.sessions(me).some((session) => session.id === Number(controller)));
    const guest = app.config.addUser("Collaborator", "guest").user;

    assert.equal(app.canSee(guest, controller), false);
    assert.ok(app.sessions(guest).every((session) => !("supervisor" in session)));
    assert.equal(
        (app.workItems.context(source, me).workItem as Record<string, unknown>).supervisor,
        undefined,
        "common work reads do not expose the private grant",
    );
    release();
    await until(
        async () =>
            (await app.transcripts.allEntries(source, true)).some(
                (entry) => entry.kind === "toolResult" && entry.name === "handoff",
            ),
        "old execution run's handoff denial",
    );
    const rejectedWorkerHandoff = (await app.transcripts.allEntries(source, true)).find(
        (entry) => entry.kind === "toolResult" && entry.name === "handoff",
    );

    assert.ok(rejectedWorkerHandoff?.kind === "toolResult");
    assert.equal(rejectedWorkerHandoff.isError, true);
    assert.match(rejectedWorkerHandoff.text, /PiP currently controls/);
    await until(
        async () =>
            (await app.harness.snapshot(PipWorkDoc, controller, context))?.question !== undefined &&
            !app.isBusy(controller),
        "handoff successor and durable question",
    );
    assert.ok(target > 0);
    assert.equal(app.workItems.itemFor(source)?.activeThreadId, target);
    assert.equal(app.workItems.itemFor(source)?.supervisor?.conversationId, Number(controller));
    assert.equal((await app.harness.snapshot(WorkflowDoc, source, context))?.readOnly, true);
    const transfers = await app.harness.snapshot(HandoffsDoc, context);
    const record = Object.values(transfers!.handoffs).find(
        (handoff) => handoff.targetThreadId === target,
    )!;

    assert.ok(record.file);
    assert.equal(record.brief, undefined);
    assert.match(readFileSync(record.file, "utf8"), /PiP direction/);
    assert.doesNotMatch(readFileSync(record.file, "utf8"), /<human_handoff_direction>/);
    assert.ok(
        scopeRequests.every((request) => !request.includes("GLOBAL_PRIVATE_HISTORY_SENTINEL")),
    );
    const question = (await app.harness.snapshot(PipWorkDoc, controller, context))!.question!;
    const beforeRestart = scopeRequests.length;
    const notice = notifications.find(
        ([, , kind, message]) => kind === "chat" && message.tag === question.id,
    );

    assert.ok(notice, "the saved question requests a human chat notification");
    assert.equal(notice[0], me.id);
    assert.equal(notice[1], controller);
    assert.equal(
        notice[3].url,
        `/s/${controller}`,
        "questions open their own private work conversation, never the global panel",
    );
    await app.close();
    app = await openApp(model, directory);
    assert.equal(
        (await app.pip.orchestration.inspect(source, owner(app))).orchestration!.question!.id,
        question.id,
    );
    assert.equal(
        scopeRequests.length,
        beforeRestart,
        "restart does not regenerate a waiting question",
    );
    const privateTab = fakeTab(controller, owner(app));
    const executionTab = fakeTab(source, owner(app));

    await app.attach(privateTab.client);
    await app.attach(executionTab.client);
    assert.deepEqual(privateTab.field("pipQuestion"), {
        id: question.id,
        text: question.text,
        entryId: question.entryId,
    });
    assert.equal(executionTab.field("pipQuestion"), null, "questions never enter execution rooms");
    assert.ok(!JSON.stringify(privateTab.events).includes('"humanInputs"'));

    await assert.rejects(
        app.commands.submit(source, owner(app), {
            pipQuestionId: question.id,
            text: "Yes",
            requestId: "outside-chat",
        }),
        /private PiP chat/,
    );
    await assert.rejects(
        app.commands.submit(controller, owner(app), {
            pipQuestionId: "wrong-question",
            text: "Yes",
            requestId: "decision-1",
        }),
        /no longer waiting/,
    );
    const decision = {
        pipQuestionId: question.id,
        text: "Resolve that discussion; do not claim code verification.",
        requestId: "decision-1",
    };
    const receipt = await app.commands.submit(controller, owner(app), decision);

    assert.deepEqual(
        await app.commands.submissionReceipt(controller, owner(app), decision.requestId),
        receipt,
        "ordinary composer acknowledgement recovery finds this exact answer",
    );
    await until(
        async () =>
            (await app.pip.orchestration.inspect(source, owner(app))).orchestration?.status ===
                "reclaimed" && !app.isBusy(controller),
        "decision continuation and explicit finish",
    );
    const saved = await app.harness.snapshot(PipWorkDoc, controller, context);
    const review = (await app.reviews.list(source, owner(app))).threads[0]!;

    assert.equal(saved!.questions[0]!.id, question.id);
    assert.equal(saved!.questions[0]!.answer!.by, owner(app).id);
    assert.deepEqual(
        (await app.transcripts.allEntries(controller, true)).filter(
            (entry) => entry.kind === "pipQuestion",
        ),
        [
            {
                id: question.entryId,
                kind: "pipQuestion",
                questionId: question.id,
                text: question.text,
            },
        ],
        "the complete ask remains visible once in chat history after reply and restart",
    );
    const chatEntries = await app.transcripts.allEntries(controller, true);
    const reply = chatEntries.findLast((entry) => entry.kind === "user");

    assert.equal(reply?.kind === "user" && reply.text, decision.text);
    assert.match(
        (await app.transcripts.exportMarkdown(controller, owner(app))).markdown,
        /PiP asks:/,
    );
    assert.equal(review.resolved, true);
    assert.equal(review.resolution?.service, "pip");
    assert.equal(review.resolution?.onBehalfOf?.id, owner(app).id);
    assert.equal(step, 10, "ask, wait and finish yield without buying an acknowledgement response");
    assert.match(saved!.reason!, /code correctness and publication were not certified/);
    const answeredEntries = (await app.transcripts.allEntries(controller, true)).filter(
        (entry) => entry.kind === "user",
    ).length;

    await until(() => privateTab.field("pipQuestion") === null, "accepted answer clears chat ask");
    app.detach(privateTab.client);
    app.detach(executionTab.client);
    assert.deepEqual(await app.commands.submit(controller, owner(app), decision), receipt);
    assert.equal(
        (await app.transcripts.allEntries(controller, true)).filter(
            (entry) => entry.kind === "user",
        ).length,
        answeredEntries,
        "an accepted answer retry after completion cannot buy or submit another response",
    );
    await assert.rejects(
        app.commands.submit(controller, owner(app), {
            ...decision,
            text: "Different decision",
        }),
        /different answer/,
    );
    await recordCost(app, source, 0.7);
    await recordCost(app, idOf(target), 0.4);
    await recordCost(app, controller, 0.2);
    assert.ok(
        Math.abs(app.spend.workSpent(source) - 1.3) < 0.000001,
        "work accounting includes old and new execution roots and the separate controller exactly once",
    );
    await recordCost(app, source, 4);
    assert.throws(() => app.spend.check(owner(app), idOf(target)), /work item.*spend limit/);
    assert.throws(() => app.spend.check(owner(app), controller), /work item.*spend limit/);
    await app.pip.orchestration.control(source, owner(app), { action: "reclaim" });
    assert.throws(
        () => app.spend.check(owner(app), idOf(target)),
        /work item.*spend limit/,
        "human control does not exempt cumulative work spend",
    );
    await assert.rejects(
        app.commands.submit(controller, owner(app), {
            requestId: "after-reclaim",
            text: "Do more work",
        }),
        /work item.*spend limit/,
    );
});

test("work-scoped PiP cannot escape through private tools, arbitrary reads or another visible thread", async (t) => {
    let source!: ConversationId;
    let other!: ConversationId;
    let review = "";
    let phase = 0;
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
        release = resolve;
    });
    const model = scriptedModel(async (request) => {
        const last = lastText(request);
        const scoped = JSON.stringify(
            request.messages.filter((message) => message.role === "system"),
        ).includes("the private supervisor for Work Item");

        if (!scoped) {
            if (last.text.includes("OTHER_THREAD_PRIVATE_SENTINEL") && last.role === "user") {
                await hold;
            }

            return text("Execution only.");
        }

        const plan = [
            () => tool("sessions", {}),
            () => tool("session_start", { folder: root, message: "Escape the work scope" }),
            () => tool("read", { path: join(root, "private.txt") }),
            () => tool("work_context", { session: Number(other), action: "thread" }),
            () =>
                tool("session_send", {
                    session: Number(other),
                    message: "Unrelated work must not receive this.",
                    report: false,
                }),
            () => tool("session_stop", { session: Number(other) }),
            () =>
                tool("work_review", {
                    session: Number(other),
                    action: "resolve",
                    threadIds: [review],
                }),
            () =>
                tool("work_handoff", {
                    session: Number(other),
                    targetType: "researcher",
                    summary: "Do not create an unrelated successor.",
                }),
            () =>
                tool("work_supervise", {
                    action: "finish",
                    text: "No action outside this work was authorized.",
                }),
            () => text("Scope boundaries retained."),
        ];

        return plan[phase++]!();
    });
    const app = await openApp(model, join(root, "orchestrator-scope"));

    t.after(async () => {
        release();
        await app.close();
    });
    source = await execution(app);
    other = await newSession(app);
    review = (
        await app.reviews.comment(other, owner(app), {
            requestId: "other-review",
            text: "Do not resolve from a different work controller.",
        })
    ).id;
    await app.commands.submit(other, owner(app), {
        text: "OTHER_THREAD_PRIVATE_SENTINEL",
        requestId: "other-active",
    });
    const view = await activateWorkPip(app, source, owner(app), {
        text: "Stay in this Work Item.",
        budget: 5,
        maxActions: 20,
    });
    const controller = idOf(view.orchestration!.conversationId);

    await until(
        async () =>
            (await app.pip.orchestration.inspect(source, owner(app))).orchestration?.status ===
                "reclaimed" && !app.isBusy(controller),
        "scope attempts and final report",
    );
    const entries = await app.transcripts.allEntries(controller, true);
    const results = entries.filter((entry) => entry.kind === "toolResult");
    const listing = results.find((entry) => entry.name === "sessions")!;

    assert.equal(listing.isError, false, listing.text);
    assert.match(listing.text, new RegExp(`#${source} `));
    assert.doesNotMatch(listing.text, new RegExp(`#${other} `));

    for (const result of results.filter(
        (entry) => !["sessions", "work_supervise"].includes(entry.name),
    )) {
        assert.equal(result.isError, true, `${result.name}: ${result.text}`);
        assert.doesNotMatch(result.text, /OTHER_THREAD_PRIVATE_SENTINEL/);
    }

    assert.equal(results.length, 9);
    assert.equal(app.isBusy(other), true, "the forged stop cannot cancel unrelated running work");
    assert.equal((await app.reviews.list(other, owner(app))).threads[0]!.resolved, false);
    assert.equal(
        Object.keys((await app.harness.snapshot(HandoffsDoc, context))!.handoffs).length,
        0,
    );
    assert.equal(
        (await app.transcripts.allEntries(other, true)).filter((entry) => entry.kind === "user")
            .length,
        1,
    );
    assert.equal(app.sessions(owner(app)).length, 2, "no unrestricted session was created");
});

test("a committed controller handoff replays after restart without a second target or a new inspection", async (t) => {
    let source!: ConversationId;
    let step = 0;
    const model = scriptedModel((request) => {
        if (
            !JSON.stringify(
                request.messages.filter((message) => message.role === "system"),
            ).includes("the private supervisor for Work Item")
        ) {
            return text("Execution report.");
        }

        const plan = [
            () => tool("work_context", { session: Number(source), action: "thread" }),
            () =>
                tool("work_handoff", {
                    session: Number(source),
                    targetType: "researcher",
                    summary: "Continue this exact investigation.",
                }),
            () =>
                tool("work_supervise", {
                    action: "finish",
                    text: "Transfer receipt recovered; waiting for the human.",
                }),
        ];

        return plan[step++]!();
    });
    const directory = join(root, "orchestrator-transfer-replay");
    let app = await openApp(model, directory);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    let committed = false;
    const original = app.pip.controllerHandoff.bind(app.pip);
    const mock = t.mock.method(
        app.pip,
        "controllerHandoff",
        async (...args: Parameters<typeof original>) => {
            const result = await original(...args);

            committed = true;
            await awaitWithContext(held, args[4]);

            return result;
        },
    );

    t.after(async () => {
        release();
        mock.mock.restore();
        await app.close();
    });
    source = await execution(app);
    const view = await activateWorkPip(app, source, owner(app), {
        text: "Transfer the investigation once.",
        budget: 5,
        maxActions: 10,
    });
    const controller = idOf(view.orchestration!.conversationId);

    await until(() => committed, "handoff committed before its native tool result settles");
    const before = await app.harness.snapshot(HandoffsDoc, context);
    const target = app.workItems.itemFor(source)!.activeThreadId;

    await app.close();
    release();
    mock.mock.restore();
    app = await openApp(model, directory);
    await until(
        async () =>
            (await app.pip.orchestration.inspect(source, owner(app))).orchestration?.status ===
                "reclaimed" && !app.isBusy(controller),
        "safe native tool replay and finish",
    );
    const result = (await app.transcripts.allEntries(controller, true)).findLast(
        (entry) => entry.kind === "toolResult" && entry.name === "work_handoff",
    );

    assert.ok(result?.kind === "toolResult");
    assert.equal(result.isError, false, result.text);
    assert.equal(JSON.parse(result.text).id, target);
    assert.equal(
        Object.keys((await app.harness.snapshot(HandoffsDoc, context))!.handoffs).length,
        Object.keys(before!.handoffs).length,
    );
    assert.equal(app.workItems.itemFor(source)!.activeThreadId, target);
    assert.equal(
        step,
        3,
        "restart replays the accepted native action, not the model's handoff decision, and finish buys no extra response",
    );
});

test("action limits survive restart and direct human steering pauses future orchestration", async (t) => {
    let calls = 0;
    const model = scriptedModel((request) => {
        if (
            !JSON.stringify(
                request.messages.filter((message) => message.role === "system"),
            ).includes("the private supervisor for Work Item")
        ) {
            return text("Human-directed execution report.");
        }

        calls++;

        if (calls === 2) {
            return tool("work_supervise", {
                action: "wait",
                text: "This extra action exceeds the first grant.",
            });
        }

        return lastText(request).role === "toolResult"
            ? text("Waiting for a meaningful event.")
            : tool("work_supervise", { action: "wait", text: "Observe, do not poll." });
    });
    const directory = join(root, "orchestrator-action-limit");
    let app = await openApp(model, directory);

    t.after(async () => {
        await app.close();
    });
    const source = await execution(app);
    const start = await activateWorkPip(app, source, owner(app), {
        text: "Bound this work.",
        budget: 5,
        maxActions: 1,
    });
    const controller = idOf(start.orchestration!.conversationId);

    await until(
        async () =>
            (await app.pip.orchestration.inspect(source, owner(app))).orchestration?.status ===
                "reclaimed" && !app.isBusy(controller),
        "durable action cap",
    );
    assert.equal(
        (await app.pip.orchestration.inspect(source, owner(app))).orchestration!.actions,
        1,
    );
    const before = calls;

    assert.equal(
        before,
        1,
        "an exhausted cap and a yielding wait must not fund another provider request",
    );
    await app.close();
    app = await openApp(model, directory);
    await say(app, source, "A human continues the work directly.");
    assert.equal(
        calls,
        before,
        "a restart or direct execution cannot silently replenish the action budget",
    );
    await activateWorkPip(app, source, owner(app), {
        text: "A new explicit delegation.",
        budget: 5,
        maxActions: 4,
    });
    await until(() => calls === before + 1 && !app.isBusy(controller), "explicitly renewed grant");
    await app.commands.abort(source, owner(app));
    assert.equal(
        (await app.pip.orchestration.inspect(source, owner(app))).orchestration!.status,
        "reclaimed",
        "the native human Stop control fences future orchestration too",
    );
    await activateWorkPip(app, source, owner(app), {});
    await until(
        () => calls === before + 2 && !app.isBusy(controller),
        "explicit resume after a human stop",
    );
    const epoch = (await app.pip.orchestration.inspect(source, owner(app))).orchestration!.epoch;

    await say(app, source, "Human steering supersedes the queued supervisor plan.");
    const paused = (await app.pip.orchestration.inspect(source, owner(app))).orchestration!;

    assert.equal(paused.status, "reclaimed");
    assert.ok(paused.epoch > epoch);
    const afterSteer = calls;

    await app.pip.orchestration.control(source, owner(app), { action: "reclaim" });
    await say(app, source, "Manual work after reclaim.");
    assert.equal(calls, afterSteer);
    assert.ok(
        app.canSee(owner(app), controller),
        "reclaim retains the private question/action history",
    );
});

test("new uncapped work can perform more than twenty native actions without a hidden cost cap", async (t) => {
    let actions = 0;
    let source!: ConversationId;
    let discussion = "";
    const model = scriptedModel((request) => {
        if (
            !JSON.stringify(
                request.messages.filter((message) => message.role === "system"),
            ).includes("the private supervisor for Work Item")
        ) {
            return text("Execution report.");
        }

        if (actions < 21) {
            actions++;

            return tool("work_review", {
                session: Number(source),
                action: "reply",
                threadId: discussion,
                text: `Clarification ${actions}: retain the evidence for this observation.`,
            });
        }

        return tool("work_supervise", {
            action: "finish",
            text: "Twenty-one authorized discussion replies completed; no code correctness claimed.",
        });
    });
    const app = await openApp(model, join(root, "orchestrator-uncapped"));

    t.after(() => app.close());
    source = await execution(app);
    discussion = (
        await app.reviews.comment(source, owner(app), {
            requestId: "uncapped-discussion",
            text: "Add the twenty-one requested evidence clarifications here, then finish.",
        })
    ).id;
    const started = await activateWorkPip(app, source, owner(app), {
        text: "Add twenty-one evidence clarifications to the discussion, then finish without a per-work cap.",
    });
    const controller = idOf(started.orchestration!.conversationId);

    await until(() => actions === 21 && !app.isBusy(controller), "twenty-one native actions");
    const view = (await app.pip.orchestration.inspect(source, owner(app))).orchestration!;
    const results = (await app.transcripts.allEntries(controller, true))
        .filter((entry) => entry.kind === "toolResult")
        .filter((entry) => entry.name === "work_review");

    assert.equal(view.actions, 22, "there is no default twenty-action ceiling, including finish");
    assert.equal(results.length, 21);
    assert.ok(results.every((entry) => !entry.isError));
    assert.equal((await app.reviews.list(source, owner(app))).threads[0]!.replies.length, 21);
    assert.equal(view.status, "reclaimed");
    assert.equal(view.maxActions, undefined);
    assert.equal(view.maxCost, undefined);
    await recordCost(app, source, 8);
    assert.doesNotThrow(() => app.spend.check(owner(app), source));
    assert.doesNotThrow(() => app.spend.check(owner(app), controller));
    assert.equal(app.spend.workSpent(source), 8, "uncapped does not mean unaccounted");
});

test("omitted caps preserve an explicit legacy grant and consumed actions across takeover, resume and restart", async (t) => {
    let calls = 0;
    const model = scriptedModel((request) => {
        if (
            JSON.stringify(
                request.messages.filter((message) => message.role === "system"),
            ).includes("the private supervisor for Work Item")
        ) {
            calls++;

            return lastText(request).role === "toolResult"
                ? text("Waiting for a work event.")
                : tool("work_supervise", { action: "wait", text: "Observe the legacy grant." });
        }

        return text("Execution report.");
    });
    const directory = join(root, "orchestrator-preserved-caps");
    let app = await openApp(model, directory);

    t.after(() => app.close());
    const source = await execution(app);
    const started = await activateWorkPip(app, source, owner(app), {
        text: "Keep the owner's explicit limits.",
        budget: 2,
        maxActions: 1,
    });
    const controller = idOf(started.orchestration!.conversationId);

    await until(async () => {
        const view = (await app.pip.orchestration.inspect(source, owner(app))).orchestration!;

        return view.actions === 1 && view.status === "reclaimed" && !app.isBusy(controller);
    }, "the explicit legacy action cap");
    await recordCost(app, source, 0.5);
    await app.close();
    app = await openApp(model, directory);
    const before = calls;

    await app.pip.orchestration.control(source, owner(app), { action: "reclaim" });

    for (const input of [
        { action: "takeover", goal: "Continue the same explicitly limited work." },
        { action: "resume" },
    ]) {
        await assert.rejects(
            app.pip.orchestration.control(source, owner(app), input),
            /Send a new message in the PiP Thread/,
        );
        await assert.rejects(
            activateWorkPip(app, source, owner(app), {
                text: "Continue within the existing caps.",
            }),
            /action budget/,
        );
        const view = (await app.pip.orchestration.inspect(source, owner(app))).orchestration!;

        assert.equal(view.maxCost, 2, "omission does not buy more cost authority");
        assert.equal(view.maxActions, 1, "omission does not replace the legacy action limit");
        assert.equal(view.actions, 1, "omission does not reset consumed actions");
        await until(
            async () =>
                (await app.pip.orchestration.inspect(source, owner(app))).orchestration!.status ===
                "reclaimed",
            "omitted caps cannot replenish an exhausted grant",
        );
        assert.equal(calls, before, "exhausted caps do not fund another provider request");
    }

    const cleared = (
        await setWorkPipLimits(app, source, owner(app), {
            maxActions: null,
        })
    ).orchestration!;

    assert.equal(cleared.status, "reclaimed");
    assert.equal(cleared.maxActions, undefined);
    assert.equal(cleared.actions, 1, "explicit removal preserves the action history");
    assert.equal(cleared.maxCost, 2, "removing the action limit does not remove the cost limit");
    await activateWorkPip(app, source, owner(app), {});
    await until(
        () => calls === before + 1 && !app.isBusy(controller),
        "explicit action cap removal",
    );
    assert.equal(
        (await app.pip.orchestration.inspect(source, owner(app))).orchestration!.actions,
        2,
    );
});

test("optional work caps include helper and auxiliary usage across restart and owner changes preserve the goal", async (t) => {
    let calls = 0;
    const model = scriptedModel((request) => {
        if (
            JSON.stringify(
                request.messages.filter((message) => message.role === "system"),
            ).includes("the private supervisor for Work Item")
        ) {
            calls++;

            return lastText(request).role === "toolResult"
                ? text("Waiting for a work event.")
                : tool("work_supervise", { action: "wait", text: "Observe the capped work." });
        }

        const last = lastText(request);

        if (last.role === "user" && last.text.endsWith("Delegate a cost-accounting helper.")) {
            return tool("subagent", {
                action: "spawn",
                name: "cost-helper",
                message: "Inspect the assigned evidence and report it to the parent.",
            });
        }

        return text("Execution report.");
    });
    const directory = join(root, "orchestrator-optional-cost");
    let app = await openApp(model, directory);

    t.after(() => app.close());
    const source = await execution(app);
    const goal = "Preserve this goal while the owner adjusts cost authority.";

    await say(app, source, "Delegate a cost-accounting helper.");
    await until(async () => {
        const agents = await app.harness.snapshot(SubagentsDoc, source, context);

        return (agents?.agents["cost-helper"]?.reported.length ?? 0) > 0 && !app.isBusy(source);
    }, "the real helper report");
    const helper = (await app.harness.snapshot(SubagentsDoc, source, context))!.agents[
        "cost-helper"
    ]!.conversationId;
    const receipt: AuxiliaryUsage = {
        receiptId: "work-helper-auxiliary",
        requesterId: owner(app).id,
        sourceConversationId: helper,
        provider: "faux",
        model: "faux-1",
        usage: {
            input: 0,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 1,
            cost: { input: 0, output: 0.25, cacheRead: 0, cacheWrite: 0, total: 0.25 },
        },
    };

    await recordCost(app, source, 9);
    await recordCost(app, helper, 0.25);
    await app.harness.commit((tx) => app.spend.recordAuxiliaryUsage(tx, receipt), context);
    const started = await activateWorkPip(app, source, owner(app), {
        text: goal,
        budget: 2,
    });
    const controller = idOf(started.orchestration!.conversationId);

    await until(() => calls === 1 && !app.isBusy(controller), "the initial capped observation");
    assert.equal(
        started.orchestration!.maxCost,
        11.5,
        "new cost authority includes prior root, helper and auxiliary usage",
    );
    await recordCost(app, controller, 0.5);
    await recordCost(app, source, 1);
    const before = calls;

    await app.close();
    app = await openApp(model, directory);
    await app.harness.commit((tx) => app.spend.recordAuxiliaryUsage(tx, receipt), context);

    for (const anchor of [source, helper, controller]) {
        const view = (await app.pip.orchestration.inspect(anchor, owner(app))).orchestration!;

        assert.equal(
            view.spent,
            11,
            "each anchor counts helpers, auxiliary and controller once after restart",
        );
    }

    assert.equal(calls, before, "restoring accounting does not regenerate the observed event");
    const changed = (
        await setWorkPipLimits(app, source, owner(app), {
            budget: 0.25,
        })
    ).orchestration!;

    assert.equal(changed.maxCost, 11.25, "updates add to actual cumulative usage, not the old cap");
    assert.equal(changed.spent, 11);
    assert.equal(changed.status, "reclaimed", "changing limits requires explicit resume");
    assert.equal(changed.actions, 1);
    assert.equal(changed.goal, "", "composer input does not fabricate a management goal");
    const goalInputs = (await app.transcripts.allEntries(controller, true)).filter(
        (entry) => entry.kind === "user" && entry.text === goal,
    );

    assert.equal(goalInputs.length, 1, "the actual human scope remains in the private transcript");
    assert.equal(changed.maxActions, undefined);
    assert.equal(calls, before, "changing limits does not buy a model response");
    await app.harness.commit(
        (tx) =>
            app.spend.recordAuxiliaryUsage(tx, {
                ...receipt,
                receiptId: "work-helper-cap-crossing",
                usage: {
                    ...receipt.usage,
                    cost: { ...receipt.usage.cost, output: 0.3, total: 0.3 },
                },
            }),
        context,
    );

    for (const anchor of [source, controller]) {
        const inputs = (await app.transcripts.allEntries(anchor, true)).filter(
            (entry) => entry.kind === "user",
        ).length;

        await assert.rejects(
            app.commands.submit(anchor, owner(app), {
                requestId: `over-work-cap-${anchor}`,
                text: "This input must not be admitted while the Work Item cap is exhausted.",
            }),
            /work item.*spend limit/,
        );
        assert.equal(
            (await app.transcripts.allEntries(anchor, true)).filter(
                (entry) => entry.kind === "user",
            ).length,
            inputs,
            "budget refusal admits no native input",
        );
    }

    const cleared = (
        await setWorkPipLimits(app, source, owner(app), {
            budget: null,
        })
    ).orchestration!;

    assert.equal(cleared.maxCost, undefined);
    assert.equal(cleared.actions, 1);
    assert.equal(cleared.goal, changed.goal);
    assert.equal(cleared.status, "reclaimed");
    assert.doesNotThrow(() => app.spend.check(owner(app), source));
    assert.doesNotThrow(() => app.spend.check(owner(app), controller));
    await app.spend.setSessionBudget(owner(app), source, 1);
    assert.throws(
        () => app.spend.check(owner(app), source),
        /session.*spend limit/,
        "removing a Work Item cap does not disable independent session limits",
    );
    const guest = app.config.addUser("Collaborator", "guest").user;

    await assert.rejects(
        app.pip.orchestration.control(source, guest, { action: "limits", budget: null }),
        /Only the currently signed-in owner/,
    );

    for (const budget of [0, -1, "1", Number.POSITIVE_INFINITY, 1000001]) {
        await assert.rejects(
            app.pip.orchestration.control(source, owner(app), { action: "limits", budget }),
            /budget/,
        );
    }
});

test("the real work provider receives review-before-landing guidance without treating idle or resolution as approval", async (t) => {
    let delivered = "";
    let bootstrap = "";
    const model = scriptedModel((request) => {
        const system = JSON.stringify(
            request.messages.filter((message) => message.role === "system"),
        );

        if (system.includes("the private supervisor for Work Item")) {
            delivered = system;
            bootstrap = lastText(request).text;
        }

        return text("Observed the work; no landing was requested.");
    });
    const app = await openApp(model, join(root, "orchestrator-review-guidance"));

    t.after(() => app.close());
    const source = await execution(app);
    const started = await activateWorkPip(app, source, owner(app), {
        text: "Coordinate implementation and review before landing.",
    });
    const controller = idOf(started.orchestration!.conversationId);

    await until(() => delivered !== "" && !app.isBusy(controller), "the actual provider request");
    assert.match(delivered, /before instructing.*stag.*commit/i);
    assert.match(delivered, /actual Reviewer outcome.*unresolved.*discussion/i);
    assert.match(delivered, /meaningful execution outcomes.*alignment.*human goal.*own.*reads/i);
    assert.match(delivered, /Reviewer.*at most two.*passes/i);
    assert.match(delivered, /eligible Follow-up.*bounded.*repairs/i);
    assert.match(delivered, /self-review.*delta.*immediate integration.*once/i);
    assert.match(delivered, /prior review.*source.*scope.*checkpoint/i);
    assert.match(delivered, /untouched work.*material rewrites.*stale/i);
    assert.match(delivered, /unavailable.*deferred.*alone.*not.*another Reviewer or Follow-up/i);
    assert.match(delivered, /manual-testing green light.*Land/i);
    assert.match(delivered, /local integration through ordinary offline bash\/Git/);
    assert.match(delivered, /no separate Land API\/action or required approval receipt/);
    assert.match(delivered, /settled Git exit\/output.*checkpoint.*preservation evidence/);
    assert.match(delivered, /supported standalone Git commands/);
    assert.match(
        delivered,
        /individual approval.*Git push\/send-pack\/receive-pack to file remotes/,
    );
    assert.match(delivered, /material new implementation.*initial independent Reviewer/i);
    assert.doesNotMatch(delivered, /then re-review the changed scope before landing/i);
    assert.equal(bootstrap, "Coordinate implementation and review before landing.");
    assert.match(delivered, /active role.*history.*options/i);
    assert.match(delivered, /Follow-up.*not fresh independent review/i);
    assert.match(delivered, /idle.*resolv.*finish.*not.*approval/i);
    assert.match(delivered, /explicit human override/i);
    assert.match(delivered, /publication.*individual human approval/i);
    assert.doesNotMatch(delivered, /\$undefined|action cap undefined/);
});

test("a failed supervisor response is retained across restart without automatic regeneration", async (t) => {
    let calls = 0;
    const model = scriptedModel((request) => {
        if (
            !JSON.stringify(
                request.messages.filter((message) => message.role === "system"),
            ).includes("the private supervisor for Work Item")
        ) {
            return text("Observed execution outcome.");
        }

        calls++;

        return fauxAssistantMessage([fauxText("Synthetic provider failure")], {
            stopReason: "error",
            errorMessage: "Synthetic provider failure",
        });
    });
    const directory = join(root, "orchestrator-provider-failure");
    let app = await openApp(model, directory);

    t.after(async () => {
        await app.close();
    });
    const source = await execution(app);
    const started = await activateWorkPip(app, source, owner(app), {
        text: "Do not retry an uncertain generation.",
        budget: 5,
        maxActions: 5,
    });
    const controller = idOf(started.orchestration!.conversationId);

    await until(
        async () =>
            (await app.pip.orchestration.inspect(source, owner(app))).orchestration?.status ===
                "reclaimed" && !app.isBusy(controller),
        "saved supervisor model failure",
    );
    const before = calls;

    await app.close();
    app = await openApp(model, directory);
    assert.match(
        (await app.pip.orchestration.inspect(source, owner(app))).orchestration!.reason!,
        /could not answer/,
    );
    await say(
        app,
        source,
        "A later source event must not regenerate the failed supervisor response.",
    );
    assert.equal(calls, before);
    assert.equal(
        (await app.pip.orchestration.inspect(source, owner(app))).orchestration!.status,
        "reclaimed",
    );
});
