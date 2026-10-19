// Linked sessions (`linked-sessions.ts`): a repeat acts once, a link shares nothing, and the checks of whom Pi works for
// apply before anything is made or sent.
import {
    type App,
    cleanUp,
    context,
    fakeTab,
    modelTexts,
    newSession,
    openApp,
    owner,
    recordCost,
    root,
    say,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import {
    LinkedSessionCallsDoc,
    LinkedSessionRelayDoc,
    type SessionMeta,
    SessionsDoc,
    TurnsDoc,
} from "../src/server/docs.ts";
import { importFixture } from "./import-fixtures.ts";
import { WorkflowDoc } from "../src/server/workflow-docs.ts";

let app: App;

before(async () => {
    const model = scriptedModel();

    // A model that thinks, so a linked session's thinking level has room to go too high.
    Object.assign(
        model.models.find((each) => each.id === "faux-1")!,
        { reasoning: true },
    );
    app = await openApp(model);
});
after(async () => {
    await app?.close();
    cleanUp();
});

/** A session with someone Pi works for: linked sessions act as them. */
async function source() {
    const id = await newSession(app);

    await say(app, id, "hello");

    return id;
}

const start = (id: ConversationId, key: string = crypto.randomUUID(), model?: string) =>
    app.linkedSessions.start(id, { title: "Linked", message: "a task", model }, key);
const send = (id: ConversationId, to: string, key: string = crypto.randomUUID()) =>
    app.linkedSessions.send(id, { to, message: "a message" }, key);
const sent = async (id: ConversationId) =>
    (await modelTexts(app, id)).filter(
        (text) => text.includes("<linked-session-message>") && !text.includes("echo:"),
    ).length;

test("a linked session from an owner-only import stays hidden from other people, including after reopen", async () => {
    const data = join(root, "linked-private-data");
    const directory = join(work, "linked-private-import");
    const model = scriptedModel();
    let isolated = await openApp(model, data);

    mkdirSync(directory, { recursive: true });

    try {
        const fixture = importFixture(directory);
        const preview = await isolated.piSessions.preview(owner(isolated), { path: fixture.path });
        const imported = await isolated.piSessions.create(owner(isolated), {
            path: preview.path,
            sha256: preview.sha256,
            leafId: preview.leafId,
            stopped: true,
            acknowledged: true,
            model: "faux/faux-vision",
            thinkingLevel: "off",
        });
        const guest = isolated.config.addUser("Private team outsider", "guest").user;

        assert.equal(isolated.sessionMeta(imported.id)?.ownerOnly, true);
        assert.equal(isolated.canSee(guest, imported.id), false);
        await say(isolated, imported.id, "Owner continuation");
        const { session: child } = await isolated.linkedSessions.start(
            imported.id,
            { message: "PRIVATE_LINKED_TASK" },
            "private-start",
        );

        assert.equal(isolated.canSee(guest, child), false, "linking must not publish private work");
        assert.equal(isolated.canSee(owner(isolated), child), true);
        assert.equal(
            isolated.sessions(guest).some((entry) => entry.id === Number(child)),
            false,
        );
        await assert.rejects(
            isolated.commands.submit(child, guest, { text: "Not shared", requestId: "outsider" }),
            /not shared/,
        );
        await until(
            async () =>
                (await modelTexts(isolated, child)).some((text) =>
                    text.includes("PRIVATE_LINKED_TASK"),
                ),
            "the linked task is actually delivered",
        );

        await isolated.close();
        isolated = await openApp(model, data);
        assert.equal(isolated.canSee(guest, child), false);
        assert.equal(isolated.sessionMeta(child)?.ownerOnly, true);
        assert.equal(
            isolated.sessions(guest).some((entry) => entry.id === Number(child)),
            false,
        );
    } finally {
        await isolated.close();
    }
});

test("new linked roots are independent Chats that retain granted project membership after reopen", async () => {
    const data = join(root, "linked-chat-data");
    const model = scriptedModel();
    let isolated = await openApp(model, data);

    try {
        const projectId = (
            await isolated.projects.create(owner(isolated), {
                name: "Linked project",
                cwd: work,
                requestId: "linked-project",
            })
        ).id;
        const guest = isolated.config.addUser(
            "Project team caller",
            "guest",
            undefined,
            undefined,
            { projectIds: [projectId] },
        ).user;
        const { id: origin } = await isolated.commands.createSession(guest, {
            projectId,
            threadType: "chat",
        });

        await isolated.commands.configure(origin, guest, {
            model: { provider: "faux", modelId: "faux-1" },
        });
        const submitted = await isolated.commands.submit(origin, guest, {
            text: "Start ordinary independent work",
            requestId: "linked-project-input",
        });

        await (await isolated.harness.submission(submitted.submissionId, context))!.wait(context);
        const { session: child } = await isolated.linkedSessions.start(
            origin,
            { message: "A linked task" },
            "chat-start",
        );

        assert.equal(isolated.sessionMeta(child)?.threadType, "chat");
        assert.equal(isolated.rootOf(child), child, "a link is not Durable parentage");
        assert.equal(isolated.cwdOf(child), isolated.cwdOf(origin));
        assert.equal(isolated.sessionMeta(child)?.projectId, projectId);
        assert.equal(isolated.canSee(guest, child), true);
        await until(
            async () =>
                (await modelTexts(isolated, child)).some((text) => text.includes("A linked task")),
            "the project collaborator's linked task is delivered",
        );
        await isolated.close();
        isolated = await openApp(model, data);
        assert.equal(isolated.sessionMeta(child)?.threadType, "chat");
        assert.equal(isolated.sessionMeta(child)?.linkedFrom?.id, Number(origin));
        assert.equal(isolated.sessionMeta(child)?.projectId, projectId);
        assert.equal(isolated.canSee(guest, child), true);
        assert.equal(isolated.rootOf(child), child);
    } finally {
        await isolated.close();
    }
});

test("legacy untyped links migrate to Chats while ordinary legacy and explicit types retain their meaning", async () => {
    const data = join(root, "linked-migration-data");
    const model = scriptedModel();
    let isolated = await openApp(model, data);

    try {
        // Store the old catalogue shape through Durable's public API, as the legacy project migration tests do.
        const create = async (metadata: Partial<SessionMeta> = {}) => {
            const conversation = await isolated.harness.createConversation(
                {
                    ownership: { kind: "ownerless" },
                    agent: { cwd: work },
                    init: async (tx, id) => {
                        (await tx.doc(SessionsDoc)).items[String(id)] = {
                            cwd: work,
                            createdAt: 100,
                            updatedAt: 100,
                            ...metadata,
                        };
                    },
                },
                context,
            );

            return conversation.id;
        };

        const ordinary = await create();
        const linked = await create({ linkedFrom: { id: Number(ordinary) } });
        const explicitChat = await create({ threadType: "chat" });
        const explicitWorker = await create({
            linkedFrom: { id: Number(ordinary) },
            threadType: "worker",
        });

        await isolated.close();
        isolated = await openApp(model, data);
        assert.equal(
            isolated.sessionMeta(linked)?.threadType,
            "chat",
            "legacy links stay unmanaged",
        );
        assert.equal(isolated.sessionMeta(ordinary)?.threadType, "worker");
        assert.equal(isolated.sessionMeta(explicitChat)?.threadType, "chat");
        assert.equal(isolated.sessionMeta(explicitWorker)?.threadType, "worker");
        const durable = await isolated.harness.snapshot(SessionsDoc, context);

        assert.equal(durable?.items[String(linked)]?.threadType, "chat", "migration is durable");
        assert.equal(durable?.items[String(ordinary)]?.threadType, "worker");
        await isolated.close();
        isolated = await openApp(model, data);
        assert.equal(isolated.sessionMeta(linked)?.threadType, "chat");
        assert.equal(isolated.sessionMeta(explicitWorker)?.threadType, "worker");
    } finally {
        await isolated.close();
    }
});

test("a repeated start or send makes one session or one message", async () => {
    const id = await source();
    const { session: target, address } = await app.linkedSessions.start(
        id,
        { message: "a task", thinking: "high" },
        "start-key",
    );
    const count = app.sessions().length;

    // Never thinking harder than the session that started it, which is at "off".
    assert.equal((await app.agentState(target))?.thinkingLevel, "off");

    assert.equal((await start(id, "start-key")).session, target);
    assert.equal(app.sessions().length, count);
    await send(id, address, "send-key");
    await send(id, address, "send-key");
    await until(async () => (await sent(target)) > 1, "the messages");
    assert.equal(await sent(target), 2);
});

test("someone who cannot see the origin learns nothing of it and cannot reach it", async () => {
    const id = await source();

    await app.commands.updateSession(id, owner(app), { title: "Secret origin" });
    const { session: target } = await start(id);
    const { user } = app.config.addUser("Target only", "guest", [String(target)]);
    // Someone who sees the linked session but not the origin: the origin's name stays out of the list Pi gets.
    const [origin] = await app.linkedSessions.list(target);

    assert.ok(origin !== undefined && origin.title === undefined && origin.cwd === undefined);
    const tab = fakeTab(undefined, user);

    await app.attach(tab.client);
    // A later change goes out in a broadcast, which must be this person's own list too.
    await app.commands.updateSession(target, owner(app), { title: "Renamed" });
    const lists = () => tab.events.filter((each) => each.event === "sessions");

    await until(() => lists().length > 1, "a list");
    app.detach(tab.client);

    for (const list of [app.sessions(user), ...lists().map((each) => each.data)]) {
        assert.ok(!JSON.stringify(list).includes("Secret origin"));
        assert.ok(!JSON.stringify(list).includes(`"id":${Number(id)}`));
    }

    // With Pi working for them in the linked session, its peers are out of reach.
    await app.commands.submit(target, user, { text: "hello", requestId: "guest" });
    assert.deepEqual(await app.linkedSessions.list(target), []);
    await assert.rejects(send(target, origin.address), /not linked/);
});

test("a start or send is refused in plan mode, past a spend limit, or without the turn", async () => {
    const id = await source();
    const { session: target, address } = await start(id);
    const count = app.sessions().length;

    await until(async () => (await sent(target)) === 1, "the first message");
    await assert.rejects(start(target), /cannot start/);

    const refused = async (why: RegExp) => {
        await assert.rejects(start(id), why);
        await assert.rejects(send(id, address), why);
        assert.equal(app.sessions().length, count);
        assert.equal(await sent(target), 1);
    };

    await app.commands.setPlan(id, owner(app), true);
    await refused(/plan mode/);
    await app.commands.setPlan(id, owner(app), false);

    // What the linked session spent counts against the budget of the session that started it.
    await recordCost(app, target, 0.02);
    await until(() => app.spend.sessionSpent(target) === 0.02, "the spend");
    await app.spend.setSessionBudget(owner(app), id, 0.01);
    await refused(/spend limit/);
    await app.spend.setSessionBudget(owner(app), id, null);

    // Twenty messages between the team's sessions with no person writing: no more until one does.
    await app.harness.commit(async (tx) => {
        (await tx.doc(LinkedSessionRelayDoc, id)).sent = 20;
    }, context);
    await refused(/without a person/);

    const driver = app.config.addUser("Driver", "guest").user;

    await app.harness.commit(async (tx) => {
        Object.assign(await tx.doc(TurnsDoc, id), { on: true, driver: driver.id, asks: [] });
    }, context);
    await refused(/driving/);
});

test("an unavailable model creates no session", async (t) => {
    const id = await source();
    const count = app.sessions().length;
    const key = "unavailable";

    // A model that is neither the session's own nor on the owner's list for subagents is refused.
    await assert.rejects(start(id, key, "faux/faux-2"), /not allowed/);
    await app.allowSubagentModel(owner(app), "faux/faux-2", true);
    t.mock.method(app.providers, "problem", async () => "its sign-in expired");
    await assert.rejects(start(id, key, "faux/faux-2"), /sign-in expired/);
    assert.equal(app.sessions().length, count);

    const token = createHash("sha256").update(`${id}:${key}`).digest("hex");

    assert.equal(
        (await app.harness.snapshot(LinkedSessionCallsDoc, id, context))?.items[token],
        undefined,
    );
});

test("managed roots and managed linked peers cannot start or receive team work, even on receipt reuse", async () => {
    const id = await source();
    const key = "managed-peer-start";
    const { session: child, address } = await start(id, key);

    await send(id, address, "before-management");
    await until(async () => (await sent(child)) === 2, "the unmanaged messages");
    const count = app.sessions().length;
    const manage = (target: ConversationId) =>
        app.harness.commit(async (tx) => {
            // A persisted proposal makes even an explicitly typed Chat managed, without changing its role or linkage.
            (await tx.doc(WorkflowDoc, target)).proposal = {
                targetType: "reviewer",
                relationship: "same-work",
                brief: "This Chat now belongs to managed workflow policy.",
            };
        }, context);

    await manage(child);
    assert.equal(app.sessionMeta(child)?.threadType, "chat");
    assert.equal(app.handoffs.isManaged(id), false);
    assert.equal(app.handoffs.isManaged(child), true);
    await assert.rejects(send(id, address), /managed workflows/);
    await assert.rejects(send(id, address, "before-management"), /managed workflows/);
    await assert.rejects(start(id, key), /managed workflows/);
    await manage(id);
    await assert.rejects(start(id), /managed workflows/);
    await assert.rejects(start(id, key), /managed workflows/);
    await assert.rejects(send(id, address), /managed workflows/);
    assert.equal(app.sessions().length, count);
    assert.equal(await sent(child), 2, "denials admit no messages");
});

test("a team start rechecks management after asynchronous model admission without creating a child", async (t) => {
    const id = await source();
    const count = app.sessions().length;
    const original = app.providers.problem.bind(app.providers);

    t.mock.method(app.providers, "problem", async (...args: Parameters<typeof original>) => {
        const result = await original(...args);

        await app.harness.commit(async (tx) => {
            (await tx.doc(WorkflowDoc, id)).readOnly = true;
        }, context);

        return result;
    });
    await assert.rejects(start(id), /managed workflows/);
    assert.equal(app.sessions().length, count);
});

test("a session that started others shows what counts against its limit: theirs too", async () => {
    const id = await source();
    const { session: child } = await start(id);

    await app.spend.setSessionBudget(owner(app), id, 1);
    await recordCost(app, id, 0.25);
    await recordCost(app, child, 0.5);

    const row = app.spend.summary(owner(app)).sessions.find((each) => each.id === Number(id));

    assert.equal(row?.spent, 0.75);
});
