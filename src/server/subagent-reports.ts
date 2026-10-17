/** Shared durable report settlement and quiescence, independent of the optional subagent tools. */
import type { ConversationId, SubmissionRecord, Tx } from "@earendil-works/pi-durable";
import { type PendingReport, SubagentsDoc } from "./docs.ts";

/**
 * What became of the batch a courier took (`state.sending`), from its submission, settled in `state`: kept while it is
 * still to send or waits in the parent's queue; gone once Pi has it. Taken out of the queue before Pi had it, it is
 * gone if a person did that (the queue's ×, or Stop, which mark it `discarded`), and otherwise (a spend limit's stop, a
 * new context) its reports wait again, first.
 */
export function settleBatch(
    state: { outbox?: PendingReport[]; sending?: { reports: PendingReport[]; discarded?: true } },
    record: SubmissionRecord | undefined,
): void {
    const sending = state.sending;

    if (sending === undefined || record === undefined || record.status === "queued") {
        return;
    }

    if (
        record.status === "unanswered" &&
        record.entry === undefined &&
        sending.discarded !== true
    ) {
        state.outbox = [...sending.reports, ...(state.outbox ?? [])];
    }

    delete state.sending;
}

/** Quiescence includes stranded batches, but not reports already placed or explicitly discarded. */
export async function hasPendingSubagentReports(tx: Tx, id: ConversationId): Promise<boolean> {
    const state = await tx.doc(SubagentsDoc, id);
    // Settlement only replaces these fields: a shallow view applies the courier's rules without changing storage.
    const pending = { outbox: state.outbox, sending: state.sending };
    const record =
        state.sending === undefined
            ? undefined
            : await tx.submissionByRequest(id, state.sending.request);

    settleBatch(pending, record);

    return (pending.outbox?.length ?? 0) > 0 || (pending.sending?.reports.length ?? 0) > 0;
}
