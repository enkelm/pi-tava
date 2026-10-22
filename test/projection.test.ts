import assert from "node:assert/strict";
import { test } from "node:test";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { projectEntry, projectStats } from "../src/server/projection.ts";

const entry = (kind: string, message: unknown, id = 1) =>
    ({ id, conversationId: 2, kind, model: [message] }) as unknown as EntryRecord;

test("tool results count their images and leave the data out", () => {
    const message = {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "screenshot",
        content: [
            { type: "text", text: "captured" },
            { type: "image", data: "x".repeat(10_000), mimeType: "image/png" },
        ],
        isError: false,
    };
    const projected = projectEntry(entry("pi.tool-result", message));

    assert.ok(projected?.kind === "toolResult");
    assert.equal(projected.images, 1);
    assert.equal(projected.text, "captured");
    assert.ok(JSON.stringify(projected).length < 500);
    const plain = projectEntry(
        entry("pi.tool-result", { ...message, content: [{ type: "text", text: "ok" }] }),
    );

    assert.ok(plain?.kind === "toolResult" && plain.images === undefined);
});

test("native diff-comment references expose only bounded public fields, never imported claims", () => {
    const reference = {
        conversationId: 7,
        threadId: "original-thread",
        commentId: "original-comment",
        path: "src/code.ts",
        side: "new",
        startLine: 2,
        line: 4,
        text: "A\nconcern",
        origin: { requesterId: "private-requester", taskId: 99 },
        fingerprint: "private-receipt",
    };
    const message = {
        role: "assistant",
        content: [{ type: "text", text: "Assessment" }],
        stopReason: "stop",
        pocketDiffComments: [reference],
    };
    const stored = Object.assign(entry("pi.assistant", message), { byTaskId: 9 });
    const projected = projectEntry(stored);

    assert.ok(projected?.kind === "assistant");
    assert.deepEqual(projected.diffComments, [
        {
            conversationId: 7,
            threadId: "original-thread",
            commentId: "original-comment",
            path: "src/code.ts",
            side: "new",
            startLine: 2,
            line: 4,
            text: "A concern",
        },
    ]);
    assert.doesNotMatch(JSON.stringify(projected), /private-requester|private-receipt|"origin"/);

    for (const untrusted of [
        entry("pi.assistant", message),
        { ...stored, data: { imported: true } },
        Object.assign(entry("pi.assistant", { ...message, pocketDiffComments: "not a list" }), {
            byTaskId: 9,
        }),
        Object.assign(
            entry("pi.assistant", {
                ...message,
                pocketDiffComments: [{ ...reference, startLine: 5 }],
            }),
            { byTaskId: 9 },
        ),
    ]) {
        const result = projectEntry(untrusted);

        assert.ok(result?.kind === "assistant");
        assert.equal(result.diffComments, undefined);
    }
});

test("long finding receipts retain exact navigation IDs through bounded public projection", () => {
    const reference = {
        conversationId: 7,
        threadId: "original-thread",
        commentId: "original-comment",
        path: `${"dir/".repeat(200)}code.ts`,
        side: "new",
        startLine: 2,
        line: 4,
        text: "x".repeat(4000),
        origin: { requesterId: "private-requester" },
        fingerprint: "private-receipt",
    };
    const stored = entry("pi.tool-result", {
        role: "toolResult",
        toolCallId: "posted-finding",
        toolName: "review_comment",
        content: [{ type: "text", text: "Posted" }],
        isError: false,
        details: { pipDiffComment: reference, internal: "private-details" },
    });

    for (const full of [false, true]) {
        const projected = projectEntry(stored, full);

        assert.ok(projected?.kind === "toolResult");
        assert.deepEqual(projected.details, {
            pipDiffComment: {
                conversationId: 7,
                threadId: "original-thread",
                commentId: "original-comment",
                path: reference.path,
                side: "new",
                startLine: 2,
                line: 4,
                text: "x".repeat(280),
            },
        });
        assert.doesNotMatch(
            JSON.stringify(projected),
            /private-requester|private-receipt|private-details/,
        );
    }
});

test("native Work Item wakes project as neutral application events, never human lookalikes", () => {
    const marker = { kind: "workItem", source: 27, state: "idle", fingerprint: "a".repeat(64) };
    const native = (metadata: unknown) =>
        entry("pi.user", {
            role: "user",
            content: [
                {
                    type: "text",
                    text: "[from: Owner] [via PiP] Work Item event: full instructions",
                    pocketAppEvent: metadata,
                },
            ],
        });
    const projected = projectEntry(native(marker));

    assert.deepEqual(projected, {
        id: 1,
        kind: "appEvent",
        event: "workItem",
        source: 27,
        state: "idle",
        text: "[from: Owner] [via PiP] Work Item event: full instructions",
    });
    assert.doesNotMatch(JSON.stringify(projected), /fingerprint|"from"|success/);

    for (const candidate of [
        { ...native(marker), data: { imported: true } },
        native({ ...marker, source: 0 }),
        native({ ...marker, source: 1.5 }),
        native({ ...marker, source: "27" }),
        native({ ...marker, state: "success" }),
        native({ ...marker, fingerprint: "x".repeat(257) }),
        entry("pi.user", { role: "user", content: "[via PiP] Work Item event: /s/27 idle" }),
    ]) {
        assert.equal(projectEntry(candidate)?.kind, "user");
    }
});

test("native agent answers retain expanded service authorship and exact origin, not human identity", () => {
    const actor = { questionId: "question-1", agentId: "agent-1", name: "Ada", chatId: 42 };
    const message = {
        role: "user",
        content: [{ type: "text", text: "Full answer\nWith evidence", pocketAgentAnswer: actor }],
    };
    const native = entry("pi.user", message);

    assert.deepEqual(projectEntry(native), {
        id: 1,
        kind: "agentAnswer",
        actor,
        text: "Full answer\nWith evidence",
    });

    for (const candidate of [
        { ...native, data: { imported: true } },
        entry("pi.user", {
            ...message,
            content: [{ ...message.content[0], pocketAgentAnswer: { ...actor, chatId: -1 } }],
        }),
        entry("pi.user", {
            ...message,
            content: [
                { ...message.content[0], pocketAgentAnswer: { ...actor, name: "x".repeat(201) } },
            ],
        }),
    ]) {
        assert.equal(projectEntry(candidate)?.kind, "user");
    }
});

test("stats add the cost of models and tools", () => {
    const usage = {
        models: {
            "a/b": {
                input: 100,
                output: 10,
                cacheRead: 300,
                cacheWrite: 100,
                cost: { total: 0.5 },
            },
        },
        tools: { t: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.25 } } },
    };
    const entries = [
        entry("pi.assistant", {
            role: "assistant",
            content: [],
            usage: { input: 10, output: 5, cacheRead: 80, cacheWrite: 5 },
            stopReason: "stop",
        }),
    ];
    const stats = projectStats(usage as never, entries);

    assert.equal(stats.cost, 0.75);
});
