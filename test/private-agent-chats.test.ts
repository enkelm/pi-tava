// Owner routes are the identity seam: a chat is history, not a new agent.
import assert from "node:assert/strict";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { after, test } from "node:test";
import { join } from "node:path";
import { type ConversationId } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { TITLE_PROMPT } from "../src/server/titles.ts";
import { createHandler } from "../src/server/http.ts";
import { SessionsDoc } from "../src/server/docs.ts";
import {
    cleanUp,
    context,
    openApp,
    owner,
    root,
    scriptedModel,
    lastText,
    recordCost,
    say,
} from "./helpers.ts";

after(cleanUp);

test("identity spending navigates to the last available chat, never an archived inbox substitute", async (t) => {
    const app = await openApp(scriptedModel());

    t.after(() => app.close());
    const made = await app.pip.agents.create(owner(app), {
        name: "Available agent",
        requestId: "available",
    });
    const first = made.id as ConversationId;
    const second = (await app.pip.agents.newChat(first, owner(app), { requestId: "second" })).id;

    // Persisted archive fixture: private chats have no public archive management intent.
    await app.harness.commit(async (tx) => {
        (await tx.doc(SessionsDoc)).items[String(second)]!.archived = true;
    }, context);
    const available = app.pip.agents
        .list(owner(app))
        .find((agent) => agent.agentId === made.agentId);
    const spending = app.spend
        .summary(owner(app))
        .sessions.filter((row) => row.title === "Available agent");

    assert.ok(available, "the current owner can list this identity");
    assert.equal(available.id, Number(first));
    assert.equal(spending.length, 1, "costs stay identity-wide, not one row per chat");
    assert.equal(
        spending[0]!.id,
        available.id,
        "spend links use the same available-chat projection as the identity list",
    );
});

test("independent chat titles follow their own first input, survive identity edits and need no title model", async (t) => {
    let titleRequests = 0;
    let reasoningRequests = 0;
    const app = await openApp(
        scriptedModel((request) => {
            if (lastText(request).text.startsWith(TITLE_PROMPT)) {
                titleRequests++;
            } else {
                reasoningRequests++;
            }

            return fauxAssistantMessage([fauxText("Done")]);
        }),
        join(root, "independent-chat-titles"),
    );

    t.after(() => app.close());
    app.config.lastModel = { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
    const user = owner(app);
    const identity = await app.pip.agents.create(user, {
        name: "Reviewer",
        requestId: "independent-titles",
    });
    const first = identity.id as ConversationId;
    const second = (await app.pip.agents.newChat(first, user, { requestId: "second" }))
        .id as ConversationId;

    await say(app, first, "Inspect keyboard navigation");
    // Nine or more words normally buy an ad-hoc title request outside the accepted reasoning run.
    await say(
        app,
        second,
        "Investigate billing receipts and reconcile overdue invoices before the next renewal",
    );
    const before = (await app.pip.agents.read(first, user)).chats;
    const instructions = await app.pip.agents.update(first, user, {
        expectedRevision: identity.revision,
        instructions: "Distinguish checked facts from assumptions.",
    });
    const renamed = await app.pip.agents.update(second, user, {
        expectedRevision: instructions.revision,
        name: "Careful reviewer",
    });
    const expected = [
        { id: Number(first), title: "Inspect keyboard navigation" },
        {
            id: Number(second),
            title: "Investigate billing receipts and reconcile overdue invoices before the next rene",
        },
    ];
    const titles = (chats: typeof before) => chats.map(({ id, title }) => ({ id, title }));

    assert.notEqual(before[0]!.title, before[1]!.title, "tabs must distinguish separate histories");
    assert.deepEqual(titles(before), expected, "each title comes from that chat's own first input");
    assert.deepEqual(
        titles(instructions.chats),
        expected,
        "instruction saves preserve chat titles",
    );
    assert.deepEqual(titles(renamed.chats), expected, "identity renames preserve chat titles");
    assert.equal(renamed.name, "Careful reviewer", "identity naming remains independent");
    assert.deepEqual(
        [app.sessionMeta(first)?.title, app.sessionMeta(second)?.title],
        expected.map(({ title }) => title),
        "the retained-chat projection uses durable transcript titles",
    );
    assert.equal(reasoningRequests, 2, "only the two accepted human turns request reasoning");
    assert.equal(titleRequests, 0, "long private input cannot open an unbound title-model lane");
});

test("owner creates distinct chats with one persistent identity and one cost-free welcome across retry/restart", async () => {
    const data = join(root, "private-agent-chats");
    const model = scriptedModel();
    let app = await openApp(model, data);

    const request = async (path: string, body?: unknown, token = app.config.ownerToken) => {
        const handler = createHandler({
            app,
            listen: { host: "127.0.0.1", port: 0 },
            restart: () => {},
        });
        const input = new IncomingMessage(new Socket());
        const output = new ServerResponse(input);
        let text = "";

        input.url = `/api/${path}`;
        input.method = body === undefined ? "GET" : "POST";
        input.headers = {
            authorization: `Bearer ${token}`,
            "x-pocket": "1",
            "content-type": "application/json",
        };

        output.end = (chunk?: unknown) => {
            text = String(chunk ?? "");

            return output;
        };

        const handled = handler(input, output);

        if (body !== undefined) {
            input.push(Buffer.from(JSON.stringify(body)));
        }

        input.push(null);
        await handled;

        return { status: output.statusCode, body: JSON.parse(text) };
    };

    try {
        const creation = { requestId: "agent-a", name: "Ada" };
        const first = await request("pip/agents", creation);

        assert.equal(first.status, 200);
        assert.equal(typeof first.body.agentId, "string");
        const chat = first.body.id as ConversationId;
        const next = await request(`c/${chat}/private-agent`, {
            action: "new_chat",
            requestId: "chat-2",
        });

        assert.equal(next.status, 200);
        assert.notEqual(next.body.id, chat);
        assert.equal(next.body.agentId, first.body.agentId);
        assert.equal(
            "inboxChatId" in next.body,
            false,
            "no chat is projected as a special home/inbox",
        );
        assert.deepEqual(next.body.chatIds, [chat, next.body.id]);
        assert.deepEqual(
            next.body.chats.map((tab: { id: number; busy: boolean }) => ({
                id: tab.id,
                busy: tab.busy,
            })),
            [
                { id: chat, busy: false },
                { id: next.body.id, busy: false },
            ],
        );
        assert.equal((await request("pip/agents")).body.agents.length, 1);
        const second = next.body.id as ConversationId;
        const welcome = await (await app.conversation(chat)).context(context);
        const empty = await (await app.conversation(second)).context(context);

        assert.equal(welcome.entries.filter((entry) => entry.kind === "pi.assistant").length, 1);
        assert.ok(!welcome.entries.some((entry) => entry.kind === "pi.user"));
        assert.equal(empty.entries.length, 0);
        const { token } = app.config.addUser("Guest", "guest");

        assert.equal((await request(`c/${second}/private-agent`, undefined, token)).status, 404);
        await app.close();
        app = await openApp(model, data);
        const retry = await request(`c/${chat}/private-agent`, {
            action: "new_chat",
            requestId: "chat-2",
        });

        assert.equal(retry.body.id, second);
        assert.equal((await request("pip/agents", creation)).body.agentId, first.body.agentId);
        assert.deepEqual((await request(`c/${second}/private-agent`)).body.chatIds, [chat, second]);
        assert.equal(app.isBusy(chat), false);
        assert.equal(app.isBusy(second), false);
        assert.equal(app.pip.idOf(owner(app).id), undefined);
        app.config.lastModel = { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
        await app.commands.configure(chat, owner(app), {
            model: { provider: "faux", modelId: "faux-2" },
        });
        assert.equal((await app.agentState(second))?.model?.modelId, "faux-2");
        const budget = await request(`c/${chat}/private-agent`, {
            action: "limits",
            expectedRevision: 1,
            budget: 2,
        });

        assert.equal(budget.status, 200);
        await recordCost(app, chat, 1.25);
        await recordCost(app, second, 0.8);
        await assert.rejects(say(app, second, "Do not renew my budget"), /spend limit/);
        const third = await request(`c/${chat}/private-agent`, {
            action: "new_chat",
            requestId: "chat-3",
        });

        await assert.rejects(
            say(app, third.body.id as ConversationId, "Nor in another chat"),
            /spend limit/,
        );
        await app.close();
        app = await openApp(model, data);
        const fourth = await request(`c/${chat}/private-agent`, {
            action: "new_chat",
            requestId: "chat-4-after-restart",
        });

        await assert.rejects(
            say(app, fourth.body.id as ConversationId, "Nor after restarting"),
            /spend limit/,
        );
    } finally {
        await app.close();
    }
});
