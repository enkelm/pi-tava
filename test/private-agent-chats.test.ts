// Owner routes are the identity seam: a chat is history, not a new agent.
import assert from "node:assert/strict";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { after, test } from "node:test";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { type ConversationId } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { TITLE_PROMPT } from "../src/server/titles.ts";
import { createHandler } from "../src/server/http.ts";
import { SessionsDoc } from "../src/server/docs.ts";
import { privateAgentRequest } from "./private-agent-http.ts";
import { AgentIdentitiesDoc } from "../src/server/agent-identity-docs.ts";
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
    work,
    newSession,
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

test("owner moves only the exact saved named Chat through the native session route", async (t) => {
    const app = await openApp(
        scriptedModel((input) => {
            const system = JSON.stringify(
                input.messages.filter((message) => message.role === "system"),
            );
            const last = lastText(input);

            if (
                system.includes("the owner's persistent private agent") &&
                last.role === "user" &&
                last.text.includes("Create a bounded child")
            ) {
                return fauxAssistantMessage(
                    [
                        fauxToolCall("handoff", {
                            action: "start",
                            targetType: "researcher",
                            relationship: "new-work",
                            summary: "Keep independent child placement when the parent Chat moves.",
                        }),
                    ],
                    { stopReason: "toolUse" },
                );
            }

            if (system.includes("the private supervisor for Work Item")) {
                return fauxAssistantMessage(
                    [
                        fauxToolCall("work_supervise", {
                            action: "wait",
                            text: "Wait for owner input.",
                        }),
                    ],
                    { stopReason: "toolUse" },
                );
            }

            return fauxAssistantMessage("Retained Chat answer.");
        }),
        join(root, "named-chat-placement"),
    );

    t.after(() => app.close());
    app.config.lastModel = { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
    const user = owner(app);
    const cwd = join(work, "named-chat-origin");
    const otherCwd = join(work, "named-chat-destination");

    mkdirSync(cwd, { recursive: true });
    mkdirSync(otherCwd, { recursive: true });
    const original = await app.projects.create(user, {
        name: "Chat origin",
        cwd,
        requestId: "chat-origin",
    });
    const destination = await app.projects.create(user, {
        name: "Chat destination",
        cwd: otherCwd,
        requestId: "chat-destination",
    });
    const agent = await app.pip.agents.createIdentity(user, {
        name: "Movable Chat owner",
        projectId: original.id,
        requestId: "movable-identity",
    });
    const first = await app.pip.agents.submitDraft(agent.agentId, user, {
        text: "Keep the exact saved Chat history and working folder",
        requestId: "first-saved-chat",
    });
    const second = await app.pip.agents.submitDraft(agent.agentId, user, {
        text: "A sibling retains its own placement",
        requestId: "sibling-saved-chat",
    });

    await (await app.harness.submission(first.submissionId, context))!.wait(context);
    await (await app.harness.submission(second.submissionId, context))!.wait(context);
    const chat = first.id as ConversationId;

    await say(app, chat, "Create a bounded child Researcher Work Item in this Chat's project.");
    const child = app.sessions(user).find((session) => session.threadType === "researcher")!
        .id as ConversationId;
    const childPlacement = app.sessionMeta(child)?.projectId;
    const identity = app.pip.agents.identity(chat);
    const before = app.sessionMeta(chat)!;
    const history = (await (await app.conversation(chat)).context(context)).entries;
    const model = await app.agentState(chat);
    const request = (path: string, body?: unknown, token?: string) =>
        privateAgentRequest(app, path, body, token);

    assert.equal(before.projectId, original.id);
    assert.equal(childPlacement, original.id);
    assert.equal(
        app.sessions(user).some((session) => session.id === Number(chat)),
        false,
    );
    const moved = await request(`sessions/${chat}`, { projectId: destination.id });

    assert.equal(moved.status, 200, await moved.text());
    assert.equal(app.sessionMeta(chat)?.projectId, destination.id);
    assert.equal(
        app.pip.agents
            .list(user)
            .find((item) => item.agentId === agent.agentId)!
            .chats.find((item) => item.id === Number(chat))!.projectId,
        destination.id,
        "the private catalogue reports actual Chat placement",
    );
    assert.equal(app.sessionMeta(second.id as ConversationId)?.projectId, original.id);
    assert.equal(app.sessionMeta(child)?.projectId, childPlacement);
    assert.deepEqual(app.pip.agents.identity(chat), identity, "moving is not an identity edit");
    assert.deepEqual(await app.agentState(chat), model, "moving cannot reconfigure the agent");
    assert.deepEqual((await (await app.conversation(chat)).context(context)).entries, history);
    const { projectId: _projectId, updatedAt: _updatedAt, ...preserved } = before;
    const { projectId: _movedProject, updatedAt: _movedAt, ...after } = app.sessionMeta(chat)!;

    assert.deepEqual(after, preserved, "privacy, type, cwd and all other metadata stay unchanged");
    assert.equal(app.cwdOf(chat), cwd);

    for (const patch of [
        { projectId: "missing-project" },
        { projectId: 12 },
        { projectId: null, title: "Not identity settings" },
        { projectId: null, archived: true },
    ]) {
        const denied = await request(`sessions/${chat}`, patch);

        assert.ok([400, 404, 409].includes(denied.status), await denied.text());
        assert.equal(app.sessionMeta(chat)?.projectId, destination.id);
    }

    for (const role of ["guest", "owner"] as const) {
        const outsider = app.config.addUser(`Other ${role}`, role);
        const denied = await request(`sessions/${chat}`, { projectId: null }, outsider.token);

        assert.equal(denied.status, 404, await denied.text());
    }

    const cleared = await request(`sessions/${chat}`, { projectId: null });

    assert.equal(cleared.status, 200, await cleared.text());
    assert.equal(app.sessionMeta(chat)?.projectId, undefined);
    assert.equal(app.cwdOf(chat), cwd);
    assert.equal(app.sessionMeta(second.id as ConversationId)?.projectId, original.id);
    assert.equal(app.sessionMeta(child)?.projectId, childPlacement);
    assert.deepEqual(app.pip.agents.identity(chat), identity);
    assert.deepEqual((await (await app.conversation(chat)).context(context)).entries, history);
});

test("both placement routes reject private non-Chats, unsaved reservations and stale Chat bindings", async (t) => {
    const app = await openApp(scriptedModel(), join(root, "named-chat-placement-guards"));

    t.after(() => app.close());
    app.config.lastModel = { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
    const user = owner(app);
    const destination = await app.projects.create(user, {
        name: "Guarded destination",
        cwd: work,
        requestId: "guarded-project",
    });
    const agent = await app.pip.agents.create(user, {
        name: "Bound identity",
        requestId: "bound-identity",
    });
    const chat = agent.id as ConversationId;
    const otherIdentity = await app.pip.agents.createIdentity(user, {
        name: "Other identity",
        requestId: "other-identity",
    });
    const generic = await app.pip.ensure(user);
    const source = await newSession(app, work, "worker");
    const controller = (await app.pip.orchestration.control(source, user, { action: "open" }))
        .orchestration!.conversationId as ConversationId;
    const paths = (id: number) => [`sessions/${id}`, `c/${id}/x/work-items/work-item`];
    const patch = { projectId: destination.id };

    const denied = async (id: number, label: string) => {
        const before = app.sessionMeta(id as ConversationId);

        for (const path of paths(id)) {
            const response = await privateAgentRequest(app, path, patch);

            assert.equal(response.status, 409, `${label}: ${path}: ${await response.text()}`);
            assert.deepEqual(app.sessionMeta(id as ConversationId), before);
        }
    };

    await denied(Number(generic), "global PiP is not saved Chat history");
    await denied(Number(controller), "a Work Item controller is not a named Chat");
    await app.pip.agents.setBudget(chat, user, 0);
    await assert.rejects(
        app.pip.agents.submitDraft(agent.agentId, user, {
            text: "Rejected first input",
            requestId: "unsaved-placement",
        }),
        /spend limit/,
    );
    const reservation = Object.values(
        (await app.harness.snapshot(AgentIdentitiesDoc, context))!.requests,
    ).find((entry) => entry.firstInputRequestId?.endsWith(":unsaved-placement"))!;

    assert.ok(reservation.chatId, "native rejected admission retained an unsaved reservation");
    await denied(reservation.chatId, "a reservation must not become saved history by moving");
    await app.pip.agents.setBudget(chat, user, undefined);
    const meta = structuredClone(app.sessionMeta(chat)!);
    const identity = structuredClone(app.pip.agents.identity(chat)!);

    for (const binding of [
        "unbound legacy",
        "deleted identity",
        "wrong owner",
        "wrong identity",
        "not a member",
        "not owner-private",
        "work-item member",
        "controller flag",
    ]) {
        await app.harness.commit(async (tx) => {
            const sessions = await tx.doc(SessionsDoc);
            const identities = await tx.doc(AgentIdentitiesDoc);

            sessions.items[String(chat)] = structuredClone(meta);
            identities.items[agent.agentId] = structuredClone(identity);
            const current = sessions.items[String(chat)]!;
            const bound = identities.items[agent.agentId]!;

            switch (binding) {
                case "unbound legacy":
                    delete current.pipAgentId;
                    break;
                case "deleted identity":
                    bound.deletedAt = Date.now();
                    break;
                case "wrong owner":
                    bound.ownerId = "another-owner";
                    break;
                case "wrong identity":
                    current.pipAgentId = otherIdentity.agentId;
                    break;
                case "not a member":
                    bound.chatIds = [];
                    break;
                case "not owner-private":
                    current.ownerOnly = false;
                    break;
                case "work-item member":
                    current.workItemId = "not-a-real-group";
                    break;
                case "controller flag":
                    current.pipWorkItemId = "not-a-real-controller";
                    break;
            }
        }, context);
        await denied(Number(chat), binding);
    }

    await app.harness.commit(async (tx) => {
        (await tx.doc(SessionsDoc)).items[String(chat)] = meta;
        (await tx.doc(AgentIdentitiesDoc)).items[agent.agentId] = identity;
    }, context);

    for (const path of paths(Number(chat))) {
        for (const mixed of [{ title: "Do not rename" }, { archived: true }]) {
            const response = await privateAgentRequest(app, path, { ...patch, ...mixed });

            assert.equal(response.status, 400, `${path}: ${await response.text()}`);
            assert.deepEqual(app.sessionMeta(chat), meta);
        }
    }
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
