/** Ordered browser output. Only complete, reconstructed surfaces may supply a replacement fence. */
type Transport = {
    maxEventBytes: number;
    isOpen: () => boolean;
    bufferedBytes: () => number;
    write: (text: string, done: (error?: Error) => void) => void;
    close: (reason: string) => void;
};

export class TerminalOutput {
    readonly #transport: Transport;
    #disposed = false;
    #inFlight = 0;
    #pending: { text: string; fence: string } | undefined;

    constructor(transport: Transport) {
        this.#transport = transport;
    }

    send(value: unknown, surfaceFence?: string) {
        if (this.#disposed) {
            return;
        }

        const text = JSON.stringify(value);

        if (!this.#admit(text)) {
            return;
        }

        // Every control/image/snapshot and every fence change is an ordering barrier.
        // Force the last held surface onto the ordered, byte-bounded transport first.
        if (this.#pending && this.#pending.fence !== surfaceFence) {
            this.#flush();
        }

        if (this.#disposed) {
            return;
        }

        if (surfaceFence !== undefined && this.#inFlight > 0) {
            // These are independent full JSON frames, never native patches or input.
            this.#pending = { text, fence: surfaceFence };
        } else {
            this.#write(text);
        }
    }

    #admit(text: string): boolean {
        if (this.#disposed) {
            return false;
        }

        if (!this.#transport.isOpen()) {
            this.dispose();

            return false;
        }

        const bytes = Buffer.byteLength(text);

        if (
            bytes > this.#transport.maxEventBytes ||
            this.#transport.bufferedBytes() + bytes > this.#transport.maxEventBytes * 2
        ) {
            this.#fail(
                "Terminal output exceeded the browser queue limit; reconnect for a fresh frame",
            );

            return false;
        }

        return true;
    }

    #write(text: string) {
        // A held frame may outlive the budget/open state observed when it arrived.
        if (!this.#admit(text)) {
            return;
        }

        this.#inFlight++;

        try {
            this.#transport.write(text, (error) => {
                if (this.#disposed) {
                    return;
                }

                this.#inFlight--;

                if (error) {
                    this.#fail("Terminal output transport closed; reconnect for a fresh frame");
                } else if (this.#inFlight === 0) {
                    // Write completion is not a browser receipt or a paint acknowledgement.
                    this.#flush();
                }
            });
        } catch {
            this.#fail("Terminal output transport closed; reconnect for a fresh frame");
        }
    }

    #flush() {
        const pending = this.#pending;

        this.#pending = undefined;

        if (pending) {
            this.#write(pending.text);
        }
    }

    #fail(reason: string) {
        this.dispose();
        this.#transport.close(reason);
    }

    dispose() {
        this.#disposed = true;
        this.#pending = undefined;
    }
}
