// Registered private tools must separate delegated history reads from native control/activation.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { join } from "node:path";
import type { ConversationId } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AgentIdentitiesDoc } from "../src/server/agent-identity-docs.ts";
import { PIP_QUESTION_ENTRY } from "../src/server/entry-format.ts";
import { PipMentionsDoc, SessionsDoc } from "../src/server/docs.ts";
import { AgentContactsDoc } from "../src/server/pip/agent-contacts-doc.ts";
import { AgentSupervisionDoc } from "../src/server/pip/agent-supervision.ts";
import { HandoffsDoc } from "../src/server/workflow-docs.ts";
import { cleanUp, context, openApp, owner, root, say, scriptedModel, until } from "./helpers.ts";

after(cleanUp);

test("named native discovery and reads include the owner's archived/private histories without contact or controller side effects", async (t) => {
    const plan: { name: string; args: Record<string, string | number | boolean> }[] = [];
    let requests = 0;
    const app = await openApp(
        scriptedModel(() => {
            requests++;
            const next = plan.shift();

            return next === undefined
                ? fauxAssistantMessage("History inspected without activating recipients.")
                : fauxAssistantMessage(fauxToolCall(next.name, next.args), {
                      stopReason: "toolUse",
                  });
        }),
        join(root, "delegated-owner-history"),
    );

    t.after(() => app.close());
    app.config.lastModel = { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
    const user = owner(app);
    const made = await app.pip.agents.create(user, { name: "Historian", requestId: "historian" });
    const source = made.id as ConversationId;
    const older = (await app.pip.agents.newChat(source, user, { requestId: "older" }))
        .id as ConversationId;
    const sibling = (await app.pip.agents.create(user, { name: "Peer", requestId: "peer" }))
        .id as ConversationId;
    const global = await app.pip.ensure(user);
    const worker = (
        await app.commands.createSession(user, { cwd: app.defaultCwd, threadType: "worker" })
    ).id;
    const controller = (await app.pip.orchestration.control(worker, user, { action: "open" }))
        .orchestration!.conversationId as ConversationId;
    const unassociated = (
        await app.commands.createSession(user, { cwd: app.defaultCwd, threadType: "worker" })
    ).id;
    const targets = [older, sibling, global, controller, worker, unassociated];

    for (const [index, id] of targets.entries()) {
        await app.commands.note(id, user, `HISTORY_CANARY_${index}`);
    }

    // Synthetic stored history, not a forged question-admission or controller-action receipt.
    await app.harness.commit(async (tx) => {
        await tx.appendEntry(controller, {
            kind: PIP_QUESTION_ENTRY,
            data: { text: "HISTORY_CONTROLLER_QUESTION", questionId: "stored-history-question" },
        });
    }, context);
    // Persisted archive fixtures: private histories have no public archive-management intent.
    await app.harness.commit(async (tx) => {
        const sessions = await tx.doc(SessionsDoc);

        for (const id of [older, global, worker]) {
            sessions.items[String(id)]!.archived = true;
        }
    }, context);
    const before = await Promise.all(targets.map((id) => app.transcripts.allEntries(id, true)));
    const controlBefore = await app.harness.snapshot(HandoffsDoc, context);
    const supervisionBefore = await app.harness.snapshot(AgentSupervisionDoc, context);
    const contactsBefore = await app.harness.snapshot(AgentContactsDoc, context);

    plan.push(
        { name: "sessions", args: { limit: 100 } },
        { name: "sessions", args: { archived: true, limit: 100 } },
    );

    for (const id of targets) {
        plan.push({ name: "session_read", args: { session: Number(id) } });
    }

    plan.push({ name: "agent_work", args: { action: "read", session: Number(sibling) } });
    await say(app, source, "Inspect my current and older histories through native reads only.");
    const results = (await app.transcripts.allEntries(source, true)).filter(
        (entry) => entry.kind === "toolResult",
    );

    assert.equal(results.length, 9);

    for (const result of results) {
        assert.equal(result.isError, false, result.text);
    }

    for (const [index, id] of targets.entries()) {
        assert.match(
            results[[older, global, worker].includes(id) ? 1 : 0]!.text,
            new RegExp(`#${id}\\b`),
            `discover exact history ${id}`,
        );
        assert.match(results[index + 2]!.text, new RegExp(`HISTORY_CANARY_${index}`));
    }

    assert.match(results.at(-1)!.text, /HISTORY_CANARY_1/);
    assert.match(results[5]!.text, /HISTORY_CONTROLLER_QUESTION/);
    assert.equal(requests, 10, "only the accepted source invocation buys model responses");
    assert.deepEqual(
        await Promise.all(targets.map((id) => app.transcripts.allEntries(id, true))),
        before,
    );
    assert.deepEqual(await app.harness.snapshot(HandoffsDoc, context), controlBefore);
    const supervisionAfter = await app.harness.snapshot(AgentSupervisionDoc, context);

    assert.deepEqual(supervisionAfter?.agents, supervisionBefore?.agents);
    assert.deepEqual(supervisionAfter?.requests, supervisionBefore?.requests);
    assert.deepEqual(await app.harness.snapshot(AgentContactsDoc, context), contactsBefore);
    assert.equal(
        app.workItems.itemFor(unassociated),
        undefined,
        "reading an ungrouped Worker creates no Work Item",
    );
});

test("owner-wide read admission does not expose deleted, hidden, other-owner or missing conversations and does not grant private control", async (t) => {
    const plan: { name: string; args: Record<string, string | number | boolean> }[] = [];
    const app = await openApp(
        scriptedModel(() => {
            const next = plan.shift();

            return next === undefined
                ? fauxAssistantMessage("Denied histories stayed private.")
                : fauxAssistantMessage(fauxToolCall(next.name, next.args), {
                      stopReason: "toolUse",
                  });
        }),
        join(root, "delegated-owner-history-denials"),
    );

    t.after(() => app.close());
    app.config.lastModel = { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
    const user = owner(app);
    const source = (await app.pip.agents.create(user, { name: "Reader", requestId: "reader" }))
        .id as ConversationId;
    const deleted = await app.pip.agents.create(user, { name: "Deleted", requestId: "deleted" });
    const peer = (await app.pip.agents.create(user, { name: "Visible peer", requestId: "visible" }))
        .id as ConversationId;
    const otherOwner = app.config.addUser("Another owner", "owner").user;
    const other = await app.pip.ensure(otherOwner);
    const hidden = (
        await app.commands.createSession(user, { cwd: app.defaultCwd, threadType: "chat" })
    ).id;

    for (const id of [deleted.id, other, hidden]) {
        await app.commands.note(
            id as ConversationId,
            id === other ? otherOwner : user,
            "DENIED_HISTORY_CANARY",
        );
    }

    await app.harness.commit(async (tx) => {
        (await tx.doc(AgentIdentitiesDoc)).items[deleted.agentId]!.deletedAt = Date.now();
        (await tx.doc(PipMentionsDoc)).lane = Number(hidden);
    }, context);
    plan.push({ name: "sessions", args: { limit: 100 } });

    for (const id of [deleted.id, other, hidden, 99999999]) {
        plan.push({ name: "session_read", args: { session: Number(id) } });
    }

    for (const action of ["send", "stop", "follow", "delegate"]) {
        plan.push({
            name: "agent_work",
            args: { action, session: Number(peer), text: "Not authorized by a read." },
        });
    }

    await say(app, source, "Exercise exact native history boundaries.");
    const results = (await app.transcripts.allEntries(source, true)).filter(
        (entry) => entry.kind === "toolResult",
    );

    assert.equal(results.length, 9);
    assert.equal(results[0]!.isError, false);

    for (const id of [deleted.id, other, hidden]) {
        assert.doesNotMatch(results[0]!.text, new RegExp(`#${id}\\b`));
    }

    for (const result of results.slice(1)) {
        assert.equal(result.isError, true, result.text);
        assert.doesNotMatch(result.text, /DENIED_HISTORY_CANARY/);
    }

    assert.equal(
        (await app.transcripts.allEntries(peer, true)).filter((entry) => entry.kind === "user")
            .length,
        0,
    );
    assert.equal(app.isBusy(peer), false);
});

test("native history revalidates source epoch/token and target visibility after awaited reads", async (t) => {
    for (const revoke of ["epoch", "token", "target-owner"] as const) {
        await t.test(revoke, async (t) => {
            let target!: ConversationId;
            let entered = false;
            let leaked = false;
            let release!: () => void;
            const held = new Promise<void>((resolve) => {
                release = resolve;
            });
            const app = await openApp(
                scriptedModel((request) => {
                    const results = request.messages.filter(
                        (message) => message.role === "toolResult",
                    );

                    leaked ||= JSON.stringify(results).includes("LATE_PRIVATE_HISTORY_CANARY");

                    return results.length === 0
                        ? fauxAssistantMessage(
                              fauxToolCall("session_read", { session: Number(target) }),
                              { stopReason: "toolUse" },
                          )
                        : fauxAssistantMessage("No stale private history received.");
                }),
                join(root, `delegated-history-race-${revoke}`),
            );

            t.after(async () => {
                release();
                await app.close();
            });
            app.config.lastModel = { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
            const user = owner(app);
            const made = await app.pip.agents.create(user, {
                name: "Race reader",
                requestId: "race-reader",
            });
            const source = made.id as ConversationId;

            target = (
                await app.pip.agents.create(user, { name: "Race target", requestId: "race-target" })
            ).id as ConversationId;
            await app.commands.note(target, user, "LATE_PRIVATE_HISTORY_CANARY");
            const list = app.schedules.list.bind(app.schedules);

            app.schedules.list = async (...args) => {
                const result = await list(...args);

                if (args[0] === target) {
                    entered = true;
                    await held;
                }

                return result;
            };

            const submitted = await app.commands.submit(source, user, {
                text: "Read the exact private history.",
                requestId: "read-race",
            });

            await until(
                () => entered,
                "the registered history read reaches an awaited native read",
            );

            if (revoke === "token") {
                app.config.rotateOwnerToken();
            } else {
                await app.harness.commit(async (tx) => {
                    if (revoke === "epoch") {
                        (await tx.doc(AgentIdentitiesDoc)).items[made.agentId]!.epoch++;
                    } else {
                        (await tx.doc(SessionsDoc)).items[String(target)]!.pip = "different-owner";
                    }
                }, context);
            }

            release();
            await (await app.harness.submission(submitted.submissionId, context))!.wait(context);
            assert.equal(leaked, false, "the provider never receives a stale history result");
            assert.doesNotMatch(
                JSON.stringify(await app.transcripts.allEntries(source, true)),
                /LATE_PRIVATE_HISTORY_CANARY/,
            );
            assert.equal(app.workItems.itemFor(target), undefined);
        });
    }
});
