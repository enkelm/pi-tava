/**
 * What Pi costs, and limits on it. A conversation's spend is its `pi.usage` total; a session's is its own and its
 * subagents'. Auxiliary requests add their own receipt-backed usage to the source and immutable requester, without
 * changing pi.usage or the main agent's attribution. Ordinary work goes to the person Pi works for when its usage
 * is committed. The owner can limit a session or a person. Past a limit, new messages are refused,
 * and a run that crosses it is stopped; the model request that crossed it still counts. Supervised Work Items also
 * share an absolute cap across their execution threads, helpers and separate PiP conversation until reclaimed.
 */
import { createHash } from "node:crypto";
import type { Usage } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
    type ConversationId,
    UsageDoc,
    type UsageState,
    type Tx,
} from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import {
    AuxiliaryUsageDoc,
    AuxiliaryUsageReceiptDoc,
    type AuxiliaryUsageRecord,
    SessionsDoc,
    SpendDoc,
} from "./docs.ts";
import { describe, HttpError } from "./errors.ts";
import { usageCost } from "./projection.ts";

const context = BACKGROUND_CONTEXT;

/** Spend stored for people a little after it happens: a run commits its usage with every response. */
const COUNT_AFTER_MS = 250;

export const dollars = (amount: number) => `$${amount.toFixed(2)}`;

export type SpendSummary = {
    /** Everything Pi spent on this server; only the owner sees it. */
    total?: number;
    sessions: { id: number; title: string; spent: number; budget?: number }[];
    /** Everyone for the owner; others see themselves. */
    people: { id: string; name: string; spent: number; budget?: number }[];
};

/** Internal model runners supply the real immutable requester/source and actual response model. */
export type AuxiliaryUsage = {
    receiptId: string;
    requesterId: string;
    sourceConversationId: ConversationId;
    provider: string;
    model: string;
    usage: Usage;
};

export class Spend {
    readonly #app: PocketApp;
    /** Each conversation's spend so far. */
    readonly #costs = new Map<ConversationId, number>();
    /** Spend added to people but not stored yet, per conversation and person. */
    readonly #owed = new Map<ConversationId, Map<string, number>>();
    /** What `SpendDoc` says each person spent, as of the last count. */
    #people: Record<string, number> = {};
    #auxiliary: { sources: Record<string, number>; people: Record<string, number> } = {
        sources: {},
        people: {},
    };
    #unsubscribeAuxiliary = () => {};
    /** Runs being stopped for a limit, until they end: each is stopped, and announced, once. */
    readonly #stopping = new Set<ConversationId>();
    #timer: NodeJS.Timeout | undefined;
    /** Told when the owner changes a limit: work held back by one may go now. */
    readonly #limits = new Set<() => void>();
    #enforcing = false;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /**
     * Start from what is stored: every conversation's spend, then count what a crash left uncounted. That goes to whoever
     * Pi works for there now, as whom it was for is not stored.
     */
    async load(ids: readonly ConversationId[]): Promise<void> {
        const harness = this.#app.harness;

        this.#auxiliary = (await harness.snapshot(AuxiliaryUsageDoc, context)) ?? {
            sources: {},
            people: {},
        };
        this.#unsubscribeAuxiliary();
        this.#unsubscribeAuxiliary = harness.subscribeCommits((publication) => {
            for (const change of publication.changes) {
                if (
                    change.type === "document" &&
                    change.record.kind === AuxiliaryUsageDoc.definition.kind
                ) {
                    this.#auxiliary = (change.value as {
                        sources: Record<string, number>;
                        people: Record<string, number>;
                    } | null) ?? {
                        sources: {},
                        people: {},
                    };
                    this.#stopOverLimit();
                    this.#app.refreshViews();
                    this.#app.scheduleSessions();
                }
            }
        });

        for (const id of ids) {
            this.#costs.set(id, usageCost(await harness.snapshot(UsageDoc, id, context)));
        }

        if ((await harness.snapshot(SpendDoc, context)) === undefined) {
            // The first start that counts spend per person: what was spent before is nobody's, rather than all of it
            // going to whoever wrote last in each conversation.
            await harness.commit(async (tx) => {
                const doc = await tx.doc(SpendDoc);

                for (const [id, cost] of this.#costs) {
                    doc.counted[String(id)] = cost;
                }
            }, context);
        }

        const stored = await harness.snapshot(SpendDoc, context);

        this.#people = { ...stored?.people };

        for (const id of ids) {
            const added = (this.#costs.get(id) ?? 0) - (stored?.counted[String(id)] ?? 0);

            if (added > 0) {
                this.#owe(id, this.#payer(id), added);
            }
        }

        await this.#count();
    }

    /**
     * Record a completed auxiliary request in its caller's transaction. Does not grant generation or
     * discussion authority. Receipt identity is source-scoped; conflicting reuse is an error. No
     * pi.usage or mutable conversation requester is involved, including during startup reconciliation.
     */
    async recordAuxiliaryUsage(tx: Tx, input: AuxiliaryUsage): Promise<void> {
        const record = auxiliaryRecord(input);
        const key = createHash("sha256")
            .update(JSON.stringify([record.sourceConversationId, record.receiptId]))
            .digest("hex");
        const receipt = await tx.doc(AuxiliaryUsageReceiptDoc, key, null);

        if (receipt.record !== undefined) {
            if (JSON.stringify(receipt.record) !== JSON.stringify(record)) {
                throw new Error("Auxiliary usage receipt already records a different response");
            }

            return;
        }

        if ((await tx.conversation(input.sourceConversationId)) === undefined) {
            throw new Error("Auxiliary usage source conversation does not exist");
        }

        const totals = await tx.doc(AuxiliaryUsageDoc);
        const source = String(record.sourceConversationId);
        const cost = record.usage.cost.total;
        const sourceTotal = (totals.sources[source] ?? 0) + cost;
        const personTotal = (totals.people[record.requesterId] ?? 0) + cost;

        if (!Number.isFinite(sourceTotal) || !Number.isFinite(personTotal)) {
            throw new Error("Auxiliary usage total exceeds the supported amount");
        }

        totals.sources[source] = sourceTotal;
        totals.people[record.requesterId] = personTotal;
        receipt.record = record;
    }

    /** Enable budget aborts only after startup is ready; accounting itself does not request progress. */
    startEnforcement(): void {
        if (this.#app.providerExtensions.recoveryRequired) {
            return;
        }

        this.#enforcing = true;
        this.#stopOverLimit();
    }

    /** Add spend in a conversation to a person, to be stored with the next count. */
    #owe(id: ConversationId, payer: string, added: number): void {
        const owed = this.#owed.get(id) ?? new Map<string, number>();

        owed.set(payer, (owed.get(payer) ?? 0) + added);
        this.#owed.set(id, owed);
    }

    /**
     * A conversation's usage changed: called from the commit listener, when whom Pi works for is who asked for this
     * work. Storing it waits for a moment.
     */
    usageChanged(id: ConversationId, usage: UsageState | null): void {
        const cost = usageCost(usage ?? undefined);
        const added = cost - (this.#costs.get(id) ?? 0);

        this.#costs.set(id, cost);

        if (added > 0) {
            this.#owe(id, this.#payer(id), added);
        }

        this.#timer ??= setTimeout(() => {
            this.#timer = undefined;
            void this.#count().catch((error: unknown) =>
                this.#app.log(`spend not counted: ${describe(error)}`),
            );
        }, COUNT_AFTER_MS);
    }

    /** Who pays for a conversation's work: whoever asked for it, else whoever started the session, else the owner. */
    #payer(id: ConversationId): string {
        const app = this.#app;

        return (
            app.attribution.requesterOf(id) ??
            app.sessionMeta(app.rootOf(id))?.createdBy ??
            app.config.users.find((user) => user.role === "owner")!.id
        );
    }

    /** Store the spend added to people, then stop work that went past a limit. */
    async #count(): Promise<void> {
        const owed = [...this.#owed];

        this.#owed.clear();

        if (owed.length === 0) {
            return;
        }

        try {
            this.#people = await this.#app.harness.commit(async (tx) => {
                const doc = await tx.doc(SpendDoc);

                for (const [id, payers] of owed) {
                    for (const [payer, added] of payers) {
                        doc.counted[String(id)] = (doc.counted[String(id)] ?? 0) + added;
                        doc.people[payer] = (doc.people[payer] ?? 0) + added;
                    }
                }

                return { ...doc.people };
            }, context);
        } catch (error) {
            // Still owed: the next count stores it.
            for (const [id, payers] of owed) {
                for (const [payer, added] of payers) {
                    this.#owe(id, payer, added);
                }
            }

            throw error;
        }

        this.#stopOverLimit();
    }

    /** What a session spent: itself and its subagents. */
    sessionSpent(root: ConversationId): number {
        let spent = 0;

        for (const [id, cost] of this.#allCosts()) {
            if (this.#app.rootOf(id) === root) {
                spent += cost;
            }
        }

        return spent;
    }

    /** Private identity reasoning across all chats, without double-counting native Work Item costs. */
    agentSpent(id: ConversationId): number {
        const identity = this.#app.pip.agents.identity(id);

        return identity === undefined
            ? this.sessionSpent(this.#app.rootOf(id))
            : identity.chatIds.reduce(
                  (sum, chat) => sum + this.sessionSpent(chat as ConversationId),
                  0,
              );
    }

    /** All execution roots and the separate supervisor, including historical and auxiliary usage once each. */
    workSpent(id: ConversationId): number {
        const app = this.#app;
        const root = app.rootOf(id);
        const item = app.workItems.itemFor(root);

        if (item === undefined) {
            return this.sessionSpent(root);
        }

        const roots = new Set(item.threadIds.map((member) => app.rootOf(member as ConversationId)));

        if (item.supervisor !== undefined) {
            roots.add(app.rootOf(item.supervisor.conversationId as ConversationId));
        }

        let spent = 0;

        for (const member of roots) {
            spent += this.sessionSpent(member);
        }

        return spent;
    }

    /**
     * The session at the top of a linked family (`linked-sessions.ts`): the one that started this one, and so on up. A
     * session no link started is its own.
     */
    teamRoot(root: ConversationId): ConversationId {
        const seen = new Set<ConversationId>([root]);
        let at = root;

        for (;;) {
            const from = this.#app.sessionMeta(at)?.linkedFrom?.id as ConversationId | undefined;

            if (from === undefined || seen.has(from)) {
                return at;
            }

            seen.add(from);
            at = from;
        }
    }

    /** What a linked family spent: its top session and every session linked under it, subagents included. */
    #teamSpent(top: ConversationId): number {
        let spent = 0;

        for (const [id, cost] of this.#allCosts()) {
            if (this.teamRoot(this.#app.rootOf(id)) === top) {
                spent += cost;
            }
        }

        return spent;
    }

    /**
     * What counts against a session's own limit, to show beside it: itself and its subagents, and, for a session that
     * started linked sessions, theirs too, as `#reached` counts it.
     */
    budgetSpent(root: ConversationId): number {
        if (this.#app.pip.agents.isNamed(root)) {
            return this.agentSpent(root);
        }

        return this.teamRoot(root) === root ? this.#teamSpent(root) : this.sessionSpent(root);
    }

    personSpent(userId: string): number {
        return (this.#people[userId] ?? 0) + (this.#auxiliary.people[userId] ?? 0);
    }

    /** The thread, team, supervised Work Item or person limit this conversation reached. */
    #reached(
        id: ConversationId,
        userId: string,
    ): { budget: number; person?: User; team?: true; work?: true } | undefined {
        const app = this.#app;
        const root = app.rootOf(id);
        const budget = app.sessionMeta(root)?.budget;
        const identity = app.pip.agents.identity(root);

        if (identity?.maxCost !== undefined && this.agentSpent(root) >= identity.maxCost) {
            return { budget: identity.maxCost };
        }

        if (budget !== undefined && this.sessionSpent(root) >= budget) {
            return { budget };
        }

        // The budget of the session that started a team covers it all: what its linked sessions spend counts too.
        const top = this.teamRoot(root);
        const team = app.sessionMeta(top)?.budget;

        if (team !== undefined && this.#teamSpent(top) >= team) {
            return top === root ? { budget: team } : { budget: team, team: true };
        }

        const supervisor = app.workItems.itemFor(root)?.supervisor;

        if (
            supervisor !== undefined &&
            supervisor.maxCost !== undefined &&
            this.workSpent(root) >= supervisor.maxCost
        ) {
            return { budget: supervisor.maxCost, work: true };
        }

        const person = app.config.userById(userId);
        const limit = person === undefined || person.role === "owner" ? undefined : person.budget;

        if (limit !== undefined && this.personSpent(userId) >= limit) {
            return { budget: limit, person };
        }

        return undefined;
    }

    /** Throw unless this person may start more work in this session. */
    check(user: User, id: ConversationId): void {
        const reached = this.#reached(id, user.id);

        if (reached === undefined) {
            return;
        }

        const whose =
            reached.person !== undefined
                ? "You reached your"
                : reached.team
                  ? "The session that started this one reached its"
                  : reached.work
                    ? "This work item reached its"
                    : "This session reached its";

        throw new HttpError(
            409,
            `${whose} ${dollars(reached.budget)} spend limit. The owner can raise it.`,
        );
    }

    /**
     * Why work Pi starts with nobody asking (a scheduled message, the next round toward a goal) may not start: a limit
     * the session or its payer reached. `userId` pays when given, else whoever asked last.
     */
    heldBack(id: ConversationId, userId = this.#payer(id)): string | undefined {
        const reached = this.#reached(id, userId);

        if (reached === undefined) {
            return undefined;
        }

        return reached.person !== undefined
            ? `${reached.person.name} reached their ${dollars(reached.budget)} spend limit`
            : reached.team
              ? `the session that started this one reached its ${dollars(reached.budget)} spend limit`
              : reached.work
                ? `this work item reached its ${dollars(reached.budget)} spend limit`
                : `this session reached its ${dollars(reached.budget)} spend limit`;
    }

    /** Call `listener` whenever the owner changes a session's or a person's limit; returns how to stop. */
    onLimitsChanged(listener: () => void): () => void {
        this.#limits.add(listener);

        return () => this.#limits.delete(listener);
    }

    #limitsChanged(): void {
        for (const listener of this.#limits) {
            listener();
        }
    }

    /** A conversation's run ended: a new one there is stopped again if it goes past a limit. */
    runEnded(id: ConversationId): void {
        this.#stopping.delete(id);
    }

    /** Stop every run that goes on past its session's limit or its payer's. */
    #stopOverLimit(): void {
        const app = this.#app;

        // Conversation.abort enables Durable's global scheduler, even for a different pending run.
        if (!this.#enforcing || app.providerExtensions.recoveryRequired) {
            return;
        }

        for (const id of app.busyConversations()) {
            if (this.#stopping.has(id)) {
                continue;
            }

            const why = this.heldBack(id);

            if (why === undefined) {
                continue;
            }

            this.#stopping.add(id);
            app.notice("warning", `Pi stopped: ${why}.`, id);
            void app
                .conversation(id)
                .then((conversation) => conversation.abort(context))
                .catch((error: unknown) => {
                    // The next count tries again.
                    this.#stopping.delete(id);
                    app.log(`could not stop ${String(id)}: ${describe(error)}`);
                });
        }
    }

    /** The owner limits what Pi may spend in a session (`null`: no limit). */
    async setSessionBudget(user: User, id: ConversationId, budget: unknown): Promise<void> {
        requireOwner(user);
        const amount = budgetOf(budget);

        if (this.#app.pip.agents.isNamed(id)) {
            await this.#app.pip.agents.setBudget(id, user, amount);
            this.#limitsChanged();

            return;
        }

        await this.#app.harness.commit(async (tx) => {
            const meta = (await tx.doc(SessionsDoc)).items[String(id)];

            if (meta === undefined) {
                throw new HttpError(404, "Not a session");
            }

            if (amount === undefined) {
                delete meta.budget;
            } else {
                meta.budget = amount;
            }
        }, context);
        this.#limitsChanged();
        await this.#app.collab.activity(
            id,
            user,
            amount === undefined
                ? "removed the spend limit"
                : `set a spend limit of ${dollars(amount)}`,
        );
    }

    /** The owner limits what Pi may spend for a person (`null`: no limit). */
    setPersonBudget(user: User, userId: string, budget: unknown): void {
        requireOwner(user);
        const person = this.#app.config.userById(userId);

        if (person === undefined) {
            throw new HttpError(404, "No such person");
        }

        if (person.role === "owner") {
            throw new HttpError(400, "The owner has no spend limit");
        }

        const amount = budgetOf(budget);

        this.#app.config.updateUser(userId, { budget: amount });
        this.#limitsChanged();
    }

    /** Spend as this person may see it: the owner sees everything, others their own sessions and themselves. */
    summary(user: User): SpendSummary {
        const app = this.#app;
        const owner = user.role === "owner";
        // Each session's spend, its subagents' with it, in one pass over every conversation.
        const byRoot = new Map<ConversationId, number>();

        for (const [id, cost] of this.#allCosts()) {
            const root = app.rootOf(id);

            byRoot.set(root, (byRoot.get(root) ?? 0) + cost);
        }

        const sessions = app.sessions(user).map((session) => {
            const id = session.id as unknown as ConversationId;
            const budget = app.sessionMeta(id)?.budget;

            return {
                id: session.id,
                title: session.title ?? "New session",
                spent: budget === undefined ? (byRoot.get(id) ?? 0) : this.budgetSpent(id),
                ...(budget === undefined ? {} : { budget }),
            };
        });

        // Reuse the identity's available-chat projection; an archived trailing chat is not a home.
        const destinations = new Map(
            owner
                ? app.pip.agents.list(user).map((agent) => [agent.agentId, agent.id] as const)
                : [],
        );

        // Private agents are out of Collab, not out of spending. Each retains its own limits.
        for (const [key, meta] of Object.entries(app.sessionCatalogue())) {
            const pip = Number(key) as ConversationId;

            if (
                meta.pip !== user.id ||
                meta.pipWorkItemId !== undefined ||
                !app.canSee(user, pip)
            ) {
                continue;
            }

            const identity = app.pip.agents.identity(pip);

            if (identity !== undefined && destinations.get(identity.agentId) !== Number(pip)) {
                continue;
            }

            const cap = identity?.maxCost ?? meta.budget;

            sessions.push({
                id: Number(pip),
                title: identity?.record.name ?? meta.title ?? "PiP",
                spent: identity === undefined ? (byRoot.get(pip) ?? 0) : this.agentSpent(pip),
                ...(cap === undefined ? {} : { budget: cap }),
            });
        }

        const people = app.config.users
            .filter((person) => owner || person.id === user.id)
            .map((person) => ({
                id: person.id,
                name: person.name,
                spent: this.personSpent(person.id),
                ...(person.budget === undefined ? {} : { budget: person.budget }),
            }));
        const total = [...this.#allCosts().values()].reduce((sum, cost) => sum + cost, 0);

        return {
            ...(owner ? { total } : {}),
            sessions: sessions.sort((a, b) => b.spent - a.spent),
            people: people.sort((a, b) => b.spent - a.spent),
        };
    }

    /** Combine dollar totals only for views and limits, never for ordinary payer reconciliation. */
    #allCosts(): Map<ConversationId, number> {
        const costs = new Map(this.#costs);

        for (const [source, cost] of Object.entries(this.#auxiliary.sources)) {
            const id = Number(source) as ConversationId;

            costs.set(id, (costs.get(id) ?? 0) + cost);
        }

        return costs;
    }

    close(): void {
        this.#unsubscribeAuxiliary();
        clearTimeout(this.#timer);
        this.#limits.clear();
    }
}

function requireOwner(user: User): void {
    if (user.role !== "owner") {
        throw new HttpError(403, "Only the owner can do that");
    }
}

/** A limit from a request: dollars, or null for none. */
function budgetOf(value: unknown): number | undefined {
    if (value === null) {
        return undefined;
    }

    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1_000_000) {
        throw new HttpError(400, "budget must be an amount in dollars, or null for none");
    }

    return Math.round(value * 100) / 100;
}

/** Normalize provider usage to bounded known fields before persisting it. */
function auxiliaryRecord(input: AuxiliaryUsage): AuxiliaryUsageRecord {
    for (const [field, value, max] of [
        ["receiptId", input.receiptId, 1024],
        ["requesterId", input.requesterId, 256],
        ["provider", input.provider, 256],
        ["model", input.model, 1024],
    ] as const) {
        if (
            typeof value !== "string" ||
            !value.trim() ||
            value.length > max ||
            value.includes("\0")
        ) {
            throw new Error(`Invalid auxiliary usage ${field}`);
        }
    }

    if (!Number.isSafeInteger(input.sourceConversationId) || input.sourceConversationId <= 0) {
        throw new Error("Invalid auxiliary usage source conversation");
    }

    const count = (value: number): number => {
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
            throw new Error("Auxiliary usage counts and costs must be finite and nonnegative");
        }

        return value;
    };

    const usage = input.usage;

    return {
        receiptId: input.receiptId,
        requesterId: input.requesterId,
        sourceConversationId: Number(input.sourceConversationId),
        provider: input.provider,
        model: input.model,
        usage: {
            input: count(usage.input),
            output: count(usage.output),
            cacheRead: count(usage.cacheRead),
            cacheWrite: count(usage.cacheWrite),
            ...(usage.cacheWrite1h === undefined
                ? {}
                : { cacheWrite1h: count(usage.cacheWrite1h) }),
            ...(usage.reasoning === undefined ? {} : { reasoning: count(usage.reasoning) }),
            totalTokens: count(usage.totalTokens),
            cost: {
                input: count(usage.cost.input),
                output: count(usage.cost.output),
                cacheRead: count(usage.cost.cacheRead),
                cacheWrite: count(usage.cost.cacheWrite),
                total: count(usage.cost.total),
            },
        },
    };
}
