/** Approval-bound external operations, with durable uncertainty receipts and no automatic mutation replay. */
import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, readdir, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
    defineDoc,
    defineTool,
    type ConversationId,
    type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { PocketApp } from "./app.ts";
import type { ApprovalAnswer } from "./host.ts";
import { DecisionsDoc } from "./docs.ts";
import { HandoffsDoc, WorkflowDoc } from "./workflow-docs.ts";
import {
    requireWorkflowRequester,
    safeWorkflowGit,
    withWorkflowPublicationLock,
    workflowGitPath,
} from "./workflow-policy.ts";

export type PublicationReceipt = {
    id: string;
    command: string[];
    cwd: string;
    fingerprint: string;
    requester: string;
    approver: string;
    approvedAt: number;
    reason: string;
    state: "executing" | "completed" | "reconciled";
    exitCode?: number;
    resolution?: { by: string; at: number; outcome: string; reason: string };
};

/** A crash between external execution and settlement leaves executing forever, until human reconciliation. */
export const PublicationsDoc = defineDoc<{ receipts: Record<string, PublicationReceipt> }>({
    kind: "pocket.workflow-publications",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ receipts: {} }),
});

const MAX_FILE = 8 * 1024 * 1024;
const GH_ACTIONS: Record<string, readonly string[]> = {
    pr: [
        "create",
        "edit",
        "comment",
        "close",
        "reopen",
        "ready",
        "review",
        "merge",
        "view",
        "list",
        "status",
    ],
    issue: ["create", "edit", "comment", "close", "reopen", "view", "list", "status"],
};
const GH_SWITCHES = new Set([
    "--draft",
    "--approve",
    "--request-changes",
    "--comment",
    "--delete-branch",
    "--auto",
    "--disable-auto",
    "--squash",
    "--merge",
    "--rebase",
    "--admin",
    "--edit-last",
    "--create-if-none",
    "--delete-last",
    "--yes",
]);
const GH_VALUES = new Set([
    "--title",
    "-t",
    "--body",
    "-b",
    "--body-file",
    "-F",
    "--repo",
    "-R",
    "--base",
    "-B",
    "--head",
    "-H",
    "--assignee",
    "-a",
    "--reviewer",
    "-r",
    "--label",
    "-l",
    "--milestone",
    "-m",
    "--project",
    "-p",
    "--add-assignee",
    "--remove-assignee",
    "--add-reviewer",
    "--remove-reviewer",
    "--add-label",
    "--remove-label",
    "--add-project",
    "--remove-project",
    "--state",
    "--search",
    "--limit",
    "--author",
    "--reason",
    "--match-head-commit",
    "--json",
]);
const GIT_SWITCHES = new Set([
    "--atomic",
    "--dry-run",
    "-n",
    "--porcelain",
    "--verbose",
    "-v",
    "--quiet",
    "-q",
    "--force",
    "-f",
]);

/** No shell, aliases, arbitrary executables, global git options or transport-program overrides. */
function validateCommand(command: readonly string[]): void {
    if (
        command.length < 2 ||
        command.length > 100 ||
        command.some((arg) => arg.includes("\0")) ||
        JSON.stringify(command).length > 32_000
    ) {
        throw new Error("Give a bounded exact argv command, not shell text.");
    }

    if (command[0] === "git" && command[1] === "push") {
        for (const arg of command.slice(2)) {
            if (
                arg.startsWith("-") &&
                !GIT_SWITCHES.has(arg) &&
                !/^--force-with-lease=refs\/(heads|tags)\/[A-Za-z0-9_./-]+:[0-9a-f]{40,64}$/.test(
                    arg,
                )
            ) {
                throw new Error(`Unsupported git push option: ${arg}`);
            }

            if (arg.includes("ext::") || arg.includes("\n") || arg.includes("\r")) {
                throw new Error(
                    "External git transport programs and multiline targets are not permitted.",
                );
            }
        }

        const targets = command.slice(2).filter((arg) => !arg.startsWith("-"));

        if (
            targets.length !== 2 ||
            !/^[A-Za-z0-9_./-]+:refs\/(heads|tags)\/[A-Za-z0-9_./-]+$/.test(targets[1]!) ||
            targets[1]!.includes("..")
        ) {
            throw new Error(
                "git push requires one explicit remote and one source:refs/heads/name (or refs/tags/name) refspec. Implicit, deletion, all and mirror pushes are not supported.",
            );
        }

        return;
    }

    if (command[0] !== "gh" || !GH_ACTIONS[command[1]!]?.includes(command[2]!)) {
        throw new Error(
            "Publication supports only git push and explicit gh pr/issue operations. Shells, aliases and wrappers are not permitted.",
        );
    }

    let repoCount = 0;
    let headCount = 0;

    for (let i = 3; i < command.length; i++) {
        const arg = command[i]!;

        if (!arg.startsWith("-")) {
            if (!/^\d+$/.test(arg) || ["create", "list", "status"].includes(command[2]!)) {
                throw new Error(
                    "gh operations accept only numeric item IDs, not URLs or implicit repository targets.",
                );
            }

            continue;
        }

        const [flag, inline] = arg.split(/=(.*)/s);

        if (GH_SWITCHES.has(flag!)) {
            if (inline !== undefined) {
                throw new Error(`Unsupported option value: ${arg}`);
            }

            continue;
        }

        if (!GH_VALUES.has(flag!) || flag === "--body-file" || flag === "-F") {
            throw new Error(
                `Unsupported gh option: ${arg}. Interactive editor, browser and shell operations are not permitted.`,
            );
        }

        const value = inline ?? command[++i];

        if (value === undefined || value === "-") {
            throw new Error(`An explicit value is required for ${flag}; stdin is not supported.`);
        }

        if (flag === "--head" || flag === "-H") {
            headCount++;

            if (
                !/^[A-Za-z0-9_./-]+$/.test(value) ||
                value.includes("..") ||
                value.startsWith("-")
            ) {
                throw new Error(
                    "PR creation requires a named local source branch, not an external or implicit source.",
                );
            }
        }

        if (flag === "--repo" || flag === "-R") {
            repoCount++;

            if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
                throw new Error("gh --repo must explicitly name owner/repository.");
            }
        }
    }

    if (repoCount !== 1) {
        throw new Error("gh publication requires exactly one explicit --repo owner/repository.");
    }

    if (command[1] === "pr" && command[2] === "create" && headCount !== 1) {
        throw new Error(
            "PR creation requires exactly one explicit --head local branch matching the inherited Land checkpoint.",
        );
    }
}

async function executable(name: string): Promise<string> {
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
            // Only absolute trusted launch-PATH entries are searched; never the workflow's cwd.
        }
    }

    throw new Error(`${name} is not installed on the server's absolute PATH.`);
}

async function hashFile(path: string, limit = MAX_FILE): Promise<string> {
    const canonical = await realpath(path);
    const info = await stat(canonical);

    if (!info.isFile() || info.size > limit) {
        throw new Error(
            `Publication input must be a regular file of at most ${limit} bytes: ${path}`,
        );
    }

    const bytes = await readFile(canonical);

    if (bytes.length > limit) {
        throw new Error(`Publication input grew beyond its size limit: ${path}`);
    }

    return createHash("sha256").update(canonical).update(bytes).digest("hex");
}

async function inspectGit(
    cwd: string,
    program: string,
    args: string[],
    context: Context,
): Promise<string> {
    const output = await safeWorkflowGit(cwd, args, context, { program, maxBytes: MAX_FILE });

    if (!isUtf8(output)) {
        throw new Error("Non-UTF-8 Git inspection output is unsupported for publication.");
    }

    return output.toString("utf8");
}

async function requirePublicationSource(
    app: PocketApp,
    id: ConversationId,
    command: readonly string[],
    landedHead: string,
    context: Context,
): Promise<void> {
    let source: string | undefined;

    if (command[0] === "git") {
        source = command
            .slice(2)
            .filter((arg) => !arg.startsWith("-"))[1]!
            .split(":")[0];
    } else if (command[1] === "pr" && command[2] === "create") {
        for (let i = 3; i < command.length; i++) {
            const [flag, inline] = command[i]!.split(/=(.*)/s);

            if (!GH_VALUES.has(flag!)) {
                continue;
            }

            const value = inline ?? command[++i];

            if (flag === "--head" || flag === "-H") {
                source = `refs/heads/${value}`;
            }
        }
    }

    if (source === undefined) {
        return;
    }

    const cwd = await realpath(app.cwdOf(id));
    const git = await executable("git");
    const commit = (
        await inspectGit(cwd, git, ["rev-parse", "--verify", `${source}^{commit}`], context)
    ).trim();

    if (commit !== landedHead) {
        throw new Error(
            "Publication source is not the inherited Land head. Review and Land that source before publishing it.",
        );
    }
}

async function pinCommand(
    app: PocketApp,
    id: ConversationId,
    requested: readonly string[],
    program: string,
    landedHead: string,
    context: Context,
): Promise<string[]> {
    if (requested[0] !== "git") {
        await requirePublicationSource(app, id, requested, landedHead, context);
        const pinned = [...requested];

        for (let i = 3; i < pinned.length; i++) {
            const [flag, inline] = pinned[i]!.split(/=(.*)/s);

            if (!GH_VALUES.has(flag!)) {
                continue;
            }

            if (inline === undefined) {
                i++;
            }

            if (flag === "--repo" || flag === "-R") {
                pinned[i] =
                    inline === undefined
                        ? `github.com/${pinned[i]}`
                        : `${flag}=github.com/${inline}`;
            }
        }

        return pinned;
    }

    const cwd = await realpath(app.cwdOf(id));
    const targets = requested.slice(2).filter((arg) => !arg.startsWith("-"));
    const remote = targets[0]!;
    const [source, destination] = targets[1]!.split(":");
    const commit = (
        await inspectGit(cwd, program, ["rev-parse", "--verify", `${source}^{commit}`], context)
    ).trim();

    if (commit !== landedHead) {
        throw new Error(
            "Publication source is not the inherited Land head. Review and Land that source before publishing it.",
        );
    }

    const url = (
        await inspectGit(cwd, program, ["remote", "get-url", "--push", "--all", remote], context)
    ).trim();

    if (
        !/^[0-9a-f]{40,64}$/.test(commit) ||
        url === "" ||
        /[\r\n\0]/.test(url) ||
        url.includes("ext::") ||
        url.startsWith("-")
    ) {
        throw new Error(
            "Publication requires one resolved push URL and a concrete source commit; external transport helpers are unsupported.",
        );
    }

    const supported =
        /^(https?:\/\/|ssh:\/\/|file:\/\/)/.test(url) ||
        /^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+:[^\s]+$/.test(url) ||
        (!url.includes(":") && !/\s/.test(url));

    if (!supported || url.includes("::")) {
        throw new Error(
            "Only ordinary HTTPS, SSH and local-file push transports are supported; custom remote helpers are not permitted.",
        );
    }

    const effective = (
        await inspectGit(cwd, program, ["ls-remote", "--get-url", url], context)
    ).trim();

    if (effective !== url) {
        throw new Error(
            "The resolved push URL would be rewritten again by Git configuration. Remove that ambiguity before publication.",
        );
    }

    return [
        "git",
        "push",
        ...requested.slice(2).filter((arg) => arg.startsWith("-")),
        url,
        `${commit}:${destination}`,
    ];
}

async function checkpoint(
    app: PocketApp,
    id: ConversationId,
    command: readonly string[],
    program: string,
    context: Context,
): Promise<string> {
    const cwd = await realpath(app.cwdOf(id));
    const hash = createHash("sha256").update(
        JSON.stringify({ command, cwd, program, fingerprint: await app.handoffs.fingerprint(id) }),
    );

    hash.update(await hashFile(program, 256 * 1024 * 1024));

    // Git configuration and push hooks are executable publication inputs, usually outside the tracked tree.
    if (command[0] === "git") {
        const config = await inspectGit(
            cwd,
            program,
            ["config", "--null", "--show-origin", "--list"],
            context,
        );
        const hooks = resolve(
            cwd,
            (await inspectGit(cwd, program, ["rev-parse", "--git-path", "hooks"], context)).trim(),
        );

        hash.update(config);

        try {
            for (const file of (await readdir(hooks)).sort()) {
                hash.update(await hashFile(join(hooks, file)));
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw error;
            }
        }
    }

    return hash.digest("hex");
}

function requirePublisher(app: PocketApp, id: ConversationId, expectedRequester?: string): string {
    const requester = requireWorkflowRequester(app, id);

    app.handoffs.requireWritable(id);

    if (!app.handoffs.isManaged(id) || app.sessionMeta(app.rootOf(id))?.threadType !== "publish") {
        throw new Error(
            "Only the current active Publish workflow may execute publication operations.",
        );
    }

    if (expectedRequester !== undefined && expectedRequester !== requester) {
        throw new Error(
            "Publication requester changed while awaiting approval. Request approval again.",
        );
    }

    return requester;
}

function approverOf(
    app: PocketApp,
    id: ConversationId,
    answer: ApprovalAnswer,
    userId: string,
): string {
    const user = app.config.userById(userId);

    if (user === undefined || user.name !== answer.by) {
        throw new Error(
            "Publication approval requires its original, currently authorized human identity.",
        );
    }

    app.requireSee(user, id);
    app.requireSteer(user);

    return user.id;
}

async function publicationRoots(
    app: PocketApp,
    api: ToolExecutionApi,
    context: Context,
): Promise<ConversationId[]> {
    const root = app.rootOf(api.conversationId);
    const itemId = app.sessionMeta(root)?.workItemId;
    const item =
        itemId === undefined
            ? undefined
            : (await api.snapshot(HandoffsDoc, context))?.workItems[itemId];

    return item?.threadIds.map((id) => id as unknown as ConversationId) ?? [root];
}

async function publicationReceipts(app: PocketApp, api: ToolExecutionApi, context: Context) {
    const found: { root: ConversationId; receipt: PublicationReceipt }[] = [];

    for (const root of await publicationRoots(app, api, context)) {
        if (
            !app.canSee(
                app.config.userById(requireWorkflowRequester(app, api.conversationId))!,
                root,
            )
        ) {
            throw new Error(
                "Publication requires access to the entire work item's publication history.",
            );
        }

        for (const receipt of Object.values(
            (await api.snapshot(PublicationsDoc, root, context))?.receipts ?? {},
        )) {
            found.push({ root, receipt });
        }
    }

    return found;
}

function result(text: string) {
    return { content: [{ type: "text" as const, text }] };
}

/** Register in pocket-core, never in a disableable extension. */
export function createPublicationTool(app: PocketApp) {
    return defineTool({
        name: "publication",
        description:
            "Individually human-approved git push or gh pr/issue operations, only in the active ready Publish workflow. Managed bash is offline. An interrupted publication is uncertain: use status and human-approved resolve, never blindly repeat.",
        parameters: Type.Object({
            action: Type.Union([
                Type.Literal("execute"),
                Type.Literal("status"),
                Type.Literal("resolve"),
            ]),
            command: Type.Optional(Type.Array(Type.String(), { minItems: 2, maxItems: 100 })),
            reason: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
            receiptId: Type.Optional(Type.String()),
            outcome: Type.Optional(
                Type.Union([Type.Literal("completed"), Type.Literal("not-executed")]),
            ),
        }),
        replay: "unsafe",
        executionMode: "sequential",
        execute: async (args, api, context) => {
            const id = api.conversationId;
            const root = app.rootOf(id);
            const receiptId = `${api.taskId}:${api.callId}`;

            if (args.action === "status") {
                return result(
                    JSON.stringify(
                        (await publicationReceipts(app, api, context)).map(
                            ({ receipt }) => receipt,
                        ),
                        null,
                        2,
                    ),
                );
            }

            const requester = requirePublisher(app, id);

            if (args.reason === undefined || args.reason.trim() === "") {
                throw new Error(
                    "Explain the specific external operation or reconciliation for the human approver.",
                );
            }

            if (args.action === "resolve") {
                return withWorkflowPublicationLock(app, id, () =>
                    resolveReceipt(app, api, context, args, requester),
                );
            }

            const workflow = await api.snapshot(WorkflowDoc, root, context);

            if (workflow?.status !== "active" || workflow.readyForPublish !== true) {
                throw new Error(
                    "This Publish workflow is not active and ready for publication. Complete its local review/land prerequisites first.",
                );
            }

            const landedFingerprint = workflow.fingerprint?.digest;
            const landedHead = workflow.fingerprint?.head;

            if (
                landedFingerprint === undefined ||
                landedHead === undefined ||
                (await app.handoffs.fingerprint(id)) !== landedFingerprint
            ) {
                throw new Error(
                    "The checkout differs from the inherited successful Land checkpoint (or has no checkpoint). Review and Land the changed tracked, staged or untracked content again before publication.",
                );
            }

            if (args.command === undefined) {
                throw new Error("Give the exact publication argv command.");
            }

            validateCommand(args.command);
            await requirePublicationSource(app, id, args.command, landedHead, context);

            if (
                (await publicationReceipts(app, api, context)).some(
                    ({ receipt }) => receipt.state === "executing",
                )
            ) {
                throw new Error(
                    "An earlier publication may have executed. Inspect publication status and obtain human-approved reconciliation before another attempt.",
                );
            }

            const program = await executable(args.command[0]!);
            const cwd = await realpath(app.cwdOf(id));
            const command = await pinCommand(app, id, args.command, program, landedHead, context);
            const fingerprint = await checkpoint(app, id, command, program, context);
            const subject = JSON.stringify({ command, cwd, fingerprint });
            let answer = await api.memo<ApprovalAnswer>("workflow.publication.approval", context);

            if (answer === undefined) {
                answer = await api.memo(
                    "workflow.publication.approval",
                    await app.approvals.request(
                        {
                            id: receiptId,
                            conversationId: id,
                            taskId: api.taskId,
                            callId: api.callId,
                            tool: "publication",
                            subject,
                            reason: args.reason,
                            createdAt: Date.now(),
                        },
                        context,
                    ),
                    context,
                );
                await api.memo("workflow.publication.checkpoint", { subject, requester }, context);
            }

            if (!answer.allow) {
                throw new Error(`${answer.by} denied publication. No external operation ran.`);
            }

            const approved = await api.memo<{ subject: string; requester: string }>(
                "workflow.publication.checkpoint",
                context,
            );
            const decision = (await api.snapshot(DecisionsDoc, id, context))?.calls[api.callId];

            if (
                decision?.allow !== true ||
                decision.by !== answer.by ||
                decision.userId === undefined
            ) {
                throw new Error(
                    "Publication approval has no durable human identity receipt. No external operation ran.",
                );
            }

            const approver = approverOf(app, id, answer, decision.userId);

            await api.memo("workflow.publication.approver", approver, context);

            return withWorkflowPublicationLock(app, id, async () => {
                requirePublisher(app, id, requester);
                await requirePublicationSource(app, id, args.command!, landedHead, context);

                if (
                    approved?.subject !== subject ||
                    approved.requester !== requester ||
                    JSON.stringify(
                        await pinCommand(app, id, args.command!, program, landedHead, context),
                    ) !== JSON.stringify(command) ||
                    (await app.handoffs.fingerprint(id)) !== landedFingerprint ||
                    (await checkpoint(app, id, command, program, context)) !== fingerprint ||
                    (await realpath(app.cwdOf(id))) !== cwd
                ) {
                    throw new Error(
                        "Publication content, cwd or requester changed after approval. No external operation ran; request fresh approval.",
                    );
                }

                // This invocation-bound transaction is the durable external-side-effect fence, before raw exec.
                const roots = await publicationRoots(app, api, context);

                await api.commit(async (tx) => {
                    const history = await Promise.all(
                        roots.map((each) => tx.doc(PublicationsDoc, each)),
                    );
                    const state = await tx.doc(PublicationsDoc, root);
                    const workflow = await tx.doc(WorkflowDoc, root);

                    requirePublisher(app, id, requester);
                    approverOf(app, id, answer, approver);

                    if (
                        workflow.status !== "active" ||
                        workflow.readyForPublish !== true ||
                        workflow.fingerprint?.digest !== landedFingerprint ||
                        workflow.fingerprint?.head !== landedHead ||
                        (await app.handoffs.fingerprint(id)) !== landedFingerprint ||
                        history.some((saved) =>
                            Object.values(saved.receipts).some(
                                (receipt) => receipt.state === "executing",
                            ),
                        )
                    ) {
                        throw new Error(
                            "Publication eligibility changed or another operation is uncertain.",
                        );
                    }

                    state.receipts[receiptId] = {
                        id: receiptId,
                        command,
                        cwd,
                        fingerprint,
                        requester,
                        approver,
                        approvedAt: Date.now(),
                        reason: args.reason!,
                        state: "executing",
                    };
                }, context);

                const env = new NodeExecutionEnv({ cwd });
                const execution = await env.exec(
                    [program, ...command.slice(1)],
                    {
                        timeout: 600,
                        env: { GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" },
                        onOutput: (text) => api.output(text),
                        window: api.outputWindow,
                    },
                    context,
                );

                if (!execution.ok) {
                    // Even spawn/timeout/abort errors are conservative: no automatic retry or agent-written outcome.
                    throw new Error(
                        `Publication receipt ${receiptId} is uncertain: ${execution.error.message}. Use human-approved resolve before attempting again.`,
                    );
                }

                await api.commit(async (tx) => {
                    const receipt = (await tx.doc(PublicationsDoc, root)).receipts[receiptId]!;

                    if (execution.value.exitCode === 0) {
                        receipt.state = "completed";
                    }

                    receipt.exitCode = execution.value.exitCode;
                }, context);

                return {
                    ...result(
                        `Publication receipt ${receiptId}: command exited ${execution.value.exitCode}. ${execution.value.exitCode === 0 ? "External operation finished." : "This receipt remains uncertain: remote changes may already exist. Obtain human-approved resolve before any retry or handoff. Local hook fixes can still run offline."}`,
                    ),
                    isError: execution.value.exitCode !== 0,
                };
            });
        },
    });
}

async function resolveReceipt(
    app: PocketApp,
    api: ToolExecutionApi,
    context: Context,
    args: { receiptId?: string; outcome?: string; reason?: string },
    requester: string,
) {
    const found = (await publicationReceipts(app, api, context)).find(
        ({ receipt }) => receipt.id === args.receiptId,
    );
    const receipt = found?.receipt;
    const root = found?.root;

    if (root === undefined || receipt?.state !== "executing" || args.outcome === undefined) {
        throw new Error(
            "Name an executing/uncertain receipt and the outcome the human verified externally.",
        );
    }

    const subject = JSON.stringify({ receipt, outcome: args.outcome, evidence: args.reason });
    const answer = await app.approvals.request(
        {
            id: `${api.taskId}:${api.callId}`,
            conversationId: api.conversationId,
            taskId: api.taskId,
            callId: api.callId,
            tool: "publication",
            subject,
            reason: "Human reconciliation required: verify the external outcome before allowing this receipt to be cleared.",
            createdAt: Date.now(),
        },
        context,
    );

    await api.memo("workflow.publication.resolution", { ...answer, subject }, context);

    if (!answer.allow) {
        throw new Error("Human denied publication reconciliation; uncertainty remains blocked.");
    }

    const decision = (await api.snapshot(DecisionsDoc, api.conversationId, context))?.calls[
        api.callId
    ];

    if (decision?.allow !== true || decision.by !== answer.by || decision.userId === undefined) {
        throw new Error(
            "Reconciliation approval has no durable human identity receipt; uncertainty remains blocked.",
        );
    }

    const by = approverOf(app, api.conversationId, answer, decision.userId);

    await api.commit(async (tx) => {
        const current = (await tx.doc(PublicationsDoc, root)).receipts[receipt.id];

        requirePublisher(app, api.conversationId, requester);
        approverOf(app, api.conversationId, answer, by);

        if (JSON.stringify(current) !== JSON.stringify(receipt)) {
            throw new Error(
                "The uncertain receipt changed while awaiting reconciliation approval.",
            );
        }

        current!.state = "reconciled";
        current!.resolution = { by, at: Date.now(), outcome: args.outcome!, reason: args.reason! };
    }, context);

    return result(
        `Receipt ${receipt.id} reconciled by a human. A new execution still requires separate approval.`,
    );
}
