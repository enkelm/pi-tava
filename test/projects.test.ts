// Real Pocket app, HTTP and SQLite own membership, privacy, atomicity and retry behavior.
import {
    type App,
    cleanUp,
    context,
    fakeTab,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { User } from "../src/server/config.ts";
import { ProjectsDoc, SessionsDoc } from "../src/server/docs.ts";
import { HttpError } from "../src/server/errors.ts";
import { createHandler } from "../src/server/http.ts";
import { importFixture } from "./import-fixtures.ts";

let app: App;
const data = join(root, "projects-data");
const model = scriptedModel();
const status = (expected: number) => (error: unknown) =>
    error instanceof HttpError && error.status === expected;

before(async () => {
    app = await openApp(model, data);
});
after(async () => {
    await app?.close();
    cleanUp();
});

function folder(name: string): string {
    const cwd = join(work, name);

    mkdirSync(cwd, { recursive: true });

    return cwd;
}

async function project(name: string, cwd = work, user = owner(app)): Promise<string> {
    return (await app.projects.create(user, { name, cwd, requestId: crypto.randomUUID() })).id;
}

async function worker(projectId: string): Promise<{ id: ConversationId; goalId: string }> {
    const { id } = await app.commands.createSession(owner(app), { projectId, newGoal: true });
    const goalId = app.sessionMeta(id)?.goalId;

    assert.ok(goalId);

    return { id, goalId };
}

function findGoal(id: string) {
    const goal = app.projects.list(owner(app)).goals.find((item) => item.id === id);

    assert.ok(goal);

    return goal;
}

async function importedOwnerOnly(name: string): Promise<ConversationId> {
    const fixture = importFixture(folder(name));
    const preview = await app.imports.preview(owner(app), { path: fixture.path });
    const imported = await app.imports.create(owner(app), {
        path: preview.path,
        sha256: preview.sha256,
        leafId: preview.leafId,
        stopped: true,
        acknowledged: true,
        model: "faux/faux-1",
        thinkingLevel: "off",
    });

    assert.equal(app.sessionMeta(imported.id)?.ownerOnly, true);

    return imported.id;
}

// Creation owns defaults and membership; assigning/editing a project never reconfigures an existing agent.
test("projects have opaque identity, multi-thread goals and independent type and working directory", async () => {
    const source = folder("identity-source");
    const destination = folder("identity-destination");
    const projectId = await project("First", source);
    const otherProjectId = await project("Second at the same path", source);
    const first = await worker(projectId);
    const second = await app.commands.createSession(owner(app), {
        projectId,
        goalId: first.goalId,
    });
    const chat = await app.commands.createSession(owner(app), {
        projectId,
        goalId: first.goalId,
        threadType: "chat",
        cwd: work,
    });
    const ungrouped = await app.commands.createSession(owner(app), {});

    assert.notEqual(projectId, otherProjectId);
    assert.equal(app.sessionMeta(first.id)?.threadType, "worker");
    assert.equal(app.sessionMeta(second.id)?.goalId, first.goalId);
    assert.equal(app.sessionMeta(chat.id)?.threadType, "chat");
    assert.equal(app.sessionMeta(ungrouped.id)?.threadType, "chat");
    assert.equal(app.cwdOf(first.id), source);
    assert.equal(app.cwdOf(second.id), source);
    assert.equal(app.cwdOf(chat.id), work);
    assert.equal(findGoal(first.goalId).name, "New goal");
    assert.equal(findGoal(first.goalId).namingThreadId, Number(first.id));
    assert.equal(findGoal(first.goalId).named, false);
    assert.equal(findGoal(first.goalId).createdBy, owner(app).id);

    await app.projects.update(owner(app), projectId, { name: "Renamed", cwd: destination });
    const later = await app.commands.createSession(owner(app), { projectId });

    assert.equal(app.cwdOf(later.id), destination);
    assert.equal(app.cwdOf(first.id), source);
    assert.equal(app.cwdOf(chat.id), work);
    assert.equal(
        app.projects.list(owner(app)).projects.find((item) => item.id === projectId)?.name,
        "Renamed",
    );
    await app.goals.set(first.id, owner(app).id, "true");
    await app.projects.updateGoal(owner(app), first.goalId, { status: "completed" });
    assert.equal(findGoal(first.goalId).status, "completed");
    assert.equal((await app.goals.get(first.id))?.status, "working");
    const completed = await app.commands.createSession(owner(app), { goalId: first.goalId });

    assert.equal(app.sessionMeta(completed.id)?.projectId, projectId);
    assert.equal(app.sessionMeta(completed.id)?.goalId, first.goalId);
});

// HTTP owns shape, authentication/CSRF, role denial and filtered live catalogue delivery.
test("HTTP lists only visible scoped memberships without cwd, names, empty goals or hidden naming ids", async () => {
    const projectId = await project("Visible project", folder("http-visible"));
    const otherProjectId = await project("UNRELATED_PROJECT_NAME", folder("http-unrelated"));
    const first = await worker(projectId);
    const visible = await app.commands.createSession(owner(app), {
        projectId,
        goalId: first.goalId,
    });
    const emptyGoal = await worker(projectId);

    await app.projects.assign(owner(app), emptyGoal.id, { projectId: otherProjectId });
    const viewer = app.config.addUser("Project viewer", "viewer", [String(visible.id)]);
    const scoped = app.config.addUser("Scoped steer", "guest", [String(visible.id)]);
    const full = app.config.addUser("Full steer", "guest");
    const elsewhere = app.config.addUser("No membership", "viewer", []);
    const tab = fakeTab(undefined, viewer.user);
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();

    assert.ok(address !== null && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}/api`;
    const request = (
        path: string,
        body?: unknown,
        token: string | null = viewer.token,
        csrf = true,
    ) =>
        fetch(base + path, {
            method: body === undefined ? "GET" : "POST",
            headers: {
                "content-type": "application/json",
                ...(token === null ? {} : { authorization: `Bearer ${token}` }),
                ...(csrf ? { "x-pocket": "1" } : {}),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });

    const post = async (path: string, body: unknown, token: string, expected = 200) => {
        const response = await request(path, body, token);

        assert.equal(response.status, expected, await response.clone().text());

        return response.json();
    };

    try {
        assert.equal((await request("/projects", undefined, null)).status, 401);
        assert.equal(
            (
                await request(
                    "/projects",
                    { name: "No CSRF", cwd: work, requestId: "csrf" },
                    full.token,
                    false,
                )
            ).status,
            403,
        );
        assert.deepEqual(await (await request("/projects", undefined, elsewhere.token)).json(), {
            projects: [],
            goals: [],
        });
        const listed = await (await request("/projects")).json();

        assert.deepEqual(
            listed.projects.map((item: { id: string }) => item.id),
            [projectId],
        );
        assert.deepEqual(
            listed.goals.map((item: { id: string }) => item.id),
            [first.goalId],
        );
        assert.equal(Object.hasOwn(listed.projects[0], "cwd"), false);
        assert.equal(Object.hasOwn(listed.goals[0], "namingThreadId"), false);
        assert.equal(Object.hasOwn(listed.goals[0], "namingTaskId"), false);
        assert.equal(Object.hasOwn(listed, "requests"), false);
        assert.equal(JSON.stringify(listed).includes("UNRELATED_PROJECT_NAME"), false);
        assert.equal(JSON.stringify(listed).includes(emptyGoal.goalId), false);
        await app.attach(tab.client);
        assert.deepEqual(tab.last("projects"), listed);

        for (const token of [viewer.token, scoped.token]) {
            for (const [path, body] of [
                ["/projects", { name: "Denied", cwd: work, requestId: "denied" }],
                [`/projects/${projectId}`, { name: "Denied" }],
                [`/project-goals/${first.goalId}`, { status: "completed", archived: true }],
                [`/sessions/${visible.id}`, { projectId: otherProjectId }],
            ] as const) {
                await post(path, body, token, 403);
            }
        }

        for (const body of [{ name: 4 }, { cwd: false }, { name: "" }, { name: "NUL\0name" }]) {
            await post(`/projects/${projectId}`, body, full.token, 400);
        }

        for (const body of [{ status: "paused" }, { archived: "true" }, { name: null }]) {
            await post(`/project-goals/${first.goalId}`, body, full.token, 400);
        }

        const created = await post(
            "/projects",
            { name: "Guest-created", cwd: work, requestId: "guest-create" },
            full.token,
        );

        assert.equal(typeof created.id, "string");
        await post(`/projects/${projectId}`, { name: "Shared rename" }, full.token);
        await post(
            `/project-goals/${first.goalId}`,
            { name: "Manual goal name", status: "completed" },
            full.token,
        );
        await until(
            () => JSON.stringify(tab.last("projects")).includes("Manual goal name"),
            "live committed goal projection",
        );
        assert.equal(findGoal(first.goalId).named, true);
        await post(`/sessions/${visible.id}`, { projectId: otherProjectId }, full.token);
        await until(() => {
            const projection = tab.last("projects") as
                { projects?: { id: string }[]; goals?: unknown[] } | undefined;

            return (
                projection?.projects?.[0]?.id === otherProjectId && projection.goals?.length === 0
            );
        }, "projection follows membership rather than granting project access");
        assert.deepEqual(
            app.sessions(viewer.user).map((item) => item.id),
            [Number(visible.id)],
        );
        const moved = await (await request("/projects")).json();

        assert.deepEqual(
            moved.projects.map((item: { id: string }) => item.id),
            [otherProjectId],
        );
        assert.equal(Object.hasOwn(moved.projects[0], "cwd"), false);
        assert.deepEqual(moved.goals, []);
        await post(`/sessions/${visible.id}`, { projectId: null, goalId: null }, full.token);
        assert.deepEqual(await (await request("/projects")).json(), { projects: [], goals: [] });
    } finally {
        app.detach(tab.client);
        await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
        );
    }
});

// Bulk mutation owns one commit and archive provenance; prior/manual archived state is not an undo target.
test("goal archive/restore groups Worker and Chat threads while preserving earlier and manual archives", async () => {
    const projectId = await project("Archive project");
    const first = await worker(projectId);
    const second = await app.commands.createSession(owner(app), {
        projectId,
        goalId: first.goalId,
    });
    const chat = await app.commands.createSession(owner(app), {
        projectId,
        goalId: first.goalId,
        threadType: "chat",
    });
    const earlier = await app.commands.createSession(owner(app), {
        projectId,
        goalId: first.goalId,
    });
    const outsider = await newSession(app);
    const ids = [first.id, second.id, chat.id, earlier.id];

    await app.commands.configure(earlier.id, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });
    await say(app, earlier.id, "Fork source");
    const reply = (await app.transcripts.allEntries(earlier.id, false)).find(
        (entry) => entry.kind === "assistant",
    );

    assert.ok(reply);
    await app.commands.updateSession(earlier.id, owner(app), { archived: true });
    const updatedBefore = ids.map((id) => app.sessionMeta(id)?.updatedAt);

    await app.projects.updateGoal(owner(app), first.goalId, {
        status: "completed",
        archived: true,
    });
    assert.equal(findGoal(first.goalId).status, "completed");
    assert.equal(findGoal(first.goalId).archived, true);
    assert.deepEqual(
        ids.map((id) => app.sessionMeta(id)?.archived),
        [true, true, true, true],
    );
    assert.notEqual(app.sessionMeta(outsider)?.archived, true);
    assert.equal(app.sessionMeta(chat.id)?.threadType, "chat");
    assert.deepEqual(
        ids.map((id) => app.sessionMeta(id)?.updatedAt),
        updatedBefore,
    );
    await assert.rejects(
        app.commands.createSession(owner(app), { projectId, goalId: first.goalId }),
        status(409),
    );
    await assert.rejects(
        app.projects.assign(owner(app), outsider, { projectId, goalId: first.goalId }),
        status(409),
    );
    assert.equal(app.sessionMeta(outsider)?.projectId, undefined);
    const fork = await app.commands.fork(earlier.id, owner(app), { entryId: reply.id });

    assert.equal(app.sessionMeta(fork.id)?.projectId, projectId);
    assert.equal(app.sessionMeta(fork.id)?.goalId, first.goalId);
    assert.equal(app.sessionMeta(fork.id)?.threadType, "worker");
    assert.equal(app.sessionMeta(fork.id)?.archived, true);
    assert.equal(app.sessionMeta(fork.id)?.archivedByGoal, first.goalId);
    assert.equal(app.sessionMeta(earlier.id)?.archivedByGoal, undefined);
    await app.projects.updateGoal(owner(app), first.goalId, { archived: true });
    await app.projects.updateGoal(owner(app), first.goalId, { archived: false });
    assert.deepEqual(
        ids.map((id) => app.sessionMeta(id)?.archived),
        [false, false, false, true],
    );
    assert.equal(app.sessionMeta(fork.id)?.archived, false);
    assert.equal(app.sessionMeta(fork.id)?.archivedByGoal, undefined);
    assert.equal(app.sessionMeta(earlier.id)?.archived, true);
    await app.projects.updateGoal(owner(app), first.goalId, { archived: true });
    await app.commands.updateSession(first.id, owner(app), { archived: false });
    assert.equal(findGoal(first.goalId).archived, false);
    assert.deepEqual(
        ids.map((id) => app.sessionMeta(id)?.archived),
        [false, true, true, true],
    );
    await app.commands.updateSession(first.id, owner(app), { archived: true });
    await app.projects.updateGoal(owner(app), first.goalId, { archived: false });
    assert.deepEqual(
        ids.map((id) => app.sessionMeta(id)?.archived),
        [true, false, false, true],
    );
    await app.projects.assign(owner(app), outsider, { projectId, goalId: first.goalId });
    assert.equal(app.sessionMeta(outsider)?.threadType, "chat");
    assert.equal(app.sessionMeta(outsider)?.cwd, work);
});

test("a full steering guest cannot partially archive a goal containing a hidden owner-only import", async () => {
    const projectId = await project("Private bulk target");
    const first = await worker(projectId);
    const hidden = await importedOwnerOnly("owner-only-bulk");
    const full = app.config.addUser("Full bulk guest", "guest").user;

    await app.projects.assign(owner(app), hidden, { projectId, goalId: first.goalId });
    const scoped = app.config.addUser("Visible bulk viewer", "viewer", [
        String(first.id),
        String(hidden),
    ]).user;
    const beforeProjects = await app.harness.snapshot(ProjectsDoc, context);
    const beforeSessions = await app.harness.snapshot(SessionsDoc, context);

    await assert.rejects(
        app.projects.updateGoal(full, first.goalId, { status: "completed", archived: true }),
        (error: unknown) => {
            assert.ok(error instanceof HttpError);
            assert.equal(error.status, 404);
            assert.equal(error.message.includes(String(hidden)), false);
            assert.equal(error.message.includes("owner-only"), false);

            return true;
        },
    );
    assert.deepEqual(await app.harness.snapshot(ProjectsDoc, context), beforeProjects);
    assert.deepEqual(await app.harness.snapshot(SessionsDoc, context), beforeSessions);
    assert.equal(
        app.sessions(full).some((item) => item.id === Number(hidden)),
        false,
    );
    assert.deepEqual(
        app.sessions(scoped).map((item) => item.id),
        [Number(first.id)],
    );
    assert.deepEqual(
        app.projects.list(scoped).goals.map((item) => item.id),
        [first.goalId],
    );
    await app.projects.updateGoal(owner(app), first.goalId, { archived: true });
    assert.equal(app.sessionMeta(first.id)?.archived, true);
    assert.equal(app.sessionMeta(hidden)?.archived, true);
    assert.equal(app.sessionMeta(hidden)?.ownerOnly, true);
    await assert.rejects(
        app.projects.updateGoal(full, first.goalId, { archived: false }),
        status(404),
    );
    assert.equal(findGoal(first.goalId).archived, true);
    await app.projects.updateGoal(owner(app), first.goalId, { archived: false });
    assert.equal(app.sessionMeta(first.id)?.archived, false);
    assert.equal(app.sessionMeta(hidden)?.archived, false);
    assert.equal(app.sessionMeta(hidden)?.ownerOnly, true);
    const prepared = app.projects.prepare(full, { projectId, goalId: first.goalId });
    const chat = await app.commands.createSession(full, { cwd: work });

    await app.projects.assign(owner(app), first.id, { projectId: null });
    await app.projects.updateGoal(owner(app), first.goalId, {
        name: "Private plan after the last shared thread left",
        status: "completed",
        archived: true,
    });
    assert.equal(
        app.projects.list(full).goals.some((item) => item.id === first.goalId),
        false,
    );
    const hiddenProjects = await app.harness.snapshot(ProjectsDoc, context);
    const hiddenSessions = await app.harness.snapshot(SessionsDoc, context);

    // A remembered ID cannot publish a new visible member and thereby reveal the private goal.
    await assert.rejects(app.projects.assign(full, chat.id, { goalId: first.goalId }), status(404));
    await assert.rejects(
        app.commands.createSession(full, { projectId, goalId: first.goalId }),
        status(404),
    );
    await assert.rejects(
        app.harness.createConversation(
            {
                ownership: { kind: "ownerless" },
                agent: { cwd: work },
                init: async (tx, id) => {
                    await app.projects.place(tx, id, prepared);
                },
            },
            context,
        ),
        status(404),
    );
    assert.deepEqual(await app.harness.snapshot(ProjectsDoc, context), hiddenProjects);
    assert.deepEqual(await app.harness.snapshot(SessionsDoc, context), hiddenSessions);
    assert.equal(
        app.projects.list(full).goals.some((item) => item.id === first.goalId),
        false,
    );
});

// Legacy fixtures use the public harness to store the old catalogue shape, not a production test hook.
async function legacySession(): Promise<ConversationId> {
    const conversation = await app.harness.createConversation(
        {
            ownership: { kind: "ownerless" },
            agent: {
                cwd: work,
                model: { provider: "faux", modelId: "faux-1" },
                thinkingLevel: "off",
            },
            init: async (tx, id) => {
                const sessions = await tx.doc(SessionsDoc);

                sessions.items[String(id)] = { cwd: work, createdAt: 100, updatedAt: 100 };
            },
        },
        context,
    );

    return conversation.id;
}

test("moves preserve legacy Workers, explicit Chats, directory, goal clearing and driver rights", async () => {
    const projectId = await project("Move origin", folder("move-origin"));
    const otherProjectId = await project("Move destination", folder("move-destination"));
    const first = await worker(projectId);
    const legacy = await legacySession();
    const full = app.config.addUser("Move guest", "guest").user;

    assert.equal(app.sessions().find((item) => item.id === Number(legacy))?.threadType, "worker");
    assert.equal(
        (await app.harness.snapshot(SessionsDoc, context))?.items[String(legacy)]?.threadType,
        undefined,
    );
    const chat = await newSession(app);

    await app.projects.assign(owner(app), chat, { projectId, goalId: first.goalId });
    assert.equal(app.sessionMeta(chat)?.threadType, "chat");
    assert.equal(app.cwdOf(chat), work);
    await app.projects.assign(owner(app), legacy, { projectId, goalId: first.goalId });
    assert.equal(app.sessionMeta(legacy)?.threadType, "worker");
    assert.equal(app.sessionMeta(legacy)?.cwd, work);
    await app.projects.assign(owner(app), legacy, { goalId: null });
    assert.equal(app.sessionMeta(legacy)?.projectId, projectId);
    assert.equal(app.sessionMeta(legacy)?.goalId, undefined);
    await app.projects.assign(owner(app), legacy, { goalId: first.goalId });
    await app.projects.assign(owner(app), legacy, { projectId: otherProjectId });
    assert.equal(app.sessionMeta(legacy)?.goalId, undefined);
    assert.equal(app.sessionMeta(legacy)?.threadType, "worker");
    assert.equal(app.sessionMeta(legacy)?.cwd, work);
    await app.projects.assign(owner(app), first.id, { projectId: null });
    assert.equal(app.sessionMeta(first.id)?.projectId, undefined);
    assert.equal(app.sessionMeta(first.id)?.goalId, undefined);
    assert.equal(app.sessionMeta(first.id)?.threadType, "worker");
    assert.equal(app.cwdOf(first.id), join(work, "move-origin"));
    await app.collab.turns(legacy, owner(app), { action: "on" });
    await assert.rejects(app.projects.assign(full, legacy, { projectId }), status(409));
    assert.equal(app.sessionMeta(legacy)?.projectId, otherProjectId);
    await app.collab.turns(legacy, owner(app), { action: "handover", to: full.id });
    await app.projects.assign(full, legacy, { projectId });
    assert.equal(app.sessionMeta(legacy)?.projectId, projectId);
    assert.equal(app.sessionMeta(legacy)?.threadType, "worker");
    await app.collab.turns(legacy, owner(app), { action: "off" });
});

test("preflight creates no goal and transactional revalidation rolls back raced folders, archives and access", async () => {
    const projectId = await project("Preflight", folder("preflight-source"));
    const first = await worker(projectId);
    const count = app.projects.list(owner(app)).goals.length;
    const prepared = app.projects.prepare(owner(app), { projectId, newGoal: true });

    assert.deepEqual(prepared, {
        projectId,
        newGoal: true,
        threadType: "worker",
        cwd: join(work, "preflight-source"),
    });
    assert.equal(app.projects.list(owner(app)).goals.length, count);

    for (const [request, expected] of [
        [{ newGoal: true }, 400],
        [{ projectId, newGoal: true, threadType: "chat" }, 400],
        [{ projectId, newGoal: true, goalId: first.goalId }, 400],
        [{ projectId: 2 }, 400],
        [{ goalId: false }, 400],
        [{ threadType: null }, 400],
        [{ projectId, newGoal: "true" }, 400],
        [{ projectId: "__proto__" }, 404],
        [{ goalId: "constructor" }, 404],
    ] as const) {
        assert.throws(() => app.projects.prepare(owner(app), request), status(expected));
    }

    // This non-repository would fail worktree preparation first if Commands validated selection too late.
    await assert.rejects(
        app.commands.createSession(owner(app), {
            projectId,
            goalId: "missing-goal",
            worktree: true,
        }),
        status(404),
    );
    assert.equal(app.projects.list(owner(app)).goals.length, count);

    const start = (selection: ReturnType<App["projects"]["prepare"]>) =>
        app.harness.createConversation(
            {
                ownership: { kind: "ownerless" },
                agent: { cwd: work },
                init: async (tx, id) => {
                    const placement = await app.projects.place(tx, id, selection);
                    const sessions = await tx.doc(SessionsDoc);

                    sessions.items[String(id)] = {
                        cwd: work,
                        createdAt: Date.now(),
                        updatedAt: Date.now(),
                        ...placement,
                    };
                },
            },
            context,
        );
    const conversationCount = () =>
        app.harness.commit(
            async (tx) => (await tx.scanConversations({}, 10_000)).items.length,
            context,
        );
    const conversationsBefore = await conversationCount();

    await app.projects.update(owner(app), projectId, { cwd: folder("preflight-changed") });
    await assert.rejects(start(prepared), status(409));
    assert.equal(app.projects.list(owner(app)).goals.length, count);
    assert.equal(await conversationCount(), conversationsBefore);
    const archivedSelection = app.projects.prepare(owner(app), { projectId, goalId: first.goalId });

    await app.projects.updateGoal(owner(app), first.goalId, { archived: true });
    await assert.rejects(start(archivedSelection), status(409));
    assert.equal(await conversationCount(), conversationsBefore);
    await app.projects.updateGoal(owner(app), first.goalId, { archived: false });
    const editor = app.config.addUser("Preflight revoked", "guest").user;
    const revoked = app.projects.prepare(editor, { projectId, newGoal: true });

    app.config.updateUser(editor.id, { role: "viewer" });
    await assert.rejects(start(revoked), status(403));
    assert.equal(app.projects.list(owner(app)).goals.length, count);
    assert.equal(await conversationCount(), conversationsBefore);
});

// Membership guards complement the separate naming task lifecycle/cost/rename tests.
test("delayed naming cannot claim a sibling thread or a different current goal", async () => {
    const projectId = await project("Naming guards");
    const first = await worker(projectId);
    const sibling = await app.commands.createSession(owner(app), {
        projectId,
        goalId: first.goalId,
    });
    const other = await worker(projectId);
    const name = (threadId: ConversationId, title: string, expectedGoalId: string) =>
        app.harness.commit(
            (tx) => app.projects.nameGoal(tx, threadId, title, expectedGoalId),
            context,
        );

    await name(sibling.id, "Wrong sibling title", first.goalId);
    assert.equal(findGoal(first.goalId).name, "New goal");
    assert.equal(findGoal(first.goalId).named, false);
    await app.projects.assign(owner(app), other.id, { goalId: first.goalId });
    await name(other.id, "Moved thread title", other.goalId);
    assert.equal(findGoal(other.goalId).name, "New goal");
    assert.equal(findGoal(other.goalId).named, false);
    await app.projects.assign(owner(app), other.id, { goalId: other.goalId });
    await name(other.id, "Wrong expected goal", first.goalId);
    assert.equal(findGoal(other.goalId).name, "New goal");
    await name(other.id, "Original goal title", other.goalId);
    assert.equal(findGoal(other.goalId).name, "Original goal title");
    assert.equal(findGoal(other.goalId).named, true);
});

// Restart owns durable receipts/cache recovery and the legacy Worker backfill, without inventing membership.
test("project and new-worker retries survive restart without duplicate goals or legacy membership migration", async () => {
    const request = {
        name: "Retry project",
        cwd: folder("retry-source"),
        requestId: "project-retry",
    };
    const [created, retried] = await Promise.all([
        app.projects.create(owner(app), request),
        app.projects.create(owner(app), request),
    ]);

    assert.equal(created.id, retried.id);
    const sessionRequest = { projectId: created.id, newGoal: true, requestId: "worker-retry" };
    const [session, duplicate] = await Promise.all([
        app.commands.createSession(owner(app), sessionRequest),
        app.commands.createSession(owner(app), sessionRequest),
    ]);
    const goalId = app.sessionMeta(session.id)?.goalId;

    assert.ok(goalId);
    assert.equal(session.id, duplicate.id);
    const legacy = await legacySession();
    const scoped = app.config.addUser("Retry scope", "viewer", [String(session.id)]).user;

    await app.projects.update(owner(app), created.id, {
        name: "Durable edited name",
        cwd: folder("retry-updated"),
    });
    await app.projects.updateGoal(owner(app), goalId, { status: "completed", archived: true });
    const goalsBefore = app.projects.list(owner(app)).goals.length;
    const sessionsBefore = app.sessions().length;

    await app.close();
    app = await openApp(model, data);
    assert.equal((await app.projects.create(owner(app), request)).id, created.id);
    assert.equal((await app.commands.createSession(owner(app), sessionRequest)).id, session.id);
    assert.equal(app.projects.list(owner(app)).goals.length, goalsBefore);
    assert.equal(app.sessions().length, sessionsBefore);
    assert.equal(
        app.projects.list(owner(app)).projects.find((item) => item.id === created.id)?.name,
        "Durable edited name",
    );
    assert.equal(app.sessionMeta(session.id)?.archived, true);
    assert.equal(app.sessionMeta(session.id)?.threadType, "worker");
    assert.equal(app.sessionMeta(session.id)?.cwd, request.cwd);
    assert.equal(findGoal(goalId).archived, true);
    assert.equal(findGoal(goalId).status, "completed");
    assert.equal(findGoal(goalId).namingThreadId, Number(session.id));
    assert.equal(findGoal(goalId).named, false);
    assert.equal(app.projects.list(scoped).projects[0]?.cwd, undefined);
    const old = (await app.harness.snapshot(SessionsDoc, context))?.items[String(legacy)];

    assert.deepEqual(old, { cwd: work, createdAt: 100, updatedAt: 100, threadType: "worker" });
    assert.equal(app.sessions().find((item) => item.id === Number(legacy))?.threadType, "worker");
    await assert.rejects(
        app.projects.create(owner(app), { ...request, name: "Different" }),
        status(409),
    );
    await assert.rejects(
        app.commands.createSession(owner(app), { ...sessionRequest, newGoal: false }),
        status(409),
    );
    assert.equal(app.projects.list(owner(app)).goals.length, goalsBefore);
    assert.equal(app.sessions().length, sessionsBefore);
    const otherActor: User = app.config.addUser("Retry actor", "guest").user;
    const other = await app.projects.create(otherActor, request);

    assert.notEqual(other.id, created.id);
    const actorRequest = { cwd: work, requestId: "removed-actor-retry" };
    const actorSession = await app.commands.createSession(otherActor, actorRequest);
    const beforeRemoval = app.sessions().length;

    app.removeUser(owner(app), otherActor.id);
    await assert.rejects(app.commands.createSession(otherActor, actorRequest), status(401));
    assert.equal(app.sessions().length, beforeRemoval);
    assert.ok(app.sessionMeta(actorSession.id));
    await app.projects.updateGoal(owner(app), goalId, { archived: false });
    assert.equal(app.sessionMeta(session.id)?.archived, false);
});
