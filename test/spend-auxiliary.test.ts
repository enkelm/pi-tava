// Auxiliary spend crosses the real app/commit/recovery seam, without generating or reading a checkout.
import {
    cleanUp,
    context,
    openApp,
    owner,
    recordCost,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { App } from "./helpers.ts";
import type { User } from "../src/server/config.ts";
import { SessionsDoc } from "../src/server/docs.ts";
import type { AuxiliaryUsage } from "../src/server/spend.ts";

const model = scriptedModel();
let app: App;
let requester: User;
let other: User;

before(async () => {
    app = await openApp(model);
    requester = app.config.addUser("Mention requester", "guest").user;
    other = app.config.addUser("Source speaker", "guest").user;
});

after(async () => {
    await app?.close();
    cleanUp();
});

async function source(linkedFrom?: ConversationId): Promise<ConversationId> {
    return app.harness.commit(async (tx) => {
        const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
        const sessions = await tx.doc(SessionsDoc);

        sessions.items[String(conversation.id)] = {
            title: "Auxiliary spend fixture",
            cwd: work,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            createdBy: owner(app).id,
            threadType: "chat",
            ...(linkedFrom === undefined ? {} : { linkedFrom: { id: Number(linkedFrom) } }),
        };

        return conversation.id;
    }, context);
}

function charge(id: ConversationId, receiptId: string, dollars = 1.25): AuxiliaryUsage {
    return {
        receiptId,
        requesterId: requester.id,
        sourceConversationId: id,
        provider: "faux",
        model: "actual-response-model",
        usage: {
            input: 11,
            output: 7,
            cacheRead: 3,
            cacheWrite: 2,
            cacheWrite1h: 1,
            reasoning: 4,
            totalTokens: 23,
            cost: {
                input: 0.25,
                output: dollars - 0.25,
                cacheRead: 0,
                cacheWrite: 0,
                total: dollars,
            },
        },
    };
}

// Protects atomic, exact-once billing and immutable requester attribution. Ordinary usage accounting
// cannot prove it: that path deliberately follows the source's current requester instead.
test("auxiliary billing is atomic, source-scoped and independent of the source speaker, including restart", async () => {
    const id = await source();
    const second = await source();
    const receipt = charge(id, "same-receipt");

    await app.commands.note(id, other, "is the current source requester");
    assert.equal(app.attribution.requesterOf(id), other.id);
    await assert.rejects(
        app.harness.commit(async (tx) => {
            await app.spend.recordAuxiliaryUsage(tx, receipt);

            throw new Error("delivery rolled back");
        }, context),
        /delivery rolled back/,
    );
    assert.equal(app.spend.personSpent(requester.id), 0);
    assert.equal(app.spend.sessionSpent(id), 0);

    await Promise.all(
        Array.from({ length: 3 }, () =>
            app.harness.commit((tx) => app.spend.recordAuxiliaryUsage(tx, receipt), context),
        ),
    );
    assert.equal(app.spend.personSpent(requester.id), 1.25);
    assert.equal(app.spend.personSpent(other.id), 0);
    assert.equal(app.spend.sessionSpent(id), 1.25);
    assert.equal(
        app.attribution.requesterOf(id),
        other.id,
        "billing must not retarget the main agent",
    );
    await assert.rejects(
        app.harness.commit(
            (tx) => app.spend.recordAuxiliaryUsage(tx, { ...receipt, requesterId: other.id }),
            context,
        ),
        /different response/,
    );
    await app.harness.commit(
        (tx) => app.spend.recordAuxiliaryUsage(tx, charge(second, "same-receipt", 0.75)),
        context,
    );
    await recordCost(app, id, 0.5);
    await until(() => app.spend.personSpent(other.id) === 0.5, "ordinary response billing");

    const check = () => {
        assert.equal(app.spend.personSpent(requester.id), 2);
        assert.equal(app.spend.personSpent(other.id), 0.5);
        assert.equal(app.spend.sessionSpent(id), 1.75);
        assert.equal(app.spend.summary(owner(app)).total, 2.5);
        assert.equal(
            app.spend.summary(owner(app)).sessions.find((s) => s.id === Number(id))?.spent,
            1.75,
        );
        assert.equal(app.spend.summary(requester).total, undefined);
        assert.deepEqual(
            app.spend.summary(requester).people.map((p) => [p.id, p.spent]),
            [[requester.id, 2]],
        );
    };

    check();
    await app.close();
    app = await openApp(model);
    await app.harness.commit((tx) => app.spend.recordAuxiliaryUsage(tx, receipt), context);
    check();
});

// Protects the existing budget and UI interfaces, which must aggregate the new ledger rather than
// showing a separate internal lane. This catches omissions from team aggregation and person checks.
test("auxiliary usage counts against source, linked-team and person limits and filtered summaries", async () => {
    const top = await source();
    const child = await source(top);
    const before = app.spend.personSpent(requester.id);

    await app.spend.setSessionBudget(owner(app), child, 1);
    await app.harness.commit(
        (tx) => app.spend.recordAuxiliaryUsage(tx, charge(child, "budget", 1)),
        context,
    );
    assert.throws(() => app.spend.check(owner(app), child), /This session reached its/);
    await app.spend.setSessionBudget(owner(app), child, null);
    await app.spend.setSessionBudget(owner(app), top, 1);
    assert.throws(
        () => app.spend.check(owner(app), child),
        /session that started this one reached/,
    );
    assert.equal(app.spend.budgetSpent(top), 1);
    assert.equal(
        app.spend.summary(owner(app)).sessions.find((s) => s.id === Number(top))?.spent,
        1,
    );
    await app.spend.setSessionBudget(owner(app), top, null);
    app.spend.setPersonBudget(owner(app), requester.id, before + 1);
    assert.throws(() => app.spend.check(requester, child), /You reached your/);
    app.spend.check(other, child);
    app.spend.check(owner(app), child);
    assert.match(app.spend.heldBack(child, requester.id)!, /Mention requester reached/);
    app.spend.setPersonBudget(owner(app), requester.id, null);

    const scoped = app.config.addUser("Scoped ledger reader", "guest", [String(child)]).user;

    assert.deepEqual(
        app.spend.summary(scoped).sessions.map((s) => [s.id, s.spent]),
        [[Number(child), 1]],
    );
    assert.equal(app.spend.summary(scoped).total, undefined);
});

// Protects persistent totals from corrupt/unbounded inputs and confirms rejection has no accounting
// side effect. No generation permission is implied by the internal recording interface.
test("invalid auxiliary usage never changes spend", async () => {
    const id = await source();
    const valid = charge(id, "invalid");
    const before = app.spend.personSpent(requester.id);

    for (const value of [NaN, Infinity, -1]) {
        await assert.rejects(
            app.harness.commit(
                (tx) =>
                    app.spend.recordAuxiliaryUsage(tx, {
                        ...valid,
                        usage: { ...valid.usage, cost: { ...valid.usage.cost, total: value } },
                    }),
                context,
            ),
            /finite and nonnegative/,
        );
    }

    await assert.rejects(
        app.harness.commit(
            (tx) =>
                app.spend.recordAuxiliaryUsage(tx, {
                    ...valid,
                    receiptId: "x".repeat(1025),
                }),
            context,
        ),
        /receiptId/,
    );
    assert.equal(app.spend.personSpent(requester.id), before);
    assert.equal(app.spend.sessionSpent(id), 0);
});
