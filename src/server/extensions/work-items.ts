/** Work Items, human-requested handoffs and the default agent profiles. Core retains permissions and durable transfers. */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { ExtensionWeb, PocketHost } from "../host.ts";
import type { SessionWorkflowTransition } from "../session-workflows.ts";
import { AGENT_ROLES, DEFAULT_AGENT_PROMPTS } from "./_work-item-profiles.ts";

const titles: Record<string, string> = {
    chat: "Chat",
    researcher: "Focused research",
    worker: "Implementation",
    reviewer: "Review",
    "follow-up": "Follow-up work",
    pull: "Pull upstream",
    land: "Land local work",
    publish: "Publish",
};
const icons: Record<string, string> = {
    chat: "chat",
    worker: "bot",
    researcher: "search",
    reviewer: "search",
    "follow-up": "pencil",
    pull: "reload",
    land: "fork",
    publish: "external",
};
const next: Record<string, string[]> = {
    chat: ["worker", "researcher"],
    worker: ["reviewer", "researcher"],
    reviewer: ["follow-up", "worker", "land", "researcher"],
    researcher: ["worker", "follow-up"],
    "follow-up": ["land", "worker"],
    pull: ["worker", "researcher", "follow-up"],
    land: ["publish", "worker", "follow-up"],
    publish: [],
};

export default function workItems(host: PocketHost, web: ExtensionWeb) {
    const transitions: SessionWorkflowTransition[] = [];

    for (const { type } of AGENT_ROLES) {
        const same = new Set([...next[type]!, "pull", "land"]);

        same.delete(type);

        for (const to of same) {
            transitions.push({
                from: type,
                to,
                relationship: "same-work",
                ...(to === "follow-up" ? { historyAny: ["reviewer", "pull"] } : {}),
                ...(to === "land" && !next[type]!.includes("land")
                    ? { historyAny: ["reviewer"] }
                    : {}),
                ...(type === "worker" && to === "reviewer" ? { currentDiff: true } : {}),
            });
        }

        for (const to of ["worker", "researcher", "pull"]) {
            transitions.push({ from: type, to, relationship: "new-work" });
        }
    }

    web.workflow({
        id: "work-items",
        profiles: AGENT_ROLES.map(({ type, name, description }) => ({
            id: type,
            name,
            description,
            prompt: DEFAULT_AGENT_PROMPTS[type]!,
            title: titles[type]!,
            icon: icons[type]!,
            starter: ["chat", "worker", "researcher", "pull"].includes(type),
        })),
        transitions,
    });

    web.client("work-items", { access: "conversation" });
    web.sessionRoute("GET", "handoffs", ({ session }) => session.transfers.status(), {
        access: "view",
    });
    web.sessionRoute(
        "POST",
        "work-item",
        ({ session, body }) => session.transfers.updateGroup(body),
        { access: "steer" },
    );

    const handoff = defineTool({
        name: "handoff",
        description:
            "Inspect workflow state and eligible destinations, or execute a human-requested handoff with a compact summary. Explicit /handoff routes must match. Infer a role for ordinary English/freeform direction; ask follow-ups before starting when ambiguous or unavailable. Only the main thread can start, after all other work has settled. Incoming couriers alone cannot authorize another handoff.",
        replay: "safe",
        executionMode: "sequential",
        parameters: Type.Union([
            Type.Object({ action: Type.Literal("status") }, { additionalProperties: false }),
            Type.Object(
                {
                    action: Type.Literal("start"),
                    // A registered ID is at most 64 module + ':' + 64 local characters.
                    targetType: Type.String({ minLength: 1, maxLength: 129 }),
                    relationship: Type.Optional(
                        Type.Union([Type.Literal("same-work"), Type.Literal("new-work")]),
                    ),
                    summary: Type.String({ minLength: 1, maxLength: 12_000 }),
                },
                { additionalProperties: false },
            ),
        ]),
        execute: async (request, api, ctx) => ({
            content: [
                {
                    type: "text",
                    text: JSON.stringify(await host.sessions.handoff(request, api, ctx)),
                },
            ],
        }),
    });

    return defineExtension({ name: "pocket-work-items", tools: [handoff] });
}
