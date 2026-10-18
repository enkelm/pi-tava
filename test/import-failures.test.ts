// Failed provider attempts are saved history, not tasks to resume or tool calls to execute.
import { cleanUp, context, openApp, owner, root, scriptedModel, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { buildSessionProjection, convertToLlm } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { UsageDoc, type EntryRecord } from "@earendil-works/pi-durable";
import { parsePiSession } from "../src/server/pi-sessions/source.ts";
import { projectEntry } from "../src/server/projection.ts";
import { importFixture } from "./import-fixtures.ts";

after(cleanUp);

function hasSource(entry: EntryRecord, sourceId: string): boolean {
    return (
        entry.data !== null &&
        typeof entry.data === "object" &&
        !Array.isArray(entry.data) &&
        entry.data.sourceId === sourceId
    );
}

function failedFixture(
    name: string,
    reason: "error" | "aborted",
    latest = false,
    partialCall = false,
    compacted = false,
) {
    const directory = join(work, name);

    mkdirSync(directory);
    const base = importFixture(directory, compacted ? "compacted" : "plain");
    const records = base.archive
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
    const assistant = latest
        ? records.find((entry) => entry.id === base.lastAnswer)
        : records.find((entry) => entry.message?.role === "assistant");

    assistant.message.stopReason = reason;
    assistant.message.content =
        reason === "error" ? [] : [{ type: "text", text: "FAILED_PARTIAL_TEXT" }];
    assistant.message.errorMessage = "HISTORICAL_FAILURE";

    if (partialCall) {
        assistant.message.content.push({
            type: "toolCall",
            id: "not-executed",
            name: "bash",
            arguments: { command: "FAILED_COMMAND_MUST_NOT_RUN" },
        });
    }

    const archive = records.map((record) => JSON.stringify(record)).join("\n") + "\n";

    writeFileSync(base.path, archive);
    const expected = convertToLlm(
        buildSessionProjection(records.slice(1), records.at(-1).id).messages,
    ).filter(
        (message) =>
            message.role !== "system" &&
            !(
                message.role === "assistant" &&
                ["error", "aborted", "deferred"].includes(message.stopReason)
            ),
    );

    return { ...base, archive, expected, failedId: assistant.id, records };
}

for (const reason of ["error", "aborted"] as const) {
    for (const latest of [false, true]) {
        test(`${reason} ${latest ? "last" : "historical"} attempt imports without replay and is excluded from model context`, async () => {
            const name = `${reason}-${latest}`;
            const source = failedFixture(name, reason, latest);
            const model = scriptedModel((request) => {
                assert.doesNotMatch(
                    JSON.stringify(request.messages),
                    /FAILED_PARTIAL_TEXT|HISTORICAL_FAILURE/,
                );

                return fauxAssistantMessage("Continued after an old failed attempt");
            });
            let app = await openApp(model, join(root, name));

            try {
                const preview = await app.piSessions.preview(owner(app), { path: source.path });

                assert.equal(preview.messages, source.expected.length);
                assert.ok(preview.warnings.some((warning) => /failed|cancelled/.test(warning)));
                const result = await app.piSessions.create(owner(app), {
                    path: source.path,
                    sha256: preview.sha256,
                    leafId: preview.leafId,
                    stopped: true,
                    acknowledged: true,
                    model: "faux/faux-vision",
                    thinkingLevel: "off",
                });
                const view = await (await app.conversation(result.id)).context(context);

                assert.deepEqual(view.messages, source.expected);
                const failed = view.entries.find((entry) => hasSource(entry, source.failedId))!;
                const rendered = projectEntry(failed);

                assert.ok(rendered?.kind === "assistant");
                assert.equal(rendered.stopReason, reason);
                assert.equal(await app.piSessions.archive(owner(app), result.id), source.archive);
                assert.equal((await app.harness.inspect(context)).tasks.length, 0);
                assert.equal(model.state.callCount, 0);
                assert.deepEqual(await app.harness.snapshot(UsageDoc, result.id, context), {
                    models: {},
                    tools: {},
                });
                await app.close();
                app = await openApp(model, join(root, name));
                assert.deepEqual(
                    (await (await app.conversation(result.id)).context(context)).messages,
                    source.expected,
                );
                const { submissionId } = await app.commands.submit(result.id, owner(app), {
                    text: "Continue",
                    requestId: `after-${name}`,
                });

                await (await app.harness.submission(submissionId, context))!.wait(context);
                assert.equal(model.state.callCount, 1);
            } finally {
                await app.close();
            }
        });
    }
}

test("partial tool calls in an aborted generation are archival, never pending tool cards or tasks", async () => {
    const source = failedFixture("partial-call", "aborted", false, true);
    const app = await openApp(scriptedModel(), join(root, "partial-call"));

    try {
        const preview = await app.piSessions.preview(owner(app), { path: source.path });
        const result = await app.piSessions.create(owner(app), {
            path: source.path,
            sha256: preview.sha256,
            leafId: preview.leafId,
            stopped: true,
            acknowledged: true,
            model: "faux/faux-vision",
            thinkingLevel: "off",
        });
        const view = await (await app.conversation(result.id)).context(context);
        const failed = view.entries.find((entry) => hasSource(entry, source.failedId))!;
        const rendered = projectEntry(failed);

        assert.ok(rendered?.kind === "assistant");
        assert.equal(
            rendered.blocks.some((block) => block.type === "toolCall"),
            false,
        );
        assert.match(JSON.stringify(rendered.blocks), /not executed/);
        assert.doesNotMatch(
            JSON.stringify(view.messages),
            /not-executed|FAILED_COMMAND_MUST_NOT_RUN|FAILED_PARTIAL_TEXT/,
        );
        assert.match(
            JSON.stringify(failed.model),
            /not-executed/,
            "retain the original failed attempt in stored history",
        );
        assert.equal(await app.piSessions.archive(owner(app), result.id), source.archive);
        assert.equal((await app.harness.inspect(context)).tasks.length, 0);
    } finally {
        await app.close();
    }
});

test("compacted historical failures are accepted, but failures cannot hide actual missing tool results", () => {
    const compacted = failedFixture("failed-compacted", "error", false, false, true);

    assert.deepEqual(parsePiSession(compacted.archive).messages, compacted.expected);
    const deferred = failedFixture("failed-deferred", "error", true);

    deferred.records.find((entry) => entry.id === deferred.lastAnswer).message.stopReason =
        "deferred";
    assert.throws(
        () => parsePiSession(deferred.records.map((entry) => JSON.stringify(entry)).join("\n")),
        /Deferred provider requests/,
    );
    const failed = failedFixture("failed-unresolved", "error");
    const toolUse = failed.records.find((entry) => entry.message?.stopReason === "toolUse");
    const result = failed.records.find((entry) => entry.message?.role === "toolResult");

    // A failed assistant inserted in place of a real result must not close a pending tool round.
    result.message = { ...toolUse.message, stopReason: "error", content: [] };
    assert.throws(
        () => parsePiSession(failed.records.map((entry) => JSON.stringify(entry)).join("\n")),
        /Incomplete or interleaved tool round/,
    );

    // A claimed result for a failed generation is also ambiguous: Pi never dispatched those calls.
    toolUse.message.stopReason = "error";
    result.message = {
        role: "toolResult",
        toolCallId: "history-call",
        toolName: "read",
        content: [],
        isError: false,
        timestamp: Date.now(),
    };
    assert.throws(
        () => parsePiSession(failed.records.map((entry) => JSON.stringify(entry)).join("\n")),
        /Unmatched or out-of-order tool result/,
    );
});
