// Native intent/admission on an isolated app. Only the external model is scripted.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { awaitWithContext, withAbortSignal } from "@earendil-works/chord/context";
import { join } from "node:path";
import type { ConversationId } from "@earendil-works/pi-durable";
import { SessionsDoc, SubagentsDoc } from "../src/server/docs.ts";
import { AgentIdentitiesDoc } from "../src/server/agent-identity-docs.ts";
import { privateAgentRequest } from "./private-agent-http.ts";
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

test("attaching private supervision reuses the native controller without activating it", async (t) => {
    let calls = 0;
    const app = await openApp(
        scriptedModel(() => {
            calls++;

            return fauxAssistantMessage("No navigation should dispatch this response.");
        }),
    );

    t.after(() => app.close());
    const source = await newSession(app, app.defaultCwd, "worker");
    const record = await app.pip.agents.create(owner(app), {
        name: "Coordinator",
        instructions: "Coordinate only when asked.",
        requestId: "create-coordinator",
    });
    const privateAgent = { ...record, id: record.id as ConversationId };
    const opened = await app.pip.orchestration.control(source, owner(app), { action: "open" });
    const before = structuredClone(app.workItems.itemFor(source)!.supervisor!);
    const attached = await app.pip.agents.supervision.control(privateAgent.id, owner(app), {
        action: "attach",
        session: Number(source),
        requestId: "attach-existing",
    });

    assert.equal(attached.attachments[0]!.controllerId, opened.orchestration!.conversationId);
    assert.equal(app.workItems.itemFor(source)!.supervisor!.status, "reclaimed");
    assert.equal(app.workItems.itemFor(source)!.supervisor!.epoch, before.epoch);
    assert.equal(calls, 0, "attach never dispatches a paid generation");
    assert.deepEqual(
        await app.pip.agents.supervision.control(privateAgent.id, owner(app), {
            action: "attach",
            session: Number(source),
            requestId: "attach-existing",
        }),
        attached,
        "same accepted owner intent is retry-safe",
    );
    await assert.rejects(
        app.pip.agents.supervision.control(privateAgent.id, owner(app), {
            action: "attach",
            session: Number(source) + 1000,
            requestId: "attach-existing",
        }),
        /different input/,
    );
});

test("task-directed native contact auto-associates the controller and reports to its originating chat across restart", async (t) => {
    let controller!: ConversationId;
    let agentCalls = 0;
    let controllerCalls = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    const model = scriptedModel(async (request, options) => {
        const system = JSON.stringify(
            request.messages.filter((message) => message.role === "system"),
        );
        const last = lastText(request);

        if (system.includes("the owner's persistent private agent")) {
            agentCalls++;

            if (last.role === "user") {
                const passive = last.text.includes("PASSIVE_FOLLOW");

                return fauxAssistantMessage(
                    [
                        fauxToolCall("agent_work", {
                            action: passive ? "follow" : "send",
                            session: Number(controller),
                            ...(passive
                                ? { report: false }
                                : {
                                      text: "Observe the existing investigation; do not resend it.",
                                  }),
                        }),
                    ],
                    { stopReason: "toolUse" },
                );
            }

            assert.match(last.text, /"status":"accepted"/);

            return fauxAssistantMessage(
                "Native controller contact accepted; no execution task was resent.",
            );
        }

        if (system.includes("the private supervisor for Work Item")) {
            controllerCalls++;
            assert.match(last.text, /^\[App message from private supervisor/);
            assert.doesNotMatch(
                last.text,
                /\[from:/,
                "native intent must not fabricate owner-written input",
            );

            return fauxAssistantMessage(
                "NATIVE_CONTROLLER_OBSERVATION: the original execution is still running.",
            );
        }

        await awaitWithContext(
            held,
            options?.signal ? withAbortSignal(options.signal, context) : context,
        );

        return fauxAssistantMessage("Original execution finished independently.");
    });
    const directory = join(root, "private-supervision-native");
    let app = await openApp(model, directory);

    t.after(async () => {
        release();
        await app.close();
    });
    const source = await newSession(app, app.defaultCwd, "worker");

    await app.commands.submit(source, owner(app), {
        text: "Investigate only; no implementation or publication.",
        requestId: "original-execution",
    });
    await until(() => app.isBusy(source), "original execution starts");
    const created = await app.pip.agents.create(owner(app), {
        name: "Coordinator",
        requestId: "coordinator",
    });
    const inbox = created.id as ConversationId;
    const second = await app.pip.agents.newChat(inbox, owner(app), { requestId: "second-chat" });
    const chat = second.id as ConversationId;

    assert.equal(app.workItems.itemFor(source)?.supervisor, undefined);
    const opened = await app.pip.orchestration.control(source, owner(app), { action: "open" });

    controller = opened.orchestration!.conversationId as ConversationId;

    const navigation = async (token?: string) => {
        const response = await privateAgentRequest(app, "sessions", undefined, token);

        assert.equal(response.status, 200);

        return (await response.json()).find((row: { id: number }) => row.id === Number(source))
            ?.supervisor;
    };

    assert.equal((await navigation()).parentChatId, undefined, "opening has no accepted parent");
    assert.equal(app.workItems.itemFor(source)!.supervisor!.status, "reclaimed");
    assert.equal(controllerCalls, 0, "opening the exact controller does not activate it");
    assert.deepEqual(
        (await app.pip.agents.supervision.status(chat, owner(app))).attachments,
        [],
        "controller discovery needs no manual association",
    );

    await app.commands.submit(chat, owner(app), {
        text: "Observe this existing investigation within its human scope.",
        requestId: "coordinate",
    });
    await until(() => controllerCalls === 1, "contact activates the exact native controller");
    assert.equal(app.workItems.itemFor(source)!.supervisor!.conversationId, Number(controller));

    await until(
        async () => !app.isBusy(chat) && controllerCalls === 1 && !app.isBusy(controller),
        "native contact and controller settle",
    );
    await until(
        async () =>
            (await app.transcripts.allEntries(chat, true)).some(
                (entry) =>
                    entry.kind === "appEvent" &&
                    entry.event === "report" &&
                    entry.text.includes("NATIVE_CONTROLLER_OBSERVATION"),
            ),
        "passive controller report reaches the originating task chat",
    );
    assert.equal(
        (await app.transcripts.allEntries(inbox, true)).some(
            (entry) => entry.kind === "appEvent" && entry.event === "report",
        ),
        false,
        "the first chat is not a special report destination",
    );
    assert.equal(
        (await app.transcripts.allEntries(source, true)).filter((entry) => entry.kind === "user")
            .length,
        1,
        "delegation does not resend execution work",
    );
    const current = await navigation();

    assert.equal(current.parentChatId, Number(chat));
    assert.equal(current.agentId, created.agentId);
    const grant = structuredClone(app.workItems.itemFor(source)!.supervisor!);
    const readsBefore = { agentCalls, controllerCalls };
    const guest = app.config.addUser("Shared work reader", "guest");
    const otherOwner = app.config.addUser("Other owner", "owner");

    for (const person of [guest, otherOwner]) {
        assert.equal(await navigation(person.token), undefined, "parentage remains owner-private");
    }

    await navigation();
    assert.deepEqual(app.workItems.itemFor(source)!.supervisor, grant);
    assert.deepEqual(
        { agentCalls, controllerCalls },
        readsBefore,
        "navigation never activates work",
    );

    for (const flag of ["pipEnabled", "workItemsEnabled"] as const) {
        app.config[flag] = false;

        try {
            assert.equal((await navigation()).parentChatId, undefined, `${flag}: no live parent`);
        } finally {
            app.config[flag] = true;
        }
    }

    await say(app, inbox, "PASSIVE_FOLLOW: inspect without acquiring management.");
    assert.equal(controllerCalls, 1, "passive contact does not activate the controller");
    assert.equal(
        (await navigation()).parentChatId,
        Number(chat),
        "passive contact cannot retarget parentage",
    );

    for (const archived of [true, false]) {
        const response = await privateAgentRequest(app, `sessions/${chat}`, { archived });

        assert.equal(response.status, 200);
        assert.equal(
            (await navigation()).parentChatId,
            undefined,
            "closing and restoring the exact source cannot renew its accepted parent authority",
        );
        assert.equal(app.workItems.itemFor(source)!.supervisor!.status, "running");
    }

    const delivered = (await app.pip.agents.supervision.status(chat, owner(app))).reports!;

    assert.equal(delivered.length, 1);
    assert.equal(delivered[0]!.originChatId, Number(chat));
    assert.equal(delivered[0]!.status, "delivered");
    const calls = agentCalls;
    const reports = (await app.transcripts.allEntries(chat, true)).length;
    const epoch = app.pip.agents.identity(chat)!.epoch;

    await app.commands.abort(chat, owner(app));
    assert.equal(
        (await navigation()).parentChatId,
        undefined,
        "reclaimed work has no current parent",
    );
    assert.equal((await navigation()).agentId, undefined);
    assert.equal(app.isBusy(source), true, "agent Stop leaves execution alive");
    assert.ok(
        app.pip.agents.identity(chat)!.epoch > epoch,
        "Stop fences the source identity epoch",
    );
    assert.equal(
        (await app.pip.agents.supervision.controllers(chat, owner(app)))[0]!.state,
        "human control",
    );
    release();
    await until(() => !app.isBusy(source), "execution finishes without supervisor control");
    await app.close();
    app = await openApp(model, directory);
    assert.equal(
        (await navigation()).parentChatId,
        undefined,
        "recovery cannot renew a stopped parent",
    );
    assert.equal(agentCalls, calls, "recovery and reports do not activate paid agent runs");
    assert.equal(controllerCalls, 1, "stopped controller does not restart from a work outcome");
    assert.equal(
        (await app.transcripts.allEntries(chat, true)).length,
        reports,
        "report receipt survives restart without duplicates",
    );
});

test("native questions hold controller contact and exact execution input until the correlated human answer", async (t) => {
    let source!: ConversationId;
    let controller!: ConversationId;
    let controllerCalls = 0;
    let expected = "accepted";
    let target: "controller" | "execution" = "controller";
    let executionCalls = 0;
    const model = scriptedModel((request) => {
        const system = JSON.stringify(
            request.messages.filter((message) => message.role === "system"),
        );
        const last = lastText(request);

        if (system.includes("the owner's persistent private agent")) {
            if (last.role === "user") {
                return fauxAssistantMessage(
                    [
                        fauxToolCall("agent_work", {
                            action: "send",
                            session: Number(target === "controller" ? controller : source),
                            text: "Clarify the investigation scope; ask the human before proceeding.",
                        }),
                    ],
                    { stopReason: "toolUse" },
                );
            }

            if (target === "execution") {
                assert.match(last.text, /Native question|human decision/);
            } else {
                assert.match(last.text, new RegExp(`"status":"${expected}"`));

                if (expected === "blocked") {
                    assert.match(last.text, /pending exact question|human decision/);
                }
            }

            return fauxAssistantMessage("Native question gate respected.");
        }

        if (system.includes("the private supervisor for Work Item")) {
            controllerCalls++;

            if (last.role === "toolResult") {
                return fauxAssistantMessage("Waiting for the exact human decision.");
            }

            if (last.text.includes("App message")) {
                return fauxAssistantMessage(
                    [
                        fauxToolCall("work_supervise", {
                            action: "ask",
                            text: "Investigate latency or clarity?",
                        }),
                    ],
                    { stopReason: "toolUse" },
                );
            }

            assert.match(last.text, /Clarity only; do not implement/);

            return fauxAssistantMessage(
                "Human-directed clarity investigation; parent attachment revoked.",
            );
        }

        executionCalls++;

        return fauxAssistantMessage("Original investigation evidence.");
    });
    const app = await openApp(model, join(root, "private-supervision-question"));

    t.after(() => app.close());
    source = await newSession(app, app.defaultCwd, "worker");
    const created = await app.pip.agents.create(owner(app), {
        name: "Question coordinator",
        requestId: "coordinator",
    });
    const chat = created.id as ConversationId;

    await app.pip.agents.supervision.control(chat, owner(app), {
        action: "attach",
        session: Number(source),
        requestId: "attach",
    });
    controller = app.workItems.itemFor(source)!.supervisor!.conversationId as ConversationId;
    await app.commands.submit(chat, owner(app), {
        text: "Ask about this investigation scope.",
        requestId: "ask",
    });
    await until(
        async () =>
            !app.isBusy(chat) &&
            (await app.pip.agents.supervision.controllers(chat, owner(app)))[0]?.state ===
                "needs owner",
        "native correlated question appears",
    );
    const inspected = await app.pip.orchestration.inspect(source, owner(app));
    const question = inspected.orchestration!.question!;

    await until(
        async () =>
            (await app.transcripts.allEntries(chat, true)).some(
                (entry) =>
                    entry.kind === "appEvent" &&
                    entry.event === "report" &&
                    entry.state === "question" &&
                    entry.questionId === question.id &&
                    entry.source === Number(controller) &&
                    entry.text.includes(question.text),
            ),
        "the native report retains its exact question and expanded-display state",
    );
    const actions = app.workItems.itemFor(source)!.supervisor!.actions;
    const calls = controllerCalls;

    expected = "blocked";
    await app.commands.submit(chat, owner(app), {
        text: "Recheck without inventing an answer.",
        requestId: "held-at-question",
    });
    await until(() => !app.isBusy(chat), "parent sees native question hold");
    assert.equal(
        controllerCalls,
        calls,
        "question hold buys no extra native controller generation",
    );
    assert.equal(
        app.workItems.itemFor(source)!.supervisor!.actions,
        actions,
        "blocked admission does not consume or replenish actions",
    );
    target = "execution";
    const executions = executionCalls;

    await say(app, chat, "Attempt exact execution input without fabricating a question answer.");
    assert.equal(
        executionCalls,
        executions,
        "the question also blocks provider dispatch to the exact execution thread",
    );
    assert.equal(
        app.workItems.itemFor(source)!.supervisor!.actions,
        actions,
        "exact refusal never consumes or renews the native cap",
    );
    await app.commands.submit(controller, owner(app), {
        text: "Clarity only; do not implement.",
        requestId: "human-answer",
        pipQuestionId: question.id,
    });
    await until(() => !app.isBusy(controller), "direct human answer settles");
    assert.equal(
        app.workItems.itemFor(source)!.supervisor!.agentId,
        undefined,
        "exact direct human input revokes private parent control",
    );
    assert.equal(
        (await app.pip.agents.supervision.status(chat, owner(app))).attachments[0]!.active,
        false,
    );
});

test("an in-flight old-owner generation cannot contact a controller after token rotation or recover into a fresh dispatch", async (t) => {
    let controller!: ConversationId;
    let agentCalls = 0;
    let controllerCalls = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    const model = scriptedModel(async (request, options) => {
        const system = JSON.stringify(
            request.messages.filter((message) => message.role === "system"),
        );

        if (system.includes("the owner's persistent private agent")) {
            agentCalls++;
            await awaitWithContext(
                held,
                options?.signal ? withAbortSignal(options.signal, context) : context,
            );

            return fauxAssistantMessage(
                [
                    fauxToolCall("agent_work", {
                        action: "send",
                        session: Number(controller),
                        text: "A stale decision must not be admitted.",
                    }),
                ],
                { stopReason: "toolUse" },
            );
        }

        if (system.includes("the private supervisor for Work Item")) {
            controllerCalls++;
        }

        return fauxAssistantMessage("No stale dispatch expected.");
    });
    const directory = join(root, "private-supervision-revoked-token");
    let app = await openApp(model, directory);

    t.after(async () => {
        release();
        await app.close();
    });
    const source = await newSession(app, app.defaultCwd, "worker");
    const created = await app.pip.agents.create(owner(app), {
        name: "Revocation coordinator",
        requestId: "coordinator",
    });
    const chat = created.id as ConversationId;

    await app.pip.agents.supervision.control(chat, owner(app), {
        action: "attach",
        session: Number(source),
        requestId: "attach",
    });
    controller = app.workItems.itemFor(source)!.supervisor!.conversationId as ConversationId;
    const admitted = await app.commands.submit(chat, owner(app), {
        text: "Observe this investigation.",
        requestId: "old-owner",
    });

    await until(() => agentCalls === 1, "old owner generation enters external provider");
    app.config.rotateOwnerToken();
    release();
    await until(() => !app.isBusy(chat), "old source is fenced after tool completion");
    const native = await app.harness.submission(admitted.submissionId, context);

    assert.equal(
        (await native!.status(context)).status,
        "unanswered",
        "source native authority aborts the revoked run rather than merely returning a downstream controller rejection",
    );
    assert.equal(
        agentCalls,
        1,
        "a diagnostic-only hook failure must not buy another provider call",
    );
    assert.equal(controllerCalls, 0, "old-owner tool did not activate the native controller");
    assert.equal(
        (await app.pip.agents.supervision.controllers(chat, owner(app)))[0]!.state,
        "held",
    );
    await app.close();
    app = await openApp(model, directory);
    assert.equal(agentCalls, 1);
    assert.equal(controllerCalls, 0);
});

test("persisted unbound and retired named chats abort legacy native input before any provider dispatch", async (t) => {
    for (const fixture of ["unbound", "retired"] as const) {
        await t.test(fixture, async () => {
            let providerCalls = 0;
            const app = await openApp(
                scriptedModel(() => {
                    providerCalls++;

                    return fauxAssistantMessage(
                        "A legacy private identity must never reach this provider.",
                    );
                }),
                join(root, `private-supervision-legacy-${fixture}`),
            );

            t.after(() => app.close());
            await newSession(app, app.defaultCwd, "worker");
            const created = await app.pip.agents.create(owner(app), {
                name: "Legacy fixture",
                requestId: "fixture",
            });
            const chat = created.id as ConversationId;

            assert.equal(
                (await app.agentState(chat))!.model!.provider,
                "faux",
                "a real selected provider exists; missing-model denial must not make this negative control pass",
            );
            await app.harness.commit(async (tx) => {
                // Persisted storage-boundary fixtures simulate old installations/recovered work,
                // not an internal collaborator or a fabricated authority/admission receipt.
                if (fixture === "unbound") {
                    delete (await tx.doc(SessionsDoc)).items[String(chat)]!.pipAgentId;
                } else {
                    (await tx.doc(AgentIdentitiesDoc)).items[created.agentId]!.deletedAt =
                        Date.now();
                }
            }, context);
            const conversation = await app.conversation(chat);
            const submission = await conversation.submit(
                {
                    type: "input",
                    content: "A persisted legacy pending private input resumes.",
                    requestId: `legacy-${fixture}`,
                },
                context,
            );
            const result = await submission.wait(context);

            assert.equal(
                providerCalls,
                0,
                "hook diagnostics alone are fail-open; the actual native generation must be aborted",
            );
            assert.equal(result.status, "unanswered");
            assert.equal(app.isBusy(chat), false);
        });
    }
});

test("delayed native replies retain their accepted source chat/request after a different chat contacts the same controller", async (t) => {
    let controller!: ConversationId;
    let controllerCalls = 0;
    const messages: string[] = [];
    const model = scriptedModel((request) => {
        const system = JSON.stringify(
            request.messages.filter((message) => message.role === "system"),
        );
        const last = lastText(request);

        if (system.includes("the owner's persistent private agent") && last.role === "user") {
            return fauxAssistantMessage(
                [
                    fauxToolCall("agent_work", {
                        action: "send",
                        session: Number(controller),
                        text: last.text.includes("TASK_A") ? "TASK_A" : "TASK_B",
                    }),
                ],
                { stopReason: "toolUse" },
            );
        }

        if (system.includes("the private supervisor for Work Item")) {
            controllerCalls++;
            messages.push(last.text);

            return fauxAssistantMessage(
                last.text.includes("TASK_A") ? "RESULT_A_ONLY" : "RESULT_B_ONLY",
            );
        }

        return fauxAssistantMessage("Accepted native contact.");
    });
    const app = await openApp(model, join(root, "private-supervision-two-origins"));

    t.after(() => app.close());
    const source = await newSession(app, app.defaultCwd, "worker");
    const opened = await app.pip.orchestration.control(source, owner(app), { action: "open" });

    controller = opened.orchestration!.conversationId as ConversationId;
    const created = await app.pip.agents.create(owner(app), {
        name: "Origin coordinator",
        requestId: "identity",
    });
    const a = created.id as ConversationId;
    const b = (await app.pip.agents.newChat(a, owner(app), { requestId: "chat-b" }))
        .id as ConversationId;
    const untouched = (await app.pip.agents.newChat(a, owner(app), { requestId: "chat-c" }))
        .id as ConversationId;

    // Suspend observation through the real lifecycle seam, then recover both native response
    // receipts after the second contact. No fabricated receipt or collaborator replacement.
    await app.pip.agents.supervision.close();
    await app.commands.submit(a, owner(app), {
        text: "TASK_A: inspect only.",
        requestId: "task-a",
    });
    await until(() => controllerCalls === 1 && !app.isBusy(a), "first native contact settles");
    await until(() => !app.isBusy(controller), "first controller input finishes");
    await app.commands.submit(b, owner(app), {
        text: "TASK_B: inspect only.",
        requestId: "task-b",
    });
    await until(
        () => controllerCalls === 2 && !app.isBusy(b) && !app.isBusy(controller),
        "second native contact settles",
    );
    assert.equal(
        app.workItems.itemFor(source)!.supervisor!.conversationId,
        Number(controller),
        "both contacts reuse the exact native controller",
    );
    assert.equal(app.pip.agents.supervision.manages(a), true);
    assert.equal(app.pip.agents.supervision.manages(b), true);
    assert.equal(
        app.sessions(owner(app)).find((row) => row.id === Number(source))!.supervisor?.parentChatId,
        undefined,
        "multiple current accepted sources cannot be collapsed to a guessed latest parent",
    );
    await app.pip.agents.supervision.open();
    const reports = async (chat: ConversationId) =>
        (await app.transcripts.allEntries(chat, true)).flatMap((entry) =>
            entry.kind === "appEvent" && entry.event === "report" ? [entry.text] : [],
        );

    await until(
        async () => (await reports(a)).length === 1 && (await reports(b)).length === 1,
        "both delayed reports return to their exact origins",
    );
    assert.match((await reports(a))[0]!, /RESULT_A_ONLY/);
    assert.doesNotMatch((await reports(a))[0]!, /RESULT_B_ONLY/);
    assert.match((await reports(b))[0]!, /RESULT_B_ONLY/);
    assert.doesNotMatch((await reports(b))[0]!, /RESULT_A_ONLY/);
    assert.equal((await reports(untouched)).length, 0, "an arbitrary other chat is not selected");
    assert.match(messages[0]!, new RegExp(`"Origin coordinator".*origin /s/${a}`));
    assert.match(messages[1]!, new RegExp(`"Origin coordinator".*origin /s/${b}`));
    const receipts = (await app.pip.agents.supervision.status(b, owner(app))).reports!;

    assert.equal(new Set(receipts.map((receipt) => receipt.originRequestId)).size, 2);
});

test("archived report origins survive completed coding without rerouting or paid activation, then restore once", async (t) => {
    const note = join(root, "completed-report-context.md");
    let contacted = false;
    let controller!: ConversationId;
    let release!: () => void;
    let controllerCalls = 0;
    let agentCalls = 0;
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    const model = scriptedModel(async (request, options) => {
        const system = JSON.stringify(
            request.messages.filter((message) => message.role === "system"),
        );
        const last = lastText(request);

        if (system.includes("the owner's persistent private agent")) {
            agentCalls++;

            if (last.role === "user") {
                return fauxAssistantMessage(
                    [fauxToolCall("write", { path: note, content: "Completed native context." })],
                    { stopReason: "toolUse" },
                );
            }

            if (!contacted) {
                contacted = true;

                return fauxAssistantMessage(
                    [
                        fauxToolCall("agent_work", {
                            action: "send",
                            session: Number(controller),
                            text: "Observe only; report this exact originating task.",
                        }),
                    ],
                    { stopReason: "toolUse" },
                );
            }

            return fauxAssistantMessage("Native contact accepted.");
        }

        if (system.includes("the private supervisor for Work Item")) {
            controllerCalls++;
            await awaitWithContext(
                held,
                options?.signal ? withAbortSignal(options.signal, context) : context,
            );

            return fauxAssistantMessage("ARCHIVED_ORIGIN_RESULT");
        }

        return fauxAssistantMessage("Native evidence.");
    });
    const directory = join(root, "private-supervision-origin-held");
    let app = await openApp(model, directory);

    t.after(async () => {
        release();
        await app.close();
    });
    const source = await newSession(app, app.defaultCwd, "worker");
    const opened = await app.pip.orchestration.control(source, owner(app), { action: "open" });

    controller = opened.orchestration!.conversationId as ConversationId;
    const first = (
        await app.pip.agents.create(owner(app), { name: "Held origin", requestId: "identity" })
    ).id as ConversationId;
    const origin = (await app.pip.agents.newChat(first, owner(app), { requestId: "origin" }))
        .id as ConversationId;

    await app.commands.submit(origin, owner(app), {
        text: "Observe this existing investigation.",
        requestId: "contact",
    });
    await until(
        () => controllerCalls === 1 && !app.isBusy(origin),
        "source contact finishes while native response is underway",
    );
    // Native persisted fixture: named-chat archive has no public management action yet.
    await app.harness.commit(async (tx) => {
        (await tx.doc(SessionsDoc)).items[String(origin)]!.archived = true;
    }, context);
    release();
    await until(
        async () =>
            (await app.pip.agents.supervision.status(first, owner(app))).reports?.some(
                (report) => report.status === "held" && report.originChatId === Number(origin),
            ) === true,
        "archived origin holds its durable report",
    );
    const before = agentCalls;
    const reportText = async (chat: ConversationId) =>
        (await app.transcripts.allEntries(chat, true)).flatMap((entry) =>
            entry.kind === "appEvent" && entry.event === "report" ? [entry.text] : [],
        );

    assert.equal((await reportText(first)).length, 0);
    assert.equal((await reportText(origin)).length, 0);
    const notices = async () =>
        (await app.transcripts.allEntries(controller, true)).flatMap((entry) =>
            entry.kind === "appEvent" && entry.event === "report" && entry.state === "held"
                ? [entry.text]
                : [],
        );

    await until(
        async () => (await notices()).length === 1,
        "owner has a durable notice at the exact native controller",
    );
    assert.equal(
        (await app.pip.agents.supervision.controllers(origin, owner(app)))[0]!.state,
        "needs owner",
    );
    const completedEpoch = app.pip.agents.identity(origin)!.epoch;

    assert.equal(await readFile(note, "utf8"), "Completed native context.");
    await app.close();
    app = await openApp(model, directory);
    assert.equal(
        app.pip.agents.identity(origin)!.epoch,
        completedEpoch,
        "completed coding does not revoke passive report authority on restart",
    );
    assert.equal(
        (await reportText(first)).length,
        0,
        "restart retains the origin tombstone instead of picking another chat",
    );
    assert.equal(agentCalls, before);
    assert.equal(controllerCalls, 1);
    await app.harness.commit(async (tx) => {
        (await tx.doc(SessionsDoc)).items[String(origin)]!.archived = false;
    }, context);
    await until(
        async () => (await reportText(origin)).length === 1,
        "restored exact origin receives its existing pending report",
    );
    assert.match((await reportText(origin))[0]!, /ARCHIVED_ORIGIN_RESULT/);
    assert.equal((await reportText(first)).length, 0);
    assert.equal(agentCalls, before, "passive report delivery never activates the source agent");
    assert.equal(
        (await notices()).length,
        1,
        "native controller owner notice is deduplicated across restart and delivery",
    );
});

test("a native helper inherits its spawning authority and cannot execute an unrelated registered tool after source Stop", async (t) => {
    let helperCalls = 0;
    let sourceCalls = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    const model = scriptedModel(async (request, options) => {
        const last = lastText(request);

        if (last.role === "user" && last.text.includes("CHILD_AUTHORITY_PROBE")) {
            helperCalls++;
            await awaitWithContext(
                held,
                options?.signal ? withAbortSignal(options.signal, context) : context,
            );

            return fauxAssistantMessage(
                [fauxToolCall("codemode", { code: 'text("FENCE_SENTINEL_WORK")' })],
                { stopReason: "toolUse" },
            );
        }

        const system = JSON.stringify(
            request.messages.filter((message) => message.role === "system"),
        );

        if (!system.includes("the owner's persistent private agent")) {
            return fauxAssistantMessage("Native observation.");
        }

        sourceCalls++;

        if (last.role === "user") {
            return fauxAssistantMessage(
                [
                    fauxToolCall("subagent", {
                        action: "spawn",
                        name: "authority-probe",
                        message: "CHILD_AUTHORITY_PROBE: inspect accessible native work.",
                    }),
                ],
                { stopReason: "toolUse" },
            );
        }

        return fauxAssistantMessage("Native helper started.");
    });
    const app = await openApp(model, join(root, "private-supervision-helper-fence"));

    t.after(async () => {
        release();
        await app.close();
    });
    await newSession(app, app.defaultCwd, "worker");
    const chat = (
        await app.pip.agents.create(owner(app), { name: "Helper owner", requestId: "identity" })
    ).id as ConversationId;

    await app.commands.submit(chat, owner(app), {
        text: "Use one native background helper to inspect accessible work.",
        requestId: "spawn",
    });
    await until(
        () => helperCalls === 1 && !app.isBusy(chat),
        "real helper dispatch inherits the source tool's durable authority",
    );
    const child = (await app.harness.snapshot(SubagentsDoc, chat, context))!.agents[
        "authority-probe"
    ]!.conversationId;

    await app.pip.agents.supervision.stop(app.pip.agents.scope(chat)!.agentId, owner(app));
    release();
    await until(() => !app.isBusy(child), "revoked helper tool is aborted natively");
    const entries = await app.transcripts.allEntries(child, true);

    assert.equal(
        entries.some(
            (entry) =>
                entry.kind === "toolResult" &&
                entry.name === "codemode" &&
                !entry.isError &&
                entry.text.includes("FENCE_SENTINEL_WORK"),
        ),
        false,
        "all-tool authority, not just write/delegation wrappers, prevents stale helper execution",
    );
    assert.equal(helperCalls, 1, "no successor provider call can recapture current authority");
    assert.equal(sourceCalls, 2, "helper observations do not pay to reactivate the stopped source");
});

test("registered discovery, work_context and session_read need no controller or default model", async (t) => {
    let source!: ConversationId;
    let reading = false;
    let inspected = false;
    let controllerCalls = 0;
    const model = scriptedModel((request) => {
        const system = JSON.stringify(
            request.messages.filter((message) => message.role === "system"),
        );
        const last = lastText(request);

        if (system.includes("the owner's persistent private agent")) {
            if (last.role === "user") {
                return fauxAssistantMessage(
                    [
                        fauxToolCall(
                            reading ? "session_read" : "sessions",
                            reading ? { session: Number(source) } : { query: "DiscoveryTarget" },
                        ),
                    ],
                    { stopReason: "toolUse" },
                );
            }

            if (!reading && !inspected) {
                assert.match(last.text, /DiscoveryTarget/);
                inspected = true;

                return fauxAssistantMessage(
                    [fauxToolCall("work_context", { session: Number(source), action: "status" })],
                    { stopReason: "toolUse" },
                );
            }

            return fauxAssistantMessage("Native work inspected; nothing activated.");
        }

        if (system.includes("the private supervisor for Work Item")) {
            controllerCalls++;
        }

        return fauxAssistantMessage("Native evidence.");
    });
    const app = await openApp(model, join(root, "private-supervision-discovery-read"));

    t.after(() => app.close());
    source = await newSession(app, app.defaultCwd, "worker");
    await app.commands.updateSession(source, owner(app), { title: "DiscoveryTarget" });
    const chat = (
        await app.pip.agents.create(owner(app), {
            name: "Passive discovery",
            requestId: "identity",
        })
    ).id as ConversationId;

    await app.commands.submit(chat, owner(app), {
        text: "Find and inspect the accessible native DiscoveryTarget; do not contact it yet.",
        requestId: "discover",
    });
    await until(
        () => inspected && !app.isBusy(chat),
        "registered discovery and canonical work_context finish",
    );
    assert.equal(
        app.workItems.itemFor(source)?.supervisor,
        undefined,
        "discovery alone does not even create a controller",
    );
    assert.equal(controllerCalls, 0);
    app.config.lastModel = undefined;
    assert.equal(
        app.commands.defaultModel().model,
        undefined,
        "the ordinary native controller has no selected fallback model",
    );
    reading = true;
    await app.commands.submit(chat, owner(app), {
        text: "Read the exact native thread without activating it.",
        requestId: "read",
    });
    await until(
        () => !app.isBusy(chat),
        "registered exact read completes without a native controller model",
    );
    const errors = (await app.transcripts.allEntries(chat, true)).filter(
        (entry) => entry.kind === "toolResult" && entry.isError,
    );

    assert.deepEqual(errors, [], JSON.stringify(errors));
    assert.equal(
        app.workItems.itemFor(source),
        undefined,
        "reading creates no Work Item/controller",
    );
    assert.deepEqual(
        (await app.pip.agents.supervision.status(chat, owner(app))).attachments,
        [],
        "reading acquires no control grant",
    );
    assert.equal(controllerCalls, 0, "native history inspection never activates a controller");
});
