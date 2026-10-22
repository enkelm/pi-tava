import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "@earendil-works/chord/context";
import { createModels, Type } from "@earendil-works/pi-ai";
import {
    fauxAssistantMessage,
    fauxProvider,
    fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
    AssistantEntry,
    createRegistry,
    defineExtension,
    defineTask,
    defineTool,
    Harness,
    hook,
    MemoryStorage,
    type Registry,
    type StorageWrite,
    type ToolHooks,
    type ToolRegistration,
    ToolTask,
    wrapTool,
} from "@earendil-works/pi-durable";
import { ExecutionError, type ExecutionEnv, FileError } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { DiagnosticRecorder, type DiagnosticRecord } from "../src/server/diagnostics/recorder.ts";
import {
    committedDiagnostics,
    observeEnvironment,
    observeRegistry,
} from "../src/server/diagnostics/runtime.ts";
import createCodemode from "../src/server/extensions/codemode.ts";
import type { PocketHost } from "../src/server/host.ts";

const SECRET = "SECRET-prompt-command-result-path";
const parameters = Type.Object({ value: Type.String() });
const tool = (execute: ToolRegistration["execute"], replay: "safe" | "unsafe" = "safe") =>
    defineTool({ name: "probe", description: "Probe", parameters, replay, execute });

function journal(sinkThrows = false) {
    const events: DiagnosticRecord[] = [];
    const recorder = new DiagnosticRecorder((record) => {
        events.push({ ...record });

        if (sinkThrows) {
            throw new Error(SECRET);
        }
    });

    return { recorder, events, ended: () => events.filter((event) => event.endedAt !== undefined) };
}

async function open(
    registry: Registry,
    recorder: DiagnosticRecorder,
    env?: () => ExecutionEnv | undefined,
    storage = new MemoryStorage(),
    models = createModels(),
) {
    const harness = await Harness.open(
        storage,
        {
            models,
            onReport: () => {},
            registry: observeRegistry(registry, recorder),
            env: ({ conversationId }) =>
                observeEnvironment(recorder, conversationId, () => env?.()),
        },
        context,
    );

    harness.subscribeCommits((publication) => committedDiagnostics(publication, recorder));
    const conversation = await harness.root(context);

    return { harness, conversation };
}

async function invoke(
    suite: Awaited<ReturnType<typeof open>>,
    name = "probe",
    args: Record<string, JsonValue> = { value: SECRET },
    callId = "provider-call-id",
) {
    const id = await suite.conversation.commit(async (tx) => {
        const assistant = await tx.appendEntry(AssistantEntry, suite.conversation.id, {
            model: [
                fauxAssistantMessage([fauxToolCall(name, args, { id: callId })], {
                    stopReason: "toolUse",
                }),
            ],
        });

        return tx.createTask(
            ToolTask,
            { assistant: assistant.id, callId },
            { ownership: { kind: "conversation" } },
        );
    }, context);

    return id;
}

async function finish(
    suite: Awaited<ReturnType<typeof open>>,
    id: Awaited<ReturnType<typeof invoke>>,
) {
    const settled = await suite.harness.waitForTask(id, context);
    const entries = await suite.conversation.entries(
        { order: "ascending" },
        100,
        undefined,
        context,
    );

    await suite.harness.close(context);

    return { settled, entries: entries.items };
}

test("real tool tasks distinguish pre-env, execution, validation and hook failures without executing blocked calls", async (t) => {
    for (const mode of [
        "construct",
        "execute",
        "validation",
        "block",
        "hook",
        "after_hook",
        "unavailable",
        "domain",
        "after_domain",
        "diagnostic",
        "ok",
    ] as const) {
        await t.test(mode, async () => {
            const log = journal();
            const registry = createRegistry();
            const fault = new Error(SECRET);
            let calls = 0;
            let constructions = 0;
            const hooks: Partial<ToolHooks> = {
                beforeTool() {
                    if (mode === "block") {
                        return { block: SECRET };
                    }

                    if (mode === "hook") {
                        throw fault;
                    }
                },
                afterTool(_call, result) {
                    if (mode === "after_hook") {
                        throw fault;
                    }

                    return mode === "after_domain" ? { ...result, isError: true } : result;
                },
            };

            registry.install(
                defineExtension({
                    name: "fixture",
                    tools: [
                        tool(async () => {
                            calls++;

                            if (mode === "execute") {
                                throw fault;
                            }

                            return {
                                content: [{ type: "text", text: SECRET }],
                                isError: mode === "domain" || mode === "diagnostic",
                                diagnostics:
                                    mode === "diagnostic"
                                        ? [
                                              ...Array.from({ length: 16 }, () => ({
                                                  severity: "error" as const,
                                                  code: "arbitrary_tool_error",
                                                  message: SECRET,
                                              })),
                                              // A plugin's oversized tail is not inspected by the receipt listener.
                                              {
                                                  severity: "error" as const,
                                                  code: "blocked",
                                                  message: SECRET,
                                              },
                                          ]
                                        : [],
                            };
                        }),
                    ],
                    hooks: [hook(ToolTask, hooks)],
                }),
            );
            const suite = await open(registry, log.recorder, () => {
                constructions++;

                if (mode === "construct") {
                    throw fault;
                }

                return undefined;
            });
            // A direct provider call may contain '/', which must not be mistaken for codemode nesting.
            const id = await invoke(
                suite,
                mode === "unavailable" ? "absent" : "probe",
                mode === "validation" ? {} : { value: SECRET },
                "provider/call",
            );
            const { entries, settled } = await finish(suite, id);
            const ended = log.ended();
            const phase = ended.find(
                (event) =>
                    event.component === "runtime" && event.stage === "phase" && event.taskId === id,
            )!;
            const execute = ended.filter(
                (event) => event.component === "tool" && event.stage === "execute",
            );
            const construct = ended.filter((event) => event.stage === "construct");
            const receipt = ended.find(
                (event) => event.component === "tool" && event.stage === "receipt",
            )!;
            const reachedExecution = [
                "execute",
                "domain",
                "diagnostic",
                "after_hook",
                "after_domain",
                "ok",
            ].includes(mode);
            const reachedEnvironment = reachedExecution || mode === "construct";

            assert.equal(calls, reachedExecution ? 1 : 0);
            assert.equal(constructions, reachedEnvironment ? 1 : 0);
            assert.equal(execute.length, calls);
            assert.equal(
                ended.some((event) => event.nested),
                false,
            );
            assert.equal(construct.length, constructions);
            assert.equal(
                settled.state.outcome.status,
                ["execute", "construct"].includes(mode) ? "failed" : "completed",
            );
            assert.equal(
                receipt.cause,
                (
                    {
                        construct: "unknown",
                        execute: "unknown",
                        validation: "invalid_arguments",
                        block: "blocked",
                        hook: "blocked",
                        after_hook: "none",
                        unavailable: "tool_unavailable",
                        domain: "result_error",
                        after_domain: "result_error",
                        diagnostic: "result_error",
                        ok: "none",
                    } as const
                )[mode],
            );

            if (mode === "construct") {
                assert.equal(construct[0]!.outcome, "failure");
            }

            if (mode === "execute") {
                assert.equal(construct[0]!.outcome, "ok");
                assert.equal(execute[0]!.outcome, "failure");
            }

            if (mode === "hook") {
                assert.equal(
                    ended.find((event) => event.stage === "beforeTool")!.cause,
                    "hook_error",
                );
            }

            if (mode === "domain" || mode === "diagnostic") {
                assert.equal(execute[0]!.outcome, "domain");
            }

            if (mode === "after_hook") {
                assert.equal(
                    ended.find((event) => event.stage === "afterTool")!.cause,
                    "hook_error",
                );
                assert.equal(receipt.outcome, "ok");
            }

            if (mode === "after_domain") {
                assert.equal(execute[0]!.outcome, "ok");
                assert.equal(ended.find((event) => event.stage === "afterTool")!.outcome, "domain");
            }

            assert.equal(JSON.stringify(log.events).includes(SECRET), false);
            assert.equal(entries.filter((entry) => entry.kind === "pi.tool-result").length, 1);
            assert.equal(
                ended.every(
                    (event) =>
                        event.conversationId === suite.conversation.id && event.taskId === id,
                ),
                true,
            );
            assert.equal(phase.outcome, "ok");
            assert.equal(phase.operation, "pi.tool/0");
            assert.equal(receipt.operation, mode === "unavailable" ? "unavailable" : "probe");
            assert.equal(
                receipt.entryId,
                entries.find((entry) => entry.kind === "pi.tool-result")!.id,
            );
            assert.equal(
                ended
                    .filter((event) => event.id !== phase.id && event.stage !== "receipt")
                    .every((event) => event.parentId === phase.id),
                true,
            );
        });
    }
});

test("distinct extensions keep distinct logical hook identities for the same tool call", async () => {
    const log = journal();
    const registry = createRegistry();
    let hooks = 0;

    registry.install({ name: "probe", tools: [tool(async () => ({}))] });

    for (const name of ["first-hooks", "second-hooks"]) {
        registry.install({
            name,
            hooks: [
                hook(ToolTask, {
                    beforeTool() {
                        hooks++;
                    },
                }),
            ],
        });
    }

    const suite = await open(registry, log.recorder);
    const id = await invoke(suite);
    const { settled } = await finish(suite, id);
    const observations = log.ended().filter((record) => record.stage === "beforeTool");

    assert.equal(settled.state.outcome.status, "completed");
    assert.equal(hooks, 2);
    assert.equal(observations.length, 2);
    assert.equal(
        observations.every((record) => record.operationId !== undefined),
        true,
    );
    assert.equal(
        new Set(observations.map((record) => record.operationId)).size,
        2,
        "distinct hooks must not be mistaken for replay attempts of one logical hook",
    );
});

test("resolved extension wraps and nested codemode caught failures retain hooks and parent/task context", async () => {
    const log = journal();
    const registry = createRegistry();
    let calls = 0;
    let wraps = 0;
    let before = 0;
    let after = 0;
    const probe = tool(async () => {
        calls++;

        return { isError: true, content: [{ type: "text", text: SECRET }] };
    });

    registry.install({
        name: "probe",
        tools: [probe],
        wraps: [
            wrapTool(probe, (original) => ({
                ...original,
                execute: async (...args) => {
                    wraps++;

                    return original.execute(...args);
                },
            })),
        ],
        hooks: [
            hook(ToolTask, {
                beforeTool() {
                    before++;
                },
                afterTool(_call, result) {
                    after++;

                    return result;
                },
            }),
        ],
    });
    // This extension's factory does not use the host. Its actual sandbox, dispatcher and hooks run unchanged.
    registry.install(createCodemode({} as PocketHost));
    const suite = await open(registry, log.recorder);
    const id = await invoke(suite, "codemode", {
        code: `try { await tools.probe({ value: '${SECRET}' }); } catch { text('caught'); }`,
    });
    const { entries } = await finish(suite, id);
    const executions = log
        .ended()
        .filter((record) => record.component === "tool" && record.stage === "execute");
    const outer = executions.find((record) => !record.nested)!;
    const nested = executions.find((record) => record.nested)!;

    assert.equal(calls, 1);
    assert.equal(wraps, 1);
    assert.equal(before, 2);
    assert.equal(after, 2);
    assert.equal(executions.length, 2);
    assert.equal(outer.outcome, "ok");
    assert.equal(outer.operation, "codemode");
    assert.equal(nested.outcome, "domain");
    assert.equal(nested.operation, "probe");
    assert.equal(nested.cause, "result_error");
    assert.equal(nested.parentId, outer.id);
    assert.equal(nested.taskId, id);
    assert.notEqual(nested.operationId, outer.operationId);
    assert.equal(
        log
            .ended()
            .filter((record) => record.nested && record.stage !== "execute")
            .every((record) => record.parentId === outer.id),
        true,
    );
    assert.equal(
        log.ended().some((record) => record.nested && record.stage === "beforeTool"),
        true,
    );
    assert.equal(
        log.ended().some((record) => record.nested && record.stage === "afterTool"),
        true,
    );
    const result = entries.find((entry) => entry.kind === "pi.tool-result")!.model![0]!;

    assert.equal(result.role, "toolResult");
    assert.equal(result.role === "toolResult" && result.isError, false);
    assert.equal(JSON.stringify(log.events).includes(SECRET), false);
});

test("immutable old snapshots stay old, live replacements wake blocked tasks, and observer faults never duplicate effects", async () => {
    const log = journal(true);
    const registry = createRegistry();
    const reader = observeRegistry(registry, log.recorder);
    let effects = 0;
    const probe = Object.freeze(
        tool(async () => {
            effects++;

            return { content: [] };
        }),
    );
    const task = defineTask({
        name: "test.replace",
        version: 1,
        initial: () => ({ phase: "run" as const }),
        phases: {
            run: async (_task, runtime, scope) => {
                await runtime.commit(
                    () => ({ status: "terminal", outcome: { status: "completed", result: 41 } }),
                    scope,
                );
            },
        },
        abort: async (_task, runtime, scope) => {
            await runtime.commit(
                () => ({ status: "terminal", outcome: { status: "aborted" } }),
                scope,
            );
        },
    });
    const original = Object.freeze({
        name: "fixture",
        tools: Object.freeze([probe]),
        tasks: Object.freeze([task]),
    });

    registry.install(original);
    const old = reader.snapshot();
    const oldTask = old.task(task.definition.name)!;
    const suite = await open(registry, log.recorder);
    const first = await invoke(suite);

    await suite.harness.waitForTask(first, context);
    registry.uninstall(original);
    const pending = await suite.conversation.commit(
        (tx) => tx.createTask(task, {}, { ownership: { kind: "conversation" } }),
        context,
    );
    let phaseReceiver: unknown;
    const replacement = defineTask({
        ...task.definition,
        version: 2,
        migrate: (_input, checkpoint) => ({
            input: {},
            checkpoint: checkpoint as { phase: "run" },
        }),
        phases: {
            run: async function (this: unknown, _task, runtime, scope) {
                phaseReceiver = this;
                await runtime.commit(
                    () => ({ status: "terminal", outcome: { status: "completed", result: 42 } }),
                    scope,
                );
            },
        },
    });

    registry.install({ name: "fixture", tools: [probe], tasks: [replacement] });
    const settled = await suite.harness.waitForTask(pending, context);
    const second = await invoke(suite);

    await finish(suite, second);
    assert.equal(effects, 2);
    assert.equal(log.recorder.dropped, log.events.length);
    assert.deepEqual(settled.state.outcome, { status: "completed", result: 42 });
    assert.equal(settled.version, 2);
    assert.equal(phaseReceiver, replacement.definition.phases);
    assert.equal(old.task(task.definition.name), oldTask);
    assert.equal(oldTask.definition.version, 1);
    assert.equal(reader.snapshot().task(task.definition.name)!.definition.version, 2);
    assert.equal(registry.snapshot().extension("fixture")!.tasks![0], replacement);
});

/** Replay an actual committed memory-storage journal into a new storage owner after Harness.close(). */
class RestartableStorage extends MemoryStorage {
    readonly writes: StorageWrite[][] = [];

    override async commit(writes: readonly StorageWrite[], scope: Context) {
        const seq = await super.commit(writes, scope);

        this.writes.push(structuredClone([...writes]));

        return seq;
    }
}

test("safe recovery keeps the logical tool operation but creates a new observation; unsafe recovery does not execute", async (t) => {
    for (const replay of ["safe", "unsafe"] as const) {
        await t.test(replay, async () => {
            const log = journal();
            const registry = createRegistry();
            const storage = new RestartableStorage();
            const started = Promise.withResolvers<void>();
            let executions = 0;

            registry.install({
                name: "fixture",
                tools: [
                    tool(async (_args, _api, scope) => {
                        executions++;

                        if (executions === 1) {
                            started.resolve();
                            await new Promise<void>((_resolve, reject) => {
                                scope.abortSignal!.addEventListener(
                                    "abort",
                                    () => reject(scope.abortSignal!.reason),
                                    { once: true },
                                );
                            });
                        }

                        return { content: [] };
                    }, replay),
                ],
            });
            const first = await open(registry, log.recorder, undefined, storage);
            const id = await invoke(first);

            first.harness.resume();
            await Promise.race([
                started.promise,
                first.harness
                    .waitForTask(id, context)
                    .then((receipt) => assert.fail(JSON.stringify(receipt))),
            ]);
            await first.harness.close(context);
            const recoveredStorage = new MemoryStorage();

            for (const writes of storage.writes) {
                await recoveredStorage.commit(writes, context);
            }

            const recovered = await open(registry, log.recorder, undefined, recoveredStorage);
            const settled = await recovered.harness.waitForTask(id, context);

            await recovered.harness.close(context);
            assert.equal(executions, replay === "safe" ? 2 : 1);
            const spans = log
                .ended()
                .filter((record) => record.component === "tool" && record.stage === "execute");

            assert.equal(spans.length, executions);
            assert.equal(spans[0]!.outcome, "cancelled");

            if (replay === "safe") {
                assert.equal(spans[1]!.operationId, spans[0]!.operationId);
                assert.notEqual(spans[1]!.id, spans[0]!.id);
                assert.equal(spans[1]!.outcome, "ok");
                assert.equal(settled.state.outcome.status, "completed");
            } else {
                assert.equal(settled.state.outcome.status, "failed");
                assert.equal(
                    log
                        .ended()
                        .some((record) => record.taskId === id && record.cause === "interrupted"),
                    true,
                );
            }
        });
    }
});

test("environment adapters preserve Result errors, nonzero exits, guarded dispatch and cancellation without payloads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-diagnostics-"));
    const log = journal(true);
    const file = join(directory, SECRET);
    const denied = new FileError("permission_denied", SECRET, file);
    const unavailable = new ExecutionError("shell_unavailable", SECRET);
    let dispatches = 0;

    class GuardedEnvironment extends NodeExecutionEnv {
        override async writeFile() {
            return { ok: false as const, error: denied };
        }
        override async exec(
            command: string | readonly string[],
            options: Parameters<ExecutionEnv["exec"]>[1],
            scope: Context,
        ) {
            if (command === "blocked") {
                return { ok: false as const, error: unavailable };
            }

            dispatches++;

            return super.exec(command, options, scope);
        }
    }
    const original = new GuardedEnvironment({ cwd: directory });

    await writeFile(file, SECRET);

    try {
        const env = (await observeEnvironment(log.recorder, 123, () => original, "local"))!;
        const read = await env.readTextFile(file, context);
        const missing = await env.readTextFile(join(directory, "missing"), context);
        const deniedResult = await env.writeFile(file, "replacement", context);
        const blocked = await env.exec("blocked", undefined, context);
        const nonzero = await env.exec(
            [process.execPath, "-e", "process.exit(7)"],
            undefined,
            context,
        );

        assert.deepEqual(read, { ok: true, value: SECRET });
        assert.equal(missing.ok, false);
        assert.equal(deniedResult.ok === false && deniedResult.error, denied);
        assert.equal(blocked.ok === false && blocked.error, unavailable);
        assert.deepEqual(nonzero, { ok: true, value: { exitCode: 7 } });
        assert.equal(dispatches, 1);
        assert.equal(
            log.ended().some((record) => record.cause === "not_found"),
            true,
        );
        assert.equal(
            log
                .ended()
                .some(
                    (record) =>
                        record.cause === "permission_denied" && record.outcome === "restricted",
                ),
            true,
        );
        assert.equal(
            log
                .ended()
                .some(
                    (record) =>
                        record.cause === "shell_unavailable" && record.outcome === "unknown",
                ),
            true,
        );
        assert.equal(
            log
                .ended()
                .some((record) => record.cause === "nonzero_exit" && record.outcome === "domain"),
            true,
        );
        assert.equal(
            log.ended().every((record) => record.destination === "local"),
            true,
        );
        const cancelled = await env.exec(
            [process.execPath, "-e", "process.exit(0)"],
            undefined,
            withAbortSignal(AbortSignal.abort(), context),
        );

        assert.equal(cancelled.ok === false && cancelled.error.code, "aborted");
        assert.equal(log.ended().at(-1)!.outcome, "cancelled");
        const sshLabel = (await observeEnvironment(log.recorder, 123, () => original, "ssh"))!;

        await sshLabel.exec("blocked", undefined, context);
        assert.equal(log.ended().at(-1)!.destination, "ssh");
        assert.equal(log.ended().at(-2)!.destination, "ssh");
        assert.equal(JSON.stringify(log.events).includes(SECRET), false);
        env.cwd = directory;
        assert.equal(original.cwd, directory);
        const fault = new Error(SECRET);
        let builds = 0;

        await assert.rejects(
            observeEnvironment(log.recorder, 123, () => {
                builds++;

                throw fault;
            }),
            (error) => error === fault,
        );
        assert.equal(builds, 1);
        assert.equal(log.recorder.dropped, log.events.length);
    } finally {
        await original.cleanup(context);
        await rm(directory, { recursive: true, force: true });
    }
});

test("environment failures keep the enclosing tool and task context when the tool handles the Result", async () => {
    const log = journal();
    const registry = createRegistry();
    const failure = new ExecutionError("shell_unavailable", SECRET);

    class RestrictedEnvironment extends NodeExecutionEnv {
        override async exec() {
            return { ok: false as const, error: failure };
        }
    }
    const original = new RestrictedEnvironment({ cwd: tmpdir() });

    registry.install({
        name: "fixture",
        tools: [
            tool(async (_args, api, scope) => {
                const result = await api.env!.exec(SECRET, undefined, scope);

                assert.equal(result.ok === false && result.error, failure);

                return { content: [] };
            }),
        ],
    });
    const suite = await open(registry, log.recorder, () => original);
    const id = await invoke(suite);

    await finish(suite, id);
    const execute = log
        .ended()
        .find((record) => record.component === "tool" && record.stage === "execute")!;
    const environment = log
        .ended()
        .find((record) => record.component === "environment" && record.stage === "execute")!;

    assert.equal(execute.outcome, "ok");
    assert.equal(environment.outcome, "unknown");
    assert.equal(environment.cause, "shell_unavailable");
    assert.equal(environment.parentId, execute.id);
    assert.equal(environment.taskId, id);
    assert.equal(environment.conversationId, suite.conversation.id);
    assert.equal(JSON.stringify(log.events).includes(SECRET), false);
});

test("generation-only unavailable-tool receipts and answered input settle without an execute span", async () => {
    const log = journal();
    const registry = createRegistry();
    const models = createModels();
    const faux = fauxProvider();

    models.setProvider(faux.provider);
    const untrustedName = "/private/do-not-retain/tool";

    faux.setResponses([
        fauxAssistantMessage([fauxToolCall(untrustedName, { secret: SECRET })], {
            stopReason: "toolUse",
        }),
        fauxAssistantMessage("done"),
    ]);
    const suite = await open(registry, log.recorder, undefined, new MemoryStorage(), models);

    await suite.conversation.configure({ model: { provider: "faux", modelId: "faux-1" } }, context);
    const submission = await suite.conversation.submit({ type: "input", content: SECRET }, context);
    const settled = await submission.wait(context);
    const entries = (
        await suite.conversation.entries({ order: "ascending" }, 100, undefined, context)
    ).items;
    const entry = entries.find((entry) => entry.kind === "pi.tool-result")!;
    const owner = await suite.harness.getTask(entry.byTaskId!, context);
    const imported = await suite.conversation.commit(
        (tx) =>
            tx.appendEntry(suite.conversation.id, {
                kind: entry.kind,
                model: entry.model,
                data: entry.data,
            }),
        context,
    );

    await suite.harness.close(context);
    const receipt = log
        .ended()
        .find((record) => record.component === "tool" && record.stage === "receipt")!;

    assert.equal(settled.status, "done");
    assert.equal(owner!.kind, "pi.generation");
    assert.equal(receipt.entryId, entry.id);
    assert.equal(imported.byTaskId, undefined);
    assert.equal(
        log.ended().some((record) => record.entryId === imported.id),
        false,
    );
    assert.equal(receipt.taskId, entry.byTaskId);
    assert.equal(receipt.operation, "unavailable");
    assert.equal(
        JSON.stringify(log.events).includes(untrustedName),
        false,
        "unknown model-emitted names are not registered metadata",
    );
    assert.equal(receipt.outcome, "restricted");
    assert.equal(receipt.cause, "tool_unavailable");
    assert.equal(
        log.ended().some((record) => record.component === "tool" && record.stage === "execute"),
        false,
    );
    assert.equal(
        log
            .ended()
            .some(
                (record) =>
                    record.operationId === `input/${submission.id}` &&
                    record.operation === "input" &&
                    record.receiptStatus === "done" &&
                    record.outcome === "ok",
            ),
        true,
    );
    assert.equal(JSON.stringify(log.events).includes(SECRET), false);
});

test("committed task faults and unanswered inputs are visible even when phase returns normally or never runs", async (t) => {
    for (const mode of ["failed", "faulted", "aborted", "orphaned", "no_model"] as const) {
        await t.test(mode, async () => {
            const log = journal();
            const registry = createRegistry();
            const task = defineTask({
                name: "test.receipt",
                version: 1,
                initial: () => ({ phase: "run" as const }),
                phases: {
                    run: async (_record, runtime, scope) => {
                        if (mode === "faulted") {
                            throw new Error(SECRET);
                        }

                        await runtime.commit(
                            () => ({
                                status: "terminal",
                                outcome: {
                                    status: "failed",
                                    error: { message: SECRET, detail: SECRET },
                                },
                            }),
                            scope,
                        );
                    },
                },
                abort: async (_record, runtime, scope) => {
                    await runtime.commit(
                        () => ({
                            status: "terminal",
                            outcome: { status: "aborted", reason: SECRET },
                        }),
                        scope,
                    );
                },
            });

            if (mode !== "orphaned") {
                registry.install({ name: "fixture", tasks: [task] });
            }

            const suite = await open(registry, log.recorder);

            if (mode === "no_model") {
                const submission = await suite.conversation.submit(
                    { type: "input", content: SECRET },
                    context,
                );
                const settled = await submission.wait(context);

                await suite.harness.close(context);
                assert.equal(settled.status, "unanswered");
                const receipt = log
                    .ended()
                    .find((record) => record.operationId === `input/${submission.id}`)!;

                assert.equal(receipt.stage, "receipt");
                assert.equal(receipt.operation, "input");
                assert.equal(receipt.receiptStatus, "unanswered");
                assert.equal(receipt.receiptReason, "no_model");
                assert.equal(receipt.outcome, "restricted");
            } else {
                const id = await suite.conversation.commit(
                    (tx) => tx.createTask(task, {}, { ownership: { kind: "conversation" } }),
                    context,
                );

                if (mode === "aborted" || mode === "orphaned") {
                    await suite.harness.abortTask(id, context);
                }

                const settled = await suite.harness.waitForTask(id, context);

                await suite.harness.close(context);
                const receipt = log
                    .ended()
                    .find((record) => record.operationId === `task/${id}/terminal`)!;
                const phase = log.ended().find((record) => record.stage === "phase");

                assert.equal(settled.state.outcome.status, mode);
                assert.equal(receipt.stage, "receipt");
                assert.equal(receipt.taskId, id);
                assert.equal(receipt.operation, "test.receipt");
                assert.equal(receipt.receiptStatus, mode);
                assert.equal(
                    receipt.receiptReason,
                    mode === "orphaned" ? "missing_task" : undefined,
                );
                assert.equal(
                    receipt.outcome,
                    mode === "failed" ? "unknown" : mode === "aborted" ? "cancelled" : "failure",
                );
                assert.equal(mode === "orphaned" ? phase === undefined : phase !== undefined, true);

                if (mode === "failed") {
                    assert.equal(phase!.outcome, "ok");
                }
            }

            assert.equal(JSON.stringify(log.events).includes(SECRET), false);
        });
    }
});
