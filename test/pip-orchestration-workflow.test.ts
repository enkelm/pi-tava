// Native controller routing and private status: real handoffs/history/role prompts, scripted decisions.
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
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { PipWorkDoc } from "../src/server/docs.ts";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

after(cleanUp);

const text = (value: string) => fauxAssistantMessage([fauxText(value)]);
const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
    fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

const decode = (value: string) =>
    JSON.parse(value.slice(value.indexOf("{"), value.lastIndexOf("}") + 1));

test("private status follows the active stage and native Reviewer-to-Follow-up preserves review and human limits", async (t) => {
    let worker!: ConversationId;
    let reviewer!: ConversationId;
    let followUp!: ConversationId;
    let step = 0;
    let repairRead = false;
    const evidence =
        "Reviewer source: fixture independent inspection; checkpoint fixture-c1; scope original feature; one bounded retry finding; full suite deliberately deferred.";
    const limits =
        "Fix only the retry finding; focused checks and one self-review of delta and immediate integration. Retain prior review for untouched work. No full suite, staging or commits; wait for the human manual-testing green light before Land.";
    const model = scriptedModel((request) => {
        const system = JSON.stringify(
            request.messages.filter((message) => message.role === "system"),
        );
        const last = lastText(request);

        if (!system.includes("the private supervisor for Work Item")) {
            if (system.includes("You are the Follow-up agent")) {
                assert.match(
                    system,
                    /Self-review your delta and immediate integration points once/,
                );
                assert.match(system, /Reuse applicable earlier evidence for untouched work/);

                if (last.role === "user") {
                    const path = /"([^"]+handoff\.md)"/.exec(last.text)?.[1];

                    assert.ok(
                        path,
                        "the real courier supplies the saved handoff file, not a fabricated human message",
                    );

                    return tool("read", { path });
                }

                assert.ok(last.text.includes(evidence));
                assert.ok(last.text.includes(limits));
                repairRead = true;

                return text(
                    "Bounded retry repair reported; focused checks and delta self-review only. Prior review remains applicable to untouched work; full suite deferred. Waiting for manual testing, not another review cycle.",
                );
            }

            return text(
                system.includes("You are the Reviewer agent")
                    ? evidence
                    : "Implementation fixture settled; initial independent inspection requested.",
            );
        }

        switch (step++) {
            case 0:
                return tool("work_context", { session: Number(worker), action: "thread" });
            case 1:
                return tool("work_handoff", {
                    session: Number(worker),
                    targetType: "reviewer",
                    summary:
                        "Independently inspect the initial implementation fixture; no landing authorized.",
                });
            case 2:
                reviewer = JSON.parse(last.text).id;

                return tool("work_supervise", {
                    action: "finish",
                    text: "Initial independent Reviewer dispatched; await the bounded repair decision.",
                });
            case 3:
                return tool("work_context", { session: Number(worker), action: "status" });

            case 4: {
                const status = decode(last.text);

                assert.equal(
                    status.thread.type,
                    "worker",
                    "the anchor remains the original implementation thread",
                );
                assert.equal(
                    status.workflow.currentType,
                    "reviewer",
                    "routing must follow the actual active stage, not that old anchor",
                );
                assert.equal(status.workflow.activeThreadId, Number(reviewer));
                assert.equal(status.workflow.role.name, "Reviewer");
                assert.deepEqual(
                    status.workflow.history.map((entry: { type: string }) => entry.type),
                    ["worker", "reviewer"],
                );
                assert.equal(status.workflow.historyOmitted, 0);
                assert.ok(
                    status.workflow.options.some(
                        (option: { targetType: string; relationship: string; enabled: boolean }) =>
                            option.targetType === "follow-up" &&
                            option.relationship === "same-work" &&
                            option.enabled,
                    ),
                );
                assert.ok(
                    !status.workflow.options.some(
                        (option: { targetType: string }) => option.targetType === "reviewer",
                    ),
                );

                return tool("work_context", { session: Number(reviewer), action: "thread" });
            }

            case 5:
                assert.ok(last.text.includes(evidence));

                return tool("work_handoff", {
                    session: Number(reviewer),
                    targetType: "follow-up",
                    summary: evidence,
                    instructions: limits,
                });
            case 6:
                followUp = JSON.parse(last.text).id;

                return tool("work_supervise", {
                    action: "finish",
                    text: "Bounded Follow-up dispatched; prior evidence and manual-testing limits retained. No new review or landing authorized.",
                });
            default:
                throw new Error(
                    "No additional Worker/Reviewer cycle or unchanged-check retry is requested.",
                );
        }
    });
    const app = await openApp(model, join(root, "orchestrator-follow-up"));

    t.after(() => app.close());
    worker = await newSession(app, app.defaultCwd, "worker");
    await say(
        app,
        worker,
        "Coordinate this implementation and independent review, then an eligible bounded Follow-up. Full suite deferred; manual-testing green light required before Land.",
    );
    const opened = await activateWorkPip(app, worker, owner(app), {
        text: "Read the settled implementation, then request its initial independent review.",
    });
    const controller = opened.orchestration!.conversationId as ConversationId;

    await until(
        () =>
            reviewer !== undefined &&
            !app.isBusy(reviewer) &&
            !app.isBusy(controller) &&
            app.workItems.itemFor(worker)?.supervisor?.status === "reclaimed",
        "settled initial independent Reviewer",
    );
    await activateWorkPip(app, worker, owner(app), { });
    await until(
        () =>
            repairRead &&
            followUp !== undefined &&
            !app.isBusy(followUp) &&
            !app.isBusy(controller) &&
            app.workItems.itemFor(worker)?.supervisor?.status === "reclaimed",
        "bounded native Follow-up report",
    );
    const status = decode(
        await app.pip.workContext(controller, Number(worker), { action: "status" }, context),
    );

    assert.equal(status.workflow.currentType, "follow-up");
    assert.equal(status.workflow.role.name, "Follow-up");
    assert.deepEqual(
        status.workflow.history.map((entry: { type: string }) => entry.type),
        ["worker", "reviewer", "follow-up"],
    );
    assert.deepEqual(
        status.workflow.options
            .filter(
                (option: { relationship: string; enabled: boolean }) =>
                    option.relationship === "same-work" && option.enabled,
            )
            .map((option: { targetType: string }) => option.targetType)
            .sort(),
        ["land", "pull", "worker"],
    );
    assert.equal(app.workItems.itemFor(worker)!.activeThreadId, Number(followUp));
    assert.equal(
        app.workItems.members(worker).length,
        3,
        "no renamed Worker or extra review thread",
    );
    assert.equal(step, 7);
    assert.equal(
        (await app.harness.snapshot(PipWorkDoc, controller, context))!.questions.length,
        0,
    );
});
