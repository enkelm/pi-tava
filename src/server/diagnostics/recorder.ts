/** Bounded metadata observations. No caller payloads or free-form exception text cross this seam. */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export type DiagnosticOutcome =
    "running" | "ok" | "failure" | "restricted" | "cancelled" | "domain" | "unknown";
export type DiagnosticComponent =
    "runtime" | "provider" | "tool" | "environment" | "workspace" | "handoff" | "scheduler";
export type DiagnosticStage =
    | "phase"
    | "execute"
    | "beforeTool"
    | "afterTool"
    | "construct"
    | "dispatch"
    | "response"
    | "receipt";
export type DiagnosticCause =
    | "none"
    | "unknown"
    | "invalid_arguments"
    | "state_conflict"
    | "tool_unavailable"
    | "blocked"
    | "aborted"
    | "interrupted"
    | "authentication"
    | "transport"
    | "not_found"
    | "permission_denied"
    | "shell_unavailable"
    | "spawn_error"
    | "nonzero_exit"
    | "result_error"
    | "hook_error"
    | "provider_error"
    | "runtime_error";
export type DiagnosticMeta = {
    conversationId: number;
    taskId?: number;
    /** Stable logical identity; different observations/replays keep separate id values. */
    operationId?: string;
    component: DiagnosticComponent;
    stage: DiagnosticStage;
    operation: string;
    provider?: string;
    model?: string;
    entryId?: number;
    nested?: boolean;
    destination?: "local" | "ssh";
    /** Native receipt state/reason, separate from operation so success and failure share a population. */
    receiptStatus?:
        "completed" | "failed" | "aborted" | "orphaned" | "faulted" | "done" | "unanswered";
    receiptReason?:
        | "missing_task"
        | "task_too_old"
        | "migration_failed"
        | "aborted"
        | "stale"
        | "model_error"
        | "no_model"
        | "reset"
        | "merged"
        | "other";
};
export type DiagnosticRecord = DiagnosticMeta & {
    id: string;
    parentId?: string;
    startedAt: number;
    endedAt?: number;
    outcome: DiagnosticOutcome;
    cause: DiagnosticCause;
};
export type DiagnosticVerdict = { outcome: DiagnosticOutcome; cause: DiagnosticCause };

/** Identifiers only, not labels, paths, prompts, commands, results or error messages. */
function identifier(value: string | undefined): string | undefined {
    return value !== undefined && /^[a-zA-Z0-9_.:/-]{1,120}$/.test(value) ? value : undefined;
}

/** Structural codes are safer than guessing causes by searching potentially secret error text. */
export function diagnosticError(error: unknown, cancelled = false): DiagnosticVerdict {
    if (cancelled) {
        return { outcome: "cancelled", cause: "aborted" };
    }

    if (typeof error !== "object" || error === null) {
        return { outcome: "failure", cause: "unknown" };
    }

    const value = error as { name?: unknown; code?: unknown; status?: unknown };

    if (value.name === "AbortError") {
        return { outcome: "cancelled", cause: "aborted" };
    }

    if (value.status === 400 || value.status === 422) {
        return { outcome: "domain", cause: "invalid_arguments" };
    }

    if (value.status === 404) {
        return { outcome: "domain", cause: "not_found" };
    }

    if (value.status === 409) {
        return { outcome: "restricted", cause: "state_conflict" };
    }

    if (value.status === 401 || value.code === "authentication_failed") {
        return { outcome: "failure", cause: "authentication" };
    }

    if (value.status === 403 || value.code === "permission_denied" || value.code === "EACCES") {
        return { outcome: "restricted", cause: "permission_denied" };
    }

    if (
        ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "transport_error"].includes(String(value.code))
    ) {
        return { outcome: "failure", cause: "transport" };
    }

    if (value.code === "ENOENT" || value.code === "not_found") {
        return { outcome: "failure", cause: "not_found" };
    }

    if (value.code === "spawn_error") {
        return { outcome: "failure", cause: "spawn_error" };
    }

    // This code covers policy refusal AND missing confinement. It does not establish which one.
    if (value.code === "shell_unavailable") {
        return { outcome: "unknown", cause: "shell_unavailable" };
    }

    return { outcome: "failure", cause: "unknown" };
}

/** Observer faults are isolated from business execution, including synchronous callback failures. */
export class DiagnosticRecorder {
    readonly #current = new AsyncLocalStorage<DiagnosticRecord>();
    readonly #emit: (record: DiagnosticRecord) => void;
    dropped = 0;

    constructor(emit: (record: DiagnosticRecord) => void) {
        this.#emit = emit;
    }

    current(): DiagnosticRecord | undefined {
        return this.#current.getStore();
    }

    #publish(record: DiagnosticRecord): void {
        try {
            this.#emit(record);
        } catch {
            this.dropped++;
        }
    }

    /** Start/end are best-effort observations, never an execution or replay permission. */
    async observe<T>(
        meta: DiagnosticMeta,
        run: () => Promise<T>,
        verdict: (result: T) => DiagnosticVerdict = () => ({ outcome: "ok", cause: "none" }),
        cancelled: () => boolean = () => false,
    ): Promise<T> {
        let record: DiagnosticRecord;

        try {
            const parent = this.current();

            record = {
                conversationId: meta.conversationId,
                component: meta.component,
                stage: meta.stage,
                operation: identifier(meta.operation) ?? "other",
                id: randomUUID(),
                startedAt: Date.now(),
                outcome: "running",
                cause: "none",
                ...(meta.taskId === undefined ? {} : { taskId: meta.taskId }),
                ...(identifier(meta.operationId) === undefined
                    ? {}
                    : { operationId: meta.operationId }),
                ...(identifier(meta.provider) === undefined ? {} : { provider: meta.provider }),
                ...(identifier(meta.model) === undefined ? {} : { model: meta.model }),
                ...(meta.entryId === undefined ? {} : { entryId: meta.entryId }),
                ...(meta.nested === undefined ? {} : { nested: meta.nested }),
                ...(meta.destination === undefined ? {} : { destination: meta.destination }),
                ...(meta.receiptStatus === undefined ? {} : { receiptStatus: meta.receiptStatus }),
                ...(meta.receiptReason === undefined ? {} : { receiptReason: meta.receiptReason }),
                ...(parent === undefined ? {} : { parentId: parent.id }),
            };
        } catch {
            this.dropped++;

            return run();
        }

        this.#publish(record);

        return this.#current.run(record, async () => {
            let ending: DiagnosticVerdict = { outcome: "unknown", cause: "unknown" };

            try {
                const result = await run();

                try {
                    ending = verdict(result);
                } catch {
                    this.dropped++;
                }

                return result;
            } catch (error) {
                try {
                    ending = diagnosticError(error, cancelled());
                } catch {
                    this.dropped++;
                }

                throw error;
            } finally {
                this.#publish({ ...record, ...ending, endedAt: Date.now() });
            }
        });
    }
}

export const DIAGNOSTIC_RECORDS = 256;
export type DiagnosticJournal = {
    records: DiagnosticRecord[];
    evicted: number;
    since: number;
};

/** Upserts preserve a single observation across start/end writes; replay has a different observation id. */
export function retainDiagnostics(
    journal: DiagnosticJournal,
    records: readonly DiagnosticRecord[],
): void {
    for (const record of records) {
        const index = journal.records.findIndex((old) => old.id === record.id);

        if (index === -1) {
            journal.records.push(record);
        } else {
            journal.records[index] = record;
        }
    }

    if (journal.records.length > DIAGNOSTIC_RECORDS) {
        journal.evicted += journal.records.length - DIAGNOSTIC_RECORDS;
        journal.records.splice(0, journal.records.length - DIAGNOSTIC_RECORDS);
    }
}
