/** Remote project instructions and deliberately narrow access to host-global skill resources. */
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Skill } from "@earendil-works/pi-coding-agent";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

const MAX_BYTES = 50 * 1024;
const MAX_CONTEXT_BYTES = 200 * 1024;
const CONTEXT_NAMES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
const STALE_MS = 30_000;

export type ContextFile = { path: string; content: string };

/** Only the host's global instruction file: never walk a remote cwd using the local filesystem. */
export async function hostInstructions(agentDir: string): Promise<ContextFile[]> {
    for (const name of CONTEXT_NAMES) {
        const path = join(agentDir, name);

        try {
            // This is trusted owner configuration, but still bound prompt size.
            const file = await open(path, "r");

            try {
                if (!(await file.stat()).isFile()) {
                    continue;
                }

                const bytes = Buffer.alloc(MAX_BYTES + 1);
                const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);

                if (bytesRead > MAX_BYTES) {
                    throw new Error(`Host instructions exceed ${String(MAX_BYTES)} bytes: ${path}`);
                }

                return [{ path, content: bytes.subarray(0, bytesRead).toString("utf8") }];
            } finally {
                await file.close();
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw error;
            }
        }
    }

    return [];
}

/** Instruction loading is read-only SFTP filesystem work; it never invokes remote scripts or local Git. */
export class RemoteContext {
    readonly #cache = new Map<string, { at: number; files: ContextFile[] }>();

    async load(env: ExecutionEnv, cwd: string, context: Context): Promise<ContextFile[]> {
        const key = JSON.stringify([env.id, cwd]);
        const cached = this.#cache.get(key);

        if (cached !== undefined && Date.now() - cached.at < STALE_MS) {
            return cached.files;
        }

        // Resolved by the remote environment, not Node's platform-specific path functions.
        const absolute = await env.absolutePath(cwd, context);

        if (!absolute.ok) {
            this.#cache.delete(key);

            throw absolute.error;
        }

        if (!posix.isAbsolute(absolute.value)) {
            throw new Error("The SSH workspace did not resolve to an absolute POSIX path.");
        }

        const folders: string[] = [];

        for (let folder = absolute.value; ; folder = posix.dirname(folder)) {
            folders.unshift(folder);

            if (posix.dirname(folder) === folder) {
                break;
            }

            if (folders.length > 100) {
                throw new Error("Remote instruction lookup exceeds 100 ancestor folders.");
            }
        }

        const files: ContextFile[] = [];
        let total = 0;

        try {
            for (const folder of folders) {
                for (const name of CONTEXT_NAMES) {
                    const path = posix.join(folder, name);
                    const opened = await env.openBinaryReader(path, undefined, context);

                    if (!opened.ok) {
                        if (
                            opened.error.code === "not_found" ||
                            opened.error.code === "is_directory"
                        ) {
                            continue;
                        }

                        throw opened.error;
                    }

                    try {
                        const bytes = await opened.value.read(0, MAX_BYTES + 1, context);

                        if (!bytes.ok) {
                            throw bytes.error;
                        }

                        total += bytes.value.byteLength;

                        if (bytes.value.byteLength > MAX_BYTES || total > MAX_CONTEXT_BYTES) {
                            throw new Error(
                                `Remote instructions exceed the prompt size limit: ${path}`,
                            );
                        }

                        files.push({
                            path,
                            content: new TextDecoder("utf-8", { fatal: true }).decode(bytes.value),
                        });
                    } finally {
                        await opened.value.close(BACKGROUND_CONTEXT);
                    }

                    break;
                }
            }
        } catch (error) {
            this.#cache.delete(key);

            throw error;
        }

        this.#cache.set(key, { at: Date.now(), files });

        return files;
    }
}

/** Registered host-global skills only. No arbitrary host reads, absolute resource paths, or script execution. */
export async function readHostSkill(
    skills: readonly Skill[],
    name: string,
    resource?: string,
    offset = 1,
    limit = 2000,
): Promise<string> {
    const skill = skills.find((each) => each.name === name);

    if (skill === undefined) {
        throw new Error(`No host-global skill is registered as ${JSON.stringify(name)}.`);
    }

    if (
        !Number.isSafeInteger(offset) ||
        offset < 1 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 2000
    ) {
        throw new Error(
            "offset must be a positive integer; limit must be between 1 and 2000 lines.",
        );
    }

    if (resource !== undefined && (isAbsolute(resource) || resource.includes("\0"))) {
        throw new Error(
            "A skill resource must be a relative path inside the registered skill directory.",
        );
    }

    const base = await realpath(skill.baseDir);
    const candidate = resource === undefined ? skill.filePath : resolve(base, resource);

    const assertInside = (path: string) => {
        const inside = relative(base, path);

        if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
            throw new Error(
                "A skill resource must remain inside the registered skill directory (including symlinks).",
            );
        }
    };

    if (resource !== undefined) {
        assertInside(candidate);
    }

    const path = await realpath(candidate);

    assertInside(path);

    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);

    try {
        if (!(await file.stat()).isFile()) {
            throw new Error("Host skill resources must be regular text files.");
        }

        const bytes = Buffer.alloc(MAX_BYTES + 1);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);

        if (bytesRead > MAX_BYTES) {
            throw new Error(`Host skill resources are limited to ${String(MAX_BYTES)} bytes.`);
        }

        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead));

        if (text.includes("\0")) {
            throw new Error("Host skill resources must be text, not binary data.");
        }

        const lines = text.split("\n");
        const end = Math.min(lines.length, offset - 1 + limit);

        return `${lines.slice(offset - 1, end).join("\n")}${end < lines.length ? `\n[More lines available: use offset ${String(end + 1)}.]` : ""}`;
    } finally {
        await file.close();
    }
}
