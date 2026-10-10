// Exercise quick edits at the real workspace boundary, with isolated app/model/filesystem fixtures.
import {
    type App,
    cleanUp,
    context,
    modelTexts,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    chmodSync,
    linkSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    realpathSync,
    statSync,
    symlinkSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { after, before, mock, test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { ChatDoc } from "../src/server/docs.ts";
import { HttpError } from "../src/server/errors.ts";

let app: App;
const cap = 512 * 1024;
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const status = (code: number) => (error: unknown) =>
    error instanceof HttpError && error.status === code;

before(async () => {
    app = await openApp(scriptedModel(), join(root, "file-edit-data"));
});

after(async () => {
    await app?.close();
    cleanUp();
});

function directory(name: string): string {
    const dir = join(root, name);

    mkdirSync(dir, { recursive: true });

    return dir;
}

test("complete text views have byte revisions; saves preserve BOM, newlines, permissions and tell Pi/people", async () => {
    const cwd = directory("edit-success");
    const file = join(cwd, "notes.txt");
    const original = Buffer.from("\uFEFFfirst\r\nsecond\r\n");
    const text = "\uFEFFchanged 🦊\r\nlast without newline";

    writeFileSync(file, original);
    chmodSync(file, 0o640);
    const id = await newSession(app, cwd);
    const me = owner(app);
    const view = await app.workspace.viewFile(id, me, "notes.txt");

    assert.equal(view.kind, "text");

    if (view.kind !== "text") {
        assert.fail("expected text");
    }

    assert.equal(view.text, original.toString("utf8"));
    assert.equal(view.truncated, false);
    assert.equal(view.editable, true);
    assert.equal(view.revision, digest(original));
    const saved = await app.workspace.saveFile(id, me, "notes.txt", text, view.revision);

    assert.deepEqual(saved, { revision: digest(text) });
    assert.deepEqual(readFileSync(file), Buffer.from(text));
    assert.equal(statSync(file).mode & 0o777, 0o640);
    assert.deepEqual(readdirSync(cwd), ["notes.txt"], "no temporary siblings left behind");
    await until(
        async () =>
            (await app.transcripts.history(id, Number.MAX_SAFE_INTEGER)).some(
                (entry) => entry.kind === "note" && entry.text === "edited notes.txt",
            ),
        "edit note in the transcript",
    );
    assert.match((await modelTexts(app, id)).join("\n"), /\[note\] Owner edited notes\.txt/);
    const chat = await app.harness.snapshot(ChatDoc, id, context);

    assert.ok(
        chat?.messages.some(
            (message) =>
                message.kind === "event" &&
                message.userId === me.id &&
                message.text === "edited notes.txt",
        ),
    );
    const fresh = await app.workspace.viewFile(id, me, "notes.txt");

    assert.ok(fresh.kind === "text" && fresh.text === text && fresh.revision === saved.revision);
});

test("concurrent stale saves across conversations/aliases have one winner; external edits are not overwritten", async () => {
    const cwd = directory("edit-concurrent");
    const file = join(cwd, "same.txt");

    writeFileSync(file, "original\n");
    symlinkSync("same.txt", join(cwd, "alias.txt"));
    const first = await newSession(app, cwd);
    const second = await newSession(app, cwd);
    const me = owner(app);
    const view = await app.workspace.viewFile(first, me, "same.txt");

    assert.ok(view.kind === "text" && view.revision);
    const attempts = [
        { id: first, path: "same.txt", text: "first winner\n" },
        { id: second, path: "alias.txt", text: "second winner\n" },
    ];
    const results = await Promise.allSettled(
        attempts.map(({ id, path, text }) =>
            app.workspace.saveFile(id, me, path, text, view.revision),
        ),
    );
    const winner = results.findIndex((result) => result.status === "fulfilled");
    const failures = results.filter((result) => result.status === "rejected");

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(failures.length, 1);
    assert.ok(status(409)(failures[0]!.reason));
    assert.equal(readFileSync(file, "utf8"), attempts[winner]!.text);
    assert.equal(readFileSync(join(cwd, "alias.txt"), "utf8"), attempts[winner]!.text);
    const next = await app.workspace.viewFile(first, me, "same.txt");

    assert.ok(next.kind === "text" && next.revision);
    const external = "externally replaced, keep this\n";

    writeFileSync(file, external);
    await assert.rejects(
        app.workspace.saveFile(first, me, "same.txt", "stale overwrite", next.revision),
        status(409),
    );
    assert.equal(readFileSync(file, "utf8"), external);
    assert.deepEqual(readdirSync(cwd).sort(), ["alias.txt", "same.txt"]);
    const notes = await app.harness.snapshot(ChatDoc, first, context);
    const otherNotes = await app.harness.snapshot(ChatDoc, second, context);

    assert.equal(
        [...(notes?.messages ?? []), ...(otherNotes?.messages ?? [])].filter(
            (message) => message.kind === "event" && message.text.startsWith("edited "),
        ).length,
        1,
        "conflicted saves do not record successful edits",
    );
});

test("scoped saves re-resolve path access: traversal, outside symlinks and a swapped link cannot write outside", async () => {
    const cwd = directory("edit-scoped");
    const outside = directory("edit-outside");
    const outsideFile = join(outside, "secret.txt");
    const file = join(cwd, "inside.txt");

    writeFileSync(file, "original");
    writeFileSync(outsideFile, "original");
    symlinkSync("inside.txt", join(cwd, "alias.txt"));
    const id = await newSession(app, cwd);
    const { user: scoped } = app.config.addUser("Scoped editor", "guest", [String(id)]);
    const view = await app.workspace.viewFile(id, scoped, "alias.txt");

    assert.ok(view.kind === "text" && view.revision);
    assert.equal(app.workspace.editableFile(scoped, id, "alias.txt"), realpathSync(file));
    unlinkSync(join(cwd, "alias.txt"));
    symlinkSync(outsideFile, join(cwd, "alias.txt"));

    for (const path of [outsideFile, "../edit-outside/secret.txt", "alias.txt"]) {
        await assert.rejects(
            app.workspace.saveFile(id, scoped, path, "must not write", view.revision),
            status(404),
        );
    }

    assert.equal(readFileSync(outsideFile, "utf8"), "original");
    assert.equal(readFileSync(file, "utf8"), "original");
    // A global steering user retains readableFile's machine-wide access outside protected directories.
    const { user: global } = app.config.addUser("Global editor", "guest");

    await app.workspace.saveFile(id, global, outsideFile, "allowed outside", digest("original"));
    assert.equal(readFileSync(outsideFile, "utf8"), "allowed outside");
});

test("even owners cannot edit app/Pi configuration or aliases, while session uploads/worktrees remain editable", async () => {
    const cwd = directory("edit-protected");
    const id = await newSession(app, cwd);
    const me = owner(app);
    const agentFile = join(process.env.PI_CODING_AGENT_DIR!, "edit-protected.txt");
    const dataFile = join(app.dataDir, "edit-protected.txt");
    const extensionDir = join(app.dataDir, "extensions");

    mkdirSync(extensionDir, { recursive: true });
    const extensionFile = join(extensionDir, "blocked.txt");

    for (const file of [agentFile, dataFile, extensionFile]) {
        writeFileSync(file, "protected");
    }

    symlinkSync(dataFile, join(cwd, "data-alias.txt"));
    symlinkSync(agentFile, join(cwd, "agent-alias.txt"));
    const uploadDir = app.workspace.uploadDirectory(id);

    symlinkSync(dataFile, join(uploadDir, "configuration-alias.txt"));

    for (const path of [
        agentFile,
        dataFile,
        extensionFile,
        "data-alias.txt",
        "agent-alias.txt",
        join(uploadDir, "configuration-alias.txt"),
    ]) {
        const view = await app.workspace.viewFile(id, me, path);

        assert.ok(view.kind === "text" && view.revision);
        assert.equal(view.editable, false);
        assert.throws(() => app.workspace.editableFile(me, id, path), status(403));
        await assert.rejects(
            app.workspace.saveFile(id, me, path, "bad change", view.revision),
            status(403),
        );
    }

    for (const file of [agentFile, dataFile, extensionFile]) {
        assert.equal(readFileSync(file, "utf8"), "protected");
    }

    const worktree = join(app.dataDir, "worktrees", "edit-fixture");

    mkdirSync(worktree, { recursive: true });
    const { user: scoped } = app.config.addUser("Upload editor", "guest", [String(id)]);
    const { user: guest } = app.config.addUser("Worktree editor", "guest");

    for (const [dir, user] of [
        [uploadDir, scoped],
        [worktree, guest],
    ] as const) {
        const file = join(dir, "editable.txt");

        writeFileSync(file, "allowed");
        const view = await app.workspace.viewFile(id, user, file);

        assert.ok(view.kind === "text" && view.revision && view.editable);
        await app.workspace.saveFile(id, user, file, "changed", view.revision);
        assert.equal(readFileSync(file, "utf8"), "changed");
    }
});

test("input and existing-byte checks reject oversized, malformed UTF-8, NUL, nonregular and hardlinked files", async () => {
    const cwd = directory("edit-limits");
    const id = await newSession(app, cwd);
    const me = owner(app);
    const ordinary = join(cwd, "ordinary.txt");

    writeFileSync(ordinary, "original");
    const revision = digest("original");
    const invalid: [unknown, unknown, unknown, number][] = [
        [undefined, "x", revision, 400],
        [4, "x", revision, 400],
        ["", "x", revision, 400],
        ["ordinary.txt\0", "x", revision, 400],
        ["ordinary.txt", {}, revision, 400],
        ["ordinary.txt", "x", undefined, 400],
        ["ordinary.txt", "x", "not a revision", 400],
        ["ordinary.txt", "embedded\0NUL", revision, 400],
        ["ordinary.txt", "lone surrogate \uD800", revision, 400],
        ["ordinary.txt", "🦊".repeat(cap / 4 + 1), revision, 413],
    ];

    for (const [path, text, rev, code] of invalid) {
        await assert.rejects(app.workspace.saveFile(id, me, path, text, rev), status(code));
        assert.equal(readFileSync(ordinary, "utf8"), "original");
    }

    const contents = [
        { name: "large.txt", bytes: Buffer.alloc(cap + 1, 97), kind: "text" },
        {
            name: "nul-late.bin",
            bytes: Buffer.concat([Buffer.alloc(9000, 97), Buffer.from([0])]),
            kind: "binary",
        },
        { name: "invalid-utf8.txt", bytes: Buffer.from([0x61, 0xc3, 0x28]), kind: "binary" },
    ];

    for (const { name, bytes, kind } of contents) {
        const file = join(cwd, name);

        writeFileSync(file, bytes);
        const view = await app.workspace.viewFile(id, me, name);

        assert.equal(view.kind, kind);

        if (view.kind === "text") {
            assert.equal(view.truncated, true);
            assert.equal(view.revision, undefined);
            assert.equal(view.editable, false);
        }

        await assert.rejects(
            app.workspace.saveFile(id, me, name, "replacement", digest(bytes)),
            status(409),
        );
        assert.deepEqual(readFileSync(file), bytes);
    }

    mkdirSync(join(cwd, "folder"));
    execFileSync("mkfifo", [join(cwd, "pipe")]);
    linkSync(ordinary, join(cwd, "hardlink.txt"));
    const linkedView = await app.workspace.viewFile(id, me, "ordinary.txt");

    assert.ok(linkedView.kind === "text" && linkedView.revision);
    assert.equal(linkedView.editable, false);

    for (const path of ["folder", "pipe", "hardlink.txt"]) {
        await assert.rejects(
            app.workspace.saveFile(id, me, path, "replacement", revision),
            status(409),
        );
    }

    assert.equal(readFileSync(ordinary, "utf8"), "original");
    unlinkSync(join(cwd, "hardlink.txt"));
    const boundary = "é".repeat(cap / 2);

    writeFileSync(ordinary, boundary);
    const full = await app.workspace.viewFile(id, me, "ordinary.txt");

    assert.ok(full.kind === "text" && full.revision);
    assert.equal(full.size, cap);
    assert.equal(full.text, boundary);
    assert.equal(full.truncated, false);
    assert.equal(full.revision, digest(boundary));
    await app.workspace.saveFile(
        id,
        me,
        "ordinary.txt",
        boundary.slice(0, -1) + "à",
        full.revision,
    );
    assert.equal(readFileSync(ordinary).length, cap);
    const updated = await app.workspace.viewFile(id, me, "ordinary.txt");

    assert.ok(updated.kind === "text" && updated.revision);
    await app.workspace.saveFile(id, me, "ordinary.txt", "", updated.revision);
    const empty = await app.workspace.viewFile(id, me, "ordinary.txt");

    assert.ok(empty.kind === "text" && empty.revision === digest("") && empty.text === "");
});

test("viewers, other-session invitees, non-drivers and busy conversations cannot save", async () => {
    const cwd = directory("edit-access");
    const file = join(cwd, "safe.txt");

    writeFileSync(file, "original");
    const id = await newSession(app, cwd);
    const another = await newSession(app, cwd);
    const me = owner(app);
    const { user: viewer } = app.config.addUser("Viewer", "viewer");
    const { user: scoped } = app.config.addUser("Different session", "guest", [String(another)]);
    const { user: guest } = app.config.addUser("Guest", "guest");
    const revision = digest("original");

    await assert.rejects(
        app.workspace.saveFile(id, viewer, "safe.txt", "no", revision),
        status(403),
    );
    await assert.rejects(
        app.workspace.saveFile(id, scoped, "safe.txt", "no", revision),
        status(404),
    );
    await app.collab.turns(id, me, { action: "on" });
    await assert.rejects(
        app.workspace.saveFile(id, guest, "safe.txt", "no", revision),
        (error) => status(409)(error) && /driving/.test((error as Error).message),
    );
    await app.collab.turns(id, me, { action: "off" });
    assert.equal(readFileSync(file, "utf8"), "original");

    const busyApp = await openApp(
        scriptedModel(() => fauxAssistantMessage([fauxText("word ".repeat(20_000))])),
        join(root, "edit-busy-data"),
    );

    try {
        const busyId = await newSession(busyApp, cwd);

        await busyApp.commands.submit(busyId, owner(busyApp), {
            text: "busy",
            requestId: "busy-save-test",
        });
        await until(() => busyApp.isBusy(busyId), "Pi working");
        await assert.rejects(
            busyApp.workspace.saveFile(busyId, owner(busyApp), "safe.txt", "no", revision),
            (error) => status(409)(error) && /Pi is working/.test((error as Error).message),
        );
        assert.equal(readFileSync(file, "utf8"), "original");
    } finally {
        await busyApp.close();
    }
});

test("a successful write stays successful if recording the edit fails", async () => {
    const cwd = directory("edit-recording-failure");
    const file = join(cwd, "saved.txt");

    writeFileSync(file, "original");
    const id = await newSession(app, cwd);
    const note = mock.method(app.commands, "note", async () => {
        throw new Error("recording unavailable");
    });

    try {
        const result = await app.workspace.saveFile(
            id,
            owner(app),
            "saved.txt",
            "saved despite recording failure",
            digest("original"),
        );

        assert.equal(result.revision, digest("saved despite recording failure"));
        assert.match(result.warning!, /File saved/);
        assert.equal(readFileSync(file, "utf8"), "saved despite recording failure");
        assert.ok(
            (await app.harness.snapshot(ChatDoc, id, context))?.messages.some(
                (message) => message.kind === "event" && message.text === "edited saved.txt",
            ),
            "the other recorder still runs",
        );
    } finally {
        note.mock.restore();
    }
});
