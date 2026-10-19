// Owner-boundary contracts: catalogue visibility, creation, untrusted HTTP grants and live revocation.
// Real app/config/SQLite and in-memory HTTP; disposable SSH peers only, never a listener or native sandbox.
// Transport/credential delegation is owned separately by ssh-project-permissions.test.ts.
import {
    type App,
    cleanUp,
    context,
    fakeTab,
    openApp,
    owner,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Auth } from "../src/server/auth.ts";
import { ConfigStore } from "../src/server/config.ts";
import { SessionsDoc } from "../src/server/docs.ts";
import { HttpError } from "../src/server/errors.ts";
import { createHandler } from "../src/server/http.ts";
import { sshFixture } from "./ssh-fixture.ts";

const host = "ssh://fixture@project-host:20977";
let app: App;
let ssh: Awaited<ReturnType<typeof sshFixture>>;
let handler: ReturnType<typeof createHandler>;
const status = (expected: number) => (error: unknown) =>
    error instanceof HttpError && error.status === expected;

before(async () => {
    ssh = await sshFixture(host);
    app = await openApp(scriptedModel(), join(ssh.root, "app"));
    handler = createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} });
});
after(async () => {
    await app?.close();
    await ssh?.close();
    cleanUp();
});

function folder(name: string): string {
    const cwd = join(work, name);

    mkdirSync(cwd, { recursive: true });

    return cwd;
}

async function project(name: string, cwd: string, target?: string): Promise<string> {
    return (
        await app.projects.create(owner(app), {
            name,
            cwd,
            requestId: crypto.randomUUID(),
            ...(target === undefined ? {} : { location: { kind: "ssh", host: target } }),
        })
    ).id;
}

async function request(method: string, path: string, token: string, body?: unknown) {
    const incoming = new IncomingMessage(new Socket());
    const response = new ServerResponse(incoming);
    let output = "";

    incoming.method = method;
    incoming.url = `/api/${path}`;
    incoming.headers = {
        authorization: `Bearer ${token}`,
        "x-pocket": "1",
        "content-type": "application/json",
    };

    response.end = (chunk?: unknown) => {
        output = String(chunk ?? "");

        return response;
    };

    const handled = handler(incoming, response);

    incoming.push(body === undefined ? null : Buffer.from(JSON.stringify(body)));

    if (body !== undefined) {
        incoming.push(null);
    }

    await handled;

    return new Response(output, { status: response.statusCode });
}

test("project selectors grant identities and dynamic local/machine groups, not unassigned or other-destination threads", async () => {
    const cwd = folder("selector-projects");
    const first = await project("Explicit local", cwd);
    const sameFolder = await project("Same path, different identity", cwd);
    const remote = await project("Selected machine", ssh.root, host);
    const other = await project("Other machine", ssh.root, "other-fixture-host");
    const guest = app.config.addUser("Project collaborator", "guest", undefined, undefined, {
        projectIds: [first],
    }).user;
    const visible = await app.commands.createSession(guest, { projectId: first });
    const unassigned = await app.commands.createSession(owner(app), { cwd });
    const onRemote = await app.commands.createSession(owner(app), { projectId: remote });
    const overridden = await app.commands.createSession(owner(app), {
        projectId: remote,
        location: { kind: "ssh", host: "other-fixture-host" },
    });
    const listed = () =>
        app.projects
            .list(guest)
            .projects.map((item) => item.id)
            .sort();

    assert.deepEqual(listed(), [first]);
    assert.equal(app.canSee(guest, visible.id), true);
    assert.equal(app.canSee(guest, unassigned.id), false);
    await assert.rejects(app.commands.createSession(guest, { projectId: sameFolder }), status(403));

    app.setAccess(owner(app), guest.id, { projectAccess: { local: true } });
    assert.ok(listed().includes(first) && listed().includes(sameFolder));
    assert.equal(listed().includes(remote), false);
    const futureLocal = await project("Future local", cwd);

    assert.ok(listed().includes(futureLocal), "local grants include future local projects");
    app.setAccess(owner(app), guest.id, { projectAccess: { hosts: [host] } });
    assert.deepEqual(listed(), [remote]);
    assert.equal(app.canSee(guest, onRemote.id), true);
    assert.equal(
        app.canSee(guest, overridden.id),
        false,
        "a machine selector cannot share an old override on another machine",
    );
    const futureRemote = await project("Future on selected machine", ssh.root, host);

    assert.ok(listed().includes(futureRemote));
    assert.equal(listed().includes(other), false);
    app.setAccess(owner(app), guest.id, { projectAccess: { all: true } });
    assert.ok(
        [first, sameFolder, remote, other, futureLocal, futureRemote].every((id) =>
            listed().includes(id),
        ),
    );
    assert.equal(app.canSee(guest, overridden.id), true);
    assert.equal(
        app.canSee(guest, unassigned.id),
        false,
        "all projects is not all unassigned conversations",
    );

    await app.harness.commit(async (tx) => {
        (await tx.doc(SessionsDoc)).items[String(onRemote.id)]!.ownerOnly = true;
    }, context);
    assert.equal(
        app.canSee(guest, onRemote.id),
        false,
        "project grants never override owner-only history",
    );

    const scoped = app.config.addUser(
        "Single thread",
        "viewer",
        [String(visible.id)],
        undefined,
        {},
    ).user;

    assert.equal(
        app.canSee(scoped, visible.id),
        true,
        "explicit single-thread invitations remain independently scoped",
    );
    assert.deepEqual(
        app.projects.list(scoped).projects.map((item) => item.id),
        [first],
    );
    assert.equal(Object.hasOwn(app.projects.list(scoped).projects[0]!, "cwd"), false);
    await assert.rejects(app.commands.createSession(scoped, { projectId: first }), status(403));
});

test("changing a project away from a granted machine revokes existing views and peeks without retargeting threads", async () => {
    const cwd = folder("changed-project-machine");
    const projectId = await project("Changing namespace", cwd);
    const guest = app.config.addUser("Local group", "guest", undefined, undefined, {
        local: true,
    }).user;
    const { id } = await app.commands.createSession(guest, { projectId });
    const tab = fakeTab(id, guest);

    await app.attach(tab.client);
    app.setPeeks(guest, tab.client.connection, [id]);
    assert.equal(tab.client.peeks?.has(id), true);

    try {
        await app.projects.update(owner(app), projectId, {
            cwd: ssh.root,
            location: { kind: "ssh", host },
        });
        assert.equal(app.cwdOf(id), cwd);
        assert.equal(app.locationOf(id), undefined);
        assert.equal(app.canSee(guest, id), false);
        assert.equal(tab.client.conversationId, undefined);
        assert.equal(tab.client.peeks?.has(id), false);
        assert.ok(tab.last("missing"));
    } finally {
        app.detach(tab.client);
    }
});

test("HTTP project grants validate untrusted selectors, persist through invitation redemption and remain owner-only", async () => {
    const projectId = await project("HTTP granted", folder("http-granted"));
    const token = app.config.ownerToken;
    const auth = new Auth(app.config);

    for (const projectAccess of [
        null,
        [],
        "all",
        { all: false },
        { local: 1 },
        { hosts: ["-oProxyCommand=bad"] },
        { projectIds: [3] },
        { unknown: true },
    ]) {
        const result = await request("POST", "invite", token, { role: "guest", projectAccess });

        assert.equal(result.status, 400, JSON.stringify(projectAccess));
    }

    const issued = await request("POST", "invite", token, {
        role: "guest",
        projectAccess: { projectIds: [projectId, projectId] },
    });

    assert.equal(issued.status, 200);
    const invite = await issued.json();
    const joined = auth.redeem(invite.code, "Invited project collaborator")!;

    assert.deepEqual(invite.grant.projectAccess, { projectIds: [projectId] });
    assert.deepEqual(
        new ConfigStore(dirname(app.config.file)).userById(joined.user.id)!.projectAccess,
        { projectIds: [projectId] },
    );
    assert.deepEqual((await app.hello(joined.user)).user.projectAccess, {
        projectIds: [projectId],
    });
    assert.deepEqual(
        app.people(owner(app)).find((person) => person.id === joined.user.id)!.projectAccess,
        { projectIds: [projectId] },
    );
    assert.equal(
        (
            await request("POST", "invite", joined.token, {
                role: "guest",
                projectAccess: { all: true },
            })
        ).status,
        403,
    );
    assert.equal(
        (
            await request("POST", `users/${joined.user.id}`, joined.token, {
                projectAccess: { all: true },
            })
        ).status,
        403,
    );
    assert.equal(
        (
            await request("POST", `users/${joined.user.id}`, token, {
                projectAccess: { local: true },
            })
        ).status,
        200,
    );
    assert.deepEqual(joined.user.projectAccess, { local: true });
    assert.equal(
        (await request("POST", `users/${joined.user.id}`, token, { continuePiSessions: true }))
            .status,
        400,
    );
    assert.equal((await request("GET", "pi-sessions", joined.token)).status, 403);

    const ordinary = await request("POST", "invite", token, { role: "guest" });
    const noAccess = auth.redeem((await ordinary.json()).code, "No implicit grants")!.user;

    assert.deepEqual(noAccess.projectAccess, {});
    assert.deepEqual(app.projects.list(noAccess), { projects: [] });
    assert.deepEqual(app.sessions(noAccess), []);
});

test("project-scoped People lists do not reveal a participant's other session memberships", async () => {
    const cwd = folder("people-membership");
    const projectId = await project("Shared participant", cwd);
    const collaborator = app.config.addUser("Project participant", "guest", undefined, undefined, {
        projectIds: [projectId],
    });
    const visible = await app.commands.createSession(collaborator.user, { projectId });
    const hidden = await app.commands.createSession(owner(app), { cwd });
    const participant = app.config.addUser("Overlapping participant", "viewer", [
        String(visible.id),
        String(hidden.id),
    ]).user;
    const result = await request("GET", "users", collaborator.token);

    assert.equal(result.status, 200);
    const people = await result.json();
    const shared = people.find((person: { id: string }) => person.id === participant.id);

    assert.ok(shared, "a participant sharing the granted thread remains visible");
    assert.equal(Object.hasOwn(shared, "sessions"), false, "other session IDs remain private");
    assert.deepEqual(
        app.people(owner(app)).find((person) => person.id === participant.id)!.sessions,
        [visible.id, hidden.id],
        "the owner retains the full access-management projection",
    );
});

test("collaborators create only at a granted project's fixed local or SSH destination, including explicit defaults", async () => {
    const cwd = folder("fixed-creation");
    const projectId = await project("Fixed local", cwd);
    const remoteId = await project("Fixed remote", ssh.root, host);

    const remoteCwd = app.projects
        .list(owner(app))
        .projects.find((item) => item.id === remoteId)!.cwd!;
    const joined = app.config.addUser("Fixed creator", "guest", undefined, undefined, {
        projectIds: [projectId, remoteId],
    });
    const body = { projectId, cwd, location: null, requestId: "fixed-create" };
    const created = await request("POST", "sessions", joined.token, body);

    assert.equal(created.status, 200);
    const { id } = await created.json();

    assert.equal(app.cwdOf(id as ConversationId), cwd);
    assert.equal(app.sessionMeta(id as ConversationId)?.projectId, projectId);
    const remote = await request("POST", "sessions", joined.token, {
        projectId: remoteId,
        cwd: remoteCwd,
        location: { kind: "ssh", host },
    });

    assert.equal(remote.status, 200, await remote.clone().text());
    const remoteThread = (await remote.json()).id as ConversationId;

    assert.equal(app.cwdOf(remoteThread), remoteCwd);
    assert.deepEqual(app.locationOf(remoteThread), { kind: "ssh", host });
    const count = app.sessions(owner(app)).length;

    for (const override of [
        { projectId, cwd: folder("not-the-project") },
        { projectId, location: { kind: "ssh", host } },
        { projectId, worktree: true },
        { projectId: remoteId, location: null },
        { projectId: remoteId, cwd: "/a/different/remote/folder" },
        { projectId: remoteId, location: { kind: "ssh", host: "other-fixture-host" } },
        { threadType: "chat" },
    ]) {
        assert.equal(
            (await request("POST", "sessions", joined.token, override)).status,
            403,
            JSON.stringify(override),
        );
    }

    assert.equal(
        app.sessions(owner(app)).length,
        count,
        "rejected selections create no conversations",
    );
    await assert.rejects(app.projects.create(joined.user, { name: "No", cwd }), status(403));
    await assert.rejects(app.projects.update(joined.user, projectId, { cwd }), status(403));
    await assert.rejects(
        app.projects.assign(joined.user, id as ConversationId, { projectId: remoteId }),
        status(403),
    );
    assert.equal((await request("GET", "fs?path=/", joined.token)).status, 403);
    assert.equal(
        (await request("POST", "fs", joined.token, { path: join(cwd, "new") })).status,
        403,
    );
    await assert.rejects(
        app.commands.configure(id as ConversationId, joined.user, { cwd }),
        status(403),
    );
    await assert.rejects(
        app.commands.fork(id as ConversationId, joined.user, { worktree: true }),
        status(403),
    );

    app.setAccess(owner(app), joined.user.id, { projectAccess: {} });
    assert.equal(
        (await request("POST", "sessions", joined.token, body)).status,
        404,
        "a saved creation receipt cannot recover access after revocation",
    );
});

test("configuration rechecks project access after awaiting current agent settings", async (t) => {
    const projectId = await project("Awaited settings", folder("awaited-settings"));
    const guest = app.config.addUser("Settings reader", "guest", undefined, undefined, {
        projectIds: [projectId],
    }).user;
    const { id } = await app.commands.createSession(guest, { projectId });

    await app.commands.configure(id, guest, { model: { provider: "faux", modelId: "faux-1" } });
    const read = app.agentState.bind(app);

    t.mock.method(app, "agentState", async (...args: Parameters<typeof read>) => {
        const result = await read(...args);

        app.setAccess(owner(app), guest.id, { projectAccess: {} });

        return result;
    });
    await assert.rejects(
        app.commands.configure(id, guest, { model: { provider: "faux", modelId: "faux-2" } }),
        status(404),
    );
    assert.equal((await read(id))?.model?.modelId, "faux-1");
});

test("a granted project's viewer cannot configure agents through a stale steering snapshot", async () => {
    const projectId = await project("Viewer role", folder("viewer-role"));
    const guest = app.config.addUser("Downgraded collaborator", "guest", undefined, undefined, {
        projectIds: [projectId],
    }).user;
    const { id } = await app.commands.createSession(guest, { projectId });
    const snapshot = structuredClone(guest);

    app.setAccess(owner(app), guest.id, { role: "viewer" });
    assert.equal(app.canSee(snapshot, id), true, "viewing the granted project remains allowed");
    await assert.rejects(
        app.commands.configure(id, snapshot, { thinkingLevel: "off" }),
        status(403),
    );
});

test("same-token project revocation closes open views, filters future events and invalidates previously obtained environments", async () => {
    const cwd = folder("live-revocation");
    const projectId = await project("Revocable", cwd);
    const guest = app.config.addUser("Revocable guest", "guest", undefined, undefined, {
        projectIds: [projectId],
    }).user;
    const { id } = await app.commands.createSession(guest, { projectId });

    writeFileSync(join(cwd, "visible.txt"), "project bytes");
    const snapshot = structuredClone(guest);
    const cached = app.envFor(id, snapshot);

    assert.equal(getOrThrow(await cached.readTextFile("visible.txt", context)), "project bytes");
    const tab = fakeTab(id, guest);
    const ownerTab = fakeTab(id, owner(app));

    await app.attach(tab.client);
    await app.attach(ownerTab.client);

    try {
        app.setAccess(owner(app), guest.id, { projectAccess: {} });
        assert.equal(
            app.canSee(snapshot, id),
            false,
            "stale user objects cannot retain old grants",
        );
        assert.equal(tab.client.conversationId, undefined);
        assert.ok(tab.last("missing"));
        await assert.rejects(
            async () => getOrThrow(await cached.readTextFile("visible.txt", context)),
            /access|requester|permission|visible|session|project/i,
        );
        const views = tab.events.filter((event) => event.event === "view").length;

        await app.commands.note(id, owner(app), "private after project revocation");
        await until(
            () =>
                ownerTab.events.some((event) =>
                    JSON.stringify(event.data).includes("private after project revocation"),
                ),
            "owner receives later private content",
        );
        assert.equal(tab.events.filter((event) => event.event === "view").length, views);
        assert.deepEqual(app.sessions(guest), []);
        assert.deepEqual(app.projects.list(guest), { projects: [] });
        await assert.rejects(app.commands.createSession(guest, { projectId }), status(403));
    } finally {
        app.detach(tab.client);
        app.detach(ownerTab.client);
    }
});
