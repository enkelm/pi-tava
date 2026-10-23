// Regression owner: the registered work_context admission, not a fake parentContext callback.
// Native send/wait creates the task; only provider decisions are scripted. Existing snapshot
// tests cover ordinary Work Items, but cannot reach a private Chat through this tool admission.
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { awaitWithContext, withAbortSignal } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import {
    cleanUp,
    context,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";

after(cleanUp);

type Snapshot = {
    revision: string;
    sectionRevisions: Record<string, string>;
    changed: string[];
    sections: {
        scope?: {
            parentTasks?: {
                ownerInputId: number;
                status: string;
                remaining: string;
                dependency: { requestId: string; controller: number; submission: number };
                admittedWakes: number;
                paidWakes: number;
            }[];
        };
    };
};

function parse<T>(text: string): T {
    // Private tool results retain the ordinary session-data fence.
    return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
}

const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
    fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

test("registered private snapshot/delta reaches only the exact origin's compact parent tasks", async (t) => {
    let origin!: ConversationId;
    let sibling!: ConversationId;
    let controller!: ConversationId;
    let baseline: Snapshot | undefined;
    let changed: Snapshot | undefined;
    let unchanged: Snapshot | undefined;
    let siblingSnapshot: Snapshot | undefined;
    let receipt: { requestId: string; submissionId: number } | undefined;
    let phase = "baseline";
    let siblingPhase = "own";
    const siblingDenials: string[] = [];
    let controllerCalls = 0;
    const remaining = `origin-private-remaining: ${'"\n'.repeat(850)}`;
    const outcome = Promise.withResolvers<void>();
    const model = scriptedModel(async (request, options) => {
        const system = JSON.stringify(
            request.messages.filter((message) => message.role === "system"),
        );
        const last = lastText(request);

        if (system.includes("the private supervisor for Work Item")) {
            controllerCalls++;
            await awaitWithContext(
                outcome.promise,
                options?.signal ? withAbortSignal(options.signal, context) : context,
            );

            return tool("work_supervise", {
                action: "finish",
                text: "The exact assignment settled.",
            });
        }

        if (system.includes(`this chat /s/${origin} owns only its transcript`)) {
            if (phase === "baseline") {
                phase = "send";

                return tool("work_context", { session: Number(origin), action: "snapshot" });
            }

            if (phase === "send") {
                baseline = parse<Snapshot>(last.text);
                assert.deepEqual(baseline.sections.scope?.parentTasks, []);
                phase = "register";

                return tool("agent_work", {
                    action: "send",
                    session: Number(controller),
                    text: "Settle this bounded assignment, then explicitly finish. Do not dispatch further work.",
                });
            }

            if (phase === "register") {
                const accepted = parse<{ status: string; requestId: string; submissionId: number }>(
                    last.text,
                );

                assert.equal(accepted.status, "accepted");
                receipt = accepted;
                phase = "waiting";

                return tool("work_supervise", {
                    action: "wait",
                    text: "Keep the bounded owner task suspended.",
                    continuation: { requestId: accepted.requestId, remaining },
                });
            }

            if (phase === "waiting") {
                assert.equal(last.role, "user");
                assert.match(last.text, /App registered continuation/);
                assert.ok(baseline);
                phase = "changed";

                return tool("work_context", {
                    session: Number(origin),
                    action: "delta",
                    sinceRevision: baseline.revision,
                    sectionRevisions: baseline.sectionRevisions,
                });
            }

            if (phase === "changed") {
                changed = parse<Snapshot>(last.text);
                phase = "unchanged";

                return tool("work_context", {
                    session: Number(origin),
                    action: "delta",
                    sinceRevision: changed.revision,
                    sectionRevisions: changed.sectionRevisions,
                });
            }

            if (phase === "unchanged") {
                unchanged = parse<Snapshot>(last.text);
                phase = "done";

                return tool("work_supervise", {
                    action: "finish",
                    text: "Private task projection inspected; no further dispatch is needed.",
                });
            }

            throw new Error(`Unexpected parent invocation during ${phase}: ${last.text}`);
        }

        if (system.includes(`this chat /s/${sibling} owns only its transcript`)) {
            if (siblingPhase === "own") {
                siblingPhase = "thread-target";

                return tool("work_context", { session: Number(sibling), action: "snapshot" });
            }

            if (siblingPhase === "thread-target") {
                siblingSnapshot = parse<Snapshot>(last.text);
                siblingPhase = "foreign";

                return tool("work_context", {
                    session: Number(sibling),
                    threadId: Number(origin),
                    action: "snapshot",
                });
            }

            if (siblingPhase === "foreign") {
                siblingDenials.push(last.text);
                siblingPhase = "denied";

                return tool("work_context", { session: Number(origin), action: "snapshot" });
            }

            siblingDenials.push(last.text);

            return fauxAssistantMessage("Another Chat's private coordination is not available.");
        }

        return fauxAssistantMessage("No unrelated work.");
    });
    const app = await openApp(model, join(root, "registered-private-parent-context"));

    t.after(() => app.close());
    const user = owner(app);
    const source = await newSession(app, app.defaultCwd, "worker");

    controller = (await app.pip.orchestration.control(source, user, { action: "open" }))
        .orchestration!.conversationId as ConversationId;
    origin = (await app.pip.agents.create(user, { name: "Snapshot parent", requestId: "parent" }))
        .id as ConversationId;
    sibling = (await app.pip.agents.newChat(origin, user, { requestId: "sibling" }))
        .id as ConversationId;
    const ownerInput = await app.commands.submit(origin, user, {
        text: "Inspect this Chat's tasks, send a bounded request and wait on the exact controller. When it finishes, inspect this Chat's task delta and finish without further dispatch.",
        requestId: "owner-parent-task",
    });

    await until(
        async () =>
            phase === "waiting" &&
            !app.isBusy(origin) &&
            (await app.pip.agents.supervision.parentContext(origin, user))[0]?.status === "waiting",
        "real registered send/wait creates the parent task",
    );
    const callsBeforeRead = controllerCalls;

    outcome.resolve();
    await until(() => phase === "done" && !app.isBusy(origin), "registered snapshot deltas finish");
    assert.ok(baseline);
    assert.ok(changed);
    assert.ok(unchanged);
    assert.ok(receipt);
    assert.ok(changed.changed.includes("scope"));
    const tasks = changed.sections.scope?.parentTasks;

    assert.equal(tasks?.length, 1);
    const task = tasks![0]!;

    assert.equal(task.ownerInputId, Number(ownerInput.submissionId));
    assert.equal(task.status, "running");
    assert.deepEqual(task.dependency, {
        requestId: receipt.requestId,
        controller: Number(controller),
        submission: receipt.submissionId,
    });
    assert.match(task.remaining, /^origin-private-remaining:/);
    assert.notEqual(task.remaining, remaining, "long task prose is compact, not repeated in full");
    assert.ok(Buffer.byteLength(JSON.stringify(task.remaining)) <= 600);
    assert.equal(task.admittedWakes, 1);
    assert.equal(task.paidWakes, 0, "the scripted provider reports zero cost, not a paid wake");
    assert.equal(unchanged.sectionRevisions.scope, changed.sectionRevisions.scope);
    assert.ok(!unchanged.changed.includes("scope"));
    assert.equal(unchanged.sections.scope, undefined, "unchanged task prose is omitted");
    assert.equal(controllerCalls, callsBeforeRead, "context reads do not activate controller work");
    assert.equal(
        (await app.transcripts.allEntries(origin, true)).filter(
            (entry) => entry.kind === "toolResult" && entry.isError,
        ).length,
        0,
        "the actual private tool admissions succeed",
    );

    await app.commands.submit(sibling, user, {
        text: "Inspect my own snapshot, then try the other Chat as an explicit negative control.",
        requestId: "sibling-negative",
    });
    await until(
        () => siblingDenials.length === 2 && !app.isBusy(sibling),
        "registered same-identity other-Chat negative settles",
    );
    assert.deepEqual(siblingSnapshot?.sections.scope?.parentTasks, []);
    const siblingErrors = (await app.transcripts.allEntries(sibling, true)).filter(
        (entry) => entry.kind === "toolResult" && entry.isError,
    );

    assert.equal(siblingErrors.length, 2, "both explicit foreign-Chat selections are refused");
    assert.doesNotMatch(siblingDenials.join("\n"), /origin-private-remaining|ownerInputId/);

    // The shared adapter can read this explicitly authorized source, but never its private ledger.
    const privateRead = t.mock.method(app.pip.agents.supervision, "parentContext", async () => {
        throw new Error("The shared adapter must not load the private parent ledger");
    });
    const shared = await app.workItems
        .reader(origin, async () => user, context, "shared")
        .read({
            type: "toolCall",
            id: "shared-negative",
            name: "work_context",
            arguments: { action: "snapshot" },
        });

    assert.equal(privateRead.mock.callCount(), 0);
    privateRead.mock.restore();
    assert.equal((shared as Snapshot).sections.scope?.parentTasks, undefined);
    assert.doesNotMatch(JSON.stringify(shared), /origin-private-remaining|ownerInputId/);
});
