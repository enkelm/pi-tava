// Registered sends and native placement own attribution; only provider decisions are scripted.
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
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
} from "./helpers.ts";
import { PipWorkDoc } from "../src/server/docs.ts";
import { AgentSupervisionDoc } from "../src/server/pip/agent-supervision.ts";

const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
    fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

after(cleanUp);

// Existing question-answer tests cover correlated replies, and controller-queue tests cover
// one send during an owner turn. Neither has two accepted assignments in one controller epoch
// with a registered parent waiting on the newer, still-unseen input.
for (const placement of ["queued", "placed"] as const) {
    test(`controller question attribution with ${placement} S2 in the same epoch`, async (t) => {
        const initial = Promise.withResolvers<void>();
        const next = Promise.withResolvers<void>();
        const questionText = "Which bounded option is authorized for this exact assignment?";
        const notices: string[] = [];
        const controllerUsers: string[][] = [];
        let controller!: ConversationId;
        let source!: ConversationId;
        let parentStep = 0;
        let secondRequest: string | undefined;
        const app = await openApp(
            scriptedModel(async (request, options) => {
                const system = JSON.stringify(
                    request.messages.filter((message) => message.role === "system"),
                );
                const last = lastText(request);
                const ctx = options?.signal ? withAbortSignal(options.signal, context) : context;

                if (system.includes("the owner's persistent private agent")) {
                    if (last.role === "user" && last.text.includes("App registered continuation")) {
                        notices.push(last.text);

                        return tool("work_supervise", {
                            action: "ask",
                            text: "Inspect the exact native outcome before any more work.",
                        });
                    }

                    if (parentStep++ === 0) {
                        return tool("agent_work", {
                            action: "send",
                            session: Number(controller),
                            text: "S1: inspect only the first bounded scope.",
                            report: false,
                        });
                    }

                    assert.equal(last.role, "toolResult");
                    const receipt = JSON.parse(last.text);

                    assert.equal(receipt.status, "accepted", last.text);

                    if (parentStep === 2) {
                        return tool("agent_work", {
                            action: "send",
                            session: Number(controller),
                            text: "S2: inspect the second bounded scope after it is read.",
                            report: false,
                        });
                    }

                    assert.equal(parentStep, 3, "no unsolicited parent acknowledgement round");
                    secondRequest = receipt.requestId;
                    assert.ok(secondRequest, "wait retains the actual accepted S2 request");

                    return tool("work_supervise", {
                        action: "wait",
                        text: "Wait for S2's own native outcome.",
                        continuation: {
                            requestId: secondRequest,
                            remaining:
                                "Inspect S2's actual evidence; do not advance on S1's outcome.",
                        },
                    });
                }

                if (system.includes("the private supervisor for Work Item")) {
                    controllerUsers.push(
                        request.messages
                            .filter((message) => message.role === "user")
                            .map((message) => lastText({ messages: [message] }).text),
                    );

                    if (controllerUsers.length === 1) {
                        await awaitWithContext(initial.promise, ctx);

                        if (placement === "placed") {
                            return tool("work_context", {
                                action: "status",
                                session: Number(source),
                            });
                        }
                    } else {
                        await awaitWithContext(next.promise, ctx);
                    }

                    return tool("work_supervise", { action: "ask", text: questionText });
                }

                return fauxAssistantMessage("Unrelated naming fixture.");
            }),
            join(root, `assignment-question-${placement}`),
        );

        t.after(async () => {
            initial.resolve();
            next.resolve();
            await app.close();
        });
        source = await newSession(app, app.defaultCwd, "worker");
        controller = (await app.pip.orchestration.control(source, owner(app), { action: "open" }))
            .orchestration!.conversationId as ConversationId;
        const chat = (
            await app.pip.agents.create(owner(app), {
                name: "Exact assignment parent",
                requestId: `create-question-parent-${placement}`,
            })
        ).id as ConversationId;

        // Both sends derive from this one accepted owner instruction, not a superseding input.
        await say(app, chat, "Send S1 and S2 within this inspection scope, then wait on S2 only.");
        await until(() => controllerUsers.length === 1, "S1's actual provider request is held");
        const before = (await app.harness.snapshot(AgentSupervisionDoc, context))!;
        const sends = Object.values(before.requests).filter(
            (receipt) => receipt.chatId === Number(chat) && receipt.action === "send",
        );

        assert.equal(sends.length, 2);
        assert.ok(sends.every((receipt) => receipt.status === "accepted"));
        const first = sends.find((receipt) => receipt.requestId !== secondRequest)!;
        const second = sends.find((receipt) => receipt.requestId === secondRequest)!;
        const native = await app.harness.commit(
            (tx) => tx.submissionByRequest(controller, second.requestId),
            context,
        );

        assert.ok(native?.type === "input");
        assert.equal(Number(native.id), second.submissionId);
        const sent = (await app.harness.submission(native.id, context))!;
        const queued = await sent.status(context);
        const waiting = Object.values(before.parentTasks!).find(
            (task) => task.authority.chatId === Number(chat),
        )!;

        assert.equal(first.controllerEpoch, second.controllerEpoch);
        assert.equal(first.sourceInputId, second.sourceInputId);
        assert.equal(waiting.status, "waiting");
        assert.equal(waiting.dependency.requestId, second.requestId);
        assert.equal(queued.status, "queued");
        assert.equal(queued.entry, undefined, "native acceptance is not placement");
        assert.ok(controllerUsers[0]!.some((text) => text.includes("S1:")));
        assert.ok(controllerUsers[0]!.every((text) => !text.includes("S2:")));
        assert.equal(notices.length, 0);
        const accepted = (await app.harness.snapshot(PipWorkDoc, controller, context))!;

        assert.equal(accepted.assignment!.requestId, second.requestId);
        assert.equal(accepted.assignment!.outcome, undefined);
        initial.resolve();

        if (placement === "placed") {
            await until(() => controllerUsers.length === 2, "post-tools request actually reads S2");
            assert.ok(controllerUsers[1]!.some((text) => text.includes("S2:")));
            assert.equal((await sent.status(context)).status, "placed");
            next.resolve();
        }

        await until(
            async () =>
                !app.isBusy(controller) &&
                (await app.harness.snapshot(PipWorkDoc, controller, context))?.question !==
                    undefined,
            "the real ask and any queued native input settle",
        );
        await app.pip.agents.supervision.open();
        const work = (await app.harness.snapshot(PipWorkDoc, controller, context))!;
        const question = work.question!;

        assert.equal(question.text, questionText);
        assert.equal(question.answer, undefined, "ordinary queued S2 is not an exact answer");
        assert.equal(work.questions.length, 0, "the real question stays pending");
        assert.equal(work.assignment!.requestId, second.requestId);

        if (placement === "queued") {
            assert.equal(controllerUsers.length, 1, "S2 never produced a provider response");
            assert.notEqual(work.assignment!.outcome?.kind, "question");
            assert.notEqual(work.assignment!.outcome?.questionId, question.id);
            const saved = (await app.harness.snapshot(AgentSupervisionDoc, context))!;
            const task = Object.values(saved.parentTasks!).find(
                (entry) => entry.authority.chatId === Number(chat),
            )!;

            // S2 may independently fail native admission at the pending-question gate. That
            // failure is not S1's question and must not be delivered as S2's semantic outcome.
            assert.ok(!task.wake?.text.includes(`Exact pending question: ${question.id};`));
            assert.ok(
                notices.every((text) => !text.includes(`Exact pending question: ${question.id};`)),
            );
        } else {
            assert.equal(work.assignment!.outcome!.kind, "question");
            assert.equal(work.assignment!.outcome!.questionId, question.id);
            await until(
                () => notices.length === 1 && !app.isBusy(chat),
                "the placed assignment's real question invokes its registered parent once",
            );
            assert.ok(notices[0]!.includes(`Exact pending question: ${question.id};`));
            assert.ok(notices[0]!.includes(`Exact child assignment ${second.requestId},`));
        }

        const pending = (await app.harness.snapshot(PipWorkDoc, controller, context))!.question!;

        assert.equal(pending.id, question.id);
        assert.equal(pending.text, questionText);
        assert.equal(pending.answer, undefined);
    });
}
