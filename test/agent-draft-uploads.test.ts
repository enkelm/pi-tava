// File ownership and immutable native-path materialization, using only disposable staging files.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PocketApp } from "../src/server/app.ts";
import type { User } from "../src/server/config.ts";
import type { ConversationId } from "@earendil-works/pi-durable";
import {
    draftAttachments,
    draftUploadDirectory,
    materializeDraftAttachments,
} from "../src/server/agent-draft-uploads.ts";

test("draft attachments are owner/identity scoped; accepted materialization uses stable native paths", (t) => {
    const dataDir = mkdtempSync(join(tmpdir(), "agent-draft-uploads-"));

    t.after(() => rmSync(dataDir, { recursive: true, force: true }));
    const app = {
        dataDir,
        workspace: {
            uploadDirectory: (id: ConversationId) => {
                const directory = join(dataDir, "uploads", String(id));

                mkdirSync(directory, { recursive: true });

                return directory;
            },
        },
    } as PocketApp;
    const owner = { id: "owner" } as User;
    const path = join(draftUploadDirectory(app, owner, "ada"), "opaque-photo.png");

    writeFileSync(path, "png");
    const attachment = { path, name: "photo.png", mime: "image/png", size: 3 };
    const files = draftAttachments(app, owner, "ada", [attachment]);

    assert.equal(files[0]?.path, path);
    assert.throws(() => draftAttachments(app, owner, "bea", [attachment]), /this private agent/);
    assert.throws(
        () => draftAttachments(app, { id: "other" } as User, "ada", [attachment]),
        /this private agent/,
    );
    assert.throws(
        () => draftAttachments(app, owner, "ada", [{ ...attachment, size: 20 }]),
        /changed/,
    );
    const hostFile = join(dataDir, "private.txt");
    const linked = join(draftUploadDirectory(app, owner, "ada"), "linked.png");

    writeFileSync(hostFile, "secret");
    symlinkSync(hostFile, linked);
    assert.throws(
        () => draftAttachments(app, owner, "ada", [{ ...attachment, path: hostFile }]),
        /this private agent/,
    );
    assert.throws(
        () => draftAttachments(app, owner, "ada", [{ ...attachment, path: linked, size: 6 }]),
        /changed/,
    );
    const first = materializeDraftAttachments(app, 101 as ConversationId, files);
    const retry = materializeDraftAttachments(app, 101 as ConversationId, files);

    assert.deepEqual(retry, first, "a retry never assigns a different native attachment path");
    assert.equal(first[0]?.path, join(dataDir, "uploads", "101", "draft-opaque-photo.png"));
    assert.equal(readFileSync(first[0]!.path, "utf8"), "png");
    assert.equal(
        readFileSync(path, "utf8"),
        "png",
        "staging remains for an uncertain first-send retry",
    );
});
