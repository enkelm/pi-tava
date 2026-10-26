// These tests own worker lifetime, not nested-child cleanup (covered in codemode.test.ts).
// Real ToolTasks execute the production extension and installed SDK. Only native timing is held.
import assert from "node:assert/strict";
import { setTimeout as delay, setImmediate as nextTurn } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
    AssistantEntry,
    createRegistry,
    Harness,
    MemoryStorage,
    ToolTask,
} from "@earendil-works/pi-durable";
import { CodemodeStoreDoc } from "../src/server/docs.ts";
import createCodemode from "../src/server/extensions/codemode.ts";
import type { PocketHost } from "../src/server/host.ts";

async function start(t: TestContext) {
    const registry = createRegistry();
    const reports: unknown[] = [];

    registry.install(createCodemode({} as PocketHost));
    const harness = await Harness.open(
        new MemoryStorage(),
        { registry, models: createModels(), onReport: (error) => reports.push(error) },
        context,
    );

    t.after(async () => {
        await harness.close(context);
        assert.deepEqual(reports, [], "the native scheduler must not fault");
    });
    const conversation = await harness.root(context, {
        init: async (tx, id) => {
            await tx.doc(CodemodeStoreDoc, id);
        },
    });
    const id = await conversation.commit(async (tx) => {
        const callId = "worker-lifetime";
        const assistant = await tx.appendEntry(AssistantEntry, conversation.id, {
            model: [
                fauxAssistantMessage(
                    [
                        fauxToolCall(
                            "codemode",
                            { code: 'return "worker finished";' },
                            { id: callId },
                        ),
                    ],
                    { stopReason: "toolUse" },
                ),
            ],
        });

        return tx.createTask(
            ToolTask,
            { kind: "model", assistant: assistant.id, callId },
            { ownership: { kind: "conversation" } },
        );
    }, context);
    const finished = harness.waitForTask(id, context);

    return { harness, conversation, id, finished };
}

// Keep this first: the real SDK caches compiled Wasm per process. Node isolates test files.
test(
    "abort during cold Wasm compilation cannot admit a worker after the ToolTask settles",
    { timeout: 15_000 },
    async (t) => {
        const compiling = Promise.withResolvers<void>();
        const releaseCompile = Promise.withResolvers<void>();
        const compiled = Promise.withResolvers<void>();
        const compile = WebAssembly.compile;
        const once = Worker.prototype.once;
        const workers = new Set<Worker>();

        t.mock.method(WebAssembly, "compile", async (bytes: BufferSource) => {
            compiling.resolve();
            await releaseCompile.promise;

            try {
                return await compile(bytes);
            } finally {
                compiled.resolve();
            }
        });
        t.mock.method(
            Worker.prototype,
            "once",
            function (this: Worker, event: string | symbol, listener: (...args: any[]) => void) {
                if (event === "exit") {
                    workers.add(this);
                }

                return once.call(this, event, listener);
            },
        );
        const suite = await start(t);

        try {
            await compiling.promise;
            assert.equal(workers.size, 0, "compilation is held before worker construction");
            await suite.harness.abortTask(suite.id, context);
            const parent = await suite.finished;

            assert.equal(parent.state.outcome.status, "aborted");
            assert.equal(workers.size, 0, "abort settles without waiting for an unadmitted worker");
            releaseCompile.resolve();
            await compiled.promise;
            // Drain the real loader's promise continuations, including any late launcher admission.
            await nextTurn();
            await nextTurn();
            assert.equal(workers.size, 0, "a settled parent must never admit a late worker");
        } finally {
            releaseCompile.resolve();
            await compiled.promise;
            await nextTurn();
            await Promise.all([...workers].map((worker) => worker.terminate()));
            await suite.finished;
        }
    },
);

test(
    "ToolTask settlement waits for a real worker's exit notification, independently of child tools",
    { timeout: 15_000 },
    async (t) => {
        const once = Worker.prototype.once;
        const exited = Promise.withResolvers<void>();
        const workers = new Set<Worker>();
        const notifications: (() => void)[] = [];
        let released = false;

        // Observe the actual OS worker exit without delaying it. Hold only once-listener delivery;
        // the SDK's onWorkerStarted promise must still be pending when the parent is inspected.
        t.mock.method(
            Worker.prototype,
            "once",
            function (this: Worker, event: string | symbol, listener: (...args: any[]) => void) {
                if (event !== "exit") {
                    return once.call(this, event, listener);
                }

                if (!workers.has(this)) {
                    workers.add(this);
                    once.call(this, "exit", () => exited.resolve());
                }

                return once.call(this, event, (...args: unknown[]) => {
                    const notify = () => listener.apply(this, args);

                    if (released) {
                        notify();
                    } else {
                        notifications.push(notify);
                    }
                });
            },
        );
        const suite = await start(t);
        let settled = false;

        void suite.finished.then(() => {
            settled = true;
        });

        try {
            await exited.promise;
            assert.equal(workers.size, 1, "the production SDK started and exited one real worker");
            assert.ok(notifications.length > 0, "exit notifications are held after actual exit");
            // Give native settlement a chance to run; no child tool or cleanup can hold it here.
            await delay(50);
            assert.equal(settled, false, "parent settlement must await worker-exit notification");
            assert.equal((await suite.harness.getTask(suite.id, context))?.state.status, "running");
        } finally {
            released = true;

            for (const notify of notifications.splice(0)) {
                notify();
            }

            await suite.finished;
        }

        const parent = await suite.finished;

        assert.equal(parent.state.outcome.status, "completed");
        const result = parent.state.outcome.result;

        assert.ok(result?.kind === "model");
        const entry = await suite.conversation.commit((tx) => tx.entry(result.entryId), context);
        const message = entry?.model?.[0];

        assert.equal(message?.role, "toolResult");
        assert.ok(message?.role === "toolResult");
        assert.equal(message.isError, false);
        assert.match(JSON.stringify(message.content), /worker finished/);
    },
);
