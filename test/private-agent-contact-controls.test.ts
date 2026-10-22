// Real native controls: only the external provider is scripted; no production profiles are changed.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { awaitWithContext, withAbortSignal } from "@earendil-works/chord/context";
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

import { AgentContactsDoc } from "../src/server/pip/agent-contacts-doc.ts";

after(cleanUp);

// A final-answer boundary would also consume a follow-up. Hold the first post-tools request to
// prove explicit steering joins the ongoing native run before either input has been answered.
test(
    "named explicit steer joins a busy Worker's first post-tools boundary without interrupting its human request",
    { timeout: 30_000 },
    async (t) => {
        const directory = mkdtempSync(join(root, "contact-steer-workspace-"));
        const file = join(directory, "boundary.txt");

        writeFileSync(file, "ACTUAL_NATIVE_READ_BOUNDARY");
        let worker!: ConversationId;
        let initialEntered = false;
        let initialAborted = false;
        let boundaryEntered = false;
        let boundaryUsers: string[] = [];
        let boundaryResult = "";
        let workerCalls = 0;
        let releaseInitial!: () => void;
        let releaseBoundary!: () => void;
        const initial = new Promise<void>((resolve) => {
            releaseInitial = resolve;
        });
        const boundary = new Promise<void>((resolve) => {
            releaseBoundary = resolve;
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
                                      session: Number(worker),
                                      text: "EXPLICIT_NATIVE_STEER",
                                      steer: true,
                                      report: false,
                                  }),
                              ],
                              { stopReason: "toolUse" },
                          )
                        : fauxAssistantMessage("Explicit native steering accepted.");
                }

                workerCalls++;

                if (workerCalls === 1) {
                    initialEntered = true;

                    try {
                        await awaitWithContext(
                            initial,
                            options?.signal ? withAbortSignal(options.signal, context) : context,
                        );
                    } catch (error) {
                        initialAborted = true;

                        throw error;
                    }

                    return fauxAssistantMessage([fauxToolCall("read", { path: file })], {
                        stopReason: "toolUse",
                    });
                }

                boundaryUsers = request.messages
                    .filter((message) => message.role === "user")
                    .map((message) => lastText({ messages: [message] }).text);
                const readResult = request.messages.findLast(
                    (message) => message.role === "toolResult",
                );

                boundaryResult =
                    readResult === undefined ? "" : lastText({ messages: [readResult] }).text;
                boundaryEntered = true;
                await awaitWithContext(
                    boundary,
                    options?.signal ? withAbortSignal(options.signal, context) : context,
                );

                return fauxAssistantMessage("NATIVE_STEER_AND_HUMAN_ANSWER");
            }),
            join(root, "contact-steer-data"),
        );

        t.after(async () => {
            releaseInitial();
            releaseBoundary();
            await app.close();
        });
        worker = await newSession(app, directory, "worker");
        const original = await app.commands.submit(worker, owner(app), {
            text: "BUSY_NATIVE_HUMAN",
            requestId: "busy-native-human",
        });

        await until(() => initialEntered, "initial human Worker request enters its provider");
        const chat = (
            await app.pip.agents.create(owner(app), {
                name: "Native steer fixture",
                requestId: "native-steer-fixture",
            })
        ).id as ConversationId;

        await say(app, chat, "Steer this exact busy Worker.");
        const receipt = (await app.transcripts.allEntries(chat, true)).find(
            (entry) => entry.kind === "toolResult" && entry.name === "agent_work",
        );

        assert.ok(receipt?.kind === "toolResult");
        assert.equal(receipt.isError, false, receipt.text);
        const contact = JSON.parse(receipt.text);

        assert.equal(contact.status, "accepted", receipt.text);
        assert.equal(contact.session, Number(worker));
        const steered = (await app.harness.submission(contact.submissionId, context))!;
        const queued = await steered.status(context);

        assert.equal(queued.conversationId, worker);
        assert.equal(
            queued.status,
            "queued",
            "steering waits for a native boundary, not immediate dispatch",
        );
        assert.match(queued.requestId!, /^p:/, "the named agent did not forge human input");
        assert.equal(workerCalls, 1);
        assert.equal(
            initialAborted,
            false,
            "explicit steer does not cancel the in-flight provider",
        );
        const beforeBoundary = await (await app.conversation(worker)).context(context);

        assert.doesNotMatch(JSON.stringify(beforeBoundary.messages), /EXPLICIT_NATIVE_STEER/);
        releaseInitial();
        await until(() => boundaryEntered, "the Worker's first actual post-tools provider request");
        assert.equal(workerCalls, 2);
        assert.match(boundaryResult, /ACTUAL_NATIVE_READ_BOUNDARY/);
        assert.ok(boundaryUsers.some((text) => text.includes("BUSY_NATIVE_HUMAN")));
        assert.ok(
            boundaryUsers.some((text) => text.includes("EXPLICIT_NATIVE_STEER")),
            "steer is already present after tools; a follow-up would remain queued until final answer",
        );
        assert.equal(
            (await (await app.harness.submission(original.submissionId, context))!.status(context))
                .status,
            "placed",
            "the ongoing human input has not ended before steering takes effect",
        );
        assert.equal((await steered.status(context)).status, "placed");
        releaseBoundary();
        const originalAnswer = await (await app.harness.submission(
            original.submissionId,
            context,
        ))!.wait(context);
        const steerAnswer = await steered.wait(context);

        assert.ok(originalAnswer.status === "done" && steerAnswer.status === "done");
        assert.equal(
            steerAnswer.answer,
            originalAnswer.answer,
            "both native inputs are answered by the same ongoing run, not separate follow-up runs",
        );
        assert.equal(initialAborted, false);
        assert.equal(workerCalls, 2, "steering did not create another independent provider run");
    },
);

// The original human parent's provider stays held while the helper's cancellation cleanup is
// delayed. Stop must join that exact helper, not abort its parent or return after signalling only.
test(
    "named Stop joins one existing ordinary-Chat helper without rerouting to its human parent",
    { timeout: 30_000 },
    async (t) => {
        const directory = mkdtempSync(join(root, "contact-helper-stop-workspace-"));
        let helper!: ConversationId;
        let helperEntered = false;
        let helperCancellationStarted = false;
        let helperJoined = false;
        let parentEntered = false;
        let parentAborted = false;
        let stopToolReturned = false;
        let joinedAtToolReturn = false;
        let releaseParent!: () => void;
        let finishHelperCleanup!: () => void;
        const parentHeld = new Promise<void>((resolve) => {
            releaseParent = resolve;
        });
        const helperHeld = new Promise<void>(() => {});
        const helperCleanup = new Promise<void>((resolve) => {
            finishHelperCleanup = resolve;
        });
        const app = await openApp(
            scriptedModel(async (request, options) => {
                const system = JSON.stringify(
                    request.messages.filter((message) => message.role === "system"),
                );
                const last = lastText(request);

                if (system.includes("the owner's persistent private agent")) {
                    if (last.role === "user") {
                        return fauxAssistantMessage(
                            [
                                fauxToolCall("agent_work", {
                                    action: "stop",
                                    session: Number(helper),
                                    report: false,
                                }),
                            ],
                            { stopReason: "toolUse" },
                        );
                    }

                    stopToolReturned = true;
                    joinedAtToolReturn = helperJoined;

                    return fauxAssistantMessage("The exact native helper Stop returned.");
                }

                if (last.role === "user" && last.text.includes("HOLD_EXACT_HELPER")) {
                    helperEntered = true;

                    try {
                        await awaitWithContext(
                            helperHeld,
                            options?.signal ? withAbortSignal(options.signal, context) : context,
                        );
                    } finally {
                        helperCancellationStarted = options?.signal?.aborted === true;
                        await helperCleanup;
                        helperJoined = true;
                    }

                    return fauxAssistantMessage("The held helper unexpectedly completed.");
                }

                if (last.role === "user" && last.text.includes("SPAWN_STOP_HELPER")) {
                    return fauxAssistantMessage(
                        [
                            fauxToolCall("subagent", {
                                action: "spawn",
                                name: "ordinary-stop-target",
                                message: "HOLD_EXACT_HELPER",
                            }),
                        ],
                        { stopReason: "toolUse" },
                    );
                }

                if (last.role === "toolResult") {
                    parentEntered = true;

                    try {
                        await awaitWithContext(
                            parentHeld,
                            options?.signal ? withAbortSignal(options.signal, context) : context,
                        );
                    } catch (error) {
                        parentAborted = true;

                        throw error;
                    }

                    return fauxAssistantMessage("The human parent's original task completed.");
                }

                // This ordinary-human helper retains native reports to its own parent, if any.
                return fauxAssistantMessage("The human parent noted its native helper report.");
            }),
            join(root, "contact-helper-stop-data"),
        );

        t.after(async () => {
            finishHelperCleanup();
            releaseParent();
            await app.close();
        });
        const parent = await newSession(app, directory, "chat");
        const original = await app.commands.submit(parent, owner(app), {
            text: "SPAWN_STOP_HELPER",
            requestId: "spawn-human-helper",
        });

        await until(
            () => parentEntered && helperEntered,
            "the ordinary human parent and its real helper both enter their providers",
        );
        const existing = app
            .subagents(owner(app))
            .find((entry) => entry.id === Number(parent) && entry.name === "ordinary-stop-target");

        assert.ok(existing);
        helper = existing.conversationId;
        assert.equal(app.parentOf(helper), parent);
        assert.equal(app.workItems.itemFor(parent), undefined);
        const helperInput = (await app.harness.inspect(context)).submissions.find(
            (submission) => submission.conversationId === helper && submission.type === "input",
        );

        assert.ok(helperInput);
        assert.equal(helperInput.status, "placed");
        const chat = (
            await app.pip.agents.create(owner(app), {
                name: "Helper Stop fixture",
                requestId: "helper-stop-fixture",
            })
        ).id as ConversationId;
        const stopping = await app.commands.submit(chat, owner(app), {
            text: "STOP_EXACT_HELPER_ONLY",
            requestId: "stop-exact-helper",
        });

        await until(
            () => helperCancellationStarted,
            "the exact helper receives native cancellation",
        );
        assert.equal(helperJoined, false, "the helper's external-provider cleanup is still held");
        assert.equal(
            stopToolReturned,
            false,
            "Stop must await the helper, not return after signalling it",
        );
        assert.equal(
            (await (await app.harness.submission(stopping.submissionId, context))!.status(context))
                .status,
            "placed",
        );
        finishHelperCleanup();
        await until(
            () => stopToolReturned && !app.isBusy(helper),
            "native Stop joins the exact helper",
        );
        const stopped = await (await app.harness.submission(stopping.submissionId, context))!.wait(
            context,
        );
        const receipt = (await app.transcripts.allEntries(chat, true)).find(
            (entry) => entry.kind === "toolResult" && entry.name === "agent_work",
        );

        assert.equal(stopped.status, "done");
        assert.ok(receipt?.kind === "toolResult");
        assert.equal(receipt.isError, false, receipt.text);
        const result = JSON.parse(receipt.text);

        assert.equal(result.status, "accepted", receipt.text);
        assert.equal(result.session, Number(helper));
        assert.equal(
            joinedAtToolReturn,
            true,
            "the actual helper provider settled before Stop returned",
        );
        const native = await (await app.harness.submission(helperInput.id, context))!.wait(context);

        assert.ok(native.status === "unanswered");
        assert.equal(native.reason, "aborted");
        assert.equal(native.conversationId, helper);
        assert.equal(parentAborted, false);
        assert.equal(
            app.isBusy(parent),
            true,
            "the exact helper Stop left its human parent running",
        );
        assert.equal(
            (await (await app.harness.submission(original.submissionId, context))!.status(context))
                .status,
            "placed",
            "the parent's original human input was not stopped or rerouted",
        );
        const parentContext = await (await app.conversation(parent)).context(context);
        const parentUsers = parentContext.messages.filter((message) => message.role === "user");

        assert.doesNotMatch(
            JSON.stringify(parentUsers),
            /STOP_EXACT_HELPER_ONLY|\[via named agent/,
        );
        assert.equal(
            app.workItems.itemFor(parent),
            undefined,
            "Stop never promotes Chat to a Work Item",
        );
        const helpers = app.subagents(owner(app)).filter((entry) => entry.id === Number(parent));

        assert.equal(
            helpers.length,
            1,
            "the existing helper was stopped without creating another one",
        );
        assert.equal(helpers[0]!.conversationId, helper);
        releaseParent();
        const completed = await (await app.harness.submission(
            original.submissionId,
            context,
        ))!.wait(context);

        assert.equal(completed.status, "done", "the original human parent can finish normally");
        await until(
            async () => (await app.harness.inspect(context)).tasks.length === 0,
            "native helper reporter and any ordinary-human parent report settle",
        );
        assert.equal(parentAborted, false);
    },
);

// A commit publication is the actual persisted-intent boundary, before native input admission.
// Stop is requested there through Commands, not by fabricating an epoch, receipt or cancellation.
test(
    "human Stop fences prepared exact input before ordinary Chat/helper admission",
    { timeout: 30_000 },
    async (t) => {
        for (const recipient of ["chat", "helper"] as const) {
            await t.test(recipient, async (t) => {
                let target!: ConversationId;
                let originalEntered = false;
                let originalStopped = false;
                let stopRequested = false;
                let stopping: Promise<void> | undefined;
                const staleActivations: { afterOriginalStop: boolean }[] = [];
                const held = new Promise<void>(() => {});
                const app = await openApp(
                    scriptedModel(async (request, options) => {
                        const last = lastText(request);
                        const system = JSON.stringify(
                            request.messages.filter((message) => message.role === "system"),
                        );

                        if (system.includes("the owner's persistent private agent")) {
                            return last.role === "user"
                                ? fauxAssistantMessage(
                                      [
                                          fauxToolCall("agent_work", {
                                              action: "send",
                                              session: Number(target),
                                              text: "STALE_PREPARED_AFTER_HUMAN_STOP",
                                              report: false,
                                          }),
                                      ],
                                      { stopReason: "toolUse" },
                                  )
                                : fauxAssistantMessage("Exact contact attempt settled.");
                        }

                        if (last.role === "user" && last.text.includes("HOLD_PREPARED_TARGET")) {
                            originalEntered = true;

                            try {
                                await awaitWithContext(
                                    held,
                                    options?.signal
                                        ? withAbortSignal(options.signal, context)
                                        : context,
                                );
                            } finally {
                                originalStopped = options?.signal?.aborted === true;
                            }
                        }

                        if (last.role === "user" && last.text.includes("SPAWN_PREPARED_TARGET")) {
                            return fauxAssistantMessage(
                                [
                                    fauxToolCall("subagent", {
                                        action: "spawn",
                                        name: "prepared-stop-target",
                                        message: "HOLD_PREPARED_TARGET",
                                    }),
                                ],
                                { stopReason: "toolUse" },
                            );
                        }

                        if (
                            last.role === "user" &&
                            last.text.includes("STALE_PREPARED_AFTER_HUMAN_STOP")
                        ) {
                            staleActivations.push({ afterOriginalStop: originalStopped });
                        }

                        return fauxAssistantMessage("Native target response.");
                    }),
                    join(root, `human-stop-prepared-${recipient}`),
                );

                t.after(() => app.close());
                const parent = await newSession(app, app.defaultCwd, "chat");

                if (recipient === "helper") {
                    await say(app, parent, "SPAWN_PREPARED_TARGET");
                    const helper = app
                        .subagents(owner(app))
                        .find(
                            (entry) =>
                                entry.id === Number(parent) &&
                                entry.name === "prepared-stop-target",
                        );

                    assert.ok(helper, "the recipient is a real registered native helper");
                    target = helper.conversationId;
                } else {
                    target = parent;
                    await app.commands.submit(target, owner(app), {
                        text: "HOLD_PREPARED_TARGET",
                        requestId: "original-human-target",
                    });
                }

                await until(
                    () => originalEntered,
                    "the exact target's original human work enters its provider",
                );
                const native = await app.conversation(target);
                const unsubscribe = app.harness.subscribeCommits((publication) => {
                    if (
                        !stopRequested &&
                        publication.changes.some(
                            (change) =>
                                change.type === "document" &&
                                change.record.kind === AgentContactsDoc.definition.kind &&
                                Object.values(
                                    (
                                        change.value as {
                                            contacts: Record<
                                                string,
                                                { target: number; action: string; status: string }
                                            >;
                                        }
                                    ).contacts,
                                ).some(
                                    (contact) =>
                                        contact.target === Number(target) &&
                                        contact.action === "send" &&
                                        contact.status === "prepared",
                                ),
                        )
                    ) {
                        stopRequested = true;
                        stopping = app.commands
                            .abort(target, owner(app))
                            .then(() => native.waitForIdle(context));
                    }
                });

                t.after(unsubscribe);
                const origin = (
                    await app.pip.agents.create(owner(app), {
                        name: "Prepared Stop origin",
                        requestId: "prepared-stop-origin",
                    })
                ).id as ConversationId;

                await say(app, origin, "Contact that exact target within my current task.");
                assert.equal(
                    stopRequested,
                    true,
                    "Stop was requested after production persisted its prepared intent",
                );
                await stopping;
                await native.waitForIdle(context);
                assert.equal(
                    originalStopped,
                    true,
                    "the target's original provider actually observed native cancellation",
                );
                assert.deepEqual(
                    staleActivations,
                    [],
                    "a decision prepared before human Stop must not buy another target provider request after it",
                );
            });
        }
    },
);
