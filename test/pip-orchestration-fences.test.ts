import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import { awaitWithContext } from "@earendil-works/chord/context";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import {
    activateWorkPip,
    cleanUp,
    context,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
    type App,
} from "./helpers.ts";
import { PipWorkDoc } from "../src/server/docs.ts";

const text = (value: string) => fauxAssistantMessage([fauxText(value)]);
const tool = (name: string, args: Parameters<typeof fauxToolCall>[1], id?: string) =>
    fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" });
const idOf = (value: number) => value as ConversationId;
const isSupervisor = (request: TranscriptContext) =>
    JSON.stringify(request.messages.filter((message) => message.role === "system")).includes(
        "the private supervisor for Work Item",
    );

after(cleanUp);

const execution = (app: App) => newSession(app, app.defaultCwd, "worker");

function watchingModel() {
    return scriptedModel((request) => {
        if (!isSupervisor(request)) {
            return text("Execution report.");
        }

        return lastText(request).role === "user"
            ? tool("work_supervise", { action: "wait", text: "Watching for new evidence." })
            : text("Waiting for evidence.");
    });
}

async function watching(app: App) {
    const source = await execution(app);
    const started = await activateWorkPip(app, source, owner(app), {
        text: "Observe this Work Item without sending new tasks.",
        budget: 5,
        maxActions: 10,
    });
    const controller = idOf(started.orchestration!.conversationId);

    await until(async () => {
        const state = await app.harness.snapshot(PipWorkDoc, controller, context);

        return (
            state?.reason === "Watching for new evidence." &&
            state.pending === undefined &&
            !app.isBusy(controller)
        );
    }, "the supervisor's initial observation to settle");

    return { source, controller };
}

test("a pending question admits only its original ask replay, not another native send or stop", async (t) => {
    let source!: ConversationId;
    let step = 0;
    const repeatedCallId = "provider-call-id-reused-after-ask";
    const model = scriptedModel((request) => {
        if (!isSupervisor(request)) {
            return text("Execution report.");
        }

        const plan = [
            () => tool("work_context", { session: Number(source), action: "thread" }),
            () =>
                tool(
                    "work_supervise",
                    { action: "ask", text: "Should I send the next task?" },
                    repeatedCallId,
                ),
            // Inspection is intentionally renewed after reopen, so a missing pending-question
            // fence cannot be masked by the independent in-memory inspect-before-acting guard.
            () => tool("work_context", { session: Number(source), action: "thread" }),
            () =>
                tool(
                    "session_send",
                    {
                        session: Number(source),
                        message: "MUST_NOT_SEND_WITHOUT_THE_QUESTION_ANSWER",
                        report: false,
                    },
                    repeatedCallId,
                ),
            () => tool("session_stop", { session: Number(source) }),
            () => text("Waiting for the exact human answer."),
        ];
        const next = plan[step++];

        assert.ok(next, "a pending question must not buy another supervisor generation");

        return next();
    });
    const directory = join(root, "question-action-fence");
    let app = await openApp(model, directory);
    const held = Promise.withResolvers<void>();
    let saved = false;
    const original = app.pip.orchestration.supervise.bind(app.pip.orchestration);
    const intercepted = t.mock.method(
        app.pip.orchestration,
        "supervise",
        async (...args: Parameters<typeof original>) => {
            const result = await original(...args);

            saved = true;
            await awaitWithContext(held.promise, args[1]);

            return result;
        },
    );

    t.after(async () => {
        held.resolve();
        intercepted.mock.restore();
        await app.close();
    });
    source = await execution(app);
    const started = await activateWorkPip(app, source, owner(app), {
        text: "Ask before sending more work or stopping execution.",
        budget: 5,
        maxActions: 10,
    });
    const controller = idOf(started.orchestration!.conversationId);

    await until(() => saved, "the question to commit before its native tool result settles");
    const before = await app.harness.snapshot(PipWorkDoc, controller, context);
    const question = before!.question!;
    const actions = app.workItems.itemFor(source)!.supervisor!.actions;

    assert.equal(question.text, "Should I send the next task?");
    await app.close();
    held.resolve();
    intercepted.mock.restore();
    app = await openApp(model, directory);
    await until(() => !app.isBusy(controller), "the recovered ask to yield without regeneration");
    assert.equal(step, 2, "an unanswered ask cannot buy an acknowledgement response");
    await app.commands.submit(controller, owner(app), {
        requestId: "uncorrelated-later-input",
        text: "Yes, but this is not an answer through the exact pending question.",
    });
    await until(
        () => step === 6 && !app.isBusy(controller),
        "an unrelated later instruction must not bypass the pending-question action fence",
    );
    const results = (await app.transcripts.allEntries(controller, true)).filter(
        (entry) => entry.kind === "toolResult",
    );
    const ask = results.find((entry) => entry.name === "work_supervise");

    assert.ok(ask, "the interrupted ask must produce its recovered native result");
    assert.equal(ask.isError, false, ask.text);
    assert.equal(JSON.parse(ask.text).questionId, question.id);

    for (const name of ["session_send", "session_stop"]) {
        const result = results.find((entry) => entry.name === name);

        assert.ok(result, `${name} must reach the native tool boundary`);
        assert.equal(result.isError, true, result.text);
        assert.match(result.text, /pending human question/i);
    }

    const afterReplay = await app.harness.snapshot(PipWorkDoc, controller, context);

    assert.deepEqual(afterReplay!.question, question, "replay must retain the unanswered question");
    assert.equal(afterReplay!.questions.length, 0);
    assert.equal(app.workItems.itemFor(source)!.supervisor!.actions, actions);
    assert.equal(
        (await app.transcripts.allEntries(source, true)).filter((entry) => entry.kind === "user")
            .length,
        0,
        "no task may reach execution before the exact question is answered",
    );
});

test("an old reconciliation cannot pause a grant renewed while it waited for control", async (t) => {
    const app = await openApp(watchingModel(), join(root, "stale-observation-fence"));
    const held = Promise.withResolvers<void>();
    let reconciliation: Promise<void> | undefined;

    t.after(async () => {
        held.resolve();
        await reconciliation?.catch(() => {});
        await app.close();
    });
    const { source, controller } = await watching(app);

    app.pip.orchestration.close();
    const scheduling = t.mock.method(app.pip.orchestration, "schedule", () => {});

    // Drain already-scheduled callbacks while observation is stopped. Keep the interleaving
    // deterministic using public methods; real authority and commits still run under the lock.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await app.reviews.comment(source, owner(app), {
        requestId: "evidence-before-renewal",
        text: "New evidence requires a fresh observation.",
    });
    const original = app.workItems.withControl.bind(app.workItems);
    let blocked = false;
    const locking = t.mock.method(
        app.workItems,
        "withControl",
        async <T>(id: ConversationId, operation: () => Promise<T>): Promise<T> => {
            if (id === controller && !blocked) {
                blocked = true;
                await held.promise;
            }

            return original(id, operation);
        },
    );

    reconciliation = app.pip.orchestration.open();
    await until(() => blocked, "the old observation to reach control-lock acquisition");
    await app.pip.orchestration.control(source, owner(app), { action: "pause" });
    const renewed = await activateWorkPip(app, source, owner(app), {});

    assert.equal(renewed.orchestration!.status, "running");
    held.resolve();
    await reconciliation;
    const afterStale = await app.pip.orchestration.inspect(source, owner(app));

    assert.equal(afterStale.orchestration!.status, "running");
    assert.equal(afterStale.orchestration!.epoch, renewed.orchestration!.epoch);
    locking.mock.restore();
    scheduling.mock.restore();
    await app.pip.orchestration.open();
    await until(async () => {
        const state = await app.harness.snapshot(PipWorkDoc, controller, context);

        if (
            state?.lastInput?.epoch !== renewed.orchestration!.epoch ||
            state.pending !== undefined ||
            app.isBusy(controller)
        ) {
            return false;
        }

        const requestId = state.lastInput.requestId;
        const submission = await app.harness.commit(
            (tx) => tx.submissionByRequest(controller, requestId),
            context,
        );

        return submission?.status === "done";
    }, "the renewed supervisor to accept and answer a fresh event");
    assert.equal(app.workItems.itemFor(source)!.supervisor!.status, "running");
    assert.equal(app.workItems.itemFor(source)!.supervisor!.epoch, renewed.orchestration!.epoch);
    assert.equal(
        (await app.harness.snapshot(PipWorkDoc, controller, context))!.reason,
        "Watching for new evidence.",
        "the resumed provider's wait must settle without another acknowledgement response",
    );
});

test("delayed human cancellation cannot abort a newer resumed supervisor input", async (t) => {
    for (const action of ["pause", "limits", "stop", "controller-stop", "input"]) {
        await t.test(action, async (t) => {
            const cancellation = Promise.withResolvers<void>();
            const response = Promise.withResolvers<void>();
            let holding = false;
            let resumed = false;
            const model = scriptedModel(async (request) => {
                if (isSupervisor(request) && resumed) {
                    holding = true;
                    await response.promise;

                    return text("The renewed supervisor is still authorized.");
                }

                return isSupervisor(request) && lastText(request).role === "user"
                    ? tool("work_supervise", { action: "wait", text: "Watching for new evidence." })
                    : text("Waiting for evidence.");
            });
            const app = await openApp(model, join(root, `stale-${action}-cancellation`));
            let pause: Promise<unknown> | undefined;

            t.after(async () => {
                cancellation.resolve();
                response.resolve();
                await pause?.catch(() => {});
                await app.close();
            });
            const { source, controller } = await watching(app);
            const original = app.workItems.withControl.bind(app.workItems);
            let delayed = false;
            const locking = t.mock.method(
                app.workItems,
                "withControl",
                async <T>(id: ConversationId, operation: () => Promise<T>): Promise<T> => {
                    const result = await original(id, operation);

                    if (
                        (id === source || (action === "controller-stop" && id === controller)) &&
                        !delayed
                    ) {
                        delayed = true;
                        await cancellation.promise;
                    }

                    return result;
                },
            );

            pause =
                action === "pause" || action === "limits"
                    ? app.pip.orchestration.control(source, owner(app), {
                          action,
                          ...(action === "limits"
                              ? {
                                    budget: null,
                                    expected: {
                                        workItemId: app.workItems.itemFor(source)!.id,
                                        conversationId: Number(controller),
                                        epoch: app.workItems.itemFor(source)!.supervisor!.epoch,
                                    },
                                }
                              : {}),
                      })
                    : action === "stop" || action === "controller-stop"
                      ? app.commands.abort(action === "stop" ? source : controller, owner(app))
                      : app.commands.submit(source, owner(app), {
                            requestId: "direct-human-direction",
                            text: "Observe this new direction.",
                        });
            await until(() => delayed, "the human fence to commit before its cancellation runs");
            resumed = true;
            await app.commands.submit(controller, owner(app), {
                requestId: "new-owner-direction",
                text: "Continue observing this Work Item under the new direction.",
            });
            await until(() => holding, "the resumed supervisor's real provider request");
            const input = (await app.harness.snapshot(PipWorkDoc, controller, context))!.lastInput!;

            cancellation.resolve();
            // Let any stale cancellation reach the held provider before its response is released.
            await new Promise<void>((resolve) => setImmediate(resolve));
            response.resolve();
            await pause;
            locking.mock.restore();
            await until(() => !app.isBusy(controller), "the renewed input to settle");
            const submission = await app.harness.commit(
                (tx) => tx.submissionByRequest(controller, input.requestId),
                context,
            );

            assert.equal(
                submission?.status,
                "done",
                "old management cannot cancel a new epoch's input",
            );
            assert.equal(app.workItems.itemFor(source)!.supervisor!.status, "running");
        });
    }
});

test("execution input fences an older controller activation that has not reached native admission", async (t) => {
    const app = await openApp(watchingModel(), join(root, "pending-activation-fence"));
    const held = Promise.withResolvers<void>();
    let pendingInput: Promise<unknown> | undefined;

    t.after(async () => {
        held.resolve();
        await pendingInput?.catch(() => {});
        await app.close();
    });
    const { source, controller } = await watching(app);

    app.pip.orchestration.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const original = app.pip.orchestration.personInput.bind(app.pip.orchestration);
    let waiting = false;

    t.mock.method(
        app.pip.orchestration,
        "personInput",
        async (...args: Parameters<typeof original>) => {
            await original(...args);

            if (args[0] === controller) {
                waiting = true;
                await held.promise;
            }
        },
    );
    pendingInput = app.commands.submit(controller, owner(app), {
        requestId: "older-controller-instruction",
        text: "Continue observing under this older direction.",
    });
    await until(() => waiting, "the controller fence before native input admission");
    const before = await app.harness.snapshot(PipWorkDoc, controller, context);
    const epoch = app.workItems.itemFor(source)!.supervisor!.epoch;

    assert.ok(before!.humanPending);
    await app.commands.submit(source, owner(app), {
        requestId: "newer-execution-instruction",
        text: "The human now directs this execution Thread instead.",
    });
    assert.equal(
        (await app.harness.snapshot(PipWorkDoc, controller, context))!.humanPending,
        undefined,
        "execution input must withdraw the older activation, even while its grant is reclaimed",
    );
    assert.ok(app.workItems.itemFor(source)!.supervisor!.epoch > epoch);
    held.resolve();
    await assert.rejects(pendingInput, /input was stopped/i);
    assert.equal(app.workItems.itemFor(source)!.supervisor!.status, "reclaimed");
    assert.equal(
        (await app.transcripts.allEntries(controller, true)).filter(
            (entry) => entry.kind === "user",
        ).length,
        1,
        "the stale controller instruction never reaches native admission",
    );
});

test("startup holds a token-revoked grant without dispatching a new supervisor request", async (t) => {
    const model = watchingModel();
    const directory = join(root, "revoked-owner-startup-fence");
    let app = await openApp(model, directory);

    t.after(async () => {
        await app.close();
    });
    const { source, controller } = await watching(app);
    const epoch = app.workItems.itemFor(source)!.supervisor!.epoch;

    app.pip.orchestration.close();
    app.config.rotateOwnerToken();
    await app.close();
    const requests = model.state.callCount;

    app = await openApp(model, directory);
    const recovered = await app.pip.orchestration.inspect(source, owner(app));

    assert.equal(recovered.orchestration!.conversationId, Number(controller));
    assert.equal(recovered.orchestration!.status, "reclaimed");
    assert.equal(recovered.orchestration!.epoch, epoch + 1);
    assert.match(recovered.orchestration!.reason!, /authority unavailable/i);
    assert.equal(
        model.state.callCount,
        requests,
        "startup must not dispatch using the revoked grant",
    );
    assert.equal(app.workItems.members(source).includes(controller), false);
});
