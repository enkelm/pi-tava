/** Owner-private, passive failure diagnosis over bounded server observations and Durable task metadata. */
import { createHash, randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import {
    defineTool,
    type ConversationId,
    type TaskId,
    type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { DiagnosticsDoc } from "./docs.ts";
import {
    DiagnosticRecorder,
    retainDiagnostics,
    type DiagnosticJournal,
    type DiagnosticRecord,
} from "./diagnostics/recorder.ts";

const ROOT_LIMIT = 1000;
const PAGE_CONVERSATIONS = 3;
const OUTPUT_BYTES = 32 * 1024;
const QUEUE_LIMIT = 1024;
const CURSOR_TTL = 5 * 60_000;
const context = BACKGROUND_CONTEXT;

type Scope =
    | { kind: "session"; id: number }
    | { kind: "work-item"; id: string }
    | { kind: "project"; id: string }
    | { kind: "owner" };
type Invocation = Pick<ToolExecutionApi, "conversationId" | "taskId">;
type Cursor = { binding: string; next: number; expires: number };
type Page = { session: number; journal: Readonly<DiagnosticJournal> | undefined };

const scopeSchema = Type.Union([
    Type.Object(
        { kind: Type.Literal("session"), id: Type.Integer({ minimum: 1 }) },
        { additionalProperties: false },
    ),
    Type.Object(
        { kind: Type.Literal("work-item"), id: Type.String({ minLength: 1, maxLength: 120 }) },
        { additionalProperties: false },
    ),
    Type.Object(
        { kind: Type.Literal("project"), id: Type.String({ minLength: 1, maxLength: 120 }) },
        { additionalProperties: false },
    ),
    Type.Object({ kind: Type.Literal("owner") }, { additionalProperties: false }),
]);

const NOTES = [
    "Observations are metadata, not semantic task/check success or a health certificate.",
    "Counts are retained observations, not lifetime totals. Task phases, tool executions, nested calls, workspace operations and provider responses are separate populations; do not add them.",
    "Logical operation identities deduplicate observed replays only where supplied. SDK/provider-side retries and uncommitted attempts are unknown.",
    "No historical backfill, active/exclusive runtime, usage/cost accounting or exact failure time-window index. Running observations after restart may be interrupted; no end receipt is not proof of ongoing work.",
    "A missing cause remains unknown. shell_unavailable can mean either intentional policy refusal or unavailable confinement. Nonzero exit/domain errors are not automatically infrastructure failures.",
    "Pagination reads current retained state, not a frozen snapshot. Eviction and failed observer writes lose evidence. No recent error is not proof of health.",
    "Codemode validation rejected before hooks/execution, environment reader-handle methods and watcher callbacks are not independently captured. Nested coverage is incomplete.",
];

/** A signature uses controlled categories, never a hash of potentially sensitive exception text. */
function signature(record: DiagnosticRecord): string {
    return JSON.stringify([
        record.component,
        record.stage,
        record.operation,
        record.destination ?? "",
        record.provider ?? "",
        record.model ?? "",
        record.outcome,
        record.cause,
        record.receiptStatus ?? "",
        record.receiptReason ?? "",
        record.nested === true,
    ]);
}

function deadline(ctx: Context): Context {
    return withAbortSignal(
        AbortSignal.any([
            AbortSignal.timeout(5000),
            ...(ctx.abortSignal === undefined ? [] : [ctx.abortSignal]),
        ]),
        ctx,
    );
}

function operation(record: DiagnosticRecord): string {
    return JSON.stringify([
        record.component,
        record.stage,
        record.operation,
        record.destination ?? "",
        record.provider ?? "",
        record.model ?? "",
        record.nested === true,
    ]);
}

function evidence(record: DiagnosticRecord) {
    return {
        session: record.conversationId,
        observation: record.id,
        ...(record.taskId === undefined ? {} : { task: record.taskId }),
        ...(record.entryId === undefined ? {} : { entry: record.entryId }),
    };
}

export class Diagnostics {
    readonly #app: PocketApp;
    readonly recorder: DiagnosticRecorder;
    readonly #pending = new Map<string, DiagnosticRecord>();
    readonly #cursors = new Map<string, Cursor>();
    #timer: NodeJS.Immediate | undefined;
    #writing: Promise<void> | undefined;
    #closed = false;
    #writeFailures = 0;
    #queueDropped = 0;

    constructor(app: PocketApp) {
        this.#app = app;
        this.recorder = new DiagnosticRecorder((record) => this.#enqueue(record));
    }

    /** Capture is passive and bounded. Storage trouble never fails, blocks or repeats the observed operation. */
    #enqueue(record: DiagnosticRecord): void {
        if (this.#closed) {
            return;
        }

        if (!this.#pending.has(record.id) && this.#pending.size >= QUEUE_LIMIT) {
            this.#queueDropped++;

            return;
        }

        this.#pending.set(record.id, record);

        if (this.#timer === undefined && this.#writing === undefined) {
            this.#timer = setImmediate(() => {
                this.#timer = undefined;
                this.#writing = this.#flush().finally(() => {
                    this.#writing = undefined;

                    if (!this.#closed && this.#pending.size > 0) {
                        this.#enqueue(this.#pending.values().next().value!);
                    }
                });
            });
        }
    }

    async #flush(): Promise<void> {
        const records = [...this.#pending.values()];
        const byConversation = new Map<number, DiagnosticRecord[]>();

        this.#pending.clear();

        for (const record of records) {
            const rows = byConversation.get(record.conversationId) ?? [];

            rows.push(record);
            byConversation.set(record.conversationId, rows);
        }

        // Bounded upserts only on the mutation line; grouping and queries happen outside it.
        for (const [id, rows] of byConversation) {
            try {
                await this.#app.harness.commit(async (tx) => {
                    const journal = await tx.doc(DiagnosticsDoc, id as ConversationId);

                    retainDiagnostics(journal, rows);
                }, context);
            } catch {
                this.#writeFailures += rows.length;
            }
        }
    }

    /** Stop capture and drain before storage closes; final shutdown interruptions may remain unobserved. */
    async close(): Promise<void> {
        this.#closed = true;

        if (this.#timer !== undefined) {
            clearImmediate(this.#timer);
            this.#timer = undefined;
        }

        await this.#writing;
        await this.#flush();
        this.#cursors.clear();
    }

    /** Authorization lives in the reader, not in registration, model-supplied roles or tool-list filtering. */
    #authority(invocation: Invocation) {
        const app = this.#app;
        const meta = app.sessionMeta(invocation.conversationId);
        const user = meta?.pip === undefined ? undefined : app.config.userById(meta.pip);

        if (
            meta?.pipWorkItemId !== undefined ||
            meta?.pipAgent === true ||
            user?.role !== "owner" ||
            !app.pip.available(user) ||
            app.rootOf(invocation.conversationId) !== invocation.conversationId
        ) {
            throw new Error(
                "Diagnostics require the current owner's global private PiP, not named agents, shared agents, helpers or scoped controllers.",
            );
        }

        const token = user.tokenHash;
        const ownerId = user.id;

        const check = () => {
            const current = app.config.userById(ownerId);
            const currentMeta = app.sessionMeta(invocation.conversationId);

            if (
                current?.role !== "owner" ||
                current.tokenHash !== token ||
                currentMeta?.pip !== ownerId ||
                currentMeta.pipWorkItemId !== undefined ||
                currentMeta.pipAgent === true ||
                !app.pip.available(current)
            ) {
                throw new Error("Diagnostic authority changed; discard this read.");
            }

            return current;
        };

        return { user: structuredClone(user), check, token };
    }

    #scope(scope: Scope, check: () => User) {
        const user = check();
        const app = this.#app;

        if (scope.kind === "session") {
            const id = scope.id as ConversationId;
            const root = app.rootOf(id);
            const meta = app.sessionMeta(root);

            if (meta === undefined || meta.pip !== undefined || !app.canSee(user, id)) {
                throw new Error("No authorized execution sessions in this scope.");
            }

            const selected =
                root === id
                    ? app.diagnosticConversations([root], ROOT_LIMIT)
                    : { members: [id], limited: false };

            return {
                members: selected.members
                    .filter((child) => app.canSee(user, child))
                    .map(Number)
                    .sort((a, b) => a - b),
                bounded: selected.limited,
            };
        }

        const members: number[] = [];
        let examined = 0;
        let bounded = false;

        for (const key in app.sessionCatalogue()) {
            if (++examined > ROOT_LIMIT) {
                bounded = true;
                break;
            }

            const id = Number(key) as ConversationId;
            const meta = app.sessionMeta(id)!;

            if (meta.pip !== undefined || !app.canSee(user, id)) {
                continue;
            }

            if (
                (scope.kind === "work-item" && scope.id !== meta.workItemId) ||
                (scope.kind === "project" && scope.id !== meta.projectId)
            ) {
                continue;
            }

            members.push(Number(id));
        }

        if (members.length === 0 && scope.kind !== "owner") {
            throw new Error(
                bounded
                    ? "Scope enumeration reached its bound; select an exact session instead."
                    : "No authorized execution sessions in this scope.",
            );
        }

        const selected = app.diagnosticConversations(members as ConversationId[], ROOT_LIMIT);

        return {
            members: selected.members
                .filter((id) => app.canSee(user, id))
                .map(Number)
                .sort((a, b) => a - b),
            bounded: bounded || selected.limited,
        };
    }

    async #prepare(invocation: Invocation, scope: Scope, ctx: Context) {
        ctx.abortSignal?.throwIfAborted();
        const authority = this.#authority(invocation);
        const selected = this.#scope(scope, authority.check);
        const task = await this.#app.harness.getTask(invocation.taskId, ctx);

        authority.check();
        ctx.abortSignal?.throwIfAborted();

        if (
            task?.conversationId !== invocation.conversationId ||
            task.kind !== "pi.tool" ||
            task.state.status !== "running"
        ) {
            throw new Error("Diagnostics require an actual private tool invocation.");
        }

        const binding = createHash("sha256")
            .update(
                JSON.stringify([
                    invocation.conversationId,
                    authority.user.id,
                    authority.token,
                    scope,
                    selected.members,
                ]),
            )
            .digest("hex");

        const check = () => {
            const current = this.#scope(scope, authority.check);

            if (JSON.stringify(current) !== JSON.stringify(selected)) {
                throw new Error("Diagnostic scope changed; start a fresh read.");
            }

            ctx.abortSignal?.throwIfAborted();
        };

        return { ...selected, binding, check };
    }

    #offset(cursor: string | undefined, binding: string): number {
        if (cursor === undefined) {
            return 0;
        }

        const saved = this.#cursors.get(cursor);

        if (saved === undefined || saved.binding !== binding || saved.expires < Date.now()) {
            throw new Error("Diagnostic cursor expired or belongs to a different caller or scope.");
        }

        return saved.next;
    }

    #cursor(next: number, binding: string): string {
        for (const [key, value] of this.#cursors) {
            if (value.expires < Date.now()) {
                this.#cursors.delete(key);
            }
        }

        while (this.#cursors.size >= 64) {
            this.#cursors.delete(this.#cursors.keys().next().value!);
        }

        const id = randomUUID();

        this.#cursors.set(id, { binding, next, expires: Date.now() + CURSOR_TTL });

        return id;
    }

    async #page(invocation: Invocation, scope: Scope, cursor: string | undefined, ctx: Context) {
        const selection = await this.#prepare(invocation, scope, ctx);
        const offset = this.#offset(cursor, selection.binding);
        const ids = selection.members.slice(offset, offset + PAGE_CONVERSATIONS);
        const pages: Page[] = [];

        for (const id of ids) {
            selection.check();
            const journal = await this.#app.harness.snapshot(
                DiagnosticsDoc,
                id as ConversationId,
                ctx,
            );

            selection.check();
            pages.push({ session: id, journal });
        }

        return {
            selection,
            pages,
            envelope: {
                version: 1,
                capturedAt: Date.now(),
                scope,
                provenance: "bounded server observations + current stored task metadata",
                coverage: {
                    scopeConversations: selection.members.length,
                    scopeEnumerationLimited: selection.bounded,
                    pageConversations: ids,
                    missingJournals: pages
                        .filter((page) => page.journal === undefined)
                        .map((page) => page.session),
                    scannedObservations: pages.reduce(
                        (sum, page) => sum + (page.journal?.records.length ?? 0),
                        0,
                    ),
                    evictedObservations: pages.reduce(
                        (sum, page) => sum + (page.journal?.evicted ?? 0),
                        0,
                    ),
                    since: pages.map((page) => ({
                        session: page.session,
                        since: page.journal?.since ?? null,
                    })),
                    processObserverWriteFailures: this.#writeFailures,
                    processObserverDropped: this.recorder.dropped + this.#queueDropped,
                    pendingObservations: this.#pending.size,
                    complete: false,
                },
                cursor:
                    offset + ids.length < selection.members.length
                        ? this.#cursor(offset + ids.length, selection.binding)
                        : null,
                definitions: NOTES,
            },
        };
    }

    /** Bounded current task state; it never calls inspect/resume/progress or constructs a workspace. */
    async status(invocation: Invocation, scope: Scope, cursor: string | undefined, ctx: Context) {
        ctx = deadline(ctx);
        const page = await this.#page(invocation, scope, cursor, ctx);
        const tasks: {
            session: number;
            id: number;
            kind: string;
            status: string;
            background: boolean;
            abortRequested: boolean;
            startedAt: number | null;
        }[] = [];
        let taskScanLimited = false;

        for (const { session } of page.pages) {
            for (const status of [
                "pending",
                "running",
                "sleeping",
                "waiting",
                "completing",
            ] as const) {
                page.selection.check();
                const rows = await this.#app.harness.commit(
                    (tx) => tx.scanTasks({ conversationId: session as ConversationId, status }, 24),
                    ctx,
                );

                page.selection.check();
                taskScanLimited ||= rows.next !== undefined;

                for (const task of rows.items) {
                    tasks.push({
                        session,
                        id: Number(task.id),
                        kind: /^[a-zA-Z0-9_.:/-]{1,120}$/.test(task.kind) ? task.kind : "other",
                        status: task.state.status,
                        background: task.background,
                        abortRequested: task.abortRequested,
                        startedAt: task.startedAt ?? null,
                    });
                }
            }
        }

        page.selection.check();

        return this.#bounded({
            ...page.envelope,
            tasks: tasks.slice(0, 100),
            taskScanLimited: taskScanLimited || tasks.length > 100,
            health: "unknown",
            unsettledObservations: page.pages.flatMap(
                (item) =>
                    item.journal?.records
                        .filter((record) => record.outcome === "running")
                        .slice(-10)
                        .map(evidence) ?? [],
            ),
        });
    }

    /** Counts and recurring signatures remain separate per stage, with observed successes as the denominator. */
    async failures(invocation: Invocation, scope: Scope, cursor: string | undefined, ctx: Context) {
        ctx = deadline(ctx);
        const page = await this.#page(invocation, scope, cursor, ctx);
        const groups = new Map<
            string,
            {
                signature: string;
                component: string;
                stage: string;
                operation: string;
                destination: string | null;
                provider: string | null;
                model: string | null;
                receiptStatus: string | null;
                receiptReason: string | null;
                outcome: string;
                cause: string;
                nesting: "direct" | "nested";
                observations: number;
                logicalOperations: Set<string>;
                logicalIdentities: number;
                nested: number;
                firstSeen: number;
                lastSeen: number;
                sessions: Set<number>;
                evidence: ReturnType<typeof evidence>[];
            }
        >();
        const populations = new Map<
            string,
            {
                population: string;
                nesting: "direct" | "nested";
                observations: number;
                finished: number;
                ok: number;
                logicalOperations: Set<string>;
                logicalIdentities: number;
            }
        >();
        const successes = new Map<string, number>();
        const failures = new Map<string, number>();
        const records = page.pages.flatMap((item) => item.journal?.records ?? []);

        for (const record of records) {
            const key = operation(record);
            const population = populations.get(key) ?? {
                population: key,
                nesting: record.nested === true ? "nested" : "direct",
                observations: 0,
                finished: 0,
                ok: 0,
                logicalOperations: new Set<string>(),
                logicalIdentities: 0,
            };

            population.observations++;
            population.finished += Number(record.outcome !== "running");
            population.ok += Number(record.outcome === "ok");

            if (record.operationId !== undefined) {
                population.logicalOperations.add(`${record.conversationId}:${record.operationId}`);
                population.logicalIdentities++;
            }

            populations.set(key, population);

            if (record.outcome === "ok") {
                successes.set(
                    `${record.conversationId}:${key}`,
                    Math.max(
                        successes.get(`${record.conversationId}:${key}`) ?? 0,
                        record.endedAt ?? record.startedAt,
                    ),
                );
            }

            if (record.outcome === "running" || record.outcome === "ok") {
                continue;
            }

            const sig = signature(record);

            failures.set(
                `${record.conversationId}:${sig}`,
                Math.max(
                    failures.get(`${record.conversationId}:${sig}`) ?? 0,
                    record.endedAt ?? record.startedAt,
                ),
            );
            const group = groups.get(sig) ?? {
                signature: sig,
                component: record.component,
                stage: record.stage,
                operation: record.operation,
                destination: record.destination ?? null,
                provider: record.provider ?? null,
                model: record.model ?? null,
                receiptStatus: record.receiptStatus ?? null,
                receiptReason: record.receiptReason ?? null,
                outcome: record.outcome,
                cause: record.cause,
                nesting: record.nested === true ? "nested" : "direct",
                observations: 0,
                logicalOperations: new Set<string>(),
                logicalIdentities: 0,
                nested: 0,
                firstSeen: record.startedAt,
                lastSeen: record.startedAt,
                sessions: new Set<number>(),
                evidence: [],
            };

            group.observations++;
            group.nested += Number(record.nested === true);
            group.firstSeen = Math.min(group.firstSeen, record.startedAt);
            group.lastSeen = Math.max(group.lastSeen, record.endedAt ?? record.startedAt);
            group.sessions.add(record.conversationId);

            if (record.operationId !== undefined) {
                group.logicalOperations.add(`${record.conversationId}:${record.operationId}`);
                group.logicalIdentities++;
            }

            if (group.evidence.length < 3) {
                group.evidence.push(evidence(record));
            }

            groups.set(sig, group);
        }

        page.selection.check();
        const incidents = [...groups.values()]
            .sort((a, b) => b.lastSeen - a.lastSeen)
            .slice(0, 50)
            .map((group) => {
                const sample = records.find((record) => signature(record) === group.signature)!;
                const recoveredSessions = [...group.sessions].filter(
                    (session) =>
                        (successes.get(`${session}:${operation(sample)}`) ?? 0) >
                        (failures.get(`${session}:${group.signature}`) ?? 0),
                );

                return {
                    ...group,
                    logicalOperations:
                        group.logicalIdentities === 0 ? null : group.logicalOperations.size,
                    logicalIdentityMissing: group.observations - group.logicalIdentities,
                    sessions: [...group.sessions].slice(0, 25),
                    recoveredSessions,
                    recoveryMeaning:
                        "later observed ok at the same stage/operation and nesting in an affected session; not proof of repair",
                    evidence: group.evidence,
                };
            });

        return this.#bounded({
            ...page.envelope,
            populations: [...populations.values()].slice(0, 50).map((population) => ({
                ...population,
                logicalOperations:
                    population.logicalIdentities === 0 ? null : population.logicalOperations.size,
                logicalIdentityMissing: population.observations - population.logicalIdentities,
            })),
            incidents,
            omittedSignatures: Math.max(0, groups.size - incidents.length),
            omittedPopulations: Math.max(0, populations.size - 50),
        });
    }

    /** Exact trace lookup does not scan arbitrary task inputs or expose free-form errors/results. */
    async trace(invocation: Invocation, session: number, observation: string, ctx: Context) {
        ctx = deadline(ctx);
        const page = await this.#page(invocation, { kind: "session", id: session }, undefined, ctx);
        const journal = page.pages.find((item) => item.session === session)?.journal;
        const found = journal?.records.find((record) => record.id === observation);

        if (found === undefined) {
            throw new Error(
                "Observation not retained in the selected session; it may have been evicted or never recorded.",
            );
        }

        let task;

        if (found.taskId !== undefined) {
            page.selection.check();
            const stored = await this.#app.harness.getTask(found.taskId as TaskId, ctx);

            page.selection.check();

            if (stored !== undefined && Number(stored.conversationId) === session) {
                task = {
                    id: Number(stored.id),
                    kind: stored.kind,
                    status: stored.state.status,
                    outcome:
                        stored.state.status === "terminal" ? stored.state.outcome.status : null,
                    startedAt: stored.startedAt ?? null,
                    endedAt: stored.endedAt ?? null,
                    timingMeaning:
                        "task elapsed wall span includes waits, children and recovery downtime",
                };
            }
        }

        const related = journal!.records.filter(
            (record) =>
                record.id === found.id ||
                record.id === found.parentId ||
                record.parentId === found.id ||
                (found.taskId !== undefined && record.taskId === found.taskId),
        );

        page.selection.check();

        return this.#bounded({
            ...page.envelope,
            observation: found,
            related: related.slice(0, 50),
            omittedRelated: Math.max(0, related.length - 50),
            task: task ?? null,
            missingParent:
                found.parentId !== undefined &&
                !journal!.records.some((record) => record.id === found.parentId),
        });
    }

    #bounded(value: object): string {
        const result = value as { coverage: Record<string, unknown>; [key: string]: unknown };
        const omitted: Record<string, number> = {};
        const keys = ["related", "incidents", "populations", "tasks", "unsettledObservations"];
        let serialized = JSON.stringify(result);

        while (Buffer.byteLength(serialized) > OUTPUT_BYTES) {
            const key = keys.find((key) => Array.isArray(result[key]) && result[key].length > 0);

            if (key === undefined) {
                return JSON.stringify({
                    version: 1,
                    capturedAt: Date.now(),
                    coverage: { complete: false, outputLimited: true },
                    error: "Diagnostic metadata exceeds the output bound. No raw payload or truncated JSON is returned.",
                });
            }

            (result[key] as unknown[]).pop();
            omitted[key] = (omitted[key] ?? 0) + 1;
            result.coverage.outputOmittedRows = omitted;
            serialized = JSON.stringify(result);
        }

        return serialized;
    }

    /** The private registration supplies these tools; live service authorization requires global PiP. */
    tools() {
        const reply = (text: string) => ({ output: [{ type: "text" as const, text }] });

        return [
            defineTool({
                name: "collab_status",
                description:
                    "Passive, owner-private system status for an explicit session/work-item/project/owner scope. Bounded current tasks and observation coverage, never probes shell/SSH or resumes work. Health remains unknown without evidence. Follow cursor with identical scope.",
                parameters: Type.Object(
                    { scope: scopeSchema, cursor: Type.Optional(Type.String({ maxLength: 80 })) },
                    { additionalProperties: false },
                ),
                replay: "safe",
                execute: async (args, api, ctx) =>
                    reply(await this.status(api, args.scope, args.cursor, ctx)),
            }),
            defineTool({
                name: "collab_failures",
                description:
                    "Owner-private grouped failure signatures, intentional restrictions, cancellations and domain errors, with per-stage successful/finished observation denominators, logical operation counts and evidence IDs. Counts are retained page observations, not lifetime rates or health. Follow cursor with identical scope.",
                parameters: Type.Object(
                    { scope: scopeSchema, cursor: Type.Optional(Type.String({ maxLength: 80 })) },
                    { additionalProperties: false },
                ),
                replay: "safe",
                execute: async (args, api, ctx) =>
                    reply(await this.failures(api, args.scope, args.cursor, ctx)),
            }),
            defineTool({
                name: "collab_trace",
                description:
                    "Owner-private sanitized metadata trace for an exact observation in an execution session. Includes related stages and stored task outcome/timing, never raw prompts, tool arguments/results, exception text, credentials or environment dumps.",
                parameters: Type.Object(
                    {
                        session: Type.Integer({ minimum: 1 }),
                        observation: Type.String({ minLength: 1, maxLength: 80 }),
                    },
                    { additionalProperties: false },
                ),
                replay: "safe",
                execute: async (args, api, ctx) =>
                    reply(await this.trace(api, args.session, args.observation, ctx)),
            }),
        ];
    }
}
