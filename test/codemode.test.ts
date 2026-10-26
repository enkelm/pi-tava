// Codemode crosses the real Harness tool boundary: nested tasks own hooks, progress and cleanup.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
    AssistantEntry,
    createRegistry,
    defineExtension,
    defineTool,
    Harness,
    hook,
    LiveDoc,
    MemoryStorage,
    NestedCallDoc,
    ToolTask,
    wrapTool,
    type Extension,
    type HarnessOptions,
    type JsonObject,
    type Storage,
    type StorageWrite,
    type TaskId,
    type ToolRegistration,
    type ToolTaskInput,
    type ToolTaskResult,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createBashTool } from "@earendil-works/pi-durable/tools";
import { CodemodeStoreDoc, PlanDoc } from "../src/server/docs.ts";
import createCodemode from "../src/server/extensions/codemode.ts";
import createGuard from "../src/server/extensions/guard.ts";
import createPlan from "../src/server/extensions/plan.ts";
import { Approvals, type PocketHost } from "../src/server/host.ts";

// These extensions do not use their host. Guard tests below supply its actual required services.
const host = {} as PocketHost;
const echo = defineTool({
    name: "echo",
    description: "Echo text",
    parameters: Type.Object({ text: Type.String() }),
    execute: async (args) => ({ output: [{ type: "text", text: `echo:${args.text}` }] }),
});

async function open(
    t: TestContext,
    tools: ToolRegistration[] = [],
    extensions: Extension[] = [],
    env?: HarnessOptions["env"],
    storage: Storage = new MemoryStorage(),
) {
    const registry = createRegistry();

    registry.install(createCodemode(host));
    registry.install(defineExtension({ name: "fixture", tools }));

    for (const extension of extensions) {
        registry.install(extension);
    }

    const reports: unknown[] = [];
    const harness = await Harness.open(
        storage,
        { models: createModels(), registry, env, onReport: (error) => reports.push(error) },
        context,
    );

    t.after(async () => {
        await harness.close(context);
        assert.deepEqual(reports, [], "the native scheduler must not fault");
    });
    const conversation = await harness.root(context, {
        init: async (tx, conversationId) => {
            await tx.doc(CodemodeStoreDoc, conversationId);
            await tx.doc(PlanDoc, conversationId);
        },
    });
    let sequence = 0;

    // Use the public ToolTask model input and a real provider-shaped assistant entry, not execute().
    const start = (code: string, name = "codemode", args: JsonObject = { code }) =>
        conversation.commit(async (tx) => {
            const callId = `model-call-${++sequence}`;
            const assistant = await tx.appendEntry(AssistantEntry, conversation.id, {
                model: [
                    fauxAssistantMessage([fauxToolCall(name, args, { id: callId })], {
                        stopReason: "toolUse",
                    }),
                ],
            });

            return tx.createTask(
                ToolTask,
                { kind: "model", assistant: assistant.id, callId },
                { ownership: { kind: "conversation" } },
            );
        }, context);

    const finish = async (id: TaskId<ToolTaskResult>) => {
        const task = await harness.waitForTask(id, context);
        const result = task.state.outcome.result;

        assert.ok(
            result && result.kind === "model",
            "a model call settles with a transcript entry",
        );
        const entry = await conversation.commit((tx) => tx.entry(result.entryId), context);
        const message = entry?.model?.[0];

        assert.equal(message?.role, "toolResult");
        assert.ok(message?.role === "toolResult");

        return {
            task,
            message,
            text: message.content
                .flatMap((part) => (part.type === "text" ? [part.text] : []))
                .join(""),
        };
    };

    return {
        harness,
        conversation,
        start,
        finish,
        run: async (code: string) => finish(await start(code)),
    };
}

async function until(check: () => boolean | Promise<boolean>, description: string) {
    for (let attempt = 0; attempt < 300; attempt++) {
        if (await check()) {
            return;
        }

        await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.fail(`Timed out waiting for ${description}`);
}

function output(text: string): unknown {
    const marker = "Output:\n";
    const at = text.indexOf(marker);

    assert.notEqual(at, -1, text);

    return JSON.parse(text.slice(at + marker.length));
}

test(
    "codemode creates native nested tasks with owned live slots and no nested transcript entries",
    { timeout: 15_000 },
    async (t) => {
        const started = Promise.withResolvers<TaskId>();
        const release = Promise.withResolvers<void>();

        t.after(() => release.resolve());
        const probe = defineTool({
            name: "probe",
            description: "Hold a real nested call open",
            parameters: Type.Object({ value: Type.String() }),
            replay: "safe",
            execute: async (args, api, scope) => {
                api.output("working");
                await api.details({ value: args.value }, scope);
                started.resolve(api.taskId);
                await release.promise;

                return { output: [{ type: "text", text: `done:${args.value}` }] };
            },
        });
        const suite = await open(t, [probe]);
        const parentId = await suite.start(`return await tools.probe({ value: "nested" });`);
        const waiting = suite.finish(parentId);

        try {
            const childId = await started.promise;
            const parent = await suite.harness.getTask(parentId, context);
            const child = await suite.harness.getTask(childId, context);

            assert.ok(parent && child);
            assert.equal((parent.input as ToolTaskInput).kind, "model");
            assert.equal(child.kind, ToolTask.definition.name);
            assert.equal(child.owner, parentId);
            assert.equal(
                child.abandonOnRestart,
                true,
                "an unsafe script must not resume its children",
            );
            const input = child.input as ToolTaskInput;

            assert.equal(input.kind, "nested");
            assert.ok(input.kind === "nested");
            assert.equal(input.parent, parentId);
            assert.equal(input.call.id, `${input.parentCallId}/${input.key}`);
            assert.deepEqual(input.call.arguments, { value: "nested" });
            assert.deepEqual(parent.state.status === "running" && parent.state.checkpoint, {
                phase: "execute",
                arguments: { code: `return await tools.probe({ value: "nested" });` },
                replay: "unsafe",
            });
            const live = await suite.harness.snapshot(LiveDoc, suite.conversation.id, context);
            const slot = live?.nestedTools?.find((item) => item.taskId === childId);

            assert.ok(slot);
            assert.equal(slot.parentTaskId, parentId);
            assert.equal(slot.parentCallId, input.parentCallId);
            assert.equal(slot.status, "running");
            assert.equal(slot.output, "working");
            assert.deepEqual(slot.details, { value: "nested" });
        } finally {
            release.resolve();
            await waiting;
        }

        const result = await waiting;
        const entries = await suite.conversation.entries(
            { order: "ascending" },
            100,
            undefined,
            context,
        );
        const messages = entries.items.flatMap((entry) => entry.model ?? []);

        assert.match(result.text, /Output:\ndone:nested$/);
        assert.equal(messages.filter((message) => message.role === "toolResult").length, 1);
        assert.equal(
            (await suite.harness.snapshot(LiveDoc, suite.conversation.id, context))?.nestedTools,
            undefined,
            "the parent retires native nested slots on settlement",
        );
    },
);

test("scripts receive structured values or bounded schema-less text, not model prose or successful diagnostics", async (t) => {
    const query = defineTool({
        name: "query",
        description: "Structured data for programs, prose for the model",
        parameters: Type.Object({}),
        structuredOutputSchema: Type.Object({ answer: Type.Number() }),
        execute: async () => ({
            structuredOutput: { answer: 42 },
            output: [{ type: "text", text: "human summary" }],
            diagnostics: [{ severity: "warn", message: "not program data" }],
        }),
    });
    const shell = defineTool({
        name: "bash",
        description: "Stream bounded output",
        parameters: Type.Object({}),
        outputLimits: { retain: "tail", maxBytes: 16 },
        execute: async (_args, api) => {
            api.output("discard-me ".repeat(20));
            api.output(new TextEncoder().encode("ran ls ✓"));

            return {};
        },
    });
    const suite = await open(t, [echo, query, shell]);
    const result = await suite.run(
        `return [await tools.echo({text: "hi"}), await tools.query({}), await tools.bash({})];`,
    );
    const [plain, structured, streamed] = output(result.text) as [string, object, string];

    assert.equal(result.message.isError, false);
    assert.equal(plain, "echo:hi");
    assert.deepEqual(structured, { answer: 42 });
    assert.ok(
        Buffer.byteLength(streamed) <= 16,
        "native tool output limits apply before returning to scripts",
    );
    assert.match(streamed, /ran ls ✓$/);
    assert.doesNotMatch(result.text, /human summary|not program data/);
});

test("isError results reject script calls with diagnostics, including schema errors", async (t) => {
    const failure = defineTool({
        name: "failure",
        description: "A domain error",
        parameters: Type.Object({}),
        execute: async (_args, api) => {
            api.diagnostic({ severity: "error", message: "native reason" });

            return { isError: true, output: [{ type: "text", text: "partial failure" }] };
        },
    });
    const invalid = defineTool({
        name: "invalid",
        description: "Break its declared result contract",
        parameters: Type.Object({}),
        structuredOutputSchema: Type.Object({ answer: Type.Number() }),
        execute: async () => ({
            structuredOutput: { answer: "wrong" },
            output: [{ type: "text", text: "misleading success" }],
        }),
    });
    const suite = await open(t, [failure, invalid]);
    const result =
        await suite.run(`return await Promise.all(["failure", "invalid"].map(async name => {
        try { await tools[name]({}); return "unexpected success"; }
        catch (error) { return error.message; }
    }));`);
    const [failed, broken] = output(result.text) as string[];

    assert.match(failed!, /partial failure/);
    assert.match(failed!, /native reason/);
    assert.match(broken!, /structuredOutput.*schema/);
    assert.doesNotMatch(result.text, /unexpected success/);
});

test(
    "real Bash nonzero exit rejects the nested call while the catching script succeeds",
    { timeout: 15_000 },
    async (t) => {
        const held = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();

        t.after(() => release.resolve());
        const hold = defineTool({
            name: "hold",
            description: "Keep the caller live while its settled Bash result is inspected",
            parameters: Type.Object({}),
            execute: async () => {
                held.resolve();
                await release.promise;

                return {};
            },
        });
        const env = new NodeExecutionEnv({ cwd: process.cwd() });
        const suite = await open(t, [createBashTool(), hold], [], () => env);

        t.after(() => env.cleanup(context));
        const parentId = await suite.start(`let caught = "unexpected success";
        try { await tools.bash({command: "exit 7"}); } catch (error) { caught = error.message; }
        await tools.hold({}); return {caught};`);
        const waiting = suite.finish(parentId);

        try {
            await held.promise;
            const live = await suite.harness.snapshot(LiveDoc, suite.conversation.id, context);
            const slot = live?.nestedTools?.find((item) => item.name === "bash");

            assert.ok(slot, "Bash must execute as a real native child");
            const child = await suite.harness.getTask(slot.taskId, context);

            assert.ok(child);
            assert.equal(child.owner, parentId);
            assert.equal(child.state.status, "terminal");
            assert.equal(child.state.outcome?.status, "completed");
            assert.deepEqual(child.state.outcome?.result, { kind: "nested" });
            const input = child.input as ToolTaskInput;

            assert.ok(input.kind === "nested");
            const result = (
                await suite.harness.snapshot(NestedCallDoc, parentId, input.key, context)
            )?.result;

            assert.ok(result);
            assert.equal(result.taskId, child.id);
            assert.equal(result.isError, true);
            assert.deepEqual(result.structuredOutput, {
                output: "",
                truncated: false,
                exitCode: 7,
            });
            assert.ok(
                result.diagnostics.some(
                    (diagnostic) =>
                        diagnostic.severity === "error" &&
                        diagnostic.code === "exit_code" &&
                        diagnostic.message === "Command exited with code 7",
                ),
            );
        } finally {
            release.resolve();
            await waiting;
        }

        const parent = await waiting;

        assert.equal(parent.task.state.outcome.status, "completed");
        assert.equal(parent.message.toolName, "codemode");
        assert.equal(parent.message.isError, false);
        assert.match(
            (output(parent.text) as { caught: string }).caught,
            /Command exited with code 7/,
        );
    },
);

for (const ending of ["return", "timeout", "abort"] as const) {
    test(
        `parent ToolTask waits for native child cleanup after script ${ending}`,
        { timeout: 15_000 },
        async (t) => {
            const started = Promise.withResolvers<TaskId>();
            const cancelled = Promise.withResolvers<void>();
            const cleanup = Promise.withResolvers<void>();

            t.after(() => cleanup.resolve());
            const slow = defineTool({
                name: "slow",
                description: "Wait for cancellation, then hold cleanup",
                parameters: Type.Object({}),
                execute: async (_args, api, scope) => {
                    scope.abortSignal!.addEventListener("abort", () => cancelled.resolve(), {
                        once: true,
                    });
                    started.resolve(api.taskId);
                    await cancelled.promise;
                    await cleanup.promise;

                    return { output: [{ type: "text", text: "cleaned up" }] };
                },
            });
            const ready = defineTool({
                name: "ready",
                description: "Wait until the sibling really started",
                parameters: Type.Object({}),
                execute: async () => {
                    await started.promise;

                    return {};
                },
            });
            const suite = await open(t, [slow, ready]);
            const id = await suite.start(
                ending === "return"
                    ? `void tools.slow({}); await tools.ready({}); return "finished";`
                    : `${ending === "timeout" ? '// @options: {"timeout_ms": 2000}\n' : ""}await tools.slow({});`,
            );
            let settled = false;
            const waiting = suite.finish(id).then((result) => {
                settled = true;

                return result;
            });
            let aborting: Promise<unknown> | undefined;

            try {
                const childId = await started.promise;

                if (ending === "abort") {
                    aborting = suite.harness.abortTask(id, context);
                }

                await cancelled.promise;
                await new Promise((resolve) => setImmediate(resolve));
                assert.equal(
                    settled,
                    false,
                    "waitForTask must not settle while the native child is cleaning up",
                );
                assert.notEqual(
                    (await suite.harness.getTask(id, context))?.state.status,
                    "terminal",
                );
                assert.notEqual(
                    (await suite.harness.getTask(childId, context))?.state.status,
                    "terminal",
                );
                assert.ok(
                    (
                        await suite.harness.snapshot(LiveDoc, suite.conversation.id, context)
                    )?.nestedTools?.some(
                        (slot) => slot.taskId === childId && slot.parentTaskId === id,
                    ),
                    "the child's native live slot remains owned until cleanup finishes",
                );
            } finally {
                cleanup.resolve();
                await aborting;
                await waiting;
            }

            const result = await waiting;

            assert.equal(
                result.task.state.outcome.status,
                ending === "abort" ? "aborted" : "completed",
            );
            assert.match(
                result.text,
                ending === "return" ? /finished/ : ending === "timeout" ? /timed out/ : /aborted/,
            );
        },
    );
}

test(
    "journal cutoff recovery never reexecutes an unsafe codemode parent or its native child",
    { timeout: 15_000 },
    async (t) => {
        class JournalStorage extends MemoryStorage {
            readonly writes: StorageWrite[][] = [];

            override async commit(writes: readonly StorageWrite[], scope: Context) {
                const seq = await super.commit(writes, scope);

                this.writes.push(structuredClone([...writes]));

                return seq;
            }
        }

        const storage = new JournalStorage();
        const entered = Promise.withResolvers<TaskId>();
        let scripts = 0;
        let effects = 0;
        let cleaned = 0;
        let publications = 0;
        const effect = defineTool({
            name: "effect",
            description: "Enter a local unsafe operation and hold it until its invocation closes",
            replay: "unsafe",
            parameters: Type.Object({}),
            execute: async (_args, api, scope) => {
                effects++;

                if (effects === 1) {
                    entered.resolve(api.taskId);

                    try {
                        await new Promise<void>((_resolve, reject) => {
                            scope.abortSignal!.addEventListener(
                                "abort",
                                () => reject(scope.abortSignal!.reason),
                                { once: true },
                            );
                        });
                    } finally {
                        cleaned++;
                    }
                }

                return { output: [{ type: "text", text: "unsafe operation repeated" }] };
            },
        });
        const publish = defineTool({
            name: "publish",
            description: "Count a local effect the interrupted script must never reach",
            replay: "unsafe",
            parameters: Type.Object({}),
            execute: async () => {
                publications++;

                return {};
            },
        });
        const codemode = createCodemode(host).tools![0]!;
        const observer = defineExtension({
            name: "script-entry-counter",
            wraps: [
                wrapTool(codemode, (tool) => ({
                    ...tool,
                    execute: async (args, api, scope) => {
                        scripts++;

                        return tool.execute(args, api, scope);
                    },
                })),
            ],
        });
        const first = await open(t, [effect, publish], [observer], undefined, storage);
        const parentId = await first.start(`store("pending", true); await tools.effect({});
        store("finished", true); await tools.publish({}); return "completed";`);

        first.harness.resume();
        const childId = await entered.promise;
        const parentAtCutoff = await first.harness.getTask(parentId, context);
        const childAtCutoff = await first.harness.getTask(childId, context);
        // Capture only successful commits before close can write anything else. No records are constructed or altered.
        const prefix = structuredClone(storage.writes);

        assert.ok(parentAtCutoff && childAtCutoff);
        assert.equal(parentAtCutoff.state.status, "running");
        assert.equal(childAtCutoff.state.status, "running");
        assert.equal(childAtCutoff.owner, parentId);
        assert.equal((childAtCutoff.input as ToolTaskInput).kind, "nested");
        await first.harness.close(context);
        assert.equal(
            cleaned,
            1,
            "the original native child is joined before replay opens a new owner",
        );

        const restored = new MemoryStorage();

        for (const writes of prefix) {
            await restored.commit(writes, context);
        }

        const recovered = await open(t, [effect, publish], [observer], undefined, restored);
        const parent = await recovered.finish(parentId);
        const child = await recovered.harness.waitForTask(childId, context);

        await recovered.conversation.waitForIdle(context);
        assert.equal(scripts, 1, "the interrupted script must not execute again");
        assert.equal(effects, 1, "the unsafe native child must not execute again");
        assert.equal(publications, 0, "recovery must not advance to later script effects");
        assert.deepEqual(
            parentAtCutoff.state.status === "running" && parentAtCutoff.state.checkpoint,
            {
                phase: "execute",
                arguments: {
                    code: `store("pending", true); await tools.effect({});
        store("finished", true); await tools.publish({}); return "completed";`,
                },
                replay: "unsafe",
            },
        );
        assert.deepEqual(
            childAtCutoff.state.status === "running" && childAtCutoff.state.checkpoint,
            {
                phase: "execute",
                arguments: {},
                replay: "unsafe",
            },
        );
        assert.equal(childAtCutoff.abandonOnRestart, true);
        assert.equal(parent.task.state.outcome.status, "failed");
        assert.equal(parent.message.isError, true);
        assert.match(parent.text, /Tool codemode was interrupted/);
        assert.equal(child.state.outcome.status, "aborted");
        assert.deepEqual(child.state.outcome.result, { kind: "nested" });
        assert.equal(child.owner, parentId);
        assert.deepEqual(
            (await recovered.harness.snapshot(CodemodeStoreDoc, recovered.conversation.id, context))
                ?.values,
            {},
        );
        assert.equal((await recovered.harness.inspect(context)).tasks.length, 0);
        const tasks = await restored.scanTasks(
            { conversationId: recovered.conversation.id },
            100,
            undefined,
            context,
        );

        assert.deepEqual(
            tasks.items.map((task) => task.id).sort((a, b) => a - b),
            [parentId, childId],
        );
        const entries = await recovered.conversation.entries(
            { order: "ascending" },
            100,
            undefined,
            context,
        );
        const results = entries.items.filter((entry) => entry.kind === "pi.tool-result");

        assert.equal(
            results.length,
            1,
            "only the interrupted parent's result enters the transcript",
        );
        assert.equal(results[0]!.byTaskId, parentId);
    },
);

test("native hooks rewrite, block, throw and share each child's own memos with execute and afterTool", async (t) => {
    const executed: string[] = [];
    const beforeIds: TaskId[] = [];
    const afterIds: TaskId[] = [];
    const writtenPaths: string[] = [];
    const write = defineTool({
        name: "write",
        description: "Observe the path accepted by native hooks",
        parameters: Type.Object({ path: Type.String() }),
        execute: async (args) => {
            writtenPaths.push(args.path);

            return { output: [{ type: "text", text: `wrote:${args.path}` }] };
        },
    });
    const shell = defineTool({
        name: "bash",
        description: "Observe native hook state",
        parameters: Type.Object({ command: Type.String() }),
        execute: async (args, api, scope) => {
            executed.push(args.command);
            assert.equal(await api.memo("command", scope), "short");

            return { output: [{ type: "text", text: `ran ${args.command}` }] };
        },
    });
    const policy = defineExtension({
        name: "policy",
        hooks: [
            hook(ToolTask, {
                beforeTool: async (call, api, scope) => {
                    if (call.name === "write") {
                        return { arguments: { path: "actual.txt" } };
                    }

                    if (call.name !== "bash") {
                        return undefined;
                    }

                    assert.ok(
                        call.parent,
                        "native nested hooks carry the parent task, not just a synthetic call ID",
                    );
                    assert.notEqual(api.taskId, call.parent.taskId);
                    beforeIds.push(api.taskId);
                    const command = call.arguments.command;

                    assert.ok(typeof command === "string");
                    await api.memo("command", command, scope);

                    if (command === "rm -rf /") {
                        return { block: "not that" };
                    }

                    if (command === "boom") {
                        throw new Error("hook failed");
                    }

                    const rewritten: JsonObject =
                        command === "invalid" ? {} : { command: "rewritten" };

                    return { arguments: rewritten };
                },
                afterTool: async (call, result, api, scope) => {
                    if (call.name !== "bash") {
                        return undefined;
                    }

                    afterIds.push(api.taskId);
                    assert.equal(await api.memo("command", scope), "short");

                    return { ...result, output: [{ type: "text", text: "after:ran rewritten" }] };
                },
            }),
        ],
    });
    const suite = await open(t, [shell, write], [policy]);
    const result = await suite.run(`return (await Promise.allSettled([
        tools.bash({command: "rm -rf /"}), tools.bash({command: "boom"}),
        tools.bash({command: "short"}), tools.bash({command: "invalid"}),
        tools.write({path: "requested.txt"})
    ])).map(o => o.status === "fulfilled" ? o.value : "ERR " + o.reason.message);`);
    const values = output(result.text) as string[];

    assert.equal(values[0], "ERR Tool call blocked: not that");
    assert.equal(values[1], "ERR Tool call blocked: hook failed");
    assert.equal(values[2], "after:ran rewritten");
    assert.match(values[3]!, /command/);
    assert.equal(values[4], "wrote:actual.txt");
    assert.deepEqual(writtenPaths, ["actual.txt"]);
    const details = result.message.details as { calls: { name: string; path?: string }[] };

    assert.equal(
        details.calls.find((call) => call.name === "write")?.path,
        "actual.txt",
        "the persisted outer result attributes the accepted path, not the requested one",
    );
    assert.deepEqual(executed, ["rewritten"], "blocked or invalid rewritten calls never execute");
    assert.equal(new Set(beforeIds).size, 4);
    assert.deepEqual(afterIds, [beforeIds[2]]);
});

test("callable-only tools keep wrapped read-only plan hints and cannot invoke codemode recursively", async (t) => {
    const ran: string[] = [];
    const tool = (name: string) =>
        defineTool({
            name,
            description: name,
            callers: ["tools"],
            parameters: Type.Object({}),
            execute: async () => {
                ran.push(name);

                return { output: [{ type: "text", text: `${name} ran` }] };
            },
        });
    const peek = tool("peek");
    const poke = tool("poke");
    const relay = defineTool({
        name: "relay",
        description: "Attempt native recursion",
        callers: ["tools"],
        ...{ annotations: { readOnlyHint: true } },
        parameters: Type.Object({}),
        execute: async (_args, api, scope) => {
            const nested = await api.executeTool(
                "codemode",
                { code: 'store("recursive", true);' },
                scope,
            );

            return { output: [{ type: "text", text: JSON.stringify(nested) }] };
        },
    });
    const hints = defineExtension({
        name: "hints",
        wraps: [
            wrapTool(peek, (original) => ({ ...original, annotations: { readOnlyHint: true } })),
        ],
    });
    const suite = await open(t, [peek, poke, relay], [hints, createPlan(host)]);

    await suite.conversation.commit(async (tx) => {
        (await tx.doc(PlanDoc, suite.conversation.id)).on = true;
    }, context);
    const agent = await suite.conversation.agent(context);

    assert.equal(
        agent.tools.some((item) => item.name === "peek"),
        false,
    );
    const direct = await suite.finish(await suite.start("", "peek", {}));

    assert.match(direct.text, /not available/);
    const result =
        await suite.run(`const results = await Promise.allSettled([tools.peek({}), tools.poke({}), tools.relay({})]);
        return {names: ALL_TOOLS.map(t => t.name), results: results.map(o => o.status === "fulfilled" ? o.value : o.reason.message)};`);
    const value = output(result.text) as { names: string[]; results: string[] };

    assert.ok(value.names.includes("peek"));
    assert.ok(!value.names.includes("codemode"));
    assert.equal(value.results[0], "peek ran");
    assert.match(value.results[1]!, /Plan mode is on: The poke tool/);
    const recursive = JSON.parse(value.results[2]!);

    assert.equal(recursive.isError, true);
    assert.match(recursive.diagnostics[0].message, /codemode is not available/);
    assert.deepEqual(ran, ["peek"]);
    assert.deepEqual(
        (await suite.harness.snapshot(CodemodeStoreDoc, suite.conversation.id, context))?.values,
        {},
    );
});

test("successful scripts commit store writes across invocations; failures keep output but commit no writes", async (t) => {
    const suite = await open(t, [echo]);

    await suite.run(
        `store("count", (load("count") ?? 0) + 1); store("gone", 1); store("gone", undefined);`,
    );
    await suite.run(`store("count", load("count") + 1);`);
    assert.deepEqual(
        (await suite.harness.snapshot(CodemodeStoreDoc, suite.conversation.id, context))?.values,
        { count: 2 },
    );
    const failed = await suite.run(
        `store("count", 99); text("partial"); await tools.echo({text: "y"}); throw new Error("oops");`,
    );

    assert.equal(failed.message.isError, true);
    assert.match(
        failed.text,
        /^Script failed[\s\S]*partial[\s\S]*Script error:\nError: oops[\s\S]*echo \(ok\)/,
    );
    assert.deepEqual(
        (await suite.harness.snapshot(CodemodeStoreDoc, suite.conversation.id, context))?.values,
        { count: 2 },
    );
    assert.equal(output((await suite.run(`return load("count");`)).text), 2);
});

test(
    "parallel Guard approvals belong to native child tasks and memoize only the approved call",
    { timeout: 15_000 },
    async (t) => {
        const approvals = new Approvals(() => undefined);
        const started = Promise.withResolvers<TaskId>();
        const release = Promise.withResolvers<void>();

        t.after(() => release.resolve());
        const executed: string[] = [];
        const guardHost = {
            approvals,
            workspace: () => ({ location: undefined }),
            guard: {
                judge: async (name: string, args: { command?: string }) =>
                    name === "bash"
                        ? {
                              subject: args.command!,
                              decision: { action: "ask", source: "test", reason: "risky" },
                          }
                        : undefined,
            },
        } as unknown as PocketHost;
        const shell = defineTool({
            name: "bash",
            description: "Only run approved calls",
            parameters: Type.Object({ command: Type.String() }),
            execute: async (args, api) => {
                executed.push(args.command);
                started.resolve(api.taskId);
                await release.promise;

                return { output: [{ type: "text", text: `ran ${args.command}` }] };
            },
        });
        const suite = await open(t, [shell], [createGuard(guardHost)]);
        const parentId =
            await suite.start(`return (await Promise.allSettled([tools.bash({command: "one"}), tools.bash({command: "two"})]))
        .map(o => o.status === "fulfilled" ? o.value : o.reason.message);`);
        const waiting = suite.finish(parentId);
        let checked = false;

        try {
            await until(() => approvals.all().length === 2, "both native Guard requests");
            const one = approvals.all().find((request) => request.subject === "one")!;
            const two = approvals.all().find((request) => request.subject === "two")!;

            assert.notEqual(one.taskId, two.taskId);
            assert.notEqual(one.taskId, parentId);
            assert.notEqual(two.taskId, parentId);
            assert.equal((await suite.harness.getTask(one.taskId, context))?.owner, parentId);
            assert.equal((await suite.harness.getTask(two.taskId, context))?.owner, parentId);
            assert.ok(approvals.answer(one.id, { allow: true, by: "Alex" }));
            assert.ok(approvals.answer(two.id, { allow: false, by: "Sam" }));
            const approvedId = await started.promise;
            const approved = await suite.harness.getTask(approvedId, context);
            const parent = await suite.harness.getTask(parentId, context);

            assert.deepEqual(approved?.memos?.["pocket.approval"], { allow: true, by: "Alex" });
            assert.equal(parent?.memos?.["pocket.approval"], undefined);
            checked = true;
        } finally {
            release.resolve();

            if (!checked) {
                await suite.conversation.abort(context);
            }

            await waiting;
        }

        const result = await waiting;
        const [first, second] = output(result.text) as string[];

        assert.equal(first, "ran one");
        assert.match(
            second!,
            /^Tool call blocked: Sam denied this bash call after Lancet Guard asked \(risky\)/,
        );
        assert.deepEqual(executed, ["one"]);
        assert.deepEqual(approvals.all(), []);
    },
);
