import assert from "node:assert/strict";
import { test } from "node:test";
import { projectJournal } from "../src/server/private-sessions/journal.ts";

test("private model metadata follows the selected branch, even outside the displayed history", () => {
    const rows: Record<string, unknown>[] = [
        { type: "session", version: 3 },
        { type: "model_change", id: "model", parentId: null, provider: "faux", modelId: "faux-1" },
        {
            type: "message",
            id: "shared",
            parentId: "model",
            message: { role: "user", content: "Start" },
        },
        {
            type: "model_change",
            id: "abandoned",
            parentId: "shared",
            provider: "faux",
            modelId: "faux-2",
        },
        {
            type: "message",
            id: "selected",
            parentId: "shared",
            message: { role: "user", content: "Back on the first branch" },
        },
    ];
    const journal = () => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";

    assert.deepEqual(projectJournal(journal()).model, { provider: "faux", modelId: "faux-1" });
    rows.push({
        type: "model_change",
        id: "current",
        parentId: "selected",
        provider: "faux",
        modelId: "faux-2",
    });
    let parent = "current";

    for (let index = 0; index < 401; index++) {
        const id = `message-${index}`;

        rows.push({
            type: "message",
            id,
            parentId: parent,
            message: { role: "user", content: `Later ${index}` },
        });
        parent = id;
    }

    const projected = projectJournal(journal());

    assert.equal(projected.entries.length, 400);
    assert.deepEqual(projected.model, { provider: "faux", modelId: "faux-2" });
    // Pi also derives the current model from assistant records, including journals without a
    // corresponding model_change. The visible chip must match that independent Pi contract.
    rows.push({
        type: "message",
        id: "answer",
        parentId: parent,
        message: { role: "assistant", provider: "faux", model: "faux-vision", content: [] },
    });
    assert.deepEqual(projectJournal(journal()).model, { provider: "faux", modelId: "faux-vision" });
});
