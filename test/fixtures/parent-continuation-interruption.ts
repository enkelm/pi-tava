// Disposable native runtime: exit at a committed delivery/request boundary, never on live data.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { AgentSupervisionDoc } from "../../src/server/pip/agent-supervision.ts";
import { context, lastText, newSession, openApp, owner, root, scriptedModel } from "../helpers.ts";

const phase = process.argv[2]!;
const data = process.argv[3]!;
const marker = join(data, "interrupted-parent.json");
const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
    fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
let chat!: ConversationId;
let controller!: ConversationId;
let step = 0;
let parentInvocations = 0;
let captured: Record<string, unknown> | undefined;
const stop = (extra: Record<string, unknown> = {}) => {
    writeFileSync(marker, JSON.stringify({ ...captured, ...extra, parentInvocations }));
    // Deliberately no close: native delivery has not acknowledged, or the provider is in flight.
    process.exit(0);
};
const model = scriptedModel(async (request) => {
    const system = JSON.stringify(request.messages.filter((message) => message.role === "system"));
    const last = lastText(request);

    if (system.includes("the owner's persistent private agent")) {
        if (last.role === "user" && last.text.includes("App registered continuation")) {
            parentInvocations++;

            if (phase === "running") {
                const state = (await app.harness.snapshot(AgentSupervisionDoc, context))!;
                const task = Object.values(state.parentTasks!)[0]!;
                const native = await app.harness.commit(
                    (tx) => tx.submissionByRequest(chat, task.wake!.requestId),
                    context,
                );

                stop({ nativeSubmission: Number(native!.id) });
            }

            throw new Error("The fixture missed its selected pre-provider crash boundary.");
        }

        if (step++ === 0) {
            return tool("agent_work", {
                action: "send",
                session: Number(controller),
                text: "Inspect A within the original owner scope, then explicitly finish.",
            });
        }

        const requestId = /"requestId":"([^"]+)"/.exec(last.text)?.[1];

        if (!requestId || !last.text.includes('"status":"accepted"')) {
            throw new Error(`Registered send did not reach continuation wait: ${last.text}`);
        }

        return tool("work_supervise", {
            action: "wait",
            text: "Await the exact accepted A assignment.",
            continuation: {
                requestId,
                remaining: "Inspect A; ask before expanding original scope.",
            },
        });
    }

    if (system.includes("the private supervisor for Work Item")) {
        return tool("work_supervise", { action: "finish", text: "A's native evidence is ready." });
    }

    return fauxAssistantMessage("Unrelated naming fixture.");
});
const app = await openApp(model, data);

mkdirSync(data, { recursive: true });
const source = await newSession(app, app.defaultCwd, "worker");

controller = (await app.pip.orchestration.control(source, owner(app), { action: "open" }))
    .orchestration!.conversationId as ConversationId;
chat = (
    await app.pip.agents.create(owner(app), {
        name: "Interrupted parent",
        requestId: "interrupted-parent",
    })
).id as ConversationId;
app.harness.subscribeCommits((publication) => {
    for (const change of publication.changes) {
        if (
            change.type === "document" &&
            change.record.kind === AgentSupervisionDoc.definition.kind
        ) {
            const doc = change.value as {
                parentTasks?: Record<
                    string,
                    {
                        authority: { inputId?: number; admissionSerial?: number };
                        wake?: { id: string; requestId: string };
                    }
                >;
            };
            const entry = Object.entries(doc.parentTasks ?? {}).find(([, task]) => task.wake);

            if (entry !== undefined) {
                const [key, task] = entry;

                captured = {
                    fixtureRoot: root,
                    chat,
                    controller,
                    key,
                    ownerInputId: task.authority.inputId,
                    ownerSerial: task.authority.admissionSerial,
                    wakeId: task.wake!.id,
                    wakeRequestId: task.wake!.requestId,
                };

                if (phase === "pre-submit") {
                    stop();
                }
            }
        }

        if (
            phase === "accepted" &&
            captured !== undefined &&
            change.type === "submission" &&
            change.value.type === "input" &&
            change.value.requestId === captured.wakeRequestId
        ) {
            stop({ nativeSubmission: Number(change.value.id) });
        }
    }
});
await app.commands.submit(chat, owner(app), {
    text: "Inspect A only under this accepted owner instruction; no new scope, commits or publication.",
    requestId: "interrupted-owner-task",
});
setTimeout(() => process.exit(2), 10_000);
