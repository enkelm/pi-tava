/** Observe Durable's read side without changing registration, guards, checkpoints or replay policy. */
import { createHash } from "node:crypto";
import type { Context, JsonValue } from "@earendil-works/chord";
import {
    type Agent,
    type AnyTask,
    type CommitPublication,
    type Extension,
    type HookRegistration,
    type RegistryReader,
    type RegistrySnapshot,
    type Task,
    type TaskRuntime,
    type ToolExecutionResult,
    type ToolHooks,
    type ToolRegistration,
    ToolResultEntry,
    ToolTask,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv, Result, ShellExecResult } from "@earendil-works/pi-durable/env";
import {
    diagnosticError,
    type DiagnosticComponent,
    type DiagnosticMeta,
    type DiagnosticRecorder,
    type DiagnosticVerdict,
} from "./recorder.ts";

const OK: DiagnosticVerdict = { outcome: "ok", cause: "none" };
const DOMAIN_ERROR: DiagnosticVerdict = { outcome: "domain", cause: "result_error" };

type Runtime = TaskRuntime<unknown, { phase: string }, unknown, object>;
type ExecutableTask = Task<unknown, { phase: string }, unknown, object>;

/** Forward getters and bind unmodified methods to their owner (including objects with private fields). */
function decorate<T extends object>(target: T, overrides: Partial<T>): T {
    // Use a facade, not target itself: immutable registrations may have non-configurable properties.
    return new Proxy(Object.create(Object.getPrototypeOf(target)) as T, {
        get(_facade, key) {
            if (Object.hasOwn(overrides, key)) {
                return Reflect.get(overrides, key);
            }

            const value: unknown = Reflect.get(target, key, target);

            return typeof value === "function" ? value.bind(target) : value;
        },
        has: (_facade, key) => key in overrides || key in target,
        ownKeys: () => [...new Set([...Reflect.ownKeys(target), ...Reflect.ownKeys(overrides)])],
        getOwnPropertyDescriptor(_facade, key) {
            const descriptor =
                Object.getOwnPropertyDescriptor(overrides, key) ??
                Object.getOwnPropertyDescriptor(target, key);

            return descriptor === undefined ? undefined : { ...descriptor, configurable: true };
        },
    });
}

function nestedTool(recorder: DiagnosticRecorder): boolean {
    const parent = recorder.current();

    return parent?.component === "tool" && parent.stage === "execute";
}

function callIdentity(taskId: number, callId: string): string {
    // Call ids come from providers, not our enum vocabulary. Retain only an opaque correlation key.
    const digest = createHash("sha256").update(callId).digest("hex").slice(0, 24);

    return `task/${taskId}/tool/${digest}`;
}

function resultVerdict(result: ToolExecutionResult): DiagnosticVerdict {
    // A successful invocation says nothing about the quality/correctness of its output.
    return result.isError === true ? DOMAIN_ERROR : OK;
}

/** Recognize only Harness's structural code vocabulary; unknown tool diagnostics stay domain-level. */
function receiptVerdict(value: JsonValue | undefined, isError: boolean): DiagnosticVerdict {
    if (!isError) {
        return OK;
    }

    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        const diagnostics = value.diagnostics;

        if (Array.isArray(diagnostics)) {
            // Plugin diagnostics are arbitrary data; bound work in the synchronous commit listener.
            for (const diagnostic of diagnostics.slice(0, 16)) {
                if (
                    diagnostic === null ||
                    typeof diagnostic !== "object" ||
                    Array.isArray(diagnostic)
                ) {
                    continue;
                }

                if (diagnostic.severity !== "error") {
                    continue;
                }

                switch (diagnostic.code) {
                    case "invalid_arguments":
                        return { outcome: "domain", cause: "invalid_arguments" };
                    case "tool_unavailable":
                        return { outcome: "restricted", cause: "tool_unavailable" };
                    case "blocked":
                        return { outcome: "restricted", cause: "blocked" };
                    case "interrupted":
                        return { outcome: "unknown", cause: "interrupted" };
                    case "aborted":
                        return { outcome: "cancelled", cause: "aborted" };
                    case "tool_error":
                        return { outcome: "failure", cause: "unknown" };
                }
            }
        }
    }

    return DOMAIN_ERROR;
}

function taskComponent(kind: string): DiagnosticComponent {
    return kind.startsWith("pocket.handoff-")
        ? "handoff"
        : kind === "pocket.schedule"
          ? "scheduler"
          : "runtime";
}

const INPUT_REASONS = new Set(["aborted", "stale", "model_error", "no_model", "reset", "merged"]);
const ORPHAN_REASONS = new Set(["missing_task", "task_too_old", "migration_failed"]);

function knownReason(
    value: string,
    allowed: ReadonlySet<string>,
): value is NonNullable<DiagnosticMeta["receiptReason"]> {
    return value.length <= 32 && allowed.has(value);
}

/**
 * Observe committed receipts, not more execute attempts. Generation can write tool_unavailable without a pi.tool
 * task, and scheduler terminal faults need not throw through a phase. Never scan tasks/read on the Session line.
 * Only known codes/statuses/reasons affect categories; messages, checkpoints, inputs, results and details stay out.
 */
export function committedDiagnostics(
    publication: CommitPublication,
    recorder: DiagnosticRecorder,
): void {
    for (const change of publication.changes) {
        if (change.type === "task" && change.value.state.status === "terminal") {
            const task = change.value;
            const state = change.value.state;
            const status = state.outcome.status;
            const reason =
                state.outcome.status === "orphaned"
                    ? knownReason(state.outcome.reason, ORPHAN_REASONS)
                        ? state.outcome.reason
                        : "other"
                    : undefined;

            void recorder.observe(
                {
                    conversationId: task.conversationId,
                    taskId: task.id,
                    operationId: `task/${task.id}/terminal`,
                    component: taskComponent(task.kind),
                    stage: "receipt",
                    operation: task.kind,
                    receiptStatus: status,
                    receiptReason: reason,
                },
                async () => undefined,
                () =>
                    status === "completed"
                        ? OK
                        : status === "aborted"
                          ? { outcome: "cancelled", cause: "aborted" }
                          : status === "failed"
                            ? { outcome: "unknown", cause: "unknown" }
                            : { outcome: "failure", cause: "runtime_error" },
            );

            continue;
        }

        if (
            change.type === "submission" &&
            change.value.type === "input" &&
            (change.value.status === "done" || change.value.status === "unanswered")
        ) {
            const input = change.value;
            const reason =
                input.status === "unanswered"
                    ? knownReason(input.reason, INPUT_REASONS)
                        ? input.reason
                        : "other"
                    : undefined;

            void recorder.observe(
                {
                    conversationId: input.conversationId,
                    entryId: input.entry,
                    operationId: `input/${input.id}`,
                    component: "runtime",
                    stage: "receipt",
                    operation: "input",
                    receiptStatus: input.status,
                    receiptReason: reason,
                },
                async () => undefined,
                () =>
                    input.status === "done"
                        ? OK
                        : reason === "aborted" || reason === "reset"
                          ? { outcome: "cancelled", cause: "aborted" }
                          : reason === "model_error"
                            ? { outcome: "failure", cause: "provider_error" }
                            : reason === "no_model"
                              ? { outcome: "restricted", cause: "runtime_error" }
                              : { outcome: "unknown", cause: "unknown" },
            );

            continue;
        }

        if (change.type !== "entry" || change.value.kind !== ToolResultEntry.kind) {
            continue;
        }

        const entry = change.value;
        const result = entry.model?.[0];

        // Imported history has no native task attribution; it is not a new local execution receipt.
        if (result?.role !== "toolResult" || entry.byTaskId === undefined) {
            continue;
        }

        const verdict = receiptVerdict(entry.data, result.isError);

        void recorder.observe(
            {
                conversationId: entry.conversationId,
                taskId: entry.byTaskId,
                entryId: entry.id,
                operationId: callIdentity(entry.byTaskId, result.toolCallId),
                component: "tool",
                stage: "receipt",
                // An unavailable name came from model output, not a resolved registration; it can contain secrets.
                operation: verdict.cause === "tool_unavailable" ? "unavailable" : result.toolName,
            },
            async () => undefined,
            () => verdict,
        );
    }
}

/**
 * Keep the original registry with the loader. Give this live reader to Harness instead. Snapshots and task wrappers
 * are cached by original identity: unchanged definitions must not look like replacements to Durable's scheduler.
 * Tool execution is wrapped on the resolved agent, AFTER extension wraps, so those wraps cannot bypass observation.
 */
export function observeRegistry(
    registry: RegistryReader,
    recorder: DiagnosticRecorder,
): RegistryReader {
    const snapshots = new WeakMap<RegistrySnapshot, RegistrySnapshot>();
    const tasks = new WeakMap<AnyTask, AnyTask>();
    const extensions = new WeakMap<Extension, Extension>();
    const agents = new WeakMap<Agent, Agent>();
    const tools = new WeakMap<ToolRegistration, ToolRegistration>();

    const observeTool = (tool: ToolRegistration): ToolRegistration => {
        let observed = tools.get(tool);

        if (observed === undefined) {
            observed = decorate(tool, {
                execute: (args, api, context) => {
                    return recorder.observe(
                        {
                            conversationId: api.conversationId,
                            taskId: api.taskId,
                            operationId: callIdentity(api.taskId, api.callId),
                            component: "tool",
                            stage: "execute",
                            operation: tool.name,
                            nested: nestedTool(recorder),
                        },
                        () => tool.execute(args, api, context),
                        resultVerdict,
                        () => context.abortSignal?.aborted ?? false,
                    );
                },
            });
            tools.set(tool, observed);
        }

        return observed;
    };

    const observeAgent = (agent: Agent): Agent => {
        let observed = agents.get(agent);

        if (observed === undefined) {
            observed = decorate(agent, { tools: Object.freeze(agent.tools.map(observeTool)) });
            agents.set(agent, observed);
        }

        return observed;
    };

    const observeHooks = (
        registration: HookRegistration,
        index: number,
        extension: string,
    ): HookRegistration => {
        if (registration.task !== ToolTask.definition.name) {
            return registration;
        }

        const handlers = registration.handlers as Partial<ToolHooks>;
        const overrides: Partial<ToolHooks> = {};
        // Indices are local to an extension. Opaque namespacing keeps distinct hooks distinct
        // across extensions without persisting another arbitrary registration string.
        const identity = createHash("sha256")
            .update(JSON.stringify([extension, index]))
            .digest("hex")
            .slice(0, 24);

        for (const stage of ["beforeTool", "afterTool"] as const) {
            const handler = handlers[stage];

            if (typeof handler !== "function") {
                continue;
            }

            // A hook throw has a known origin, but must still propagate unchanged for Harness/codemode composition.
            const invoke = async (...args: unknown[]) => {
                const [call] = args as [Parameters<ToolHooks["beforeTool"]>[0]];
                const api = args[stage === "beforeTool" ? 1 : 2] as Parameters<
                    ToolHooks["beforeTool"]
                >[1];
                const context = args.at(-1) as Context;
                const result = await recorder.observe(
                    {
                        conversationId: api.conversationId,
                        taskId: api.taskId,
                        operationId: `${callIdentity(api.taskId, call.id)}/${stage}/${identity}`,
                        component: "tool",
                        stage,
                        operation: call.name,
                        nested: nestedTool(recorder),
                    },
                    async () => {
                        try {
                            return {
                                threw: false as const,
                                value: await Reflect.apply(handler, handlers, args),
                            };
                        } catch (error) {
                            return { threw: true as const, error };
                        }
                    },
                    (result) => {
                        if (result.threw) {
                            return context.abortSignal?.aborted
                                ? diagnosticError(result.error, true)
                                : { outcome: "failure", cause: "hook_error" };
                        }

                        if (stage === "beforeTool") {
                            return result.value?.block === undefined
                                ? OK
                                : { outcome: "restricted", cause: "blocked" };
                        }

                        return result.value === undefined ? OK : resultVerdict(result.value);
                    },
                );

                if (result.threw) {
                    throw result.error;
                }

                return result.value;
            };

            Object.assign(overrides, { [stage]: invoke });
        }

        return decorate(registration, { handlers: decorate(handlers, overrides) });
    };

    const observeTask = (task: AnyTask): AnyTask => {
        let observed = tasks.get(task);

        if (observed !== undefined) {
            return observed;
        }

        const definition = (task as ExecutableTask).definition;

        const wrap =
            (handler: ExecutableTask["definition"]["abort"], phase: number) =>
            async (record: Parameters<typeof handler>[0], runtime: Runtime, context: Context) => {
                const decorated = decorate(runtime, {
                    agent: async (scope) => observeAgent(await runtime.agent(scope)),
                });

                return recorder.observe(
                    {
                        conversationId: runtime.conversationId,
                        taskId: runtime.taskId,
                        operationId: `task/${runtime.taskId}/phase/${phase}`,
                        component: taskComponent(definition.name),
                        stage: "phase",
                        operation: `${definition.name}/${phase === -1 ? "abort" : phase}`,
                    },
                    () =>
                        handler.call(
                            phase === -1 ? definition : definition.phases,
                            record,
                            decorated,
                            context,
                        ),
                    () => OK,
                    () => runtime.signal.aborted,
                );
            };

        const phases = Object.fromEntries(
            Object.entries(definition.phases).map(([name, handler], index) => [
                name,
                wrap(handler, index),
            ]),
        );

        observed = decorate(task, {
            definition: decorate(definition, {
                phases: Object.freeze(phases),
                abort: wrap(definition.abort, -1),
            }),
        });
        tasks.set(task, observed);

        return observed;
    };

    const observeExtension = (extension: Extension): Extension => {
        let observed = extensions.get(extension);

        if (observed === undefined) {
            observed = decorate(extension, {
                ...(extension.tasks === undefined
                    ? {}
                    : { tasks: Object.freeze(extension.tasks.map(observeTask)) }),
                ...(extension.hooks === undefined
                    ? {}
                    : {
                          hooks: Object.freeze(
                              extension.hooks.map((registration, index) =>
                                  observeHooks(registration, index, extension.name),
                              ),
                          ),
                      }),
            });
            extensions.set(extension, observed);
        }

        return observed;
    };

    return {
        subscribe: (listener) => registry.subscribe(listener),
        snapshot() {
            const original = registry.snapshot();
            let observed = snapshots.get(original);

            if (observed === undefined) {
                observed = Object.freeze({
                    installed: () => Object.freeze(original.installed().map(observeExtension)),
                    extension: (name: string) => {
                        const extension = original.extension(name);

                        return extension === undefined ? undefined : observeExtension(extension);
                    },
                    tools: () =>
                        Object.freeze(
                            original.tools().map(({ extension, tool }) => ({
                                extension: observeExtension(extension),
                                tool,
                            })),
                        ),
                    sections: () =>
                        Object.freeze(
                            original.sections().map(({ extension, section }) => ({
                                extension: observeExtension(extension),
                                section,
                            })),
                        ),
                    tasks: () => Object.freeze(original.tasks().map(observeTask)),
                    task: (name: string) => {
                        const task = original.task(name);

                        return task === undefined ? undefined : observeTask(task);
                    },
                });
                snapshots.set(original, observed);
            }

            return observed;
        },
    };
}

const ENV_METHODS = new Set<keyof ExecutionEnv>([
    "absolutePath",
    "joinPath",
    "readTextFile",
    "openTextLineReader",
    "readTextLines",
    "readBinaryFile",
    "openBinaryReader",
    "writeFile",
    "appendFile",
    "truncateFile",
    "flushFile",
    "renameFile",
    "fileInfo",
    "listDir",
    "openDirReader",
    "watch",
    "canonicalPath",
    "exists",
    "createDir",
    "remove",
    "createTempDir",
    "createTempFile",
    "cleanup",
    "exec",
]);

function environmentVerdict(result: unknown): DiagnosticVerdict {
    if (result === undefined) {
        return OK;
    }

    const value = result as Result<unknown, { code?: string }>;

    if (value.ok === false) {
        return diagnosticError(value.error, value.error.code === "aborted");
    }

    return OK;
}

/** Each construction attempt stays separate from execution; undefined environments remain undefined. */
export async function observeEnvironment(
    recorder: DiagnosticRecorder,
    conversationId: number,
    build: () => ExecutionEnv | undefined | Promise<ExecutionEnv | undefined>,
    destination?: "local" | "ssh",
): Promise<ExecutionEnv | undefined> {
    const taskId = recorder.current()?.taskId;
    const env = await recorder.observe(
        {
            conversationId,
            taskId,
            destination,
            component: "environment",
            stage: "construct",
            operation: "environment",
        },
        async () => build(),
    );

    if (env === undefined) {
        return undefined;
    }

    const methods = new Map<PropertyKey, unknown>();

    return new Proxy(env, {
        get(target, key) {
            const value: unknown = Reflect.get(target, key, target);

            if (typeof value !== "function") {
                return value;
            }

            if (!methods.has(key)) {
                const method = (...args: unknown[]) => Reflect.apply(value, target, args);

                methods.set(
                    key,
                    ENV_METHODS.has(key as keyof ExecutionEnv)
                        ? (...args: unknown[]) => {
                              const meta: DiagnosticMeta = {
                                  conversationId,
                                  taskId: recorder.current()?.taskId,
                                  destination,
                                  component: "environment",
                                  stage: "execute",
                                  operation: String(key),
                              };
                              const context = args.at(-1) as Context | undefined;

                              return recorder.observe(
                                  meta,
                                  () => method(...args),
                                  (result: unknown) => {
                                      const ending = environmentVerdict(result);

                                      if (
                                          key === "exec" &&
                                          (result as Result<ShellExecResult, unknown>).ok
                                      ) {
                                          return (result as { value: ShellExecResult }).value
                                              .exitCode === 0
                                              ? OK
                                              : { outcome: "domain", cause: "nonzero_exit" };
                                      }

                                      return ending;
                                  },
                                  () => context?.abortSignal?.aborted ?? false,
                              );
                          }
                        : method,
                );
            }

            return methods.get(key);
        },
    });
}
