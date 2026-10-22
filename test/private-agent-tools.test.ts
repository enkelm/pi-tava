// Execution-capable private profile through registered native tools and disposable filesystem/model.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
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

test("named session_start delegates a real Worker through its controller with exact source provenance", async (t) => {
    let step = 0;
    const app = await openApp(
        scriptedModel((request) => {
            const system = JSON.stringify(
                request.messages.filter((message) => message.role === "system"),
            );

            if (system.includes("the owner's persistent private agent") && step++ === 0) {
                return fauxAssistantMessage(
                    [
                        fauxToolCall("session_start", {
                            title: "Native delegated task",
                            message:
                                "Coordinate this newly created native Work Item; observation only.",
                        }),
                    ],
                    { stopReason: "toolUse" },
                );
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
    await say(app, chat, "Start the named native task and delegate its first message.");
    const result = (await app.transcripts.allEntries(chat, true)).find(
        (entry) => entry.kind === "toolResult" && entry.name === "session_start",
    );

    assert.ok(result && result.kind === "toolResult", "actual session_start returns its receipt");
    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /"status":"accepted"/);
    const target = Object.entries(app.sessionCatalogue()).find(
        ([, meta]) => meta.title === "Native delegated task",
    );

    assert.ok(target, "registered start creates a native thread");
    const source = Number(target[0]) as ConversationId;
    const item = app.workItems.itemFor(source);

    assert.equal(target[1].threadType, "worker", "new work is not an ungrouped Chat");
    assert.ok(item?.supervisor, "preferred delegation uses its exact native controller");
    const controller = item.supervisor.conversationId as ConversationId;

    await until(() => !app.isBusy(controller), "new native controller finishes its observation");
    const messages = (await app.transcripts.allEntries(controller, true)).filter(
        (entry) => entry.kind === "user",
    );

    assert.equal(messages.length, 1);
    assert.match(messages[0]!.text, /Native starter/);
    assert.ok(
        messages[0]!.text.includes(`/s/${chat}`),
        "accepted provenance names its exact source chat",
    );
    assert.equal(
        (await app.transcripts.allEntries(source, true)).filter((entry) => entry.kind === "user")
            .length,
        0,
        "session_start uses preferred orchestrator delegation without also sending execution input",
    );
    assert.equal(
        app.parentOf(controller),
        undefined,
        "controller remains an independent native root",
    );
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
