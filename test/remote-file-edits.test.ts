// Run the fixed native Python protocol against disposable files. This proves descriptor/content and
// two-phase lifecycle behavior, not SSH cryptography or the unavailable nested seatbelt boundary.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
    mkdtemp,
    realpath,
    rm,
    writeFile,
    readFile,
    readdir,
    chmod,
    stat,
    symlink,
    link,
    unlink,
    mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, after } from "node:test";
import { existsSync } from "node:fs";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { WorkspaceBackend } from "../src/server/workspace-backend.ts";
import {
    inspectRemoteFileEdit,
    saveRemoteFileEdit,
    RemoteEditCapabilityError,
} from "../src/server/remote-file-edits.ts";
import { textRevision, MAX_EDIT_BYTES } from "../src/server/file-edits.ts";
import { cleanUp, openApp, owner, scriptedModel, root, until } from "./helpers.ts";
import { sshFixture } from "./ssh-fixture.ts";
import { WorkflowDoc } from "../src/server/workflow-docs.ts";
import { HttpError } from "../src/server/errors.ts";

after(cleanUp);

async function fixture() {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "coop-native-edit-")));
    const env = new NodeExecutionEnv({ cwd: directory });
    // A local process running the same fixed script is explicitly permitted for this test fixture.
    const backend = new WorkspaceBackend(env, { remote: true, context });
    const file = join(directory, "notes ' 雪 ; $literal.txt");
    const bytes = Buffer.from("\uFEFFfirst\r\nlast without newline");

    await writeFile(file, bytes, { mode: 0o640 });

    return {
        directory,
        file,
        bytes,
        backend,
        authorization: { backend, root: directory, file, offline: false },
        async close() {
            await env.cleanup(context);
            await rm(directory, { recursive: true, force: true });
        },
    };
}

async function nativeBarrier(directory: string, phase: string, forbiddenArgv = "") {
    const hold = join(directory, "hold-native-response");
    const ready = join(directory, "native-response-ready");

    await writeFile(
        join(directory, "bin", "python3"),
        `#!${process.execPath}
import {spawnSync} from 'node:child_process';
import {existsSync,writeFileSync} from 'node:fs';
const args=process.argv.slice(2);
if (${JSON.stringify(forbiddenArgv !== "")} && JSON.stringify(args).includes(${JSON.stringify(forbiddenArgv)})) { throw new Error('content leaked into argv'); }
const result=spawnSync('/usr/bin/python3',args,{encoding:'utf8',maxBuffer:2*1024*1024});
if (args[3] === ${JSON.stringify(phase)} && existsSync(${JSON.stringify(hold)})) {
    writeFileSync(${JSON.stringify(ready)},'prepared');
    while (existsSync(${JSON.stringify(hold)})) { await new Promise(resolve=>setTimeout(resolve,10)); }
}
process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
process.exitCode=result.status ?? 1;
`,
        { mode: 0o755 },
    );

    return { hold, ready };
}

// New risk: bytes, revision and stat checks must survive a native process boundary; old local JS
// file-edits tests do not exercise this protocol or decimal nanosecond stat serialization.
test("native snapshots return coherent bytes/revision; two-phase saves preserve mode/owner/BOM/newlines", async () => {
    const f = await fixture();

    try {
        const before = await stat(f.file);
        const snapshot = await inspectRemoteFileEdit(f.authorization);

        assert.deepEqual(snapshot.bytes, f.bytes);
        assert.equal(snapshot.revision, textRevision(f.bytes));
        const bytes = Buffer.from("\uFEFFchanged 🦊\r\nno final newline");
        const result = await saveRemoteFileEdit(
            { bytes, revision: snapshot.revision },
            async () => f.authorization,
        );
        const after = await stat(f.file);

        assert.equal(result.revision, textRevision(bytes));
        assert.deepEqual(await readFile(f.file), bytes);
        assert.equal(after.mode, before.mode);
        assert.equal(after.uid, before.uid);
        assert.equal(after.gid, before.gid);
        assert.notEqual(after.ino, before.ino, "the target was replaced, not overwritten in place");
        assert.deepEqual(await readdir(f.directory), [f.backend.paths.basename(f.file)]);
        const next = await inspectRemoteFileEdit(f.authorization);

        assert.deepEqual(next.bytes, bytes);
        assert.equal(next.revision, result.revision);
    } finally {
        await f.close();
    }
});

test("canonical aliases share the entire queue and stale concurrent saves have exactly one winner", async () => {
    const f = await fixture();

    try {
        const alias = join(f.directory, "alias.txt");

        await symlink(f.file, alias);
        const attempts = [Buffer.from("first"), Buffer.from("second")];
        const results = await Promise.allSettled(
            attempts.map((bytes, index) =>
                saveRemoteFileEdit({ bytes, revision: textRevision(f.bytes) }, async () => ({
                    ...f.authorization,
                    file: await f.backend.canonical(index === 0 ? f.file : alias),
                })),
            ),
        );
        const winner = results.findIndex((result) => result.status === "fulfilled");

        assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
        assert.equal(results.filter((result) => result.status === "rejected").length, 1);
        assert.deepEqual(await readFile(f.file), attempts[winner]);
        assert.deepEqual(await readFile(alias), attempts[winner]);
        assert.deepEqual(
            (await readdir(f.directory)).sort(),
            ["alias.txt", f.backend.paths.basename(f.file)].sort(),
        );
    } finally {
        await f.close();
    }
});

// The callback is the production post-prepare live-authority seam, not a test-only scheduling hook.
test("post-prepare authority denial prevents commit, cleans its own temp and releases the queue", async () => {
    const f = await fixture();
    let calls = 0;

    try {
        await assert.rejects(
            saveRemoteFileEdit(
                { bytes: Buffer.from("denied"), revision: textRevision(f.bytes) },
                async () => {
                    if (++calls === 3) {
                        throw new Error("driver revoked after native staging");
                    }

                    return f.authorization;
                },
            ),
            /driver revoked/,
        );
        assert.deepEqual(await readFile(f.file), f.bytes);
        assert.deepEqual(await readdir(f.directory), [f.backend.paths.basename(f.file)]);
        await saveRemoteFileEdit(
            { bytes: Buffer.from("allowed"), revision: textRevision(f.bytes) },
            async () => f.authorization,
        );
        assert.equal(await readFile(f.file, "utf8"), "allowed");
    } finally {
        await f.close();
    }
});

test("finalize detects changed original bytes/full stat and never deletes a swapped temporary inode", async () => {
    for (const mutation of ["original", "mode", "temp"]) {
        const f = await fixture();
        let calls = 0;
        let swapped: string | undefined;

        try {
            await assert.rejects(
                saveRemoteFileEdit(
                    { bytes: Buffer.from("replacement"), revision: textRevision(f.bytes) },
                    async () => {
                        if (++calls === 3) {
                            if (mutation === "original") {
                                await writeFile(f.file, "external edit");
                            }

                            if (mutation === "mode") {
                                await chmod(f.file, 0o600);
                            }

                            if (mutation === "temp") {
                                const name = (await readdir(f.directory)).find((name) =>
                                    name.startsWith(".pi-edit-"),
                                )!;

                                swapped = join(f.directory, name);
                                await unlink(swapped);
                                await writeFile(swapped, "unrelated swapped inode");
                            }
                        }

                        return f.authorization;
                    },
                ),
                /changed|safely|Native file/,
            );
            assert.deepEqual(
                await readFile(f.file),
                mutation === "original" ? Buffer.from("external edit") : f.bytes,
            );

            if (swapped !== undefined) {
                assert.equal(await readFile(swapped, "utf8"), "unrelated swapped inode");
            }

            if (mutation === "mode") {
                assert.equal((await stat(f.file)).mode & 0o777, 0o600);
            }
        } finally {
            await f.close();
        }
    }
});

test("native inspection rejects root escapes, hardlinks, invalid UTF-8/NUL and oversize; exact cap remains readable", async () => {
    const f = await fixture();

    try {
        for (const bytes of [
            Buffer.from([0xff]),
            Buffer.from([97, 0, 98]),
            Buffer.alloc(MAX_EDIT_BYTES + 1, 97),
        ]) {
            await writeFile(f.file, bytes);
            await assert.rejects(inspectRemoteFileEdit(f.authorization), /safely|UTF-8/);
        }

        await writeFile(f.file, Buffer.alloc(MAX_EDIT_BYTES, 97));
        const boundary = await inspectRemoteFileEdit(f.authorization);

        assert.equal(boundary.bytes.length, MAX_EDIT_BYTES);
        assert.equal(boundary.revision, textRevision(boundary.bytes));
        await link(f.file, join(f.directory, "hardlink"));
        await assert.rejects(inspectRemoteFileEdit(f.authorization), /safely/);
        await unlink(join(f.directory, "hardlink"));
        const child = join(f.directory, "scope");

        await mkdir(child);
        await symlink(f.file, join(child, "escape"));
        await assert.rejects(
            inspectRemoteFileEdit({ ...f.authorization, root: child, file: join(child, "escape") }),
            /SSH file|authority changed/,
        );
        await assert.rejects(inspectRemoteFileEdit({ ...f.authorization, file: child }), /safely/);
    } finally {
        await f.close();
    }
});

test("missing native confinement fails specifically before staging and never falls back to an unrestricted process", async () => {
    const f = await fixture();

    try {
        await assert.rejects(
            saveRemoteFileEdit(
                { bytes: Buffer.from("must not write"), revision: textRevision(f.bytes) },
                async () => ({ ...f.authorization, offline: true }),
            ),
            RemoteEditCapabilityError,
        );
        assert.deepEqual(await readFile(f.file), f.bytes);
        assert.deepEqual(await readdir(f.directory), [f.backend.paths.basename(f.file)]);
    } finally {
        await f.close();
    }
});

// This owner-boundary proof uses real app state and the disposable SSH protocol executable.
// No native sandbox is claimed: an ordinary Chat target runs the fixed Python operation.
test("Workspace SSH quick save and native review context preserve snapshots, scope, live readers and read-only state", async () => {
    const ssh = await sshFixture();
    const app = await openApp(scriptedModel(), join(root, "native-remote-edit-app"));
    const previousGitConfig = process.env.GIT_CONFIG_GLOBAL;

    process.env.GIT_CONFIG_GLOBAL = "/dev/null";

    try {
        const cwd = await realpath(ssh.root);
        const file = join(cwd, "visible.txt");

        await writeFile(file, "original\r\n");
        await writeFile(join(cwd, "unchanged.txt"), "stable baseline");
        await mkdir(join(cwd, "scope"));
        await writeFile(join(cwd, "scope", "inside.txt"), "inside baseline");
        const git = (...args: string[]) =>
            execFileSync("git", args, {
                cwd,
                env: { ...process.env, GIT_CONFIG_SYSTEM: "/dev/null" },
                stdio: "pipe",
            });

        git("init", "-q", "--initial-branch=main");
        git("config", "user.name", "Fixture");
        git("config", "user.email", "fixture@example.invalid");
        git("add", "--", "visible.txt", "unchanged.txt", "scope/inside.txt");
        git("commit", "-qm", "review baseline");
        const { id } = await app.commands.createSession(owner(app), {
            cwd,
            location: { kind: "ssh", host: "fixture-host" },
            threadType: "chat",
        });
        const me = owner(app);
        const beforeView = (await readFile(join(ssh.root, "calls"), "utf8"))
            .trim()
            .split("\n").length;
        const beforePackets = (await readFile(join(ssh.root, "packets"), "utf8")).length;
        const view = await app.workspace.viewFile(id, me, "visible.txt");
        const viewPackets = (await readFile(join(ssh.root, "packets"), "utf8"))
            .slice(beforePackets)
            .trim()
            .split("\n");

        assert.equal(
            viewPackets.includes("5"),
            false,
            "native editable snapshots must not download the same bytes over SFTP first",
        );
        const afterView = (await readFile(join(ssh.root, "calls"), "utf8"))
            .trim()
            .split("\n").length;

        assert.ok(view.kind === "text" && view.editable && view.revision);
        assert.ok(
            afterView - beforeView <= 2,
            `opening one editable file used ${afterView - beforeView} SSH sessions; expected one SFTP and one native inspection`,
        );
        assert.equal(view.revision, textRevision(Buffer.from(view.text)));
        const saved = await app.workspace.saveFile(
            id,
            me,
            "visible.txt",
            "saved\r\n",
            view.revision,
        );

        assert.equal(saved.revision, textRevision(Buffer.from("saved\r\n")));
        assert.equal(await readFile(file, "utf8"), "saved\r\n");
        assert.ok(
            (await app.transcripts.history(id, Number.MAX_SAFE_INTEGER)).some(
                (entry) => entry.kind === "note" && entry.text === "edited visible.txt",
            ),
        );
        const outside = join(root, "native-remote-outside.txt");
        const scoped = app.config.addUser("Remote scoped editor", "guest", [String(id)]).user;

        await writeFile(outside, "outside scope");
        await assert.rejects(app.workspace.viewFile(id, scoped, outside), /File not found/);
        await assert.rejects(
            app.workspace.saveFile(
                id,
                scoped,
                outside,
                "denied",
                textRevision(Buffer.from("outside scope")),
            ),
            /File not found/,
        );
        assert.equal(await readFile(outside, "utf8"), "outside scope");

        // Hidden context uses the same native descriptor snapshot, but only for a currently changed
        // path in this thread's review folder. Ordinary readers do not need steering permission.
        const viewer = app.config.addUser("Native review reader", "viewer", [String(id)]).user;

        assert.deepEqual(await app.reviews.context(id, viewer, "visible.txt"), {
            text: "saved\r\n",
        });
        await assert.rejects(
            app.reviews.context(id, viewer, "unchanged.txt"),
            /no uncommitted changes/,
        );
        await assert.rejects(
            app.reviews.context(id, viewer, "../outside.txt"),
            /without traversal/,
        );
        await symlink(file, join(cwd, "alias.txt"));
        await symlink(outside, join(cwd, "escape.txt"));
        await assert.rejects(app.reviews.context(id, viewer, "alias.txt"), /regular file inside/);
        await assert.rejects(app.reviews.context(id, viewer, "escape.txt"), /regular file inside/);
        git("add", "--", "visible.txt");
        git("commit", "-qm", "accept current text");
        await assert.rejects(
            app.reviews.context(id, viewer, "visible.txt"),
            /no uncommitted changes/,
        );
        await writeFile(file, "\uFEFFnative current 🦊\r\n");
        assert.deepEqual(await app.reviews.context(id, viewer, "visible.txt"), {
            text: "\uFEFFnative current 🦊\r\n",
        });
        await writeFile(join(cwd, "scope", "inside.txt"), "inside changed\r\n");
        const narrow = await app.commands.createSession(me, {
            cwd: join(cwd, "scope"),
            location: { kind: "ssh", host: "fixture-host" },
            threadType: "chat",
        });
        const narrowReader = app.config.addUser("Narrow review reader", "viewer", [
            String(narrow.id),
        ]).user;

        assert.deepEqual(await app.reviews.context(narrow.id, narrowReader, "scope/inside.txt"), {
            text: "inside changed\r\n",
        });
        await assert.rejects(
            app.reviews.context(narrow.id, narrowReader, "visible.txt"),
            /no uncommitted changes/,
        );
        const { hold, ready } = await nativeBarrier(ssh.root, "inspect");

        await writeFile(hold, "wait");
        const read = app.reviews.context(id, viewer, "visible.txt");
        const revoked = assert.rejects(read, /not shared with you|SSH requester's access changed/);

        await until(() => existsSync(ready), "real native context snapshot is read");
        app.setAccess(me, viewer.id, { role: "viewer", sessions: [String(narrow.id)] });
        await unlink(hold);
        await revoked;
        await app.harness.commit(async (tx) => {
            (await tx.doc(WorkflowDoc, id)).readOnly = true;
        }, context);
        const readonly = await app.workspace.viewFile(id, me, "visible.txt");

        assert.ok(readonly.kind === "text" && readonly.editable === false);
        assert.match(readonly.editUnavailable!, /read-only/);
        await assert.rejects(
            app.workspace.saveFile(id, me, "visible.txt", "denied", saved.revision),
            /read-only/,
        );
        // List has no filesystem backend to catch stale credentials: the shared Reviews caller
        // guard must reject the original token itself, even though the owner still exists/sees it.
        const staleOwner = { ...owner(app) };

        app.config.rotateOwnerToken();
        await assert.rejects(
            app.reviews.list(id, staleOwner),
            (error: unknown) => error instanceof HttpError && error.status === 401,
        );
    } finally {
        await rm(join(ssh.root, "hold-native-response"), { force: true });
        await app.close();
        await ssh.env.cleanup(context);
        await ssh.close();

        if (previousGitConfig === undefined) {
            delete process.env.GIT_CONFIG_GLOBAL;
        } else {
            process.env.GIT_CONFIG_GLOBAL = previousGitConfig;
        }
    }
});

// Keep access to the same thread while narrowing filesystem authority. Visibility alone cannot
// authorize bytes opened outside the thread's folder before an asynchronous response completes.
test("Workspace discards an in-flight SSH file read when the same token gains a session scope", async () => {
    const ssh = await sshFixture();
    const { hold, ready } = await nativeBarrier(ssh.root, "inspect");
    const app = await openApp(scriptedModel(), join(root, "native-read-scope-app"));

    try {
        const folder = join(await realpath(ssh.root), "thread-folder");
        const outside = join(await realpath(ssh.root), "outside-thread.txt");

        await mkdir(folder);
        await writeFile(outside, "outside-thread secret");
        const me = owner(app);
        const { id } = await app.commands.createSession(me, {
            cwd: folder,
            location: { kind: "ssh", host: "fixture-host" },
            threadType: "chat",
        });
        const guest = app.config.addUser("Initially unrestricted reader", "guest").user;
        const tokenHash = guest.tokenHash;
        const cachedEnv = app.envFor(id, guest);

        await writeFile(hold, "wait");
        const result = app.workspace.viewFile(id, guest, outside);
        const denied = assert.rejects(result, /access changed|authority changed|scope changed/i);

        await until(() => existsSync(ready), "real native file snapshot is read");
        app.setAccess(me, guest.id, { role: "guest", sessions: [String(id)] });
        assert.equal(guest.tokenHash, tokenHash);
        assert.equal(app.canSee(guest, id), true, "thread visibility was not revoked");
        await unlink(hold);
        await denied;
        await assert.rejects(app.workspace.viewFile(id, guest, outside), /File not found/);
        await writeFile(join(folder, "inside.txt"), "still authorized");
        const expiredRead = await cachedEnv.readTextFile(outside, context);

        assert.equal(expiredRead.ok, false, "an old cached environment cannot regain old scope");
        const freshEnv = app.envFor(id, guest);

        assert.notEqual(freshEnv, cachedEnv, "fresh requests use a scope-specific environment");
        assert.deepEqual(await freshEnv.readTextFile(join(folder, "inside.txt"), context), {
            ok: true,
            value: "still authorized",
        });
        const inside = await app.workspace.viewFile(id, guest, "inside.txt");

        assert.ok(inside.kind === "text");
        assert.equal(inside.text, "still authorized", "fresh reads use the new scope");
    } finally {
        await rm(hold, { force: true });
        await app.close();
        await ssh.env.cleanup(context);
        await ssh.close();
    }
});

// Hold the actual native prepare response, rather than mocking the policy callback or synthesizing a
// receipt. Driver revocation happens after the real adjacent temp is fsynced and before host finalize.
test("Workspace rechecks the actual driver after asynchronous native staging, before committing", async () => {
    const ssh = await sshFixture();
    const replacement = "unique-replacement-content-not-in-argv-雪";

    const { hold, ready } = await nativeBarrier(ssh.root, "prepare", replacement);
    const app = await openApp(scriptedModel(), join(root, "native-driver-recheck-app"));

    try {
        const cwd = await realpath(ssh.root);
        const file = join(cwd, "driver.txt");

        await writeFile(file, "original");
        const { id } = await app.commands.createSession(owner(app), {
            cwd,
            location: { kind: "ssh", host: "fixture-host" },
            threadType: "chat",
        });
        const guest = app.config.addUser("Actual remote saver", "guest").user;
        const view = await app.workspace.viewFile(id, guest, "driver.txt");

        assert.ok(view.kind === "text" && view.editable && view.revision);
        await writeFile(hold, "wait");
        const operation = app.workspace.saveFile(
            id,
            guest,
            "driver.txt",
            replacement,
            view.revision,
        );
        const denied = assert.rejects(operation, /driving/);

        await until(() => existsSync(ready), "real native preparation completes");
        await app.collab.turns(id, owner(app), { action: "on" });
        await unlink(hold);
        await denied;
        assert.equal(await readFile(file, "utf8"), "original");
        assert.equal(
            (await readdir(cwd)).some((name) => name.startsWith(".pi-edit-")),
            false,
        );
    } finally {
        await rm(hold, { force: true });
        await app.close();
        await ssh.env.cleanup(context);
        await ssh.close();
    }
});
