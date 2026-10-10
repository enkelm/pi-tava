/** Read-only, bounded display of Pi's last persisted branch. This is not the executable importer. */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { stripVTControlCharacters } from "node:util";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { projectEntry, type ClientEntry } from "../projection.ts";

// Adapted from Collie bridge/journal/{pi,text}.ts, cfaf95a93df3c9404a03f5f840bf222f0cd6c2ee.
// Copyright (c) 2026 Altan Sarisin, MIT; see LICENSES/Collie-MIT.txt.
const MAX_TEXT_CHARS = 20_000;

export const MAX_JOURNAL_BYTES = 16 * 1024 * 1024;
const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

/** Collie's text-block projection, with unknown inputs narrowed at this file's read boundary. */
function textBlocks(content: unknown): string {
    if (typeof content === "string") {
        return content;
    }

    if (!Array.isArray(content)) {
        return "";
    }

    return content
        .map((block) =>
            record(block) && block.type === "text" && typeof block.text === "string"
                ? block.text
                : "",
        )
        .filter(Boolean)
        .join("\n");
}

/** Collie's per-part cap, made visible in a Pocket text block. No terminal escapes reach the renderer. */
function clamp(text: string, max = MAX_TEXT_CHARS): string {
    text = stripVTControlCharacters(text);

    return text.length <= max ? text : `${text.slice(0, max)}\n… text truncated in this view …`;
}

function content(value: unknown): unknown {
    if (typeof value === "string") {
        return clamp(value);
    }

    if (!Array.isArray(value)) {
        return [];
    }

    return value
        .filter(record)
        .slice(0, 100)
        .flatMap((block) => {
            switch (block.type) {
                case "text":
                    return [
                        {
                            type: "text",
                            text: clamp(typeof block.text === "string" ? block.text : ""),
                        },
                    ];
                case "thinking":
                    return [
                        {
                            type: "thinking",
                            thinking: clamp(
                                typeof block.thinking === "string" ? block.thinking : "",
                            ),
                            redacted: block.redacted === true,
                        },
                    ];
                case "image":
                    return [{ type: "image" }]; // Count images, never pass arbitrary URLs or megabytes of base64.

                case "toolCall": {
                    const args = record(block.arguments) ? block.arguments : {};
                    const serialized = JSON.stringify(args);

                    return [
                        {
                            type: "toolCall",
                            id: typeof block.id === "string" ? block.id : "",
                            name: typeof block.name === "string" ? block.name : "tool",
                            arguments:
                                serialized.length < 4000
                                    ? args
                                    : { preview: clamp(serialized, 4000) },
                        },
                    ];
                }

                default:
                    return [];
            }
        });
}

export function projectJournal(text: string): { entries: ClientEntry[]; warnings: string[] } {
    const lines = text.split("\n");
    const rows: Record<string, unknown>[] = [];
    const warnings: string[] = [];

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index]!;

        if (!line.trim()) {
            continue;
        }

        try {
            const value: unknown = JSON.parse(line);

            if (!record(value)) {
                throw new Error("Invalid journal record");
            }

            rows.push(value);
        } catch {
            if (index === lines.length - 1 && !text.endsWith("\n")) {
                warnings.push(
                    "Pi is still saving its latest message. It will appear on the next refresh.",
                );
                break;
            }

            throw new Error(
                "The saved Pi journal contains an invalid record. Use the terminal view.",
            );
        }
    }

    if (rows[0]?.type !== "session" || rows[0]?.version !== 3 || rows.length > 20_001) {
        throw new Error(
            "This saved journal format or size cannot be displayed. Use the terminal view.",
        );
    }

    const byId = new Map<string, { row: Record<string, unknown>; index: number }>();

    for (const [index, row] of rows.slice(1).entries()) {
        if (
            typeof row.id !== "string" ||
            byId.has(row.id) ||
            (row.parentId !== null && (typeof row.parentId !== "string" || !byId.has(row.parentId)))
        ) {
            throw new Error("The journal branch could not be resolved. Use the terminal view.");
        }

        byId.set(row.id, { row, index: index + 1 });
    }

    const branch: { row: Record<string, unknown>; index: number }[] = [];
    let current = [...byId.values()].at(-1);

    while (current) {
        branch.push(current);
        current =
            typeof current.row.parentId === "string" ? byId.get(current.row.parentId) : undefined;
    }

    if (branch.length > 400) {
        warnings.push(
            "Showing the most recent 400 saved records. The original journal is unchanged.",
        );
    }

    const entries: ClientEntry[] = [];

    for (const { row, index } of branch.slice(0, 400).reverse()) {
        let entry: ClientEntry | undefined;

        if (row.type === "message" && record(row.message)) {
            const message = row.message;
            const role = message.role;
            const kind =
                role === "user"
                    ? "pi.user"
                    : role === "assistant"
                      ? "pi.assistant"
                      : role === "toolResult"
                        ? "pi.tool-result"
                        : undefined;

            if (kind) {
                // Projection only: these objects are never appended to Durable or turned into tasks.
                entry = projectEntry({
                    id: index,
                    kind,
                    model: [
                        {
                            ...message,
                            content: content(message.content),
                            errorMessage:
                                typeof message.errorMessage === "string"
                                    ? clamp(message.errorMessage, 4000)
                                    : undefined,
                            details: undefined,
                        },
                    ],
                } as unknown as EntryRecord);
            } else if (role === "bashExecution") {
                entry = {
                    id: index,
                    kind: "note",
                    name: "Terminal command",
                    text: clamp(
                        `${String(message.command ?? "")}\n${String(message.output ?? "")}`,
                    ),
                };
            } else if (role === "custom") {
                entry = {
                    id: index,
                    kind: "note",
                    name: "Pi context",
                    text: clamp(textBlocks(message.content)),
                };
            }
        } else if (row.type === "compaction" || row.type === "branch_summary") {
            entry = {
                id: index,
                kind: "note",
                name: row.type === "compaction" ? "Compacted history" : "Branch summary",
                text: clamp(typeof row.summary === "string" ? row.summary : ""),
            };
        } else if (row.type === "custom_message") {
            entry = {
                id: index,
                kind: "note",
                name: "Pi context",
                text: clamp(textBlocks(row.content)),
            };
        }

        if (entry) {
            entries.push(entry);
        }
    }

    let bytes = 0;
    const bounded: ClientEntry[] = [];

    for (const entry of entries.reverse()) {
        bytes += Buffer.byteLength(JSON.stringify(entry));

        if (bytes > 512 * 1024) {
            warnings.push(
                "Earlier messages are not shown because this view reached its size limit.",
            );
            break;
        }

        bounded.push(entry);
    }

    return { entries: bounded.reverse(), warnings };
}

export async function readJournal(path: string) {
    // NONBLOCK means a substituted FIFO cannot hang the server while we check the opened descriptor.
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);

    try {
        const metadata = await file.stat();

        if (!metadata.isFile() || metadata.size > MAX_JOURNAL_BYTES) {
            throw new Error(
                "The saved journal is unavailable or exceeds the 16 MiB display limit.",
            );
        }

        const bytes = Buffer.alloc(metadata.size);
        let offset = 0;

        while (offset < bytes.length) {
            const read = await file.read(bytes, offset, bytes.length - offset, offset);

            if (read.bytesRead === 0) {
                break;
            }

            offset += read.bytesRead;
        }

        // No SessionManager.open: reading the private view must never repair or rewrite the source.
        return projectJournal(
            new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset)),
        );
    } finally {
        await file.close();
    }
}
