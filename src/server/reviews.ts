/** Immutable, session-scoped local review rounds. Reviews never submit Pi work or mutate a checkout. */
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { relative, sep } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ConversationId, LiveDoc } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import { changesIn, diffOf, type Changes } from "./changes.ts";
import type { User } from "./config.ts";
import { ReviewDoc, type ReviewRound, ReviewSnapshotDoc } from "./docs.ts";
import { describe, HttpError } from "./errors.ts";

const context = BACKGROUND_CONTEXT;
const MAX_ROUNDS = 20;
const MAX_FILES = 100;
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_COMMENTS = 500;
const MAX_EVENTS = 1000;
// Reviewers cannot consume the owner's remaining administration/audit space.
const COLLAB_EVENTS = 900;
const COLLAB_METADATA_BYTES = 900 * 1024;
const COLLAB_REQUESTS = 19_000;
const MAX_REVIEWERS = 100;
const MAX_REQUESTS = 20_000;
const MAX_TEXT = 4000;
const MAX_REASON = 2000;

type Retry = { requestId?: unknown; expectedRevision?: unknown };
export type CreateReview = { requestId: unknown; title: unknown };
export type ManageReview = Retry & { action: unknown; userId?: unknown; reason?: unknown };
export type SubmitReview = Retry & { state: unknown; text?: unknown };
export type CommentReview = Retry & {
    requestId: unknown;
    text: unknown;
    threadId?: unknown;
    path?: unknown;
    side?: unknown;
    line?: unknown;
};
export type ResolveReview = Retry & { threadId: unknown; resolved: unknown };

type ReviewData = { items: ReviewRound[]; requests: Record<string, string> };

function text(value: unknown, label: string, limit: number, required = true): string {
    if (value === undefined && !required) {
        return "";
    }

    if (typeof value !== "string" || (required && value.trim() === "")) {
        throw new HttpError(400, `${label} is required`);
    }

    if (value.length > limit) {
        throw new HttpError(413, `${label} is limited to ${limit} characters`);
    }

    return value.trim();
}

function digest(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function requestKey(userId: string, requestId: unknown): string {
    return digest([userId, text(requestId, "requestId", 160)]);
}

function findRound(doc: Pick<ReviewData, "items">, reviewId: string): ReviewRound {
    const round = doc.items.find((item) => item.id === reviewId);

    if (round === undefined) {
        throw new HttpError(404, "No such review round");
    }

    return round;
}

function openRound(round: ReviewRound): void {
    if (round.status !== "open") {
        throw new HttpError(409, "This review is closed; the owner can reopen it");
    }
}

function reviewer(round: ReviewRound, userId: string) {
    return Object.hasOwn(round.reviewers, userId) ? round.reviewers[userId] : undefined;
}

/** Receipts precede revision checks: a successful retry remains successful after later collaboration. */
function retry(
    doc: ReviewData,
    round: ReviewRound,
    user: User,
    input: Retry,
    operation: unknown,
): boolean {
    if (input.requestId !== undefined) {
        const key = digest([round.id, requestKey(user.id, input.requestId)]);
        const fingerprint = digest(operation);

        if (Object.hasOwn(doc.requests, key)) {
            if (doc.requests[key] !== fingerprint) {
                throw new HttpError(409, "This requestId was already used for a different action");
            }

            return true;
        }

        if (
            Object.keys(doc.requests).length >=
            (user.role === "owner" ? MAX_REQUESTS : COLLAB_REQUESTS)
        ) {
            throw new HttpError(413, "This session has reached its review action limit");
        }

        doc.requests[key] = fingerprint;
    }

    if (input.expectedRevision !== undefined) {
        if (!Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 1) {
            throw new HttpError(400, "expectedRevision must be a positive integer");
        }

        if (input.expectedRevision !== round.rev) {
            throw new HttpError(409, "This review changed; refresh before trying again");
        }
    }

    return false;
}

function event(round: ReviewRound, user: User, message: string): void {
    if (round.events.length >= (user.role === "owner" ? MAX_EVENTS : COLLAB_EVENTS)) {
        throw new HttpError(413, "This review has reached its audit event limit");
    }

    round.events.push({ userId: user.id, name: user.name, text: message, at: Date.now() });
    round.rev++;
}

function bounded(doc: ReviewData, user?: User): void {
    const limit =
        user === undefined || user.role === "owner" ? MAX_METADATA_BYTES : COLLAB_METADATA_BYTES;

    if (Buffer.byteLength(JSON.stringify(doc)) > limit) {
        throw new HttpError(413, "This session has reached its review metadata limit");
    }
}

function inside(folder: string, file: string): boolean {
    const tail = relative(folder, file);

    return tail === "" || (tail !== ".." && !tail.startsWith(`..${sep}`) && !tail.startsWith(sep));
}

function canonical(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        return path;
    }
}

/** Anchors must name a line present on the selected side of the saved diff, not arbitrary disk content. */
function hasLine(diff: string, side: "old" | "new", line: number): boolean {
    for (const match of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
        const start = Number(match[side === "old" ? 1 : 3]);
        const count = Number(match[side === "old" ? 2 : 4] ?? 1);

        if (line >= start && line < start + count) {
            return true;
        }
    }

    return false;
}

export class Reviews {
    readonly #app: PocketApp;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /** Never trust a caller's saved role/name/scope, including after an asynchronous read. */
    #person(id: ConversationId, supplied: User, owner = false): User {
        const user = this.#app.config.userById(supplied.id);

        if (user === undefined) {
            throw new HttpError(401, "Your access was removed");
        }

        this.#app.requireSee(user, id);

        if (owner && user.role !== "owner") {
            throw new HttpError(403, "Only the owner manages review rounds");
        }

        return user;
    }

    async list(id: ConversationId, supplied: User): Promise<{ items: ReviewRound[] }> {
        this.#person(id, supplied);
        await this.#app.conversation(id);
        const doc = await this.#app.harness.snapshot(ReviewDoc, id, context);

        this.#person(id, supplied);

        return { items: JSON.parse(JSON.stringify(doc?.items ?? [])) as ReviewRound[] };
    }

    /** Double-read complete diffs and revalidate the listing; refuse changes instead of saving a mixed/truncated round. */
    async create(id: ConversationId, supplied: User, input: CreateReview): Promise<{ id: string }> {
        const app = this.#app;
        const user = this.#person(id, supplied, true);
        const title = text(input?.title, "title", 160);
        const reviewId = `r-${requestKey(user.id, input?.requestId)}`;
        const previous = (await this.list(id, user)).items.find((item) => item.id === reviewId);

        if (previous !== undefined) {
            if (previous.title !== title) {
                throw new HttpError(409, "This requestId was already used for another review");
            }

            return { id: reviewId };
        }

        const cwd = app.cwdOf(id);
        const folder = canonical(cwd);
        let interrupted = false;

        const overlaps = (other: ConversationId) => {
            const directory = canonical(app.cwdOf(other));

            return inside(folder, directory) || inside(directory, folder);
        };

        const unsubscribe = app.harness.subscribeCommits((publication) => {
            for (const change of publication.changes) {
                if (change.type !== "document" || change.conversationId === undefined) {
                    continue;
                }

                if (
                    (change.conversationId === id && change.record.kind === "pi.agent") ||
                    (change.record.kind === "pi.live" && overlaps(change.conversationId))
                ) {
                    interrupted = true;
                }
            }
        });

        const guard = () => {
            this.#person(id, supplied, true);

            if (interrupted || app.cwdOf(id) !== cwd || canonical(cwd) !== folder) {
                throw new HttpError(409, "The session changed during capture; try again");
            }

            if (app.busyConversations().some(overlaps)) {
                throw new HttpError(409, "Wait for Pi to finish before capturing a review");
            }
        };

        try {
            guard();
            const entries = await app.transcripts.allEntries(id, false);

            const listing = async (): Promise<Changes> => {
                guard();
                const changes = await changesIn(cwd, entries, true);

                guard();

                if (changes.repo === undefined || changes.files.length === 0) {
                    throw new HttpError(
                        400,
                        "There are no uncommitted changes in this session folder",
                    );
                }

                if (changes.more !== 0 || changes.files.length > MAX_FILES) {
                    throw new HttpError(413, `A review can contain at most ${MAX_FILES} files`);
                }

                return { ...changes, more: 0, piOnly: [] };
            };

            const capture = async (snapshot: Changes) => {
                const pairs: [string, string][] = [];
                let bytes = Buffer.byteLength(JSON.stringify(snapshot));

                for (const file of snapshot.files) {
                    guard();
                    const diff = await diffOf(cwd, file.path, true, MAX_SNAPSHOT_BYTES - bytes);

                    guard();
                    bytes += Buffer.byteLength(file.path) + Buffer.byteLength(diff);

                    if (bytes > MAX_SNAPSHOT_BYTES) {
                        throw new HttpError(413, "A complete review snapshot is limited to 2 MiB");
                    }

                    pairs.push([file.path, diff]);
                }

                return Object.fromEntries(pairs);
            };

            const snapshot = await listing();
            const diffs = await capture(snapshot);
            const second = await listing();

            if (JSON.stringify(snapshot) !== JSON.stringify(second)) {
                throw new HttpError(409, "Files or the branch changed during capture; try again");
            }

            const repeated = await capture(second);
            const final = await listing();

            if (
                JSON.stringify(snapshot) !== JSON.stringify(final) ||
                JSON.stringify(diffs) !== JSON.stringify(repeated)
            ) {
                throw new HttpError(409, "Files or the branch changed during capture; try again");
            }

            return await app.harness.commit(async (tx) => {
                const doc = await tx.doc(ReviewDoc, id);
                const existing = doc.items.find((item) => item.id === reviewId);

                if (existing !== undefined) {
                    if (existing.title !== title) {
                        throw new HttpError(
                            409,
                            "This requestId was already used for another review",
                        );
                    }

                    this.#person(id, supplied, true);

                    return { id: reviewId };
                }

                if (doc.items.length >= MAX_ROUNDS) {
                    throw new HttpError(
                        413,
                        `A session can contain at most ${MAX_ROUNDS} review rounds`,
                    );
                }

                const live = await tx.doc(LiveDoc, id);
                const body = await tx.doc(ReviewSnapshotDoc, id, reviewId, {});
                // A queued commit may have waited since the final capture; recheck HEAD, branch and file versions.
                const admitted = await listing();

                if (JSON.stringify(snapshot) !== JSON.stringify(admitted)) {
                    throw new HttpError(
                        409,
                        "Files or the branch changed before publication; try again",
                    );
                }

                const author = this.#person(id, supplied, true);

                guard();

                if (live.run !== undefined) {
                    throw new HttpError(409, "Wait for Pi to finish before capturing a review");
                }

                const now = Date.now();
                const prefix = relative(canonical(snapshot.repo!.root), folder)
                    .split(sep)
                    .join("/");

                doc.items.push({
                    id: reviewId,
                    title,
                    status: "open",
                    createdBy: author.id,
                    name: author.name,
                    createdAt: now,
                    cwd,
                    scopePrefix: prefix === "" ? "" : `${prefix}/`,
                    rev: 1,
                    snapshot,
                    reviewers: Object.fromEntries([
                        [
                            author.id,
                            {
                                userId: author.id,
                                name: author.name,
                                active: true,
                                state: "pending" as const,
                            },
                        ],
                    ]),
                    threads: [],
                    events: [
                        {
                            userId: author.id,
                            name: author.name,
                            text: "Created this review and assigned themselves",
                            at: now,
                        },
                    ],
                });
                body.diffs = diffs;
                bounded(doc, author);

                return { id: reviewId };
            }, context);
        } catch (error) {
            if (error instanceof HttpError) {
                throw error;
            }

            throw new HttpError(409, `Could not capture a complete review: ${describe(error)}`);
        } finally {
            unsubscribe();
        }
    }

    async manage(
        id: ConversationId,
        supplied: User,
        reviewId: string,
        input: ManageReview,
    ): Promise<void> {
        this.#person(id, supplied, true);
        const action = input?.action;
        const reason = text(input?.reason, "reason", MAX_REASON, false);

        if (
            typeof action !== "string" ||
            !["assign", "remove", "dismiss", "close", "reopen"].includes(action)
        ) {
            throw new HttpError(400, "Unknown review management action");
        }

        const targetId = ["assign", "remove", "dismiss"].includes(action)
            ? text(input.userId, "userId", 160)
            : undefined;

        await this.#app.harness.commit(async (tx) => {
            const doc = await tx.doc(ReviewDoc, id);
            const user = this.#person(id, supplied, true);
            const round = findRound(doc, reviewId);

            if (retry(doc, round, user, input, ["manage", action, targetId ?? null, reason])) {
                return;
            }

            if (action === "close" || action === "reopen") {
                const status = action === "close" ? "closed" : "open";

                if (round.status === status) {
                    bounded(doc, user);

                    return;
                }

                const objections =
                    Object.values(round.reviewers).some(
                        (item) => item.active && item.state === "changes_requested",
                    ) || round.threads.some((thread) => !thread.resolved);

                if (action === "close" && objections && reason === "") {
                    throw new HttpError(
                        400,
                        "A reason is required to close with requested changes or unresolved threads",
                    );
                }

                round.status = status;
                event(
                    round,
                    user,
                    `${action === "close" ? "Closed" : "Reopened"} this review${action === "close" && objections ? " despite requested changes or unresolved threads" : ""}${reason === "" ? "" : `: ${reason}`}`,
                );
            } else {
                openRound(round);
                const prior = reviewer(round, targetId!);

                if (action === "assign") {
                    const person = this.#app.config.userById(targetId!);

                    if (
                        person === undefined ||
                        !this.#app.canSee(person, id) ||
                        ["__proto__", "prototype", "constructor"].includes(person.id)
                    ) {
                        throw new HttpError(
                            400,
                            "The reviewer must be a person who can see this session",
                        );
                    }

                    if (prior?.active) {
                        bounded(doc, user);

                        return;
                    }

                    if (
                        prior === undefined &&
                        Object.keys(round.reviewers).length >= MAX_REVIEWERS
                    ) {
                        throw new HttpError(413, "This review has reached its reviewer limit");
                    }

                    round.reviewers[person.id] = {
                        userId: person.id,
                        name: person.name,
                        active: true,
                        state: "pending",
                    };
                    event(
                        round,
                        user,
                        `Assigned ${person.name} as a reviewer${prior === undefined ? "" : ` again (previous verdict: ${prior.state})`}`,
                    );
                } else {
                    if (prior === undefined || !prior.active) {
                        throw new HttpError(409, "That person is not an active reviewer");
                    }

                    if (action === "remove") {
                        prior.active = false;
                        event(
                            round,
                            user,
                            `Removed ${prior.name} as a reviewer (previous verdict: ${prior.state}${prior.text ? ` — ${prior.text}` : ""})`,
                        );
                    } else {
                        if (reason === "") {
                            throw new HttpError(400, "A reason is required to dismiss a verdict");
                        }

                        if (prior.state === "pending" || prior.state === "dismissed") {
                            throw new HttpError(409, "That reviewer has no verdict to dismiss");
                        }

                        event(
                            round,
                            user,
                            `Dismissed ${prior.name}'s ${prior.state} verdict${prior.text ? ` — ${prior.text}` : ""}. Reason: ${reason}`,
                        );
                        prior.state = "dismissed";
                        prior.at = Date.now();
                    }
                }
            }

            bounded(doc, user);
        }, context);
    }

    async submit(
        id: ConversationId,
        supplied: User,
        reviewId: string,
        input: SubmitReview,
    ): Promise<void> {
        this.#person(id, supplied);
        const state = input?.state;
        const message = text(input?.text, "text", MAX_TEXT, false);

        if (state !== "commented" && state !== "approved" && state !== "changes_requested") {
            throw new HttpError(400, "Choose commented, approved, or changes_requested");
        }

        await this.#app.harness.commit(async (tx) => {
            const doc = await tx.doc(ReviewDoc, id);
            const user = this.#person(id, supplied);
            const round = findRound(doc, reviewId);
            const own = reviewer(round, user.id);

            if (!own?.active) {
                throw new HttpError(403, "Only assigned reviewers submit their own verdict");
            }

            if (retry(doc, round, user, input, ["submit", state, message])) {
                return;
            }

            openRound(round);

            if (own.state === state && (own.text ?? "") === message) {
                bounded(doc, user);

                return;
            }

            event(
                round,
                user,
                `Submitted ${state}${message === "" ? "" : `: ${message}`} (previous verdict: ${own.state})`,
            );
            own.name = user.name;
            own.state = state;
            own.text = message;
            own.at = Date.now();
            bounded(doc, user);
        }, context);
    }

    async comment(
        id: ConversationId,
        supplied: User,
        reviewId: string,
        input: CommentReview,
    ): Promise<void> {
        const person = this.#person(id, supplied);
        const messageId = `c-${requestKey(person.id, input?.requestId)}`;
        const message = text(input?.text, "text", MAX_TEXT);
        const threadId =
            input?.threadId === undefined ? undefined : text(input.threadId, "threadId", 160);
        const path = input?.path;

        if (
            path !== undefined &&
            (typeof path !== "string" || path === "" || path.length > 4096 || path.includes("\0"))
        ) {
            throw new HttpError(400, "path must be a nonempty saved file path");
        }

        const side = input?.side;
        const line = input?.line;

        if (
            threadId !== undefined &&
            (path !== undefined || side !== undefined || line !== undefined)
        ) {
            throw new HttpError(400, "Replies use their thread's existing anchor");
        }

        if (
            (side !== undefined || line !== undefined) &&
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

        await this.#app.harness.commit(async (tx) => {
            const doc = await tx.doc(ReviewDoc, id);
            const round = findRound(doc, reviewId);
            const body =
                path !== undefined && line !== undefined
                    ? await tx.doc(ReviewSnapshotDoc, id, reviewId, {})
                    : undefined;
            const user = this.#person(id, supplied);

            if (
                retry(doc, round, user, input, [
                    "comment",
                    message,
                    threadId ?? null,
                    path ?? null,
                    side ?? null,
                    line ?? null,
                ])
            ) {
                return;
            }

            openRound(round);

            if (path !== undefined && !round.snapshot.files.some((file) => file.path === path)) {
                throw new HttpError(400, "The comment must name a file in this saved review");
            }

            if (
                path !== undefined &&
                line !== undefined &&
                (!body ||
                    !Object.hasOwn(body.diffs, path) ||
                    !hasLine(body.diffs[path]!, side as "old" | "new", Number(line)))
            ) {
                throw new HttpError(400, "That line is not present on this side of the saved diff");
            }

            const count = round.threads.reduce(
                (total, thread) => total + 1 + thread.replies.length,
                0,
            );

            if (count >= MAX_COMMENTS) {
                throw new HttpError(
                    413,
                    `A review is limited to ${MAX_COMMENTS} comments and replies`,
                );
            }

            const comment = {
                id: messageId,
                userId: user.id,
                name: user.name,
                text: message,
                at: Date.now(),
            };

            if (threadId !== undefined) {
                const thread = round.threads.find((item) => item.id === threadId);

                if (thread === undefined) {
                    throw new HttpError(404, "No such review thread");
                }

                thread.replies.push(comment);
                event(round, user, "Replied to a review thread");
            } else {
                round.threads.push({
                    ...comment,
                    ...(path === undefined ? {} : { path }),
                    ...(side === undefined
                        ? {}
                        : { side: side as "old" | "new", line: Number(line) }),
                    resolved: false,
                    replies: [],
                });
                event(round, user, "Opened a review thread");
            }

            bounded(doc, user);
        }, context);
    }

    async resolve(
        id: ConversationId,
        supplied: User,
        reviewId: string,
        input: ResolveReview,
    ): Promise<void> {
        this.#person(id, supplied);
        const threadId = text(input?.threadId, "threadId", 160);

        const resolved = input?.resolved;

        if (typeof resolved !== "boolean") {
            throw new HttpError(400, "resolved must be a boolean");
        }

        await this.#app.harness.commit(async (tx) => {
            const doc = await tx.doc(ReviewDoc, id);
            const user = this.#person(id, supplied);
            const round = findRound(doc, reviewId);
            const thread = round.threads.find((item) => item.id === threadId);

            if (thread === undefined) {
                throw new HttpError(404, "No such review thread");
            }

            if (
                user.role !== "owner" &&
                thread.userId !== user.id &&
                !reviewer(round, user.id)?.active
            ) {
                throw new HttpError(
                    403,
                    "Only the owner, thread author, or an assigned reviewer resolves threads",
                );
            }

            if (retry(doc, round, user, input, ["resolve", threadId, resolved])) {
                return;
            }

            openRound(round);

            if (thread.resolved === resolved) {
                bounded(doc, user);

                return;
            }

            thread.resolved = resolved;

            if (resolved) {
                thread.resolvedBy = user.id;
            } else {
                delete thread.resolvedBy;
            }

            event(round, user, `${resolved ? "Resolved" : "Reopened"} a review thread`);
            bounded(doc, user);
        }, context);
    }

    async diff(
        id: ConversationId,
        supplied: User,
        reviewId: string,
        path: string,
    ): Promise<string> {
        this.#person(id, supplied);
        const { items } = await this.list(id, supplied);
        const round = findRound({ items }, reviewId);

        if (!round.snapshot.files.some((file) => file.path === path)) {
            throw new HttpError(404, "No such file in this saved review");
        }

        const body = await this.#app.harness.snapshot(ReviewSnapshotDoc, id, reviewId, context);

        this.#person(id, supplied);

        if (body === undefined || !Object.hasOwn(body.diffs, path)) {
            throw new HttpError(404, "Saved review diff is missing");
        }

        return body.diffs[path]!;
    }
}
