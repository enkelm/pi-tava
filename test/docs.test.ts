// Exercise Pocket's real document definitions at the SQLite boundary, without app/task side effects.
import { cleanUp, context, root } from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import {
    createSession,
    defineDoc,
    type ConversationId,
    type DocumentAddress,
} from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
    ArtifactBodyDoc,
    CommandRequestsDoc,
    CommentReviewDoc,
    FolderFavoritesDoc,
    NotesDoc,
    PipMentionJobDoc,
    PipMentionsDoc,
    PipWorkDoc,
    ProjectsDoc,
    SpendDoc,
} from "../src/server/docs.ts";
import { HandoffsDoc, WorkflowDoc } from "../src/server/workflow-docs.ts";
import { PublicationsDoc } from "../src/server/workflow-publication.ts";

after(cleanUp);

async function open(path: string) {
    const db = await openNodeSqliteDatabase(path);
    const storage = await SqliteStorage.open(db);
    const session = createSession(storage);

    return { db, storage, session };
}

type Fixture = Awaited<ReturnType<typeof open>>;

async function replayBounds(fixture: Fixture, conversationId: ConversationId) {
    for (const scope of [
        { kind: "session" } as const,
        { kind: "conversation", conversationId } as const,
    ]) {
        const records = await fixture.storage.scanDocuments(
            { scope, at: "current" },
            100,
            undefined,
            context,
        );

        assert.equal(records.next, undefined);

        for (const record of records.items) {
            const stored = await fixture.storage.document(record.id, "current", context);
            const name = `${record.kind}/${record.key ?? ""}`;
            const rows = await fixture.db.all<{ kind: string }>(
                "SELECT kind FROM document_revisions WHERE document_id = ? ORDER BY seq",
                record.id,
            );

            assert.ok(stored !== undefined, name);
            assert.ok(stored.deltasSinceBase <= 64, `${name}: ${stored.deltasSinceBase} deltas`);
            assert.equal(rows.length, stored.deltasSinceBase + 1, `${name}: obsolete revisions`);
            assert.equal(rows[0]?.kind, "base", name);
            assert.ok(
                rows.slice(1).every((row) => row.kind === "delta"),
                name,
            );
        }
    }
}

test("busy current-only documents keep a bounded replay tail across SQLite reopen", async () => {
    const path = join(root, "doc-checkpoints.sqlite");
    let f = await open(path);

    try {
        const conversation = await f.session.commit(
            (tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
            context,
        );
        const id = conversation.id;

        // Multiple checkpoint cycles, with a cold reopen part way through a delta tail.
        for (let revision = 0; revision < 150; revision++) {
            await f.session.commit(async (tx) => {
                const spend = await tx.doc(SpendDoc);

                spend.people.alex = revision;
                spend.counted.source = revision;

                (await tx.doc(FolderFavoritesDoc)).users.alex = [`/work/${revision}`];
                (await tx.doc(ProjectsDoc)).projects.project = {
                    id: "project",
                    name: `Project ${revision}`,
                    cwd: "/work",
                    createdAt: 0,
                    updatedAt: revision,
                    createdBy: "alex",
                };
                (await tx.doc(HandoffsDoc)).requests.request = {
                    input: "unchanged human intent",
                    id: revision,
                    handoffId: "handoff",
                    workItemId: "item",
                };
                (await tx.doc(PipMentionsDoc)).active.message = {
                    source: Number(id),
                    taskId: revision,
                };

                const notes = await tx.doc(NotesDoc, id);

                notes.text = `Notes ${revision}`;
                notes.rev = revision;
                (await tx.doc(CommentReviewDoc, id)).rev = revision;
                (await tx.doc(WorkflowDoc, id)).summary = `Checkpoint ${revision}`;
                (await tx.doc(PipWorkDoc, id)).sequence = revision;
                (await tx.doc(PublicationsDoc, id)).receipts.publication = {
                    id: "publication",
                    command: ["git", "push"],
                    cwd: "/work",
                    fingerprint: "fixed command inputs",
                    requester: "alex",
                    approver: "alex",
                    approvedAt: 0,
                    reason: "explicit publication",
                    state: "completed",
                    exitCode: revision,
                };

                for (const key of ["alex", "beth"]) {
                    (await tx.doc(CommandRequestsDoc, id, key, null)).items.request =
                        revision + (key === "beth" ? 1000 : 0);
                }

                (await tx.doc(ArtifactBodyDoc, id, "chart@1", { content: "initial" })).content =
                    `Chart ${revision}`;
                (await tx.doc(PipMentionJobDoc, id, "mention", null)).job = {
                    source: { kind: "chat", messageId: "message" },
                    requesterId: "alex",
                    authority: "fixed authority",
                    fingerprint: "fixed source",
                    context: "bounded context",
                    createdAt: 0,
                    selection: {
                        provider: "faux",
                        modelId: "faux-1",
                        thinkingLevel: "off",
                        revision: 0,
                    },
                    taskId: 1,
                    status: "ready",
                    responses: revision,
                };
            }, context);

            if (revision === 64 || revision === 65) {
                const spend = await f.storage.findDocument(
                    { kind: SpendDoc.definition.kind, scope: { kind: "session" } },
                    "current",
                    context,
                );

                assert.ok(spend);
                assert.equal(
                    (await f.storage.document(spend.id, "current", context))?.deltasSinceBase,
                    revision === 64 ? 64 : 0,
                );
            }

            if (revision === 80) {
                await replayBounds(f, id);
                await f.session.close(context);
                f = await open(path);
            }
        }

        await f.session.close(context);
        f = await open(path);
        await replayBounds(f, id);
        assert.deepEqual(await f.session.snapshot(SpendDoc, context), {
            people: { alex: 149 },
            counted: { source: 149 },
        });
        assert.deepEqual(await f.session.snapshot(FolderFavoritesDoc, context), {
            users: { alex: ["/work/149"] },
        });
        assert.equal(
            (await f.session.snapshot(ProjectsDoc, context))?.projects.project?.name,
            "Project 149",
        );
        assert.equal((await f.session.snapshot(HandoffsDoc, context))?.requests.request?.id, 149);
        assert.equal(
            (await f.session.snapshot(PipMentionsDoc, context))?.active.message?.taskId,
            149,
        );
        assert.deepEqual(await f.session.snapshot(NotesDoc, id, context), {
            text: "Notes 149",
            rev: 149,
        });
        assert.equal((await f.session.snapshot(CommentReviewDoc, id, context))?.rev, 149);
        assert.equal(
            (await f.session.snapshot(WorkflowDoc, id, context))?.summary,
            "Checkpoint 149",
        );
        assert.equal((await f.session.snapshot(PipWorkDoc, id, context))?.sequence, 149);
        assert.equal(
            (await f.session.snapshot(PublicationsDoc, id, context))?.receipts.publication
                ?.exitCode,
            149,
        );
        assert.deepEqual(await f.session.snapshot(CommandRequestsDoc, id, "alex", context), {
            items: { request: 149 },
        });
        assert.deepEqual(await f.session.snapshot(CommandRequestsDoc, id, "beth", context), {
            items: { request: 1149 },
        });
        assert.equal(
            (await f.session.snapshot(ArtifactBodyDoc, id, "chart@1", context))?.content,
            "Chart 149",
        );
        assert.equal(
            (await f.session.snapshot(PipMentionJobDoc, id, "mention", context))?.job?.responses,
            149,
        );
    } finally {
        await f.session.close(context);
    }
});

test("existing uncheckpointed data upgrades on a write and forks retain current/initial policies", async () => {
    const path = join(root, "doc-checkpoint-upgrade.sqlite");
    let f = await open(path);

    try {
        // The existing stored contract, independent of the new definition and periodic policy.
        const oldNotes = defineDoc({
            kind: "pocket.notes",
            version: 1,
            scope: "conversation",
            history: "latest",
            fork: "current",
            initial: () => ({ text: "", rev: 0 }),
            checkpointWhen: () => false,
        });
        const { id, at } = await f.session.commit(async (tx) => {
            const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
            const entry = await tx.appendEntry(conversation.id, { kind: "cutoff", data: null });

            return { id: conversation.id, at: entry.id };
        }, context);

        for (let revision = 0; revision < 90; revision++) {
            await f.session.commit(async (tx) => {
                const notes = await tx.doc(oldNotes, id);

                notes.text = `Legacy ${revision}`;
                notes.rev = revision;
            }, context);
        }

        const address: DocumentAddress = {
            kind: NotesDoc.definition.kind,
            scope: { kind: "conversation", conversationId: id },
        };
        const record = await f.storage.findDocument(address, "current", context);

        assert.ok(record);
        assert.equal(
            (await f.storage.document(record.id, "current", context))?.deltasSinceBase,
            89,
        );
        await f.session.close(context);
        f = await open(path);
        assert.deepEqual(await f.session.snapshot(NotesDoc, id, context), {
            text: "Legacy 89",
            rev: 89,
        });
        await f.session.commit(async (tx) => {
            (await tx.doc(NotesDoc, id)).text = "Upgraded";
            await tx.doc(ArtifactBodyDoc, id, "chart@1", { content: "Inherited chart" });
            (await tx.doc(CommandRequestsDoc, id, "alex", null)).items.request = 42;
            (await tx.doc(CommentReviewDoc, id)).rev = 42;
            (await tx.doc(WorkflowDoc, id)).receipts.request = "source only";
        }, context);
        assert.equal((await f.storage.document(record.id, "current", context))?.deltasSinceBase, 0);
        await replayBounds(f, id);

        // The fork cutoff predates the documents: latest/current copies now, not as of the entry.
        const child = await f.session.commit(
            (tx) => tx.forkConversation(id, at, { ownership: { kind: "ownerless" } }),
            context,
        );

        await f.session.commit(async (tx) => {
            (await tx.doc(NotesDoc, id)).text = "Parent changed later";
            (await tx.doc(ArtifactBodyDoc, id, "chart@1", { content: "ignored seed" })).content =
                "Parent chart";
        }, context);
        await f.session.close(context);
        f = await open(path);
        assert.deepEqual(await f.session.snapshot(NotesDoc, child.id, context), {
            text: "Upgraded",
            rev: 89,
        });
        assert.equal(
            (await f.session.snapshot(ArtifactBodyDoc, child.id, "chart@1", context))?.content,
            "Inherited chart",
        );
        assert.equal(
            await f.session.snapshot(CommandRequestsDoc, child.id, "alex", context),
            undefined,
        );
        assert.equal(await f.session.snapshot(CommentReviewDoc, child.id, context), undefined);
        assert.equal(await f.session.snapshot(WorkflowDoc, child.id, context), undefined);
        await f.session.commit(async (tx) => {
            assert.deepEqual(await tx.doc(CommandRequestsDoc, child.id, "alex", null), {
                items: {},
            });
            assert.deepEqual(await tx.doc(CommentReviewDoc, child.id), {
                threads: [],
                rev: 0,
                requests: {},
            });
            assert.deepEqual(await tx.doc(WorkflowDoc, child.id), {
                readOnly: false,
                status: "active",
                receipts: {},
            });
        }, context);
        await replayBounds(f, child.id);
    } finally {
        await f.session.close(context);
    }
});
