/** A destination-bound filesystem and Git capability. Remote paths never fall through to host-local I/O. */
import { copyFile, lstat, readlink } from "node:fs/promises";
import * as localPaths from "node:path";
import { posix } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
    getOrThrow,
    type ExecutionEnv,
    type FileInfo,
    type Result,
    type FileError,
    type ShellExecOptions,
    type ShellExecResult,
    type ExecutionError,
} from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { gitBytes as localGitBytes, GitError, type GitOptions } from "./git.ts";

export type WorkspaceFileInfo = FileInfo & { mode: number };

/** Extra inspection only: neither arbitrary commands nor writable file descriptors. */
export type WorkspaceInspection = {
    lstat(path: string, context: Context): Promise<Result<WorkspaceFileInfo, FileError>>;
    readlink(path: string, context: Context): Promise<Result<Uint8Array, FileError>>;
};

export type ConfinedExec = (
    command: string | readonly string[],
    options: ShellExecOptions,
    context: Context,
    readOnly: boolean,
) => Promise<Result<ShellExecResult, ExecutionError>>;

type BackendOptions = {
    remote?: boolean;
    cwd?: string;
    context?: Context;
    inspection?: WorkspaceInspection;
    /** Must enforce the target-native OS boundary for the command and all descendants. */
    confinedExec?: ConfinedExec;
    /** Trusted host-service reads still recheck identity and the selected destination. */
    authorize?: (write: boolean) => void;
    reserveWrite?: () => () => void;
    /** Factory-bound managed policy cannot be weakened by a caller omitting offline:true. */
    offline?: () => boolean;
};

/** Missing is the only filesystem failure callers may treat as absence. Auth/transport failures propagate. */
export function isMissingWorkspaceFile(error: unknown): boolean {
    return ["not_found", "not_directory", "ENOENT", "ENOTDIR"].includes(
        String((error as { code?: unknown } | undefined)?.code),
    );
}

export class WorkspaceBackend {
    readonly env: ExecutionEnv;
    readonly id: string;
    readonly cwd: string;
    readonly remote: boolean;
    readonly paths: typeof posix;
    readonly context: Context;
    readonly #options: BackendOptions;

    constructor(env: ExecutionEnv, options: BackendOptions = {}) {
        this.env = env;
        this.id = env.id;
        this.cwd = options.cwd ?? env.cwd;
        this.remote = options.remote ?? env.id.startsWith("ssh:");
        this.paths = this.remote ? posix : localPaths;
        this.context = options.context ?? BACKGROUND_CONTEXT;
        this.#options = options;
    }

    static local(cwd: string, context?: Context): WorkspaceBackend {
        return new WorkspaceBackend(new NodeExecutionEnv({ cwd }), { remote: false, context });
    }

    /** Final reauthorization after compound reads which intentionally tolerate individual missing files. */
    checkAccess(write = false): void {
        this.#options.authorize?.(write);
    }

    /** Rebind cwd without mutating a cached environment or changing its authentication/policy capability. */
    at(cwd: string): WorkspaceBackend {
        return new WorkspaceBackend(this.env, { ...this.#options, cwd });
    }

    async absolute(path: string): Promise<string> {
        this.#options.authorize?.(false);

        if (path === "~" || path.startsWith("~/")) {
            return getOrThrow(await this.env.absolutePath(path, this.context));
        }

        return this.paths.resolve(this.cwd, path);
    }

    async canonical(path: string): Promise<string> {
        const canonical = getOrThrow(
            await this.env.canonicalPath(await this.absolute(path), this.context),
        );

        this.#options.authorize?.(false);

        return canonical;
    }

    /** Canonicalize deleted paths through their nearest existing ancestor, without crossing namespaces. */
    async canonicalWithMissingTail(path: string): Promise<string> {
        const missing: string[] = [];
        let ancestor = await this.absolute(path);

        while (true) {
            try {
                return this.paths.resolve(await this.canonical(ancestor), ...missing);
            } catch (error) {
                if (!isMissingWorkspaceFile(error)) {
                    throw error;
                }

                const parent = this.paths.dirname(ancestor);

                if (parent === ancestor) {
                    throw error;
                }

                missing.unshift(this.paths.basename(ancestor));
                ancestor = parent;
            }
        }
    }

    async exists(path: string): Promise<boolean> {
        return getOrThrow(await this.env.exists(await this.absolute(path), this.context));
    }

    async lstat(path: string): Promise<WorkspaceFileInfo> {
        const absolute = await this.absolute(path);

        if (this.remote) {
            if (this.#options.inspection === undefined) {
                throw new Error(
                    "Remote filesystem inspection is unavailable; no host-local fallback.",
                );
            }

            return getOrThrow(await this.#options.inspection.lstat(absolute, this.context));
        }

        const info = await lstat(absolute);

        if (!info.isFile() && !info.isDirectory() && !info.isSymbolicLink()) {
            throw new Error("Unsupported workspace file type.");
        }

        return {
            name: this.paths.basename(absolute),
            path: absolute,
            kind: info.isSymbolicLink() ? "symlink" : info.isDirectory() ? "directory" : "file",
            size: info.size,
            mtimeMs: info.mtimeMs,
            mode: info.mode,
        };
    }

    async readlink(path: string): Promise<Buffer> {
        const absolute = await this.absolute(path);

        if (this.remote) {
            if (this.#options.inspection === undefined) {
                throw new Error(
                    "Remote symlink inspection is unavailable; no host-local fallback.",
                );
            }

            return Buffer.from(
                getOrThrow(await this.#options.inspection.readlink(absolute, this.context)),
            );
        }

        return readlink(absolute, { encoding: "buffer" });
    }

    /** Read one opened regular file with a hard bound. No decoded-string round trip. */
    async readBytes(path: string, limit: number): Promise<Buffer> {
        const reader = getOrThrow(
            await this.env.openBinaryReader(await this.absolute(path), undefined, this.context),
        );
        let output: Buffer;

        try {
            const info = getOrThrow(await reader.info(this.context));

            if (info.size > limit) {
                throw new Error(`Workspace file exceeds ${limit} bytes.`);
            }

            const chunks: Buffer[] = [];
            let length = 0;

            while (length <= limit) {
                const chunk = Buffer.from(
                    getOrThrow(
                        await reader.read(
                            length,
                            Math.min(64 * 1024, limit + 1 - length),
                            this.context,
                        ),
                    ),
                );

                if (chunk.length === 0) {
                    break;
                }

                chunks.push(chunk);
                length += chunk.length;
            }

            const after = getOrThrow(await reader.info(this.context));

            if (
                length > limit ||
                length !== info.size ||
                after.size !== info.size ||
                after.mtimeMs !== info.mtimeMs
            ) {
                throw new Error("Workspace file changed or exceeded its read limit.");
            }

            output = Buffer.concat(chunks, length);
        } finally {
            await reader.close(this.context);
        }

        this.#options.authorize?.(false);

        return output;
    }

    async mkdir(path: string, check?: () => Promise<void>): Promise<void> {
        const absolute = await this.absolute(path);

        await check?.();
        this.context.abortSignal?.throwIfAborted();
        getOrThrow(await this.env.createDir(absolute, { recursive: true }, this.context));
    }

    async remove(path: string): Promise<void> {
        getOrThrow(await this.env.remove(await this.absolute(path), { force: true }, this.context));
    }

    async copyFile(
        from: string,
        into: string,
        limit: number,
        options: GitOptions = {},
    ): Promise<void> {
        await this.mkdir(this.paths.dirname(into), options.check);

        if (!this.remote) {
            const source = await this.absolute(from);
            const target = await this.absolute(into);

            await options.check?.();
            this.context.abortSignal?.throwIfAborted();
            await copyFile(source, target);

            return;
        }

        const info = await this.lstat(from);
        const bytes = await this.readBytes(from, limit);
        const target = await this.absolute(into);

        await options.check?.();
        this.context.abortSignal?.throwIfAborted();
        getOrThrow(await this.env.writeFile(target, bytes, this.context));
        // chmod is fixed argv, confined under the same live policy as worktree creation. No shell fragments.
        const result = getOrThrow(
            await this.exec(
                ["chmod", (info.mode & 0o777).toString(8), await this.absolute(into)],
                { timeout: 15 },
                options,
                false,
            ),
        );

        if (result.exitCode !== 0) {
            throw new Error("Could not preserve copied remote file permissions.");
        }
    }

    /** Backend-owned fixed operations, with an explicit mandatory offline boundary when requested. */
    async exec(
        command: string | readonly string[],
        options: ShellExecOptions,
        policy: GitOptions,
        readOnly: boolean,
    ) {
        await policy.check?.();
        this.context.abortSignal?.throwIfAborted();
        this.#options.authorize?.(!readOnly);
        const offline =
            this.#options.offline?.() === true ||
            (typeof policy.offline === "function" ? policy.offline() : policy.offline);
        const release = !readOnly ? this.#options.reserveWrite?.() : undefined;

        try {
            if (offline) {
                if (!this.remote || this.#options.confinedExec === undefined) {
                    throw new Error(
                        "Managed fixed workspace operation requires target-native confinement; unrestricted fallback is forbidden.",
                    );
                }

                return await this.#options.confinedExec(command, options, this.context, readOnly);
            }

            return await this.env.exec(command, options, this.context);
        } finally {
            release?.();
        }
    }

    async contains(root: string, path: string): Promise<boolean> {
        const base = await this.canonical(root);
        const target = await this.canonical(path);
        const relative = this.paths.relative(base, target);

        return (
            relative === "" ||
            (relative !== ".." &&
                !relative.startsWith(`..${this.paths.sep}`) &&
                !this.paths.isAbsolute(relative))
        );
    }

    /** Git stdout is bytes, not ExecutionEnv's potentially lossy UTF-8 output stream. */
    async gitBytes(cwd: string, args: string[], options: GitOptions = {}): Promise<Buffer> {
        await options.check?.();
        this.context.abortSignal?.throwIfAborted();
        this.#options.authorize?.(options.readOnly === false);
        const release = options.readOnly === false ? this.#options.reserveWrite?.() : undefined;

        try {
            return await this.#gitBytes(cwd, args, {
                ...options,
                offline: () =>
                    this.#options.offline?.() === true ||
                    (typeof options.offline === "function"
                        ? options.offline()
                        : options.offline) === true,
            });
        } finally {
            release?.();
        }
    }

    async #gitBytes(cwd: string, args: string[], options: GitOptions): Promise<Buffer> {
        if (!this.remote) {
            const { backend: _backend, ...local } = options;

            const output = await localGitBytes(cwd, args, { ...local, context: this.context });

            this.#options.authorize?.(options.readOnly === false);

            return output;
        }

        const offline = typeof options.offline === "function" ? options.offline() : options.offline;
        const execute = offline ? this.#options.confinedExec : undefined;

        if (offline && execute === undefined) {
            throw new GitError(
                "Managed remote Git requires target-native confinement; unrestricted fallback is forbidden.",
                undefined,
            );
        }

        const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
        const maxBytes = options.maxBuffer ?? 16 * 1024 * 1024;
        const maxEncoded = Math.ceil(maxBytes / 3) * 4;
        let encoded = "";
        let diagnostics = "";
        // The entire fixed pipeline is confined, not just git. Git's exit status survives base64.
        const command = [
            "/bin/bash",
            "--noprofile",
            "--norc",
            "-c",
            `set -o pipefail; git -c core.fsmonitor=false ${args.map(quote).join(" ")} | base64`,
        ];
        const execOptions: ShellExecOptions = {
            cwd,
            timeout: (options.timeoutMs ?? 60_000) / 1000,
            env: {
                ...options.env,
                GIT_LITERAL_PATHSPECS: "1",
                GIT_OPTIONAL_LOCKS: "0",
                GIT_NO_LAZY_FETCH: "1",
                LC_ALL: "C",
            },
            onOutput(text, _context, info) {
                if (info.skipped !== undefined) {
                    throw new Error("Git output was omitted by transport.");
                }

                if (info.stream === "stdout") {
                    encoded += text.replace(/[\r\n]/g, "");

                    if (encoded.length > maxEncoded) {
                        throw new Error("Git output exceeded its byte limit.");
                    }
                } else {
                    diagnostics = (diagnostics + text).slice(-64 * 1024);
                }
            },
        };
        const result =
            execute === undefined
                ? await this.env.exec(command, execOptions, this.context)
                : await execute(command, execOptions, this.context, options.readOnly !== false);

        if (!result.ok) {
            throw new GitError(result.error.message, undefined);
        }

        this.#options.authorize?.(options.readOnly === false);
        const code = result.value.exitCode;

        if (code !== 0 && !options.allowExit?.includes(code)) {
            throw new GitError(diagnostics.trim() || `Git exited ${code}.`, code);
        }

        const bytes = Buffer.from(encoded, "base64");

        if (bytes.length > maxBytes || bytes.toString("base64") !== encoded) {
            throw new GitError(
                "Invalid or oversized base64 Git output; no decoded text fallback.",
                undefined,
            );
        }

        return bytes;
    }
}
