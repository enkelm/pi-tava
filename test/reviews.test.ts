// Real app, HTTP, SQLite and temporary Git repositories own the review contract; no production test seams.
import {
    cleanUp,
    context,
    fakeTab,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
    type App,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
    CommentReviewDoc,
    type ChangeReviews,
    ReviewDoc,
    ReviewSnapshotDoc,
} from "../src/server/docs.ts";
import { HttpError } from "../src/server/errors.ts";
import { createHandler } from "../src/server/http.ts";

let app: App;
const data = join(root, "reviews-data");

before(async () => {
    app = await openApp(scriptedModel(), data);
});
after(async () => {
    await app.close();
    cleanUp();
});

function git(cwd: string, ...args: string[]) {
    return execFileSync("git", ["-c", "core.fsmonitor=false", ...args], { cwd, encoding: "utf8" });
}

function repo(name: string, subfolder = "scoped") {
    const folder = join(root, name);
    const cwd = join(folder, subfolder);

    mkdirSync(cwd, { recursive: true });
    git(folder, "init", "-q");
    writeFileSync(join(cwd, "code.txt"), "before\n");
    writeFileSync(join(folder, "private.txt"), "OUTSIDE_REVIEW_SECRET\n");
    git(folder, "add", ".");
    git(
        folder,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-qm",
        "baseline",
    );
    writeFileSync(join(cwd, "code.txt"), "after\n");
    writeFileSync(join(folder, "private.txt"), "OUTSIDE_REVIEW_SECRET_CHANGED\n");

    return { folder, cwd };
}

const status = (expected: number) => (error: unknown) =>
    error instanceof HttpError && error.status === expected;

// Transport owns shape, authentication, CSRF, viewer access, and committed room delivery, not internal functions.
test("HTTP and rooms expose comment-first threads to visible viewers without unlocking Files or steering", async () => {
    const { cwd, folder } = repo("http");

    mkdirSync(join(cwd, "nested"));
    writeFileSync(join(cwd, "nested", "code.txt"), "inside context\n");
    writeFileSync(join(cwd, "unchanged.txt"), "unchanged context\n");
    writeFileSync(join(cwd, "was-file.txt"), "regular file\n");
    git(folder, "add", "scoped/nested/code.txt", "scoped/unchanged.txt", "scoped/was-file.txt");
    git(
        folder,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-qm",
        "context fixtures",
    );
    const id = await newSession(app, cwd);
    const viewer = app.config.addUser("Sam", "viewer", [String(id)]);
    const guest = app.config.addUser("Alex", "guest", [String(id)]);
    const hidden = app.config.addUser("Elsewhere", "viewer", ["987654"]);
    const tab = fakeTab(id, viewer.user);
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();

    assert.ok(address !== null && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}/api/c/${id}`;
    const request = (
        suffix: string,
        body?: unknown,
        token: string | null = viewer.token,
        csrf = true,
    ) =>
        fetch(base + suffix, {
            method: body === undefined ? "GET" : "POST",
            headers: {
                "content-type": "application/json",
                ...(token === null ? {} : { authorization: `Bearer ${token}` }),
                ...(csrf ? { "x-pocket": "1" } : {}),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });

    const post = async (suffix: string, body: unknown, token = viewer.token, expected = 200) => {
        const response = await request(suffix, body, token);

        assert.equal(response.status, expected, await response.clone().text());

        return response.json();
    };

    try {
        await app.attach(tab.client);
        assert.deepEqual(await (await request("/reviews")).json(), { threads: [], rev: 0 });
        assert.equal((await request("/reviews", undefined, null)).status, 401);
        assert.equal(
            (
                await request(
                    "/reviews/comment",
                    { requestId: "csrf", text: "No" },
                    viewer.token,
                    false,
                )
            ).status,
            403,
        );
        const changes = await (await request("/reviews/changes")).json();

        assert.deepEqual(
            changes.files.map((file: { path: string }) => file.path),
            ["scoped/code.txt"],
        );
        const diff = await request("/reviews/diff?path=scoped%2Fcode.txt");

        assert.equal(diff.status, 200);
        assert.match((await diff.json()).diff, /\+after/);
        const complete = await request("/reviews/context?path=scoped%2Fcode.txt");

        assert.equal(complete.status, 200);
        assert.deepEqual(await complete.json(), { text: "after\n" });
        assert.equal(
            (await request("/reviews/context?path=scoped%2Fcode.txt", undefined, null)).status,
            401,
        );
        const outside = join(root, "context-outside");

        mkdirSync(outside);
        writeFileSync(join(outside, "code.txt"), "OUTSIDE_CONTEXT_SECRET\n");
        symlinkSync(join(folder, "private.txt"), join(cwd, "leaf-link.txt"));
        renameSync(join(cwd, "nested"), join(cwd, "former-nested"));
        symlinkSync(outside, join(cwd, "nested"));
        rmSync(join(cwd, "was-file.txt"));
        mkdirSync(join(cwd, "was-file.txt"));
        writeFileSync(join(cwd, "binary.txt"), Buffer.from([65, 0, 66]));
        writeFileSync(join(cwd, "invalid-utf8.txt"), Buffer.from([0xff, 0xfe]));
        writeFileSync(join(cwd, "oversize.txt"), "x".repeat(512 * 1024 + 1));
        const refused: [string, number][] = [
            ["private.txt", 404],
            ["scoped/unchanged.txt", 404],
            ["scoped/../private.txt", 400],
            ["scoped/leaf-link.txt", 404],
            ["scoped/nested/code.txt", 404],
            ["scoped/missing.txt", 404],
            ["scoped/was-file.txt", 404],
            ["scoped/binary.txt", 415],
            ["scoped/invalid-utf8.txt", 415],
            ["scoped/oversize.txt", 413],
        ];

        for (const [path, expected] of refused) {
            const response = await request(`/reviews/context?path=${encodeURIComponent(path)}`);

            assert.equal(response.status, expected, path);
            assert.doesNotMatch(await response.text(), /OUTSIDE_(?:REVIEW|CONTEXT)_SECRET/);
        }

        const { id: threadId } = await post("/reviews/comment", {
            requestId: "first",
            text: "Fix this",
            path: "scoped/code.txt",
            side: "new",
            line: 1,
            context: "after",
            userId: owner(app).id,
            name: "Forged",
            cwd: "/forged",
            resolved: true,
        });
        const { id: replyId } = await post(
            "/reviews/comment",
            { requestId: "reply", text: "I agree", threadId },
            guest.token,
        );

        assert.notEqual(threadId, replyId);
        await post("/reviews/resolve", {
            requestId: "author",
            threadIds: [threadId],
            resolved: true,
        });
        const saved = await (await request("/reviews")).json();

        assert.equal(saved.rev, 3);
        assert.equal(saved.threads.length, 1);
        assert.equal(saved.threads[0].id, threadId);
        assert.equal(saved.threads[0].userId, viewer.user.id);
        assert.equal(saved.threads[0].name, "Sam");
        assert.equal(saved.threads[0].cwd, cwd);
        assert.equal(saved.threads[0].context, "after");
        assert.equal(saved.threads[0].resolvedBy, viewer.user.id);
        assert.equal(saved.threads[0].replies[0].id, replyId);
        assert.equal(saved.threads[0].replies[0].userId, guest.user.id);
        await until(
            () => (tab.field("reviews") as ChangeReviews | undefined)?.rev === 3,
            "committed review delivery",
        );
        assert.deepEqual(tab.field("reviews"), saved);
        assert.doesNotMatch(JSON.stringify(saved), /requests|diff --git|OUTSIDE_REVIEW_SECRET/);

        for (const endpoint of [
            "/reviews",
            "/reviews/changes",
            "/reviews/diff?path=scoped%2Fcode.txt",
            "/reviews/context?path=scoped%2Fcode.txt",
        ]) {
            assert.equal((await request(endpoint, undefined, hidden.token)).status, 404);
        }

        await post("/reviews/comment", { requestId: "hidden", text: "No" }, hidden.token, 404);
        await post(
            "/reviews/resolve",
            { requestId: "hidden", threadIds: [threadId], resolved: true },
            hidden.token,
            404,
        );

        for (const endpoint of [
            "/changes",
            "/changes/diff?path=scoped%2Fcode.txt",
            "/view?path=code.txt",
            "/files",
        ]) {
            assert.equal((await request(endpoint)).status, 403, endpoint);
        }

        await assert.rejects(
            app.workspace.revertChange(id, viewer.user, "scoped/code.txt"),
            status(403),
        );
        await assert.rejects(
            app.commands.submit(id, viewer.user, { requestId: "steer", text: "No" }),
            status(403),
        );
        await post(
            "/reviews",
            { requestId: "obsolete", title: "No rounds" },
            app.config.ownerToken,
            404,
        );
        await post("/reviews/old/manage", { action: "close" }, app.config.ownerToken, 404);

        for (const body of [null, [], 7, "not an object", {}]) {
            await post("/reviews/comment", body, viewer.token, 400);
            await post("/reviews/resolve", body, viewer.token, 400);
        }
    } finally {
        app.detach(tab.client);
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

// SQLite serialization is the owner of concurrent writes, exactly-once retries, and all-or-nothing bulk permissions.
test("concurrent comments and replies are durable once; atomic bulk resolves respect authors and never replay over newer work", async () => {
    const { cwd } = repo("concurrency");
    const id = await newSession(app, cwd);
    const me = owner(app);
    const { user: a } = app.config.addUser("A", "viewer");
    const { user: b } = app.config.addUser("B", "viewer");
    const first = { requestId: "same", text: "First concern" };
    const results = await Promise.all(
        Array.from({ length: 12 }, () => app.reviews.comment(id, a, first)),
    );

    assert.equal(new Set(results.map((result) => result.id)).size, 1);
    const aId = results[0]!.id;
    const { id: bId } = await app.reviews.comment(id, b, first);

    assert.notEqual(aId, bId, "request IDs are scoped by author");
    await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
            app.reviews.comment(id, me, {
                requestId: `parallel-${index}`,
                text: `Reply ${index}`,
                threadId: aId,
            }),
        ),
    );
    let saved = await app.reviews.list(id, me);

    assert.equal(saved.rev, 12);
    assert.equal(saved.threads.length, 2);
    assert.equal(saved.threads[0]!.replies.length, 10);
    const before = saved;

    await assert.rejects(
        app.reviews.resolve(id, a, { requestId: "bulk", threadIds: [aId, bId], resolved: true }),
        status(403),
    );
    assert.deepEqual(await app.reviews.list(id, me), before, "unauthorized batch changes nothing");
    await assert.rejects(
        app.reviews.resolve(id, me, {
            requestId: "missing",
            threadIds: [aId, "missing"],
            resolved: true,
        }),
        status(404),
    );
    assert.deepEqual(await app.reviews.list(id, me), before, "missing target changes nothing");
    await app.reviews.resolve(id, a, { requestId: "bulk", threadIds: [aId], resolved: true });
    const resolve = { requestId: "owner-all", threadIds: [aId, bId], resolved: true };

    await app.reviews.resolve(id, me, resolve);
    await app.reviews.resolve(id, b, { requestId: "reopen", threadIds: [bId], resolved: false });
    const reopened = await app.reviews.list(id, me);

    await app.reviews.resolve(id, me, { ...resolve, threadIds: [bId, aId, aId] });
    assert.deepEqual(
        await app.reviews.list(id, me),
        reopened,
        "successful retry must not re-resolve reopened work",
    );
    await assert.rejects(app.reviews.resolve(id, me, { ...resolve, resolved: false }), status(409));
    await assert.rejects(app.reviews.comment(id, a, { ...first, text: "Different" }), status(409));
    await assert.rejects(
        app.reviews.resolve(id, a, { requestId: "same", threadIds: [aId], resolved: true }),
        status(409),
    );
    saved = await app.reviews.list(id, me);
    assert.equal(saved.threads[0]!.userId, a.id);
    assert.equal(saved.threads[0]!.resolvedBy, a.id);
    assert.equal(saved.threads[1]!.resolved, false);
    assert.equal(saved.threads[1]!.resolvedBy, undefined);
});

// Storage/reopen and actual conversation forks exercise persistence independently of transport/serialization.
test("threads and retry receipts survive restart and cwd changes; legacy rounds are ignored and forks start empty", async () => {
    const { cwd, folder } = repo("persistent");
    const id = await newSession(app, cwd);

    await say(app, id, "A forkable reply");
    // Materialize the old kinds as an older server did; reopening must retain their stored definitions.
    await app.harness.commit(async (tx) => {
        await tx.doc(ReviewDoc, id);
        (await tx.doc(ReviewSnapshotDoc, id, "legacy", {})).diffs = {
            "scoped/code.txt": "OLD_SNAPSHOT_SECRET",
        };
    }, context);
    const input = {
        requestId: "persist",
        text: "Old line",
        path: "scoped/code.txt",
        side: "new",
        line: 1,
        context: "after",
    };
    const result = await app.reviews.comment(id, owner(app), input);
    const resolution = { requestId: "resolve", threadIds: [result.id], resolved: true };

    await app.reviews.resolve(id, owner(app), resolution);
    await app.reviews.resolve(id, owner(app), {
        ...resolution,
        requestId: "reopen",
        resolved: false,
    });
    const saved = await app.reviews.list(id, owner(app));

    writeFileSync(join(cwd, "code.txt"), "changed again\n");
    await app.commands.configure(id, owner(app), { cwd: folder });
    await app.close();
    app = await openApp(scriptedModel(), data);
    assert.deepEqual(await app.reviews.list(id, owner(app)), saved);
    assert.deepEqual(await app.reviews.comment(id, owner(app), input), result);
    await app.reviews.resolve(id, owner(app), resolution);
    assert.deepEqual(await app.reviews.list(id, owner(app)), saved);
    const tab = fakeTab(id, owner(app));

    await app.attach(tab.client);
    assert.deepEqual(tab.field("reviews"), saved);
    app.detach(tab.client);
    const reply = (await app.transcripts.allEntries(id, false)).findLast(
        (entry) => entry.kind === "assistant",
    )!;
    const { id: fork } = await app.commands.fork(id, owner(app), { entryId: reply.id });

    assert.deepEqual(await app.reviews.list(fork, owner(app)), { threads: [], rev: 0 });
    await assert.rejects(
        app.reviews.comment(fork, owner(app), {
            requestId: "reply",
            text: "No inherited threads",
            threadId: result.id,
        }),
        status(404),
    );
    await app.reviews.comment(fork, owner(app), input);
    assert.equal(
        (await app.reviews.list(fork, owner(app))).rev,
        1,
        "parent retry receipts are not inherited",
    );
    assert.deepEqual(await app.reviews.list(id, owner(app)), saved);
});

// Security boundary: literal Git paths, canonical cwd aliases, cross-boundary renames, and stale advisory anchors.
test("live changes stay inside cwd for everyone and literal whitespace anchors survive disk churn without locking editing", async () => {
    const { cwd, folder } = repo("scope ", " spaced ");
    const alias = join(root, "scope-alias");

    symlinkSync(cwd, alias);
    const id = await newSession(app, alias);
    const me = owner(app);
    const { user } = app.config.addUser("Scope viewer", "viewer", [String(id)]);
    const names = [
        " leading.txt",
        "trailing.txt ",
        "tab\tfile.txt",
        "line\nfile.txt",
        "__proto__",
        "*.txt",
    ];

    for (const name of names) {
        writeFileSync(join(cwd, name), `content of ${name}\n`);
    }

    git(folder, "mv", "private.txt", " spaced /moved.txt");
    symlinkSync(folder, join(cwd, "escape"));
    const changes = await app.reviews.changes(id, user);

    assert.deepEqual(
        changes.files.map((file) => file.path).sort(),
        [...names.map((name) => ` spaced /${name}`), " spaced /code.txt", " spaced /escape"].sort(),
    );
    assert.deepEqual(
        await app.reviews.changes(id, me),
        changes,
        "owner review scope is no broader",
    );
    assert.deepEqual(changes.piOnly, []);
    assert.equal(changes.more, 0);

    for (const name of names) {
        const path = ` spaced /${name}`;

        assert.match(await app.reviews.diff(id, user, path), /content of/);
        const { id: threadId } = await app.reviews.comment(id, user, {
            requestId: name,
            text: "Literal path",
            path,
        });

        assert.equal(
            (await app.reviews.list(id, me)).threads.find((thread) => thread.id === threadId)!.path,
            path,
        );
    }

    for (const path of [
        "private.txt",
        " spaced /moved.txt",
        " spaced /escape/private.txt",
        " spaced /unchanged.txt",
    ]) {
        await assert.rejects(app.reviews.diff(id, user, path), status(404));
    }

    for (const path of [
        "../private.txt",
        " spaced /../private.txt",
        "/private.txt",
        " spaced /bad\0name",
    ]) {
        await assert.rejects(
            app.reviews.comment(id, user, { requestId: path, text: "Bad anchor", path }),
            status(400),
        );
        await assert.rejects(app.reviews.diff(id, user, path), status(400));
    }

    await assert.rejects(
        app.reviews.comment(id, user, { requestId: "outside", text: "No", path: "private.txt" }),
        status(400),
    );
    await assert.rejects(
        app.reviews.comment(id, user, {
            requestId: "escape",
            text: "No",
            path: " spaced /escape/private.txt",
        }),
        status(400),
    );
    rmSync(join(cwd, "code.txt"));
    await app.reviews.comment(id, user, {
        requestId: "stale",
        text: "From the old visible diff",
        path: " spaced /code.txt",
        side: "old",
        line: 999,
        context: "previous line text",
    });
    const stale = (await app.reviews.list(id, me)).threads.at(-1)!;

    assert.equal(stale.cwd, alias);
    assert.equal(stale.line, 999);
    assert.equal(stale.context, "previous line text");
    writeFileSync(join(cwd, "code.txt"), "editable\n");
    const view = await app.workspace.viewFile(id, me, "code.txt");

    assert.ok(view.kind === "text" && view.revision !== undefined);
    await app.workspace.saveFile(id, me, "code.txt", "edited with open comments\n", view.revision);
    assert.equal(readFileSync(join(cwd, "code.txt"), "utf8"), "edited with open comments\n");
    await assert.rejects(
        app.workspace.saveFile(id, user, "code.txt", "viewer edit\n", view.revision),
        status(403),
    );
    assert.equal((await app.reviews.list(id, me)).threads.at(-1)!.resolved, false);
});

// The shared Changes collector remains authoritative for actual tool attribution and non-Git/committed edits.
test("review Changes preserves Pi attribution and in-scope Pi-only edits in and outside Git", async () => {
    const writing = await openApp(
        scriptedModel((request) => {
            if (lastText(request as never).role === "toolResult") {
                return fauxAssistantMessage([fauxText("done")]);
            }

            return fauxAssistantMessage(
                [
                    fauxToolCall("write", { path: "code.txt", content: "Pi wrote this\n" }),
                    fauxToolCall("write", { path: "../outside.txt", content: "Outside edit\n" }),
                ],
                { stopReason: "toolUse" },
            );
        }),
        join(root, "attribution-data"),
    );

    try {
        const { folder, cwd } = repo("attribution");
        const plain = join(root, "not-git", "session");

        mkdirSync(plain, { recursive: true });

        for (const directory of [cwd, plain]) {
            const id = await newSession(writing, directory);
            const { user } = writing.config.addUser("Attribution viewer", "viewer", [String(id)]);

            await say(writing, id, "write files");
            const first = await writing.reviews.changes(id, user);

            if (directory === cwd) {
                assert.equal(
                    first.files.find((file) => file.path === "scoped/code.txt")?.byPi,
                    true,
                );
                assert.deepEqual(first.piOnly, []);
                git(folder, "add", ".");
                git(
                    folder,
                    "-c",
                    "user.name=Test",
                    "-c",
                    "user.email=test@example.com",
                    "commit",
                    "-qm",
                    "Pi edits",
                );
            } else {
                assert.equal(first.repo, undefined);
            }

            const changes = await writing.reviews.changes(id, user);

            assert.deepEqual(changes.files, []);
            assert.deepEqual(
                changes.piOnly.map((file) => file.path),
                [directory === cwd ? "scoped/code.txt" : join(plain, "code.txt")],
            );
            assert.equal(
                (await writing.transcripts.fullEntry(id, changes.piOnly[0]!.entryId))?.kind,
                "assistant",
            );
        }
    } finally {
        await writing.close();
    }
});

// Queuing behind a real harness transaction catches admission-time rechecks that a stale User object bypasses.
test("queued writes and supplied owner roles recheck current membership and role", async () => {
    const { cwd } = repo("revocation");
    const id = await newSession(app, cwd);
    const me = owner(app);
    const { user } = app.config.addUser("Temporary", "viewer", [String(id)]);
    const { user: admin } = app.config.addUser("Temporary guest", "guest");
    const { id: threadId } = await app.reviews.comment(id, user, {
        requestId: "initial",
        text: "Mine",
    });
    const resolution = { requestId: "owner", threadIds: [threadId], resolved: true };

    await app.reviews.resolve(id, me, resolution);
    app.config.updateUser(admin.id, { role: "viewer" });
    await assert.rejects(
        app.reviews.resolve(id, { ...admin, role: "owner" }, resolution),
        status(403),
    );
    let unlock!: () => void;
    let admitted!: () => void;
    const waiting = new Promise<void>((resolve) => {
        admitted = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
        unlock = resolve;
    });
    const reservation = app.harness.commit(async (tx) => {
        await tx.doc(CommentReviewDoc, id);
        admitted();
        await blocked;
    }, context);

    await waiting;
    const pending = assert.rejects(
        app.reviews.comment(id, user, { requestId: "queued", text: "No longer visible" }),
        status(404),
    );

    app.config.updateUser(user.id, { sessions: ["987654"] });
    unlock();
    await reservation;
    await pending;
    await assert.rejects(
        app.reviews.list(id, { ...user, role: "owner", sessions: undefined }),
        status(404),
    );
    await assert.rejects(app.reviews.changes(id, user), status(404));
    await assert.rejects(app.reviews.diff(id, user, "scoped/code.txt"), status(404));
    assert.equal((await app.reviews.list(id, me)).threads.length, 1);
    app.config.removeUser(user.id);
    await assert.rejects(
        app.reviews.comment(id, user, { requestId: "initial", text: "Mine" }),
        status(401),
    );
});

// Inputs and aggregate storage are bounded without evicting discussion or exhausting owner resolution capacity.
test("invalid anchors and oversized comments fail atomically; a full collaboration allowance leaves owner resolution possible", async () => {
    const id = await newSession(app);
    const me = owner(app);
    const { user } = app.config.addUser("Bounded viewer", "viewer");
    const invalid = [
        { requestId: "", text: "No retry id" },
        { requestId: "x".repeat(161), text: "Long retry id" },
        { requestId: "text", text: "x".repeat(4001) },
        { requestId: "empty", text: "   " },
        { requestId: "side", text: "No side", path: "file", line: 1 },
        { requestId: "line", text: "Bad line", path: "file", side: "new", line: 0 },
        { requestId: "huge", text: "Huge line", path: "file", side: "old", line: 10_000_001 },
        {
            requestId: "excerpt",
            text: "Huge excerpt",
            path: "file",
            side: "new",
            line: 1,
            context: "x".repeat(1001),
        },
        { requestId: "reply", text: "Replies have no anchor", threadId: "missing", path: "file" },
    ];

    for (const input of invalid) {
        await assert.rejects(
            app.reviews.comment(id, user, input),
            (error) => status(400)(error) || status(413)(error),
        );
    }

    assert.deepEqual(await app.reviews.list(id, me), { threads: [], rev: 0 });
    const ids: string[] = [];
    let full = false;

    for (let index = 0; index < 501; index++) {
        try {
            ids.push(
                (
                    await app.reviews.comment(id, user, {
                        requestId: `fill-${index}`,
                        text: "x".repeat(4000),
                    })
                ).id,
            );
        } catch (error) {
            assert.ok(status(413)(error));
            full = true;
            break;
        }
    }

    assert.ok(full && ids.length > 0);
    assert.equal((await app.reviews.list(id, me)).threads.length, ids.length);
    assert.deepEqual(
        await app.reviews.comment(id, user, { requestId: "fill-0", text: "x".repeat(4000) }),
        { id: ids[0] },
        "accepted retries remain successful at the limit",
    );
    await app.reviews.resolve(id, me, {
        requestId: "resolve-full",
        threadIds: ids,
        resolved: true,
    });
    const saved = await app.reviews.list(id, me);

    assert.equal(saved.threads.length, ids.length);
    assert.ok(saved.threads.every((thread) => thread.resolved && thread.resolvedBy === me.id));
    assert.equal(saved.threads[0]!.text.length, 4000);
});

// An actual running model distinguishes collaboration from steering/capture and guards against reintroducing idle gates.
test("viewers can start threads, read live diffs and reply while Pi is busy without a saved review", async () => {
    const { cwd } = repo("busy");
    const busy = await openApp(
        scriptedModel(() => fauxAssistantMessage([fauxText("word ".repeat(20_000))])),
        join(root, "busy-data"),
    );

    try {
        const id = await newSession(busy, cwd);
        const me = owner(busy);
        const { user } = busy.config.addUser("Busy viewer", "viewer", [String(id)]);

        await busy.commands.submit(id, me, { text: "Be busy", requestId: "busy" });
        await until(() => busy.isBusy(id), "Pi running");
        const { id: threadId } = await busy.reviews.comment(id, user, {
            requestId: "during",
            text: "Live concern",
            path: "scoped/code.txt",
            side: "new",
            line: 1,
            context: "after",
        });

        assert.match(await busy.reviews.diff(id, user, "scoped/code.txt"), /\+after/);
        writeFileSync(join(cwd, "code.txt"), "new live text\n");
        assert.match(await busy.reviews.diff(id, user, "scoped/code.txt"), /\+new live text/);
        assert.equal((await busy.reviews.changes(id, user)).files.length, 1);
        await busy.reviews.comment(id, me, {
            requestId: "busy-reply",
            text: "Will handle it",
            threadId,
        });
        await busy.reviews.resolve(id, me, {
            requestId: "busy-resolve",
            threadIds: [threadId],
            resolved: true,
        });
        assert.equal((await busy.reviews.list(id, user)).threads[0]!.replies.length, 1);
        assert.ok(busy.isBusy(id), "reviewing did not wait for or stop Pi");
    } finally {
        await busy.close();
    }
});
