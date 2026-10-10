/** Bounded, read-only discovery of ordinary Pi journals. Listing never establishes that a writer has exited. */
import { lstat, opendir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { MAX_IMPORT_BYTES, readPiSession, type PiImport } from "./pi-session.ts";

const MAX_SCANNED_ENTRIES = 10_000;
const MAX_CANDIDATES = 100;
const MAX_READ_BYTES = 64 * 1024 * 1024;
const MAX_SNIPPET = 400;

export type HistorySession = {
    path: string;
    title: string;
    cwd: string;
    modified: number;
    messages: number;
    reason?: string;
};

/** Extract only a bounded prefix of text blocks, never tools, images, thinking or serialized content. */
function plainText(content: unknown, limit: number): string {
    let value = "";

    if (typeof content === "string") {
        value = content.slice(0, limit + 1);
    } else if (Array.isArray(content)) {
        for (const part of content) {
            if (part?.type === "text" && typeof part.text === "string") {
                value += (value ? "\n" : "") + part.text.slice(0, limit + 1 - value.length);

                if (value.length > limit) {
                    break;
                }
            }
        }
    }

    value = value.trim();

    return value.length > limit ? value.slice(0, limit - 1) + "…" : value;
}

/** Latest six plain-text messages on the selected branch, in transcript order rather than compacted context. */
export function recentHistory(source: PiImport): { role: "user" | "assistant"; text: string }[] {
    const history: { role: "user" | "assistant"; text: string }[] = [];

    for (let index = source.branch.length - 1; index >= 0 && history.length < 6; index--) {
        const entry = source.branch[index]!;

        if (entry.type !== "message") {
            continue;
        }

        const message = entry.message;

        if (message.role === "user" || message.role === "assistant") {
            const text = plainText(message.content, MAX_SNIPPET);

            if (text) {
                history.push({ role: message.role, text });
            }
        }
    }

    return history.reverse();
}

function sessionTitle(source: PiImport): string {
    const info = source.branch.findLast((entry) => entry.type === "session_info");

    if (info?.type === "session_info" && info.name?.trim()) {
        return info.name.trim().slice(0, 200);
    }

    for (const entry of source.branch) {
        if (entry.type === "message" && entry.message.role === "user") {
            const text = plainText(entry.message.content, 160).replace(/\s+/g, " ");

            if (text) {
                return text;
            }
        }
    }

    return "Untitled Pi session";
}

type Candidate = { path: string; modified: number; size: number; dev: number; ino: number };
const newestFirst = (a: Candidate, b: Candidate) =>
    b.modified - a.modified || a.path.localeCompare(b.path);

/** Stream only the root and its immediate project directories. The SDK listAll follows links and retains unbounded text. */
export async function listSavedHistory(excluded: ReadonlySet<string>, activeWarnings: string[]) {
    let directory = resolve(join(getAgentDir(), "sessions"));
    const sessions: HistorySession[] = [];
    const warnings = [
        "History does not prove that Pi has stopped. Confirm the original Pi has exited before importing a saved file.",
        ...activeWarnings,
    ];
    const candidates: Candidate[] = [];
    let scanned = 0;
    let skipped = 0;
    let links = 0;
    let unreadable = 0;
    let activeFiles = 0;
    let excess = false;

    try {
        const root = await lstat(directory);

        if (!root.isDirectory() || root.isSymbolicLink()) {
            warnings.push(
                "The Pi sessions directory is not an ordinary directory; links are not followed.",
            );

            return { sessions, warnings, directory };
        }

        directory = await realpath(directory);
    } catch {
        warnings.push("The Pi sessions directory is missing or unreadable.");

        return { sessions, warnings, directory };
    }

    async function scan(path: string, projects: boolean): Promise<void> {
        try {
            // Recheck the directory immediately before opening it: never traverse a project link.
            const stats = await lstat(path);

            if (!stats.isDirectory() || stats.isSymbolicLink() || (await realpath(path)) !== path) {
                links++;

                return;
            }

            const entries = await opendir(path);

            for await (const entry of entries) {
                if (scanned >= MAX_SCANNED_ENTRIES) {
                    break;
                }

                scanned++;
                const child = join(path, entry.name);

                if (entry.isSymbolicLink()) {
                    links++;
                } else if (projects && entry.isDirectory()) {
                    await scan(child, false);
                } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
                    if (excluded.has(child)) {
                        activeFiles++;
                        continue;
                    }

                    const file = await lstat(child).catch(() => undefined);

                    if (!file?.isFile() || file.isSymbolicLink()) {
                        skipped++;
                        continue;
                    }

                    if (file.size > MAX_IMPORT_BYTES) {
                        skipped++;
                        continue;
                    }

                    const candidate = {
                        path: child,
                        modified: file.mtimeMs,
                        size: file.size,
                        dev: file.dev,
                        ino: file.ino,
                    };

                    candidates.push(candidate);
                    candidates.sort(newestFirst);

                    if (candidates.length > MAX_CANDIDATES) {
                        candidates.pop();
                        excess = true;
                    }
                }
            }
        } catch {
            unreadable++;
        }
    }

    await scan(directory, true);
    let bytes = 0;

    for (const candidate of candidates) {
        if (bytes + candidate.size > MAX_READ_BYTES) {
            warnings.push("History reached its 64 MiB read budget; older files were not read.");
            break;
        }

        // Failed attempts count toward the budget too. Reads are sequential and no archives are retained.
        bytes += candidate.size;

        try {
            const parent = await lstat(resolve(candidate.path, ".."));
            const file = await lstat(candidate.path);

            if (
                !parent.isDirectory() ||
                parent.isSymbolicLink() ||
                !file.isFile() ||
                file.isSymbolicLink() ||
                file.size !== candidate.size ||
                file.mtimeMs !== candidate.modified ||
                file.dev !== candidate.dev ||
                file.ino !== candidate.ino ||
                (await realpath(candidate.path)) !== candidate.path
            ) {
                skipped++;
                continue;
            }

            const source = await readPiSession(candidate.path, undefined, "strict", candidate.size);
            const after = await lstat(candidate.path);

            // readPiSession resolves paths itself. Recheck containment and the enumerated identity after it,
            // so a file or ancestor replaced with a link during discovery cannot expose outside metadata.
            if (
                source.path !== candidate.path ||
                (await realpath(candidate.path)) !== candidate.path ||
                !after.isFile() ||
                after.isSymbolicLink() ||
                after.dev !== candidate.dev ||
                after.ino !== candidate.ino ||
                after.size !== candidate.size ||
                after.mtimeMs !== candidate.modified
            ) {
                skipped++;
                continue;
            }

            sessions.push({
                path: source.path,
                title: sessionTitle(source),
                cwd: source.header.cwd,
                modified: candidate.modified,
                messages: source.messages.length,
            });
        } catch {
            skipped++;
        }
    }

    if (scanned >= MAX_SCANNED_ENTRIES) {
        warnings.push(
            "History discovery reached its 10,000-entry scan limit; only scanned files are shown.",
        );
    }

    if (excess) {
        warnings.push("History shows at most the 100 most recently modified discovered files.");
    }

    if (skipped) {
        warnings.push(
            `${skipped} malformed, unsupported, oversized or changed session files were omitted. Preview remains the import authority.`,
        );
    }

    if (activeFiles) {
        warnings.push(
            `${activeFiles} known Herdr session files were omitted. Use Live to move those sessions.`,
        );
    }

    if (links) {
        warnings.push(`${links} symbolic links or non-ordinary directories were not followed.`);
    }

    if (unreadable) {
        warnings.push(`${unreadable} session directories could not be read.`);
    }

    return { sessions, warnings, directory };
}
