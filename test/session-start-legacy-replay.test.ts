// Historical validation uses the real registered tool; Durable records its own execute intent.
// Reopening with today's descriptor must honor those arguments, not invent a Chat or a new call.
import {
    cleanUp,
    context,
    lastText,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { awaitWithContext } from "@earendil-works/chord/context";
import { join } from "node:path";
import { after, test } from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId, TaskId, ToolRegistration } from "@earendil-works/pi-durable";
import { Pip } from "../src/server/pip.ts";
import { AgentSupervisionDoc } from "../src/server/pip/agent-supervision.ts";

after(cleanUp);

test("accepted legacy session_start without threadType replays as one Worker and native delegation under the current schema", async (t) => {
    const direction = "Create a Worker for this observation-only task; no publication.";
    const message = "Observe the original task and stop; no implementation or publication.";
    const legacyArgs = { folder: work, title: "Legacy replay Worker", message, report: false };
    let decisions = 0;
    let controllerCalls = 0;
    const model = scriptedModel((request) => {
        const system = JSON.stringify(request.messages.filter((entry) => entry.role === "system"));
        const last = lastText(request);

        if (system.includes("the private supervisor for Work Item")) {
            controllerCalls++;
            assert.ok(last.text.includes(message));

            return fauxAssistantMessage(
                [
                    fauxToolCall("work_supervise", {
                        action: "finish",
                        text: "Native legacy assignment observed; waiting for the owner.",
                    }),
                ],
                { stopReason: "toolUse" },
            );
        }

        if (
            system.includes("the owner's persistent private agent") &&
            last.role === "user" &&
            (last.text.includes(direction) || last.text.includes("Reject a fresh legacy call"))
        ) {
            decisions++;

            return fauxAssistantMessage([fauxToolCall("session_start", legacyArgs)], {
                stopReason: "toolUse",
            });
        }

        return fauxAssistantMessage("Creation result recorded; no replacement assignment.");
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    let taskId: TaskId | undefined;
    const registration = Pip.prototype.registration;
    const historical = t.mock.method(Pip.prototype, "registration", function (this: Pip) {
        const registered = registration.call(this);

        for (const selected of registered.tools ?? []) {
            const tool: ToolRegistration = selected;

            if (tool.name !== "session_start") {
                continue;
            }

            // Recreate only the former schema, not authority, memo state or a task checkpoint.
            // The native hooks still bind the real owner input before Durable records intent.
            const parameters = tool.parameters;

            assert.ok(Type.IsObject(parameters));
            tool.parameters = {
                ...parameters,
                properties: Object.fromEntries(
                    Object.entries(parameters.properties).filter(([name]) => name !== "threadType"),
                ),
                required: (parameters.required ?? []).filter((name) => name !== "threadType"),
            };
            const execute = tool.execute;

            t.mock.method(tool, "execute", async (...args: Parameters<typeof execute>) => {
                assert.ok(
                    args[0] !== null && typeof args[0] === "object" && !Array.isArray(args[0]),
                );
                assert.equal(Reflect.get(args[0], "threadType"), undefined);
                taskId = args[1].taskId;
                await awaitWithContext(held, args[2]);

                return execute(...args);
            });
        }

        return registered;
    });
    const directory = join(root, "session-start-legacy-replay");
    let app = await openApp(model, directory);

    t.after(async () => {
        release();
        t.mock.restoreAll();
        await app.close();
    });
    // These are owner-selected native defaults, not a fabricated controller/model selection.
    app.config.lastModel = { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
    const created = await app.pip.agents.create(owner(app), {
        name: "Legacy replay",
        requestId: "legacy-replay-agent",
    });
    const chat = created.id as ConversationId;

    await app.commands.configure(chat, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });
    const initial = app
        .sessions(owner(app))
        .map((session) => session.id)
        .sort();

    const accepted = await app.commands.submit(chat, owner(app), {
        text: direction,
        requestId: "legacy-start-owner-input",
    });

    await until(() => taskId !== undefined, "old arguments pass real validation and enter execute");
    assert.ok(taskId);
    const pending = await app.harness.commit((tx) => tx.task(taskId!), context);

    assert.equal(pending?.kind, "pi.tool");
    assert.deepEqual(pending?.state, {
        status: "running",
        checkpoint: { phase: "execute", arguments: legacyArgs, replay: "safe" },
    });
    assert.deepEqual(
        app
            .sessions(owner(app))
            .map((session) => session.id)
            .sort(),
        initial,
    );
    await app.close();
    release();
    historical.mock.restore();
    t.mock.restoreAll();
    app = await openApp(model, directory);
    const settled = await app.harness.waitForTask(taskId, context);

    assert.equal(settled.state.outcome.status, "completed");
    await until(() => !app.isBusy(chat), "replayed legacy creation tool settles");
    const result = (await app.transcripts.allEntries(chat, true)).find(
        (entry) => entry.kind === "toolResult" && entry.name === "session_start",
    );

    assert.ok(result?.kind === "toolResult");
    assert.equal(result.isError, false, result.text);
    const receipt = JSON.parse(result.text);

    assert.equal(receipt.status, "accepted", result.text);
    const state = (await app.harness.snapshot(AgentSupervisionDoc, context))!;
    const assignments = Object.values(state.requests).filter(
        (entry) => entry.chatId === Number(chat),
    );

    assert.equal(assignments.length, 1);
    const assignment = assignments[0]!;
    const worker = assignment.source as ConversationId;
    const controller = assignment.controllerId as ConversationId;

    assert.equal(assignment.action, "delegate", "old arguments retain native delegation, not send");
    assert.equal(assignment.status, "accepted");
    assert.equal(assignment.requestId, receipt.requestId);
    assert.equal(assignment.submissionId, receipt.submissionId);
    assert.equal(assignment.sourceInputId, Number(accepted.submissionId));
    const native = await app.harness.commit(
        (tx) => tx.submissionByRequest(controller, assignment.requestId),
        context,
    );

    assert.ok(native?.type === "input", "delegation has a real native input receipt");
    assert.equal(Number(native.id), receipt.submissionId);
    assert.equal(receipt.controllerId, Number(controller));
    assert.equal(receipt.session, Number(controller));
    assert.equal(app.sessionMeta(worker)?.threadType, "worker", "legacy creation is not a Chat");
    assert.equal(app.workItems.itemFor(worker)?.activeThreadId, Number(worker));
    assert.equal(app.workItems.isReadOnly(chat), false, "the originating private Chat is retained");
    await until(() => !app.isBusy(controller), "native delegated controller finishes");
    const inputs = (await app.transcripts.allEntries(controller, true)).filter(
        (entry) => entry.kind === "user",
    );

    assert.equal(inputs.length, 1, "one native controller input, not a synthetic owner receipt");
    assert.ok(inputs[0]!.text.includes(message));
    assert.equal(controllerCalls, 1);
    assert.equal(decisions, 1, "recovery executes the saved call instead of buying a replacement");
    const sessions = app
        .sessions(owner(app))
        .map((session) => session.id)
        .sort();

    assert.deepEqual(
        sessions.filter((id) => !initial.includes(id)),
        [worker],
    );
    await say(app, chat, "Reject a fresh legacy call; new calls must specify threadType chat.");
    const refused = (await app.transcripts.allEntries(chat, true)).findLast(
        (entry) => entry.kind === "toolResult" && entry.name === "session_start",
    );

    assert.ok(refused?.kind === "toolResult");
    assert.equal(refused.isError, true, refused.text);
    assert.match(refused.text, /threadType/);
    assert.deepEqual(
        app
            .sessions(owner(app))
            .map((session) => session.id)
            .sort(),
        sessions,
    );
    assert.equal(
        Object.values((await app.harness.snapshot(AgentSupervisionDoc, context))!.requests).length,
        1,
        "current-schema rejection creates no second delegation",
    );
});
