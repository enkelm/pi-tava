// Queued edits use isolated InboxDoc fixtures, so no model delay or running conversation holds a test open.
import {
    type App,
    cleanUp,
    context,
    fakeTab,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, before, mock, test } from "node:test";
import {
    type ConversationId,
    InboxDoc,
    type SubmissionId,
    type UserInput,
    UserEntry,
} from "@earendil-works/pi-durable";
import type { User } from "../src/server/config.ts";
import { AuthorsDoc, TurnsDoc } from "../src/server/docs.ts";
import { ATTACHMENTS_HEADING, FILE_BLOCK, SHELL_ENTRY } from "../src/server/entry-format.ts";
import { HttpError } from "../src/server/errors.ts";
import { createHandler } from "../src/server/http.ts";
import { ownRequest } from "../src/server/requests.ts";

let app: App;
let author: User;
let viewer: User;

before(async () => {
    app = await openApp(scriptedModel(), join(root, "queued-edit-data"));
    author = app.config.addUser("Original author", "guest").user;
    viewer = app.config.addUser("Reader", "viewer").user;
});

after(async () => {
    await app?.close();
    cleanUp();
});

const status = (code: number) => (error: unknown) =>
    error instanceof HttpError && error.status === code;
const inbox = async (id: ConversationId) =>
    (await app.harness.snapshot(InboxDoc, id, context))!.items;
const receipt = async (id: SubmissionId) =>
    (await app.harness.submission(id, context))!.status(context);

/** Admit a queued fixture directly, without starting a model task. */
async function queue(
    id: ConversationId,
    content: UserInput,
    mode: "steer" | "followUp" = "steer",
    by = author,
): Promise<SubmissionId> {
    return app.harness.commit(async (tx) => {
        const doc = await tx.doc(InboxDoc, id);
        const record = await tx.createSubmission({
            conversationId: id,
            type: "input",
            status: "queued",
            requestId: ownRequest(by.id, crypto.randomUUID()),
        });

        doc.items.push({ id: record.id, mode, content });

        return record.id;
    }, context);
}

/** The input half of a final boundary: copy its content to an entry, place the receipt, and remove the item. */
async function place(id: ConversationId, submissionId: SubmissionId) {
    return app.harness.commit(async (tx) => {
        const doc = await tx.doc(InboxDoc, id);
        const index = doc.items.findIndex((item) => item.id === submissionId);
        const item = doc.items[index];

        assert.ok(item && item.mode !== "write");
        const entry = await tx.appendEntry(UserEntry, id, {
            model: [{ role: "user", content: item.content, timestamp: Date.now() }],
        });

        tx.placeSubmission(submissionId, entry.id);
        doc.items.splice(index, 1);

        return entry;
    }, context);
}

const main = "first line\n" + "a full queued draft, not truncated JSON\n".repeat(40);
const prefix = "[from: Original author] ";
const files = `${ATTACHMENTS_HEADING}- /saved/photo.png (photo.png, image/png, 123 bytes)\n- /saved/data.bin (data.bin, application/octet-stream, 456 bytes)`;
const rich = (): UserInput => [
    { type: "text", text: prefix + main + files },
    { type: "image", mimeType: "image/png", data: "original-image-bytes" },
    { type: "text", text: `${FILE_BLOCK}/work/source.ts">\noriginal inline file\n</file>` },
    { type: "image", mimeType: "image/jpeg", data: "original-mentioned-image" },
];

test("editing keeps submission IDs, order, modes, receipts and original attribution", async () => {
    const id = await newSession(app);
    const first = await queue(id, prefix + "before", "steer");
    const second = await queue(id, prefix + "follow-up", "followUp");
    const third = await queue(id, "last", "steer", owner(app));
    const before = await inbox(id);
    const records = await Promise.all([first, second, third].map(receipt));
    const authorName = author.name;

    author.name = "Renamed after submitting";

    try {
        await app.commands.editQueued(id, owner(app), first, "after", "before");
        await app.commands.editQueued(id, owner(app), second, "new follow-up", "follow-up");
    } finally {
        author.name = authorName;
    }

    assert.deepEqual(await inbox(id), [
        { ...before[0], content: prefix + "after" },
        { ...before[1], content: prefix + "new follow-up" },
        before[2],
    ]);
    assert.deepEqual(await Promise.all([first, second, third].map(receipt)), records);
    assert.equal(app.attribution.knownSubmitter(Number(first)), author.id);
    assert.equal(app.attribution.knownSubmitter(Number(second)), author.id);
    assert.equal(app.attribution.knownSubmitter(Number(third)), owner(app).id);
    assert.equal((await app.harness.inspect(context)).tasks.length, 0);

    const tab = fakeTab(id, owner(app));

    (await app.room(id)).push(tab.client, true);
    assert.ok(
        (tab.last("view")?.inbox as { hasAttachments: boolean }[]).every(
            (item) => item.hasAttachments === false,
        ),
    );
    const entry = await place(id, first);

    assert.equal(entry.model?.[0]?.content, prefix + "after");
    await until(
        async () =>
            (await app.harness.snapshot(AuthorsDoc, id, context))?.entries[String(entry.id)] ===
            author.id,
        "the original author of the placed edit",
    );
    assert.equal(app.attribution.requesterOf(id), author.id);
});

test("room input exposes the full editable main text and edits preserve attachment and inline parts", async () => {
    const id = await newSession(app);
    const content = rich();
    const submissionId = await queue(id, content, "followUp");
    const tab = fakeTab(id, owner(app));
    const room = await app.room(id);

    room.push(tab.client, true);
    assert.deepEqual(tab.last("view")?.inbox, [
        {
            id: submissionId,
            mode: "followUp",
            text: prefix + main + files,
            editableText: main,
            hasAttachments: true,
            by: author.id,
        },
    ]);
    const text = "  revised request\nkeep all attachments\n";

    await app.commands.editQueued(id, owner(app), submissionId, text, main);
    const edited = await inbox(id);

    assert.deepEqual(edited, [
        {
            id: submissionId,
            mode: "followUp",
            content: [{ type: "text", text: prefix + text + files }, ...content.slice(1)],
        },
    ]);
    await until(() => {
        room.push(tab.client, false);
        const items = tab.last("view")?.inbox as { editableText: string }[];

        return items[0]?.editableText === text;
    }, "the committed edit in the room view");
    const entry = await place(id, submissionId);

    assert.deepEqual(
        entry.model?.[0]?.content,
        edited[0]?.mode !== "write" ? edited[0]?.content : undefined,
    );
});

test("attachment-only and image-only inputs retain their content when main text is added or cleared", async () => {
    const id = await newSession(app);
    // Commands.submit trims an attachment-only body before adding the speaker prefix.
    const attachmentOnly = prefix + files.trimStart();
    const attachmentId = await queue(id, attachmentOnly);
    const imageOnly: UserInput = [
        { type: "image", mimeType: "image/png", data: "untouched" },
        { type: "text", text: `${FILE_BLOCK}/work/inline.txt">\nuntouched\n</file>` },
    ];
    const imageId = await queue(id, imageOnly);
    const tab = fakeTab(id, owner(app));
    const room = await app.room(id);

    room.push(tab.client, true);
    assert.deepEqual(
        (tab.last("view")?.inbox as { editableText: string }[]).map((item) => item.editableText),
        ["", ""],
    );
    assert.ok(
        (tab.last("view")?.inbox as { hasAttachments: boolean }[]).every(
            (item) => item.hasAttachments,
        ),
    );
    await app.commands.editQueued(id, owner(app), attachmentId, "", "");
    const unchanged = (await inbox(id)).find((item) => item.id === attachmentId);

    assert.ok(unchanged && unchanged.mode !== "write");
    assert.equal(unchanged.content, attachmentOnly);
    await app.commands.editQueued(id, owner(app), attachmentId, "explain the file", "");
    await app.commands.editQueued(id, owner(app), imageId, "describe the image", "");
    assert.deepEqual(await inbox(id), [
        { id: attachmentId, mode: "steer", content: prefix + "explain the file" + files },
        {
            id: imageId,
            mode: "steer",
            content: [{ type: "text", text: "describe the image" }, ...imageOnly],
        },
    ]);
    await app.commands.editQueued(id, owner(app), attachmentId, "", "explain the file");
    await app.commands.editQueued(id, owner(app), attachmentId, "", "explain the file");
    await app.commands.editQueued(id, owner(app), imageId, "", "describe the image");
    const items = await inbox(id);

    assert.deepEqual(items, [
        { id: attachmentId, mode: "steer", content: prefix + files },
        { id: imageId, mode: "steer", content: [{ type: "text", text: "" }, ...imageOnly] },
    ]);
});

test("viewers, nondrivers including the original author, and cross-session edits are denied", async () => {
    const id = await newSession(app);
    const other = await newSession(app);
    const scoped = app.config.addUser("Scoped guest", "guest", [String(other)]).user;
    const submissionId = await queue(id, prefix + "before");
    const before = await inbox(id);

    await assert.rejects(
        app.commands.editQueued(id, viewer, submissionId, "after", "before"),
        status(403),
    );
    await assert.rejects(
        app.commands.editQueued(id, scoped, submissionId, "after", "before"),
        status(404),
    );
    await assert.rejects(
        app.commands.editQueued(other, owner(app), submissionId, "after", "before"),
        status(404),
    );
    await app.harness.commit(async (tx) => {
        const turns = await tx.doc(TurnsDoc, id);

        turns.on = true;
        turns.driver = owner(app).id;
    }, context);
    await assert.rejects(
        app.commands.editQueued(id, author, submissionId, "after", "before"),
        status(409),
    );
    await assert.rejects(
        app.commands.editQueued(id, author, submissionId, "before", "before"),
        status(409),
    );
    assert.deepEqual(await inbox(id), before);
    await app.commands.editQueued(id, owner(app), submissionId, "after", "before");
    assert.equal((await inbox(id))[0]?.mode, "steer");
});

test("passive writes have no editableText and cannot be edited", async () => {
    const id = await newSession(app);
    const submissionId = await app.harness.commit(async (tx) => {
        const doc = await tx.doc(InboxDoc, id);
        const record = await tx.createSubmission({
            conversationId: id,
            type: "write",
            status: "queued",
        });

        doc.items.push({
            id: record.id,
            mode: "write",
            entry: { kind: SHELL_ENTRY, data: { command: "echo untouched" } },
        });

        return record.id;
    }, context);
    const before = await inbox(id);
    const tab = fakeTab(id, owner(app));

    (await app.room(id)).push(tab.client, true);
    assert.deepEqual(tab.last("view")?.inbox, [
        { id: submissionId, mode: "write", text: "$ echo untouched" },
    ]);
    await assert.rejects(
        app.commands.editQueued(id, owner(app), submissionId, "edited", "$ echo untouched"),
        status(409),
    );
    assert.deepEqual(await inbox(id), before);
});

test("stale saves conflict, identical retries succeed, and concurrent editors cannot overwrite each other", async () => {
    const id = await newSession(app);
    const submissionId = await queue(id, prefix + "original");

    await app.commands.editQueued(id, owner(app), submissionId, "first edit", "original");
    await assert.rejects(
        app.commands.editQueued(id, author, submissionId, "stale edit", "original"),
        status(409),
    );
    await app.commands.editQueued(id, owner(app), submissionId, "first edit", "original");
    const results = await Promise.allSettled([
        app.commands.editQueued(id, owner(app), submissionId, "winner A", "first edit"),
        app.commands.editQueued(id, author, submissionId, "winner B", "first edit"),
    ]);

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const conflict = results.find((result) => result.status === "rejected");

    assert.ok(conflict?.status === "rejected" && status(409)(conflict.reason));
    const text = results[0]?.status === "fulfilled" ? "winner A" : "winner B";

    assert.deepEqual(await inbox(id), [
        { id: submissionId, mode: "steer", content: prefix + text },
    ]);
    await Promise.all([
        app.commands.editQueued(id, owner(app), submissionId, "identical", text),
        app.commands.editQueued(id, author, submissionId, "identical", text),
    ]);
    await assert.rejects(
        app.commands.editQueued(id, owner(app), submissionId, "first edit", "original"),
        status(409),
    );
});

test("unknown and missing inbox items, withdrawn, placed and answered inputs cannot be edited", async () => {
    const id = await newSession(app);

    await assert.rejects(
        app.commands.editQueued(id, owner(app), Number.MAX_SAFE_INTEGER, "new", "old"),
        status(404),
    );
    const missing = await app.harness.commit(
        async (tx) =>
            (await tx.createSubmission({ conversationId: id, type: "input", status: "queued" })).id,
        context,
    );

    await assert.rejects(
        app.commands.editQueued(id, owner(app), missing, "new", "old"),
        status(409),
    );
    const withdrawn = await queue(id, "old");

    assert.equal(await app.commands.withdraw(id, author, Number(withdrawn)), "aborted");
    await assert.rejects(
        app.commands.editQueued(id, owner(app), withdrawn, "old", "old"),
        status(409),
    );
    const placed = await queue(id, "old");

    await place(id, placed);
    await assert.rejects(
        app.commands.editQueued(id, owner(app), placed, "old", "old"),
        status(409),
    );
    await app.harness.commit(async (tx) => {
        const answer = await tx.appendEntry(id, { kind: "test.answer" });

        tx.settleSubmission(placed, { status: "done", answer: answer.id });
    }, context);
    await assert.rejects(
        app.commands.editQueued(id, owner(app), placed, "new", "old"),
        status(409),
    );
});

test("a boundary that places or settles an input while an edit is admitted wins without resurrecting it", async () => {
    for (const boundary of ["placed", "settled"] as const) {
        const id = await newSession(app);
        const submissionId = await queue(id, "old");
        const admitted = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const requireDriver = app.requireDriver.bind(app);
        const gate = mock.method(app, "requireDriver", async (id: ConversationId, user: User) => {
            await requireDriver(id, user);
            admitted.resolve();
            await release.promise;
        });
        const saving = app.commands.editQueued(id, owner(app), submissionId, "new", "old");
        // Register the rejection assertion before letting the save continue.
        const rejected = assert.rejects(saving, status(409));

        try {
            await admitted.promise;

            if (boundary === "placed") {
                const entry = await place(id, submissionId);

                assert.equal(entry.model?.[0]?.content, "old");
            } else {
                // Even a stale inbox item must not make a settled receipt editable.
                await app.harness.commit(
                    (tx) =>
                        tx.settleSubmission(submissionId, {
                            status: "unanswered",
                            reason: "aborted",
                        }),
                    context,
                );
            }

            const before = await inbox(id);

            release.resolve();
            await rejected;
            assert.deepEqual(await inbox(id), before);
            assert.notEqual((await receipt(submissionId)).status, "queued");
        } finally {
            release.resolve();
            gate.mock.restore();
        }
    }
});

test("IDs, text and expectedText are validated without changing the queue", async () => {
    const id = await newSession(app);
    const submissionId = await queue(id, "old");
    const before = await inbox(id);

    for (const invalid of [
        undefined,
        null,
        false,
        "1",
        -1,
        1.5,
        NaN,
        Infinity,
        Number.MAX_SAFE_INTEGER + 1,
    ]) {
        await assert.rejects(
            app.commands.editQueued(id, owner(app), invalid, "new", "old"),
            status(400),
        );
    }

    for (const invalid of [
        undefined,
        null,
        42,
        [],
        {},
        "",
        " \n\t",
        `new${ATTACHMENTS_HEADING}fake metadata`,
        "[from: Someone else] new",
        ATTACHMENTS_HEADING.trimStart() + "fake metadata",
    ]) {
        await assert.rejects(
            app.commands.editQueued(id, owner(app), submissionId, invalid, "old"),
            status(400),
        );
    }

    for (const invalid of [undefined, null, 42, [], {}]) {
        await assert.rejects(
            app.commands.editQueued(id, owner(app), submissionId, "new", invalid),
            status(400),
        );
    }

    assert.deepEqual(await inbox(id), before);
});

test("POST edit-queued requires optimistic text and returns the client contract and conflict statuses", async () => {
    const id = await newSession(app);
    const submissionId = await queue(id, "old");
    const server = createServer(
        createHandler({
            app,
            listen: { host: "127.0.0.1", port: 0 },
            restart: () => assert.fail("no restart"),
        }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/c/${id}/edit-queued`;
    const post = (body: unknown, token = app.config.ownerToken) =>
        fetch(base, {
            method: "POST",
            headers: {
                authorization: `Bearer ${token}`,
                "x-pocket": "1",
                "content-type": "application/json",
            },
            body: JSON.stringify(body),
        });

    try {
        const response = await post({ submissionId, text: "new", expectedText: "old" });

        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { ok: true });
        assert.equal((await post({ submissionId, text: "new", expectedText: "old" })).status, 200);
        assert.equal(
            (await post({ submissionId, text: "stale", expectedText: "old" })).status,
            409,
        );
        assert.equal((await post({ submissionId, text: "new" })).status, 400);
        assert.equal(
            (await post({ submissionId: String(submissionId), text: "new", expectedText: "new" }))
                .status,
            400,
        );
        assert.equal((await post(null)).status, 400);
        assert.equal((await post([])).status, 400);
        await place(id, submissionId);
        assert.equal((await post({ submissionId, text: "new", expectedText: "new" })).status, 409);
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
        );
    }
});
