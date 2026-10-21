import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { cleanUp, context, openApp, owner, root, scriptedModel } from "./helpers.ts";
import { MAX_EDIT_BYTES } from "../src/server/file-edits.ts";

after(cleanUp);

// Local shared discovery must use Workspace's Git-aware file list, not the SSH fallback walk.
// Real ignored/tracked files distinguish the dispatchers without mocking discovery or authority.
test("shared source discovery honors local Git ignores and includes tracked dotfiles", async () => {
    const cwd = join(root, "source-git");

    await mkdir(cwd);
    await writeFile(join(cwd, ".gitignore"), "ignored-secret.txt\n");
    await writeFile(join(cwd, ".tracked-config"), "tracked source configuration\n");
    await writeFile(join(cwd, "source.ts"), "export const source = true;\n");
    await writeFile(join(cwd, "ignored-secret.txt"), "must not be discovered\n");
    await mkdir(join(cwd, ".ssh"));
    await writeFile(join(cwd, ".ssh", "config"), "private SSH configuration\n");
    execFileSync("git", ["init", "--quiet", cwd]);
    execFileSync("git", ["-C", cwd, "add", ".gitignore", ".tracked-config", "source.ts", ".ssh"]);
    const app = await openApp(scriptedModel(), join(cwd, "app-private"));

    try {
        const user = owner(app);
        const { id } = await app.commands.createSession(user, { cwd, threadType: "chat" });
        const shared = app.workItems.reader(id, async () => owner(app), context, "shared");
        const listing = await shared.read({
            type: "toolCall",
            id: "source-list",
            name: "work_context",
            arguments: { action: "files" },
        });

        assert.deepEqual(listing, {
            files: [".gitignore", ".tracked-config", "source.ts"],
            truncated: false,
        });
    } finally {
        await app.close();
    }
});

// Unlike the broad viewer, shared source reads must reject rather than truncate binary/oversized input.
test("Workspace source reads return complete byte-revisioned UTF-8 and reject unsuitable source", async () => {
    const cwd = join(root, "source-bytes");

    await mkdir(cwd);
    const text = "\ufeffα\r\nβ\n";
    const bytes = Buffer.from(text);

    await writeFile(join(cwd, "source.ts"), bytes);
    await writeFile(join(cwd, "binary.ts"), Buffer.from([0xff, 0x00, 0x61]));
    await writeFile(join(cwd, "large.ts"), Buffer.alloc(MAX_EDIT_BYTES + 1, 0x61));
    const app = await openApp(scriptedModel(), join(root, "source-bytes-data"));

    try {
        const user = owner(app);
        const { id } = await app.commands.createSession(user, { cwd, threadType: "chat" });

        assert.deepEqual(await app.workspace.sourceFile(id, user, "source.ts", context), {
            text,
            revision: createHash("sha256").update(bytes).digest("hex"),
        });
        await assert.rejects(app.workspace.sourceFile(id, user, "binary.ts", context), {
            status: 415,
        });
        await assert.rejects(
            app.workspace.sourceFile(id, user, "large.ts", context),
            /exceeds .* bytes/,
        );
    } finally {
        await app.close();
    }
});

// Static path-escape coverage cannot detect a symlink retargeted after the opened bytes return.
// Keep the real backend/authorization/read; mutate only the isolated filesystem at that await.
test("Workspace source reads discard bytes when the requested file is retargeted mid-read", async (t) => {
    const cwd = join(root, "source-retarget");

    await mkdir(cwd);
    await writeFile(join(cwd, "first.ts"), "old source\n");
    await writeFile(join(cwd, "second.ts"), "different source\n");
    const alias = join(cwd, "source.ts");

    await symlink("first.ts", alias);
    const app = await openApp(scriptedModel(), join(root, "source-retarget-data"));

    try {
        const user = owner(app);
        const { id } = await app.commands.createSession(user, { cwd, threadType: "chat" });
        const original = app.sshSessions.withWorkspace.bind(app.sshSessions);

        t.mock.method(
            app.sshSessions,
            "withWorkspace",
            (...[id, user, ctx, read]: Parameters<typeof original>) =>
                original(id, user, ctx, (backend) => {
                    const readBytes = backend.readBytes.bind(backend);

                    t.mock.method(backend, "readBytes", async (path: string, limit: number) => {
                        const bytes = await readBytes(path, limit);

                        await unlink(alias);
                        await symlink("second.ts", alias);

                        return bytes;
                    });

                    return read(backend);
                }),
        );
        await assert.rejects(
            app.workspace.sourceFile(id, user, "source.ts", context),
            /location changed during the read/,
        );
    } finally {
        await app.close();
    }
});
