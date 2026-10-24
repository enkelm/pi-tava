import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type {
    ConversationId,
    EntryId,
    EntryRecord,
    Seq,
    Storage,
    SubmissionQuery,
    SubmissionRecord,
} from "@earendil-works/pi-durable";
import { PipWorkDoc } from "../src/server/docs.ts";
import { PipSupervision } from "../src/server/pip/supervision.ts";
import {
    activateWorkPip,
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";

const text = (value: string) => fauxAssistantMessage([fauxText(value)]);
const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
    fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

after(cleanUp);

test("native busy handoff stays passive; distinct equal-text outcomes wake once each across restart", async (t) => {
    const held = Promise.withResolvers<void>();
    let source!: ConversationId;
    let calls = 0;
    let researcherStarted = false;
    const model = scriptedModel(async (request) => {
        const system = JSON.stringify(
            request.messages.filter((message) => message.role === "system"),
        );

        if (system.includes("the private supervisor for Work Item")) {
            calls++;

            return calls === 1
                ? tool("handoff", {
                      action: "start",
                      session: Number(source),
                      targetType: "researcher",
                      summary:
                          "Investigate the bounded evidence, then report your claim. No landing authorized.",
                  })
                : tool("work_supervise", {
                      action: "wait",
                      text: "Awaiting a meaningful outcome.",
                  });
        }

        if (system.includes("You are the Researcher agent")) {
            researcherStarted = true;
            await held.promise;

            return text(
                "The evidence supports this bounded claim; full validation remains deferred.",
            );
        }

        return text("Initial evidence and naming fixture.");
    });
    const directory = join(root, "outcome-driven-busy-handoff");
    let app = await openApp(model, directory);

    t.after(async () => {
        held.resolve();
        await app.close();
    });
    source = await newSession(app, app.defaultCwd, "worker");
    const started = await activateWorkPip(app, source, owner(app), {
        text: "Delegate bounded research, then wait for its actual outcome, not busy-state reports.",
    });
    const controller = started.orchestration!.conversationId as ConversationId;

    const reconcile = async () => {
        await app.pip.orchestration.open();
        await until(async () => {
            const state = await app.harness.snapshot(PipWorkDoc, controller, context);
            const tasks = await app.harness.inspect(context);

            return (
                !app.isBusy(controller) &&
                state?.pending === undefined &&
                tasks.tasks.every((task) => task.record.conversationId !== controller)
            );
        }, "the native controller wake/turn to settle");
    };

    await until(
        () => researcherStarted && calls >= 2 && !app.isBusy(controller),
        "busy research and controller wait",
    );
    await reconcile();
    assert.equal(calls, 2, "a newly busy active member must not buy another model response");
    const researcher = app.workItems.itemFor(source)!.activeThreadId as ConversationId;

    assert.notEqual(researcher, source);
    assert.equal(app.isBusy(researcher), true);
    held.resolve();
    await until(() => calls >= 3 && !app.isBusy(controller), "one meaningful research outcome");
    await reconcile();
    assert.equal(calls, 3);
    const first = await app.pip.orchestration.contribution(researcher);

    assert.equal(first?.status, "done");
    const execution = await app.conversation(researcher);
    const followUp = await execution.submit(
        {
            type: "input",
            requestId: "distinct-valid-attempt",
            content: "Reassess the same bounded claim.",
        },
        context,
    );

    await followUp.wait(context);
    await until(() => calls >= 4 && !app.isBusy(controller), "the distinct equal-text outcome");
    await reconcile();
    const second = await app.pip.orchestration.contribution(researcher);

    assert.equal(second?.status, "done");
    assert.notEqual(second?.submission, first?.submission);
    assert.ok(first?.status === "done" && second?.status === "done");
    assert.notEqual(second.answer, first.answer, "equal prose never becomes an outcome identity");
    assert.equal(calls, 4);
    const inspected = await app.pip.orchestration.inspect(source, owner(app));

    assert.equal(inspected.orchestration?.lastWake?.reason, "outcome");
    assert.equal(inspected.orchestration?.lastWake?.source, Number(researcher));
    assert.equal(typeof inspected.orchestration?.usage.controller.input, "number");
    const nativeEvents = (await app.transcripts.allEntries(controller, true)).filter(
        (entry) => entry.kind === "appEvent",
    );

    assert.equal(nativeEvents.length, 2, "one event per semantic native outcome, no busy event");
    await app.close();
    app = await openApp(model, directory);
    await reconcile();
    assert.equal(
        calls,
        4,
        "native receipts recover both consumed outcomes without another model input",
    );
    assert.deepEqual(await app.pip.orchestration.contribution(researcher), second);
});

// Recovery consumes native records; only the storage read fault is injected. The other lifecycle
// tests own wake delivery. This case owns failure isolation and restoration of the projection.
test("one failed native answer read does not poison other sources or later recovery", async (t) => {
    const app = await openApp(scriptedModel(), join(root, "outcome-projection-read-failure"));
    const projection = new PipSupervision(app);

    t.after(async () => {
        await projection.close();
        await app.close();
    });
    const source = await newSession(app);
    const other = await newSession(app);
    const records: (SubmissionRecord & { type: "input"; status: "done" })[] = [];
    const entries = new Map<EntryId, EntryRecord | undefined>();

    for (const id of [source, other]) {
        const conversation = await app.conversation(id);
        const submission = await conversation.submit(
            { type: "input", content: "Native contribution.", requestId: `claim-${id}` },
            context,
        );

        await submission.wait(context);
        const record = await submission.status(context);

        assert.ok(record.type === "input" && record.status === "done");
        records.push(record);
        entries.set(record.answer, await app.transcripts.visibleEntry(id, Number(record.answer)));
    }

    let fail = true;
    const failure = new Error("Injected native entry read failure");
    const storage = {
        scanSubmissions: async (query: SubmissionQuery) => ({
            items: records.filter((record) => record.conversationId === query.conversationId),
        }),
        entry: async (id: EntryId) => {
            if (id === records[0]!.answer && fail) {
                fail = false;

                throw failure;
            }

            const entry = entries.get(id);

            return entry === undefined ? undefined : { entry, commitSeq: 1 as Seq };
        },
    } as Storage;

    await projection.recover(storage);
    await assert.rejects(projection.contribution(source), failure);
    const unaffected = await projection.contribution(other);

    assert.equal(unaffected?.status, "done");
    assert.equal(unaffected?.submission, Number(records[1]!.id));
    await projection.recover(storage);
    const recovered = await projection.contribution(source);

    assert.equal(recovered?.status, "done");
    assert.equal(recovered?.submission, Number(records[0]!.id));
    assert.deepEqual(await projection.contribution(other), unaffected);
});

test("empty final yields neither wake the controller nor erase the last attributed contribution", async (t) => {
    let controllerCalls = 0;
    let executionCalls = 0;
    const model = scriptedModel((request) => {
        const system = JSON.stringify(
            request.messages.filter((message) => message.role === "system"),
        );

        if (system.includes("the private supervisor for Work Item")) {
            controllerCalls++;

            return tool("work_supervise", {
                action: "wait",
                text: "Waiting for substantive evidence.",
            });
        }

        return text(
            executionCalls++ === 0 ? "A bounded worker claim, not a verified test result." : "",
        );
    });
    const directory = join(root, "empty-outcome-preserves-contribution");
    let app = await openApp(model, directory);

    t.after(() => app.close());
    const source = await newSession(app, app.defaultCwd, "worker");
    const execution = await app.conversation(source);
    const initial = await execution.submit(
        { type: "input", content: "Report evidence.", requestId: "claim" },
        context,
    );

    await initial.wait(context);
    const started = await activateWorkPip(app, source, owner(app), {
        text: "Observe substantive outcomes only.",
    });
    const controller = started.orchestration!.conversationId as ConversationId;

    await until(
        () => controllerCalls === 1 && !app.isBusy(controller),
        "initial owner-directed wait",
    );
    const before = await app.pip.orchestration.contribution(source);
    const empty = await execution.submit(
        { type: "input", content: "Yield with no new evidence.", requestId: "empty" },
        context,
    );

    await empty.wait(context);
    await app.pip.orchestration.open();
    assert.equal(controllerCalls, 1, "an empty settled model turn is not new evidence");
    assert.deepEqual(await app.pip.orchestration.contribution(source), before);
    await app.close();
    app = await openApp(model, directory);
    await app.pip.orchestration.open();
    assert.equal(controllerCalls, 1);
    assert.deepEqual(await app.pip.orchestration.contribution(source), before);
});
