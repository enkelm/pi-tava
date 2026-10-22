/** Private diagnostics cross real tool admission and Durable reads, never shell-based inspection. */
import {
    cleanUp,
    context,
    lastText,
    modelTexts,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
    type App,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AgentDoc, type ConversationId, type TaskId } from "@earendil-works/pi-durable";
import { DiagnosticsDoc, SessionsDoc } from "../src/server/docs.ts";
import { PIP_EXTENSION } from "../src/server/pip.ts";
import {
    DIAGNOSTIC_RECORDS,
    DiagnosticRecorder,
    retainDiagnostics,
    type DiagnosticJournal,
} from "../src/server/diagnostics/recorder.ts";

const secret = "DO-NOT-DISCLOSE-diagnostic-fixture";
const route = scriptedModel((request) => {
    const last = lastText(request as never);
    const text = last.text.replace(/^\[from:[^\]]+\]\s*/, "");

    if (last.role === "toolResult") {
        return fauxAssistantMessage([fauxText(`result: ${last.text}`)]);
    }

    if (text === "fail-read") {
        return fauxAssistantMessage([fauxToolCall("read", { path: `/missing/${secret}` })], {
            stopReason: "toolUse",
        });
    }

    if (text === "nested-fail-read") {
        return fauxAssistantMessage(
            [
                fauxToolCall("codemode", {
                    code: `try { await tools.read({ path: '/missing/${secret}' }); } catch { text('caught'); }`,
                }),
            ],
            { stopReason: "toolUse" },
        );
    }

    if (text === "successful-read") {
        return fauxAssistantMessage(
            [fauxToolCall("read", { path: join(root, "diagnostic-readable.txt") })],
            { stopReason: "toolUse" },
        );
    }

    if (text.startsWith("diagnose ")) {
        const { name, args } = JSON.parse(text.slice(9));

        return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
    }

    return fauxAssistantMessage([fauxText("ok")]);
});
let app: App;

after(async () => {
    await app?.close();
    cleanUp();
});

async function privatePip() {
    const id = await app.pip.ensure(owner(app));

    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });

    return id;
}

async function call(id: ConversationId, name: string, args: object) {
    await say(app, id, `diagnose ${JSON.stringify({ name, args })}`);
    const result = (await app.transcripts.allEntries(id, true)).findLast(
        (entry) => entry.kind === "toolResult" && entry.name === name,
    );

    assert.ok(result?.kind === "toolResult", `tool result for ${name}`);

    return result;
}

test("retention bounds observations while keeping distinct replay identities and isolating observer faults", async () => {
    const journal: DiagnosticJournal = { records: [], evicted: 0, since: Date.now() };
    const recorder = new DiagnosticRecorder((record) => retainDiagnostics(journal, [record]));
    let executions = 0;
    const meta = {
        conversationId: 1,
        taskId: 1,
        operationId: "logical-call",
        component: "tool",
        stage: "execute",
        operation: "read",
    } as const;

    for (let i = 0; i < DIAGNOSTIC_RECORDS + 1; i++) {
        await recorder.observe(meta, async () => ++executions);
    }

    assert.equal(executions, DIAGNOSTIC_RECORDS + 1);
    assert.equal(journal.records.length, DIAGNOSTIC_RECORDS);
    assert.equal(journal.evicted, 1);
    assert.equal(new Set(journal.records.map((record) => record.id)).size, DIAGNOSTIC_RECORDS);
    assert.equal(new Set(journal.records.map((record) => record.operationId)).size, 1);
    assert.ok(
        journal.records.every((record) => record.outcome === "ok" && record.endedAt !== undefined),
    );

    const broken = new DiagnosticRecorder(() => {
        throw new Error(secret);
    });
    const failure = new Error(secret);

    assert.equal(await broken.observe(meta, async () => ++executions), DIAGNOSTIC_RECORDS + 2);
    await assert.rejects(
        broken.observe(meta, async () => {
            executions++;

            throw failure;
        }),
        (error) => error === failure,
    );
    assert.equal(
        executions,
        DIAGNOSTIC_RECORDS + 3,
        "observer trouble never repeats business operations",
    );
    assert.equal(broken.dropped, 4);
});

test("global private tools diagnose real failed calls, redact payloads, paginate scope and retain evidence on reopen", async () => {
    const data = join(root, "diagnostics-data");

    app = await openApp(route, data);
    const sessions: ConversationId[] = [];

    for (let i = 0; i < 4; i++) {
        sessions.push(await newSession(app));
    }

    const target = sessions[0]!;
    const pip = await privatePip();

    await say(app, target, "fail-read");
    await say(app, target, "fail-read");
    await until(
        async () =>
            ((await app.harness.snapshot(DiagnosticsDoc, target, context))?.records.filter(
                (record) =>
                    record.component === "tool" &&
                    record.stage === "execute" &&
                    record.outcome !== "running",
            ).length ?? 0) >= 2,
        "failed execute observations persisted",
    );

    const failed = await call(pip, "collab_failures", {
        scope: { kind: "session", id: Number(target) },
    });

    assert.equal(failed.isError, false);
    assert.ok(
        !failed.text.includes(secret),
        "no path, result, free-form exception or tool arguments in diagnostics",
    );
    const result = JSON.parse(failed.text);
    const incident = result.incidents.find(
        (item: { component: string; stage: string }) =>
            item.component === "tool" && item.stage === "execute",
    );

    assert.ok(incident);
    assert.equal(incident.observations, 2);
    assert.equal(
        incident.logicalOperations,
        2,
        "separate task/assistant episodes retain distinct logical identities",
    );
    assert.deepEqual(incident.sessions, [Number(target)]);
    assert.equal(result.coverage.complete, false);
    assert.ok(result.definitions.some((note: string) => note.includes("not lifetime")));
    const observation = incident.evidence[0].observation;
    const trace = JSON.parse(
        (await call(pip, "collab_trace", { session: Number(target), observation })).text,
    );

    assert.equal(trace.observation.id, observation);
    assert.equal(trace.observation.conversationId, Number(target));
    assert.ok(trace.task?.id);
    assert.ok(!JSON.stringify(trace).includes(secret));
    assert.ok(Buffer.byteLength(JSON.stringify(trace)) <= 32 * 1024);

    const first = JSON.parse(
        (await call(pip, "collab_failures", { scope: { kind: "owner" } })).text,
    );

    assert.equal(first.coverage.scopeConversations, 4);
    assert.equal(first.coverage.pageConversations.length, 3);
    assert.ok(first.cursor);
    const changedScope = await call(pip, "collab_failures", {
        scope: { kind: "session", id: Number(target) },
        cursor: first.cursor,
    });

    assert.equal(changedScope.isError, true);
    assert.match(changedScope.text, /different caller or scope/);
    const second = JSON.parse(
        (await call(pip, "collab_failures", { scope: { kind: "owner" }, cursor: first.cursor }))
            .text,
    );

    assert.deepEqual(second.coverage.pageConversations, [Number(sessions[3])]);
    assert.equal(second.cursor, null);

    const status = JSON.parse(
        (await call(pip, "collab_status", { scope: { kind: "session", id: Number(target) } })).text,
    );

    assert.equal(status.health, "unknown");
    assert.deepEqual(status.tasks, []);
    assert.ok(
        !status.coverage.pageConversations.includes(Number(pip)),
        "private conversation metadata stays outside execution scope",
    );

    const answer = (await app.transcripts.allEntries(target, true)).findLast(
        (entry) => entry.kind === "assistant",
    );
    const fork = await app.commands.fork(target, owner(app), { entryId: answer!.id });
    const forkJournal = await app.harness.snapshot(DiagnosticsDoc, fork.id, context);

    assert.deepEqual(
        forkJournal?.records ?? [],
        [],
        "inherited source history is not a new execution observation",
    );
    assert.equal(forkJournal?.evicted ?? 0, 0);

    await app.close();
    app = await openApp(route, data);
    const recovered = JSON.parse(
        (await call(pip, "collab_trace", { session: Number(target), observation })).text,
    );

    assert.equal(
        recovered.observation.id,
        observation,
        "observation evidence survives process reopen without replaying work",
    );
    assert.ok(!(await modelTexts(app, target)).some((text) => text.includes("diagnose")));
});

test("direct and nested tool failures keep independent denominators and recovery evidence", async () => {
    const target = await newSession(app);
    const pip = await privatePip();

    await writeFile(join(root, "diagnostic-readable.txt"), "readable fixture");
    await say(app, target, "fail-read");
    await say(app, target, "nested-fail-read");
    await say(app, target, "successful-read");
    await until(
        async () =>
            (await app.harness.snapshot(DiagnosticsDoc, target, context))?.records.some(
                (record) =>
                    record.component === "tool" &&
                    record.stage === "execute" &&
                    record.operation === "read" &&
                    record.outcome === "ok",
            ) === true,
        "successful direct read persisted after both failure populations",
    );
    const report = JSON.parse(
        (await call(pip, "collab_failures", { scope: { kind: "session", id: Number(target) } }))
            .text,
    );
    const populations = report.populations.filter((row: { population: string }) => {
        const key = JSON.parse(row.population);

        return key[0] === "tool" && key[1] === "execute" && key[2] === "read";
    });
    const incidents = report.incidents.filter(
        (row: { component: string; stage: string; operation: string }) =>
            row.component === "tool" && row.stage === "execute" && row.operation === "read",
    );

    assert.equal(populations.length, 2, "direct and nested reads are not one denominator");
    assert.deepEqual(
        populations
            .map((row: { nesting: string; observations: number; ok: number }) => ({
                nesting: row.nesting,
                observations: row.observations,
                ok: row.ok,
            }))
            .sort((a: { nesting: string }, b: { nesting: string }) =>
                a.nesting.localeCompare(b.nesting),
            ),
        [
            { nesting: "direct", observations: 2, ok: 1 },
            { nesting: "nested", observations: 1, ok: 0 },
        ],
    );
    assert.equal(incidents.length, 2);
    assert.deepEqual(
        incidents.find((row: { nesting: string }) => row.nesting === "direct").recoveredSessions,
        [Number(target)],
    );
    assert.deepEqual(
        incidents.find((row: { nesting: string }) => row.nesting === "nested").recoveredSessions,
        [],
        "a later direct success is not evidence of nested recovery",
    );
});

test("diagnostics remain readable without constructing a broken source SSH environment", async () => {
    const target = await newSession(app);
    const pip = await privatePip();
    const envFor = app.sshSessions.envFor;
    let attempted = 0;

    await app.harness.commit(async (tx) => {
        (await tx.doc(SessionsDoc)).items[String(target)]!.location = {
            kind: "ssh",
            host: "diagnostic-fixture.invalid",
        };
    }, context);

    app.sshSessions.envFor = () => {
        attempted++;

        throw Object.assign(new Error(secret), { code: "ECONNREFUSED" });
    };

    try {
        await say(app, target, "the environment fails before model/tool execution");
        await until(
            async () =>
                (await app.harness.snapshot(DiagnosticsDoc, target, context))?.records.some(
                    (record) => record.component === "environment" && record.outcome === "failure",
                ) === true,
            "source setup failure persisted",
        );
        const before = attempted;
        const result = await call(pip, "collab_failures", {
            scope: { kind: "session", id: Number(target) },
        });
        const report = JSON.parse(result.text);

        assert.equal(result.isError, false);
        assert.equal(attempted, before, "inspection makes no new source SSH/environment attempt");
        assert.ok(
            report.incidents.some(
                (incident: { component: string; stage: string; cause: string }) =>
                    incident.component === "environment" &&
                    incident.stage === "construct" &&
                    incident.cause === "transport",
            ),
        );
        assert.ok(!result.text.includes(secret));
        assert.ok(!result.text.includes("diagnostic-fixture.invalid"));
    } finally {
        app.sshSessions.envFor = envFor;
    }
});

test("private reader denies ordinary and named callers before storage and fences owner revocation after an awaited read", async () => {
    const target = await newSession(app);
    const pip = await privatePip();
    const managed = await newSession(app, undefined, "worker");

    await app.pip.orchestration.control(managed, owner(app), { action: "open" });
    const controller = (await app.pip.orchestration.inspect(managed, owner(app))).orchestration!
        .conversationId as ConversationId;
    const named = await app.pip.agents.create(owner(app), {
        name: "No global diagnostic authority",
        requestId: "diagnostic-named-denial",
    });
    const namedChat = named.id as ConversationId;
    let reads = 0;
    const original = app.harness.snapshot.bind(app.harness);

    app.harness.snapshot = ((...args: Parameters<typeof original>) => {
        if (Object.is(args[0], DiagnosticsDoc)) {
            reads++;
        }

        return Reflect.apply(original, app.harness, args);
    }) as typeof app.harness.snapshot;

    try {
        for (const caller of [target, controller, namedChat, 999999 as ConversationId]) {
            await assert.rejects(
                app.diagnostics.failures(
                    { conversationId: caller, taskId: 999999 as TaskId },
                    { kind: "owner" },
                    undefined,
                    context,
                ),
                /global private PiP/,
            );
        }

        assert.equal(reads, 0);
        await app.harness.commit(async (tx) => {
            (await tx.doc(AgentDoc, target)).extensions = { add: [PIP_EXTENSION] };
        }, context);
        const denial = await call(target, "collab_failures", { scope: { kind: "owner" } });

        assert.equal(
            denial.isError,
            true,
            "offering a private tool to an ordinary coding agent cannot confer private authority",
        );
        assert.match(denial.text, /global private PiP/);
        assert.equal(reads, 0);
    } finally {
        app.harness.snapshot = original;
    }

    let revoke = true;

    app.harness.snapshot = (async (...args: Parameters<typeof original>) => {
        const value = await Reflect.apply(original, app.harness, args);

        if (Object.is(args[0], DiagnosticsDoc) && revoke) {
            revoke = false;
            app.config.rotateOwnerToken();
        }

        return value;
    }) as typeof app.harness.snapshot;

    try {
        const fenced = await call(pip, "collab_failures", {
            scope: { kind: "session", id: Number(target) },
        });

        assert.equal(fenced.isError, true);
        assert.match(fenced.text, /authority changed/);
        assert.ok(
            !fenced.text.includes('"incidents"'),
            "no private results return after revocation",
        );
    } finally {
        app.harness.snapshot = original;
    }
});
