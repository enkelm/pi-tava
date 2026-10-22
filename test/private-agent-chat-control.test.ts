// Selected-chat projection over real native association/delegation; only the model is scripted.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AgentDoc, type ConversationId } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { PipWorkDoc, SessionsDoc } from "../src/server/docs.ts";
import {
    cleanUp,
    context,
    fakeTab,
    lastText,
    newSession,
    openApp,
    owner,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";

after(cleanUp);

function controlModel() {
    let calls = 0;
    const model = scriptedModel((request) => {
        calls++;
        const system = JSON.stringify(
            request.messages.filter((message) => message.role === "system"),
        );
        const last = lastText(request);

        if (system.includes("the owner's persistent private agent")) {
            if (last.role !== "user") {
                assert.match(last.text, /"status":"accepted"/);

                return fauxAssistantMessage("Exact native contact accepted.");
            }

            const command = /CONTROL_(delegate|follow|read)_(\d+)(?:_(ask|finish))?/.exec(
                last.text,
            );

            assert.ok(command, last.text);
            const action = command[1];

            assert.ok(action);

            return fauxAssistantMessage(
                [
                    fauxToolCall("agent_work", {
                        action,
                        session: Number(command[2]),
                        report: false,
                        ...(action === "delegate"
                            ? {
                                  text:
                                      command[3] ??
                                      "Observe only, then wait for native work events.",
                              }
                            : {}),
                    }),
                ],
                { stopReason: "toolUse" },
            );
        }

        if (system.includes("the private supervisor for Work Item")) {
            const action = last.text.includes("\nask\n")
                ? "ask"
                : last.text.includes("\nfinish\n")
                  ? "finish"
                  : "wait";

            return fauxAssistantMessage(
                [
                    fauxToolCall("work_supervise", {
                        action,
                        text:
                            action === "ask"
                                ? "Which permitted scope should this native work use?"
                                : action === "finish"
                                  ? "Native work finished; no review or publication approval implied."
                                  : "Waiting for meaningful native work events.",
                    }),
                ],
                { stopReason: "toolUse" },
            );
        }

        return fauxAssistantMessage("Unchanged execution thread.");
    });

    return { model, calls: () => calls };
}

test("current controllers follow the exact chat's live delegation, never its historical contacts or latest report context", async (t) => {
    const scripted = controlModel();
    const app = await openApp(scripted.model);

    t.after(() => app.close());
    const firstWork = await newSession(app, app.defaultCwd, "worker");
    const secondWork = await newSession(app, app.defaultCwd, "worker");
    const first = (
        await app.pip.agents.create(owner(app), { name: "Coordinator", requestId: "coordinator" })
    ).id as ConversationId;
    const second = (await app.pip.agents.newChat(first, owner(app), { requestId: "second" }))
        .id as ConversationId;
    const tab = fakeTab(first, owner(app));

    await app.attach(tab.client);
    t.after(() => app.detach(tab.client));
    const revision = () =>
        (
            tab.last("namedAgents") as unknown as
                { agentId: string; controlRevision: number }[] | undefined
        )?.find((agent) => agent.agentId === app.pip.agents.identity(first)!.agentId)
            ?.controlRevision ?? -1;

    await until(() => revision() >= 0, "owner receives the native control projection revision");
    const initialRevision = revision();
    const rows = async (chat: ConversationId) =>
        (await app.pip.agents.read(chat, owner(app))).controllers;
    const itemIds = (entries: Awaited<ReturnType<typeof rows>>) =>
        entries.map((entry) => entry.workItemId).sort();
    const currentIds = (entries: Awaited<ReturnType<typeof rows>>) =>
        itemIds(entries.filter((entry) => entry.current));

    const settle = async (source: ConversationId) => {
        const controller = app.workItems.itemFor(source)!.supervisor!
            .conversationId as ConversationId;

        await until(async () => {
            const work = await app.harness.snapshot(PipWorkDoc, controller, context);

            return (
                work?.reason === "Waiting for meaningful native work events." &&
                !app.isBusy(controller)
            );
        }, "native controller settles");

        return controller;
    };

    await app.pip.agents.supervision.control(first, owner(app), {
        action: "attach",
        session: Number(firstWork),
        requestId: "associate-only",
    });
    assert.equal((await rows(first))[0]!.current, false, "association alone is not control");
    assert.deepEqual(await rows(second), [], "association belongs to its actual source chat");

    await say(app, first, `CONTROL_delegate_${firstWork}`);
    const firstController = await settle(firstWork);

    await until(
        () => revision() > initialRevision,
        "native delegation invalidates the visible owner's controller projection",
    );
    await say(app, first, `CONTROL_delegate_${secondWork}`);
    await settle(secondWork);
    const firstItem = app.workItems.itemFor(firstWork)!.id;
    const secondItem = app.workItems.itemFor(secondWork)!.id;

    assert.deepEqual(currentIds(await rows(first)), [firstItem, secondItem].sort());
    assert.deepEqual(await rows(second), [], "another chat of the same identity has no contacts");

    const observer = (
        await app.pip.agents.create(owner(app), { name: "Observer", requestId: "observer" })
    ).id as ConversationId;
    const observerOther = (
        await app.pip.agents.newChat(observer, owner(app), { requestId: "other" })
    ).id as ConversationId;

    await say(app, observer, `CONTROL_follow_${firstWork}`);
    const observed = await rows(observer);

    assert.deepEqual(
        itemIds(observed),
        [firstItem],
        "exact execution contacts remain discoverable without an attachment",
    );
    assert.equal(observed[0]!.attached, false);
    assert.equal(observed[0]!.current, false);
    assert.deepEqual(
        await rows(observerOther),
        [],
        "passive contacts are also exact-source-chat scoped",
    );
    await app.commands.abort(observer, owner(app));
    const historicalObservation = (await rows(observer))[0]!;

    assert.equal(historicalObservation.current, false);
    assert.equal(
        historicalObservation.state,
        "held",
        "revoked passive authority is not a live observation",
    );
    assert.deepEqual(currentIds(await rows(first)), [firstItem, secondItem].sort());

    // A controller follow advances report context, but does not issue a new native delegation.
    await say(app, second, `CONTROL_follow_${firstController}`);
    assert.deepEqual(currentIds(await rows(first)), [firstItem, secondItem].sort());
    assert.deepEqual(itemIds(await rows(second)), [firstItem]);
    assert.deepEqual(currentIds(await rows(second)), []);

    await say(app, second, `CONTROL_delegate_${firstController}`);
    await settle(firstWork);
    assert.deepEqual(
        itemIds(await rows(first)),
        [firstItem, secondItem].sort(),
        "history is not pruned when control moves",
    );
    assert.deepEqual(currentIds(await rows(first)), [secondItem]);
    assert.deepEqual(currentIds(await rows(second)), [firstItem]);

    await until(
        () => revision() === app.pip.agents.supervision.projectionRevision,
        "owner caught up before native Stop",
    );
    const beforeStop = revision();

    await app.commands.abort(firstController, owner(app));
    await until(
        () => revision() > beforeStop,
        "native Stop invalidates current-control chrome without navigation or polling",
    );
    assert.deepEqual(currentIds(await rows(second)), [], "native Stop ends selected-chat control");
    assert.deepEqual(itemIds(await rows(second)), [firstItem], "Stop retains the contact history");

    await say(app, firstController, "Observe under direct human control and wait.");
    assert.equal(app.workItems.itemFor(firstWork)!.supervisor!.status, "running");
    assert.deepEqual(currentIds(await rows(first)), [secondItem]);
    assert.deepEqual(
        currentIds(await rows(second)),
        [],
        "independent owner activation is not the chat's old delegation",
    );

    const before = scripted.calls();

    await rows(first);
    await rows(second);
    await app.pip.orchestration.control(firstWork, owner(app), { action: "open" });
    assert.equal(
        scripted.calls(),
        before,
        "projection and navigation cannot activate paid reasoning",
    );
});

test("pending native questions and finished work retain truthful state without inventing chat control", async (t) => {
    const { model } = controlModel();
    const app = await openApp(model);

    t.after(() => app.close());
    const questionWork = await newSession(app, app.defaultCwd, "worker");
    const finishedWork = await newSession(app, app.defaultCwd, "worker");
    const chat = (
        await app.pip.agents.create(owner(app), { name: "Questions", requestId: "questions" })
    ).id as ConversationId;
    const rows = () => app.pip.agents.supervision.controllers(chat, owner(app));

    await say(app, chat, `CONTROL_delegate_${questionWork}_ask`);
    const questionItem = app.workItems.itemFor(questionWork)!;
    const controller = questionItem.supervisor!.conversationId as ConversationId;

    await until(
        async () => (await rows()).some((entry) => entry.state === "needs owner"),
        "native question is visible",
    );
    const question = (await rows()).find((entry) => entry.workItemId === questionItem.id)!;

    assert.equal(question.current, true, "a pending question does not give away the native grant");
    assert.equal(question.accessible, true);
    assert.equal(question.reason, "Which permitted scope should this native work use?");

    await app.commands.abort(controller, owner(app));
    const stopped = (await rows()).find((entry) => entry.workItemId === questionItem.id)!;

    assert.equal(stopped.current, false);
    assert.equal(stopped.state, "needs owner", "Stop does not erase the pending question");

    await say(app, chat, `CONTROL_delegate_${finishedWork}_finish`);
    const finishedItem = app.workItems.itemFor(finishedWork)!;

    await until(
        () => app.workItems.itemFor(finishedWork)!.supervisor!.status !== "running",
        "native finish returns human control",
    );
    const finished = (await rows()).find((entry) => entry.workItemId === finishedItem.id)!;

    assert.equal(
        finished.current,
        false,
        "an accepted historical delegation is not current after finish",
    );
    assert.equal(finished.state, "human control");
    assert.match(finished.reason, /no review or publication approval implied/);
});

test("selected-chat history retains inaccessible work and rejects stale owner authority", async (t) => {
    const { model } = controlModel();
    const app = await openApp(model);

    t.after(() => app.close());
    const source = await newSession(app, app.defaultCwd, "worker");
    const chat = (await app.pip.agents.create(owner(app), { name: "Access", requestId: "access" }))
        .id as ConversationId;

    await say(app, chat, `CONTROL_delegate_${source}`);
    const item = app.workItems.itemFor(source)!;
    const controller = item.supervisor!.conversationId as ConversationId;

    await until(async () => {
        const work = await app.harness.snapshot(PipWorkDoc, controller, context);

        return (
            work?.reason === "Waiting for meaningful native work events." && !app.isBusy(controller)
        );
    }, "delegation settles before changing visibility");
    assert.equal(
        (await app.pip.agents.supervision.controllers(chat, owner(app)))[0]!.current,
        true,
    );

    // An adverse persisted access fixture, not a fabricated contact or controller grant.
    await app.harness.commit(async (tx) => {
        (await tx.doc(SessionsDoc)).items[String(controller)]!.pip = "another-owner";
    }, context);
    const unavailable = await app.pip.agents.supervision.controllers(chat, owner(app));

    assert.equal(unavailable.length, 1, "access loss does not silently erase contact history");
    assert.equal(unavailable[0]!.workItemId, item.id);
    assert.equal(unavailable[0]!.state, "unavailable");
    assert.equal(unavailable[0]!.accessible, false);
    assert.equal(unavailable[0]!.current, false);
    assert.equal(unavailable[0]!.title, "Unavailable Work Item");
    assert.equal(unavailable[0]!.activeThreadId, undefined);

    await app.harness.commit(async (tx) => {
        (await tx.doc(SessionsDoc)).items[String(controller)]!.pip = owner(app).id;
    }, context);
    const oldOwner = { ...owner(app) };

    app.config.rotateOwnerToken();
    await assert.rejects(
        app.pip.agents.supervision.controllers(chat, oldOwner),
        /Only the current owner/,
    );
    const revoked = (await app.pip.agents.supervision.controllers(chat, owner(app)))[0]!;

    assert.equal(revoked.current, false, "native token mismatch invalidates current control");
    assert.equal(revoked.state, "held");
    assert.match(revoked.reason, /sign-in changed/);
});

test("disabled execution and native model holds exclude an otherwise current delegation", async (t) => {
    const { model } = controlModel();
    const app = await openApp(model);

    t.after(() => app.close());
    const source = await newSession(app, app.defaultCwd, "worker");
    const chat = (await app.pip.agents.create(owner(app), { name: "Holds", requestId: "holds" }))
        .id as ConversationId;

    await say(app, chat, `CONTROL_delegate_${source}`);
    const controller = app.workItems.itemFor(source)!.supervisor!.conversationId as ConversationId;
    const row = async () => (await app.pip.agents.supervision.controllers(chat, owner(app)))[0]!;

    await until(async () => {
        const work = await app.harness.snapshot(PipWorkDoc, controller, context);

        return (
            work?.reason === "Waiting for meaningful native work events." && !app.isBusy(controller)
        );
    }, "native delegation waits before testing runtime holds");
    assert.equal((await row()).current, true);

    for (const flag of ["pipEnabled", "workItemsEnabled"] as const) {
        const enabled = app.config[flag];

        // Desired runtime flags can hold a retained native grant without rewriting its history.
        app.config[flag] = false;

        try {
            const held = await row();

            assert.equal(app.workItems.itemFor(source)!.supervisor!.status, "running");
            assert.equal(held.attached, true);
            assert.equal(held.state, "held");
            assert.equal(
                held.current,
                false,
                `${flag}: disabled authority cannot be current control`,
            );
        } finally {
            app.config[flag] = enabled;
        }

        assert.equal(
            (await row()).current,
            true,
            `${flag}: inspection did not revoke or reactivate the retained grant`,
        );
    }

    const selected = (await app.harness.snapshot(AgentDoc, controller, context))!.model;

    assert.ok(selected);
    const beforeHold = app.pip.agents.supervision.projectionRevision;

    // An unavailable persisted model, after real delegation, must not become an active chip.
    await app.harness.commit(async (tx) => {
        (await tx.doc(AgentDoc, controller)).model = {
            ...selected,
            modelId: "missing-controlled-model",
        };
    }, context);

    try {
        assert.ok(
            app.pip.agents.supervision.projectionRevision > beforeHold,
            "model holds invalidate the header projection without another work event",
        );
        const held = await row();

        assert.equal(app.workItems.itemFor(source)!.supervisor!.status, "running");
        assert.equal(held.state, "held");
        assert.equal(
            held.current,
            false,
            "a valid historical grant is not effective control while its model is held",
        );
        assert.match(held.reason, /model is unavailable/);
    } finally {
        const beforeRestore = app.pip.agents.supervision.projectionRevision;

        await app.harness.commit(async (tx) => {
            (await tx.doc(AgentDoc, controller)).model = selected;
        }, context);
        assert.ok(
            app.pip.agents.supervision.projectionRevision > beforeRestore,
            "restoring the model also invalidates the header's held state",
        );
    }
});
