// The production SSHSessions interface owns request-local transports and joined shutdown.
// Disposable OpenSSH/SFTP peers only: no listener, real SSH host, credentials or native sandbox.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { context, openApp, owner, scriptedModel, until } from "./helpers.ts";
import { fixturePassword, sshFixture } from "./ssh-fixture.ts";

const host = "ssh://rentamac@fixture-host:20977";

test("a workspace operation shares one transport, releases its capability and never shares a transport with another request", async () => {
    const ssh = await sshFixture(host);
    const app = await openApp(scriptedModel(), join(ssh.root, "app"));

    try {
        await writeFile(join(ssh.root, "workspace.txt"), "target bytes");
        const { id } = await app.commands.createSession(owner(app), {
            threadType: "chat",
            cwd: ssh.root,
            location: { kind: "ssh", host },
        });
        const calls = async () =>
            (await readFile(join(ssh.root, "calls"), "utf8")).trim().split("\n").length;
        const before = await calls();
        const escaped = await app.sshSessions.withWorkspace(
            id,
            owner(app),
            context,
            async (backend) => {
                assert.equal(
                    getOrThrow(await backend.env.readTextFile("workspace.txt", backend.context)),
                    "target bytes",
                );
                assert.equal(
                    getOrThrow(await backend.env.readTextFile("workspace.txt", backend.context)),
                    "target bytes",
                );

                return backend;
            },
        );

        assert.equal((await calls()) - before, 1, "a compound read owns exactly one SFTP peer");
        await assert.rejects(escaped.readBytes("workspace.txt", 100), /operation has finished/);
        await app.sshSessions.withWorkspace(id, owner(app), context, async (backend) => {
            assert.equal(
                getOrThrow(await backend.env.readTextFile("workspace.txt", backend.context)),
                "target bytes",
            );
        });
        assert.equal(
            (await calls()) - before,
            2,
            "a later request must create its own authenticated transport",
        );
    } finally {
        await app.close();
        await ssh.close();
    }
});

test("closing SSHSessions cancels and joins a gated real workspace read and password login before returning", async () => {
    const ssh = await sshFixture(host, true);
    const app = await openApp(scriptedModel(), join(ssh.root, "app"));

    try {
        await writeFile(join(ssh.root, "workspace.txt"), "target bytes");
        await app.sshSessions.login(owner(app), host, fixturePassword, context, () => true);
        const { id } = await app.commands.createSession(owner(app), {
            threadType: "chat",
            cwd: ssh.root,
            location: { kind: "ssh", host },
        });

        await writeFile(join(ssh.root, "hold-sftp-5"), "wait for cancellation");
        let readSettled = false;
        const read = app.sshSessions
            .withWorkspace(id, owner(app), context, async (backend) =>
                getOrThrow(await backend.env.readBinaryFile("workspace.txt", backend.context)),
            )
            .then(
                () => {
                    readSettled = true;

                    return undefined;
                },
                (error: unknown) => {
                    readSettled = true;

                    return error;
                },
            );

        await until(
            () => existsSync(join(ssh.root, "sftp-5-ready")),
            "workspace READ reaches the fixture gate",
        );
        const readPid = Number(await readFile(join(ssh.root, "sftp-5-ready"), "utf8"));

        await writeFile(join(ssh.root, "hold-sftp-16"), "wait for cancellation");
        let loginSettled = false;
        const login = app.sshSessions
            .login(owner(app), host, fixturePassword, context, () => true)
            .then(
                () => {
                    loginSettled = true;

                    return undefined;
                },
                (error: unknown) => {
                    loginSettled = true;

                    return error;
                },
            );

        await until(
            () => existsSync(join(ssh.root, "sftp-16-ready")),
            "password login reaches the fixture gate",
        );
        const loginPid = Number(await readFile(join(ssh.root, "sftp-16-ready"), "utf8"));

        await app.sshSessions.close();
        assert.equal(readSettled, true, "close must join the entire read callback and cleanup");
        assert.equal(
            loginSettled,
            true,
            "close must join candidate credential disposal and cleanup",
        );
        assert.ok((await read) instanceof Error);
        assert.ok((await login) instanceof Error);

        for (const pid of [readPid, loginPid]) {
            assert.throws(
                () => process.kill(pid, 0),
                { code: "ESRCH" },
                "the fixture SSH child must be gone before close resolves",
            );
        }

        const calls = await readFile(join(ssh.root, "calls"), "utf8");

        await assert.rejects(
            app.sshSessions.withWorkspace(id, owner(app), context, async () => "must not run"),
            /closing/,
        );
        assert.equal(
            await readFile(join(ssh.root, "calls"), "utf8"),
            calls,
            "shutdown never starts a replacement operation",
        );
    } finally {
        await app.close();
        await ssh.close();
    }
});
