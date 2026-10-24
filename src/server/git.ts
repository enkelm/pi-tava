/** Literal, bounded Git execution, optionally bound to a remote workspace backend. */
import { isUtf8 } from "node:buffer";
import { execFile } from "node:child_process";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { safeWorkflowGit } from "./workflow-policy.ts";
import type { WorkspaceBackend } from "./workspace-backend.ts";

export type GitOptions = {
    allowExit?: number[];
    timeoutMs?: number;
    maxBuffer?: number;
    /** Re-evaluated for every subprocess; cached backends never freeze workflow policy. */
    offline?: boolean | (() => boolean);
    readOnly?: boolean;
    backend?: WorkspaceBackend;
    context?: Context;
    /** Native preparation revalidates its captured source before each subprocess. */
    check?: () => Promise<void>;
    /** Trusted core callers can suppress checkout/global config; mandatory safety variables win. */
    env?: Record<string, string>;
};

export class GitError extends Error {
    readonly exitCode: number | undefined;

    constructor(message: string, exitCode: number | undefined) {
        super(message);
        this.exitCode = exitCode;
    }
}

/** Raw stdout, for bundles/objects and callers that independently validate pathname encodings. */
export async function gitBytes(cwd: string, args: string[], options: GitOptions = {}): Promise<Buffer> {
    await options.check?.();
    options.context?.abortSignal?.throwIfAborted();

    if (options.backend !== undefined) {
        return options.backend.gitBytes(cwd, args, options);
    }

    const { allowExit = [], timeoutMs = 60_000, maxBuffer = 16 * 1024 * 1024 } = options;
    const offline = typeof options.offline === "function" ? options.offline() : options.offline;

    if (offline) {
        return safeWorkflowGit(cwd, args, options.context ?? BACKGROUND_CONTEXT, {
            timeoutMs,
            maxBytes: maxBuffer,
            allowExit,
            readOnly: options.readOnly,
            env: {
                ...options.env,
                GIT_LITERAL_PATHSPECS: "1",
                GIT_OPTIONAL_LOCKS: "0",
                GIT_NO_LAZY_FETCH: "1",
                LC_ALL: "C",
            },
        }).catch((error: unknown) => {
            if (error instanceof GitError) {
                throw error;
            }

            const failed = error as { code?: unknown; stderr?: unknown };
            const code = typeof failed.code === "number" ? failed.code : undefined;
            const stderr = Buffer.isBuffer(failed.stderr)
                ? failed.stderr.toString("utf8")
                : typeof failed.stderr === "string"
                  ? failed.stderr
                  : "";

            throw new GitError(
                stderr.trim() || (error instanceof Error ? error.message : String(error)),
                code,
            );
        });
    }

    return new Promise((resolve, reject) => {
        execFile(
            "git",
            ["-c", "core.fsmonitor=false", ...args],
            {
                cwd,
                encoding: "buffer",
                timeout: timeoutMs,
                maxBuffer,
                signal: options.context?.abortSignal,
                env: {
                    ...process.env,
                    ...options.env,
                    GIT_LITERAL_PATHSPECS: "1",
                    GIT_OPTIONAL_LOCKS: "0",
                    GIT_NO_LAZY_FETCH: "1",
                    LC_ALL: "C",
                },
            },
            (error, stdout, stderr) => {
                const code = typeof error?.code === "number" ? error.code : undefined;

                if (error === null || (code !== undefined && allowExit.includes(code))) {
                    resolve(stdout);
                } else {
                    reject(new GitError(stderr.toString("utf8").trim() || error.message, code));
                }
            },
        );
    });
}

/** Text consumers reject invalid UTF-8 rather than inspecting a different replacement-character pathname. */
export async function git(cwd: string, args: string[], options: GitOptions = {}): Promise<string> {
    const bytes = await gitBytes(cwd, args, options);

    if (!isUtf8(bytes)) {
        throw new GitError("Non-UTF-8 Git output is unsupported", undefined);
    }

    return bytes.toString("utf8");
}
