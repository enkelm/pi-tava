/** Cancellation and joining for SSH work, including operations started by legacy guarded environments. */
import type { Context } from "@earendil-works/chord";
import { withCancel } from "@earendil-works/chord/context";
import { HttpError } from "../errors.ts";

export class SshLifetime {
    readonly #pending = new Set<{ cancel(): void; done: Promise<void> }>();
    #closed = false;
    #closing?: Promise<void>;

    requireOpen(): void {
        if (this.#closed) {
            throw new HttpError(409, "SSH sessions are closing. No operation was started.");
        }
    }

    async run<T>(context: Context, operation: (context: Context) => Promise<T>): Promise<T> {
        this.requireOpen();
        const pending = withCancel(context);
        let finish!: () => void;
        const done = new Promise<void>((resolve) => {
            finish = resolve;
        });
        const job = { cancel: pending.cancel, done };

        this.#pending.add(job);

        try {
            return await operation(pending.context);
        } finally {
            // A returned reader or a compound batch may still own this signal. Cancelling a
            // completed method would abort its shared transport before the next method runs.
            this.#pending.delete(job);
            finish();
        }
    }

    close(): Promise<void> {
        this.#closed = true;
        this.#closing ??= (async () => {
            const pending = [...this.#pending];

            for (const job of pending) {
                job.cancel();
            }

            await Promise.all(pending.map((job) => job.done));
        })();

        return this.#closing;
    }
}
