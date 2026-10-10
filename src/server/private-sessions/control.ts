/** Durable admission before external input. An unresolved receipt is a fence, not a retry queue. */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createHash, randomUUID } from "node:crypto";
import type { PocketApp } from "../app.ts";
import { PrivateControlDoc } from "../docs.ts";
import { HttpError } from "../errors.ts";

const context = BACKGROUND_CONTEXT;
const hash = (...parts: string[]) =>
    createHash("sha256").update(JSON.stringify(parts)).digest("hex");

export const UNCERTAIN_INPUT_REASON =
    "Input delivery is uncertain. Chat prompts and Import & share are blocked for safety. Restarting the app or refreshing does not clear this block. Input was not automatically retried.";
export type ControlPurpose = "prompt" | "takeover";
export type PromptReceipt = Readonly<{ id: string; socket: string; pane: string }>;

/** Internal server API. Callers authorize the owner and acquire the local pane/instance operation reservation first.
 * No generic clear method: snapshots, socket closure and process replacement do not cancel queued input.
 */
export class PrivateControl {
    readonly #app: PocketApp;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    async reason(socket: string, pane: string): Promise<string | undefined> {
        const stored = await this.#app.harness.snapshot(PrivateControlDoc, context);
        const instance = hash(socket);
        const target = hash(socket, pane);
        const receipts = Object.values(stored?.items ?? {}).filter(
            (item) => item.instance === instance && (!item.pane || item.pane === target),
        );

        return receipts.some((item) => item.kind !== "terminal")
            ? UNCERTAIN_INPUT_REASON
            : undefined;
    }

    async requireClear(socket: string, pane: string): Promise<void> {
        const reason = await this.reason(socket, pane);

        if (reason) {
            throw new HttpError(409, reason);
        }
    }

    /** Must finish committing before agent.prompt is sent. A crash before send deliberately leaves a block. */
    async admitPrompt(socket: string, pane: string): Promise<PromptReceipt> {
        const receipt = { id: randomUUID(), socket, pane };
        const instance = hash(socket);
        const target = hash(socket, pane);

        await this.#app.harness.commit(async (tx) => {
            const stored = await tx.doc(PrivateControlDoc);

            if (
                Object.values(stored.items).some(
                    (item) =>
                        item.kind !== "terminal" &&
                        item.instance === instance &&
                        (!item.pane || item.pane === target),
                )
            ) {
                throw new HttpError(409, UNCERTAIN_INPUT_REASON);
            }

            stored.items[target] = {
                id: receipt.id,
                instance,
                pane: target,
                kind: "prompt",
                admittedAt: Date.now(),
            };
        }, context);

        return receipt;
    }

    /** A transport result, not proof that a particular PID consumed the text. Only settle the matching admission. */
    async settlePrompt(receipt: PromptReceipt, ack: unknown): Promise<void> {
        if (!ack || typeof ack !== "object" || !("type" in ack) || ack.type !== "agent_prompted") {
            throw new Error("Herdr did not acknowledge agent.prompt");
        }

        const agent = "agent" in ack ? ack.agent : undefined;

        if (
            !agent ||
            typeof agent !== "object" ||
            !("pane_id" in agent) ||
            agent.pane_id !== receipt.pane ||
            !("agent" in agent) ||
            agent.agent !== "pi"
        ) {
            throw new Error("Herdr acknowledged an unexpected agent or pane");
        }

        await this.#app.harness.commit(async (tx) => {
            const stored = await tx.doc(PrivateControlDoc);
            const target = hash(receipt.socket, receipt.pane);
            const item = stored.items[target];

            if (!item || item.id !== receipt.id || item.kind !== "prompt") {
                throw new Error("Private prompt admission no longer matches");
            }

            delete stored.items[target];
        }, context);
    }

    /** Call before forwarding any terminal input or input-capable native request. Idempotent per instance.
     * Known terminal use is retained for storage compatibility, not as a Chat or import restriction.
     * It never settles an uncertain Chat receipt or implies cancellation of Herdr's queued input.
     * Instance scope covers input/focus that can target panes other than the initial one.
     */
    async markTerminalInput(socket: string): Promise<void> {
        const instance = hash(socket);

        await this.#app.harness.commit(async (tx) => {
            const stored = await tx.doc(PrivateControlDoc);

            stored.items[instance] ??= {
                id: randomUUID(),
                instance,
                kind: "terminal",
                admittedAt: Date.now(),
            };
        }, context);
    }
}
