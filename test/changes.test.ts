// Changes: Pi's edits from its tool calls, and a repository's uncommitted changes with their diffs.
import {
    type App,
    cleanUp,
    context,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test, type TestContext } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId, EntryDraft } from "@earendil-works/pi-durable";
import { withCancel } from "@earendil-works/chord/context";

/** The model edits one file and writes another, as asked. */
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText("done")]);
    }

    if (text.endsWith("edit it")) {
        return fauxAssistantMessage(
            [fauxToolCall("edit", { path: "keep.txt", edits: [{ oldText: "b", newText: "c" }] })],
            { stopReason: "toolUse" },
        );
    }

    if (text.endsWith("write notes")) {
        return fauxAssistantMessage(
            [fauxToolCall("write", { path: "notes/todo.md", content: "- one\n" })],
            { stopReason: "toolUse" },
        );
    }

    if (text.endsWith("write outside")) {
        return fauxAssistantMessage(
            [fauxToolCall("write", { path: "../outside.txt", content: "x\n" })],
            { stopReason: "toolUse" },
        );
    }

    if (text.endsWith("script it")) {
        return fauxAssistantMessage(
            [
                fauxToolCall("codemode", {
                    code: 'await tools.write({ path: "scripted.txt", content: "x\\n" });\nawait tools.write({ path: "../scripted-outside.txt", content: "y\\n" });',
                }),
            ],
            { stopReason: "toolUse" },
        );
    }

    return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
};

let app: App;
const repo = join(root, "repo");
const gitIn = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

before(async () => {
    mkdirSync(repo, { recursive: true });
    gitIn("init", "-q", "--initial-branch=main");
    gitIn("config", "user.email", "t@example.com");
    gitIn("config", "user.name", "T");
    writeFileSync(join(repo, "keep.txt"), "a\nb\n");
    writeFileSync(join(repo, "other.txt"), "untouched by Pi\n");
    gitIn("add", "-A");
    gitIn("commit", "-qm", "init");
    app = await openApp(scriptedModel(route));
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("a session's changes list git's uncommitted files, mark Pi's, and give each file's diff", async () => {
    const id = await newSession(app, repo);

    await say(app, id, "edit it");
    await say(app, id, "write notes");
    await say(app, id, "write outside");
    writeFileSync(join(repo, "other.txt"), "changed by a person\n");

    const changes = await app.workspace.changes(id, owner(app));

    assert.equal(changes.repo?.root, realpathSync(repo));
    assert.equal(changes.repo?.branch, "main");
    assert.deepEqual(
        changes.files.map(({ path, kind, added, removed, byPi }) => ({
            path,
            kind,
            added,
            removed,
            byPi,
        })),
        [
            { path: "keep.txt", kind: "modified", added: 1, removed: 1, byPi: true },
            { path: "other.txt", kind: "modified", added: 1, removed: 1, byPi: false },
            {
                path: "notes/todo.md",
                kind: "new",
                added: 1,
                removed: 0,
                byPi: true,
            },
        ],
    );
    assert.deepEqual(
        changes.piOnly.map((each) => each.path),
        ["../outside.txt"],
        "outside the repository, only Pi's list has it",
    );

    assert.match(await app.workspace.changeDiff(id, owner(app), "keep.txt"), /^-b\n\+c$/m);
    assert.match(await app.workspace.changeDiff(id, owner(app), "notes/todo.md"), /^\+- one$/m);
    await assert.rejects(app.workspace.changeDiff(id, owner(app), "../outside.txt"), {
        status: 404,
    });
    await assert.rejects(app.workspace.changeDiff(id, owner(app), "/etc/passwd"), { status: 404 });
    await assert.rejects(app.workspace.changeDiff(id, owner(app), "README.md"), {
        status: 404,
        message: /no uncommitted changes/,
    });
    const viewer = app.config.addUser("Vee", "viewer").user;

    await assert.rejects(app.workspace.changes(id, viewer), { status: 403 });

    // A same-line-count rewrite still changes its version, so the browser reads the new diff.
    const versionOf = async (path: string) =>
        (await app.workspace.changes(id, owner(app))).files.find((file) => file.path === path)
            ?.version;
    const before = await versionOf("notes/todo.md");

    assert.ok(before);
    writeFileSync(join(repo, "notes/todo.md"), "- two, and longer\n");
    assert.notEqual(await versionOf("notes/todo.md"), before);
});

test("diffs read the same whatever a person's git config says", async () => {
    const id = await newSession(app, repo);

    writeFileSync(join(repo, "fresh.txt"), "new\n");
    gitIn("config", "diff.mnemonicPrefix", "true");
    gitIn("config", "color.diff", "always");

    try {
        const changed = await app.workspace.changeDiff(id, owner(app), "other.txt");
        const added = await app.workspace.changeDiff(id, owner(app), "fresh.txt");

        assert.match(changed, /^diff --git a\/other\.txt b\/other\.txt$/m);
        assert.match(added, /^\+\+\+ b\/fresh\.txt$/m);
        assert.ok(!`${changed}${added}`.includes("\u001b"), "no colors");
    } finally {
        gitIn("config", "--unset", "diff.mnemonicPrefix");
        gitIn("config", "--unset", "color.diff");
        rmSync(join(repo, "fresh.txt"));
    }
});

test("files a codemode script wrote are Pi's too, shown at the reply that ran it", async () => {
    const id = await newSession(app, repo);

    await say(app, id, "script it");
    const changes = await app.workspace.changes(id, owner(app));

    assert.equal(changes.files.find((file) => file.path === "scripted.txt")?.byPi, true);
    assert.equal(changes.more, 0);
    const [outside] = changes.piOnly.filter((each) => each.path === "../scripted-outside.txt");

    assert.equal((await app.transcripts.fullEntry(id, outside!.entryId))?.kind, "assistant");
});

/** A repository of its own, with one commit of `files`. */
function repository(name: string, files: Record<string, string>): string {
    const folder = join(root, name);

    for (const [path, text] of Object.entries(files)) {
        mkdirSync(join(folder, path, ".."), { recursive: true });
        writeFileSync(join(folder, path), text);
    }

    const git = (...args: string[]) =>
        execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", ...args], {
            cwd: folder,
        });

    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "init");

    return folder;
}

test("someone invited to one session sees the changes in its folder, not the rest of the repository", async () => {
    const shared = repository("shared", {
        "public/page.txt": "hello\n",
        "private/notes.txt": "notes\n",
    });

    writeFileSync(join(shared, "public", "page.txt"), "hello again\n");
    writeFileSync(join(shared, "private", "secret.txt"), "the secret\n");
    const id = await newSession(app, join(shared, "public"));
    const guest = app.config.addUser("Scoped", "guest", [String(id)]).user;

    assert.deepEqual(
        (await app.workspace.changes(id, guest)).files.map((file) => file.path),
        ["public/page.txt"],
    );
    assert.match(await app.workspace.changeDiff(id, guest, "public/page.txt"), /^\+hello again$/m);
    await assert.rejects(app.workspace.changeDiff(id, guest, "private/secret.txt"), {
        status: 404,
        message: /no uncommitted changes/,
    });
    assert.deepEqual(
        (await app.workspace.changes(id, owner(app))).files.map((file) => file.path),
        ["public/page.txt", "private/secret.txt"],
        "the owner sees them all",
    );
});

test("a renamed file's diff is what changed in it, under both its names", async () => {
    const moved = repository("moved", { "café.txt": "one\ntwo\nthree\n" });

    execFileSync("git", ["mv", "café.txt", "thé.txt"], { cwd: moved });
    writeFileSync(join(moved, "thé.txt"), "one\ntwo\nthree\nfour\n");
    const id = await newSession(app, moved);
    const [file] = (await app.workspace.changes(id, owner(app))).files;
    const diff = await app.workspace.changeDiff(id, owner(app), "thé.txt");

    assert.deepEqual([file?.path, file?.kind, file?.added], ["thé.txt", "renamed", 1]);
    assert.match(diff, /^rename from "caf\\303\\251\.txt"$/m);
    assert.match(diff, /^\+four$/m);
    assert.doesNotMatch(diff, /^\+one$/m, "not the whole file as new");
});

function observeHistoryReads(
    t: TestContext,
    observe: (id: ConversationId, entries: number[]) => void | Promise<void>,
) {
    const conversation = app.conversation.bind(app);

    t.mock.method(app, "conversation", async (id: ConversationId) => {
        const handle = await conversation(id);
        const entries = handle.entries.bind(handle);

        t.mock.method(handle, "entries", async (...args: Parameters<typeof entries>) => {
            const page = await entries(...args);

            await observe(
                id,
                page.items.map((entry) => Number(entry.id)),
            );

            return page;
        });

        return handle;
    });
}

// Protect the public read budget and real output, not the cache's representation or a particular query spelling.
test("Changes and native Reviews read only new history and preserve each fork's edit attribution", async (t) => {
    const folder = repository("incremental", { "keep.txt": "a\nb\n" });
    const id = await newSession(app, folder);
    const scanned: number[] = [];

    observeHistoryReads(t, (_id, entries) => {
        scanned.push(...entries);
    });
    const byPi = (changes: Awaited<ReturnType<App["workspace"]["changes"]>>) => [
        ...changes.files.filter((file) => file.byPi).map((file) => file.path),
        ...changes.piOnly.map((file) => file.path),
    ];

    await say(app, id, "edit it");
    assert.deepEqual(byPi(await app.workspace.changes(id, owner(app))), ["keep.txt"]);
    const inheritedThrough = Math.max(...scanned);

    scanned.length = 0;
    const viewer = app.config.addUser("Incremental viewer", "viewer", [String(id)]).user;

    assert.deepEqual(byPi(await app.reviews.changes(id, viewer)), ["keep.txt"]);
    assert.deepEqual(
        scanned,
        [],
        "Reviews reuse Changes' immutable history, not its filesystem result",
    );
    await say(app, id, "write notes");
    assert.deepEqual(byPi(await app.reviews.changes(id, viewer)), ["keep.txt", "notes/todo.md"]);
    assert.ok(scanned.length > 0 && scanned.every((entry) => entry > inheritedThrough));
    scanned.length = 0;
    assert.deepEqual(byPi(await app.workspace.changes(id, owner(app))), [
        "keep.txt",
        "notes/todo.md",
    ]);
    assert.deepEqual(scanned, [], "Changes also reuse the native Reviews reader's history");

    const { id: fork } = await app.commands.fork(id, owner(app), { entryId: inheritedThrough });

    assert.deepEqual(byPi(await app.reviews.changes(fork, owner(app))), ["keep.txt"]);
    await say(app, fork, "write outside");
    assert.deepEqual(byPi(await app.workspace.changes(fork, owner(app))), [
        "keep.txt",
        "../outside.txt",
    ]);
    assert.deepEqual(byPi(await app.reviews.changes(fork, owner(app))), ["keep.txt"]);
    await say(app, fork, "script it");
    const scripted = await app.workspace.changes(fork, owner(app));

    assert.deepEqual(byPi(scripted), [
        "keep.txt",
        "scripted.txt",
        "../outside.txt",
        "../scripted-outside.txt",
    ]);
    assert.deepEqual(byPi(await app.reviews.changes(fork, owner(app))), [
        "keep.txt",
        "scripted.txt",
    ]);
    const scriptEntry = scripted.piOnly.find(
        (file) => file.path === "../scripted-outside.txt",
    )!.entryId;
    const last = (await app.transcripts.allEntries(fork, false)).at(-1)!.id;
    const { id: grandchild } = await app.commands.fork(fork, owner(app), { entryId: last });
    const inherited = await app.workspace.changes(grandchild, owner(app));

    assert.deepEqual(byPi(inherited), [
        "keep.txt",
        "scripted.txt",
        "../outside.txt",
        "../scripted-outside.txt",
    ]);
    assert.equal(
        inherited.piOnly.find((file) => file.path === "../scripted-outside.txt")?.entryId,
        scriptEntry,
    );
});

test("cancelling a paged history read cannot hide older edits or repeatedly read invisible entries", async (t) => {
    const folder = repository("cancelled-history", { "keep.txt": "a\nb\n" });
    const id = await newSession(app, folder);

    await say(app, id, "edit it");
    await app.harness.commit(async (tx) => {
        for (let at = 0; at < 300; at++) {
            await tx.appendEntry(id, { kind: "pi.system" });
        }
    }, context);
    const read = withCancel(context);
    const scanned: number[] = [];
    let cancel = true;

    observeHistoryReads(t, (session, entries) => {
        if (session !== id) {
            return;
        }

        scanned.push(...entries);

        if (cancel) {
            cancel = false;
            read.cancel();
        }
    });
    await assert.rejects(app.workspace.changes(id, owner(app), read.context));
    assert.equal(
        cancel,
        false,
        "cancellation happened during history paging, not before admission",
    );
    assert.equal((await app.workspace.changes(id, owner(app))).files[0]?.byPi, true);
    scanned.length = 0;
    assert.equal((await app.reviews.changes(id, owner(app))).files[0]?.byPi, true);
    assert.deepEqual(
        scanned,
        [],
        "the newest raw entry advances the watermark even when not projected",
    );
});

test("a history read retains earlier edits when 64 other sessions are read while it waits", async (t) => {
    const folder = repository("evicted-history", { "keep.txt": "a\nb\n" });
    const id = await newSession(app, folder);

    await say(app, id, "edit it");
    assert.equal((await app.reviews.changes(id, owner(app))).files[0]?.byPi, true);
    await say(app, id, "write notes");
    const reached = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let hold = true;

    observeHistoryReads(t, async (session, entries) => {
        if (session === id && entries.length > 0 && hold) {
            hold = false;
            reached.resolve();
            await resume.promise;
        }
    });
    const pending = app.workspace.changes(id, owner(app));

    try {
        await reached.promise;

        for (let at = 0; at < 64; at++) {
            const other = await newSession(app, folder);
            const changes = await app.reviews.changes(other, owner(app));

            assert.ok(
                changes.files.every((file) => !file.byPi),
                "other sessions do not inherit attribution",
            );
        }

        resume.resolve();
        assert.deepEqual(
            (await pending).files.filter((file) => file.byPi).map((file) => file.path),
            ["keep.txt", "notes/todo.md"],
        );
        assert.deepEqual(
            (await app.reviews.changes(id, owner(app))).files
                .filter((file) => file.byPi)
                .map((file) => file.path),
            ["keep.txt", "notes/todo.md"],
        );
    } finally {
        resume.resolve();
        await pending.catch(() => {});
    }
});

// A result can arrive after a UI poll: errors must remove optimistic direct edits, and codemode keeps successful
// nested edits even when a later nested call fails. Appending real stored entries places the poll at that boundary.
test("later error and codemode results update Changes and Reviews without losing their original caller", async () => {
    const folder = repository("incremental-results", {
        "keep.txt": "a\nb\n",
        "failed.txt": "before\n",
    });
    const id = await newSession(app, folder);
    const append = (entry: EntryDraft) =>
        app.harness.commit((tx) => tx.appendEntry(id, entry), context);
    const call = await append({
        kind: "pi.assistant",
        model: [
            fauxAssistantMessage(
                [
                    fauxToolCall(
                        "edit",
                        {
                            path: "failed.txt",
                            edits: [{ oldText: "missing", newText: "replacement" }],
                        },
                        { id: "failed-edit" },
                    ),
                    fauxToolCall(
                        "codemode",
                        { code: "await tools.write(...); throw new Error('later failure');" },
                        { id: "script" },
                    ),
                ],
                { stopReason: "toolUse" },
            ),
        ],
    });

    writeFileSync(join(folder, "failed.txt"), "changed by a person\n");
    assert.equal(
        (await app.workspace.changes(id, owner(app))).files.find(
            (file) => file.path === "failed.txt",
        )?.byPi,
        true,
    );
    await append({
        kind: "pi.tool-result",
        model: [
            {
                role: "toolResult",
                toolCallId: "failed-edit",
                toolName: "edit",
                content: [{ type: "text", text: "not found" }],
                isError: true,
                timestamp: Date.now(),
            },
        ],
    });
    writeFileSync(join(folder, "scripted.txt"), "written before script failure\n");
    await append({
        kind: "pi.tool-result",
        model: [
            {
                role: "toolResult",
                toolCallId: "script",
                toolName: "codemode",
                content: [{ type: "text", text: "script failed after a successful write" }],
                isError: true,
                timestamp: Date.now(),
                details: {
                    calls: [
                        { name: "write", status: "ok", path: "scripted.txt" },
                        { name: "edit", status: "error", path: "failed.txt" },
                    ],
                },
            },
        ],
    });
    const review = await app.reviews.changes(id, owner(app));

    assert.deepEqual(
        review.files.map(({ path, byPi }) => ({ path, byPi })),
        [
            { path: "failed.txt", byPi: false },
            { path: "scripted.txt", byPi: true },
        ],
    );
    execFileSync("git", ["add", "scripted.txt"], { cwd: folder });
    execFileSync(
        "git",
        ["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-qm", "scripted edit"],
        { cwd: folder },
    );
    const changes = await app.workspace.changes(id, owner(app));

    assert.deepEqual(changes.piOnly, [{ path: "scripted.txt", entryId: Number(call.id) }]);
    assert.equal(changes.files.find((file) => file.path === "failed.txt")?.byPi, false);
    assert.deepEqual((await app.reviews.changes(id, owner(app))).piOnly, [
        { path: "scripted.txt", entryId: Number(call.id) },
    ]);
});
