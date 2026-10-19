// Destination routing, byte transport and workflow orchestration with disposable process/protocol peers.
// The injected confined runner exercises dispatch only: it is NOT evidence of native seatbelt enforcement.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
    chmod,
    lstat,
    mkdir,
    readFile,
    realpath,
    rm,
    stat,
    symlink,
    writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { mock, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import type { PocketApp } from "../src/server/app.ts";
import type { User } from "../src/server/config.ts";
import { branchesIn, switchBranch } from "../src/server/branches.ts";
import { changesIn, diffOf } from "../src/server/changes.ts";
import { git, gitBytes } from "../src/server/git.ts";
import { WorkspaceBackend } from "../src/server/workspace-backend.ts";
import {
    userWorkspaceBackend,
    workflowWorkspaceBackend,
} from "../src/server/workspace-backend-factory.ts";
import {
    createWorktree,
    inWorktreeAt,
    removeWorktree,
    sourceFolder,
    worktreeStorage,
} from "../src/server/worktrees.ts";
import { withWorkflowPublicationLock } from "../src/server/workflow-policy.ts";
import { sshFixture } from "./ssh-fixture.ts";
import { SshExecutionEnv } from "../src/server/ssh-env.ts";
import { SshSessions } from "../src/server/ssh-sessions.ts";
import { cleanUp, openApp, owner, scriptedModel } from "./helpers.ts";

async function repository(t: { after(fn: () => Promise<void>): void }) {
    const f = await sshFixture();

    t.after(() => f.close());
    const folder = join(f.root, "project '雪");

    await mkdir(join(folder, "src"), { recursive: true });
    const root = await realpath(folder);
    const configuration = {
        GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
        GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
        GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM,
    };

    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    process.env.GIT_CONFIG_SYSTEM = "/dev/null";
    t.after(async () => {
        for (const [key, value] of Object.entries(configuration)) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    });
    const command = (...argv: string[]) =>
        execFileSync("git", argv, { cwd: root, encoding: "buffer" });

    command("init", "-q", "--initial-branch=main");
    command("config", "user.name", "Fixture");
    command("config", "user.email", "fixture@example.invalid");
    await writeFile(join(root, "src/keep.txt"), "original\n");
    await writeFile(join(root, "outside.txt"), "outside\n");
    await writeFile(join(root, "binary.bin"), Buffer.from([0, 255, 128, 13, 10]));
    command("add", "--all");
    command("commit", "-qm", "fixture seed");
    f.env.cwd = root;
    const confined: boolean[] = [];
    const execution = f.env.exec.bind(f.env);
    const backend = new WorkspaceBackend(f.env, {
        remote: true,
        inspection: f.env,
        confinedExec: async (argv, options, context, readOnly) => {
            confined.push(readOnly);

            return execution(argv, options, context);
        },
    });

    return { ...f, root, command, backend, confined };
}

test("remote Git preserves binary stdout and rejects lossy text decoding, output overflow and shell injection", async (t) => {
    const f = await repository(t);
    const options = { backend: f.backend, offline: true };

    assert.deepEqual(
        await gitBytes(f.root, ["show", "HEAD:binary.bin"], options),
        Buffer.from([0, 255, 128, 13, 10]),
    );
    const weirdName = "notes ; $(touch escaped) '雪\n.txt";

    await writeFile(join(f.root, weirdName), "literal filename\n");
    const listed = await git(f.root, ["ls-files", "--others", "--exclude-standard", "-z"], options);

    assert.equal(listed, weirdName + "\0");
    await assert.rejects(
        git(f.root, ["check-ref-format", "--branch", "$(touch escaped)"], options),
    );
    await assert.rejects(stat(join(f.root, "escaped")), { code: "ENOENT" });
    await assert.rejects(
        gitBytes(f.root, ["show", "HEAD:src/keep.txt"], { ...options, maxBuffer: 2 }),
        /limit/,
    );
    await assert.rejects(git(f.root, ["not-a-real-operation"], options), /not a git command/);
    // macOS filesystems reject invalid-UTF-8 pathnames; a blob exercises the same byte/text boundary portably.
    await assert.rejects(git(f.root, ["show", "HEAD:binary.bin"], options), /Non-UTF-8/);
    assert.ok(f.confined.length > 0);
    assert.ok(f.confined.every(Boolean), "every inspection was dispatched read-only");
    const unsupported = new WorkspaceBackend(f.env, { remote: true, inspection: f.env });
    const callsBefore = await readFile(join(f.root, "../calls"), "utf8").catch(() => "");

    await assert.rejects(
        git(f.root, ["status"], { backend: unsupported, offline: true }),
        /confinement/,
    );
    assert.equal(
        await readFile(join(f.root, "../calls"), "utf8").catch(() => ""),
        callsBefore,
        "unavailable confinement must fail before transport",
    );
});

test("remote Changes propagates an uncertain transport failure without local fallback or automatic replay", async (t) => {
    const f = await repository(t);
    const env = new SshExecutionEnv({ host: "lost-host", cwd: f.root });
    const backend = new WorkspaceBackend(env);

    await assert.rejects(changesIn(f.root, [], false, { backend }), /outcome is unknown/);
    assert.equal(
        await readFile(join(f.root, "../effect"), "utf8"),
        "once",
        "a failed inspection must not replay the remote command",
    );
});

test("trusted Git environment applies on both destinations but cannot disable literal pathspec safety", async (t) => {
    const f = await repository(t);
    const configuration = join(f.root, "../isolated-gitconfig");

    await writeFile(configuration, "[fixture]\n    value = trusted-isolated-config\n");

    for (const backend of [WorkspaceBackend.local(f.root), f.backend]) {
        const options = {
            backend,
            offline: backend.remote,
            env: {
                GIT_CONFIG_GLOBAL: configuration,
                GIT_CONFIG_NOSYSTEM: "1",
                GIT_LITERAL_PATHSPECS: "0",
            },
        };

        assert.equal(
            await git(f.root, ["config", "--get", "fixture.value"], options),
            "trusted-isolated-config\n",
        );
        assert.equal(
            await git(f.root, ["ls-files", "--", "*.txt"], options),
            "",
            "trusted env cannot turn a literal path into a wildcard",
        );
    }
});

test("remote Changes, branches and worktrees share one destination, preserving scope, dirty bytes and executable files", async (t) => {
    const f = await repository(t);
    const cwd = join(f.root, "src");
    const backend = f.backend.at(cwd);
    const options = { backend, offline: true };

    await writeFile(join(cwd, "keep.txt"), "changed\n");
    await writeFile(join(f.root, "outside.txt"), "outside changed\n");
    await writeFile(join(cwd, "run '雪.sh"), "#!/bin/sh\necho fixture\n");
    await chmod(join(cwd, "run '雪.sh"), 0o751);
    const scoped = await changesIn(cwd, [], true, options);

    assert.deepEqual(
        scoped.files.map((file) => file.path),
        ["src/keep.txt", "src/run '雪.sh"],
    );
    assert.match(await diffOf(cwd, "src/keep.txt", true, options), /\+changed/);
    await assert.rejects(diffOf(cwd, "outside.txt", true, options), /no uncommitted changes/);
    assert.deepEqual((await branchesIn(cwd, options)).head, { branch: "main" });
    await switchBranch(cwd, { name: "fixture-next", create: true }, options);
    assert.deepEqual((await branchesIn(cwd, options)).head, { branch: "fixture-next" });
    const made = await createWorktree(
        cwd,
        join(f.root, "../remote-worktrees"),
        "Remote fixture",
        options,
    );

    assert.equal(made.worktree.destination, backend.id);
    assert.equal(made.cwd, join(made.worktree.path, "src"));
    assert.equal(await readFile(join(made.cwd, "keep.txt"), "utf8"), "changed\n");
    assert.equal(await readFile(join(made.cwd, "run '雪.sh"), "utf8"), "#!/bin/sh\necho fixture\n");
    assert.equal((await lstat(join(made.cwd, "run '雪.sh"))).mode & 0o777, 0o751);
    assert.equal(await inWorktreeAt(made.worktree, made.cwd, backend), true);
    const otherDestination = new WorkspaceBackend(
        new SshExecutionEnv({ host: "another-host", cwd }),
    );

    assert.equal(await inWorktreeAt(made.worktree, made.cwd, otherDestination), false);
    assert.equal(await sourceFolder(made.worktree, made.cwd, options), cwd);
    await mkdir(join(made.cwd, "new-only"));
    assert.equal(await sourceFolder(made.worktree, join(made.cwd, "new-only"), options), cwd);
    await assert.rejects(removeWorktree(made.worktree, false, options), /uncommitted changes/);
    await removeWorktree(made.worktree, true, options);
    await assert.rejects(stat(made.worktree.path), { code: "ENOENT" });
    assert.equal(
        await readFile(join(cwd, "keep.txt"), "utf8"),
        "changed\n",
        "removal cannot mutate source checkout",
    );
    assert.ok(
        f.confined.some((readOnly) => !readOnly),
        "worktree and branch writes use writable confined dispatch",
    );
});

test("real SSH-thread workspace and review services reuse destination Git with caller scopes and explicit safe-save limits", async (t) => {
    const f = await repository(t);
    const app = await openApp(scriptedModel());

    t.after(async () => {
        await app.close();
        cleanUp();
    });
    const cwd = join(f.root, "src");
    const { id } = await app.commands.createSession(owner(app), {
        cwd,
        threadType: "chat",
        location: { kind: "ssh", host: "fixture-host" },
    });

    // This fixture intentionally supports Git but not the separate native Python text capability.
    // Keep its refusal boundary explicit while the full Git+Python fixture owns successful context reads.
    await writeFile(
        join(f.root, "../bin/python3"),
        "#!/bin/sh\nprintf '%s\\n' 'Python3 is unavailable in this Git-only fixture' >&2\nexit 127\n",
        { mode: 0o755 },
    );
    const guest = app.config.addUser("Scoped remote guest", "guest", [String(id)]).user;
    const viewer = app.config.addUser("Scoped remote viewer", "viewer", [String(id)]).user;

    await writeFile(join(cwd, "keep.txt"), "remote changes\n");
    await writeFile(join(f.root, "outside.txt"), "not in scoped review\n");
    await mkdir(join(f.root, "outside-directory"));
    await writeFile(join(f.root, "outside-directory/private.txt"), "private\n");
    await symlink(join(f.root, "outside-directory"), join(cwd, "escape"));
    assert.deepEqual(await app.workspace.destinationHead(id, owner(app)), { branch: "main" });
    assert.deepEqual(
        (await app.workspace.changes(id, guest)).files.map((file) => file.path).sort(),
        ["src/escape", "src/keep.txt"],
    );
    const changes = await app.reviews.changes(id, viewer);

    assert.deepEqual(changes.files.map((file) => file.path).sort(), ["src/escape", "src/keep.txt"]);
    const calls = async (): Promise<string[][]> =>
        (await readFile(join(f.root, "../calls"), "utf8"))
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line));

    for (let index = 0; index < 6; index++) {
        await writeFile(join(cwd, `unrelated-${index}.txt`), "unrelated untracked content\n");
    }

    const beforeDiff = (await calls()).length;

    assert.match(await app.reviews.diff(id, viewer, "src/keep.txt"), /\+remote changes/);
    const diffCalls = (await calls()).slice(beforeDiff);
    const sftpCalls = diffCalls.filter((argv) => argv.at(-1) === "sftp");

    assert.ok(
        sftpCalls.length <= 1,
        `one review diff must share filesystem transport across fresh scope checks; opened ${sftpCalls.length} SFTP connections in ${diffCalls.length} SSH invocations`,
    );
    assert.ok(
        diffCalls.length <= 7,
        `one review diff must not count or version unrelated untracked files; used ${diffCalls.length} SSH invocations`,
    );
    await assert.rejects(app.reviews.diff(id, viewer, "outside.txt"), /no uncommitted changes/);
    await assert.rejects(app.reviews.diff(id, viewer, "src/escape/private.txt"), {
        status: 404,
    });
    const newFileDiff = await app.reviews.diff(id, viewer, "src/unrelated-0.txt");

    assert.match(newFileDiff, /\+unrelated untracked content/);
    assert.doesNotMatch(newFileDiff, /unrelated-1\.txt|remote changes/);
    const comment = await app.reviews.comment(id, viewer, {
        requestId: "remote-comment",
        path: "src/keep.txt",
        text: "Remote review anchor",
    });

    assert.ok(comment.id);
    await assert.rejects(
        app.reviews.comment(id, viewer, {
            requestId: "escape-comment",
            path: "src/escape/private.txt",
            text: "Must not escape",
        }),
        /inside this session folder/,
    );
    await assert.rejects(
        app.reviews.context(id, viewer, "src/keep.txt"),
        /Native SSH text editing is unavailable.*Python3/s,
    );
    const view = await app.workspace.viewFile(id, owner(app), "keep.txt");

    assert.equal(view.kind, "text");
    assert.equal(view.editable, false);
    await assert.rejects(
        app.workspace.saveFile(id, owner(app), "keep.txt", "not saved", "0".repeat(64)),
        /Native SSH text editing is unavailable.*Python3/s,
    );
    assert.equal(await readFile(join(cwd, "keep.txt"), "utf8"), "remote changes\n");
    const gitBytes = WorkspaceBackend.prototype.gitBytes;
    let changedCheckout = false;

    // A nested Git init changes checkout identity without changing the canonical cwd.
    // Race it after the real root read, regardless of which caller owns the backend lifetime.
    const raced = mock.method(
        WorkspaceBackend.prototype,
        "gitBytes",
        async function (
            this: WorkspaceBackend,
            ...[folder, argv, options]: Parameters<WorkspaceBackend["gitBytes"]>
        ) {
            const output = await gitBytes.call(this, folder, argv, options);

            if (!changedCheckout && argv[0] === "rev-parse" && argv[1] === "--show-toplevel") {
                changedCheckout = true;
                f.command("-C", cwd, "init", "-q", "--initial-branch=fixture-nested");
            }

            return output;
        },
    );

    try {
        await assert.rejects(app.reviews.diff(id, viewer, "src/keep.txt"), {
            status: 409,
            message: /session checkout changed/,
        });
        assert.ok(changedCheckout);
    } finally {
        raced.mock.restore();
        await rm(join(cwd, ".git"), { recursive: true, force: true });
    }
});

test("remote worktree storage is private, persists on its destination and refuses existing public folders or symlinks without chmod", async (t) => {
    const f = await repository(t);
    const options = { backend: f.backend, offline: true };
    const home = getOrThrow(await f.env.canonicalPath("~", BACKGROUND_CONTEXT));
    const storage = await worktreeStorage(f.backend, "/must-not-use-host-storage", options);

    assert.equal(storage, join(home, ".pi-coop-worktrees"));
    assert.equal((await stat(storage)).mode & 0o777, 0o700);
    assert.equal(await worktreeStorage(f.backend, "/must-not-use-host-storage", options), storage);
    await chmod(storage, 0o755);
    await assert.rejects(
        worktreeStorage(f.backend, "/must-not-use-host-storage", options),
        /private 0700/,
    );
    assert.equal(
        (await stat(storage)).mode & 0o777,
        0o755,
        "existing permissions must never be silently repaired",
    );
    await rm(storage, { recursive: true });
    await symlink(f.root, storage);
    await assert.rejects(
        worktreeStorage(f.backend, "/must-not-use-host-storage", options),
        /not a symlink/,
    );
    assert.equal((await lstat(storage)).isSymbolicLink(), true);
});

test("trusted workflow staging works inside the publication lock without bypassing actual-user revocation or ordinary writer gates", async (t) => {
    const f = await repository(t);
    const id = 7 as ConversationId;
    let user = { id: "requesting-human", tokenHash: "fixture-token", role: "owner" } as User;
    let retired = false;
    let confined = 0;
    const original = f.env.exec.bind(f.env);

    // Simulate the confined boundary only; never invoke a native sandbox in this fixture.
    const confinedTransport = mock.method(
        SshExecutionEnv.prototype,
        "execConfined",
        (...[_readOnly, argv, options, context]: Parameters<SshExecutionEnv["execConfined"]>) => {
            confined++;

            return original(argv, options, context);
        },
    );

    t.after(() => confinedTransport.mock.restore());
    const app = {
        attribution: { requesterOf: () => user.id },
        config: { userById: (who: string) => (who === user.id ? user : undefined) },
        requireSee: () => {},
        requireSteer: (person: User) => {
            if (person.role === "viewer") {
                throw new Error("Steering is revoked");
            }
        },
        rootOf: () => id,
        sessionMeta: () => ({ workItemId: "fixture-item" }),
        locationOf: () => ({ kind: "ssh", host: "fixture-host" }),
        cwdOf: () => f.root,
        handoffs: {
            isManaged: () => true,
            requireWritable: () => {
                if (retired) {
                    throw new Error("Retired writer");
                }
            },
        },
    } as unknown as PocketApp;

    Object.assign(app, { sshSessions: new SshSessions(app, f.root) });
    t.after(() => app.sshSessions.close());
    const trusted = workflowWorkspaceBackend(app, id, BACKGROUND_CONTEXT);
    const ordinary = userWorkspaceBackend(app, id, BACKGROUND_CONTEXT, user);

    await withWorkflowPublicationLock(app, id, async () => {
        getOrThrow(
            await trusted.env.writeFile(
                join(f.root, "stage.bin"),
                Buffer.from([255, 0]),
                BACKGROUND_CONTEXT,
            ),
        );
        assert.deepEqual(await trusted.readBytes("stage.bin", 2), Buffer.from([255, 0]));
        await trusted.gitBytes(f.root, ["hash-object", "-w", "--", "stage.bin"], {
            offline: true,
            readOnly: false,
        });
        await assert.rejects(
            ordinary.env.writeFile(
                join(f.root, "ordinary.bin"),
                "must not write",
                BACKGROUND_CONTEXT,
            ),
            /Publication is executing/,
        );
        await assert.rejects(
            ordinary.gitBytes(f.root, ["add", "--", "stage.bin"], {
                offline: true,
                readOnly: false,
            }),
            /Publication is executing/,
        );
    });
    const localApp = {
        ...app,
        locationOf: () => undefined,
        handoffs: { ...app.handoffs, isManaged: () => false },
    } as unknown as PocketApp;
    const localUser = userWorkspaceBackend(localApp, id, BACKGROUND_CONTEXT, user);

    await withWorkflowPublicationLock(localApp, id, async () => {
        await assert.rejects(
            localUser.gitBytes(f.root, ["rev-parse", "HEAD"], { readOnly: false }),
            /Publication is executing/,
        );
    });
    const beforeForced = confined;

    await trusted.gitBytes(f.root, ["rev-parse", "HEAD"], { offline: false });
    assert.equal(
        confined,
        beforeForced + 1,
        "a managed factory cannot be weakened by offline:false",
    );
    retired = true;
    await assert.rejects(
        trusted.gitBytes(f.root, ["add", "--", "stage.bin"], { offline: true, readOnly: false }),
        /Retired/,
    );
    assert.equal(await trusted.canonical(f.root), f.root);
    user = { ...user, role: "viewer" };
    await assert.rejects(trusted.readBytes("stage.bin", 2), /authority changed/);
    const viewer = userWorkspaceBackend(app, id, BACKGROUND_CONTEXT, user);

    assert.deepEqual(await viewer.readBytes("stage.bin", 2), Buffer.from([255, 0]));
    assert.match(
        (await viewer.gitBytes(f.root, ["rev-parse", "HEAD"], { offline: true })).toString(),
        /^[a-f0-9]{40}\n$/,
    );
    user = { ...user, tokenHash: "replaced-token" };
    await assert.rejects(viewer.readBytes("stage.bin", 2), /currently authorized requester/);
    await assert.rejects(stat(join(f.root, "ordinary.bin")), { code: "ENOENT" });
});
