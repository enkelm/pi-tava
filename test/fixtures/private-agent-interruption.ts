// Disposable subprocess fixture: exit at a committed native boundary, never patch a collaborator.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { AgentSupervisionDoc } from "../../src/server/pip/agent-supervision.ts";
import { lastText, newSession, openApp, owner, root, scriptedModel } from "../helpers.ts";

const phase = process.argv[2];
const data = process.argv[3]!;
let source!: ConversationId;
let controllerCalls = 0;
const model = scriptedModel((request) => {
    const system = JSON.stringify(request.messages.filter((message) => message.role === "system"));

    if (
        system.includes("the owner's persistent private agent") &&
        lastText(request).role === "user"
    ) {
        return fauxAssistantMessage(
            [
                fauxToolCall("agent_work", {
                    action: "delegate",
                    session: Number(source),
                    text: "Observe the existing native work; do not resend it.",
                }),
            ],
            { stopReason: "toolUse" },
        );
    }

    if (system.includes("the private supervisor for Work Item")) {
        controllerCalls++;

        return fauxAssistantMessage("INTERRUPTED_NATIVE_OBSERVATION");
    }

    return fauxAssistantMessage("Coordinator acknowledged native admission.");
});
const app = await openApp(model, data);

source = await newSession(app, app.defaultCwd, "worker");
const agent = await app.pip.agents.create(owner(app), {
    name: "Crash recovery",
    requestId: "crash-identity",
});
const firstChat = agent.id as ConversationId;
const chat = (await app.pip.agents.newChat(firstChat, owner(app), { requestId: "crash-chat" }))
    .id as ConversationId;

app.harness.subscribeCommits((publication) => {
    for (const change of publication.changes) {
        if (
            change.type !== "document" ||
            change.record.kind !== AgentSupervisionDoc.definition.kind
        ) {
            continue;
        }

        const doc = change.value as {
            requests?: Record<string, { status: string }>;
            outbox?: Record<string, { status: string }>;
        };
        const receipts = phase === "admission" ? doc.requests : doc.outbox;

        if (Object.values(receipts ?? {}).some((receipt) => receipt.status === "pending")) {
            writeFileSync(
                join(data, "interrupted.json"),
                JSON.stringify({
                    firstChat,
                    chat,
                    source,
                    controller: app.workItems.itemFor(source)!.supervisor!.conversationId,
                    controllerCalls,
                    fixtureRoot: root,
                }),
            );
            // This is deliberately not graceful close: the effect/delivered receipt has not run.
            process.exit(0);
        }
    }
});
await app.commands.submit(chat, owner(app), {
    text: "Discover and contact the existing native work within its current human scope.",
    requestId: "crash-delegate",
});
// Reaching this deadline instead of the selected committed boundary is a fixture failure.
setTimeout(() => process.exit(2), 10_000);
