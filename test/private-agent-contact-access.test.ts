// Passive public-thread observation must not acquire or steal another controller's grant.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { join } from "node:path";
import type { ConversationId } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { awaitWithContext, withAbortSignal } from "@earendil-works/chord/context";
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

after(cleanUp);

test("another private identity may follow a public execution thread without taking its controller grant", async (t) => {
    let execution!: ConversationId;
    let privateCalls = 0;
    const app = await openApp(
        scriptedModel((request) => {
            const last = lastText(request);
            const system = JSON.stringify(
                request.messages.filter((message) => message.role === "system"),
            );

            if (system.includes("the owner's persistent private agent")) {
                privateCalls++;

                return last.role === "user"
                    ? fauxAssistantMessage(
                          [
                              fauxToolCall("agent_work", {
                                  action: last.text.includes("READ_FIRST") ? "read" : "follow",
                                  session: Number(execution),
                              }),
                          ],
                          { stopReason: "toolUse" },
                      )
                    : fauxAssistantMessage("Passive exact contact recorded.");
            }

            return fauxAssistantMessage("NATIVE_VISIBLE_OUTCOME");
        }),
        join(root, "passive-contact-existing-parent"),
    );

    t.after(() => app.close());
    execution = await newSession(app, app.defaultCwd, "worker");
    const first = (
        await app.pip.agents.create(owner(app), { name: "First parent", requestId: "first-parent" })
    ).id as ConversationId;
    const observer = (
        await app.pip.agents.create(owner(app), {
            name: "Independent observer",
            requestId: "independent-observer",
        })
    ).id as ConversationId;

    // Establish control explicitly; a read is no longer an implicit association intent.
    await app.pip.agents.supervision.control(first, owner(app), {
        action: "attach",
        session: Number(execution),
        requestId: "first-parent-attachment",
    });
    await say(app, first, "READ_FIRST: inspect this exact native work.");
    const original = app.workItems.itemFor(execution)!.supervisor!;
    const controller = original.conversationId;
    const agentId = original.agentId;
    const epoch = original.epoch;

    await say(
        app,
        observer,
        "FOLLOW_SECOND: observe this accessible exact execution, not its private controller history.",
    );
    const grant = app.workItems.itemFor(execution)!.supervisor!;

    assert.equal(grant.agentId, agentId);
    assert.equal(grant.epoch, epoch, "passive follow never renews or replaces native control");
    assert.equal(grant.conversationId, controller);
    const rows = await app.pip.agents.supervision.controllers(observer, owner(app));

    assert.equal(
        rows.length,
        1,
        "observed Work Items remain discoverable beneath their observing identity",
    );
    assert.equal(
        rows[0]!.conversationId,
        controller,
        "navigation still opens the exact existing orchestrator",
    );
    assert.equal(rows[0]!.attached, false);
    assert.equal(rows[0]!.state, "observing");
    await say(app, execution, "NATIVE_VISIBLE_EVENT");
    await until(
        async () =>
            (await app.transcripts.allEntries(observer, true)).some(
                (entry) =>
                    entry.kind === "appEvent" &&
                    entry.event === "report" &&
                    entry.text?.includes("NATIVE_VISIBLE_OUTCOME"),
            ),
        "independent public execution event reaches its accepted observing origin",
    );
    assert.equal(
        privateCalls,
        4,
        "the passive outcome did not buy either identity a new model turn",
    );
    assert.equal(
        (await app.transcripts.allEntries(first, true)).some((entry) =>
            JSON.stringify(entry).includes("NATIVE_VISIBLE_OUTCOME"),
        ),
        false,
        "a passive read is not an implicit follow",
    );
});

test("native reclaim fences both running and queued source decisions, and only a later owner input can reacquire", async (t) => {
    let target!: ConversationId;
    let entered = false;
    let targetCalls = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    const app = await openApp(
        scriptedModel(async (request, options) => {
            const last = lastText(request);
            const system = JSON.stringify(
                request.messages.filter((message) => message.role === "system"),
            );

            if (system.includes("the owner's persistent private agent")) {
                if (last.role !== "user") {
                    return fauxAssistantMessage("The native control receipt was inspected.");
                }

                if (last.text.includes("OLD_SOURCE_AUTHORITY")) {
                    entered = true;
                    await awaitWithContext(
                        held,
                        options?.signal ? withAbortSignal(options.signal, context) : context,
                    );
                }

                return fauxAssistantMessage(
                    [
                        fauxToolCall("agent_work", {
                            action: "send",
                            session: Number(target),
                            text: "Bounded native task under this accepted source decision.",
                        }),
                    ],
                    { stopReason: "toolUse" },
                );
            }

            targetCalls++;

            return fauxAssistantMessage("Fresh native target answered.");
        }),
        join(root, "reclaim-source-admission-cutoff"),
    );

    t.after(async () => {
        release();
        await app.close();
    });
    target = await newSession(app, app.defaultCwd, "worker");
    const source = (
        await app.pip.agents.create(owner(app), {
            name: "Reclaim source",
            requestId: "reclaim-source",
        })
    ).id as ConversationId;

    await app.pip.agents.supervision.control(source, owner(app), {
        action: "attach",
        session: Number(target),
        requestId: "inert-owner-association",
    });
    const running = await app.commands.submit(source, owner(app), {
        text: "OLD_SOURCE_AUTHORITY",
        requestId: "old-source",
    });

    await until(
        () => entered,
        "the old private source is in its provider before its first contact",
    );
    const queued = await app.commands.submit(source, owner(app), {
        text: "QUEUED_SOURCE_AUTHORITY",
        requestId: "queued-source",
    });

    assert.equal(
        (await app.harness.inspect(context)).submissions.find(
            (item) => item.id === queued.submissionId,
        )?.status,
        "queued",
    );
    const controller = app.workItems.itemFor(target)!.supervisor!.conversationId as ConversationId;

    await app.commands.abort(controller, owner(app));
    release();
    await (await app.harness.submission(running.submissionId, context))!.wait(context);
    await (await app.harness.submission(queued.submissionId, context))!.wait(context);
    assert.equal(targetCalls, 0, "neither pre-reclaim decision dispatched its native recipient");
    const refusals = (await app.transcripts.allEntries(source, true)).filter(
        (entry) =>
            entry.kind === "toolResult" && /owner reclaimed.*fresh owner input/i.test(entry.text),
    );

    assert.equal(refusals.length, 2, "running and queued sources keep distinct rejected receipts");
    await say(app, source, "FRESH_SOURCE_AUTHORITY after the native reclaim.");
    await until(
        () => targetCalls === 1,
        "a genuinely later owner input still reaches the same exact Worker",
    );
});
