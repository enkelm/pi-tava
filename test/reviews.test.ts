// Reviews are exercised through the real app/HTTP boundary and temporary repositories, never the live checkout.
import {
    cleanUp,
    context,
    fakeTab,
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
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { ReviewDoc, ReviewSnapshotDoc, type ReviewRound } from "../src/server/docs.ts";
import { HttpError } from "../src/server/errors.ts";
import { createHandler } from "../src/server/http.ts";

let app: App;

before(async () => {
    app = await openApp(scriptedModel(), join(root, "reviews-data"));
});
after(async () => {
    await app.close();
    cleanUp();
});

function repo(name: string) {
    const folder = join(root, name);
    const cwd = join(folder, "scoped");

    mkdirSync(cwd, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: folder });
    writeFileSync(join(cwd, "code.txt"), "before\n");
    writeFileSync(join(folder, "private.txt"), "outside secret\n");
    execFileSync("git", ["add", "."], { cwd: folder });
    execFileSync(
        "git",
        ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "baseline"],
        { cwd: folder },
    );
    writeFileSync(join(cwd, "code.txt"), "after\n");
    writeFileSync(join(folder, "private.txt"), "OUTSIDE_REVIEW_SECRET\n");

    return { folder, cwd };
}

const status = (expected: number) => (error: unknown) =>
    error instanceof HttpError && error.status === expected;
const round = async (id: Parameters<App["reviews"]["list"]>[0], reviewId: string) =>
    (await app.reviews.list(id, owner(app))).items.find((item) => item.id === reviewId)!;

// Contract: independent people keep independent verdicts; HTTP cannot smuggle author identity or manage as a viewer.
// Regression: collapsing approval to one global state, trusting request userId/name, or calling requireSteer for reviews.
// No previous feature owns these contracts; use real HTTP and room delivery without a test-only production seam.
test("HTTP reviewers and visible viewers independently review, comment, reply, and receive committed metadata", async () => {
    const { cwd } = repo("multiplayer");
    const id = await newSession(app, cwd);
    const me = owner(app);
    const guest = app.config.addUser("Alex", "guest", [String(id)]);
    const viewer = app.config.addUser("Sam", "viewer", [String(id)]);
    const observer = app.config.addUser("Observer", "viewer", [String(id)]);
    const hidden = app.config.addUser("Elsewhere", "guest", ["987654"]);
    const tab = fakeTab(id, viewer.user);
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/c/${id}/reviews`;
    const request = (suffix: string, body?: unknown, token = app.config.ownerToken, csrf = true) =>
        fetch(base + suffix, {
            method: body === undefined ? "GET" : "POST",
            headers: {
                authorization: `Bearer ${token}`,
                "content-type": "application/json",
                ...(csrf ? { "x-pocket": "1" } : {}),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });

    const post = async (
        suffix: string,
        body: unknown,
        token = app.config.ownerToken,
        expected = 200,
    ) => {
        const response = await request(suffix, body, token);

        assert.equal(response.status, expected, await response.clone().text());

        return response.json();
    };

    try {
        await app.attach(tab.client);
        assert.equal((await app.hello(me)).server.localReviews, 1);
        assert.equal((await request("", {}, app.config.ownerToken, false)).status, 403);
        await post("", { requestId: "viewer-create", title: "Forbidden" }, viewer.token, 403);
        const { id: reviewId } = await post("", {
            requestId: "create",
            title: "Round one",
            name: "Fake author",
        });

        for (const payload of [null, [], 7, "not an object"]) {
            for (const endpoint of [
                "",
                `/${reviewId}/manage`,
                `/${reviewId}/submit`,
                `/${reviewId}/comment`,
                `/${reviewId}/resolve`,
            ]) {
                await post(endpoint, payload, app.config.ownerToken, 400);
            }
        }

        for (const person of [guest, viewer]) {
            await post(`/${reviewId}/manage`, { action: "assign", userId: person.user.id });
        }

        await post(
            `/${reviewId}/manage`,
            { action: ["assign"], userId: guest.user.id, reason: "Invalid action type" },
            app.config.ownerToken,
            400,
        );
        await post(
            `/${reviewId}/manage`,
            { action: "assign", userId: hidden.user.id },
            app.config.ownerToken,
            400,
        );
        await post(`/${reviewId}/manage`, { action: "close" }, viewer.token, 403);
        await post(
            `/${reviewId}/submit`,
            { state: "approved", userId: me.id },
            observer.token,
            403,
        );
        await Promise.all([
            post(
                `/${reviewId}/submit`,
                { state: "approved", text: "Looks good", userId: viewer.user.id, name: "Forged" },
                guest.token,
            ),
            post(
                `/${reviewId}/submit`,
                { state: "changes_requested", text: "Fix this" },
                viewer.token,
            ),
        ]);
        await post(
            `/${reviewId}/comment`,
            {
                requestId: "thread",
                text: "Question",
                path: "scoped/code.txt",
                side: "new",
                line: 1,
                userId: me.id,
                name: "Forged",
            },
            observer.token,
        );
        let saved = await round(id, reviewId);
        const threadId = saved.threads[0]!.id;

        await post(
            `/${reviewId}/comment`,
            { requestId: "reply", text: "Answer", threadId },
            guest.token,
        );
        await post(`/${reviewId}/resolve`, { threadId, resolved: true }, viewer.token);
        saved = await round(id, reviewId);
        assert.equal(saved.createdBy, me.id);
        assert.equal(saved.name, me.name);
        assert.equal(saved.reviewers[guest.user.id]!.state, "approved");
        assert.equal(saved.reviewers[viewer.user.id]!.state, "changes_requested");
        assert.equal(saved.reviewers[me.id]!.state, "pending");
        assert.equal(saved.threads[0]!.userId, observer.user.id);
        assert.equal(saved.threads[0]!.name, "Observer");
        assert.equal(saved.threads[0]!.replies[0]!.userId, guest.user.id);
        assert.equal(saved.threads[0]!.resolvedBy, viewer.user.id);
        assert.equal((await request("", undefined, hidden.token)).status, 404);
        const diffResponse = await request(
            `/${reviewId}/diff?path=scoped%2Fcode.txt`,
            undefined,
            viewer.token,
        );

        assert.equal(diffResponse.status, 200);
        assert.match((await diffResponse.json()).diff, /\+after/);
        assert.equal(
            (await request(`/${reviewId}/diff?path=private.txt`, undefined, viewer.token)).status,
            404,
        );
        assert.deepEqual(
            (
                await (await request("", undefined, observer.token)).json()
            ).items[0].snapshot.files.map((file: { path: string }) => file.path),
            ["scoped/code.txt"],
        );
        await until(
            () => JSON.stringify(tab.field("reviews")).includes("Answer"),
            "live review metadata",
        );
        const live = JSON.stringify(tab.field("reviews"));

        assert.doesNotMatch(live, /OUTSIDE_REVIEW_SECRET|diff --git|requests/);
        assert.match(live, /changes_requested/);
        await assert.rejects(app.workspace.changes(id, viewer.user), status(403));
        await assert.rejects(
            app.workspace.changeDiff(id, viewer.user, "scoped/code.txt"),
            status(403),
        );
        assert.match(await app.workspace.changeDiff(id, guest.user, "scoped/code.txt"), /\+after/);
        await assert.rejects(app.workspace.changeDiff(id, guest.user, "private.txt"), status(404));
        await assert.rejects(
            app.workspace.revertChange(id, viewer.user, "scoped/code.txt"),
            status(403),
        );
    } finally {
        app.detach(tab.client);
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

// Contract: owner administration is auditable, never an impersonated verdict, and closed rounds refuse new writing.
// Regression: dismissal wipes authorship/history, removed reviewers approve, or close silently overrides objections.
test("owner dismissal, removal, close overrides and reopen preserve authorship and verdict history", async () => {
    const { cwd } = repo("administration");
    const id = await newSession(app, cwd);
    const me = owner(app);
    const { user } = app.config.addUser("Reviewer", "viewer");
    const { id: rid } = await app.reviews.create(id, me, {
        requestId: "create-admin",
        title: "Owner controls",
    });

    await app.reviews.manage(id, me, rid, { action: "assign", userId: user.id });
    await app.reviews.submit(id, user, rid, {
        state: "changes_requested",
        text: "Security concern",
    });
    await app.reviews.comment(id, user, rid, { requestId: "concern", text: "Unresolved issue" });
    await assert.rejects(
        app.reviews.manage(id, me, rid, { action: "dismiss", userId: user.id }),
        status(400),
    );
    await app.reviews.manage(id, me, rid, {
        action: "dismiss",
        userId: user.id,
        reason: "Handled separately",
    });
    let saved = await round(id, rid);

    assert.equal(saved.reviewers[user.id]!.userId, user.id);
    assert.equal(saved.reviewers[user.id]!.name, user.name);
    assert.equal(saved.reviewers[user.id]!.state, "dismissed");
    assert.equal(saved.reviewers[user.id]!.text, "Security concern");
    assert.ok(
        saved.events.some(
            (item) =>
                item.userId === me.id &&
                /changes_requested.*Security concern.*Handled separately/.test(item.text),
        ),
    );
    await app.reviews.submit(id, user, rid, { state: "approved", text: "Fixed" });
    await app.reviews.manage(id, me, rid, { action: "remove", userId: user.id });
    await assert.rejects(
        app.reviews.submit(id, user, rid, { state: "changes_requested", text: "Late verdict" }),
        status(403),
    );
    saved = await round(id, rid);
    assert.equal(saved.reviewers[user.id]!.active, false);
    assert.equal(saved.reviewers[user.id]!.state, "approved");
    assert.ok(saved.events.some((item) => /Removed Reviewer.*approved.*Fixed/.test(item.text)));
    await assert.rejects(app.reviews.manage(id, me, rid, { action: "close" }), status(400));
    await app.reviews.manage(id, me, rid, {
        action: "close",
        reason: "Owner accepts this unresolved risk",
        requestId: "close",
    });
    saved = await round(id, rid);
    assert.equal(saved.status, "closed");
    assert.ok(
        saved.events.some(
            (item) =>
                item.userId === me.id &&
                /despite.*Owner accepts this unresolved risk/.test(item.text),
        ),
    );
    await assert.rejects(
        app.reviews.comment(id, me, rid, { requestId: "closed", text: "No" }),
        status(409),
    );
    await assert.rejects(app.reviews.submit(id, me, rid, { state: "approved" }), status(409));
    await assert.rejects(
        app.reviews.resolve(id, me, rid, { threadId: saved.threads[0]!.id, resolved: true }),
        status(409),
    );
    await app.reviews.manage(id, me, rid, { action: "reopen" });
    await app.reviews.manage(id, me, rid, { action: "assign", userId: user.id });
    assert.equal((await round(id, rid)).reviewers[user.id]!.state, "pending");
    await app.reviews.submit(id, user, rid, {
        state: "changes_requested",
        text: "Still needs work",
    });
    await app.reviews.resolve(id, user, rid, { threadId: saved.threads[0]!.id, resolved: true });
    await assert.rejects(
        app.reviews.manage(id, me, rid, { action: "close", reason: "   " }),
        status(400),
    );
    await app.reviews.manage(id, me, rid, {
        action: "close",
        reason: "Deliberate changes-request override",
    });
    assert.ok(
        (await round(id, rid)).events.some((item) =>
            /Deliberate changes-request override/.test(item.text),
        ),
    );
    assert.equal(readFileSync(join(cwd, "code.txt"), "utf8"), "after\n");
});

// Contract: saved complete content survives disk edits, restart, and starts empty in a real conversation fork.
// Regression: live diff fallback, truncation at the live viewer's 300k cap, non-durable bodies, or fork=current.
test("complete snapshots stay immutable after disk edits and restart, while forks start without reviews", async () => {
    const { cwd } = repo("persistence");
    const alias = join(root, "persistence-alias");

    symlinkSync(cwd, alias, "dir");
    const id = await newSession(app, alias);
    const body = "saved line\n".repeat(32_000);

    writeFileSync(join(cwd, "large.txt"), body);
    await say(app, id, "A forkable reply");
    const { id: rid } = await app.reviews.create(id, owner(app), {
        requestId: "persistent",
        title: "Persistent",
    });
    const savedDiff = await app.reviews.diff(id, owner(app), rid, "scoped/large.txt");
    const saved = await round(id, rid);

    assert.equal(saved.cwd, app.cwdOf(id));
    assert.equal(saved.cwd, alias);
    assert.equal(saved.scopePrefix, "scoped/");
    assert.ok(savedDiff.length > 300_000);
    assert.ok(savedDiff.endsWith("+saved line\n"));
    assert.ok(saved.snapshot.files.every((file) => file.version !== undefined));
    writeFileSync(join(cwd, "large.txt"), "later disk contents\n");
    await app.close();
    app = await openApp(scriptedModel(), join(root, "reviews-data"));
    assert.equal(await app.reviews.diff(id, owner(app), rid, "scoped/large.txt"), savedDiff);
    assert.deepEqual((await round(id, rid)).snapshot, saved.snapshot);
    assert.deepEqual(
        await app.reviews.create(id, owner(app), { requestId: "persistent", title: "Persistent" }),
        { id: rid },
    );
    const reply = (await app.transcripts.allEntries(id, false)).findLast(
        (entry) => entry.kind === "assistant",
    )!;
    const { id: fork } = await app.commands.fork(id, owner(app), { entryId: reply.id });

    assert.deepEqual(await app.reviews.list(fork, owner(app)), { items: [] });
    await assert.rejects(app.reviews.diff(fork, owner(app), rid, "scoped/large.txt"), status(404));
    const inherited = await app.harness.snapshot(ReviewSnapshotDoc, fork, rid, context);

    assert.ok(inherited === undefined || Object.keys(inherited.diffs).length === 0);
});

// Contract: scoped snapshots cannot contain renamed content from outside cwd; bounded captures are complete or refused.
// Regression: including a rename's old path, missing byte/file caps, or treating oversized/truncated output as valid.
test("captures reject cross-folder renames and excessive snapshots rather than leaking or truncating", async () => {
    const { folder, cwd } = repo("capture-limits");
    const id = await newSession(app, cwd);
    const me = owner(app);

    execFileSync("git", ["mv", "private.txt", "scoped/moved.txt"], { cwd: folder });
    await assert.rejects(
        app.reviews.create(id, me, { requestId: "outside-rename", title: "No leak" }),
        status(409),
    );
    const { user: scoped } = app.config.addUser("Rename reviewer", "guest", [String(id)]);

    await assert.rejects(app.workspace.changeDiff(id, scoped, "scoped/moved.txt"), status(404));
    assert.deepEqual(await app.reviews.list(id, me), { items: [] });
    execFileSync("git", ["mv", "scoped/moved.txt", "private.txt"], { cwd: folder });
    writeFileSync(join(cwd, "huge.txt"), "too big\n".repeat(300_000));
    await assert.rejects(
        app.reviews.create(id, me, { requestId: "oversize", title: "No truncation" }),
        (error) =>
            (status(409)(error) || status(413)(error)) &&
            /complete|2 MiB/.test((error as Error).message),
    );
    assert.deepEqual(await app.reviews.list(id, me), { items: [] });
    const { cwd: many } = repo("too-many-files");
    const manyId = await newSession(app, many);

    for (let i = 0; i < 100; i++) {
        writeFileSync(join(many, `${i}.txt`), "new\n");
    }

    await assert.rejects(
        app.reviews.create(manyId, me, { requestId: "too-many", title: "No omitted files" }),
        status(413),
    );
    await assert.rejects(
        app.reviews.create(id, me, { requestId: "long-title", title: "x".repeat(161) }),
        status(413),
    );
});

// Contract: receipts are persistent, optimistic revisions reject conflicts, and concurrent calls do not lose writes.
// Regression: request dedup in memory only, non-serialized doc mutation, or retry replays close over a reopened review.
test("concurrent create/comments deduplicate, revisions conflict, and old manage retries cannot close reopened rounds", async () => {
    const { cwd } = repo("concurrency");
    const id = await newSession(app, cwd);
    const me = owner(app);
    const creates = await Promise.all(
        Array.from({ length: 3 }, () =>
            app.reviews.create(id, me, { requestId: "same-create", title: "Concurrent" }),
        ),
    );
    const rid = creates[0]!.id;

    assert.ok(creates.every((item) => item.id === rid));
    assert.equal((await app.reviews.list(id, me)).items.length, 1);
    const { user } = app.config.addUser("Concurrent reviewer", "viewer");

    await app.reviews.manage(id, me, rid, { action: "assign", userId: user.id });
    await Promise.all([
        app.reviews.comment(id, me, rid, { requestId: "same-comment", text: "One comment" }),
        app.reviews.comment(id, me, rid, { requestId: "same-comment", text: "One comment" }),
        app.reviews.comment(id, user, rid, { requestId: "same-comment", text: "Another person" }),
    ]);
    let saved = await round(id, rid);

    assert.equal(saved.threads.length, 2);
    const rev = saved.rev;
    const results = await Promise.allSettled([
        app.reviews.submit(id, me, rid, {
            state: "approved",
            expectedRevision: rev,
            requestId: "verdict-one",
        }),
        app.reviews.submit(id, user, rid, {
            state: "commented",
            expectedRevision: rev,
            requestId: "verdict-two",
        }),
    ]);

    assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
    assert.ok(results.some((item) => item.status === "rejected" && status(409)(item.reason)));
    await assert.rejects(
        app.reviews.comment(id, me, rid, { requestId: "same-comment", text: "Changed payload" }),
        status(409),
    );
    await app.reviews.manage(id, me, rid, {
        action: "close",
        reason: "Reviewed elsewhere",
        requestId: "close-once",
    });
    await app.reviews.manage(id, me, rid, { action: "reopen", requestId: "reopen-once" });
    saved = await round(id, rid);
    await app.close();
    app = await openApp(scriptedModel(), join(root, "reviews-data"));
    await app.reviews.manage(id, me, rid, {
        action: "close",
        reason: "Reviewed elsewhere",
        requestId: "close-once",
    });
    await app.reviews.comment(id, me, rid, { requestId: "same-comment", text: "One comment" });
    const retried = await round(id, rid);

    assert.equal(retried.status, "open");
    assert.equal(retried.events.length, saved.events.length);
    assert.equal(retried.threads.length, 2);
});

// Contract: authorization is live at transaction admission, and assignment cannot survive removal for submission.
// Regression: trusting caller User objects or checking only before an operation waits behind another commit.
test("revoked and re-scoped callers cannot read or write, including queued verdicts", async () => {
    const { cwd } = repo("revocation");
    const id = await newSession(app, cwd);
    const me = owner(app);
    const { user } = app.config.addUser("Temporary", "viewer", [String(id)]);
    const { id: rid } = await app.reviews.create(id, me, {
        requestId: "revocation",
        title: "Access checks",
    });

    await app.reviews.manage(id, me, rid, { action: "assign", userId: user.id });
    let unlock!: () => void;
    let admitted!: () => void;
    const waiting = new Promise<void>((resolve) => {
        admitted = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
        unlock = resolve;
    });
    const reservation = app.harness.commit(async (tx) => {
        await tx.doc(ReviewDoc, id);
        admitted();
        await blocked;
    }, context);

    await waiting;
    const pending = app.reviews.submit(id, user, rid, {
        state: "approved",
        text: "Should be refused",
    });
    const rejection = assert.rejects(pending, status(404));

    app.config.updateUser(user.id, { sessions: ["987654"] });
    unlock();
    await reservation;
    await rejection;
    await assert.rejects(
        app.reviews.list(id, { ...user, role: "owner", sessions: undefined }),
        status(404),
    );
    await assert.rejects(app.reviews.diff(id, user, rid, "scoped/code.txt"), status(404));
    assert.equal((await round(id, rid)).reviewers[user.id]!.state, "pending");
    app.config.removeUser(user.id);
    await assert.rejects(
        app.reviews.comment(id, user, rid, { requestId: "removed", text: "No" }),
        status(401),
    );
});

// Contract: anchors use saved lines, dangerous record keys stay ordinary file names, and resolve is permissioned.
// Regression: prototype lookup, arbitrary-file/line comments, or unassigned unrelated viewers resolving threads.
test("saved anchors and prototype-like file paths stay bounded and unrelated viewers cannot resolve threads", async () => {
    const { folder } = repo("anchors");
    const id = await newSession(app, folder);
    const me = owner(app);
    const { user: author } = app.config.addUser("Author", "viewer");
    const { user: observer } = app.config.addUser("Not assigned", "viewer");

    writeFileSync(join(folder, "__proto__"), "ordinary file\n");
    writeFileSync(join(folder, " spaced.txt "), "spaced file\n");
    const { id: rid } = await app.reviews.create(id, me, {
        requestId: "anchors",
        title: "Anchored discussion",
    });

    assert.match(await app.reviews.diff(id, observer, rid, "__proto__"), /ordinary file/);
    await assert.rejects(
        app.reviews.comment(id, author, rid, {
            requestId: "bad-path",
            text: "No",
            path: "not-in-snapshot.txt",
        }),
        status(400),
    );
    await assert.rejects(
        app.reviews.comment(id, author, rid, {
            requestId: "bad-line",
            text: "No",
            path: "scoped/code.txt",
            side: "new",
            line: 900,
        }),
        status(400),
    );
    await assert.rejects(
        app.reviews.comment(id, author, rid, {
            requestId: "missing-side",
            text: "No",
            path: "scoped/code.txt",
            line: 1,
        }),
        status(400),
    );
    await app.reviews.comment(id, author, rid, {
        requestId: "valid",
        text: "Saved line",
        path: "scoped/code.txt",
        side: "old",
        line: 1,
    });
    const threadId = (await round(id, rid)).threads[0]!.id;

    await assert.rejects(
        app.reviews.resolve(id, observer, rid, { threadId, resolved: true }),
        status(403),
    );
    await app.reviews.resolve(id, author, rid, { threadId, resolved: true });
    assert.equal((await round(id, rid)).threads[0]!.resolvedBy, author.id);
    await app.reviews.resolve(id, me, rid, { threadId, resolved: false });
    assert.equal((await round(id, rid)).threads[0]!.resolvedBy, undefined);
    await assert.rejects(
        app.reviews.manage(id, me, rid, { action: "assign", userId: "__proto__" }),
        status(400),
    );
    const saved: ReviewRound = await round(id, rid);

    assert.equal(saved.scopePrefix, "");
    assert.deepEqual(Object.keys(saved.reviewers), [me.id]);
    assert.equal(saved.threads.length, 1);
    await app.reviews.comment(id, author, rid, {
        requestId: "exact-spaced-path",
        text: "Exact Git filename",
        path: " spaced.txt ",
        side: "new",
        line: 1,
    });
    const spaced = (await round(id, rid)).threads.at(-1)!;

    assert.equal(spaced.path, " spaced.txt ");
    assert.equal(spaced.text, "Exact Git filename");
    assert.equal(spaced.userId, author.id);
});

// Contract: non-owner collaboration cannot consume the space needed for owner administration.
// Regression: repeated thread toggles/comments fill bounded audit/metadata and prevent dismissal, removal, or close.
// Exercise limits through the app, without a production-only test knob or fabricated stored state.
test("reviewer exhaustion preserves owner audit and metadata capacity", async () => {
    const { cwd } = repo("owner-reserve");
    const limited = await openApp(scriptedModel(), join(root, "reserve-data"));

    try {
        const id = await newSession(limited, cwd);
        const me = owner(limited);
        const { user } = limited.config.addUser("Noisy reviewer", "viewer");
        const { id: rid } = await limited.reviews.create(id, me, {
            requestId: "reserve-events",
            title: "Event reserve",
        });

        await limited.reviews.manage(id, me, rid, { action: "assign", userId: user.id });
        await limited.reviews.submit(id, user, rid, {
            state: "changes_requested",
            text: "Concern",
        });
        await limited.reviews.comment(id, user, rid, { requestId: "toggle", text: "Discussion" });
        const threadId = (await limited.reviews.list(id, me)).items[0]!.threads[0]!.id;
        let toggles = 0;

        for (; toggles < 1000; toggles++) {
            try {
                await limited.reviews.resolve(id, user, rid, {
                    threadId,
                    resolved: toggles % 2 === 0,
                });
            } catch (error) {
                assert.ok(status(413)(error));
                break;
            }
        }

        assert.ok(toggles > 800 && toggles < 1000);
        await limited.reviews.manage(id, me, rid, {
            action: "dismiss",
            userId: user.id,
            reason: "Owner retained control",
        });
        await limited.reviews.manage(id, me, rid, { action: "remove", userId: user.id });
        await limited.reviews.manage(id, me, rid, {
            action: "close",
            reason: "Closing exhausted review",
        });
        const { id: second } = await limited.reviews.create(id, me, {
            requestId: "reserve-bytes",
            title: "Metadata reserve",
        });

        await limited.reviews.manage(id, me, second, { action: "assign", userId: user.id });
        await limited.reviews.submit(id, user, second, {
            state: "changes_requested",
            text: "Another concern",
        });
        let comments = 0;

        for (; comments < 500; comments++) {
            try {
                await limited.reviews.comment(id, user, second, {
                    requestId: `large-${comments}`,
                    text: "x".repeat(4000),
                });
            } catch (error) {
                assert.ok(status(413)(error));
                break;
            }
        }

        assert.ok(comments > 100 && comments < 300);
        await limited.reviews.manage(id, me, second, {
            action: "dismiss",
            userId: user.id,
            reason: "Metadata capacity remains",
        });
        await limited.reviews.manage(id, me, second, { action: "remove", userId: user.id });
        await limited.reviews.manage(id, me, second, {
            action: "close",
            reason: "Closing noisy review",
        });
        const saved = (await limited.reviews.list(id, me)).items;

        assert.ok(saved.every((item) => item.status === "closed"));
        assert.equal(saved[0]!.events.length, 903);
        assert.equal(saved[1]!.threads.length, comments);
        assert.match(saved[1]!.events.at(-1)!.text, /Closing noisy review/);
    } finally {
        await limited.close();
    }
});

// Contract: snapshots are refused while a real Pi run is active; saved rounds remain readable to assigned viewers.
// Regression: capturing files during agent writes or reusing requireDriver/requireSteer on immutable saved reads.
test("busy Pi blocks new snapshots but not saved viewer reviews", async () => {
    const { cwd } = repo("busy");
    const busyApp = await openApp(
        scriptedModel(() => fauxAssistantMessage([fauxText("word ".repeat(20_000))])),
        join(root, "busy-reviews-data"),
    );

    try {
        const id = await newSession(busyApp, cwd);
        const me = owner(busyApp);
        const { user } = busyApp.config.addUser("Busy viewer", "viewer");
        const { id: rid } = await busyApp.reviews.create(id, me, {
            requestId: "before-busy",
            title: "Idle capture",
        });

        await busyApp.reviews.manage(id, me, rid, { action: "assign", userId: user.id });
        await busyApp.commands.submit(id, me, { text: "Be busy", requestId: "busy" });
        await until(() => busyApp.isBusy(id), "Pi running");
        await assert.rejects(
            busyApp.reviews.create(id, me, { requestId: "during-busy", title: "Refused" }),
            (error) => status(409)(error) && /Pi/.test((error as Error).message),
        );
        assert.match(await busyApp.reviews.diff(id, user, rid, "scoped/code.txt"), /after/);
        await busyApp.reviews.submit(id, user, rid, {
            state: "approved",
            text: "Saved capture is okay",
        });
        assert.equal(
            (await busyApp.reviews.list(id, user)).items[0]!.reviewers[user.id]!.state,
            "approved",
        );
    } finally {
        await busyApp.close();
    }
});
