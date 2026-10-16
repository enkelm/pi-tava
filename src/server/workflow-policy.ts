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
import { describe, HttpError } from "./errors.ts";
import { commandWords, readOnlyCommand } from "./extensions/plan.ts";
import { requireResearch } from "./workflow-research.ts";

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

/** Built-ins whose arguments are not Git publication operations. Unknown aliases keep lexical refusal. */
const LOCAL_GIT_OPERATIONS = new Set([
    "add",
    "am",
    "apply",
    "bisect",
    "blame",
    "branch",
    "checkout",
    "cherry-pick",
    "commit",
    "config",
    "describe",
    "diff",
    "grep",
    "init",
    "log",
    "ls-files",
    "ls-tree",
    "merge",
    "rebase",
    "reflog",
    "remote",
    "restore",
    "rev-parse",
    "revert",
    "show",
    "stash",
    "status",
    "switch",
    "tag",
    "worktree",
]);

/** Recognize Git's operation, not a subcommand (stash push) or an option's value (-C push). */
function gitPublication(args: readonly string[]): boolean {
    for (let at = 0; at < args.length; at++) {
        const arg = args[at]!;

        if (["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"].includes(arg)) {
            at++;
        } else if (
            /^(?:-C.|-c.|--(?:git-dir|work-tree|namespace|config-env|exec-path|attr-source|list-cmds)=)/.test(
                arg,
            ) ||
            [
                "--no-pager",
                "-P",
                "--paginate",
                "-p",
                "--bare",
                "--no-replace-objects",
                "--literal-pathspecs",
                "--glob-pathspecs",
                "--noglob-pathspecs",
                "--icase-pathspecs",
                "--no-optional-locks",
                "--no-lazy-fetch",
                "--no-advice",
            ].includes(arg)
        ) {
            continue;
        } else if (arg.startsWith("-")) {
            // Do not guess how an unknown option consumes the remaining words.
            return lexicalPublication(["git", ...args]);
        } else {
            return (
                ["push", "send-pack", "receive-pack"].includes(arg.toLowerCase()) ||
                (!LOCAL_GIT_OPERATIONS.has(arg) && lexicalPublication(["git", ...args]))
            );
        }
    }

    return false;
}

/** Bounded lexical inspection, not a shell interpreter or a filesystem jail for trusted programs. */
function shellPublication(command: string | readonly string[], depth = 0): boolean {
    if (depth > 8) {
        return true;
    }

    const commands =
        typeof command === "string" ? commandWords(command.replace(/\\\r?\n/g, "")) : [command];

    if (commands === undefined) {
        // Redirects, substitutions and other unsupported syntax keep the conservative refusal.
        return lexicalPublication(command);
    }

    return commands.some((words) =>
        words.some((word, at) => {
            const program = basename(word);

            if (/^(?:gh|git-(?:send|receive)-pack)(?:\.exe)?$/i.test(program)) {
                return true;
            }

            if (/^git(?:\.exe)?$/i.test(program) && gitPublication(words.slice(at + 1))) {
                return true;
            }

            // Inspect shell/wrapper arguments and config/environment values, including ! shell aliases.
            const value = word.includes("=")
                ? word.slice(word.indexOf("=") + 1).replace(/^!/, "")
                : undefined;

            return [word, ...(value === undefined ? [] : [value])].some(
                (nested) => /[\s'"\\;|&()<>{}]/.test(nested) && shellPublication(nested, depth + 1),
            );
        }),
    );
}

/** Unsupported shell syntax must not hide explicit publication behind quotes, escapes or wrappers. */
function lexicalPublication(command: string | readonly string[]): boolean {
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
const localWriters = new WeakMap<PocketApp, Map<string, number>>();

function publicationKey(app: PocketApp, id: ConversationId): string {
    const root = app.rootOf(id);

    return app.sessionMeta(root)?.workItemId ?? `thread:${root}`;
}

/** Local writers cannot race an exclusive workflow operation's final checks and execution. */
export function requireWorkflowLocalWrite(app: PocketApp, id: ConversationId): void {
    app.handoffs.requireWritable(id);

    if (publicationLocks.get(app)?.has(publicationKey(app, id))) {
        throw new HttpError(
            409,
            "Publication is executing for this workflow. Wait before changing files, running shell commands or using the browser.",
        );
    }
}

/** Reserve before the first await; release only once the filesystem, child or panel action has settled. */
export function reserveWorkflowLocalWrite(app: PocketApp, id: ConversationId): () => void {
    requireWorkflowLocalWrite(app, id);
    let writers = localWriters.get(app);

    if (writers === undefined) {
        writers = new Map();
        localWriters.set(app, writers);
    }

    const key = publicationKey(app, id);

    writers.set(key, (writers.get(key) ?? 0) + 1);

    return () => {
        const remaining = writers.get(key)! - 1;

        if (remaining === 0) {
            writers.delete(key);
        } else {
            writers.set(key, remaining);
        }
    };
}

/** Discovery and exclusive admission share the same in-flight writer/operation gate. */
export function workflowExclusiveReason(app: PocketApp, id: ConversationId): string | undefined {
    const key = publicationKey(app, id);

    if (publicationLocks.get(app)?.has(key)) {
        return "Another publication is executing for this workflow.";
    }

    if ((localWriters.get(app)?.get(key) ?? 0) > 0) {
        return "Local workflow writes are still executing. Wait before an exclusive workflow operation.";
    }

    return undefined;
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

    const reason = workflowExclusiveReason(app, id);

    if (reason !== undefined) {
        throw new HttpError(409, reason);
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

                    if (app.handoffs.isPreparing(id)) {
                        return {
                            block: "The human requested a handoff summary only. Reply with the summary; do not call tools or change workflow.",
                        };
                    }

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

                    if (call.name === "research" || call.name === "browser") {
                        requireResearch(app, id);

                        if (
                            call.name === "browser" &&
                            ![
                                "navigate",
                                "snapshot",
                                "screenshot",
                                "scroll",
                                "viewport",
                                "console",
                                "wait",
                            ].includes(String(args.action))
                        ) {
                            return {
                                block: "Managed research browsing is a static reader. Use navigate with a public HTTPS document URL, snapshot, screenshot, scroll, viewport, console or wait; scripts, clicks, typing, history and form actions are blocked.",
                            };
                        }

                        return undefined;
                    }

                    if (call.name === "pull") {
                        return app.sessionMeta(app.rootOf(id))?.threadType === "pull"
                            ? undefined
                            : {
                                  block: "Only the current active Pull workflow may perform external reads.",
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
                        block: `${call.name} is not permitted in managed workflows. Unknown extension tools may publish or access the network; use publication for supported, individually approved external operations.`,
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
 * the separately approved mutation path; Pull has a constrained inbound-read adapter, not online shell access.
 * Known Git publication/GH commands are refused lexically,
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

    async #write<T>(
        path: string | undefined,
        run: () => Promise<Result<T, FileError>>,
    ): Promise<Result<T, FileError>> {
        let release: () => void;

        try {
            if (this.#app.handoffs.isManaged(this.#conversationId)) {
                requireWorkflowRequester(this.#app, this.#conversationId);
            }

            release = reserveWorkflowLocalWrite(this.#app, this.#conversationId);
        } catch (error) {
            return err(new FileError("permission_denied", describe(error), path));
        }

        try {
            return await run();
        } finally {
            release();
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
                    "Direct Git push/send-pack/receive-pack and GitHub CLI commands are blocked in managed shell, including file remotes. Use pull for supported active-Pull reads, or publication for supported, individually human-approved mutations.",
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

        // The graph gate covers owned tasks; this reservation also covers direct env callers and
        // remains held through the child's entire lifetime, not just its initial policy check.
        const release = readOnly ? () => {} : reserveWorkflowLocalWrite(app, id);

        try {
            return await super.exec(
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
        } finally {
            release();
        }
    }

    override async writeFile(path: string, content: string | Uint8Array, context: Context) {
        return this.#write(path, () => super.writeFile(path, content, context));
    }

    override async appendFile(path: string, content: string | Uint8Array, context: Context) {
        return this.#write(path, () => super.appendFile(path, content, context));
    }

    override async truncateFile(path: string, size: number, context: Context) {
        return this.#write(path, () => super.truncateFile(path, size, context));
    }

    override async flushFile(path: string, context: Context) {
        return this.#write(path, () => super.flushFile(path, context));
    }

    override async renameFile(source: string, destination: string, context: Context) {
        return this.#write(destination, () => super.renameFile(source, destination, context));
    }

    override async createDir(
        path: string,
        options: { recursive?: boolean } | undefined,
        context: Context,
    ) {
        return this.#write(path, () => super.createDir(path, options, context));
    }

    override async remove(
        path: string,
        options: { recursive?: boolean; force?: boolean } | undefined,
        context: Context,
    ) {
        return this.#write(path, () => super.remove(path, options, context));
    }

    override async createTempDir(prefix: string | undefined, context: Context) {
        return this.#write(undefined, () => super.createTempDir(prefix, context));
    }

    override async createTempFile(
        options: { prefix?: string; suffix?: string } | undefined,
        context: Context,
    ) {
        return this.#write(undefined, () => super.createTempFile(options, context));
    }
}

export function createWorkflowEnv(
    app: PocketApp,
    id: ConversationId,
    cwd: string,
): NodeExecutionEnv {
    return new WorkflowExecutionEnv(app, id, cwd);
}
