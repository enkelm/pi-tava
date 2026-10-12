/** Comment-first reviews of live changes. Review actions never drive Pi, edit files, or mutate Git. */
import { createHash } from "node:crypto";
import { constants, fstatSync, lstatSync, realpathSync, statSync, type Stats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import { changesIn, diffOf, type Changes } from "./changes.ts";
import type { User } from "./config.ts";
import { CommentReviewDoc, type ChangeReviews } from "./docs.ts";
import { describe, HttpError } from "./errors.ts";
import { boundedBytes, decodeText, MAX_EDIT_BYTES } from "./file-edits.ts";
import { git } from "./git.ts";

const context = BACKGROUND_CONTEXT;
const MAX_COMMENTS = 500;
const MAX_REQUESTS = 4000;
const MAX_METADATA_BYTES = 1024 * 1024;

type Scope = { cwd: string; folder: string; root?: string; prefix: string };
type ReviewData = ChangeReviews & { requests: Record<string, string> };
export type CommentReview = {
    requestId: unknown;
    text: unknown;
    threadId?: unknown;
    path?: unknown;
    side?: unknown;
    line?: unknown;
    context?: unknown;
};
export type ResolveReview = { requestId: unknown; threadIds: unknown; resolved: unknown };

function text(value: unknown, label: string, limit: number): string {
    if (typeof value !== "string" || value.trim() === "") {
        throw new HttpError(400, `${label} is required`);
    }

    if (value.length > limit) {
        throw new HttpError(413, `${label} is limited to ${limit} characters`);
    }

    return value.trim();
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

    constructor(app: PocketApp) {
        this.#app = app;
    }

    #person(id: ConversationId, supplied: User): User {
        const user = this.#app.config.userById(supplied.id);

        if (user === undefined) {
            throw new HttpError(401, "Your access was removed");
        }

        this.#app.requireSee(user, id);

        return user;
    }

    async list(id: ConversationId, supplied: User): Promise<ChangeReviews> {
        this.#person(id, supplied);
        await this.#app.conversation(id);
        const doc = await this.#app.harness.snapshot(CommentReviewDoc, id, context);

        this.#person(id, supplied);

        return JSON.parse(
            JSON.stringify({ threads: doc?.threads ?? [], rev: doc?.rev ?? 0 }),
        ) as ChangeReviews;
    }

    async #scope(id: ConversationId, user: User): Promise<Scope> {
        this.#person(id, user);
        const cwd = this.#app.cwdOf(id);
        let folder: string;

        try {
            folder = realpathSync(cwd);
        } catch {
            throw new HttpError(404, "The session folder is not accessible");
        }

        const root = await git(folder, ["rev-parse", "--show-toplevel"], {
            offline: () => this.#app.handoffs.isManaged(id),
        }).then(record, () => undefined);
        const scope = { cwd, folder, root, prefix: "" };

        if (root !== undefined) {
            if (!inside(root, folder)) {
                throw new HttpError(409, "The session folder is outside its checkout");
            }

            const tail = relative(root, folder).split(sep).join("/");

            scope.prefix = tail === "" ? "" : `${tail}/`;
        }

        this.#guard(id, user, scope);

        return scope;
    }

    #guard(id: ConversationId, user: User, scope: Scope): void {
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
            offline: () => this.#app.handoffs.isManaged(id),
        });

        this.#guard(id, user, scope);

        if (changes.repo?.root !== scope.root) {
            throw new HttpError(409, "The session checkout changed; refresh before trying again");
        }

        return {
            ...changes,
            files: changes.files.filter((file) => inScope(scope, file.path)),
            piOnly: changes.piOnly.filter((file) =>
                inside(scope.folder, canonicalParent(resolve(scope.root ?? scope.cwd, file.path))),
            ),
        };
    }

    /** Keep the shared Changes attribution and Pi-only edits, with review access restricted to cwd. */
    async changes(id: ConversationId, user: User): Promise<Changes> {
        this.#person(id, user);
        await this.#app.conversation(id);
        const scope = await this.#scope(id, user);

        return this.#changes(id, user, scope);
    }

    async diff(id: ConversationId, user: User, value: string): Promise<string> {
        this.#person(id, user);
        const path = filePath(value);

        await this.#app.conversation(id);
        const scope = await this.#scope(id, user);
        const changes = await this.#changes(id, user, scope);

        if (!changes.files.some((file) => file.path === path)) {
            throw new HttpError(404, "That file has no uncommitted changes in this session folder");
        }

        const diff = await diffOf(scope.cwd, path, true, {
            offline: () => this.#app.handoffs.isManaged(id),
        }).catch((error: unknown) => {
            throw new HttpError(404, describe(error));
        });

        this.#guard(id, user, scope);

        if (!inScope(scope, path)) {
            throw new HttpError(404, "That file is outside this session folder");
        }

        return diff;
    }

    /** Complete current text for hidden diff context, never a general-purpose file viewer. */
    async context(id: ConversationId, user: User, value: string): Promise<{ text: string }> {
        this.#person(id, user);
        const path = filePath(value);

        await this.#app.conversation(id);
        const scope = await this.#scope(id, user);
        const changes = await this.#changes(id, user, scope);

        if (!changes.files.some((file) => file.path === path)) {
            throw new HttpError(404, "That file has no uncommitted changes in this session folder");
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
                this.#guard(id, user, scope);
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
        const person = this.#person(id, supplied);
        const key = requestKey(person, input?.requestId);
        const messageId = `c-${key}`;
        const message = text(input?.text, "text", 4000);
        const threadId =
            input?.threadId === undefined ? undefined : text(input.threadId, "threadId", 160);
        const path = input?.path === undefined ? undefined : filePath(input.path);
        const side = input?.side;
        const line = input?.line;
        const excerpt = input?.context;

        if (
            excerpt !== undefined &&
            (typeof excerpt !== "string" || excerpt.length > 1000 || excerpt.includes("\0"))
        ) {
            throw new HttpError(400, "context must be at most 1000 characters without NUL");
        }

        if (
            threadId !== undefined &&
            (path !== undefined ||
                side !== undefined ||
                line !== undefined ||
                excerpt !== undefined)
        ) {
            throw new HttpError(400, "Replies use their thread's existing anchor");
        }

        if (
            (side !== undefined || line !== undefined || excerpt !== undefined) &&
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

        await this.#app.conversation(id);

        return this.#app.harness.commit(async (tx) => {
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
                threadId === undefined
                    ? undefined
                    : doc.threads.find((item) => item.id === threadId);

            if (threadId !== undefined && thread === undefined) {
                throw new HttpError(404, "No such review thread");
            }

            // No disk read is required for conversation comments or replies, including after a cwd change.
            const scope = path === undefined ? undefined : await this.#scope(id, supplied);

            if (scope !== undefined && !inScope(scope, path!)) {
                throw new HttpError(400, "The comment must name a file inside this session folder");
            }

            user = this.#person(id, supplied);
            const comment = {
                id: messageId,
                userId: user.id,
                name: user.name,
                text: message,
                at: Date.now(),
            };

            if (thread !== undefined) {
                thread.replies.push(comment);
            } else {
                doc.threads.push({
                    ...comment,
                    cwd: scope?.cwd ?? this.#app.cwdOf(id),
                    ...(path === undefined ? {} : { path }),
                    ...(side === undefined
                        ? {}
                        : { side: side as "old" | "new", line: Number(line) }),
                    ...(excerpt === undefined ? {} : { context: excerpt }),
                    resolved: false,
                    replies: [],
                });
            }

            doc.rev++;
            bounded(doc, user);

            return { id: messageId };
        }, context);
    }

    async resolve(id: ConversationId, supplied: User, input: ResolveReview): Promise<void> {
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
