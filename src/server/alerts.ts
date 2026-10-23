/**
 * Push notifications: who hears about what, and when. Pi finished, Pi needs approval, mentions, and chat messages go
 * to the people who take part in a session, unless they are looking at it or turned that kind off.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
    defineDoc,
    InboxDoc,
    LiveDoc,
    type CommitPublication,
    type SubmissionRecord,
    type ConversationId,
} from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import { AuthorsDoc, ChatDoc, FollowsDoc, SubagentsDoc } from "./docs.ts";
import { currentStateCheckpoints } from "./doc-checkpoint.ts";
import { AgentSupervisionDoc } from "./pip/agent-supervision.ts";
import { AgentContactsDoc } from "./pip/agent-contacts-doc.ts";
import { describe } from "./errors.ts";
import { entryText, projectEntry, snippet } from "./projection.ts";
import type { PushMessage, PushPrefs } from "./push.ts";

const context = BACKGROUND_CONTEXT;

/** Delivery attempts are claimed before transport: uncertain pushes are never automatically replayed. */
const AlertsDoc = defineDoc<{
    doneThrough?: number;
    events: Record<string, true>;
}>({
    kind: "pocket.alerts",
    version: 1,
    ...currentStateCheckpoints,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ events: {} }),
});

/** How long a run must stay finished before "Pi finished" is pushed: a queued follow-up often starts right away. */
const DONE_DELAY_MS = 3000;
/**
 * A call is offered for allowing from a notification only when all of it shows there, collapsed: one short line. A
 * longer one could hide its risky part below the fold; it opens the app instead. Denying is always offered.
 */
const MAX_NOTIFIED_CALL = 120;
/** Characters that break a line, are invisible, or reorder text: a call with any of them may not read as it runs. */
const DISGUISING = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

export class Alerts {
    readonly #app: PocketApp;
    readonly #doneTimers = new Map<ConversationId, NodeJS.Timeout>();
    /** Approvals already announced, so each one is pushed once. */
    #approvalIds = new Set<string>();
    #closed = false;
    readonly #abort = new AbortController();
    readonly #pending = new Set<Promise<void>>();
    readonly #outcomes = new Map<ConversationId, SubmissionRecord>();

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /** Push to one person about a conversation, unless they cannot see it, turned that kind off, or are looking at it. */
    async push(
        userId: string,
        id: ConversationId,
        kind: keyof PushPrefs,
        message: PushMessage,
        urgency: "normal" | "high" = "normal",
    ): Promise<void> {
        const app = this.#app;
        const store = app.pushStore;
        const user = app.config.userById(userId);

        if (this.#closed || store === undefined || user === undefined || !app.canSee(user, id)) {
            return;
        }

        if (
            !store.prefs(userId)[kind] ||
            app.watching(userId, id) ||
            store.subscriptions(userId).length === 0
        ) {
            return;
        }

        // Push services want a real contact; Apple rejects placeholders. A tunnel's https address will do.
        const subject = app.access?.url?.startsWith("https://") ? app.access.url : undefined;

        await store.notify(userId, message, {
            urgency,
            signal: AbortSignal.any([this.#abort.signal, AbortSignal.timeout(10000)]),
            ...(subject === undefined ? {} : { subject }),
        });
    }

    /** Owner-only Herdr delivery: fixed metadata, exact pane, existing preferences and watching rules. */
    async herdr(
        userId: string,
        paneId: string,
        kind: "done" | "approval",
        signal: AbortSignal,
    ): Promise<void> {
        const app = this.#app;
        const store = app.pushStore;
        const user = app.config.userById(userId);

        if (
            this.#closed ||
            signal.aborted ||
            user?.role !== "owner" ||
            !/^[a-f0-9]{64}$/.test(paneId) ||
            store === undefined ||
            !store.prefs(userId)[kind] ||
            app.watchingHerdr(userId, paneId) ||
            store.subscriptions(userId).length === 0
        ) {
            return;
        }

        const subject = app.access?.url?.startsWith("https://") ? app.access.url : undefined;

        await store.notify(
            userId,
            {
                title: kind === "done" ? "Herdr agent finished" : "Herdr agent needs attention",
                body:
                    kind === "done"
                        ? "The observed agent turn ended. Open its pane to inspect the result."
                        : "An agent is waiting for attention. Open its pane to inspect it.",
                url: `/private/${paneId}`,
                tag: `herdr-${paneId}`,
            },
            {
                urgency: kind === "done" ? "normal" : "high",
                signal: AbortSignal.any([signal, this.#abort.signal, AbortSignal.timeout(10000)]),
                ...(subject === undefined ? {} : { subject }),
            },
        );
    }

    /** Observe only newly committed native terminal inputs; never backfill completion from saved history. */
    committed(publication: CommitPublication): void {
        for (const change of publication.changes) {
            if (change.type !== "submission") {
                continue;
            }

            const record = change.value;
            const previous = this.#outcomes.get(record.conversationId);

            if (
                record.type === "input" &&
                record.entry !== undefined &&
                (record.status === "done" || record.status === "unanswered") &&
                Number(record.entry) >
                    Number(previous?.type === "input" ? (previous.entry ?? 0) : 0)
            ) {
                this.#outcomes.set(record.conversationId, record);
            }
        }
    }

    /** A run started or ended. "Pi finished" goes out once it has stayed finished for a moment. */
    runChanged(id: ConversationId, busy: boolean): void {
        clearTimeout(this.#doneTimers.get(id));
        this.#doneTimers.delete(id);

        if (
            this.#closed ||
            busy ||
            this.#app.sessionMeta(id) === undefined ||
            this.#app.pushStore === undefined
        ) {
            return;
        }

        const timer = setTimeout(() => {
            this.#doneTimers.delete(id);
            const pending = this.#pushDone(id).catch((error: unknown) =>
                this.#app.log(`push failed: ${describe(error)}`),
            );

            this.#pending.add(pending);
            void pending.finally(() => this.#pending.delete(pending));
        }, DONE_DELAY_MS);

        timer.unref();
        this.#doneTimers.set(id, timer);
    }

    async #pushDone(id: ConversationId): Promise<void> {
        const app = this.#app;

        if (this.#closed || app.isBusy(id)) {
            return;
        }

        const outcome = this.#outcomes.get(id);

        if (
            outcome?.type !== "input" ||
            outcome.entry === undefined ||
            (outcome.status !== "done" &&
                !(outcome.status === "unanswered" && outcome.reason === "model_error"))
        ) {
            return;
        }

        const conversation = await app.harness.conversation(id, context);

        if (conversation === undefined) {
            return;
        }

        const page = await conversation.entries({}, 12, undefined, context);
        const last = page.items
            .map((entry) => projectEntry(entry))
            .find((entry) => entry?.kind === "assistant");

        if (
            last?.kind !== "assistant" ||
            last.stopReason === "aborted" ||
            last.id <= Number(outcome.entry) ||
            (outcome.status === "done" && last.id !== Number(outcome.answer))
        ) {
            return;
        }

        if (last.stopReason === "error" && app.pip.agents.isNamed(id)) {
            await this.orchestrationEvent(
                id,
                `model-${last.id}`,
                "blocker",
                last.error ?? "The model request failed. No fallback was selected.",
            );

            return;
        }

        if ((await this.#internal(id)) || app.isBusy(id) || this.#closed) {
            return;
        }

        const fresh = await app.harness.commit(async (tx) => {
            const state = await tx.doc(AlertsDoc, id);

            if (Number(last.id) <= (state.doneThrough ?? 0)) {
                return false;
            }

            state.doneThrough = Number(last.id);

            return true;
        }, context);

        if (!fresh) {
            return;
        }

        const title = await app.conversationTitle(id);
        const failed = last.stopReason === "error";
        // Global PiP opens its panel; a work supervisor opens its separate private conversation.
        const meta = app.sessionMeta(id);
        const pip = meta?.pip !== undefined;
        const panel = pip && meta.pipWorkItemId === undefined && meta.pipAgent !== true;
        const message: PushMessage = {
            title: pip
                ? title
                : failed
                  ? `Pi stopped with an error · ${title}`
                  : `Pi finished · ${title}`,
            body: snippet(
                failed ? (last.error ?? "The model request failed.") : entryText(last) || "Done.",
                400,
            ),
            url: panel ? "/?pip=1" : `/s/${String(id)}`,
            tag: `done-${String(id)}`,
        };

        for (const userId of await this.participants(id)) {
            // Their PiP follows this run and tells them what came of it: one notification, not two.
            if (!pip && (await app.pip.reportsOn(id, userId).catch(() => false))) {
                continue;
            }

            await this.push(userId, id, "done", message);
        }
    }

    /** Routine yields are internal while a native supervisor/recipient/report path owns the work. */
    async #internal(id: ConversationId): Promise<boolean> {
        const app = this.#app;
        const root = app.rootOf(id);
        const meta = app.sessionMeta(root);
        const item = app.workItems.itemFor(root);

        // Helpers report to their parent. Retired/preparing threads and controller waits are not finals.
        if (
            id !== root ||
            meta?.pipWorkItemId !== undefined ||
            app.workItems.isReadOnly(root) ||
            app.workItems.isPreparing(root) ||
            item?.supervisor?.status === "running" ||
            (item !== undefined &&
                app.pip.agents.supervision.notificationParent(item) !== undefined)
        ) {
            return true;
        }

        const [supervision, contacts, inbox, helpers] = await Promise.all([
            app.harness.snapshot(AgentSupervisionDoc, context),
            app.harness.snapshot(AgentContactsDoc, context),
            app.harness.snapshot(InboxDoc, id, context),
            app.harness.snapshot(SubagentsDoc, id, context),
        ]);

        if (
            (inbox?.items.length ?? 0) > 0 ||
            (helpers?.outbox?.length ?? 0) > 0 ||
            helpers?.sending !== undefined ||
            helpers?.courier !== undefined ||
            app.conversationsOf(root).some((child) => app.isBusy(child))
        ) {
            return true;
        }

        // Exact named-agent sends retain their native target epoch until direct human takeover.
        if (
            Object.values(contacts?.contacts ?? {}).some(
                (contact) =>
                    contact.target === Number(id) &&
                    contact.action === "send" &&
                    ["prepared", "accepted"].includes(contact.status) &&
                    contacts?.epochs[String(id)] === contact.epoch,
            )
        ) {
            return true;
        }

        if (app.pip.agents.supervision.hasRunningChildren(id)) {
            return true;
        }

        if (meta?.pipAgent !== true) {
            if (meta?.pip !== undefined) {
                const follows = await app.harness.snapshot(FollowsDoc, id, context);
                const waiting = Object.values(follows?.items ?? {}).filter(
                    (follow) => follow.doneAt === undefined,
                );

                return app.harness.commit(async (tx) => {
                    for (const follow of waiting) {
                        const task = await tx.task(follow.taskId as never);

                        if (task !== undefined && task.state.status !== "terminal") {
                            return true;
                        }
                    }

                    return false;
                }, context);
            }

            return false;
        }

        const serial = Math.max(
            0,
            ...Object.values(supervision?.admissions ?? {})
                .filter((pin) => pin.chatId === Number(id))
                .map((pin) => pin.admissionSerial ?? 0),
        );
        const attention = supervision?.attention?.[String(id)];

        if (attention?.admissionSerial === serial) {
            return true;
        }

        // Delegation remains orchestration across later owner clarifications until an explicit final.
        const finishedThrough = attention?.finishedThrough ?? 0;

        return (
            Object.values(supervision?.requests ?? {}).some(
                (receipt) =>
                    receipt.chatId === Number(id) &&
                    (receipt.sourceAdmissionSerial ?? 0) > finishedThrough &&
                    ["delegate", "send", "follow"].includes(receipt.action ?? "delegate") &&
                    ["pending", "accepted"].includes(receipt.status),
            ) ||
            Object.values(supervision?.questionAnswers ?? {}).some(
                (receipt) =>
                    receipt.chatId === Number(id) &&
                    (receipt.sourceAdmissionSerial ?? 0) > finishedThrough &&
                    ["pending", "accepted"].includes(receipt.status),
            ) ||
            Object.values(contacts?.contacts ?? {}).some(
                (contact) =>
                    contact.chatId === Number(id) &&
                    (contact.sourceAdmissionSerial ?? 0) > finishedThrough &&
                    ["send", "follow"].includes(contact.action) &&
                    ["prepared", "accepted"].includes(contact.status),
            )
        );
    }

    /** Native ask/finish/blocker only. No prose classifier and no historical backfill on startup. */
    async orchestrationEvent(
        id: ConversationId,
        eventId: string,
        kind: "question" | "final" | "blocker",
        text: string,
    ): Promise<void> {
        const app = this.#app;
        const meta = app.sessionMeta(id);
        const userId = meta?.pip;

        if (this.#closed || userId === undefined) {
            return;
        }

        const item = app.workItems.itemFor(id);
        const parent =
            item === undefined ? undefined : app.pip.agents.supervision.notificationParent(item);
        let ongoing = false;
        const fresh = await app.harness.commit(async (tx) => {
            const state = await tx.doc(AlertsDoc, id);
            const key = `${kind}:${eventId}`;

            if (state.events[key] || Object.keys(state.events).length >= 10000) {
                return false;
            }

            state.events[key] = true;

            // Native finish can also relinquish orchestration to the human while execution continues.
            // Keep that lifecycle behavior, but do not mislabel its control handoff as completion.
            if (kind === "final" && item !== undefined) {
                for (const member of item.threadIds) {
                    const source = member as ConversationId;

                    for (const child of app.conversationsOf(source)) {
                        const live = await tx.doc(LiveDoc, child);
                        const inbox = await tx.doc(InboxDoc, child);
                        const helpers = await tx.doc(SubagentsDoc, child);

                        ongoing ||=
                            live.run !== undefined ||
                            inbox.items.length > 0 ||
                            app.workItems.isPreparing(source) ||
                            helpers.courier !== undefined ||
                            helpers.sending !== undefined ||
                            (helpers.outbox?.length ?? 0) > 0;
                    }
                }
            }

            return true;
        }, context);

        if (!fresh || ongoing || this.#closed || (parent !== undefined && kind !== "blocker")) {
            return;
        }

        await this.push(
            userId,
            id,
            kind === "final" ? "done" : kind === "question" ? "chat" : "approval",
            {
                title:
                    kind === "final"
                        ? "Orchestration finished"
                        : kind === "question"
                          ? "PiP needs your decision"
                          : "Orchestration needs attention",
                body: snippet(text, 400),
                url: `/s/${id}`,
                tag: kind === "question" ? eventId : `orchestration-${id}-${eventId}`,
            },
            kind === "final" ? "normal" : "high",
        );
    }

    /** New approvals go out to everyone in the session who can answer them. */
    announceApprovals(): void {
        const app = this.#app;
        const pending = app.approvals.all();
        const fresh = pending.filter((approval) => !this.#approvalIds.has(approval.id));

        this.#approvalIds = new Set(pending.map((approval) => approval.id));

        if (app.pushStore === undefined) {
            return;
        }

        for (const approval of fresh) {
            void (async () => {
                const root = app.rootOf(approval.conversationId);
                const title = await app.conversationTitle(root);
                const call = `${approval.tool}: ${approval.subject}`;
                const shown =
                    !DISGUISING.test(approval.subject) && call.length <= MAX_NOTIFIED_CALL;
                let people = await this.participants(root);

                if (people.size === 0) {
                    people = new Set(app.config.users.map((each) => each.id));
                }

                for (const userId of people) {
                    const user = app.config.userById(userId);

                    if (user === undefined || user.role === "viewer") {
                        continue;
                    }

                    const message: PushMessage = {
                        title: `Pi needs approval · ${title}`,
                        body: snippet(call, 400),
                        url: `/s/${String(approval.conversationId)}`,
                        tag: `approval-${approval.id}`,
                        approval: {
                            id: approval.id,
                            allow: shown && app.cannotAllow(user, approval) === undefined,
                        },
                    };

                    void this.push(userId, approval.conversationId, "approval", message, "high");
                }
            })().catch((error: unknown) => app.log(`push failed: ${describe(error)}`));
        }
    }

    /** People who take part in a session: whoever started it, wrote to Pi, or chatted there. */
    async participants(id: ConversationId): Promise<Set<string>> {
        const app = this.#app;
        const root = app.rootOf(id);
        const people = new Set<string>();
        const createdBy = app.sessionMeta(root)?.createdBy;

        if (createdBy !== undefined) {
            people.add(createdBy);
        }

        for (const userId of Object.values(
            (await app.harness.snapshot(AuthorsDoc, root, context))?.entries ?? {},
        )) {
            people.add(userId);
        }

        for (const message of (await app.harness.snapshot(ChatDoc, root, context))?.messages ??
            []) {
            if (message.kind !== "event") {
                people.add(message.userId);
            }
        }

        return people;
    }

    async close(): Promise<void> {
        this.#closed = true;
        this.#abort.abort();

        for (const timer of this.#doneTimers.values()) {
            clearTimeout(timer);
        }

        this.#doneTimers.clear();
        await Promise.allSettled(this.#pending);
    }
}
