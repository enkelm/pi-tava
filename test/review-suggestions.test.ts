// Real App/Workspace and temporary files own application, authority and durable retry behavior.
import {
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
    type App,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { CommentReviewDoc } from "../src/server/docs.ts";
import { HttpError } from "../src/server/errors.ts";
import { createHandler } from "../src/server/http.ts";
import { withWorkflowPublicationLock } from "../src/server/workflow-policy.ts";

let app: App;
let calls = 0;
const data = join(root, "suggestions-data");
const model = scriptedModel(() => {
    calls++;

    throw new Error("Applying a review suggestion must not call a model");
});

before(async () => {
    app = await openApp(model, data);
});
after(async () => {
    await app.close();
    assert.equal(
        calls,
        0,
        "Review creation, application, retries and recovery made no model calls",
    );
    cleanUp();
});

const status = (expected: number, message?: RegExp) => (error: unknown) =>
    error instanceof HttpError &&
    error.status === expected &&
    (message === undefined || message.test(error.message));
const fence = (replacement: string) => `\n\n\`\`\`suggestion\n${replacement}\n\`\`\``;

async function fixture(name: string, original = "before\nfirst\nsecond\nafter\n") {
    const cwd = join(root, name);

    mkdirSync(cwd);
    const file = join(cwd, "code.txt");

    writeFileSync(file, original);
    const id = await newSession(app, cwd);
    const user = owner(app);
    const comment = (text: string, anchor = { startLine: 2, line: 3, context: "first\nsecond" }) =>
        app.reviews.comment(id, user, {
            requestId: crypto.randomUUID(),
            path: "code.txt",
            side: "new",
            ...anchor,
            text,
        });
    const apply = (
        threadId: string,
        commentId = threadId,
        index = 0,
        requestId: string = crypto.randomUUID(),
    ) => app.reviews.applySuggestion(id, user, { threadId, commentId, index, requestId });

    return { cwd, file, id, user, comment, apply };
}

test("a human applies the original inclusive NEW-side range without generating or resolving", async () => {
    const f = await fixture("apply-range");
    const { id: threadId } = await f.comment("Replace these lines:" + fence("replacement"));
    const result = await f.apply(threadId);

    assert.equal(result.status, "applied");
    assert.equal(result.by, f.user.id);
    assert.equal(readFileSync(f.file, "utf8"), "before\nreplacement\nafter\n");
    const thread = (await app.reviews.list(f.id, f.user)).threads[0]!;

    assert.deepEqual(thread.suggestions?.["0"], result);
    assert.equal(thread.resolved, false, "Applying does not resolve the discussion");
});

test("root/reply suggestions, human/PiP authors, BOM, CRLF, deletions and EOF retain exact surrounding bytes", async (t) => {
    const cases = [
        {
            name: "crlf-bom",
            source: "human-root",
            original: "\uFEFFfirst\r\nsecond\r\nafter\r\n",
            start: 1,
            end: 2,
            context: "first\r\nsecond",
            replacement: "new\nlines",
            expected: "\uFEFFnew\r\nlines\r\nafter\r\n",
        },
        {
            name: "bom-evidence",
            source: "human-root",
            original: "\uFEFFfirst\nlast\n",
            start: 1,
            end: 1,
            context: "\uFEFFfirst",
            replacement: "\uFEFFchanged",
            expected: "\uFEFFchanged\nlast\n",
        },
        {
            name: "reply-delete",
            source: "human-reply",
            original: "before\nfirst\nsecond\nafter\n",
            start: 2,
            end: 3,
            context: "first\nsecond",
            replacement: "",
            expected: "before\nafter\n",
        },
        {
            name: "pip-root",
            source: "pip-root",
            original: "first\nlast",
            start: 2,
            end: 2,
            context: "last",
            replacement: "new",
            expected: "first\nnew",
        },
        {
            name: "pip-reply",
            source: "pip-reply",
            original: "first\r\nlast",
            start: 2,
            end: 2,
            context: "last",
            replacement: "",
            expected: "first",
        },
        {
            name: "whole-delete",
            source: "human-root",
            original: "\uFEFFfirst\nlast\n",
            start: 1,
            end: 2,
            context: "first\nlast",
            replacement: "",
            expected: "\uFEFF",
        },
        {
            name: "blank-line",
            source: "human-root",
            original: "first\n\nlast\n",
            start: 2,
            end: 2,
            context: "",
            replacement: "filled",
            expected: "first\nfilled\nlast\n",
        },
    ];

    for (const item of cases) {
        await t.test(item.name, async () => {
            const f = await fixture(item.name, item.original);
            const input = {
                requestId: item.name,
                path: "code.txt",
                side: "new",
                startLine: item.start,
                line: item.end,
                context: item.context,
                text: item.source.endsWith("reply")
                    ? "Original finding"
                    : "Fix" + fence(item.replacement),
            };
            const { id: threadId } =
                item.source === "pip-root"
                    ? await app.harness.commit(
                          (tx) => app.reviews.commentAsPiP(tx, f.id, f.user, input),
                          context,
                      )
                    : await app.reviews.comment(f.id, f.user, input);
            let commentId = threadId;

            if (item.source.endsWith("reply")) {
                const reply = {
                    requestId: item.name + "-reply",
                    threadId,
                    text: "Proposed fix" + fence(item.replacement),
                };
                const result =
                    item.source === "pip-reply"
                        ? await app.harness.commit(
                              (tx) => app.reviews.commentAsPiP(tx, f.id, f.user, reply),
                              context,
                          )
                        : await app.reviews.comment(f.id, f.user, reply);

                commentId = result.id;
            }

            assert.equal((await f.apply(threadId, commentId)).status, "applied");
            assert.deepEqual(readFileSync(f.file), Buffer.from(item.expected));
            const thread = (await app.reviews.list(f.id, f.user)).threads[0]!;
            const message = threadId === commentId ? thread : thread.replies[0]!;

            assert.equal(message.suggestions?.["0"]?.status, "applied");
            assert.equal(thread.context, item.context);
        });
    }
});

test("only complete top-level exact-info fenced suggestions contribute indices", async () => {
    const f = await fixture("fence-protocol", "original\n");
    const text = [
        "> ```suggestion\n> quoted\n> ```",
        "- ```suggestion\n  list example\n  ```",
        "````markdown\n```suggestion\nnested example\n```\n````",
        "```suggestion extra\nwrong info\n```",
        "```suggestion\nfirst choice\n```",
        "~~~suggestion\nsecond choice\n~~~",
        "```suggestion\nunclosed",
    ].join("\n\n");
    const { id: threadId } = await f.comment(text, { startLine: 1, line: 1, context: "original" });

    await assert.rejects(f.apply(threadId, threadId, 2), status(400, /complete top-level/));
    assert.equal((await f.apply(threadId, threadId, 1)).status, "applied");
    assert.equal(readFileSync(f.file, "utf8"), "second choice\n");
    const thread = (await app.reviews.list(f.id, f.user)).threads[0]!;

    assert.deepEqual(Object.keys(thread.suggestions!), ["1"]);
});

test("Git-root paths in subfolder sessions apply only to that session's scope", async () => {
    const f = await fixture("repo-scope", "root file\n");

    execFileSync("git", ["init", "-q"], { cwd: f.cwd });
    mkdirSync(join(f.cwd, "sub"));
    writeFileSync(join(f.cwd, "sub", "code.txt"), "scoped\n");
    const id = await newSession(app, join(f.cwd, "sub"));
    const { id: threadId } = await app.reviews.comment(id, f.user, {
        requestId: "scoped",
        text: fence("changed"),
        path: "sub/code.txt",
        side: "new",
        line: 1,
        context: "scoped",
    });

    assert.equal(
        (
            await app.reviews.applySuggestion(id, f.user, {
                threadId,
                commentId: threadId,
                index: 0,
                requestId: "scope-apply",
            })
        ).status,
        "applied",
    );
    assert.equal(readFileSync(join(f.cwd, "sub", "code.txt"), "utf8"), "changed\n");
    assert.equal(readFileSync(f.file, "utf8"), "root file\n");
    await assert.rejects(
        app.reviews.comment(id, f.user, {
            requestId: "outside",
            text: fence("no"),
            path: "code.txt",
            side: "new",
            line: 1,
            context: "root file",
        }),
        status(400, /inside this session/),
    );
});

test("stale/partial context, old/file anchors, unsafe paths and symlinks never write", async () => {
    const f = await fixture("refused-anchors");
    const source = fence("no");
    const inputs = [
        { path: "code.txt", side: "old", line: 2, context: "first" },
        { path: "code.txt" },
        { path: "code.txt", side: "new", line: 2, context: "fir" },
        { path: "code.txt", side: "new", line: 30, context: "first" },
        { path: "code.txt", side: "new", line: 2 },
    ];

    for (const anchor of inputs) {
        const { id: threadId } = await app.reviews.comment(f.id, f.user, {
            requestId: crypto.randomUUID(),
            text: source,
            ...anchor,
        });

        await assert.rejects(f.apply(threadId), status(409));
    }

    const { id: stale } = await f.comment(source);

    writeFileSync(f.file, "before\nchanged\nsecond\nafter\n");
    await assert.rejects(f.apply(stale), status(409, /complete context/));
    assert.equal(readFileSync(f.file, "utf8"), "before\nchanged\nsecond\nafter\n");
    writeFileSync(join(f.cwd, "target.txt"), "target\n");
    symlinkSync("target.txt", join(f.cwd, "link.txt"));
    const { id: linked } = await app.reviews.comment(f.id, f.user, {
        requestId: "link",
        text: source,
        path: "link.txt",
        side: "new",
        line: 1,
        context: "target",
    });

    await assert.rejects(f.apply(linked), status(409, /symlink/));
    assert.equal(readFileSync(join(f.cwd, "target.txt"), "utf8"), "target\n");

    for (const path of ["../outside", "/absolute", "sub/../code.txt", "bad\0path"]) {
        await assert.rejects(
            app.reviews.comment(f.id, f.user, {
                requestId: crypto.randomUUID(),
                text: source,
                path,
                side: "new",
                line: 1,
                context: "before",
            }),
            status(400),
        );
    }

    assert.ok(
        (await app.reviews.list(f.id, f.user)).threads.every(
            (thread) => thread.suggestions === undefined,
        ),
    );
});

test("viewers, hidden users, non-drivers and busy conversations cannot apply", async () => {
    const f = await fixture("suggestion-permissions");
    const { id: threadId } = await f.comment(fence("no"));
    const input = { threadId, commentId: threadId, index: 0, requestId: "permissions" };
    const viewer = app.config.addUser("Viewer", "viewer", [String(f.id)]).user;
    const hidden = app.config.addUser("Hidden", "guest", ["987654"]).user;
    const guest = app.config.addUser("Guest", "guest", [String(f.id)]).user;

    await assert.rejects(app.reviews.applySuggestion(f.id, viewer, input), status(403));
    await assert.rejects(app.reviews.applySuggestion(f.id, hidden, input), status(404));
    await app.collab.turns(f.id, f.user, { action: "on" });
    await assert.rejects(
        app.reviews.applySuggestion(f.id, guest, input),
        status(409, /driv|wheel/),
    );
    await app.collab.turns(f.id, f.user, { action: "off" });
    assert.equal(readFileSync(f.file, "utf8"), "before\nfirst\nsecond\nafter\n");

    const busy = await openApp(
        scriptedModel(() => fauxAssistantMessage([fauxText("word ".repeat(20_000))])),
        join(root, "suggestion-busy-data"),
    );

    try {
        const id = await newSession(busy, f.cwd);
        const user = owner(busy);
        const { id: busyThread } = await busy.reviews.comment(id, user, {
            requestId: "busy-source",
            text: fence("no"),
            path: "code.txt",
            side: "new",
            line: 2,
            context: "first",
        });

        await busy.commands.submit(id, user, { text: "Be busy", requestId: "busy" });
        await until(() => busy.isBusy(id), "Pi working");
        await assert.rejects(
            busy.reviews.applySuggestion(id, user, {
                ...input,
                threadId: busyThread,
                commentId: busyThread,
            }),
            status(409, /Pi is working/),
        );
        assert.equal(readFileSync(f.file, "utf8"), "before\nfirst\nsecond\nafter\n");
    } finally {
        await busy.close();
    }
});

test("HTTP suggestion application retains the authenticated token while its body is delayed", async () => {
    const f = await fixture("http-revoked-suggestion", "original\n");
    const { id: threadId } = await f.comment(fence("changed"), {
        startLine: 1,
        line: 1,
        context: "original",
    });
    const handler = createHandler({
        app,
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
    });
    const input = { threadId, commentId: threadId, index: 0, requestId: "http-apply" };

    const apply = (token: string) => {
        const request = new IncomingMessage(new Socket());
        const response = new ServerResponse(request);
        let output = "";

        request.url = `/api/c/${f.id}/reviews/suggestion`;
        request.method = "POST";
        request.headers = {
            authorization: `Bearer ${token}`,
            "x-pocket": "1",
            "content-type": "application/json",
        };

        response.end = (chunk?: unknown) => {
            output = String(chunk ?? "");

            return response;
        };

        const handled = handler(request, response);

        const finish = async () => {
            request.push(Buffer.from(JSON.stringify(input)));
            request.push(null);
            await handled;

            return new Response(output, { status: response.statusCode });
        };

        return { request, finish };
    };

    const pending = apply(app.config.ownerToken);

    // The real route has authenticated and awaited conversation loading before reading the body.
    await until(() => pending.request.listenerCount("readable") > 0, "suggestion body reader");
    app.config.rotateOwnerToken();
    const rejected = await pending.finish();

    assert.equal(rejected.status, 401);
    assert.match((await rejected.json()).error, /sign-in changed/);
    assert.equal(readFileSync(f.file, "utf8"), "original\n");
    assert.equal((await app.reviews.list(f.id, owner(app))).threads[0]!.suggestions, undefined);

    // Rejection must not claim the suggestion or poison the requestId for an authorized retry.
    const accepted = await apply(app.config.ownerToken).finish();

    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).status, "applied");
    assert.equal(readFileSync(f.file, "utf8"), "changed\n");
});

test("double clicks and concurrent people never reapply replacement that starts with the original lines", async () => {
    const f = await fixture("concurrent-suggestion", "original\nafter\n");
    const { id: threadId } = await f.comment(fence("original\ninserted"), {
        startLine: 1,
        line: 1,
        context: "original",
    });
    const guest = app.config.addUser("Concurrent", "guest", [String(f.id)]).user;
    const requests = Array.from({ length: 12 }, (_, index) =>
        app.reviews.applySuggestion(f.id, index % 2 ? guest : f.user, {
            threadId,
            commentId: threadId,
            index: 0,
            requestId: `apply-${index}`,
        }),
    );
    const results = await Promise.all(requests);

    assert.ok(results.every((result) => result.status === "applied"));
    assert.ok(
        results.every((result) => result.by === results[0]!.by && result.at === results[0]!.at),
    );
    assert.equal(readFileSync(f.file, "utf8"), "original\ninserted\nafter\n");
    assert.deepEqual(await f.apply(threadId, threadId, 0, "apply-0"), results[0]);
    const { id: other } = await f.comment(fence("another"), {
        startLine: 2,
        line: 2,
        context: "inserted",
    });

    await assert.rejects(f.apply(other, other, 0, "apply-0"), status(409, /requestId/));
    assert.equal(readFileSync(f.file, "utf8"), "original\ninserted\nafter\n");
});

test("an active save serializes manual result checks and reserves the writer until settlement", async (t) => {
    const f = await fixture("pending-save", "original\n");
    const { id: threadId } = await f.comment(fence("saved"), {
        startLine: 1,
        line: 1,
        context: "original",
    });
    const save = app.workspace.saveFile.bind(app.workspace);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
        entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
        release = resolve;
    });
    const delayed = t.mock.method(
        app.workspace,
        "saveFile",
        async (...args: Parameters<typeof save>) => {
            entered();
            await blocked;

            return save(...args);
        },
    );
    const applying = f.apply(threadId, threadId, 0, "manual-check");

    await started;
    let checked = false;
    const check = f.apply(threadId, threadId, 0, "manual-check").then((result) => {
        checked = true;

        return result;
    });

    try {
        await assert.rejects(
            withWorkflowPublicationLock(app, f.id, async () => {}),
            status(409, /Local workflow writes/),
        );
        // Give the concurrent request a full read/transaction opportunity while the real save is held.
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(
            checked,
            false,
            "A manual check must wait, not reconcile pre-write bytes to uncertain",
        );
        assert.equal(
            (await app.reviews.list(f.id, f.user)).threads[0]!.suggestions?.["0"]?.status,
            "applying",
        );
    } finally {
        release();
        await Promise.all([applying, check]);
    }

    const [first, second] = await Promise.all([applying, check]);

    assert.equal(first.status, "applied");
    assert.deepEqual(second, first);
    assert.equal(delayed.mock.callCount(), 1);
    assert.equal(readFileSync(f.file, "utf8"), "saved\n");
    await withWorkflowPublicationLock(app, f.id, async () => {});
    delayed.mock.restore();
});

test("uncertain claims survive restart and only reconcile exact expected output, never retry mutation", async (t) => {
    const f = await fixture("lost-save-ack", "original\nafter\n");
    const { id: threadId } = await f.comment(fence("original\ninserted"), {
        startLine: 1,
        line: 1,
        context: "original",
    });
    const save = app.workspace.saveFile.bind(app.workspace);
    const failure = t.mock.method(
        app.workspace,
        "saveFile",
        async (...args: Parameters<typeof save>) => {
            const claimed = await app.harness.snapshot(CommentReviewDoc, f.id, context);

            assert.equal(
                claimed?.threads[0]?.suggestions?.["0"]?.status,
                "applying",
                "The claim is durable before the real filesystem save starts",
            );
            assert.equal(readFileSync(f.file, "utf8"), "original\nafter\n");
            await save(...args);

            throw new Error("The save acknowledgement was lost");
        },
    );
    const uncertain = await f.apply(threadId);

    failure.mock.restore();
    assert.equal(uncertain.status, "uncertain");
    assert.equal(readFileSync(f.file, "utf8"), "original\ninserted\nafter\n");
    await app.close();
    app = await openApp(model, data);
    const forbidSave = t.mock.method(app.workspace, "saveFile", async () => {
        throw new Error("Reconciliation must not call saveFile");
    });

    assert.equal((await f.apply(threadId)).status, "applied");
    assert.equal(forbidSave.mock.callCount(), 0);
    assert.equal(readFileSync(f.file, "utf8"), "original\ninserted\nafter\n");
    forbidSave.mock.restore();

    const unexecuted = await fixture("uncertain-no-write", "original\n");
    const { id: unexecutedThread } = await unexecuted.comment(fence("original\ninserted"), {
        startLine: 1,
        line: 1,
        context: "original",
    });
    const refused = t.mock.method(app.workspace, "saveFile", async () => {
        throw new Error("Save failed before execution; outcome cannot be assumed");
    });

    assert.equal((await unexecuted.apply(unexecutedThread)).status, "uncertain");
    refused.mock.restore();
    await app.close();
    app = await openApp(model, data);
    const noRetry = t.mock.method(app.workspace, "saveFile", async () => {
        throw new Error("An unchanged original does not permit retrying a durable claim");
    });

    assert.equal((await unexecuted.apply(unexecutedThread)).status, "uncertain");
    assert.equal(noRetry.mock.callCount(), 0);
    assert.equal(readFileSync(unexecuted.file, "utf8"), "original\n");
    noRetry.mock.restore();
});

test("a lost settlement leaves applying durable, and a restarted app confirms bytes without saving again", async (t) => {
    const f = await fixture("lost-settlement", "original\n");
    const { id: threadId } = await f.comment(fence("saved"), {
        startLine: 1,
        line: 1,
        context: "original",
    });
    const save = app.workspace.saveFile.bind(app.workspace);

    let restoreCommit = () => {};

    const delayed = t.mock.method(
        app.workspace,
        "saveFile",
        async (...args: Parameters<typeof save>) => {
            const result = await save(...args);
            const fail = t.mock.method(app.harness, "commit", async () => {
                throw new Error("Server stopped before storing the applied marker");
            });

            restoreCommit = () => fail.mock.restore();

            return result;
        },
    );

    await assert.rejects(f.apply(threadId), /Server stopped/);
    restoreCommit();
    delayed.mock.restore();
    assert.equal(
        (await app.reviews.list(f.id, f.user)).threads[0]!.suggestions?.["0"]?.status,
        "applying",
    );
    assert.equal(readFileSync(f.file, "utf8"), "saved\n");
    await app.close();
    app = await openApp(model, data);
    const spy = t.mock.method(app.workspace, "saveFile", async () => {
        throw new Error("Never repeat a claim after restart");
    });

    assert.equal((await f.apply(threadId)).status, "applied");
    assert.equal(spy.mock.callCount(), 0);
    spy.mock.restore();
});

test("cwd and canonical-folder changes invalidate the original destination, including matching namesakes", async () => {
    const f = await fixture("destination-original", "original\n");
    const { id: threadId } = await f.comment(fence("no"), {
        startLine: 1,
        line: 1,
        context: "original",
    });
    const other = join(root, "destination-namesake");

    mkdirSync(other);
    writeFileSync(join(other, "code.txt"), "original\n");
    await app.commands.configure(f.id, f.user, { cwd: other });
    await assert.rejects(f.apply(threadId), status(409, /workspace/));
    assert.equal(readFileSync(f.file, "utf8"), "original\n");
    assert.equal(readFileSync(join(other, "code.txt"), "utf8"), "original\n");
    await app.commands.configure(f.id, f.user, { cwd: f.cwd });
    renameSync(f.cwd, f.cwd + "-moved");
    mkdirSync(f.cwd);
    writeFileSync(f.file, "original\n");
    await assert.rejects(f.apply(threadId), status(409, /workspace/));
    assert.equal(readFileSync(f.file, "utf8"), "original\n");
});

test("protected app/Pi files remain ineligible even when the owner can review their text", async () => {
    for (const parent of [data, process.env.PI_CODING_AGENT_DIR!]) {
        const cwd = join(parent, "suggestion-protected");

        mkdirSync(cwd);
        const file = join(cwd, "code.txt");

        writeFileSync(file, "protected\n");
        const id = await newSession(app, cwd);
        const user = owner(app);
        const { id: threadId } = await app.reviews.comment(id, user, {
            requestId: "protected",
            text: fence("no"),
            path: "code.txt",
            side: "new",
            line: 1,
            context: "protected",
        });

        await assert.rejects(
            app.reviews.applySuggestion(id, user, {
                threadId,
                commentId: threadId,
                index: 0,
                requestId: "apply-protected",
            }),
            status(409, /eligible/),
        );
        assert.equal(readFileSync(file, "utf8"), "protected\n");
        assert.equal((await app.reviews.list(id, user)).threads[0]!.suggestions, undefined);
    }
});

test("intervening file edits conflict after the claim and cannot be overwritten or blindly retried", async (t) => {
    const f = await fixture("save-conflict", "original\n");
    const { id: threadId } = await f.comment(fence("replacement"), {
        startLine: 1,
        line: 1,
        context: "original",
    });
    const save = app.workspace.saveFile.bind(app.workspace);
    const intervening = t.mock.method(
        app.workspace,
        "saveFile",
        async (...args: Parameters<typeof save>) => {
            writeFileSync(f.file, "external edit\n");

            return save(...args);
        },
    );

    assert.equal((await f.apply(threadId)).status, "uncertain");
    assert.equal(readFileSync(f.file, "utf8"), "external edit\n");
    assert.equal((await f.apply(threadId)).status, "uncertain");
    assert.equal(
        intervening.mock.callCount(),
        1,
        "The durable claim prevents a second save even on retry",
    );
    intervening.mock.restore();
});

test("the original read destination stays pinned through Workspace save authorization awaits", async (t) => {
    const f = await fixture("inflight-destination", "original\n");
    const { id: threadId } = await f.comment(fence("no"), {
        startLine: 1,
        line: 1,
        context: "original",
    });
    const driver = app.requireDriver.bind(app);
    const save = app.workspace.saveFile.bind(app.workspace);
    let saving = false;
    let replaced = false;
    const admission = t.mock.method(
        app,
        "requireDriver",
        async (...args: Parameters<typeof driver>) => {
            await driver(...args);

            if (saving && !replaced) {
                replaced = true;
                renameSync(f.cwd, f.cwd + "-original");
                mkdirSync(f.cwd);
                writeFileSync(f.file, "original\n");
            }
        },
    );
    const recording = t.mock.method(
        app.workspace,
        "saveFile",
        async (...args: Parameters<typeof save>) => {
            saving = true;

            return save(...args);
        },
    );

    assert.equal((await f.apply(threadId)).status, "uncertain");
    assert.equal(
        replaced,
        true,
        "The directory replacement happened inside real save authorization",
    );
    assert.equal(readFileSync(f.file, "utf8"), "original\n");
    assert.equal(readFileSync(join(f.cwd + "-original", "code.txt"), "utf8"), "original\n");
    admission.mock.restore();
    recording.mock.restore();
});

test("fresh human/PiP suggestion replies can pin legacy threads without promoting the old source", async (t) => {
    for (const service of [false, true]) {
        await t.test(service ? "PiP reply" : "human reply", async () => {
            const f = await fixture(`legacy-fresh-${service}`, "original\n");
            const { id: threadId } = await f.comment(fence("old source"), {
                startLine: 1,
                line: 1,
                context: "original",
            });

            await app.harness.commit(async (tx) => {
                const doc = await tx.doc(CommentReviewDoc, f.id);

                delete doc.threads[0]!.workspace;
            }, context);
            await assert.rejects(f.apply(threadId), status(409, /destination/));
            const reply = {
                requestId: "fresh-source",
                threadId,
                text: "Fresh proposal" + fence("new source"),
            };
            const proposer = service
                ? f.user
                : app.config.addUser("Viewer proposer", "viewer", [String(f.id)]).user;
            const { id: commentId } = service
                ? await app.harness.commit(
                      (tx) => app.reviews.commentAsPiP(tx, f.id, f.user, reply),
                      context,
                  )
                : await app.reviews.comment(f.id, proposer, reply);
            const thread = (await app.reviews.list(f.id, f.user)).threads[0]!;

            assert.equal(
                thread.workspace,
                undefined,
                "A fresh reply never grants authority to the legacy root",
            );
            assert.ok(thread.replies[0]!.workspace);
            assert.equal((await f.apply(threadId, commentId)).status, "applied");
            assert.equal(readFileSync(f.file, "utf8"), "new source\n");
            await assert.rejects(f.apply(threadId), status(409, /destination/));
        });
    }
});

test("legacy fresh replies preserve exact old evidence and stay display-only on changed or deleted cwd", async () => {
    const f = await fixture("legacy-current-scope", "original\n");
    const { id: threadId } = await f.comment("Original finding", {
        startLine: 1,
        line: 1,
        context: "original",
    });

    await app.harness.commit(async (tx) => {
        const doc = await tx.doc(CommentReviewDoc, f.id);

        delete doc.threads[0]!.workspace;
    }, context);
    writeFileSync(f.file, "changed\n");
    const { id: stale } = await app.reviews.comment(f.id, f.user, {
        requestId: "fresh-stale",
        threadId,
        text: fence("no"),
    });

    await assert.rejects(f.apply(threadId, stale), status(409, /complete context/));
    assert.equal(readFileSync(f.file, "utf8"), "changed\n");
    const elsewhere = join(root, "legacy-current-elsewhere");

    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "code.txt"), "original\n");
    await app.commands.configure(f.id, f.user, { cwd: elsewhere });
    const { id: moved } = await app.reviews.comment(f.id, f.user, {
        requestId: "fresh-other-cwd",
        threadId,
        text: fence("no"),
    });
    let thread = (await app.reviews.list(f.id, f.user)).threads[0]!;

    assert.equal(thread.replies.find((reply) => reply.id === moved)!.workspace, undefined);
    await assert.rejects(f.apply(threadId, moved), status(409, /destination/));
    assert.equal(readFileSync(join(elsewhere, "code.txt"), "utf8"), "original\n");
    await app.commands.configure(f.id, f.user, { cwd: f.cwd });
    renameSync(f.cwd, f.cwd + "-deleted");
    const { id: deleted } = await app.reviews.comment(f.id, f.user, {
        requestId: "fresh-deleted-cwd",
        threadId,
        text: fence("no"),
    });

    thread = (await app.reviews.list(f.id, f.user)).threads[0]!;
    assert.equal(thread.replies.find((reply) => reply.id === deleted)!.workspace, undefined);
    assert.equal(thread.replies.find((reply) => reply.id === deleted)!.text, fence("no").trim());
});

test("legacy anchors without a captured destination remain readable but never writable", async () => {
    const f = await fixture("legacy-suggestion", "original\n");
    const { id: threadId } = await f.comment(fence("no"), {
        startLine: 1,
        line: 1,
        context: "original",
    });

    // Stored pre-feature documents legitimately lack this additive field.
    await app.harness.commit(async (tx) => {
        const doc = await tx.doc(CommentReviewDoc, f.id);

        delete doc.threads[0]!.workspace;
    }, context);
    await assert.rejects(f.apply(threadId), status(409, /destination/));
    assert.equal(readFileSync(f.file, "utf8"), "original\n");
});
