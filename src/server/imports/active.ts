/** Select a discovered Pi, validate first, stop only that process, then use the existing atomic importer. */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { PocketApp } from "../app.ts";
import type { User } from "../config.ts";
import { TakeoversDoc } from "../docs.ts";
import { HttpError } from "../errors.ts";
import {
    importVisibility,
    type ImportRequest,
    type Imports,
    type ImportVisibility,
} from "../imports.ts";
import { LocalPiSessions, type ActivePi } from "./herdr.ts";

const context = BACKGROUND_CONTEXT;

type MoveRequest = ImportRequest & { id?: unknown };
type Result = Awaited<ReturnType<Imports["create"]>>;

function requireOwner(user: User): void {
    if (user.role !== "owner") {
        throw new HttpError(403, "Only the owner can discover or move Pi sessions");
    }
}

function requestId(request: MoveRequest): string {
    if (
        !request ||
        typeof request !== "object" ||
        typeof request.id !== "string" ||
        !/^[a-f0-9]{64}$/.test(request.id)
    ) {
        throw new HttpError(400, "Choose a session from the running Pi list");
    }

    return request.id;
}

export class ActiveImports {
    readonly #app: PocketApp;
    readonly #imports: Imports;
    readonly #pending = new Map<
        string,
        { visibility?: ImportVisibility; promise: Promise<Result> }
    >();
    readonly local = new LocalPiSessions();

    constructor(app: PocketApp, imports: Imports) {
        this.#app = app;
        this.#imports = imports;
    }

    #visibility(
        request: MoveRequest,
        previous?: { visibility?: ImportVisibility; result?: Result["id"] },
    ): ImportVisibility {
        const requested = importVisibility(request);

        if (
            previous?.visibility === "shared" &&
            previous.result === undefined &&
            request.visibility === "owner"
        ) {
            throw new HttpError(
                409,
                "This unfinished move was confirmed as shared. Preview it and retry with shared visibility.",
            );
        }

        // Completed imports may have been promoted separately from their original takeover reservation.
        if (
            previous?.visibility === "shared" ||
            (previous?.result !== undefined &&
                this.#app.sessionMeta(previous.result)?.ownerOnly === false)
        ) {
            return "shared";
        }

        return requested;
    }

    async list(user: User) {
        requireOwner(user);
        const current = await this.local.list();
        const stored = await this.#app.harness.snapshot(TakeoversDoc, context);
        const sessions = current.sessions.map((item) => ({
            id: item.id,
            title: item.title,
            cwd: item.cwd,
            location: item.location,
            state: item.state,
            reason: item.reason,
            recovery: false,
            visibility: this.#visibility({}, stored?.items[item.id]),
        }));

        for (const [id, item] of Object.entries(stored?.items ?? {})) {
            if (item.result === undefined && !sessions.some((session) => session.id === id)) {
                sessions.push({
                    id,
                    title: item.session.title,
                    cwd: item.session.cwd,
                    location: item.session.location,
                    state: "unfinished move",
                    reason: await this.local.inputReason(item.session.socket, item.session.pane),
                    recovery: true,
                    visibility: this.#visibility({}, item),
                });
            }
        }

        return { sessions, warnings: current.warnings };
    }

    async #session(id: string): Promise<ActivePi> {
        const stored = await this.#app.harness.snapshot(TakeoversDoc, context);
        const previous = stored?.items[id];

        if (previous) {
            await this.local.requireInputSafe(previous.session.socket, previous.session.pane);
        }

        if (previous && (await this.local.exited(previous.session))) {
            // Refuse to import while another discoverable Pi has reopened the same source.
            const current = await this.local.list();

            if (
                current.warnings.length ||
                current.sessions.some(
                    (item) => item.path === previous.session.path && item.process !== undefined,
                )
            ) {
                throw new HttpError(
                    409,
                    "Could not confirm the old session is stopped. Check Herdr and any Pi using this file.",
                );
            }

            return previous.session;
        }

        return this.local.find(id);
    }

    async preview(user: User, request: MoveRequest) {
        requireOwner(user);
        const id = requestId(request);

        importVisibility(request);
        const stored = await this.#app.harness.snapshot(TakeoversDoc, context);
        const visibility = this.#visibility(request, stored?.items[id]);
        const session = await this.#session(id);
        const preview = await this.#imports.preview(user, { path: session.path, visibility });

        return { ...preview, activeId: id, location: session.location };
    }

    move(user: User, request: MoveRequest): Promise<Result> {
        requireOwner(user);
        const id = requestId(request);
        const visibility = importVisibility(request);

        if (request.acknowledged !== true) {
            throw new HttpError(400, "Confirm Move to Durable before stopping this Pi");
        }

        const pending = this.#pending.get(id);

        if (pending) {
            if ((pending.visibility ?? "owner") !== visibility) {
                throw new HttpError(409, "A move with different visibility is already in progress");
            }

            if (pending.visibility === undefined && request.visibility === "owner") {
                // An omitted value may inherit persisted sharing. Do not treat explicit owner as that consent.
                return this.#app.harness.snapshot(TakeoversDoc, context).then((stored) => {
                    this.#visibility(request, stored?.items[id]);

                    return pending.promise;
                });
            }

            return pending.promise;
        }

        const promise = this.#move(user, id, request).finally(() => this.#pending.delete(id));

        this.#pending.set(id, {
            visibility: request.visibility === undefined ? undefined : visibility,
            promise,
        });

        return promise;
    }

    async #move(user: User, id: string, request: MoveRequest): Promise<Result> {
        const stored = await this.#app.harness.snapshot(TakeoversDoc, context);
        const previous = stored?.items[id];
        // Legacy retries retain earlier consent; explicitly conflicting unfinished retries are refused.
        const visibility = this.#visibility(request, previous);

        if (previous?.result !== undefined) {
            return this.#imports.retry(user, previous.result, { ...request, visibility });
        }

        const session = await this.#session(id);

        return this.local.withPane(session.socket, session.pane, async () => {
            const prepared = { ...request, path: session.path, stopped: true, visibility };

            // No signal is sent until source compatibility, fingerprint, cwd and destination are valid.
            await this.#imports.prepare(user, prepared);
            await this.#app.harness.commit(async (tx) => {
                const document = await tx.doc(TakeoversDoc);

                document.items[id] = {
                    ...(document.items[id] ?? { session, startedAt: Date.now() }),
                    visibility,
                };
            }, context);

            if (!(await this.local.exited(session))) {
                await this.local.stop(session);
            }

            // Session metadata may change during shutdown. Revalidate the preview rather than silently changing context.
            await this.#session(id);

            try {
                return await this.#imports.create(user, prepared, id);
            } catch (error) {
                const message = error instanceof Error ? error.message : "Import failed";

                throw new HttpError(
                    409,
                    `Pi has stopped, but the import did not finish. Select the unfinished move to preview and retry. The original file is safe. ${message}`,
                );
            }
        });
    }
}
