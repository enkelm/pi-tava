/** Inert pre-redesign storage contracts. Kept registered unchanged; active identities and Memory never read/write them. */
import { defineDoc } from "@earendil-works/pi-durable";
import { currentStateCheckpoints } from "./doc-checkpoint.ts";

export type PrivateAgentFields = {
    name: string;
    instructions: string;
    notes: string;
    /** Legacy freeform remit only; never a project association, directory or access grant. */
    focus: string;
};

export type PrivateAgentRevision = PrivateAgentFields & {
    revision: number;
    at: number;
    by: string;
    source: "owner" | "notes" | "undo" | "proposal";
};

export type PrivateAgentProposal = {
    instructions: string;
    /** The observed revision the proposal was based on, not authority to apply it. */
    expectedRevision: number;
    at: number;
};

export type PrivateAgentCallResult = {
    revision: number;
    notes: string;
    proposal?: PrivateAgentProposal;
};

export type PrivateAgentState = PrivateAgentFields & {
    /** Explicit creation-time remit only. Immutable across revisions; never SessionMeta membership or authority. */
    projectId?: string;
    revision: number;
    updatedAt: number;
    /** Bounded explicit snapshots; undo appends a new revision, never rewinds the counter. */
    history: PrivateAgentRevision[];
    /** One bounded pending draft, never rendered as active instructions. Owner saves/undo clear it. */
    proposal?: PrivateAgentProposal;
};

/** Latest storage plus explicit bounded undo history. Forks start without the private charter or notebook. */
export const PrivateAgentDoc = defineDoc<{ record?: PrivateAgentState }>({
    kind: "pocket.private-agent",
    version: 1,
    ...currentStateCheckpoints,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({}),
});

/** Creation publishes the catalogue, charter and retry receipt together. Never sent to rooms. */
export const PrivateAgentCreatesDoc = defineDoc<{
    items: Record<string, { id: number; fingerprint: string }>;
}>({
    kind: "pocket.private-agent-creates",
    version: 1,
    ...currentStateCheckpoints,
    scope: "session",
    initial: () => ({ items: {} }),
});

/** Task lifetime is the replay lifetime. Receipts commit atomically with notes, without rolling eviction. */
export const PrivateAgentCallsDoc = defineDoc<{
    items: Record<string, { fingerprint: string; result: PrivateAgentCallResult }>;
}>({
    kind: "pocket.private-agent-calls",
    version: 1,
    ...currentStateCheckpoints,
    scope: "task",
    initial: () => ({ items: {} }),
});
