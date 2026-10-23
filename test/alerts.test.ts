// The alert owner boundary: real native turns/tools/grants, only delivery transport is replaced.
// Regressions are idle-as-final, nested asks escaping to a human, and lost owner-only/presence filters.
import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { PipWorkDoc } from "../src/server/docs.ts";
import type { PushMessage } from "../src/server/push.ts";
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
    scriptedModel,
    until,
} from "./helpers.ts";

after(cleanUp);
const settle = () => new Promise((resolve) => setTimeout(resolve, 3250));

function capture(app: Awaited<ReturnType<typeof openApp>>) {
    // These tests must never discover personal Herdr endpoints, even after adding a subscription.
    app.privateSessions.local.sockets = async () => [];
    const store = app.pushStore!;
    const key = createECDH("prime256v1");

    key.generateKeys();
    store.subscribe(owner(app).id, {
        endpoint: "https://fcm.googleapis.com/test-notifications",
        keys: {
            p256dh: key.getPublicKey().toString("base64url"),
            auth: randomBytes(16).toString("base64url"),
        },
    });
    const sent: { user: string; message: PushMessage }[] = [];

    store.notify = async (user, message) => {
        sent.push({ user, message });

        return 1;
    };

    return sent;
}

test("a native controller wait and execution yield stay quiet; only explicit outer finish notifies once", async (t) => {
    let action: "wait" | "finish" = "wait";
    const model = scriptedModel((request) =>
        JSON.stringify(request.messages.filter((message) => message.role === "system")).includes(
            "the private supervisor for Work Item",
        )
            ? fauxAssistantMessage(
                  [
                      fauxToolCall("work_supervise", {
                          action,
                          text:
                              action === "wait"
                                  ? "Waiting for execution."
                                  : "The requested orchestration ended; evidence remains in the work.",
                      }),
                  ],
                  { stopReason: "toolUse" },
              )
            : fauxAssistantMessage("Execution checkpoint, not an orchestration final."),
    );
    const directory = join(root, "controller-notifications");
    const app = await openApp(model, directory);

    t.after(() => app.close());
    const sent = capture(app);
    const source = await newSession(app, app.defaultCwd, "worker");
    const started = await activateWorkPip(app, source);
    const controller = started.orchestration!.conversationId as ConversationId;

    await until(() => !app.isBusy(controller), "controller wait to settle");
    await say(app, source, "Execution checkpoint");
    // Direct human execution input reclaims the controller; reactivate through its real composer.
    await say(app, controller, "Continue observing; wait.");
    await settle();
    assert.equal(sent.length, 0, "idle execution and native wait are not human-facing completion");
    action = "finish";
    await say(app, controller, "Conclude the orchestration with the existing evidence.");
    await until(() => sent.length === 1, "explicit final push");
    assert.equal(sent[0]!.message.title, "Orchestration finished");
    assert.equal(sent[0]!.message.url, `/s/${controller}`);
    // A duplicate native delivery must not repeat a final.
    const work = (await app.harness.snapshot(PipWorkDoc, controller, context))!;
    const finish = Object.entries(work.actions).find(([, value]) => value.finish !== undefined)!;

    await app.alerts.orchestrationEvent(controller, finish[0], "final", finish[1].finish!);
    await settle();
    assert.equal(sent.length, 1, "the tool final must not also become a run-done push");
    // Disable the synthetic subscription before reopening so no personal endpoints can be discovered.
    app.pushStore!.unsubscribe("https://fcm.googleapis.com/test-notifications", owner(app).id);
    await app.close();
    const reopened = await openApp(model, directory);

    t.after(() => reopened.close());
    const afterRestart = capture(reopened);

    await reopened.alerts.orchestrationEvent(controller, finish[0], "final", finish[1].finish!);
    reopened.alerts.runChanged(controller, false);
    await settle();
    assert.equal(
        afterRestart.length,
        0,
        "persisted native events and saved history are not replayed on startup",
    );
});

test("nested native questions stay with their accepted named origin; only explicit owner escalation pushes that chat", async (t) => {
    let source!: ConversationId;
    let controller!: ConversationId;
    let escalation = false;
    let finishing = false;
    let answer: { action: "answer"; session: number; questionId: string; text: string } | undefined;
    const app = await openApp(
        scriptedModel((request) => {
            const system = JSON.stringify(
                request.messages.filter((message) => message.role === "system"),
            );

            if (system.includes("the owner's persistent private agent")) {
                if (lastText(request).role !== "user") {
                    return fauxAssistantMessage("Delegated; an internal yield is not a final.");
                }

                return fauxAssistantMessage(
                    [
                        fauxToolCall(
                            answer
                                ? "agent_work"
                                : escalation || finishing
                                  ? "work_supervise"
                                  : "agent_work",
                            answer ??
                                (finishing
                                    ? {
                                          action: "finish",
                                          text: "The outer orchestration has now ended.",
                                      }
                                    : escalation
                                      ? {
                                            action: "ask",
                                            text: "The decision exceeds the prior scope; please clarify here.",
                                        }
                                      : {
                                            action: "send",
                                            session: Number(controller),
                                            text: "Inspect the existing scope and clarify before proceeding.",
                                        }),
                        ),
                    ],
                    { stopReason: "toolUse" },
                );
            }

            if (system.includes("the private supervisor for Work Item")) {
                return fauxAssistantMessage(
                    [
                        fauxToolCall(
                            "work_supervise",
                            answer
                                ? { action: "finish", text: "The child scope is settled." }
                                : { action: "ask", text: "Which existing scope applies?" },
                        ),
                    ],
                    { stopReason: "toolUse" },
                );
            }

            return fauxAssistantMessage("Existing evidence.");
        }),
        join(root, "nested-notifications"),
    );

    t.after(() => app.close());
    const sent = capture(app);

    source = await newSession(app, app.defaultCwd, "worker");
    const opened = await app.pip.orchestration.control(source, owner(app), { action: "open" });

    controller = opened.orchestration!.conversationId as ConversationId;
    const chat = (
        await app.pip.agents.create(owner(app), {
            name: "Coordinator",
            requestId: "notification-agent",
        })
    ).id as ConversationId;

    await say(app, chat, "Coordinate this existing investigation.");
    await until(
        async () =>
            (await app.harness.snapshot(PipWorkDoc, controller, context))?.question !== undefined &&
            !app.isBusy(controller),
        "nested native ask",
    );
    await settle();
    assert.equal(
        sent.length,
        0,
        "the parent can answer an internal exact question; no child or parent idle push",
    );
    escalation = true;
    await say(app, chat, "Ask me if this needs new authority.");
    const result = (await app.transcripts.allEntries(chat, true)).findLast(
        (entry) => entry.kind === "toolResult" && entry.name === "work_supervise",
    );

    assert.ok(
        result?.kind === "toolResult",
        JSON.stringify(await app.transcripts.allEntries(chat, true)),
    );
    assert.equal(result.isError, false, result.text);
    await until(() => sent.length === 1, "named owner escalation");
    assert.equal(sent[0]!.message.url, `/s/${chat}`);
    assert.equal(sent[0]!.message.title, "PiP needs your decision");
    await settle();
    assert.equal(sent.length, 1, "an explicit question is not also a completion");
    finishing = true;
    await say(app, chat, "Try to finish while child work is still active.");
    const premature = (await app.transcripts.allEntries(chat, true)).findLast(
        (entry) => entry.kind === "toolResult" && entry.name === "work_supervise",
    );

    assert.ok(premature?.kind === "toolResult");
    assert.equal(premature.isError, true);
    assert.match(premature.text, /Child work or a report is still active/);
    const question = (await app.harness.snapshot(PipWorkDoc, controller, context))!.question!;

    answer = {
        action: "answer",
        session: Number(controller),
        questionId: question.id,
        text: "Use the already authorized existing scope.",
    };
    await say(app, chat, "Answer with the existing authorized scope.");
    await until(
        () => app.workItems.itemFor(source)!.supervisor!.status !== "running",
        "child native finish",
    );
    await settle();
    assert.equal(sent.length, 1, "child finish and parent answer-yield remain internal");
    answer = undefined;
    await say(app, chat, "Now finish the settled outer orchestration.");
    await until(() => sent.length === 2, "named outer final");
    assert.equal(sent[1]!.message.title, "Orchestration finished");
    assert.equal(sent[1]!.message.url, `/s/${chat}`);
    await settle();
    assert.equal(sent.length, 2);
});

test("standalone completion remains once per answer, with preferences and visible conversation suppression", async (t) => {
    const app = await openApp(
        scriptedModel(() => fauxAssistantMessage("Standalone answer.")),
        join(root, "standalone-notifications"),
    );

    t.after(() => app.close());
    const sent = capture(app);
    const source = await newSession(app, app.defaultCwd, "chat");

    await say(app, source, "Answer normally.");
    await until(() => sent.length === 1, "standalone completion", 5000);
    assert.match(sent[0]!.message.title, /^Pi finished/);
    app.alerts.runChanged(source, false);
    await settle();
    assert.equal(sent.length, 1);
    app.pushStore!.setPrefs(owner(app).id, { done: false });
    await say(app, source, "Muted completion.");
    await settle();
    assert.equal(sent.length, 1);
    app.pushStore!.setPrefs(owner(app).id, { done: true });
    const tab = fakeTab(source, owner(app));

    await app.attach(tab.client);
    await say(app, source, "Visible completion.");
    await settle();
    assert.equal(sent.length, 1);
    app.detach(tab.client);
});

test("Herdr pushes use fixed owner-only metadata, exact pane presence, existing prefs and abortable delivery", async (t) => {
    const app = await openApp(
        scriptedModel(() => fauxAssistantMessage("Unused.")),
        join(root, "herdr-notification-delivery"),
    );

    t.after(() => app.close());
    const sent = capture(app);
    const pane = "a".repeat(64);
    const signal = new AbortController();
    const guest = app.config.addUser("Guest", "guest").user;

    await app.alerts.herdr(guest.id, pane, "done", signal.signal);
    assert.equal(sent.length, 0);
    await app.alerts.herdr(owner(app).id, pane, "done", signal.signal);
    assert.deepEqual(sent[0], {
        user: owner(app).id,
        message: {
            title: "Herdr agent finished",
            body: "The observed agent turn ended. Open its pane to inspect the result.",
            url: `/private/${pane}`,
            tag: `herdr-${pane}`,
        },
    });
    app.pushStore!.setPrefs(owner(app).id, { approval: false });
    await app.alerts.herdr(owner(app).id, pane, "approval", signal.signal);
    assert.equal(sent.length, 1);
    app.pushStore!.setPrefs(owner(app).id, { approval: true });
    const tab = fakeTab(undefined, owner(app));

    tab.client.privateId = pane;
    await app.attach(tab.client);
    await app.alerts.herdr(owner(app).id, pane, "approval", signal.signal);
    assert.equal(sent.length, 1, "visible exact private pane suppresses its push");
    app.setVisible(owner(app), tab.client.id, false);
    await app.alerts.herdr(owner(app).id, pane, "approval", signal.signal);
    assert.equal(sent.length, 2, "hidden pane permits attention without an Allow action");
    assert.equal(sent[1]!.message.approval, undefined);
    signal.abort();
    await app.alerts.herdr(owner(app).id, pane, "done", signal.signal);
    assert.equal(sent.length, 2);
    app.detach(tab.client);
});
