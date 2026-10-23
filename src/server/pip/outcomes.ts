/** Compact passive observations; full agent evidence remains at its native source identity. */
import type { EntryRecord } from "@earendil-works/pi-durable";

/** Written only at a correlated native assignment lifecycle transition, never inferred from prose. */
export type AssignedTaskOutcome = {
    id: string;
    kind: "finish" | "question" | "failure" | "budget" | "cancelled";
    questionId?: string;
    text: string;
};

export type PassiveOutcome = { fact: string; summary?: string };

function excerpt(text: string, limit: number): string {
    const line = text.replace(/\s+/g, " ").trim();

    return line.length <= limit ? line : `${line.slice(0, limit - 1).trimEnd()}…`;
}

/** Keep native settlement separate from the agent's unverified prose, including failed answers. */
function passiveOutcome(
    text: string,
    stopReason: string | undefined,
    error?: string,
): PassiveOutcome | undefined {
    const summary = text.trim();
    const failed = stopReason === "error" || stopReason === "aborted";

    if (!summary && !failed) {
        return undefined;
    }

    return {
        fact: failed
            ? `Native response ${stopReason}: ${excerpt(error ?? "no further detail", 160)}.`
            : `Native response settled: ${stopReason ?? "unknown"}.`,
        ...(summary ? { summary: excerpt(summary, 320) } : {}),
    };
}

/** Native tool rounds and app-authored notices are not independent assistant outcomes. */
export function nativePassiveOutcome(entry: EntryRecord | undefined): PassiveOutcome | undefined {
    if (
        entry?.kind !== "pi.assistant" ||
        (entry.data as { appAuthored?: boolean } | undefined)?.appAuthored === true
    ) {
        return undefined;
    }

    const message = entry.model?.find((message) => message.role === "assistant");

    if (
        message?.role !== "assistant" ||
        message.provider === "pi-coop" ||
        message.api === "pi-coop" ||
        message.stopReason === "toolUse"
    ) {
        return undefined;
    }

    return passiveOutcome(
        message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
        message.stopReason,
        message.errorMessage,
    );
}

/** Semantic terminal text for native wake/report selection; never an authority or success claim. */
export function settledAssistantText(entry: EntryRecord): string | undefined {
    const outcome = nativePassiveOutcome(entry);

    if (outcome === undefined) {
        return undefined;
    }

    return [
        outcome.summary,
        /^Native response (?:error|aborted):/.test(outcome.fact) ? outcome.fact : undefined,
    ]
        .filter(Boolean)
        .join("\n");
}

/** Pure rendering only: callers retain native cursors, authority, access and delivery receipts. */
export function passiveReport(input: {
    title: string;
    source: number;
    controller?: number;
    outcome: PassiveOutcome;
    entry?: number;
    evidence?: string;
}): string {
    const source = `/s/${input.source}`;
    const pointer = `${source}${input.entry === undefined ? "" : `#entry-${input.entry}`}`;

    return [
        excerpt(input.title, 120),
        ...(input.controller === undefined ? [] : [`Native controller: /s/${input.controller}.`]),
        excerpt(input.outcome.fact, 240),
        ...(input.outcome.summary?.trim()
            ? [
                  `Agent summary (unverified excerpt from ${source}): ${excerpt(input.outcome.summary, 320)}`,
              ]
            : []),
        `Evidence: ${pointer}${input.evidence === undefined ? "" : ` · ${input.evidence}`}`,
        "Passive app-authored observation; not owner input, completion proof or activation authority.",
    ].join("\n");
}
