// Crash/reopen through real native admission publications and disposable storage; no collaborator mocks.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { cleanUp, openApp, owner, root, scriptedModel, until } from "./helpers.ts";

after(cleanUp);

for (const phase of ["admission", "outbox"]) {
    test(`restart recovers interrupted private ${phase} without duplicate native input or origin-chat delivery`, async (t) => {
        const data = join(root, `interrupted-${phase}`);
        const child = spawn(
            process.execPath,
            ["test/fixtures/private-agent-interruption.ts", phase, data],
            {
                stdio: ["ignore", "ignore", "pipe"],
            },
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
        });

        clearTimeout(deadline);
        assert.equal(
            code,
            0,
            diagnostics || "fixture failed to reach the selected committed boundary",
        );
        const saved = JSON.parse(await readFile(join(data, "interrupted.json"), "utf8")) as {
            firstChat: ConversationId;
            chat: ConversationId;
            controller: ConversationId;
            controllerCalls: number;
            fixtureRoot: string;
        };
        let controllerCalls = 0;
        const model = scriptedModel((request) => {
            if (JSON.stringify(request.messages).includes("the private supervisor for Work Item")) {
                controllerCalls++;

                return fauxAssistantMessage("RECOVERED_NATIVE_OBSERVATION");
            }

            return fauxAssistantMessage("Coordinator acknowledged its recovered admission.");
        });
        let app = await openApp(model, data);

        t.after(async () => {
            await app.close();
            await rm(saved.fixtureRoot, { recursive: true, force: true });
        });
        await until(
            async () =>
                (await app.pip.agents.supervision.status(saved.chat, owner(app))).reports?.some(
                    (report) => report.status === "delivered",
                ) === true,
            "interrupted passive report is delivered",
        );
        await until(
            () => !app.isBusy(saved.chat) && !app.isBusy(saved.controller),
            "recovered native work settles",
        );
        const delegated = (await app.transcripts.allEntries(saved.controller, true)).filter(
            (entry) => entry.kind === "user",
        );
        const reports = () =>
            app.transcripts
                .allEntries(saved.chat, true)
                .then((entries) =>
                    entries.filter(
                        (entry) => entry.kind === "appEvent" && entry.event === "report",
                    ),
                );

        assert.equal(delegated.length, 1, "the exact accepted native intent is submitted once");
        assert.equal(
            (await app.transcripts.allEntries(saved.firstChat, true)).some(
                (entry) => entry.kind === "appEvent" && entry.event === "report",
            ),
            false,
            "recovery never redirects an originating-task report to the first/arbitrary chat",
        );
        assert.ok(
            (await app.pip.agents.supervision.status(saved.chat, owner(app))).reports?.every(
                (report) => report.originChatId === Number(saved.chat),
            ),
        );
        assert.equal(
            (await reports()).length,
            1,
            "pending outbox recovery appends one passive report",
        );
        assert.equal(
            saved.controllerCalls + controllerCalls,
            1,
            "recovery does not repeat a completed native response",
        );
        await app.close();
        app = await openApp(model, data);
        assert.equal(
            (await reports()).length,
            1,
            "delivered receipt remains deduplicated on another restart",
        );
        assert.equal(saved.controllerCalls + controllerCalls, 1);
    });
}
