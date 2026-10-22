// Catalogue projection is the native owner boundary consumed by an unsent identity Composer.
import { cleanUp, fakeTab, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";

after(cleanUp);

test("owner catalogue retains each identity's effective model/thinking, refreshes on configure, and preserves unavailable selections", async (t) => {
    const app = await openApp(scriptedModel(), join(root, "identity-model-catalogue"));

    t.after(() => app.close());
    const user = owner(app);
    const reasoner = fauxProvider({
        provider: "identity-model",
        models: [{ id: "reasoner-a", name: "Identity reasoner A", reasoning: true }],
    });

    app.models.registerNativeProvider(reasoner.provider);
    await app.models.refresh({ allowNetwork: false, providers: ["identity-model"] });
    app.config.lastModel = { provider: "faux", modelId: "faux-2", thinkingLevel: "off" };
    const a = await app.pip.agents.createIdentity(user, {
        requestId: "a",
        name: "A",
        instructions: "secret-charter-not-model-state",
    });
    const b = await app.pip.agents.createIdentity(user, { requestId: "b", name: "B" });
    const tab = fakeTab(undefined, user);

    await app.attach(tab.client);
    const info = (agentId: string) =>
        app.pip.agents.list(user).find((entry) => entry.agentId === agentId)!.modelInfo;

    await app.pip.agents.configureIdentity(a.agentId, user, {
        model: { provider: "identity-model", modelId: "reasoner-a" },
        thinkingLevel: "high",
    });
    assert.ok(
        info(a.agentId),
        "owner catalogue must publish native model state before any chat exists",
    );
    assert.deepEqual(info(a.agentId).model, { provider: "identity-model", modelId: "reasoner-a" });
    assert.equal(info(a.agentId).modelName, "Identity reasoner A");
    assert.equal(info(a.agentId).thinkingLevel, "high");
    assert.equal(info(a.agentId).reasoning, true);
    assert.equal(info(a.agentId).available, true);
    assert.deepEqual(info(b.agentId).model, { provider: "faux", modelId: "faux-2" });
    assert.equal(info(b.agentId).thinkingLevel, "off");
    assert.doesNotMatch(JSON.stringify(info(a.agentId)), /secret-charter|cwd|instructions/);
    await until(() => {
        const summaries = tab.last("namedAgents") as unknown as {
            agentId: string;
            modelInfo?: { thinkingLevel: string };
        }[];

        return (
            summaries?.find((entry) => entry.agentId === a.agentId)?.modelInfo?.thinkingLevel ===
            "high"
        );
    }, "configure commit updates the existing owner catalogue stream");
    await app.pip.agents.configureIdentity(a.agentId, user, { thinkingLevel: "medium" });
    await until(() => {
        const summaries = tab.last("namedAgents") as unknown as {
            agentId: string;
            modelInfo?: { thinkingLevel: string };
        }[];

        return (
            summaries?.find((entry) => entry.agentId === a.agentId)?.modelInfo?.thinkingLevel ===
            "medium"
        );
    }, "thinking-only configure refreshes without a chat or extra fetch");
    assert.equal(
        (await app.pip.agents.read(a.agentId, user)).id,
        null,
        "projection/configure never allocates a chat",
    );
    app.models.unregisterProvider("identity-model");
    assert.deepEqual(info(a.agentId).model, { provider: "identity-model", modelId: "reasoner-a" });
    assert.equal(info(a.agentId).thinkingLevel, "medium");
    assert.equal(info(a.agentId).available, false);
    assert.equal(info(a.agentId).modelName, undefined);
    const { user: guest } = app.config.addUser("Guest", "guest");
    const guestTab = fakeTab(undefined, guest);

    await app.attach(guestTab.client);
    assert.deepEqual(guestTab.last("namedAgents"), []);
    assert.throws(() => app.pip.agents.list(guest), /Only the owner/);
    assert.throws(() => app.pip.agents.list({ ...user, tokenHash: "revoked" }), /access changed/);
});
