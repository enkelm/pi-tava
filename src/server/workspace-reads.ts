/** Pending workspace reads share work, never a consumer's cancellation or a retained transport. */
import type { Context } from "@earendil-works/chord";
import { awaitWithContext, BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";

type Pending<T> = {
    promise: Promise<T>;
    cancel: () => void;
    consumers: number;
};

/** Callers key exact authority/destination and authorize each consumer after awaiting its result. */
export class SharedWorkspaceReads<T> {
    readonly #pending = new Map<string, Pending<T>>();

    /** New questions after a mutation must not attach to older work. Existing consumers still finish. */
    forget(prefix: string): void {
        for (const key of this.#pending.keys()) {
            if (key.startsWith(prefix)) {
                this.#pending.delete(key);
            }
        }
    }

    async run(
        key: string,
        callerContext: Context,
        operation: (sharedContext: Context) => Promise<T>,
    ): Promise<T> {
        callerContext.abortSignal?.throwIfAborted();
        let entry = this.#pending.get(key);

        if (entry === undefined) {
            // An aggregate read is independent of any one request. Its last consumer owns cancellation/join.
            const shared = withCancel(BACKGROUND_CONTEXT);
            const created: Pending<T> = {
                promise: Promise.resolve().then(() => {
                    shared.context.abortSignal?.throwIfAborted();

                    return operation(shared.context);
                }),
                cancel: shared.cancel,
                consumers: 0,
            };

            created.promise = created.promise.finally(() => {
                if (this.#pending.get(key) === created) {
                    this.#pending.delete(key);
                }
            });
            entry = created;
            this.#pending.set(key, entry);

            // Eviction only stops indexing the oldest work; it never cancels its existing consumers.
            for (const oldest of this.#pending.keys()) {
                if (this.#pending.size <= 16) {
                    break;
                }

                this.#pending.delete(oldest);
            }
        }

        entry.consumers++;

        try {
            return await awaitWithContext(entry.promise, callerContext);
        } finally {
            entry.consumers--;

            if (entry.consumers === 0) {
                if (this.#pending.get(key) === entry) {
                    this.#pending.delete(key);
                }

                entry.cancel();
                await entry.promise.catch(() => {});
            }
        }
    }
}
