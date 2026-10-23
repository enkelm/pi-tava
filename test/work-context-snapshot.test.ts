import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
    type App,
} from "./helpers.ts";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { LiveDoc, type ConversationId, type TaskId } from "@earendil-works/pi-durable";
import { PipWorkDoc, SessionsDoc } from "../src/server/docs.ts";
import { HandoffsDoc, WorkflowDoc } from "../src/server/workflow-docs.ts";
import { PublicationsDoc } from "../src/server/workflow-publication.ts";
import type { WorkReadInput } from "../src/server/work-items/context.ts";

after(cleanUp);

type Reader = ReturnType<App["workItems"]["reader"]>;
type Snapshot = {
    revision: string;
    sectionRevisions: Record<string, string>;
    changed: string[];
    reset?: boolean;
    sections: {
        scope?: {
            membersOmitted: number;
            privateController?: {
                decisionsOmitted: number;
                pendingQuestion?: { questionId: string | null; entryId?: number };
            };
        };
        execution?: {
            threadId?: number;
            unavailable?: boolean;
            busy?: boolean;
            run?: number;
            attempt?: number;
        };
        outcomes?: {
            threadId: number;
            candidateId: string | null;
            runtime: {
                inputEntryId: number;
                answerEntryId?: number;
                submissionId?: number;
            } | null;
            claim: { provenance: string; summary: string } | null;
        }[];
        evidence?: {
            threadId: number;
            assessment: { gapsOmitted: number } | null;
            publicationReceipts?: { receiptKey: string | null; receiptId: string | null }[];
            pendingApprovals?: { id: string | null; callId?: string | null }[];
        }[];
    };
};

async function snapshot(reader: Reader, input: WorkReadInput = { action: "snapshot" }) {
    return (await reader.read({
        type: "toolCall",
        id: "snapshot-read",
        name: "work_context",
        arguments: input,
    })) as Snapshot;
}

// The reader consumes existing topology; this fixture is not handoff-admission evidence.
async function group(app: App, ids: ConversationId[]) {
    await app.harness.commit(async (tx) => {
        const sessions = await tx.doc(SessionsDoc);

        for (const id of ids) {
            sessions.items[String(id)]!.workItemId = "snapshot-work";
        }

        sessions.items[String(ids[1])]!.threadType = "reviewer";
        (await tx.doc(HandoffsDoc)).workItems["snapshot-work"] = {
            id: "snapshot-work",
            originThreadId: Number(ids[0]),
            activeThreadId: Number(ids[1]),
            threadIds: ids.map(Number),
            title: "Actual implementation scope",
            createdAt: 1,
        };
    }, context);
}

// Privacy, encoded output bounds and claim/fact separation have one reader-level owner.
// The older status/thread tests do not exercise compact state or hidden active-member projection.
test("snapshot bounds state and isolates private controller/hidden members", async (t) => {
    const app = await openApp(scriptedModel(), join(root, "context-snapshot-isolation"));

    t.after(() => app.close());
    const user = owner(app);
    const source = await newSession(app);
    const reviewer = await newSession(app);
    const hidden = await newSession(app);
    const foreign = await newSession(app);

    await say(app, source, "SOURCE_OUTCOME_CLAIM");
    await say(app, reviewer, "REVIEWER_OUTCOME_CLAIM");
    await say(app, hidden, "HIDDEN_MEMBER_CANARY");
    await group(app, [source, reviewer, hidden]);
    await app.harness.commit(async (tx) => {
        (await tx.doc(SessionsDoc)).items[String(hidden)]!.ownerOnly = true;
        const workflow = await tx.doc(WorkflowDoc, reviewer);

        workflow.summary = "ASSESSMENT_CLAIM " + "\n".repeat(20_000);
        workflow.reviewAssessment = {
            outcome: "blocked",
            validationGaps: Array.from(
                { length: 20 },
                () => "DEFERRED_NOT_PASSED " + "x".repeat(1000),
            ),
        };
        workflow.receipts = { PRIVATE_WORKFLOW_RECEIPT: "must not appear" };
        workflow.externalReview = {
            source: "https://example.com/review/42",
            scope: "Historical reviewed scope",
            checkpoint: "a".repeat(40),
            sourceEntryId: 1,
            sourceSubmissionId: 1,
            sourceRequestId: "PRIVATE_EXTERNAL_REVIEW_REQUEST_CANARY",
            suppliedBy: user.id,
            recordedBy: user.id,
            recordedAt: 1,
            findings: "PRIVATE_RAW_EXTERNAL_FINDINGS_CANARY",
            fingerprint: {
                digest: "PRIVATE_EXTERNAL_DIGEST_CANARY",
                cwd: "PRIVATE_EXTERNAL_CWD_CANARY",
                head: "a".repeat(40),
                status: "PRIVATE_EXTERNAL_STATUS_CANARY",
            },
        };
    }, context);
    const opened = await app.pip.orchestration.control(source, user, { action: "open" });
    const controller = opened.orchestration!.conversationId as ConversationId;
    const questionId = "question-" + "q".repeat(150);
    const receiptKey = "receipt-key-" + "k".repeat(150);
    const receiptId = "receipt-id-" + "i".repeat(150);
    const approvalId = "approval-" + "a".repeat(150);
    const callId = "call-" + "c".repeat(150);
    const pending = app.approvals.request(
        {
            id: approvalId,
            conversationId: reviewer,
            taskId: 1 as TaskId,
            callId,
            tool: "publication",
            subject: "PRIVATE_APPROVAL_COMMAND_CANARY",
            reason: "PRIVATE_APPROVAL_REASON_CANARY",
            createdAt: 1,
        },
        context,
    );

    t.after(async () => {
        app.approvals.answer(approvalId, { allow: false, by: "test cleanup" });
        await pending;
    });
    await app.harness.commit(async (tx) => {
        const state = await tx.doc(PipWorkDoc, controller);

        state.goal = "PRIVATE_SCOPE_CANARY " + "x".repeat(20_000);
        state.questions = Array.from({ length: 8 }, (_, index) => ({
            id: `decision-${index}`,
            text: "PRIVATE_DECISION_CANARY " + "x".repeat(2000),
            at: index,
            answer: {
                text: "Keep manual checks deferred, not passed.",
                by: user.id,
                at: index,
                requestId: "PRIVATE_ANSWER_REQUEST_CANARY",
            },
        }));
        state.questions.at(-1)!.id = questionId;
        state.questions.at(-1)!.entryId = 77;
        state.question = state.questions.at(-1)!;
        state.actions = { PRIVATE_ACTION_RECEIPT: { epoch: 1, finish: "PRIVATE_FINISH_CANARY" } };
        (await tx.doc(PublicationsDoc, reviewer)).receipts[receiptKey] = {
            id: receiptId,
            command: ["PRIVATE_PUBLICATION_COMMAND_CANARY"],
            cwd: "PRIVATE_PUBLICATION_CWD_CANARY",
            fingerprint: "PRIVATE_PUBLICATION_FINGERPRINT_CANARY",
            requester: user.id,
            approver: user.id,
            approvedAt: 1,
            reason: "PRIVATE_PUBLICATION_REASON_CANARY",
            state: "completed",
            exitCode: 0,
        };
    }, context);
    const original = app.transcripts.visibleEntry.bind(app.transcripts);
    const reads: number[] = [];

    t.mock.method(app.transcripts, "visibleEntry", async (...args: Parameters<typeof original>) => {
        reads.push(Number(args[0]));

        return original(...args);
    });
    t.mock.method(app.transcripts, "page", async () => {
        throw new Error("Compact state must not scan transcript pages");
    });
    t.mock.method(app.workItems, "list", async () => {
        throw new Error("Compact state must not probe Git or handoff eligibility");
    });
    const shared = app.workItems.reader(source, async () => owner(app), context, "shared");
    const result = await snapshot(shared);
    const serialized = JSON.stringify(result);

    assert.equal(result.sections.execution?.threadId, Number(reviewer));
    assert.match(serialized, /SOURCE_OUTCOME_CLAIM/);
    assert.match(serialized, /REVIEWER_OUTCOME_CLAIM/);
    assert.match(serialized, /agent-claim-not-verified-result/);
    assert.match(serialized, /stored-agent-assessment/);
    assert.match(serialized, /human-supplied-external-review/);
    assert.match(serialized, /DEFERRED_NOT_PASSED/);
    assert.equal(
        result.sections.evidence?.find((row) => row.threadId === Number(reviewer))?.assessment
            ?.gapsOmitted,
        16,
    );
    assert.doesNotMatch(serialized, /PRIVATE_|HIDDEN_MEMBER_CANARY/);
    assert.ok(reads.every((id) => id !== Number(hidden)));
    assert.ok(Buffer.byteLength(serialized) < 32_768);
    await assert.rejects(
        snapshot(shared, { action: "snapshot", threadId: Number(foreign) }),
        /outside this work/,
    );
    await assert.rejects(
        snapshot(shared, { action: "snapshot", threadId: Number(controller) }),
        /outside this work/,
    );
    const privateReader = app.workItems.reader(source, async () => owner(app), context, "private");
    const privateResult = await snapshot(privateReader);
    const privateText = JSON.stringify(privateResult);

    assert.match(privateText, /PRIVATE_SCOPE_CANARY/);
    assert.match(privateText, /PRIVATE_DECISION_CANARY/);
    assert.match(privateText, /HIDDEN_MEMBER_CANARY/);
    assert.match(privateText, /runtime-receipt-not-code-validation/);
    assert.equal(privateResult.sections.scope?.privateController?.decisionsOmitted, 5);
    assert.equal(
        privateResult.sections.scope?.privateController?.pendingQuestion?.questionId,
        questionId,
    );
    assert.equal(privateResult.sections.scope?.privateController?.pendingQuestion?.entryId, 77);
    const receipt = privateResult.sections.evidence?.find(
        (row) => row.threadId === Number(reviewer),
    )?.publicationReceipts?.[0];

    assert.equal(receipt?.receiptKey, receiptKey);
    assert.equal(receipt?.receiptId, receiptId);
    const approval = privateResult.sections.evidence?.find(
        (row) => row.threadId === Number(reviewer),
    )?.pendingApprovals?.[0];

    assert.equal(approval?.id, approvalId);
    assert.equal(approval?.callId, callId);
    assert.doesNotMatch(privateText, /PRIVATE_APPROVAL_/);
    assert.ok(
        privateResult.sections.outcomes?.some((row) => row.runtime?.submissionId !== undefined),
    );
    assert.ok(result.sections.outcomes?.every((row) => row.runtime?.submissionId === undefined));
    assert.doesNotMatch(
        privateText,
        /PRIVATE_(?:ANSWER_REQUEST|ACTION_RECEIPT|FINISH|PUBLICATION_)/,
    );
    assert.ok(Buffer.byteLength(privateText) < 32_768);

    await app.harness.commit(async (tx) => {
        (await tx.doc(PipWorkDoc, controller)).goal = "CHANGED_PRIVATE_SCOPE_CANARY";
    }, context);
    const privateOnly = await snapshot(shared, {
        action: "delta",
        sinceRevision: result.revision,
        sectionRevisions: result.sectionRevisions,
    });

    assert.deepEqual(privateOnly.changed, [], "private edits must not even alter shared revisions");

    await app.harness.commit(async (tx) => {
        (await tx.doc(HandoffsDoc)).workItems["snapshot-work"]!.activeThreadId = Number(hidden);
    }, context);
    const hiddenActive = await snapshot(shared);

    assert.equal(hiddenActive.sections.execution?.unavailable, true);
    assert.equal(hiddenActive.sections.execution?.threadId, undefined);
    assert.doesNotMatch(JSON.stringify(hiddenActive), /HIDDEN_MEMBER_CANARY/);
    const extra = [];

    for (let index = 0; index < 6; index++) {
        extra.push(await newSession(app));
    }

    await group(app, [source, reviewer, hidden, ...extra]);
    const many = await snapshot(shared);

    assert.equal(many.sections.scope?.membersOmitted, 4);
    assert.equal(many.sections.outcomes?.length, 4);
});

// Revisions compare actual native identities and sections, not text equality or a fabricated history.
// Counts here protect the explicit no-unchanged-transcript-read contract across new reader instances.
test("delta isolates changed sections and distinct equal-text outcomes", async (t) => {
    const model = scriptedModel(() =>
        fauxAssistantMessage([fauxText("Agent says focused checks passed.")]),
    );
    const app = await openApp(model, join(root, "context-snapshot-delta"));

    t.after(() => app.close());
    const source = await newSession(app);

    await say(app, source, "Inspect the current scope.");
    await app.commands.updateSession(source, owner(app), { title: "Stable source" });
    const reader = () => app.workItems.reader(source, async () => owner(app), context, "shared");
    const original = app.transcripts.visibleEntry.bind(app.transcripts);
    let reads = 0;

    t.mock.method(app.transcripts, "visibleEntry", async (...args: Parameters<typeof original>) => {
        reads++;

        return original(...args);
    });
    const first = await snapshot(reader());
    const firstReads = reads;
    const same = await snapshot(reader(), {
        action: "delta",
        sinceRevision: first.revision,
        sectionRevisions: first.sectionRevisions,
    });

    assert.match(first.revision, /^[a-f0-9]{64}$/);
    assert.deepEqual(same.changed, []);
    assert.deepEqual(same.sections, {});
    assert.equal(reads, firstReads);
    assert.equal(same.revision, first.revision);
    await app.reviews.comment(source, owner(app), {
        requestId: "snapshot-review-comment",
        text: "Unresolved finding: check the cancellation path.",
    });
    const discussion = await snapshot(reader(), {
        action: "delta",
        sinceRevision: first.revision,
        sectionRevisions: first.sectionRevisions,
    });

    assert.deepEqual(discussion.changed, ["evidence"]);
    assert.match(JSON.stringify(discussion.sections), /cancellation path/);
    assert.equal(reads, firstReads);
    await say(app, source, "A distinct native request with the same agent answer.");
    const next = await snapshot(reader(), {
        action: "delta",
        sinceRevision: discussion.revision,
        sectionRevisions: discussion.sectionRevisions,
    });

    assert.deepEqual(next.changed, ["outcomes"]);
    assert.notEqual(next.revision, discussion.revision);
    assert.notEqual(
        next.sections.outcomes?.[0]?.runtime?.answerEntryId,
        first.sections.outcomes?.[0]?.runtime?.answerEntryId,
    );
    assert.equal(
        next.sections.outcomes?.[0]?.claim?.summary,
        first.sections.outcomes?.[0]?.claim?.summary,
    );
    assert.ok(reads > firstReads);
    const reset = await snapshot(reader(), { action: "delta", sinceRevision: "0".repeat(64) });

    assert.equal(reset.reset, true);
    assert.deepEqual(reset.changed, ["scope", "execution", "outcomes", "evidence"]);
    const initial = await reader().initial();

    assert.equal(initial.snapshot.revision, reset.revision);
    assert.equal(initial.thread.id, Number(source));
    assert.match(JSON.stringify(initial.transcript), /Agent says focused checks passed/);
});

test("snapshot reports the busy native run/attempt, not generated prose", async (t) => {
    const release = Promise.withResolvers<void>();
    const model = scriptedModel(async () => {
        await release.promise;

        return fauxAssistantMessage([fauxText("Eventually settled.")]);
    });
    const app = await openApp(model, join(root, "context-snapshot-execution"));

    t.after(async () => {
        release.resolve();
        await app.close();
    });
    const source = await newSession(app);
    const submitted = await app.commands.submit(source, owner(app), {
        text: "Inspect current execution.",
        requestId: "snapshot-active-execution",
    });

    await until(
        async () =>
            (await app.harness.snapshot(LiveDoc, source, context))?.generation !== undefined,
        "the actual source generation attempt",
    );
    const reader = app.workItems.reader(source, async () => owner(app), context, "shared");
    const result = await snapshot(reader);

    assert.equal(result.sections.execution?.threadId, Number(source));
    assert.equal(result.sections.execution?.busy, true);
    assert.ok((result.sections.execution?.run ?? 0) > 0);
    assert.ok((result.sections.execution?.attempt ?? 0) >= 1);
    assert.equal(result.sections.outcomes?.[0]?.claim, null);
    release.resolve();
    await (await app.harness.submission(submitted.submissionId, context))!.wait(context);
});

// Stale cached/projection authority must never make an awaited result publishable.
// The native claim is real; only the authorization/destination transition is interposed.
for (const change of ["token", "destination", "outcome", "execution"] as const) {
    test(`snapshot discards an awaited claim after ${change} changes`, async (t) => {
        const release = Promise.withResolvers<void>();
        let hold = false;
        const model = scriptedModel(async () => {
            if (hold) {
                await release.promise;
            }

            return fauxAssistantMessage([fauxText("Claim from the native source.")]);
        });
        const app = await openApp(model, join(root, `context-snapshot-race-${change}`));

        t.after(async () => {
            release.resolve();
            await app.close();
        });
        const source = await newSession(app);

        await say(app, source, "CLAIM_MUST_NOT_RETURN_AFTER_REVOCATION");
        const user = owner(app);
        const captured = structuredClone(user);
        const originalToken = user.tokenHash;
        const project = await app.projects.create(user, {
            requestId: `snapshot-race-${change}`,
            name: "Replacement destination binding",
            cwd: app.defaultCwd,
        });
        const original = app.transcripts.visibleEntry.bind(app.transcripts);
        let interposed = false;

        t.after(() => {
            user.tokenHash = originalToken;
        });
        t.mock.method(
            app.transcripts,
            "visibleEntry",
            async (...args: Parameters<typeof original>) => {
                const entry = await original(...args);

                interposed = true;

                if (change === "token") {
                    user.tokenHash = "revoked-during-snapshot";
                } else if (change === "destination") {
                    await app.projects.assign(user, source, { projectId: project.id });
                } else if (change === "outcome") {
                    await say(app, source, "NEW_CONTRIBUTION_MUST_INVALIDATE_SNAPSHOT");
                } else {
                    hold = true;
                    await app.commands.submit(source, user, {
                        requestId: "new-execution-during-snapshot",
                        text: "Start another native execution attempt.",
                    });
                    await until(() => app.isBusy(source), "the replacement native execution");
                }

                return entry;
            },
        );
        const reader = app.workItems.reader(source, async () => captured, context, "shared");

        await assert.rejects(snapshot(reader), { status: change === "token" ? 401 : 409 });
        assert.equal(interposed, true, "rejection must follow the real awaited claim read");
    });
}
