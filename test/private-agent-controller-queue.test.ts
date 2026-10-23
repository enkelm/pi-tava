// Controller contacts cross registered tools and actual native input/lifecycle admission.
import assert from "node:assert/strict";
import { after, test, type TestContext } from "node:test";
import { join } from "node:path";
import { awaitWithContext, withAbortSignal } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
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
    setWorkPipLimits,
    until,
} from "./helpers.ts";

import { PipWorkDoc } from "../src/server/docs.ts";
import { AgentSupervisionDoc } from "../src/server/pip/agent-supervision.ts";

after(cleanUp);

// Hold a response generated before contact: normal tool continuation must steer at post-tools,
// and an in-flight finish must preserve the unseen contact. Neither may cancel execution.
async function busyControllerContact(t: TestContext, firstAction: "observe" | "finish") {
    let controller!: ConversationId;
    let controllerCalls = 0;
    let initialAborted = false;
    let boundaryUsers: string[] = [];
    let releaseInitial!: () => void;
    let releaseBoundary!: () => void;
    let releaseExecution!: () => void;
    const initial = new Promise<void>((resolve) => {
        releaseInitial = resolve;
    });
    const boundary = new Promise<void>((resolve) => {
        releaseBoundary = resolve;
    });
    const execution = new Promise<void>((resolve) => {
        releaseExecution = resolve;
    });
    const app = await openApp(
        scriptedModel(async (request, options) => {
            const system = JSON.stringify(
                request.messages.filter((message) => message.role === "system"),
            );
            const last = lastText(request);
            const ctx = options?.signal ? withAbortSignal(options.signal, context) : context;

            if (system.includes("the owner's persistent private agent")) {
                return last.role === "user"
                    ? fauxAssistantMessage(
                          [
                              fauxToolCall("session_send", {
                                  session: Number(controller),
                                  message: "ONE_CONTROLLER_CONTACT",
                                  report: false,
                              }),
                          ],
                          { stopReason: "toolUse" },
                      )
                    : fauxAssistantMessage("Native contact result recorded.");
            }

            if (system.includes("the private supervisor for Work Item")) {
                controllerCalls++;

                if (controllerCalls === 1) {
                    try {
                        await awaitWithContext(initial, ctx);
                    } catch (error) {
                        initialAborted = true;

                        throw error;
                    }

                    return fauxAssistantMessage(
                        [
                            firstAction === "finish"
                                ? fauxToolCall("work_supervise", {
                                      action: "finish",
                                      text: "Earlier input finished before the new contact was read.",
                                  })
                                : fauxToolCall("work_context", {
                                      action: "status",
                                      session: Number(source),
                                  }),
                        ],
                        { stopReason: "toolUse" },
                    );
                }

                boundaryUsers = request.messages
                    .filter((message) => message.role === "user")
                    .map((message) => lastText({ messages: [message] }).text);
                await awaitWithContext(boundary, ctx);

                return fauxAssistantMessage(
                    [
                        fauxToolCall("work_supervise", {
                            action: "ask",
                            text: "Which bounded next step does the owner want?",
                        }),
                    ],
                    { stopReason: "toolUse" },
                );
            }

            await awaitWithContext(execution, ctx);

            return fauxAssistantMessage("Separate execution completed.");
        }),
        join(root, `private-agent-controller-steer-${firstAction}`),
    );

    t.after(async () => {
        releaseInitial();
        releaseBoundary();
        releaseExecution();
        await app.close();
    });
    const source = await newSession(app, app.defaultCwd, "worker");
    const opened = await app.pip.orchestration.control(source, owner(app), { action: "open" });

    controller = opened.orchestration!.conversationId as ConversationId;
    await app.commands.submit(source, owner(app), {
        text: "Separate execution",
        requestId: "separate-execution",
    });
    const original = await app.commands.submit(controller, owner(app), {
        text: "OWNER_CONTROLLER_INPUT",
        requestId: "owner-controller-input",
    });

    await until(() => controllerCalls === 1 && app.isBusy(source), "both native runs are active");
    const before = { ...app.workItems.itemFor(source)!.supervisor! };
    const chat = (
        await app.pip.agents.create(owner(app), {
            name: "One-send Tava",
            requestId: "one-send-agent",
        })
    ).id as ConversationId;

    await say(app, chat, "Contact the exact Work Item orchestrator within this scope.");
    const result = (await app.transcripts.allEntries(chat, true)).findLast(
        (entry) => entry.kind === "toolResult" && entry.name === "session_send",
    );

    assert.ok(result?.kind === "toolResult");
    assert.equal(result.isError, false, result.text);
    const receipt = JSON.parse(result.text);

    assert.equal(receipt.status, "accepted", result.text);
    assert.equal(receipt.session, Number(controller));
    const sent = (await app.harness.submission(receipt.submissionId, context))!;
    const queued = await sent.status(context);

    assert.equal(queued.status, "queued");
    assert.equal(queued.conversationId, controller);
    assert.equal(initialAborted, false);
    assert.equal(controllerCalls, 1);
    assert.equal(app.workItems.itemFor(source)!.supervisor!.epoch, before.epoch);
    assert.equal(app.workItems.itemFor(source)!.activeThreadId, Number(source));
    assert.equal(app.workItems.itemFor(source)!.intervention, undefined);
    assert.equal(app.isBusy(source), true);
    releaseInitial();
    await until(() => controllerCalls === 2, "next controller request consumes the contact");
    assert.ok(boundaryUsers.some((text) => text.includes("OWNER_CONTROLLER_INPUT")));
    assert.ok(
        boundaryUsers.some((text) => text.includes("ONE_CONTROLLER_CONTACT")),
        firstAction === "finish"
            ? "an in-flight finish must not discard the accepted contact"
            : "contact must steer at post-tools, not wait for the final-answer boundary",
    );
    const contact = boundaryUsers.find((text) => text.includes("ONE_CONTROLLER_CONTACT"))!;

    assert.match(contact, /One-send Tava.*origin \/s\//);
    assert.match(contact, /not a new owner instruction/);
    assert.equal((await sent.status(context)).status, "placed");
    assert.equal(
        (await (await app.harness.submission(original.submissionId, context))!.status(context))
            .status,
        firstAction === "finish" ? "done" : "placed",
    );
    assert.equal(app.isBusy(source), true, "controller steering never stops separate execution");
    releaseBoundary();
    await sent.wait(context);
    await until(() => !app.isBusy(controller), "controller asks its exact question");
    const question = (await app.harness.snapshot(PipWorkDoc, controller, context))!.question!;
    const actions = app.workItems.itemFor(source)!.supervisor!.actions;

    await say(app, chat, "Pass another instruction, not an answer.");
    const blocked = (await app.transcripts.allEntries(chat, true)).findLast(
        (entry) => entry.kind === "toolResult" && entry.name === "session_send",
    );

    assert.ok(blocked?.kind === "toolResult");
    assert.equal(JSON.parse(blocked.text).status, "blocked");
    assert.match(JSON.parse(blocked.text).reason, /pending.*question|human decision/);
    const pending = (await app.harness.snapshot(PipWorkDoc, controller, context))!.question!;

    assert.equal(pending.id, question.id);
    assert.equal(pending.answer, undefined);
    assert.equal(app.workItems.itemFor(source)!.supervisor!.actions, actions);
    assert.equal(controllerCalls, 2);
    await app.commands.abort(controller, owner(app));
    const stopped = { ...app.workItems.itemFor(source)!.supervisor! };

    await say(app, chat, "Contact the stopped orchestrator; do not fabricate an answer.");
    const refused = (await app.transcripts.allEntries(chat, true)).findLast(
        (entry) => entry.kind === "toolResult" && entry.name === "session_send",
    );

    assert.ok(refused?.kind === "toolResult");
    assert.equal(refused.isError, true);
    assert.match(refused.text, /exact human decision/);
    const stoppedQuestion = (await app.harness.snapshot(PipWorkDoc, controller, context))!.question!;

    assert.equal(stoppedQuestion.id, question.id);
    assert.equal(stoppedQuestion.answer, undefined);
    assert.equal(app.workItems.itemFor(source)!.supervisor!.epoch, stopped.epoch);
    assert.equal(app.workItems.itemFor(source)!.supervisor!.status, "reclaimed");
    assert.equal(controllerCalls, 2);
    assert.equal(
        (await app.transcripts.allEntries(source, true)).filter((entry) => entry.kind === "user")
            .length,
        1,
    );
    releaseExecution();
    await until(() => !app.isBusy(source), "separate execution settles independently");
}

for (const firstAction of ["observe", "finish"] as const) {
    test(`one send survives in-flight ${firstAction} and steers only the controller`, (t) =>
        busyControllerContact(t, firstAction),
    );
}

for (const [state, boundary] of [
    ["human", "normal"],
    ["stopped", "normal"],
    ["finished", "normal"],
    ["human", "refused"],
    ["human", "ack-lost"],
    ["human", "token-rotated"],
    ["human", "reclaimed"],
    ["human", "execution-directed"],
] as const) {
    test(`one send ${state}/${boundary}: native acceptance and recovery`, async (t) => {
        let controller!: ConversationId;
        let deliveries = 0;
        let controllerCalls = 0;
        let joining = false;
        let sending: Promise<void> | undefined;
        let reconciliation: Promise<void> | undefined;
        const releaseJoin = Promise.withResolvers<void>();
        const directory = join(root, `private-agent-controller-${state}-${boundary}`);
        const model = scriptedModel((request) => {
            const system = JSON.stringify(
                request.messages.filter((message) => message.role === "system"),
            );
            const last = lastText(request);

            if (system.includes("the owner's persistent private agent")) {
                return last.role === "user"
                    ? fauxAssistantMessage(
                          [
                              fauxToolCall("agent_work", {
                                  action: "send",
                                  session: Number(controller),
                                  text: "ACTIVATE_ONCE",
                                  report: false,
                              }),
                          ],
                          { stopReason: "toolUse" },
                      )
                    : fauxAssistantMessage("Native contact result recorded.");
            }

            if (system.includes("the private supervisor for Work Item")) {
                controllerCalls++;

                if (last.text.includes("ACTIVATE_ONCE")) {
                    deliveries++;
                } else if (state === "finished") {
                    return fauxAssistantMessage(
                        [
                            fauxToolCall("work_supervise", {
                                action: "finish",
                                text: "Earlier scope ended; not a correctness certificate.",
                            }),
                        ],
                        { stopReason: "toolUse" },
                    );
                }
            }

            return fauxAssistantMessage("Native controller observation.");
        });
        let app = await openApp(model, directory);

        t.after(async () => {
            releaseJoin.resolve();
            await sending?.catch(() => {});
            await reconciliation?.catch(() => {});
            await app.close();
        });
        const source = await newSession(app, app.defaultCwd, "worker");
        const opened = await app.pip.orchestration.control(source, owner(app), { action: "open" });

        controller = opened.orchestration!.conversationId as ConversationId;

        if (state !== "human") {
            await say(app, controller, "Observe this earlier scope.");

            if (state === "stopped") {
                await app.commands.abort(controller, owner(app));
            }
        }

        const before = { ...app.workItems.itemFor(source)!.supervisor! };
        const sendFromAgent = app.pip.orchestration.sendFromAgent.bind(app.pip.orchestration);
        let nativeAttempts = 0;

        if (boundary === "execution-directed") {
            app.pip.orchestration.sendFromAgent = (id, user, intent, sender) => {
                const withControl = app.workItems.withControl.bind(app.workItems);
                let delayed = false;

                t.mock.method(
                    app.workItems,
                    "withControl",
                    async <T>(target: ConversationId, operation: () => Promise<T>): Promise<T> => {
                        const result = await withControl(target, operation);

                        if (target === controller && !delayed) {
                            delayed = true;
                            joining = true;
                            await releaseJoin.promise;
                        }

                        return result;
                    },
                );

                return sendFromAgent(id, user, intent, sender);
            };
        } else if (boundary === "token-rotated" || boundary === "reclaimed") {
            app.pip.orchestration.sendFromAgent = async (id, user, intent, sender) => {
                if (boundary === "token-rotated") {
                    owner(app).tokenHash = "rotated-after-contact-preparation";
                } else {
                    await app.pip.orchestration.control(controller, owner(app), { action: "pause" });
                }

                return sendFromAgent(id, user, intent, sender);
            };
        } else if (boundary !== "normal") {
            app.pip.orchestration.sendFromAgent = (id, user, intent, sender) => {
                assert.ok(sender);

                return sendFromAgent(
                    id,
                    user,
                    intent,
                    new Proxy(sender, {
                        get(target, field, receiver) {
                            if (field !== "submit") {
                                return Reflect.get(target, field, receiver);
                            }

                            return async (...args: Parameters<typeof sender.submit>) => {
                                nativeAttempts++;
                                const pending = (
                                    await app.harness.snapshot(PipWorkDoc, controller, context)
                                )!.contactPending;

                                assert.equal(
                                    app.workItems.itemFor(source)!.supervisor!.status,
                                    "reclaimed",
                                    "prepared intent must not enable paid wakes before native acceptance",
                                );
                                assert.equal(pending!.requestId, intent.requestId);
                                assert.equal(
                                    pending!.epoch,
                                    app.workItems.itemFor(source)!.supervisor!.epoch,
                                );
                                reconciliation = app.pip.agents.supervision.open();

                                if (boundary === "refused") {
                                    throw new Error("Native input rejected before acceptance");
                                }

                                await sender.submit(...args);

                                throw new Error("Native acknowledgement lost after acceptance");
                            };
                        },
                    }),
                );
            };
        }

        assert.equal(before.status, "reclaimed");
        const chat = (
            await app.pip.agents.create(owner(app), {
                name: "Activate Tava",
                requestId: "activate-agent",
            })
        ).id as ConversationId;

        sending = say(
            app,
            chat,
            "Contact this exact controller once within the established scope.",
        );

        if (boundary === "execution-directed") {
            // Delay only scheduling after the real preflight releases its control lock. The
            // native human-input path must revoke the older contact during that unlocked join.
            await until(() => joining, "inactive contact releases its preflight lock");
            await app.commands.submit(source, owner(app), {
                text: "New human execution direction supersedes the older private contact.",
                requestId: "human-execution-during-controller-join",
            });
            releaseJoin.resolve();
        }

        await sending;
        await reconciliation;

        if (
            boundary === "token-rotated" ||
            boundary === "reclaimed" ||
            boundary === "execution-directed"
        ) {
            const requests = Object.values(
                (await app.harness.snapshot(AgentSupervisionDoc, context))!.requests,
            );

            assert.equal(requests.length, 1, "the contact reached its actual durable preparation");
            assert.equal(requests[0]!.status, "blocked");
            assert.equal(
                await app.harness.commit(
                    (tx) => tx.submissionByRequest(controller, requests[0]!.requestId),
                    context,
                ),
                undefined,
            );
            assert.equal(deliveries, 0);
            assert.equal(controllerCalls, 0);
            assert.equal(app.workItems.itemFor(source)!.supervisor!.status, "reclaimed");

            return;
        }

        const result = (await app.transcripts.allEntries(chat, true)).findLast(
            (entry) => entry.kind === "toolResult" && entry.name === "agent_work",
        );

        assert.ok(result?.kind === "toolResult");
        assert.equal(result.isError, false, result.text);
        const receipt = JSON.parse(result.text);

        assert.equal(receipt.session, Number(controller));

        if (boundary === "refused") {
            assert.equal(receipt.status, "blocked", result.text);
            assert.match(receipt.reason, /rejected before acceptance/);
            assert.equal(nativeAttempts, 1);
            assert.equal(deliveries, 0);
            assert.equal(app.workItems.itemFor(source)!.supervisor!.status, "reclaimed");
            assert.equal(
                (await app.harness.snapshot(PipWorkDoc, controller, context))!.contactPending,
                undefined,
            );
            assert.equal(
                await app.harness.commit(
                    (tx) => tx.submissionByRequest(controller, receipt.requestId),
                    context,
                ),
                undefined,
            );

            return;
        }

        assert.equal(receipt.status, "accepted", result.text);
        await (await app.harness.submission(receipt.submissionId, context))!.wait(context);
        assert.equal(deliveries, 1);
        assert.equal(nativeAttempts, boundary === "ack-lost" ? 1 : 0);
        const after = { ...app.workItems.itemFor(source)!.supervisor! };

        assert.equal(after.conversationId, Number(controller));
        assert.equal(after.status, "running");
        assert.equal(
            (await app.harness.snapshot(PipWorkDoc, controller, context))!.contactPending,
            undefined,
        );
        assert.ok(after.epoch > before.epoch);
        assert.equal(after.actions, before.actions + 1);
        assert.equal(after.maxActions, before.maxActions);
        assert.equal(after.maxCost, before.maxCost);
        const accepted = (await app.harness.snapshot(AgentSupervisionDoc, context))!.requests;
        const saved = Object.values(accepted).filter((entry) => entry.requestId === receipt.requestId);

        assert.equal(saved.length, 1);
        assert.equal(saved[0]!.submissionId, receipt.submissionId);
        const replay = await sendFromAgent(controller, owner(app), saved[0]!, undefined);

        assert.equal(Number(replay.submissionId), receipt.submissionId);
        assert.equal(app.workItems.itemFor(source)!.supervisor!.actions, after.actions);
        const calls = controllerCalls;

        if (state === "human" && boundary === "normal") {
            await setWorkPipLimits(app, source, owner(app), { maxActions: after.actions });
            await say(app, chat, "Try one more contact without extending the exhausted action cap.");
            const denied = (await app.transcripts.allEntries(chat, true)).findLast(
                (entry) => entry.kind === "toolResult" && entry.name === "agent_work",
            );

            assert.ok(denied?.kind === "toolResult");
            assert.equal(denied.isError, true);
            assert.match(denied.text, /action budget is exhausted/);
            assert.equal(app.workItems.itemFor(source)!.supervisor!.actions, after.actions);
            assert.equal(app.workItems.itemFor(source)!.supervisor!.status, "reclaimed");
            assert.equal(deliveries, 1);
        }

        await app.commands.abort(controller, owner(app));
        await app.close();
        app = await openApp(model, directory);
        assert.equal(app.workItems.itemFor(source)!.supervisor!.status, "reclaimed");
        assert.equal(
            controllerCalls,
            calls,
            "historical accepted contact does not reactivate on recovery",
        );
        assert.equal(deliveries, 1);
        const recovered = (await app.harness.snapshot(AgentSupervisionDoc, context))!.requests;

        assert.equal(
            Object.values(recovered).find((entry) => entry.requestId === receipt.requestId)!
                .submissionId,
            receipt.submissionId,
        );
    });
}
