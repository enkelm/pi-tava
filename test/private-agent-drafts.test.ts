// Native first sends reuse Commands request identities/receipts. Client view dismissal is owned by agent-drafts.test.ts.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ConversationId, SubmissionId } from "@earendil-works/pi-durable";
import { SessionsDoc } from "../src/server/docs.ts";
import { AgentIdentitiesDoc } from "../src/server/agent-identity-docs.ts";
import { privateAgentRequest as request } from "./private-agent-http.ts";
import {
    cleanUp,
    context,
    echo,
    lastText,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";

after(cleanUp);

test("identity-only creation and rejected first input leave History empty; accepted input persists once across retry/restart", async () => {
    const data = join(root, "named-agent-first-send");
    let app = await openApp(scriptedModel(echo), data);

    try {
        const before = await app.harness.snapshot(SessionsDoc, context);
        const creation = { requestId: "identity-only", name: "Ada" };
        const made = await request(app, "pip/agents?identityOnly=1", creation);

        assert.equal(made.status, 200, await made.clone().text());
        const agent = await made.json();
        const path = `pip/agents/${agent.agentId}`;

        assert.equal(agent.id, null);
        assert.deepEqual(agent.chats, []);
        const draftShell = await request(app, `/agents/${agent.agentId}/drafts/local-view`);

        assert.equal(
            draftShell.status,
            200,
            "reload of a local draft serves the app shell, not a durable room",
        );
        assert.match(await draftShell.text(), /<!doctype html>/i);
        assert.deepEqual(
            (await (await request(app, "pip/agents?identityOnly=1", creation)).json()).agentId,
            agent.agentId,
        );
        assert.deepEqual(
            await app.harness.snapshot(SessionsDoc, context),
            before,
            "creating/viewing an identity never stores a welcome conversation",
        );
        assert.equal(
            (await request(app, `${path}/submit`, { requestId: "empty", text: " " })).status,
            400,
        );
        const first = { requestId: "first-message", text: "Plan a careful implementation" };

        assert.equal(
            (await request(app, `${path}/submit`, first)).status,
            409,
            "a missing model rejects before reserving a conversation",
        );
        assert.deepEqual(await app.harness.snapshot(SessionsDoc, context), before);
        assert.deepEqual((await (await request(app, path)).json()).chats, []);
        assert.equal(
            (
                await request(app, `${path}/configure`, {
                    model: { provider: "faux", modelId: "faux-1" },
                })
            ).status,
            200,
        );
        const sent = await Promise.all([
            request(app, `${path}/submit`, first),
            request(app, `${path}/submit`, first),
        ]);

        assert.deepEqual(
            sent.map((response) => response.status),
            [200, 200],
        );
        const [accepted, duplicate] = await Promise.all(sent.map((response) => response.json()));

        assert.equal(accepted.id, duplicate.id);
        assert.equal(accepted.submissionId, duplicate.submissionId);
        await (await app.harness.submission(accepted.submissionId as SubmissionId, context))!.wait(
            context,
        );
        const chat = accepted.id as ConversationId;
        const entries = (await (await app.conversation(chat)).context(context)).entries;

        assert.equal(entries.filter((entry) => entry.kind === "pi.user").length, 1);
        assert.ok(
            !entries.some(
                (entry) => (entry.data as { appAuthored?: boolean } | undefined)?.appAuthored,
            ),
            "no stored onboarding message",
        );
        const passive = await request(app, `${path}/submit?requestId=${first.requestId}`);

        assert.equal(passive.status, 200);
        assert.equal((await passive.json()).submissionId, accepted.submissionId);
        assert.deepEqual(
            (await (await request(app, path)).json()).chats.map((item: { id: number }) => item.id),
            [accepted.id],
        );
        // Simulate interruption after native admission but before its visibility marker was committed.
        const interruptVisibility = (legacyFingerprint = false) =>
            app.harness.commit(async (tx) => {
                const doc = await tx.doc(AgentIdentitiesDoc);
                const reservation = Object.values(doc.requests).find(
                    (item) => item.chatId === accepted.id,
                )!;

                delete reservation.accepted;

                if (legacyFingerprint) {
                    reservation.fingerprint = createHash("sha256")
                        .update(JSON.stringify({ agentId: agent.agentId, text: first.text }))
                        .digest("hex");
                }
            }, context);

        await interruptVisibility();
        assert.deepEqual(
            (await (await request(app, path)).json()).chats.map((item: { id: number }) => item.id),
            [accepted.id],
            "History recovers accepted native input even after the originating view closes",
        );
        await interruptVisibility(true);
        await app.close();
        app = await openApp(scriptedModel(echo), data);
        const recovered = await request(app, `${path}/submit?requestId=${first.requestId}`);

        assert.equal(recovered.status, 200);
        assert.equal((await recovered.json()).id, accepted.id);
        const retry = await request(app, `${path}/submit`, first);

        assert.equal(retry.status, 200);
        assert.equal((await retry.json()).submissionId, accepted.submissionId);
        assert.deepEqual(
            app.pip.agents.list(owner(app))[0]!.chats.map((item) => item.id),
            [accepted.id],
        );
        assert.equal(
            (await (await app.conversation(chat)).context(context)).entries.filter(
                (entry) => entry.kind === "pi.user",
            ).length,
            1,
        );
        assert.equal(
            (await request(app, `${path}/submit`, { ...first, text: "Different intent" })).status,
            409,
        );
    } finally {
        await app.close();
    }
});

for (const rejection of ["spend", "busy"] as const) {
    test(`native ${rejection} rejection after model selection preserves saved Chat capacity and exact retry across restart`, async () => {
        const data = join(root, `named-agent-${rejection}-capacity`);
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        let started = false;
        const model = scriptedModel(async (input, ...args) => {
            if (lastText(input).text.includes("Hold the saved chat")) {
                started = true;
                await held;
            }

            return typeof echo === "function" ? echo(input, ...args) : echo;
        });
        let app = await openApp(model, data);

        try {
            const agent = await app.pip.agents.createIdentity(owner(app), {
                requestId: "capacity-identity",
                name: "Capacity",
            });

            await app.pip.agents.configureIdentity(agent.agentId, owner(app), {
                model: { provider: "faux", modelId: "faux-1" },
            });
            const first = await app.pip.agents.submitDraft(agent.agentId, owner(app), {
                requestId: "accepted-first",
                text: "Keep this saved history",
            });

            await (await app.harness.submission(first.submissionId, context))!.wait(context);
            const saved = [first.id];

            // Native explicit-chat callers retain saved empty Chats, not just accepted first sends.
            for (let index = 1; index < 127; index++) {
                saved.push(
                    (
                        await app.pip.agents.newChat(first.id as ConversationId, owner(app), {
                            requestId: `saved-${index}`,
                        })
                    ).id,
                );
            }

            let blocking: SubmissionId | undefined;

            if (rejection === "spend") {
                await app.pip.agents.setBudget(first.id as ConversationId, owner(app), 0);
            } else {
                blocking = (
                    await app.commands.submit(first.id as ConversationId, owner(app), {
                        requestId: "hold-saved",
                        text: "Hold the saved chat",
                    })
                ).submissionId;
                await until(
                    () => started && app.isBusy(first.id as ConversationId),
                    "saved Chat busy",
                );
            }

            const rejected = { requestId: "rejected-first", text: "Try the native admission" };
            const attempt = () => app.pip.agents.submitDraft(agent.agentId, owner(app), rejected);
            const expected = rejection === "spend" ? /spend limit/ : /working in another chat/;

            await assert.rejects(attempt, expected);
            await assert.rejects(attempt, expected);
            assert.deepEqual(
                (await app.pip.agents.read(agent.agentId, owner(app))).chatIds,
                saved,
                "native rejection never exposes the reserved Chat in History",
            );
            const reservation = Object.values(
                (await app.harness.snapshot(AgentIdentitiesDoc, context))!.requests,
            ).find((item) => item.firstInputRequestId?.endsWith(":rejected-first"));

            assert.ok(reservation?.chatId, "the exact rejected reservation is retained for retry");
            assert.equal(
                await app.pip.agents.draftReceipt(agent.agentId, owner(app), rejected.requestId),
                undefined,
                "a definite native rejection has no acceptance receipt",
            );

            if (rejection === "spend") {
                await app.pip.agents.setBudget(first.id as ConversationId, owner(app), undefined);
            } else {
                release();
                await (await app.harness.submission(blocking!, context))!.wait(context);
            }

            await app.close();
            app = await openApp(scriptedModel(echo), data);
            const corrected = { requestId: "corrected-first", text: "Use the last saved slot" };
            const accepted = await app.pip.agents.submitDraft(agent.agentId, owner(app), corrected);

            await (await app.harness.submission(accepted.submissionId, context))!.wait(context);
            assert.deepEqual(
                (await app.pip.agents.read(agent.agentId, owner(app))).chatIds,
                [...saved, accepted.id],
                "rejected reservations consume none of the 128 saved slots after restart",
            );
            assert.equal(
                (await app.pip.agents.submitDraft(agent.agentId, owner(app), corrected))
                    .submissionId,
                accepted.submissionId,
            );
            await assert.rejects(attempt, /At most 128 chats/);
            assert.equal(
                Object.values(
                    (await app.harness.snapshot(AgentIdentitiesDoc, context))!.requests,
                ).find((item) => item.firstInputRequestId === reservation.firstInputRequestId)
                    ?.chatId,
                reservation.chatId,
                "retry keeps the same rejected request and Chat identities even at capacity",
            );
            // A native acceptance whose projection was interrupted must still occupy its saved slot.
            await app.harness.commit(async (tx) => {
                const doc = await tx.doc(AgentIdentitiesDoc);
                const waiting = Object.values(doc.requests).find(
                    (item) => item.chatId === accepted.id,
                )!;

                delete waiting.accepted;
            }, context);
            await assert.rejects(
                app.pip.agents.newChat(first.id as ConversationId, owner(app), {
                    requestId: "beyond-capacity",
                }),
                /At most 128 chats/,
            );
            assert.deepEqual(
                (await app.pip.agents.read(agent.agentId, owner(app))).chatIds,
                [...saved, accepted.id],
                "accepted and preexisting Chats are never removed to free capacity",
            );
        } finally {
            release();
            await app.close();
        }
    });
}

test("owner-private identity History includes retained saved Chats and never another agent's conversation", async (t) => {
    const app = await openApp(scriptedModel(echo));

    t.after(() => app.close());
    app.config.lastModel = { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
    const ada = await app.pip.agents.createIdentity(owner(app), {
        requestId: "history-ada",
        name: "Ada",
    });
    const bea = await app.pip.agents.createIdentity(owner(app), {
        requestId: "history-bea",
        name: "Bea",
    });
    const first = await app.pip.agents.submitDraft(ada.agentId, owner(app), {
        requestId: "first",
        text: "First history",
    });
    await (await app.harness.submission(first.submissionId, context))!.wait(context);
    const second = await app.pip.agents.submitDraft(ada.agentId, owner(app), {
        requestId: "second",
        text: "Second history",
    });
    const sibling = await app.pip.agents.submitDraft(bea.agentId, owner(app), {
        requestId: "first",
        text: "Other identity",
    });
    const history = await (await request(app, `pip/agents/${ada.agentId}`)).json();

    assert.deepEqual(
        history.chats.map((item: { id: number }) => item.id),
        [first.id, second.id],
    );
    assert.ok(!history.chats.some((item: { id: number }) => item.id === sibling.id));
    assert.equal(
        (await request(app, `c/${first.id}/private-agent`)).status,
        200,
        "exact navigation reopens a saved Chat without creating a new one",
    );
    assert.deepEqual(
        (await app.pip.agents.read(ada.agentId, owner(app))).chats.map((item) => item.id),
        [first.id, second.id],
    );
    const guest = app.config.addUser("Guest", "guest");

    for (const path of [
        "pip/agents",
        `pip/agents/${ada.agentId}`,
        `pip/agents/${ada.agentId}/submit?requestId=first`,
    ]) {
        const denied = await request(app, path, undefined, guest.token);

        assert.equal(denied.status, 403);
        assert.ok(!(await denied.text()).includes("First history"));
    }

    assert.equal(
        (await request(app, `pip/agents/${bea.agentId}/submit?requestId=second`)).status,
        404,
        "receipt lookup cannot cross identities",
    );
});
