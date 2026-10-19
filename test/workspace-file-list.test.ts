import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import { cleanUp, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
import { sshFixture } from "./ssh-fixture.ts";

after(cleanUp);

async function fixture(name: string) {
    const ssh = await sshFixture();
    const app = await openApp(scriptedModel(), join(root, name));
    const cwd = join(await realpath(ssh.root), "project");
    const hold = join(ssh.root, "hold-sftp-init");
    const ready = join(ssh.root, "sftp-init-ready");

    const close = async () => {
        await rm(hold, { force: true });
        await app.close();
        await ssh.env.cleanup(BACKGROUND_CONTEXT);
        await ssh.close();
    };

    try {
        await mkdir(cwd);
        await mkdir(join(cwd, "src"));
        await writeFile(join(cwd, "src", "first.ts"), "first");
        const user = owner(app);
        const { id } = await app.commands.createSession(user, {
            cwd,
            location: { kind: "ssh", host: "fixture-host" },
            threadType: "chat",
        });

        // Session creation has its own explicit validation; measure only the requested mention reads.
        await writeFile(join(ssh.root, "calls"), "");

        return {
            app,
            user,
            id,
            cwd,
            hold,
            ready,
            async transports() {
                return (await readFile(join(ssh.root, "calls"), "utf8")).split("\n").filter(Boolean)
                    .length;
            },
            async gate() {
                await rm(ready, { force: true });
                await writeFile(hold, "wait");
            },
            close,
        };
    } catch (error) {
        await close();

        throw error;
    }
}

// The former remote branch bypassed local FileLists freshness and single-flight entirely.
// This crosses Workspace's actual caller/pinned-target seam and the SFTP subprocess protocol,
// rather than asserting a cache implementation or replacing the tree walk with a fake result.
test("remote mention readers share one exact-caller traversal and briefly reuse its result", async (t) => {
    const f = await fixture("remote-mention-freshness");

    try {
        await writeFile(f.hold, "wait");
        const first = f.app.workspace.fileList(f.id, f.user);
        const second = f.app.workspace.fileList(f.id, f.user);
        const third = f.app.workspace.fileList(f.id, f.user);

        await until(() => existsSync(f.ready), "mention traversal has started authenticating");
        await rm(f.hold);
        const results = await Promise.all([first, second, third]);

        assert.deepEqual(
            results.map((listing) => listing.files),
            [["src/first.ts"], ["src/first.ts"], ["src/first.ts"]],
        );
        assert.equal(
            await f.transports(),
            1,
            "concurrent tabs must not each authenticate and walk",
        );
        await writeFile(join(f.cwd, "src", "second.ts"), "second");
        const fresh = await f.app.workspace.fileList(f.id, f.user);

        assert.deepEqual(fresh.files, ["src/first.ts"], "fresh names may be reused briefly");
        assert.equal(fresh.version, results[0]!.version);
        // A fresh result still verifies the current canonical root, without retaining its transport.
        assert.equal(await f.transports(), 2);
        const now = Date.now();

        t.mock.method(Date, "now", () => now + 5001);
        const expired = await f.app.workspace.fileList(f.id, f.user);

        assert.deepEqual(expired.files, ["src/first.ts", "src/second.ts"]);
        assert.notEqual(expired.version, fresh.version);
    } finally {
        t.mock.restoreAll();
        await f.close();
    }
});

// Each browser read has its own lifetime. Abandoning one tab must neither return data to
// that tab nor cancel another identical authorized read; abandoning all must join cleanup.
test("remote mention consumers cancel independently and the last cancellation joins transport cleanup", async () => {
    const f = await fixture("remote-mention-cancellation");

    try {
        await writeFile(f.hold, "wait");
        const abandoned = withCancel(BACKGROUND_CONTEXT);
        const kept = f.app.workspace.fileList(f.id, f.user);
        const cancelled = f.app.workspace.fileList(f.id, f.user, abandoned.context);
        const denied = assert.rejects(cancelled, /abort|cancel/i);

        await until(() => existsSync(f.ready), "shared mention read is blocked in real SFTP");
        abandoned.cancel();
        await denied;
        assert.equal(await f.transports(), 1);
        await rm(f.hold);
        assert.deepEqual((await kept).files, ["src/first.ts"]);
        await rm(f.ready);
        await writeFile(f.hold, "wait");
        const last = withCancel(BACKGROUND_CONTEXT);
        const operation = f.app.workspace.fileList(f.id, f.user, last.context);
        const lastDenied = assert.rejects(operation, /abort|cancel/i);

        await until(() => existsSync(f.ready), "fresh-result root validation has started SFTP");
        last.cancel();
        await lastDenied;
        await rm(f.hold);
        assert.deepEqual((await f.app.workspace.fileList(f.id, f.user)).files, ["src/first.ts"]);
        assert.equal(await f.transports(), 3, "a cancelled connection cannot be retained/reused");
    } finally {
        await f.close();
    }
});

// A names-only cache is not authority: exact people/tokens/scopes remain separate, and
// narrowing the same token while an actual SFTP response is pending invalidates all its readers.
test("remote mention sharing separates callers and rechecks changed live authority", async () => {
    const f = await fixture("remote-mention-authority");

    try {
        const guest = f.app.config.addUser("Mention reader", "guest").user;
        const other = f.app.config.addUser("Other mention reader", "guest").user;

        assert.deepEqual((await f.app.workspace.fileList(f.id, guest)).files, ["src/first.ts"]);
        await writeFile(join(f.cwd, "second.txt"), "second");
        assert.deepEqual((await f.app.workspace.fileList(f.id, other)).files, [
            "second.txt",
            "src/first.ts",
        ]);
        f.app.setAccess(f.user, guest.id, { role: "guest", sessions: [String(f.id)] });
        assert.deepEqual((await f.app.workspace.fileList(f.id, guest)).files, [
            "second.txt",
            "src/first.ts",
        ]);
        await f.gate();
        const first = f.app.workspace.fileList(f.id, guest);
        const second = f.app.workspace.fileList(f.id, guest);
        const denied = Promise.all([
            assert.rejects(first, /authority changed|access changed|scope changed/i),
            assert.rejects(second, /authority changed|access changed|scope changed/i),
        ]);

        await until(() => existsSync(f.ready), "fresh cached listing is verifying its remote root");
        f.app.setAccess(f.user, guest.id, { role: "guest", sessions: null });
        await rm(f.hold);
        await denied;
        assert.deepEqual((await f.app.workspace.fileList(f.id, guest)).files, ["src/first.ts"]);
        // The unrestricted result is still within its brief freshness window. It cannot be
        // borrowed by another token of the same person, even when thread visibility is unchanged.
        assert.deepEqual((await f.app.workspace.fileList(f.id, f.user)).files, [
            "second.txt",
            "src/first.ts",
        ]);
        const oldOwner = { ...f.user };

        await writeFile(join(f.cwd, "third.txt"), "third");
        f.app.config.rotateOwnerToken();
        assert.deepEqual((await f.app.workspace.fileList(f.id, owner(f.app))).files, [
            "second.txt",
            "src/first.ts",
            "third.txt",
        ]);
        // Live-config visibility may reject the old token before the file-list snapshot check.
        await assert.rejects(
            f.app.workspace.fileList(f.id, oldOwner),
            /authority changed|not shared/i,
        );
        f.app.setAccess(owner(f.app), guest.id, { role: "viewer" });
        await assert.rejects(f.app.workspace.fileList(f.id, guest), /not steer/i);
    } finally {
        await f.close();
    }
});

test("fresh remote mention snapshots revalidate canonical roots and changed working directories", async () => {
    const f = await fixture("remote-mention-root");

    try {
        await f.app.workspace.fileList(f.id, f.user);
        const replacement = join(f.cwd, "..", "replacement");

        await mkdir(replacement);
        await writeFile(join(replacement, "replacement.txt"), "replacement");
        await rename(f.cwd, f.cwd + "-old");
        await symlink(replacement, f.cwd);
        assert.deepEqual((await f.app.workspace.fileList(f.id, f.user)).files, ["replacement.txt"]);
        await rm(f.cwd);
        await writeFile(f.cwd, "not a directory");
        await assert.rejects(f.app.workspace.fileList(f.id, f.user), /root.*directory/i);
        await rm(f.cwd);
        await symlink(replacement, f.cwd);
        const next = join(f.cwd, "..", "next");

        await mkdir(next);
        await writeFile(join(next, "next.txt"), "next");
        await f.app.commands.configure(f.id, f.user, { cwd: next });
        assert.deepEqual((await f.app.workspace.fileList(f.id, f.user)).files, ["next.txt"]);
    } finally {
        await f.close();
    }
});

test("remote mention freshness retains at most sixteen exact-caller snapshots", async (t) => {
    const f = await fixture("remote-mention-bounded");
    const now = Date.now();

    t.mock.method(Date, "now", () => now);

    try {
        const first = f.app.config.addUser("First cached reader", "guest").user;

        await f.app.workspace.fileList(f.id, first);

        for (let n = 0; n < 16; n++) {
            const user = f.app.config.addUser(`Reader ${n}`, "guest").user;

            await f.app.workspace.fileList(f.id, user);
        }

        await writeFile(join(f.cwd, "after-eviction.txt"), "new");
        assert.deepEqual((await f.app.workspace.fileList(f.id, first)).files, [
            "after-eviction.txt",
            "src/first.ts",
        ]);
    } finally {
        t.mock.restoreAll();
        await f.close();
    }
});
