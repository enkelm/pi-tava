/** Generated ordinary Pi sessions only. Import helpers.ts first to isolate Pi's configuration. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";

export function importFixture(directory: string, mode = "plain") {
    const source = SessionManager.create(directory, join(directory, "sources"));
    const answer = (text: string): AssistantMessage => ({
        role: "assistant",
        content: [{ type: "text", text }],
        api: "faux",
        provider: "faux",
        model: "faux-1",
        stopReason: "stop",
        timestamp: Date.now(),
        usage: {
            input: 10,
            output: 5,
            totalTokens: 15,
            cacheRead: 0,
            cacheWrite: 0,
            cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
        },
    });

    source.appendSessionInfo(`Imported ${mode}`);
    source.appendModelChange("faux", "faux-1");
    source.appendThinkingLevelChange("off");
    source.appendMessage({
        role: "system",
        content: "",
        sections: { old: "OLD_RUNTIME_ONLY" },
        timestamp: Date.now(),
    });
    source.appendMessage({ role: "user", content: "OLD_HISTORY", timestamp: Date.now() });
    const point = source.appendMessage(answer("Earlier answer"));

    source.appendMessage({ role: "user", content: "ABANDONED_BRANCH", timestamp: Date.now() });
    source.appendMessage(answer("Unselected answer"));
    source.branchWithSummary(point, "Back on the selected branch");
    const kept = source.appendMessage({
        role: "user",
        content: [
            { type: "text", text: "KEPT_HISTORY" },
            {
                type: "image",
                mimeType: "image/png",
                data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG0sAAAAASUVORK5CYII=",
            },
        ],
        timestamp: Date.now(),
    });

    source.appendMessage({
        ...answer(""),
        stopReason: "toolUse",
        content: [
            {
                type: "toolCall",
                id: "history-call",
                name: "read",
                arguments: { path: "NEVER_EXECUTE" },
            },
        ],
    });
    source.appendMessage({
        role: "toolResult",
        toolCallId: "history-call",
        toolName: "read",
        content: [{ type: "text", text: "HISTORICAL_TOOL_RESULT" }],
        isError: false,
        timestamp: Date.now(),
    });
    source.appendMessage(answer("Saved result received"));
    source.appendCustomEntry("example", { private: "OPAQUE_ARCHIVE_ONLY" });
    source.appendCustomMessageEntry("example-note", "CUSTOM_CONTEXT", true);

    if (mode !== "plain") {
        source.appendCompaction("COMPACTED_SUMMARY", mode === "empty-kept" ? null : kept, 3000);
    }

    const edited = source.appendMessage({
        role: "user",
        content: "UNEDITED_TEXT",
        timestamp: Date.now(),
    });
    const lastAnswer = source.appendMessage(answer("Ready to continue"));

    source.appendContextEdit(edited, { content: "EDITED_CONTEXT" });

    if (mode === "repeated") {
        source.appendCompaction("NEWEST_SUMMARY", kept, 4000);
    }

    const omitted = source.appendCustomMessageEntry("hidden", "OMITTED_CONTEXT", false);

    source.appendContextEdit(omitted, null);
    const path = source.getSessionFile()!;

    return { source, path, archive: readFileSync(path, "utf8"), lastAnswer };
}
