// Authoring gate: the real app owns unload/restart safety and durable accepted-intent completion.
// Regressions: removing a workflow removes mandatory gates, unknown profiles become Chat, or accepted
// summaries/couriers lose their core tasks. Existing workflow tests do not cross module disposal.
// Historical profile/accepted-intent fixtures are seeded; current handoffs and all tool results are real.
import {
    type App,
    cleanUp,
    context,
    executeHandoff,
    lastText,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { SessionsDoc, SubagentsDoc } from "../src/server/docs.ts";
import { TITLE_PROMPT } from "../src/server/titles.ts";
import { HandoffsDoc } from "../src/server/workflow-docs.ts";

const apps = new Set<App>();
const holds = new Set<Gate>();
let serial = 0;

type Gate = { promise: Promise<void>; release: () => void };
type Call = { name: string; args: Parameters<typeof fauxToolCall>[1] };
type Result = { text: string; isError: boolean };
type Scenario = {
    summaryCalls: number;
    courierCalls: number;
    summaryGate?: Gate;
    planned: Map<string, Call>;
    results: Map<string, Result>;
    roles: Map<string, string>;
};

function gate(): Gate {
    let release = () => {};

    const promise = new Promise<void>((resolve) => {
        release = resolve;
    });
    const hold = { promise, release };

    holds.add(hold);

    return hold;
}

after(async () => {
    for (const hold of holds) {
        hold.release();
    }

    for (const app of apps) {
        await app.close();
    }

    cleanUp();
});

async function fixture() {
    const directory = join(root, `session-workflows-${++serial}`);
    const cwd = join(directory, "work");
    const data = join(directory, "data");
    const state: Scenario = {
        summaryCalls: 0,
        courierCalls: 0,
        planned: new Map(),
        results: new Map(),
        roles: new Map(),
    };

    mkdirSync(cwd, { recursive: true });
    const model = scriptedModel(async (input, options) => {
        const last = lastText(input);
        const lastUser = input.messages.findLast((message) => message.role === "user");
        const original =
            lastUser === undefined
                ? ""
                : lastText({ messages: [lastUser] }).text.replace(/^\[from:[^\]]+\]\s*/, "");

        if (last.role === "user" && last.text.startsWith(TITLE_PROMPT)) {
            return fauxAssistantMessage("Preserve workflow unload safety");
        }

        const sections: Record<string, string> = {};

        for (const message of input.messages) {
            if (message.role !== "system") {
                continue;
            }

            for (const [key, value] of Object.entries(message.sections ?? {})) {
                if (value === null) {
                    delete sections[key];
                } else {
                    sections[key] = value;
                }
            }
        }

        state.roles.set(original, sections.thread_role ?? "");

        if (original.startsWith("The human has requested a ")) {
            if (last.role === "user") {
                state.summaryCalls++;

                if (state.summaryGate !== undefined) {
                    const hold = state.summaryGate;
                    const signal = options?.signal;

                    await new Promise<void>((resolve, reject) => {
                        const abort = () => {
                            signal?.removeEventListener("abort", abort);
                            reject(new Error("Historical summary generation interrupted"));
                        };

                        signal?.addEventListener("abort", abort, { once: true });
                        void hold.promise.then(() => {
                            signal?.removeEventListener("abort", abort);
                            resolve();
                        });

                        if (signal?.aborted) {
                            abort();
                        }
                    });
                }

                return fauxAssistantMessage(
                    [
                        fauxToolCall("write", { path: "forbidden-summary.txt", content: "bad" }),
                        fauxToolCall("subagent", {
                            action: "spawn",
                            name: "forbidden",
                            message: "Do more work during a summary.",
                        }),
                        fauxToolCall("handoff", { action: "status" }),
                    ],
                    { stopReason: "toolUse" },
                );
            }

            return fauxAssistantMessage(
                "Ask: preserve unload safety. Source: disposable workflow fixture. " +
                    "Checks: no external checks requested. Limits: no commit or publication.",
            );
        }

        if (last.role === "user" && original.startsWith("Continue as the ")) {
            state.courierCalls++;

            return fauxAssistantMessage("Received the independent handoff once.");
        }

        const planned = state.planned.get(original);

        if (last.role === "user" && planned !== undefined) {
            return fauxAssistantMessage([fauxToolCall(planned.name, planned.args)], {
                stopReason: "toolUse",
            });
        }

        if (last.role === "toolResult") {
            const message = input.messages.at(-1)!;

            state.results.set(original, {
                text: last.text,
                isError: "isError" in message && message.isError === true,
            });
        }

        return fauxAssistantMessage("Fixture request observed.");
    });
    const app = await openApp(model, data);

    apps.add(app);

    return { app, model, data, cwd, state };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function restart(f: Fixture) {
    await f.app.close();
    apps.delete(f.app);
    f.app = await openApp(f.model, f.data);
    apps.add(f.app);
}

async function worker(f: Fixture) {
    const { id } = await f.app.commands.createSession(owner(f.app), {
        cwd: f.cwd,
        threadType: "worker",
        title: "Workflow lifecycle fixture",
    });

    await f.app.commands.configure(id, owner(f.app), {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });
    await say(f.app, id, "Establish a human requester before checking execution gates.");

    return id;
}

async function execute(f: Fixture, id: ConversationId, call: Call) {
    const body = `WORKFLOW_CALL_${crypto.randomUUID()}`;

    f.state.planned.set(body, call);
    await say(f.app, id, body);
    await until(() => !f.app.isBusy(id), "workflow tool invocation settles");
    const result = f.state.results.get(body);

    assert.ok(result, `the real ${call.name} result reached the scripted model`);

    return { result, role: f.state.roles.get(body) ?? "" };
}

async function delivered(f: Fixture, handoffId: string) {
    await until(async () => {
        const record = (await f.app.harness.snapshot(HandoffsDoc, context))?.handoffs[handoffId];

        return (
            record?.delivery === "delivered" &&
            !f.app.isBusy(record.targetThreadId as ConversationId)
        );
    }, "core handoff courier completes");
}

async function userEntries(f: Fixture, id: ConversationId) {
    const entries = await (
        await f.app.conversation(id)
    ).entries({ order: "ascending" }, 200, undefined, context);

    return entries.items.filter((entry) => entry.kind === "pi.user");
}

test("disabling Work Items retains retired and active execution gates, including nested writes", async () => {
    const f = await fixture();
    const source = await worker(f);
    const cachedSource = f.app.envFor(source);

    assert.equal((await cachedSource.writeFile("retired.txt", "original", context)).ok, true);
    const transfer = await executeHandoff(f.app, source, "researcher");
    const active = transfer.id as ConversationId;

    await delivered(f, transfer.handoffId);
    const cachedActive = f.app.envFor(active);

    assert.equal((await cachedActive.writeFile("active.txt", "original", context)).ok, true);
    await f.app.setExtensionEnabled(owner(f.app), "work-items.ts", false);

    for (const [id, env, path] of [
        [source, cachedSource, "retired.txt"],
        [active, cachedActive, "active.txt"],
    ] as const) {
        const direct = await env.writeFile(path, "forbidden direct write", context);

        assert.equal(direct.ok, false);
        assert.match(!direct.ok ? direct.error.message : "", /profile.*unavailable/i);
        // Refused before spawning. This non-repository fixture has no network target even on regression.
        const shell = await env.exec(["git", "push", "origin", "HEAD"], undefined, context);

        assert.equal(shell.ok, false);
        assert.match(!shell.ok ? shell.error.message : "", /blocked in managed shell/);
        const nested = await execute(f, id, {
            name: "codemode",
            args: {
                code: `await tools.write({path:${JSON.stringify(path)},content:"forbidden nested write"});`,
            },
        });

        assert.equal(nested.result.isError, true);
        assert.match(nested.result.text, /read-only/i);
        assert.equal(readFileSync(join(f.cwd, path), "utf8"), "original");
    }

    await f.app.setExtensionEnabled(owner(f.app), "work-items.ts", true);
    const retired = await cachedSource.writeFile("retired.txt", "still forbidden", context);

    assert.equal(retired.ok, false);
    assert.match(!retired.ok ? retired.error.message : "", /read-only/i);
    assert.equal(
        (await cachedActive.writeFile("active.txt", "resumed active work", context)).ok,
        true,
    );
    assert.equal(readFileSync(join(f.cwd, "retired.txt"), "utf8"), "original");
    assert.equal(readFileSync(join(f.cwd, "active.txt"), "utf8"), "resumed active work");
});

test("an unknown persisted profile stays unavailable rather than becoming Chat across restart", async () => {
    const f = await fixture();
    const id = await worker(f);
    const unknown = "removed-workflow:historical-agent";
    const cached = f.app.envFor(id);

    assert.equal((await cached.writeFile("identity.txt", "original", context)).ok, true);
    await f.app.harness.commit(async (tx) => {
        (await tx.doc(SessionsDoc)).items[String(id)]!.threadType = unknown;
    }, context);

    for (const phase of ["before restart", "after restart"]) {
        assert.equal(f.app.sessionMeta(id)?.threadType, unknown, phase);
        const direct = await f.app.envFor(id).writeFile("identity.txt", "forbidden", context);

        assert.equal(direct.ok, false, phase);
        assert.match(!direct.ok ? direct.error.message : "", /profile.*unavailable/i);
        const observed = await execute(f, id, {
            name: "write",
            args: { path: "identity.txt", content: "not a Chat write" },
        });

        assert.equal(observed.result.isError, true);
        assert.match(observed.result.text, /read-only/i);
        assert.match(observed.role, /agent profile is unavailable/i);
        assert.match(observed.role, /do not implement work or assume another role/i);
        assert.doesNotMatch(observed.role, /You are the Chat agent/i);
        assert.equal(readFileSync(join(f.cwd, "identity.txt"), "utf8"), "original");

        if (phase === "before restart") {
            await restart(f);
        }
    }
});

// Persisted acceptance is historical input, not a new admission path. The registered summary task
// must resume it across restart/unload, keep summary-only isolation and atomically create its one successor.
test("an already-accepted summary resumes across module disable and restart with one transfer and delivery", async () => {
    const f = await fixture();
    const source = await worker(f);
    const hold = gate();
    const instructions = "Keep this exact human direction through unload and restart.";
    const hash = (value: unknown) =>
        createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const key = hash([owner(f.app).id, Number(source), "previously-accepted-summary"]);
    const input = hash(["researcher", "same-work", null, instructions]);

    f.state.summaryGate = hold;
    const taskId = await f.app.harness.commit(async (tx) => {
        const taskId = await tx.createTask(
            f.app.handoffs.summaryTask,
            { key },
            {
                conversationId: source,
                ownership: { kind: "conversation" },
                background: true,
            },
        );
        const doc = await tx.doc(HandoffsDoc);

        doc.pending ??= {};
        doc.pending[key] = {
            sourceThreadId: Number(source),
            targetType: "researcher",
            relationship: "same-work",
            requestedBy: owner(f.app).id,
            input,
            instructions,
            targetTitle: "Accepted research",
            taskId: Number(taskId),
            attempt: 0,
            status: "pending",
        };

        return taskId;
    }, context);

    await until(() => f.state.summaryCalls === 1, "stored summary task reaches its model");
    await f.app.setExtensionEnabled(owner(f.app), "work-items.ts", false);
    assert.equal(f.app.handoffs.isPreparing(source), true);
    assert.equal(f.app.agentProfile("researcher"), undefined);
    await restart(f);
    assert.equal(f.app.agentProfile("researcher"), undefined);
    assert.equal(f.app.handoffs.isPreparing(source), true);
    assert.equal(
        (await f.app.envFor(source).writeFile("forbidden-unloaded.txt", "bad", context)).ok,
        false,
    );
    await f.app.setExtensionEnabled(owner(f.app), "work-items.ts", true);
    hold.release();
    const settled = await f.app.harness.waitForTask(taskId, context);
    const outcome = settled.state.outcome;

    assert.ok(outcome.status === "completed" && outcome.result !== null);
    const transfer = outcome.result;
    const target = transfer.id as ConversationId;

    await delivered(f, transfer.handoffId);
    const saved = await f.app.harness.snapshot(HandoffsDoc, context);

    assert.equal(saved?.pending?.[key]?.status, "completed");
    assert.equal(saved?.requests[key]?.id, Number(target));
    assert.equal(saved?.handoffs[transfer.handoffId]?.instructions, instructions);
    assert.equal(
        Object.values(saved?.handoffs ?? {}).filter(
            (record) => record.sourceThreadId === Number(source),
        ).length,
        1,
    );
    assert.equal(f.app.sessions().length, 2);
    assert.equal(f.state.courierCalls, 1);
    const sourceEntries = await (
        await f.app.conversation(source)
    ).entries({ order: "ascending" }, 200, undefined, context);
    const refused = sourceEntries.items.filter((entry) => entry.kind === "pi.tool-result");

    assert.equal(
        refused.length,
        3,
        "each summary-time tool attempt reaches the real refusal boundary",
    );
    assert.ok(
        refused.every((entry) => {
            const message = entry.model?.[0];

            return message?.role === "toolResult" && message.isError === true;
        }),
    );
    assert.equal(existsSync(join(f.cwd, "forbidden-summary.txt")), false);
    assert.equal(
        (await f.app.harness.snapshot(SubagentsDoc, source, context))?.agents.forbidden,
        undefined,
    );
    assert.equal(
        (await userEntries(f, source)).filter((entry) =>
            lastText({ messages: entry.model ?? [] }).text.includes("The human has requested a "),
        ).length,
        1,
    );
    assert.equal((await userEntries(f, target)).length, 1);
    const receipts = f.app.handoffs.receipts(source, owner(f.app));

    await f.app.setExtensionEnabled(owner(f.app), "work-items.ts", false);
    await restart(f);
    assert.deepEqual(f.app.handoffs.receipts(source, owner(f.app)), receipts);
    assert.equal(f.app.sessions().length, 2);
    assert.equal(f.state.courierCalls, 1, "completed delivery never runs again on restart");
    await f.app.setExtensionEnabled(owner(f.app), "work-items.ts", true);
    assert.equal((await f.app.envFor(target).writeFile("active.txt", "resumed", context)).ok, true);
    const retired = await f.app.envFor(source).writeFile("never-created.txt", "forbidden", context);

    assert.equal(retired.ok, false);
    assert.match(!retired.ok ? retired.error.message : "", /read-only/i);
});

// Work Items must not become a hidden dependency of the separate Agent Teams extension.
test("ordinary Chat teams keep working with Work Items disabled", async () => {
    const f = await fixture();

    await f.app.setExtensionEnabled(owner(f.app), "work-items.ts", false);
    await f.app.setExtensionEnabled(owner(f.app), "agent-teams.ts", true);
    const { id } = await f.app.commands.createSession(owner(f.app), {
        cwd: f.cwd,
        threadType: "chat",
    });

    await f.app.commands.configure(id, owner(f.app), {
        model: { provider: "faux", modelId: "faux-1" },
    });
    const team = await execute(f, id, {
        name: "team",
        args: { action: "start", message: "Help with this ordinary Chat task." },
    });

    assert.equal(team.result.isError, false, team.result.text);
    const linked = f.app.sessions().filter((session) => session.linkedFrom?.id === Number(id));

    assert.equal(linked.length, 1);
    assert.equal(linked[0]!.threadType, "chat");
    assert.equal((await f.app.handoffs.list(id, owner(f.app))).options.length, 0);
    assert.equal((await f.app.envFor(id).writeFile("chat.txt", "ordinary Chat", context)).ok, true);
    assert.equal(readFileSync(join(f.cwd, "chat.txt"), "utf8"), "ordinary Chat");
});
