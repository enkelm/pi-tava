// Acceptance at the registered agent_work tool and durable transcript boundaries; only the provider is scripted.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { awaitWithContext, withAbortSignal } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
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
    type App,
} from "./helpers.ts";
import { AgentContactsDoc } from "../src/server/pip/agent-contacts-doc.ts";
import { SessionsDoc, SubagentsDoc } from "../src/server/docs.ts";
import { HandoffsDoc } from "../src/server/workflow-docs.ts";

after(cleanUp);

async function observations(app: App, chat: ConversationId, reason: string) {
    const conversation = await app.conversation(chat);
    const page = await conversation.entries({ order: "ascending" }, 100, undefined, context);

    return page.items.filter(
        (entry) =>
            entry.kind === "pi.assistant" &&
            (entry.data as { reason?: string } | undefined)?.reason === reason,
    );
}

const reports = (app: App, chat: ConversationId) => observations(app, chat, "agent-contact-report");
const textOf = (entry: Awaited<ReturnType<typeof reports>>[number]) =>
    entry.model
        ?.flatMap((message) =>
            message.role === "assistant"
                ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
                : [],
        )
        .join("\n") ?? "";

test("concurrent exact follow subscriptions fan out independent Chat outcomes to each origin and survive restart once", async (t) => {
    let target!: ConversationId;
    let privateCalls = 0;
    const model = scriptedModel((request) => {
        const last = lastText(request);
        const system = JSON.stringify(
            request.messages.filter((message) => message.role === "system"),
        );

        if (system.includes("the owner's persistent private agent")) {
            privateCalls++;

            if (last.role === "user") {
                return fauxAssistantMessage(
                    [fauxToolCall("agent_work", { action: "follow", session: Number(target) })],
                    { stopReason: "toolUse" },
                );
            }

            assert.match(last.text, /"status":"accepted"/);

            return fauxAssistantMessage("Following this exact Chat, without activating it.");
        }

        return fauxAssistantMessage(last.text.includes("OLD") ? "OLD_OUTCOME" : "NEW_OUTCOME");
    });
    const directory = join(root, "exact-contact-follow-fanout");
    let app = await openApp(model, directory);

    t.after(() => app.close());
    target = await newSession(app, app.defaultCwd, "chat");
    await say(app, target, "OLD: existing history is not a new event.");
    const identity = await app.pip.agents.create(owner(app), {
        name: "Exact observer",
        requestId: "identity",
    });
    const a = identity.id as ConversationId;
    const b = (await app.pip.agents.newChat(a, owner(app), { requestId: "b" }))
        .id as ConversationId;
    const untouched = (await app.pip.agents.newChat(a, owner(app), { requestId: "untouched" }))
        .id as ConversationId;

    await say(app, a, "Follow for task A.");
    await say(app, b, "Follow independently for task B.");
    const contacts = Object.values(
        (await app.harness.snapshot(AgentContactsDoc, context))?.contacts ?? {},
    );

    assert.equal(
        contacts.filter((contact) => contact.status === "accepted" && contact.action === "follow")
            .length,
        2,
        "both registered tool calls accept an exact ordinary Chat subscription",
    );
    assert.equal((await reports(app, a)).length, 0, "follow never replays old history");
    assert.equal((await reports(app, b)).length, 0);
    const before = privateCalls;

    await say(app, target, "NEW: independent human-directed outcome.");
    await until(
        async () => (await reports(app, a)).length === 1 && (await reports(app, b)).length === 1,
        "each explicit subscription receives the target outcome",
    );
    const first = (await reports(app, a))[0]!;
    const second = (await reports(app, b))[0]!;

    assert.match(textOf(first), /NEW_OUTCOME/);
    assert.match(textOf(second), /NEW_OUTCOME/);
    assert.notEqual(
        (first.data as { originRequestId: string }).originRequestId,
        (second.data as { originRequestId: string }).originRequestId,
        "each origin retains its accepted contact correlation",
    );
    assert.equal((await reports(app, untouched)).length, 0, "no latest-chat/inbox fallback");
    assert.equal(privateCalls, before, "passive observations buy no private-agent generation");
    assert.equal(app.workItems.itemFor(target), undefined, "Chat observation creates no Work Item");
    await app.close();
    app = await openApp(model, directory);
    assert.equal((await reports(app, a)).length, 1, "restart does not duplicate the first origin");
    assert.equal((await reports(app, b)).length, 1, "restart does not duplicate the second origin");
    assert.equal(privateCalls, before);
});

test("exact execution follows stay on their subscribed Worker across a stored Work Item active-thread switch and restart", async (t) => {
    let x!: ConversationId;
    let y!: ConversationId;
    let privateCalls = 0;
    let controllerCalls = 0;
    let executionCalls = 0;
    const model = scriptedModel((request) => {
        const last = lastText(request);
        const system = JSON.stringify(
            request.messages.filter((message) => message.role === "system"),
        );

        if (system.includes("the owner's persistent private agent")) {
            privateCalls++;

            if (last.role === "user") {
                return fauxAssistantMessage(
                    [
                        fauxToolCall("agent_work", {
                            action: "follow",
                            session: Number(last.text.includes("FOLLOW_X") ? x : y),
                        }),
                    ],
                    { stopReason: "toolUse" },
                );
            }

            assert.match(last.text, /"status":"accepted"/);

            return fauxAssistantMessage("Subscribed only to the selected execution thread.");
        }

        if (system.includes("the private supervisor for Work Item")) {
            controllerCalls++;

            return fauxAssistantMessage("UNEXPECTED_CONTROLLER_WAKE");
        }

        executionCalls++;

        return fauxAssistantMessage(
            last.text.includes("EVENT_X")
                ? "EXACT_EXECUTION_X_OUTCOME"
                : "EXACT_EXECUTION_Y_OUTCOME",
        );
    });
    const directory = join(root, "exact-contact-execution-topology");
    const workItemId = "fixture-exact-execution-follow";
    let app = await openApp(model, directory);

    t.after(() => app.close());
    x = await newSession(app, app.defaultCwd, "worker");
    y = await newSession(app, app.defaultCwd, "worker");
    await app.commands.updateSession(x, owner(app), { title: "Exact execution X" });
    await app.commands.updateSession(y, owner(app), { title: "Exact execution Y" });
    await app.harness.commit(async (tx) => {
        // Topology-only persisted fixture: both Workers are real native conversations. This
        // models historical Work Item membership, NOT native handoff admission, Git work,
        // successor creation, or a transfer receipt. Subsequent events use Commands.submit.
        const sessions = await tx.doc(SessionsDoc);

        sessions.items[String(x)]!.workItemId = workItemId;
        sessions.items[String(y)]!.workItemId = workItemId;
        (await tx.doc(HandoffsDoc)).workItems[workItemId] = {
            id: workItemId,
            originThreadId: Number(x),
            activeThreadId: Number(x),
            threadIds: [Number(x), Number(y)],
            title: "Exact execution topology fixture",
            createdAt: Date.now(),
        };
    }, context);
    const a = (
        await app.pip.agents.create(owner(app), {
            name: "Execution observer",
            requestId: "identity",
        })
    ).id as ConversationId;
    const b = (await app.pip.agents.newChat(a, owner(app), { requestId: "b" }))
        .id as ConversationId;

    await say(app, a, "FOLLOW_X for the original execution task.");
    await app.harness.commit(async (tx) => {
        // The fixture switches the native current-thread pointer only; it does not claim that
        // the handoff engine admitted a transfer. The accepted exact X subscription stays put.
        (await tx.doc(HandoffsDoc)).workItems[workItemId]!.activeThreadId = Number(y);
    }, context);
    await say(app, b, "FOLLOW_Y for the later execution task.");
    const contacts = Object.values(
        (await app.harness.snapshot(AgentContactsDoc, context))!.contacts,
    ).filter((contact) => contact.action === "follow");

    assert.deepEqual(
        contacts
            .map(({ status, target, chatId }) => ({ status, target, chatId }))
            .sort((left, right) => left.target - right.target),
        [
            { status: "accepted", target: Number(x), chatId: Number(a) },
            { status: "accepted", target: Number(y), chatId: Number(b) },
        ],
    );
    assert.equal(app.workItems.itemFor(x)?.id, app.workItems.itemFor(y)?.id);
    assert.equal(app.workItems.itemFor(x)?.activeThreadId, Number(y));
    assert.equal(app.workItems.isReadOnly(x), true, "X is no longer the active native writer");
    const paidBeforeEvents = privateCalls;

    // Both native outcomes finish after B selected Y, while passive reporting is suspended.
    // Startup must recover both exact subscriptions, not the item's current execution/chat.
    await app.pip.agents.contacts.reports.close();
    await say(app, x, "EVENT_X: describe this exact old thread's outcome; do not write.");
    await say(app, y, "EVENT_Y: describe this exact current thread's outcome; do not write.");
    await app.close();
    app = await openApp(model, directory);
    await until(
        async () => (await reports(app, a)).length === 1 && (await reports(app, b)).length === 1,
        "startup correlates both buffered exact execution outcomes",
    );
    await app.pip.agents.contacts.reports.reconcile();
    await app.pip.agents.contacts.reports.reconcile();
    assert.equal((await reports(app, a)).length, 1, "reconcile is restart-safe for exact X");
    assert.equal((await reports(app, b)).length, 1, "reconcile is restart-safe for exact Y");

    await say(app, x, "EVENT_X: a further read-only observation after restart.");
    await say(app, y, "EVENT_Y: a further current-thread observation after restart.");
    await until(
        async () => (await reports(app, a)).length === 2 && (await reports(app, b)).length === 2,
        "recovered subscriptions keep observing their original exact execution threads",
    );

    for (const [origin, target, own, other] of [
        [a, x, "EXACT_EXECUTION_X_OUTCOME", "EXACT_EXECUTION_Y_OUTCOME"],
        [b, y, "EXACT_EXECUTION_Y_OUTCOME", "EXACT_EXECUTION_X_OUTCOME"],
    ] as const) {
        const received = await reports(app, origin);
        const subscription = contacts.find((contact) => contact.chatId === Number(origin))!;

        for (const entry of received) {
            assert.match(textOf(entry), new RegExp(own));
            assert.doesNotMatch(textOf(entry), new RegExp(`${other}|UNEXPECTED_CONTROLLER_WAKE`));
            assert.equal((entry.data as { target: number }).target, Number(target));
            assert.equal(
                (entry.data as { originRequestId: string }).originRequestId,
                subscription.requestId,
                "each execution subscription keeps its accepted origin/correlation",
            );
        }
    }

    assert.equal(app.workItems.itemFor(x)?.activeThreadId, Number(y));
    assert.equal(executionCalls, 4, "only the four explicit native execution inputs run");
    assert.equal(privateCalls, paidBeforeEvents, "execution observations never wake either origin");
    assert.equal(controllerCalls, 0, "exact execution follows never become controller activation");
});

test(
    "mixed controller delegation and exact Worker send keep replies at their accepted origins",
    { timeout: 30_000 },
    async (t) => {
        for (const report of [true, false]) {
            await t.test(`exact send report=${report}`, async (t) => {
                let worker!: ConversationId;
                let workerCalls = 0;
                const app = await openApp(
                    scriptedModel((request) => {
                        const last = lastText(request);
                        const system = JSON.stringify(
                            request.messages.filter((message) => message.role === "system"),
                        );

                        if (system.includes("the owner's persistent private agent")) {
                            if (last.role === "user") {
                                const exact = last.text.includes("EXACT_TASK_B");

                                return fauxAssistantMessage(
                                    [
                                        fauxToolCall("agent_work", {
                                            action: exact ? "send" : "delegate",
                                            session: Number(worker),
                                            text: exact
                                                ? "EXACT_TASK_B"
                                                : "CONTROLLER_TASK_A: inspect only; do not start execution.",
                                            ...(exact ? { report } : {}),
                                        }),
                                    ],
                                    { stopReason: "toolUse" },
                                );
                            }

                            return fauxAssistantMessage("Native contact accepted.");
                        }

                        if (system.includes("the private supervisor for Work Item")) {
                            return fauxAssistantMessage("CONTROLLER_ANSWER_A_ONLY");
                        }

                        workerCalls++;

                        return fauxAssistantMessage("EXACT_WORKER_ANSWER_B_ONLY");
                    }),
                    join(root, `mixed-controller-exact-origins-${report}`),
                );

                t.after(() => app.close());
                worker = await newSession(app, app.defaultCwd, "worker");
                const a = (
                    await app.pip.agents.create(owner(app), {
                        name: "Mixed adapter origins",
                        requestId: "mixed-origins",
                    })
                ).id as ConversationId;
                const b = (
                    await app.pip.agents.newChat(a, owner(app), { requestId: "exact-origin-b" })
                ).id as ConversationId;

                await say(
                    app,
                    a,
                    "CONTROLLER_TASK_A: inspect through this Work Item's controller only.",
                );
                const controller = app.workItems.itemFor(worker)!.supervisor!
                    .conversationId as ConversationId;

                await until(
                    () => !app.isBusy(controller),
                    "A's real native controller response settles",
                );
                await until(
                    async () =>
                        (await observations(app, a, "agent-work-report")).some((entry) =>
                            textOf(entry).includes("CONTROLLER_ANSWER_A_ONLY"),
                        ),
                    "A receives its controller's own answer",
                );
                assert.equal(workerCalls, 0, "A's request did not dispatch execution");
                // Hold only passive reconciliation, leaving real exact contact/native submission and
                // both tool and provider lifecycles intact. Reopening performs an awaited reconciliation.
                await app.pip.agents.supervision.close();
                await say(app, b, "EXACT_TASK_B: ask the exact Worker, not its controller.");
                await until(
                    () => workerCalls === 1 && !app.isBusy(worker),
                    "B's exact native Worker response settles",
                );
                const accepted = (await app.transcripts.allEntries(b, true)).find(
                    (entry) => entry.kind === "toolResult" && entry.name === "agent_work",
                );

                assert.ok(accepted?.kind === "toolResult");
                assert.equal(accepted.isError, false, accepted.text);
                assert.equal(JSON.parse(accepted.text).status, "accepted", accepted.text);
                await app.pip.agents.contacts.reports.reconcile();
                const bReports = await reports(app, b);

                assert.equal(
                    bReports.length,
                    report ? 1 : 0,
                    "B's own report preference is respected by the exact adapter",
                );

                if (report) {
                    assert.match(textOf(bReports[0]!), /EXACT_WORKER_ANSWER_B_ONLY/);
                }

                await app.pip.agents.supervision.open();
                const aReports = await observations(app, a, "agent-work-report");

                assert.doesNotMatch(
                    aReports.map(textOf).join("\n"),
                    /EXACT_WORKER_ANSWER_B_ONLY/,
                    "B's exact reply is not an independent controller event and must not reach A",
                );
                assert.equal(workerCalls, 1, "reporting never repeats B's execution");
            });
        }
    },
);

test("send answers retain only their accepted origin while independent outcomes require explicit follow", async (t) => {
    let target!: ConversationId;
    let privateCalls = 0;
    const model = scriptedModel((request) => {
        const last = lastText(request);
        const system = JSON.stringify(
            request.messages.filter((message) => message.role === "system"),
        );

        if (system.includes("the owner's persistent private agent")) {
            privateCalls++;

            if (last.role === "user") {
                const follow = last.text.includes("FOLLOW");

                return fauxAssistantMessage(
                    [
                        fauxToolCall("agent_work", {
                            action: follow ? "follow" : "send",
                            session: Number(target),
                            ...(follow
                                ? {}
                                : {
                                      text: last.text.includes("SILENT")
                                          ? "TASK_SILENT"
                                          : last.text.includes("TASK_A")
                                            ? "TASK_A"
                                            : "TASK_B",
                                      report: !last.text.includes("SILENT"),
                                  }),
                        }),
                    ],
                    { stopReason: "toolUse" },
                );
            }

            assert.match(last.text, /"status":"accepted"/);

            return fauxAssistantMessage("Exact contact accepted.");
        }

        return fauxAssistantMessage(
            last.text.includes("TASK_A")
                ? "ANSWER_A_ONLY"
                : last.text.includes("TASK_B")
                  ? "ANSWER_B_ONLY"
                  : last.text.includes("TASK_SILENT")
                    ? "SILENT_ANSWER"
                    : "INDEPENDENT_OUTCOME",
        );
    });
    const directory = join(root, "exact-contact-send-origins");
    let app = await openApp(model, directory);

    t.after(() => app.close());
    target = await newSession(app, app.defaultCwd, "chat");
    const a = (
        await app.pip.agents.create(owner(app), { name: "Exact sender", requestId: "identity" })
    ).id as ConversationId;
    const b = (await app.pip.agents.newChat(a, owner(app), { requestId: "b" }))
        .id as ConversationId;
    const follower = (await app.pip.agents.newChat(a, owner(app), { requestId: "follower" }))
        .id as ConversationId;

    await say(app, follower, "FOLLOW only independent target events.");
    await say(app, a, "TASK_A: request an exact scoped answer.");
    await say(app, b, "TASK_B: request a different exact answer.");
    const sent = Object.values(
        (await app.harness.snapshot(AgentContactsDoc, context))?.contacts ?? {},
    ).filter((contact) => contact.action === "send");

    assert.deepEqual(
        sent.map(({ status, reason }) => ({ status, reason })),
        [
            { status: "accepted", reason: undefined },
            { status: "accepted", reason: undefined },
        ],
        "both registered sends must reach native acceptance before reply correlation is exercised",
    );
    await until(
        async () => (await reports(app, a)).length === 1 && (await reports(app, b)).length === 1,
        "each submitted answer returns to its exact source",
    );
    assert.match(textOf((await reports(app, a))[0]!), /ANSWER_A_ONLY/);
    assert.doesNotMatch(textOf((await reports(app, a))[0]!), /ANSWER_B_ONLY/);
    assert.match(textOf((await reports(app, b))[0]!), /ANSWER_B_ONLY/);
    assert.doesNotMatch(textOf((await reports(app, b))[0]!), /ANSWER_A_ONLY/);
    assert.equal(
        (await reports(app, follower)).length,
        0,
        "send replies are not independent events",
    );
    const acceptedCalls = privateCalls;

    await app.close();
    app = await openApp(model, directory);
    assert.equal(
        (await reports(app, a)).length,
        1,
        "completed send reports deduplicate on restart",
    );
    assert.equal((await reports(app, b)).length, 1);
    assert.equal((await reports(app, follower)).length, 0);
    assert.equal(privateCalls, acceptedCalls);
    await say(app, a, "SILENT: send without reporting the answer.");
    await until(() => !app.isBusy(target), "the unreported native send settles");
    const before = privateCalls;

    await say(app, target, "An independent human-directed target turn.");
    await until(
        async () => (await reports(app, follower)).length === 1,
        "independent events reach the explicit follower",
    );
    assert.match(textOf((await reports(app, follower))[0]!), /INDEPENDENT_OUTCOME/);
    assert.equal((await reports(app, a)).length, 1, "send does not silently subscribe its origin");
    assert.equal((await reports(app, b)).length, 1);
    assert.equal(
        privateCalls,
        before,
        "neither send replies nor follow events pay to wake origins",
    );
});

test("unavailable exact origins hold durably at the target, never reroute, and revalidate authority on restoration", async (t) => {
    for (const fixture of [
        "archived",
        "missing",
        "rotated-token",
        "revoked-epoch",
        "unbound",
    ] as const) {
        await t.test(fixture, async (t) => {
            let target!: ConversationId;
            let targetCalls = 0;
            let privateCalls = 0;
            let release!: () => void;
            const held = new Promise<void>((resolve) => {
                release = resolve;
            });
            const model = scriptedModel(async (request, options) => {
                const last = lastText(request);
                const system = JSON.stringify(
                    request.messages.filter((message) => message.role === "system"),
                );

                if (system.includes("the owner's persistent private agent")) {
                    privateCalls++;

                    if (last.role === "user") {
                        return fauxAssistantMessage(
                            [
                                fauxToolCall("agent_work", {
                                    action: "follow",
                                    session: Number(target),
                                }),
                            ],
                            { stopReason: "toolUse" },
                        );
                    }

                    assert.match(last.text, /"status":"accepted"/);

                    return fauxAssistantMessage("Exact native input accepted.");
                }

                targetCalls++;
                await awaitWithContext(
                    held,
                    options?.signal ? withAbortSignal(options.signal, context) : context,
                );

                return fauxAssistantMessage("HELD_EXACT_RESPONSE");
            });
            const directory = join(root, `exact-contact-origin-${fixture}`);
            let app = await openApp(model, directory);

            t.after(async () => {
                release();
                await app.close();
            });
            target = await newSession(app, app.defaultCwd, "chat");
            const identity = await app.pip.agents.create(owner(app), {
                name: "Held exact sender",
                requestId: "identity",
            });
            const other = identity.id as ConversationId;
            const origin = (
                await app.pip.agents.newChat(other, owner(app), { requestId: "origin" })
            ).id as ConversationId;

            await say(app, origin, "Follow this exact target for one scoped outcome.");
            await app.commands.submit(target, owner(app), {
                text: "Independent native work for the observed exact outcome.",
                requestId: "native-work",
            });
            await until(
                () => targetCalls === 1,
                "the accepted exact native input reaches its provider",
            );
            await app.harness.commit(async (tx) => {
                // Public durable-storage fixtures represent older/no-origin contacts and archived
                // chats. They do not synthesize native acceptance, reports, or task authority.
                if (fixture === "missing") {
                    for (const contact of Object.values(
                        (await tx.doc(AgentContactsDoc)).contacts,
                    )) {
                        Reflect.deleteProperty(contact, "chatId");
                    }
                } else {
                    (await tx.doc(SessionsDoc)).items[String(origin)]!.archived = true;
                }
            }, context);
            release();
            await until(
                async () =>
                    Object.values(
                        (await app.harness.snapshot(AgentContactsDoc, context))?.reports ?? {},
                    ).some((report) => report.status === "held"),
                "the response is held instead of rerouted",
            );
            await until(
                async () =>
                    (await observations(app, target, "agent-contact-report-held")).length === 1,
                "the exact target has one durable owner-visible held notice",
            );
            assert.equal((await reports(app, other)).length, 0);
            assert.equal((await reports(app, origin)).length, 0);
            const before = privateCalls;

            await app.close();
            app = await openApp(model, directory);
            assert.equal(
                (await reports(app, other)).length,
                0,
                "restart never chooses another chat",
            );
            assert.equal((await observations(app, target, "agent-contact-report-held")).length, 1);
            assert.equal(targetCalls, 1, "restart does not repeat accepted target work");
            assert.equal(privateCalls, before, "a held observation buys no originating-agent wake");

            if (fixture === "rotated-token") {
                app.config.rotateOwnerToken();
            } else if (fixture === "revoked-epoch") {
                await app.pip.agents.supervision.stop(identity.agentId, owner(app));
            }

            if (fixture !== "missing") {
                await app.harness.commit(async (tx) => {
                    const originMeta = (await tx.doc(SessionsDoc)).items[String(origin)]!;

                    originMeta.archived = false;

                    if (fixture === "unbound") {
                        delete originMeta.pipAgentId;
                    }
                }, context);
            }

            if (fixture === "archived") {
                await until(
                    async () => (await reports(app, origin)).length === 1,
                    "restoring the exact valid origin delivers the pending report once",
                );
                assert.match(textOf((await reports(app, origin))[0]!), /HELD_EXACT_RESPONSE/);
            } else {
                await app.close();
                app = await openApp(model, directory);
                const pending = Object.values(
                    (await app.harness.snapshot(AgentContactsDoc, context))?.reports ?? {},
                );

                assert.equal(pending.length, 1);
                assert.equal(pending[0]!.status, "held");
                assert.equal(
                    (await reports(app, origin)).length,
                    0,
                    "missing/revoked origins stay held",
                );
            }

            assert.equal((await reports(app, other)).length, 0);
            assert.equal((await observations(app, target, "agent-contact-report-held")).length, 1);
            assert.equal(privateCalls, before);
            assert.equal(targetCalls, 1);
        });
    }
});

test("following a literal helper reads bounded exact history, ignores app-authored notices, and reports its native failure", async (t) => {
    let child!: ConversationId;
    let helperCalls = 0;
    let privateCalls = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    const model = scriptedModel(async (request, options) => {
        const last = lastText(request);
        const system = JSON.stringify(
            request.messages.filter((message) => message.role === "system"),
        );

        if (last.role === "user" && last.text.includes("EXACT_CHILD_BODY")) {
            helperCalls++;
            await awaitWithContext(
                held,
                options?.signal ? withAbortSignal(options.signal, context) : context,
            );

            return fauxAssistantMessage("", {
                stopReason: "error",
                errorMessage: "EXACT_HELPER_FAILED: provider refused this scoped response",
            });
        }

        if (system.includes("the owner's persistent private agent")) {
            privateCalls++;

            if (last.role === "user") {
                return fauxAssistantMessage(
                    [fauxToolCall("agent_work", { action: "follow", session: Number(child) })],
                    { stopReason: "toolUse" },
                );
            }

            assert.match(last.text, /"status":"accepted"/);

            return fauxAssistantMessage("Following the literal helper, not its root.");
        }

        if (last.role === "user" && last.text.includes("START_HELPER")) {
            return fauxAssistantMessage(
                [
                    fauxToolCall("subagent", {
                        action: "spawn",
                        name: "literal-target",
                        message: "EXACT_CHILD_BODY: inspect only this bounded request.",
                    }),
                ],
                { stopReason: "toolUse" },
            );
        }

        return fauxAssistantMessage("PARENT_ONLY_OUTCOME");
    });
    const app = await openApp(model, join(root, "exact-contact-helper-pages"));

    t.after(async () => {
        release();
        await app.close();
    });
    const parent = await newSession(app, app.defaultCwd, "chat");

    await say(app, parent, "START_HELPER for this bounded inspection.");
    await until(() => helperCalls === 1, "the real helper reaches its native provider");
    child = (await app.harness.snapshot(SubagentsDoc, parent, context))!.agents["literal-target"]!
        .conversationId;
    const observer = (
        await app.pip.agents.create(owner(app), { name: "Helper observer", requestId: "identity" })
    ).id as ConversationId;

    await say(app, observer, "Follow that exact literal helper's outcome.");
    const contacts = Object.values(
        (await app.harness.snapshot(AgentContactsDoc, context))?.contacts ?? {},
    );

    assert.equal(contacts.length, 1);
    assert.equal(contacts[0]!.status, "accepted");
    assert.equal(contacts[0]!.target, Number(child));
    await app.harness.commit(async (tx) => {
        // Stored app-authored observations are passive history, not assistant outcomes. More
        // than one public transcript page proves the later native failure cannot be starved.
        for (let index = 0; index < 105; index++) {
            await tx.appendEntry(child, {
                kind: "pi.assistant",
                data: { appAuthored: true },
                model: [
                    {
                        ...fauxAssistantMessage("APP_NOTICE_ONLY"),
                        api: "pi-coop",
                        provider: "pi-coop",
                        model: "app-authored",
                    },
                ],
            });
        }
    }, context);
    const before = privateCalls;

    release();
    await until(
        async () => (await reports(app, observer)).length === 1 && !app.isBusy(child),
        "one exact native helper failure reaches its subscribed origin",
    );
    const report = (await reports(app, observer))[0]!;

    assert.match(textOf(report), /EXACT_HELPER_FAILED/);
    assert.doesNotMatch(textOf(report), /APP_NOTICE_ONLY|PARENT_ONLY_OUTCOME/);
    assert.equal((report.data as { target: number }).target, Number(child));
    assert.equal(privateCalls, before, "helper observations do not activate their private origin");
    assert.equal(helperCalls, 1, "non-retryable native failure is not retried by reporting");
});

test("a contacted parent's real helper returns passively only through its registered reporter and captured source pin", async (t) => {
    for (const fixture of [
        "valid",
        "wrong-target",
        "wrong-reporter",
        "missing-source-pin",
        "missing-origin",
    ] as const) {
        await t.test(fixture, async (t) => {
            let parent!: ConversationId;
            let parentCalls = 0;
            let helperCalls = 0;
            let privateCalls = 0;
            let release!: () => void;
            const held = new Promise<void>((resolve) => {
                release = resolve;
            });
            const model = scriptedModel(async (request, options) => {
                const last = lastText(request);
                const system = JSON.stringify(
                    request.messages.filter((message) => message.role === "system"),
                );

                if (last.role === "user" && last.text.includes("CONTACTED_PARENT_CHILD")) {
                    helperCalls++;
                    await awaitWithContext(
                        held,
                        options?.signal ? withAbortSignal(options.signal, context) : context,
                    );

                    return fauxAssistantMessage(
                        `PINNED_HELPER_OUTCOME${fixture === "valid" ? `\n${"Native evidence. ".repeat(500)}` : ""}`,
                    );
                }

                if (system.includes("the owner's persistent private agent")) {
                    privateCalls++;

                    if (last.role === "user") {
                        return fauxAssistantMessage(
                            [
                                fauxToolCall("agent_work", {
                                    action: "send",
                                    session: Number(parent),
                                    text: "START_CONTACTED_HELPER within this bounded task.",
                                }),
                            ],
                            { stopReason: "toolUse" },
                        );
                    }

                    assert.match(last.text, /"status":"accepted"/);

                    return fauxAssistantMessage("Accepted this exact native parent contact.");
                }

                parentCalls++;

                if (last.role === "user" && last.text.includes("START_CONTACTED_HELPER")) {
                    return fauxAssistantMessage(
                        [
                            fauxToolCall("subagent", {
                                action: "spawn",
                                name: "pinned-return",
                                message: "CONTACTED_PARENT_CHILD: inspect this task only.",
                            }),
                        ],
                        { stopReason: "toolUse" },
                    );
                }

                return fauxAssistantMessage("PINNED_PARENT_ANSWER");
            });
            const directory = join(root, `exact-contact-helper-return-${fixture}`);
            let app = await openApp(model, directory);

            t.after(async () => {
                release();
                await app.close();
            });
            parent = await newSession(app, app.defaultCwd, "chat");
            const first = (
                await app.pip.agents.create(owner(app), {
                    name: "Pinned helper origin",
                    requestId: "identity",
                })
            ).id as ConversationId;
            const origin = (
                await app.pip.agents.newChat(first, owner(app), { requestId: "origin" })
            ).id as ConversationId;

            // Suspend only passive delivery at its real lifecycle seam. Native tool admission,
            // helper ownership, reporter creation, and the return outbox remain production-owned.
            await app.pip.agents.contacts.reports.close();
            await say(app, origin, "Ask that exact native parent to use one bounded helper.");
            await until(
                () => helperCalls === 1 && !app.isBusy(parent),
                "the real derived helper runs while its contacted parent settles",
            );
            const contacts = (await app.harness.snapshot(AgentContactsDoc, context))!.contacts;
            const [contactKey, contact] = Object.entries(contacts)[0]!;
            const helpers = (await app.harness.snapshot(SubagentsDoc, parent, context))!;
            const helper = helpers.agents["pinned-return"]!.conversationId;
            const [creatorId, reporterId] = Object.entries(helpers.reporters)[0]!;

            assert.equal(contact.status, "accepted");
            assert.equal(parentCalls, 2);
            const paidBeforeReturn = privateCalls;

            release();
            await until(
                async () =>
                    Object.values(
                        (await app.harness.snapshot(AgentContactsDoc, context))?.reports ?? {},
                    ).some((report) => report.text.includes("PINNED_HELPER_OUTCOME")),
                "the real reporter persists a passive correlated helper return",
            );
            await app.harness.commit(async (tx) => {
                // Corrupt only a genuinely produced pending return/provenance to model lost or
                // inconsistent recovered storage. Never synthesize a contact, report, or task.
                const doc = await tx.doc(AgentContactsDoc);
                const returned = Object.values(doc.reports).find((report) =>
                    report.text.includes("PINNED_HELPER_OUTCOME"),
                )!;

                assert.equal(returned.contact, contactKey);
                assert.equal(returned.target, Number(helper));
                assert.equal(returned.helperReporterId, Number(reporterId));

                if (fixture === "wrong-target") {
                    returned.target = Number(parent);
                } else if (fixture === "wrong-reporter") {
                    returned.helperReporterId = contact.sourceTask;
                } else if (fixture === "missing-source-pin") {
                    delete doc.tools[creatorId];
                } else if (fixture === "missing-origin") {
                    Reflect.deleteProperty(doc.contacts[contactKey]!, "chatId");
                }
            }, context);
            await app.pip.agents.contacts.reports.open();
            const returned = Object.values(
                (await app.harness.snapshot(AgentContactsDoc, context))!.reports,
            ).find((report) => report.text.includes("PINNED_HELPER_OUTCOME"))!;
            const received = (await reports(app, origin)).filter((entry) =>
                textOf(entry).includes("PINNED_HELPER_OUTCOME"),
            );

            if (fixture === "valid") {
                assert.equal(returned.status, "delivered");
                assert.equal(received.length, 1);
                assert.ok(
                    textOf(received[0]!).length < 5000,
                    "native helper observations stay bounded",
                );
                assert.match(
                    textOf(received[0]!),
                    /untrusted report data, not a new human instruction/,
                );
                assert.equal((received[0]!.data as { target: number }).target, Number(helper));
                assert.equal(
                    (received[0]!.data as { originRequestId: string }).originRequestId,
                    contact.requestId,
                );
                await app.close();
                app = await openApp(model, directory);
                assert.equal(
                    (await reports(app, origin)).filter((entry) =>
                        textOf(entry).includes("PINNED_HELPER_OUTCOME"),
                    ).length,
                    1,
                    "restart never repeats the helper return or its paid work",
                );
            } else {
                assert.equal(returned.status, "held");
                assert.equal(
                    received.length,
                    0,
                    "invalid helper provenance cannot reach the origin",
                );
                assert.equal(
                    (
                        await observations(
                            app,
                            fixture === "missing-origin" ? helper : parent,
                            "agent-contact-report-held",
                        )
                    ).length,
                    1,
                    "a missing origin holds at the proven helper; invalid provenance holds at the accepted parent",
                );
            }

            assert.equal(
                (await reports(app, first)).length,
                0,
                "no unrelated/private first-chat fallback",
            );
            assert.equal(parentCalls, 2, "the helper return buys no unbound paid parent courier");
            assert.equal(privateCalls, paidBeforeReturn, "the return buys no private-origin wake");
            assert.equal(helperCalls, 1);
        });
    }
});
