/** Owner-confirmed imports of stopped Pi sessions, with private archives and optional shared conversations. */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { configure, type ConversationId, type Tx } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { ImportedSessionDoc, ImportsDoc, SessionsDoc, TakeoversDoc } from "./docs.ts";
import { HttpError } from "./errors.ts";
import { appendPiHistory, readPiSession } from "./imports/pi-session.ts";
import { ActiveImports } from "./imports/active.ts";
import { modelList } from "./models.ts";

const context = BACKGROUND_CONTEXT;

export type ImportRequest = {
    path?: unknown;
    leafId?: unknown;
    sha256?: unknown;
    stopped?: unknown;
    acknowledged?: unknown;
    model?: unknown;
    thinkingLevel?: unknown;
    visibility?: unknown;
};

export type ImportVisibility = "owner" | "shared";

/** Omitted visibility preserves the owner-only import API. This check never publishes anything. */
export function importVisibility(request: ImportRequest): ImportVisibility {
    checkRequest(request);

    if (request.visibility === undefined || request.visibility === "owner") {
        return "owner";
    }

    if (request.visibility === "shared") {
        return "shared";
    }

    throw new HttpError(400, "Choose owner or shared import visibility");
}

async function reuseImport(tx: Tx, id: ConversationId, visibility: ImportVisibility) {
    if (visibility === "shared") {
        const sessions = await tx.doc(SessionsDoc);
        const session = sessions.items[String(id)];

        if (session?.imported !== true) {
            throw new HttpError(409, "The imported conversation is no longer available");
        }

        // Publication is one-way on retries and applies only to this selected branch, not older forks.
        session.ownerOnly = false;
    }

    return { id, existing: true };
}

function requireOwner(user: User): void {
    if (user.role !== "owner") {
        throw new HttpError(403, "Only the owner can import or download original Pi sessions");
    }
}

function checkRequest(request: ImportRequest): void {
    if (request === null || typeof request !== "object" || Array.isArray(request)) {
        throw new HttpError(400, "Expected an import request");
    }
}

function confirmedImport(request: ImportRequest) {
    const visibility = importVisibility(request);

    if (request.stopped !== true || request.acknowledged !== true) {
        throw new HttpError(
            400,
            "Confirm that the original Pi has exited and accept the import limitations",
        );
    }

    if (
        typeof request.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(request.sha256) ||
        typeof request.leafId !== "string"
    ) {
        throw new HttpError(400, "Preview the session and select a branch before importing");
    }

    return { visibility, key: `${request.sha256}:${request.leafId}` };
}

export class Imports {
    readonly #app: PocketApp;
    readonly #pending = new Map<string, { visibility: ImportVisibility; count: number }>();
    readonly active: ActiveImports;

    constructor(app: PocketApp) {
        this.#app = app;
        this.active = new ActiveImports(app, this);
    }

    async preview(user: User, request: ImportRequest) {
        requireOwner(user);
        const requestedVisibility = importVisibility(request);
        const source = await readPiSession(request.path, request.leafId);
        const cwd = this.#app.workspace.checkDirectory(source.header.cwd);
        const imports = await this.#app.harness.snapshot(ImportsDoc, context);
        const existing = imports?.items[`${source.sha256}:${source.leafId}`];
        const visibility: ImportVisibility =
            requestedVisibility === "shared" ||
            (existing !== undefined && this.#app.sessionMeta(existing)?.ownerOnly === false)
                ? "shared"
                : "owner";

        return {
            path: source.path,
            sha256: source.sha256,
            leafId: source.leafId,
            title: source.title,
            cwd,
            sourceSessionId: source.header.id,
            entries: source.branch.length,
            messages: source.messages.length,
            hasImages: source.hasImages,
            leaves: source.leaves,
            warnings: source.warnings,
            sourceModel: source.model,
            sourceThinkingLevel: source.thinkingLevel,
            models: modelList(this.#app.models),
            visibility,
        };
    }

    /** Validate everything that could reject an import before a takeover stops its source process. */
    async prepare(user: User, request: ImportRequest) {
        requireOwner(user);
        const { visibility } = confirmedImport(request);
        const source = await readPiSession(request.path, request.leafId);

        if (source.sha256 !== request.sha256) {
            throw new HttpError(
                409,
                "The session changed since preview. Stop Pi and preview again.",
            );
        }

        const app = this.#app;
        const cwd = app.workspace.checkDirectory(source.header.cwd);
        const model = app.models
            .getAvailableSnapshot()
            .find((item) => `${item.provider}/${item.id}` === request.model);

        if (model === undefined) {
            throw new HttpError(400, "Choose an available destination model before importing");
        }

        if (source.hasImages && !model.input.includes("image")) {
            throw new HttpError(
                400,
                "This context includes images. Choose a destination model that accepts images.",
            );
        }

        const levels = model.reasoning ? getSupportedThinkingLevels(model) : ["off"];

        if (
            typeof request.thinkingLevel !== "string" ||
            !levels.includes(request.thinkingLevel as ModelThinkingLevel)
        ) {
            throw new HttpError(400, "Choose a thinking level supported by the destination model");
        }

        const thinkingLevel = request.thinkingLevel as ModelThinkingLevel;

        return { source, cwd, model, thinkingLevel, visibility };
    }

    /** Completed takeovers can retry without a source file, but sharing still requires explicit consent. */
    async retry(user: User, id: ConversationId, request: ImportRequest) {
        requireOwner(user);
        const visibility = importVisibility(request);

        if (request.acknowledged !== true) {
            throw new HttpError(400, "Confirm the import before publishing it");
        }

        return this.#app.harness.commit((tx) => reuseImport(tx, id, visibility), context);
    }

    async create(
        user: User,
        request: ImportRequest,
        takeoverId?: string,
    ): Promise<{ id: ConversationId; existing: boolean }> {
        requireOwner(user);
        const { visibility, key } = confirmedImport(request);
        const app = this.#app;
        // Reserve the intent before file I/O so a slower concurrent preview cannot silently change it.
        const pending = this.#pending.get(key) ?? { visibility, count: 0 };

        if (pending.visibility !== visibility) {
            throw new HttpError(409, "An import with different visibility is already in progress");
        }

        pending.count++;
        this.#pending.set(key, pending);

        try {
            const { source, cwd, model, thinkingLevel } = await this.prepare(user, request);

            // The index, archive, entries and catalogue publish together; matching retries still read the same index.
            return await app.harness.commit(async (tx) => {
                const imports = await tx.doc(ImportsDoc);
                const existing = imports.items[key];
                const takeovers = takeoverId === undefined ? undefined : await tx.doc(TakeoversDoc);
                const takeover =
                    takeoverId === undefined ? undefined : takeovers?.items[takeoverId];

                if (takeoverId !== undefined && takeover === undefined) {
                    throw new Error("Missing takeover reservation");
                }

                if (existing !== undefined) {
                    if (takeover) {
                        takeover.result = existing;
                    }

                    return reuseImport(tx, existing, visibility);
                }

                const conversation = await tx.createConversation({
                    ownership: { kind: "ownerless" },
                });
                const id = conversation.id;

                await configure(tx, id, {
                    cwd,
                    model: { provider: model.provider, modelId: model.id },
                    thinkingLevel,
                });
                const entryIds = await appendPiHistory(tx, id, source);
                const stored = await tx.doc(ImportedSessionDoc, id);

                stored.source = {
                    path: source.path,
                    sha256: source.sha256,
                    sessionId: source.header.id,
                    leafId: source.leafId,
                    importedBy: user.id,
                    importedAt: Date.now(),
                    entryIds,
                };
                stored.archive = source.archive;
                const sessions = await tx.doc(SessionsDoc);

                sessions.items[String(id)] = {
                    cwd,
                    title: source.title,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    createdBy: user.id,
                    ownerOnly: visibility === "owner",
                    imported: true,
                };
                imports.items[key] = id;

                if (takeover) {
                    takeover.result = id;
                }

                return { id, existing: false };
            }, context);
        } finally {
            if (--pending.count === 0) {
                this.#pending.delete(key);
            }
        }
    }

    /** The full source may contain other branches. It is never sent in room views and only the owner may download it. */
    async archive(user: User, id: ConversationId): Promise<string> {
        requireOwner(user);
        const imported = await this.#app.harness.snapshot(ImportedSessionDoc, id, context);

        if (imported?.source === undefined) {
            throw new HttpError(404, "This conversation has no source archive");
        }

        return imported.archive;
    }
}
