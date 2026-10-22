// Real registered contact/subagent/coding tools survive a killed process without renewing old authority.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId, SubmissionId } from "@earendil-works/pi-durable";
import {
    type App,
    cleanUp,
    context,
    lastText,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";

after(cleanUp);

// Unlike a private-root crash, this source caller has finished: its accepted native Worker and
// background helper still need their original activation fences, not a newly authorized source.
test(
    "SIGKILL fences a contacted Worker and its pending native helper, while fresh human contact can still code",
    { timeout: 30_000 },
    async (t) => {
        const directory = mkdtempSync(join(root, "contact-crash-workspace-"));
        const data = join(root, "contact-crash-data");
        const marker = join(directory, "held-native-contact.json");
        const staleWorker = join(directory, "stale-worker.txt");
        const staleHelper = join(directory, "stale-helper.txt");
        const fresh = join(directory, "fresh-contact.txt");
        const script = `
        const assert = (await import("node:assert/strict")).default;
        const { writeFileSync } = await import("node:fs");
        const { fauxAssistantMessage, fauxToolCall } = await import(
            "@earendil-works/pi-ai/providers/faux"
        );
        const helpers = await import(${JSON.stringify(new URL("./helpers.ts", import.meta.url).href)});
        const { openApp, scriptedModel, newSession, owner, context, until, root } = helpers;

        process.send({ setupRoot: root });
        let worker;
        let workerEntered = false;
        let helperEntered = false;
        let privateStep = 0;
        const hold = () => new Promise(() => {});
        const tool = (name, args) => fauxAssistantMessage(
            [fauxToolCall(name, args)], { stopReason: "toolUse" }
        );
        const app = await openApp(scriptedModel(async (request) => {
            const system = JSON.stringify(
                request.messages.filter((message) => message.role === "system")
            );
            const last = helpers.lastText(request);

            if (system.includes("the owner's persistent private agent")) {
                if (privateStep++ === 0) {
                    return tool("agent_work", {
                        action: "send",
                        session: Number(worker),
                        text: "CRASH_CONTACT_WORKER: start the real helper, then hold this work.",
                        report: false,
                    });
                }

                assert.equal(JSON.parse(last.text).status, "accepted", last.text);

                return fauxAssistantMessage("Exact native contact accepted; caller finished.");
            }

            if (last.role === "user" && last.text.includes("CRASH_CONTACT_HELPER")) {
                helperEntered = true;
                await hold();
            }

            if (last.role === "user" && last.text.includes("CRASH_CONTACT_WORKER")) {
                return tool("subagent", {
                    action: "spawn",
                    name: "crash-contact-helper",
                    message: "CRASH_CONTACT_HELPER: hold this actual native helper request.",
                });
            }

            if (last.role === "toolResult") {
                assert.doesNotMatch(last.text, /blocked|Error:|not permitted/i);
                workerEntered = true;
                await hold();
            }

            throw new Error("Unexpected crash-fixture provider request: " + last.text);
        }), ${JSON.stringify(data)});

        worker = await newSession(app, ${JSON.stringify(directory)}, "worker");
        const chat = (await app.pip.agents.create(owner(app), {
            name: "Contact crash fixture",
            requestId: "contact-crash-fixture",
        })).id;
        setInterval(() => {}, 1000);
        const source = await app.commands.submit(chat, owner(app), {
            text: "Send the exact Worker its bounded task, then finish this caller.",
            requestId: "old-exact-contact",
        });
        const sourceResult = await (
            await app.harness.submission(source.submissionId, context)
        ).wait(context);

        assert.equal(sourceResult.status, "done");
        await until(() => workerEntered && helperEntered, "Worker and real helper are held");
        await until(() => !app.isBusy(chat), "private source caller has finished");
        const helper = app.subagents(owner(app)).find(
            (entry) => entry.id === Number(worker) && entry.name === "crash-contact-helper"
        );

        assert.ok(helper, "registered helper belongs to the exact contacted Worker");
        assert.equal(app.parentOf(helper.conversationId), worker);
        assert.equal(app.isBusy(worker), true);
        assert.equal(app.isBusy(helper.conversationId), true);
        const receipt = (await app.transcripts.allEntries(chat, true)).find(
            (entry) => entry.kind === "toolResult" && entry.name === "agent_work"
        );

        assert.ok(receipt && receipt.kind === "toolResult");
        assert.equal(receipt.isError, false, receipt.text);
        const accepted = JSON.parse(receipt.text);
        const native = await (
            await app.harness.submission(accepted.submissionId, context)
        ).status(context);

        assert.equal(accepted.session, Number(worker));
        assert.equal(native.conversationId, worker);
        assert.equal(native.status, "placed");
        const pending = (await app.harness.inspect(context)).submissions.find(
            (submission) => submission.conversationId === helper.conversationId
        );

        assert.equal(pending?.status, "placed", "real helper input is pending at SIGKILL");
        writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
            worker: Number(worker),
            chat: Number(chat),
            helper: Number(helper.conversationId),
            sourceSubmissionId: Number(source.submissionId),
            workerSubmissionId: Number(native.id),
            helperSubmissionId: Number(pending.id),
        }));
        process.send({ ready: true });
    `;
        const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
            cwd: process.cwd(),
            stdio: ["ignore", "pipe", "pipe", "ipc"],
        });
        let fixtureRoot: string | undefined;
        let ready = false;
        let diagnostics = "";
        let spawnError: Error | undefined;
        let app: App | undefined;

        t.after(async () => {
            if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
                const exited = once(child, "exit");

                child.kill("SIGKILL");
                await exited;
            }

            await app?.close();

            if (fixtureRoot !== undefined) {
                rmSync(fixtureRoot, { recursive: true, force: true });
            }
        });
        assert.ok(child.stdout);
        assert.ok(child.stderr);
        child.stdout.on("data", (value) => {
            diagnostics += String(value);
        });
        child.stderr.on("data", (value) => {
            diagnostics += String(value);
        });
        child.on("error", (error) => {
            spawnError = error;
        });
        child.on("message", (value: unknown) => {
            if (typeof value !== "object" || value === null) {
                return;
            }

            if ("setupRoot" in value && typeof value.setupRoot === "string") {
                fixtureRoot = value.setupRoot;
            }

            if ("ready" in value && value.ready === true) {
                ready = true;
            }
        });
        await until(() => {
            assert.equal(spawnError, undefined);
            assert.equal(child.exitCode, null, diagnostics);
            assert.equal(child.signalCode, null, diagnostics);

            return ready;
        }, "finished private caller and both held native provider requests").catch((error) => {
            throw new Error(`${String(error)}\n${diagnostics}`);
        });
        const saved = JSON.parse(readFileSync(marker, "utf8")) as {
            worker: ConversationId;
            chat: ConversationId;
            helper: ConversationId;
            sourceSubmissionId: SubmissionId;
            workerSubmissionId: SubmissionId;
            helperSubmissionId: SubmissionId;
        };
        const exited = once(child, "exit");

        assert.equal(child.kill("SIGKILL"), true, "kill only the disposable app process");
        const [code, signal] = await exited;

        assert.equal(code, null);
        assert.equal(signal, "SIGKILL");
        const staleCalls: string[] = [];
        let freshRequested = false;

        app = await openApp(
            scriptedModel((request) => {
                const system = JSON.stringify(
                    request.messages.filter((message) => message.role === "system"),
                );
                const last = lastText(request);
                const latestUser = request.messages.findLast((message) => message.role === "user");
                const freshInput =
                    freshRequested &&
                    latestUser !== undefined &&
                    lastText({ messages: [latestUser] }).text.includes("FRESH_CONTACT_AFTER_CRASH");

                if (!freshInput) {
                    staleCalls.push(last.text);

                    return last.role === "toolResult"
                        ? fauxAssistantMessage("Unexpected old activation reached the provider.")
                        : fauxAssistantMessage(
                              [
                                  fauxToolCall("write", {
                                      path: system.includes("crash-contact-helper")
                                          ? staleHelper
                                          : staleWorker,
                                      content: "stale private-derived effect replayed",
                                  }),
                              ],
                              { stopReason: "toolUse" },
                          );
                }

                if (system.includes("the owner's persistent private agent")) {
                    if (last.role === "user") {
                        return fauxAssistantMessage(
                            [
                                fauxToolCall("agent_work", {
                                    action: "send",
                                    session: Number(saved.worker),
                                    text: "FRESH_CONTACT_AFTER_CRASH: write the freshly authorized file.",
                                    report: false,
                                }),
                            ],
                            { stopReason: "toolUse" },
                        );
                    }

                    assert.equal(JSON.parse(last.text).status, "accepted", last.text);

                    return fauxAssistantMessage("Fresh exact contact accepted.");
                }

                if (last.role === "user") {
                    return fauxAssistantMessage(
                        [fauxToolCall("write", { path: fresh, content: "fresh native contact" })],
                        { stopReason: "toolUse" },
                    );
                }

                assert.doesNotMatch(last.text, /blocked|Error:|permission_denied|not permitted/i);

                return fauxAssistantMessage("Fresh native coding completed.");
            }),
            data,
        );
        const reopened = app;

        await reopened.harness.waitForIdle(context);
        await until(
            async () =>
                !reopened.isBusy(saved.worker) &&
                !reopened.isBusy(saved.helper) &&
                (await reopened.harness.inspect(context)).tasks.length === 0,
            "interrupted Worker, helper and native reporter settle without provider replay",
        );

        for (const submission of [saved.workerSubmissionId, saved.helperSubmissionId]) {
            const result = await (await reopened.harness.submission(submission, context))!.status(
                context,
            );

            assert.equal(
                result.status,
                "unanswered",
                "crashed native input is not renewed or completed",
            );
        }

        assert.equal(
            (
                await (await reopened.harness.submission(
                    saved.sourceSubmissionId,
                    context,
                ))!.status(context)
            ).status,
            "done",
            "the private caller had finished before its independently owned recipients crashed",
        );
        assert.deepEqual(staleCalls, [], "neither old native input buys another provider request");
        assert.equal(existsSync(staleWorker), false);
        assert.equal(existsSync(staleHelper), false);
        freshRequested = true;
        await say(
            reopened,
            saved.chat,
            "FRESH_CONTACT_AFTER_CRASH: explicitly send the same Worker a new bounded coding task.",
        );
        const freshReceipt = (await reopened.transcripts.allEntries(saved.chat, true)).findLast(
            (entry) => entry.kind === "toolResult" && entry.name === "agent_work",
        );

        assert.ok(freshReceipt?.kind === "toolResult");
        assert.equal(freshReceipt.isError, false, freshReceipt.text);
        const accepted = JSON.parse(freshReceipt.text);

        assert.equal(accepted.status, "accepted", freshReceipt.text);
        assert.equal(accepted.session, Number(saved.worker));
        await until(
            () => existsSync(fresh) && !reopened.isBusy(saved.worker),
            "fresh human input reaches the same Worker and its real registered coding tool",
        );
        const native = await (await reopened.harness.submission(
            accepted.submissionId,
            context,
        ))!.wait(context);

        assert.equal(native.conversationId, saved.worker);
        assert.equal(native.status, "done", "fresh native input completes through actual coding");
        assert.equal(readFileSync(fresh, "utf8"), "fresh native contact");
        assert.deepEqual(
            staleCalls,
            [],
            "fresh contact does not renew the old helper or source input",
        );
        assert.equal(existsSync(staleWorker), false);
        assert.equal(existsSync(staleHelper), false);
        assert.equal(reopened.parentOf(saved.helper), saved.worker);
        assert.equal(
            reopened.subagents(owner(reopened)).filter((entry) => entry.id === Number(saved.worker))
                .length,
            1,
            "restart and fresh contact reuse the exact Worker without synthesizing another helper",
        );
    },
);
