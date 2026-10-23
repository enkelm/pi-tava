// The registered tools, native assignments, durable delivery and input receipts are real.
// Only provider decisions and a post-acceptance acknowledgement failure are scripted.
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { awaitWithContext, withAbortSignal } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { PipWorkDoc } from "../src/server/docs.ts";
import { AgentSupervisionDoc } from "../src/server/pip/agent-supervision.ts";
import {
    cleanUp,
    context,
    lastText,
    newSession,
    openApp,
    owner,
    recordCost,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";

after(cleanUp);

const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
    fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

async function fixture(name: string, outcome: "finish" | "question" | "failure" = "finish") {
    const released = Promise.withResolvers<void>();
    const controllers: ConversationId[] = [];
    const sources: ConversationId[] = [];
    const itemIds: string[] = [];
    let unrelated!: ConversationId;
    let phase = "follow";
    let index = 0;
    let firstControllerCalls = 0;
    let researcherStarted = false;
    let parentWakes = 0;
    let disposition = "";
    let questionId: string | undefined;
    const model = scriptedModel(async (request, options) => {
        const system = JSON.stringify(
            request.messages.filter((message) => message.role === "system"),
        );
        const last = lastText(request);

        if (system.includes("the owner's persistent private agent")) {
            if (last.text.includes("supersede the previous batch")) {
                return tool("work_supervise", {
                    action: "wait",
                    text: "The old batch is superseded.",
                });
            }

            if (last.role === "user" && last.text.includes("App registered continuation")) {
                parentWakes++;
                disposition = /Native semantic outcome: (\w+)/.exec(last.text)?.[1] ?? "";
                questionId = /Exact pending question: ([^;]+);/.exec(last.text)?.[1];
                phase = "inspected";

                return tool("agent_work", { action: "read", session: Number(controllers[index]) });
            }

            if (phase === "follow") {
                phase = "send-first";

                return tool("agent_work", { action: "follow", session: Number(unrelated) });
            }

            if (phase === "send-first") {
                phase = "sent";

                return tool("agent_work", {
                    action: "send",
                    session: Number(controllers[0]),
                    text: "Do A only, then explicitly finish or ask. No landing or publication.",
                });
            }

            if (phase === "inspected") {
                if (disposition !== "finish") {
                    phase = "blocked";

                    return tool("work_supervise", {
                        action: "ask",
                        text: `The exact child at /s/${controllers[index]} has a ${disposition}${questionId === undefined ? "" : ` (${questionId})`}. Inspect its native question/response; B is not dispatched.`,
                    });
                }

                index++;

                if (index === controllers.length) {
                    phase = "finished";

                    return tool("work_supervise", {
                        action: "finish",
                        text: "A, B and C settled. No landing/commit/publication approval was inferred.",
                    });
                }

                phase = "sent";

                return tool("agent_work", {
                    action: "send",
                    session: Number(controllers[index]),
                    text: `Do batch step ${index + 1} only within the original scope, then finish.`,
                });
            }

            if (phase === "sent") {
                const requestId = /"requestId":"([^"]+)"/.exec(last.text)?.[1];

                assert.ok(
                    requestId,
                    `The actual accepted send receipt must reach the parent: ${last.text}`,
                );
                assert.match(last.text, /"status":"accepted"/);
                phase = "waiting";

                return tool("work_supervise", {
                    action: "wait",
                    text: "Await the assigned task, not a busy/idle report.",
                    continuation: {
                        requestId,
                        remaining: `Inspect step ${index + 1}, then decide whether the remaining serial steps are still in the original scope.`,
                    },
                });
            }

            throw new Error(`Unexpected paid parent request in phase ${phase}: ${last.text}`);
        }

        if (system.includes("the private supervisor for Work Item")) {
            const first = system.includes(`Work Item ${itemIds[0]}`);

            if (first && firstControllerCalls++ === 0) {
                return tool("work_supervise", {
                    action: "wait",
                    text: "A is still running in its researcher.",
                });
            }

            if (first && outcome === "failure") {
                return fauxAssistantMessage(
                    "Native provider failure fixture; not a successful task result.",
                    {
                        stopReason: "error",
                        errorMessage: "Scripted provider unavailable; no fallback.",
                    },
                );
            }

            return tool("work_supervise", {
                action: first && outcome === "question" ? "ask" : "finish",
                text:
                    first && outcome === "question"
                        ? "Which bounded option is authorized for A?"
                        : "The assigned step settled; evidence remains at its native source.",
            });
        }

        if (system.includes("You are the Researcher agent")) {
            researcherStarted = true;
            await awaitWithContext(
                released.promise,
                options?.signal ? withAbortSignal(options.signal, context) : context,
            );

            return fauxAssistantMessage(
                "A evidence is ready for the controller to inspect; this is not owner authority.",
            );
        }

        return fauxAssistantMessage("Unrelated observation or naming fixture.");
    });
    const directory = join(root, name);
    let app = await openApp(model, directory);

    for (let i = 0; i < 3; i++) {
        // Start A in its final execution thread. Controller handoff/source fencing is a
        // separate existing seam and must not prevent this continuation fixture reaching wait.
        const source = await newSession(app, app.defaultCwd, i === 0 ? "researcher" : "worker");
        const opened = await app.pip.orchestration.control(source, owner(app), { action: "open" });

        sources.push(source);
        controllers.push(opened.orchestration!.conversationId as ConversationId);
        itemIds.push(app.workItems.itemFor(source)!.id);
    }

    unrelated = await newSession(app, app.defaultCwd, "chat");
    const created = await app.pip.agents.create(owner(app), {
        name: "Serial parent",
        requestId: `create-${name}`,
    });
    const chat = created.id as ConversationId;
    const sibling = (await app.pip.agents.newChat(chat, owner(app), { requestId: "sibling" }))
        .id as ConversationId;
    const start = async () => {
        // Admit independent execution before parent attachment: later direct execution input
        // correctly reclaims control, which is not the continuation behavior under test.
        await app.commands.submit(sources[0]!, owner(app), {
            text: "Investigate A within the original scope and hold its native evidence.",
            requestId: "independent-A",
        });
        await until(() => researcherStarted, "independent A execution is running");
        await app.commands.submit(chat, owner(app), {
            text: "Do A, then inspect its actual outcome before B, then C. Stop before any landing/commits/publication.",
            requestId: "owner-batch",
        });
        await until(
            async () =>
                researcherStarted &&
                !app.isBusy(chat) &&
                (await app.pip.agents.supervision.parentContext(chat, owner(app)))[0]?.status ===
                    "waiting",
            "registered parent waiting on accepted A",
        );
    };

    return {
        get app() {
            return app;
        },
        chat,
        sibling,
        controllers,
        sources,
        unrelated,
        start,
        get parentWakes() {
            return parentWakes;
        },
        release: () => released.resolve(),
        restart: async () => {
            await app.close();
            app = await openApp(model, directory);
        },
        close: async () => {
            released.resolve();
            await app.close();
        },
    };
}

test("a passive controller follow cannot hide the registered assignment's busy execution tree", async (t) => {
    const execution = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let executionStarted = false;
    let controllerStarted = false;
    let parentWakes = 0;
    let step = 0;
    let requestId: string | undefined;
    let controller!: ConversationId;
    const model = scriptedModel(async (request, options) => {
        const system = JSON.stringify(
            request.messages.filter((message) => message.role === "system"),
        );
        const last = lastText(request);
        const ctx = options?.signal ? withAbortSignal(options.signal, context) : context;

        if (system.includes("the owner's persistent private agent")) {
            if (last.role === "user" && last.text.includes("App registered continuation")) {
                parentWakes++;

                return tool("work_supervise", {
                    action: "ask",
                    text: "The assigned execution settled; inspect its evidence before further work.",
                });
            }

            if (step++ === 0) {
                return tool("agent_work", {
                    action: "send",
                    session: Number(controller),
                    text: "Observe A without interrupting its execution. No landing or publication.",
                });
            }

            if (step === 2) {
                requestId = /"requestId":"([^"]+)"/.exec(last.text)?.[1];
                assert.ok(
                    requestId,
                    "retain the actual accepted assignment, not the follow receipt",
                );
                assert.match(last.text, /"status":"accepted"/);

                return tool("agent_work", { action: "follow", session: Number(controller) });
            }

            assert.match(last.text, /"status":"accepted"/);

            return tool("work_supervise", {
                action: "wait",
                text: "Wait for the assigned execution tree, even if its controller finishes early.",
                continuation: { requestId: requestId!, remaining: "Inspect A's actual evidence." },
            });
        }

        if (system.includes("the private supervisor for Work Item")) {
            controllerStarted = true;
            await awaitWithContext(finish.promise, ctx);

            return tool("work_supervise", {
                action: "finish",
                text: "Controller finished early; this does not settle the busy execution.",
            });
        }

        if (system.includes("You are the Worker agent")) {
            executionStarted = true;
            await awaitWithContext(execution.promise, ctx);

            return fauxAssistantMessage("A's independent execution evidence is ready.");
        }

        return fauxAssistantMessage("Unrelated naming fixture.");
    });
    const app = await openApp(model, join(root, "parent-follow-finality"));

    t.after(async () => {
        execution.resolve();
        finish.resolve();
        await app.close();
    });
    const source = await newSession(app, app.defaultCwd, "worker");

    controller = (await app.pip.orchestration.control(source, owner(app), { action: "open" }))
        .orchestration!.conversationId as ConversationId;
    await app.commands.submit(source, owner(app), {
        text: "Hold A's independent execution until its evidence is ready.",
        requestId: "busy-execution",
    });
    await until(() => executionStarted, "native execution is busy");
    const chat = (
        await app.pip.agents.create(owner(app), {
            name: "Follow finality parent",
            requestId: "create-follow-finality",
        })
    ).id as ConversationId;

    await app.commands.submit(chat, owner(app), {
        text: "Observe A, follow its controller and wait for the assigned execution to settle.",
        requestId: "follow-finality-owner",
    });
    await until(
        async () =>
            controllerStarted &&
            !app.isBusy(chat) &&
            (await app.pip.agents.supervision.parentContext(chat, owner(app)))[0]?.status ===
                "waiting",
        "registered parent waits after the real send and follow",
    );
    finish.resolve();
    await until(() => !app.isBusy(controller), "native early controller finish settles");
    await app.pip.agents.supervision.open();
    const waiting = (await app.harness.snapshot(AgentSupervisionDoc, context))!.parentTasks!;

    assert.equal(app.isBusy(source), true);
    assert.equal(parentWakes, 0);
    assert.equal(
        Object.values(waiting).find((task) => task.authority.chatId === Number(chat))!.consumed
            .length,
        0,
        "no continuation delivery is even scheduled while the assigned execution is busy",
    );
    execution.resolve();
    await until(
        async () =>
            (await app.pip.agents.supervision.parentContext(chat, owner(app)))[0]?.status ===
            "blocked",
        "the settled native execution allows one parent inspection",
    );
    assert.equal(parentWakes, 1);
});

test("registered serial A→B→C dispatches without owner input; waits and passive reports stay quiet; accepted ack loss/completed restart do not duplicate", async (t) => {
    const f = await fixture("parent-native-serial");

    t.after(() => f.close());
    const input = f.app.pip.agents.input.bind(f.app.pip.agents);
    let lostAck = false;

    f.app.pip.agents.input = async (...args) => {
        const result = await input(...args);

        if (args[2].includes(":parent-") && !lostAck) {
            lostAck = true;

            throw new Error("Lost acknowledgement after actual native acceptance");
        }

        return result;
    };
    await f.start();
    assert.equal(
        f.parentWakes,
        0,
        "a controller wait while independent research runs is not assignment settlement",
    );
    const passive = await f.app.commands.submit(f.unrelated, owner(f.app), {
        text: "Report an unrelated result.",
        requestId: "unrelated",
    });

    await (await f.app.harness.submission(passive.submissionId, context))!.wait(context);
    await until(
        async () =>
            (await f.app.transcripts.allEntries(f.chat, true)).some(
                (entry) =>
                    entry.kind === "appEvent" &&
                    entry.event === "report" &&
                    entry.text.includes("Unrelated"),
            ),
        "real passive follow report",
    );
    assert.equal(f.parentWakes, 0);
    f.release();
    await until(
        async () =>
            (await f.app.pip.agents.supervision.parentContext(f.chat, owner(f.app)))[0]?.status ===
            "completed",
        "parent serial task explicitly finishes",
        20_000,
    );
    assert.equal(
        f.parentWakes,
        3,
        "three actual native provider invocations, not three app-inserted reports",
    );
    assert.equal(lostAck, true);
    const state = await f.app.harness.snapshot(AgentSupervisionDoc, context);
    const sends = Object.values(state!.requests).filter(
        (receipt) => receipt.chatId === Number(f.chat) && receipt.action === "send",
    );

    assert.equal(sends.length, 3);
    assert.deepEqual(
        sends.map((receipt) => receipt.controllerId),
        f.controllers,
    );
    assert.ok(
        sends.every(
            (receipt) => receipt.status === "accepted" && receipt.submissionId !== undefined,
        ),
    );
    assert.equal(
        new Set(sends.map((receipt) => receipt.sourceInputId)).size,
        1,
        "derived inputs retain one accepted owner instruction",
    );
    const derived = Object.values(state!.admissions ?? {}).filter(
        (pin) => pin.parentTask !== undefined,
    );

    assert.equal(derived.length, 3);
    assert.equal(
        new Set(derived.map((pin) => pin.requestId)).size,
        3,
        "each semantic event has a distinct stable request identity",
    );
    for (const pin of derived) {
        const native = await f.app.harness.commit(
            (tx) => tx.submissionByRequest(f.chat, pin.requestId!),
            context,
        );

        assert.ok(native, "every counted continuation has a real native input receipt");
        assert.match(pin.requestId!, /^p:/, "runtime continuation is never owner-written input");
    }

    assert.deepEqual(await f.app.pip.agents.supervision.parentContext(f.sibling, owner(f.app)), []);
    await f.restart();
    await f.app.pip.agents.supervision.open();
    assert.equal(
        f.parentWakes,
        3,
        "completed-task receipts never backfill another invocation after restart",
    );
});

// Protects transfer at the real postTools boundary, which the sibling-Chat supersession
// cases cannot exercise: an old derived input and a fresh owner steer share one native run.
// The real read executes; only its acknowledgement is held to place the owner input in time.
test("a same-Chat owner steer replaces stale continuation authority after its tool round", async (t) => {
    const f = await fixture("parent-post-tools-owner");
    const releaseRead = Promise.withResolvers<void>();
    let readReturned = false;
    const contact = f.app.pip.agents.supervision.contact.bind(f.app.pip.agents.supervision);

    f.app.pip.agents.supervision.contact = async (...args) => {
        const result = await contact(...args);

        if (args[0].conversationId === f.chat && args[1].action === "read") {
            readReturned = true;
            await releaseRead.promise;
        }

        return result;
    };
    t.after(async () => {
        releaseRead.resolve();
        await f.close();
    });
    await f.start();
    f.release();
    await until(() => readReturned, "continuation's registered read reached its tool boundary");
    const fresh = await f.app.commands.submit(f.chat, owner(f.app), {
        text: "supersede the previous batch; do nothing further",
        requestId: "post-tools-owner-steer",
        mode: "steer",
    });

    releaseRead.resolve();
    const settled = await (await f.app.harness.submission(fresh.submissionId, context))!.wait(
        context,
    );

    assert.ok(settled.type === "input" && settled.status === "done");
    const state = (await f.app.harness.snapshot(AgentSupervisionDoc, context))!;
    const freshPin = Object.values(state.admissions!).find(
        (pin) => pin.requestId === settled.requestId,
    )!;

    assert.ok(freshPin, "the new authority has a native owner admission");
    assert.equal(state.attention![String(f.chat)]!.text, "The old batch is superseded.");
    assert.equal(
        state.attention![String(f.chat)]!.admissionSerial,
        freshPin.admissionSerial,
        "the terminating tool uses the new owner input, not the derived wake pin",
    );
    assert.equal(f.parentWakes, 1);
    assert.equal(
        Object.values(state.requests).filter(
            (receipt) => receipt.chatId === Number(f.chat) && receipt.action === "send",
        ).length,
        1,
        "the stale continuation cannot dispatch B after the owner takes over",
    );
    await f.app.pip.agents.supervision.open();
    assert.equal(
        (await f.app.pip.agents.supervision.parentContext(f.chat, owner(f.app)))[0]?.status,
        "revoked",
    );
});

for (const outcome of ["question", "failure"] as const) {
    test(`native assigned-task ${outcome} wakes the exact parent to inspect/escalate, never unconditionally dispatches B`, async (t) => {
        const f = await fixture(`parent-${outcome}`, outcome);

        t.after(() => f.close());
        await f.start();
        f.release();
        await until(
            async () =>
                (await f.app.pip.agents.supervision.parentContext(f.chat, owner(f.app)))[0]
                    ?.status === "blocked",
            "parent explicitly asks its owner",
        );
        assert.equal(f.parentWakes, 1);
        const state = await f.app.harness.snapshot(AgentSupervisionDoc, context);
        const sends = Object.values(state!.requests).filter(
            (receipt) => receipt.chatId === Number(f.chat) && receipt.action === "send",
        );

        assert.equal(sends.length, 1, "B/C received no native assignment");
        const work = await f.app.harness.snapshot(PipWorkDoc, f.controllers[0]!, context);

        assert.equal(work?.assignment?.outcome?.kind, outcome);
        if (outcome === "question") {
            assert.equal(work!.assignment!.outcome!.questionId, work!.question!.id);
            assert.equal(
                work!.question!.answer,
                undefined,
                "a continuation does not answer/clear a native question",
            );
            assert.ok(
                state!.attention![String(f.chat)]!.text.includes(work!.question!.id),
                "escalation preserves the exact native question identity",
            );
        }
    });
}

test("native parent spend admission blocks a continuation without buying a provider invocation or dispatching B", async (t) => {
    const f = await fixture("parent-budget");

    t.after(() => f.close());
    await f.start();
    await f.app.pip.agents.setBudget(f.chat, owner(f.app), 0.1);
    // Native usage accounting fixture, not actual paid provider spending.
    await recordCost(f.app, f.chat, 0.2);
    f.release();
    await until(
        async () =>
            (await f.app.pip.agents.supervision.parentContext(f.chat, owner(f.app)))[0]?.status ===
            "blocked",
        "native spend check holds the continuation",
    );
    assert.equal(f.parentWakes, 0);
    const task = (await f.app.pip.agents.supervision.parentContext(f.chat, owner(f.app)))[0]!;

    assert.equal(task.admittedWakes, 0);
    assert.equal(task.paidWakes, 0);
    const state = await f.app.harness.snapshot(AgentSupervisionDoc, context);

    assert.equal(
        Object.values(state!.requests).filter(
            (receipt) => receipt.chatId === Number(f.chat) && receipt.action === "send",
        ).length,
        1,
    );
});

for (const fence of ["stop", "detach", "supersede"] as const) {
    test(`${fence} fences a registered unfinished parent without cancelling independent research`, async (t) => {
        const f = await fixture(`parent-fence-${fence}`);

        t.after(() => f.close());
        await f.start();
        const researcher = f.app.workItems.itemFor(f.sources[0]!)!.activeThreadId as ConversationId;

        if (fence === "supersede") {
            const input = await f.app.commands.submit(f.sibling, owner(f.app), {
                text: "supersede the previous batch; do nothing further",
                requestId: "new-direction",
            });

            await (await f.app.harness.submission(input.submissionId, context))!.wait(context);
        } else {
            await f.app.pip.agents.supervision.control(f.chat, owner(f.app), {
                action: fence === "stop" ? "stop_supervision" : "detach",
                session: Number(f.sources[0]),
                requestId: `fence-${fence}`,
            });
        }

        assert.equal(
            f.app.isBusy(researcher),
            true,
            "parent fencing never cancels the child's independent execution",
        );
        f.release();
        await until(() => !f.app.isBusy(researcher), "independent researcher settles");
        await f.app.pip.agents.supervision.open();
        assert.equal(f.parentWakes, 0);
        const state = await f.app.harness.snapshot(AgentSupervisionDoc, context);

        assert.equal(
            Object.values(state!.requests).filter(
                (receipt) => receipt.chatId === Number(f.chat) && receipt.action === "send",
            ).length,
            1,
        );
        assert.equal(
            (await f.app.pip.agents.supervision.parentContext(f.chat, owner(f.app)))[0]?.status,
            "revoked",
        );
    });
}
