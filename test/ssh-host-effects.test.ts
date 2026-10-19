// Transfer adapters operate on real disposable SFTP bytes and host staging; no service, credentials or network.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, access, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { WorkspaceBackend } from "../src/server/workspace-backend.ts";
import {
    publicationBodies,
    requireHostTransport,
    stagePublicationBodies,
} from "../src/server/workflow-host-stage.ts";
import { sshFixture } from "./ssh-fixture.ts";

// This owns the SSH-to-host body-file boundary, not approval policy (workflow-permissions owns that).
// A regression interpreting a remote path locally, decoding/reencoding bytes or rereading after approval
// would change the staged result. Generic transport tests do not exercise publication argument parsing.
test("publication snapshots remote body-file bytes and source identity into private host staging", async () => {
    const f = await sshFixture();
    const backend = new WorkspaceBackend(f.env, { remote: true, inspection: f.env, context });
    const source = join(f.root, "body ' 雪 ; $literal.txt");
    const bytes = Buffer.from("line one\r\n雪\nno trailing newline", "utf8");
    const command = [
        "gh",
        "issue",
        "comment",
        "7",
        "--repo",
        "team/project",
        "--title",
        "--body-file",
        "--body-file",
        source,
    ];

    try {
        await writeFile(source, bytes);
        const bodies = await publicationBodies(backend, command);

        assert.equal(bodies.length, 1, "a flag-looking title is text, not another file operand");
        assert.equal(bodies[0]!.path, await realpath(source));
        assert.deepEqual(bodies[0]!.bytes, bytes);
        const staged = await stagePublicationBodies(command, bodies);
        const path = staged.command.at(-1)!;

        try {
            assert.notEqual(path, source);
            assert.equal(staged.command[7], "--body-file", "non-file content is unchanged");
            assert.deepEqual(await readFile(path), bytes);
            assert.equal((await stat(path)).mode & 0o777, 0o600);
            await writeFile(source, "new remote content");
            assert.deepEqual(
                await readFile(path),
                bytes,
                "execution consumes the pinned snapshot, never a late remote reread",
            );
            const changed = await publicationBodies(backend, command);

            assert.notEqual(
                changed[0]!.sha256,
                bodies[0]!.sha256,
                "new source content invalidates its approval input hash",
            );
            const inline = await stagePublicationBodies(
                ["gh", "issue", "comment", "7", `-F=${source}`],
                await publicationBodies(backend, ["gh", "issue", "comment", "7", `-F=${source}`]),
            );

            try {
                assert.match(inline.command[4]!, /^-F=/);
                assert.equal(
                    await readFile(inline.command[4]!.slice(3), "utf8"),
                    "new remote content",
                );
            } finally {
                await inline.cleanup();
            }
        } finally {
            await staged.cleanup();
        }

        await assert.rejects(access(path), /ENOENT/);
    } finally {
        await f.env.cleanup(context);
        await f.close();
    }
});

test("remote publication body inputs reject failed authentication, non-text, oversized and directory sources without fallback", async () => {
    const f = await sshFixture();
    const backend = new WorkspaceBackend(f.env, { remote: true, inspection: f.env, context });
    const source = join(f.root, "body.txt");
    const command = ["gh", "issue", "comment", "7", "--body-file", source];

    try {
        await writeFile(source, Buffer.from([0xff, 0xfe]));
        await assert.rejects(
            publicationBodies(backend, command),
            /Non-UTF-8 publication body file/,
        );
        await writeFile(source, "valid text");
        await assert.rejects(
            publicationBodies(backend, [...command, "-F", source]),
            /only one explicit body-file/,
        );
        await writeFile(source, Buffer.alloc(8 * 1024 * 1024 + 1));
        await assert.rejects(publicationBodies(backend, command), /bounded regular file/);
        await mkdir(join(f.root, "directory"));
        await assert.rejects(
            publicationBodies(backend, [...command.slice(0, -1), join(f.root, "directory")]),
            /bounded regular file/,
        );
        await assert.rejects(
            publicationBodies(backend, [...command.slice(0, -1), "-"]),
            /stdin is unsupported/,
        );
    } finally {
        await f.env.cleanup(context);
        await f.close();
    }

    const failed = await sshFixture("auth-failed");
    const namesake = join(failed.root, "host-only.txt");

    try {
        await writeFile(namesake, "host bytes must never be published as remote content");
        const unavailable = new WorkspaceBackend(failed.env, {
            remote: true,
            inspection: failed.env,
            context,
        });

        await assert.rejects(
            publicationBodies(unavailable, ["gh", "issue", "comment", "7", "-F", namesake]),
            /Permission denied|SSH\/SFTP/,
        );
    } finally {
        await failed.env.cleanup(context);
        await failed.close();
    }
});

// URL validation is shared by both public external adapters. File transport has different namespace
// meaning on SSH; accepting it would acquire/publish an unrelated same-named host repository.
test("host external Git transport never gives remote file URLs host-local namesake meaning", () => {
    for (const url of [
        "/tmp/repository",
        "../repository",
        "file:///tmp/repository",
        "file://localhost/tmp/repository",
        "ext::anything",
        "https://name:secret@example.invalid/repo",
        "https://example.invalid/repo\nextra",
    ]) {
        assert.throws(
            () => requireHostTransport(url),
            /require an ordinary HTTPS or SSH URL|must not embed credentials|multiline/,
        );
    }

    for (const url of [
        "https://example.invalid/team/repository.git",
        "ssh://git@example.invalid/team/repository.git",
        "git@example.invalid:team/repository.git",
    ]) {
        assert.doesNotThrow(() => requireHostTransport(url));
    }
});
