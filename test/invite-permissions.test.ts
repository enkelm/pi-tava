// Authoring gate: the real socket-free HTTP handler owns untrusted invite JSON validation;
// app access updates own revocation and browser projections. Auth persistence and non-delegation
// are covered separately in invite-auth.test.ts. No test-only production seams or local listeners.
import { type App, cleanUp, newSession, openApp, owner, root, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { Auth } from "../src/server/auth.ts";
import { canContinuePiSessions, ConfigStore } from "../src/server/config.ts";
import { createHandler } from "../src/server/http.ts";

let app: App;
let handler: ReturnType<typeof createHandler>;

before(async () => {
    app = await openApp(scriptedModel(), join(root, "invite-permissions-app"));
    handler = createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} });
});
after(async () => {
    await app?.close();
    cleanUp();
});

async function request(path: string, body: unknown, token = app.config.ownerToken) {
    const request = new IncomingMessage(new Socket());
    const response = new ServerResponse(request);
    let output = "";

    request.url = `/api/${path}`;
    request.method = "POST";
    request.headers = {
        authorization: `Bearer ${token}`,
        "x-pocket": "1",
        "content-type": "application/json",
    };

    response.end = (chunk?: unknown) => {
        output = String(chunk ?? "");

        return response;
    };

    const handled = handler(request, response);

    request.push(Buffer.from(JSON.stringify(body)));
    request.push(null);
    await handled;

    return new Response(output, { status: response.statusCode });
}

test("HTTP invite input rejects unauthorized, malformed and ineligible local Pi grants", async () => {
    const auth = new Auth(app.config);
    const id = await newSession(app);
    const guest = app.config.addUser("Guest", "guest");
    const viewer = app.config.addUser("Viewer", "viewer");
    const scoped = app.config.addUser("Scoped", "guest", [String(id)]);

    app.setAccess(owner(app), guest.user.id, { continuePiSessions: true });

    for (const token of [guest.token, viewer.token, scoped.token]) {
        assert.equal(
            (await request("invite", { role: "guest", continuePiSessions: true }, token)).status,
            403,
        );
    }

    for (const body of [
        { role: "viewer", continuePiSessions: true },
        { role: "owner", continuePiSessions: true },
        { role: "guest", session: Number(id), continuePiSessions: true },
        { role: "guest", continuePiSessions: "true" },
        { role: "guest", continuePiSessions: 1 },
        { role: "guest", continuePiSessions: null },
    ]) {
        assert.equal((await request("invite", body)).status, 400, JSON.stringify(body));
    }

    const granted = await request("invite", { role: "guest", continuePiSessions: true });

    assert.equal(granted.status, 200);
    const result = await granted.json();

    assert.deepEqual(result.grant, { role: "guest", continuePiSessions: true });
    assert.equal(auth.redeem(result.code, "Invited")!.user.continuePiSessions, true);

    const ordinary = await request(
        "invite",
        { role: "guest", continuePiSessions: false },
        guest.token,
    );

    assert.equal(ordinary.status, 200);
    const ungranted = await ordinary.json();

    assert.deepEqual(ungranted.grant, { role: "guest" });
    assert.equal(auth.redeem(ungranted.code, "Friend")!.user.continuePiSessions, undefined);
});

test("the owner can grant and revoke local Pi access; scope and role changes clear it", async () => {
    const id = await newSession(app);
    const guest = app.config.addUser("Manage me", "guest").user;
    const viewer = app.config.addUser("View only", "viewer").user;
    const scoped = app.config.addUser("One session", "guest", [String(id)]).user;
    const accessPath = `users/${guest.id}`;

    assert.equal((await app.hello(guest)).user.continuePiSessions, undefined);
    assert.equal((await app.hello(owner(app))).user.continuePiSessions, true);
    assert.throws(() => app.setAccess(guest, guest.id, { continuePiSessions: true }), /owner/i);
    assert.throws(
        () => app.setAccess(owner(app), viewer.id, { continuePiSessions: true }),
        /guest|steer/i,
    );
    assert.throws(
        () => app.setAccess(owner(app), scoped.id, { continuePiSessions: true }),
        /unrestricted|session/i,
    );
    assert.equal((await request(accessPath, { continuePiSessions: "true" })).status, 400);
    assert.equal((await request(accessPath, { continuePiSessions: true })).status, 200);
    assert.equal((await app.hello(guest)).user.continuePiSessions, true);
    assert.equal(
        app.people(owner(app)).find((person) => person.id === guest.id)!.continuePiSessions,
        true,
    );
    assert.equal(
        app.people(viewer).find((person) => person.id === guest.id)!.continuePiSessions,
        undefined,
    );
    assert.equal((await request(accessPath, { continuePiSessions: false })).status, 200);
    assert.equal(guest.continuePiSessions, undefined);
    assert.equal((await app.hello(guest)).user.continuePiSessions, undefined);

    app.setAccess(owner(app), guest.id, { continuePiSessions: true });
    app.setAccess(owner(app), guest.id, { role: "viewer" });
    assert.equal(guest.continuePiSessions, undefined);
    app.setAccess(owner(app), guest.id, { role: "guest" });
    assert.equal(
        canContinuePiSessions(guest),
        false,
        "restoring steering does not restore an old grant",
    );
    app.setAccess(owner(app), guest.id, { continuePiSessions: true });
    app.setAccess(owner(app), guest.id, { sessions: [String(id)] });
    assert.equal(guest.continuePiSessions, undefined);
    app.setAccess(owner(app), guest.id, { sessions: null });
    assert.equal(
        canContinuePiSessions(guest),
        false,
        "removing scope does not restore an old grant",
    );

    app.setAccess(owner(app), viewer.id, {
        role: "guest",
        sessions: null,
        continuePiSessions: true,
    });
    assert.equal(canContinuePiSessions(viewer), true);
    assert.equal(
        new ConfigStore(dirname(app.config.file)).userById(viewer.id)!.continuePiSessions,
        true,
    );
});
