// Real registered contacts cross native admission; only the external provider is scripted.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { awaitWithContext, withAbortSignal } from "@earendil-works/chord/context";
import { SubagentsDoc } from "../src/server/docs.ts";
import { AgentContactsDoc } from "../src/server/pip/agent-contacts-doc.ts";
import type { ConversationId } from "@earendil-works/pi-durable";
import {
    cleanUp,
    context,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";

after(cleanUp);

test("named input reaches the exact execution recipient, with nonhuman provenance and a native receipt", async (t) => {
    let target!: ConversationId;
    let privateCalls = 0;
    const received: string[] = [];
    const app = await openApp(
        scriptedModel((request) => {
            const system = JSON.stringify(
                request.messages.filter((message) => message.role === "system"),
            );

            if (system.includes("the owner's persistent private agent")) {
                return privateCalls++ === 0
                    ? fauxAssistantMessage(
                          [
                              fauxToolCall("agent_work", {
                                  action: "send",
                                  session: Number(target),
                                  text: "EXACT_EXECUTION_INPUT",
                              }),
                          ],
                          { stopReason: "toolUse" },
                      )
                    : fauxAssistantMessage("Sent the exact input.");
            }

            received.push(lastText(request).text);

            return fauxAssistantMessage("EXACT_EXECUTION_ANSWER");
        }),
        join(root, "exact-native-worker"),
    );

    t.after(() => app.close());
    target = await newSession(app, app.defaultCwd, "worker");
    const chat = (
        await app.pip.agents.create(owner(app), { name: "Contact Ada", requestId: "contact-agent" })
    ).id as ConversationId;

    await say(app, chat, "Send this exact Worker a bounded task.");
    const sourceReceipt = (await app.transcripts.allEntries(chat, true)).find(
        (entry) => entry.kind === "toolResult" && entry.name === "agent_work",
    );

    assert.ok(sourceReceipt?.kind === "toolResult");
    assert.equal(sourceReceipt.isError, false, sourceReceipt.text);
    assert.equal(JSON.parse(sourceReceipt.text).status, "accepted", sourceReceipt.text);
    await until(() => received.length > 0, "the exact recipient's actual provider runs");
    assert.equal(received.length, 1);
    assert.match(received[0]!, /EXACT_EXECUTION_INPUT/);
    assert.match(received[0]!, new RegExp(`named agent.*Contact Ada.*origin /s/${chat}`));
    await until(() => !app.isBusy(target), "native exact input settles");
    const source = await app.transcripts.allEntries(chat, true);
    const receipt = source.find(
        (entry) => entry.kind === "toolResult" && entry.name === "agent_work",
    );

    assert.ok(receipt?.kind === "toolResult");
    assert.equal(receipt.isError, false, receipt.text);
    const result = JSON.parse(receipt.text);

    assert.equal(result.session, Number(target));
    assert.equal(result.status, "accepted");
    const accepted = await (await app.harness.submission(result.submissionId, context))!.status(
        context,
    );

    assert.equal(accepted.conversationId, target);
    assert.match(
        accepted.requestId!,
        /^p:/,
        "service input is never owner-written handoff direction",
    );
    const controller = app.workItems.itemFor(target)!.supervisor!.conversationId;

    assert.notEqual(controller, Number(target));
    assert.equal(
        (await app.transcripts.allEntries(controller as ConversationId, true)).filter(
            (entry) => entry.kind === "user",
        ).length,
        0,
        "exact input was not rerouted through the orchestrator",
    );
});

test("ordinary Chat and its existing literal helper accept exact native input without creating execution membership", async (t) => {
    const delivered: string[] = [];
    let recipient!: ConversationId;
    const app = await openApp(
        scriptedModel((request) => {
            const last = lastText(request);
            const system = JSON.stringify(
                request.messages.filter((message) => message.role === "system"),
            );

            if (system.includes("the owner's persistent private agent")) {
                return last.role === "user"
                    ? fauxAssistantMessage(
                          [
                              fauxToolCall("session_send", {
                                  session: Number(recipient),
                                  message: "EXACT_CHAT_CONTACT",
                                  report: true,
                              }),
                          ],
                          { stopReason: "toolUse" },
                      )
                    : fauxAssistantMessage("Contact accepted.");
            }

            if (last.role === "user" && last.text.includes("SPAWN_EXISTING_HELPER")) {
                return fauxAssistantMessage(
                    [
                        fauxToolCall("subagent", {
                            action: "spawn",
                            name: "existing-contact",
                            message: "Initialize this helper once.",
                        }),
                    ],
                    { stopReason: "toolUse" },
                );
            }

            if (last.role === "user" && last.text.includes("EXACT_CHAT_CONTACT")) {
                delivered.push(last.text);

                return fauxAssistantMessage("EXACT_RECIPIENT_ACK");
            }

            return fauxAssistantMessage("Initialized.");
        }),
        join(root, "exact-native-chat-helper"),
    );

    t.after(() => app.close());
    const parent = await newSession(app, app.defaultCwd, "chat");
    const agent = (
        await app.pip.agents.create(owner(app), { name: "Chat contact", requestId: "chat-contact" })
    ).id as ConversationId;

    recipient = parent;
    await say(app, agent, "Contact the exact ordinary Chat.");
    await until(() => delivered.length === 1, "ordinary Chat receives authorized input");
    assert.equal(
        app.workItems.itemFor(parent),
        undefined,
        "contact never promotes Chat into an execution Work Item",
    );
    await until(() => !app.isBusy(parent), "ordinary Chat settles");
    await say(app, parent, "SPAWN_EXISTING_HELPER for this existing task.");
    await until(async () => {
        const state = await app.harness.snapshot(SubagentsDoc, parent, context);

        return (
            state?.agents["existing-contact"] !== undefined &&
            !app.isBusy(parent) &&
            state.sending === undefined &&
            (state.outbox?.length ?? 0) === 0
        );
    }, "real helper and original native courier settle");
    recipient = (await app.harness.snapshot(SubagentsDoc, parent, context))!.agents[
        "existing-contact"
    ]!.conversationId;
    const before = (await app.transcripts.allEntries(parent, true)).filter(
        (entry) => entry.kind === "user",
    ).length;

    await say(app, agent, "Contact that existing literal helper, not its parent.");
    await until(() => delivered.length === 2, "the literal helper receives the second exact input");
    const contacts = Object.values(
        (await app.harness.snapshot(AgentContactsDoc, context))!.contacts,
    );
    const childContact = contacts.find((item) => item.target === Number(recipient))!;
    const admitted = await app.harness.commit(
        (tx) => tx.submissionByRequest(recipient, childContact.nativeRequestId),
        context,
    );

    assert.ok(admitted);
    const native = await (await app.harness.submission(admitted.id, context))!.wait(context);

    assert.equal(native.conversationId, recipient);
    assert.equal(native.status, "done");
    assert.equal(
        (await app.transcripts.allEntries(parent, true)).filter((entry) => entry.kind === "user")
            .length,
        before,
        "literal contact did not become parent input or a synthetic helper",
    );
    assert.equal(
        Object.keys((await app.harness.snapshot(SubagentsDoc, parent, context))!.agents).length,
        1,
    );
    assert.equal(app.workItems.itemFor(parent), undefined);
});

test("queued private inputs cannot activate after source revoke, token rotation or loss of their native intent", async (t) => {
    for (const revoke of ["identity", "token", "control", "missing-intent"] as const) {
        await t.test(revoke, async (t) => {
            let target!: ConversationId;
            let entered = false;
            let privateActivations = 0;
            let release!: () => void;
            const held = new Promise<void>((resolve) => {
                release = resolve;
            });
            const app = await openApp(
                scriptedModel(async (request, options) => {
                    const system = JSON.stringify(
                        request.messages.filter((message) => message.role === "system"),
                    );
                    const last = lastText(request);

                    if (system.includes("the owner's persistent private agent")) {
                        return last.role === "user"
                            ? fauxAssistantMessage(
                                  [
                                      fauxToolCall("agent_work", {
                                          action: "send",
                                          session: Number(target),
                                          text: "FENCED_PRIVATE_INPUT",
                                      }),
                                  ],
                                  { stopReason: "toolUse" },
                              )
                            : fauxAssistantMessage("Queued with a stable native receipt.");
                    }

                    if (last.text.includes("HOLD_NATIVE_OWNER")) {
                        entered = true;
                        await awaitWithContext(
                            held,
                            options?.signal ? withAbortSignal(options.signal, context) : context,
                        );

                        return fauxAssistantMessage("Original owner's native work completed.");
                    }

                    privateActivations++;

                    return fauxAssistantMessage("Fresh private input answered.");
                }),
                join(root, `exact-native-queued-${revoke}`),
            );

            t.after(async () => {
                release();
                await app.close();
            });
            target = await newSession(app, app.defaultCwd, "worker");
            const agent = (
                await app.pip.agents.create(owner(app), {
                    name: "Fence contact",
                    requestId: "fence-agent",
                })
            ).id as ConversationId;

            await app.commands.submit(target, owner(app), {
                text: "HOLD_NATIVE_OWNER",
                requestId: "original-owner",
            });
            await until(() => entered, "the existing native owner run enters its provider");
            await say(app, agent, "Queue private work without interrupting the existing run.");
            const contacts = Object.values(
                (await app.harness.snapshot(AgentContactsDoc, context))!.contacts,
            );
            const contact = contacts[0]!;

            assert.equal(contact?.status, "accepted", JSON.stringify(contact));
            assert.ok(contact.submissionId, "the accepted contact retains its native receipt");
            const queued = (await app.harness.inspect(context)).submissions.find(
                (item) => Number(item.id) === contact.submissionId,
            )!;

            assert.equal(
                queued.status,
                "queued",
                "normal contact preserves native busy/follow-up semantics",
            );
            assert.equal(privateActivations, 0);

            if (revoke === "identity") {
                await app.pip.agents.supervision.stop(contact.agentId, owner(app));
            } else if (revoke === "token") {
                app.config.rotateOwnerToken();
            } else if (revoke === "control") {
                await app.commands.abort(
                    app.workItems.itemFor(target)!.supervisor!.conversationId as ConversationId,
                    owner(app),
                );
                assert.equal(
                    app.isBusy(target),
                    true,
                    "controller reclaim does not kill unrelated native execution",
                );
            } else {
                await app.harness.commit(async (tx) => {
                    delete (await tx.doc(AgentContactsDoc)).contacts[
                        Object.keys((await tx.doc(AgentContactsDoc)).contacts)[0]!
                    ];
                }, context);
            }

            release();
            const settled = await (await app.harness.submission(queued.id, context))!.wait(context);

            assert.equal(settled.status, "unanswered");
            assert.equal(
                privateActivations,
                0,
                "stale native acceptance never becomes a provider call",
            );
            await until(
                () => !app.isBusy(target),
                "the old native run and rejected activation settle",
            );
            await say(app, agent, "Fresh explicit input authorizes a new exact contact.");
            await until(
                () => privateActivations === 1,
                "a fresh valid decision still activates its exact target",
            );
        });
    }
});

test("an existing named helper accepts exact service input and fresh authenticated human correction without a paid courier", async (t) => {
    let helper!: ConversationId;
    let sent = false;
    let freshHuman = false;
    const unexpectedCouriers: string[] = [];
    const app = await openApp(
        scriptedModel((request) => {
            const last = lastText(request);

            if (last.role !== "user") {
                return fauxAssistantMessage("The bounded tool step completed.");
            }

            if (last.text.includes("INIT_PRIVATE_HELPER")) {
                return fauxAssistantMessage("Private helper initialized.");
            }

            if (last.text.includes("CONTACT_PRIVATE_HELPER")) {
                sent = true;

                return fauxAssistantMessage(
                    "Exact private helper acknowledged its real named source.",
                );
            }

            if (last.text.includes("HUMAN_HELPER_CORRECTION")) {
                freshHuman = true;

                return fauxAssistantMessage("The exact helper accepted fresh owner correction.");
            }

            if (last.text.includes("SPAWN_PRIVATE_HELPER")) {
                return fauxAssistantMessage(
                    [
                        fauxToolCall("subagent", {
                            action: "spawn",
                            name: "bounded-private-child",
                            message: "INIT_PRIVATE_HELPER: complete this bounded initialization.",
                        }),
                    ],
                    { stopReason: "toolUse" },
                );
            }

            if (last.text.includes("SEND_TO_PRIVATE_HELPER")) {
                return fauxAssistantMessage(
                    [
                        fauxToolCall("agent_work", {
                            action: "send",
                            session: Number(helper),
                            text: "CONTACT_PRIVATE_HELPER from this persistent identity.",
                        }),
                    ],
                    { stopReason: "toolUse" },
                );
            }

            if (last.text.startsWith("[reports from subagents]")) {
                unexpectedCouriers.push(last.text);
            }

            return fauxAssistantMessage("Passive information needs no additional paid work.");
        }),
        join(root, "exact-named-helper-input"),
    );

    t.after(() => app.close());
    const chat = (
        await app.pip.agents.create(owner(app), {
            name: "Private helper contact",
            requestId: "private-helper-contact",
        })
    ).id as ConversationId;

    await app.commands.configure(chat, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });
    await say(app, chat, "SPAWN_PRIVATE_HELPER for a bounded initialization task.");
    await until(async () => {
        const state = await app.harness.snapshot(SubagentsDoc, chat, context);
        const record = state?.agents["bounded-private-child"];

        return (
            record?.answeredAt !== undefined &&
            !app.isBusy(chat) &&
            state?.sending === undefined &&
            (state?.outbox?.length ?? 0) === 0
        );
    }, "private helper finishes and returns passively");
    helper = (await app.harness.snapshot(SubagentsDoc, chat, context))!.agents[
        "bounded-private-child"
    ]!.conversationId;
    const origin = (
        await app.pip.agents.newChat(chat, owner(app), { requestId: "helper-contact-origin" })
    ).id as ConversationId;

    await say(app, origin, "SEND_TO_PRIVATE_HELPER without rerouting its literal address.");
    await until(() => sent && !app.isBusy(helper), "exact named helper service input settles");
    await until(
        async () =>
            (await app.transcripts.allEntries(origin, true)).some(
                (entry) =>
                    entry.kind === "assistant" &&
                    JSON.stringify(entry).includes("Exact private helper acknowledged"),
            ),
        "helper answer returns to its accepted second-chat origin",
    );
    const contact = Object.values(
        (await app.harness.snapshot(AgentContactsDoc, context))!.contacts,
    ).find((item) => item.target === Number(helper))!;

    assert.equal(
        contact.chatId,
        origin,
        "no helper-parent or latest-chat fallback replaced the accepted origin",
    );
    await say(
        app,
        helper,
        "HUMAN_HELPER_CORRECTION: this is fresh authenticated owner input, not a reporter.",
    );
    assert.equal(freshHuman, true);
    assert.deepEqual(
        unexpectedCouriers,
        [],
        "no old helper reporter created an activating parent input",
    );
    assert.equal(
        (await app.transcripts.allEntries(chat, true)).filter((entry) => entry.kind === "user")
            .length,
        1,
        "contacting from a second chat did not wake or report through the original parent",
    );
    const entries = await app.transcripts.allEntries(helper, true);

    assert.ok(
        entries.some(
            (entry) => entry.kind === "user" && entry.text.includes(`origin /s/${origin}`),
        ),
        "service provenance retains the exact source chat",
    );
    assert.ok(
        entries.some(
            (entry) =>
                entry.kind === "user" &&
                entry.text.includes("HUMAN_HELPER_CORRECTION") &&
                !entry.text.includes("via named agent"),
        ),
        "fresh human input is not relabeled as service authority",
    );
});
