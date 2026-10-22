/** Persistent private identities. Chats own transcripts; this registry owns approved identity and retry tombstones. */
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { defineDoc } from "@earendil-works/pi-durable";
import { currentStateCheckpoints } from "./doc-checkpoint.ts";

export type AgentCharterFields = { name: string; instructions: string; focus: string };
export type AgentCharterRevision = AgentCharterFields & {
    revision: number;
    at: number;
    by: string;
    source: "owner" | "undo" | "proposal";
};
export type AgentCharter = AgentCharterFields & {
    projectId?: string;
    revision: number;
    updatedAt: number;
    history: AgentCharterRevision[];
    proposal?: { instructions: string; expectedRevision: number; at: number };
};
export type PrivateIdentity = {
    agentId: string;
    ownerId: string;
    epoch: number;
    /** Historical inbox choice, retained as stored data only; new task reports never use it. */
    inboxChatId?: number;
    chatIds: number[];
    record: AgentCharter;
    model?: { provider: string; modelId: string };
    thinkingLevel?: ModelThinkingLevel;
    /** Absolute cumulative reasoning cap, never renewed by opening a chat. */
    maxCost?: number;
    deletedAt?: number;
};
export type AgentIdentities = {
    items: Record<string, PrivateIdentity>;
    /** Never evicted: retry after retirement/deletion cannot resurrect an identity or a chat. */
    requests: Record<string, { fingerprint: string; agentId: string; chatId: number }>;
    calls: Record<string, { fingerprint: string; agentId: string; revision: number }>;
};
export const AgentIdentitiesDoc = defineDoc<AgentIdentities>({
    kind: "pocket.agent-identities",
    version: 1,
    ...currentStateCheckpoints,
    scope: "session",
    initial: () => ({ items: {}, requests: {}, calls: {} }),
});
