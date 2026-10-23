import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ConversationId, EntryId, EntryRecord } from "@earendil-works/pi-durable";
import {
    nativePassiveOutcome,
    passiveReport,
    settledAssistantText,
} from "../src/server/pip/outcomes.ts";

function answer(
    text: string,
    override: Partial<AssistantMessage> = {},
    data?: EntryRecord["data"],
): EntryRecord {
    return {
        id: 99 as EntryId,
        conversationId: 42 as ConversationId,
        kind: "pi.assistant",
        data,
        model: [
            {
                role: "assistant",
                content: [
                    { type: "text", text },
                    { type: "thinking", thinking: "Private reasoning must not be reported." },
                ],
                api: "openai-responses",
                provider: "fixture",
                model: "fixture",
                stopReason: "stop",
                timestamp: 1,
                usage: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 0,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                ...override,
            },
        ],
    };
}

test("only semantic native assistant text enters the shared wake/report selector", () => {
    const claim = answer("The worker claims that the focused check passed.");
    const outcome = nativePassiveOutcome(claim);

    assert.equal(outcome?.summary, "The worker claims that the focused check passed.");
    assert.equal(outcome?.fact, "Native response settled: stop.");
    assert.doesNotMatch(JSON.stringify(outcome), /Private reasoning/);

    for (const excluded of [
        answer("Tool-round status is not a settled outcome.", { stopReason: "toolUse" }),
        answer("App-authored lookalike.", {}, { appAuthored: true }),
        answer("App-provider lookalike.", { provider: "pi-coop" }),
        answer("App-API lookalike.", { api: "pi-coop" }),
        { ...claim, kind: "pocket.note" },
        answer("   "),
    ]) {
        assert.equal(nativePassiveOutcome(excluded), undefined);
        assert.equal(settledAssistantText(excluded), undefined);
    }
});

test("an empty native failure remains a semantic blocker, never a successful completion claim", () => {
    const entry = answer("", { stopReason: "error", errorMessage: "Provider unavailable." });
    const outcome = nativePassiveOutcome(entry);

    assert.equal(outcome?.summary, undefined);
    assert.match(outcome?.fact ?? "", /^Native response error: Provider unavailable/);
    assert.match(settledAssistantText(entry) ?? "", /Provider unavailable/);
    assert.doesNotMatch(JSON.stringify(outcome), /success|passed/);
});

test("compact reports retain exact evidence and attribution without full outcome copies", () => {
    const fullClaim = "Observed fixture evidence; validation remains incomplete. "
        .repeat(100)
        .slice(0, 4000);
    const report = passiveReport({
        title: "Work Item report: Fixture task",
        source: 42,
        controller: 43,
        entry: 99,
        outcome: { fact: "Native response settled: stop.", summary: fullClaim },
    });

    assert.match(report, /Agent summary \(unverified excerpt from \/s\/42\)/);
    assert.match(report, /Evidence: \/s\/42#entry-99/);
    assert.match(report, /Native controller: \/s\/43/);
    assert.match(report, /not owner input, completion proof or activation authority/);
    assert.ok(!report.includes(fullClaim));
    assert.ok(Buffer.byteLength(report) < 700, "a report should not copy a 4000-character outcome");
});
