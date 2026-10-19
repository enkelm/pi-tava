/** Passive saved SSH host suggestions. Never resolves destinations or runs config commands. */
import { constants } from "node:fs";
import { open, opendir, stat } from "node:fs/promises";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { join, matchesGlob, parse, resolve, sep } from "node:path";
import { validateSshHost } from "./ssh-env.ts";

const MAX_FILE_BYTES = 256 * 1024;
const MAX_BYTES = 1024 * 1024;
const MAX_FILES = 128;
const MAX_DEPTH = 16;
const MAX_ALIASES = 256;
const MAX_GLOB_WORK = 8192;

/** Split config arguments, preserving quoted spaces and ignoring comments outside quotes. */
function argumentsOf(value: string): string[] | undefined {
    const result: string[] = [];
    let token = "";
    let quoted = "";
    let started = false;

    for (let i = 0; i < value.length; i++) {
        const c = value[i]!;

        if (c === "\\" && i + 1 < value.length) {
            token += value[++i];
            started = true;
        } else if (quoted) {
            if (c === quoted) {
                quoted = "";
            } else {
                token += c;
            }
        } else if (c === '"' || c === "'") {
            quoted = c;
            started = true;
        } else if (c === "#") {
            break;
        } else if (/\s/.test(c)) {
            if (started) {
                result.push(token);
                token = "";
                started = false;
            }
        } else {
            token += c;
            started = true;
        }
    }

    if (quoted) {
        return undefined;
    }

    if (started) {
        result.push(token);
    }

    return result;
}

function missing(error: unknown): boolean {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * Read ~/.ssh/config's static Include graph and hostnames from ~/.ssh/known_hosts,
 * not private keys, shell history or effective ssh -G config. No public-key fields
 * are returned. Suggestions can occur in conditional blocks: this is not a
 * connection/availability check. Relative Includes remain rooted at ~/.ssh,
 * even inside nested files. Only ~/ is expanded; commands, env and SSH tokens
 * are never evaluated. Missing roots/Include matches are normal.
 *
 * Work is bounded to 128 file attempts, 16 Include levels, 256 KiB per file,
 * 1 MiB overall, 8192 glob entries/directory visits and 256 aliases. Unsupported
 * expansions, unreadable/nonregular files and exhausted bounds set incomplete.
 */
export async function discoverSshHosts(
    options: { home?: string } = {},
): Promise<{ hosts: string[]; incomplete: boolean }> {
    const home = resolve(options.home ?? homedir());
    const userRoot = join(home, ".ssh");
    const aliases = new Map<string, string>();
    const visited = new Set<string>();
    let incomplete = false;
    let files = 0;
    let bytes = 0;
    let globWork = 0;

    // Expand one path segment at a time: OpenSSH globbing is not recursive **.
    // Directory iteration is bounded even when a glob has no matches.
    async function expand(pattern: string): Promise<string[]> {
        const root = parse(pattern).root;
        const parts = pattern.slice(root.length).split(sep);
        let paths = [root];

        for (const part of parts) {
            if (!/[*?[]/.test(part)) {
                paths = paths.map((path) => join(path, part));
                continue;
            }

            if (globWork >= MAX_GLOB_WORK) {
                incomplete = true;

                return [];
            }

            const next: string[] = [];

            for (const parent of paths) {
                if (++globWork > MAX_GLOB_WORK) {
                    incomplete = true;
                    break;
                }

                try {
                    const directory = await opendir(parent);

                    for await (const entry of directory) {
                        if (++globWork > MAX_GLOB_WORK) {
                            incomplete = true;
                            break;
                        }

                        if (matchesGlob(entry.name, part)) {
                            if (next.length >= MAX_FILES) {
                                incomplete = true;
                                break;
                            }

                            next.push(join(parent, entry.name));
                        }
                    }
                } catch (error) {
                    if (!missing(error)) {
                        incomplete = true;
                    }
                }

                if (globWork > MAX_GLOB_WORK || next.length >= MAX_FILES) {
                    incomplete = true;
                    break;
                }
            }

            paths = next.sort();
        }

        return paths;
    }

    function add(value: string): void {
        try {
            validateSshHost(value);
        } catch {
            return;
        }

        const key = value.toLowerCase();

        if (!aliases.has(key)) {
            if (aliases.size >= MAX_ALIASES) {
                incomplete = true;

                return;
            }

            aliases.set(key, value);
        }
    }

    async function readBounded(
        path: string,
        depth = 0,
        seen?: Set<string>,
    ): Promise<string | undefined> {
        if (files >= MAX_FILES || bytes >= MAX_BYTES) {
            incomplete = true;

            return;
        }

        files++;

        try {
            // Avoid opening devices/FIFOs; O_NONBLOCK plus fstat also protects
            // against a regular file being replaced with a FIFO after stat.
            const info = await stat(path);

            if (!info.isFile()) {
                incomplete = true;

                return;
            }

            const identity = `${info.dev}:${info.ino}`;

            if (seen?.has(identity)) {
                return;
            }

            if (depth > MAX_DEPTH) {
                incomplete = true;

                return;
            }

            seen?.add(identity);
            const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);

            try {
                const current = await file.stat();
                const limit = Math.min(MAX_FILE_BYTES, MAX_BYTES - bytes);

                if (!current.isFile() || current.size > limit) {
                    incomplete = true;

                    return;
                }

                const buffer = Buffer.alloc(limit + 1);
                let length = 0;

                while (length < buffer.length) {
                    const read = await file.read(buffer, length, buffer.length - length, null);

                    if (!read.bytesRead) {
                        break;
                    }

                    length += read.bytesRead;
                }

                bytes += length;

                if (length > limit) {
                    incomplete = true;

                    return;
                }

                return buffer.toString("utf8", 0, length);
            } finally {
                await file.close();
            }
        } catch (error) {
            if (!missing(error)) {
                incomplete = true;
            }

            return;
        }
    }

    async function visit(path: string, base: string, depth: number): Promise<void> {
        const content = await readBounded(path, depth, visited);

        if (content === undefined) {
            return;
        }

        for (const line of content.split(/\r?\n/)) {
            const directive = /^\s*(host|include)(?:\s*=\s*|\s+|$)(.*)$/i.exec(line);

            if (!directive) {
                continue;
            }

            const values = argumentsOf(directive[2]!);

            if (!values) {
                incomplete = true;
                continue;
            }

            if (directive[1]!.toLowerCase() === "host") {
                for (const value of values) {
                    if (/[*?![\]]/.test(value)) {
                        continue;
                    }

                    add(value);
                }
            } else {
                for (let value of values) {
                    if (
                        !value ||
                        /[$%`]/.test(value) ||
                        (value[0] === "~" && !value.startsWith("~/"))
                    ) {
                        incomplete = true;
                        continue;
                    }

                    if (value.startsWith("~/")) {
                        value = join(home, value.slice(2));
                    }

                    for (const included of await expand(resolve(base, value))) {
                        await visit(included, base, depth + 1);
                    }
                }
            }
        }
    }

    await visit(join(userRoot, "config"), userRoot, 0);

    const knownHosts = await readBounded(join(userRoot, "known_hosts"));

    for (const line of knownHosts?.split(/\r?\n/) ?? []) {
        // Require the shape of a saved host-key record, but interpret only the
        // first field. All marker lines (including revoked/CA keys) are omitted.
        const first = /^\s*([^\s#@]+)\s+\S+\s+\S+/.exec(line)?.[1];

        if (!first || first.startsWith("|")) {
            continue;
        }

        for (const name of first.split(",")) {
            if (/[*?!@|]/.test(name) || name.includes("://")) {
                continue;
            }

            const withPort = /^\[([^\]]+)\]:(\d+)$/.exec(name);

            if (withPort) {
                const hostname = withPort[1]!;
                const port = Number(withPort[2]);

                if (port < 1 || port > 65535) {
                    continue;
                }

                const host = isIP(hostname) === 6 ? `[${hostname}]` : hostname;

                add(`ssh://${host}:${withPort[2]}`);
            } else if (!/[\[\]]/.test(name)) {
                add(isIP(name) === 6 ? `[${name}]` : name);
            }
        }
    }

    return {
        hosts: [...aliases.entries()]
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([, v]) => v),
        incomplete,
    };
}
