// Native session archive is the Close/restore boundary. Only model decisions and delayed native
// admission are scripted; HTTP, stored history, parent assignments and runtime cancellation are real.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { awaitWithContext, withAbortSignal } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { SessionsDoc } from "../src/server/docs.ts";
import { AgentIdentitiesDoc } from "../src/server/agent-identity-docs.ts";
import { privateAgentRequest as request } from "./private-agent-http.ts";
import {
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

after(cleanUp);

const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
    fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

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

test("Close revokes registered parent continuation but independent child work finishes and restore never wakes the old task", async (t) => {
    const child = Promise.withResolvers<void>();
    let childStarted = false;
    let parentCalls = 0;
    let phase = "send";
    let controller!: ConversationId;
    const app = await openApp(
        scriptedModel(async (input, options) => {
            const system = JSON.stringify(
                input.messages.filter((message) => message.role === "system"),
            );
            const last = lastText(input);

            if (system.includes("the owner's persistent private agent")) {
                parentCalls++;

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
    const source = await newSession(app, app.defaultCwd, "researcher");

    controller = (await app.pip.orchestration.control(source, owner(app), { action: "open" }))
        .orchestration!.conversationId as ConversationId;
    const created = await app.pip.agents.create(owner(app), {
        name: "Parent Chat",
        requestId: "close-parent",
    });
    const chat = created.id as ConversationId;
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
    const grant = { ...app.workItems.itemFor(source)!.supervisor! };
    const closed = await request(app, `sessions/${chat}`, { archived: true });

    assert.equal(closed.status, 200, await closed.text());
    assert.equal(app.isBusy(source), true, "independent Work Item execution continues");
    assert.deepEqual(app.workItems.itemFor(source)!.supervisor, grant);
    assert.equal(
        (await app.pip.agents.supervision.parentContext(chat, owner(app)))[0]?.status,
        "revoked",
    );
    assert.equal((await request(app, `sessions/${chat}`, { archived: false })).status, 200);
    assert.equal(app.isBusy(chat), false, "restore remains idle while independent work continues");
    child.resolve();
    const completed = await (await app.harness.submission(execution.submissionId, context))!.wait(
        context,
    );

    assert.equal(completed.status, "done");
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
