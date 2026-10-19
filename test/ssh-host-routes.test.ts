// The socket-free HTTP boundary owns authentication, metadata privacy and freshness.
// Config parsing/Include edge cases belong to ssh-hosts.test.ts; no real SSH configuration or sockets are used here.
import {
    type App,
    cleanUp,
    home,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { join } from "node:path";
import { after, before, mock, test } from "node:test";
import { createHandler } from "../src/server/http.ts";
import { sshFixture } from "./ssh-fixture.ts";

let app: App;
let handler: ReturnType<typeof createHandler>;
const config = join(home, ".ssh", "config");

before(async () => {
    mkdirSync(join(home, ".ssh"), { recursive: true });
    writeFileSync(
        config,
        "Host Rentamac\n  HostName private.invalid\n  IdentityFile /private/key\n",
    );
    writeFileSync(
        join(home, ".ssh", "known_hosts"),
        "[gate1.rentamac.io]:20977 ssh-ed25519 PUBLIC-FIXTURE-KEY\n",
    );
    app = await openApp(scriptedModel(), join(root, "ssh-host-routes"));
    handler = createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} });
});
after(async () => {
    await app?.close();
    cleanUp();
});

async function request(token: string | null = app.config.ownerToken) {
    const incoming = new IncomingMessage(new Socket());
    const response = new ServerResponse(incoming);
    let output = "";

    incoming.url = "/api/ssh-hosts";
    incoming.method = "GET";
    incoming.headers = token === null ? {} : { authorization: `Bearer ${token}` };

    response.end = (chunk?: unknown) => {
        output = String(chunk ?? "");

        return response;
    };

    incoming.push(null);
    await handler(incoming, response);

    return new Response(output, {
        status: response.statusCode,
        headers: { "cache-control": String(response.getHeader("cache-control") ?? "") },
    });
}

test("known SSH suggestions are owner-only destination metadata from the Coop home, refreshed without caching", async () => {
    assert.equal((await request(null)).status, 401);
    const id = await newSession(app);

    for (const [role, sessions] of [
        ["guest", undefined],
        ["viewer", undefined],
        ["guest", [String(id)]],
    ] as const) {
        const { token } = app.config.addUser(
            "No discovery",
            role,
            sessions === undefined ? undefined : [...sessions],
        );

        assert.equal((await request(token)).status, 403);
    }

    const response = await request();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
        hosts: ["Rentamac", "ssh://gate1.rentamac.io:20977"],
        incomplete: false,
    });
    writeFileSync(config, "Host second-machine\n  User private-account\n");
    assert.deepEqual(await (await request()).json(), {
        hosts: ["second-machine", "ssh://gate1.rentamac.io:20977"],
        incomplete: false,
    });
});

// This exercises the real route and SFTP handshake, not a mock which supplies the authorization
// ordering. A same-token scope change must prevent MKDIR, not merely discard its acknowledgement.
test("folder creation reauthorizes after SSH authentication before dispatching a mutation", async () => {
    const ssh = await sshFixture();
    const hold = join(ssh.root, "hold-sftp-init");
    const folder = join(ssh.root, "must-not-be-created");
    const { user, token } = app.config.addUser("Folder creator", "guest");
    const id = await newSession(app);
    const incoming = new IncomingMessage(new Socket());
    const response = new ServerResponse(incoming);

    incoming.url = "/api/fs";
    incoming.method = "POST";
    incoming.headers = {
        authorization: `Bearer ${token}`,
        "x-pocket": "1",
        "content-type": "application/json",
    };
    response.end = () => response;
    incoming.push(
        JSON.stringify({ path: folder, location: { kind: "ssh", host: "fixture-host" } }),
    );
    incoming.push(null);
    writeFileSync(hold, "wait");

    try {
        const pending = handler(incoming, response);

        await until(
            () => existsSync(join(ssh.root, "sftp-init-ready")),
            "SFTP authentication waits",
        );
        const tokenHash = user.tokenHash;

        app.setAccess(owner(app), user.id, { role: "guest", sessions: [String(id)] });
        assert.equal(user.tokenHash, tokenHash);
        rmSync(hold);
        await pending;
        assert.notEqual(response.statusCode, 200);
        assert.equal(existsSync(folder), false, "no unauthorized MKDIR reached the peer");
    } finally {
        rmSync(hold, { force: true });
        await ssh.close();
    }
});

test("revoking the owner's token during discovery cannot return its host metadata", async () => {
    const scanned = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const original = app.sshSessions.hosts.bind(app.sshSessions);
    const delayed = mock.method(
        app.sshSessions,
        "hosts",
        async (person: Parameters<typeof original>[0]) => {
            const result = await original(person);

            scanned.resolve();
            await release.promise;

            return result;
        },
    );

    try {
        const pending = request();

        await scanned.promise;
        app.config.rotateOwnerToken();
        release.resolve();
        const response = await pending;

        assert.equal(response.status, 401);
        assert.doesNotMatch(await response.text(), /second-machine|rentamac/i);
    } finally {
        release.resolve();
        delayed.mock.restore();
    }
});
