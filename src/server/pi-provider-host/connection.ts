import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { OPERATION_TIMEOUT_MS, type HostConfiguration, type WireMessage } from "./protocol.ts";

type Handlers = {
    callback?: (op: string, data: any, signal: AbortSignal) => Promise<any> | any;
    event?: (data: any) => void;
};

type Pending = Handlers & {
    callbacks: Map<number, AbortController>;
    resolve: (data: any) => void;
    reject: (error: Error) => void;
    dispose: () => void;
};

/** Owns a child and joins its exit, including after an uncooperative extension times out. */
export class Connection {
    readonly child: ChildProcess;
    readonly exited: Promise<void>;
    readonly pending = new Map<number, Pending>();
    nextId = 0;
    dead = false;
    closing?: Promise<void>;

    constructor(
        configuration: HostConfiguration,
        bootstrapEnv: Partial<Record<"LITELLM_API_KEY" | "LITELLM_BASE_URL", string>> = {},
    ) {
        this.child = fork(fileURLToPath(new URL("./worker.ts", import.meta.url)), [], {
            cwd: configuration.cwd,
            execArgv: [],
            serialization: "json",
            stdio: ["ignore", "ignore", "ignore", "ipc"],
            env: {
                PATH: process.env.PATH,
                HOME: configuration.cwd,
                TMPDIR: process.env.TMPDIR,
                ...bootstrapEnv,
                PI_OFFLINE: configuration.restoreOnly ? "1" : undefined,
                PI_CODING_AGENT_DIR: configuration.agentDir,
                PI_PROVIDER_HOST_CONFIG: JSON.stringify(configuration),
            },
        });
        this.exited = once(this.child, "exit")
            .then(() => undefined)
            .catch(() => undefined);
        this.child.on("message", (message) => void this.receive(message as WireMessage));
        this.child.on("error", () => this.fail(new Error("Provider host worker failed")));
        this.child.on("exit", () => this.fail(new Error("Provider host worker exited")));
    }

    send(message: WireMessage): void {
        if (!this.dead && this.child.connected) {
            this.child.send(message, (error) => {
                if (error) {
                    this.fail(new Error("Provider host IPC failed"));
                }
            });
        }
    }

    async receive(message: WireMessage): Promise<void> {
        const pending = this.pending.get(message.id);

        if (!pending || this.dead) {
            return;
        }

        if (message.kind === "reply") {
            this.pending.delete(message.id);
            pending.dispose();

            if (message.failed) {
                pending.reject(new Error(String(message.data)));
            } else {
                pending.resolve(message.data);
            }
        } else if (message.kind === "event") {
            pending.event?.(message.data);
        } else if (message.kind === "callbackCancel") {
            pending.callbacks.get(message.token!)?.abort();
        } else if (message.kind === "callback") {
            const callbackController = new AbortController();

            pending.callbacks.set(message.token!, callbackController);

            try {
                if (!pending.callback) {
                    throw new Error("Missing callback bridge");
                }

                const data = await pending.callback(
                    message.op!,
                    message.data,
                    callbackController.signal,
                );

                if (this.pending.has(message.id)) {
                    this.send({
                        kind: "callbackReply",
                        id: message.id,
                        token: message.token,
                        data,
                    });
                }
            } catch {
                this.send({
                    kind: "callbackReply",
                    id: message.id,
                    token: message.token,
                    failed: true,
                });
            } finally {
                pending.callbacks.delete(message.token!);
            }
        }
    }

    call(
        op: string,
        data?: any,
        handlers: Handlers = {},
        signal?: AbortSignal,
        timeoutMs = OPERATION_TIMEOUT_MS,
    ): Promise<any> {
        if (this.dead || signal?.aborted) {
            return Promise.reject(
                new Error("Provider host operation aborted or worker unavailable"),
            );
        }

        const id = ++this.nextId;

        return new Promise((resolve, reject) => {
            const abort = () => {
                this.fail(new Error("Provider host operation aborted"));
                void this.close();
            };

            const timer = setTimeout(() => {
                this.fail(
                    new Error("Provider host operation timed out; remote outcome may be unknown"),
                );
                void this.close();
            }, timeoutMs);

            signal?.addEventListener("abort", abort, { once: true });
            const callbacks = new Map<number, AbortController>();

            this.pending.set(id, {
                callbacks,
                ...handlers,
                resolve,
                reject,
                dispose: () => {
                    clearTimeout(timer);
                    signal?.removeEventListener("abort", abort);

                    for (const callback of callbacks.values()) {
                        callback.abort();
                    }
                },
            });
            this.send({ kind: "request", id, op, data });
        });
    }

    fail(error: Error): void {
        this.dead = true;

        for (const pending of this.pending.values()) {
            pending.dispose();
            pending.reject(error);
        }

        this.pending.clear();
    }

    close(): Promise<void> {
        this.closing ??= this.stop();

        return this.closing;
    }

    private async stop(): Promise<void> {
        if (!this.dead) {
            // Cancellation is out-of-band: an active transport must stop before shutdown hooks.
            this.send({ kind: "cancel", id: 0 });

            try {
                await this.call("shutdown", undefined, {}, undefined, 2_000);
            } catch {
                // A stuck or failing hook must not retain an owned child indefinitely.
            }
        }

        this.fail(new Error("Provider host closed"));
        this.child.kill("SIGTERM");

        const kill = setTimeout(() => this.child.kill("SIGKILL"), 1_000);

        await this.exited;
        clearTimeout(kill);
    }
}
