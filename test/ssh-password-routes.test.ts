// The real HTTP/app/SSH-child/FIFO boundary owns password login, scoped reuse and revocation.
// The SSH executable speaks fixture SFTP locally; no listener, real host, owner config or credentials are used.
import {
    type App,
    cleanUp,
    context,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import type { Context } from "@earendil-works/chord";
import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { join } from "node:path";
import { after, before, mock, test } from "node:test";
import { createHandler } from "../src/server/http.ts";
import { SshExecutionEnv } from "../src/server/ssh-env.ts";
import { fixturePassword, sshFixture } from "./ssh-fixture.ts";

const host = "ssh://rentamac@fixture-host:20977";
const data = join(root, "ssh-password-app");
let app: App;
let handler: ReturnType<typeof createHandler>;
let transport: Awaited<ReturnType<typeof sshFixture>>;

before(async () => {
    transport = await sshFixture(host, true);
    app = await openApp(scriptedModel(), data);
    handler = createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} });
    await writeFile(join(transport.root, "workspace.txt"), "remote workspace bytes");
});
after(async () => {
    await app?.close();
    await transport?.close();
    cleanUp();
});

async function request(
    path = `ssh-auth?host=${encodeURIComponent(host)}`,
    body?: unknown,
    token: string | null = app.config.ownerToken,
    headers: Record<string, string> = {},
) {
    const incoming = new IncomingMessage(new Socket());
    const response = new ServerResponse(incoming);
    let output = "";

    incoming.url = `/api/${path}`;
    incoming.method = body === undefined ? "GET" : "POST";
    incoming.headers = {
        host: "localhost",
        "x-pocket": "1",
        "content-type": "application/json",
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        ...headers,
    };

    response.end = (chunk?: unknown) => {
        output = String(chunk ?? "");

        return response;
    };

    const pending = handler(incoming, response);

    if (body !== undefined) {
        incoming.push(Buffer.from(JSON.stringify(body)));
    }

    incoming.push(null);
    await pending;

    return new Response(output, {
        status: response.statusCode,
        headers: { "cache-control": String(response.getHeader("cache-control") ?? "") },
    });
}

const login = (password = fixturePassword) => request("ssh-auth", { host, password });
const status = async (target = host) =>
    (await request(`ssh-auth?host=${encodeURIComponent(target)}`)).json();

test("password endpoints require owner access, CSRF and a secure address before connecting", async () => {
    assert.equal((await request(undefined, undefined, null)).status, 401);

    for (const role of ["guest", "viewer"] as const) {
        const { token } = app.config.addUser("No passwords", role);

        assert.equal((await request(undefined, undefined, token)).status, 403);
        assert.equal(
            (await request("ssh-auth", { host, password: fixturePassword }, token)).status,
            403,
        );
    }

    assert.equal(
        (
            await request("ssh-auth", { host, password: fixturePassword }, undefined, {
                "x-pocket": "0",
            })
        ).status,
        403,
    );
    assert.equal(
        (
            await request("ssh-auth", { host, password: fixturePassword }, undefined, {
                host: "192.0.2.40:8888",
            })
        ).status,
        403,
    );

    for (const password of ["", "line\nbreak", "nul\0byte", "x".repeat(1025), { invalid: true }]) {
        assert.equal((await request("ssh-auth", { host, password })).status, 400);
    }

    assert.deepEqual(await status(), { authenticated: false });
    await assert.rejects(readFile(join(transport.root, "calls")), { code: "ENOENT" });
});

test("transport success without consuming the candidate password is not a successful password login", async () => {
    delete process.env.SSH_TEST_REQUIRE_PASSWORD;

    try {
        assert.equal((await login()).status, 409);
        assert.deepEqual(await status(), { authenticated: false });
    } finally {
        process.env.SSH_TEST_REQUIRE_PASSWORD = "1";
    }
});

test("a password reaches SSH without becoming durable metadata and is reused by folders, projects, threads and commands", async () => {
    const response = await login();

    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get("cache-control"), "no-store");
    const receipt = await response.json();

    assert.equal(receipt.authenticated, true);
    assert.equal(typeof receipt.expiresAt, "number");
    assert.deepEqual(await status("ssh://rentamac@fixture-host:2200"), { authenticated: false });
    assert.deepEqual(await status("ssh://other-user@fixture-host:20977"), { authenticated: false });
    const folder = await request(`fs?host=${encodeURIComponent(host)}&path=~`);

    assert.equal(folder.status, 200, await folder.clone().text());
    const project = await app.projects.create(owner(app), {
        name: "Password fixture",
        cwd: transport.root,
        location: { kind: "ssh", host },
        requestId: "password-project",
    });

    await app.projects.update(owner(app), project.id, { cwd: transport.root });
    const { id } = await app.commands.createSession(owner(app), {
        threadType: "chat",
        projectId: project.id,
    });
    const unattributed = await app.envFor(id).readTextFile("workspace.txt", context);

    assert.equal(
        unattributed.ok,
        false,
        "an unattributed agent must not borrow its creator's saved password",
    );
    assert.match(
        !unattributed.ok ? unattributed.error.message : "",
        /currently authorized requester/,
    );
    const env = app.envFor(id, owner(app));
    const file = await env.readTextFile("workspace.txt", context);

    assert.equal(file.ok && file.value, "remote workspace bytes");
    const command = await env.exec(["printf", "%s", "command on fixture"], undefined, context);

    assert.equal(command.ok && command.value.exitCode, 0);
    const guest = app.config.addUser("Shared guest", "guest").user;

    await assert.rejects(app.workspace.viewFile(id, guest, "workspace.txt"), /SSH|password/i);
    await app.shell.start(id, guest, {
        command: "printf should-not-borrow-owner-password",
        context: false,
    });
    await until(
        async () =>
            (await app.transcripts.history(id, Number.MAX_SAFE_INTEGER)).some(
                (entry) => entry.kind === "shell",
            ),
        "guest shell refusal",
    );
    const shell = (await app.transcripts.history(id, Number.MAX_SAFE_INTEGER)).find(
        (entry) => entry.kind === "shell",
    );

    assert.ok(shell?.kind === "shell");
    assert.equal(
        shell.status,
        "failed",
        "A human shell must bind authentication to its actual requester, not the last agent requester",
    );
    assert.equal(JSON.stringify(app.sessionMeta(id)).includes(fixturePassword), false);
    const calls = await readFile(join(transport.root, "calls"), "utf8");

    assert.equal(calls.includes(fixturePassword), false);
    const wrong = "wrong'雪-secret-not-to-log";
    const refused = await login(wrong);

    assert.equal(refused.status, 409);
    assert.equal(
        (await refused.text()).includes(wrong),
        false,
        "Remote authentication stderr must not echo a supplied password through the API",
    );
    assert.equal(
        (await status()).authenticated,
        true,
        "A failed replacement preserves the previous valid login",
    );
    assert.equal((await request("ssh-auth", { host, forget: true })).status, 200);
    assert.deepEqual(await status(), { authenticated: false });
    assert.equal(
        (await env.readTextFile("workspace.txt", context)).ok,
        false,
        "A cached env must not keep forgotten credentials or fall back to host files",
    );
    assert.equal((await login()).status, 200);
    assert.equal(
        (await env.readTextFile("workspace.txt", context)).ok,
        true,
        "The same cached env sees an explicit new login",
    );
    assert.equal((await request("logout", {})).status, 200);
    assert.deepEqual(await status(), { authenticated: false });
    assert.equal((await login()).status, 200);
    await app.close();

    for (const file of await readdir(data, { recursive: true, withFileTypes: true })) {
        if (file.isFile()) {
            const bytes = await readFile(join(file.parentPath, file.name));

            assert.equal(
                bytes.includes(Buffer.from(fixturePassword)),
                false,
                `Password persisted to ${file.name}`,
            );
        }
    }

    app = await openApp(scriptedModel(), data);
    handler = createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} });
    assert.deepEqual(await status(), { authenticated: false });
});

test("forgetting or revoking access while a real authentication probe settles cannot publish credentials", async () => {
    for (const action of ["forget", "revoke"] as const) {
        const scanned = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const original = SshExecutionEnv.prototype.canonicalPath;
        const delayed = mock.method(
            SshExecutionEnv.prototype,
            "canonicalPath",
            async function (this: SshExecutionEnv, path: string, ctx: Context) {
                const result = await original.call(this, path, ctx);

                scanned.resolve();
                await release.promise;

                return result;
            },
        );

        try {
            const pending = login();

            await scanned.promise;

            if (action === "forget") {
                await request("ssh-auth", { host, forget: true });
            } else {
                app.config.rotateOwnerToken();
            }

            release.resolve();
            const response = await pending;

            assert.equal(response.status, 409);
            assert.deepEqual(await status(), { authenticated: false });
        } finally {
            release.resolve();
            delayed.mock.restore();
        }
    }
});
