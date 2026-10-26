// Real native delivery/request crash windows, not restart only after a completed batch.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { AgentSupervisionDoc } from "../src/server/pip/agent-supervision.ts";
import {
    cleanUp,
    context,
    lastText,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";

after(cleanUp);

// Each window owns a distinct lifecycle risk: absent admission must deliver once; native
// acceptance must reconcile without a second input; an uncertain paid request must not replay.
// The subprocess uses registered tools and exits without graceful task settlement.
for (const phase of ["pre-submit", "accepted", "running"] as const) {
    test(`parent continuation restart at ${phase} retains original authority and one native receipt`, async (t) => {
        const data = join(root, `parent-crash-${phase}`);
        const child = spawn(
            process.execPath,
            ["test/fixtures/parent-continuation-interruption.ts", phase, data],
            { stdio: ["ignore", "ignore", "pipe"] },
        );
        let diagnostics = "";

        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (text: string) => {
            diagnostics += text;
        });
        const deadline = setTimeout(() => child.kill("SIGKILL"), 15_000);
        const code = await new Promise<number | null>((resolve, reject) => {
            child.once("error", reject);
            child.once("close", resolve);
        }).finally(() => clearTimeout(deadline));

        assert.equal(code, 0, diagnostics || "fixture missed its native crash window");
        const saved = JSON.parse(await readFile(join(data, "interrupted-parent.json"), "utf8")) as {
            fixtureRoot: string;
            chat: ConversationId;
            controller: ConversationId;
            key: string;
            ownerInputId: number;
            ownerSerial: number;
            wakeId: string;
            wakeRequestId: string;
            nativeSubmission?: number;
            parentInvocations: number;
        };
        let invocations = 0;
        const model = scriptedModel((request) => {
            const system = JSON.stringify(
                request.messages.filter((message) => message.role === "system"),
            );

            if (system.includes("the owner's persistent private agent")) {
                invocations++;
                const last = lastText(request);

                assert.equal(last.role, "user");
                assert.match(last.text, /App registered continuation/);
                assert.ok(last.text.includes(`accepted owner input ${saved.ownerInputId}`));
                assert.ok(last.text.includes(`/s/${saved.controller}`));

                return fauxAssistantMessage(
                    [
                        fauxToolCall("work_supervise", {
                            action: "ask",
                            text: "Inspect A's native evidence before expanding the original owner scope.",
                        }),
                    ],
                    { stopReason: "toolUse" },
                );
            }

            throw new Error("Recovery must not regenerate a child controller or unrelated input.");
        });
        let app = await openApp(model, data);

        t.after(async () => {
            await app.close();
            await rm(saved.fixtureRoot, { recursive: true, force: true });
        });
        await until(
            async () =>
                !app.isBusy(saved.chat) &&
                (await app.pip.agents.supervision.parentContext(saved.chat, owner(app)))[0]
                    ?.status === "blocked",
            "recovered continuation asks its owner or holds the uncertain request",
        );

        const inspect = async () => {
            const state = (await app.harness.snapshot(AgentSupervisionDoc, context))!;
            const task = state.parentTasks![saved.key]!;
            const native = await app.harness.commit(
                (tx) => tx.submissionByRequest(saved.chat, saved.wakeRequestId),
                context,
            );

            assert.ok(native?.type === "input");
            assert.equal(task.wake!.submissionId, Number(native.id));
            assert.equal(task.wake!.id, saved.wakeId);
            assert.equal(task.wake!.requestId, saved.wakeRequestId);
            assert.equal(task.admittedWakes, 1);
            assert.equal(task.authority.inputId, saved.ownerInputId);
            assert.equal(task.authority.admissionSerial, saved.ownerSerial);
            assert.equal(task.authority.chatId, Number(saved.chat));
            assert.equal(task.consumed.length, 1);
            assert.equal(
                Object.values(state.admissions!).filter((pin) => pin.parentTask === saved.key)
                    .length,
                1,
                "one derived admission, not a new owner input on recovery",
            );

            if (saved.nativeSubmission !== undefined) {
                assert.equal(Number(native.id), saved.nativeSubmission);
            }

            if (phase === "running") {
                assert.match(task.reason!, /interrupted|uncertain/);
            }
        };

        await inspect();
        assert.equal(saved.parentInvocations + invocations, 1, "no duplicate native invocation");
        assert.equal(invocations, phase === "running" ? 0 : 1);
        await app.close();
        app = await openApp(model, data);
        await app.pip.agents.supervision.open();
        await inspect();
        assert.equal(saved.parentInvocations + invocations, 1, "blocked receipt stays quiet");
    });
}
