// Dependency-compatibility smoke tests: real 1.4 Harness/Session state and public persisted writes.
// No application server, native execution environment, network, or production test-only exports.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { Context } from "@earendil-works/chord";
import { awaitWithContext, BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { type AssistantMessage, createModels, type Message, Type } from "@earendil-works/pi-ai";
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
    InboxDoc,
    MemoryStorage,
    SessionFailed,
    type Registry,
    type SetTimer,
    type StorageWrite,
    ToolResultEntry,
    ToolTask,
} from "@earendil-works/pi-durable";

/** Capture only successful, real MemoryStorage commits, preserving their atomic batch boundaries. */
class JournalStorage extends MemoryStorage {
    readonly batches: StorageWrite[][] = [];

    override async commit(writes: readonly StorageWrite[], scope: Context) {
        const detached = structuredClone([...writes]);
        const seq = await super.commit(writes, scope);

        this.batches.push(detached);

        return seq;
    }

    checkpoint() {
        return structuredClone(this.batches);
    }
}

async function replay(batches: readonly (readonly StorageWrite[])[]) {
    const storage = new JournalStorage();

    for (const batch of batches) {
        await storage.commit(batch, context);
    }

    return storage;
}

function clock(start = 1_000) {
    let time = start;
    let serial = 0;
    const timers = new Map<number, { at: number; callback: () => void }>();

    const setTimer: SetTimer = (callback, delay, options) => {
        // Idle cache/context eviction is optional. Only foreground task timers matter here.
        if (options.background) {
            return undefined;
        }

        const id = ++serial;

        timers.set(id, { at: time + delay, callback });

        return () => {
            timers.delete(id);
        };
    };

    return {
        now: () => time,
        setTimer,
        deadlines: () => [...timers.values()].map((timer) => timer.at).sort((a, b) => a - b),
        advanceTo(at: number) {
            assert.ok(at >= time, "the injected clock never goes backwards");
            time = at;

            for (const [id, timer] of [...timers]) {
                if (timer.at <= time && timers.delete(id)) {
                    timer.callback();
                }
            }
        },
    };
}

async function until(check: () => boolean | Promise<boolean>, message: string) {
    for (let turn = 0; turn < 1_000; turn++) {
        if (await check()) {
            return;
        }

        await nextTurn();
    }

    assert.fail(message);
}

async function open(
    t: TestContext,
    storage: MemoryStorage,
    registry: Registry,
    time: ReturnType<typeof clock>,
    models = createModels(),
) {
    const harness = await Harness.open(
        storage,
        {
            models,
            registry,
            // Application policy, not the SDK default: five consecutive cutoffs without progress.
            settings: { restartLimit: 5 },
            now: time.now,
            setTimer: time.setTimer,
        },
        context,
    );

    t.after(() => harness.close(context));

    return harness;
}

function sleeper() {
    const visits: string[] = [];
    const task = defineTask<
        { label: string },
        { phase: "start" } | { phase: "awake"; label: string },
        { label: string; at: number }
    >({
        name: "test.runtime.sleep",
        version: 1,
        initial: () => ({ phase: "start" }),
        phases: {
            start: async (task, runtime, scope) => {
                visits.push("start");
                await awaitWithContext(
                    new Promise<void>((resolve) => runtime.setTimer(resolve, 25)),
                    scope,
                );
                await runtime.sleepUntil(
                    runtime.now() + 100,
                    { phase: "awake", label: task.input.label },
                    scope,
                );
            },
            awake: async (task, runtime, scope) => {
                visits.push("awake");
                await runtime.commit(
                    () => ({
                        status: "terminal",
                        outcome: {
                            status: "completed",
                            result: { label: task.state.checkpoint.label, at: runtime.now() },
                        },
                    }),
                    scope,
                );
            },
        },
        abort: async (_task, runtime, scope) => {
            visits.push("abort");
            await runtime.commit(
                () => ({ status: "terminal", outcome: { status: "aborted" } }),
                scope,
            );
        },
    });

    return { task, visits };
}

function blocker() {
    const attempts = { started: 0, committed: 0, change: "none" as "none" | "same" | "advance" };
    const task = defineTask<null, { phase: "hold"; revision: number }, null>({
        name: "test.runtime.block",
        version: 1,
        initial: () => ({ phase: "hold", revision: 0 }),
        phases: {
            hold: async (task, runtime, scope) => {
                attempts.started++;

                if (attempts.change !== "none") {
                    const revision =
                        task.state.checkpoint.revision + (attempts.change === "advance" ? 1 : 0);

                    await runtime.commit(
                        () => ({ status: "running", checkpoint: { phase: "hold", revision } }),
                        scope,
                    );
                    attempts.committed++;
                }

                // An invocation cut off before its next durable transition; close still joins it.
                await awaitWithContext(new Promise<never>(() => {}), scope);
            },
        },
        abort: async (_task, runtime, scope) => {
            await runtime.commit(
                () => ({ status: "terminal", outcome: { status: "aborted" } }),
                scope,
            );
        },
    });

    return { task, attempts };
}

/** Each recovery replays the last successful journal BEFORE close, never its graceful pending write. */
async function cutoffs(t: TestContext, count: number) {
    const fixture = blocker();
    const registry = createRegistry();

    registry.install(defineExtension({ name: "runtime-test", tasks: [fixture.task] }));
    const time = clock();
    let storage = new JournalStorage();
    let harness = await open(t, storage, registry, time);
    const conversation = await harness.root(context);
    const id = await conversation.commit(
        (tx) =>
            tx.createTask(fixture.task, null, {
                ownership: { kind: "conversation" },
            }),
        context,
    );

    harness.resume();
    await until(() => fixture.attempts.started === 1, "initial invocation did not start");

    for (let recovered = 1; recovered <= count; recovered++) {
        const cutoff = storage.checkpoint();

        await harness.close(context);
        storage = await replay(cutoff);
        harness = await open(t, storage, registry, time);
        const record = await harness.getTask(id, context);

        assert.equal(record?.restarts, recovered, "each cutoff is counted exactly once on open");
        assert.deepEqual(record?.state, {
            status: "pending",
            checkpoint: { phase: "hold", revision: 0 },
        });

        if (recovered < count) {
            harness.resume();
            await until(
                () => fixture.attempts.started === recovered + 1,
                `recovery ${recovered} did not execute`,
            );
        }
    }

    return { ...fixture, harness, storage, registry, time, id };
}

test(
    "sleepUntil persists its next phase and resumes only at the injected deadline after reopen",
    { timeout: 10_000 },
    async (t) => {
        const fixture = sleeper();
        const registry = createRegistry();

        registry.install(defineExtension({ name: "runtime-test", tasks: [fixture.task] }));
        const time = clock();
        const storage = new JournalStorage();
        const harness = await open(t, storage, registry, time);
        const conversation = await harness.root(context);
        const id = await conversation.commit(
            (tx) =>
                tx.createTask(
                    fixture.task,
                    { label: "persisted" },
                    {
                        ownership: { kind: "conversation" },
                    },
                ),
            context,
        );

        harness.resume();
        await until(() => time.deadlines().includes(1_025), "runtime.setTimer was not armed");
        time.advanceTo(1_024);
        assert.deepEqual(fixture.visits, ["start"]);
        time.advanceTo(1_025);
        await until(
            async () => (await harness.getTask(id, context))?.state.status === "sleeping",
            "sleep was not committed",
        );
        const sleeping = await storage.task(id, context);

        assert.deepEqual(sleeping?.state, {
            status: "sleeping",
            until: 1_125,
            checkpoint: { phase: "awake", label: "persisted" },
        });
        const persisted = storage.checkpoint();

        await harness.close(context);
        assert.deepEqual(time.deadlines(), [], "close disarms the old owner's timers");
        const restoredStorage = await replay(persisted);
        const restored = await open(t, restoredStorage, registry, time);

        assert.equal((await restored.getTask(id, context))?.restarts, undefined);
        restored.resume();
        await until(
            () => time.deadlines().includes(1_125),
            "persisted sleep timer was not rearmed",
        );
        time.advanceTo(1_124);
        await nextTurn();
        assert.equal((await restored.getTask(id, context))?.state.status, "sleeping");
        assert.deepEqual(fixture.visits, ["start"]);
        time.advanceTo(1_125);
        await until(
            async () => (await restored.getTask(id, context))?.state.status === "terminal",
            "the injected wake timer did not resume the persisted phase",
        );
        assert.deepEqual((await restored.waitForTask(id, context)).state.outcome, {
            status: "completed",
            result: { label: "persisted", at: 1_125 },
        });
        assert.deepEqual(fixture.visits, ["start", "awake"]);
    },
);

test(
    "abortTask cancels a persisted sleep without waiting for its deadline or running the wake phase",
    { timeout: 10_000 },
    async (t) => {
        const fixture = sleeper();
        const registry = createRegistry();

        registry.install(defineExtension({ name: "runtime-test", tasks: [fixture.task] }));
        const time = clock();
        const harness = await open(t, new MemoryStorage(), registry, time);
        const conversation = await harness.root(context);
        const id = await conversation.commit(
            (tx) =>
                tx.createTask(
                    fixture.task,
                    { label: "cancel" },
                    {
                        ownership: { kind: "conversation" },
                    },
                ),
            context,
        );

        harness.resume();
        await until(() => time.deadlines().includes(1_025), "phase timer was not armed");
        time.advanceTo(1_025);
        await until(
            async () => (await harness.getTask(id, context))?.state.status === "sleeping",
            "task did not enter sleep",
        );
        await harness.abortTask(id, context);
        assert.deepEqual((await harness.waitForTask(id, context)).state.outcome, {
            status: "aborted",
        });
        assert.equal(time.now(), 1_025);
        time.advanceTo(1_125);
        await nextTurn();
        assert.deepEqual(fixture.visits, ["start", "abort"]);
        assert.deepEqual((await harness.waitForTask(id, context)).state.outcome, {
            status: "aborted",
        });
    },
);

test(
    "five consecutive cutoff recoveries park at restart_limit; explicit retry clears the count",
    { timeout: 10_000 },
    async (t) => {
        const fixture = await cutoffs(t, 5);
        const inspection = await fixture.harness.inspect(context);

        assert.deepEqual(inspection.tasks.find((task) => task.record.id === fixture.id)?.state, {
            kind: "blocked",
            reason: "restart_limit",
        });
        fixture.harness.resume();
        await nextTurn();
        assert.equal(
            fixture.attempts.started,
            5,
            "the fifth recovery must not execute a sixth attempt",
        );
        await fixture.harness.retryTask(fixture.id, context);
        await until(() => fixture.attempts.started === 6, "retry did not unpark the task");
        assert.equal((await fixture.harness.getTask(fixture.id, context))?.restarts, undefined);
        assert.equal(
            (await fixture.harness.inspect(context)).tasks.find(
                (task) => task.record.id === fixture.id,
            )?.state.kind,
            "running",
        );
    },
);

test(
    "same-checkpoint intent is not progress; graceful close preserves the count and a changed checkpoint resets it",
    { timeout: 10_000 },
    async (t) => {
        const fixture = await cutoffs(t, 4);
        let { harness, storage } = fixture;

        fixture.attempts.change = "same";
        harness.resume();
        await until(
            () => fixture.attempts.committed === 1,
            "same-checkpoint commit did not settle",
        );
        assert.equal((await harness.getTask(fixture.id, context))?.restarts, 4);

        // Unlike a cutoff, retain the graceful close's real pending write in this replay.
        await harness.close(context);
        storage = await replay(storage.checkpoint());
        harness = await open(t, storage, fixture.registry, fixture.time);
        assert.equal((await harness.getTask(fixture.id, context))?.restarts, 4);
        assert.equal((await harness.getTask(fixture.id, context))?.state.status, "pending");
        fixture.attempts.change = "advance";
        harness.resume();
        await until(
            () => fixture.attempts.committed === 2,
            "changed-checkpoint commit did not settle",
        );
        const progressed = await harness.getTask(fixture.id, context);

        assert.equal(progressed?.restarts, undefined);
        assert.deepEqual(progressed?.state, {
            status: "running",
            checkpoint: { phase: "hold", revision: 1 },
        });
        const cutoff = storage.checkpoint();

        await harness.close(context);
        storage = await replay(cutoff);
        harness = await open(t, storage, fixture.registry, fixture.time);
        assert.equal((await harness.getTask(fixture.id, context))?.restarts, 1);
        fixture.attempts.change = "none";
        harness.resume();
        await until(
            () => fixture.attempts.started === 7,
            "progress did not restore the restart budget",
        );
    },
);

async function toolFixture(t: TestContext) {
    const calls: unknown[] = [];
    const child = sleeper();
    const registry = createRegistry();

    registry.install(
        defineExtension({
            name: "runtime-test",
            tasks: [child.task],
            tools: [
                defineTool({
                    name: "probe",
                    description: "A deterministic tool for persisted task compatibility",
                    parameters: Type.Object({ value: Type.String() }),
                    replay: "safe",
                    execute: async (args) => {
                        calls.push(args);

                        return { output: [{ type: "text", text: "legacy tool executed" }] };
                    },
                }),
            ],
        }),
    );
    const time = clock();
    const storage = new JournalStorage();
    const harness = await open(t, storage, registry, time);
    const conversation = await harness.root(context);
    const assistant = await conversation.commit(
        (tx) =>
            tx.appendEntry(AssistantEntry, conversation.id, {
                model: [
                    fauxAssistantMessage(
                        [fauxToolCall("probe", { value: "assistant args" }, { id: "legacy-call" })],
                        { stopReason: "toolUse" },
                    ),
                ],
            }),
        context,
    );
    const id = await conversation.commit(
        (tx) =>
            tx.createTask(
                ToolTask,
                { kind: "model", assistant: assistant.id, callId: "legacy-call" },
                { ownership: { kind: "conversation" } },
            ),
        context,
    );

    return { calls, child, registry, time, storage, harness, conversation, assistant, id };
}

test(
    "live v1 ToolTask input migrates in storage and resumes its safe execute checkpoint",
    { timeout: 10_000 },
    async (t) => {
        const fixture = await toolFixture(t);

        await fixture.harness.close(context);
        const storage = await replay(fixture.storage.checkpoint());
        const current = await storage.task(fixture.id, context);

        assert.ok(current);
        // The installed 1.1 schema: untagged model input and already-recorded safe execution intent.
        await storage.commit(
            [
                {
                    type: "task",
                    value: {
                        ...current,
                        version: 1,
                        input: { assistant: fixture.assistant.id, callId: "legacy-call" },
                        state: {
                            status: "running",
                            checkpoint: {
                                phase: "execute",
                                arguments: { value: "persisted args" },
                                replay: "safe",
                            },
                        },
                    },
                },
            ],
            context,
        );
        const harness = await open(t, storage, fixture.registry, fixture.time);
        const outcome = (await harness.waitForTask(fixture.id, context)).state.outcome;

        assert.equal(outcome.status, "completed");

        if (outcome.status !== "completed") {
            assert.fail("migrated tool did not complete");
        }

        assert.equal(outcome.result.kind, "model");

        if (outcome.result.kind !== "model") {
            assert.fail("a v1 tool must remain model-issued");
        }

        assert.deepEqual(fixture.calls, [{ value: "persisted args" }]);
        const migrated = await harness.getTask(fixture.id, context);

        assert.equal(migrated?.version, 2);
        assert.deepEqual(migrated?.input, {
            kind: "model",
            assistant: fixture.assistant.id,
            callId: "legacy-call",
        });
        const entry = await storage.entry(outcome.result.entryId, context);

        assert.equal(entry?.entry.kind, ToolResultEntry.kind);
        assert.deepEqual(entry?.entry.model?.[0]?.content, [
            { type: "text", text: "legacy tool executed" },
        ]);
    },
);

test(
    "an already-completing v1 ToolTask preserves its untagged result while owned work drains",
    { timeout: 10_000 },
    async (t) => {
        const fixture = await toolFixture(t);
        const legacy = await fixture.conversation.commit(async (tx) => {
            const entry = await tx.appendEntry(ToolResultEntry, fixture.conversation.id, {
                model: [
                    {
                        role: "toolResult",
                        toolCallId: "legacy-call",
                        toolName: "probe",
                        content: [{ type: "text", text: "already committed by 1.1" }],
                        isError: false,
                        timestamp: fixture.time.now(),
                    },
                ],
                data: { diagnostics: [] },
            });
            const child = await tx.createTask(
                fixture.child.task,
                { label: "owned" },
                {
                    ownership: { kind: "task", taskId: fixture.id },
                },
            );

            return { entryId: entry.id, child };
        }, context);

        await fixture.harness.close(context);
        const storage = await replay(fixture.storage.checkpoint());
        const current = await storage.task(fixture.id, context);

        assert.ok(current);
        const { memos: _memos, restarts: _restarts, ...legacyRecord } = current;

        await storage.commit(
            [
                {
                    type: "task",
                    value: {
                        ...legacyRecord,
                        version: 1,
                        input: { assistant: fixture.assistant.id, callId: "legacy-call" },
                        state: {
                            status: "completing",
                            outcome: { status: "completed", result: { entryId: legacy.entryId } },
                        },
                    },
                },
            ],
            context,
        );
        const harness = await open(t, storage, fixture.registry, fixture.time);

        harness.resume();
        await until(() => fixture.time.deadlines().includes(1_025), "owned task did not start");
        fixture.time.advanceTo(1_025);
        await until(
            async () => (await harness.getTask(legacy.child, context))?.state.status === "sleeping",
            "owned task did not sleep",
        );
        assert.equal((await harness.getTask(fixture.id, context))?.state.status, "completing");
        await harness.abortTask(legacy.child, context);
        assert.deepEqual((await harness.waitForTask(legacy.child, context)).state.outcome, {
            status: "aborted",
        });
        assert.deepEqual((await harness.waitForTask(fixture.id, context)).state.outcome, {
            status: "completed",
            result: { entryId: legacy.entryId },
        });
        assert.deepEqual(
            fixture.calls,
            [],
            "a completing task must not execute again to tag its result",
        );
        assert.equal((await harness.getTask(fixture.id, context))?.version, 1);
        const entries = await storage.scanEntries(
            { conversationId: fixture.conversation.id },
            10,
            undefined,
            context,
        );

        assert.deepEqual(
            entries.items.filter((entry) => ToolResultEntry.is(entry)).map((entry) => entry.id),
            [legacy.entryId],
        );
    },
);

test(
    "a failed submission commit poisons its Session without publishing or returning durable acceptance",
    { timeout: 10_000 },
    async (t) => {
        const failure = new Error("injected atomic commit failure");

        class FailingStorage extends JournalStorage {
            rejectCommit = false;
            commitCalls = 0;

            override async commit(writes: readonly StorageWrite[], scope: Context) {
                this.commitCalls++;

                if (this.rejectCommit) {
                    throw failure;
                }

                return super.commit(writes, scope);
            }
        }

        const storage = new FailingStorage();
        const harness = await open(t, storage, createRegistry(), clock());
        const conversation = await harness.root(context);
        const publications: unknown[] = [];

        harness.subscribeCommits((publication) => publications.push(publication));
        const before = storage.commitCalls;

        storage.rejectCommit = true;
        await assert.rejects(
            conversation.submit(
                {
                    type: "write",
                    requestId: "failed-card",
                    entry: { kind: "test.runtime.card", data: { text: "must not be accepted" } },
                },
                context,
            ),
            (error) => error === failure,
        );
        assert.deepEqual(await harness.closed, { reason: "failed", error: failure });
        assert.deepEqual(
            publications,
            [],
            "failed storage writes must not be adopted or published",
        );
        const isFailed = (error: unknown) =>
            error instanceof SessionFailed && error.cause === failure;

        await assert.rejects(
            harness.commit(() => null, context),
            isFailed,
        );
        await assert.rejects(
            conversation.submit(
                {
                    type: "write",
                    entry: { kind: "test.runtime.card", data: { text: "later attempt" } },
                },
                context,
            ),
            isFailed,
        );
        assert.equal(
            storage.commitCalls,
            before + 1,
            "the failed Session neither retries nor reaches storage again",
        );

        // Reopen only actual successful commits, after the failed Session has closed its storage owner.
        const recoveredStorage = await replay(storage.checkpoint());
        const recovered = await open(t, recoveredStorage, createRegistry(), clock());

        assert.equal(
            await recoveredStorage.submissionByRequest(conversation.id, "failed-card", context),
            undefined,
        );
        const transcript = await (await recovered.conversation(conversation.id, context))!.entries(
            { order: "ascending" },
            10,
            undefined,
            context,
        );

        assert.ok(!transcript.items.some((entry) => entry.kind === "test.runtime.card"));
    },
);

test(
    "a display-only write bypasses a busy generation without entering or reordering queued requester inputs",
    { timeout: 10_000 },
    async (t) => {
        const faux = fauxProvider();
        const models = createModels();

        models.setProvider(faux.provider);
        const requests: Message[][] = [];
        const release = Promise.withResolvers<AssistantMessage>();

        faux.setResponses([
            async (transcript) => {
                requests.push(structuredClone([...transcript.messages]));

                return release.promise;
            },
            (transcript) => {
                requests.push(structuredClone([...transcript.messages]));

                return fauxAssistantMessage("second answer");
            },
            (transcript) => {
                requests.push(structuredClone([...transcript.messages]));

                return fauxAssistantMessage("third answer");
            },
        ]);
        const storage = new MemoryStorage();
        const harness = await open(t, storage, createRegistry(), clock(), models);
        const conversation = await harness.root(context);

        await conversation.configure({ model: { provider: "faux", modelId: "faux-1" } }, context);
        const first = await conversation.submit(
            {
                type: "input",
                content: "first",
                requestId: "requester-A",
                entry: { kind: "test.runtime.input", data: { requester: "A" } },
            },
            context,
        );

        try {
            await until(
                () => requests.length === 1,
                "the first generation did not reach its provider",
            );
            const second = await conversation.submit(
                {
                    type: "input",
                    content: "second",
                    requestId: "requester-B",
                    whenBusy: "followUp",
                    entry: { kind: "test.runtime.input", data: { requester: "B" } },
                },
                context,
            );
            const third = await conversation.submit(
                {
                    type: "input",
                    content: "third",
                    requestId: "requester-C",
                    whenBusy: "followUp",
                    entry: { kind: "test.runtime.input", data: { requester: "C" } },
                },
                context,
            );

            const card = await conversation.submit(
                {
                    type: "write",
                    requestId: "guest-card",
                    entry: {
                        kind: "test.runtime.card",
                        data: { requester: "guest", text: "CARD_SENTINEL" },
                    },
                },
                context,
            );

            assert.equal(
                (await card.status(context)).status,
                "done",
                "the card must not wait for generation",
            );
            assert.equal((await second.status(context)).status, "queued");
            assert.equal((await third.status(context)).status, "queued");
            const inbox = await harness.snapshot(InboxDoc, conversation.id, context);

            assert.deepEqual(
                inbox?.items.map((item) => item.id),
                [second.id, third.id],
            );
            const tasks = await storage.scanTasks(
                { conversationId: conversation.id, kind: "pi.generation" },
                10,
                undefined,
                context,
            );

            assert.equal(tasks.items.length, 1, "the passive write must not create a generation");
            assert.equal(requests.length, 1);
            release.resolve(fauxAssistantMessage("first answer"));

            const settled = await Promise.all([
                first.wait(context),
                second.wait(context),
                third.wait(context),
            ]);

            assert.deepEqual(
                settled.map((record) => record.status),
                ["done", "done", "done"],
            );
            assert.equal(requests.length, 3, "only the three inputs may enter generation");
            assert.deepEqual(
                requests.map((messages) =>
                    messages
                        .filter((message) => message.role === "user")
                        .map((message) => message.content),
                ),
                [["first"], ["first", "second"], ["first", "second", "third"]],
            );
            assert.ok(!JSON.stringify(requests).includes("CARD_SENTINEL"));
            const transcript = await conversation.entries(
                { order: "ascending" },
                100,
                undefined,
                context,
            );

            assert.deepEqual(
                transcript.items
                    .filter((entry) => entry.kind.startsWith("test.runtime."))
                    .map((entry) => entry.data),
                [
                    { requester: "A" },
                    { requester: "guest", text: "CARD_SENTINEL" },
                    { requester: "B" },
                    { requester: "C" },
                ],
            );
        } finally {
            release.resolve(fauxAssistantMessage("first answer"));
        }
    },
);
