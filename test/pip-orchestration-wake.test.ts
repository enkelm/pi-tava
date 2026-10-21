import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import { awaitWithContext } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { PipWorkDoc } from "../src/server/docs.ts";
import { clientKey, requestFor } from "../src/server/requests.ts";
import {
    activateWorkPip,
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    root,
    recordCost,
    scriptedModel,
    until,
} from "./helpers.ts";

after(cleanUp);

test("restart recovers an accepted work wake before its cursor settles, without buying or sending a second input", async (t) => {
    let calls = 0;
    const model = scriptedModel((request) => {
        if (
            JSON.stringify(
                request.messages.filter((message) => message.role === "system"),
            ).includes("the private supervisor for Work Item")
        ) {
            calls++;
        }

        return fauxAssistantMessage([fauxText("Observed; no further task was requested.")]);
    });
    const directory = join(root, "orchestrator-wake-replay");
    let app = await openApp(model, directory);
    const held = Promise.withResolvers<void>();
    let interrupted = false;
    const phases = app.pip.orchestration.task.definition.phases;
    const original = phases.wake;
    const phase = t.mock.method(phases, "wake", async (...args: Parameters<typeof original>) => {
        const runtime = args[1];
        const commit = runtime.commit.bind(runtime);

        t.mock.method(runtime, "commit", async (...[change, ctx]: Parameters<typeof commit>) => {
            const state = await runtime.snapshot(PipWorkDoc, runtime.conversationId, ctx);
            const pending = state?.pending;

            if (!interrupted && pending !== undefined) {
                const key = requestFor(owner(app).id, clientKey(pending.requestId));
                const accepted = await app.harness.commit(
                    (tx) => tx.submissionByRequest(runtime.conversationId, key),
                    ctx,
                );

                if (accepted !== undefined) {
                    interrupted = true;
                    await awaitWithContext(held.promise, ctx);
                }
            }

            return commit(change, ctx);
        });

        return original(...args);
    });

    t.after(async () => {
        held.resolve();
        phase.mock.restore();
        await app.close();
    });
    const source = await newSession(app, app.defaultCwd, "worker");
    const started = await activateWorkPip(app, source, owner(app), {
        text: "Observe this work once, without polling or resending.",
        budget: 5,
        maxActions: 10,
    });
    const controller = started.orchestration!.conversationId as ConversationId;

    await until(() => calls === 1 && !app.isBusy(controller), "the owner instruction to settle");
    await app.reviews.comment(source, owner(app), {
        requestId: "wake-after-owner-input",
        text: "New evidence for the active PiP to observe.",
    });
    await until(
        () => interrupted && calls === 2 && !app.isBusy(controller),
        "native accepted wake and answer before cursor settlement",
    );
    assert.ok(
        (await app.harness.snapshot(PipWorkDoc, controller, context))?.pending,
        "the durable wake intent exists before the interrupted receipt settlement",
    );
    await app.close();
    held.resolve();
    phase.mock.restore();
    app = await openApp(model, directory);
    await until(async () => {
        const state = await app.harness.snapshot(PipWorkDoc, controller, context);

        return state?.pending === undefined && state?.observed !== "" && !app.isBusy(controller);
    }, "native wake receipt recovery");
    assert.equal(calls, 2, "recovery must not regenerate an already answered event");
    const inputs = (await app.transcripts.allEntries(controller, true)).filter(
        (entry) => entry.kind === "user",
    );

    assert.equal(inputs.length, 2, "the owner instruction and exactly one event wake remain");
    assert.equal(app.workItems.itemFor(source)!.supervisor!.status, "running");
});

test("restart recovers a committed finish report without another provider request or counted action", async (t) => {
    const report =
        "Inspected the recorded evidence.\nNo code correctness or publication approval was claimed.";
    let calls = 0;
    const model = scriptedModel((request) => {
        if (
            !JSON.stringify(
                request.messages.filter((message) => message.role === "system"),
            ).includes("the private supervisor for Work Item")
        ) {
            return fauxAssistantMessage([fauxText("Execution report.")]);
        }

        calls++;

        return fauxAssistantMessage(
            [fauxToolCall("work_supervise", { action: "finish", text: report })],
            { stopReason: "toolUse" },
        );
    });
    const directory = join(root, "orchestrator-finish-replay");
    let app = await openApp(model, directory);
    const held = Promise.withResolvers<void>();
    const original = app.pip.orchestration.supervise.bind(app.pip.orchestration);
    let originalOutput: Awaited<ReturnType<typeof original>> | undefined;
    const interrupted = t.mock.method(
        app.pip.orchestration,
        "supervise",
        async (...args: Parameters<typeof original>) => {
            const result = await original(...args);

            originalOutput = result;
            await awaitWithContext(held.promise, args[1]);

            return result;
        },
    );

    t.after(async () => {
        held.resolve();
        interrupted.mock.restore();
        await app.close();
    });
    const source = await newSession(app, app.defaultCwd, "worker");
    const started = await activateWorkPip(app, source, owner(app), {
        text: "Finish with an honest evidence-based report.",
        budget: 5,
        maxActions: 1,
    });
    const controller = started.orchestration!.conversationId as ConversationId;

    await until(
        () => originalOutput !== undefined,
        "finish to commit before its native tool result settles",
    );
    const before = await app.pip.orchestration.inspect(source, owner(app));

    assert.equal(before.orchestration!.status, "reclaimed");
    assert.equal(before.orchestration!.reason, report);
    assert.equal(before.orchestration!.actions, 1);
    await app.close();
    held.resolve();
    interrupted.mock.restore();
    app = await openApp(model, directory);
    await until(async () => {
        const entries = await app.transcripts.allEntries(controller, true);

        return (
            !app.isBusy(controller) &&
            entries.some((entry) => entry.kind === "toolResult" && entry.name === "work_supervise")
        );
    }, "the interrupted native finish result to recover");
    const entries = await app.transcripts.allEntries(controller, true);
    const results = entries
        .filter((entry) => entry.kind === "toolResult")
        .filter((entry) => entry.name === "work_supervise");

    assert.equal(results.length, 1, "the same native finish call must settle exactly once");
    const result = results[0]!;

    assert.equal(result.isError, false, result.text);
    const output = JSON.parse(result.text);

    assert.equal(output.action, "finish");
    assert.equal(output.report, report);
    assert.deepEqual(
        output,
        originalOutput,
        "replay must return the original successful finish output",
    );
    assert.equal(calls, 1, "a saved finish report must not buy another provider request");
    assert.equal(entries.filter((entry) => entry.kind === "user").length, 1);
    const recovered = await app.pip.orchestration.inspect(source, owner(app));

    assert.equal(recovered.orchestration!.status, "reclaimed");
    assert.equal(recovered.orchestration!.reason, report);
    assert.equal(
        recovered.orchestration!.actions,
        1,
        "finish replay cannot consume another action",
    );
    assert.equal(recovered.orchestration!.epoch, before.orchestration!.epoch);
});

for (const recovery of ["session-budget", "limits", "stop"]) {
    test(`a saved composer reply survives restart and recovers after ${recovery} without renewing stale replies`, async (t) => {
        let step = 0;
        const model = scriptedModel((request) => {
            if (
                !JSON.stringify(
                    request.messages.filter((message) => message.role === "system"),
                ).includes("the private supervisor for Work Item")
            ) {
                return fauxAssistantMessage([fauxText("Execution report.")]);
            }

            const plan = [
                () =>
                    fauxAssistantMessage(
                        [
                            fauxToolCall("work_supervise", {
                                action: "ask",
                                text: "May I continue the first investigation?",
                            }),
                        ],
                        { stopReason: "toolUse" },
                    ),
                () =>
                    fauxAssistantMessage(
                        [
                            fauxToolCall("work_supervise", {
                                action: "ask",
                                text: "May I continue the second investigation?",
                            }),
                        ],
                        { stopReason: "toolUse" },
                    ),
                () =>
                    fauxAssistantMessage(
                        [
                            fauxToolCall("work_supervise", {
                                action: "finish",
                                text: "Both exact human decisions were received; no publication approval was implied.",
                            }),
                        ],
                        { stopReason: "toolUse" },
                    ),
            ];
            const next = plan[step++];

            assert.ok(next, "only admitted human decisions may advance this investigation");

            return next();
        });
        const directory = join(root, `orchestrator-answer-admission-${recovery}`);
        let app = await openApp(model, directory);

        t.after(async () => {
            await app.close();
        });
        const source = await newSession(app, app.defaultCwd, "worker");
        const started = await activateWorkPip(app, source, owner(app), {
            text: "Ask for two separate human decisions.",
            budget: recovery === "limits" ? 0.01 : 5,
            maxActions: 10,
        });
        const controller = started.orchestration!.conversationId as ConversationId;

        await until(
            async () =>
                (await app.harness.snapshot(PipWorkDoc, controller, context))?.question !==
                    undefined && !app.isBusy(controller),
            "first material question",
        );
        const first = (await app.harness.snapshot(PipWorkDoc, controller, context))!.question!;
        const requestId = "same-client-id-" + "x".repeat(82);

        if (recovery !== "limits") {
            await app.spend.setSessionBudget(owner(app), controller, 0.01);
        }

        await recordCost(app, controller, 0.02);
        await assert.rejects(
            app.commands.submit(controller, owner(app), {
                pipQuestionId: first.id,
                requestId,
                text: "Continue the first investigation only.",
            }),
            /spend limit/,
        );
        const blocked = (await app.pip.orchestration.inspect(source, owner(app))).orchestration!;

        assert.equal(blocked.question?.id, first.id, "saving an answer is not native acceptance");
        assert.deepEqual(blocked.question?.answer, {
            text: "Continue the first investigation only.",
            requestId,
        });
        const savedAnswer = (await app.harness.snapshot(PipWorkDoc, controller, context))!.question!
            .answer!;

        assert.equal(
            await app.commands.submissionReceipt(controller, owner(app), requestId),
            undefined,
        );
        assert.equal(step, 1);
        await app.close();
        app = await openApp(model, directory);
        assert.deepEqual(
            (await app.pip.orchestration.inspect(source, owner(app))).orchestration!.question,
            blocked.question,
            "the private chat can recover the exact saved answer and request ID",
        );
        assert.equal(step, 1, "an unadmitted answer is not automatically regenerated on startup");
        let acceptedRequestId = requestId;
        let acceptedText = "Continue the first investigation only.";

        if (recovery === "limits") {
            const current = (await app.pip.orchestration.inspect(source, owner(app)))
                .orchestration!;

            await app.pip.orchestration.control(source, owner(app), {
                action: "limits",
                budget: 1,
                expected: {
                    workItemId: current.workItemId,
                    conversationId: current.conversationId,
                    epoch: current.epoch,
                },
            });
        } else if (recovery === "stop") {
            await app.commands.abort(controller, owner(app));
        }

        if (recovery !== "limits") {
            await app.spend.setSessionBudget(owner(app), controller, null);
        }

        if (recovery !== "session-budget") {
            const fenced = app.workItems.itemFor(source)!.supervisor!;

            assert.ok(fenced.epoch > savedAnswer.epoch!);
            assert.equal(fenced.status, "reclaimed");
            await assert.rejects(
                app.commands.submit(controller, owner(app), {
                    pipQuestionId: first.id,
                    requestId,
                    text: savedAnswer.text,
                }),
                /unavailable or was stopped/,
            );
            assert.deepEqual(
                (await app.harness.snapshot(PipWorkDoc, controller, context))!.question!.answer,
                savedAnswer,
                "stale retries retain their original text and authority fence",
            );
            assert.equal(step, 1, "neither the fence nor a stale retry buys a generation");
            acceptedRequestId = "fresh-owner-decision";
            acceptedText =
                recovery === "limits"
                    ? "I reconsidered: continue the first investigation with the new limit."
                    : savedAnswer.text;
        } else {
            await assert.rejects(
                app.commands.submit(controller, owner(app), {
                    pipQuestionId: first.id,
                    requestId: "cannot-replace-without-a-fence",
                    text: "A changed decision before any fence.",
                }),
                /different answer/,
            );
        }

        const accepted = await app.commands.submit(controller, owner(app), {
            pipQuestionId: first.id,
            requestId: acceptedRequestId,
            text: acceptedText,
        });

        await until(
            async () =>
                (await app.harness.snapshot(PipWorkDoc, controller, context))?.question?.id !==
                    first.id &&
                step === 2 &&
                !app.isBusy(controller),
            "second independent question",
        );
        const settled = (await app.harness.snapshot(PipWorkDoc, controller, context))!;
        const second = settled.question!;

        assert.deepEqual(
            settled.questions[0]!.supersededAnswers,
            recovery === "session-budget" ? undefined : [savedAnswer],
        );
        assert.deepEqual(
            await app.commands.submissionReceipt(controller, owner(app), acceptedRequestId),
            accepted,
        );
        assert.deepEqual(
            await app.commands.submit(controller, owner(app), {
                pipQuestionId: first.id,
                requestId: acceptedRequestId,
                text: acceptedText,
            }),
            accepted,
            "an admitted decision keeps its original receipt, without another submission",
        );

        if (recovery !== "session-budget") {
            await assert.rejects(
                app.commands.submit(controller, owner(app), {
                    pipQuestionId: first.id,
                    requestId,
                    text: savedAnswer.text,
                }),
                /superseded/,
            );
            await assert.rejects(
                app.commands.submit(controller, owner(app), {
                    requestId,
                    text: savedAnswer.text,
                }),
                /superseded/,
                "a delayed submission without question correlation cannot inherit new authority",
            );
            await assert.rejects(
                app.commands.submit(controller, owner(app), {
                    pipQuestionId: second.id,
                    requestId,
                    text: "An old request cannot answer the next question either.",
                }),
                /superseded/,
            );
            assert.equal(
                await app.commands.submissionReceipt(controller, owner(app), requestId),
                undefined,
            );
        }

        assert.notEqual(second.id, first.id);
        await assert.rejects(
            app.commands.submit(controller, owner(app), {
                pipQuestionId: second.id,
                requestId: acceptedRequestId,
                text: "Continue the second investigation only.",
            }),
            /already used for another input/,
        );
        await assert.rejects(
            app.commands.submit(controller, owner(app), {
                pipQuestionId: first.id,
                requestId: "late-stale-reply",
                text: "An old tab answered the previous question.",
            }),
            /different answer/,
        );
        await app.commands.submit(controller, owner(app), {
            pipQuestionId: second.id,
            requestId: "second-independent-answer",
            text: "Continue the second investigation only.",
        });
        await app.harness.waitForIdle(context);
        assert.equal(
            step,
            3,
            "the second question's decision is a new native input, not a replay of the first answer",
        );
        const state = await app.harness.snapshot(PipWorkDoc, controller, context);
        const inputs = (await app.transcripts.allEntries(controller, true)).filter(
            (entry) => entry.kind === "user",
        );

        assert.equal(inputs.length, 3);
        assert.equal(state!.questions.length, 2);
        assert.equal(state!.questions[0]!.answer!.text, acceptedText);
        assert.equal(state!.questions[1]!.answer!.text, "Continue the second investigation only.");
        assert.equal(app.workItems.itemFor(source)!.supervisor!.status, "reclaimed");
        await app.close();
        app = await openApp(model, directory);
        assert.deepEqual(
            (await app.harness.snapshot(PipWorkDoc, controller, context))!.questions,
            state!.questions,
            "restart retains both the final decision and any superseded, unadmitted reply",
        );
        assert.deepEqual(
            await app.commands.submit(controller, owner(app), {
                pipQuestionId: first.id,
                requestId: acceptedRequestId,
                text: acceptedText,
            }),
            accepted,
        );
        assert.equal(
            app.workItems.itemFor(source)!.supervisor!.status,
            "reclaimed",
            "receipt recovery cannot reactivate PiP",
        );
        assert.equal(step, 3);
    });
}

for (const chat of [false, true]) {
    test(`startup settles an accepted ${chat ? "composer" : "legacy"} answer without another input or generation`, async (t) => {
        let calls = 0;
        const model = scriptedModel((request) => {
            if (
                !JSON.stringify(
                    request.messages.filter((message) => message.role === "system"),
                ).includes("the private supervisor for Work Item")
            ) {
                return fauxAssistantMessage([fauxText("Execution report.")]);
            }

            calls++;

            return calls === 1
                ? fauxAssistantMessage(
                      [
                          fauxToolCall("work_supervise", {
                              action: "ask",
                              text: "Should the investigation continue?",
                          }),
                      ],
                      { stopReason: "toolUse" },
                  )
                : fauxAssistantMessage([fauxText("Decision observed; no new execution claimed.")]);
        });
        const directory = join(root, `orchestrator-answer-settlement-${chat}`);
        let app = await openApp(model, directory);

        t.after(async () => {
            await app.close();
        });
        const source = await newSession(app, app.defaultCwd, "worker");
        const started = await activateWorkPip(app, source, owner(app), {
            text: "Record the exact human decision before continuing.",
            budget: 5,
            maxActions: 10,
        });
        const controller = started.orchestration!.conversationId as ConversationId;

        await until(
            async () =>
                (await app.harness.snapshot(PipWorkDoc, controller, context))?.question !==
                    undefined && !app.isBusy(controller),
            "question and initial response",
        );
        const question = (await app.harness.snapshot(PipWorkDoc, controller, context))!.question!;

        app.pip.orchestration.close();
        await new Promise<void>((resolve) => setImmediate(resolve));
        const settlement = t.mock.method(app.pip.orchestration, "personAccepted", async () => {
            throw new Error("Interrupted after real native admission, before question settlement");
        });

        await assert.rejects(
            chat
                ? app.commands.submit(controller, owner(app), {
                      pipQuestionId: question.id,
                      requestId: "accepted-decision",
                      text: "Continue this investigation.",
                  })
                : app.pip.orchestration.control(source, owner(app), {
                      action: "answer",
                      questionId: question.id,
                      requestId: "accepted-decision",
                      text: "Continue this investigation.",
                  }),
            /before question settlement/,
        );
        await app.harness.waitForIdle(context);
        const pending = await app.harness.snapshot(PipWorkDoc, controller, context);

        assert.equal(pending!.question!.answer!.text, "Continue this investigation.");
        assert.equal(calls, 2);
        await assert.rejects(
            app.commands.submit(controller, owner(app), {
                pipQuestionId: question.id,
                requestId: "cannot-replace-an-admitted-decision",
                text: "A different decision cannot replace an admitted reply.",
            }),
            /different answer/,
        );
        await app.close();
        settlement.mock.restore();
        app = await openApp(model, directory);
        const recovered = await app.harness.snapshot(PipWorkDoc, controller, context);

        assert.equal(recovered!.question, undefined);
        assert.equal(recovered!.humanPending, undefined);
        assert.equal(recovered!.questions.length, 1);
        assert.equal(recovered!.questions[0]!.id, question.id);
        assert.equal(recovered!.questions[0]!.answer!.text, "Continue this investigation.");
        assert.equal(
            calls,
            2,
            "the saved native acceptance is recovery, not permission to regenerate",
        );
        assert.equal(
            (await app.transcripts.allEntries(controller, true)).filter(
                (entry) => entry.kind === "user",
            ).length,
            2,
        );
    });
}
