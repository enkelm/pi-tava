/** Owner-only editor language services. Leases stay bound to their conversation, user and working directory. */
import { realpathSync } from "node:fs";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { HttpError } from "./errors.ts";
import { git } from "./git.ts";
import { LspPool } from "./lsp.ts";

type Lease = { id: ConversationId; user: string; path: string; cwd: string; touched: number };

export class LanguageServices {
    readonly #app: PocketApp;
    readonly #pool = new LspPool();
    readonly #leases = new Map<string, Lease>();
    readonly #sweeper = setInterval(() => this.#sweep(), 10_000).unref();

    constructor(app: PocketApp) {
        this.#app = app;
    }

    async handle(id: ConversationId, user: User, input: unknown): Promise<unknown> {
        this.#app.requireSee(user, id);

        if (user.role !== "owner") {
            throw new HttpError(403, "Language servers are available to the owner only");
        }

        if (input === null || typeof input !== "object" || Array.isArray(input)) {
            throw new HttpError(400, "An LSP action is required");
        }

        const body = input as {
            action?: unknown;
            path?: unknown;
            session?: unknown;
            message?: unknown;
        };

        if (body.action === "status") {
            return { servers: this.#pool.status() };
        }

        if (body.action === "open") {
            await this.#app.requireDriver(id, user);

            if (typeof body.path !== "string" || body.path.trim() === "") {
                throw new HttpError(400, "path is required");
            }

            const file = this.#app.workspace.editableFile(user, id, body.path);
            const view = await this.#app.workspace.viewFile(id, user, file);

            if (view.kind !== "text" || view.truncated || !view.revision) {
                throw new HttpError(415, "Only complete UTF-8 text files have language support");
            }

            this.#sweep();

            if (this.#leases.size >= 32) {
                throw new HttpError(429, "Too many open language-service documents");
            }

            const cwd = realpathSync(this.#app.cwdOf(id));
            const root = await git(cwd, ["rev-parse", "--show-toplevel"], { timeoutMs: 3000 })
                .then((path) => realpathSync(path.trim()))
                .catch(() => cwd);
            const opened = await this.#pool.open(root, file, view.text);

            if (opened.session) {
                try {
                    this.#app.requireSee(user, id);
                    await this.#app.requireDriver(id, user);

                    if (
                        realpathSync(this.#app.cwdOf(id)) !== cwd ||
                        this.#app.workspace.editableFile(user, id, body.path) !== file
                    ) {
                        throw new HttpError(
                            409,
                            "The working directory or file changed while starting language support",
                        );
                    }

                    this.#leases.set(opened.session, {
                        id,
                        user: user.id,
                        path: file,
                        cwd,
                        touched: Date.now(),
                    });
                } catch (error) {
                    this.#pool.close(opened.session);

                    throw error;
                }
            }

            return opened;
        }

        if (typeof body.session !== "string") {
            throw new HttpError(400, "session is required");
        }

        const lease = this.#leases.get(body.session);

        if (!lease || lease.id !== id || lease.user !== user.id) {
            // Do not let one conversation close or query another conversation's editor.
            throw new HttpError(404, "No language-service session in this conversation");
        }

        if (body.action === "close") {
            this.#pool.close(body.session);
            this.#leases.delete(body.session);

            return { messages: [] };
        }

        try {
            await this.#app.requireDriver(id, user);

            if (
                realpathSync(this.#app.cwdOf(id)) !== lease.cwd ||
                this.#app.workspace.editableFile(user, id, lease.path) !== lease.path
            ) {
                throw new HttpError(
                    409,
                    "The working directory or file changed. Reopen the editor for language support.",
                );
            }

            lease.touched = Date.now();

            if (body.action === "poll") {
                return { messages: this.#pool.poll(body.session) };
            }

            if (body.action === "message" && typeof body.message === "string") {
                return { messages: this.#pool.send(body.session, body.message) };
            }

            throw new HttpError(400, "Unknown LSP action or invalid message");
        } catch (error) {
            this.#pool.close(body.session);
            this.#leases.delete(body.session);

            throw error;
        }
    }

    #sweep(): void {
        for (const [session, lease] of this.#leases) {
            if (Date.now() - lease.touched > 120_000) {
                this.#pool.close(session);
                this.#leases.delete(session);
            }
        }
    }

    close(): void {
        clearInterval(this.#sweeper);
        this.#leases.clear();
        this.#pool.close();
    }
}
