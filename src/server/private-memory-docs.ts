/** Durable request tombstones for private learned Memory; never stores a lesson's text. */
import { defineDoc } from "@earendil-works/pi-durable";
import { currentStateCheckpoints } from "./doc-checkpoint.ts";

export const MemoryReceiptsDoc = defineDoc<{
    items: Record<string, { fingerprint: string; lessonId: string; revision: number }>;
}>({
    kind: "pocket.private-memory-receipts",
    version: 1,
    ...currentStateCheckpoints,
    scope: "session",
    initial: () => ({ items: {} }),
});
