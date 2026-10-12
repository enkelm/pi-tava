/**
 * Git as Pi Pocket runs it for itself (Changes, branches, worktrees): literal paths, no optional locks or fsmonitor,
 * and English diagnostics. Managed callers opt into the offline OS sandbox, read-only unless a local mutation
 * explicitly permits writes. Ordinary callers retain configured clean/smudge filters and executable configuration.
 */
import { isUtf8 } from "node:buffer";
import { execFile } from "node:child_process";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { safeWorkflowGit } from "./workflow-policy.ts";

export type GitOptions = {
    /** Exit codes besides 0 that still mean success. */
    allowExit?: number[];
    timeoutMs?: number;
    maxBuffer?: number;
    /** Re-evaluated for each subprocess when a conversation can become managed during an in-flight read. */
    offline?: boolean | (() => boolean);
    /** Sandboxed inspection is read-only unless an explicit local Git operation needs writes. */
    readOnly?: boolean;
};

/** A git command that failed, with what git said (or why it did not run) as its message. */
export class GitError extends Error {
    /** Git's exit code; undefined when it did not get to exit (a timeout, or no git). */
    readonly exitCode: number | undefined;

    constructor(message: string, exitCode: number | undefined) {
        super(message);
        this.exitCode = exitCode;
    }
}

/** Run git in `cwd` and return what it printed. */
export function git(cwd: string, args: string[], options: GitOptions = {}): Promise<string> {
    const { allowExit = [], timeoutMs = 60_000, maxBuffer = 16 * 1024 * 1024 } = options;
    const offline = typeof options.offline === "function" ? options.offline() : options.offline;

    if (offline) {
        return safeWorkflowGit(cwd, args, BACKGROUND_CONTEXT, {
            timeoutMs,
            maxBytes: maxBuffer,
            allowExit,
            readOnly: options.readOnly,
            env: { GIT_LITERAL_PATHSPECS: "1", LC_ALL: "C" },
        })
            .then((output) => {
                if (!isUtf8(output)) {
                    throw new GitError("Non-UTF-8 Git output is unsupported", undefined);
                }

                return output.toString("utf8");
            })
            .catch((error: unknown) => {
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
                timeout: timeoutMs,
                maxBuffer,
                env: {
                    ...process.env,
                    GIT_LITERAL_PATHSPECS: "1",
                    GIT_OPTIONAL_LOCKS: "0",
                    LC_ALL: "C",
                },
            },
            (error, stdout, stderr) => {
                const code = typeof error?.code === "number" ? error.code : undefined;

                if (error === null || (code !== undefined && allowExit.includes(code))) {
                    resolve(stdout);
                } else {
                    reject(new GitError(stderr.trim() || error.message, code));
                }
            },
        );
    });
}
