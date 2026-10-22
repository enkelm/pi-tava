// Native admission publications are the storage boundary; only the external model is scripted.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { cleanUp, openApp, owner, scriptedModel, until } from "./helpers.ts";

after(cleanUp);

test("owner authority is pinned at accepted native input, before the first provider hook", async (t) => {
    let calls = 0;
    let rotated = false;
    const app = await openApp(
        scriptedModel(() => {
            calls++;

            return fauxAssistantMessage(
                "An input admitted under a revoked sign-in must not dispatch.",
            );
        }),
    );

    t.after(() => app.close());
    const agent = await app.pip.agents.create(owner(app), {
        name: "Admission fencing",
        requestId: "admission-fencing",
    });
    const chat = agent.id as ConversationId;

    await app.commands.configure(chat, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });
    const unsubscribe = app.harness.subscribeCommits((publication) => {
        if (
            !rotated &&
            publication.changes.some(
                (change) =>
                    change.type === "submission" &&
                    change.value?.conversationId === chat &&
                    change.value.type === "input",
            )
        ) {
            rotated = true;
            app.config.rotateOwnerToken();
        }
    });

    t.after(unsubscribe);
    await app.commands.submit(chat, owner(app), {
        text: "Observe only while this admission's owner authority remains current.",
        requestId: "revoke-at-native-admission",
    });
    await until(() => !app.isBusy(chat), "revoked admitted input settles without dispatch");
    assert.equal(rotated, true, "rotation happened at the real native acceptance publication");
    assert.equal(
        calls,
        0,
        "the first provider hook cannot bless an older admission with a fresh token",
    );
    unsubscribe();
    await app.commands.submit(chat, owner(app), {
        text: "A fresh explicit owner decision is still allowed.",
        requestId: "fresh-owner-admission",
    });
    await until(() => !app.isBusy(chat), "fresh-owner input settles");
    assert.equal(calls, 1);
});
