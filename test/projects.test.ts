// Real Pocket app, HTTP and SQLite own membership, privacy, atomicity and retry behavior.
import {
    type App,
    cleanUp,
    context,
    executeHandoff,
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
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { join } from "node:path";
import { after, before, mock, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { User } from "../src/server/config.ts";
import { ProjectsDoc, SessionsDoc } from "../src/server/docs.ts";
import { HttpError } from "../src/server/errors.ts";
import { createHandler } from "../src/server/http.ts";
import { HandoffsDoc } from "../src/server/workflow-docs.ts";
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

async function worker(projectId: string): Promise<{ id: ConversationId }> {
    return app.commands.createSession(owner(app), { projectId });
}

async function importedOwnerOnly(name: string): Promise<ConversationId> {
    const fixture = importFixture(folder(name));
    const preview = await app.piSessions.preview(owner(app), { path: fixture.path });
    const imported = await app.piSessions.create(owner(app), {
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
test("projects have opaque identity, direct thread membership and independent type and working directory", async () => {
    const source = folder("identity-source");
    const destination = folder("identity-destination");
    const projectId = await project("First", source);
    const otherProjectId = await project("Second at the same path", source);
    const first = await worker(projectId);
    const second = await worker(projectId);
    const chat = await app.commands.createSession(owner(app), {
        projectId,
        threadType: "chat",
        cwd: work,
    });
    const unassigned = await app.commands.createSession(owner(app), {});

    assert.notEqual(projectId, otherProjectId);
    assert.equal(app.sessionMeta(first.id)?.projectId, projectId);
    assert.equal(app.sessionMeta(first.id)?.threadType, "worker");
    assert.equal(app.sessionMeta(second.id)?.projectId, projectId);
    assert.equal(app.sessionMeta(second.id)?.threadType, "worker");
    assert.equal(app.sessionMeta(chat.id)?.threadType, "chat");
    assert.equal(app.sessionMeta(unassigned.id)?.threadType, "chat");
    assert.equal(app.sessionMeta(unassigned.id)?.projectId, undefined);
    assert.equal(app.cwdOf(first.id), source);
    assert.equal(app.cwdOf(second.id), source);
    assert.equal(app.cwdOf(chat.id), work);

    await app.projects.update(owner(app), projectId, { name: "Renamed", cwd: destination });
    const later = await worker(projectId);

    assert.equal(app.cwdOf(later.id), destination);
    assert.equal(app.cwdOf(first.id), source);
    assert.equal(app.cwdOf(chat.id), work);
    assert.equal(
        app.projects.list(owner(app)).projects.find((item) => item.id === projectId)?.name,
        "Renamed",
    );

    for (const threadType of ["pull", "researcher"] as const) {
        const starter = await app.commands.createSession(owner(app), { projectId, threadType });

        assert.equal(app.sessionMeta(starter.id)?.projectId, projectId);
        assert.equal(app.sessionMeta(starter.id)?.threadType, threadType);
        assert.equal(app.cwdOf(starter.id), destination);
    }

    assert.equal(
        app.agentProfile("researcher")?.icon,
        "brain",
        "Researcher advertises its brain icon to every UI surface",
    );
});

// Remote preparation may wait on an unreachable SSH host. It must not own Durable's global
// mutation line while waiting; the same check protects both project creation and default edits.
test("SSH project directory preparation does not block unrelated commits and cannot overwrite changed defaults", async () => {
    const person = owner(app);
    const projectId = await project("Preparation source");

    for (const operation of ["create", "update"] as const) {
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const delayed = mock.method(app.sshSessions, "prepare", async () => {
            entered.resolve();
            await release.promise;

            return "/prepared/remote";
        });
        const request = {
            cwd: "/prepared/remote",
            location: { kind: "ssh", host: "fixture-host" },
        };
        const pending =
            operation === "create"
                ? app.projects.create(person, {
                      ...request,
                      name: "Prepared",
                      requestId: "prepared-remote",
                  })
                : app.projects.update(person, projectId, request);
        const outcome = pending.then(
            () => undefined,
            (error: unknown) => error,
        );

        try {
            await entered.promise;
            const unrelated = app.projects.update(person, projectId, {
                name: "Unrelated commit completed",
                ...(operation === "update" ? { cwd: folder("concurrent-project-default") } : {}),
            });
            const settled = await Promise.race([
                unrelated.then(() => true),
                new Promise<false>((resolve) => setTimeout(() => resolve(false), 250)),
            ]);

            release.resolve();
            await unrelated;
            const result = await outcome;

            assert.equal(settled, true, "SSH preparation held the global mutation line");

            if (operation === "update") {
                assert.ok(result instanceof HttpError && result.status === 409);
                assert.equal(
                    app.projects.list(person).projects.find((item) => item.id === projectId)?.cwd,
                    folder("concurrent-project-default"),
                );
            } else {
                assert.equal(result, undefined);
            }
        } finally {
            release.resolve();
            await outcome;
            delayed.mock.restore();
        }
    }
});

// Direct projection and commit delivery own scoped privacy, including an owner-only import in the same project.
test("scoped catalogues contain only visible projects without cwd and follow committed membership", async () => {
    const projectId = await project("Visible project", folder("projection-visible"));
    const otherProjectId = await project("UNRELATED_PROJECT_NAME", folder("projection-unrelated"));
    const visible = await worker(projectId);
    const hidden = await importedOwnerOnly("projection-private");

    await app.projects.assign(owner(app), hidden, { projectId });
    const viewer = app.config.addUser("Project viewer", "viewer", [
        String(visible.id),
        String(hidden),
    ]);
    const scoped = app.config.addUser("Scoped steer", "guest", [String(visible.id)]).user;
    const full = app.config.addUser("Full steer", "guest").user;
    const elsewhere = app.config.addUser("No membership", "viewer", []).user;
    const tab = fakeTab(undefined, viewer.user);
    const listed = app.projects.list(viewer.user);

    assert.deepEqual(Object.keys(listed), ["projects"]);
    assert.deepEqual(
        listed.projects.map((item) => item.id),
        [projectId],
    );
    assert.equal(Object.hasOwn(listed.projects[0]!, "cwd"), false);
    assert.equal(JSON.stringify(listed).includes("UNRELATED_PROJECT_NAME"), false);
    assert.deepEqual(app.projects.list(elsewhere), { projects: [] });
    assert.deepEqual(
        app.sessions(viewer.user).map((item) => item.id),
        [Number(visible.id)],
    );
    await app.attach(tab.client);

    try {
        assert.deepEqual(tab.last("projects"), listed);

        for (const user of [viewer.user, scoped]) {
            await assert.rejects(project("Denied", work, user), status(403));
            await assert.rejects(
                app.projects.update(user, projectId, { name: "Denied" }),
                status(403),
            );
            await assert.rejects(
                app.projects.assign(user, visible.id, { projectId: otherProjectId }),
                status(403),
            );
            await assert.rejects(app.commands.createSession(user, { projectId }), status(403));
        }

        await assert.rejects(
            app.projects.assign(full, hidden, { projectId: otherProjectId }),
            status(403),
        );
        assert.equal(app.sessionMeta(hidden)?.projectId, projectId);
        await app.projects.update(owner(app), projectId, { name: "Shared rename" });
        await until(
            () => JSON.stringify(tab.last("projects")).includes("Shared rename"),
            "live committed project rename",
        );
        await app.commands.updateSession(visible.id, owner(app), { projectId: otherProjectId });
        await until(() => {
            const projection = tab.last("projects") as { projects?: { id: string }[] } | undefined;

            return projection?.projects?.[0]?.id === otherProjectId;
        }, "projection follows membership rather than granting project access");
        const moved = app.projects.list(viewer.user);

        assert.deepEqual(
            moved.projects.map((item) => item.id),
            [otherProjectId],
        );
        assert.equal(Object.hasOwn(moved.projects[0]!, "cwd"), false);
        assert.equal(app.sessionMeta(hidden)?.projectId, projectId);
        assert.deepEqual(
            app.sessions(viewer.user).map((item) => item.id),
            [Number(visible.id)],
        );
        await app.commands.updateSession(visible.id, owner(app), { projectId: null });
        await until(
            () => JSON.stringify(tab.last("projects")) === JSON.stringify({ projects: [] }),
            "empty committed scoped project projection",
        );
    } finally {
        app.detach(tab.client);
    }
});

// HTTP owns authentication, CSRF, route retirement and JSON request/response adaptation.
test("HTTP project routes require auth and CSRF and expose project-only creation, editing and moves", async () => {
    const full = app.config.addUser("HTTP steer", "guest");
    const handler = createHandler({
        app,
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
    });

    const request = async (
        path: string,
        body?: unknown,
        token: string | null = app.config.ownerToken,
        csrf = true,
    ) => {
        const incoming = new IncomingMessage(new Socket());
        const response = new ServerResponse(incoming);
        let output = "";

        incoming.method = body === undefined ? "GET" : "POST";
        incoming.url = `/api${path}`;
        incoming.headers = {
            "content-type": "application/json",
            ...(token === null ? {} : { authorization: `Bearer ${token}` }),
            ...(csrf ? { "x-pocket": "1" } : {}),
        };

        response.end = (chunk?: unknown) => {
            output = String(chunk ?? "");

            return response;
        };

        const handled = handler(incoming, response);

        if (body !== undefined) {
            incoming.push(Buffer.from(JSON.stringify(body)));
        }

        incoming.push(null);
        await handled;

        return new Response(output, { status: response.statusCode });
    };

    const post = async (path: string, body: unknown, expected = 200) => {
        const response = await request(path, body);

        assert.equal(response.status, expected, await response.clone().text());

        return response.json();
    };

    assert.equal((await request("/projects", undefined, null)).status, 401);
    assert.equal(
        (
            await request(
                "/projects",
                { name: "No CSRF", cwd: work, requestId: "csrf" },
                app.config.ownerToken,
                false,
            )
        ).status,
        403,
    );
    assert.equal(
        (
            await request(
                "/projects",
                { name: "No guest setup", cwd: work, requestId: "guest-setup" },
                full.token,
            )
        ).status,
        403,
    );
    const created = await post("/projects", {
        name: "Owner-created",
        cwd: work,
        requestId: "http-project",
    });
    const started = await post("/sessions", {
        projectId: created.id,
        requestId: "http-worker",
    });

    assert.equal(typeof created.id, "string");
    assert.equal(app.sessionMeta(started.id)?.projectId, created.id);
    await post(`/projects/${created.id}`, { name: "HTTP rename" });
    const listed = await (await request("/projects")).json();

    assert.deepEqual(Object.keys(listed), ["projects"]);
    assert.equal(
        listed.projects.find((item: { id: string }) => item.id === created.id)?.name,
        "HTTP rename",
    );
    await post(`/sessions/${started.id}`, { projectId: null });
    assert.equal(app.sessionMeta(started.id)?.projectId, undefined);
    await post("/project-goals/no-longer-a-route", { name: "No goal" }, 404);
});

// Independent archive changes only the requested thread, not other threads in the same project.
test("archive and restore remain independent of project moves and Done when checks", async () => {
    const projectId = await project("Archive project");
    const otherProjectId = await project("Archive move destination");
    const first = await worker(projectId);
    const second = await worker(projectId);
    const before = app.sessionMeta(first.id)?.updatedAt;

    await app.goals.set(first.id, owner(app).id, "true");
    await app.commands.updateSession(first.id, owner(app), { archived: true });
    assert.equal(app.sessionMeta(first.id)?.archived, true);
    assert.notEqual(app.sessionMeta(second.id)?.archived, true);
    assert.equal(app.sessionMeta(first.id)?.updatedAt, before);
    assert.equal((await app.goals.get(first.id))?.status, "working");
    await app.projects.assign(owner(app), first.id, { projectId: otherProjectId });
    assert.equal(app.sessionMeta(first.id)?.archived, true);
    assert.equal(app.sessionMeta(first.id)?.projectId, otherProjectId);
    await app.commands.updateSession(first.id, owner(app), { archived: false });
    assert.equal(app.sessionMeta(first.id)?.archived, false);
    assert.equal(app.sessionMeta(second.id)?.projectId, projectId);
    assert.notEqual(app.sessionMeta(second.id)?.archived, true);
    assert.equal((await app.goals.get(first.id))?.command, "true");
});

// Forks/resends retain placement and privacy, but no project membership makes them bulk-archive targets.
test("forks and resends preserve project, type, working directory and owner-only restrictions", async () => {
    const projectId = await project("Fork project", folder("fork-project"));
    const source = await importedOwnerOnly("fork-private");

    await app.projects.assign(owner(app), source, { projectId });
    await say(app, source, "Fork source");
    const entries = await app.transcripts.allEntries(source, false);
    const reply = entries.findLast((entry) => entry.kind === "assistant");
    const user = entries.findLast((entry) => entry.kind === "user");

    assert.ok(reply);
    assert.ok(user);
    await app.commands.updateSession(source, owner(app), { archived: true });
    const fork = await app.commands.fork(source, owner(app), { entryId: reply.id });
    const resend = await app.commands.resend(source, owner(app), { entryId: user.id });

    for (const id of [fork.id, resend.id]) {
        assert.equal(app.sessionMeta(id)?.projectId, projectId);
        assert.equal(app.sessionMeta(id)?.threadType, app.sessionMeta(source)?.threadType);
        assert.equal(app.cwdOf(id), app.cwdOf(source));
        assert.equal(app.sessionMeta(id)?.ownerOnly, true);
        assert.notEqual(app.sessionMeta(id)?.archived, true);
    }

    assert.equal(app.sessionMeta(source)?.archived, true);
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

test("moves preserve legacy Workers, explicit Chats, directory, archive state and driver rights", async () => {
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

    await app.projects.assign(owner(app), chat, { projectId });
    assert.equal(app.sessionMeta(chat)?.threadType, "chat");
    assert.equal(app.cwdOf(chat), work);
    await app.projects.assign(owner(app), legacy, { projectId });
    assert.equal(app.sessionMeta(legacy)?.threadType, "worker");
    assert.equal(app.sessionMeta(legacy)?.cwd, work);
    await app.projects.assign(owner(app), legacy, { projectId: otherProjectId });
    assert.equal(app.sessionMeta(legacy)?.projectId, otherProjectId);
    assert.equal(app.sessionMeta(legacy)?.threadType, "worker");
    assert.equal(app.sessionMeta(legacy)?.cwd, work);
    await app.projects.assign(owner(app), first.id, { projectId: null });
    assert.equal(app.sessionMeta(first.id)?.projectId, undefined);
    assert.equal(app.sessionMeta(first.id)?.threadType, "worker");
    assert.equal(app.cwdOf(first.id), join(work, "move-origin"));
    await app.collab.turns(legacy, owner(app), { action: "on" });
    await assert.rejects(app.projects.assign(full, legacy, { projectId }), status(403));
    assert.equal(app.sessionMeta(legacy)?.projectId, otherProjectId);
    await app.collab.turns(legacy, owner(app), { action: "handover", to: full.id });
    await assert.rejects(app.projects.assign(full, legacy, { projectId }), status(403));
    await assert.rejects(app.projects.assign(owner(app), legacy, { projectId }), status(409));
    await app.collab.turns(legacy, full, { action: "handover", to: owner(app).id });
    await app.projects.assign(owner(app), legacy, { projectId });
    assert.equal(app.sessionMeta(legacy)?.projectId, projectId);
    assert.equal(app.sessionMeta(legacy)?.threadType, "worker");
    await app.collab.turns(legacy, owner(app), { action: "off" });
});

// A Work Item move rechecks every member before publishing any placement, including combined archive edits.
test("whole Work Item placement is owner-only and rejects non-driver members atomically", async () => {
    const projectId = await project("Work Item source");
    const otherProjectId = await project("Work Item destination");
    const first = await worker(projectId);

    await app.commands.configure(first.id, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
    });
    const handoff = await executeHandoff(app, first.id, "researcher");
    const next = handoff.id as ConversationId;
    const full = app.config.addUser("Work Item mover", "guest").user;

    await until(() => !app.isBusy(next), "successor settles");
    assert.equal(app.sessionMeta(next)?.projectId, projectId);
    await app.collab.turns(first.id, owner(app), { action: "on" });
    const beforeSessions = await app.harness.snapshot(SessionsDoc, context);
    const beforeGroups = await app.harness.snapshot(HandoffsDoc, context);

    await assert.rejects(
        app.handoffs.updateWorkItem(next, full, { projectId: otherProjectId, archived: true }),
        status(403),
    );
    assert.deepEqual(await app.harness.snapshot(SessionsDoc, context), beforeSessions);
    assert.deepEqual(await app.harness.snapshot(HandoffsDoc, context), beforeGroups);
    await app.collab.turns(first.id, owner(app), { action: "handover", to: full.id });
    await assert.rejects(
        app.handoffs.updateWorkItem(next, owner(app), {
            projectId: otherProjectId,
            archived: true,
        }),
        status(409),
    );
    assert.deepEqual(await app.harness.snapshot(SessionsDoc, context), beforeSessions);
    await app.collab.turns(first.id, owner(app), { action: "off" });
    await app.harness.commit(async (tx) => {
        (await tx.doc(SessionsDoc)).items[String(next)]!.ownerOnly = true;
    }, context);
    const hiddenSessions = await app.harness.snapshot(SessionsDoc, context);

    await assert.rejects(
        app.projects.assign(full, first.id, { projectId: otherProjectId }),
        status(403),
    );
    assert.deepEqual(await app.harness.snapshot(SessionsDoc, context), hiddenSessions);
    assert.deepEqual(await app.harness.snapshot(HandoffsDoc, context), beforeGroups);
    await app.handoffs.updateWorkItem(next, owner(app), {
        projectId: otherProjectId,
        archived: true,
    });

    for (const id of [first.id, next]) {
        assert.equal(app.sessionMeta(id)?.projectId, otherProjectId);
        assert.equal(app.sessionMeta(id)?.archived, true);
        assert.equal(app.cwdOf(id), work);
    }

    assert.equal((await app.handoffs.list(next, owner(app))).workItem?.projectId, otherProjectId);
    await app.handoffs.updateWorkItem(next, owner(app), { projectId: null, archived: false });
    assert.equal(app.sessionMeta(first.id)?.projectId, undefined);
    assert.equal(app.sessionMeta(next)?.projectId, undefined);
    assert.equal(app.sessionMeta(first.id)?.archived, false);
    assert.equal(app.sessionMeta(next)?.archived, false);
});

// Preflight cannot publish state; conversation init must still reject folder and authorization races.
test("preflight is side-effect free and transactional revalidation rolls back raced folders and access", async () => {
    const projectId = await project("Preflight", folder("preflight-source"));
    const beforeProjects = await app.harness.snapshot(ProjectsDoc, context);
    const prepared = app.projects.prepare(owner(app), { projectId });

    assert.deepEqual(prepared, {
        projectId,
        threadType: "worker",
        cwd: join(work, "preflight-source"),
    });
    assert.deepEqual(await app.harness.snapshot(ProjectsDoc, context), beforeProjects);

    for (const [request, expected] of [
        [{ projectId, threadType: "reviewer" }, 400],
        [{ threadType: "publish" }, 400],
        [{ projectId: 2 }, 400],
        [{ threadType: null }, 400],
        [{ projectId: "__proto__" }, 404],
        [{ projectId: "constructor" }, 404],
    ] as const) {
        assert.throws(() => app.projects.prepare(owner(app), request), status(expected));
    }

    for (const patch of [{ name: 4 }, { cwd: false }, { name: "" }, { name: "NUL\0name" }]) {
        await assert.rejects(app.projects.update(owner(app), projectId, patch), status(400));
    }

    // This non-repository would fail worktree preparation first if Commands validated selection too late.
    await assert.rejects(
        app.commands.createSession(owner(app), { projectId: "missing-project", worktree: true }),
        status(404),
    );
    const start = (selection: ReturnType<App["projects"]["prepare"]>) =>
        app.harness.createConversation(
            {
                ownership: { kind: "ownerless" },
                agent: { cwd: work },
                init: async (tx, id) => {
                    const placement = await app.projects.place(tx, selection);
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
    assert.equal(await conversationCount(), conversationsBefore);
    const editor = app.config.addUser("Preflight revoked", "guest").user;
    const revoked = app.projects.prepare(editor, { projectId });

    app.config.updateUser(editor.id, { role: "viewer" });
    await assert.rejects(start(revoked), status(403));
    assert.equal(await conversationCount(), conversationsBefore);
    await assert.rejects(start({ projectId, threadType: "worker" }), status(400));
    assert.equal(await conversationCount(), conversationsBefore);
});

// Restart owns receipts, project-only projection of old extras and the existing Worker backfill.
test("project and thread retries survive restart while obsolete grouping data leaves placement and archive unchanged", async () => {
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
    const sessionRequest = { projectId: created.id, requestId: "worker-retry" };
    const [session, duplicate] = await Promise.all([
        app.commands.createSession(owner(app), sessionRequest),
        app.commands.createSession(owner(app), sessionRequest),
    ]);

    assert.equal(session.id, duplicate.id);
    const legacy = await legacySession();
    const scoped = app.config.addUser("Retry scope", "viewer", [String(session.id)]).user;

    await app.projects.update(owner(app), created.id, {
        name: "Durable edited name",
        cwd: folder("retry-updated"),
    });
    await app.commands.updateSession(session.id, owner(app), { archived: true });
    await app.harness.commit(async (tx) => {
        // Stored extra fields are irrelevant to the current contract; do not migrate or unarchive the thread.
        Object.assign((await tx.doc(SessionsDoc)).items[String(session.id)]!, {
            goalId: "removed-group",
            archivedByGoal: "removed-group",
        });
        Object.assign(await tx.doc(ProjectsDoc), {
            goals: {
                "removed-group": {
                    id: "removed-group",
                    projectId: created.id,
                    name: "OBSOLETE_GOAL_NAME",
                },
            },
        });
    }, context);
    const projectsBefore = app.projects.list(owner(app)).projects.length;
    const sessionsBefore = app.sessions().length;

    await app.close();
    app = await openApp(model, data);
    assert.equal((await app.projects.create(owner(app), request)).id, created.id);
    assert.equal((await app.commands.createSession(owner(app), sessionRequest)).id, session.id);
    assert.equal(app.projects.list(owner(app)).projects.length, projectsBefore);
    assert.equal(app.sessions().length, sessionsBefore);
    assert.equal(
        app.projects.list(owner(app)).projects.find((item) => item.id === created.id)?.name,
        "Durable edited name",
    );
    assert.deepEqual(Object.keys(app.projects.list(owner(app))), ["projects"]);
    assert.equal(
        JSON.stringify(app.projects.list(owner(app))).includes("OBSOLETE_GOAL_NAME"),
        false,
    );
    const projected = app.sessions().find((item) => item.id === Number(session.id))!;

    assert.equal(Object.hasOwn(projected, "goalId"), false);
    assert.equal(Object.hasOwn(projected, "archivedByGoal"), false);
    assert.equal(projected.projectId, created.id);
    assert.equal(projected.archived, true);
    assert.equal(projected.threadType, "worker");
    assert.equal(projected.cwd, request.cwd);
    assert.equal(app.projects.list(scoped).projects[0]?.cwd, undefined);
    const old = (await app.harness.snapshot(SessionsDoc, context))?.items[String(legacy)];

    assert.deepEqual(old, { cwd: work, createdAt: 100, updatedAt: 100, threadType: "worker" });
    await assert.rejects(
        app.projects.create(owner(app), { ...request, name: "Different" }),
        status(409),
    );
    await assert.rejects(
        app.commands.createSession(owner(app), { ...sessionRequest, threadType: "chat" }),
        status(409),
    );
    assert.equal(app.projects.list(owner(app)).projects.length, projectsBefore);
    assert.equal(app.sessions().length, sessionsBefore);
    const otherActor: User = app.config.addUser("Retry actor", "guest", undefined, undefined, {
        projectIds: [created.id],
    }).user;

    await assert.rejects(app.projects.create(otherActor, request), status(403));
    const actorRequest = { projectId: created.id, requestId: sessionRequest.requestId };
    const actorSession = await app.commands.createSession(otherActor, actorRequest);

    assert.notEqual(
        actorSession.id,
        session.id,
        "creation retry identity belongs to the current person",
    );
    const beforeRemoval = app.sessions().length;

    app.removeUser(owner(app), otherActor.id);
    await assert.rejects(app.commands.createSession(otherActor, actorRequest), status(401));
    assert.equal(app.sessions().length, beforeRemoval);
    assert.ok(app.sessionMeta(actorSession.id));
    await app.commands.updateSession(session.id, owner(app), { archived: false });
    assert.equal(app.sessionMeta(session.id)?.archived, false);
});
