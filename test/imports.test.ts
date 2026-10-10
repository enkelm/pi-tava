// Import through the real Pocket app and SQLite, with generated source files and a scripted provider only.
import {
    cleanUp,
    context,
    fakeTab,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, mock, test } from "node:test";
import type { Context } from "@earendil-works/chord";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { type Tx, UsageDoc } from "@earendil-works/pi-durable";
import { ImportedSessionDoc, ImportsDoc } from "../src/server/docs.ts";
import { createHandler } from "../src/server/http.ts";
import { MAX_IMPORT_BYTES, parsePiSession } from "../src/server/imports/pi-session.ts";
import { importFixture } from "./import-fixtures.ts";

const folder = (name: string) => {
    const path = join(work, name);

    mkdirSync(path, { recursive: true });

    return path;
};

const confirm = (
    preview: Awaited<ReturnType<Awaited<ReturnType<typeof openApp>>["imports"]["preview"]>>,
) => ({
    path: preview.path,
    sha256: preview.sha256,
    leafId: preview.leafId,
    stopped: true,
    acknowledged: true,
    model: "faux/faux-vision",
    thinkingLevel: "off",
});

after(cleanUp);

for (const mode of ["plain", "compacted", "empty-kept", "repeated"]) {
    test(`${mode}: atomic import, unchanged archive, canonical context and no phantom work/spend`, async () => {
        const fixture = importFixture(folder(mode), mode);
        const model = scriptedModel();
        const app = await openApp(model, join(root, `data-${mode}`));

        try {
            const preview = await app.imports.preview(owner(app), { path: fixture.path });
            const request = confirm(preview);
            const [first, retry] = await Promise.all([
                app.imports.create(owner(app), request),
                app.imports.create(owner(app), request),
            ]);

            assert.equal(first.id, retry.id);
            assert.equal(Number(first.existing) + Number(retry.existing), 1);
            assert.equal(app.sessions().length, 1);
            const conversation = await app.conversation(first.id);

            assert.deepEqual(
                (await conversation.context(context)).messages,
                convertToLlm(fixture.source.buildSessionContext().messages).filter(
                    (message) => message.role !== "system",
                ),
            );
            assert.deepEqual(await app.harness.snapshot(UsageDoc, first.id, context), {
                models: {},
                tools: {},
            });
            assert.equal((await app.harness.inspect(context)).tasks.length, 0);
            assert.equal(model.state.callCount, 0);
            assert.equal(await app.imports.archive(owner(app), first.id), fixture.archive);
            assert.equal(readFileSync(fixture.path, "utf8"), fixture.archive);
            const provenance = await app.harness.snapshot(ImportedSessionDoc, first.id, context);

            assert.equal(
                Object.keys(provenance!.source!.entryIds).length,
                fixture.source.getBranch().length,
            );
            assert.equal(
                app.attribution.requesterOf(first.id),
                undefined,
                "do not claim the importer authored history",
            );
        } finally {
            await app.close();
        }
    });
}

test("an explicitly selected alternate branch has its own import identity and context", async () => {
    const fixture = importFixture(folder("alternate"));
    const alternate = fixture.source
        .getEntries()
        .find(
            (entry) =>
                entry.type === "message" &&
                JSON.stringify(entry.message).includes("Unselected answer"),
        )!;
    const app = await openApp(scriptedModel(), join(root, "data-alternate"));

    try {
        const current = await app.imports.create(
            owner(app),
            confirm(await app.imports.preview(owner(app), { path: fixture.path })),
        );
        const selected = await app.imports.preview(owner(app), {
            path: fixture.path,
            leafId: alternate.id,
        });
        const imported = await app.imports.create(owner(app), confirm(selected));

        assert.notEqual(imported.id, current.id);
        const messages = JSON.stringify(
            (await (await app.conversation(imported.id)).context(context)).messages,
        );

        assert.match(messages, /ABANDONED_BRANCH/);
        assert.doesNotMatch(messages, /EDITED_CONTEXT|KEPT_HISTORY/);
        assert.equal(await app.imports.archive(owner(app), imported.id), fixture.archive);
    } finally {
        await app.close();
    }
});

test("two views, disconnected execution, restart, import retry and prompt retry use one conversation", async () => {
    const fixture = importFixture(folder("continue"));
    const model = scriptedModel((request) => {
        const serialized = JSON.stringify(request.messages);

        assert.match(serialized, /EDITED_CONTEXT/);
        assert.match(serialized, /HISTORICAL_TOOL_RESULT/);
        assert.doesNotMatch(
            serialized,
            /OLD_RUNTIME_ONLY|ABANDONED_BRANCH|OPAQUE_ARCHIVE_ONLY|OMITTED_CONTEXT/,
        );

        return fauxAssistantMessage("CONTINUED_IN_DURABLE");
    });
    const data = join(root, "data-continue");
    let app = await openApp(model, data);

    try {
        const request = confirm(await app.imports.preview(owner(app), { path: fixture.path }));
        const { id } = await app.imports.create(owner(app), request);
        const first = fakeTab(id, owner(app));
        const second = fakeTab(id, owner(app));

        await app.attach(first.client);
        await app.attach(second.client);
        const initialEntries = (tab: typeof first) =>
            tab.events.find(
                (event) =>
                    event.event === "view" &&
                    Array.isArray(event.data.entries) &&
                    event.data.entries.length > 0,
            )?.data.entries;

        assert.deepEqual(initialEntries(first), initialEntries(second));
        assert.match(JSON.stringify(first.events), /Imported user/);
        assert.doesNotMatch(JSON.stringify(first.events), /OPAQUE_ARCHIVE_ONLY|ABANDONED_BRANCH/);
        app.detach(first.client);
        const prompt = { text: "Continue please", requestId: "one-request" };
        const sent = await app.commands.submit(id, owner(app), prompt);

        assert.equal(
            (await (await app.harness.submission(sent.submissionId, context))!.wait(context))
                .status,
            "done",
        );
        await until(
            () => JSON.stringify(second.events).includes("CONTINUED_IN_DURABLE"),
            "continuation in the attached tab",
        );
        const reconnected = fakeTab(id, owner(app));

        await app.attach(reconnected.client);
        assert.match(JSON.stringify(initialEntries(reconnected)), /CONTINUED_IN_DURABLE/);
        app.detach(second.client);
        app.detach(reconnected.client);
        assert.equal(model.state.callCount, 1);
        await app.close();
        app = await openApp(model, data);
        assert.deepEqual(await app.imports.create(owner(app), request), { id, existing: true });
        assert.equal(
            (await app.commands.submit(id, owner(app), prompt)).submissionId,
            sent.submissionId,
        );
        await (await app.harness.submission(sent.submissionId, context))!.wait(context);
        assert.equal(model.state.callCount, 1);
        assert.match(
            JSON.stringify((await (await app.conversation(id)).context(context)).messages),
            /CONTINUED_IN_DURABLE/,
        );
        assert.equal(await app.imports.archive(owner(app), id), fixture.archive);
    } finally {
        await app.close();
    }
});

test("invalid input, missing confirmation, stale preview and unavailable configuration publish nothing", async () => {
    const fixture = importFixture(folder("reject"));
    const app = await openApp(scriptedModel(), join(root, "data-reject"));

    try {
        const request = confirm(await app.imports.preview(owner(app), { path: fixture.path }));

        for (const change of [
            { stopped: false },
            { acknowledged: false },
            { model: "missing/model" },
            { thinkingLevel: "nonsense" },
            { sha256: undefined },
        ]) {
            await assert.rejects(app.imports.create(owner(app), { ...request, ...change }), {
                status: 400,
            });
        }

        await assert.rejects(app.imports.preview(owner(app), { path: "relative.jsonl" }), {
            status: 400,
        });
        await assert.rejects(app.imports.preview(owner(app), { path: work }), { status: 400 });
        writeFileSync(fixture.path, fixture.archive + "\n");
        await assert.rejects(app.imports.create(owner(app), request), { status: 409 });
        assert.equal(app.sessions().length, 0);
    } finally {
        await app.close();
    }
});

test("a failed creation transaction publishes no archive, index, entries or session, and can be retried", async () => {
    const fixture = importFixture(folder("rollback"));
    const data = join(root, "data-rollback");
    let app = await openApp(scriptedModel(), data);
    const request = confirm(await app.imports.preview(owner(app), { path: fixture.path }));
    const commit = app.harness.commit.bind(app.harness);
    const fault = mock.method(
        app.harness,
        "commit",
        <T>(change: (tx: Tx) => T | Promise<T>, ctx: Context) =>
            commit(async (tx) => {
                await change(tx);

                throw new Error("injected failure before commit");
            }, ctx),
    );

    try {
        await assert.rejects(app.imports.create(owner(app), request), /injected failure/);
        fault.mock.restore();
        assert.equal(app.sessions().length, 0);
        assert.equal(await app.harness.snapshot(ImportsDoc, context), undefined);
        assert.deepEqual(
            (await app.harness.commit((tx) => tx.scanConversations({}, 100), context)).items,
            [],
        );
        await app.close();
        app = await openApp(scriptedModel(), data);
        assert.equal(app.sessions().length, 0);
        const imported = await app.imports.create(owner(app), request);

        assert.equal(imported.existing, false);
        assert.equal(await app.imports.archive(owner(app), imported.id), fixture.archive);
    } finally {
        fault.mock.restore();
        await app.close();
    }
});

test("bounded file reads preserve a missing final newline and reject invalid UTF-8 or oversized files", async () => {
    const fixture = importFixture(folder("file-limits"));
    const app = await openApp(scriptedModel(), join(root, "data-file-limits"));

    try {
        const noNewline = fixture.archive.trimEnd();

        writeFileSync(fixture.path, noNewline);
        const request = confirm(await app.imports.preview(owner(app), { path: fixture.path }));
        const { id } = await app.imports.create(owner(app), request);

        assert.equal(readFileSync(fixture.path, "utf8"), noNewline);
        assert.equal(await app.imports.archive(owner(app), id), noNewline);
        writeFileSync(fixture.path, Buffer.from([0xff]));
        await assert.rejects(app.imports.preview(owner(app), { path: fixture.path }), /UTF-8/);
        truncateSync(fixture.path, MAX_IMPORT_BYTES + 1);
        await assert.rejects(app.imports.preview(owner(app), { path: fixture.path }), /16 MiB/);
    } finally {
        await app.close();
    }
});

test("an image-containing context requires an image-capable destination", async () => {
    const fixture = importFixture(folder("text-only"));
    const model = scriptedModel();

    for (const item of model.models) {
        item.input = ["text"];
    }

    const app = await openApp(model, join(root, "data-text-only"));

    try {
        const preview = await app.imports.preview(owner(app), { path: fixture.path });

        assert.equal(preview.hasImages, true);
        await assert.rejects(app.imports.create(owner(app), confirm(preview)), /accepts images/);
        assert.equal(app.sessions().length, 0);
    } finally {
        await app.close();
    }
});

test("malformed/unsupported records, invalid trees and incomplete tools are rejected rather than repaired", () => {
    const fixture = importFixture(folder("validation"));
    const original = fixture.archive
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));

    const change = (edit: (entries: typeof original) => void) => {
        const entries = structuredClone(original);

        edit(entries);

        return entries.map((entry) => JSON.stringify(entry)).join("\n");
    };

    for (const archive of [
        fixture.archive + "{unfinished",
        change((entries) => {
            entries[0].version = 999;
        }),
        change((entries) => {
            entries[2].id = entries[1].id;
        }),
        change((entries) => {
            entries[2].parentId = "missing";
        }),
        change((entries) => {
            entries.at(-1).targetId = "missing";
        }),
        change((entries) => {
            entries.at(-1).type = "future-message";
        }),
        change((entries) => {
            entries.find((entry) => entry.message?.role === "toolResult").message.toolCallId =
                "missing";
        }),
        change((entries) => {
            entries.find((entry) => entry.message?.role === "assistant").message.stopReason =
                "unknown-future-reason";
        }),
        change((entries) => {
            entries.find((entry) => entry.message?.role === "user").message.content = [
                { type: "unknown", text: "do not drop" },
            ];
        }),
    ]) {
        assert.throws(() => parsePiSession(archive), { status: 400 });
    }

    assert.throws(() => parsePiSession(fixture.archive, "missing"), { status: 400 });
    assert.equal(readFileSync(fixture.path, "utf8"), fixture.archive);
});

test("HTTP import/archive and imported conversations are owner-only, including lists, live lists and forks", async () => {
    const fixture = importFixture(folder("http"));
    const app = await openApp(scriptedModel(), join(root, "data-http"));
    const guest = app.config.addUser("Guest", "guest");
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/`;
    const post = (path: string, body: unknown, token = app.config.ownerToken, csrf = true) =>
        fetch(base + path, {
            method: "POST",
            headers: {
                authorization: `Bearer ${token}`,
                "content-type": "application/json",
                ...(csrf ? { "x-pocket": "1" } : {}),
            },
            body: JSON.stringify(body),
        });
    const guestTab = fakeTab(undefined, guest.user);

    try {
        await app.attach(guestTab.client);
        assert.equal(
            (await post("imports/preview", { path: fixture.path }, guest.token)).status,
            403,
        );
        assert.equal(
            (await post("imports/preview", { path: fixture.path }, "invalid")).status,
            401,
        );
        assert.equal(
            (await post("imports/preview", { path: fixture.path }, app.config.ownerToken, false))
                .status,
            403,
        );
        const previewResponse = await post("imports/preview", { path: fixture.path });

        assert.equal(previewResponse.status, 200);
        const request = confirm(await previewResponse.json());

        assert.equal((await post("imports", request, guest.token)).status, 403);
        const response = await post("imports", request);

        assert.equal(response.status, 200);
        const { id } = await response.json();

        assert.equal(app.canSee(guest.user, id), false);
        assert.equal(app.sessions(guest.user).length, 0);
        const scoped = app.config.addUser("Scoped", "guest", [String(id)]);

        assert.equal(app.canSee(scoped.user, id), false);
        assert.equal(
            (
                await fetch(`${base}c/${id}/history`, {
                    headers: { authorization: `Bearer ${guest.token}` },
                })
            ).status,
            404,
        );
        assert.equal(
            (
                await fetch(`${base}imports/${id}/archive`, {
                    headers: { authorization: `Bearer ${guest.token}` },
                })
            ).status,
            403,
        );
        const archive = await fetch(`${base}imports/${id}/archive`, {
            headers: { authorization: `Bearer ${app.config.ownerToken}` },
        });

        assert.equal(archive.status, 200);
        assert.equal(await archive.text(), fixture.archive);
        const provenance = (await app.harness.snapshot(ImportedSessionDoc, id, context))!.source!;
        const { id: fork } = await app.commands.fork(id, owner(app), {
            entryId: provenance.entryIds[fixture.lastAnswer],
        });

        assert.equal(app.canSee(guest.user, fork), false);
        await until(
            () => guestTab.events.filter((event) => event.event === "sessions").length >= 2,
            "live session list",
        );
        assert.doesNotMatch(JSON.stringify(guestTab.events), /Imported http|OPAQUE_ARCHIVE_ONLY/);
    } finally {
        app.detach(guestTab.client);
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await app.close();
    }
});
