/** Bounded, read-only copies of ordinary Pi v3 journals. No source tools, extensions or work are resumed. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { Message, ToolResultMessage } from "@earendil-works/pi-ai";
import {
    buildSessionProjection,
    convertToLlm,
    CURRENT_SESSION_VERSION,
    type SessionEntry,
    type SessionHeader,
    sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import type { ConversationId, EntryDraft, EntryId, Tx } from "@earendil-works/pi-durable";
import { HttpError } from "../errors.ts";
import { IMPORT_META_ENTRY, IMPORT_NOTE_ENTRY } from "../entry-format.ts";
import { expandHome } from "../paths.ts";

export const MAX_IMPORT_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 20_000;
const SNAPSHOT_RESULT_TEXT =
    "Result unavailable at snapshot time. The original Pi session may still be running; this tool may have run or may still run there. Nothing is resumed or executed here.";
// Pi ends failed generations before dispatching their tool calls. Durable excludes these attempts from context.
const FAILED_ASSISTANT_STOPS = new Set(["error", "aborted"]);
const identifier = (value: unknown): value is string =>
    typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value);
const text = (value: unknown) => typeof value === "string";

function requireValue(ok: unknown, message: string): asserts ok {
    if (!ok) {
        throw new HttpError(400, message);
    }
}

/** Only known content blocks can contribute to the imported model context. */
function content(value: unknown, kinds = ["text", "image", "thinking", "toolCall"]): boolean {
    return (
        typeof value === "string" ||
        (Array.isArray(value) &&
            value.every((part) => {
                if (!record(part) || !kinds.includes(String(part.type))) {
                    return false;
                }

                switch (part.type) {
                    case "text":
                        return text(part.text);
                    case "thinking":
                        return text(part.thinking) || part.redacted === true;
                    case "image":
                        return (
                            text(part.data) &&
                            ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
                                String(part.mimeType),
                            )
                        );
                    case "toolCall":
                        return text(part.id) && text(part.name) && record(part.arguments);
                    default:
                        return false;
                }
            }))
    );
}

function usage(value: unknown): boolean {
    return (
        record(value) &&
        ["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every((key) =>
            finite(value[key]),
        ) &&
        record(value.cost) &&
        ["input", "output", "cacheRead", "cacheWrite", "total"].every((key) =>
            finite((value.cost as Record<string, unknown>)[key]),
        )
    );
}

function validateMessage(value: unknown): void {
    requireValue(record(value) && finite(value.timestamp), "Invalid message or timestamp");

    switch (value.role) {
        case "user":
        case "custom":
            requireValue(content(value.content, ["text", "image"]), "Unsupported user content");
            break;
        case "assistant":
            requireValue(
                Array.isArray(value.content) &&
                    content(value.content) &&
                    text(value.api) &&
                    text(value.provider) &&
                    text(value.model) &&
                    usage(value.usage),
                "Invalid assistant message or unsupported content",
            );
            requireValue(
                value.stopReason !== "deferred",
                "Deferred provider requests cannot be imported yet; finish or cancel the request in the original Pi",
            );
            requireValue(
                ["stop", "length", "toolUse", "error", "aborted"].includes(
                    String(value.stopReason),
                ),
                "Unsupported assistant stop reason",
            );
            break;
        case "toolResult":
            requireValue(
                text(value.toolCallId) &&
                    text(value.toolName) &&
                    Array.isArray(value.content) &&
                    content(value.content, ["text", "image"]) &&
                    typeof value.isError === "boolean",
                "Invalid tool result",
            );
            break;
        case "system":
            // Stored in the source archive only. The destination builds its own prompt and tools.
            break;
        case "bashExecution":
            requireValue(
                text(value.command) &&
                    text(value.output) &&
                    (value.exitCode === null || finite(value.exitCode)) &&
                    typeof value.cancelled === "boolean" &&
                    typeof value.truncated === "boolean" &&
                    (value.excludeFromContext === undefined ||
                        typeof value.excludeFromContext === "boolean"),
                "Invalid shell history",
            );
            requireValue(
                !value.cancelled && value.exitCode !== null,
                "Finish shell work before importing",
            );
            break;
        default:
            throw new HttpError(400, `Unsupported message role: ${String(value.role)}`);
    }
}

function validateEntry(entry: Record<string, unknown>): void {
    switch (entry.type) {
        case "message":
            validateMessage(entry.message);
            break;
        case "compaction":
            requireValue(
                text(entry.summary) &&
                    identifier(entry.firstKeptEntryId) &&
                    finite(entry.tokensBefore),
                "Invalid compaction",
            );
            break;
        case "context_edit":
            requireValue(
                identifier(entry.targetId) &&
                    (entry.replacement === null ||
                        (record(entry.replacement) && content(entry.replacement.content))),
                "Invalid context edit",
            );
            break;
        case "custom_message":
            requireValue(
                text(entry.customType) &&
                    content(entry.content, ["text", "image"]) &&
                    typeof entry.display === "boolean",
                "Invalid custom message",
            );
            break;
        case "custom":
            requireValue(text(entry.customType), "Invalid extension record");
            break;
        case "branch_summary":
            requireValue(text(entry.summary) && identifier(entry.fromId), "Invalid branch summary");
            break;
        case "model_change":
            requireValue(text(entry.provider) && text(entry.modelId), "Invalid model choice");
            break;
        case "thinking_level_change":
            requireValue(text(entry.thinkingLevel), "Invalid thinking level");
            break;
        case "session_info":
            requireValue(entry.name === undefined || text(entry.name), "Invalid session name");
            break;
        case "label":
            requireValue(
                identifier(entry.targetId) && (entry.label === undefined || text(entry.label)),
                "Invalid label",
            );
            break;
        case "usage":
            requireValue(usage(entry.usage), "Invalid usage record");
            break;
        default:
            throw new HttpError(400, `Unsupported session record: ${String(entry.type)}`);
    }
}

export type PiImport = ReturnType<typeof parsePiSession>;
/** Strict saved-file validation remains the default; snapshot copies a saved prefix without controlling Pi. */
export type PiSessionMode = "strict" | "live" | "aborted" | "snapshot";

/** V8 reports the first invalid position. Only an error at EOF can be a cut-off JSON object, not malformed text. */
function cutOffRecord(line: string, error: unknown): boolean {
    return (
        line.trimStart().startsWith("{") &&
        error instanceof SyntaxError &&
        (error.message === "Unexpected end of JSON input" ||
            Number(error.message.match(/at position (\d+)/)?.[1]) === line.length)
    );
}

/** Parse every envelope strictly, validate complete snapshot records, and project one branch without changing the archive. */
export function parsePiSession(
    archive: string,
    selectedLeaf?: string,
    mode: PiSessionMode = "strict",
) {
    requireValue(
        Buffer.byteLength(archive) <= MAX_IMPORT_BYTES,
        "Session exceeds the 16 MiB import limit",
    );
    const lines = archive.split("\n");
    const values: unknown[] = [];
    let cutOffTail = false;

    for (const [index, line] of lines.entries()) {
        if (!line.trim()) {
            continue;
        }

        requireValue(values.length <= MAX_ENTRIES, "Expected a session with 1 to 20,000 entries");

        try {
            values.push(JSON.parse(line));
        } catch (error) {
            requireValue(
                mode === "snapshot" && index === lines.length - 1 && cutOffRecord(line, error),
                "Malformed JSONL; no complete lines were skipped. Preview again after Pi saves the session.",
            );
            cutOffTail = true;
        }
    }

    requireValue(values.length > 1, "Expected a session with 1 to 20,000 entries");
    const header = values[0];

    requireValue(
        record(header) &&
            header.type === "session" &&
            header.version === CURRENT_SESSION_VERSION &&
            identifier(header.id) &&
            text(header.cwd) &&
            isAbsolute(header.cwd as string) &&
            text(header.timestamp) &&
            Number.isFinite(Date.parse(header.timestamp as string)),
        "Only ordinary Pi session format v3 with an absolute working directory is supported",
    );
    const byId = new Map<string, SessionEntry>();

    for (const value of values.slice(1)) {
        requireValue(
            record(value) &&
                identifier(value.id) &&
                !byId.has(value.id) &&
                value.type !== "session" &&
                text(value.type) &&
                text(value.timestamp) &&
                Number.isFinite(Date.parse(value.timestamp as string)) &&
                (value.parentId === null ||
                    (identifier(value.parentId) && byId.has(value.parentId))),
            "Invalid, duplicate or out-of-order session entry/parent",
        );
        byId.set(value.id, value as unknown as SessionEntry);
    }

    if (mode === "snapshot") {
        validateSnapshotRecords(byId);
    }

    const leafId = selectedLeaf ?? [...byId.keys()].at(-1)!;

    requireValue(byId.has(leafId), "The selected entry is not in this session");
    const branch: SessionEntry[] = [];

    for (
        let entry = byId.get(leafId);
        entry !== undefined;
        entry = entry.parentId === null ? undefined : byId.get(entry.parentId)
    ) {
        branch.push(entry);
    }

    branch.reverse();
    const ancestors = new Map<string, SessionEntry>();

    for (const entry of branch) {
        validateBranchEntry(entry, ancestors);
        ancestors.set(entry.id, entry);
    }

    const projection = buildSessionProjection(branch, leafId);
    const projected = modelMessages(projection.messages);

    // Validate raw ordering before filtering failed attempts, so they cannot hide an unfinished real tool round.
    const rawPending = checkToolHistory(
        modelMessages(branch.flatMap(sessionEntryToContextMessages)),
        mode === "live" || mode === "snapshot",
    );
    const pending = checkToolHistory(projected, mode === "live" || mode === "snapshot");

    if (mode === "snapshot") {
        const actualPending = new Map(rawPending.map((call) => [call.id, call]));

        requireValue(
            pending.every((call) => {
                const raw = actualPending.get(call.id);

                return raw?.name === call.name && raw.timestamp === call.timestamp;
            }),
            "Context edits leave a missing tool result outside the pending snapshot tail",
        );
    }

    const snapshotResults: ToolResultMessage[] =
        mode === "snapshot"
            ? pending.map((call) => ({
                  role: "toolResult",
                  toolCallId: call.id,
                  toolName: call.name,
                  content: [{ type: "text", text: SNAPSHOT_RESULT_TEXT }],
                  isError: true,
                  details: { reason: "snapshot_result_unavailable" },
                  timestamp: call.timestamp,
              }))
            : [];
    const messages = [
        ...projected.filter((message) => !failedAssistant(message)),
        ...snapshotResults,
    ];
    const lastConversationMessage = branch.findLast(
        (entry) =>
            entry.type === "message" &&
            ["user", "assistant", "toolResult"].includes(entry.message.role),
    );

    requireValue(lastConversationMessage !== undefined, "Expected saved conversation history");

    if (mode === "strict") {
        requireValue(
            lastConversationMessage.type === "message" &&
                lastConversationMessage.message.role === "assistant" &&
                lastConversationMessage.message.stopReason !== "toolUse",
            "Import a stopped branch ending in a saved assistant response",
        );
    }

    const info = branch.findLast((entry) => entry.type === "session_info" && entry.name);
    const title = (info?.type === "session_info" ? info.name : undefined) ?? "Imported Pi session";
    const parentIds = new Set([...byId.values()].map((entry) => entry.parentId));
    const warnings = [
        "Only this branch is continued. Other branches stay in the owner-only source archive.",
        "The destination uses its own tools, instructions and extensions. Ordinary Pi extensions and live work do not migrate.",
        "Historical usage is not charged again. Original authors are labeled Imported user, not assigned to your account.",
    ];

    if (mode === "snapshot") {
        warnings.push(
            "This is a copy of the selected saved snapshot. The original Pi session is untouched and may still be running. No pending request or tool is resumed here.",
        );
    }

    if (cutOffTail) {
        warnings.push(
            "The final cut-off JSONL record is retained exactly in the archive but is not part of this snapshot's history.",
        );
    }

    if (snapshotResults.length) {
        warnings.push(
            "Pending tool results were unavailable at snapshot time. Error results mark that uncertainty in the copied model context, not whether the tools ran in the original Pi.",
        );
    }

    if (
        branch.some(
            (entry) =>
                entry.type === "message" &&
                entry.message.role === "assistant" &&
                FAILED_ASSISTANT_STOPS.has(entry.message.stopReason),
        )
    ) {
        warnings.push(
            "Failed or cancelled assistant attempts remain in the transcript and archive, but are excluded from model context. They and their partial tool calls are not restarted.",
        );
    }

    if (branch.some((entry) => entry.type === "custom")) {
        warnings.push("Opaque extension state is archived only, not activated.");
    }

    if (branch.some((entry) => entry.type === "context_edit")) {
        warnings.push(
            "Context edits affect what Pi sees. The transcript keeps the original text and marks each edit.",
        );
    }

    return {
        header: header as unknown as SessionHeader,
        archive,
        mode,
        snapshotResults,
        branch,
        leafId,
        title: title.slice(0, 200),
        messages,
        hasImages: messages.some(
            (message) =>
                Array.isArray(message.content) &&
                message.content.some((part) => part.type === "image"),
        ),
        model: projection.model,
        thinkingLevel: projection.thinkingLevel,
        sha256: createHash("sha256").update(archive).digest("hex"),
        warnings,
        leaves: [...byId.keys()].filter((id) => !parentIds.has(id)),
    };
}

function validateBranchEntry(
    entry: SessionEntry,
    ancestors: ReadonlyMap<string, SessionEntry>,
): void {
    validateEntry(entry as unknown as Record<string, unknown>);

    if (entry.type === "compaction") {
        requireValue(
            entry.firstKeptEntryId === entry.id || ancestors.has(entry.firstKeptEntryId),
            "Compaction target is outside the selected branch",
        );
    }

    if (entry.type === "context_edit") {
        const target = ancestors.get(entry.targetId);

        requireValue(
            target !== undefined &&
                (target.type === "custom_message" ||
                    (target.type === "message" &&
                        ["user", "assistant", "toolResult", "custom"].includes(
                            target.message.role,
                        ))),
            "Context edit target is not an earlier editable message on this branch",
        );

        if (entry.replacement !== null) {
            for (const message of sessionEntryToContextMessages(target)) {
                if ("content" in message) {
                    validateMessage(replaceContent(message, entry.replacement.content));
                }
            }
        }
    }
}

/** Validate the entire complete-record tree in linear traversal, not once per leaf or by recursive walks. */
function validateSnapshotRecords(entries: ReadonlyMap<string, SessionEntry>): void {
    const children = new Map<string | null, SessionEntry[]>();

    for (const entry of entries.values()) {
        const siblings = children.get(entry.parentId) ?? [];

        siblings.push(entry);
        children.set(entry.parentId, siblings);
    }

    const ancestors = new Map<string, SessionEntry>();
    const empty: ToolRound = { calls: [], next: 0 };
    const stack = (children.get(null) ?? []).map((entry) => ({
        entry,
        leave: false,
        round: empty,
    }));

    while (stack.length) {
        const frame = stack.pop()!;
        const { entry } = frame;

        if (frame.leave) {
            ancestors.delete(entry.id);
            continue;
        }

        validateBranchEntry(entry, ancestors);
        const round = toolRoundAfter(
            modelMessages(sessionEntryToContextMessages(entry)),
            frame.round,
        );

        ancestors.set(entry.id, entry);
        stack.push({ ...frame, leave: true });

        for (const child of children.get(entry.id) ?? []) {
            stack.push({ entry: child, leave: false, round });
        }
    }
}

function modelMessages(messages: Parameters<typeof convertToLlm>[0]): Message[] {
    return convertToLlm(messages).filter((message) => message.role !== "system");
}

function failedAssistant(message: Message): boolean {
    return message.role === "assistant" && FAILED_ASSISTANT_STOPS.has(message.stopReason);
}

function replaceContent<T extends { role: string; content: unknown }>(
    message: T,
    content: unknown,
): T {
    return {
        ...message,
        content:
            ["assistant", "toolResult"].includes(message.role) && typeof content === "string"
                ? [{ type: "text", text: content }]
                : content,
    };
}

type PendingCall = { id: string; name: string; timestamp: number };
type ToolRound = { calls: PendingCall[]; next: number };

/** Round states are immutable so siblings can share their parent's pending calls without copying whole branches. */
function toolRoundAfter(messages: Message[], initial: ToolRound): ToolRound {
    let round = initial;

    for (const message of messages) {
        if (message.role === "toolResult") {
            const call = round.calls[round.next];

            requireValue(
                call?.id === message.toolCallId && call.name === message.toolName,
                "Unmatched or out-of-order tool result; this history is not supported yet",
            );
            round = { calls: round.calls, next: round.next + 1 };
        } else {
            requireValue(
                round.next === round.calls.length,
                "Incomplete or interleaved tool round; finish the original session before importing",
            );

            if (message.role === "assistant" && !failedAssistant(message)) {
                const calls = message.content
                    .filter((part) => part.type === "toolCall")
                    .map(({ id, name }) => ({ id, name, timestamp: message.timestamp }));

                requireValue(
                    new Set(calls.map((call) => call.id)).size === calls.length,
                    "Duplicate tool call IDs",
                );
                round = { calls, next: 0 };
            }
        }
    }

    return round;
}

/** Reject missing, unmatched or reordered tool results instead of letting Durable synthesize or reorder them. */
function checkToolHistory(messages: Message[], allowPendingTail = false): PendingCall[] {
    const round = toolRoundAfter(messages, { calls: [], next: 0 });

    requireValue(
        allowPendingTail || round.next === round.calls.length,
        "Incomplete tool round; finish the original session before importing",
    );

    return round.calls.slice(round.next);
}

/** A bounded stable read, never SessionManager.open(). The fourth argument is a trusted I/O cap, not HTTP input. */
export async function readPiSession(
    path: unknown,
    leaf?: unknown,
    mode: PiSessionMode = "strict",
    maxReadBytes = MAX_IMPORT_BYTES + 1,
) {
    requireValue(
        typeof path === "string" && isAbsolute(expandHome(path)),
        "Enter an absolute session file path on this server",
    );
    requireValue(
        leaf === undefined || (typeof leaf === "string" && identifier(leaf)),
        "Invalid branch entry ID",
    );
    requireValue(
        Number.isSafeInteger(maxReadBytes) && maxReadBytes >= 0,
        "Invalid session read byte limit",
    );
    const readBound = Math.min(MAX_IMPORT_BYTES + 1, maxReadBytes);
    let file;

    try {
        const requested = expandHome(path);
        const original = await lstat(requested);

        requireValue(
            original.isFile() && !original.isSymbolicLink(),
            "Choose a regular session file, not a symbolic link",
        );
        const resolved = await realpath(requested);

        file = await open(
            resolved,
            constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
        );
        const before = await file.stat();

        requireValue(
            before.isFile() && before.size <= MAX_IMPORT_BYTES,
            "Choose a regular session file no larger than 16 MiB",
        );
        requireValue(
            before.size <= readBound,
            "The source exceeded its discovery read budget; preview again.",
        );
        // A trusted discovery cap needs no extra-byte probe: the stable before/after/path stats still reject growth.
        const buffer = Buffer.alloc(readBound);
        let size = 0;

        while (size < buffer.length) {
            const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);

            if (bytesRead === 0) {
                break;
            }

            size += bytesRead;
        }

        const after = await file.stat();
        const current = await lstat(resolved);
        const requestedAfter = await lstat(requested);

        requireValue(
            current.isFile() &&
                !current.isSymbolicLink() &&
                requestedAfter.isFile() &&
                !requestedAfter.isSymbolicLink() &&
                original.dev === before.dev &&
                original.ino === before.ino &&
                original.size === before.size &&
                original.mtimeMs === before.mtimeMs &&
                original.ctimeMs === before.ctimeMs &&
                requestedAfter.dev === after.dev &&
                requestedAfter.ino === after.ino &&
                size <= MAX_IMPORT_BYTES &&
                size === before.size &&
                before.size === after.size &&
                before.mtimeMs === after.mtimeMs &&
                before.ctimeMs === after.ctimeMs &&
                current.dev === after.dev &&
                current.ino === after.ino &&
                current.mtimeMs === after.mtimeMs &&
                current.ctimeMs === after.ctimeMs &&
                current.size === after.size,
            "The source changed while reading; preview the latest saved snapshot again",
        );
        let archive: string;

        try {
            archive = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
                buffer.subarray(0, size),
            );
        } catch {
            throw new HttpError(400, "Session file is not valid UTF-8");
        }

        return { ...parsePiSession(archive, leaf, mode), path: resolved };
    } catch (error) {
        if (error instanceof HttpError) {
            throw error;
        }

        throw new HttpError(
            400,
            "Could not read that session file. Check its path and permissions on the server.",
        );
    } finally {
        await file?.close();
    }
}

/** Append history in the caller's creation transaction. These writes create no tasks or usage charges. */
export async function appendPiHistory(
    tx: Tx,
    id: ConversationId,
    source: PiImport,
): Promise<Record<string, number>> {
    const ids = new Map<string, EntryId>();
    const originals = new Map(source.branch.map((entry) => [entry.id, entry]));

    for (const entry of source.branch) {
        const messages = modelMessages(sessionEntryToContextMessages(entry));
        let kind = IMPORT_META_ENTRY;

        if (entry.type === "message") {
            kind =
                (
                    {
                        user: "pi.user",
                        assistant: "pi.assistant",
                        toolResult: "pi.tool-result",
                    } as Record<string, string>
                )[entry.message.role] ?? (messages.length ? IMPORT_NOTE_ENTRY : IMPORT_META_ENTRY);
        } else if (entry.type === "compaction") {
            kind = "pi.compaction";
        } else if (messages.length || entry.type === "context_edit") {
            kind = IMPORT_NOTE_ENTRY;
        }

        if (
            (entry.type === "custom_message" && !entry.display) ||
            (entry.type === "message" && entry.message.role === "custom" && !entry.message.display)
        ) {
            kind = IMPORT_META_ENTRY;
        }

        const draft: EntryDraft = {
            kind,
            ...(messages.length ? { model: messages } : {}),
            data: {
                sourceId: entry.id,
                imported: true,
                ...(entry.type === "context_edit"
                    ? {
                          text: `Context ${entry.replacement === null ? "omitted" : "replaced"} for source entry ${entry.targetId}.`,
                      }
                    : {}),
            },
            ...(entry.type === "compaction"
                ? {
                      head:
                          entry.firstKeptEntryId === entry.id
                              ? "self"
                              : ids.get(entry.firstKeptEntryId)!,
                  }
                : {}),
        };
        let edits: EntryDraft["edits"];

        if (entry.type === "context_edit") {
            const replacement = entry.replacement;

            edits = [
                replacement === null
                    ? { target: ids.get(entry.targetId)!, action: "omit" }
                    : {
                          target: ids.get(entry.targetId)!,
                          action: "replace",
                          messages: modelMessages(
                              sessionEntryToContextMessages(originals.get(entry.targetId)!).map(
                                  (message) => {
                                      if ("content" in message) {
                                          return replaceContent(message, replacement.content);
                                      }

                                      return message;
                                  },
                              ),
                          ),
                      },
            ];
        }

        ids.set(
            entry.id,
            (await tx.appendEntry(id, { ...draft, ...(edits === undefined ? {} : { edits }) })).id,
        );
    }

    for (const message of source.snapshotResults) {
        await tx.appendEntry(id, {
            kind: "pi.tool-result",
            model: [message],
            data: { imported: true, synthetic: true, reason: "snapshot_result_unavailable" },
        });
    }

    return Object.fromEntries(ids);
}
