/** Durable exact-recipient private contacts; native submissions remain owned by Durable admission. */
import { defineDoc } from "@earendil-works/pi-durable";
import { currentStateCheckpoints } from "../doc-checkpoint.ts";

export type ContactAuthority = {
    agentId: string;
    ownerId: string;
    tokenHash: string;
    agentEpoch: number;
    chatId: number;
    requestId: string;
    target: number;
    root: number;
    epoch: number;
    boot: string;
    destination: string;
    sourceInputId?: number;
    sourceAdmissionSerial?: number;
    workItemId?: string;
    attachmentEpoch?: number;
    controllerId?: number;
};
export type ExactContact = ContactAuthority & {
    fingerprint: string;
    agentName: string;
    action: "send" | "read" | "follow" | "stop";
    text: string;
    steer: boolean;
    report: boolean;
    /** Native requester id, not owner-written human direction. */
    nativeRequestId: string;
    sourceTask: number;
    status: "prepared" | "accepted" | "blocked" | "revoked";
    submissionId?: number;
    reason?: string;
    /** Follow starts after this snapshot, never a different/current active thread. */
    afterEntry: number;
};
export type ContactReport = {
    key: string;
    contact: string;
    target: number;
    entry?: number;
    /** Immutable native question identity, independent of its display prose. */
    questionId?: string;
    /** Real native helper reporter; delivery validates its parent, child and copied creator authority. */
    helperReporterId?: number;
    originChatId?: number;
    originRequestId?: string;
    agentId: string;
    agentEpoch: number;
    ownerId: string;
    tokenHash: string;
    text: string;
    status: "pending" | "held" | "delivered";
    reason?: string;
    notified?: boolean;
};
export type ContactsData = {
    contacts: Record<string, ExactContact>;
    /** Reclaim/Stop invalidate accepted and queued activations before joining native work. */
    epochs: Record<string, number>;
    /** Pins persist across successor GenerationTasks and real helper ownership edges. */
    generations: Record<string, ContactAuthority[]>;
    tools: Record<string, ContactAuthority[]>;
    reports: Record<string, ContactReport>;
};
export const AgentContactsDoc = defineDoc<ContactsData>({
    kind: "pocket.agent-contacts",
    version: 1,
    ...currentStateCheckpoints,
    scope: "session",
    initial: () => ({ contacts: {}, epochs: {}, generations: {}, tools: {}, reports: {} }),
});
