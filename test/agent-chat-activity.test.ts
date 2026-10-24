// Catalogue activity is a passive native projection, not a provider-busy heuristic.
import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import {
    type App,
    cleanUp,
    context,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import { privateAgentRequest } from "./private-agent-http.ts";
import type { PrivateAgentRecord, PrivateAgentSummary } from "../src/server/pip/agents.ts";
import { PipWorkDoc, SessionsDoc } from "../src/server/docs.ts";
import type { PushMessage } from "../src/server/push.ts";
import { AgentSupervisionDoc } from "../src/server/pip/agent-supervision.ts";

const cid = (id: number) => id as ConversationId;

after(cleanUp);

async function catalogue(app: App): Promise<PrivateAgentSummary[]> {
    const response = await privateAgentRequest(app, "pip/agents");

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");

    return (await response.json()).agents;
}

function activityModel({
    execution,
    ask,
}: { execution?: () => Promise<void>; ask?: () => boolean } = {}) {
    let calls = 0;
    let parentCalls = 0;
    const model = scriptedModel(async (request) => {
        calls++;
        const system = JSON.stringify(
            request.messages.filter((message) => message.role === "system"),
        );
        const last = lastText(request);

        if (system.includes("the owner's persistent private agent")) {
            parentCalls++;
        }

        if (system.includes("the owner's persistent private agent") && last.role === "user") {
            const command = /ACTIVITY_(send|follow)_(\d+)/.exec(last.text);

            assert.ok(command, last.text);
            const action = command[1];

            assert.ok(action);

            return fauxAssistantMessage(
                [
                    fauxToolCall("agent_work", {
                        action,
                        session: Number(command[2]),
                        report: false,
                        ...(action === "send"
                            ? { text: "Observe native work events and wait." }
                            : {}),
                    }),
                ],
                { stopReason: "toolUse" },
            );
        }

        if (system.includes("the private supervisor for Work Item")) {
            return fauxAssistantMessage(
                [
                    fauxToolCall("work_supervise", {
                        action: ask?.() ? "ask" : "wait",
                        text: ask?.()
                            ? "Which authorized scope should this independent child use next?"
                            : "Waiting for native work events, without a provider request.",
                    }),
                ],
                { stopReason: "toolUse" },
            );
        }

        if (last.role === "user" && last.text.includes("ACTIVITY_EXECUTION")) {
            await execution?.();
        }

        return fauxAssistantMessage("Native contact accepted.");
    });

    return { model, calls: () => calls, parentCalls: () => parentCalls };
}

async function idleController(app: App, controller: ConversationId): Promise<void> {
    await until(async () => {
        const work = await app.harness.snapshot(PipWorkDoc, controller, context);

        return (
            work?.reason === "Waiting for native work events, without a provider request." &&
            !app.isBusy(controller)
        );
    }, "the actual native controller yields between model requests");
}

test("catalogue activity follows accepted exact-chat management while models are idle", async (t) => {
    const scripted = activityModel();
    const app = await openApp(scripted.model);

    t.after(() => app.close());
    const user = owner(app);
    const work = await newSession(app, app.defaultCwd, "worker");
    const controller = cid(
        (await app.pip.orchestration.control(work, user, { action: "open" })).orchestration!
            .conversationId,
    );
    const agent = await app.pip.agents.create(user, { requestId: "active", name: "Coordinator" });
    const chat = cid(agent.id);
    const sibling = cid((await app.pip.agents.newChat(chat, user, { requestId: "sibling" })).id);
    const observer = await app.pip.agents.create(user, {
        requestId: "observer",
        name: "Observer",
    });

    await app.pip.agents.supervision.control(chat, user, {
        action: "attach",
        session: Number(work),
        requestId: "association",
    });
    assert.equal(
        (await catalogue(app)).find((row) => row.agentId === agent.agentId)!.managing,
        false,
        "association alone cannot claim management activity",
    );
    await say(app, chat, `ACTIVITY_send_${controller}`);
    await idleController(app, controller);
    assert.equal(app.isBusy(chat), false);
    assert.equal(app.isBusy(work), false);
    assert.equal(app.workItems.itemFor(work)!.supervisor!.status, "running");
    const active = (await catalogue(app)).find((row) => row.agentId === agent.agentId)!;
    const source = active.chats.find((row) => row.id === Number(chat))!;

    assert.equal(
        source.managing,
        true,
        "idle native child orchestration is still activity for the originating Chat",
    );
    assert.equal(source.busy, false, "provider activity retains its narrower meaning");
    assert.equal(active.managing, true, "identity activity aggregates its visible Chats");
    assert.equal(active.busy, false);
    assert.equal(active.chats.find((row) => row.id === Number(sibling))!.managing, false);

    await say(app, sibling, `ACTIVITY_follow_${controller}`);
    await say(app, cid(observer.id), `ACTIVITY_follow_${work}`);
    const followed = await catalogue(app);
    const followedAgent = followed.find((row) => row.agentId === agent.agentId)!;

    assert.equal(
        followedAgent.chats.find((row) => row.id === Number(chat))!.managing,
        true,
        "a passive contact cannot replace the accepted management origin",
    );
    assert.equal(followedAgent.chats.find((row) => row.id === Number(sibling))!.managing, false);
    assert.equal(followed.find((row) => row.agentId === observer.agentId)!.managing, false);

    const before = scripted.calls();
    const details = await privateAgentRequest(app, `c/${chat}/private-agent`);

    assert.equal(details.status, 200);
    assert.equal(
        (await details.json()).chats.find((row: { id: number }) => row.id === Number(chat))
            .managing,
        true,
    );
    await catalogue(app);
    assert.equal(scripted.calls(), before, "reading activity cannot buy another model response");
    await say(app, sibling, `ACTIVITY_send_${controller}`);
    await idleController(app, controller);
    const shared = (await catalogue(app)).find((row) => row.agentId === agent.agentId)!;

    assert.equal(
        shared.chats.find((row) => row.id === Number(chat))!.managing,
        true,
        "another accepted Chat contact in the same grant does not erase earlier management",
    );
    assert.equal(shared.chats.find((row) => row.id === Number(sibling))!.managing, true);

    await app.commands.abort(controller, user);
    const stopped = (await catalogue(app)).find((row) => row.agentId === agent.agentId)!;

    assert.equal(stopped.managing, false);
    assert.equal(stopped.chats.find((row) => row.id === Number(chat))!.managing, false);
    await say(app, controller, "Observe under direct owner control and wait.");
    await idleController(app, controller);
    assert.equal(app.workItems.itemFor(work)!.supervisor!.status, "running");
    assert.equal(
        (await catalogue(app)).find((row) => row.agentId === agent.agentId)!.managing,
        false,
        "human reactivation is not a renewal of the old private source grant",
    );
    await say(app, chat, `ACTIVITY_send_${controller}`);
    await idleController(app, controller);
    assert.equal(
        (await catalogue(app)).find((row) => row.agentId === agent.agentId)!.managing,
        true,
    );
    await app.pip.agents.supervision.control(sibling, user, {
        action: "attach",
        session: Number(work),
        requestId: "new-attachment",
    });
    assert.equal(app.workItems.itemFor(work)!.supervisor!.status, "running");
    assert.equal(
        (await catalogue(app)).find((row) => row.agentId === agent.agentId)!.managing,
        false,
        "a replaced attachment cannot borrow accepted receipts from its prior epoch",
    );
});

test("management activity is fenced by current owner, source binding and native availability", async (t) => {
    const { model } = activityModel();
    const app = await openApp(model);

    t.after(() => app.close());
    const work = await newSession(app, app.defaultCwd, "worker");
    const user = owner(app);
    const controller = cid(
        (await app.pip.orchestration.control(work, user, { action: "open" })).orchestration!
            .conversationId,
    );
    const agent = await app.pip.agents.create(user, { requestId: "fences" });
    const chat = cid(agent.id);

    await say(app, chat, `ACTIVITY_send_${controller}`);
    await idleController(app, controller);
    const managing = async () =>
        (await catalogue(app)).find((row) => row.agentId === agent.agentId)!.managing;

    assert.equal(await managing(), true);

    for (const flag of ["pipEnabled", "workItemsEnabled"] as const) {
        app.config[flag] = false;

        try {
            assert.equal(await managing(), false, `${flag}: disabled native execution is inactive`);
        } finally {
            app.config[flag] = true;
        }
    }

    assert.equal(await managing(), true, "passive inspection does not rewrite the grant");
    await app.harness.commit(async (tx) => {
        (await tx.doc(SessionsDoc)).items[String(controller)]!.pip = "different-owner";
    }, context);
    assert.equal(
        await managing(),
        false,
        "inaccessible native controller is not active management",
    );
    await app.harness.commit(async (tx) => {
        (await tx.doc(SessionsDoc)).items[String(controller)]!.pip = user.id;
    }, context);
    assert.equal(await managing(), true);
    await app.harness.commit(async (tx) => {
        (await tx.doc(SessionsDoc)).items[String(chat)]!.pipAgentId = "unbound-source";
    }, context);
    assert.equal(
        await managing(),
        false,
        "a rebound source Chat cannot claim the old identity's work",
    );
    await app.harness.commit(async (tx) => {
        (await tx.doc(SessionsDoc)).items[String(chat)]!.pipAgentId = agent.agentId;
    }, context);
    assert.equal(await managing(), true);
    const guest = app.config.addUser("Guest", "guest");
    const denied = await privateAgentRequest(app, "pip/agents", undefined, guest.token);

    assert.equal(denied.status, 403, "management activity remains owner-private");
    const oldToken = app.config.ownerToken;

    app.config.rotateOwnerToken();
    assert.equal(await managing(), false, "the new owner token cannot borrow an old grant");
    const stale = await privateAgentRequest(app, "pip/agents", undefined, oldToken);

    assert.equal(stale.status, 401);
});

test("restoring a closed source does not reacquire management of its independently active child", async (t) => {
    const scripted = activityModel();
    const app = await openApp(scripted.model);

    t.after(() => app.close());
    const user = owner(app);
    const work = await newSession(app, app.defaultCwd, "worker");
    const controller = cid(
        (await app.pip.orchestration.control(work, user, { action: "open" })).orchestration!
            .conversationId,
    );
    const agent = await app.pip.agents.create(user, { requestId: "source-lifecycle" });
    const chat = cid(agent.id);
    const row = async () =>
        (await catalogue(app)).find((entry) => entry.agentId === agent.agentId)!;

    const current = async () => {
        const response = await privateAgentRequest(app, `c/${chat}/private-agent`);

        assert.equal(response.status, 200);
        const details: PrivateAgentRecord = await response.json();

        return details.controllers.find((entry) => entry.conversationId === Number(controller))
            ?.current;
    };

    await say(app, chat, `ACTIVITY_send_${controller}`);
    await idleController(app, controller);
    assert.equal((await row()).managing, true);
    assert.equal(await current(), true);
    const grant = { ...app.workItems.itemFor(work)!.supervisor! };
    const origin = (await app.pip.agents.supervision.status(chat, user)).attachments[0]!
        .contextRequestId;
    const before = scripted.calls();

    assert.ok(origin, "the real accepted contact retains its passive report origin");
    assert.equal(
        (await privateAgentRequest(app, `sessions/${chat}`, { archived: true })).status,
        200,
    );
    assert.deepEqual((await row()).chatIds, []);
    assert.equal(app.workItems.itemFor(work)!.supervisor!.status, "running");
    assert.equal(
        (await privateAgentRequest(app, `sessions/${chat}`, { archived: false })).status,
        200,
    );
    const restored = await row();
    const saved = restored.chats.find((entry) => entry.id === Number(chat))!;

    assert.equal(saved.archived, false);
    assert.equal(saved.busy, false);
    assert.equal(saved.managing, false, "restore cannot renew the closed source's native input");
    assert.equal(restored.managing, false);
    assert.equal(await current(), false, "restored source Peeks cannot claim current management");
    assert.deepEqual(
        app.workItems.itemFor(work)!.supervisor,
        grant,
        "child authority is unchanged",
    );
    assert.equal(
        (await app.pip.agents.supervision.status(chat, user)).attachments[0]!.contextRequestId,
        origin,
        "activity projection cannot discard or reroute the passive origin",
    );
    assert.equal(
        scripted.calls(),
        before,
        "Close, restore and activity reads cannot wake reasoning",
    );
    await say(app, chat, `ACTIVITY_send_${controller}`);
    await idleController(app, controller);
    assert.equal((await row()).managing, true, "a fresh owner-authorized send can manage again");
    assert.equal(
        await current(),
        true,
        "fresh owner authority also restores current managed Peeks",
    );
});

for (const condition of ["restored", "missing-input", "missing-serial"] as const) {
    test(`an independent child's question reaches its owner with ${condition} source authority`, async (t) => {
        const child = Promise.withResolvers<void>();
        let started = false;
        let ask = false;
        const scripted = activityModel({
            execution: async () => {
                started = true;
                await child.promise;
            },
            ask: () => ask,
        });
        const app = await openApp(scripted.model, join(root, `activity-question-${condition}`));

        t.after(async () => {
            child.resolve();
            await app.close();
        });
        const user = owner(app);
        const source = await newSession(app, app.defaultCwd, "worker");
        const controller = cid(
            (await app.pip.orchestration.control(source, user, { action: "open" })).orchestration!
                .conversationId,
        );
        const agent = await app.pip.agents.create(user, { requestId: "restored-question" });
        const chat = cid(agent.id);
        const running = await app.commands.submit(source, user, {
            requestId: "independent-question-source",
            text: "ACTIVITY_EXECUTION: retain actual evidence for the controller.",
        });

        await until(() => started, "the independent child enters its native provider request");
        await say(app, chat, `ACTIVITY_send_${controller}`);
        await idleController(app, controller);
        const before = scripted.parentCalls();

        assert.equal(
            app.pip.agents.supervision.notificationParent(app.workItems.itemFor(source)!),
            chat,
        );

        if (condition === "restored") {
            assert.equal(
                (await privateAgentRequest(app, `sessions/${chat}`, { archived: true })).status,
                200,
            );
            assert.equal(
                (await privateAgentRequest(app, `sessions/${chat}`, { archived: false })).status,
                200,
            );
        } else {
            // Historical missing proof on a real accepted contact, not a fabricated grant or event.
            const origin = (await app.pip.agents.supervision.status(chat, user)).attachments[0]!
                .contextRequestId;

            assert.ok(origin);
            await app.harness.commit(async (tx) => {
                const receipt = Object.values((await tx.doc(AgentSupervisionDoc)).requests).find(
                    (entry) => entry.requestId === origin,
                )!;

                if (condition === "missing-input") {
                    delete receipt.sourceInputId;
                } else {
                    delete receipt.sourceAdmissionSerial;
                }
            }, context);
        }

        assert.equal(
            app.isBusy(source),
            true,
            "source lifecycle cannot stop independent child work",
        );
        assert.equal(
            (await catalogue(app)).find((row) => row.agentId === agent.agentId)!.managing,
            false,
            "revoked or unproven input cannot confer management activity",
        );
        // Keep native owner/prefs/subscription admission; replace only the outgoing push transport.
        app.privateSessions.local.sockets = async () => [];
        const key = createECDH("prime256v1");

        key.generateKeys();
        app.pushStore!.subscribe(user.id, {
            endpoint: "https://fcm.googleapis.com/restored-source-question",
            keys: {
                p256dh: key.getPublicKey().toString("base64url"),
                auth: randomBytes(16).toString("base64url"),
            },
        });
        const sent: { userId: string; message: PushMessage }[] = [];

        t.mock.method(app.pushStore!, "notify", async (userId: string, message: PushMessage) => {
            sent.push({ userId, message });

            return 1;
        });
        ask = true;
        child.resolve();
        const settled = await (await app.harness.submission(running.submissionId, context))!.wait(
            context,
        );

        assert.equal(settled.status, "done");
        await until(async () => {
            const work = await app.harness.snapshot(PipWorkDoc, controller, context);

            return work?.question !== undefined && !app.isBusy(controller);
        }, "the actual settled child outcome wakes its independent controller to ask");
        const decision = sent.find((entry) => entry.message.title === "PiP needs your decision");

        assert.ok(
            decision,
            "revoked or unproven source must not suppress the owner's decision push",
        );
        assert.equal(decision.userId, user.id);
        assert.equal(decision.message.url, `/s/${controller}`);
        assert.match(decision.message.body, /Which authorized scope/);
        assert.equal(scripted.parentCalls(), before, "the revoked parent does not wake to reason");
        assert.equal(app.workItems.itemFor(source)!.supervisor!.status, "running");
    });
}
