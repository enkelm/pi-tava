/** Durable handoff grouping and per-thread workflow state; no executable context reset or task ownership. */
import { defineDoc } from "@earendil-works/pi-durable";

export type ThreadType = "chat" | "worker" | "reviewer" | "follow-up" | "pull" | "land" | "publish";
export type Relationship = "same-work" | "new-work";
export type WorkflowStatus = "active" | "review-complete" | "landed" | "published" | "needs-review";
export type Recommendation = {
    targetType: ThreadType;
    relationship: Relationship;
    reason?: string;
};
export type Proposal = { targetType: ThreadType; relationship: Relationship; brief: string };
export type CodeFingerprint = { digest: string; cwd: string; head: string; status: string };
export type Workflow = {
    readOnly: boolean;
    status: WorkflowStatus;
    readyForPublish?: boolean;
    summary?: string;
    recommendations?: Recommendation[];
    proposal?: Proposal;
    fingerprint?: CodeFingerprint;
    completedAt?: number;
    completedBy?: string;
    /** Invocation receipts are private and are not projected into the room or HTTP response. */
    receipts: Record<string, string>;
};

export const WorkflowDoc = defineDoc<Workflow>({
    kind: "pocket.workflow",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ readOnly: false, status: "active", receipts: {} }),
});

export type WorkItem = {
    id: string;
    originThreadId: number;
    activeThreadId: number;
    threadIds: number[];
    title: string;
    projectId?: string;
    goalId?: string;
    archived?: boolean;
    predecessorWorkItemId?: string;
    createdAt: number;
};
export type Handoff = {
    id: string;
    sourceThreadId: number;
    targetThreadId: number;
    targetType: ThreadType;
    relationship: Relationship;
    workItemId: string;
    brief: string;
    sourceEntryId?: number;
    codeCheckpoint?: CodeFingerprint;
    requestedBy: string;
    createdAt: number;
    delivery: "pending" | "delivered" | "blocked";
    deliveryReason?: string;
    deliveryAttempt?: number;
};
export type HandoffsData = {
    workItems: Record<string, WorkItem>;
    handoffs: Record<string, Handoff>;
    requests: Record<string, { input: string; id: number; handoffId: string; workItemId: string }>;
};

/** Application-wide retry receipts and grouping. Never exposed wholesale as a room document. */
export const HandoffsDoc = defineDoc<HandoffsData>({
    kind: "pocket.handoffs",
    version: 1,
    scope: "session",
    initial: () => ({ workItems: {}, handoffs: {}, requests: {} }),
});
