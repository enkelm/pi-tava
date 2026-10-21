import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { PipWorkDoc } from "../src/server/docs.ts";
import { activateWorkPip, cleanUp, context, newSession, openApp, owner, scriptedModel, until } from "./helpers.ts";

after(cleanUp);

test("waiting yields the real controller turn without buying another provider response", async (t) => {
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
                          action: "wait",
                          text: "Waiting for execution to report a meaningful outcome.",
                      }),
                  ],
                  { stopReason: "toolUse" },
              )
            : fauxAssistantMessage([fauxText("Unnecessary continuation after waiting.")]);
    });
    const app = await openApp(model);

    t.after(() => app.close());
    const source = await newSession(app, app.defaultCwd, "worker");
    const started = await activateWorkPip(app, source, owner(app), {
        text: "Observe meaningful execution outcomes, without polling.",
    });
    const controller = started.orchestration!.conversationId as ConversationId;

    await until(async () => {
        const state = await app.harness.snapshot(PipWorkDoc, controller, context);

        return calls > 0 && state?.pending === undefined && !app.isBusy(controller);
    }, "the real wait tool and native controller submission to settle");
    const entries = await app.transcripts.allEntries(controller, true);
    const waits = entries.filter(
        (entry) => entry.kind === "toolResult" && entry.name === "work_supervise",
    );

    assert.equal(waits.length, 1);
    const wait = waits[0];

    assert.ok(wait?.kind === "toolResult");
    assert.equal(wait.isError, false, wait.text);
    assert.equal(calls, 1, "wait must terminate its turn, not buy a model acknowledgement");
    assert.equal(
        app.workItems.itemFor(source)!.supervisor!.status,
        "running",
        "waiting leaves the durable event listener armed",
    );
});
