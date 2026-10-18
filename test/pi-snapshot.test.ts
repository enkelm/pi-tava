// Generated journals and real SQLite context only; copying saved bytes never controls a source Pi process.
import { cleanUp, context, root, scriptedModel, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
    appendFileSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    symlinkSync,
    truncateSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { after, test } from "node:test";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, UsageDoc } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { listSavedHistory, recentHistory } from "../src/server/pi-sessions/history.ts";
import {
    appendPiHistory,
    MAX_IMPORT_BYTES,
    parsePiSession,
    readPiSession,
} from "../src/server/pi-sessions/source.ts";
import { importFixture } from "./import-fixtures.ts";

after(cleanUp);

function fixture(name: string, mode = "plain") {
    const directory = join(work, name);

    mkdirSync(directory, { recursive: true });

    return importFixture(directory, mode);
}

function calls(...ids: string[]) {
    return fauxAssistantMessage(
        ids.map((id) => ({
            type: "toolCall",
            id,
            name: "read",
            arguments: { path: "NEVER_EXECUTE" },
        })),
        { stopReason: "toolUse" },
    );
}

function result(id: string) {
    return {
        role: "toolResult" as const,
        toolCallId: id,
        toolName: "read",
        content: [{ type: "text" as const, text: "SAVED_TOOL_RESULT" }],
        isError: false,
        timestamp: 123,
    };
}

for (const tail of ["user", "toolUse", "partialResults", "toolResult", "failed"] as const) {
    test(`${tail}: snapshot accepts only a pending tail and strict saved-file validation stays unchanged`, () => {
        const { source, path } = fixture("tail-" + tail);

        source.appendMessage({ role: "user", content: "Pending user", timestamp: 123 });

        if (tail === "failed") {
            source.appendMessage({ ...calls("failed-partial"), stopReason: "error" });
        } else if (tail !== "user") {
            source.appendMessage(calls("first", "second"));

            if (tail !== "toolUse") {
                source.appendMessage(result("first"));
            }

            if (tail === "toolResult") {
                source.appendMessage(result("second"));
            }
        }

        const archive = readFileSync(path, "utf8");
        const snapshot = parsePiSession(archive, undefined, "snapshot");
        const pending =
            tail === "toolUse" ? ["first", "second"] : tail === "partialResults" ? ["second"] : [];

        assert.equal(snapshot.mode, "snapshot");
        assert.deepEqual(
            snapshot.snapshotResults.map((message) => message.toolCallId),
            pending,
        );
        assert.equal(snapshot.archive, archive);
        assert.equal(snapshot.sha256, createHash("sha256").update(archive).digest("hex"));

        if (pending.length) {
            assert.deepEqual(snapshot.messages.slice(-pending.length), snapshot.snapshotResults);
        }

        assert.match(snapshot.warnings.join(" "), /original.*untouched.*may still be running/i);

        if (tail === "failed") {
            assert.doesNotMatch(JSON.stringify(snapshot.messages), /failed-partial/);
            assert.match(JSON.stringify(snapshot.branch), /failed-partial/);
            assert.equal(parsePiSession(archive).mode, "strict");
        } else {
            assert.throws(() => parsePiSession(archive), /saved assistant|Incomplete tool/);
        }

        for (const message of snapshot.snapshotResults) {
            assert.equal(message.isError, true);
            assert.equal(message.toolName, "read");
            assert.match(JSON.stringify(message.content), /unavailable at snapshot time/);
            assert.match(JSON.stringify(message.content), /may have run or may still run/);
            assert.doesNotMatch(JSON.stringify(message.content), /not run|did not run|never ran/i);
        }

        assert.equal(readFileSync(path, "utf8"), archive);
    });
}

test("only a final syntactically cut-off JSON object is tolerated, with exact archived bytes and selected leaf", async () => {
    const { path, archive, lastAnswer } = fixture("cut-off");
    const complete = parsePiSession(archive, lastAnswer, "snapshot");

    for (const cut of [
        '{"type":"message","id":"part',
        '{"type":"message","message":{"content":"\\u12',
        '{"type":"message","message":{"timestamp":1e',
        '{"type":"message",',
    ]) {
        const bytes = archive + cut;

        writeFileSync(path, bytes);
        const snapshot = await readPiSession(path, lastAnswer, "snapshot");

        assert.equal(snapshot.archive, bytes);
        assert.equal(snapshot.sha256, createHash("sha256").update(bytes).digest("hex"));
        assert.deepEqual(snapshot.messages, complete.messages);
        assert.equal(snapshot.leafId, lastAnswer);
        assert.match(snapshot.warnings.join(" "), /final cut-off JSONL record.*retained exactly/);
        assert.equal(readFileSync(path, "utf8"), bytes);
        assert.throws(() => parsePiSession(bytes), /Malformed JSONL/);
    }

    for (const suffix of [
        "{broken",
        '{"x":wat',
        '{"x":"\\x',
        '{"x":01',
        '{"x":true,}',
        '{"type":\n',
        '{"type":\n{"next":"record"}',
        '{"type":"message"}',
    ]) {
        assert.throws(
            () => parsePiSession(archive + suffix, undefined, "snapshot"),
            { status: 400 },
            suffix,
        );
    }

    assert.deepEqual(
        parsePiSession(archive.trimEnd(), undefined, "snapshot").messages,
        parsePiSession(archive).messages,
    );
    const records = archive
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));

    records.find((entry) => entry.message?.content === "ABANDONED_BRANCH").message.content = [
        { type: "future-content" },
    ];
    assert.throws(
        () =>
            parsePiSession(
                records.map((entry) => JSON.stringify(entry)).join("\n"),
                lastAnswer,
                "snapshot",
            ),
        /Unsupported user content/,
        "an earlier selection must not hide a malformed complete unselected record",
    );
});

for (const malformed of [
    "missing-middle",
    "orphan",
    "reordered",
    "failed-interleaved",
    "compacted-missing",
] as const) {
    test(`${malformed}: snapshot never repairs interior tool history`, () => {
        const { source, path } = fixture("bad-tools-" + malformed);

        if (malformed === "orphan") {
            source.appendMessage(result("orphan"));
        } else {
            source.appendMessage(calls("first", "second"));

            if (malformed === "reordered") {
                source.appendMessage(result("second"));
                source.appendMessage(result("first"));
            } else if (malformed === "failed-interleaved") {
                source.appendMessage({ ...calls("failed-partial"), stopReason: "aborted" });
            } else {
                source.appendMessage({
                    role: "user",
                    content: "An illegal next turn",
                    timestamp: 123,
                });
            }
        }

        if (malformed === "compacted-missing") {
            source.appendCompaction("Hides incomplete tools only in the projection", null, 100);
        }

        source.appendMessage(fauxAssistantMessage("Saved after invalid history"));
        assert.throws(
            () => parsePiSession(readFileSync(path, "utf8"), undefined, "snapshot"),
            /tool result|interleaved tool/,
        );
    });
}

test("snapshot validates every complete branch and never synthesizes results for calls introduced or orphaned by edits", () => {
    const { source, path, lastAnswer } = fixture("edited-tools");
    const anchor = source.getLeafId()!;
    const assistant = source.appendMessage(calls("saved"));
    const tool = source.appendMessage(result("saved"));

    source.appendContextEdit(tool, null);
    assert.throws(
        () => parsePiSession(readFileSync(path, "utf8"), undefined, "snapshot"),
        /outside the pending snapshot tail/,
    );
    source.branch(anchor);
    source.appendContextEdit(lastAnswer, {
        content: [{ type: "toolCall", id: "invented", name: "read", arguments: {} }],
    });
    assert.throws(
        () => parsePiSession(readFileSync(path, "utf8"), undefined, "snapshot"),
        /outside the pending snapshot tail/,
    );
    source.branch(anchor);
    source.appendContextEdit(lastAnswer, null);
    const records = readFileSync(path, "utf8")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));

    records.at(-1).targetId = assistant;
    assert.throws(
        () =>
            parsePiSession(
                records.map((entry) => JSON.stringify(entry)).join("\n"),
                lastAnswer,
                "snapshot",
            ),
        /not an earlier editable message/,
        "a context edit outside its branch must reject even when a different leaf is selected",
    );

    const other = fixture("unselected-orphan");
    const selected = other.source.getLeafId()!;

    other.source.appendMessage(result("unselected-orphan"));
    assert.throws(
        () => parsePiSession(readFileSync(other.path, "utf8"), selected, "snapshot"),
        /tool result/,
    );
});

for (const mode of ["plain", "compacted", "empty-kept", "repeated"]) {
    test(`${mode}: SQLite copy has canonical context plus unavailable-result context, survives reopen and starts no work`, async () => {
        const { source, path } = fixture("sqlite-" + mode, mode);

        source.appendMessage({
            role: "user",
            content: [{ type: "image", mimeType: "image/png", data: "SAVED_IMAGE" }],
            timestamp: 123,
        });
        source.appendMessage({ ...calls("failed-partial"), stopReason: "error" });
        source.appendMessage(calls("completed", "unavailable"));
        source.appendMessage(result("completed"));
        const archive = readFileSync(path, "utf8");
        const snapshot = await readPiSession(path, undefined, "snapshot");
        const expected = convertToLlm(source.buildSessionContext().messages).filter(
            (message) =>
                message.role !== "system" &&
                !(message.role === "assistant" && message.stopReason === "error"),
        );
        const synthetic = snapshot.snapshotResults[0]!;

        assert.equal(snapshot.hasImages, true);
        assert.equal(snapshot.snapshotResults.length, 1);
        assert.equal(synthetic.toolCallId, "unavailable");
        assert.deepEqual(snapshot.messages, [...expected, synthetic]);
        assert.equal(
            recentHistory(snapshot).some((entry) => entry.text.includes("unavailable at snapshot")),
            false,
        );
        const model = scriptedModel();
        const models = createModels();

        models.setProvider(model.provider);
        const data = join(root, "snapshot-" + mode + ".sqlite");
        const open = async () =>
            Harness.open(
                await openNodeSqliteStorage(data),
                { models, registry: createRegistry() },
                context,
            );
        let harness = await open();

        try {
            const conversation = await harness.root(context);
            const id = conversation.id;
            const ids = await harness.commit((tx) => appendPiHistory(tx, id, snapshot), context);

            assert.deepEqual((await conversation.context(context)).messages, [
                ...expected,
                synthetic,
            ]);
            assert.equal(Object.keys(ids).length, source.getBranch().length);
            const entries = await conversation.entries(
                { order: "ascending" },
                200,
                undefined,
                context,
            );

            assert.match(JSON.stringify(entries.items), /failed-partial/);
            assert.equal(
                entries.items.filter(
                    (entry) =>
                        entry.data &&
                        typeof entry.data === "object" &&
                        !Array.isArray(entry.data) &&
                        entry.data.synthetic,
                ).length,
                1,
            );
            assert.deepEqual(await harness.snapshot(UsageDoc, id, context), {
                models: {},
                tools: {},
            });
            assert.equal((await harness.inspect(context)).tasks.length, 0);
            assert.equal(model.state.callCount, 0);
            assert.equal(readFileSync(path, "utf8"), archive);
            await harness.close(context);
            harness = await open();
            assert.deepEqual(
                (await (await harness.conversation(id, context))!.context(context)).messages,
                [...expected, synthetic],
            );
            assert.equal((await harness.inspect(context)).tasks.length, 0);
            assert.equal(model.state.callCount, 0);
        } finally {
            await harness.close(context);
        }
    });
}

test("configured flat roots and ordinary project roots discover pending snapshots, bounded metadata and optional exclusions", async () => {
    const { source, path } = fixture("custom-root");

    source.appendSessionInfo("");
    source.appendMessage({ role: "user", content: "Still running", timestamp: 123 });
    const archive = readFileSync(path, "utf8") + '{"type":"message","id":"cut';
    const custom = join(root, "custom-sessions");

    mkdirSync(join(custom, "project"), { recursive: true });
    const flat = join(custom, "flat.jsonl");
    const nested = join(custom, "project", "nested.jsonl");

    writeFileSync(flat, archive);
    writeFileSync(nested, archive);
    utimesSync(flat, 100, 100);
    utimesSync(nested, 200, 200);
    const canonicalRoot = realpathSync(custom);
    const list = await listSavedHistory(
        new Set(),
        ["Optional Herdr discovery unavailable"],
        custom,
    );

    assert.equal(list.directory, canonicalRoot);
    assert.deepEqual(
        list.sessions.map((item) => item.path),
        [realpathSync(nested), realpathSync(flat)],
    );
    assert.equal(list.sessions[0]!.title, "OLD_HISTORY");
    assert.match(list.warnings.join(" "), /original Pi may still be running/);
    assert.match(list.warnings.join(" "), /Optional Herdr discovery unavailable/);
    const parsed = parsePiSession(archive, undefined, "snapshot");

    assert.equal(list.sessions[0]!.sourceSessionId, parsed.header.id);
    assert.equal(list.sessions[0]!.sha256, createHash("sha256").update(archive).digest("hex"));
    assert.equal(list.sessions[0]!.leafId, parsed.leafId);
    assert.ok(JSON.stringify(list).length < 4000);
    const excluded = await listSavedHistory(new Set([realpathSync(flat)]), [], custom);

    assert.deepEqual(
        excluded.sessions.map((item) => item.path),
        [realpathSync(nested)],
    );
    assert.match(excluded.warnings.join(" "), /known Herdr session files were omitted/);
    assert.equal(readFileSync(flat, "utf8"), archive);

    const defaults = join(process.env.PI_CODING_AGENT_DIR!, "sessions", "project");

    mkdirSync(defaults, { recursive: true });
    writeFileSync(join(defaults, "default.jsonl"), archive);
    assert.equal(
        (await listSavedHistory()).sessions[0]!.path,
        realpathSync(join(defaults, "default.jsonl")),
    );
});

test("discovery rejects links, deep traversal, oversized and malformed candidates, and retains only the newest 100", async () => {
    const { archive } = fixture("discovery-safety");
    const directory = join(root, "bounded-sessions");
    const outside = join(root, "outside-snapshot.jsonl");

    mkdirSync(join(directory, "project", "deep"), { recursive: true });
    writeFileSync(outside, archive);
    symlinkSync(outside, join(directory, "linked.jsonl"));
    symlinkSync(join(root, "work"), join(directory, "linked-project"));
    writeFileSync(join(directory, "project", "deep", "hidden.jsonl"), archive);
    writeFileSync(join(directory, "malformed.jsonl"), archive + "{broken");
    const oversized = join(directory, "oversized.jsonl");

    writeFileSync(oversized, "");
    truncateSync(oversized, MAX_IMPORT_BYTES + 1);

    for (let index = 0; index < 105; index++) {
        const path = join(directory, `copy-${index}.jsonl`);

        writeFileSync(path, archive);
        utimesSync(path, 100 + index, 100 + index);
    }

    utimesSync(join(directory, "malformed.jsonl"), 1000, 1000);
    const list = await listSavedHistory(new Set(), [], directory);

    assert.equal(list.sessions.length, 99, "the newest 100 candidates include one malformed file");
    assert.equal(list.sessions[0]!.path, realpathSync(join(directory, "copy-104.jsonl")));
    assert.equal(list.sessions.at(-1)!.path, realpathSync(join(directory, "copy-6.jsonl")));
    assert.match(list.warnings.join(" "), /symbolic links/);
    assert.match(list.warnings.join(" "), /100 most recently/);
    assert.match(list.warnings.join(" "), /malformed, unsupported, oversized or changed/);
    const linkedRoot = join(root, "linked-session-root");

    symlinkSync(directory, linkedRoot);
    assert.deepEqual((await listSavedHistory(new Set(), [], linkedRoot)).sessions, []);
    await assert.rejects(
        readPiSession(join(directory, "linked.jsonl"), undefined, "snapshot"),
        /symbolic link/,
    );
});

test("discovery bounds aggregate read bytes even for malformed sparse files and bounds total enumerated entries", async () => {
    const large = join(root, "snapshot-byte-budget");

    mkdirSync(large);

    for (let index = 0; index < 6; index++) {
        const path = join(large, `large-${index}.jsonl`);

        writeFileSync(path, "");
        truncateSync(path, MAX_IMPORT_BYTES);
        utimesSync(path, 100 + index, 100 + index);
    }

    const boundedBytes = await listSavedHistory(new Set(), [], large);

    assert.deepEqual(boundedBytes.sessions, []);
    assert.match(boundedBytes.warnings.join(" "), /64 MiB read budget/);
    assert.match(boundedBytes.warnings.join(" "), /4 malformed/);
    const crowded = join(root, "snapshot-scan-budget");

    mkdirSync(crowded);

    for (let index = 0; index < 10_001; index++) {
        writeFileSync(join(crowded, `not-a-session-${index}`), "");
    }

    const boundedScan = await listSavedHistory(new Set(), [], crowded);

    assert.deepEqual(boundedScan.sessions, []);
    assert.match(boundedScan.warnings.join(" "), /10,000-entry scan limit/);
});

for (const mutation of ["growth", "replacement"] as const) {
    test(`${mutation}: snapshot descriptor identity stays stable and reads cannot exceed the discovery charge`, async (t) => {
        const { path: originalPath, archive } = fixture("descriptor-" + mutation);
        const path = realpathSync(originalPath);
        const charged = Buffer.byteLength(archive);
        const open = fs.open;
        let changed = false;
        let readBytes = 0;
        const hook = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
            const file = await open(...args);

            if (args[0] !== path) {
                return file;
            }

            const read = file.read.bind(file);

            t.mock.method(
                file,
                "read",
                async (buffer: Buffer, offset: number, length: number, position: number) => {
                    const result = await read(buffer, offset, length, position);

                    readBytes += result.bytesRead;

                    if (!changed) {
                        changed = true;

                        if (mutation === "growth") {
                            appendFileSync(path, " ".repeat(4096));
                        } else {
                            renameSync(path, path + ".old");
                            writeFileSync(path, archive);
                        }
                    }

                    return result;
                },
            );

            return file;
        });

        syncBuiltinESMExports();

        try {
            await assert.rejects(
                readPiSession(path, undefined, "snapshot", charged),
                /changed while reading/,
            );
            assert.equal(changed, true, "injection reached a real descriptor read");
            assert.ok(readBytes > 0 && readBytes <= charged);
        } finally {
            hook.mock.restore();
            syncBuiltinESMExports();
        }
    });
}
