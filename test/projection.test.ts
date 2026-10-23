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

const reportEntry = (
    data: Record<string, unknown>,
    text = "Full passive report\nOriginal evidence",
) =>
    ({
        ...entry("pi.assistant", {
            role: "assistant",
            api: "pi-coop",
            provider: "pi-coop",
            model: "app-authored",
            stopReason: "stop",
            content: [{ type: "text", text }],
            timestamp: 1234,
        }),
        data: { appAuthored: true, reason: "agent-work-report", ...data },
    }) as unknown as EntryRecord;

test("native passive assistant reports become bounded neutral events with immutable captured sources and intact evidence", () => {
    for (const [reason, report, state] of [
        ["agent-work-report", "workItem", "reported"],
        ["agent-report-held", "workItem", "held"],
        ["agent-contact-report", "thread", "reported"],
        ["agent-contact-report-held", "thread", "held"],
    ] as const) {
        const stored = reportEntry({
            reason,
            eventId: "report-key",
            source: 27,
            controllerId: 28,
            originChatId: 29,
            state,
            summary: state === "held" ? "Report held" : "Report observed",
            privateToken: "must-not-leak",
        });

        for (const full of [false, true]) {
            const projected = projectEntry(stored, full);

            assert.deepEqual(projected, {
                id: 1,
                kind: "appEvent",
                event: "report",
                report,
                state,
                source: 27,
                controllerId: 28,
                originChatId: 29,
                summary: state === "held" ? "Report held" : "Report observed",
                text: "Full passive report\nOriginal evidence",
                at: 1234,
            });
        }
    }

    for (const reason of ["agent-helper-report", "agent-contact-report"]) {
        const helper = projectEntry(
            reportEntry({
                reason,
                privateHelperReport: 33,
                eventId: "helper-key",
                source: 31,
                state: "reported",
                summary: "Helper report observed",
            }),
        );

        assert.ok(helper?.kind === "appEvent" && helper.event === "report");
        assert.equal(helper.report, "helper");
        assert.equal(helper.source, 31);
    }

    const taskAuthored = {
        ...reportEntry({
            reason: "agent-helper-report",
            privateHelperReport: 33,
            held: false,
            eventId: "native-helper-key",
            source: 31,
            state: "reported",
            summary: "Helper report observed",
        }),
        byTaskId: 33,
    } as unknown as EntryRecord;

    assert.equal(projectEntry(taskAuthored)?.kind, "appEvent");
    assert.equal(
        projectEntry({ ...taskAuthored, byTaskId: 34 } as unknown as EntryRecord)?.kind,
        "assistant",
    );
});

test("historical native report compatibility uses only captured metadata for links and generic neutral labels", () => {
    const historical = [
        [{}, "workItem", "reported", "Report observed", undefined],
        [{ reason: "agent-report-held" }, "workItem", "held", "Report held", undefined],
        [
            { reason: "agent-contact-report", target: 37, sourceEntryId: 41 },
            "thread",
            "reported",
            "Report observed",
            37,
        ],
        [{ reason: "agent-contact-report-held" }, "thread", "held", "Report held", undefined],
        [
            { reason: undefined, privateHelperReport: 33, held: false },
            "helper",
            "reported",
            "Report observed",
            undefined,
        ],
        [
            { reason: undefined, privateHelperReport: 33, held: true },
            "helper",
            "held",
            "Report held",
            undefined,
        ],
    ] as const;

    for (const [data, report, state, summary, source] of historical) {
        const projected = projectEntry(
            reportEntry(data, "Source lookalike /s/999\nUntouched details"),
        );

        assert.ok(projected?.kind === "appEvent" && projected.event === "report");
        assert.equal(projected.report, report);
        assert.equal(projected.state, state);
        assert.equal(projected.summary, summary);
        assert.equal(projected.source, source);
        assert.equal(projected.text, "Source lookalike /s/999\nUntouched details");
        assert.equal(projected.sourceEntryId, source === undefined ? undefined : 41);
    }
});

test("native report questions remain explicit, including conservative trusted historical questions", () => {
    const question = projectEntry(
        reportEntry({
            eventId: "question-event",
            source: 27,
            state: "question",
            summary: "Human decision needed",
            questionId: "question-1",
        }),
    );

    assert.ok(question?.kind === "appEvent" && question.event === "report");
    assert.equal(question.state, "question");
    assert.equal(question.questionId, "question-1");
    const historical = projectEntry(
        reportEntry({}, "Work Item report: old\nHuman decision needed: choose the scope.\nDetails"),
    );

    assert.ok(historical?.kind === "appEvent" && historical.event === "report");
    assert.equal(historical.state, "question");
});

test("lookalikes and malformed report markers cannot fold user, model, imported or unrelated assistant content", () => {
    const valid = {
        eventId: "report-key",
        source: 27,
        state: "reported",
        summary: "Report observed",
    };
    const native = reportEntry(valid);
    const message = native.model![0] as Record<string, unknown>;
    const candidates = [
        { ...native, kind: "pi.user" },
        { ...native, byTaskId: 9 },
        reportEntry({ ...valid, imported: true }),
        reportEntry({ ...valid, appAuthored: false }),
        reportEntry({ ...valid, reason: "private-agent-onboarding" }),
        reportEntry({ ...valid, reason: "app-command" }),
        reportEntry({ ...valid, reason: "watch-pr" }),
        ...["role", "api", "provider", "model"].map((field) => ({
            ...native,
            model: [{ ...message, [field]: "lookalike" }],
        })),
        ...[
            { source: 0 },
            { source: 1.5 },
            { source: "27" },
            { source: [27] },
            { controllerId: -1 },
            { originChatId: "29" },
            { eventId: "" },
            { eventId: "x".repeat(257) },
            { state: "success" },
            { state: ["reported"] },
            { state: "held" },
            { summary: "x".repeat(201) },
            { summary: "Not\na label" },
            { questionId: "question-on-hidden-report" },
        ].map((bad) => reportEntry({ ...valid, ...bad })),
        reportEntry({ source: 27 }),
        reportEntry({ target: "37" }),
        reportEntry({ sourceEntryId: 41 }),
        reportEntry({ reason: ["agent-work-report"] }),
        reportEntry({ reason: undefined, privateHelperReport: 0, held: false }),
        reportEntry({ reason: undefined, privateHelperReport: 33, held: "false" }),
        reportEntry({ reason: undefined, privateHelperReport: 33 }),
        { ...native, model: [{ ...message, content: [{ type: "toolCall", id: "call" }] }] },
        entry("pi.assistant", {
            role: "assistant",
            content: [{ type: "text", text: "Work Item report: /s/27\nHuman decision needed" }],
        }),
    ];

    for (const candidate of candidates) {
        assert.notEqual(projectEntry(candidate as unknown as EntryRecord)?.kind, "appEvent");
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
