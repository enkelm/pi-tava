/** Comment-first reviews of live changes; explicit human suggestions reuse guarded Workspace saves. */
import { createHash } from "node:crypto";
import { constants, fstatSync, lstatSync, realpathSync, statSync, type Stats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import { changesIn, diffOf, type Changes } from "./changes.ts";
import type { User } from "./config.ts";
import {
    CommentReviewDoc,
    ReviewSuggestionsDoc,
    TurnsDoc,
    type ChangeReviews,
    type ReviewMessage,
    type ReviewSuggestionState,
} from "./docs.ts";
import { describe, HttpError } from "./errors.ts";
import {
    boundedBytes,
    decodeText,
    fileEditInput,
    MAX_EDIT_BYTES,
    textRevision,
} from "./file-edits.ts";
import { replaceReviewRange, reviewSuggestions } from "./review-suggestions.ts";
import { requireWorkflowLocalWrite, reserveWorkflowLocalWrite } from "./workflow-policy.ts";
import { inspectRemoteFileEdit } from "./remote-file-edits.ts";
import { git, GitError } from "./git.ts";
import { isMissingWorkspaceFile, type WorkspaceBackend } from "./workspace-backend.ts";

const context = BACKGROUND_CONTEXT;
const MAX_COMMENTS = 500;
const MAX_REQUESTS = 4000;
const MAX_METADATA_BYTES = 1024 * 1024;

type Scope = {
    cwd: string;
    folder: string;
    root?: string;
    prefix: string;
    backend: WorkspaceBackend;
    location: string | undefined;
    projectId: string | undefined;
};
type ReviewData = ChangeReviews & { requests: Record<string, string> };
export type CommentReview = {
    requestId: unknown;
    text: unknown;
    threadId?: unknown;
    path?: unknown;
    side?: unknown;
    startLine?: unknown;
    line?: unknown;
    context?: unknown;
};
export type ResolveReview = { requestId: unknown; threadIds: unknown; resolved: unknown };
export type ApplyReviewSuggestion = {
    threadId: unknown;
    commentId: unknown;
    index: unknown;
    requestId: unknown;
};

/** Shared anchor shape/range rules; optional single-line context preserves legacy human comments. */
export function validateReviewAnchor(
    input: Pick<CommentReview, "threadId" | "path" | "side" | "line" | "startLine" | "context">,
): void {
    const { threadId, path, side, line, startLine, context: excerpt } = input;
    const contextLimit = startLine === undefined ? 1000 : 8000;

    if (
        excerpt !== undefined &&
        (typeof excerpt !== "string" || excerpt.length > contextLimit || excerpt.includes("\0"))
    ) {
        throw new HttpError(400, `context must be at most ${contextLimit} characters without NUL`);
    }

    if (
        threadId !== undefined &&
        (path !== undefined ||
            side !== undefined ||
            line !== undefined ||
            startLine !== undefined ||
            excerpt !== undefined)
    ) {
        throw new HttpError(400, "Replies use their thread's existing anchor");
    }

    if (
        (side !== undefined ||
            line !== undefined ||
            startLine !== undefined ||
            excerpt !== undefined) &&
        (path === undefined ||
            (side !== "old" && side !== "new") ||
            !Number.isSafeInteger(line) ||
            Number(line) < 1 ||
            Number(line) > 10_000_000)
    ) {
        throw new HttpError(
            400,
            "A line comment needs a file, old/new side, and positive line number",
        );
    }

    if (
        startLine !== undefined &&
        (!Number.isSafeInteger(startLine) ||
            Number(startLine) < 1 ||
            Number(startLine) > Number(line) ||
            Number(line) - Number(startLine) >= 100 ||
            typeof excerpt !== "string" ||
            excerpt.split("\n").length !== Number(line) - Number(startLine) + 1)
    ) {
        throw new HttpError(400, "A range needs 1–100 inclusive lines and their complete context");
    }
}

function text(value: unknown, label: string, limit: number, preserveLeading = false): string {
    if (typeof value !== "string" || value.trim() === "") {
        throw new HttpError(400, `${label} is required`);
    }

    if (value.length > limit) {
        throw new HttpError(413, `${label} is limited to ${limit} characters`);
    }

    // Bodies retain first-line Markdown indentation, but outer blank lines still normalize as before.
    // Metadata always keeps its legacy normalization.
    return preserveLeading
        ? value.replace(/^(?:[^\S\r\n]*(?:\r\n?|\n))+/, "").trimEnd()
        : value.trim();
}

/** Git paths are literal: spaces, tabs and newlines in a name must not be trimmed. */
function filePath(value: unknown): string {
    if (
        typeof value !== "string" ||
        value === "" ||
        value.length > 4096 ||
        value.includes("\0") ||
        isAbsolute(value) ||
        value.split("/").some((part) => part === "" || part === "." || part === "..")
    ) {
        throw new HttpError(400, "path must be a relative file path without traversal or NUL");
    }

    return value;
}

function digest(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function requestKey(user: User, value: unknown): string {
    return digest([user.id, text(value, "requestId", 160)]);
}

/** Keep receipts forever within a bounded document; never replay an old resolve over newer work. */
function retry(doc: ReviewData, user: User, key: string, operation: unknown): boolean {
    const fingerprint = digest(operation);

    if (Object.hasOwn(doc.requests, key)) {
        if (doc.requests[key] !== fingerprint) {
            throw new HttpError(409, "This requestId was already used for a different action");
        }

        return true;
    }

    // Leave administration capacity for the owner even after collaborators fill their allowance.
    if (Object.keys(doc.requests).length >= (user.role === "owner" ? MAX_REQUESTS : 3500)) {
        throw new HttpError(413, "This session has reached its review action limit");
    }

    doc.requests[key] = fingerprint;

    return false;
}

function bounded(doc: ReviewData, user: User): void {
    if (
        Buffer.byteLength(JSON.stringify(doc)) >
        (user.role === "owner" ? MAX_METADATA_BYTES : 800 * 1024)
    ) {
        throw new HttpError(413, "This session has reached its review metadata limit");
    }
}

function inside(folder: string, file: string): boolean {
    const tail = relative(folder, file);

    return tail === "" || (tail !== ".." && !tail.startsWith(`..${sep}`) && !isAbsolute(tail));
}

/** Deleted anchors still work, but an existing parent symlink cannot take them outside the folder. */
function canonicalParent(path: string): string {
    let parent = dirname(path);

    while (true) {
        try {
            return resolve(realpathSync(parent), relative(parent, path));
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;

            if ((code !== "ENOENT" && code !== "ENOTDIR") || dirname(parent) === parent) {
                throw new HttpError(404, "That file is not accessible in this session folder");
            }

            parent = dirname(parent);
        }
    }
}

function inScope(scope: Scope, path: string): boolean {
    return (
        path.startsWith(scope.prefix) &&
        inside(scope.folder, canonicalParent(resolve(scope.root ?? scope.folder, path)))
    );
}

/** Remote anchors canonicalize parents on the selected host, including deleted files. */
async function inDestinationScope(
    scope: Scope,
    path: string,
    requirePrefix = true,
): Promise<boolean> {
    if (!scope.backend.remote) {
        return requirePrefix
            ? inScope(scope, path)
            : inside(scope.folder, canonicalParent(resolve(scope.root ?? scope.cwd, path)));
    }

    const backend = scope.backend;
    const file = backend.paths.resolve(scope.root ?? scope.folder, path);
    const parent = backend.paths.dirname(file);

    try {
        const canonical = backend.paths.resolve(
            await backend.canonicalWithMissingTail(parent),
            backend.paths.relative(parent, file),
        );
        const tail = backend.paths.relative(scope.folder, canonical);

        return (
            (!requirePrefix || path.startsWith(scope.prefix)) &&
            (tail === "" ||
                (tail !== ".." && !tail.startsWith("../") && !backend.paths.isAbsolute(tail)))
        );
    } catch (error) {
        if (isMissingWorkspaceFile(error)) {
            return false;
        }

        throw error;
    }
}

/** Identity and byte-version checks keep a raced context read from being returned as current text. */
function unchangedFile(before: Stats, after: Stats): boolean {
    return (
        before.dev === after.dev &&
        before.ino === after.ino &&
        before.size === after.size &&
        before.mtimeMs === after.mtimeMs &&
        before.ctimeMs === after.ctimeMs &&
        before.mode === after.mode &&
        before.nlink === after.nlink &&
        before.uid === after.uid &&
        before.gid === after.gid
    );
}

/** Remove only Git's final record newline, not whitespace belonging to a folder or branch name. */
function record(output: string): string {
    return output.endsWith("\n") ? output.slice(0, -1) : output;
}

export class Reviews {
    readonly #app: PocketApp;
    readonly #applying = new Map<string, Promise<ReviewSuggestionState>>();

    constructor(app: PocketApp) {
        this.#app = app;
    }

    #person(id: ConversationId, supplied: User): User {
        const user = this.#app.config.userById(supplied.id);

        if (user === undefined) {
            throw new HttpError(401, "Your access was removed");
        }

        if (user.tokenHash !== supplied.tokenHash) {
            throw new HttpError(401, "Your sign-in changed. Reload before reviewing.");
        }

        this.#app.requireSee(user, id);

        return user;
    }

    async list(id: ConversationId, supplied: User): Promise<ChangeReviews> {
        // Config can update its User object in place; retain this request's original token across awaits.
        supplied = { ...supplied };
        this.#person(id, supplied);
        await this.#app.conversation(id);
        const doc = await this.#app.harness.snapshot(CommentReviewDoc, id, context);

        this.#person(id, supplied);

        return JSON.parse(
            JSON.stringify({ threads: doc?.threads ?? [], rev: doc?.rev ?? 0 }),
        ) as ChangeReviews;
    }

    async #scope(id: ConversationId, user: User, backend?: WorkspaceBackend): Promise<Scope> {
        this.#person(id, user);
        backend ??= this.#app.workspace.backend(id, user);
        const cwd = this.#app.cwdOf(id);
        const location = JSON.stringify(this.#app.locationOf(id));
        const projectId = this.#app.sessionMeta(this.#app.rootOf(id))?.projectId;
        let folder: string;

        try {
            folder = await backend.canonical(cwd);
        } catch {
            throw new HttpError(404, "The session folder is not accessible");
        }

        const root = await git(folder, ["rev-parse", "--show-toplevel"], {
            backend,
            offline: () => this.#app.workItems.isManaged(id),
        }).then(record, (error: unknown) => {
            if (backend.remote && (!(error instanceof GitError) || error.exitCode !== 128)) {
                throw error;
            }

            return undefined;
        });
        const scope = { cwd, folder, root, prefix: "", backend, location, projectId };

        if (root !== undefined) {
            if (!(await backend.contains(root, folder))) {
                throw new HttpError(409, "The session folder is outside its checkout");
            }

            const tail = backend.paths.relative(root, folder).split(backend.paths.sep).join("/");

            scope.prefix = tail === "" ? "" : `${tail}/`;
        }

        await this.#guard(id, user, scope);

        return scope;
    }

    #destination(id: ConversationId, scope: Scope): void {
        scope.backend.checkAccess();

        if (
            this.#app.cwdOf(id) !== scope.cwd ||
            JSON.stringify(this.#app.locationOf(id)) !== scope.location ||
            this.#app.sessionMeta(this.#app.rootOf(id))?.projectId !== scope.projectId
        ) {
            throw new HttpError(
                409,
                "The workspace destination changed; refresh before trying again",
            );
        }
    }

    #fingerprint(scope: Scope): string {
        const physical = scope.backend.remote ? undefined : statSync(scope.folder);

        return digest([
            scope.cwd,
            scope.folder,
            scope.root,
            scope.location,
            scope.projectId,
            physical?.dev,
            physical?.ino,
        ]);
    }

    async #guard(id: ConversationId, user: User, scope: Scope): Promise<void> {
        this.#destination(id, scope);

        if (!scope.backend.remote) {
            this.#guardLocal(id, user, scope);

            return;
        }

        this.#person(id, user);

        if (
            this.#app.cwdOf(id) !== scope.cwd ||
            (await scope.backend.canonical(scope.cwd)) !== scope.folder
        ) {
            throw new HttpError(409, "The session folder changed; refresh before trying again");
        }

        this.#person(id, user);
    }

    #guardLocal(id: ConversationId, user: User, scope: Scope): void {
        this.#destination(id, scope);
        this.#person(id, user);

        if (this.#app.cwdOf(id) !== scope.cwd) {
            throw new HttpError(409, "The session folder changed; refresh before trying again");
        }

        try {
            if (realpathSync(scope.cwd) === scope.folder) {
                return;
            }
        } catch {
            // A removed or retargeted folder invalidates an in-flight read.
        }

        throw new HttpError(409, "The session folder changed; refresh before trying again");
    }

    async #changes(id: ConversationId, user: User, scope: Scope): Promise<Changes> {
        const entries = await this.#app.transcripts.allEntries(id, false);
        const changes = await changesIn(scope.cwd, entries, true, {
            backend: scope.backend,
            offline: () => this.#app.workItems.isManaged(id),
        });

        await this.#guard(id, user, scope);

        if (changes.repo?.root !== scope.root) {
            throw new HttpError(409, "The session checkout changed; refresh before trying again");
        }

        const files = await Promise.all(
            changes.files.map(async (file) =>
                (await inDestinationScope(scope, file.path)) ? file : undefined,
            ),
        );
        const piOnly = await Promise.all(
            changes.piOnly.map(async (file) =>
                (await inDestinationScope(scope, file.path, false)) ? file : undefined,
            ),
        );

        await this.#guard(id, user, scope);

        return {
            ...changes,
            files: files.filter((file) => file !== undefined),
            piOnly: piOnly.filter((file) => file !== undefined),
        };
    }

    /** Keep the shared Changes attribution and Pi-only edits, with review access restricted to cwd. */
    async changes(
        id: ConversationId,
        user: User,
        context: Context = BACKGROUND_CONTEXT,
    ): Promise<Changes> {
        user = { ...user };
        this.#person(id, user);
        await this.#app.conversation(id);

        return this.#app.sshSessions.withWorkspace(id, user, context, async (backend) => {
            const scope = await this.#scope(id, user, backend);

            return this.#changes(id, user, scope);
        });
    }

    async diff(
        id: ConversationId,
        user: User,
        value: string,
        context: Context = BACKGROUND_CONTEXT,
    ): Promise<string> {
        user = { ...user };
        this.#person(id, user);
        const path = filePath(value);

        await this.#app.conversation(id);

        return this.#app.sshSessions.withWorkspace(id, user, context, async (backend) => {
            const scope = await this.#scope(id, user, backend);

            if (!(await inDestinationScope(scope, path))) {
                throw new HttpError(
                    404,
                    "That file has no uncommitted changes in this session folder",
                );
            }

            const diff = await diffOf(scope.cwd, path, true, {
                backend: scope.backend,
                offline: () => this.#app.workItems.isManaged(id),
                checkRoot(root) {
                    if (root !== scope.root) {
                        throw new HttpError(
                            409,
                            "The session checkout changed; refresh before trying again",
                        );
                    }
                },
            }).catch((error: unknown) => {
                if (error instanceof HttpError) {
                    throw error;
                }

                throw new HttpError(404, describe(error));
            });

            await this.#guard(id, user, scope);

            if (!(await inDestinationScope(scope, path))) {
                throw new HttpError(404, "That file is outside this session folder");
            }

            return diff;
        });
    }

    /** Complete current text for hidden diff context, never a general-purpose file viewer. */
    async context(
        id: ConversationId,
        user: User,
        value: string,
        context: Context = BACKGROUND_CONTEXT,
    ): Promise<{ text: string }> {
        user = { ...user };
        this.#person(id, user);
        const path = filePath(value);

        await this.#app.conversation(id);

        return this.#app.sshSessions.withWorkspace(id, user, context, (backend) =>
            this.#context(id, user, path, backend),
        );
    }

    async #context(
        id: ConversationId,
        user: User,
        path: string,
        backend: WorkspaceBackend,
    ): Promise<{ text: string }> {
        const scope = await this.#scope(id, user, backend);
        const changes = await this.#changes(id, user, scope);

        if (!changes.files.some((file) => file.path === path)) {
            throw new HttpError(404, "That file has no uncommitted changes in this session folder");
        }

        if (scope.backend.remote) {
            try {
                const backend = scope.backend;
                const file = backend.paths.resolve(scope.root ?? scope.folder, path);

                // Reviews intentionally retain their stricter no-symlink-spelling rule, even
                // though Files quick edits can authorize a canonical alias within their root.
                if (
                    (await backend.canonical(file)) !== file ||
                    !(await inDestinationScope(scope, path))
                ) {
                    throw new HttpError(
                        404,
                        "Review context requires a regular file inside this session folder",
                    );
                }

                await this.#guard(id, user, scope);
                const snapshot = await inspectRemoteFileEdit({
                    backend,
                    root: scope.folder,
                    file,
                    offline: this.#app.workItems.isManaged(id),
                });
                const text = decodeText(snapshot.bytes);

                if (text === undefined) {
                    throw new HttpError(
                        415,
                        "Review context requires UTF-8 text without NUL characters",
                    );
                }

                await this.#guard(id, user, scope);

                if (
                    !(await inDestinationScope(scope, path)) ||
                    (await backend.canonical(file)) !== file
                ) {
                    throw new HttpError(
                        404,
                        "That file is outside this session folder or changed to a symlink",
                    );
                }

                this.#person(id, user);
                backend.checkAccess();

                return { text };
            } catch (error) {
                if (error instanceof HttpError) {
                    throw error;
                }

                throw new HttpError(404, "That file is unavailable for native review context");
            }
        }

        let handle: FileHandle | undefined;

        try {
            const file = resolve(scope.root ?? scope.folder, path);
            const parent = dirname(file);
            const named = lstatSync(file);
            const directory = statSync(parent);

            if (
                !named.isFile() ||
                !inside(scope.folder, file) ||
                realpathSync(file) !== file ||
                realpathSync(parent) !== parent
            ) {
                throw new HttpError(
                    404,
                    "Review context requires a regular file inside this session folder",
                );
            }

            if (named.size > MAX_EDIT_BYTES) {
                throw new HttpError(
                    413,
                    "Review context is limited to complete text files of 512 KiB",
                );
            }

            const check = () => {
                this.#guardLocal(id, user, scope);
                const currentParent = statSync(parent);

                if (
                    !unchangedFile(named, lstatSync(file)) ||
                    realpathSync(file) !== file ||
                    realpathSync(parent) !== parent ||
                    directory.dev !== currentParent.dev ||
                    directory.ino !== currentParent.ino
                ) {
                    throw new HttpError(409, "The file changed while reading review context");
                }
            };

            handle = await open(
                file,
                constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
            );
            check();

            if (!unchangedFile(named, fstatSync(handle.fd))) {
                throw new HttpError(409, "The file changed while opening review context");
            }

            const bytes = await boundedBytes(handle);

            check();

            if (!unchangedFile(named, fstatSync(handle.fd)) || bytes.length !== named.size) {
                throw new HttpError(409, "The file changed while reading review context");
            }

            if (bytes.length > MAX_EDIT_BYTES) {
                throw new HttpError(
                    413,
                    "Review context is limited to complete text files of 512 KiB",
                );
            }

            const text = decodeText(bytes);

            if (text === undefined) {
                throw new HttpError(
                    415,
                    "Review context requires UTF-8 text without NUL characters",
                );
            }

            await handle.close();
            handle = undefined;
            // Recheck after the final await; no path or permission result is trusted across a yield.
            check();

            return { text };
        } catch (error) {
            if (error instanceof HttpError) {
                throw error;
            }

            throw new HttpError(404, "That file is unavailable for review context");
        } finally {
            if (handle !== undefined) {
                await handle.close().catch(() => {});
            }
        }
    }

    async comment(
        id: ConversationId,
        supplied: User,
        input: CommentReview,
    ): Promise<{ id: string }> {
        supplied = { ...supplied };
        this.#person(id, supplied);
        await this.#app.conversation(id);

        return this.#app.harness.commit((tx) => this.#commentIn(tx, id, supplied, input), context);
    }

    /** Internal sink: PiP owns invocation authority and commits its provenance/receipt in this same transaction. */
    async commentAsPiP(
        tx: Tx,
        id: ConversationId,
        supplied: User,
        input: CommentReview,
    ): Promise<{ id: string }> {
        return this.#commentIn(tx, id, { ...supplied }, input, true);
    }

    async #commentIn(
        tx: Tx,
        id: ConversationId,
        supplied: User,
        input: CommentReview,
        asPiP = false,
    ): Promise<{ id: string }> {
        const person = this.#person(id, supplied);
        const key = asPiP
            ? digest(["pip", person.id, text(input?.requestId, "requestId", 160)])
            : requestKey(person, input?.requestId);
        const messageId = `c-${key}`;
        const message = text(input?.text, "text", 4000, true);
        const threadId =
            input?.threadId === undefined ? undefined : text(input.threadId, "threadId", 160);
        const path = input?.path === undefined ? undefined : filePath(input.path);
        const side = input?.side;
        const line = input?.line;
        const startLine = input?.startLine;
        const excerpt = input?.context;

        validateReviewAnchor({ threadId, path, side, line, startLine, context: excerpt });

        const doc = await tx.doc(CommentReviewDoc, id);
        let user = this.#person(id, supplied);

        if (
            retry(doc, user, key, [
                "comment",
                message,
                threadId ?? null,
                path ?? null,
                side ?? null,
                line ?? null,
                excerpt ?? null,
                ...(startLine === undefined ? [] : [startLine]),
            ])
        ) {
            return { id: messageId };
        }

        if (
            doc.threads.reduce((count, thread) => count + 1 + thread.replies.length, 0) >=
            MAX_COMMENTS
        ) {
            throw new HttpError(
                413,
                `A session is limited to ${MAX_COMMENTS} review comments and replies`,
            );
        }

        const thread =
            threadId === undefined ? undefined : doc.threads.find((item) => item.id === threadId);

        if (threadId !== undefined && thread === undefined) {
            throw new HttpError(404, "No such review thread");
        }

        // No disk read is required for conversation comments or replies, including after a cwd change.
        const scope = path === undefined ? undefined : await this.#scope(id, supplied);

        if (scope !== undefined && !(await inDestinationScope(scope, path!))) {
            throw new HttpError(400, "The comment must name a file inside this session folder");
        }

        if (scope !== undefined) {
            await this.#guard(id, supplied, scope);
        }

        let workspace = scope === undefined ? undefined : this.#fingerprint(scope);

        if (
            thread !== undefined &&
            thread.cwd === this.#app.cwdOf(id) &&
            thread.path !== undefined &&
            thread.side === "new" &&
            thread.line !== undefined &&
            thread.context !== undefined &&
            reviewSuggestions(message).length > 0
        ) {
            try {
                const current = await this.#scope(id, supplied);

                if (
                    thread.cwd === current.cwd &&
                    (await inDestinationScope(current, filePath(thread.path)))
                ) {
                    await this.#guard(id, supplied, current);
                    workspace = this.#fingerprint(current);
                }
            } catch {
                // Proposing is not applying. A missing/stale destination leaves a display-only reply,
                // including discussions of deleted files/folders; final posting still rechecks access.
            }
        }

        user = this.#person(id, supplied);
        const comment = {
            id: messageId,
            userId: asPiP ? "pip" : user.id,
            name: asPiP ? "PiP" : user.name,
            text: message,
            at: Date.now(),
            ...(workspace === undefined ? {} : { workspace }),
            ...(asPiP ? { service: "pip" as const } : {}),
        };

        if (thread !== undefined) {
            thread.replies.push(comment);
        } else {
            doc.threads.push({
                ...comment,
                cwd: scope?.cwd ?? this.#app.cwdOf(id),
                ...(path === undefined ? {} : { path }),
                ...(side === undefined ? {} : { side: side as "old" | "new", line: Number(line) }),
                ...(startLine === undefined ? {} : { startLine: Number(startLine) }),
                ...(excerpt === undefined ? {} : { context: excerpt as string }),
                resolved: false,
                replies: [],
            });
        }

        doc.rev++;

        if (!asPiP) {
            await this.#app.pip.admitMention(tx, id, supplied, {
                kind: "review",
                threadId: thread?.id ?? messageId,
                commentId: messageId,
            });
        }

        user = this.#person(id, supplied);
        bounded(doc, user);

        return { id: messageId };
    }

    /** Human-only application. A durable claim is a one-way fence against ever repeating a filesystem write. */
    async applySuggestion(
        id: ConversationId,
        supplied: User,
        input: ApplyReviewSuggestion,
    ): Promise<ReviewSuggestionState> {
        supplied = structuredClone(supplied);
        this.#app.requireSteer(this.#person(id, supplied));
        const threadId = text(input?.threadId, "threadId", 160);
        const commentId = text(input?.commentId, "commentId", 160);
        const index = input?.index;
        const request = requestKey(supplied, input?.requestId);

        if (!Number.isSafeInteger(index) || Number(index) < 0 || Number(index) > 1000) {
            throw new HttpError(400, "index must select a top-level suggestion fence");
        }

        const target = digest([threadId, commentId, index]);
        const queueKey = `${id}:${target}`;
        const previous = this.#applying.get(queueKey);
        const release = reserveWorkflowLocalWrite(this.#app, id);
        const operation = (async () => {
            // Other calls in this process wait for settlement, never reconcile an actively executing save.
            await previous?.catch(() => {});

            return this.#applySuggestion(
                id,
                supplied,
                threadId,
                commentId,
                Number(index),
                request,
                target,
            );
        })();

        this.#applying.set(queueKey, operation);

        try {
            return await operation;
        } finally {
            release();

            if (this.#applying.get(queueKey) === operation) {
                this.#applying.delete(queueKey);
            }
        }
    }

    async #applySuggestion(
        id: ConversationId,
        supplied: User,
        threadId: string,
        commentId: string,
        index: number,
        request: string,
        target: string,
    ): Promise<ReviewSuggestionState> {
        const authorize = async (tx?: Tx) => {
            const user = this.#person(id, supplied);

            if (tx === undefined) {
                await this.#app.requireDriver(id, user);
            } else {
                const turns = await tx.doc(TurnsDoc, this.#app.rootOf(id));

                if (turns.on && turns.driver !== user.id) {
                    throw new HttpError(
                        409,
                        "Take turns is on: take the wheel before applying a suggestion.",
                    );
                }
            }

            this.#app.requireSteer(this.#person(id, supplied));
            requireWorkflowLocalWrite(this.#app, id);

            if (this.#app.isBusy(id)) {
                throw new HttpError(
                    409,
                    "Pi is working here: stop it or wait before applying a suggestion.",
                );
            }
        };

        await authorize();
        await this.#app.conversation(id);
        const snapshot = await this.#app.harness.snapshot(CommentReviewDoc, id, context);
        const thread = snapshot?.threads.find((item) => item.id === threadId);
        const message =
            thread?.id === commentId
                ? thread
                : thread?.replies.find((item) => item.id === commentId);

        if (thread === undefined || message === undefined) {
            throw new HttpError(404, "No such review comment");
        }

        const replacement = reviewSuggestions(message.text)[index];

        if (replacement === undefined) {
            throw new HttpError(400, "No complete top-level suggestion exists at this index");
        }

        const sourceWorkspace = message.workspace ?? thread.workspace;

        if (
            thread.path === undefined ||
            thread.side !== "new" ||
            thread.line === undefined ||
            thread.context === undefined ||
            sourceWorkspace === undefined
        ) {
            throw new HttpError(
                409,
                "Suggestions require a new-side line anchor with complete original context and destination.",
            );
        }

        const path = filePath(thread.path);
        const scope = await this.#scope(id, supplied);
        const fingerprint = this.#fingerprint(scope);

        if (sourceWorkspace !== fingerprint || !(await inDestinationScope(scope, path))) {
            throw new HttpError(409, "The review's original workspace or file scope changed.");
        }

        const file = scope.backend.paths.resolve(scope.root ?? scope.folder, path);

        const guard = async (tx?: Tx) => {
            await authorize(tx);
            await this.#guard(id, supplied, scope);

            if (
                this.#fingerprint(scope) !== fingerprint ||
                (await scope.backend.canonical(file)) !== file ||
                !(await inDestinationScope(scope, path))
            ) {
                throw new HttpError(409, "The review destination changed or became a symlink.");
            }

            this.#destination(id, scope);

            if (this.#fingerprint(scope) !== fingerprint) {
                throw new HttpError(409, "The review's original workspace was replaced.");
            }
        };

        await guard();
        const view = await this.#app.workspace.viewFile(id, supplied, file);

        await guard();

        if (
            view.path !== file ||
            view.kind !== "text" ||
            view.truncated ||
            view.revision === undefined ||
            !view.editable
        ) {
            throw new HttpError(
                409,
                "This file is not eligible for a complete, guarded text save.",
            );
        }

        const prior = await this.#app.harness.snapshot(ReviewSuggestionsDoc, id, context);
        const existing = prior?.claims[target];
        // A claimed action can only inspect expected output. Even unchanged input must not cause a retry.
        const output =
            existing === undefined
                ? replaceReviewRange(
                      view.text,
                      thread.startLine ?? thread.line,
                      thread.line,
                      thread.context,
                      replacement,
                  )
                : undefined;
        const expected =
            output === undefined
                ? existing!.expectedRevision
                : textRevision(fileEditInput(file, output, view.revision).bytes);
        const state = await this.#app.harness.commit(async (tx) => {
            const doc = await tx.doc(CommentReviewDoc, id);
            const claims = await tx.doc(ReviewSuggestionsDoc, id);
            const current = doc.threads.find((item) => item.id === threadId);
            const comment =
                current?.id === commentId
                    ? current
                    : current?.replies.find((item) => item.id === commentId);

            await guard(tx);
            const user = this.#person(id, supplied);

            if (
                comment === undefined ||
                (comment.workspace ?? current?.workspace) !== fingerprint ||
                comment.text !== message.text
            ) {
                throw new HttpError(409, "The suggestion source changed.");
            }

            retry(doc, user, request, ["suggestion", threadId, commentId, index]);
            let claim = claims.claims[target];
            const fresh = claim === undefined;

            if (claim === undefined) {
                if (Object.keys(claims.claims).length >= 2000) {
                    throw new HttpError(
                        413,
                        "This session has reached its suggestion application limit.",
                    );
                }

                claim = { workspace: fingerprint, path: file, expectedRevision: expected };
                claims.claims[target] = claim;
                comment.suggestions ??= {};
                comment.suggestions[String(index)] = {
                    status: "applying",
                    by: user.id,
                    at: Date.now(),
                };
                doc.rev++;
            }

            if (claim.workspace !== fingerprint || claim.path !== file) {
                throw new HttpError(
                    409,
                    "The claimed suggestion belongs to a different destination.",
                );
            }

            bounded(doc, user);

            return {
                fresh,
                state: { ...comment.suggestions![String(index)]! },
                expected: claim.expectedRevision,
            };
        }, context);

        if (!state.fresh) {
            if (state.state.status === "applied") {
                return state.state;
            }

            // Restart/lost acknowledgement reconciliation has no filesystem mutation path.
            return this.#settleSuggestion(
                id,
                threadId,
                commentId,
                index,
                view.revision === state.expected ? "applied" : "uncertain",
            );
        }

        try {
            await guard();
            this.#destination(id, scope);
            await this.#app.workspace.saveFile(id, supplied, file, output!, view.revision, guard);
        } catch (error) {
            this.#app.log(`review suggestion save uncertain: ${describe(error)}`);

            return this.#settleSuggestion(id, threadId, commentId, index, "uncertain");
        }

        return this.#settleSuggestion(id, threadId, commentId, index, "applied");
    }

    async #settleSuggestion(
        id: ConversationId,
        threadId: string,
        commentId: string,
        index: number,
        status: "applied" | "uncertain",
    ): Promise<ReviewSuggestionState> {
        return this.#app.harness.commit(async (tx) => {
            const doc = await tx.doc(CommentReviewDoc, id);
            const thread = doc.threads.find((item) => item.id === threadId)!;
            const message: ReviewMessage =
                thread.id === commentId
                    ? thread
                    : thread.replies.find((item) => item.id === commentId)!;
            const state = message.suggestions![String(index)]!;

            if (state.status !== "applied" && state.status !== status) {
                state.status = status;
                doc.rev++;
            }

            return { ...state };
        }, context);
    }

    async resolve(id: ConversationId, supplied: User, input: ResolveReview): Promise<void> {
        supplied = { ...supplied };
        const person = this.#person(id, supplied);
        const key = requestKey(person, input?.requestId);
        const resolved = input?.resolved;

        if (
            !Array.isArray(input?.threadIds) ||
            input.threadIds.length === 0 ||
            input.threadIds.length > MAX_COMMENTS ||
            typeof resolved !== "boolean"
        ) {
            throw new HttpError(400, `Choose 1–${MAX_COMMENTS} threadIds and a boolean resolved`);
        }

        const ids = [
            ...new Set(input.threadIds.map((value) => text(value, "threadId", 160))),
        ].sort();

        await this.#app.conversation(id);
        await this.#app.harness.commit(async (tx) => {
            const doc = await tx.doc(CommentReviewDoc, id);
            const user = this.#person(id, supplied);
            // Authorize the entire batch, including retries, before recording or changing anything.
            const threads = ids.map((threadId) => {
                const thread = doc.threads.find((item) => item.id === threadId);

                if (thread === undefined) {
                    throw new HttpError(404, "No such review thread");
                }

                if (user.role !== "owner" && thread.userId !== user.id) {
                    throw new HttpError(
                        403,
                        "Only the owner or original author can resolve a thread",
                    );
                }

                return thread;
            });

            if (retry(doc, user, key, ["resolve", ids, resolved])) {
                return;
            }

            for (const thread of threads) {
                if (thread.resolved === resolved) {
                    continue;
                }

                thread.resolved = resolved;

                if (resolved) {
                    thread.resolvedBy = user.id;
                } else {
                    delete thread.resolvedBy;
                }
            }

            doc.rev++;
            bounded(doc, user);
        }, context);
    }
}
