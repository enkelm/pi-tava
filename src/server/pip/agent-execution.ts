/** Native private-agent interventions: fence and join execution before lending its writer, never its membership. */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
    awaitWithContext,
    BACKGROUND_CONTEXT,
    withAbortSignal,
} from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import {
    defineDoc,
    defineTool,
    GenerationTask,
    ToolTask,
    hook,
    wrapTool,
    type ConversationId,
    type ToolExecutionApi,
    type Tx,
} from "@earendil-works/pi-durable";
import {
    createBashTool,
    createEditTool,
    createReadTool,
    createWriteTool,
} from "@earendil-works/pi-durable/tools";
import { getOrThrow, type ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { PocketApp } from "../app.ts";
import type { User } from "../config.ts";
import { AgentIdentitiesDoc } from "../agent-identity-docs.ts";
import { PipWorkDoc, PlanDoc, TurnsDoc } from "../docs.ts";
import { HttpError } from "../errors.ts";
import { currentStateCheckpoints } from "../doc-checkpoint.ts";
import { HandoffsDoc, type WorkItem } from "../workflow-docs.ts";
import { workflowExclusiveReason, withWorkflowWriterFence } from "../workflow-policy.ts";
import { AgentSupervisionDoc } from "./agent-supervision.ts";

const context = BACKGROUND_CONTEXT;
const idOf = (id: number) => id as ConversationId;

/** Private execution recovery tombstones; never projected into a room or used as new human authority. */
const PrivateExecutionDoc = defineDoc<{ agents: Record<string, { epoch: number; boot: string }> }>({
    kind: "pocket.private-execution",
    version: 1,
    ...currentStateCheckpoints,
    scope: "session",
    initial: () => ({ agents: {} }),
});

export type AgentExecutionIntent = {
    agentId: string;
    ownerId: string;
    tokenHash: string;
    agentEpoch: number;
    chatId: number;
    workItemId: string;
    controllerId: number;
    source: number;
    target?: number;
    attachmentEpoch: number;
    requestId: string;
    action?: string;
    text: string;
    agentName?: string;
    steer?: boolean;
};
type Lease = NonNullable<WorkItem["intervention"]>;
type Invocation = {
    api: ToolExecutionApi;
    root: ConversationId;
    agentId: string;
    epoch: number;
    ownerId: string;
    tokenHash: string;
    destination: string;
    lease?: Lease;
    controller: AbortController;
    settled: Promise<void>;
    writes?: string[];
    location?: string;
};

function contains(root: string, path: string): boolean {
    const part = relative(root, path);

    return (
        part === "" ||
        (part !== ".." &&
            !part.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
            !isAbsolute(part))
    );
}

export class AgentExecution {
    readonly #app: PocketApp;
    readonly #boot = randomUUID();
    readonly #current = new AsyncLocalStorage<Invocation>();
    readonly #operations = new Set<Invocation>();
    readonly #scratch = new Map<string, Promise<string>>();
    readonly #canonicalNamespaces = new Map<string, string>();
    readonly #retiring = new Map<string, Promise<void>>();
    readonly #returns = new Map<string, Promise<void>>();
    readonly #nativeActions = new Map<Promise<unknown>, string>();
    readonly #transfers = new Set<{ source: ConversationId; cwd: string; location: string }>();
    #closing = false;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    #root(id: ConversationId) {
        const root = this.#app.rootOf(id);

        return this.#app.pip.agents.scope(root) === undefined ? undefined : root;
    }

    #lease(root: ConversationId): Lease | undefined {
        const identity = this.#app.pip.agents.identity(root);

        if (identity === undefined) {
            return undefined;
        }

        for (const key of Object.keys(this.#app.sessionCatalogue())) {
            const lease = this.#app.workItems.itemFor(idOf(Number(key)))?.intervention;

            if (lease?.agentId === identity.agentId) {
                return { ...lease };
            }
        }

        return undefined;
    }

    async #temporary(
        agentId: string,
        env?: ExecutionEnv,
        id?: ConversationId,
        ctx = context,
    ): Promise<string> {
        const remote = id === undefined ? undefined : this.#app.locationOf(id);
        const key = JSON.stringify([agentId, remote]);
        let pending = this.#scratch.get(key);

        if (pending === undefined) {
            pending =
                remote === undefined || env === undefined
                    ? mkdtemp(resolve(tmpdir(), "coop-agent-"))
                    : env.createTempDir("coop-agent-", ctx).then(getOrThrow);
            this.#scratch.set(key, pending);
        }

        return pending;
    }

    #destination(id: ConversationId): string {
        return JSON.stringify([this.#app.locationOf(id), this.#app.cwdOf(id)]);
    }

    #assert(pin: Invocation): void {
        const identity = this.#app.pip.agents.identity(pin.root);
        const owner = this.#app.config.userById(pin.ownerId);

        if (
            pin.controller.signal.aborted ||
            identity?.agentId !== pin.agentId ||
            identity.epoch !== pin.epoch ||
            owner?.role !== "owner" ||
            owner.tokenHash !== pin.tokenHash ||
            pin.destination !==
                this.#destination(pin.lease === undefined ? pin.root : idOf(pin.lease.source)) ||
            !this.#app.config.pipEnabled
        ) {
            throw new HttpError(
                409,
                "Private execution authority changed; do not replay stale commands.",
            );
        }

        if (pin.lease !== undefined) {
            const item = this.#app.workItems.itemFor(idOf(pin.lease.source));
            const current = item?.intervention;

            if (
                current?.id !== pin.lease.id ||
                current.boot !== this.#boot ||
                current.phase !== "active" ||
                current.agentEpoch !== identity.epoch ||
                current.destination !== this.#destination(idOf(current.source)) ||
                item?.activeThreadId !== current.source ||
                current.ownerId !== owner.id ||
                current.tokenHash !== owner.tokenHash ||
                item?.supervisor?.agentId !== pin.agentId ||
                !this.#app.pip.agents.supervision.current(item)
            ) {
                throw new HttpError(409, "The temporary native writer was fenced or returned.");
            }
        }
    }

    async #invocation(api: ToolExecutionApi, effect = false): Promise<Invocation> {
        const root = this.#root(api.conversationId);
        const identity = root === undefined ? undefined : this.#app.pip.agents.identity(root);
        const owner =
            identity === undefined ? undefined : this.#app.config.userById(identity.ownerId);

        if (
            this.#closing ||
            root === undefined ||
            identity === undefined ||
            owner?.role !== "owner"
        ) {
            throw new HttpError(403, "Private execution requires a current private identity.");
        }

        await api.commit(async (tx) => {
            await this.#app.pip.agents.supervision.requireInvocation(tx, api);

            if (effect) {
                await this.#markExecution(tx, root);
            }
        }, context);
        const boot = await api.memo("private-execution-boot", this.#boot, context);

        if (boot !== this.#boot) {
            throw new HttpError(
                409,
                "Private execution was interrupted by restart; inspect the outcome and make a fresh decision instead of replaying.",
            );
        }

        const currentLease = this.#lease(root);
        const lease = currentLease?.chatId === Number(root) ? currentLease : undefined;

        return {
            api,
            root,
            agentId: identity.agentId,
            epoch: identity.epoch,
            ownerId: owner.id,
            tokenHash: owner.tokenHash,
            destination: this.#destination(lease === undefined ? root : idOf(lease.source)),
            lease,
            controller: new AbortController(),
            settled: Promise.resolve(),
        };
    }

    async #markExecution(tx: Tx, root: ConversationId): Promise<void> {
        const scope = this.#app.pip.agents.scope(root);
        const identity =
            scope === undefined
                ? undefined
                : (await tx.doc(AgentIdentitiesDoc)).items[scope.agentId];

        if (identity === undefined || identity.deletedAt !== undefined) {
            throw new HttpError(409, "Private execution identity is no longer current.");
        }

        const state = await tx.doc(PrivateExecutionDoc);
        const previous = state.agents[identity.agentId];

        if (previous?.epoch === identity.epoch && previous.boot !== this.#boot) {
            throw new HttpError(
                409,
                "This accepted private execution belongs to an interrupted boot. Fresh owner input is required.",
            );
        }

        state.agents[identity.agentId] = { epoch: identity.epoch, boot: this.#boot };
    }

    readonly hooks = [
        hook(ToolTask, {
            beforeTool: async (call, api, ctx) => {
                const root = this.#root(api.conversationId);
                const args = call.arguments as Record<string, unknown>;
                const action = args.action;
                const exactSend =
                    (call.name === "session_send" ||
                        (call.name === "agent_work" && action === "send")) &&
                    typeof args.session === "number" &&
                    !this.#app.pip.orchestration.isScoped(idOf(args.session));
                const mutates =
                    exactSend ||
                    (call.name === "subagent" && !["list", "status"].includes(String(action)));

                if (root === undefined || !mutates) {
                    return;
                }

                // Coding/intervention wrappers mark effects themselves. Exact sends and helpers
                // create new native paid lanes too. Fence an interrupted producer, but preserve
                // legacy delegated receipts and completed-source passive report authority.
                try {
                    await this.#app.harness.commit(async (tx) => {
                        await this.#app.pip.agents.supervision.requireInvocation(tx, api);
                        await this.#markExecution(tx, root);
                    }, ctx);
                } catch (error) {
                    await awaitWithContext(this.#app.harness.abortTask(api.taskId, context), ctx);

                    throw error;
                }
            },
        }),
        hook(GenerationTask, {
            beforeRequest: async (_input, api, ctx) => {
                if (this.#root(api.conversationId) === undefined) {
                    return;
                }

                const root = this.#root(api.conversationId)!;
                const identity = this.#app.pip.agents.identity(root)!;
                const previous = (await this.#app.harness.snapshot(PrivateExecutionDoc, ctx))
                    ?.agents[identity.agentId];
                const boot = await api.memo("private-execution-boot", this.#boot, ctx);

                if (
                    boot !== this.#boot ||
                    (previous?.epoch === identity.epoch && previous.boot !== this.#boot)
                ) {
                    // Durable hook exceptions are diagnostics, not an admission veto. Fence the
                    // actual generation and cancel this wait instead of joining our own caller.
                    await awaitWithContext(this.#app.harness.abortTask(api.taskId, context), ctx);

                    throw new HttpError(
                        409,
                        "Private execution interrupted by restart. Human control; inspect the outcome before continuing.",
                    );
                }
            },
        }),
    ];

    /** Real Durable coding-tool wrappers; nested codemode calls and actual helpers cross the same seam. */
    readonly wraps = [
        wrapTool(createReadTool(), (tool) => ({
            ...tool,
            execute: (args, api, ctx) =>
                this.#run(api, ctx, (bound, scoped) => tool.execute(args, bound, scoped), false),
        })),
        wrapTool(createWriteTool(), (tool) => ({
            ...tool,
            execute: (args, api, ctx) =>
                this.#run(api, ctx, (bound, scoped) => tool.execute(args, bound, scoped)),
        })),
        wrapTool(createEditTool(), (tool) => ({
            ...tool,
            execute: (args, api, ctx) =>
                this.#run(api, ctx, (bound, scoped) => tool.execute(args, bound, scoped)),
        })),
        wrapTool(createBashTool(), (tool) => ({
            ...tool,
            execute: (args, api, ctx) =>
                this.#run(api, ctx, (bound, scoped) => tool.execute(args, bound, scoped)),
        })),
    ];

    async #run<T>(
        api: ToolExecutionApi,
        ctx: Context,
        run: (api: ToolExecutionApi, context: Context) => Promise<T>,
        effect = true,
    ): Promise<T> {
        const root = this.#root(api.conversationId);

        if (root === undefined) {
            return run(api, ctx);
        }

        const pin = await this.#invocation(api, effect);
        let done!: () => void;

        pin.settled = new Promise<void>((settle) => {
            done = settle;
        });
        this.#operations.add(pin);
        const signal = AbortSignal.any([
            pin.controller.signal,
            ...(ctx.abortSignal ? [ctx.abortSignal] : []),
        ]);
        const scoped = withAbortSignal(signal, ctx);
        const monitor = setInterval(() => this.changed(), 50);

        monitor.unref();

        try {
            this.#assert(pin);
            await this.#temporary(pin.agentId);
            const user = this.#app.config.userById(pin.ownerId)!;
            const env = this.#app.envFor(
                pin.lease === undefined ? api.conversationId : idOf(pin.lease.source),
                user,
            );

            return await this.#current.run(pin, () => run({ ...api, env }, scoped));
        } finally {
            clearInterval(monitor);
            this.#operations.delete(pin);
            done();
        }
    }

    /** Called by environment operations, not a tool-name allowlist or a caller-supplied authority token. */
    applies(id: ConversationId): boolean {
        return this.#current.getStore() !== undefined || this.#root(id) !== undefined;
    }

    isWriter(id: ConversationId): boolean {
        const pin = this.#current.getStore();

        if (pin?.lease === undefined || this.#app.rootOf(id) !== idOf(pin.lease.source)) {
            return false;
        }

        this.#assert(pin);

        return true;
    }

    /** Native writers in another Work Item cannot bypass an intervention by sharing its filesystem. */
    requireNativeWrite(id: ConversationId): void {
        if (this.isWriter(id) || this.#root(id) !== undefined) {
            return;
        }

        const cwd = this.#canonicalLocal(this.#app.cwdOf(id), id);
        const location = JSON.stringify(this.#app.locationOf(id));

        for (const transfer of this.#transfers) {
            if (
                transfer.location === location &&
                (contains(cwd, transfer.cwd) || contains(transfer.cwd, cwd))
            ) {
                throw new HttpError(409, "A native writer transfer is fencing this filesystem.");
            }
        }

        for (const pin of this.#operations) {
            if (
                pin.location === location &&
                pin.writes?.some((path) => contains(cwd, path) || contains(path, cwd))
            ) {
                throw new HttpError(
                    409,
                    "A private native-tool effect holds this filesystem; wait for it to settle.",
                );
            }
        }

        for (const key of Object.keys(this.#app.sessionCatalogue())) {
            const item = this.#app.workItems.itemFor(idOf(Number(key)));

            if (item?.intervention === undefined) {
                continue;
            }

            const source = idOf(item.intervention.source);
            const other = this.#canonicalLocal(this.#app.cwdOf(source), source);

            if (
                location === JSON.stringify(this.#app.locationOf(source)) &&
                (contains(cwd, other) || contains(other, cwd))
            ) {
                throw new HttpError(
                    409,
                    "This filesystem has a temporary native writer; wait for its intervention to finish.",
                );
            }
        }
    }

    #canonicalLocal(path: string, id: ConversationId): string {
        if (this.#app.locationOf(id) !== undefined) {
            return (
                this.#canonicalNamespaces.get(JSON.stringify([this.#app.locationOf(id), path])) ??
                path
            );
        }

        try {
            return realpathSync(path);
        } catch {
            return path;
        }
    }

    async #primeNamespaces(env: ExecutionEnv, id: ConversationId, ctx: Context): Promise<void> {
        const location = this.#app.locationOf(id);

        if (location === undefined) {
            return;
        }

        for (const [key, meta] of Object.entries(this.#app.sessionCatalogue())) {
            const candidate = idOf(Number(key));

            if (
                meta.pip !== undefined ||
                JSON.stringify(this.#app.locationOf(candidate)) !== JSON.stringify(location)
            ) {
                continue;
            }

            const cwd = this.#app.cwdOf(candidate);
            const canonical = await env.canonicalPath(cwd, ctx);

            if (canonical.ok) {
                this.#canonicalNamespaces.set(JSON.stringify([location, cwd]), canonical.value);
            } else if (
                this.#app.conversationsOf(candidate).some((member) => this.#app.isBusy(member))
            ) {
                throw new HttpError(
                    409,
                    `Cannot resolve the active native filesystem of /s/${candidate}; no private writer was granted.`,
                );
            }
        }
    }

    async authorize(
        id: ConversationId,
        env: ExecutionEnv,
        method: string,
        args: unknown[],
        ctx: Context,
    ) {
        const pin = this.#current.getStore();

        if (pin === undefined) {
            throw new HttpError(
                403,
                "Private effects require their current native tool invocation.",
            );
        }

        this.#assert(pin);

        if (
            this.#app.rootOf(id) !== pin.root &&
            this.#app.rootOf(id) !== idOf(pin.lease?.source ?? -1)
        ) {
            throw new HttpError(403, "The private invocation's filesystem destination changed.");
        }

        const scratch = await this.#temporary(pin.agentId, env, id, ctx);
        const roots = await Promise.all(
            [
                scratch,
                pin.lease === undefined
                    ? this.#app.cwdOf(pin.root)
                    : this.#app.cwdOf(idOf(pin.lease.source)),
            ].map(async (root) => {
                const canonical = await env.canonicalPath(root, ctx);

                return canonical.ok ? canonical.value : root;
            }),
        );

        const writes: string[] = method === "exec" ? roots : [];

        if (method !== "exec" && method !== "createTempDir" && method !== "createTempFile") {
            const paths = method === "renameFile" ? args.slice(0, 2) : args.slice(0, 1);

            for (const path of paths) {
                if (typeof path !== "string") {
                    throw new HttpError(403, "Private mutation requires an explicit path.");
                }

                const absolute = getOrThrow(await env.absolutePath(path, ctx));
                let existing = absolute;

                while (true) {
                    const canonical = await env.canonicalPath(existing, ctx);

                    if (canonical.ok) {
                        const destination = resolve(canonical.value, relative(existing, absolute));

                        writes.push(destination);

                        break;
                    }

                    if (canonical.error.code !== "not_found" || dirname(existing) === existing) {
                        throw canonical.error;
                    }

                    existing = dirname(existing);
                }
            }
        }

        await this.#primeNamespaces(env, id, ctx);
        // Filesystem preparation can wait while authority changes. Validate at final admission,
        // then reserve this effect below without another asynchronous preparation gap.
        await pin.api.commit(async (tx) => {
            await this.#app.pip.agents.supervision.requireInvocation(tx, pin.api);

            if ((await tx.doc(PlanDoc, pin.root)).on) {
                throw new HttpError(409, "Plan mode blocks private execution effects.");
            }

            if (pin.lease !== undefined) {
                await this.#requireDriver(
                    tx,
                    idOf(pin.lease.source),
                    this.#app.config.userById(pin.ownerId)!,
                );
                await this.#app.pip.agents.supervision.requireAttachment(
                    tx,
                    idOf(
                        this.#app.workItems.itemFor(idOf(pin.lease.source))!.supervisor!
                            .conversationId,
                    ),
                    pin.agentId,
                    pin.epoch,
                    pin.lease.attachmentEpoch,
                );
            }
        }, ctx);
        this.#assert(pin);
        const location = JSON.stringify(this.#app.locationOf(id));

        for (const transfer of this.#transfers) {
            if (
                transfer.location === location &&
                writes.some((path) => contains(transfer.cwd, path) || contains(path, transfer.cwd))
            ) {
                throw new HttpError(
                    409,
                    "A native writer transfer is fencing this filesystem. Use private temporary storage until it settles.",
                );
            }
        }

        for (const [key, meta] of Object.entries(this.#app.sessionCatalogue())) {
            const candidate = idOf(Number(key));

            if (
                meta.pip !== undefined ||
                candidate !== this.#app.rootOf(candidate) ||
                JSON.stringify(this.#app.locationOf(candidate)) !== location ||
                (pin.lease !== undefined &&
                    this.#app.workItems.itemFor(candidate)?.id ===
                        this.#app.workItems.itemFor(idOf(pin.lease.source))?.id)
            ) {
                continue;
            }

            const cwd = this.#canonicalLocal(this.#app.cwdOf(candidate), candidate);
            const overlap = writes.some((path) => contains(cwd, path) || contains(path, cwd));
            const busy = this.#app
                .conversationsOf(candidate)
                .some((conversation) => this.#app.isBusy(conversation));

            if (
                overlap &&
                (busy ||
                    workflowExclusiveReason(this.#app, candidate) !== undefined ||
                    this.#app.workItems.itemFor(candidate)?.intervention !== undefined)
            ) {
                if (method === "exec" && pin.lease === undefined) {
                    for (let at = roots.length - 1; at >= 0; at--) {
                        if (contains(cwd, roots[at]!) || contains(roots[at]!, cwd)) {
                            roots.splice(at, 1);
                        }
                    }
                } else {
                    throw new HttpError(
                        409,
                        `Native execution /s/${candidate} is using this workspace. Use agent_execution intervene before direct correction; temporary work can use $TMPDIR.`,
                    );
                }
            }
        }

        for (const other of this.#operations) {
            if (
                other !== pin &&
                other.location === location &&
                other.writes?.some((left) =>
                    writes.some((right) => contains(left, right) || contains(right, left)),
                )
            ) {
                throw new HttpError(
                    409,
                    "Another private tool is writing this workspace; wait for it to settle.",
                );
            }
        }

        this.#assert(pin);
        pin.location = location;
        pin.writes = [...(pin.writes ?? []), ...writes];

        return {
            roots,
            scratch,
            context: withAbortSignal(
                AbortSignal.any([
                    pin.controller.signal,
                    ...(ctx.abortSignal ? [ctx.abortSignal] : []),
                ]),
                ctx,
            ),
            check: () => this.#assert(pin),
        };
    }

    async #transfer<T>(
        source: ConversationId,
        run: (join: () => Promise<void>) => Promise<T>,
    ): Promise<T> {
        const ownerId = this.#app.workItems.itemFor(source)?.supervisor?.ownerId;
        const owner = ownerId === undefined ? undefined : this.#app.config.userById(ownerId);

        if (owner === undefined) {
            throw new HttpError(403, "Native writer transfer requires its current owner.");
        }

        await this.#primeNamespaces(this.#app.envFor(source, owner), source, context);
        const fence = {
            source,
            cwd: this.#canonicalLocal(this.#app.cwdOf(source), source),
            location: JSON.stringify(this.#app.locationOf(source)),
        };

        for (const other of this.#transfers) {
            if (
                other.location === fence.location &&
                (contains(other.cwd, fence.cwd) || contains(fence.cwd, other.cwd))
            ) {
                throw new HttpError(
                    409,
                    "Another native writer transfer is already fencing this filesystem.",
                );
            }
        }

        for (const pin of this.#operations) {
            if (
                pin.location === fence.location &&
                pin.writes?.some((path) => contains(path, fence.cwd) || contains(fence.cwd, path))
            ) {
                throw new HttpError(
                    409,
                    "A private effect is still writing this filesystem; Stop or join it before native intervention.",
                );
            }
        }

        this.#transfers.add(fence);

        try {
            return await withWorkflowWriterFence(this.#app, source, run);
        } finally {
            this.#transfers.delete(fence);
        }
    }

    async #track<T>(agentId: string, run: () => Promise<T>): Promise<T> {
        const pending = run();

        this.#nativeActions.set(pending, agentId);

        try {
            return await pending;
        } finally {
            this.#nativeActions.delete(pending);
        }
    }

    changed(): void {
        for (const pin of this.#operations) {
            try {
                this.#assert(pin);
            } catch {
                pin.controller.abort();
            }
        }

        if (this.#closing) {
            return;
        }

        for (const key of Object.keys(this.#app.sessionCatalogue())) {
            const item = this.#app.workItems.itemFor(idOf(Number(key)));
            const lease = item?.intervention;

            if (
                item === undefined ||
                lease === undefined ||
                lease.boot !== this.#boot ||
                lease.phase === "fencing" ||
                this.#retiring.has(lease.id)
            ) {
                continue;
            }

            const identity = this.#app.pip.agents.identity(idOf(lease.chatId));
            const owner = this.#app.config.userById(lease.ownerId);

            if (
                identity?.epoch === lease.agentEpoch &&
                lease.destination === this.#destination(idOf(lease.source)) &&
                owner?.role === "owner" &&
                owner.tokenHash === lease.tokenHash &&
                item.supervisor?.agentId === lease.agentId &&
                this.#app.pip.agents.supervision.current(item)
            ) {
                continue;
            }

            const pending = Promise.resolve()
                .then(() => this.#return(item))
                .catch((error: unknown) => {
                    this.#app.notice(
                        "error",
                        `Private writer return is held: ${error instanceof Error ? error.message : String(error)}`,
                        idOf(lease.chatId),
                    );
                })
                .finally(() => {
                    if (
                        this.#app.workItems.itemFor(idOf(lease.source))?.intervention?.id !==
                        lease.id
                    ) {
                        this.#retiring.delete(lease.id);
                    }
                });

            this.#retiring.set(lease.id, pending);
        }
    }

    /** Join before Harness.close; durable fences survive shutdown and are reconciled on next boot. */
    async close(): Promise<void> {
        this.#closing = true;

        for (const pin of this.#operations) {
            pin.controller.abort();
        }

        await Promise.all([...this.#operations].map((pin) => pin.settled));
        await Promise.allSettled(this.#nativeActions.keys());
        await Promise.all(this.#retiring.values());
    }

    async releaseAgent(agentId: string): Promise<void> {
        for (const pin of this.#operations) {
            if (pin.agentId === agentId) {
                pin.controller.abort();
            }
        }

        await Promise.all(
            [...this.#operations]
                .filter((pin) => pin.agentId === agentId)
                .map((pin) => pin.settled),
        );
        await Promise.allSettled(
            [...this.#nativeActions]
                .filter(([, owner]) => owner === agentId)
                .map(([pending]) => pending),
        );
        const seen = new Set<string>();

        for (const key of Object.keys(this.#app.sessionCatalogue())) {
            const item = this.#app.workItems.itemFor(idOf(Number(key)));

            if (item?.intervention?.agentId === agentId && !seen.has(item.id)) {
                seen.add(item.id);
                await this.#return(item);
            }
        }
    }

    /** Coordination may return the identity's writer; Chat Close must return only its own. */
    async release(chatId: ConversationId, { exactChat = false } = {}): Promise<void> {
        const root = this.#root(chatId);
        const lease = root === undefined ? undefined : this.#lease(root);

        if (lease !== undefined && (!exactChat || lease.chatId === Number(root))) {
            const item = this.#app.workItems.itemFor(idOf(lease.source));

            if (item !== undefined) {
                await this.#return(item);
            }
        }
    }

    async #return(item: Readonly<WorkItem>): Promise<void> {
        const lease = item.intervention;

        if (lease === undefined) {
            return;
        }

        const previous = this.#returns.get(lease.id);

        if (previous !== undefined) {
            return previous;
        }

        const pending = this.#returnWriter(item);

        this.#returns.set(lease.id, pending);

        try {
            await pending;
        } finally {
            this.#returns.delete(lease.id);
        }
    }

    async #returnWriter(item: Readonly<WorkItem>): Promise<void> {
        const lease = item.intervention;

        if (lease === undefined) {
            return;
        }

        await this.#app.workItems.withControl(idOf(lease.source), () =>
            this.#app.harness.commit(async (tx) => {
                const current = (await tx.doc(HandoffsDoc)).workItems[item.id]?.intervention;

                if (current?.id === lease.id) {
                    current.phase = "releasing";
                }
            }, context),
        );
        this.changed();
        await Promise.all(
            [...this.#operations]
                .filter((pin) => pin.lease?.id === lease.id)
                .map((pin) => pin.settled),
        );
        await withWorkflowWriterFence(this.#app, idOf(lease.source), async (join) => {
            await join();
            await this.#app.workItems.withControl(idOf(lease.source), () =>
                this.#app.harness.commit(async (tx) => {
                    const current = (await tx.doc(HandoffsDoc)).workItems[item.id];

                    if (current?.intervention?.id === lease.id) {
                        delete current.intervention;
                    }
                }, context),
            );
        });
    }

    async #requireIntent(tx: Tx, supplied: User, intent: AgentExecutionIntent): Promise<WorkItem> {
        const owner = this.#app.config.userById(supplied.id);
        const identity = (await tx.doc(AgentIdentitiesDoc)).items[intent.agentId];
        const stored = Object.values((await tx.doc(AgentSupervisionDoc)).requests).find(
            (record) => record.requestId === intent.requestId,
        );

        if (
            owner?.role !== "owner" ||
            owner.id !== intent.ownerId ||
            owner.tokenHash !== supplied.tokenHash ||
            owner.tokenHash !== intent.tokenHash ||
            identity?.ownerId !== owner.id ||
            identity.deletedAt !== undefined ||
            identity.epoch !== intent.agentEpoch ||
            stored === undefined ||
            stored.agentId !== intent.agentId ||
            stored.action !== intent.action ||
            stored.target !== intent.target ||
            stored.text !== intent.text ||
            stored.agentEpoch !== intent.agentEpoch ||
            stored.attachmentEpoch !== intent.attachmentEpoch ||
            !this.#app.config.pipEnabled
        ) {
            throw new HttpError(409, "The private native execution intent was revoked or changed.");
        }

        await this.#app.pip.agents.supervision.requireAttachment(
            tx,
            idOf(intent.controllerId),
            intent.agentId,
            intent.agentEpoch,
            intent.attachmentEpoch,
        );
        const item = (await tx.doc(HandoffsDoc)).workItems[intent.workItemId];
        const target = intent.target ?? intent.source;

        if (
            item === undefined ||
            item.archived ||
            !this.#app.workItems.enabled ||
            (target !== item.supervisor?.conversationId && target !== item.activeThreadId)
        ) {
            throw new HttpError(
                409,
                "The exact native target is no longer the current writer or controller.",
            );
        }

        this.#app.requireSee(owner, idOf(target));
        this.#app.requireSteer(owner);
        this.#app.spend.check(owner, idOf(intent.chatId));
        this.#app.spend.check(owner, idOf(target));

        if (intent.action === "send") {
            const grant = item.supervisor!;

            if (
                (await tx.doc(PipWorkDoc, idOf(intent.controllerId))).question !== undefined ||
                (grant.maxActions !== undefined &&
                    grant.actions >= grant.maxActions &&
                    item.privateCommands?.[intent.requestId] === undefined) ||
                (grant.maxCost !== undefined &&
                    this.#app.spend.workSpent(idOf(target)) >= grant.maxCost)
            ) {
                throw new HttpError(
                    409,
                    "The native controller needs an owner answer or its Work Item budget is exhausted.",
                );
            }
        }

        return item;
    }

    /** Whole-item native Stop retains writer/control receipts; exact input is admitted by AgentContacts. */
    deliver(
        supplied: User,
        intent: AgentExecutionIntent,
    ): Promise<{ submissionId?: number; result?: string }> {
        return this.#track(intent.agentId, () => this.#deliver(supplied, intent));
    }

    async #deliver(
        supplied: User,
        intent: AgentExecutionIntent,
    ): Promise<{ submissionId?: number; result?: string }> {
        if (intent.action !== "stop") {
            throw new HttpError(
                409,
                "Use the exact native contact adapter for input; this endpoint only settles native whole-item Stop.",
            );
        }

        const observed = await this.#app.harness.commit(async (tx) => {
            const item = await this.#requireIntent(tx, supplied, intent);
            const prior = item.privateCommands?.[intent.requestId];

            return {
                activeThreadId: item.activeThreadId,
                prior: prior === undefined ? undefined : { ...prior },
            };
        }, context);
        const prior = observed.prior;

        if (intent.action === "stop" && prior !== undefined) {
            return {
                result:
                    prior.status === "completed"
                        ? "This exact native Stop already completed and joined; it was not repeated."
                        : "This exact native Stop was already admitted. Its outcome may be interrupted; inspect the native tasks before a fresh decision. It was not replayed.",
            };
        }

        await this.release(idOf(intent.chatId));
        const source = idOf(observed.activeThreadId);

        return this.#transfer(source, async (join) => {
            await this.#app.workItems.withControl(source, () =>
                this.#app.harness.commit(async (tx) => {
                    const item = await this.#requireIntent(tx, supplied, intent);

                    if (item.intervention !== undefined) {
                        throw new HttpError(
                            409,
                            "Another native writer transfer is already in progress.",
                        );
                    }

                    item.privateCommands ??= {};
                    item.privateCommands[intent.requestId] = {
                        agentId: intent.agentId,
                        epoch: intent.agentEpoch,
                        action: "stop",
                        source: Number(source),
                        status: "admitted",
                    };
                    item.intervention = {
                        id: intent.requestId,
                        boot: this.#boot,
                        chatId: intent.chatId,
                        agentId: intent.agentId,
                        ownerId: intent.ownerId,
                        tokenHash: intent.tokenHash,
                        agentEpoch: intent.agentEpoch,
                        attachmentEpoch: intent.attachmentEpoch,
                        source: Number(source),
                        destination: this.#destination(source),
                        phase: "fencing",
                    };
                    await this.#app.pip.agents.contacts.fenceTarget(tx, source);
                    item.supervisor!.epoch++;
                    item.supervisor!.status = "reclaimed";
                }, context),
            );
            await this.#app.workItems.interrupt(source);
            await join();
            await this.#app.workItems.withControl(source, () =>
                this.#app.harness.commit(async (tx) => {
                    const item = await this.#requireIntent(tx, supplied, intent);

                    if (item.intervention?.id === intent.requestId) {
                        delete item.intervention;
                        item.privateCommands![intent.requestId]!.status = "completed";
                    }
                }, context),
            );

            return {
                result: "Native execution and relevant helpers stopped and joined. External effects were not reversed.",
            };
        });
    }

    /** Boot identities never grant a resumed command permission to reuse an old writer reservation. */
    async recover(): Promise<void> {
        const seen = new Set<string>();

        for (const key of Object.keys(this.#app.sessionCatalogue())) {
            const item = this.#app.workItems.itemFor(idOf(Number(key)));

            if (item?.intervention !== undefined && !seen.has(item.id)) {
                seen.add(item.id);
                await this.#app.workItems.interrupt(idOf(item.activeThreadId));
                await this.#return(item);
            }
        }

        // Startup recovery runs before the app's publication subscription is installed.
        // Refresh the native projections we mutate; ordinary commit delivery handles this after startup.
        this.#app.workItems.committed(await this.#app.harness.snapshot(HandoffsDoc, context));
        const execution = await this.#app.harness.snapshot(PrivateExecutionDoc, context);
        const identities = await this.#app.harness.snapshot(AgentIdentitiesDoc, context);
        const inspection = await this.#app.harness.inspect(context);

        for (const [agentId, previous] of Object.entries(execution?.agents ?? {})) {
            const identity = identities?.items[agentId];
            const owner =
                identity === undefined ? undefined : this.#app.config.userById(identity.ownerId);

            if (
                previous.boot !== this.#boot &&
                identity?.deletedAt === undefined &&
                identity?.epoch === previous.epoch &&
                owner?.role === "owner"
            ) {
                const conversations = new Set(
                    identity.chatIds.flatMap((chat) => this.#app.conversationsOf(idOf(chat))),
                );
                const interrupted = inspection.submissions.some((submission) =>
                    conversations.has(submission.conversationId),
                );

                if (!interrupted) {
                    // Completed coding is not an interrupted decision. Retain accepted native
                    // contacts/passive outboxes and let a fresh input use the current boot.
                    await this.#app.harness.commit(async (tx) => {
                        (await tx.doc(PrivateExecutionDoc)).agents[agentId] = {
                            epoch: identity.epoch,
                            boot: this.#boot,
                        };
                    }, context);

                    continue;
                }

                // Reuse native accepted-input epoch fences, including inherited helper authority.
                // A successor GenerationTask may be new; its original accepted input is not.
                await this.#app.pip.agents.supervision.stop(agentId, owner);
                await Promise.all(
                    identity.chatIds.map(async (chat) =>
                        (await this.#app.conversation(idOf(chat))).abort(context, {
                            background: true,
                        }),
                    ),
                );
            }
        }

        this.#app.workItems.committed(await this.#app.harness.snapshot(HandoffsDoc, context));
        this.#app.pip.agents.committed(
            await this.#app.harness.snapshot(AgentIdentitiesDoc, context),
        );
    }

    #requireNoCompetingNative(source: ConversationId, item: Readonly<WorkItem>): void {
        const cwd = this.#canonicalLocal(this.#app.cwdOf(source), source);
        const location = JSON.stringify(this.#app.locationOf(source));

        for (const [key, meta] of Object.entries(this.#app.sessionCatalogue())) {
            const candidate = idOf(Number(key));

            if (
                meta.pip !== undefined ||
                candidate !== this.#app.rootOf(candidate) ||
                this.#app.workItems.itemFor(candidate)?.id === item.id ||
                JSON.stringify(this.#app.locationOf(candidate)) !== location
            ) {
                continue;
            }

            const other = this.#canonicalLocal(this.#app.cwdOf(candidate), candidate);

            if (
                (contains(cwd, other) || contains(other, cwd)) &&
                (this.#app.conversationsOf(candidate).some((member) => this.#app.isBusy(member)) ||
                    workflowExclusiveReason(this.#app, candidate) !== undefined)
            ) {
                throw new HttpError(
                    409,
                    `Another native writer /s/${candidate} is using this filesystem. Stop/join that exact work before direct correction; unrelated Work Items are not silently cancelled.`,
                );
            }
        }
    }

    async #requireDriver(tx: Tx, source: ConversationId, user: User): Promise<void> {
        const turns = await tx.doc(TurnsDoc, source);

        if (turns.on && turns.driver !== user.id) {
            throw new HttpError(
                409,
                "The native execution Thread is driven by someone else; ask for the wheel before borrowing its writer.",
            );
        }
    }

    async #intervene(api: ToolExecutionApi, source: ConversationId, ctx: Context) {
        const pin = await this.#invocation(api, true);
        const user = this.#app.config.userById(pin.ownerId)!;
        const key = `${api.taskId}:${api.callId}`;

        if (api.conversationId !== pin.root) {
            throw new HttpError(403, "Only the private agent's main chat may intervene.");
        }

        await this.release(pin.root);

        return this.#transfer(source, async (join) => {
            await this.#app.workItems.withControl(source, () =>
                api.commit(async (tx) => {
                    await this.#app.pip.agents.supervision.requireInvocation(tx, api);
                    const item = this.#app.workItems.itemFor(source);
                    const current =
                        item === undefined
                            ? undefined
                            : (await tx.doc(HandoffsDoc)).workItems[item.id];
                    const attachment =
                        current === undefined
                            ? undefined
                            : (await tx.doc(AgentSupervisionDoc)).agents[pin.agentId]?.attachments[
                                  current.id
                              ];

                    if (
                        current === undefined ||
                        current.activeThreadId !== Number(source) ||
                        attachment?.active !== true ||
                        current.archived ||
                        !this.#app.workItems.enabled
                    ) {
                        throw new HttpError(
                            409,
                            "Intervene only in the exact attached active execution Work Item.",
                        );
                    }

                    await this.#app.pip.agents.supervision.requireAttachment(
                        tx,
                        idOf(attachment.controllerId),
                        pin.agentId,
                        pin.epoch,
                        attachment.epoch,
                    );
                    this.#app.requireSee(user, source);
                    this.#app.requireSteer(user);
                    await this.#requireDriver(tx, source, user);
                    this.#app.spend.check(user, pin.root);
                    this.#app.spend.check(user, source);
                    const grant = current.supervisor!;

                    if (
                        (grant.maxActions !== undefined &&
                            grant.actions >= grant.maxActions &&
                            current.privateCommands?.[key] === undefined) ||
                        (grant.maxCost !== undefined &&
                            this.#app.spend.workSpent(source) >= grant.maxCost)
                    ) {
                        throw new HttpError(
                            409,
                            "The native Work Item action or spend budget is exhausted; ask the owner instead of borrowing its writer.",
                        );
                    }

                    if (
                        (await tx.doc(PipWorkDoc, idOf(attachment.controllerId))).question !==
                            undefined ||
                        (await tx.doc(PlanDoc, pin.root)).on
                    ) {
                        throw new HttpError(
                            409,
                            "Resolve the native controller question or plan mode before intervention.",
                        );
                    }

                    for (const other of Object.values((await tx.doc(HandoffsDoc)).workItems)) {
                        if (
                            other.id !== current.id &&
                            other.intervention !== undefined &&
                            JSON.stringify(this.#app.locationOf(source)) ===
                                JSON.stringify(this.#app.locationOf(idOf(other.activeThreadId))) &&
                            (contains(
                                this.#app.cwdOf(source),
                                this.#app.cwdOf(idOf(other.activeThreadId)),
                            ) ||
                                contains(
                                    this.#app.cwdOf(idOf(other.activeThreadId)),
                                    this.#app.cwdOf(source),
                                ))
                        ) {
                            throw new HttpError(
                                409,
                                "Another Work Item already holds this filesystem's temporary writer.",
                            );
                        }
                    }

                    this.#requireNoCompetingNative(source, current);
                    current.privateCommands ??= {};

                    if (current.privateCommands[key] === undefined) {
                        current.privateCommands[key] = {
                            agentId: pin.agentId,
                            epoch: pin.epoch,
                            action: "intervene",
                            source: Number(source),
                            status: "admitted",
                        };
                        grant.actions++;
                    }

                    current.intervention = {
                        id: key,
                        boot: this.#boot,
                        chatId: Number(pin.root),
                        agentId: pin.agentId,
                        ownerId: pin.ownerId,
                        tokenHash: pin.tokenHash,
                        agentEpoch: pin.epoch,
                        attachmentEpoch: attachment.epoch,
                        source: Number(source),
                        destination: this.#destination(source),
                        phase: "fencing",
                    };
                    await this.#app.pip.agents.contacts.fenceTarget(tx, source);
                    grant.epoch++;
                    grant.status = "reclaimed";
                }, ctx),
            );
            await this.#app.workItems.interrupt(source);
            await join();
            await this.#app.workItems.withControl(source, () =>
                api.commit(async (tx) => {
                    await this.#app.pip.agents.supervision.requireInvocation(tx, api);
                    const item = this.#app.workItems.itemFor(source)!;
                    const current = (await tx.doc(HandoffsDoc)).workItems[item.id]!;
                    const lease = current.intervention;

                    if (
                        lease?.id !== key ||
                        lease.boot !== this.#boot ||
                        current.activeThreadId !== Number(source) ||
                        lease.destination !== this.#destination(source)
                    ) {
                        throw new HttpError(
                            409,
                            "The native writer changed while execution was joining; no private writer was granted.",
                        );
                    }

                    await this.#app.pip.agents.supervision.requireAttachment(
                        tx,
                        idOf(current.supervisor!.conversationId),
                        pin.agentId,
                        pin.epoch,
                        lease.attachmentEpoch,
                    );
                    await this.#requireDriver(tx, source, user);
                    await this.#app.workItems.requireIdle(tx, source);
                    current.privateCommands![key]!.status = "completed";
                    lease.phase = "active";
                }, ctx),
            );

            return this.#status(pin.root);
        }).catch(async (error) => {
            // A failed post-join admission must not strand a half-granted writer lease.
            await this.release(pin.root);

            throw error;
        });
    }

    async #status(root: ConversationId) {
        const identity = this.#app.pip.agents.identity(root);

        if (identity === undefined) {
            throw new HttpError(409, "The private execution identity is no longer current.");
        }

        const lease = this.#lease(root);
        const destination = lease === undefined ? root : idOf(lease.source);
        const remote = this.#app.locationOf(destination);
        const cached = this.#scratch.get(JSON.stringify([identity.agentId, remote]));

        return {
            ...(remote === undefined
                ? { scratch: await this.#temporary(identity.agentId) }
                : cached === undefined
                  ? {
                        temporaryStorage:
                            "Target temporary storage is allocated on the first effect. Use bash $TMPDIR on that target.",
                    }
                  : { scratch: await cached }),
            ...(remote === undefined ? {} : { location: remote }),
            writer:
                lease === undefined
                    ? null
                    : {
                          source: lease.source,
                          phase: lease.phase,
                          description:
                              "The exact native writer is temporarily fenced and joined; release or delegate to return it.",
                      },
            workspace: this.#app.cwdOf(destination),
            authority:
                "Normal idle owner-authorized workspaces remain writable without Work Item membership. Competing native work must be explicitly stopped/joined before correction.",
        };
    }

    readonly tools = [
        defineTool({
            name: "agent_execution",
            description:
                "Inspect private execution authority and temporary storage, intervene in an exact native execution after fencing/cancelling/joining its full helper tree, or return its unchanged native writer. This never transfers Work Item membership. Use ordinary coding tools in idle authorized workspaces without intervention.",
            parameters: Type.Object({
                action: Type.Union([
                    Type.Literal("status"),
                    Type.Literal("intervene"),
                    Type.Literal("release"),
                ]),
                session: Type.Optional(
                    Type.Integer({
                        minimum: 1,
                        description:
                            "Exact existing active native execution session to intervene in.",
                    }),
                ),
            }),
            execute: async (args, api, ctx) => {
                const pin = await this.#invocation(api);

                this.#assert(pin);

                if (args.action === "status") {
                    return {
                        content: [
                            { type: "text", text: JSON.stringify(await this.#status(pin.root)) },
                        ],
                    };
                }

                if (api.conversationId !== pin.root) {
                    throw new HttpError(
                        403,
                        "Only the private agent's main chat may transfer native writer authority.",
                    );
                }

                if (args.action === "release") {
                    return this.#app.pip.agents.supervision.perform(pin.root, () =>
                        this.#track(pin.agentId, async () => {
                            await this.release(pin.root);

                            return {
                                content: [
                                    {
                                        type: "text" as const,
                                        text: JSON.stringify(await this.#status(pin.root)),
                                    },
                                ],
                            };
                        }),
                    );
                }

                if (args.session === undefined) {
                    throw new HttpError(
                        400,
                        "Intervention requires the exact native execution session.",
                    );
                }

                // Intervention needs an actual control association, not a passive public-history read.
                // Establish it before acquiring the same native action lane used by intervention.
                await this.#app.pip.agents.supervision.associate(
                    api,
                    args.session,
                    this.#app.config.userById(pin.ownerId)!,
                    ctx,
                );

                return this.#app.pip.agents.supervision.perform(pin.root, () =>
                    this.#track(pin.agentId, async () => ({
                        content: [
                            {
                                type: "text" as const,
                                text: JSON.stringify(
                                    await this.#intervene(api, idOf(args.session!), ctx),
                                ),
                            },
                        ],
                    })),
                );
            },
        }),
    ];
}
