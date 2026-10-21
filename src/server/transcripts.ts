/**
 * A conversation's stored history, as people read it: single entries (its own, or ones a fork inherited), the images
 * in them, what came before the active context, and the whole session as Markdown.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import type {
    ConversationId,
    ConversationRecord,
    Cursor,
    EntryId,
    EntryRecord,
} from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import { editFacts } from "./changes.ts";
import type { User } from "./config.ts";
import { AuthorsDoc } from "./docs.ts";
import { transcriptMarkdown } from "./export.ts";
import { homePath } from "./paths.ts";
import { type ClientEntry, projectEntry } from "./projection.ts";

const context = BACKGROUND_CONTEXT;
/** Retain only the last 64 sessions' immutable edit facts, never filesystem observations or authority. */
const EDITS_KEPT = 64;

type EditHistory = { last: number; entries: readonly ClientEntry[] };

export class Transcripts {
    readonly #app: PocketApp;
    readonly #edits = new Map<ConversationId, EditHistory>();

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /** An image part of a stored message: a pasted image, or an image a tool returned. */
    async entryImage(
        id: ConversationId,
        entryId: number,
        index: number,
    ): Promise<{ mimeType: string; data: Buffer } | undefined> {
        if (!Number.isInteger(entryId) || !Number.isInteger(index) || index < 0) {
            return undefined;
        }

        const entry = await this.visibleEntry(id, entryId);

        if (entry === undefined) {
            return undefined;
        }

        const content = (entry.model?.[0] as { content?: unknown } | undefined)?.content;

        if (!Array.isArray(content)) {
            return undefined;
        }

        const part = (content as { type?: string; data?: unknown; mimeType?: unknown }[]).filter(
            (each) => each?.type === "image",
        )[index];

        if (typeof part?.data !== "string" || typeof part.mimeType !== "string") {
            return undefined;
        }

        return { mimeType: part.mimeType, data: Buffer.from(part.data, "base64") };
    }

    async fullEntry(id: ConversationId, entryId: number): Promise<ClientEntry | undefined> {
        const entry = await this.visibleEntry(id, entryId);

        return entry === undefined ? undefined : projectEntry(entry, true);
    }

    /**
     * An entry of a conversation's history: its own, or one it inherited as a fork (the fork's parent's entries up to
     * the fork point, and so on up the line). Undefined for an entry of any other conversation.
     */
    async visibleEntry(id: ConversationId, entryId: number): Promise<EntryRecord | undefined> {
        if (!Number.isInteger(entryId)) {
            return undefined;
        }

        return this.#app.harness.commit(async (tx) => {
            const entry = await tx.entry(entryId as unknown as EntryId);

            if (entry === undefined) {
                return undefined;
            }

            // Walk up the forks: each one inherits its parent's entries through `parent.at`, and no later ones.
            let conversation = id;
            let through = Number.POSITIVE_INFINITY;

            for (;;) {
                if (entry.conversationId === conversation) {
                    return entryId <= through ? entry : undefined;
                }

                const parent: ConversationRecord["parent"] = (await tx.conversation(conversation))
                    ?.parent;

                if (parent === undefined) {
                    return undefined;
                }

                through = Math.min(through, parent.at as unknown as number);
                conversation = parent.conversationId;
            }
        }, context);
    }

    /** One bounded, cancellable page of public transcript entries, newest first, including fork history. */
    async page(
        id: ConversationId,
        { before, limit = 20 }: { before?: number; limit?: number } = {},
        ctx: Context = context,
    ): Promise<{ entries: ClientEntry[]; before?: number }> {
        const conversation = await this.#app.conversation(id);
        const page = await conversation.entries(
            before === undefined ? {} : { maxEntryId: (before - 1) as EntryId },
            Math.max(1, Math.min(100, Math.floor(limit))),
            undefined,
            ctx,
        );
        const last = page.items.at(-1);

        return {
            entries: page.items.flatMap((entry) => {
                const projected = projectEntry(entry);

                return projected === undefined ? [] : [projected];
            }),
            ...(page.next !== undefined && last ? { before: Number(last.id) } : {}),
        };
    }

    /** Entries before the active context: what compaction or a reset hid from the model. Oldest first. */
    async history(id: ConversationId, before: number, limit = 400): Promise<ClientEntry[]> {
        const conversation = await this.#app.conversation(id);
        const out: ClientEntry[] = [];
        let cursor: Cursor | undefined;

        do {
            const page = await conversation.entries(
                { maxEntryId: (before - 1) as unknown as EntryId },
                256,
                cursor,
                context,
            );

            for (const entry of page.items) {
                const projected = projectEntry(entry);

                if (projected !== undefined) {
                    out.push(projected);
                }
            }

            cursor = page.next;
        } while (cursor !== undefined && out.length < limit);

        return out.slice(0, limit).reverse();
    }

    /** A conversation's whole history, oldest first, as browsers get it (`full`: nothing clipped). */
    async allEntries(id: ConversationId, full: boolean): Promise<ClientEntry[]> {
        return (await this.entriesAfter(id, 0, full)).entries;
    }

    /** New immutable history, oldest first, including inherited fork entries; `last` includes unprojected entries. */
    async entriesAfter(
        id: ConversationId,
        after: number,
        full: boolean,
        ctx: Context = context,
    ): Promise<{ entries: ClientEntry[]; last: number }> {
        ctx.abortSignal?.throwIfAborted();
        const conversation = await this.#app.conversation(id);
        const query = after > 0 ? { minEntryId: (after + 1) as EntryId } : {};
        const entries: ClientEntry[] = [];
        let last = after;
        let cursor: Cursor | undefined;

        do {
            ctx.abortSignal?.throwIfAborted();
            const page = await conversation.entries(query, 256, cursor, ctx);

            for (const entry of page.items) {
                last = Math.max(last, Number(entry.id));
                const projected = projectEntry(entry, full);

                if (projected !== undefined) {
                    entries.push(projected);
                }
            }

            cursor = page.next;
        } while (cursor !== undefined);

        ctx.abortSignal?.throwIfAborted();

        return { entries: entries.reverse(), last };
    }

    /** Shared by Changes and native Reviews. Callers still authorize each destination read and its result. */
    async editEntries(id: ConversationId, ctx: Context = context): Promise<readonly ClientEntry[]> {
        const previous = this.#edits.get(id) ?? { last: 0, entries: [] };
        const read = await this.entriesAfter(id, previous.last, false, ctx);
        const current = this.#edits.get(id);
        // Keep the complete baseline even if other sessions evicted it while this read was pending.
        const known = current !== undefined && current.last >= previous.last ? current : previous;
        const added = read.entries.flatMap((entry) => {
            const facts = entry.id > known.last ? editFacts(entry) : undefined;

            return facts === undefined ? [] : [facts];
        });
        const next = {
            last: Math.max(known.last, read.last),
            entries: added.length === 0 ? known.entries : [...known.entries, ...added],
        };

        this.#edits.delete(id);
        this.#edits.set(id, next);

        if (this.#edits.size > EDITS_KEPT) {
            this.#edits.delete(this.#edits.keys().next().value!);
        }

        return next.entries;
    }

    /** A session as a Markdown file: its whole history, with who wrote what. */
    async exportMarkdown(
        id: ConversationId,
        user: User,
    ): Promise<{ filename: string; markdown: string }> {
        this.#app.requireSee(user, id);
        const entries = await this.allEntries(id, true);
        const authors: Record<number, string> = {};

        for (const [entryId, userId] of Object.entries(
            (await this.#app.harness.snapshot(AuthorsDoc, id, context))?.entries ?? {},
        )) {
            authors[Number(entryId)] = this.#app.config.userById(userId)?.name ?? "Someone";
        }

        const agent = await this.#app.agentState(id);
        const title = await this.#app.conversationTitle(id);
        const markdown = transcriptMarkdown({
            title,
            cwd: homePath(this.#app.cwdOf(id)),
            ...(agent?.model === undefined
                ? {}
                : { model: `${agent.model.provider}/${agent.model.modelId}` }),
            exportedAt: new Date(),
            entries,
            authors,
        });
        const slug =
            title
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-+|-+$/g, "")
                .slice(0, 60) || "session";

        return { filename: `${slug}.md`, markdown };
    }
}
