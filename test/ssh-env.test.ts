import assert from "node:assert/strict";
import { writeFile, readFile, chmod, stat, symlink, realpath, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";
import { mock, test } from "node:test";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import { SshExecutionEnv, validateSshHost, withSshFileSystem } from "../src/server/ssh-env.ts";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { createSshPassword, SshPasswords } from "../src/server/ssh-passwords.ts";
import { fixturePassword } from "./ssh-fixture.ts";

import { sshFixture as fixture } from "./ssh-fixture.ts";

// These tests own the transport contract: quoting/byte framing, handle identity and
// remote process lifecycle are not reached by the app's local ExecutionEnv tests.
test("SSH filesystem transfers bytes and unusual paths, keeps opened file identity, and preserves permissions", async () => {
    const f = await fixture();
    const ctx = BACKGROUND_CONTEXT;

    try {
        const name = "quote' $;\n雪.bin";
        const bytes = Buffer.alloc(100_001);

        for (let i = 0; i < bytes.length; i++) {
            bytes[i] = i % 256;
        }

        getOrThrow(await f.env.writeFile(name, bytes, ctx));
        await chmod(join(f.root, name), 0o640);
        assert.deepEqual(Buffer.from(getOrThrow(await f.env.readBinaryFile(name, ctx))), bytes);
        const reader = getOrThrow(await f.env.openBinaryReader(name, undefined, ctx));

        getOrThrow(await f.env.renameFile(name, "renamed", ctx));
        getOrThrow(await f.env.writeFile(name, "new", ctx));
        assert.deepEqual(
            Buffer.from(getOrThrow(await reader.read(32_766, 10, ctx))),
            bytes.subarray(32_766, 32_776),
        );
        assert.equal(getOrThrow(await reader.info(ctx)).size, bytes.length);
        await reader.close(ctx);
        getOrThrow(await f.env.writeFile("renamed", "hello", ctx));
        assert.equal((await stat(join(f.root, "renamed"))).mode & 0o777, 0o640);
        getOrThrow(await f.env.appendFile("renamed", "\nworld\n", ctx));
        assert.deepEqual(getOrThrow(await f.env.readTextLines("renamed", undefined, ctx)), [
            "hello",
            "world",
        ]);
        const paged = getOrThrow(await f.env.openDirReader(".", ctx));
        const entries = [];
        let done = false;

        while (!done) {
            const page = getOrThrow(await paged.next(1, ctx));

            assert.ok(page.entries.length <= 1);
            entries.push(...page.entries);
            done = page.done;
        }

        await paged.close(ctx);
        assert.ok(entries.some((e) => e.name === name && e.kind === "file"));
        assert.equal(
            getOrThrow(await f.env.canonicalPath("~/renamed", ctx)),
            await realpath(join(f.root, "renamed")),
        );
        assert.equal(getOrThrow(await f.env.exists("missing", ctx)), false);
        await symlink("renamed", join(f.root, "link"));
        const noFollow = await f.env.openBinaryReader("link", { noFollow: true }, ctx);

        assert.equal(noFollow.ok, false);

        if (!noFollow.ok) {
            assert.equal(noFollow.error.code, "not_supported");
        }

        const calls = (await readFile(join(f.root, "calls"), "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as string[]);

        assert.ok(
            calls.every(
                (argv) =>
                    argv.includes("-oBatchMode=yes") &&
                    argv.includes("-oForwardAgent=no") &&
                    argv.includes("-oSendEnv=-*"),
            ),
        );
        assert.ok(
            calls.every((argv) => !argv.some((arg) => arg.includes("StrictHostKeyChecking=no"))),
        );
    } finally {
        await f.env.cleanup(ctx);
        await f.close();
    }
});

test("SSH exec preserves URI ports, quotes argv, streams UTF-8 and supplies complete remote output spill", async () => {
    const destination = "ssh://builder@fixture-host:20977";
    const f = await fixture(destination);
    const ctx = BACKGROUND_CONTEXT;

    try {
        let output = "";
        const argument = "' ; $(touch injected)\n雪";
        const r = getOrThrow(
            await f.env.exec(
                ["printf", "%s", argument],
                {
                    onOutput: (t) => {
                        output += t;
                    },
                    spill: { afterBytes: 1, afterLines: 1 },
                },
                ctx,
            ),
        );

        assert.equal(r.exitCode, 0);
        assert.equal(output, argument);
        assert.ok(r.spillPath);
        assert.equal(getOrThrow(await f.env.readTextFile(r.spillPath, ctx)), argument);
        assert.equal(getOrThrow(await f.env.exists("injected", ctx)), false);
        getOrThrow(await f.env.remove(r.spillPath, undefined, ctx));
        let envOutput = "";
        const result = getOrThrow(
            await f.env.exec(
                'printf "%s" "$COOP_VALUE"; exit 7',
                {
                    env: { COOP_VALUE: argument },
                    onOutput: (t) => {
                        envOutput += t;
                    },
                },
                ctx,
            ),
        );

        assert.equal(envOutput, argument);
        assert.equal(result.exitCode, 7);
        const oneLine = getOrThrow(
            await f.env.exec(
                ["printf", "a\\n"],
                { spill: { afterBytes: 1024, afterLines: 1 } },
                ctx,
            ),
        );

        assert.equal(oneLine.spillPath, undefined, "A terminated line is not two output lines");
        const calls: string[][] = (await readFile(join(f.root, "calls"), "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));

        assert.ok(calls.length > 0);
        assert.ok(
            calls.every((argv) => argv.includes(destination)),
            "Commands and SFTP must preserve the explicit port and user",
        );
    } finally {
        await f.env.cleanup(ctx);
        await f.close();
    }
});

test("SSH timeout kills ordinary descendants; transport loss reports unknown without replay", async () => {
    const f = await fixture();
    const ctx = BACKGROUND_CONTEXT;

    try {
        let output = "";
        const result = await f.env.exec(
            "(trap '' TERM; sleep 1.8; printf escaped > late-effect) & wait",
            {
                timeout: 0.15,
                onOutput: (t) => {
                    output += t;
                },
            },
            ctx,
        );

        assert.equal(result.ok, false);

        if (!result.ok) {
            assert.equal(result.error.code, "timeout");
            assert.match(result.error.message, /unconfirmed/);
        }

        await new Promise((resolve) => setTimeout(resolve, 1200));
        assert.equal(getOrThrow(await f.env.exists("late-effect", ctx)), false, output);
        const lost = new SshExecutionEnv({ host: "lost-host", cwd: f.root });
        const failure = await lost.exec("arbitrary mutation", undefined, ctx);

        assert.equal(failure.ok, false);

        if (!failure.ok) {
            assert.match(failure.error.message, /outcome is unknown/);
        }

        assert.equal(await readFile(join(f.root, "effect"), "utf8"), "once");
        await lost.cleanup(ctx);
    } finally {
        await f.env.cleanup(ctx);
        await f.close();
    }
});

test("cancelling one remote command prevents its continuation without stopping another", async () => {
    const f = await fixture();
    const targetContext = withCancel(BACKGROUND_CONTEXT);
    const peerContext = withCancel(BACKGROUND_CONTEXT);
    const effect = join(f.root, "cancelled-continuation");
    const release = join(f.root, "release-peer");

    const start = (
        command: readonly string[],
        context: typeof BACKGROUND_CONTEXT,
        marker: string,
    ) => {
        let output = "";
        let entered!: () => void;
        const ready = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const done = f.env.exec(
            command,
            {
                timeout: 10,
                onOutput(text, _context, info) {
                    if (info.stream === "stdout") {
                        output += text;

                        if (output.includes(marker)) {
                            entered();
                        }
                    }
                },
            },
            context,
        );

        return {
            done,
            ready: Promise.race([
                ready,
                done.then(() => {
                    throw new Error("Command ended before its gate");
                }),
            ]),
            output: () => output,
        };
    };

    let target: ReturnType<typeof start> | undefined;
    let peer: ReturnType<typeof start> | undefined;

    try {
        peer = start(
            [
                "sh",
                "-c",
                'printf peer-ready; while [ ! -f "$1" ]; do sleep 0.02; done; printf peer-complete',
                "fixture",
                release,
            ],
            peerContext.context,
            "peer-ready",
        );
        target = start(
            [
                "sh",
                "-c",
                'trap "" TERM; printf target-ready; sleep 10; printf effect > "$1"',
                "fixture",
                effect,
            ],
            targetContext.context,
            "target-ready",
        );
        await Promise.all([peer.ready, target.ready]);
        targetContext.cancel();
        const interrupted = await target.done;

        assert.equal(interrupted.ok, false);

        if (!interrupted.ok) {
            assert.equal(interrupted.error.code, "aborted");
            assert.match(interrupted.error.message, /unconfirmed.*not automatically replay/i);
        }

        assert.equal(
            getOrThrow(await f.env.exists(effect, BACKGROUND_CONTEXT)),
            false,
            "killing the child cannot wake its TERM-ignoring shell into the next command",
        );
        await writeFile(release, "explicitly release the unrelated group");
        assert.equal(getOrThrow(await peer.done).exitCode, 0);
        assert.equal(
            peer.output(),
            "peer-readypeer-complete",
            "the concurrent command must remain running and finish normally",
        );
    } finally {
        targetContext.cancel();
        peerContext.cancel();
        await Promise.allSettled([target?.done, peer?.done]);
        await f.env.cleanup(BACKGROUND_CONTEXT);
        await f.close();
    }
});

test("SSH optimistic edits refuse changed content, including same-size same-timestamp writes", async () => {
    const f = await fixture();
    const ctx = BACKGROUND_CONTEXT;

    try {
        await writeFile(join(f.root, "edit.txt"), "before");
        assert.equal(getOrThrow(await f.env.readTextFile("edit.txt", ctx)), "before");
        const previous = await stat(join(f.root, "edit.txt"));

        await writeFile(join(f.root, "edit.txt"), "after!");
        await utimes(join(f.root, "edit.txt"), previous.atime, previous.mtime);
        const conflict = await f.env.writeFile("edit.txt", "my edit", ctx);

        assert.equal(conflict.ok, false);

        if (!conflict.ok) {
            assert.match(conflict.error.message, /Edit conflict/);
        }

        assert.equal(await readFile(join(f.root, "edit.txt"), "utf8"), "after!");
        assert.equal(getOrThrow(await f.env.readTextFile("edit.txt", ctx)), "after!");
        getOrThrow(await f.env.writeFile("edit.txt", "merged", ctx));
        assert.equal(await readFile(join(f.root, "edit.txt"), "utf8"), "merged");
    } finally {
        await f.env.cleanup(ctx);
        await f.close();
    }
});

test("SSH authentication failure never falls back locally and interrupted writes are not retried", async () => {
    const f = await fixture();
    const ctx = BACKGROUND_CONTEXT;

    try {
        await writeFile(join(f.root, "local.txt"), "local sentinel");
        const denied = new SshExecutionEnv({ host: "auth-failed", cwd: f.root });
        const read = await denied.readTextFile("local.txt", ctx);

        assert.equal(read.ok, false);

        if (!read.ok) {
            assert.match(read.error.message, /Permission denied/);
        }

        const write = await denied.writeFile("local.txt", "overwrite", ctx);

        assert.equal(write.ok, false);
        assert.equal(await readFile(join(f.root, "local.txt"), "utf8"), "local sentinel");
        const lost = new SshExecutionEnv({ host: "lost-write", cwd: f.root });
        const uncertain = await lost.appendFile("effect.txt", "once", ctx);

        assert.equal(uncertain.ok, false);

        if (!uncertain.ok) {
            assert.match(uncertain.error.message, /outcome may be unknown/);
        }

        assert.equal(await readFile(join(f.root, "effect.txt"), "utf8"), "once");
        await denied.cleanup(ctx);
        await lost.cleanup(ctx);
    } finally {
        await f.env.cleanup(ctx);
        await f.close();
    }
});

test("SSH reader honors per-call cancellation without poisoning subsequent operations", async () => {
    const f = await fixture();
    const ctx = BACKGROUND_CONTEXT;

    try {
        await writeFile(join(f.root, "read.txt"), "hello");
        const reader = getOrThrow(await f.env.openBinaryReader("read.txt", undefined, ctx));
        const cancelled = withCancel(ctx);

        cancelled.cancel();
        const read = await reader.read(0, 4, cancelled.context);

        assert.equal(read.ok, false);

        if (!read.ok) {
            assert.equal(read.error.code, "aborted");
        }

        await reader.close(ctx).catch(() => {});
        assert.equal(getOrThrow(await f.env.exec(["true"], undefined, ctx)).exitCode, 0);
    } finally {
        await f.env.cleanup(ctx);
        await f.close();
    }
});

test("cancellation during password preparation cannot start a connection or command and removes its IPC", async (t) => {
    for (const operation of ["connect", "exec"] as const) {
        await t.test(operation, async () => {
            const f = await fixture();
            const credential = createSshPassword("ephemeral-test-password");
            const prepared = Promise.withResolvers<void>();
            const release = Promise.withResolvers<void>();
            const directories: string[] = [];
            const original = credential.prepare.bind(credential);
            const delayed = mock.method(credential, "prepare", async () => {
                const lease = await original();

                directories.push(dirname(lease.env.SSH_ASKPASS!));
                prepared.resolve();
                await release.promise;

                return lease;
            });
            const env = new SshExecutionEnv({
                host: "fixture-host",
                cwd: f.root,
                password: () => credential,
            });
            const cancelled = withCancel(BACKGROUND_CONTEXT);

            try {
                const pending =
                    operation === "connect"
                        ? env.canonicalPath("~", cancelled.context)
                        : env.exec("printf must-not-start", undefined, cancelled.context);

                await prepared.promise;
                cancelled.cancel();
                release.resolve();
                const result = await pending;

                assert.equal(result.ok, false);

                if (!result.ok) {
                    assert.equal(result.error.code, "aborted");
                }

                await assert.rejects(readFile(join(f.root, "calls")), { code: "ENOENT" });

                for (const directory of directories) {
                    await assert.rejects(stat(directory), { code: "ENOENT" });
                }
            } finally {
                release.resolve();
                delayed.mock.restore();
                credential.dispose();
                await env.cleanup(BACKGROUND_CONTEXT);
                await f.close();
            }
        });
    }
});

test("a rejected oversized command releases its password channel without replay", async () => {
    const f = await fixture();
    const credential = createSshPassword("ephemeral-test-password");
    const directories: string[] = [];
    const original = credential.prepare.bind(credential);
    const captured = mock.method(credential, "prepare", async () => {
        const lease = await original();

        directories.push(dirname(lease.env.SSH_ASKPASS!));

        return lease;
    });
    const env = new SshExecutionEnv({
        host: "fixture-host",
        cwd: f.root,
        password: () => credential,
    });

    try {
        const result = await env.exec(
            "printf " + "x".repeat(4 * 1024 * 1024),
            undefined,
            BACKGROUND_CONTEXT,
        );

        assert.equal(result.ok, false);

        if (!result.ok) {
            assert.equal(result.error.code, "spawn_error");
        }

        assert.equal(directories.length, 1, "Only actual command delivery prepares authentication");

        for (const directory of directories) {
            await assert.rejects(stat(directory), { code: "ENOENT" });
        }

        await assert.rejects(readFile(join(f.root, "calls")), { code: "ENOENT" });
    } finally {
        captured.mock.restore();
        credential.dispose();
        await env.cleanup(BACKGROUND_CONTEXT);
        await f.close();
    }
});

test("compound filesystem requests isolate concurrent scopes and close their transports before the next request", async () => {
    const f = await fixture();
    const ctx = BACKGROUND_CONTEXT;

    try {
        await writeFile(join(f.root, "read.txt"), "remote bytes");
        const read = () =>
            withSshFileSystem(f.env, async () => {
                assert.equal(getOrThrow(await f.env.readTextFile("read.txt", ctx)), "remote bytes");
                const [path, info] = await Promise.all([
                    f.env.canonicalPath("read.txt", ctx),
                    f.env.fileInfo("read.txt", ctx),
                ]);

                assert.equal(getOrThrow(path), await realpath(join(f.root, "read.txt")));
                assert.equal(getOrThrow(info).size, Buffer.byteLength("remote bytes"));
            });

        await Promise.all([read(), read()]);
        const calls = () =>
            readFile(join(f.root, "calls"), "utf8").then((text) => text.trim().split("\n"));

        assert.equal(
            (await calls()).length,
            2,
            "concurrent requests must not share an authenticated session",
        );
        await read();
        assert.equal(
            (await calls()).length,
            3,
            "a completed request must not leave a reusable login channel",
        );
    } finally {
        await f.env.cleanup(ctx);
        await f.close();
    }
});

test("cancelling a compound request aborts its shared session without poisoning the next request", async () => {
    const f = await fixture();
    const ctx = BACKGROUND_CONTEXT;
    const cancelled = withCancel(ctx);

    try {
        await writeFile(join(f.root, "read.txt"), "remote bytes");
        await assert.rejects(
            withSshFileSystem(
                f.env,
                async () => {
                    getOrThrow(await f.env.fileInfo("read.txt", ctx));
                    cancelled.cancel();
                    getOrThrow(await f.env.readTextFile("read.txt", ctx));
                },
                cancelled.context,
            ),
            { code: "aborted" },
        );
        assert.equal(getOrThrow(await f.env.readTextFile("read.txt", ctx)), "remote bytes");
    } finally {
        await f.env.cleanup(ctx);
        await f.close();
    }
});

test("forgetting a password invalidates an in-flight compound request without reconnecting", async (t) => {
    for (const next of ["read", "return"]) {
        await t.test(next, async () => {
            const f = await fixture("fixture-host", true);
            const passwords = new SshPasswords();
            const ctx = BACKGROUND_CONTEXT;
            const env = new SshExecutionEnv({
                host: "fixture-host",
                cwd: f.root,
                password: () => passwords.get("current-user", "fixture-host"),
            });

            try {
                await writeFile(join(f.root, "read.txt"), "must not borrow an expired login");
                passwords.set("current-user", "fixture-host", fixturePassword);
                await assert.rejects(
                    withSshFileSystem(env, async () => {
                        assert.equal(getOrThrow(await env.fileInfo("read.txt", ctx)).kind, "file");
                        passwords.forget("current-user", "fixture-host");

                        if (next === "read") {
                            getOrThrow(await env.readTextFile("read.txt", ctx));
                        }
                    }),
                    /SSH login changed/,
                );
                const calls = (await readFile(join(f.root, "calls"), "utf8")).trim().split("\n");

                assert.equal(
                    calls.length,
                    1,
                    "revocation must not authenticate again or replay the read",
                );
            } finally {
                passwords.close();
                await env.cleanup(ctx);
                await f.close();
            }
        });
    }
});

test("SSH destinations allow native port URIs but reject credentials, options and command syntax", () => {
    for (const host of [
        "-oProxyCommand=evil",
        "host;touch evil",
        "user@host x",
        "ssh://host/path",
        "ssh://host/",
        "ssh://host?command=evil",
        "ssh://host#fragment",
        "ssh://user:password@host:22",
        "ssh://user%40other@host:22",
        "ssh://host:0",
        "ssh://host:65536",
        "ssh://host:abc",
        "ssh://-oProxyCommand=evil:22",
        "host:22",
        "",
        "x\n",
    ]) {
        assert.throws(() => validateSshHost(host));
    }

    for (const host of [
        "devbox",
        "user@dev-box.example",
        "[::1]",
        "ssh://host",
        "ssh://gate1.rentamac.io:20977",
        "ssh://builder@host:22",
        "ssh://user@[::1]:2200",
    ]) {
        assert.equal(validateSshHost(host), host);
    }
});
