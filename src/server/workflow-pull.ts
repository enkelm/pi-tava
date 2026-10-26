/** Constrained inbound Git/GitHub reads for the active Pull thread, never an online shell. */
import { isUtf8 } from "node:buffer";
import { constants } from "node:fs";
import { access, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ConversationId, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { PocketApp } from "./app.ts";
import { WorkflowDoc } from "./workflow-docs.ts";
import type { WorkspaceBackend } from "./workspace-backend.ts";
import {
    importHostFetch,
    requireHostTransport,
    type WorkflowBackendFactory,
} from "./workflow-host-stage.ts";
import {
    requireWorkflowRequester,
    safeWorkflowGit,
    withWorkflowPublicationLock,
    workflowGitPath,
} from "./workflow-policy.ts";

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REMOTE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ITEM = /^[1-9]\d{0,9}$/;
const GH_LIST_VALUES = new Set(["--state", "--search", "--limit", "--author", "--label"]);
const SAFE_SSH =
    "/usr/bin/ssh -F /dev/null -oBatchMode=yes -oStrictHostKeyChecking=yes " +
    "-oPermitLocalCommand=no -oProxyCommand=none -oProxyJump=none " +
    "-oClearAllForwardings=yes -oControlMaster=no -oControlPath=none";

type PullCommand = { kind: "fetch"; remote: string } | { kind: "github"; command: string[] };

/** Parse once into canonical argv: no wrappers, arbitrary flags, stdin, URLs or host overrides. */
function parseCommand(command: readonly string[]): PullCommand {
    if (
        command.length < 2 ||
        command.length > 40 ||
        JSON.stringify(command).length > 16_000 ||
        command.some((arg) => /[\0\r\n]/.test(arg))
    ) {
        throw new Error("Give a bounded argv command, not shell text or multiline arguments.");
    }

    if (command[0] === "git" && command[1] === "fetch") {
        if (command.length !== 3 || !REMOTE.test(command[2]!)) {
            throw new Error(
                "Pull accepts only git fetch <configured-remote-name>, with no flags or refspecs.",
            );
        }

        return { kind: "fetch", remote: command[2]! };
    }

    const [program, topic, action] = command;

    if (
        program !== "gh" ||
        !["pr", "issue"].includes(topic!) ||
        !["view", "list"].includes(action!)
    ) {
        throw new Error(
            "Pull supports only git fetch and gh pr/issue view/list. Mutations and arbitrary API calls require other tools.",
        );
    }

    const output = ["gh", topic!, action!];
    let at = 3;

    if (action === "view") {
        if (!ITEM.test(command[at] ?? "")) {
            throw new Error("gh view requires one explicit numeric item ID.");
        }

        output.push(command[at++]!);
    }

    const seen = new Set<string>();
    let repo: string | undefined;

    for (; at < command.length; at++) {
        const [rawFlag, inline] = command[at]!.split(/=(.*)/s);
        const flag = rawFlag === "-R" ? "--repo" : rawFlag!;

        if (seen.has(flag)) {
            throw new Error(`Duplicate Pull option: ${flag}`);
        }

        seen.add(flag);

        if (flag === "--comments" && action === "view" && inline === undefined) {
            output.push(flag);
            continue;
        }

        const allowed =
            flag === "--repo" ||
            flag === "--json" ||
            (action === "list" &&
                (GH_LIST_VALUES.has(flag) ||
                    (topic === "pr" && ["--base", "--head"].includes(flag))));

        if (!allowed) {
            throw new Error(`Unsupported Pull option: ${command[at]}`);
        }

        const value = inline ?? command[++at];

        if (value === undefined || value === "" || value.startsWith("-")) {
            throw new Error(`An explicit value is required for ${flag}; stdin is unsupported.`);
        }

        if (flag === "--repo") {
            if (!REPO.test(value)) {
                throw new Error(
                    "gh Pull reads require an explicit --repo owner/repository on github.com.",
                );
            }

            repo = value;
        } else if (flag === "--limit") {
            if (!/^\d{1,3}$/.test(value) || Number(value) < 1 || Number(value) > 100) {
                throw new Error(
                    "gh list --limit must be between 1 and 100; unbounded pagination is unsupported.",
                );
            }
        } else if (flag === "--state") {
            if (!["open", "closed", "all", ...(topic === "pr" ? ["merged"] : [])].includes(value)) {
                throw new Error("Unsupported item state for this Pull read.");
            }
        } else if (
            flag === "--json" &&
            !/^[A-Za-z][A-Za-z0-9]*(,[A-Za-z][A-Za-z0-9]*)*$/.test(value)
        ) {
            throw new Error(
                "--json accepts only comma-separated field names, not scripts or templates.",
            );
        }

        if (flag !== "--repo") {
            output.push(`${flag}=${value}`);
        }
    }

    if (repo === undefined) {
        throw new Error("gh Pull reads require exactly one explicit --repo owner/repository.");
    }

    output.push(`--repo=github.com/${repo}`);

    if (action === "list" && !seen.has("--limit")) {
        output.push("--limit=20");
    }

    return { kind: "github", command: output };
}

async function executable(name: "git" | "gh"): Promise<string> {
    const git = name === "git" ? workflowGitPath() : undefined;

    if (git !== undefined) {
        return realpath(git);
    }

    for (const directory of (process.env.PATH ?? "/usr/bin:/bin").split(delimiter)) {
        if (!isAbsolute(directory)) {
            continue;
        }

        const candidate = join(directory, name);

        try {
            await access(candidate, constants.X_OK);
            const canonical = await realpath(candidate);

            if ((await stat(canonical)).isFile()) {
                return canonical;
            }
        } catch {
            // Resolve only the trusted launch PATH, never the checkout or an agent-supplied path.
        }
    }

    throw new Error(`${name} is not installed on the server's absolute PATH.`);
}

/** No inherited Git config injection, executable pager/editor, SSH command or helper overrides. */
function externalEnvironment(): Record<string, string> {
    const env: Record<string, string> = {
        PATH: (process.env.PATH ?? "/usr/bin:/bin")
            .split(delimiter)
            .filter(isAbsolute)
            .join(delimiter),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_NO_LAZY_FETCH: "1",
        GIT_SSH_COMMAND: SAFE_SSH,
        GH_HOST: "github.com",
        GH_PROMPT_DISABLED: "1",
        GH_PAGER: "/bin/cat",
        PAGER: "/bin/cat",
        NO_COLOR: "1",
    };

    for (const key of [
        "HOME",
        "TMPDIR",
        "SSH_AUTH_SOCK",
        "GH_TOKEN",
        "GITHUB_TOKEN",
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "NO_PROXY",
    ]) {
        if (process.env[key] !== undefined) {
            env[key] = process.env[key]!;
        }
    }

    return env;
}

function requirePull(app: PocketApp, id: ConversationId, expectedRequester?: string): string {
    const requester = requireWorkflowRequester(app, id);

    app.workItems.requireWritable(id);

    if (!app.workItems.isManaged(id) || app.sessionMeta(app.rootOf(id))?.threadType !== "pull") {
        throw new Error("Only the current active Pull workflow may perform external reads.");
    }

    if (expectedRequester !== undefined && expectedRequester !== requester) {
        throw new Error("Pull requester changed before execution. No external read ran.");
    }

    return requester;
}

async function requireActive(
    app: PocketApp,
    api: ToolExecutionApi,
    context: Context,
    requester: string,
) {
    requirePull(app, api.conversationId, requester);
    const state = await api.snapshot(WorkflowDoc, app.rootOf(api.conversationId), context);

    // Directly created Pull threads have the document's initial state even before it is persisted.
    if ((state?.status ?? "active") !== "active" || state?.readOnly === true) {
        throw new Error("This Pull workflow is no longer active.");
    }
}

async function remoteUrl(
    cwd: string,
    remote: string,
    context: Context,
    backend?: WorkspaceBackend,
): Promise<string> {
    const args = ["remote", "get-url", "--all", remote];
    const bytes =
        backend === undefined
            ? await safeWorkflowGit(cwd, args, context)
            : await backend.gitBytes(cwd, args, {
                  offline: true,
                  readOnly: true,
                  maxBuffer: 64 * 1024,
              });

    if (!isUtf8(bytes)) {
        throw new Error("Non-UTF-8 Git remote URLs are unsupported.");
    }

    // Remove only Git's one trailing newline: blank/multiple URLs must not be hidden by trim().
    const url = bytes.toString("utf8").replace(/\n$/, "");
    let supported =
        isAbsolute(url) ||
        /^[A-Za-z0-9_][A-Za-z0-9_.-]*@[A-Za-z0-9][A-Za-z0-9_.-]*:[A-Za-z0-9_./~-]+$/.test(url);

    if (/^(https:\/\/|ssh:\/\/|file:\/\/)/.test(url)) {
        try {
            const target = new URL(url);

            supported =
                target.protocol === "https:" ||
                (target.protocol === "file:" && ["", "localhost"].includes(target.hostname)) ||
                (target.protocol === "ssh:" &&
                    /^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(target.hostname) &&
                    (target.username === "" ||
                        /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(target.username)) &&
                    target.password === "" &&
                    /^[A-Za-z0-9_./~-]+$/.test(target.pathname) &&
                    target.search === "" &&
                    target.hash === "");
        } catch {
            supported = false;
        }
    }

    if (!supported || /[\0\r\n]/.test(url) || url.includes("::")) {
        throw new Error(
            "Pull requires one ordinary HTTPS, SSH or local-file fetch URL; custom transports and multiple URLs are unsupported.",
        );
    }

    if (backend !== undefined) {
        requireHostTransport(url);
    }

    return isAbsolute(url) ? resolve(cwd, url) : url;
}

async function fetchRemote(
    app: PocketApp,
    api: ToolExecutionApi,
    context: Context,
    remote: string,
    requester: string,
    backendFor?: WorkflowBackendFactory,
) {
    const id = api.conversationId;

    if (app.rootOf(id) !== id) {
        throw new Error(
            "Only the main Pull thread may fetch and update remote-tracking refs. Helpers may use GitHub reads.",
        );
    }

    const location = app.locationOf(id);

    if (location !== undefined && backendFor === undefined) {
        throw new Error(
            "SSH Pull requires a destination-bound offline workspace backend; no host-local fallback.",
        );
    }

    const backend = location === undefined ? undefined : await backendFor!(id, context);
    const canonicalCwd = () =>
        backend === undefined ? realpath(app.cwdOf(id)) : backend.canonical(app.cwdOf(id));
    const cwd = await canonicalCwd();
    const url = await remoteUrl(cwd, remote, context, backend);
    const destination = JSON.stringify(location);
    const program = await executable("git");
    const stage = await mkdtemp(join(tmpdir(), "pi-pull-"));

    try {
        // The only online Git repository is app-created: checkout config, hooks, credentials and refspecs
        // cannot turn an unapproved inbound read into arbitrary online child execution.
        await safeWorkflowGit(stage, ["init", "--bare", "--template=", "."], context, {
            program,
            readOnly: false,
            env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
        });
        await requireActive(app, api, context, requester);

        if (
            (await canonicalCwd()) !== cwd ||
            JSON.stringify(app.locationOf(id)) !== destination ||
            (await remoteUrl(cwd, remote, context, backend)) !== url
        ) {
            throw new Error(
                "Pull cwd or fetch URL changed before execution. No external fetch ran.",
            );
        }

        const fetchArgs = [
            "-c",
            "credential.helper=",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "protocol.allow=never",
            "-c",
            "protocol.https.allow=always",
            "-c",
            "protocol.ssh.allow=always",
            "-c",
            "protocol.file.allow=always",
            "-c",
            "gc.auto=0",
            "-c",
            "uploadpack.packObjectsHook=",
            "fetch",
            "--no-tags",
            "--no-recurse-submodules",
            "--no-auto-maintenance",
            "--",
            url,
            "refs/heads/*:refs/heads/*",
        ];

        if (url.startsWith("file://") || isAbsolute(url)) {
            // File transport starts a local upload-pack process, so it must never get online execution.
            await safeWorkflowGit(stage, fetchArgs, context, {
                program,
                readOnly: false,
                timeoutMs: 120_000,
                env: externalEnvironment(),
            });
        } else {
            const execution = await new NodeExecutionEnv({ cwd: stage }).exec(
                [program, ...fetchArgs],
                {
                    timeout: 120,
                    inheritEnv: false,
                    env: externalEnvironment(),
                    onOutput: (text, _context, info) => api.output(text, info.skipped),
                    window: api.outputWindow,
                },
                context,
            );

            if (!execution.ok) {
                throw new Error(
                    `Pull fetch stopped: ${execution.error.message}. No automatic retry; inspect local refs before another explicit attempt.`,
                );
            }

            if (execution.value.exitCode !== 0) {
                throw new Error(
                    `Pull fetch exited ${execution.value.exitCode}; checkout refs were not imported. No automatic retry.`,
                );
            }
        }

        await requireActive(app, api, context, requester);

        if (
            (await canonicalCwd()) !== cwd ||
            JSON.stringify(app.locationOf(id)) !== destination ||
            (await remoteUrl(cwd, remote, context, backend)) !== url
        ) {
            throw new Error(
                "Pull destination, cwd or URL changed during the read; fetched refs were not imported.",
            );
        }

        if (backend !== undefined) {
            await importHostFetch(backend.at(cwd), stage, remote, context);

            return {
                output: [
                    {
                        type: "text" as const,
                        text: `Fetched ${remote} on the Coop host and imported refs/remotes/${remote}/* into SSH · ${location!.host}. HEAD and working files were not integrated. Tags and pruning are not supported.`,
                    },
                ],
            };
        }

        // Git fetch dereferences symbolic destinations, even when their names are remote-tracking
        // refs. Inspect each actual destination (including dangling/chained symbols) before import.
        // Ordinary origin/HEAD is untouched unless upstream really has a branch named HEAD.
        const heads = await safeWorkflowGit(
            stage,
            ["for-each-ref", "--format=%(refname)", "refs/heads/"],
            context,
            { program },
        );

        if (!isUtf8(heads)) {
            throw new Error(
                "Non-UTF-8 upstream branch names are unsupported; refs were not imported.",
            );
        }

        for (const head of heads.toString("utf8").split("\n").filter(Boolean)) {
            const destination = `refs/remotes/${remote}/${head.slice("refs/heads/".length)}`;
            const symbolic = await safeWorkflowGit(
                cwd,
                ["symbolic-ref", "--quiet", "--no-recurse", destination],
                context,
                { program, allowExit: [1] },
            );

            if (symbolic.length > 0) {
                throw new Error(
                    `Pull will not import into symbolic tracking ref ${destination}; checkout refs were not imported.`,
                );
            }
        }

        // Import runs with checkout config, including URL rewrites. It must read the same staging
        // repository whose heads were checked above, not an unchecked file remote selected by insteadOf.
        const importUrl = await safeWorkflowGit(cwd, ["ls-remote", "--get-url", stage], context, {
            program,
        });

        if (!isUtf8(importUrl) || importUrl.toString("utf8").replace(/\n$/, "") !== stage) {
            throw new Error(
                "The staging import URL would be rewritten by checkout configuration; refs were not imported.",
            );
        }

        // Local import stays in the mandatory offline sandbox. Ignore configured fetch destinations:
        // only this remote's tracking refs may change, never HEAD, local branches, tags or working files.
        await safeWorkflowGit(
            cwd,
            [
                "-c",
                "core.hooksPath=/dev/null",
                "-c",
                "protocol.allow=never",
                "-c",
                "protocol.file.allow=always",
                "-c",
                "gc.auto=0",
                "fetch",
                "--no-tags",
                "--no-recurse-submodules",
                "--no-auto-maintenance",
                "--",
                stage,
                `+refs/heads/*:refs/remotes/${remote}/*`,
            ],
            context,
            { program, readOnly: false, timeoutMs: 120_000 },
        );

        return {
            output: [
                {
                    type: "text" as const,
                    text: `Fetched ${remote} into refs/remotes/${remote}/*. HEAD and working files were not integrated; use offline bash for an explicit local rebase. Tags and pruning are not supported.`,
                },
            ],
        };
    } finally {
        await rm(stage, { recursive: true, force: true });
    }
}

/** Register with pocket-core; role prompts and optional guards cannot grant this capability. */
export function createPullTool(app: PocketApp, backendFor?: WorkflowBackendFactory) {
    return defineTool({
        name: "pull",
        description:
            "Constrained external reads in the active Pull workflow: git fetch <configured-remote> (main thread only), or gh pr/issue view/list with explicit --repo owner/repository. Helpers inherit GitHub reads. No mutations, arbitrary API, shell, browser or automatic retries. Local rebases stay in offline bash.",
        parameters: Type.Object({
            command: Type.Array(Type.String(), { minItems: 2, maxItems: 40 }),
        }),
        replay: "unsafe",
        executionMode: "sequential",
        outputLimits: { retain: "tail" },
        execute: async (args, api, context) => {
            const requester = requirePull(app, api.conversationId);
            const parsed = parseCommand(args.command);

            // Share publication's work-item lock: local shell/writes and sibling external calls must
            // not race ref import or authorize a read against a moving checkout/requester.
            return withWorkflowPublicationLock(app, api.conversationId, async () => {
                await requireActive(app, api, context, requester);

                if (parsed.kind === "fetch") {
                    // The lock excludes later writers, but cannot stop a shell/helper already running.
                    // Refuse before even inspecting Git until independent work is quiescent; the
                    // invoking run and exact incoming brief already placed into it are not writers.
                    await api.commit(
                        (tx) => app.workItems.requireFetchIdle(tx, api.conversationId, api.taskId),
                        context,
                    );

                    return fetchRemote(app, api, context, parsed.remote, requester, backendFor);
                }

                const program = await executable("gh");
                // Explicit --repo reads never need checkout discovery. In particular an SSH cwd
                // must not gain host-local namesake meaning or load checkout-owned gh config.
                const cwd = await mkdtemp(join(tmpdir(), "pi-pull-github-"));

                try {
                    await requireActive(app, api, context, requester);
                    const execution = await new NodeExecutionEnv({ cwd }).exec(
                        [program, ...parsed.command.slice(1)],
                        {
                            timeout: 60,
                            inheritEnv: false,
                            env: externalEnvironment(),
                            onOutput: (text, _context, info) => api.output(text, info.skipped),
                            window: api.outputWindow,
                        },
                        context,
                    );

                    if (!execution.ok) {
                        throw new Error(
                            `Pull read stopped: ${execution.error.message}. No automatic retry.`,
                        );
                    }

                    if (execution.value.exitCode !== 0) {
                        throw new Error(
                            `Pull read exited ${execution.value.exitCode}. No automatic retry.`,
                        );
                    }

                    // Returning no explicit content makes Durable retain stdout/stderr as the model's result.
                    return {};
                } finally {
                    await rm(cwd, { recursive: true, force: true });
                }
            });
        },
    });
}
