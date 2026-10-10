import { cleanUp, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { parsePiSession } from "../src/server/imports/pi-session.ts";
import { importFixture } from "./import-fixtures.ts";

after(cleanUp);

for (const tail of ["user", "toolUse", "toolResult"] as const) {
    test(`${tail}: live validation is provisional; saved-file defaults stay strict and aborted handoff requires complete tools`, () => {
        const folder = join(work, `parser-${tail}`);

        mkdirSync(folder);
        const { source, path } = importFixture(folder);

        source.appendMessage({ role: "user", content: "Pending user", timestamp: Date.now() });

        if (tail !== "user") {
            source.appendMessage({
                ...fauxAssistantMessage(""),
                stopReason: "toolUse",
                content: [
                    {
                        type: "toolCall",
                        id: "pending",
                        name: "read",
                        arguments: { path: "NEVER_READ" },
                    },
                ],
            });
        }

        if (tail === "toolResult") {
            source.appendMessage({
                role: "toolResult",
                toolCallId: "pending",
                toolName: "read",
                content: [{ type: "text", text: "Cancelled by owner" }],
                isError: true,
                timestamp: Date.now(),
            });
        }

        const archive = readFileSync(path, "utf8");

        assert.throws(() => parsePiSession(archive), /saved assistant|Incomplete tool/);
        assert.equal(parsePiSession(archive, undefined, "live").archive, archive);

        if (tail === "toolUse") {
            assert.throws(() => parsePiSession(archive, undefined, "aborted"), /Incomplete tool/);
            source.appendMessage(fauxAssistantMessage("", { stopReason: "aborted" }));
            assert.throws(
                () => parsePiSession(readFileSync(path, "utf8"), undefined, "live"),
                /interleaved tool/,
            );
        } else {
            assert.equal(parsePiSession(archive, undefined, "aborted").archive, archive);
        }

        assert.throws(
            () => parsePiSession(archive + "{broken", undefined, "live"),
            /Malformed JSONL/,
        );
        assert.equal(readFileSync(path, "utf8").startsWith(archive), true);
    });
}
