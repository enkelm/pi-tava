/** Bounded workspace reads in an execution environment; never interprets its paths on the Coop host. */
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { promisify } from "node:util";
import { gzip as gzipCallback } from "node:zlib";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { getOrThrow, type ExecutionEnv, type FileInfo } from "@earendil-works/pi-durable/env";
import { HttpError } from "./errors.ts";
import { decodeText, MAX_EDIT_BYTES } from "./file-edits.ts";
import type { FileListing, FileView } from "./files.ts";
import { withSshFileSystem } from "./ssh-env.ts";

const gzip = promisify(gzipCallback);
const MAX_ENTRIES = 1000;
const MAX_MENTIONS = 10_000;
const SKIP = new Set(["node_modules", "__pycache__", "venv", "target", "site-packages"]);

/** Convert filesystem failures at the HTTP boundary without ever falling back to local files. */
export function remoteError(error: unknown): HttpError {
    if (error instanceof HttpError) {
        return error;
    }

    const code = (error as { code?: string } | undefined)?.code;

    return new HttpError(
        code === "not_found" ? 404 : code === "permission_denied" ? 403 : 409,
        error instanceof Error ? error.message : "Could not reach the SSH workspace.",
    );
}

export async function remoteDirectory(
    env: ExecutionEnv,
    path: string,
    context: Context = BACKGROUND_CONTEXT,
): Promise<string> {
    return withSshFileSystem(
        env,
        async () => {
            try {
                const absolute = getOrThrow(await env.absolutePath(path.trim() || "~", context));
                const canonical = getOrThrow(await env.canonicalPath(absolute, context));
                const info = getOrThrow(await env.fileInfo(canonical, context));

                if (info.kind !== "directory") {
                    throw new HttpError(400, `${absolute} is a file, not a folder.`);
                }

                return canonical;
            } catch (error) {
                throw remoteError(error);
            }
        },
        context,
    );
}

/** Scope remote viewers/invitees to the canonical remote root, not a same-named local directory or uploads. */
export async function remoteFile(
    env: ExecutionEnv,
    path: string,
    scoped: boolean,
    context: Context = BACKGROUND_CONTEXT,
): Promise<string> {
    return withSshFileSystem(
        env,
        async () => {
            if (path.includes("\0")) {
                throw new HttpError(400, "Invalid file path.");
            }

            const absolute = getOrThrow(await env.absolutePath(path, context));
            const canonical = getOrThrow(await env.canonicalPath(absolute, context));

            if (scoped) {
                const root = getOrThrow(await env.canonicalPath(env.cwd, context));
                const prefix = root.endsWith("/") ? root : root + "/";

                if (canonical !== root && !canonical.startsWith(prefix)) {
                    throw new HttpError(404, "File not found.");
                }
            }

            return canonical;
        },
        context,
    );
}

async function directoryEntries(env: ExecutionEnv, path: string, context: Context) {
    const reader = getOrThrow(await env.openDirReader(path, context));

    try {
        const entries: FileInfo[] = [];
        let done = false;

        while (!done && entries.length <= MAX_ENTRIES) {
            const page = getOrThrow(await reader.next(MAX_ENTRIES + 1 - entries.length, context));

            entries.push(...page.entries);
            done = page.done;
        }

        return { entries, done };
    } finally {
        await reader.close(context);
    }
}

export async function remoteView(
    env: ExecutionEnv,
    path: string,
    context: Context = BACKGROUND_CONTEXT,
    textSnapshot?: () => Promise<FileView | undefined>,
): Promise<FileView> {
    return withSshFileSystem(
        env,
        async () => {
            const info = getOrThrow(await env.fileInfo(path, context));

            if (info.kind === "directory") {
                const page = await directoryEntries(env, path, context);
                const entries = page.entries.slice(0, MAX_ENTRIES).map((entry) => ({
                    name: entry.name,
                    dir: entry.kind === "directory",
                }));

                entries.sort(
                    (a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name),
                );

                return {
                    kind: "folder",
                    entries,
                    truncated: !page.done || page.entries.length > MAX_ENTRIES,
                };
            }

            if (/\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i.test(path)) {
                return { kind: "image", size: info.size };
            }

            // A coherent native preview already contains these bytes. Use it first when eligible;
            // unsupported/binary/unsafe snapshots still use the ordinary read-only preview below.
            if (info.kind === "file" && info.size <= MAX_EDIT_BYTES && textSnapshot !== undefined) {
                const snapshot = await textSnapshot();

                context.abortSignal?.throwIfAborted();

                if (snapshot !== undefined) {
                    return snapshot;
                }
            }

            const reader = getOrThrow(await env.openBinaryReader(path, undefined, context));

            try {
                const bytes = Buffer.from(
                    getOrThrow(await reader.read(0, MAX_EDIT_BYTES + 1, context)),
                );
                const after = getOrThrow(await reader.info(context));
                const shown = bytes.subarray(0, MAX_EDIT_BYTES);
                const text = decodeText(shown);
                const truncated = bytes.length > MAX_EDIT_BYTES || after.size !== bytes.length;

                if (shown.includes(0) || (!truncated && text === undefined)) {
                    return { kind: "binary", size: after.size };
                }

                // SFTP has no atomic compare-and-swap with arbitrary remote writers. No revision/quick-edit promise.
                return {
                    kind: "text",
                    size: after.size,
                    text: text ?? shown.toString("utf8"),
                    truncated,
                };
            } finally {
                await reader.close(context);
            }
        },
        context,
    );
}

/** Image bytes travel back over the remote backend, never through a host-local path. */
export async function remoteImage(
    env: ExecutionEnv,
    path: string,
    context: Context = BACKGROUND_CONTEXT,
): Promise<Buffer> {
    return withSshFileSystem(
        env,
        async () => {
            const reader = getOrThrow(await env.openBinaryReader(path, undefined, context));

            try {
                const info = getOrThrow(await reader.info(context));
                const limit = 25 * 1024 * 1024;

                if (info.size > limit) {
                    throw new HttpError(413, "Image too large to show");
                }

                const bytes = Buffer.from(getOrThrow(await reader.read(0, limit + 1, context)));

                if (bytes.length > limit) {
                    throw new HttpError(413, "Image too large to show");
                }

                return bytes;
            } finally {
                await reader.close(context);
            }
        },
        context,
    );
}

/** Bounded mention discovery. No symlink traversal, Git children, persistent remote helper or local cache. */
export async function remoteFileList(
    env: ExecutionEnv,
    context: Context = BACKGROUND_CONTEXT,
): Promise<FileListing> {
    return withSshFileSystem(
        env,
        async () => {
            const files: string[] = [];
            const pending = [""];
            const deadline = Date.now() + 5000;
            let truncated = false;
            let visited = 0;

            while (pending.length > 0 && files.length < MAX_MENTIONS && visited < MAX_MENTIONS) {
                if (Date.now() > deadline) {
                    truncated = true;
                    break;
                }

                const relative = pending.shift()!;
                const path = posix.join(env.cwd, relative);
                const page = await directoryEntries(env, path, context);

                truncated ||= !page.done || page.entries.length > MAX_ENTRIES;
                visited += page.entries.length;

                for (const entry of page.entries.slice(0, MAX_ENTRIES)) {
                    if (entry.name.startsWith(".") || SKIP.has(entry.name)) {
                        continue;
                    }

                    const name = posix.join(relative, entry.name);

                    if (entry.kind === "directory") {
                        pending.push(name);
                    } else if (entry.kind === "file") {
                        files.push(name);
                    }

                    if (files.length >= MAX_MENTIONS) {
                        truncated = true;
                        break;
                    }
                }
            }

            truncated ||= pending.length > 0;
            files.sort();
            const version = createHash("sha256")
                .update(JSON.stringify([env.id, env.cwd, files, truncated]))
                .digest("hex");
            const list = { files, truncated, version };
            const json = JSON.stringify(list);

            return { ...list, json, gzipped: () => gzip(json) };
        },
        context,
    );
}

export async function remoteFolders(
    env: ExecutionEnv,
    requested: string,
    hidden: boolean,
    context: Context = BACKGROUND_CONTEXT,
) {
    return withSshFileSystem(
        env,
        async () => {
            const path = await remoteDirectory(env, requested, context);
            const page = await directoryEntries(env, path, context);
            const dirs: { name: string; path: string }[] = [];

            for (const entry of page.entries.slice(0, MAX_ENTRIES)) {
                if (!hidden && entry.name.startsWith(".")) {
                    continue;
                }

                const child = posix.join(path, entry.name);
                let directory = entry.kind === "directory";

                if (entry.kind === "symlink") {
                    const canonical = await env.canonicalPath(child, context);
                    const info = canonical.ok
                        ? await env.fileInfo(canonical.value, context)
                        : canonical;

                    if (info.ok) {
                        directory = info.value.kind === "directory";
                    } else if (
                        info.error.code !== "not_found" &&
                        info.error.code !== "not_directory"
                    ) {
                        throw info.error;
                    }
                }

                if (directory) {
                    dirs.push({ name: entry.name, path: child });
                }
            }

            dirs.sort((a, b) => a.name.localeCompare(b.name));

            return {
                path,
                parent: posix.dirname(path) === path ? null : posix.dirname(path),
                home: getOrThrow(await env.absolutePath("~", context)),
                dirs,
                recent: [] as string[],
            };
        },
        context,
    );
}
