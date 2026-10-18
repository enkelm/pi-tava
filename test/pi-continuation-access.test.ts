// Local-history access is exercised against generated files and an isolated app, never personal Pi data.
import { cleanUp, context, openApp, owner, root, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { after, test } from "node:test";
import { ImportedSessionDoc } from "../src/server/docs.ts";
import { importFixture } from "./import-fixtures.ts";
import { fakeHerdr } from "./active-import-fixture.ts";
import { createHandler } from "../src/server/http.ts";

after(cleanUp);

test("a granted collaborator discovers and copies history only after explicit sharing, without exposing the owner's private copy or archive", async () => {
    const directory = join(root, "granted-sources");

    mkdirSync(directory);
    const source = importFixture(directory);
    const prior = process.env.PI_CODING_AGENT_SESSION_DIR;

    process.env.PI_CODING_AGENT_SESSION_DIR = directory;
    const app = await openApp(scriptedModel(), join(root, "granted-data"));
    const guest = app.config.addUser("Collaborator", "guest").user;
    const other = app.config.addUser("Reader", "viewer").user;
    let discovery = 0;

    app.piSessions.active.local.sockets = async () => {
        discovery++;

        return [];
    };

    try {
        await assert.rejects(app.piSessions.history(guest), { status: 403 });
        await assert.rejects(app.piSessions.active.list(guest), { status: 403 });
        assert.equal(discovery, 0);
        const preview = await app.piSessions.preview(owner(app), { path: source.path });
        const request = {
            path: preview.path,
            leafId: preview.leafId,
            sha256: preview.sha256,
            model: "faux/faux-vision",
            thinkingLevel: "off",
            acknowledged: true,
        };
        const privateCopy = await app.piSessions.create(owner(app), request);

        app.setAccess(owner(app), guest.id, { continuePiSessions: true });
        const history = await app.piSessions.history(guest);
        const discovered = history.sessions.find((session) => session.path === preview.path);

        assert.ok(discovered);
        assert.equal(discovered.pocket, undefined);
        assert.equal("sha256" in discovered, false);
        const guestPreview = await app.piSessions.preview(guest, { path: discovered.path });

        assert.equal(guestPreview.visibility, "shared");
        assert.equal(guestPreview.existing, undefined);
        await assert.rejects(app.piSessions.preview(guest, { path: "/etc/passwd" }), {
            status: 404,
        });
        await assert.rejects(app.piSessions.create(guest, request), /Confirm sharing/);
        await assert.rejects(
            app.piSessions.create(guest, { ...request, visibility: "shared", acknowledged: false }),
            { status: 400 },
        );
        assert.equal(app.sessions(owner(app)).length, 1);
        const sharedCopy = await app.piSessions.create(guest, { ...request, visibility: "shared" });

        assert.notEqual(sharedCopy.id, privateCopy.id);
        assert.equal(app.sessionMeta(privateCopy.id)?.ownerOnly, true);
        assert.equal(app.canSee(guest, privateCopy.id), false);
        assert.equal(app.canSee(other, sharedCopy.id), true);
        assert.equal(app.sessionMeta(sharedCopy.id)?.threadType, "chat");
        assert.equal(app.sessionMeta(sharedCopy.id)?.imported, true);
        assert.equal(
            (await app.harness.snapshot(ImportedSessionDoc, sharedCopy.id, context))?.source
                ?.importedBy,
            guest.id,
        );
        await assert.rejects(app.piSessions.archive(guest, sharedCopy.id), { status: 403 });
        assert.equal(await app.piSessions.archive(owner(app), sharedCopy.id), source.archive);
        assert.equal((await app.harness.inspect(context)).tasks.length, 0);
        app.setAccess(owner(app), guest.id, { continuePiSessions: false });
        const before = discovery;

        await assert.rejects(app.piSessions.create(guest, { ...request, visibility: "shared" }), {
            status: 403,
        });
        await assert.rejects(app.piSessions.history(guest), { status: 403 });
        assert.equal(discovery, before);
        assert.equal(
            app.canSee(guest, sharedCopy.id),
            true,
            "revocation removes local discovery, not ordinary shared-conversation access",
        );
    } finally {
        await app.close();

        if (prior === undefined) {
            delete process.env.PI_CODING_AGENT_SESSION_DIR;
        } else {
            process.env.PI_CODING_AGENT_SESSION_DIR = prior;
        }
    }
});

test("revocation during preflight prevents publication and successful receipts outlive changing or removed sources", async () => {
    const directory = join(root, "revocation-sources");

    mkdirSync(directory);
    const source = importFixture(directory);
    const app = await openApp(scriptedModel(), join(root, "revocation-data"));
    const guest = app.config.addUser("Collaborator", "guest").user;

    fakeHerdr(app, source.path);

    try {
        const activeId = (await app.piSessions.active.list(owner(app))).sessions[0]!.id;
        const preview = await app.piSessions.preview(owner(app), { activeId });
        const request = {
            activeId,
            leafId: preview.leafId,
            sha256: preview.sha256,
            model: "faux/faux-vision",
            thinkingLevel: "off",
            acknowledged: true,
        };

        app.setAccess(owner(app), guest.id, { continuePiSessions: true });
        const prepare = app.piSessions.prepare.bind(app.piSessions);

        app.piSessions.prepare = async (...args) => {
            const result = await prepare(...args);

            app.setAccess(owner(app), guest.id, { continuePiSessions: false });

            return result;
        };

        await assert.rejects(app.piSessions.create(guest, { ...request, visibility: "shared" }), {
            status: 403,
        });
        assert.equal(app.sessions().length, 0);
        app.piSessions.prepare = prepare;
        const created = await app.piSessions.create(owner(app), request);

        appendFileSync(source.path, "\n");
        assert.deepEqual(await app.piSessions.create(owner(app), request), {
            id: created.id,
            existing: true,
        });
        unlinkSync(source.path);
        assert.deepEqual(await app.piSessions.create(owner(app), request), {
            id: created.id,
            existing: true,
        });
        assert.equal(await app.piSessions.archive(owner(app), created.id), source.archive);
    } finally {
        await app.close();
    }
});

test("the canonical HTTP routes share the capability gate and pinned confirmation; no legacy path-only writer remains", async () => {
    const directory = join(root, "route-sources");

    mkdirSync(directory);
    const source = importFixture(directory);
    const app = await openApp(scriptedModel(), join(root, "route-data"));
    const guest = app.config.addUser("Collaborator", "guest");
    const viewer = app.config.addUser("Viewer", "viewer");
    const handler = createHandler({
        app,
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
    });
    const fake = fakeHerdr(app, source.path);
    const sockets = fake.local.sockets;
    let discovery = 0;

    fake.local.sockets = async () => {
        discovery++;

        return sockets();
    };

    // Real request/response parsing and routing, without opening a network listener.
    const request = async (
        method: string,
        path: string,
        body?: unknown,
        token = app.config.ownerToken,
    ) => {
        const incoming = new IncomingMessage(new Socket());
        const response = new ServerResponse(incoming);
        let output = "";

        incoming.url = `/api/${path}`;
        incoming.method = method;
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

        return {
            status: response.statusCode,
            text: output,
            cache: response.getHeader("cache-control"),
        };
    };

    try {
        for (const token of [guest.token, viewer.token]) {
            for (const [method, path, body] of [
                ["GET", "pi-sessions", undefined],
                ["GET", "pi-sessions/history", undefined],
                ["GET", "pi-sessions/active", undefined],
                ["GET", `pi-sessions/preview?path=${encodeURIComponent(source.path)}`, undefined],
                ["POST", "pi-sessions/preview", { path: source.path }],
                ["POST", "pi-sessions/active/preview", { id: "0".repeat(64) }],
                ["POST", "pi-sessions/continue", { path: source.path }],
                ["POST", "pi-sessions", { path: source.path }],
                ["POST", "pi-sessions/active", { id: "0".repeat(64) }],
            ] as const) {
                assert.equal(
                    (await request(method, path, body, token)).status,
                    403,
                    `${method} ${path}`,
                );
            }
        }

        assert.equal(discovery, 0);
        assert.equal((await request("POST", "imports", { path: source.path })).status, 404);
        assert.equal(
            (await request("POST", "pi-sessions/continue", { path: source.path })).status,
            400,
        );
        app.setAccess(owner(app), guest.user.id, { continuePiSessions: true });
        const listing = await request("GET", "pi-sessions/active", undefined, guest.token);

        assert.equal(listing.status, 200);
        assert.equal(listing.cache, "no-store");
        const id = JSON.parse(listing.text).sessions[0].id;
        const response = await request("POST", "pi-sessions/active/preview", { id }, guest.token);

        assert.equal(response.status, 200);
        assert.equal(response.cache, "no-store");
        const preview = JSON.parse(response.text);
        const confirmation = {
            id,
            sha256: preview.sha256,
            leafId: preview.leafId,
            acknowledged: true,
            model: "faux/faux-vision",
            thinkingLevel: "off",
            visibility: "shared",
        };
        const moved = await request("POST", "pi-sessions/active", confirmation, guest.token);

        assert.equal(moved.status, 200);
        const conversation = JSON.parse(moved.text).id;

        assert.equal(
            (await request("GET", `pi-sessions/${conversation}/archive`, undefined, guest.token))
                .status,
            403,
        );
        const archive = await request("GET", `pi-sessions/${conversation}/archive`);

        assert.equal(archive.status, 200);
        assert.equal(archive.text, source.archive);
        app.setAccess(owner(app), guest.user.id, { continuePiSessions: false });
        const before = discovery;

        assert.equal(
            (await request("POST", "pi-sessions/active", confirmation, guest.token)).status,
            403,
        );
        assert.equal(discovery, before);
        assert.equal(app.sessions().length, 1);
        assert.deepEqual(fake.state.signals, []);
        assert.deepEqual(fake.state.escapes, []);
    } finally {
        await app.close();
    }
});
