// Normal controller messaging crosses actual registered tools and native queued admission.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { join } from "node:path";
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
    until,
} from "./helpers.ts";

import { PipWorkDoc } from "../src/server/docs.ts";

after(cleanUp);

test("ordinary private-agent messages queue on the exact busy controller without rotating ownership", async (t) => {
    let source!: ConversationId;
    let controller!: ConversationId;
    let sending = false;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    const received: string[] = [];
    const app = await openApp(
        scriptedModel(async (request) => {
            const system = JSON.stringify(
                request.messages.filter((message) => message.role === "system"),
            );
            const last = lastText(request);

            if (system.includes("the owner's persistent private agent")) {
                return last.role === "user"
                    ? fauxAssistantMessage(
                          [
                              fauxToolCall(
                                  "agent_work",
                                  sending
                                      ? {
                                            action: "send",
                                            session: Number(controller),
                                            text: "QUEUED_ORDINARY_MESSAGE",
                                            report: false,
                                        }
                                      : {
                                            action: "delegate",
                                            session: Number(source),
                                            text: "Observe this exact work without changing its scope.",
                                            report: false,
                                        },
                              ),
                          ],
                          { stopReason: "toolUse" },
                      )
                    : fauxAssistantMessage("Native contact result recorded.");
            }

            if (system.includes("the private supervisor for Work Item")) {
                received.push(last.text);

                if (received.length === 1) {
                    await held;
                } else if (received.length === 2) {
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
            }

            return fauxAssistantMessage("Exact controller observation.");
        }),
        join(root, "private-agent-controller-queue"),
    );

    t.after(async () => {
        release();
        await app.close();
    });
    source = await newSession(app, app.defaultCwd, "worker");
    const chat = (
        await app.pip.agents.create(owner(app), { name: "Queue Tava", requestId: "queue-agent" })
    ).id as ConversationId;

    await say(app, chat, "Observe this Work Item.");
    controller = app.workItems.itemFor(source)!.supervisor!.conversationId as ConversationId;
    await until(
        () => received.length === 1,
        "controller is genuinely busy in its existing generation",
    );
    const before = { ...app.workItems.itemFor(source)!.supervisor! };
    const active = app.workItems.itemFor(source)!.activeThreadId;

    sending = true;
    await say(app, chat, "Pass this ordinary message along without interrupting or taking over.");
    const result = (await app.transcripts.allEntries(chat, true)).findLast(
        (entry) => entry.kind === "toolResult" && entry.name === "agent_work",
    );

    assert.ok(result?.kind === "toolResult");
    assert.equal(result.isError, false, result.text);
    const receipt = JSON.parse(result.text);

    assert.equal(receipt.status, "accepted", result.text);
    const queued = await (await app.harness.submission(receipt.submissionId, context))!.status(
        context,
    );

    assert.equal(queued.status, "queued", "normal input waits behind the exact native run");
    assert.equal(queued.conversationId, controller);
    assert.equal(received.length, 1, "sending never interrupts the existing model call");
    const after = app.workItems.itemFor(source)!.supervisor!;

    assert.equal(after.epoch, before.epoch);
    assert.equal(after.attachmentEpoch, before.attachmentEpoch);
    assert.equal(after.agentId, before.agentId);
    assert.equal(after.status, before.status);
    assert.equal(app.workItems.itemFor(source)!.activeThreadId, active);
    release();
    const done = await (await app.harness.submission(receipt.submissionId, context))!.wait(context);

    assert.equal(done.status, "done");
    assert.equal(received.length, 2);
    assert.match(received[1]!, /QUEUED_ORDINARY_MESSAGE/);
    assert.match(received[1]!, /Queue Tava/);
    assert.match(received[1]!, /not a new owner instruction/);
    const question = (await app.harness.snapshot(PipWorkDoc, controller, context))!.question!;

    await say(app, chat, "Try normal messaging while the exact question remains pending.");
    const blocked = (await app.transcripts.allEntries(chat, true)).findLast(
        (entry) => entry.kind === "toolResult" && entry.name === "agent_work",
    );

    assert.ok(blocked?.kind === "toolResult");
    assert.equal(blocked.isError, false, blocked.text);
    const refusal = JSON.parse(blocked.text);

    assert.equal(refusal.status, "blocked");
    assert.match(refusal.reason, /pending.*question|human decision/);
    const pending = (await app.harness.snapshot(PipWorkDoc, controller, context))!.question!;

    assert.equal(pending.id, question.id);
    assert.equal(pending.answer, undefined, "ordinary messaging never supplies an implicit answer");
    assert.equal(received.length, 2);
    assert.equal(app.workItems.itemFor(source)!.supervisor!.epoch, before.epoch);
});
