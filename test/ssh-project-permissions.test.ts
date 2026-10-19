// Real SSHSessions and disposable process/SFTP peers own grant, credential and revocation behavior.
// No live SSH account, listener, owner credentials or native confinement claim.
import { context, openApp, owner, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import type { User } from "../src/server/config.ts";
import { DestinationHeads } from "../src/server/destination-heads.ts";
import { HttpError } from "../src/server/errors.ts";
import { fixturePassword, sshFixture } from "./ssh-fixture.ts";
import { SshPasswords } from "../src/server/ssh-passwords.ts";

const host = "ssh://rentamac@fixture-host:20977";
const forbidden = (error: unknown) => error instanceof HttpError && error.status === 403;

async function setup(password = false) {
    const ssh = await sshFixture(host, password);
    const app = await openApp(scriptedModel(), join(ssh.root, "app"));

    if (password) {
        await app.sshSessions.login(owner(app), host, fixturePassword, context, () => true);
    }

    const { id: projectId } = await app.projects.create(owner(app), {
        name: "Owner-approved remote project",
        cwd: ssh.root,
        location: { kind: "ssh", host },
        requestId: crypto.randomUUID(),
    });
    const { id } = await app.commands.createSession(owner(app), { projectId, threadType: "chat" });

    await writeFile(join(ssh.root, "workspace.txt"), "approved project bytes");
    const collaborator = (projectAccess: User["projectAccess"]) =>
        app.config.addUser("Collaborator", "guest", undefined, undefined, projectAccess).user;
    const calls = () => readFile(join(ssh.root, "calls"), "utf8");
    const read = (user: User) =>
        app.sshSessions.withWorkspace(id, user, context, async (backend) =>
            getOrThrow(await backend.env.readTextFile("workspace.txt", backend.context)),
        );

    return {
        app,
        ssh,
        projectId,
        id,
        collaborator,
        calls,
        read,
        async close() {
            await app.close();
            await ssh.close();
        },
    };
}

test("project grants allow only visible pinned remote work and never SSH management or arbitrary destinations", async () => {
    const f = await setup();

    try {
        const denied = f.collaborator({});
        const granted = f.collaborator({ projectIds: [f.projectId] });
        const all = f.collaborator({ all: true });
        const legacy = f.collaborator(undefined);
        const before = await f.calls();

        await assert.rejects(f.read(denied), /not shared/);
        assert.equal(await f.calls(), before, "an ungranted requester starts no transport");
        assert.equal(await f.read(granted), "approved project bytes");

        for (const user of [denied, granted, all, legacy]) {
            const before = await f.calls();

            await assert.rejects(f.app.sshSessions.hosts(user), forbidden);
            assert.throws(() => f.app.sshSessions.status(user, host), forbidden);
            assert.throws(() => f.app.sshSessions.forget(user, host), forbidden);
            assert.throws(
                () => f.app.sshSessions.login(user, host, fixturePassword, context, () => true),
                forbidden,
            );
            assert.throws(
                () =>
                    f.app.sshSessions.prepare(
                        user,
                        { location: { kind: "ssh", host }, cwd: f.ssh.root },
                        context,
                    ),
                forbidden,
            );
            assert.throws(
                () => f.app.sshSessions.browse(user, host, "/", true, context),
                forbidden,
            );
            assert.throws(
                () =>
                    f.app.sshSessions.createDirectory(user, host, join(f.ssh.root, "new"), context),
                forbidden,
            );
            assert.throws(
                () => f.app.sshSessions.modelDefault(user, host, f.ssh.root, context),
                forbidden,
            );
            await assert.rejects(f.app.sshSessions.projectTrust(f.id, user), forbidden);
            await assert.rejects(f.app.sshSessions.setProjectTrust(f.id, user, "trust"), forbidden);
            assert.equal(await f.calls(), before, "control-plane refusals never contact SSH");
        }
    } finally {
        await f.close();
    }
});

test("an explicit project grant can use the owner's private exact-host login only for normal pinned work", async () => {
    const f = await setup(true);

    try {
        const granted = f.collaborator({ hosts: [host] });
        const legacy = f.collaborator(undefined);
        const unrelated = await f.app.commands.createSession(owner(f.app), {
            threadType: "chat",
            cwd: f.ssh.root,
            location: { kind: "ssh", host },
        });

        assert.equal(await f.read(granted), "approved project bytes");
        await f.app.sshSessions.withWorkspace(f.id, granted, context, async (backend) => {
            getOrThrow(await backend.env.writeFile("guest.txt", "guest effect", backend.context));
            let output = "";
            const result = getOrThrow(
                await backend.env.exec(
                    "printf 'trusted project script'",
                    {
                        onOutput: (text) => {
                            output += text;
                        },
                    },
                    backend.context,
                ),
            );

            assert.equal(result.exitCode, 0);
            assert.equal(output, "trusted project script");
        });
        assert.equal(await readFile(join(f.ssh.root, "guest.txt"), "utf8"), "guest effect");
        await assert.rejects(
            f.app.sshSessions.withWorkspace(
                unrelated.id,
                granted,
                context,
                async () => "must not run",
            ),
            /not shared/,
        );
        await assert.rejects(f.read(legacy), /Password channel not configured safely/);

        const env = f.app.envFor(f.id, granted);

        assert.equal(
            getOrThrow(await env.readTextFile("workspace.txt", context)),
            "approved project bytes",
        );
        f.app.sshSessions.forget(owner(f.app), host);
        const forgotten = await env.readTextFile("workspace.txt", context);

        assert.equal(
            forgotten.ok,
            false,
            "a cached guest environment must not retain the forgotten credential",
        );

        if (!forgotten.ok) {
            assert.match(forgotten.error.message, /Password channel not configured safely/);
        }

        assert.equal(f.app.sshSessions.status(owner(f.app), host).authenticated, false);
        await f.app.sshSessions.login(owner(f.app), host, fixturePassword, context, () => true);
        const oldOwnerCapability = f.app.sshSessions.backend(f.id, granted, context);

        assert.equal(
            Buffer.from(await oldOwnerCapability.readBytes("workspace.txt", 100)).toString(),
            "approved project bytes",
        );
        f.app.config.rotateOwnerToken();
        await f.app.sshSessions.login(owner(f.app), host, fixturePassword, context, () => true);
        await assert.rejects(oldOwnerCapability.readBytes("workspace.txt", 100), /access changed/);
        assert.equal(
            getOrThrow(await f.app.envFor(f.id, granted).readTextFile("workspace.txt", context)),
            "approved project bytes",
            "a fresh requester environment uses only the newly logged-in owner token",
        );
        assert.ok(
            !(await f.calls()).includes(fixturePassword),
            "fixture process arguments never contain the password",
        );
    } finally {
        await f.close();
    }
});

for (const changed of ["forget", "rotation"] as const) {
    test(`a selected delegated password fails closed on owner ${changed}, without reconnecting or returning its result`, async () => {
        const f = await setup(true);

        try {
            const granted = f.collaborator({ projectIds: [f.projectId] });
            const before = (await f.calls()).trim().split("\n").length;

            await assert.rejects(
                f.app.sshSessions.withWorkspace(f.id, granted, context, async (backend) => {
                    const bytes = await backend.readBytes("workspace.txt", 100);

                    assert.equal(Buffer.from(bytes).toString(), "approved project bytes");

                    if (changed === "forget") {
                        f.app.sshSessions.forget(owner(f.app), host);
                    } else {
                        f.app.config.rotateOwnerToken();
                    }

                    return bytes;
                }),
                /login changed|access changed/,
            );
            assert.equal(
                (await f.calls()).trim().split("\n").length - before,
                1,
                "revocation never opens a replacement key/password transport",
            );
            await f.app.sshSessions.login(owner(f.app), host, fixturePassword, context, () => true);
            assert.equal(
                await f.read(granted),
                "approved project bytes",
                "only an independent request can select the fresh owner login",
            );
        } finally {
            await f.close();
        }
    });
}

test("revoking a project grant during delegated password preparation prevents command dispatch and closes its IPC", async (t) => {
    const f = await setup(true);
    const prepared = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const directories: string[] = [];
    let pending: Promise<{ value: unknown } | { error: unknown }> | undefined;
    const get = SshPasswords.prototype.get;
    const wrapped = new WeakSet<object>();

    t.mock.method(
        SshPasswords.prototype,
        "get",
        function (this: SshPasswords, ...args: Parameters<typeof get>) {
            const credential = get.apply(this, args);

            if (credential !== undefined && !wrapped.has(credential)) {
                wrapped.add(credential);
                const prepare = credential.prepare.bind(credential);

                t.mock.method(credential, "prepare", async () => {
                    const lease = await prepare();

                    directories.push(dirname(lease.env.SSH_ASKPASS!));
                    prepared.resolve();
                    await release.promise;

                    return lease;
                });
            }

            return credential;
        },
    );

    try {
        const granted = f.collaborator({ projectIds: [f.projectId] });
        const before = await f.calls();
        const effect = join(f.ssh.root, "must-not-dispatch");
        const operation = f.app.sshSessions.withWorkspace(f.id, granted, context, async (backend) =>
            getOrThrow(await backend.exec(["touch", effect], {}, {}, true)),
        );

        pending = operation.then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
        );
        await prepared.promise;
        f.app.setAccess(owner(f.app), granted.id, { projectAccess: {} });
        release.resolve();
        const result = await pending;

        assert.ok("error" in result, "revoked authority cannot return a command result");
        assert.equal(await f.calls(), before, "no SSH process starts after revocation");
        assert.equal(existsSync(effect), false, "the command produces no filesystem effect");

        for (const directory of directories) {
            assert.equal(existsSync(directory), false, "the prepared password IPC is removed");
        }
    } finally {
        release.resolve();
        await pending;
        t.mock.restoreAll();
        await f.close();
    }
});

// Ordinary Chat commands deliberately use no native sandbox. Authentication succeeds before the
// real disposable shell publishes its gate, then authority changes before any stdout or result.
for (const { route, changed, streaming } of [
    { route: "backend", changed: "forget", streaming: true },
    { route: "backend", changed: "rotation", streaming: true },
    { route: "cached environment", changed: "forget", streaming: true },
    { route: "cached environment", changed: "rotation", streaming: true },
    { route: "backend", changed: "forget", streaming: false },
    { route: "cached environment", changed: "rotation", streaming: false },
] as const) {
    test(`${route} ${streaming ? "command output and result are" : "silent command result is"} fenced after delegated owner ${changed}`, async () => {
        const f = await setup(true);
        const hold = join(f.ssh.root, "hold-delegated-command");
        const ready = join(f.ssh.root, "delegated-command-ready");
        let pending: Promise<{ value: unknown } | { error: unknown }> | undefined;

        try {
            const granted = f.collaborator({ projectIds: [f.projectId] });
            const before = (await f.calls()).trim().split("\n").length;
            const command = [
                "sh",
                "-c",
                'printf selected > "$1"; while [ -f "$2" ]; do sleep 0.01; done; ' +
                    (streaming ? 'printf "protected command bytes"' : ":"),
                "fixture",
                ready,
                hold,
            ];
            let output = "";
            const options = {
                onOutput: (text: string) => {
                    output += text;
                },
            };

            await writeFile(hold, "wait after authentication");
            const operation =
                route === "backend"
                    ? f.app.sshSessions.withWorkspace(f.id, granted, context, async (backend) =>
                          getOrThrow(await backend.exec(command, options, {}, true)),
                      )
                    : f.app.envFor(f.id, granted).exec(command, options, context).then(getOrThrow);

            pending = operation.then(
                (value) => ({ value }),
                (error: unknown) => ({ error }),
            );
            await until(
                () => existsSync(ready),
                "authenticated command reaches its real shell gate",
            );

            if (changed === "forget") {
                f.app.sshSessions.forget(owner(f.app), host);
            } else {
                f.app.config.rotateOwnerToken();
            }

            await rm(hold);
            const result = await pending;

            assert.ok(
                "error" in result,
                "an already-selected command cannot return after delegated owner authority changes",
            );
            assert.match(String(result.error), /login changed|access changed/);
            assert.equal(
                output,
                "",
                "stdout produced after revocation must not reach the caller either",
            );
            assert.equal(
                (await f.calls()).trim().split("\n").length - before,
                1,
                "failed command authority cannot reconnect with a different password or key",
            );
        } finally {
            await rm(hold, { force: true });
            await pending;
            await f.close();
        }
    });
}

test("same-token project revocation fences an in-flight SFTP result and stale cached environments", async () => {
    const f = await setup(true);

    try {
        const granted = f.collaborator({ projectIds: [f.projectId] });
        const token = granted.tokenHash;
        const env = f.app.envFor(f.id, granted);

        assert.equal(
            getOrThrow(await env.readTextFile("workspace.txt", context)),
            "approved project bytes",
        );
        await writeFile(join(f.ssh.root, "hold-sftp-5"), "hold read response");
        const pending = f.read(granted).then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
        );

        await until(
            () => existsSync(join(f.ssh.root, "sftp-5-ready")),
            "read reaches the SFTP gate",
        );
        f.app.config.updateUser(granted.id, { projectAccess: {} });
        assert.equal(f.app.config.userById(granted.id)!.tokenHash, token);
        await rm(join(f.ssh.root, "hold-sftp-5"));
        const result = await pending;

        assert.ok(
            "error" in result,
            "revoked bytes cannot escape the service after the awaited read",
        );
        assert.match(String(result.error), /not shared|access changed|authority changed/);
        const before = await f.calls();
        const stale = await env.readTextFile("workspace.txt", context);

        assert.equal(stale.ok, false);
        await assert.rejects(f.read(f.app.config.userById(granted.id)!), /not shared/);
        assert.equal(
            await f.calls(),
            before,
            "revoked cached and fresh requests start no replacement transport",
        );
    } finally {
        await f.close();
    }
});

test("grant edits invalidate old authority even when visibility remains, including nested grant arrays and remote resources", async () => {
    const f = await setup(true);

    try {
        const granted = f.collaborator({ all: true, projectIds: [f.projectId] });
        const env = f.app.envFor(f.id, granted);
        const held = f.app.sshSessions.backend(f.id, granted, context);

        assert.equal(
            getOrThrow(await env.readTextFile("workspace.txt", context)),
            "approved project bytes",
        );
        assert.ok(
            !(await f.app.workspace.fileList(f.id, granted, context)).files.includes(
                "new-name.txt",
            ),
        );
        await writeFile(join(f.ssh.root, "new-name.txt"), "new filename after the cache entry");
        // Config owns the live user object. Mutating a nested selector must not also mutate
        // the immutable authority captured by an already issued workspace capability.
        granted.projectAccess!.projectIds!.push("another-owner-approved-project");
        assert.equal(f.app.canSee(granted, f.id), true);
        const before = await f.calls();
        const stale = await env.readTextFile("workspace.txt", context);

        assert.equal(stale.ok, false);
        await assert.rejects(held.readBytes("workspace.txt", 100), /authority changed/);
        assert.equal(await f.calls(), before);
        assert.equal(
            await f.read(granted),
            "approved project bytes",
            "a fresh capability adopts current grants",
        );
        assert.ok(
            (await f.app.workspace.fileList(f.id, granted, context)).files.includes("new-name.txt"),
            "new grant authority cannot reuse the prior authority's names cache",
        );

        await mkdir(join(f.ssh.root, ".pi", "skills", "remote"), { recursive: true });
        await writeFile(
            join(f.ssh.root, ".pi", "skills", "remote", "SKILL.md"),
            "---\nname: approved-skill\ndescription: owner trusted remote skill\n---\nRemote project skill bytes\n",
        );
        await f.app.sshSessions.setProjectTrust(f.id, owner(f.app), "trust");
        const resources = await f.app.sshSessions.projectResources(f.id, granted, context);

        assert.equal(
            resources.skills
                .find((skill) => skill.name === "approved-skill")
                ?.content.includes("Remote project skill bytes"),
            true,
        );
        f.app.config.updateUser(granted.id, { projectAccess: {} });
        await assert.rejects(
            f.app.sshSessions.projectResources(f.id, granted, context),
            /not shared|access changed|authority changed/,
        );
    } finally {
        await f.close();
    }
});

test("remote HEAD observations cannot be borrowed across a same-token project authority edit", async () => {
    const f = await setup();
    const heads = new DestinationHeads(f.app);

    try {
        execFileSync("git", ["init", "--quiet", "--initial-branch=before-grant", f.ssh.root]);
        const granted = f.collaborator({ all: true, projectIds: [f.projectId] });
        const staleIdentity = structuredClone(granted);

        assert.equal(heads.get(f.id, granted), undefined);
        await until(
            () =>
                JSON.stringify(heads.peek(f.id, granted)) ===
                JSON.stringify({ branch: "before-grant" }),
            "the actual target HEAD reaches the cache",
        );
        granted.projectAccess!.projectIds!.push("additional-owner-approved-project");
        assert.equal(
            heads.peek(f.id, granted),
            undefined,
            "changed grants have no old cached observation",
        );
        execFileSync("git", ["-C", f.ssh.root, "symbolic-ref", "HEAD", "refs/heads/after-grant"]);
        heads.get(f.id, granted);
        await until(
            () =>
                JSON.stringify(heads.peek(f.id, granted)) ===
                JSON.stringify({ branch: "after-grant" }),
            "the fresh authority observes a new target HEAD",
        );
        assert.equal(
            heads.peek(f.id, staleIdentity),
            undefined,
            "the old authority cannot borrow the current authority's result",
        );
        f.app.config.updateUser(granted.id, { projectAccess: {} });
        assert.equal(heads.peek(f.id, granted), undefined);
    } finally {
        await heads.close();
        await f.close();
    }
});

for (const remote of [false, true]) {
    test(`${remote ? "SSH" : "local"} project file APIs and Changes stay inside the pinned folder, not its enclosing repository`, async () => {
        const f = await setup();

        try {
            const cwd = join(f.ssh.root, "approved");
            const outside = join(f.ssh.root, "outside.txt");

            await mkdir(cwd);
            await writeFile(join(cwd, "inside.txt"), "inside bytes");
            await writeFile(outside, "outside private bytes");
            await symlink(outside, join(cwd, "escape.txt"));
            execFileSync("git", ["init", "--quiet", f.ssh.root]);
            execFileSync("git", [
                "-C",
                f.ssh.root,
                "add",
                "--",
                "approved/inside.txt",
                "outside.txt",
            ]);
            const { id: projectId } = await f.app.projects.create(owner(f.app), {
                name: "Narrow approved folder",
                cwd,
                ...(remote ? { location: { kind: "ssh" as const, host } } : {}),
                requestId: crypto.randomUUID(),
            });
            const { id } = await f.app.commands.createSession(owner(f.app), {
                projectId,
                threadType: "chat",
            });
            const granted = f.collaborator({ projectIds: [projectId] });
            const viewed = await f.app.workspace.viewFile(id, granted, "inside.txt", context);

            assert.equal(viewed.kind, "text");

            if (viewed.kind !== "text") {
                throw new Error("Expected the actual project text preview");
            }

            assert.equal(viewed.text, "inside bytes");
            assert.equal(viewed.editable, true);
            assert.ok(
                viewed.revision,
                "native remote and local previews both publish their opened revision",
            );
            await f.app.workspace.saveFile(
                id,
                granted,
                "inside.txt",
                "allowed save",
                viewed.revision,
            );
            assert.equal(await readFile(join(cwd, "inside.txt"), "utf8"), "allowed save");

            for (const path of ["../outside.txt", outside, "escape.txt"]) {
                await assert.rejects(
                    f.app.workspace.viewFile(id, granted, path, context),
                    /not found|not there/i,
                );
                await assert.rejects(
                    f.app.workspace.saveFile(
                        id,
                        granted,
                        path,
                        "must not escape",
                        createHash("sha256").update("outside private bytes").digest("hex"),
                    ),
                    /not found/i,
                );
            }

            assert.equal(await readFile(outside, "utf8"), "outside private bytes");
            const changes = await f.app.workspace.changes(id, granted, context);

            assert.ok(changes.files.some((file) => file.path === "approved/inside.txt"));
            assert.ok(
                changes.files.every((file) => file.path.startsWith("approved/")),
                "enclosing-repository files never enter the granted Changes result",
            );
            await assert.rejects(
                f.app.workspace.changeDiff(id, granted, "outside.txt", context),
                /no uncommitted changes in this folder/,
            );
            await assert.rejects(
                f.app.workspace.revertChange(id, granted, "outside.txt"),
                /no uncommitted changes/,
            );
            assert.equal(await readFile(outside, "utf8"), "outside private bytes");
            assert.throws(
                () => f.app.workspace.makeFolder(granted, join(f.ssh.root, "arbitrary")),
                forbidden,
            );
            await assert.rejects(
                f.app.workspace.switchBranch(id, granted, { name: "other" }),
                forbidden,
            );
        } finally {
            await f.close();
        }
    });
}
