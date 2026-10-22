// Offline native registration/admission proof; only model decisions are scripted.
import assert from "node:assert/strict";
import { after, test, type TestContext } from "node:test";
import { join } from "node:path";
import type { ConversationId } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { awaitWithContext, withAbortSignal } from "@earendil-works/chord/context";
import {
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
import { PipWorkDoc } from "../src/server/docs.ts";
import {
    AgentSupervisionDoc,
    type AgentQuestionAnswerIntent,
} from "../src/server/pip/agent-supervision.ts";

after(cleanUp);

// Fixtures drive actual owner input, registered tools, native questions and receipts. No
// receipts, authority pins, answers or callback ordering are fabricated by the provider.
async function questioning(
    t: TestContext,
    name: string,
    onAnswer?: (signal?: AbortSignal) => Promise<ReturnType<typeof fauxAssistantMessage>>,
) {
    let source!: ConversationId;
    let controller!: ConversationId;
    let reply: { session: number; questionId: string; text: string } | undefined;
    const received: string[] = [];
    const executions: string[] = [];
    let asked = false;
    const app = await openApp(
        scriptedModel(async (request, options) => {
            const system = JSON.stringify(
                request.messages.filter((message) => message.role === "system"),
            );
            const last = lastText(request);

            if (system.includes("the owner's persistent private agent")) {
                if (last.role === "user") {
                    return fauxAssistantMessage(
                        [
                            fauxToolCall(
                                "agent_work",
                                reply === undefined
                                    ? {
                                          action: "delegate",
                                          session: Number(source),
                                          text: "Clarify the existing investigation scope.",
                                      }
                                    : { action: "answer", ...reply },
                            ),
                        ],
                        { stopReason: "toolUse" },
                    );
                }

                return fauxAssistantMessage("The native result is recorded.");
            }

            if (system.includes("the private supervisor for Work Item")) {
                if (last.text.includes("App delegation")) {
                    return fauxAssistantMessage(
                        [fauxToolCall("session_read", { session: Number(source) })],
                        { stopReason: "toolUse" },
                    );
                }

                if (!asked) {
                    asked = true;

                    return fauxAssistantMessage(
                        [
                            fauxToolCall("work_supervise", {
                                action: "ask",
                                text: "Investigate latency or clarity?",
                            }),
                        ],
                        { stopReason: "toolUse" },
                    );
                }

                received.push(last.text);

                return onAnswer === undefined
                    ? fauxAssistantMessage("Continue within the existing clarity-only scope.")
                    : onAnswer(options?.signal);
            }

            executions.push(last.text);

            return fauxAssistantMessage("Existing investigation evidence.");
        }),
        join(root, name),
    );

    t.after(() => app.close());
    source = await newSession(app, app.defaultCwd, "worker");
    const chat = (
        await app.pip.agents.create(owner(app), {
            name: "Tava",
            requestId: "question-agent",
        })
    ).id as ConversationId;

    await say(app, chat, "Coordinate the existing clarity investigation; do not implement.");
    controller = app.workItems.itemFor(source)!.supervisor!.conversationId as ConversationId;
    await until(
        async () =>
            (await app.harness.snapshot(PipWorkDoc, controller, context))?.question !== undefined,
        "real controller asks its native question",
    );
    await until(() => !app.isBusy(controller), "ask terminates native controller");
    const questionId = (await app.harness.snapshot(PipWorkDoc, controller, context))!.question!.id;

    const answer = async (overrides: Partial<NonNullable<typeof reply>> = {}) => {
        reply = {
            session: Number(controller),
            questionId,
            text: "Clarity only; do not implement.",
            ...overrides,
        };
        await say(
            app,
            chat,
            "The prior scope already answers this; use the exact native question.",
        );
        const entries = await app.transcripts.allEntries(chat, true);
        const result = entries.findLast(
            (entry) => entry.kind === "toolResult" && entry.name === "agent_work",
        );

        assert.ok(result?.kind === "toolResult");

        return result;
    };

    return { app, source, controller, chat, questionId, answer, received, executions };
}

// Existing coverage establishes that delegation is blocked, but cannot express a
// correlated, attributed private-agent answer or its request retry lifecycle.
test("a private agent answers the exact native question without impersonating its owner, and retries only its accepted payload", async (t) => {
    let target!: ConversationId;
    let turns = 0;
    const f = await questioning(t, "native-agent-question-answer", async () =>
        turns++ === 0
            ? fauxAssistantMessage(
                  [
                      fauxToolCall("session_send", {
                          session: Number(target),
                          message: "CLARITY_ONLY_CONTINUATION",
                          report: false,
                      }),
                  ],
                  { stopReason: "toolUse" },
              )
            : fauxAssistantMessage(
                  "The exact clarification was delegated and its actual receipt checked.",
              ),
    );
    const { app, source, controller, chat, questionId } = f;

    target = source;
    const nativeAnswer = app.pip.orchestration.answerFromAgent.bind(app.pip.orchestration);
    let sender: Parameters<typeof nativeAnswer>[3] | undefined;

    app.pip.orchestration.answerFromAgent = async (...args) => {
        sender = args[3];

        return nativeAnswer(...args);
    };

    const result = await f.answer();

    assert.equal(result.isError, false, result.text);
    const receipt = JSON.parse(result.text);

    assert.equal(receipt.status, "accepted", result.text);
    const completed = await (await app.harness.submission(receipt.submissionId, context))!.wait(
        context,
    );

    assert.equal(
        completed.status,
        "done",
        JSON.stringify(await app.transcripts.allEntries(controller, true)),
    );
    await until(
        () => f.executions.length === 1,
        "the actual execution recipient receives the controller's continuation",
    );
    assert.ok(f.received.length >= 2);
    await until(() => !app.isBusy(controller), "answer settles");
    const state = (await app.harness.snapshot(PipWorkDoc, controller, context))!;
    const saved = state.questions.find((question) => question.id === questionId)!;

    assert.equal(state.question, undefined);
    assert.equal(saved.answer!.text, "Clarity only; do not implement.");
    assert.deepEqual(
        saved.answer!.agent,
        {
            agentId: app.pip.agents.scope(chat)!.agentId,
            name: "Tava",
            chatId: Number(chat),
        },
        "the immutable reply identifies the actual agent and originating chat",
    );
    assert.equal(saved.answer!.submissionRequestId, receipt.requestId);
    const native = await (await app.harness.submission(receipt.submissionId, context))!.status(
        context,
    );

    assert.equal(native.conversationId, controller);
    assert.equal(
        native.status,
        "done",
        "acceptance is followed by actual controller generation and tool continuation",
    );
    assert.match(f.executions[0]!, /CLARITY_ONLY_CONTINUATION/);
    assert.match(native.requestId!, /^agent-answer-/, "agent input is not an owner input");
    assert.match(f.received[0]!, /Tava/);
    assert.match(f.received[0]!, /not a new owner instruction/i);
    assert.ok(f.received[0]!.includes(questionId));
    assert.equal(
        app.workItems.itemFor(source)!.supervisor!.agentId,
        app.pip.agents.scope(chat)!.agentId,
        "answer retains rather than reclaims its current parent grant",
    );
    const stored = Object.values(
        (await app.harness.snapshot(AgentSupervisionDoc, context))!.questionAnswers!,
    )[0]!;
    const { status: _status, submissionId: _submission, reason: _reason, ...intent } = stored;
    const retry = () =>
        app.pip.orchestration.answerFromAgent(controller, owner(app), intent, sender!);
    const repeated = await retry();

    assert.equal(Number(repeated.submissionId), receipt.submissionId);
    assert.equal(
        f.received.filter((text) => text.includes("App answer from private supervisor")).length,
        1,
        "identical native retry does not buy another answer generation",
    );

    for (const changed of [
        { text: "Implement outside the prior scope." },
        { questionId: "q-other" },
        { chatId: Number(source) },
        { controllerEpoch: intent.controllerEpoch + 1 },
    ]) {
        const different: AgentQuestionAnswerIntent = { ...intent, ...changed };

        await assert.rejects(
            app.pip.orchestration.answerFromAgent(controller, owner(app), different, sender!),
            /reply|answer|intent|payload|grant|changed|source|question/i,
        );
    }

    assert.equal(
        f.received.filter((text) => text.includes("App answer from private supervisor")).length,
        1,
    );
    assert.equal(
        (await app.harness.snapshot(PipWorkDoc, controller, context))!.questions.length,
        1,
    );
});

for (const queuedOutcome of ["resume", "owner-replaces", "access-loss"] as const) {
    test(`a genuinely queued agent answer ${queuedOutcome} retains its question until native placement`, async (t) => {
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        let calls = 0;
        const f = await questioning(
            t,
            `native-agent-answer-queued-${queuedOutcome}`,
            async (signal) => {
                if (calls++ === 0) {
                    await awaitWithContext(
                        held,
                        signal === undefined ? context : withAbortSignal(signal, context),
                    );
                }

                return fauxAssistantMessage("Only existing work scope was observed.");
            },
        );
        const { app, controller, questionId } = f;

        t.after(release);
        // A harmless native service observation keeps an existing, already-running grant
        // busy. The agent answer itself still comes only from its real registered source
        // invocation; this fixture does not fabricate that intent, receipt or human input.
        await (
            await app.conversation(controller)
        ).submit(
            {
                type: "input",
                requestId: "native-test-observation",
                content: "Existing work observation; no new owner instructions.",
            },
            context,
        );
        await until(
            () => calls === 1,
            "native controller observation really waits in its provider",
        );
        const result = await f.answer();

        assert.equal(result.isError, false, result.text);
        const receipt = JSON.parse(result.text);
        const queued = await (await app.harness.submission(receipt.submissionId, context))!.status(
            context,
        );

        assert.equal(queued.status, "queued");
        assert.equal(queued.entry, undefined);
        const waiting = (await app.harness.snapshot(PipWorkDoc, controller, context))!;

        assert.equal(waiting.question!.id, questionId);
        assert.equal(waiting.question!.answer!.agent!.name, "Tava");
        assert.equal(waiting.questions.length, 0, "native queue admission is not native placement");

        if (queuedOutcome === "resume") {
            const tab = fakeTab(controller, owner(app));

            (await app.room(controller)).push(tab.client, true);
            const item = (
                tab.last("view")?.inbox as { id: number; text: string; editableText?: string }[]
            ).find((entry) => entry.id === receipt.submissionId)!;

            assert.ok(item);
            await assert.rejects(
                app.commands.editQueued(
                    controller,
                    owner(app),
                    receipt.submissionId,
                    "Changed by a human, not the captured agent decision.",
                    item.text,
                ),
                /application event|agent answer|service input/i,
                "human edits must not inherit native agent attribution or diverge from the saved answer",
            );
            assert.equal(item.editableText, undefined, "trusted service input has no Edit control");
        }

        if (queuedOutcome === "access-loss") {
            app.config.rotateOwnerToken();
            release();
            const denied = await (await app.harness.submission(
                receipt.submissionId,
                context,
            ))!.wait(context);

            assert.equal(denied.status, "unanswered");
            assert.equal(calls, 1, "revoked queued source cannot invoke the controller's model");
        }

        if (queuedOutcome !== "resume") {
            const ownerReply = await app.commands.submit(controller, owner(app), {
                text: "Fresh owner decision: latency only.",
                requestId: "owner-overrides-queued-agent",
                pipQuestionId: questionId,
            });
            const human = await (await app.harness.submission(
                ownerReply.submissionId,
                context,
            ))!.wait(context);

            assert.equal(human.status, "done");
            const discarded = await (await app.harness.submission(
                receipt.submissionId,
                context,
            ))!.wait(context);

            assert.equal(
                discarded.status,
                "unanswered",
                "the superseded queued agent reply never acquires a newer human epoch",
            );
        } else {
            release();
            const done = await (await app.harness.submission(receipt.submissionId, context))!.wait(
                context,
            );

            assert.equal(done.status, "done");
            assert.equal(calls, 2);
        }

        const finished = (await app.harness.snapshot(PipWorkDoc, controller, context))!;
        const saved = finished.questions.find((entry) => entry.id === questionId)!;

        assert.equal(finished.question, undefined);
        assert.equal(finished.questions.length, 1);
        assert.equal(saved.answer!.agent?.name, queuedOutcome === "resume" ? "Tava" : undefined);

        if (queuedOutcome !== "resume") {
            assert.equal(saved.supersededAnswers!.length, 1);
            assert.equal(saved.supersededAnswers![0]!.agent!.name, "Tava");
            assert.equal(
                saved.supersededAnswers![0]!.submissionRequestId,
                receipt.requestId,
                "the rejected/superseded agent reply retains its exact historical attribution and native receipt",
            );
        }
    });
}

for (const boundary of ["refused", "ack-lost"] as const) {
    test(`native agent answer ${boundary} saves no pre-admission reply and recovers only actual acceptance`, async (t) => {
        const f = await questioning(t, `native-agent-answer-${boundary}`);
        const { app, controller, questionId } = f;
        const original = app.pip.orchestration.answerFromAgent.bind(app.pip.orchestration);
        let inspected = false;

        app.pip.orchestration.answerFromAgent = (id, user, intent, sender) =>
            original(
                id,
                user,
                intent,
                new Proxy(sender, {
                    get(target, field, receiver) {
                        if (field !== "submit") {
                            return Reflect.get(target, field, receiver);
                        }

                        return async (...args: Parameters<typeof sender.submit>) => {
                            const pending = (await app.harness.snapshot(
                                PipWorkDoc,
                                controller,
                                context,
                            ))!.question!;

                            assert.equal(
                                pending.answer,
                                undefined,
                                "no answer can be saved before real native acceptance",
                            );
                            inspected = true;

                            if (boundary === "refused") {
                                throw new Error("Native input rejected before acceptance");
                            }

                            await sender.submit(...args);

                            throw new Error("Native acknowledgement lost after actual acceptance");
                        };
                    },
                }),
            );
        const result = await f.answer();

        assert.equal(inspected, true);
        const after = (await app.harness.snapshot(PipWorkDoc, controller, context))!;

        if (boundary === "refused") {
            assert.equal(result.isError, true, result.text);
            assert.equal(after.question!.id, questionId);
            assert.equal(
                after.question!.answer,
                undefined,
                "failed source admission cannot trap the owner's next reply",
            );
            assert.equal(f.received.length, 0);
            await app.commands.submit(controller, owner(app), {
                text: "Owner now chooses clarity only.",
                requestId: "owner-after-refusal",
                pipQuestionId: questionId,
            });
            await until(() => !app.isBusy(controller), "owner's real composer answer settles");
            const recovered = (await app.harness.snapshot(PipWorkDoc, controller, context))!;

            assert.equal(recovered.question, undefined);
            assert.equal(
                recovered.questions.find((question) => question.id === questionId)!.answer!.agent,
                undefined,
            );
        } else {
            assert.equal(result.isError, false, result.text);
            const receipt = JSON.parse(result.text);
            const native = await (await app.harness.submission(
                receipt.submissionId,
                context,
            ))!.wait(context);

            assert.equal(native.status, "done");
            assert.equal(
                f.received.length,
                1,
                "lost acknowledgement buys no repeated model response",
            );
            const recovered = (await app.harness.snapshot(PipWorkDoc, controller, context))!;

            assert.equal(recovered.question, undefined);
            assert.equal(
                recovered.questions.find((question) => question.id === questionId)!.answer!.agent!
                    .name,
                "Tava",
            );
        }
    });
}

for (const mismatch of ["question", "recipient", "reclaimed"] as const) {
    test(`a private-agent answer rejects a ${mismatch} mismatch without waking or clearing the question`, async (t) => {
        const f = await questioning(t, `native-agent-answer-${mismatch}`);
        const { app, source, controller, questionId } = f;

        if (mismatch === "reclaimed") {
            await app.pip.orchestration.control(controller, owner(app), { action: "pause" });
        }

        const before = app.workItems.itemFor(source)!.supervisor!;
        const result = await f.answer(
            mismatch === "question"
                ? { questionId: "q-wrong" }
                : mismatch === "recipient"
                  ? { session: Number(source) }
                  : {},
        );

        assert.equal(result.isError, true, result.text);
        assert.match(
            result.text,
            mismatch === "question"
                ? /exact pending question/
                : mismatch === "recipient"
                  ? /exact controller already attached/
                  : /revoked|changed|attach/,
        );
        assert.equal(f.received.length, 0, "refusal does not activate controller reasoning");
        assert.equal(
            (await app.harness.snapshot(PipWorkDoc, controller, context))!.question!.id,
            questionId,
        );
        const after = app.workItems.itemFor(source)!.supervisor!;

        assert.equal(after.epoch, before.epoch);
        assert.equal(after.status, before.status);
        assert.equal(after.actions, before.actions);

        if (mismatch === "question") {
            const replies = Object.values(
                (await app.harness.snapshot(AgentSupervisionDoc, context))!.questionAnswers!,
            );

            assert.equal(replies.length, 1);
            assert.equal(replies[0]!.questionId, "q-wrong");
            assert.equal(
                replies[0]!.status,
                "blocked",
                "a rejected payload retains its exact invocation tombstone",
            );
            assert.equal(replies[0]!.submissionId, undefined);
        }
    });
}

test("a newer actually accepted owner input fences an admitted agent reply before downstream effects", async (t) => {
    let entered!: () => void;
    let release!: () => void;
    let target!: ConversationId;
    const atProvider = new Promise<void>((resolve) => {
        entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    const f = await questioning(t, "native-agent-answer-newer-owner", async () => {
        entered();
        await held;

        return fauxAssistantMessage(
            [
                fauxToolCall("session_send", {
                    session: Number(target),
                    message: "STALE_AGENT_REPLY_EFFECT",
                }),
            ],
            { stopReason: "toolUse" },
        );
    });

    target = f.source;
    t.after(release);
    const result = await f.answer();

    assert.equal(result.isError, false, result.text);
    const receipt = JSON.parse(result.text);

    await atProvider;
    await say(f.app, f.chat, "New owner direction: withdraw that previous decision and wait.");
    release();
    const status = await (await f.app.harness.submission(receipt.submissionId, context))!.wait(
        context,
    );

    assert.equal(
        status.status,
        "unanswered",
        "accepted native input was later fenced, not certified successful",
    );
    assert.equal(
        f.executions.length,
        0,
        "a completed source tool must not lend its authority to a superseded effect",
    );
    assert.equal(
        f.received.length,
        1,
        "stale reply does not purchase a fresh acknowledgement round",
    );
});

test("owner access loss between prepared agent reply and native admission cannot wake the controller", async (t) => {
    const f = await questioning(t, "native-agent-answer-access-loss");
    const { app, controller, chat, questionId } = f;
    const original = app.pip.orchestration.answerFromAgent.bind(app.pip.orchestration);
    let entered!: () => void;
    let release!: () => void;
    const atAdmission = new Promise<void>((resolve) => {
        entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });

    // Delay, but do not replace, the actual production acceptance method. Authority is
    // revoked after the registered tool saves its real intent and before native admission.
    app.pip.orchestration.answerFromAgent = async (...args) => {
        entered();
        await held;

        return original(...args);
    };

    t.after(release);
    const answering = f.answer();

    await atAdmission;
    app.config.rotateOwnerToken();
    release();
    await answering;
    await until(() => !app.isBusy(chat), "revoked source settles");
    assert.equal(f.received.length, 0);
    assert.equal(
        (await app.harness.snapshot(PipWorkDoc, controller, context))!.question!.id,
        questionId,
    );
    const stored = Object.values(
        (await app.harness.snapshot(AgentSupervisionDoc, context))!.questionAnswers!,
    )[0]!;

    assert.notEqual(stored.status, "accepted");
    assert.equal(stored.submissionId, undefined);
    const native = await app.harness.commit(
        (tx) => tx.submissionByRequest(controller, stored.requestId),
        context,
    );

    assert.equal(native, undefined, "no revoked native input was admitted");
});
