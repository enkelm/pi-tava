import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { LiveDoc, type ConversationId } from "@earendil-works/pi-durable";
import { PipWorkDoc, SubagentsDoc } from "../src/server/docs.ts";
import {
    activateWorkPip,
    cleanUp,
    context,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
    type App,
} from "./helpers.ts";

const text = (value: string) => fauxAssistantMessage([fauxText(value)]);
const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
    fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const wait = () =>
    tool("work_supervise", { action: "wait", text: "Waiting for a meaningful execution outcome." });

async function settled(app: App, controller: ConversationId) {
    await until(async () => {
        const state = await app.harness.snapshot(PipWorkDoc, controller, context);
        const work = await app.harness.inspect(context);

        return (
            state?.lastInput !== undefined &&
            state.pending === undefined &&
            !app.isBusy(controller) &&
            work.tasks.every((task) => task.record.conversationId !== controller)
        );
    }, "the accepted supervisor event and its native turn to settle");
}

async function reconcile(app: App, controller: ConversationId) {
    // Exercise the real reconciliation boundary, so negative assertions need no arbitrary delay.
    await app.pip.orchestration.open();
    await settled(app, controller);
}

after(cleanUp);

for (const dispatched of [true, false]) {
    test(`${dispatched ? "dispatched" : "already-running"} execution stays silent through real tool rounds until a question yields`, async (t) => {
        const gates = Array.from({ length: 4 }, () => Promise.withResolvers<void>());
        let source!: ConversationId;
        let executionCalls = 0;
        let supervisorCalls = 0;
        const executionPrompts: string[] = [];
        const model = scriptedModel(async (request) => {
            const system = JSON.stringify(
                request.messages.filter((message) => message.role === "system"),
            );

            if (system.includes("the private supervisor for Work Item")) {
                supervisorCalls++;

                if (dispatched && supervisorCalls === 1) {
                    return tool("work_context", { session: Number(source), action: "thread" });
                }

                if (dispatched && supervisorCalls === 2) {
                    return tool("session_send", {
                        session: Number(source),
                        message: "Inspect the evidence and report any material question.",
                    });
                }

                return wait();
            }

            const step = executionCalls++;

            executionPrompts.push(system);
            await gates[step]!.promise;

            return step < 3
                ? tool("read", { path: "evidence.txt" })
                : text(
                      "Question: the evidence leaves two valid scopes. Which should I investigate?",
                  );
        });
        const directory = join(root, `semantic-execution-events-${dispatched}`);
        let app = await openApp(model, directory);

        t.after(async () => {
            gates.forEach((gate) => gate.resolve());
            await app.close();
        });
        writeFileSync(join(app.defaultCwd, "evidence.txt"), "Observed evidence, not completion.\n");
        source = await newSession(app, app.defaultCwd, "worker");

        if (!dispatched) {
            await app.commands.submit(source, owner(app), {
                requestId: "original-execution",
                text: "Inspect the evidence and report any material question.",
            });
            await until(() => executionCalls === 1, "the already-running execution request");
        }

        const started = await activateWorkPip(app, source, owner(app), {
            text: "Inspect the evidence and ask about material scope ambiguity.",
        });
        const controller = started.orchestration!.conversationId as ConversationId;

        await until(() => executionCalls === 1, "PiP's real dispatched execution request");
        await reconcile(app, controller);
        const initialCalls = dispatched ? 3 : 1;

        assert.equal(
            supervisorCalls,
            initialCalls,
            "dispatch or attachment must not buy a busy recheck",
        );

        for (let round = 0; round < 3; round++) {
            gates[round]!.resolve();
            await until(() => executionCalls === round + 2, "the next real execution generation");
            await reconcile(app, controller);
            assert.equal(
                supervisorCalls,
                initialCalls,
                "ordinary tool rounds must not fund supervisor polling",
            );
            assert.match(executionPrompts.at(-1)!, /PiP is supervising this Work Item/);
            assert.match(
                executionPrompts.at(-1)!,
                /Your settled result automatically notifies PiP/,
            );
            assert.doesNotMatch(executionPrompts.at(-1)!, /Human goal and scope:/);
        }

        const results = (await app.transcripts.allEntries(source, true)).filter(
            (entry) => entry.kind === "toolResult",
        );

        assert.equal(results.length, 3);
        assert.ok(results.every((entry) => entry.name === "read" && !entry.isError));
        gates[3]!.resolve();
        await until(
            () => supervisorCalls === initialCalls + 1,
            "one notification for the yielded question",
        );
        await reconcile(app, controller);
        const before = (await app.transcripts.allEntries(controller, true)).filter(
            (entry) => entry.kind === "user" || entry.kind === "appEvent",
        );

        assert.equal(before.length, 2, "initial attachment and one settled execution outcome");
        const event = before.find((entry) => entry.kind === "appEvent");

        assert.ok(
            event?.kind === "appEvent",
            "the real wake producer carries native app provenance",
        );
        assert.equal(
            event.source,
            Number(source),
            "the observation retains the exact execution source",
        );
        assert.equal(event.state, "idle", "a yielded question is idle, not verified success");
        assert.equal(app.workItems.itemFor(source)!.supervisor!.status, "running");
        await app.close();
        app = await openApp(model, directory);
        await reconcile(app, controller);
        assert.equal(
            supervisorCalls,
            initialCalls + 1,
            "startup must reconstruct the already-observed outcome",
        );
        assert.equal(
            (await app.transcripts.allEntries(controller, true)).filter(
                (entry) => entry.kind === "user" || entry.kind === "appEvent",
            ).length,
            before.length,
            "restart cannot submit the settled question twice",
        );
    });
}

test("a terminal execution failure without a final assistant answer wakes PiP once", async (t) => {
    const held = Promise.withResolvers<void>();
    let executionCalls = 0;
    let supervisorCalls = 0;
    const model = scriptedModel(async (request) => {
        if (
            JSON.stringify(
                request.messages.filter((message) => message.role === "system"),
            ).includes("the private supervisor for Work Item")
        ) {
            supervisorCalls++;

            return wait();
        }

        executionCalls++;
        await held.promise;

        return tool("read", { path: "evidence.txt" });
    });
    const directory = join(root, "semantic-execution-failure");
    let app = await openApp(model, directory);

    t.after(async () => {
        held.resolve();
        await app.close();
    });
    writeFileSync(
        join(app.defaultCwd, "evidence.txt"),
        "Evidence before model availability changed.\n",
    );
    const source = await newSession(app, app.defaultCwd, "worker");
    const sent = await app.commands.submit(source, owner(app), {
        requestId: "execution-before-model-loss",
        text: "Read the evidence, then report the outcome.",
    });

    await until(() => executionCalls === 1, "the original execution request");
    const started = await activateWorkPip(app, source, owner(app), {
        text: "Observe the outcome without regenerating failed work.",
    });
    const controller = started.orchestration!.conversationId as ConversationId;

    await reconcile(app, controller);
    assert.equal(supervisorCalls, 1);
    await (
        await app.conversation(source)
    ).configure({ model: { provider: "faux", modelId: "removed-between-generations" } }, context);
    held.resolve();
    const outcome = await (await app.harness.submission(sent.submissionId, context))!.wait(context);

    assert.equal(outcome.status, "unanswered");
    assert.equal(outcome.reason, "no_model");
    await until(() => supervisorCalls >= 2, "notification for the failed execution input");
    await reconcile(app, controller);
    assert.equal(supervisorCalls, 2, "failure is one outcome, not another tool-round event");
    assert.equal(executionCalls, 1, "supervision does not regenerate the failed source");
    const entries = await app.transcripts.allEntries(source, true);

    assert.ok(!entries.some((entry) => entry.kind === "assistant" && entry.stopReason === "stop"));
    await app.close();
    app = await openApp(model, directory);
    await reconcile(app, controller);
    assert.equal(
        supervisorCalls,
        2,
        "startup reconstructs failure without needing an answer entry",
    );
});

test("helper spawn and report completion stay with the busy parent instead of separately waking PiP", async (t) => {
    const helper = Promise.withResolvers<void>();
    const parent = Promise.withResolvers<void>();
    const final = Promise.withResolvers<void>();
    let parentCalls = 0;
    let supervisorCalls = 0;
    let helperStarted = false;
    let helperPrompt = "";
    const model = scriptedModel(async (request) => {
        const system = JSON.stringify(
            request.messages.filter((message) => message.role === "system"),
        );

        if (system.includes("the private supervisor for Work Item")) {
            supervisorCalls++;

            return wait();
        }

        if (!system.includes("You are the Worker agent")) {
            return text("Evidence investigation");
        }

        if (lastText(request).text.includes("HELPER_EVIDENCE_REQUEST")) {
            helperStarted = true;
            helperPrompt = system;
            await helper.promise;

            return text("Helper inspected the assigned evidence; parent must interpret it.");
        }

        if (parentCalls++ === 0) {
            await parent.promise;

            return tool("subagent", {
                action: "spawn",
                name: "evidence-helper",
                message: "HELPER_EVIDENCE_REQUEST",
            });
        }

        await final.promise;

        return text("Parent received the helper evidence and reports the actual outcome.");
    });
    const app = await openApp(model, join(root, "semantic-helper-events"));

    t.after(async () => {
        parent.resolve();
        helper.resolve();
        final.resolve();
        await app.close();
    });
    const source = await newSession(app, app.defaultCwd, "worker");

    await app.commands.submit(source, owner(app), {
        requestId: "parent-task",
        text: "Delegate the evidence inspection, then report the result yourself.",
    });
    await until(() => parentCalls === 1, "the original parent request");
    const started = await activateWorkPip(app, source, owner(app), {
        text: "Wait for the parent to interpret its helper's findings.",
    });
    const controller = started.orchestration!.conversationId as ConversationId;

    await reconcile(app, controller);
    parent.resolve();
    await until(() => parentCalls >= 2, "the parent to continue after spawning its helper");
    const spawn = (await app.transcripts.allEntries(source, true)).find(
        (entry) => entry.kind === "toolResult" && entry.name === "subagent",
    );

    assert.ok(spawn?.kind === "toolResult");
    assert.equal(spawn.isError, false, spawn.text);
    await until(() => helperStarted, "the spawned helper's execution request");
    await reconcile(app, controller);
    assert.equal(supervisorCalls, 1, "spawning a helper is not an attention event");
    assert.match(helperPrompt, /Report meaningful outcomes.*to your parent/);
    helper.resolve();
    await until(async () => {
        const agents = await app.harness.snapshot(SubagentsDoc, source, context);

        return (agents?.agents["evidence-helper"]?.reported.length ?? 0) > 0;
    }, "the helper's real persisted report");
    await reconcile(app, controller);
    assert.equal(app.isBusy(source), true);
    assert.equal(supervisorCalls, 1, "helper completion belongs to its still-working parent");
    final.resolve();
    await until(() => !app.isBusy(source), "the parent to yield its own outcome");
});

test("settlement is observed while another run stays busy, ordered by placement rather than admission", async (t) => {
    const gates = Array.from({ length: 3 }, () => Promise.withResolvers<void>());
    let executionCalls = 0;
    let supervisorCalls = 0;
    const model = scriptedModel(async (request) => {
        if (
            JSON.stringify(
                request.messages.filter((message) => message.role === "system"),
            ).includes("the private supervisor for Work Item")
        ) {
            supervisorCalls++;

            return wait();
        }

        const step = executionCalls++;

        await gates[step]!.promise;

        return step === 0
            ? tool("read", { path: "evidence.txt" })
            : text(step === 1 ? "First result, including steering." : "Queued follow-up result.");
    });
    const app = await openApp(model, join(root, "semantic-placement-order"));

    t.after(async () => {
        gates.forEach((gate) => gate.resolve());
        await app.close();
    });
    writeFileSync(join(app.defaultCwd, "evidence.txt"), "Queued execution evidence.\n");
    const source = await newSession(app, app.defaultCwd, "worker");
    const execution = await app.conversation(source);
    const original = await execution.submit(
        { type: "input", content: "Initial investigation.", requestId: "initial-investigation" },
        context,
    );

    await until(() => executionCalls === 1, "the initial execution request");
    const started = await activateWorkPip(app, source, owner(app), {
        text: "Observe each real outcome without waiting for the queue to become idle.",
    });
    const controller = started.orchestration!.conversationId as ConversationId;

    await reconcile(app, controller);
    const followUp = await execution.submit(
        {
            type: "input",
            content: "Older queued follow-up.",
            requestId: "older-follow-up",
            whenBusy: "followUp",
        },
        context,
    );
    const steer = await execution.submit(
        {
            type: "input",
            content: "Newer steering input.",
            requestId: "newer-steer",
            whenBusy: "steer",
        },
        context,
    );

    assert.ok(Number(followUp.id) < Number(steer.id));
    gates[0]!.resolve();
    await until(() => executionCalls === 2, "the post-tool request containing steering");
    await reconcile(app, controller);
    assert.equal(supervisorCalls, 1, "placing steering is not a terminal outcome");
    app.pip.orchestration.close();
    gates[1]!.resolve();
    await original.wait(context);
    await until(() => executionCalls === 3, "the older follow-up to begin without an idle gap");
    assert.equal(app.isBusy(source), true);
    await reconcile(app, controller);
    assert.equal(
        supervisorCalls,
        2,
        "settlements still update the projection while observation is closed",
    );
    const first = await steer.status(context);

    gates[2]!.resolve();
    const later = await followUp.wait(context);

    assert.equal(later.status, "done");
    assert.ok(
        Number(later.entry) > Number(first.entry),
        "placement, unlike admission, orders these outcomes",
    );
    await until(() => supervisorCalls >= 3, "the later-placed follow-up outcome");
    await reconcile(app, controller);
    assert.equal(supervisorCalls, 3, "the older submission ID must not hide its newer outcome");
});

test("PiP discussion actions do not self-wake, while new human chat and review replies do", async (t) => {
    let supervisorCalls = 0;
    const model = scriptedModel((request) => {
        if (
            JSON.stringify(
                request.messages.filter((message) => message.role === "system"),
            ).includes("the private supervisor for Work Item")
        ) {
            supervisorCalls++;

            return wait();
        }

        return text("Execution report.");
    });
    const directory = join(root, "semantic-discussion-events");
    let app = await openApp(model, directory);

    t.after(() => app.close());
    const source = await newSession(app, app.defaultCwd, "worker");
    const me = owner(app);
    const chat = await app.collab.postChat(source, me, {
        requestId: "human-chat-before-takeover",
        text: "Please retain the observed uncertainty.",
    });
    const review = await app.reviews.comment(source, me, {
        requestId: "human-review-before-takeover",
        text: "Keep this evidence explicit.",
    });
    const started = await activateWorkPip(app, source, me, {
        text: "Observe material human discussion, without responding to your own receipts.",
    });
    const controller = started.orchestration!.conversationId as ConversationId;

    await reconcile(app, controller);
    assert.equal(supervisorCalls, 1);
    await app.harness.commit(async (tx) => {
        await app.collab.replyAsPiP(tx, source, me, {
            requestId: "1".repeat(64),
            messageId: chat.id,
            text: "The existing uncertainty remains recorded.",
        });
        await app.reviews.commentAsPiP(tx, source, me, {
            requestId: "pip-review-reply",
            threadId: review.id,
            text: "Recorded; not proof of code correctness.",
        });
        await app.reviews.resolveAsPiP(tx, source, me, {
            requestId: "pip-discussion-resolution",
            threadIds: [review.id],
            resolved: true,
        });
    }, context);
    await reconcile(app, controller);
    assert.equal(supervisorCalls, 1, "PiP-authored messages must not create a feedback loop");
    await app.reviews.comment(source, me, {
        requestId: "new-human-review-reply",
        threadId: review.id,
        text: "There is new evidence requiring attention.",
    });
    await until(() => supervisorCalls >= 2, "a new human review reply");
    await reconcile(app, controller);
    assert.equal(supervisorCalls, 2);
    await app.collab.postChat(source, me, {
        requestId: "new-human-chat",
        text: "Please consider this newly discovered scope limitation.",
    });
    await until(() => supervisorCalls >= 3, "a new human chat message");
    await reconcile(app, controller);
    assert.equal(supervisorCalls, 3);
    await app.close();
    app = await openApp(model, directory);
    await reconcile(app, controller);
    assert.equal(
        supervisorCalls,
        3,
        "startup does not reinterpret PiP replies as human discussion",
    );
    assert.equal((await app.harness.snapshot(LiveDoc, controller, context))?.run, undefined);
});
