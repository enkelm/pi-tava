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
    type ExecutionEnv,
} from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { describe, HttpError } from "./errors.ts";
import { commandWords, readOnlyCommand } from "./extensions/plan.ts";
import { requireResearch } from "./workflow-research.ts";
import { sandboxProfile } from "./workflow-shell.ts";

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

/** Locate Git's operation without mistaking a global option's value for it. Unknown options stay opaque. */
function gitOperation(args: readonly string[]): number | undefined {
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
            return undefined;
        } else {
            return at;
        }
    }

    return args.length;
}

/** Recognize Git's operation, not a subcommand (stash push) or an option's value (-C push). */
function gitPublication(args: readonly string[]): boolean {
    const at = gitOperation(args);
    const operation = at === undefined ? undefined : args[at];

    if (at === undefined) {
        return lexicalPublication(["git", ...args]);
    }

    return (
        operation !== undefined &&
        (["push", "send-pack", "receive-pack"].includes(operation.toLowerCase()) ||
            (!LOCAL_GIT_OPERATIONS.has(operation) && lexicalPublication(["git", ...args])))
    );
}

function inspectionWords(words: readonly string[]): boolean {
    // Normalize only the executable's path; operands remain separate, literal shell words.
    return readOnlyCommand(
        [basename(words[0] ?? ""), ...words.slice(1)]
            .map((word) => `'${word.replaceAll("'", "'\\''")}'`)
            .join(" "),
    );
}

/** Non-editing commits have literal message operands; unknown option consumption stays opaque. */
function commitInspectionWords(words: readonly string[]): readonly string[] | undefined {
    if (!/^git(?:\.exe)?$/i.test(basename(words[0] ?? ""))) {
        return undefined;
    }

    const operation = gitOperation(words.slice(1));

    if (operation === undefined || words[operation + 1] !== "commit") {
        return undefined;
    }

    const inspected = words.slice(0, operation + 2);

    for (let at = operation + 2; at < words.length; at++) {
        const word = words[at]!;

        if (word === "--") {
            inspected.push(...words.slice(at));
            break;
        }

        if (word === "-m" || word === "--message") {
            at++;
        } else if (word.startsWith("--message=") || /^-m./s.test(word)) {
            continue;
        } else if (
            word.startsWith("-") &&
            ![
                "-a",
                "--all",
                "-q",
                "--quiet",
                "--amend",
                "--allow-empty",
                "--allow-empty-message",
                "--no-edit",
                "-n",
                "--no-verify",
                "--no-gpg-sign",
                "-s",
                "--signoff",
                "--no-signoff",
                "--reset-author",
            ].includes(word)
        ) {
            // Editors can execute the message itself. Unknown/combined/value-taking options
            // also keep the original scan rather than guessing which operands they consume.
            return undefined;
        } else {
            inspected.push(word);
        }
    }

    return inspected;
}

/** A later interpreter could execute COMMIT_EDITMSG even without a pipe. Keep the whole list bounded. */
function localIntegrationWords(words: readonly string[]): boolean {
    if (inspectionWords(words)) {
        return true;
    }

    if (!/^git(?:\.exe)?$/i.test(basename(words[0] ?? ""))) {
        return false;
    }

    const args = words.slice(1);
    const operation = gitOperation(args);

    if (operation === undefined) {
        return false;
    }

    for (let at = 0; at < operation; at++) {
        if (["-C", "--git-dir", "--work-tree"].includes(args[at]!)) {
            at++;
        } else if (
            !/^(?:-C.|--(?:git-dir|work-tree)=)/.test(args[at]!) &&
            args[at] !== "--no-pager"
        ) {
            // Executable global configuration is not an inspection/integration continuation.
            return false;
        }
    }

    const action = args.slice(operation);

    return (
        inspectionWords(["git", ...action]) ||
        commitInspectionWords(words) !== undefined ||
        (action.length === 3 &&
            action[0] === "merge" &&
            action[1] === "--ff-only" &&
            !action[2]!.startsWith("-"))
    );
}

/** Only proven data positions are exempt. Quoting alone never makes a shell/config/script payload inert. */
function publicationWords(
    words: readonly string[],
    searchData: boolean,
    commitData: boolean,
): readonly string[] {
    if (["rg", "grep"].includes(basename(words[0] ?? "")) && searchData && inspectionWords(words)) {
        return words.slice(0, 1);
    }

    return (commitData ? commitInspectionWords(words) : undefined) ?? words;
}

/** Bounded lexical inspection, not a shell interpreter or a filesystem jail for trusted programs. */
function shellPublication(command: string | readonly string[], depth = 0): boolean {
    if (depth > 8) {
        return true;
    }

    const normalized = typeof command === "string" ? command.replace(/\\\r?\n/g, "") : command;
    const commands = typeof normalized === "string" ? commandWords(normalized) : [normalized];

    if (commands === undefined) {
        // Redirects, substitutions and other unsupported syntax keep the conservative refusal.
        return lexicalPublication(command);
    }

    // A search feeding an interpreter is not inert. Without a full pipeline interpreter, exempt
    // search operands only for a single invocation or a wholly verified inspection command list.
    const searchData = commands.length === 1 || commands.every(inspectionWords);
    // Git prints the subject in its commit summary: a pipe can turn that prose into executable input.
    const commitData =
        (commands.length === 1 || commands.every(localIntegrationWords)) &&
        (typeof normalized !== "string" ||
            commandWords(normalized, { pipelines: false }) !== undefined);

    return commands.some((commandWords) => {
        const words =
            depth === 0 ? publicationWords(commandWords, searchData, commitData) : commandWords;

        return words.some((word, at) => {
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
        });
    });
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
    app.workItems.requireWritable(id);

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

export type WorkflowRequester = Pick<
    User,
    "id" | "tokenHash" | "role" | "sessions" | "projectAccess"
>;

/** Live identity: explicit human reads need visibility, while agent operations also need steering. */
export function requireWorkflowRequester(
    app: PocketApp,
    id: ConversationId,
    explicit?: WorkflowRequester,
    readOnly = false,
): string {
    const requester = explicit?.id ?? app.attribution.requesterOf(id);
    const user = requester === undefined ? undefined : app.config.userById(requester);

    if (user === undefined || (explicit !== undefined && user.tokenHash !== explicit.tokenHash)) {
        throw new Error(
            "Workflow execution requires a currently authorized requester. Sign in again if access changed.",
        );
    }

    app.requireSee(user, id);

    if (explicit === undefined || !readOnly) {
        app.requireSteer(user);
    }

    if (
        explicit !== undefined &&
        (user.role !== explicit.role ||
            JSON.stringify(user.sessions) !== JSON.stringify(explicit.sessions) ||
            JSON.stringify(user.projectAccess) !== JSON.stringify(explicit.projectAccess))
    ) {
        throw new Error("The requester's authority changed. Start a fresh workspace request.");
    }

    return user.id;
}

export function createWorkflowHooks(app: PocketApp) {
    return [
        hook(ToolTask, {
            beforeTool: (call, api) => {
                const id = api.conversationId;

                if (!app.workItems.isManaged(id)) {
                    return undefined;
                }

                try {
                    requireWorkflowRequester(app, id);

                    const args = call.arguments as Record<string, unknown>;
                    const readOnly = app.workItems.executionBlocked(id);

                    if (app.workItems.isPreparing(id)) {
                        return {
                            block: "The human requested a handoff summary only. Reply with the summary; do not call tools or change workflow.",
                        };
                    }

                    if (!readOnly) {
                        if (call.name !== "publication") {
                            requireWorkflowLocalWrite(app, id);
                        }
                    }

                    if (["read", "host_skill", "bash", "codemode"].includes(call.name)) {
                        // Bash has an OS sandbox, including its arbitrary descendants. Nested codemode calls
                        // pass this hook independently; the script itself has no filesystem/network APIs.
                        return undefined;
                    }

                    if (
                        call.name === "handoff" &&
                        (args.action === "status" || args.action === "start")
                    ) {
                        // The owner may recover an existing start receipt after source retirement.
                        // Its final admission still rejects every fresh transfer from a retired source.
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
                            "stage_upload",
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
export type ConfinedExec = (
    readOnly: boolean,
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    context: Context,
) => Promise<Result<ShellExecResult, ExecutionError>>;

const mutations = new Set([
    "writeFile",
    "appendFile",
    "truncateFile",
    "flushFile",
    "renameFile",
    "createDir",
    "remove",
    "createTempDir",
    "createTempFile",
]);

/** One live policy boundary for host and SSH environments, including direct UI callers. */
export function protectWorkflowEnv<T extends ExecutionEnv>(
    app: PocketApp,
    id: ConversationId,
    env: T,
    confinedExec: ConfinedExec,
    requester?: WorkflowRequester,
): T {
    const identity =
        requester === undefined
            ? undefined
            : {
                  id: requester.id,
                  tokenHash: requester.tokenHash,
                  role: requester.role,
                  sessions: requester.sessions?.slice(),
                  projectAccess:
                      requester.projectAccess === undefined
                          ? undefined
                          : {
                                ...requester.projectAccess,
                                hosts: requester.projectAccess.hosts?.slice(),
                                projectIds: requester.projectAccess.projectIds?.slice(),
                            },
              };

    return new Proxy(env, {
        get(target, property) {
            // The confined backend is an implementation capability, not another execution entry point.
            if (property === "execConfined") {
                return undefined;
            }

            const value = Reflect.get(target, property, target);

            if (typeof value !== "function") {
                return value;
            }

            if (property === "cleanup") {
                return value.bind(target);
            }

            if (property === "exec") {
                return async (
                    command: string | readonly string[],
                    options: ShellExecOptions | undefined,
                    context: Context,
                ) => {
                    let release: (() => void) | undefined;

                    try {
                        const managed = app.workItems.isManaged(id);

                        if (managed || identity !== undefined) {
                            requireWorkflowRequester(app, id, identity);
                        }

                        if (!managed) {
                            const result = await target.exec(command, options, context);

                            if (identity !== undefined) {
                                requireWorkflowRequester(app, id, identity);
                            }

                            return result;
                        }

                        const readOnly = app.workItems.executionBlocked(id);

                        if (typeof command !== "string" && command.length === 0) {
                            return err(new ExecutionError("spawn_error", "Empty command"));
                        }

                        if (shellPublication(command)) {
                            return err(
                                new ExecutionError(
                                    "shell_unavailable",
                                    "Direct Git push/send-pack/receive-pack and GitHub CLI commands are blocked in managed shell, including file remotes. Use pull for supported active-Pull reads, or publication for supported, individually human-approved mutations.",
                                ),
                            );
                        }

                        const text =
                            typeof command === "string"
                                ? command
                                : command
                                      .map((word) => `'${word.replaceAll("'", "'\\''")}'`)
                                      .join(" ");

                        if (readOnly && !readOnlyCommand(text)) {
                            return err(
                                new ExecutionError(
                                    "shell_unavailable",
                                    "Read-only workflow shell permits only verified simple inspection commands. Process control, interpreters and arbitrary shell are blocked.",
                                ),
                            );
                        }

                        if (!readOnly) {
                            release = reserveWorkflowLocalWrite(app, id);
                        }

                        const result = await confinedExec(readOnly, command, options, context);

                        requireWorkflowRequester(app, id, identity);

                        return result;
                    } catch (error) {
                        return err(new ExecutionError("shell_unavailable", describe(error)));
                    } finally {
                        release?.();
                    }
                };
            }

            return async (...args: unknown[]) => {
                let release: (() => void) | undefined;

                try {
                    if (mutations.has(String(property))) {
                        if (app.workItems.isManaged(id) || identity !== undefined) {
                            requireWorkflowRequester(app, id, identity);
                        }

                        release = reserveWorkflowLocalWrite(app, id);
                    } else if (app.workItems.isManaged(id) || identity !== undefined) {
                        requireWorkflowRequester(app, id, identity, true);
                    }

                    const result = await Reflect.apply(value, target, args);

                    if (app.workItems.isManaged(id) || identity !== undefined) {
                        requireWorkflowRequester(
                            app,
                            id,
                            identity,
                            !mutations.has(String(property)),
                        );
                    }

                    return result;
                } catch (error) {
                    return err(new FileError("permission_denied", describe(error)));
                } finally {
                    release?.();
                }
            };
        },
    });
}

export function createWorkflowEnv(
    app: PocketApp,
    id: ConversationId,
    cwd: string,
    requester?: WorkflowRequester,
): NodeExecutionEnv {
    const env = new NodeExecutionEnv({ cwd });

    return protectWorkflowEnv(
        app,
        id,
        env,
        async (readOnly, command, options, context) => {
            if (process.platform !== "darwin") {
                return err(
                    new ExecutionError(
                        "shell_unavailable",
                        "Managed workflow shell is disabled on this platform until an OS sandbox is supported. It must not fall back to unrestricted execution.",
                    ),
                );
            }

            const argv =
                typeof command === "string"
                    ? ["/bin/bash", "--noprofile", "--norc", "-c", command]
                    : [...command];
            const git = workflowGitPath();
            const path = options?.env?.PATH ?? process.env.PATH ?? "/usr/bin:/bin";

            if (git !== undefined && (argv[0] === "git" || argv[0] === "/usr/bin/git")) {
                argv[0] = git;
            }

            // Requested environment is installed only after seatbelt, never in its native loader.
            const workloadEnv = {
                ...options?.env,
                PATH: git === undefined ? path : `${dirname(git)}:${path}`,
                GIT_OPTIONAL_LOCKS: "0",
            };

            return env.exec(
                [
                    "/usr/bin/sandbox-exec",
                    "-p",
                    sandboxProfile(readOnly),
                    "/usr/bin/env",
                    ...(options?.inheritEnv === false ? ["-i"] : []),
                    ...Object.entries(workloadEnv).map(([key, value]) => `${key}=${value}`),
                    ...argv,
                ],
                { ...options, env: undefined, inheritEnv: true },
                context,
            );
        },
        requester,
    );
}
