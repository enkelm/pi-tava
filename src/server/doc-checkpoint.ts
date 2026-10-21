import type { CheckpointInfo } from "@earendil-works/pi-durable";

/**
 * Opt in only for current-state documents: session/task scope, or conversation history "latest".
 * Durable counts the stored deltas before this change, so the next write after 64 stores a new base.
 * SQLite then drops the older revisions of these documents, bounding cold-read replay without
 * changing their stored kind, version, scope, history or fork contract.
 */
export const currentStateCheckpoints = {
    checkpointWhen: (_value: unknown, _ops: unknown, info: CheckpointInfo) =>
        info.deltasSinceBase >= 64,
};
