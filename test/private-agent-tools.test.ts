// Execution-capable private profile through registered native tools and disposable filesystem/model.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentSupervisionDoc } from "../src/server/pip/agent-supervision.ts";
import { PipWorkDoc, SessionCreatesDoc } from "../src/server/docs.ts";
import {
    cleanUp,
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

test("named agents refuse legacy owner-account mutations without a native private source adapter", async (t) => {
    let target = 0;
    let step = 0;
    const app = await openApp(
        scriptedModel(() => {
            if (step++ === 0) {
                return fauxAssistantMessage([fauxToolCall("session_read", { session: target })], {
                    stopReason: "toolUse",
                });
            }

            if (step === 2) {
                return fauxAssistantMessage(
                    [
                        fauxToolCall("session_schedule", {
                            action: "add",
                            session: target,
                            when: "in 1h",
                            message: "Unadapted delayed work",
                        }),
                        fauxToolCall("repo_watch", {
                            action: "add",
                            repo: "example/private",
                            events: ["issues"],
                            instructions: "Unadapted event work",
                        }),
                        fauxToolCall("session_watch_pr", {
                            action: "start",
                            session: target,
                            pr: "1",
                        }),
                        fauxToolCall("session_archive", { session: target }),
                    ],
                    { stopReason: "toolUse" },
                );
            }

            return fauxAssistantMessage(
                "Refusals stay explicit; no unadapted automation was created.",
            );
        }),
    );

    t.after(() => app.close());
    target = Number(await newSession(app, undefined, "worker"));
    const made = await app.pip.agents.create(owner(app), {
        name: "Native safety",
        requestId: "native-adapter-refusals",
    });
    const chat = made.id as ConversationId;

    await app.commands.configure(chat, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });
    await say(
        app,
        chat,
        "Read the work, then try each legacy owner-account mutation without inventing a private adapter.",
    );
    const results = (await app.transcripts.allEntries(chat, true)).filter(
        (entry) => entry.kind === "toolResult",
    );
    const read = results.find((entry) => entry.name === "session_read");

    assert.ok(read, "the registered native read must complete before mutation attempts");
    assert.equal(read.isError, false, read.text);

    for (const name of ["session_schedule", "repo_watch", "session_watch_pr", "session_archive"]) {
        const result = results.find((entry) => entry.name === name);

        assert.ok(result, `registered ${name} must return its native refusal`);
        assert.equal(result.isError, true, result.text);
        assert.match(
            result.text,
            /source-authority and origin-pinned adapter|no (?:native|accepted).*adapter/,
        );
    }

    assert.deepEqual(await app.schedules.list(target as ConversationId), []);
    assert.deepEqual(await app.repoWatches.list(owner(app)), []);
    assert.equal(app.sessionMeta(target as ConversationId)?.archived, undefined);
});

test("named handoff retains its Chat and returns one native controller assignment usable by continuation", async (t) => {
    let step = 0;
    const app = await openApp(
        scriptedModel((request) => {
            const system = JSON.stringify(
                request.messages.filter((message) => message.role === "system"),
            );

            if (system.includes("the owner's persistent private agent")) {
                switch (step++) {
                    case 0:
                        return fauxAssistantMessage([fauxToolCall("handoff", { action: "status" })], { stopReason: "toolUse" });
                    case 1:
                        return fauxAssistantMessage([fauxToolCall("handoff", {
                            action: "start",
                            targetType: "reviewer",
                            relationship: "new-work",
                            summary: "Unsupported new-work role must refuse, never silently retarget.",
                        })], { stopReason: "toolUse" });
                    case 2:
                        return fauxAssistantMessage([fauxToolCall("handoff", {
                            action: "start",
                            targetType: "worker",
                            relationship: "new-work",
                            title: "Native delegated task",
                            summary: "Coordinate this newly created native Work Item; observation only.",
                        })], { stopReason: "toolUse" });
                    case 3: {
                        const result = lastText(request);
                        let receipt: { status?: string; requestId?: string } = {};

                        try {
                            receipt = JSON.parse(result.text);
                        } catch {
                            return fauxAssistantMessage("The handoff failed; no duplicate assignment.");
                        }

                        return receipt.status === "accepted"
                            ? fauxAssistantMessage([fauxToolCall("work_supervise", {
                                action: "wait",
                                text: "Wait for the exact child assignment.",
                                continuation: { requestId: receipt.requestId, remaining: "Inspect its observation within the original owner scope." },
                            })], { stopReason: "toolUse" })
                            : fauxAssistantMessage("The native assignment was not accepted.");
                    }
                }
            }

            return fauxAssistantMessage("Native task acknowledged.");
        }),
    );

    t.after(() => app.close());
    // A human-selected PiP model is the native controller's existing creation default, not
    // an invented model choice or a private identity's inherited project setting.
    const generic = await app.pip.ensure(owner(app));

    await app.commands.configure(generic, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });
    const created = await app.pip.agents.create(owner(app), {
        name: "Native starter",
        requestId: "native-starter",
    });
    const chat = created.id as ConversationId;

    await app.commands.configure(chat, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });
    const direction = "SOURCE_PRIVATE_SENTINEL is unrelated private context; do not export it. Hand a new observation-only Work Item to a Worker; retain this private Chat and wait on the exact assignment. No publication.";

    await app.commands.submit(chat, owner(app), { text: direction, requestId: "named-handoff-owner-task" });
    await until(async () => !app.isBusy(chat) && (await app.transcripts.allEntries(chat, true)).filter(
        (entry) => entry.kind === "toolResult" && entry.name === "handoff",
    ).length === 3, "named handoff and continuation registration settle");
    const entries = await app.transcripts.allEntries(chat, true);
    const results = entries.filter((entry) => entry.kind === "toolResult" && entry.name === "handoff");
    const status = results[0];
    const refused = results[1];
    const result = results[2];

    assert.ok(status && status.kind === "toolResult");
    assert.equal(status.isError, false, status.text);
    assert.ok(JSON.parse(status.text).options.some((option: { targetType: string; enabled: boolean }) => option.targetType === "worker" && option.enabled));
    assert.ok(refused && refused.kind === "toolResult");
    assert.equal(refused.isError, true, refused.text);
    assert.match(refused.text, /available new-work starter/);
    assert.ok(!JSON.parse(status.text).options.some((option: { targetType: string; enabled: boolean }) => option.targetType === "reviewer" && option.enabled));
    assert.ok(result && result.kind === "toolResult", "actual handoff returns its receipt");
    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /"status":"accepted"/);
    const receipt = JSON.parse(result.text);
    const brief = await readFile(receipt.file, "utf8");

    assert.match(receipt.file, /pi-coop-handoff-[^/]+\/handoff\.md$/);
    assert.doesNotMatch(brief, /SOURCE_PRIVATE_SENTINEL/, "only the delegated brief, not the whole private instruction, is exported");
    assert.ok(brief.includes(`/s/${chat}`), "the saved brief retains exact native source Chat provenance");
    assert.ok(brief.includes("Coordinate this newly created native Work Item; observation only."));
    assert.equal(receipt.sourceChatId, Number(chat));
    assert.equal(app.sessionMeta(chat)?.threadType, "chat");
    assert.equal(app.workItems.itemFor(chat), undefined, "private source is not enrolled in execution");
    assert.equal(app.workItems.isReadOnly(chat), false, "private source is not retired");
    const target = Object.entries(app.sessionCatalogue()).find(
        ([, meta]) => meta.title === "Native delegated task",
    );

    assert.ok(target, "registered start creates a native thread");
    const source = Number(target[0]) as ConversationId;
    const item = app.workItems.itemFor(source);

    assert.equal(target[1].threadType, "worker", "new work is not an ungrouped Chat");
    assert.ok(item?.supervisor, "preferred delegation uses its exact native controller");
    const controller = item.supervisor.conversationId as ConversationId;

    assert.equal(receipt.controllerId, Number(controller));
    assert.equal(receipt.threadId, Number(source));
    assert.equal(receipt.workItemId, item.id);
    const supervision = await app.harness.snapshot(AgentSupervisionDoc, BACKGROUND_CONTEXT);
    const accepted = Object.values(supervision!.requests).find((entry) => entry.requestId === receipt.requestId);

    assert.equal(Object.values(supervision!.requests).filter((entry) => entry.chatId === Number(chat) && entry.status === "accepted").length, 1, "one real assignment; the refused role did not create or send work");
    assert.equal(accepted?.action, "send");
    assert.equal(accepted?.controllerContact, true);
    assert.equal(accepted?.chatId, Number(chat));
    assert.equal(accepted?.agentId, receipt.agentId);
    const controllerState = await app.harness.snapshot(PipWorkDoc, controller, BACKGROUND_CONTEXT);

    assert.equal(controllerState?.assignment?.requestId, receipt.requestId);
    assert.equal(controllerState?.assignment?.submissionId, receipt.submissionId);
    const wait = entries.find((entry) => entry.kind === "toolResult" && entry.name === "work_supervise");

    assert.ok(wait && wait.kind === "toolResult", "the accepted creation receipt can register continuation without another send");
    assert.equal(wait.isError, false, wait.text);
    const parent = Object.values(supervision?.parentTasks ?? {}).find((task) => task.authority.chatId === Number(chat));

    assert.equal(parent?.dependency.requestId, receipt.requestId);
    assert.equal(parent?.dependency.controller, Number(controller));
    assert.equal(parent?.dependency.submission, receipt.submissionId);
    await until(() => !app.isBusy(controller), "new native controller finishes its observation");
    const messages = (await app.transcripts.allEntries(controller, true)).filter(
        (entry) => entry.kind === "user",
    );

    assert.equal(messages.length, 1);
    assert.match(messages[0]!.text, /Native starter/);
    assert.doesNotMatch(messages[0]!.text, /SOURCE_PRIVATE_SENTINEL/);
    assert.ok(
        messages[0]!.text.includes(`/s/${chat}`),
        "accepted provenance names its exact source chat",
    );
    assert.equal(
        (await app.transcripts.allEntries(source, true)).filter((entry) => entry.kind === "user")
            .length,
        0,
        "handoff uses native controller assignment without also sending execution input",
    );
    assert.equal(
        app.parentOf(controller),
        undefined,
        "controller remains an independent native root",
    );
});

test("named exact-recipient handoff status preserves the controller's pending question refusal", async (t) => {
    let target = 0;
    let controller = 0;
    let phase: "attach" | "handoff" = "attach";
    let step = 0;
    const app = await openApp(scriptedModel((request) => {
        const system = JSON.stringify(
            request.messages.filter((message) => message.role === "system"),
        );

        if (system.includes("the private supervisor for Work Item")) {
            return fauxAssistantMessage([fauxToolCall("work_supervise", {
                action: "ask",
                text: "Which bounded next step does the owner authorize?",
            })], { stopReason: "toolUse" });
        }

        if (phase === "attach") {
            return step++ === 0
                ? fauxAssistantMessage([fauxToolCall("agent_work", {
                    action: "send",
                    session: controller,
                    text: "Inspect the existing execution and ask for its next bounded step.",
                    report: false,
                })], { stopReason: "toolUse" })
                : fauxAssistantMessage("Wait for the exact native controller question.");
        }

        switch (step++) {
            case 0:
                return fauxAssistantMessage([fauxToolCall("handoff", {
                    action: "status",
                    session: target,
                })], { stopReason: "toolUse" });
            case 1:
                return fauxAssistantMessage([fauxToolCall("handoff", {
                    action: "start",
                    session: target,
                    summary: "Do not bypass its pending exact owner decision.",
                    report: false,
                })], { stopReason: "toolUse" });
            default:
                return fauxAssistantMessage("The exact question remains pending; no assignment.");
        }
    }), join(root, "named-handoff-question-admission"));

    t.after(() => app.close());
    const execution = await newSession(app, undefined, "worker");
    const opened = await app.pip.orchestration.control(execution, owner(app), { action: "open" });

    target = Number(execution);
    controller = opened.orchestration!.conversationId;
    const made = await app.pip.agents.create(owner(app), {
        name: "Exact question parent",
        requestId: "named-handoff-question-parent",
    });
    const chat = made.id as ConversationId;

    await app.commands.configure(chat, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });
    await say(app, chat, "Contact the exact controller and ask for its next bounded step.");
    await until(async () => !app.isBusy(controller as ConversationId) &&
        (await app.harness.snapshot(PipWorkDoc, controller as ConversationId, BACKGROUND_CONTEXT))?.question !== undefined,
    "the attached controller has asked its real exact question");
    const before = await app.harness.snapshot(PipWorkDoc, controller as ConversationId, BACKGROUND_CONTEXT);

    phase = "handoff";
    step = 0;
    await say(app, chat, "Inspect handoff availability for the exact execution recipient; preserve its pending question.");
    const results = (await app.transcripts.allEntries(chat, true)).filter(
        (entry) => entry.kind === "toolResult" && entry.name === "handoff",
    );

    assert.equal(results.length, 2);
    assert.equal(results[0]!.isError, false, results[0]!.text);
    const status = JSON.parse(results[0]!.text);

    assert.equal(status.options.length, 1);
    assert.equal(status.options[0].session, target, "status must not silently select the controller");
    assert.equal(status.options[0].enabled, false);
    assert.match(status.options[0].reason, /requires an owner answer/);
    assert.equal(results[1]!.isError, true, results[1]!.text);
    assert.match(results[1]!.text, /requires an owner answer/);
    assert.equal((await app.harness.snapshot(PipWorkDoc, controller as ConversationId, BACKGROUND_CONTEXT))?.question?.id, before?.question?.id);
    assert.equal((await app.transcripts.allEntries(execution, true)).filter(
        (entry) => entry.kind === "user",
    ).length, 0, "the refused handoff must not send execution input");
});

// These holds cross real registered-tool preparation, not an adapter around the whole start call.
// The first catches continued repository effects; the second reaches the final creation transaction.
test("a superseded named handoff cannot continue repository preparation or publish its prepared session", async (t) => {
    for (const boundary of ["repository", "publication"] as const) {
        await t.test(boundary, async (t) => {
            let release = () => {};
            const held = new Promise<void>((resolve) => {
                release = resolve;
            });
            let entered = false;
            let clones = 0;
            const title = `Superseded native creation ${boundary}`;
            const app = await openApp(
                scriptedModel((request) => {
                    const system = JSON.stringify(
                        request.messages.filter((message) => message.role === "system"),
                    );
                    const last = lastText(request);

                    if (
                        system.includes("the owner's persistent private agent") &&
                        last.role === "user" &&
                        last.text.includes("PREPARE_NAMED_CREATION")
                    ) {
                        return fauxAssistantMessage(
                            [
                                fauxToolCall("handoff", {
                                    action: "start",
                                    targetType: "worker",
                                    relationship: "new-work",
                                    title,
                                    summary: "Prepare one bounded native Work Item; no publication approval.",
                                    ...(boundary === "repository"
                                        ? { repo: "fixture/stale-creation" }
                                        : {}),
                                }),
                            ],
                            { stopReason: "toolUse" },
                        );
                    }

                    return fauxAssistantMessage(
                        "Respect the current owner direction; do not create more work.",
                    );
                }),
                join(root, `named-creation-source-fence-${boundary}`),
            );

            t.after(async () => {
                release();
                await app.close();
            });
            const generic = await app.pip.ensure(owner(app));

            await app.commands.configure(generic, owner(app), {
                model: { provider: "faux", modelId: "faux-1" },
                thinkingLevel: "off",
            });
            const made = await app.pip.agents.create(owner(app), {
                name: "Creation fence parent",
                requestId: `creation-fence-${boundary}`,
            });
            const chat = made.id as ConversationId;

            await app.commands.configure(chat, owner(app), {
                model: { provider: "faux", modelId: "faux-1" },
                thinkingLevel: "off",
            });
            const before = Object.keys(app.sessionCatalogue()).sort();

            if (boundary === "repository") {
                t.mock.method(app.watches, "gh", async (args: string[]) => {
                    if (args[0] === "api") {
                        entered = true;
                        await held;

                        return JSON.stringify({
                            full_name: "fixture/stale-creation",
                            default_branch: "main",
                            permissions: { push: true },
                        });
                    }

                    clones++;

                    throw new Error("A superseded preparation reached repository cloning.");
                });
            } else {
                const create = app.harness.createConversation.bind(app.harness);

                t.mock.method(
                    app.harness,
                    "createConversation",
                    async (...args: Parameters<typeof create>) => {
                        if (!entered) {
                            entered = true;
                            await held;
                        }

                        return create(...args);
                    },
                );
            }

            const original = await app.commands.submit(chat, owner(app), {
                text: "PREPARE_NAMED_CREATION: hand a new bounded Work Item to a Worker.",
                requestId: `prepare-native-creation-${boundary}`,
            });

            await until(() => entered, "the registered handoff is held inside native preparation");
            const replacement = await app.commands.submit(chat, owner(app), {
                text: "Replace the earlier task. Do not create or assign that Work Item.",
                requestId: `supersede-native-creation-${boundary}`,
            });

            release();
            await (
                await app.harness.submission(original.submissionId, BACKGROUND_CONTEXT)
            )!.wait(BACKGROUND_CONTEXT);
            await (
                await app.harness.submission(replacement.submissionId, BACKGROUND_CONTEXT)
            )!.wait(BACKGROUND_CONTEXT);
            await until(() => !app.isBusy(chat), "the old tool and replacement owner input settle");
            assert.equal(clones, 0, "superseded repository metadata must not authorize cloning");
            assert.deepEqual(
                Object.keys(app.sessionCatalogue()).sort(),
                before,
                "the final native transaction must not publish a stale execution or controller",
            );
            const creates = await app.harness.snapshot(SessionCreatesDoc, BACKGROUND_CONTEXT);

            assert.equal(
                Object.keys(creates!.items).length,
                0,
                "failed native creation must not save a retry receipt",
            );
            const supervision = await app.harness.snapshot(AgentSupervisionDoc, BACKGROUND_CONTEXT);

            assert.equal(
                Object.values(supervision!.requests).filter(
                    (request) => request.chatId === Number(chat) && request.status === "accepted",
                ).length,
                0,
                "no assignment may activate from the superseded owner task",
            );
            assert.equal(app.workItems.itemFor(chat), undefined);
            assert.equal(app.workItems.isReadOnly(chat), false);
        });
    }
});

test("a persistent private agent writes and edits an authorized temporary handoff without another agent", async (t) => {
    const file = join(root, "authorized-workspace", "handoff.md");
    let step = 0;
    let prompt = "";
    const app = await openApp(
        scriptedModel((request) => {
            prompt = JSON.stringify(
                request.messages.filter((message) => message.role === "system"),
            );

            switch (step++) {
                case 0:
                    return fauxAssistantMessage(
                        [
                            fauxToolCall("write", {
                                path: file,
                                content: "# Correction\nOriginal task context.\n",
                            }),
                        ],
                        { stopReason: "toolUse" },
                    );
                case 1:
                    return fauxAssistantMessage(
                        [
                            fauxToolCall("edit", {
                                path: file,
                                oldText: "Original task context.",
                                newText:
                                    "Corrected task context; continuation stays human-authorized.",
                            }),
                        ],
                        { stopReason: "toolUse" },
                    );
                case 2:
                    return fauxAssistantMessage(
                        [
                            fauxToolCall("bash", {
                                command: `test -s '${file}' && printf 'PRIVATE_AGENT_CHECK_OK'`,
                            }),
                        ],
                        { stopReason: "toolUse" },
                    );
                default:
                    return fauxAssistantMessage(`Local check result: ${lastText(request).text}`);
            }
        }),
    );

    t.after(() => app.close());
    const made = await app.pip.agents.create(owner(app), {
        name: "Practical agent",
        requestId: "practical-agent",
    });
    const chat = made.id as ConversationId;

    await app.commands.configure(chat, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });
    await say(
        app,
        chat,
        "Write a temporary handoff, correct its task context, and run the local file check yourself; do not publish or create another agent.",
    );
    const entries = await app.transcripts.allEntries(chat, true);

    const results = entries.filter((entry) => entry.kind === "toolResult");

    const written = results.find((entry) => entry.name === "write");

    assert.equal(
        written?.isError,
        false,
        `the real write tool must execute: ${written?.text ?? "no result"}`,
    );
    assert.doesNotMatch(
        prompt,
        /You do not execute code|never directly to execution threads|only to explicitly attached/i,
    );
    assert.equal(
        await readFile(file, "utf8"),
        "# Correction\nCorrected task context; continuation stays human-authorized.\n",
    );
    assert.deepEqual(
        results
            .filter((entry) => entry.isError && entry.name !== "bash")
            .map((entry) => ({ name: entry.name, error: entry.text })),
        [],
    );
    await t.test(
        "the native confined shell executes the file check when the host permits its sandbox",
        (check) => {
            const shell = results.find((entry) => entry.name === "bash");

            assert.ok(shell, "the registered bash tool must be available");

            if (
                shell.isError &&
                shell.text.includes("sandbox-exec: sandbox_apply: Operation not permitted")
            ) {
                check.skip(
                    "Managed macOS environment refuses nested sandbox-exec (exit 71); no unrestricted fallback permitted.",
                );

                return;
            }

            assert.equal(shell.isError, false, shell.text);
            assert.ok(shell.text.includes("PRIVATE_AGENT_CHECK_OK"));
        },
    );
    assert.equal(app.subagents().length, 0, "direct tools need no artificial helper");
});
