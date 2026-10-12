/** Mandatory workflow capabilities, including an OS boundary around every managed child process. */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import { promisify } from "node:util";
import type { Context } from "@earendil-works/chord";
import { hook, ToolTask, type ConversationId } from "@earendil-works/pi-durable";
import {
    err,
    ExecutionError,
    FileError,
    type Result,
    type ShellExecOptions,
    type ShellExecResult,
} from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { PocketApp } from "./app.ts";
import { describe } from "./errors.ts";
import { commandWords, readOnlyCommand } from "./extensions/plan.ts";

/** Apple's /usr/bin/git is an xcrun trampoline that needs writes/services even for reads. Use the actual binary. */
export function workflowGitPath(): string | undefined {
    if (process.platform !== "darwin") {
        return undefined;
    }

    return [
        "/Library/Developer/CommandLineTools/usr/bin/git",
        "/Applications/Xcode.app/Contents/Developer/usr/bin/git",
    ].find((path) => existsSync(path));
}

/** Conservative lexical refusal, not a general shell interpreter or a filesystem jail for trusted programs. */
function shellPublication(command: string | readonly string[]): boolean {
    const words =
        typeof command === "string" ? (commandWords(command)?.flat() ?? [command]) : command;
    // Also inspect nested command text (for example bash -c), resolving lexical quotes/escapes conservatively.
    // Redirects/variables do not excuse an explicit publication command; opaque program behavior is not analyzed.
    const tokens = words.flatMap((word) =>
        word
            .replace(/\\\r?\n/g, "")
            .replace(/\\(.)/gs, "$1")
            .replace(/['"]/g, "")
            .split(/[\s;|&()<>{}]+/),
    );

    return tokens.some((word, at) => {
        const program = basename(word);

        if (/^(?:gh|git-(?:send|receive)-pack)(?:\.exe)?$/i.test(program)) {
            return true;
        }

        return (
            /^git(?:\.exe)?$/i.test(program) &&
            tokens
                .slice(at + 1)
                .some((arg) => ["push", "send-pack", "receive-pack"].includes(arg.toLowerCase()))
        );
    });
}

function sandboxProfile(readOnly: boolean): string {
    return [
        "(version 1)",
        "(allow default)",
        "(deny network*)",
        // Prevent delegation to unsandboxed local services such as automation/XPC brokers.
        "(deny mach-lookup)",
        "(deny appleevent-send)",
        ...(readOnly
            ? ["(deny file-write*)", '(allow file-write* (literal "/dev/null"))', "(deny signal)"]
            : []),
    ].join("\n");
}

const runFile = promisify(execFile);

/** Run managed Git and its descendants offline; inspection also denies local filesystem writes. */
export async function safeWorkflowGit(
    cwd: string,
    args: readonly string[],
    context: Context,
    options: {
        program?: string;
        env?: NodeJS.ProcessEnv;
        maxBytes?: number;
        timeoutMs?: number;
        allowExit?: readonly number[];
        /** Inspection is read-only by default; explicit local worktree operations may write. */
        readOnly?: boolean;
    } = {},
): Promise<Buffer> {
    if (process.platform !== "darwin") {
        throw new Error(
            "Managed Git requires a supported OS sandbox; unrestricted fallback is forbidden.",
        );
    }

    const program = options.program ?? workflowGitPath() ?? "/usr/bin/git";

    try {
        const result = await runFile(
            "/usr/bin/sandbox-exec",
            [
                "-p",
                sandboxProfile(options.readOnly !== false),
                program,
                "-c",
                "core.fsmonitor=false",
                ...args,
            ],
            {
                cwd,
                encoding: "buffer",
                maxBuffer: options.maxBytes ?? 32 * 1024 * 1024,
                timeout: options.timeoutMs ?? 15_000,
                signal: context.abortSignal,
                env: {
                    ...process.env,
                    GIT_OPTIONAL_LOCKS: "0",
                    GIT_NO_LAZY_FETCH: "1",
                    ...options.env,
                },
            },
        );

        return result.stdout;
    } catch (error) {
        const failed = error as { code?: unknown; stdout?: unknown };

        if (
            typeof failed.code === "number" &&
            options.allowExit?.includes(failed.code) &&
            Buffer.isBuffer(failed.stdout)
        ) {
            return failed.stdout;
        }

        throw error;
    }
}

const publicationLocks = new WeakMap<PocketApp, Set<string>>();

function publicationKey(app: PocketApp, id: ConversationId): string {
    const root = app.rootOf(id);

    return app.sessionMeta(root)?.workItemId ?? `thread:${root}`;
}

/** Local tools cannot race an approved publication's final checkpoint and external execution. */
export function requireWorkflowLocalWrite(app: PocketApp, id: ConversationId): void {
    app.handoffs.requireWritable(id);

    if (publicationLocks.get(app)?.has(publicationKey(app, id))) {
        throw new Error(
            "Publication is executing for this workflow. Wait before changing files or running shell commands.",
        );
    }
}

export async function withWorkflowPublicationLock<T>(
    app: PocketApp,
    id: ConversationId,
    run: () => Promise<T>,
): Promise<T> {
    let locks = publicationLocks.get(app);

    if (locks === undefined) {
        locks = new Set();
        publicationLocks.set(app, locks);
    }

    const root = publicationKey(app, id);

    if (locks.has(root)) {
        throw new Error("Another publication is executing for this workflow.");
    }

    locks.add(root);

    try {
        return await run();
    } finally {
        locks.delete(root);
    }
}

/** Re-evaluate identity, membership and steering rights, not the User object captured at admission. */
export function requireWorkflowRequester(app: PocketApp, id: ConversationId): string {
    const requester = app.attribution.requesterOf(id);
    const user = requester === undefined ? undefined : app.config.userById(requester);

    if (user === undefined) {
        throw new Error("Managed workflow execution requires a currently authorized requester.");
    }

    app.requireSee(user, id);
    app.requireSteer(user);

    return user.id;
}

export function createWorkflowHooks(app: PocketApp) {
    return [
        hook(ToolTask, {
            beforeTool: (call, api) => {
                const id = api.conversationId;

                if (!app.handoffs.isManaged(id)) {
                    return undefined;
                }

                try {
                    requireWorkflowRequester(app, id);
                    const args = call.arguments as Record<string, unknown>;
                    const readOnly = app.handoffs.isReadOnly(id);

                    if (!readOnly) {
                        if (call.name !== "publication") {
                            requireWorkflowLocalWrite(app, id);
                        }
                    }

                    if (["read", "bash", "codemode"].includes(call.name)) {
                        // Bash has an OS sandbox, including its arbitrary descendants. Nested codemode calls
                        // pass this hook independently; the script itself has no filesystem/network APIs.
                        return undefined;
                    }

                    if (call.name === "handoff" && args.action === "status") {
                        return undefined;
                    }

                    if (call.name === "publication" && args.action === "status") {
                        return undefined;
                    }

                    if (call.name === "artifact") {
                        return {
                            block: "Artifacts are blocked in managed workflows: scripts, forms and resource loads can make unapproved external requests from a viewer's device. Use static text/code instead, and publication for supported human-approved external operations.",
                        };
                    }

                    if (readOnly) {
                        return {
                            block: "This managed workflow predecessor is read-only. Use handoff status or read-only local inspection.",
                        };
                    }

                    if (
                        [
                            "write",
                            "edit",
                            "subagent",
                            "schedule",
                            "handoff",
                            "publication",
                        ].includes(call.name)
                    ) {
                        return undefined;
                    }

                    return {
                        block: `${call.name} is not permitted in managed workflows. Browser and unknown extension tools may publish or access the network; use publication for supported, individually approved external operations.`,
                    };
                } catch (error) {
                    return { block: describe(error) };
                }
            },
        }),
    ];
}

/**
 * Cached instances must consult live policy on every operation. There is deliberately no unrestricted fallback:
 * managed commands are offline, so HTTP/server tests and dependency downloads cannot run here. Publication is
 * the sole separately approved external execution path. Known Git publication/GH commands are refused lexically,
 * even for file remotes. Darwin seatbelt applies to child hooks and interpreters, not just command spelling, but
 * active local writes and arbitrary trusted programs are not a complete hostile-code filesystem sandbox.
 * Other platforms need an equivalent OS sandbox before shell execution is enabled.
 */
class WorkflowExecutionEnv extends NodeExecutionEnv {
    readonly #app: PocketApp;
    readonly #conversationId: ConversationId;

    constructor(app: PocketApp, id: ConversationId, cwd: string) {
        super({ cwd });
        this.#app = app;
        this.#conversationId = id;
    }

    #writeError(path?: string): Result<never, FileError> | undefined {
        try {
            requireWorkflowLocalWrite(this.#app, this.#conversationId);

            if (this.#app.handoffs.isManaged(this.#conversationId)) {
                requireWorkflowRequester(this.#app, this.#conversationId);
            }

            return undefined;
        } catch (error) {
            return err(new FileError("permission_denied", describe(error), path));
        }
    }

    override async exec(
        command: string | readonly string[],
        options: ShellExecOptions | undefined,
        context: Context,
    ): Promise<Result<ShellExecResult, ExecutionError>> {
        const app = this.#app;
        const id = this.#conversationId;

        if (!app.handoffs.isManaged(id)) {
            return super.exec(command, options, context);
        }

        try {
            requireWorkflowRequester(app, id);

            if (!app.handoffs.isReadOnly(id)) {
                requireWorkflowLocalWrite(app, id);
            }
        } catch (error) {
            return err(new ExecutionError("shell_unavailable", describe(error)));
        }

        if (shellPublication(command)) {
            return err(
                new ExecutionError(
                    "shell_unavailable",
                    "Direct Git push/send-pack/receive-pack and GitHub CLI commands are blocked in managed shell, including file remotes. Use publication for supported, individually human-approved operations.",
                ),
            );
        }

        const readOnly = app.handoffs.isReadOnly(id);
        const text =
            typeof command === "string"
                ? command
                : command.map((word) => `'${word.replaceAll("'", "'\\''")}'`).join(" ");

        if (readOnly && !readOnlyCommand(text)) {
            return err(
                new ExecutionError(
                    "shell_unavailable",
                    "Read-only workflow shell permits only verified simple inspection commands. Process control, interpreters and arbitrary shell are blocked.",
                ),
            );
        }

        if (process.platform !== "darwin") {
            return err(
                new ExecutionError(
                    "shell_unavailable",
                    "Managed workflow shell is disabled on this platform until an OS sandbox is supported. It must not fall back to unrestricted execution.",
                ),
            );
        }

        const profile = sandboxProfile(readOnly);
        const argv =
            typeof command === "string"
                ? ["/bin/bash", "--noprofile", "--norc", "-c", command]
                : [...command];

        // A missing/rejected sandbox returns a failed result from NodeExecutionEnv. Never retry raw.
        const git = workflowGitPath();
        const path = options?.env?.PATH ?? process.env.PATH ?? "/usr/bin:/bin";

        if (git !== undefined && (argv[0] === "git" || argv[0] === "/usr/bin/git")) {
            argv[0] = git;
        }

        return super.exec(
            ["/usr/bin/sandbox-exec", "-p", profile, ...argv],
            {
                ...options,
                env: {
                    ...options?.env,
                    PATH: git === undefined ? path : `${dirname(git)}:${path}`,
                    GIT_OPTIONAL_LOCKS: "0",
                },
            },
            context,
        );
    }

    override async writeFile(path: string, content: string | Uint8Array, context: Context) {
        return this.#writeError(path) ?? super.writeFile(path, content, context);
    }

    override async appendFile(path: string, content: string | Uint8Array, context: Context) {
        return this.#writeError(path) ?? super.appendFile(path, content, context);
    }

    override async truncateFile(path: string, size: number, context: Context) {
        return this.#writeError(path) ?? super.truncateFile(path, size, context);
    }

    override async flushFile(path: string, context: Context) {
        return this.#writeError(path) ?? super.flushFile(path, context);
    }

    override async renameFile(source: string, destination: string, context: Context) {
        return this.#writeError(destination) ?? super.renameFile(source, destination, context);
    }

    override async createDir(
        path: string,
        options: { recursive?: boolean } | undefined,
        context: Context,
    ) {
        return this.#writeError(path) ?? super.createDir(path, options, context);
    }

    override async remove(
        path: string,
        options: { recursive?: boolean; force?: boolean } | undefined,
        context: Context,
    ) {
        return this.#writeError(path) ?? super.remove(path, options, context);
    }

    override async createTempDir(prefix: string | undefined, context: Context) {
        return this.#writeError() ?? super.createTempDir(prefix, context);
    }

    override async createTempFile(
        options: { prefix?: string; suffix?: string } | undefined,
        context: Context,
    ) {
        return this.#writeError() ?? super.createTempFile(options, context);
    }
}

export function createWorkflowEnv(
    app: PocketApp,
    id: ConversationId,
    cwd: string,
): NodeExecutionEnv {
    return new WorkflowExecutionEnv(app, id, cwd);
}
