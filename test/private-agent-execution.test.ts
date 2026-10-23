// Exercise registered native tools with disposable storage; only the external provider is scripted.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { awaitWithContext, withAbortSignal } from "@earendil-works/chord/context";
import { LiveDoc, type ConversationId } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { TurnsDoc } from "../src/server/docs.ts";
import type { JsonObject } from "@earendil-works/pi-ai";
import {
    cleanUp,
    context,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    say,
    setWorkPipLimits,
    scriptedModel,
    until,
} from "./helpers.ts";

after(cleanUp);

// The owning contract is tool-level: Stop alone leaves execution running; direct intervention
// joins it before editing, and delegation returns the native writer instead of leaving a second one.
test("Stop and direct correction return one native writer for execution or controller continuation", async (t) => {
    for (const continuation of ["controller", "execution"] as const) {
        await t.test(continuation, async (t) => {
            const directory = mkdtempSync(join(root, "execution-workspace-"));
            const file = join(directory, "answer.txt");

            writeFileSync(file, "original\n");
            let source!: ConversationId;
            let controller!: ConversationId;
            let chat!: ConversationId;
            let workerEntered = false;
            let helperEntered = false;
            let helperJoined = false;
            let continuationStarted = false;
            let corrected = false;
            let resumed = false;
            let agentStep = 0;
            let controllerStep = 0;
            const tool = (name: string, args: JsonObject) =>
                fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
            const app = await openApp(
                scriptedModel(async (request, options) => {
                    const system = JSON.stringify(
                        request.messages.filter((item) => item.role === "system"),
                    );
                    const last = lastText(request);

                    if (system.includes("the owner's persistent private agent")) {
                        const steps = [
                            () =>
                                tool("agent_execution", {
                                    action: "intervene",
                                    session: Number(source),
                                }),
                            () =>
                                tool("edit", {
                                    path: file,
                                    edits: [{ oldText: "original", newText: "corrected" }],
                                }),
                            () =>
                                tool("agent_work", {
                                    action: "send",
                                    session: Number(
                                        continuation === "controller" ? controller : source,
                                    ),
                                    text:
                                        continuation === "execution"
                                            ? "Continue after correction."
                                            : "Continue the corrected work; no publication.",
                                }),
                        ];

                        if (agentStep > 0) {
                            assert.doesNotMatch(
                                last.text,
                                /not available|not permitted|permission_denied|Error:/i,
                            );
                        }

                        if (agentStep === 2) {
                            assert.equal(readFileSync(file, "utf8"), "corrected\n");
                            assert.equal(
                                app.isBusy(source),
                                false,
                                "intervention joined the old native run",
                            );
                            assert.equal(
                                helperJoined,
                                true,
                                "intervention also joined its relevant native helper",
                            );
                            corrected = true;
                        }

                        return (
                            steps[agentStep++]?.() ??
                            fauxAssistantMessage("Corrected and delegated.")
                        );
                    }

                    if (system.includes("the private supervisor for Work Item")) {
                        assert.equal(corrected, true);

                        if (controllerStep++ === 0) {
                            return tool("session_read", { session: Number(source) });
                        }

                        if (controllerStep === 2) {
                            return tool("session_send", {
                                session: Number(source),
                                message: "Continue after correction.",
                                report: false,
                            });
                        }

                        assert.doesNotMatch(last.text, /blocked|Error:/i);
                        resumed = true;

                        return fauxAssistantMessage("Native continuation dispatched.");
                    }

                    if (last.text.includes("Hold the competing helper")) {
                        helperEntered = true;

                        try {
                            await awaitWithContext(
                                new Promise<void>(() => {}),
                                options?.signal
                                    ? withAbortSignal(options.signal, context)
                                    : context,
                            );
                        } finally {
                            helperJoined = true;
                        }
                    }

                    if (last.text.includes("Continue after correction")) {
                        continuationStarted = true;
                        resumed = true;

                        return tool("write", {
                            path: join(directory, "continued.txt"),
                            content: "native writer continued",
                        });
                    }

                    if (last.role === "toolResult" && continuationStarted) {
                        return fauxAssistantMessage("Native continuation completed.");
                    }

                    if (last.role === "user") {
                        return tool("subagent", {
                            action: "spawn",
                            name: "competing-execution",
                            message: "Hold the competing helper until native Stop.",
                        });
                    }

                    workerEntered = true;
                    await awaitWithContext(
                        new Promise<void>(() => {}),
                        options?.signal ? withAbortSignal(options.signal, context) : context,
                    );

                    return fauxAssistantMessage(
                        "Stopped execution must never resume this command.",
                    );
                }),
                join(root, `execution-native-${continuation}-data`),
            );

            t.after(() => app.close());
            source = await newSession(app, directory, "worker");
            const opened = await app.pip.orchestration.control(source, owner(app), {
                action: "open",
            });

            controller = opened.orchestration!.conversationId as ConversationId;
            await app.commands.submit(source, owner(app), {
                text: "Work until stopped.",
                requestId: "old-work",
            });
            await until(
                () => workerEntered && helperEntered,
                "execution and its native helper start",
            );
            const agent = await app.pip.agents.create(owner(app), {
                name: "Fixer",
                requestId: "fixer",
            });

            chat = agent.id as ConversationId;
            await app.pip.agents.supervision.control(chat, owner(app), {
                action: "attach",
                session: Number(source),
                requestId: "attach",
            });
            await app.commands.abort(chat, owner(app));
            assert.equal(app.isBusy(source), true, "ordinary private Stop does not kill execution");
            await say(
                app,
                chat,
                `Stop that execution, correct it directly, then ${continuation} continuation.`,
            );
            const errors = (await app.transcripts.allEntries(chat, true)).filter(
                (entry) => entry.kind === "toolResult" && entry.isError,
            );

            assert.deepEqual(
                errors,
                [],
                JSON.stringify(await app.transcripts.allEntries(chat, true)),
            );
            await until(() => resumed, "native delegated correction is admitted");
            await until(
                () => existsSync(join(directory, "continued.txt")),
                "native continuation writes its result",
            );
            await until(() => !app.isBusy(source), "native writer settles");
            assert.equal(
                readFileSync(join(directory, "continued.txt"), "utf8"),
                "native writer continued",
            );

            if (continuation === "execution") {
                assert.equal(
                    controllerStep,
                    0,
                    "exact continuation never wakes or silently reroutes to its orchestrator",
                );
            }
        });
    }
});

// This distinct path never borrows a private writer: native Stop must join the old run,
// then immediate controller delegation must be able to use the same execution root.
test("native Stop then immediate delegated correction needs no manual association or writer loan", async (t) => {
    const directory = mkdtempSync(join(root, "immediate-correction-"));
    const result = join(directory, "fixed.txt");
    let source!: ConversationId;
    let controller!: ConversationId;
    let entered = false;
    let stopped = false;
    let step = 0;
    let controllerStep = 0;
    let correcting = false;
    const tool = (name: string, args: JsonObject) =>
        fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
    const app = await openApp(
        scriptedModel(async (request, options) => {
            const system = JSON.stringify(
                request.messages.filter((item) => item.role === "system"),
            );
            const last = lastText(request);

            if (system.includes("the owner's persistent private agent")) {
                if (step++ === 0) {
                    return tool("agent_work", { action: "stop", session: Number(source) });
                }

                if (step === 2) {
                    assert.equal(
                        stopped,
                        true,
                        "Stop joined the old native invocation before delegating correction",
                    );
                    assert.equal(app.isBusy(source), false);

                    return tool("agent_work", {
                        action: "send",
                        session: Number(controller),
                        text: "Correct the stopped work directly in its existing native execution thread.",
                    });
                }

                return fauxAssistantMessage(
                    "Correction delegated through the existing native controller.",
                );
            }

            if (system.includes("the private supervisor for Work Item")) {
                if (controllerStep++ === 0) {
                    return tool("session_read", { session: Number(source) });
                }

                return controllerStep === 2
                    ? tool("session_send", {
                          session: Number(source),
                          message: "Apply immediate native correction.",
                          report: false,
                      })
                    : fauxAssistantMessage("Native correction dispatched.");
            }

            if (last.text.includes("Apply immediate native correction")) {
                correcting = true;

                return tool("write", {
                    path: result,
                    content: "corrected by the original native writer",
                });
            }

            if (correcting) {
                return fauxAssistantMessage("Native correction complete.");
            }

            entered = true;

            try {
                await awaitWithContext(
                    new Promise<void>(() => {}),
                    options?.signal ? withAbortSignal(options.signal, context) : context,
                );
            } finally {
                stopped = true;
            }

            return fauxAssistantMessage("A stopped invocation cannot decide another command.");
        }),
        join(root, "immediate-native-data"),
    );

    t.after(() => app.close());
    source = await newSession(app, directory, "worker");
    const opened = await app.pip.orchestration.control(source, owner(app), { action: "open" });

    controller = opened.orchestration!.conversationId as ConversationId;
    await app.commands.submit(source, owner(app), {
        text: "Original work pending correction.",
        requestId: "original",
    });
    await until(() => entered, "original native execution starts");
    const created = await app.pip.agents.create(owner(app), {
        name: "Direct coordinator",
        requestId: "direct",
    });
    const chat = created.id as ConversationId;

    await say(app, chat, "Stop the current execution and immediately delegate its correction.");
    const errors = (await app.transcripts.allEntries(chat, true)).filter(
        (entry) => entry.kind === "toolResult" && entry.isError,
    );

    assert.deepEqual(errors, [], JSON.stringify(errors));
    const contacts = (await app.transcripts.allEntries(chat, true))
        .filter((entry) => entry.kind === "toolResult")
        .filter((entry) => entry.name === "agent_work");

    assert.ok(
        contacts.every((entry) => entry.text.includes('"status":"accepted"')),
        JSON.stringify(contacts),
    );
    await until(
        () => existsSync(result),
        "original native thread completes the delegated correction",
    );
    assert.equal(readFileSync(result, "utf8"), "corrected by the original native writer");
    assert.equal(
        app.workItems.itemFor(source)!.intervention,
        undefined,
        "immediate delegation leaves no temporary private writer",
    );
    assert.deepEqual(
        app.workItems.members(source),
        [source],
        "private chat and controller never become execution members",
    );
});

test("restart returns a native writer without replaying the interrupted private generation", async (t) => {
    const directory = mkdtempSync(join(root, "restart-writer-"));
    const stale = join(directory, "stale.txt");
    const resumed = join(directory, "resumed.txt");
    const data = join(root, "restart-native-data");
    let source!: ConversationId;
    let waiting = false;
    let privateCalls = 0;
    const model = scriptedModel(async (request, options) => {
        const system = JSON.stringify(request.messages.filter((item) => item.role === "system"));
        const last = lastText(request);

        if (system.includes("the owner's persistent private agent")) {
            privateCalls++;

            if (privateCalls === 1) {
                return fauxAssistantMessage(
                    [
                        fauxToolCall("agent_execution", {
                            action: "intervene",
                            session: Number(source),
                        }),
                    ],
                    { stopReason: "toolUse" },
                );
            }

            if (privateCalls === 2) {
                waiting = true;
                await awaitWithContext(
                    new Promise<void>(() => {}),
                    options?.signal ? withAbortSignal(options.signal, context) : context,
                );
            }

            return last.role === "user" || (last.role === "toolResult" && privateCalls === 3)
                ? fauxAssistantMessage(
                      [fauxToolCall("write", { path: stale, content: "must not replay" })],
                      { stopReason: "toolUse" },
                  )
                : fauxAssistantMessage("Interrupted decision ended.");
        }

        return last.role === "user"
            ? fauxAssistantMessage(
                  [fauxToolCall("write", { path: resumed, content: "native authority restored" })],
                  { stopReason: "toolUse" },
              )
            : fauxAssistantMessage("Native continuation done.");
    });
    let app = await openApp(model, data);

    t.after(() => app.close());
    source = await newSession(app, directory, "worker");
    const created = await app.pip.agents.create(owner(app), {
        name: "Restart fixture",
        requestId: "restart-fixture",
    });
    const chat = created.id as ConversationId;

    await app.commands.submit(chat, owner(app), {
        text: "Take over this native writer for a correction.",
        requestId: "take-over",
    });
    await until(() => waiting, "private writer is active before restart");
    const calls = privateCalls;

    await app.close();
    app = await openApp(model, data);
    await app.harness.waitForIdle(context);
    assert.equal(privateCalls, calls, "restart must not buy a fresh stale private decision");
    assert.equal(existsSync(stale), false, "no old private command wrote after restart");
    assert.equal(
        app.workItems.executionBlocked(source),
        false,
        JSON.stringify({
            projection: app.workItems.projection(source),
            item: app.workItems.itemFor(source),
        }),
    );
    await say(app, source, "Resume native work after the interrupted correction.");
    const sourceEntries = await app.transcripts.allEntries(source, true);

    assert.equal(existsSync(resumed), true, JSON.stringify(sourceEntries));
    await until(() => existsSync(resumed), "native writer resumes after private restart fence");
    assert.equal(readFileSync(resumed, "utf8"), "native authority restored");
});

test("named execution cannot escape publication policy through Chat shell, browser or artifacts", async (t) => {
    let step = 0;
    const app = await openApp(
        scriptedModel(() => {
            const attempts: [string, JsonObject][] = [
                [
                    "artifact",
                    {
                        id: "network-attempt",
                        title: "Network attempt",
                        type: "html",
                        content: "<script>fetch('https://example.com/mutate')</script>",
                    },
                ],
                ["browser", { action: "evaluate", script: "fetch('https://example.com/mutate')" }],
                [
                    "publication",
                    {
                        action: "execute",
                        command: ["git", "push", "file:///must-not-run", "HEAD"],
                        reason: "This must be refused before approval or execution.",
                    },
                ],
                ["bash", { command: "git push file:///must-not-run HEAD" }],
            ];
            const attempt = attempts[step++];

            return attempt === undefined
                ? fauxAssistantMessage("No external effect was authorized.")
                : fauxAssistantMessage([fauxToolCall(attempt[0], attempt[1])], {
                      stopReason: "toolUse",
                  });
        }),
        join(root, "named-publication-policy-data"),
    );

    t.after(() => app.close());
    const created = await app.pip.agents.create(owner(app), {
        name: "Policy fixture",
        requestId: "policy-fixture",
    });
    const chat = created.id as ConversationId;

    await app.commands.configure(chat, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });
    await say(app, chat, "Inspect the native execution policy; no publication is approved.");
    const results = (await app.transcripts.allEntries(chat, true)).filter(
        (entry) => entry.kind === "toolResult",
    );

    assert.equal(results.length, 4, "every attempted real registered tool returned a refusal");
    assert.ok(results.every((entry) => entry.isError));
    assert.match(results.find((entry) => entry.name === "artifact")!.text, /Artifacts are blocked/);
    assert.match(results.find((entry) => entry.name === "browser")!.text, /static reader/);
    assert.match(results.find((entry) => entry.name === "publication")!.text, /Publish/);
    assert.match(results.find((entry) => entry.name === "bash")!.text, /Direct Git push/);
    assert.ok(
        results.every((entry) => !entry.text.includes("sandbox_apply")),
        "all refusals happened before native process/browser execution",
    );
});

test("an overlapping independent writer must be explicitly stopped, never silently cancelled by intervention", async (t) => {
    const directory = mkdtempSync(join(root, "overlapping-writers-"));
    const file = join(directory, "answer.txt");

    writeFileSync(file, "original");
    let first!: ConversationId;
    let second!: ConversationId;
    let entered = 0;
    let step = 0;
    const tool = (name: string, args: JsonObject) =>
        fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
    const app = await openApp(
        scriptedModel(async (request, options) => {
            const system = JSON.stringify(
                request.messages.filter((item) => item.role === "system"),
            );
            const last = lastText(request);

            if (system.includes("the owner's persistent private agent")) {
                switch (step++) {
                    case 0:
                        return tool("agent_execution", {
                            action: "intervene",
                            session: Number(first),
                        });
                    case 1:
                        assert.match(last.text, /Another native writer/);
                        assert.equal(
                            app.isBusy(first),
                            true,
                            "a refused loan leaves the selected execution untouched",
                        );
                        assert.equal(
                            app.isBusy(second),
                            true,
                            "intervention never silently stops another Work Item",
                        );

                        return tool("agent_work", { action: "stop", session: Number(second) });
                    case 2:
                        assert.equal(app.isBusy(second), false);

                        return tool("agent_execution", {
                            action: "intervene",
                            session: Number(first),
                        });
                    case 3:
                        return tool("edit", {
                            path: file,
                            edits: [{ oldText: "original", newText: "single corrected writer" }],
                        });
                    default:
                        return fauxAssistantMessage(
                            "The conflicting native writer was explicitly stopped first.",
                        );
                }
            }

            entered++;
            await awaitWithContext(
                new Promise<void>(() => {}),
                options?.signal ? withAbortSignal(options.signal, context) : context,
            );

            return fauxAssistantMessage("A stopped writer must not continue.");
        }),
        join(root, "overlapping-native-data"),
    );

    t.after(() => app.close());
    first = await newSession(app, directory, "worker");
    second = await newSession(app, directory, "worker");
    await app.commands.submit(first, owner(app), {
        text: "First native writer.",
        requestId: "first-native",
    });
    await app.commands.submit(second, owner(app), {
        text: "Second native writer.",
        requestId: "second-native",
    });
    await until(() => entered === 2, "both independent native executions start");
    const created = await app.pip.agents.create(owner(app), {
        name: "Overlap fixture",
        requestId: "overlap-fixture",
    });

    await say(
        app,
        created.id as ConversationId,
        "Stop the overlapping execution explicitly before correcting the first workspace.",
    );
    const entries = await app.transcripts.allEntries(created.id as ConversationId, true);

    assert.equal(readFileSync(file, "utf8"), "single corrected writer", JSON.stringify(entries));
});

test("direct intervention retains the native Work Item action cap before cancelling its writer", async (t) => {
    let source!: ConversationId;
    let controller!: ConversationId;
    let entered = false;
    let privateStep = 0;
    const app = await openApp(
        scriptedModel(async (request, options) => {
            const system = JSON.stringify(
                request.messages.filter((item) => item.role === "system"),
            );

            if (system.includes("the owner's persistent private agent")) {
                if (privateStep++ === 0) {
                    return fauxAssistantMessage(
                        [
                            fauxToolCall("agent_work", {
                                action: "send",
                                session: Number(controller),
                                text: "Observe the current native task; this bounded contact consumes its one action.",
                                report: false,
                            }),
                        ],
                        { stopReason: "toolUse" },
                    );
                }

                return privateStep === 2
                    ? fauxAssistantMessage(
                          [
                              fauxToolCall("agent_execution", {
                                  action: "intervene",
                                  session: Number(source),
                              }),
                          ],
                          { stopReason: "toolUse" },
                      )
                    : fauxAssistantMessage("The native action cap requires the owner.");
            }

            entered = true;
            await awaitWithContext(
                new Promise<void>(() => {}),
                options?.signal ? withAbortSignal(options.signal, context) : context,
            );

            return fauxAssistantMessage("Original native work.");
        }),
        join(root, "native-intervention-cap-data"),
    );

    t.after(() => app.close());
    source = await newSession(app, mkdtempSync(join(root, "capped-writer-")), "worker");
    const opened = await app.pip.orchestration.control(source, owner(app), { action: "open" });

    controller = opened.orchestration!.conversationId as ConversationId;
    await setWorkPipLimits(app, source, owner(app), { maxActions: 1 });
    await app.commands.submit(source, owner(app), {
        text: "Original execution under native limits.",
        requestId: "limited-work",
    });
    await until(() => entered, "native execution starts");
    const created = await app.pip.agents.create(owner(app), {
        name: "Cap fixture",
        requestId: "cap-fixture",
    });
    const chat = created.id as ConversationId;

    await say(app, chat, "Correct directly only within the existing native limits.");
    const result = (await app.transcripts.allEntries(chat, true)).find(
        (entry) => entry.kind === "toolResult" && entry.name === "agent_execution",
    );

    assert.ok(result?.kind === "toolResult");
    assert.equal(result.isError, true);
    assert.match(result.text, /native Work Item action or spend budget is exhausted/);
    assert.equal(
        app.isBusy(source),
        true,
        "refused intervention must not cancel the limited native writer",
    );
    assert.equal(app.workItems.itemFor(source)!.intervention, undefined);
});

test("private intervention respects a guest driving already-associated native work", async (t) => {
    let source!: ConversationId;
    let entered = false;
    let targetAborted = false;
    let privateStep = 0;
    const app = await openApp(
        scriptedModel(async (request, options) => {
            const system = JSON.stringify(
                request.messages.filter((item) => item.role === "system"),
            );

            if (system.includes("the owner's persistent private agent")) {
                return privateStep++ === 0
                    ? fauxAssistantMessage(
                          [
                              fauxToolCall("agent_execution", {
                                  action: "intervene",
                                  session: Number(source),
                              }),
                          ],
                          { stopReason: "toolUse" },
                      )
                    : fauxAssistantMessage("The native driver's authority must be respected.");
            }

            entered = true;

            try {
                await awaitWithContext(
                    new Promise<void>(() => {}),
                    options?.signal ? withAbortSignal(options.signal, context) : context,
                );
            } finally {
                targetAborted = true;
            }

            return fauxAssistantMessage("Original native execution must not be interrupted.");
        }),
        join(root, "native-intervention-driver-data"),
    );

    t.after(() => app.close());
    source = await newSession(app, mkdtempSync(join(root, "guest-driven-writer-")), "worker");
    await app.commands.submit(source, owner(app), {
        text: "Keep the original native execution running.",
        requestId: "guest-driven-original-work",
    });
    await until(() => entered, "original native execution starts");
    const created = await app.pip.agents.create(owner(app), {
        name: "Driver boundary fixture",
        requestId: "driver-boundary-fixture",
    });
    const chat = created.id as ConversationId;

    await app.pip.agents.supervision.control(chat, owner(app), {
        action: "attach",
        session: Number(source),
        requestId: "attach-before-guest-drives",
    });
    const guest = app.config.addUser("Guest driver", "guest").user;

    await app.collab.turns(source, guest, { action: "on" });
    const turnsBefore = await app.harness.snapshot(TurnsDoc, source, context);
    const runBefore = (await app.harness.snapshot(LiveDoc, source, context))!.run!;
    const itemBefore = JSON.parse(JSON.stringify(app.workItems.itemFor(source)!));

    assert.equal(turnsBefore?.on, true);
    assert.equal(turnsBefore?.driver, guest.id);
    assert.ok(runBefore.taskId, "the original target run is active before intervention");
    assert.equal(itemBefore.supervisor.agentId, created.agentId, "association already exists");
    assert.equal(itemBefore.intervention, undefined);
    await say(app, chat, "Stop that work and borrow its native writer for a direct correction.");
    const result = (await app.transcripts.allEntries(chat, true)).find(
        (entry) => entry.kind === "toolResult" && entry.name === "agent_execution",
    );

    assert.ok(result?.kind === "toolResult", "the actual registered intervention tool answered");
    const current = app.workItems.itemFor(source)!;
    const runAfter = (await app.harness.snapshot(LiveDoc, source, context))?.run;

    assert.deepEqual(
        {
            refused: result.isError,
            interventionAbsent: current.intervention === undefined,
            originalTargetAborted: targetAborted,
            originalRunStillActive: app.isBusy(source) && runAfter?.taskId === runBefore.taskId,
            activeWriter: current.activeThreadId,
        },
        {
            refused: true,
            interventionAbsent: true,
            originalTargetAborted: false,
            originalRunStillActive: true,
            activeWriter: itemBefore.activeThreadId,
        },
        `a non-driving owner must not stop or borrow the native writer: ${result.text}`,
    );
    assert.match(result.text, /driv|wheel/i, "refusal must come from the native driver guard");
    assert.deepEqual(current.supervisor, itemBefore.supervisor);
    assert.deepEqual(await app.harness.snapshot(TurnsDoc, source, context), turnsBefore);
});

test("a borrowed write refuses a guest taking the wheel during filesystem preparation", async (t) => {
    const directory = mkdtempSync(join(root, "pending-borrowed-write-"));
    const file = join(directory, "answer.txt");

    writeFileSync(file, "original native bytes\n");
    let source!: ConversationId;
    let entered = false;
    let privateStep = 0;
    let gateArmed = false;
    let preparationWaiting = false;
    let releasePreparation!: () => void;
    const preparation = new Promise<void>((resolve) => {
        releasePreparation = resolve;
    });
    const app = await openApp(
        scriptedModel(async (request, options) => {
            const system = JSON.stringify(
                request.messages.filter((item) => item.role === "system"),
            );

            if (system.includes("the owner's persistent private agent")) {
                if (privateStep++ === 0) {
                    return fauxAssistantMessage(
                        [
                            fauxToolCall("agent_execution", {
                                action: "intervene",
                                session: Number(source),
                            }),
                        ],
                        { stopReason: "toolUse" },
                    );
                }

                if (privateStep === 2) {
                    assert.equal(app.workItems.itemFor(source)!.intervention?.phase, "active");
                    gateArmed = true;

                    return fauxAssistantMessage(
                        [fauxToolCall("write", { path: file, content: "unauthorized correction" })],
                        { stopReason: "toolUse" },
                    );
                }

                return fauxAssistantMessage("The pending correction has settled.");
            }

            entered = true;
            await awaitWithContext(
                new Promise<void>(() => {}),
                options?.signal ? withAbortSignal(options.signal, context) : context,
            );

            return fauxAssistantMessage("Original native execution stopped for intervention.");
        }),
        join(root, "pending-borrowed-write-driver-data"),
    );

    t.after(async () => {
        releasePreparation();
        await app.close();
    });
    const canonicalPath = NodeExecutionEnv.prototype.canonicalPath;

    t.mock.method(
        NodeExecutionEnv.prototype,
        "canonicalPath",
        async function (this: NodeExecutionEnv, ...args: Parameters<typeof canonicalPath>) {
            // The real write tool resolves its path with absolutePath. This workspace canonicalization
            // belongs to authorize's preparation, after the initial transactional driver check.
            if (gateArmed && args[0] === directory) {
                gateArmed = false;
                preparationWaiting = true;
                await awaitWithContext(preparation, args[1]);
            }

            return canonicalPath.apply(this, args);
        },
    );
    source = await newSession(app, directory, "worker");
    await app.commands.submit(source, owner(app), {
        text: "Hold native execution until explicit intervention.",
        requestId: "pending-write-original-work",
    });
    await until(() => entered, "original native execution starts");
    const created = await app.pip.agents.create(owner(app), {
        name: "Pending writer fixture",
        requestId: "pending-writer-fixture",
    });
    const chat = created.id as ConversationId;
    const guest = app.config.addUser("Preparation-time driver", "guest").user;
    const pending = say(app, chat, "Intervene, then correct the native file directly.");

    await until(() => preparationWaiting, "borrowed write reaches filesystem preparation");
    assert.equal(app.workItems.itemFor(source)!.intervention?.phase, "active");
    assert.equal(readFileSync(file, "utf8"), "original native bytes\n");
    await app.collab.turns(source, guest, { action: "on" });
    assert.equal((await app.harness.snapshot(TurnsDoc, source, context))?.driver, guest.id);
    releasePreparation();
    await pending;
    const result = (await app.transcripts.allEntries(chat, true)).find(
        (entry) => entry.kind === "toolResult" && entry.name === "write",
    );

    assert.ok(result?.kind === "toolResult", "the actual registered write tool answered");
    assert.deepEqual(
        { refused: result.isError, bytes: readFileSync(file, "utf8") },
        { refused: true, bytes: "original native bytes\n" },
        `a guest taking the wheel during preparation must fence the pending borrowed write: ${result.text}`,
    );
    assert.match(result.text, /driv|wheel/i, "refusal must come from the native driver guard");
    assert.equal((await app.harness.snapshot(TurnsDoc, source, context))?.driver, guest.id);
});

test("a process crash cannot renew the old private input or its real helper, but fresh owner input can execute", async (t) => {
    const directory = mkdtempSync(join(root, "crash-writer-"));
    const data = join(root, "crash-native-data");
    const stale = join(directory, "stale-after-crash.txt");
    const resumed = join(directory, "native-resumed.txt");
    const fresh = join(directory, "fresh-private.txt");
    const script = `
        const { fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai/providers/faux");
        const helpers = await import(${JSON.stringify(new URL("./helpers.ts", import.meta.url).href)});
        const { openApp, scriptedModel, newSession, owner, root, until } = helpers;
        process.send({ setupRoot: root });
        let source;
        let chat;
        let helperEntered = false;
        let step = 0;
        const hold = () => new Promise(() => {});
        const app = await openApp(scriptedModel(async (request) => {
            const system = JSON.stringify(request.messages.filter((message) => message.role === "system"));
            const last = helpers.lastText(request);
            process.send({ diagnostic: JSON.stringify({ last, step, private: system.includes("the owner's persistent private agent") }) });

            if (last.role === "user" && last.text.includes("CRASH_PRIVATE_HELPER")) {
                helperEntered = true;
                await hold();
            }

            if (system.includes("the owner's persistent private agent")) {
                switch (step++) {
                    case 0:
                        return fauxAssistantMessage([fauxToolCall("subagent", { action: "spawn", name: "crash-private-helper", message: "CRASH_PRIVATE_HELPER: inspect only, then await the root's next instruction." })], { stopReason: "toolUse" });
                    case 1:
                        return fauxAssistantMessage([fauxToolCall("agent_execution", { action: "intervene", session: Number(source) })], { stopReason: "toolUse" });
                    default:
                        await until(() => helperEntered, "real private helper entered its provider");
                        process.send({ ready: true, source: Number(source), chat: Number(chat) });
                        await hold();
                }
            }

            return fauxAssistantMessage("Native source is idle.");
        }), ${JSON.stringify(data)});
        source = await newSession(app, ${JSON.stringify(directory)}, "worker");
        const created = await app.pip.agents.create(owner(app), { name: "Crash fixture", requestId: "crash-fixture" });
        chat = created.id;
        setInterval(() => {}, 1000);
        await app.commands.submit(chat, owner(app), { text: "Start the real helper and take the native writer for a correction.", requestId: "old-crash-input" });
    `;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let setupRoot: string | undefined;
    let ready: { source: number; chat: number } | undefined;
    let diagnostics = "";

    assert.ok(child.stdout);
    assert.ok(child.stderr);
    child.stdout.on("data", (value) => {
        diagnostics += String(value);
    });
    child.stderr.on("data", (value) => {
        diagnostics += String(value);
    });
    child.on("message", (value: unknown) => {
        const message = value as {
            diagnostic?: string;
            setupRoot?: string;
            ready?: boolean;
            source: number;
            chat: number;
        };

        setupRoot ??= message.setupRoot;
        diagnostics += message.diagnostic ?? "";

        if (message.ready) {
            ready = { source: message.source, chat: message.chat };
        }
    });
    t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) {
            const exited = once(child, "exit");

            child.kill("SIGKILL");
            await exited;
        }

        if (setupRoot !== undefined) {
            rmSync(setupRoot, { recursive: true, force: true });
        }
    });
    await until(() => {
        assert.equal(child.exitCode, null, diagnostics);
        assert.equal(child.signalCode, null, diagnostics);

        return ready !== undefined;
    }, "disposable child holds the native writer and a real helper before crash").catch((error) => {
        throw new Error(String(error) + diagnostics);
    });
    const source = ready!.source as ConversationId;
    const chat = ready!.chat as ConversationId;
    const exited = once(child, "exit");

    child.kill("SIGKILL");
    await exited;
    let staleCalls = 0;
    const app = await openApp(
        scriptedModel((request) => {
            const system = JSON.stringify(
                request.messages.filter((message) => message.role === "system"),
            );
            const all = JSON.stringify(request.messages);
            const last = lastText(request);
            const privateRequest =
                system.includes("the owner's persistent private agent") ||
                all.includes("CRASH_PRIVATE_HELPER");

            if (privateRequest && !all.includes("FRESH_PRIVATE_AFTER_CRASH")) {
                staleCalls++;

                return fauxAssistantMessage(
                    [fauxToolCall("write", { path: stale, content: "old authority executed" })],
                    { stopReason: "toolUse" },
                );
            }

            if (last.role !== "user") {
                return fauxAssistantMessage("Fresh correction completed.");
            }

            return fauxAssistantMessage(
                [
                    fauxToolCall("write", {
                        path: privateRequest ? fresh : resumed,
                        content: privateRequest
                            ? "fresh owner correction"
                            : "native writer restored",
                    }),
                ],
                { stopReason: "toolUse" },
            );
        }),
        data,
    );

    t.after(() => app.close());
    await app.harness.waitForIdle(context);
    assert.equal(
        staleCalls,
        0,
        "neither old accepted root input nor inherited helper buys a successor decision",
    );
    assert.equal(existsSync(stale), false);
    assert.equal(app.workItems.itemFor(source)!.intervention, undefined);
    await say(app, source, "Continue with the original native writer after the process crash.");
    assert.equal(readFileSync(resumed, "utf8"), "native writer restored");
    await say(
        app,
        chat,
        "FRESH_PRIVATE_AFTER_CRASH: make the explicitly requested fresh correction.",
    );
    assert.equal(readFileSync(fresh, "utf8"), "fresh owner correction");
    assert.equal(staleCalls, 0);
    assert.equal(existsSync(stale), false);
});

test("authorized exact native input performs real coding without a borrowed private writer", async (t) => {
    const directory = mkdtempSync(join(root, "authorized-send-"));
    const escaped = join(directory, "native-authorized-write.txt");
    let source!: ConversationId;
    let step = 0;
    let nativeCalls = 0;
    const app = await openApp(
        scriptedModel((request) => {
            const system = JSON.stringify(
                request.messages.filter((message) => message.role === "system"),
            );

            if (!system.includes("the owner's persistent private agent")) {
                nativeCalls++;

                return lastText(request).role === "user"
                    ? fauxAssistantMessage(
                          [
                              fauxToolCall("write", {
                                  path: escaped,
                                  content: "native authorized effect",
                              }),
                          ],
                          { stopReason: "toolUse" },
                      )
                    : fauxAssistantMessage("The exact native writer completed its task.");
            }

            return step++ === 0
                ? fauxAssistantMessage(
                      [
                          fauxToolCall("agent_work", {
                              action: "send",
                              session: Number(source),
                              text: "Write the requested bounded file through this exact native writer.",
                              report: false,
                          }),
                      ],
                      { stopReason: "toolUse" },
                  )
                : fauxAssistantMessage("The exact native input was accepted with its own receipt.");
        }),
        join(root, "authorized-send-data"),
    );

    t.after(() => app.close());
    source = await newSession(app, directory, "worker");
    const created = await app.pip.agents.create(owner(app), {
        name: "Send safety fixture",
        requestId: "send-safety-fixture",
    });
    const chat = created.id as ConversationId;

    await say(app, chat, "Send this exact Worker its bounded native coding task.");
    const result = (await app.transcripts.allEntries(chat, true)).find(
        (entry) => entry.kind === "toolResult" && entry.name === "agent_work",
    );

    assert.ok(result?.kind === "toolResult");
    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /"status":"accepted"/);
    await until(
        () => existsSync(escaped) && !app.isBusy(source),
        "the real native coding task completes",
    );
    assert.equal(
        nativeCalls,
        2,
        "one native tool round and answer, without an unfenced title-model call",
    );
    assert.equal(readFileSync(escaped, "utf8"), "native authorized effect");
    assert.equal(app.workItems.itemFor(source)!.intervention, undefined);
});
