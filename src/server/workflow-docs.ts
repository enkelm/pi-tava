/** Durable handoff grouping and per-thread workflow state; no executable context reset or task ownership. */
import { defineDoc } from "@earendil-works/pi-durable";

export type ThreadType =
    "chat" | "researcher" | "worker" | "reviewer" | "follow-up" | "pull" | "land" | "publish";
export type Relationship = "same-work" | "new-work";
export type WorkflowStatus = "active" | "review-complete" | "landed" | "published" | "needs-review";
export type Recommendation = {
    targetType: ThreadType;
    relationship: Relationship;
    reason?: string;
};
export type Proposal = { targetType: ThreadType; relationship: Relationship; brief: string };
export type CodeFingerprint = { digest: string; cwd: string; head: string; status: string };
/** Human-supplied third-party review, grounded in an attributed input and an inspected checkpoint. */
export type ExternalReview = {
    source: string;
    scope: string;
    findings: string;
    checkpoint: string;
    sourceEntryId: number;
    sourceSubmissionId: number;
    sourceRequestId: string;
    suppliedBy: string;
    recordedBy: string;
    recordedAt: number;
    fingerprint: CodeFingerprint;
};
/** Code findings and validation readiness are separate; a clear review may still have failed/deferred checks. */
export type ReviewAssessment = { outcome: "clear" | "blocked"; validationGaps: string[] };
export type ValidationAcceptance = {
    threadId: number;
    checkpoint: string;
    assessment: string;
    gaps: string[];
    acceptedBy: string;
    acceptedAt: number;
};
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
    externalReview?: ExternalReview;
    reviewAssessment?: ReviewAssessment;
    /** Fresh identity on every successfully checkpoint-bound assessment, including identical reports. */
    reviewAssessmentId?: string;
    /** Append-only human decisions, not passed-check evidence. Each binds one completed assessment. */
    validationAcceptances?: ValidationAcceptance[];
    /** Material rewrites make prior review inapplicable, not ordinary bounded repairs or check blockers. */
    reviewApplicability?: "preserved" | "invalidated";
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
    titleNamed?: boolean;
};
/** Immutable human intent; only its summary and settlement are produced by background work. */
export type HandoffRequest = {
    sourceThreadId: number;
    targetType: ThreadType;
    relationship: Relationship;
    requestedBy: string;
    input: string;
    brief?: string;
    taskId: number;
    attempt: number;
    status: "pending" | "blocked" | "completed";
    reason?: string;
};
export type HandoffsData = {
    workItems: Record<string, WorkItem>;
    handoffs: Record<string, Handoff>;
    requests: Record<string, { input: string; id: number; handoffId: string; workItemId: string }>;
    pending?: Record<string, HandoffRequest>;
};

/** Application-wide retry receipts and grouping. Never exposed wholesale as a room document. */
export const HandoffsDoc = defineDoc<HandoffsData>({
    kind: "pocket.handoffs",
    version: 1,
    scope: "session",
    initial: () => ({ workItems: {}, handoffs: {}, requests: {} }),
});
