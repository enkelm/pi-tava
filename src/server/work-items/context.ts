/** Source-bound project/Work Item reads shared by private PiP and the read-only mention adapter. */
import { createHash } from "node:crypto";
import { Type, type Tool, type ToolCall } from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import type { Context } from "@earendil-works/chord";
import { LiveDoc, type ConversationId } from "@earendil-works/pi-durable";
import type { PocketApp } from "../app.ts";
import type { User } from "../config.ts";
import type { ClientEntry } from "../projection.ts";
import { ChatDoc, PipWorkDoc } from "../docs.ts";
import { HttpError } from "../errors.ts";
import { PublicationsDoc } from "../workflow-publication.ts";
import { nativePassiveOutcome } from "../pip/outcomes.ts";

const SECTIONS = ["scope", "execution", "outcomes", "evidence"] as const;
const revisionParameter = () => Type.String({ pattern: "^[a-f0-9]{64}$", maxLength: 64 });

type OutcomeClaim = {
    provenance: "agent-claim-not-verified-result";
    summary: string;
    provider?: string;
    model?: string;
};
// Bounded immutable excerpts, never authority or history. Every use still crosses #target.
const claims = new WeakMap<PocketApp, Map<string, OutcomeClaim | null>>();

export const workContextParameters = Type.Object(
    {
        action: Type.Union(
            [
                "snapshot",
                "delta",
                "status",
                "thread",
                "discussion",
                "files",
                "file",
                "changes",
                "diff",
            ].map((action) => Type.Literal(action)),
        ),
        sinceRevision: Type.Optional(revisionParameter()),
        sectionRevisions: Type.Optional(
            Type.Object(
                Object.fromEntries(
                    SECTIONS.map((section) => [section, Type.Optional(revisionParameter())]),
                ),
                { additionalProperties: false },
            ),
        ),
        threadId: Type.Optional(Type.Integer({ minimum: 1 })),
        path: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
        query: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
        before: Type.Optional(
            Type.Integer({
                minimum: 1,
                description:
                    "thread: transcript cursor. discussion: exclusive 1-based review creation position; pass reviewPage.before for older threads (not chat).",
            }),
        ),
        startLine: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000_000 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    },
    { additionalProperties: false },
);

export const sharedContextTool: Tool = {
    name: "work_context",
    description:
        "Read the source and its actually bound work, without changing it. snapshot returns compact scope/decision references, current runtime execution, attributed outcomes and evidence (bounded recent members, not a history or correctness certificate). delta compares sinceRevision and optional sectionRevisions from a prior snapshot, returning only changed current sections; no stored history is implied. Both are rooted at the actual source, never threadId, and remain passive (no Git/eligibility probes). Private controller scope/questions/receipts never enter Collaborator snapshots. Correlation references are exact; null means an oversized reference was omitted (512 JSON bytes), never truncated into another identity. Runtime settlement and agent claims are distinct; missing checks remain unknown. status shows the source, actual project, workflow and visible project/Work Item threads. thread reads visible human/assistant text (before paginates, query filters literal text), never tool results, prompts or thinking. discussion reads recent chat and pages review threads (pass reviewPage.before until null; reviewPage counts all/omitted/unresolved threads, chatOmitted and omittedReplies disclose other truncation; query is not supported). files discovers paths (query filters names); file reads current UTF-8 code with line numbers (startLine/limit paginate, query finds text). changes/diff inspect current Changes (startLine/limit also page diff lines). threadId defaults to the actual source. Collaborator mentions may name visible non-private threads in that same project or Work Item; private PiP work reads stay in the source Work Item. A private named-agent source permits its own history/discussion only unless actually bound to project/work, never sibling chats, Memory or a project inferred from remit/name/folder. All paths are relative to the target thread's folder. No arbitrary sessions, shell, writes or external access.",
    parameters: workContextParameters,
};

export type WorkReadInput = {
    action: string;
    threadId?: number;
    sinceRevision?: string;
    sectionRevisions?: Partial<Record<(typeof SECTIONS)[number], string>>;
    path?: string;
    query?: string;
    before?: number;
    startLine?: number;
    limit?: number;
};

/** Free text has an encoded JSON-byte budget, including control-character escaping. */
function compactText(value: string, bytes = 600): string {
    let text = value.slice(0, bytes);

    while (Buffer.byteLength(JSON.stringify(text)) > bytes - 5) {
        text = text.slice(0, Math.floor(text.length * 0.8));
    }

    return text.length < value.length ? `${text}…` : text;
}

const revisionOf = (value: unknown): string =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");
// Correlation is exact or explicitly unavailable, never a clipped lookalike native identity.
const exactRef = (value: string): string | null =>
    Buffer.byteLength(JSON.stringify(value)) <= 512 ? value : null;

/** Visible conversation text only: tool results/commands and derived summaries may contain private Memory or secrets. */
function publicEntry(entry: ClientEntry) {
    if (
        entry.kind !== "assistant" &&
        entry.kind !== "user" &&
        entry.kind !== "note" &&
        entry.kind !== "agentAnswer" &&
        entry.kind !== "pipQuestion"
    ) {
        return [];
    }

    const text =
        entry.kind === "assistant"
            ? entry.blocks.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
            : entry.text;

    return [
        {
            id: entry.id,
            kind: entry.kind,
            text: text.slice(0, 4000),
            ...(text.length > 4000 ? { truncated: true } : {}),
        },
    ];
}

export class WorkContext {
    readonly #app: PocketApp;
    readonly #source: ConversationId;
    readonly #authorize: () => Promise<User>;
    readonly #context: Context;
    readonly #audience: "shared" | "private";
    readonly #destinations = new Map<number, string>();

    constructor(
        app: PocketApp,
        source: ConversationId,
        authorize: () => Promise<User>,
        context: Context,
        audience: "shared" | "private",
    ) {
        this.#app = app;
        this.#source = source;
        this.#authorize = authorize;
        this.#context = context;
        this.#audience = audience;
    }

    #members(user: User): Set<number> {
        const app = this.#app;
        const root = app.rootOf(this.#source);
        const meta = app.sessionMeta(root);
        const members = new Set(
            app.workItems.context(this.#source, user).workItem?.threadIds ?? [],
        );

        members.add(Number(root));

        if (
            this.#audience === "shared" &&
            meta?.projectId !== undefined &&
            app.projects.canAccessThread(user, meta)
        ) {
            for (const thread of app.sessions(user)) {
                const target = app.sessionMeta(thread.id as ConversationId);

                if (
                    target?.projectId === meta.projectId &&
                    app.projects.canAccessThread(user, target)
                ) {
                    members.add(thread.id);
                }
            }
        }

        return members;
    }

    #eligible(id: ConversationId, user: User): boolean {
        const app = this.#app;
        const root = app.rootOf(id);
        const meta = app.sessionMeta(root);

        if (!meta || !app.canSee(user, id) || app.pip.isInternal(id)) {
            return false;
        }

        if (meta.pip !== undefined || meta.pipAgent === true || meta.pipWorkItemId !== undefined) {
            return (
                id === this.#source &&
                id === root &&
                user.role === "owner" &&
                app.pip.agents.scope(root)?.ownerId === user.id
            );
        }

        return this.#audience !== "shared" || !meta.ownerOnly;
    }

    async #target(requested?: number) {
        const user = await this.#authorize();
        const id = (requested ?? Number(this.#source)) as ConversationId;
        const app = this.#app;
        const allowed = this.#members(user);
        const root = app.rootOf(id);
        const meta = app.sessionMeta(root);

        app.requireSee(user, id);

        if (
            !meta ||
            !this.#eligible(id, user) ||
            !allowed.has(Number(root)) ||
            (app.sessionMeta(app.rootOf(this.#source))?.pip !== undefined &&
                root === app.rootOf(this.#source) &&
                id !== this.#source)
        ) {
            throw new HttpError(404, "That thread is outside this work");
        }

        const destination = JSON.stringify([app.cwdOf(id), app.locationOf(id), meta.projectId]);
        const pinned = this.#destinations.get(Number(id));

        if (pinned !== undefined && destination !== pinned) {
            throw new HttpError(409, "The work's destination changed during this answer");
        }

        this.#destinations.set(Number(id), destination);
        this.#context.abortSignal?.throwIfAborted();

        return { id, user };
    }

    async summary() {
        const { id, user } = await this.#target();
        const app = this.#app;
        const root = app.rootOf(id);
        const meta = app.sessionMeta(root)!;
        const { workflow, workItem } = app.workItems.context(id, user);
        const members = this.#members(user);
        const visible = app
            .sessions(user)
            .filter(
                (thread) =>
                    members.has(thread.id) && this.#eligible(thread.id as ConversationId, user),
            );
        const threads = visible.slice(0, 12);
        const itemThreads = visible
            .filter((thread) => workItem?.threadIds.includes(thread.id))
            .slice(0, 12);
        const project = app.projects
            .list(user)
            .projects.find((entry) => entry.id === meta.projectId);
        const active = (workItem?.activeThreadId ?? Number(root)) as ConversationId;
        const routes =
            this.#audience === "private" ? await app.workItems.list(active, user) : undefined;
        const currentType = app.sessionMeta(active)?.threadType ?? "worker";
        const role = app.workItems.profile(currentType);
        const history = (workItem?.threadIds ?? [Number(root)])
            .filter((member) => this.#eligible(member as ConversationId, user))
            .slice(-12)
            .map((member) => ({
                id: member,
                type: app.sessionMeta(member as ConversationId)?.threadType ?? "worker",
            }));

        const title = (await app.conversationTitle(id)).slice(0, 200);

        await this.#target();

        return {
            thread: {
                id: Number(id),
                title,
                type: meta.threadType ?? "worker",
            },
            ...(project
                ? {
                      project: {
                          id: project.id,
                          name: project.name.slice(0, 200),
                          ...(this.#audience === "shared"
                              ? {
                                    threads: threads.map((thread) => ({
                                        id: thread.id,
                                        title: (thread.title ?? "Thread").slice(0, 120),
                                        type: thread.threadType,
                                    })),
                                    truncated: visible.length > threads.length,
                                }
                              : {}),
                      },
                  }
                : {}),
            workflow: {
                status: workflow.status,
                readOnly: workflow.readOnly,
                paused: workflow.paused,
                preparing: workflow.preparing,
                ...(routes === undefined
                    ? {}
                    : {
                          activeThreadId: Number(active),
                          currentType,
                          ...(role === undefined
                              ? {}
                              : { role: { name: role.name, description: role.description } }),
                          history,
                          historyOmitted: (workItem?.threadIds.length ?? 1) - history.length,
                          options: routes.options,
                          ...(routes.diffReason === undefined
                              ? {}
                              : { diffReason: routes.diffReason }),
                      }),
            },
            workItem: workItem
                ? {
                      id: workItem.id,
                      title:
                          workItem.originThreadId !== undefined &&
                          this.#eligible(workItem.originThreadId as ConversationId, user)
                              ? workItem.title.slice(0, 300)
                              : "Work item",
                      ...(workItem.activeThreadId !== undefined &&
                      this.#eligible(workItem.activeThreadId as ConversationId, user)
                          ? { activeThreadId: workItem.activeThreadId }
                          : {}),
                      ...(workItem.originThreadId !== undefined &&
                      this.#eligible(workItem.originThreadId as ConversationId, user)
                          ? { originThreadId: workItem.originThreadId }
                          : {}),
                      threads: itemThreads.map((thread) => ({
                          id: thread.id,
                          title: (thread.title ?? "Thread").slice(0, 120),
                          type: thread.threadType,
                      })),
                      truncated:
                          visible.filter((thread) => workItem.threadIds.includes(thread.id))
                              .length > itemThreads.length,
                  }
                : null,
        };
    }

    /** Current projections only. Revisions compare state, not a fabricated event/history ledger. */
    async #snapshot(input: WorkReadInput) {
        const { id, user } = await this.#target();
        const app = this.#app;
        const root = app.rootOf(id);
        const meta = app.sessionMeta(root)!;
        const { workItem } = app.workItems.context(id, user);
        const eligible = (workItem?.threadIds ?? [Number(root)]).filter((member) =>
            this.#eligible(member as ConversationId, user),
        );
        const active =
            workItem?.activeThreadId ?? (workItem === undefined ? Number(root) : undefined);
        const visibleActive =
            active !== undefined && eligible.includes(active) ? active : undefined;
        // Preserve the latest independent-review reference even after several repair/landing threads.
        const reviewer = eligible.findLast(
            (member) => app.sessionMeta(member as ConversationId)?.threadType === "reviewer",
        );
        const selected = [
            ...new Set([visibleActive, reviewer, Number(root), ...eligible.toReversed()]),
        ]
            .filter((member): member is number => member !== undefined && eligible.includes(member))
            .slice(0, 4);
        const binding = [
            "work-context-v1",
            Number(id),
            this.#audience,
            user.id,
            user.tokenHash,
            this.#destinations.get(Number(id)),
            workItem?.id,
            visibleActive,
            eligible,
        ];
        const project = app.projects
            .list(user)
            .projects.find((entry) => entry.id === meta.projectId);
        const item = app.workItems.itemFor(root);
        const grant =
            this.#audience === "private" &&
            user.role === "owner" &&
            item?.supervisor?.ownerId === user.id
                ? item.supervisor
                : undefined;
        const controller =
            grant === undefined ? undefined : (grant.conversationId as ConversationId);

        // Never even load private controller state for a shared answer, including an owner's mention.
        if (controller !== undefined) {
            app.requireSee(user, controller);
        }

        const privateState =
            controller === undefined
                ? undefined
                : await app.harness.snapshot(PipWorkDoc, controller, this.#context);

        await this.#target();
        const privateRevision = revisionOf([
            privateState?.goal,
            privateState?.questions,
            privateState?.question,
            privateState?.pending,
            privateState?.reason,
        ]);
        const decisions = privateState?.questions.slice(-3).map((question) => ({
            questionId: exactRef(question.id),
            ...(question.entryId === undefined ? {} : { entryId: question.entryId }),
            question: compactText(question.text, 300),
            ...(question.answer === undefined
                ? {}
                : {
                      answer: {
                          text: compactText(question.answer.text, 300),
                          by: compactText(question.answer.by, 100),
                          at: question.answer.at,
                          actor: question.answer.agent === undefined ? "human" : "agent",
                          ...(question.answer.agent === undefined
                              ? {}
                              : { name: compactText(question.answer.agent.name, 100) }),
                      },
                  }),
        }));
        const parentProjection = async () =>
            this.#audience === "private" && app.pip.agents.isNamed(root)
                ? (await app.pip.agents.supervision.parentContext(root, user)).map((task) => ({
                      ...task,
                      remaining: compactText(task.remaining, 600),
                      dependency: {
                          ...task.dependency,
                          requestId: exactRef(task.dependency.requestId),
                      },
                      ...(task.reason === undefined
                          ? {}
                          : { reason: compactText(task.reason, 200) }),
                  }))
                : undefined;
        const parentTasks = await parentProjection();

        await this.#target();
        const scope = {
            ...(parentTasks === undefined ? {} : { parentTasks }),
            source: {
                threadId: Number(root),
                title: compactText(await app.conversationTitle(root), 200),
            },
            project:
                project === undefined
                    ? null
                    : { id: compactText(project.id, 100), name: compactText(project.name, 160) },
            workItem:
                workItem === undefined
                    ? null
                    : {
                          id: compactText(workItem.id, 100),
                          title: compactText(
                              workItem.originThreadId !== undefined &&
                                  eligible.includes(workItem.originThreadId)
                                  ? workItem.title
                                  : "Work item",
                              200,
                          ),
                          ...(workItem.originThreadId === undefined ||
                          !eligible.includes(workItem.originThreadId)
                              ? {}
                              : { originThreadId: workItem.originThreadId }),
                      },
            ...(privateState === undefined
                ? {}
                : {
                      privateController: {
                          goal: compactText(privateState.goal, 600),
                          decisions,
                          decisionsOmitted: Math.max(0, privateState.questions.length - 3),
                          ...(privateState.pending === undefined
                              ? {}
                              : {
                                    pendingWake: {
                                        requestId: exactRef(privateState.pending.requestId),
                                        sourceThreadId: privateState.pending.source,
                                        taskId: privateState.pending.taskId,
                                        epoch: privateState.pending.epoch,
                                    },
                                }),
                          ...(privateState.reason === undefined
                              ? {}
                              : {
                                    reason: {
                                        provenance: "controller-reason-not-verdict",
                                        text: compactText(privateState.reason, 200),
                                    },
                                }),
                          pendingQuestion:
                              privateState.question === undefined
                                  ? null
                                  : {
                                        questionId: exactRef(privateState.question.id),
                                        ...(privateState.question.entryId === undefined
                                            ? {}
                                            : { entryId: privateState.question.entryId }),
                                        text: compactText(privateState.question.text, 300),
                                        answered: privateState.question.answer !== undefined,
                                    },
                      },
                  }),
            // Missing scope is not synthesized from titles or agent prose. Follow these exact threads.
            scopeRefs: eligible.includes(workItem?.originThreadId ?? Number(root))
                ? [{ threadId: workItem?.originThreadId ?? Number(root) }]
                : [],
            members: selected.map((member) => ({
                threadId: member,
                type: compactText(
                    app.sessionMeta(member as ConversationId)?.threadType ?? "worker",
                    100,
                ),
            })),
            membersOmitted: eligible.length - selected.length,
        };

        const executionProjection = (
            target: ConversationId,
            run: number | undefined,
            attempt: number | undefined,
        ) => {
            const { workflow } = app.workItems.context(target, user);

            return {
                provenance: "runtime",
                threadId: Number(target),
                type: compactText(app.sessionMeta(target)?.threadType ?? "worker", 100),
                busy: app.isBusy(target),
                ...(run === undefined ? {} : { run }),
                ...(attempt === undefined ? {} : { attempt }),
                workflow: {
                    status: workflow.status,
                    readOnly: workflow.readOnly,
                    paused: workflow.paused,
                    preparing: workflow.preparing,
                },
            };
        };

        let execution: object = { provenance: "runtime", unavailable: true };

        if (visibleActive !== undefined) {
            const target = visibleActive as ConversationId;

            await this.#target(visibleActive);
            const live = await app.harness.snapshot(LiveDoc, target, this.#context);

            execution = executionProjection(target, live?.run, live?.generation?.attempt);
            await this.#target(visibleActive);
        }

        const outcomes = [];
        const evidence = [];
        const observedOutcomes = new Map<number, string>();
        const reviewRevisions = new Map<number, number>();
        const workflowRevisions = new Map<number, string>();

        for (const member of selected) {
            const target = member as ConversationId;

            await this.#target(member);
            const outcome = await app.pip.orchestration.contribution(target);

            await this.#target(member);
            observedOutcomes.set(member, revisionOf(outcome ?? null));
            const { workflow } = app.workItems.context(target, user);
            const reviews = await app.reviews.list(target, user);

            reviewRevisions.set(member, reviews.rev);
            workflowRevisions.set(member, revisionOf(workflow));
            await this.#target(member);
            const unresolved = reviews.threads.filter((thread) => !thread.resolved);
            const publications =
                this.#audience === "private" && user.role === "owner"
                    ? await app.harness.snapshot(PublicationsDoc, target, this.#context)
                    : undefined;
            const receipts = Object.entries(publications?.receipts ?? {});
            const approvals =
                this.#audience === "private" && user.role === "owner"
                    ? app.approvals.forConversation(target)
                    : undefined;

            outcomes.push({
                threadId: member,
                candidateId: outcome?.status === "done" ? `${member}:${outcome.answer}` : null,
                runtime:
                    outcome === undefined
                        ? null
                        : {
                              status: outcome.status,
                              inputEntryId: outcome.entry,
                              ...(this.#audience === "private" && user.role === "owner"
                                  ? { submissionId: outcome.submission }
                                  : {}),
                              ...(outcome.status === "done"
                                  ? { answerEntryId: outcome.answer }
                                  : { reason: compactText(outcome.reason, 160) }),
                          },
                claim: null as OutcomeClaim | null,
            });
            evidence.push({
                threadId: member,
                workflowRevision: workflowRevisions.get(member),
                discussionRevision: reviews.rev,
                assessment:
                    workflow.reviewAssessment === undefined
                        ? null
                        : {
                              provenance: "stored-agent-assessment",
                              outcome: workflow.reviewAssessment.outcome,
                              gaps: workflow.reviewAssessment.validationGaps
                                  .slice(0, 4)
                                  .map((gap) => compactText(gap, 160)),
                              gapsOmitted: Math.max(
                                  0,
                                  workflow.reviewAssessment.validationGaps.length - 4,
                              ),
                              applicability: workflow.reviewApplicability ?? "unknown",
                          },
                report:
                    workflow.summary === undefined
                        ? null
                        : { provenance: "agent-claim", text: compactText(workflow.summary, 400) },
                externalReview:
                    workflow.externalReview === undefined
                        ? null
                        : {
                              provenance: "human-supplied-external-review",
                              source: compactText(workflow.externalReview.source, 200),
                              scope: compactText(workflow.externalReview.scope, 200),
                              checkpoint: compactText(workflow.externalReview.checkpoint, 100),
                              suppliedBy: compactText(workflow.externalReview.suppliedBy, 100),
                              sourceEntryId: workflow.externalReview.sourceEntryId,
                          },
                validationDecisions: (workflow.validationAcceptances ?? [])
                    .slice(-2)
                    .map((acceptance) => ({
                        provenance: "human-risk-acceptance-not-passed-checks",
                        checkpoint: compactText(acceptance.checkpoint, 100),
                        assessment: compactText(acceptance.assessment, 100),
                        by: compactText(acceptance.acceptedBy, 100),
                        at: acceptance.acceptedAt,
                        gaps: acceptance.gaps.slice(0, 3).map((gap) => compactText(gap, 120)),
                        gapsOmitted: Math.max(0, acceptance.gaps.length - 3),
                    })),
                validationDecisionsOmitted: Math.max(
                    0,
                    (workflow.validationAcceptances?.length ?? 0) - 2,
                ),
                findings: unresolved.slice(-2).map((thread) => ({
                    provenance: "review-discussion-not-verdict",
                    id: compactText(thread.id, 100),
                    by: compactText(thread.name, 100),
                    text: compactText(thread.text, 200),
                    ...(thread.path === undefined
                        ? {}
                        : { path: compactText(thread.path, 200), line: thread.line }),
                })),
                unresolved: unresolved.length,
                findingsOmitted: Math.max(0, unresolved.length - 2),
                ...(publications === undefined
                    ? {}
                    : {
                          publicationReceipts: receipts.slice(-2).map(([key, receipt]) => ({
                              provenance: "runtime-receipt-not-code-validation",
                              receiptKey: exactRef(key),
                              receiptId: exactRef(receipt.id),
                              state: receipt.state,
                              ...(receipt.sourceCommit === undefined
                                  ? {}
                                  : { sourceCommit: compactText(receipt.sourceCommit, 100) }),
                              exitCode: receipt.exitCode,
                              approvedAt: receipt.approvedAt,
                              ...(receipt.resolution === undefined
                                  ? {}
                                  : { resolution: compactText(receipt.resolution.outcome, 100) }),
                          })),
                          publicationReceiptsOmitted: Math.max(0, receipts.length - 2),
                      }),
                ...(approvals === undefined
                    ? {}
                    : {
                          pendingApprovals: approvals.slice(0, 2).map((approval) => ({
                              id: exactRef(approval.id),
                              taskId: Number(approval.taskId),
                              ...(approval.callId === undefined
                                  ? {}
                                  : { callId: exactRef(approval.callId) }),
                              tool: compactText(approval.tool, 100),
                              createdAt: approval.createdAt,
                          })),
                          pendingApprovalsOmitted: Math.max(0, approvals.length - 2),
                      }),
            });
            await this.#target(member);
        }

        const sections = { scope, execution, outcomes, evidence };
        // Native input/answer identities revision the immutable excerpts, without loading their text.
        const sectionRevisions = Object.fromEntries(
            SECTIONS.map((key) => [key, revisionOf([binding, sections[key]])]),
        );
        const revision = revisionOf(sectionRevisions);
        const changed =
            input.action !== "delta"
                ? [...SECTIONS]
                : input.sinceRevision === revision
                  ? []
                  : SECTIONS.filter(
                        (key) => input.sectionRevisions?.[key] !== sectionRevisions[key],
                    );

        if (changed.includes("outcomes")) {
            for (const outcome of outcomes) {
                if (outcome.runtime?.answerEntryId !== undefined) {
                    outcome.claim = await this.#outcomeClaim(
                        outcome.threadId as ConversationId,
                        outcome.runtime.answerEntryId,
                    );
                }
            }
        }

        await this.#target();

        for (const member of selected) {
            await this.#target(member);
            const current = await app.pip.orchestration.contribution(member as ConversationId);

            await this.#target(member);

            const reviews = await app.reviews.list(member as ConversationId, user);

            await this.#target(member);

            if (
                revisionOf(current ?? null) !== observedOutcomes.get(member) ||
                reviews.rev !== reviewRevisions.get(member) ||
                revisionOf(app.workItems.context(member as ConversationId, user).workflow) !==
                    workflowRevisions.get(member)
            ) {
                throw new HttpError(409, "The work changed during this snapshot; read it again");
            }
        }

        if (visibleActive !== undefined) {
            await this.#target(visibleActive);
            const target = visibleActive as ConversationId;
            const live = await app.harness.snapshot(LiveDoc, target, this.#context);

            await this.#target(visibleActive);

            if (
                revisionOf(executionProjection(target, live?.run, live?.generation?.attempt)) !==
                revisionOf(execution)
            ) {
                throw new HttpError(409, "The work changed during this snapshot; read it again");
            }
        }

        if (controller !== undefined) {
            app.requireSee(await this.#authorize(), controller);
            const state = await app.harness.snapshot(PipWorkDoc, controller, this.#context);

            app.requireSee(await this.#authorize(), controller);

            if (
                revisionOf([
                    state?.goal,
                    state?.questions,
                    state?.question,
                    state?.pending,
                    state?.reason,
                ]) !== privateRevision
            ) {
                throw new HttpError(409, "The work changed during this snapshot; read it again");
            }
        }

        if (parentTasks !== undefined) {
            const currentParents = await parentProjection();

            await this.#target();

            if (revisionOf(currentParents) !== revisionOf(parentTasks)) {
                throw new HttpError(
                    409,
                    "The parent task changed during this snapshot; read it again",
                );
            }
        }

        const current = app.workItems.context(id, user).workItem;

        if (
            current?.id !== workItem?.id ||
            current?.activeThreadId !== workItem?.activeThreadId ||
            revisionOf(
                (current?.threadIds ?? [Number(root)]).filter((member) =>
                    this.#eligible(member as ConversationId, user),
                ),
            ) !== revisionOf(eligible)
        ) {
            throw new HttpError(409, "The work changed during this snapshot; read it again");
        }

        return {
            revision,
            sectionRevisions,
            changed,
            ...(input.action === "delta"
                ? {
                      reset:
                          input.sinceRevision !== revision && input.sectionRevisions === undefined,
                  }
                : {}),
            sections: Object.fromEntries(changed.map((key) => [key, sections[key]])),
        };
    }

    async #outcomeClaim(id: ConversationId, answer: number): Promise<OutcomeClaim | null> {
        const cache = claims.get(this.#app) ?? new Map<string, OutcomeClaim | null>();
        const key = `${id}:${answer}`;

        claims.set(this.#app, cache);

        if (cache.has(key)) {
            return cache.get(key)!;
        }

        const entry = await this.#app.transcripts.visibleEntry(id, answer);
        const outcome = nativePassiveOutcome(entry);
        const message = entry?.model?.find((message) => message.role === "assistant");
        const claim: OutcomeClaim | null =
            outcome?.summary === undefined
                ? null
                : {
                      provenance: "agent-claim-not-verified-result",
                      summary: compactText(outcome.summary),
                      ...(message?.role !== "assistant"
                          ? {}
                          : {
                                provider: compactText(message.provider, 100),
                                model: compactText(message.model, 100),
                            }),
                  };

        await this.#target(Number(id));
        cache.set(key, claim);

        for (const old of [...cache.keys()].slice(0, -64)) {
            cache.delete(old);
        }

        return claim;
    }

    async initial() {
        const summary = await this.summary();
        const snapshot = await this.#snapshot({ action: "snapshot" });
        const page = await this.#app.transcripts.page(this.#source, { limit: 8 }, this.#context);

        await this.#target();

        return {
            ...summary,
            snapshot,
            transcript: page.entries.flatMap(publicEntry),
            before: page.before,
        };
    }

    async read(call: ToolCall): Promise<unknown> {
        const input = validateToolArguments(sharedContextTool, call) as WorkReadInput;
        const { id, user } = await this.#target(input.threadId);
        const app = this.#app;
        const meta = app.sessionMeta(app.rootOf(id))!;

        if (
            meta.pip !== undefined &&
            meta.projectId === undefined &&
            meta.workItemId === undefined &&
            meta.pipWorkItemId === undefined &&
            ["files", "file", "changes", "diff"].includes(input.action)
        ) {
            throw new HttpError(404, "This private discussion has no bound workspace");
        }

        let result: unknown;

        switch (input.action) {
            case "snapshot":
            case "delta":
                result = await this.#snapshot(input);
                break;

            case "status":
                // Work Item identity is always rooted at the actual question, not a model-selected destination.
                result = await this.summary();
                break;

            case "thread": {
                const page = await app.transcripts.page(
                    id,
                    { before: input.before, limit: input.limit ?? 20 },
                    this.#context,
                );
                const entries = page.entries.flatMap(publicEntry);

                result = {
                    ...page,
                    entries: input.query
                        ? entries.filter((entry) =>
                              entry.text.toLowerCase().includes(input.query!.toLowerCase()),
                          )
                        : entries,
                };
                break;
            }

            case "discussion": {
                if (input.query !== undefined) {
                    throw new HttpError(
                        400,
                        "discussion does not support query; omit it and use reviewPage.before to read older review threads",
                    );
                }

                const chat = await app.harness.snapshot(ChatDoc, id, this.#context);
                const reviews = await app.reviews.list(id, user);
                const messages = (chat?.messages ?? []).filter((entry) => entry.kind !== "event");
                const recentChat = messages.slice(-(input.limit ?? 12));
                // Reviews appends threads without reordering/removing them. Creation positions stay
                // stable across new comments, replies and resolution changes between page requests.
                const end = Math.min(reviews.threads.length, (input.before ?? Infinity) - 1);
                const start = Math.max(0, end - (input.limit ?? 8));
                const threads = reviews.threads.slice(start, end);
                const unresolved = reviews.threads.filter((thread) => !thread.resolved).length;

                result = {
                    chat: recentChat.map(({ name, text }) => ({ name, text })),
                    chatOmitted: messages.length - recentChat.length,
                    reviewPage: {
                        total: reviews.threads.length,
                        unresolved,
                        omitted: reviews.threads.length - threads.length,
                        omittedUnresolved:
                            unresolved - threads.filter((thread) => !thread.resolved).length,
                        before: start > 0 ? start + 1 : null,
                    },
                    reviews: threads.map((thread) => ({
                        id: thread.id,
                        userId: thread.userId,
                        name: thread.name,
                        service: thread.service,
                        onBehalfOf: thread.onBehalfOf,
                        text: thread.text,
                        path: thread.path,
                        side: thread.side,
                        startLine: thread.startLine,
                        line: thread.line,
                        context: thread.context,
                        resolved: thread.resolved,
                        resolution: thread.resolution,
                        omittedReplies: Math.max(0, thread.replies.length - 6),
                        replies: thread.replies
                            .slice(-6)
                            .map(({ id, name, text, service, onBehalfOf }) => ({
                                id,
                                name,
                                text,
                                service,
                                onBehalfOf,
                            })),
                    })),
                };
                break;
            }

            case "files": {
                const listing = await app.workspace.sourceFiles(id, user, this.#context);
                const matching = listing.files.filter(
                    (path) =>
                        !input.query || path.toLowerCase().includes(input.query.toLowerCase()),
                );

                result = {
                    files: matching.slice(0, input.limit ?? 80),
                    truncated: listing.truncated || matching.length > (input.limit ?? 80),
                };
                break;
            }

            case "file": {
                const path = input.path ?? "";
                const { text, revision } = await app.workspace.sourceFile(
                    id,
                    user,
                    path,
                    this.#context,
                );
                const lines = text.replace(/\r\n/g, "\n").split("\n");
                const start = (input.startLine ?? 1) - 1;
                const matching = lines.flatMap((text, index) =>
                    index >= start &&
                    (!input.query || text.toLowerCase().includes(input.query.toLowerCase()))
                        ? [{ line: index + 1, text }]
                        : [],
                );
                const selected = matching.slice(0, input.limit ?? 80);

                result = {
                    path,
                    revision,
                    lines: selected,
                    nextLine:
                        matching.length > selected.length ? selected.at(-1)!.line + 1 : undefined,
                };
                break;
            }

            case "changes": {
                const changes = await app.reviews.changes(id, user, this.#context);
                const matches = changes.files.filter(
                    (file) =>
                        !input.query || file.path.toLowerCase().includes(input.query.toLowerCase()),
                );
                const files = matches.slice(0, input.limit ?? 60);

                result = {
                    ...changes,
                    files,
                    piOnly: changes.piOnly.slice(0, input.limit ?? 60),
                    more: changes.more + matches.length - files.length,
                };
                break;
            }

            case "diff": {
                const path = app.workspace.sourcePath(input.path);
                const lines = (await app.reviews.diff(id, user, path, this.#context)).split("\n");
                const start = (input.startLine ?? 1) - 1;
                const end = Math.min(lines.length, start + (input.limit ?? 80));

                result = {
                    path,
                    diff: lines.slice(start, end).join("\n"),
                    startLine: start + 1,
                    nextLine: end < lines.length ? end + 1 : undefined,
                };
                break;
            }

            default:
                throw new HttpError(400, "Unknown shared work read");
        }

        await this.#target(Number(id));

        return result;
    }
}
