import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { sshFixture } from "./ssh-fixture.ts";
import { gunzipSync } from "node:zlib";
import type { ConversationId } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { PocketApp } from "../src/server/app.ts";
import type { User } from "../src/server/config.ts";
import { MAX_EDIT_BYTES } from "../src/server/file-edits.ts";
import {
    remoteFile,
    remoteFileList,
    remoteFolders,
    remoteImage,
    remoteView,
} from "../src/server/remote-workspace.ts";
import { Workspace } from "../src/server/workspace.ts";

// Exercise the filesystem contract against disposable real files, without owner credentials or an SSH connection.
function fixture(t: { after(fn: () => void): void }) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "coop-ssh-workspace-")));
    const cwd = join(root, "project");

    mkdirSync(cwd);
    t.after(() => rmSync(root, { recursive: true, force: true }));

    return { root, cwd, env: new NodeExecutionEnv({ cwd }) };
}

test("remote viewer scopes canonical paths and rejects symlinks outside its remote root", async (t) => {
    const { root, cwd, env } = fixture(t);
    const file = join(cwd, "notes ; $name.txt");
    const outside = join(root, "private.txt");

    writeFileSync(file, "remote project content");
    writeFileSync(outside, "private");
    symlinkSync(outside, join(cwd, "escape"));
    symlinkSync(file, join(cwd, "inside"));
    assert.equal(await remoteFile(env, "inside", true), file);
    await assert.rejects(remoteFile(env, "escape", true), /File not found/);
    await assert.rejects(remoteFile(env, "../private.txt", true), /File not found/);
    assert.equal(await remoteFile(env, "../private.txt", false), outside);
    const view = await remoteView(env, await remoteFile(env, "notes ; $name.txt", true));

    assert.equal(view.kind, "text");

    if (view.kind === "text") {
        assert.equal(view.text, "remote project content");
        assert.equal(
            view.revision,
            undefined,
            "remote reads must not imply atomic quick-edit support",
        );
    }
});

test("remote previews bound text, preserve image bytes, and distinguish binary files", async (t) => {
    const { cwd, env } = fixture(t);
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 255, 0]);

    writeFileSync(join(cwd, "image.png"), bytes);
    writeFileSync(join(cwd, "binary.bin"), Buffer.from([0, 255, 3]));
    writeFileSync(join(cwd, "large.txt"), "x".repeat(MAX_EDIT_BYTES + 100));
    assert.deepEqual(await remoteImage(env, join(cwd, "image.png")), bytes);
    assert.deepEqual(await remoteView(env, join(cwd, "binary.bin")), { kind: "binary", size: 3 });
    const view = await remoteView(env, join(cwd, "large.txt"));

    assert.equal(view.kind, "text");

    if (view.kind === "text") {
        assert.equal(view.text.length, MAX_EDIT_BYTES);
        assert.equal(view.truncated, true);
        assert.equal(view.revision, undefined);
    }
});

test("remote folders and mentions use environment files, skip linked trees and bound directory pages", async (t) => {
    const { root, cwd, env } = fixture(t);
    // SFTP can return short, non-final directory pages; use real filesystem readers with small transport pages.
    const openDirReader = env.openDirReader.bind(env);

    env.openDirReader = async (path, context) => {
        const result = await openDirReader(path, context);

        if (!result.ok) {
            return result;
        }

        const reader = result.value;

        return {
            ok: true,
            value: {
                next: (limit, ctx) => reader.next(Math.min(3, limit), ctx),
                close: (ctx) => reader.close(ctx),
            },
        };
    };

    mkdirSync(join(cwd, "src"));
    mkdirSync(join(cwd, ".hidden"));
    mkdirSync(join(cwd, "node_modules"));
    writeFileSync(join(cwd, "src", "app.ts"), "source");
    writeFileSync(join(cwd, "node_modules", "package.js"), "dependency");
    symlinkSync(root, join(cwd, "loop"));
    const folders = await remoteFolders(env, cwd, false);

    assert.equal(folders.path, cwd);
    assert.deepEqual(
        folders.dirs.map((entry) => entry.name),
        ["loop", "node_modules", "src"],
    );
    const mentions = await remoteFileList(env);

    assert.deepEqual(mentions.files, ["src/app.ts"]);
    assert.equal(mentions.truncated, false);
    assert.deepEqual(JSON.parse(gunzipSync(await mentions.gzipped()).toString()), {
        files: ["src/app.ts"],
        truncated: false,
        version: mentions.version,
    });

    for (let n = 0; n < 1020; n++) {
        writeFileSync(join(cwd, `file-${n}.txt`), "");
    }

    const view = await remoteView(env, cwd);

    assert.equal(view.kind, "folder");

    if (view.kind === "folder") {
        assert.equal(view.entries.length, 1000);
        assert.equal(view.truncated, true);
    }
});

// Transport setup is the latency-bearing boundary: loopback process timing omits real network/auth RTT.
// Keep one authenticated SFTP transport per compound browse, even when resolving directory symlinks.
test("one remote folder browse authenticates once, including linked folders", async () => {
    const fixture = await sshFixture();

    try {
        const cwd = join(fixture.root, "project");

        mkdirSync(cwd);
        mkdirSync(join(cwd, "src"));
        writeFileSync(join(cwd, "notes.txt"), "remote content");

        for (let index = 0; index < 4; index++) {
            symlinkSync(join(cwd, "src"), join(cwd, `link-${index}`));
        }

        const folders = await remoteFolders(fixture.env, cwd, false);

        assert.deepEqual(
            folders.dirs.map((entry) => entry.name),
            ["link-0", "link-1", "link-2", "link-3", "src"],
        );
        const calls = (await readFile(join(fixture.root, "calls"), "utf8")).trim().split("\n");

        assert.equal(
            calls.length,
            1,
            "a single browse must not repeat SSH authentication for each path operation",
        );
    } finally {
        await fixture.close();
    }
});

test("synchronous workspace helpers cannot resolve SSH paths against same-named host files", (t) => {
    const { cwd } = fixture(t);
    const id = 1 as ConversationId;
    const user = { role: "owner" } as User;
    const app = {
        cwdOf: () => cwd,
        locationOf: () => ({ kind: "ssh", host: "fixture" }),
    } as unknown as PocketApp;
    const workspace = new Workspace(app);
    const path = join(cwd, "local-secret.txt");

    writeFileSync(path, "host only");
    assert.equal(workspace.head(id), undefined);
    assert.throws(() => workspace.conversationPath(id, path), /not available for SSH/);
    assert.throws(() => workspace.conversationFile(user, id, path), /not available for SSH/);
    assert.throws(() => workspace.readableFile(user, id, path), /not available for SSH/);
    assert.throws(() => workspace.editableFile(user, id, path), /not available for SSH/);
});
