// Native owner boundary: normal messages and Stop, never navigation or stale input, own PiP authority.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { awaitWithContext, withAbortSignal } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { PipWorkDoc } from "../src/server/docs.ts";
import { HandoffsDoc } from "../src/server/workflow-docs.ts";
import {
    cleanUp,
    context,
    fakeTab,
    lastText,
    newSession,
    openApp,
    owner,
    recordCost,
    root,
    say,
    setWorkPipLimits,
    scriptedModel,
    until,
} from "./helpers.ts";

after(cleanUp);

const idOf = (id: number) => id as ConversationId;
const idle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("owner messages activate the same PiP Thread; Stop while waiting preserves questions and leaves execution alone", async (t) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    let pipCalls = 0;
    const model = scriptedModel(async (request, ctx) => {
        const system = JSON.stringify(
            request.messages.filter((message) => message.role === "system"),
        );

        if (!system.includes("the private supervisor for Work Item")) {
            if (lastText(request).text.includes("HELD_EXECUTION")) {
                await awaitWithContext(
                    held,
                    ctx?.signal ? withAbortSignal(ctx.signal, context) : context,
                );
            }

            return fauxAssistantMessage("Worker outcome, not permission to restart PiP.");
        }

        pipCalls++;

        return fauxAssistantMessage(
            [
                fauxToolCall("work_supervise", {
                    action: pipCalls === 1 ? "ask" : "wait",
                    text:
                        pipCalls === 1
                            ? "Should the Worker continue?"
                            : "Waiting for a meaningful outcome.",
                }),
            ],
            { stopReason: "toolUse" },
        );
    });
    const directory = join(root, "pip-normal-control");
    let app = await openApp(model, directory);

    t.after(async () => {
        release();
        await app.close();
    });
    const source = await newSession(app, app.defaultCwd, "worker");

    await app.commands.submit(source, owner(app), {
        text: "HELD_EXECUTION",
        requestId: "worker-task",
    });
    await until(() => app.isBusy(source), "Worker is running");
    const opened = await app.pip.orchestration.control(source, owner(app), { action: "open" });
    const controller = idOf(opened.orchestration!.conversationId);

    await idle();
    assert.equal(pipCalls, 0, "opening does not dispatch or delegate");
    assert.notEqual(opened.orchestration!.status, "running");
    await setWorkPipLimits(app, source, owner(app), { budget: 1 });
    const instruction = {
        text: "Observe this Work Item and ask before proceeding.",
        requestId: "owner-instruction",
    };
    const first = await app.commands.submit(controller, owner(app), instruction);

    await until(
        async () =>
            !app.isBusy(controller) &&
            (await app.harness.snapshot(PipWorkDoc, controller, context))?.question !== undefined,
        "PiP asks and waits",
    );
    const question = (await app.harness.snapshot(PipWorkDoc, controller, context))!.question!;
    const beforeStop = { ...app.workItems.itemFor(source)!.supervisor! };

    await app.commands.abort(controller, owner(app));
    assert.equal(app.isBusy(source), true, "normal PiP Stop must not stop the running Worker");
    assert.notEqual(app.workItems.itemFor(source)!.supervisor!.status, "running");
    assert.equal(app.workItems.itemFor(source)!.supervisor!.maxCost, beforeStop.maxCost);
    assert.equal(
        (await app.harness.snapshot(PipWorkDoc, controller, context))!.question!.id,
        question.id,
    );
    assert.deepEqual(await app.commands.submit(controller, owner(app), instruction), first);
    assert.notEqual(
        app.workItems.itemFor(source)!.supervisor!.status,
        "running",
        "an accepted retry cannot reactivate PiP",
    );
    release();
    await until(() => !app.isBusy(source), "Worker finishes independently");
    await app.reviews.comment(source, owner(app), {
        requestId: "stopped-event",
        text: "A human discussion event while PiP is stopped.",
    });
    await say(app, source, "Human directs this Worker, not PiP.");
    await idle();
    assert.equal(
        pipCalls,
        1,
        "Work Item outcomes, discussion and execution input do not restart PiP",
    );
    assert.equal(
        (await app.transcripts.allEntries(source, true)).filter((entry) => entry.kind === "user")
            .length,
        2,
        "PiP never resends the Worker task",
    );
    await app.close();
    app = await openApp(model, directory);
    const stopped = { ...app.workItems.itemFor(source)!.supervisor! };

    await app.pip.orchestration.control(source, owner(app), { action: "open" });
    assert.deepEqual(
        app.workItems.itemFor(source)!.supervisor,
        stopped,
        "opening after restart does not renew authority",
    );
    const tab = fakeTab(controller, owner(app));

    await app.attach(tab.client);
    assert.equal((tab.field("pipQuestion") as { id: string }).id, question.id);
    app.detach(tab.client);
    const reply = {
        text: "Keep the Worker running.",
        requestId: "owner-answer",
        pipQuestionId: question.id,
    };
    const answer = await app.commands.submit(controller, owner(app), reply);

    await until(
        () => pipCalls === 2 && !app.isBusy(controller),
        "accepted exact question reply resumes PiP",
    );
    assert.equal(app.workItems.itemFor(source)!.supervisor!.status, "running");
    await app.commands.abort(controller, owner(app));
    assert.deepEqual(await app.commands.submit(controller, owner(app), reply), answer);
    assert.notEqual(app.workItems.itemFor(source)!.supervisor!.status, "running");
    const global = await app.pip.ensure(owner(app));

    await say(app, global, "An unrelated personal PiP message.");
    await assert.rejects(
        app.pip.send(
            global,
            Number(controller),
            "Activate this controller indirectly.",
            false,
            "global-controller",
        ),
    );
    const guest = app.config.addUser("Guest", "guest").user;

    await assert.rejects(
        app.commands.submit(controller, guest, {
            text: "Collaborator input",
            requestId: "guest-controller",
        }),
    );
    assert.notEqual(app.workItems.itemFor(source)!.supervisor!.status, "running");
    const beforeDriverCheck = { ...app.workItems.itemFor(source)!.supervisor! };

    await app.collab.turns(source, guest, { action: "on" });
    await assert.rejects(
        app.commands.submit(controller, owner(app), {
            text: "Owner input without the active execution Thread's wheel.",
            requestId: "without-active-driver",
        }),
        /unavailable or was stopped/i,
    );
    assert.deepEqual(app.workItems.itemFor(source)!.supervisor, beforeDriverCheck);
    await app.collab.turns(source, owner(app), { action: "off" });
    assert.equal(
        pipCalls,
        2,
        "global PiP, collaborator input and non-driving owner input never activate this Work Item's PiP",
    );
    assert.equal(
        (await app.harness.snapshot(PipWorkDoc, controller, context))!.questions[0]!.id,
        question.id,
    );
    await app.harness.commit(async (tx) => {
        (await tx.doc(HandoffsDoc)).workItems[
            app.workItems.itemFor(source)!.id
        ]!.supervisor!.status = "paused";
    }, context);
    assert.equal(
        (await app.pip.orchestration.inspect(source, owner(app))).orchestration!.status,
        "reclaimed",
        "historical paused state is human control",
    );
    await recordCost(app, source, 2);
    await assert.rejects(
        app.commands.submit(controller, owner(app), {
            text: "A new instruction over budget.",
            requestId: "over-budget",
        }),
        /spend limit/i,
    );
    assert.notEqual(
        app.workItems.itemFor(source)!.supervisor!.status,
        "running",
        "rejected input cannot activate PiP",
    );
});

test("limits reject a stale selected item, controller or grant without changing authority or spending", async (t) => {
    const app = await openApp(
        scriptedModel(() => fauxAssistantMessage("Not dispatched.")),
        join(root, "pip-limits-grant"),
    );

    t.after(() => app.close());
    const source = await newSession(app, app.defaultCwd, "worker");
    const opened = (await app.pip.orchestration.control(source, owner(app), { action: "open" }))
        .orchestration!;
    const expected = {
        workItemId: opened.workItemId,
        conversationId: opened.conversationId,
        epoch: opened.epoch,
    };

    await app.commands.abort(idOf(opened.conversationId), owner(app));
    const before = { ...app.workItems.itemFor(source)!.supervisor! };

    for (const target of [
        expected,
        { ...expected, epoch: before.epoch, workItemId: "another-item" },
        { ...expected, epoch: before.epoch, conversationId: opened.conversationId + 1 },
    ]) {
        await assert.rejects(
            app.pip.orchestration.control(source, owner(app), {
                action: "limits",
                budget: 5,
                expected: target,
            }),
            /Work Item changed/,
        );
        assert.deepEqual(app.workItems.itemFor(source)!.supervisor, before);
    }

    await app.pip.orchestration.control(source, owner(app), {
        action: "limits",
        budget: 5,
        expected: { ...expected, epoch: before.epoch },
    });
    assert.equal(app.workItems.itemFor(source)!.supervisor!.maxCost, 5);
    const saved = { ...app.workItems.itemFor(source)!.supervisor! };
    const current = { ...expected, epoch: saved.epoch };

    await app.workItems.updateWorkItem(source, owner(app), { archived: true });
    await assert.rejects(
        app.pip.orchestration.control(source, owner(app), {
            action: "limits",
            budget: 10,
            expected: current,
        }),
        /Work Item changed/,
    );
    assert.deepEqual(app.workItems.itemFor(source)!.supervisor, saved);
    await app.workItems.updateWorkItem(source, owner(app), { archived: false });
    const staleOwner = { ...owner(app) };

    app.config.rotateOwnerToken();
    await assert.rejects(
        app.pip.orchestration.control(source, staleOwner, {
            action: "limits",
            budget: 10,
            expected: current,
        }),
        /currently signed-in owner/,
    );
    assert.deepEqual(app.workItems.itemFor(source)!.supervisor, saved);
});

test("normal Stop aborts PiP's own run and fences an unaccepted input without restarting it on retry", async (t) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    let calls = 0;
    const app = await openApp(
        scriptedModel(async (request, ctx) => {
            calls++;

            if (lastText(request).text.includes("Working PiP")) {
                await awaitWithContext(
                    held,
                    ctx?.signal ? withAbortSignal(ctx.signal, context) : context,
                );
            }

            return fauxAssistantMessage(
                [fauxToolCall("work_supervise", { action: "wait", text: "Waiting." })],
                { stopReason: "toolUse" },
            );
        }),
        join(root, "pip-stop-admission"),
    );

    t.after(async () => {
        release();
        await app.close();
    });
    const source = await newSession(app, app.defaultCwd, "worker");
    const opened = await app.pip.orchestration.control(source, owner(app), { action: "open" });
    const controller = idOf(opened.orchestration!.conversationId);

    await app.commands.submit(controller, owner(app), {
        text: "Working PiP",
        requestId: "working",
    });
    await until(() => calls === 1 && app.isBusy(controller), "PiP's own running response");
    await app.commands.abort(controller, owner(app));
    await until(() => !app.isBusy(controller), "normal Stop aborts PiP itself");
    const native = await app.conversation(controller);
    const nativeSubmit = native.submit.bind(native);
    const conversation = app.conversation.bind(app);
    let reject = true;

    t.mock.method(app, "conversation", async (id: ConversationId) =>
        id === controller ? native : conversation(id),
    );
    t.mock.method(native, "submit", async (...args: Parameters<typeof native.submit>) => {
        if (reject) {
            reject = false;

            throw new Error("Admission unavailable before the native input is accepted");
        }

        return nativeSubmit(...args);
    });
    const input = { text: "Investigate only this Work Item.", requestId: "unaccepted" };

    await assert.rejects(
        app.commands.submit(controller, owner(app), input),
        /Admission unavailable/,
    );
    assert.notEqual(app.workItems.itemFor(source)!.supervisor!.status, "running");
    await app.commands.abort(controller, owner(app));
    await assert.rejects(app.commands.submit(controller, owner(app), input), /input was stopped/i);
    assert.equal(calls, 1, "the stale retry never reaches a provider");
    await app.commands.submit(controller, owner(app), { ...input, requestId: "new-owner-message" });
    await until(
        () => calls === 2 && !app.isBusy(controller),
        "a fresh accepted owner message activates PiP",
    );
    assert.equal(app.workItems.itemFor(source)!.supervisor!.status, "running");
    await app.commands.abort(controller, owner(app));
});
