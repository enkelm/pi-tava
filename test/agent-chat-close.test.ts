// Native session archive is the Close/restore boundary. Only model decisions and delayed native
// admission are scripted; HTTP, stored history, parent assignments and runtime cancellation are real.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { awaitWithContext, withAbortSignal } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { protectWorkflowEnv } from "../src/server/workflow-policy.ts";
import { SessionsDoc } from "../src/server/docs.ts";
import { AgentIdentitiesDoc } from "../src/server/agent-identity-docs.ts";
import { HandoffsDoc } from "../src/server/workflow-docs.ts";
import { privateAgentRequest as request } from "./private-agent-http.ts";
import {
    cleanUp,
    context,
    executeHandoff,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";

after(cleanUp);

const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
    fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

const closeOwned = (app: Awaited<ReturnType<typeof openApp>>, chat: ConversationId) =>
    request(app, `pip/agents/${app.pip.agents.scope(chat)!.agentId}/close-chat-v1`, {
        chatId: Number(chat),
    });

test("only a current owner's bound saved Chat accepts native archive/restore and retains its history", async () => {
    const data = join(root, "chat-close-history");
    let calls = 0;
    const model = scriptedModel(() => {
        calls++;

        return fauxAssistantMessage("Retained answer.");
    });
    let app = await openApp(model, data);

    try {
        app.config.lastModel = { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
        const created = await app.pip.agents.create(owner(app), {
            requestId: "close-history",
            name: "History owner",
        });
        const chat = created.id as ConversationId;
        const sibling = (await app.pip.agents.newChat(chat, owner(app), { requestId: "sibling" }))
            .id as ConversationId;

        await say(app, chat, "Keep this history");
        const entries = (await (await app.conversation(chat)).context(context)).entries;
        const epoch = app.pip.agents.identity(chat)!.epoch;
        const guest = app.config.addUser("Guest", "guest");
        const generic = await app.pip.ensure(owner(app));
        const source = await newSession(app, app.defaultCwd, "worker");
        const controller = (
            await app.pip.orchestration.control(source, owner(app), { action: "open" })
        ).orchestration!.conversationId as ConversationId;

        for (const id of [generic, controller]) {
            for (const archived of [true, false]) {
                const denied = await request(app, `sessions/${id}`, { archived });

                assert.equal(denied.status, 409, await denied.text());
                assert.notEqual(app.sessionMeta(id)?.archived, true);
            }
        }

        for (const patch of [
            { title: "Not identity settings" },
            { archived: true, title: "Not identity settings" },
            { archived: true, projectId: null },
            { archived: "yes" },
        ]) {
            const denied = await request(app, `sessions/${chat}`, patch);

            assert.ok([400, 409].includes(denied.status), await denied.text());
            assert.notEqual(app.sessionMeta(chat)?.archived, true);
        }

        assert.equal(
            (await request(app, `sessions/${chat}`, { archived: true }, guest.token)).status,
            404,
        );
        await assert.rejects(
            app.commands.updateSession(
                chat,
                { ...owner(app), tokenHash: "stale" },
                {
                    archived: true,
                },
            ),
        );
        await app.pip.agents.setBudget(chat, owner(app), 0);
        await assert.rejects(
            app.pip.agents.submitDraft(created.agentId, owner(app), {
                text: "Rejected first input",
                requestId: "rejected-reservation",
            }),
            /spend limit/,
        );
        const reservation = Object.values(
            (await app.harness.snapshot(AgentIdentitiesDoc, context))!.requests,
        ).find((entry) => entry.firstInputRequestId?.endsWith(":rejected-reservation"))!;

        assert.ok(reservation.chatId, "native rejected admission retains its reserved exact Chat");

        for (const archived of [true, false]) {
            const denied = await request(app, `sessions/${reservation.chatId}`, { archived });

            assert.equal(denied.status, 409, "a reservation is not saved Chat history");
        }

        await app.pip.agents.setBudget(chat, owner(app), undefined);
        const closed = await request(app, `sessions/${chat}`, { archived: true });

        assert.equal(closed.status, 200, await closed.text());
        assert.equal(app.sessionMeta(chat)?.archived, true);
        assert.notEqual(app.sessionMeta(sibling)?.archived, true);
        assert.equal(app.pip.agents.identity(chat)!.epoch, epoch);
        assert.deepEqual(
            (await (await app.conversation(chat)).context(context)).entries,
            entries,
            "Close retains native history rather than deleting its conversation",
        );
        const refused = await request(app, `c/${chat}/submit`, {
            text: "Do not run while closed",
            requestId: "closed-input",
        });

        assert.equal(refused.status, 409, await refused.text());
        await app.close();
        app = await openApp(model, data);
        assert.equal(app.sessionMeta(chat)?.archived, true, "archive is global durable state");
        const restored = await request(app, `sessions/${chat}`, { archived: false });

        assert.equal(restored.status, 200, await restored.text());
        assert.equal(app.isBusy(chat), false, "restore does not restart the old task");
        assert.equal(calls, 1);
        assert.deepEqual((await (await app.conversation(chat)).context(context)).entries, entries);
        await say(app, chat, "A fresh instruction");
        assert.equal(calls, 2, "fresh owner input can run after restore");

        // Persisted malformed/old bindings must not gain management merely from pipAgent:true.
        await app.harness.commit(async (tx) => {
            const sessions = await tx.doc(SessionsDoc);
            const identities = await tx.doc(AgentIdentitiesDoc);

            identities.items[created.agentId]!.chatIds = [Number(chat)];
            delete sessions.items[String(sibling)]!.pipAgentId;
        }, context);
        const unbound = await request(app, `sessions/${sibling}`, { archived: true });

        assert.equal(unbound.status, 409, await unbound.text());
        assert.notEqual(app.sessionMeta(sibling)?.archived, true);
    } finally {
        await app.close();
    }
});

test("Close aborts the exact Chat's native run and queue without stopping a busy sibling", async (t) => {
    const held = Promise.withResolvers<void>();
    const started = new Set<string>();
    const app = await openApp(
        scriptedModel(async (input, options) => {
            const text = lastText(input).text;

            if (text.includes("Hold source") || text.includes("Hold sibling")) {
                started.add(text.includes("Hold source") ? "source" : "sibling");
                await awaitWithContext(
                    held.promise,
                    options?.signal ? withAbortSignal(options.signal, context) : context,
                );
            }

            return fauxAssistantMessage("Settled without replacement work.");
        }),
        join(root, "chat-close-running"),
    );

    t.after(async () => {
        held.resolve();
        await app.close();
    });
    app.config.lastModel = { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
    const created = await app.pip.agents.create(owner(app), {
        name: "Independent Chats",
        requestId: "running-chats",
    });
    const chat = created.id as ConversationId;
    const sibling = (await app.pip.agents.newChat(chat, owner(app), { requestId: "sibling" }))
        .id as ConversationId;
    const running = await app.commands.submit(chat, owner(app), {
        text: "Hold source",
        requestId: "hold-source",
    });

    await until(() => started.has("source"), "the exact source Chat entered its provider");
    const other = await app.commands.submit(sibling, owner(app), {
        text: "Hold sibling",
        requestId: "hold-sibling",
    });

    await until(() => started.size === 2, "both independent Chats entered their provider");
    const queued = await app.commands.submit(chat, owner(app), {
        text: "Queued old source instruction",
        requestId: "queued-source",
    });
    const closed = await request(app, `sessions/${chat}`, { archived: true });

    assert.equal(closed.status, 200, await closed.text());
    assert.equal(app.isBusy(chat), false);
    assert.equal(app.isBusy(sibling), true, "a shared identity is not a cancellation scope");

    for (const receipt of [running, queued]) {
        const settled = await (await app.harness.submission(receipt.submissionId, context))!.wait(
            context,
        );

        assert.equal(settled.status, "unanswered");
        assert.equal(settled.reason, "aborted");
    }

    assert.equal((await request(app, `sessions/${chat}`, { archived: false })).status, 200);
    assert.equal(app.isBusy(chat), false);
    held.resolve();
    const siblingResult = await (await app.harness.submission(other.submissionId, context))!.wait(
        context,
    );

    assert.equal(siblingResult.status, "done");
});

test("Close joins a real tool queued on supervision without a lock cycle, and Restore waits for that join", async (t) => {
    const modelGate = Promise.withResolvers<void>();
    const laneGate = Promise.withResolvers<void>();
    const nativeJoined = Promise.withResolvers<void>();
    const finishJoin = Promise.withResolvers<void>();
    let controller!: ConversationId;
    let providerEntered = false;
    const app = await openApp(
        scriptedModel(async (_input, options) => {
            providerEntered = true;
            await awaitWithContext(
                modelGate.promise,
                options?.signal ? withAbortSignal(options.signal, context) : context,
            );

            return tool("agent_work", {
                action: "send",
                session: Number(controller),
                text: "This queued source must not activate after Close.",
            });
        }),
        join(root, "chat-close-queued-tool"),
    );
    const conversation = app.conversation.bind(app);
    let aborting: Promise<void> | undefined;
    let closing: Promise<Response> | undefined;
    let restoring: Promise<Response> | undefined;

    t.after(async () => {
        modelGate.resolve();
        laneGate.resolve();
        finishJoin.resolve();
        await closing;
        await restoring;
        await aborting;
        app.conversation = conversation;
        await app.close();
    });
    const source = await newSession(app, app.defaultCwd, "researcher");

    controller = (await app.pip.orchestration.control(source, owner(app), { action: "open" }))
        .orchestration!.conversationId as ConversationId;
    const created = await app.pip.agents.create(owner(app), {
        name: "Queued tool",
        requestId: "queued-tool",
    });
    const chat = created.id as ConversationId;

    await app.commands.submit(chat, owner(app), { text: "Read the controller", requestId: "read" });
    await until(() => providerEntered, "the native Chat generation entered its provider");
    const supervision = app.pip.agents.supervision;
    const perform = supervision.perform.bind(supervision);
    const blocking = perform(chat, () => laneGate.promise);
    let queued = 0;

    supervision.perform = (id, operation) => {
        if (id === chat) {
            queued++;
        }

        return perform(id, operation);
    };

    // A teardown watchdog breaks the pre-fix deadlock by rejecting only the HTTP join wait.
    // The real Durable abort still runs, and its exact promise is joined before app teardown.
    app.conversation = async (id) => {
        const handle = await conversation(id);

        return id !== chat
            ? handle
            : new Proxy(handle, {
                  get(target, property) {
                      if (property === "abort") {
                          return async (...args: Parameters<typeof handle.abort>) => {
                              aborting = target.abort(...args);
                              let timer: ReturnType<typeof setTimeout> | undefined;

                              try {
                                  await Promise.race([
                                      aborting.then(async () => {
                                          nativeJoined.resolve();
                                          await finishJoin.promise;
                                      }),
                                      new Promise<never>((_resolve, reject) => {
                                          timer = setTimeout(
                                              () =>
                                                  reject(new Error("Close/queued-tool join cycle")),
                                              2000,
                                          );
                                      }),
                                  ]);
                              } finally {
                                  clearTimeout(timer);
                              }
                          };
                      }

                      const value = Reflect.get(target, property, target);

                      return typeof value === "function" ? value.bind(target) : value;
                  },
              });
    };

    closing = request(app, `sessions/${chat}`, { archived: true });
    await until(() => queued >= 1, "Close queued behind the native supervision lane");
    modelGate.resolve();
    await until(() => queued >= 2, "the real agent_work tool queued behind Close");
    laneGate.resolve();
    await blocking;
    const joined = await Promise.race([
        nativeJoined.promise.then(() => true),
        closing.then(() => false),
    ]);

    assert.equal(joined, true, "native queued tool and Close must join without a lane cycle");
    restoring = request(app, `sessions/${chat}`, { archived: false });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(app.sessionMeta(chat)?.archived, true, "Restore cannot overtake Close's join");
    finishJoin.resolve();
    assert.equal((await closing).status, 200);
    assert.equal((await restoring).status, 200);
    assert.equal(app.isBusy(chat), false);
    assert.notEqual(app.sessionMeta(chat)?.archived, true);
    assert.notEqual(app.workItems.itemFor(source)!.supervisor!.status, "running");
});

test("closing idle Chat A preserves sibling B's real borrowed writer and coding operation", async (t) => {
    const beforeWrite = Promise.withResolvers<void>();
    const afterWrite = Promise.withResolvers<void>();
    const directory = mkdtempSync(join(root, "sibling-writer-"));
    const file = join(directory, "correction.txt");
    let source!: ConversationId;
    let step = 0;
    let borrowed = false;
    let written = false;
    const app = await openApp(
        scriptedModel(async (_input, options) => {
            const ctx = options?.signal ? withAbortSignal(options.signal, context) : context;

            if (step++ === 0) {
                return tool("agent_execution", { action: "intervene", session: Number(source) });
            }

            if (step === 2) {
                borrowed = true;
                await awaitWithContext(beforeWrite.promise, ctx);

                return tool("write", { path: file, content: "Sibling B retained its writer" });
            }

            written = true;
            await awaitWithContext(afterWrite.promise, ctx);

            return fauxAssistantMessage("Correction finished.");
        }),
        join(root, "chat-close-sibling-writer"),
    );

    t.after(async () => {
        beforeWrite.resolve();
        afterWrite.resolve();
        await app.close();
    });
    source = await newSession(app, directory, "worker");
    const created = await app.pip.agents.create(owner(app), {
        name: "Sibling writers",
        requestId: "sibling-writers",
    });
    const chat = created.id as ConversationId;
    const sibling = (await app.pip.agents.newChat(chat, owner(app), { requestId: "borrower" }))
        .id as ConversationId;

    await app.pip.agents.supervision.control(sibling, owner(app), {
        action: "attach",
        session: Number(source),
        requestId: "attach-writer",
    });
    await app.commands.submit(sibling, owner(app), {
        text: "Take the writer and correct the work directly.",
        requestId: "borrow-writer",
    });
    await until(() => borrowed, "sibling B's real intervention acquired the native writer");
    const lease = structuredClone(app.workItems.itemFor(source)!.intervention);

    assert.equal(lease?.chatId, Number(sibling));
    assert.equal((await request(app, `sessions/${chat}`, { archived: true })).status, 200);
    assert.deepEqual(app.workItems.itemFor(source)!.intervention, lease);
    assert.equal(app.isBusy(sibling), true);
    beforeWrite.resolve();
    await until(() => written && existsSync(file), "B completes its real selected write tool");
    assert.equal(readFileSync(file, "utf8"), "Sibling B retained its writer");
    await app.pip.agents.execution.release(chat);
    assert.equal(
        app.workItems.itemFor(source)!.intervention,
        undefined,
        "explicit legacy identity-wide release still returns a sibling's writer",
    );
    afterWrite.resolve();
});

test("Close archives and joins its currently managed whole Work Item; restores retain history without resuming", async (t) => {
    const child = Promise.withResolvers<void>();
    let childStarted = false;
    let parentCalls = 0;
    let phase = "own";
    let source!: ConversationId;
    let controller!: ConversationId;
    const app = await openApp(
        scriptedModel(async (input, options) => {
            const system = JSON.stringify(
                input.messages.filter((message) => message.role === "system"),
            );
            const last = lastText(input);

            if (system.includes("the owner's persistent private agent")) {
                parentCalls++;

                if (phase === "own") {
                    phase = "owned";

                    return tool("handoff", {
                        action: "start",
                        targetType: "researcher",
                        relationship: "new-work",
                        summary: "Create a bounded native child and retain the evidence.",
                    });
                }

                if (phase === "owned") {
                    phase = "send";

                    return fauxAssistantMessage("Ownership recorded; wait for fresh input.");
                }

                if (phase === "send") {
                    phase = "wait";

                    return tool("agent_work", {
                        action: "send",
                        session: Number(controller),
                        text: "Wait for the already running child, then finish.",
                    });
                }

                if (phase === "wait") {
                    phase = "waiting";
                    const requestId = /"requestId":"([^"]+)"/.exec(last.text)?.[1];

                    assert.ok(requestId, last.text);

                    return tool("work_supervise", {
                        action: "wait",
                        text: "Inspect the child only after its actual completion.",
                        continuation: {
                            requestId,
                            remaining: "Inspect the evidence, then decide.",
                        },
                    });
                }

                return fauxAssistantMessage("Only a fresh owner input may reach this response.");
            }

            if (system.includes("the private supervisor for Work Item")) {
                return tool("work_supervise", {
                    action: childStarted && !app.isBusy(source) ? "finish" : "wait",
                    text: "Keep the native child evidence at its source.",
                });
            }

            if (system.includes("You are the Researcher agent")) {
                childStarted = true;
                await awaitWithContext(
                    child.promise,
                    options?.signal ? withAbortSignal(options.signal, context) : context,
                );

                return fauxAssistantMessage("Independent child evidence completed.");
            }

            return fauxAssistantMessage("Unrelated naming fixture.");
        }),
        join(root, "chat-close-parent"),
    );

    t.after(async () => {
        child.resolve();
        await app.close();
    });
    app.config.lastModel = { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
    const created = await app.pip.agents.create(owner(app), {
        name: "Parent Chat",
        requestId: "close-parent",
    });
    const chat = created.id as ConversationId;

    await say(app, chat, "Create a new bounded Researcher child and wait before running it.");
    source = app.sessions(owner(app)).find((row) => row.threadType === "researcher")!
        .id as ConversationId;
    controller = app.workItems.itemFor(source)!.supervisor!.conversationId as ConversationId;
    assert.equal(
        app.pip.agents.supervision.groupingParent(app.workItems.itemFor(source)!, owner(app))
            ?.groupingParentChatId,
        Number(chat),
    );
    const execution = await app.commands.submit(source, owner(app), {
        text: "Investigate independently and retain evidence.",
        requestId: "independent-child",
    });

    await until(() => childStarted, "independent child running");
    await app.commands.submit(chat, owner(app), {
        text: "Coordinate the existing child and inspect its result.",
        requestId: "parent-task",
    });
    await until(
        async () =>
            !app.isBusy(chat) &&
            (await app.pip.agents.supervision.parentContext(chat, owner(app)))[0]?.status ===
                "waiting",
        "native registered parent wait",
    );
    const parentBeforeClose = parentCalls;
    const rejected = await request(app, `pip/agents/${created.agentId}/close-chat-v1`, {
        chatId: Number(chat),
        archived: true,
    });

    assert.equal(
        rejected.status,
        400,
        "versioned Close rejects unknown payload keys without effects",
    );
    assert.notEqual(app.sessionMeta(chat)?.archived, true);
    assert.equal((await request(app, `sessions/${chat}`, { archived: true })).status, 200);
    assert.equal(
        app.isBusy(source),
        true,
        "an older frontend's Chat-only contract must not escalate to child cancellation",
    );
    assert.notEqual(app.sessionMeta(source)?.archived, true);
    await t.test(
        "legacy Chat-only archive cannot receive a false owned Close acknowledgement",
        async () => {
            const unchanged = await closeOwned(app, chat);
            const body = await unchanged.json();

            assert.equal(unchanged.status, 409, JSON.stringify(body));
            assert.equal(
                body.scope,
                undefined,
                "an already-closed no-op cannot certify an owned join",
            );
            assert.equal(body.ok, undefined);
            assert.match(body.error, /already closed/i);
            assert.match(body.error, /no additional child/i);
            assert.match(body.error, /restore.*fresh close/i);
            assert.equal(app.sessionMeta(chat)?.archived, true);
            assert.notEqual(app.workItems.itemFor(source)!.archived, true);
            assert.equal(
                app.isBusy(source),
                true,
                "the refused stale-UI request leaves child execution untouched",
            );

            for (const member of app.workItems.members(source)) {
                assert.notEqual(app.sessionMeta(member)?.archived, true);
            }
        },
    );
    assert.equal((await request(app, `sessions/${chat}`, { archived: false })).status, 200);
    const exact = app.pip.agents
        .list(owner(app))
        .find((row) => row.agentId === created.agentId)!
        .chats.find((row) => row.id === Number(chat))!;

    assert.equal(exact.busy, false);
    assert.equal(exact.managing, false);
    assert.equal(
        exact.runningChildren,
        true,
        "trusted exact child projection survives a stopped source task",
    );
    const members = app.workItems.members(source);
    const entries = (await (await app.conversation(source)).context(context)).entries;
    const closed = await closeOwned(app, chat);

    assert.equal(closed.status, 200, await closed.text());
    assert.equal(app.isBusy(source), false, "the currently controlled child is natively joined");
    assert.equal(app.isBusy(controller), false);
    assert.equal(app.workItems.itemFor(source)!.archived, true);
    assert.equal(app.workItems.itemFor(source)!.supervisor!.status, "reclaimed");
    const file = join(root, "archived-work-item-fence.txt");
    const env = protectWorkflowEnv(
        app,
        source,
        new NodeExecutionEnv({ cwd: app.cwdOf(source) }),
        async () => {
            throw new Error("This file-only fixture must never launch a shell.");
        },
        owner(app),
    );
    const refusedWrite = await env.writeFile(file, "Must not write while archived", context);

    assert.equal(
        refusedWrite.ok,
        false,
        "the native environment rejects fresh effects after the archive fence",
    );
    assert.match(!refusedWrite.ok ? refusedWrite.error.message : "", /Restore the Work Item/);
    assert.equal(existsSync(file), false);

    for (const member of members) {
        assert.equal(app.sessionMeta(member)?.archived, true);
        assert.equal(
            app.sessions(owner(app)).find((row) => row.id === member)?.groupingParentChatId,
            Number(chat),
        );
    }

    assert.equal(
        (await app.pip.agents.supervision.parentContext(chat, owner(app)))[0]?.status,
        "revoked",
    );
    assert.equal((await request(app, `sessions/${chat}`, { archived: false })).status, 200);
    assert.equal(
        app.isBusy(chat),
        false,
        "Chat restore remains idle and does not restore children",
    );
    assert.equal(app.workItems.itemFor(source)!.archived, true);
    assert.deepEqual((await (await app.conversation(source)).context(context)).entries, entries);
    child.resolve();
    const completed = await (await app.harness.submission(execution.submissionId, context))!.wait(
        context,
    );

    assert.equal(completed.status, "unanswered");

    if (completed.status === "unanswered") {
        assert.equal(completed.reason, "aborted");
    }

    assert.equal((await request(app, `sessions/${source}`, { archived: false })).status, 200);
    assert.equal(app.workItems.itemFor(source)!.archived, false);
    assert.equal(app.isBusy(source), false, "explicit whole-item restore cannot resume execution");
    const freshWrite = await env.writeFile(
        file,
        "Fresh explicit owner effect after restore",
        context,
    );

    assert.equal(
        freshWrite.ok,
        true,
        "an explicit restore reopens new owner effects, not old tasks",
    );
    assert.equal(readFileSync(file, "utf8"), "Fresh explicit owner effect after restore");
    await env.cleanup(context);
    assert.equal(
        app.sessions(owner(app)).find((row) => row.id === source)?.groupingParentChatId,
        Number(chat),
        "inert Restore retains passive ownership, never live control",
    );
    await until(() => !app.isBusy(controller), "child controller settled");
    await app.pip.agents.supervision.open();
    await until(() => !app.isBusy(chat), "restored history idle");
    assert.equal(
        parentCalls,
        parentBeforeClose,
        "restoration delivers history, never old paid continuation",
    );
    await say(app, chat, "A fresh task after restore");
    assert.equal(parentCalls, parentBeforeClose + 1);
});

test("whole Work Item Restore waits for its owning Chat's native join and revalidates current access", async (t) => {
    for (const mode of [
        "session",
        "work item",
        "other owner",
        "visibility changed",
        "driver changed",
    ]) {
        await t.test(mode, async (t) => {
            const provider = Promise.withResolvers<void>();
            const joined = Promise.withResolvers<void>();
            const finishJoin = Promise.withResolvers<void>();
            let childStarted = false;
            let calls = 0;
            const wouldWrite = join(root, `old-restored-tool-${mode}.txt`);
            const app = await openApp(
                scriptedModel(async (input, options) => {
                    calls++;
                    const system = JSON.stringify(
                        input.messages.filter((message) => message.role === "system"),
                    );
                    const last = lastText(input);

                    if (
                        system.includes("the owner's persistent private agent") &&
                        last.role === "user"
                    ) {
                        return tool("handoff", {
                            action: "start",
                            targetType: "researcher",
                            relationship: "new-work",
                            summary: "Create one bounded native child for lifecycle ordering.",
                        });
                    }

                    if (system.includes("the private supervisor for Work Item")) {
                        return tool("work_supervise", {
                            action: "wait",
                            text: "Wait for native events.",
                        });
                    }

                    if (system.includes("You are the Researcher agent")) {
                        childStarted = true;
                        await awaitWithContext(
                            provider.promise,
                            options?.signal ? withAbortSignal(options.signal, context) : context,
                        );

                        return tool("write", {
                            path: wouldWrite,
                            content: "Old work must never resume.",
                        });
                    }

                    return fauxAssistantMessage("Fixture task retained.");
                }),
                join(root, `chat-close-restore-join-${mode}`),
            );
            const conversation = app.conversation.bind(app);
            let closing: Promise<Response> | undefined;
            let restoring: Promise<Response> | undefined;
            let repeated: Promise<Response> | undefined;

            t.after(async () => {
                finishJoin.resolve();
                provider.resolve();
                await Promise.allSettled([closing, restoring, repeated]);
                app.conversation = conversation;
                await app.close();
            });
            app.config.lastModel = { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
            const user = owner(app);
            const other = app.config.addUser(
                "Other authorized person",
                mode === "visibility changed" ? "guest" : "owner",
            );
            const created = await app.pip.agents.create(user, {
                name: "Join owner",
                requestId: "join-owner",
            });
            const chat = created.id as ConversationId;

            await say(app, chat, "Create a new bounded Researcher child and wait.");
            const source = app.sessions(user).find((row) => row.threadType === "researcher")!
                .id as ConversationId;
            const controller = app.workItems.itemFor(source)!.supervisor!
                .conversationId as ConversationId;

            app.conversation = async (id) => {
                const handle = await conversation(id);

                return id !== source
                    ? handle
                    : new Proxy(handle, {
                          get(target, property) {
                              if (property === "abort") {
                                  return async (...args: Parameters<typeof handle.abort>) => {
                                      await target.abort(...args);
                                      joined.resolve();
                                      await finishJoin.promise;
                                  };
                              }

                              const value = Reflect.get(target, property, target);

                              return typeof value === "function" ? value.bind(target) : value;
                          },
                      });
            };

            const execution = await app.commands.submit(source, user, {
                requestId: "hold-child",
                text: "Hold this child until stopped.",
            });

            await until(() => childStarted, "the real native child starts");
            closing = closeOwned(app, chat);
            await joined.promise;
            await until(() => !app.isBusy(controller), "the native controller is stopped");
            const beforeCalls = calls;
            const restoredByOther = mode === "other owner" || mode === "visibility changed";
            const token = restoredByOther ? other.token : app.config.ownerToken;
            const path =
                mode === "session" ? `sessions/${source}` : `c/${source}/x/work-items/work-item`;
            let restoreFinished = false;

            restoring = request(app, path, { archived: false }, token).then((response) => {
                restoreFinished = true;

                return response;
            });
            await new Promise<void>((resolve) => setImmediate(resolve));
            assert.equal(
                restoreFinished,
                false,
                "Restore must wait outside native locks, not publish during Close's held join",
            );
            assert.equal(app.sessionMeta(source)?.archived, true);
            const file = join(root, `pending-restore-writer-${mode}.txt`);
            const env = protectWorkflowEnv(
                app,
                source,
                new NodeExecutionEnv({ cwd: app.cwdOf(source) }),
                async () => {
                    throw new Error("This file-only fixture cannot launch a shell.");
                },
                user,
            );
            const refused = await env.writeFile(file, "Too early", context);

            assert.equal(refused.ok, false, "the native writer stays fenced until join finishes");
            assert.equal(existsSync(file), false);

            if (mode === "other owner") {
                assert.equal(
                    app.workItems.projection(source, other.user).groupingParentChatId,
                    undefined,
                    "the wait uses private stored ownership, not owner-projected grouping",
                );
                const moved = await request(app, `sessions/${source}`, { projectId: null });

                assert.equal(
                    moved.status,
                    409,
                    "Move cannot clear the private join relationship during Close",
                );
                assert.equal(app.workItems.itemFor(source)!.parentChat?.chatId, Number(chat));
            }

            if (mode === "visibility changed") {
                app.config.updateUser(other.user.id, { sessions: ["999999"] });
            }

            if (mode === "driver changed") {
                await app.collab.turns(source, other.user, { action: "on" });
            }

            if (mode === "session") {
                let duplicateFinished = false;

                repeated = closeOwned(app, chat).then((response) => {
                    duplicateFinished = true;

                    return response;
                });
                await new Promise<void>((resolve) => setImmediate(resolve));
                assert.equal(
                    duplicateFinished,
                    false,
                    "a repeated Close still joins the first Close",
                );
            }

            finishJoin.resolve();
            assert.equal((await closing).status, 200);
            const restored = await restoring;
            const blocked = mode === "visibility changed" || mode === "driver changed";

            assert.equal(
                restored.status,
                mode === "visibility changed" ? 404 : mode === "driver changed" ? 409 : 200,
                await restored.text(),
            );
            assert.equal(app.sessionMeta(source)?.archived, blocked);
            assert.equal(app.workItems.itemFor(source)!.supervisor!.status, "reclaimed");
            assert.equal(app.workItems.itemFor(source)!.supervisor!.agentId, undefined);
            assert.equal(app.isBusy(chat), false);
            assert.equal(app.isBusy(source), false);
            assert.equal(calls, beforeCalls, "restore cannot wake model or tool work");
            assert.equal(existsSync(wouldWrite), false);
            const settled = await (await app.harness.submission(
                execution.submissionId,
                context,
            ))!.wait(context);

            assert.equal(settled.status, "unanswered");

            if (!blocked) {
                const fresh = await env.writeFile(
                    file,
                    "Fresh owner effect after settled restore",
                    context,
                );

                assert.equal(fresh.ok, true);
            }

            await env.cleanup(context);

            if (mode === "session") {
                const duplicate = await repeated!;

                assert.equal(
                    duplicate.status,
                    409,
                    "duplicate HTTP refusal cannot reject the internal lifecycle wait used by Restore",
                );
                assert.equal((await duplicate.json()).scope, undefined);
                assert.equal(
                    (await closeOwned(app, chat)).status,
                    409,
                    "a lost-ACK retry against an already closed Chat is refused without new child changes",
                );
                assert.equal(
                    app.sessionMeta(source)?.archived,
                    false,
                    "stale Close cannot undo later explicit child Restore",
                );
                assert.equal(
                    (await request(app, `sessions/${chat}`, { archived: false })).status,
                    200,
                );
                assert.equal((await closeOwned(app, chat)).status, 200);
                assert.equal(
                    app.sessionMeta(source)?.archived,
                    true,
                    "a fresh Close after explicit Chat Restore has a fresh owned scope",
                );
            }
        });
    }
});

test("Close refuses legacy creation ownership after a pre-field project move without partially archiving the Chat", async (t) => {
    const app = await openApp(
        scriptedModel((input) => {
            const system = JSON.stringify(
                input.messages.filter((message) => message.role === "system"),
            );
            const last = lastText(input);

            if (system.includes("the owner's persistent private agent") && last.role === "user") {
                return tool("handoff", {
                    action: "start",
                    targetType: "researcher",
                    relationship: "new-work",
                    summary: "Create bounded work in this exact Chat's current project.",
                });
            }

            if (system.includes("the private supervisor for Work Item")) {
                return tool("work_supervise", { action: "wait", text: "Wait for native events." });
            }

            return fauxAssistantMessage("Accepted native creation.");
        }),
        join(root, "chat-close-old-moved-child"),
    );

    t.after(() => app.close());
    app.config.lastModel = { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
    const user = owner(app);
    const created = await app.pip.agents.create(user, {
        name: "Old child origin",
        requestId: "old-child",
    });
    const chat = created.id as ConversationId;

    await say(app, chat, "Create a new bounded Researcher child and wait.");
    const source = app.sessions(user).find((row) => row.threadType === "researcher")!
        .id as ConversationId;
    const project = await app.projects.create(user, {
        name: "Explicitly moved destination",
        cwd: app.defaultCwd,
        requestId: "moved-destination",
    });

    await app.projects.assign(user, source, { projectId: project.id });
    await app.harness.commit(async (tx) => {
        // Retain genuine creation/move history and immutable creation proof. Omit only the new
        // detach field to represent native data moved before this additive field existed.
        delete (await tx.doc(HandoffsDoc)).workItems[app.workItems.itemFor(source)!.id]!.parentChat;
    }, context);
    assert.equal(
        app.pip.agents.supervision.groupingParent(app.workItems.itemFor(source)!, user)
            ?.groupingParentChatId,
        Number(chat),
        "the immutable native origin remains provable, not necessarily current ownership",
    );
    const closed = await closeOwned(app, chat);

    assert.equal(closed.status, 409, "origin cannot authorize cross-project destructive Close");
    assert.notEqual(app.sessionMeta(chat)?.archived, true);
    assert.notEqual(app.sessionMeta(source)?.archived, true);
    assert.equal(app.sessionMeta(source)?.projectId, project.id);
    assert.equal(
        app.workItems.itemFor(source)!.parentChat,
        undefined,
        "refusal cannot silently establish ownership from old origin",
    );
});

test("Close uses exclusive current exact-Chat ownership, refuses shared control, and persists whole-item display provenance", async () => {
    const data = join(root, "chat-close-exclusive");
    const model = scriptedModel((input) => {
        const system = JSON.stringify(
            input.messages.filter((message) => message.role === "system"),
        );
        const last = lastText(input);

        if (system.includes("the owner's persistent private agent") && last.role === "user") {
            if (last.text === "CREATE") {
                return tool("handoff", {
                    action: "start",
                    targetType: "worker",
                    relationship: "new-work",
                    summary: "Create a bounded native Work Item child.",
                });
            }

            const controller = /CONTROL_(\d+)/.exec(last.text);

            assert.ok(controller, last.text);

            return tool("agent_work", {
                action: "send",
                session: Number(controller[1]),
                text: "Observe this exact Work Item and wait.",
                report: false,
            });
        }

        if (system.includes("the private supervisor for Work Item")) {
            return tool("work_supervise", {
                action: last.text === "FINISH" ? "finish" : "wait",
                text: "Wait without new work.",
            });
        }

        return fauxAssistantMessage("Fixture evidence retained.");
    });
    let app = await openApp(model, data);

    try {
        app.config.lastModel = { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
        const user = owner(app);
        const created = await app.pip.agents.create(user, {
            name: "Exact owners",
            requestId: "exclusive",
        });
        const a = created.id as ConversationId;
        const b = (await app.pip.agents.newChat(a, user, { requestId: "second" }))
            .id as ConversationId;

        const create = async (chat: ConversationId) => {
            const before = new Set(app.sessions(user).map((row) => row.id));

            await say(app, chat, "CREATE");
            const row = app
                .sessions(user)
                .find((row) => !before.has(row.id) && row.workItemId !== undefined);

            assert.ok(row, "the registered native handoff created a real Work Item");

            return row.id as ConversationId;
        };

        const ownA = await create(a);

        await app.close();
        app = await openApp(model, data);
        const successor = (await executeHandoff(app, ownA, "researcher")).id as ConversationId;
        const ownB = await create(b);
        const shared = await create(a);
        const moved = await create(a);

        await app.projects.assign(user, moved, { projectId: null });
        const historical = await newSession(app, app.defaultCwd, "worker");
        const unrelated = await newSession(app, app.defaultCwd, "worker");
        const controllers = new Map<ConversationId, ConversationId>();

        for (const source of [ownA, ownB, shared, historical]) {
            controllers.set(
                source,
                (await app.pip.orchestration.control(source, user, { action: "open" }))
                    .orchestration!.conversationId as ConversationId,
            );
        }

        const contact = async (chat: ConversationId, work: ConversationId) => {
            const controller = controllers.get(work)!;

            await say(app, chat, `CONTROL_${controller}`);
            await until(() => !app.isBusy(controller), "native controller wait settles");
        };

        await contact(a, ownA);
        await say(app, controllers.get(ownA)!, "FINISH");
        assert.notEqual(app.workItems.itemFor(ownA)!.supervisor!.status, "running");
        // Represent an older stored native creation: retain its real accepted receipt and ledger,
        // omitting only the newly additive field. No fabricated ownership or acceptance is supplied.
        await app.harness.commit(async (tx) => {
            delete (await tx.doc(HandoffsDoc)).workItems[app.workItems.itemFor(ownA)!.id]!
                .parentChat;
        }, context);
        assert.equal(
            app.pip.agents.supervision.groupingParent(app.workItems.itemFor(ownA)!, user)
                ?.groupingParentChatId,
            Number(a),
            "validated legacy creation survives semantic completion",
        );
        await contact(b, ownB);
        await contact(a, historical);
        await app.pip.orchestration.stopped(historical, user);
        await contact(a, shared);
        await contact(b, shared);
        assert.equal(
            app.pip.agents.supervision.groupingParent(app.workItems.itemFor(shared)!, user)
                ?.groupingParentChatId,
            Number(a),
        );
        assert.equal(
            app.pip.agents.supervision.parentChat(app.workItems.itemFor(shared)!, user),
            undefined,
            "several current sources cannot become one guessed live parent",
        );
        const refused = await closeOwned(app, a);

        assert.equal(
            refused.status,
            409,
            "several accepted current sources are not guessed into exclusive ownership",
        );
        assert.notEqual(
            app.sessionMeta(a)?.archived,
            true,
            "ambiguous Close is atomic and has no lifecycle effects",
        );
        assert.notEqual(app.workItems.itemFor(ownA)!.archived, true);
        assert.equal(app.workItems.itemFor(shared)!.supervisor!.status, "running");
        await app.pip.orchestration.stopped(shared, user);
        const closed = await closeOwned(app, a);

        assert.equal(closed.status, 200, await closed.text());
        assert.equal(app.sessionMeta(a)?.archived, true);
        assert.notEqual(app.sessionMeta(b)?.archived, true);
        assert.equal(app.workItems.itemFor(ownA)!.archived, true);
        assert.equal(
            app.sessionMeta(successor)?.archived,
            true,
            "all native handoff members archive together",
        );
        assert.equal(
            app.sessionMeta(shared)?.archived,
            true,
            "stopped owned children remain in the Close scope",
        );
        assert.equal(app.workItems.members(ownA).length, 2);
        const summary = app.pip.agents
            .list(user)
            .find((agent) => agent.agentId === created.agentId)!;

        assert.ok(
            summary.chats.some((entry) => entry.id === Number(a) && entry.archived),
            "owner catalogue/SSE retains archived saved Chats",
        );
        assert.ok(!summary.chatIds.includes(Number(a)), "native re-entry remains open-only");
        assert.equal(summary.id, Number(b));

        for (const source of [ownB, historical, unrelated, moved]) {
            assert.notEqual(
                app.sessionMeta(source)?.archived,
                true,
                "sibling, historical and unrelated work stay open",
            );
            assert.equal(
                app.sessions(owner(app)).find((row) => row.id === source)?.groupingParentChatId,
                source === ownB ? Number(b) : undefined,
            );
        }

        const guest = app.config.addUser("Catalogue guest", "guest");
        const otherOwner = app.config.addUser("Other owner", "owner");

        for (const person of [guest.user, otherOwner.user]) {
            assert.equal(
                app.sessions(person).find((row) => row.id === ownA)?.groupingParentChatId,
                undefined,
                "private grouping requires matching exact owner, not role alone",
            );
            const detail = app.workItems.context(ownA, person).workItem;

            assert.ok(detail, "the public native Work Item is still visible");
            assert.equal("parentChat" in detail, false);
            assert.equal("groupingParentChatId" in detail, false);
            assert.equal(JSON.stringify(detail).includes(created.agentId), false);
            const response = await request(
                app,
                `c/${ownA}/x/work-items/handoffs`,
                undefined,
                person.id === guest.user.id ? guest.token : otherOwner.token,
            );

            assert.equal(response.status, 200, await response.clone().text());
            const body = await response.json();

            assert.equal(
                "parentChat" in body.workItem,
                false,
                "HTTP detail cannot spread private stored ownership",
            );
            assert.equal(JSON.stringify(body).includes(created.agentId), false);
        }

        assert.equal(
            app.sessions().find((row) => row.id === ownA)?.groupingParentChatId,
            undefined,
            "unscoped reads cannot disclose private origin",
        );
        await app.close();
        app = await openApp(model, data);
        const archived = app.sessions(owner(app));

        for (const member of [ownA, successor]) {
            assert.equal(app.sessionMeta(member)?.archived, true);
            assert.equal(
                archived.find((row) => row.id === member)?.groupingParentChatId,
                Number(a),
            );
            assert.equal(
                archived.find((row) => row.id === member)?.supervisor?.parentChatId,
                undefined,
                "archive display provenance never regrants live control",
            );
            assert.equal(app.isBusy(member), false);
        }

        assert.equal((await request(app, `sessions/${a}`, { archived: false })).status, 200);
        assert.equal(
            app.sessionMeta(ownA)?.archived,
            true,
            "Chat Restore does not implicitly restore children",
        );
        assert.equal(
            (await request(app, `sessions/${successor}`, { archived: false })).status,
            200,
        );

        for (const member of [ownA, successor]) {
            assert.equal(app.sessionMeta(member)?.archived, false);
            assert.equal(
                app.sessions(owner(app)).find((row) => row.id === member)?.groupingParentChatId,
                Number(a),
            );
            assert.equal(app.isBusy(member), false);
        }
    } finally {
        await app.close();
    }
});

test("an input paused after authority admission cannot run after Close and restore", async (t) => {
    let calls = 0;
    const app = await openApp(
        scriptedModel(() => {
            calls++;

            return fauxAssistantMessage("Fresh input only.");
        }),
        join(root, "chat-close-admission-race"),
    );
    const released = Promise.withResolvers<void>();
    const admitted = Promise.withResolvers<void>();

    t.after(async () => {
        released.resolve();
        await app.close();
    });
    app.config.lastModel = { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
    const created = await app.pip.agents.create(owner(app), {
        requestId: "close-race",
        name: "Admission race",
    });
    const chat = created.id as ConversationId;
    const contacts = app.pip.agents.contacts;
    const humanInput = contacts.humanInput.bind(contacts);
    let delay = true;

    contacts.humanInput = async (id, effect) => {
        if (id === chat && delay) {
            delay = false;
            admitted.resolve();
            await released.promise;
        }

        return humanInput(id, effect);
    };

    const old = app.commands.submit(chat, owner(app), {
        text: "Old admitted instruction",
        requestId: "old-admitted-input",
    });

    await admitted.promise;
    assert.equal((await request(app, `sessions/${chat}`, { archived: true })).status, 200);
    assert.equal((await request(app, `sessions/${chat}`, { archived: false })).status, 200);
    released.resolve();
    const receipt = await old;
    const result = await (await app.harness.submission(receipt.submissionId, context))!.wait(
        context,
    );

    assert.equal(result.status, "unanswered");
    assert.equal(calls, 0, "restored metadata cannot bless authority captured before Close");
    await assert.rejects(
        app.commands.submit(chat, owner(app), {
            text: "Old admitted instruction",
            requestId: "old-admitted-input",
        }),
        { status: 409 },
        "retrying the old input identity cannot renew its revoked authority",
    );
    await say(app, chat, "Fresh admitted instruction");
    assert.equal(calls, 1);
});
