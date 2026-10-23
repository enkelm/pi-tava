/** Pi's local sessions, copied into Durable without controlling the original Pi or writing its journal. */
import { realpath } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { configure, type ConversationId, type Tx } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import { canContinuePiSessions, type User } from "./config.ts";
import { ImportedSessionDoc, ImportsDoc, SessionsDoc } from "./docs.ts";
import type { ProjectSelection } from "./projects.ts";
import { FROM_PI_ENTRY } from "./entry-format.ts";
import { HttpError } from "./errors.ts";
import { modelList } from "./models.ts";
import { ActivePiSessions } from "./pi-sessions/active.ts";
import { listSavedHistory, recentHistory } from "./pi-sessions/history.ts";
import { appendPiHistory, readPiSession, type PiSessionMode } from "./pi-sessions/source.ts";

const context = BACKGROUND_CONTEXT;

export type ImportRequest = {
    path?: unknown;
    activeId?: unknown;
    leafId?: unknown;
    sha256?: unknown;
    acknowledged?: unknown;
    model?: unknown;
    thinkingLevel?: unknown;
    visibility?: unknown;
    projectId?: unknown;
    /** The previewed Chat whose entire history the owner agreed to share on receipt reuse. */
    existingId?: unknown;
    /** Old clients must never turn a copy into an abort or stop. */
    abortRunning?: unknown;
    stopped?: unknown;
};

export type ImportVisibility = "owner" | "shared";

export function importVisibility(request: ImportRequest): ImportVisibility {
    if (request === null || typeof request !== "object" || Array.isArray(request)) {
        throw new HttpError(400, "Expected a Pi session request");
    }

    if (request.abortRunning === true) {
        throw new HttpError(
            400,
            "Moving a session only copies history. Aborting Pi is not supported.",
        );
    }

    if (request.visibility === undefined || request.visibility === "owner") {
        return "owner";
    }

    if (request.visibility === "shared") {
        return "shared";
    }

    throw new HttpError(400, "Choose owner or shared import visibility");
}

export class PiSessions {
    readonly #app: PocketApp;
    readonly active: ActivePiSessions;
    #historyPending?: ReturnType<typeof listSavedHistory>;

    constructor(app: PocketApp) {
        this.#app = app;
        this.active = new ActivePiSessions(app, this);
    }

    /** Re-read current access after asynchronous I/O; an old tab cannot retain a revoked grant. */
    requireAccess(user: User): User {
        const current = this.#app.config.userById(user.id);

        if (
            !current ||
            current.tokenHash !== user.tokenHash ||
            current.role !== user.role ||
            !canContinuePiSessions(current)
        ) {
            throw new HttpError(403, "Permission to continue local Pi sessions is required");
        }

        return { ...current };
    }

    #owner(user: User): User {
        const current = this.requireAccess(user);

        if (current.role !== "owner") {
            throw new HttpError(403, "Only the owner can share an imported Chat");
        }

        return current;
    }

    #destination(user: User, request: { projectId?: unknown }): ProjectSelection | undefined {
        if (request.projectId === undefined) {
            return undefined;
        }

        this.#owner(user);

        return this.#app.projects.prepare(user, {
            projectId: request.projectId,
            threadType: "chat",
        });
    }

    /** Only a directly imported, independent Chat can lose its owner-only restriction. */
    async #promote(
        tx: Tx,
        user: User,
        id: ConversationId,
        request: { projectId?: unknown },
    ): Promise<void> {
        this.#owner(user);
        const imported = await tx.doc(ImportedSessionDoc, id);
        const sessions = await tx.doc(SessionsDoc);
        const meta = sessions.items[String(id)];

        this.#owner(user);

        if (
            !meta ||
            (meta.imported !== true && meta.fromPi === undefined) ||
            imported.source === undefined ||
            this.#app.rootOf(id) !== id ||
            this.#app.pip.isInternal(id) ||
            meta.pip !== undefined ||
            meta.pipAgent !== undefined ||
            meta.pipAgentId !== undefined ||
            meta.pipWorkItemId !== undefined ||
            meta.workItemId !== undefined ||
            meta.accessFrom !== undefined ||
            meta.forkedFrom !== undefined ||
            meta.linkedFrom !== undefined ||
            (meta.threadType !== undefined &&
                meta.threadType !== "chat" &&
                !(meta.threadType === "worker" && meta.fromPi !== undefined))
        ) {
            throw new HttpError(409, "Only an independent imported Chat can be shared here");
        }

        // A repeated/stale confirmation never relocates an already-shared Chat.
        if (meta.ownerOnly !== false) {
            // Projects also checks current steering/turn authority when placement is unchanged.
            await this.#app.projects.assignTx(tx, user, id, request);
            this.#owner(user);
            meta.ownerOnly = false;
        }
    }

    async #reuse(
        tx: Tx,
        user: User,
        id: ConversationId,
        visibility: ImportVisibility,
        request: ImportRequest,
    ) {
        const sessions = await tx.doc(SessionsDoc);
        const meta = sessions.items[String(id)];

        this.requireAccess(user);

        if (!meta || (meta.imported !== true && meta.fromPi === undefined)) {
            throw new HttpError(409, "The imported conversation is no longer available");
        }

        if (visibility === "shared" && meta.ownerOnly !== false) {
            if (request.existingId !== Number(id)) {
                throw new HttpError(
                    409,
                    "This source already has a private imported Chat. Preview again to confirm sharing its entire history.",
                );
            }

            await this.#promote(tx, user, id, request);
        }

        this.requireAccess(user);

        return { id, existing: true };
    }

    /** Share the current Chat, including its continuation, without consulting the Pi source. */
    async share(
        user: User,
        id: ConversationId,
        request: { acknowledged?: unknown; projectId?: unknown },
    ) {
        user = { ...user };
        request = { ...request };
        this.#owner(user);

        if (request.acknowledged !== true) {
            throw new HttpError(400, "Confirm sharing this Chat's entire history");
        }

        this.#app.requireSee(user, id);

        if (this.#app.sessionMeta(id) === undefined) {
            throw new HttpError(404, "No such imported Chat");
        }

        await this.#app.requireDriver(id, user);

        return this.#app.harness.commit(async (tx) => {
            await this.#promote(tx, user, id, request);
            this.#owner(user);

            return { id };
        }, context);
    }

    async #listHistory() {
        const excluded = new Set<string>();
        const warnings: string[] = [];
        const local = this.active.local;

        try {
            if ((await local.sockets()).length) {
                const active = await local.list();

                warnings.push(
                    ...active.warnings.slice(0, 16).map((warning) => warning.slice(0, 500)),
                );

                for (const session of active.sessions.slice(0, 1000)) {
                    excluded.add(await realpath(session.path).catch(() => session.path));
                }
            }
        } catch {
            warnings.push("Live Pi discovery is unavailable. Saved snapshots are still available.");
        }

        let configured: string | undefined;

        try {
            configured = this.#app.settings.getSessionDir();
        } catch {
            // Unreadable settings use Pi's ordinary sessions directory.
        }

        return listSavedHistory(
            excluded,
            warnings,
            process.env.PI_CODING_AGENT_SESSION_DIR || configured,
        );
    }

    async #history(user: User) {
        this.requireAccess(user);
        this.#historyPending ??= this.#listHistory().finally(() => {
            this.#historyPending = undefined;
        });
        const result = await this.#historyPending;

        this.requireAccess(user);

        return result;
    }

    /** Only bounded metadata leaves discovery. Source IDs are used internally for legacy fromPi records. */
    async history(user: User) {
        const result = await this.#history(user);
        const imports = await this.#app.harness.snapshot(ImportsDoc, context);
        const current = this.requireAccess(user);
        const visible = this.#app.sessions(current);

        return {
            ...result,
            sessions: result.sessions.map(({ sourceSessionId, sha256, leafId, ...session }) => {
                const exact = imports?.items[this.#key(current, sha256, leafId)];
                const prior = visible.find(
                    (item) =>
                        this.#app.sessionMeta(item.id as ConversationId)?.fromPi?.session ===
                        sourceSessionId,
                );
                const id = exact ?? prior?.id;

                return {
                    ...session,
                    ...(id !== undefined && this.#app.canSee(current, id as ConversationId)
                        ? { pocket: { id: Number(id), behind: exact === undefined } }
                        : {}),
                };
            }),
        };
    }

    async list(user: User, query = "") {
        const result = await this.history(user);
        const needle = query.trim().toLocaleLowerCase();

        return {
            ...result,
            sessions: result.sessions.filter((session) =>
                [session.title, session.cwd, session.path]
                    .join(" ")
                    .toLocaleLowerCase()
                    .includes(needle),
            ),
        };
    }

    #key(user: User, sha256: string, leafId: string): string {
        // A guest's explicit shared copy must not publish or reuse an owner's private import.
        return `${sha256}:${leafId}${user.role === "owner" ? "" : `:user:${user.id}`}`;
    }

    async #source(user: User, request: ImportRequest, mode: PiSessionMode) {
        const current = this.requireAccess(user);

        importVisibility(request);
        let path = request.path;
        let active;

        if (request.activeId !== undefined) {
            active = await this.active.resolve(current, request.activeId);
            path = active.path;
        } else if (current.role !== "owner") {
            const listed = await this.#history(current);

            if (!listed.sessions.some((session) => session.path === path)) {
                throw new HttpError(404, "Choose a discovered Pi session");
            }
        }

        const source = await readPiSession(path, request.leafId, mode);

        this.requireAccess(current);

        return { source, active };
    }

    async preview(user: User, request: ImportRequest, mode: PiSessionMode = "snapshot") {
        const { source, active } = await this.#source(user, request, mode);
        const current = this.requireAccess(user);
        const visibility = current.role === "owner" ? importVisibility(request) : "shared";
        const cwd = this.#app.workspace.checkDirectory(source.header.cwd);
        const imports = await this.#app.harness.snapshot(ImportsDoc, context);
        const existing = imports?.items[this.#key(current, source.sha256, source.leafId)];

        this.requireAccess(current);

        return {
            path: source.path,
            sha256: source.sha256,
            leafId: source.leafId,
            title: source.title,
            cwd,
            entries: source.branch.length,
            messages: source.messages.length,
            history: recentHistory(source),
            hasImages: source.hasImages,
            leaves: source.leaves,
            warnings: source.warnings,
            sourceModel: source.model,
            sourceThinkingLevel: source.thinkingLevel,
            models: modelList(this.#app.models),
            visibility:
                existing !== undefined && this.#app.sessionMeta(existing)?.ownerOnly === false
                    ? "shared"
                    : visibility,
            ...(existing === undefined
                ? {}
                : {
                      existing: Number(existing),
                      existingTitle: this.#app.sessionMeta(existing)?.title,
                  }),
            ...(current.role === "owner" && existing !== undefined
                ? { projectId: this.#app.sessionMeta(existing)?.projectId }
                : {}),
            ...(active === undefined
                ? {}
                : {
                      activeId: active.id,
                      location: active.location,
                      running: ["working", "blocked"].includes(active.state),
                  }),
        };
    }

    #confirmation(current: User, request: ImportRequest) {
        const visibility = importVisibility(request);

        if (request.acknowledged !== true) {
            throw new HttpError(400, "Confirm copying the saved Pi history before moving it");
        }

        if (current.role !== "owner" && visibility !== "shared") {
            throw new HttpError(400, "Confirm sharing the copied conversation before continuing");
        }

        if (
            typeof request.sha256 !== "string" ||
            !/^[a-f0-9]{64}$/.test(request.sha256) ||
            typeof request.leafId !== "string"
        ) {
            throw new HttpError(400, "Preview the session and select a branch before moving it");
        }

        return visibility;
    }

    async prepare(user: User, request: ImportRequest, options: { mode?: PiSessionMode } = {}) {
        user = { ...user };
        request = { ...request };
        const current = this.requireAccess(user);
        const visibility = this.#confirmation(current, request);
        const { source } = await this.#source(current, request, options.mode ?? "snapshot");

        if (source.sha256 !== request.sha256) {
            throw new HttpError(409, "The saved session changed since preview. Preview it again.");
        }

        const cwd = this.#app.workspace.checkDirectory(source.header.cwd);
        const model = this.#app.models
            .getAvailableSnapshot()
            .find((item) => `${item.provider}/${item.id}` === request.model);

        if (!model) {
            throw new HttpError(400, "Choose an available destination model before moving");
        }

        if (source.hasImages && !model.input.includes("image")) {
            throw new HttpError(
                400,
                "This context includes images. Choose a model that accepts images.",
            );
        }

        const levels = model.reasoning ? getSupportedThinkingLevels(model) : ["off"];

        if (
            typeof request.thinkingLevel !== "string" ||
            !levels.includes(request.thinkingLevel as ModelThinkingLevel)
        ) {
            throw new HttpError(400, "Choose a thinking level supported by the destination model");
        }

        this.requireAccess(current);

        return {
            source,
            cwd,
            model,
            thinkingLevel: request.thinkingLevel as ModelThinkingLevel,
            visibility,
        };
    }

    async create(user: User, request: ImportRequest) {
        user = { ...user };
        request = { ...request };
        const caller = this.requireAccess(user);
        const intent = this.#confirmation(caller, request);

        if (caller.role !== "owner" && request.projectId !== undefined) {
            throw new HttpError(403, "Only the owner can place imported Chats in projects");
        }

        const receiptKey = this.#key(caller, request.sha256 as string, request.leafId as string);
        const receipts = await this.#app.harness.snapshot(ImportsDoc, context);

        this.requireAccess(caller);

        // A confirmed successful copy is durable even if Pi has since saved more or exited.
        if (receipts?.items[receiptKey] !== undefined) {
            return this.#app.harness.commit(async (tx) => {
                this.requireAccess(caller);
                const receipts = await tx.doc(ImportsDoc);
                const existing = receipts.items[receiptKey];

                if (existing === undefined) {
                    throw new HttpError(
                        409,
                        "The import receipt changed. Preview the session again.",
                    );
                }

                const result = await this.#reuse(tx, caller, existing, intent, request);

                this.requireAccess(caller);

                return result;
            }, context);
        }

        const prepared = await this.prepare(user, request);
        const { source, cwd, model, thinkingLevel, visibility } = prepared;
        const current = this.requireAccess(user);
        const key = this.#key(current, source.sha256, source.leafId);
        const destination = this.#destination(current, request);

        return this.#app.harness.commit(async (tx) => {
            this.requireAccess(current);
            const imports = await tx.doc(ImportsDoc);
            const existing = imports.items[key];

            if (existing !== undefined) {
                const result = await this.#reuse(tx, current, existing, visibility, request);

                this.requireAccess(current);

                return result;
            }

            const placement = destination
                ? await this.#app.projects.place(tx, destination)
                : undefined;
            const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
            const id = conversation.id;

            await configure(tx, id, {
                cwd,
                model: { provider: model.provider, modelId: model.id },
                thinkingLevel,
            });
            const entryIds = await appendPiHistory(tx, id, source);

            await tx.appendEntry(id, {
                kind: FROM_PI_ENTRY,
                data: { session: source.header.id, title: source.title, file: source.path },
            });
            const stored = await tx.doc(ImportedSessionDoc, id);

            stored.source = {
                path: source.path,
                sha256: source.sha256,
                sessionId: source.header.id,
                leafId: source.leafId,
                importedBy: current.id,
                importedAt: Date.now(),
                entryIds,
            };
            stored.archive = source.archive;
            const sessions = await tx.doc(SessionsDoc);

            sessions.items[String(id)] = {
                cwd,
                threadType: "chat",
                ...(placement?.projectId === undefined ? {} : { projectId: placement.projectId }),
                title: source.title,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                createdBy: current.id,
                ownerOnly: visibility === "owner",
                imported: true,
                fromPi: {
                    session: source.header.id,
                    count: source.branch.filter((entry) => entry.type === "message").length,
                },
            };
            imports.items[key] = id;
            this.requireAccess(current);

            return { id, existing: false };
        }, context);
    }

    async archive(user: User, id: ConversationId): Promise<string> {
        if (this.#app.config.userById(user.id)?.role !== "owner") {
            throw new HttpError(403, "Only the owner can download original Pi sessions");
        }

        const imported = await this.#app.harness.snapshot(ImportedSessionDoc, id, context);

        if (imported?.source === undefined) {
            throw new HttpError(404, "This conversation has no source archive");
        }

        if (this.#app.config.userById(user.id)?.role !== "owner") {
            throw new HttpError(403, "Only the owner can download original Pi sessions");
        }

        return imported.archive;
    }
}
