// Real native question/action-budget and approval admission. Transport is inert; no external effects.
import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import { SubagentsDoc } from "../src/server/docs.ts";
import type { PushMessage } from "../src/server/push.ts";
import {
    activateWorkPip,
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

function capture(app: Awaited<ReturnType<typeof openApp>>) {
    app.privateSessions.local.sockets = async () => [];
    const store = app.pushStore!;
    const key = createECDH("prime256v1");

    key.generateKeys();
    store.subscribe(owner(app).id, {
        endpoint: "https://fcm.googleapis.com/gates",
        keys: {
            p256dh: key.getPublicKey().toString("base64url"),
            auth: randomBytes(16).toString("base64url"),
        },
    });
    const sent: PushMessage[] = [];

    store.notify = async (_user, message) => {
        sent.push(message);

        return 1;
    };

    return sent;
}

test("outer native asks and action-budget blockers notify once without suppressing real human approval gates", async (t) => {
    let action: "ask" | "wait" = "ask";
    const app = await openApp(
        scriptedModel(() =>
            fauxAssistantMessage(
                [
                    fauxToolCall("work_supervise", {
                        action,
                        text: "Please decide the next authorized scope.",
                    }),
                ],
                { stopReason: "toolUse" },
            ),
        ),
        join(root, "notification-gates"),
    );

    t.after(() => app.close());
    const sent = capture(app);

    const source = await newSession(app, app.defaultCwd, "worker");
    const opened = await activateWorkPip(app, source);
    const controller = opened.orchestration!.conversationId as ConversationId;

    await until(() => sent.length === 1, "outer native question push");
    assert.equal(sent[0]!.title, "PiP needs your decision");
    assert.equal(sent[0]!.url, `/s/${controller}`);
    const approval = app.approvals.request(
        {
            id: "native-gate",
            conversationId: source,
            taskId: 1 as TaskId,
            tool: "publication",
            subject: "git push origin main",
            reason: "individual publication approval",
            createdAt: Date.now(),
        },
        context,
    );

    await until(() => sent.length === 2, "approval even under an active orchestrator");
    assert.equal(sent[1]!.approval?.id, "native-gate");
    assert.equal(sent[1]!.url, `/s/${source}`);
    app.alerts.announceApprovals();
    await app.answerApproval("native-gate", false, owner(app));
    await approval;
    assert.equal(sent.length, 2);
    action = "wait";
    const second = await newSession(app, app.defaultCwd, "worker");
    const limited = await activateWorkPip(app, second, owner(app), { maxActions: 1 });
    const limitedController = limited.orchestration!.conversationId as ConversationId;

    await until(() => sent.length === 3, "native action budget blocker");
    assert.equal(sent[2]!.title, "Orchestration needs attention");
    assert.equal(sent[2]!.url, `/s/${limitedController}`);
    const epoch = app.workItems.itemFor(second)!.supervisor!.epoch - 1;

    await app.alerts.orchestrationEvent(
        limitedController,
        `budget-${epoch}`,
        "blocker",
        "Repeated observation of the same budget fence.",
    );
    assert.equal(sent.length, 3);
});

test("a native controller's control handoff is not a completion while its execution is still active", async (t) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    const app = await openApp(
        scriptedModel(async (request) => {
            const system = JSON.stringify(
                request.messages.filter((message) => message.role === "system"),
            );

            if (system.includes("the private supervisor for Work Item")) {
                return lastText(request).role === "toolResult"
                    ? fauxAssistantMessage("The native control transition was recorded.")
                    : fauxAssistantMessage(
                          [
                              fauxToolCall("work_supervise", {
                                  action: "finish",
                                  text: "Attempting an outer final.",
                              }),
                          ],
                          { stopReason: "toolUse" },
                      );
            }

            await held;

            return fauxAssistantMessage("The execution turn actually settled.");
        }),
        join(root, "active-execution-final"),
    );

    t.after(async () => {
        release();
        await app.close();
    });
    const sent = capture(app);
    const source = await newSession(app, app.defaultCwd, "worker");

    await app.commands.submit(source, owner(app), {
        requestId: "held-work",
        text: "Do not settle until released.",
    });
    await until(() => app.isBusy(source), "native execution running");
    const opened = await activateWorkPip(app, source);
    const controller = opened.orchestration!.conversationId as ConversationId;

    await until(() => !app.isBusy(controller), "premature native finish settled");
    const result = (await app.transcripts.allEntries(controller, true)).find(
        (entry) => entry.kind === "toolResult" && entry.name === "work_supervise",
    );

    assert.ok(result?.kind === "toolResult");
    assert.equal(
        result.isError,
        false,
        "notification policy must preserve the native control-handoff behavior",
    );
    assert.equal(sent.length, 0, "a premature final is not a human completion");
    release();
    await until(() => !app.isBusy(source), "the real execution outcome");
    await say(app, controller, "Execution settled; explicitly conclude this orchestration now.");
    await until(() => sent.length === 1, "final after the actual execution outcome");
    assert.equal(sent[0]!.title, "Orchestration finished");
    assert.equal(sent[0]!.url, "/s/" + controller);
});

test("named finals wait for delegated execution and exact recipients' helper trees, not just controller/model idleness", async (t) => {
    for (const target of ["delegated-work", "chat-helper"] as const) {
        await t.test(target, async (t) => {
            let source!: ConversationId;
            let controller!: ConversationId;
            let finishing = false;
            let release!: () => void;
            const held = new Promise<void>((resolve) => {
                release = resolve;
            });
            const app = await openApp(
                scriptedModel(async (request) => {
                    const system = JSON.stringify(
                        request.messages.filter((message) => message.role === "system"),
                    );
                    const last = lastText(request);

                    if (system.includes("the owner's persistent private agent")) {
                        return last.role !== "user"
                            ? fauxAssistantMessage("Internal coordination checkpoint.")
                            : fauxAssistantMessage(
                                  [
                                      finishing
                                          ? fauxToolCall("work_supervise", {
                                                action: "finish",
                                                text: "The outer orchestration ended.",
                                            })
                                          : target === "delegated-work"
                                            ? fauxToolCall("agent_work", {
                                                  action: "send",
                                                  session: Number(controller),
                                                  text: "Observe the already-running execution.",
                                              })
                                            : fauxToolCall("session_send", {
                                                  session: Number(source),
                                                  message: "SPAWN_HELD_HELPER",
                                                  report: true,
                                              }),
                                  ],
                                  { stopReason: "toolUse" },
                              );
                    }

                    if (system.includes("the private supervisor for Work Item")) {
                        return fauxAssistantMessage(
                            [
                                fauxToolCall("work_supervise", {
                                    action: "finish",
                                    text: "Return control while execution continues.",
                                }),
                            ],
                            { stopReason: "toolUse" },
                        );
                    }

                    if (
                        target === "delegated-work" ||
                        (last.role === "user" && last.text.includes("HELD_CHILD"))
                    ) {
                        await held;

                        return fauxAssistantMessage("The held work settled.");
                    }

                    return last.role === "user" && last.text.includes("SPAWN_HELD_HELPER")
                        ? fauxAssistantMessage(
                              [
                                  fauxToolCall("subagent", {
                                      action: "spawn",
                                      name: "held",
                                      message: "HELD_CHILD",
                                  }),
                              ],
                              { stopReason: "toolUse" },
                          )
                        : fauxAssistantMessage(
                              "Recipient yielded; its helper may still be running.",
                          );
                }),
                join(root, `notification-final-tree-${target}`),
            );

            t.after(async () => {
                release();
                await app.close();
            });
            const sent = capture(app);

            source = await newSession(
                app,
                app.defaultCwd,
                target === "delegated-work" ? "worker" : "chat",
            );

            if (target === "delegated-work") {
                const opened = await app.pip.orchestration.control(source, owner(app), {
                    action: "open",
                });

                controller = opened.orchestration!.conversationId as ConversationId;
                await app.commands.submit(source, owner(app), {
                    requestId: "held-execution",
                    text: "Hold this execution.",
                });
                await until(() => app.isBusy(source), "execution starts");
            }

            const chat = (
                await app.pip.agents.create(owner(app), {
                    name: "Finality",
                    requestId: `finality-${target}`,
                })
            ).id as ConversationId;

            await say(app, chat, "Coordinate the exact target.");
            await until(async () => {
                if (target === "delegated-work") {
                    const grant = app.workItems.itemFor(source)?.supervisor;

                    return (
                        grant?.status === "reclaimed" &&
                        !app.isBusy(grant.conversationId as ConversationId)
                    );
                }

                const helpers = await app.harness.snapshot(SubagentsDoc, source, context);

                return (
                    !app.isBusy(source) &&
                    helpers?.agents.held !== undefined &&
                    app.isBusy(helpers.agents.held.conversationId)
                );
            }, "controller/recipient yields with descendant work still active");
            finishing = true;
            await say(app, chat, "Conclude the outer orchestration.");
            const premature = (await app.transcripts.allEntries(chat, true)).findLast(
                (entry) => entry.kind === "toolResult" && entry.name === "work_supervise",
            );

            assert.ok(premature?.kind === "toolResult");
            assert.equal(
                premature.isError,
                true,
                "a descendant remains active after the immediate recipient yields",
            );
            assert.match(premature.text, /Child work or a report is still active/);
            assert.equal(sent.length, 0);
            release();
            await until(async () => {
                const helpers = await app.harness.snapshot(SubagentsDoc, source, context);

                return (
                    app.conversationsOf(source).every((child) => !app.isBusy(child)) &&
                    helpers?.courier === undefined &&
                    helpers?.sending === undefined &&
                    (helpers?.outbox?.length ?? 0) === 0
                );
            }, "actual target tree and native helper reports settle");
            await new Promise((resolve) => setTimeout(resolve, 3250));
            assert.equal(sent.length, 0, "the descendant yield must not leak its own completion");
            await say(app, chat, "Now conclude the settled orchestration.");
            await until(() => sent.length === 1, "settled outer final");
            assert.equal(sent[0]!.title, "Orchestration finished");
            assert.equal(sent[0]!.url, `/s/${chat}`);
        });
    }
});
