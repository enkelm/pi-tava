// Pi's sessions from the terminal, continued here: Pi gets the context Pi itself builds from the file, people get the
// whole conversation, nothing Pi did runs again, the file is never written, and only the owner can do it.
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
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep, Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
    buildSessionContext,
    convertToLlm,
    parseSessionEntries,
    type SessionEntry,
    SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ConversationId } from "@earendil-works/pi-durable";
import { parsePiSession } from "../src/server/pi-sessions/source.ts";

/** The messages of the newest request to the model. */
let requested: Message[] = [];

const route: FauxResponseStep = (request) => {
    requested = (request as { messages: Message[] }).messages;

    return fauxAssistantMessage([fauxText(`echo: ${lastText(request as never).text}`)]);
};

let app: App;
const sessions = join(process.env.PI_CODING_AGENT_DIR!, "sessions");
const image = { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" };

before(async () => {
    app = await openApp(scriptedModel(route), join(root, "pi-sessions-data"));
});

after(async () => {
    await app?.close();
    cleanUp();
});

/** Write a session as Pi does, into the folder of its project in Pi's sessions folder; its path. */
function save(manager: SessionManager, name = "session"): string {
    const folder = join(sessions, `--${manager.getCwd().replace(/^\//, "").replace(/\//g, "-")}--`);
    const path = join(folder, `${name}.jsonl`);

    mkdirSync(folder, { recursive: true });
    writeFileSync(
        path,
        [manager.getHeader(), ...manager.getEntries()]
            .map((entry) => JSON.stringify(entry))
            .join("\n") + "\n",
    );

    return path;
}

/**
 * A session with everything Pi writes: a name, model and thinking changes, Pi's system messages, a tool call and its
 * result, an image, a branch left with a summary, an extension's message, `!` and `!!` commands, a compaction that
 * keeps the last turns, and context edits that replace one message and leave one out.
 */
function rich(cwd = work): SessionManager {
    const manager = SessionManager.inMemory(cwd);

    manager.appendModelChange("faux", "faux-1");
    manager.appendThinkingLevelChange("off");
    manager.appendSessionInfo("Fix the checkout total");
    manager.appendMessage({ role: "system", content: "Pi's own prompt", timestamp: 1 });
    manager.appendMessage({
        role: "user",
        content: [{ type: "text", text: "The total is off by a cent." }, image],
        timestamp: 2,
    });
    manager.appendMessage(
        fauxAssistantMessage([fauxToolCall("read", { path: "cart.ts" }, { id: "call-1" })], {
            stopReason: "toolUse",
        }),
    );
    manager.appendMessage({
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "export const total = (items) => items.reduce(...)" }],
        isError: false,
        timestamp: 3,
    });
    const fork = manager.appendMessage(fauxAssistantMessage([fauxText("Floats drift.")]));

    manager.appendMessage({ role: "user", content: "Try doubles", timestamp: 4 });
    manager.appendMessage(fauxAssistantMessage([fauxText("That will not help.")]));
    manager.branchWithSummary(fork, "Tried doubles; it did not help.");
    manager.appendMessage({ role: "user", content: "Use integer cents", timestamp: 5 });
    manager.appendMessage(
        fauxAssistantMessage([fauxText("Changing th")], { stopReason: "aborted" }),
    );
    manager.appendMessage(
        fauxAssistantMessage([], { stopReason: "error", errorMessage: "Overloaded" }),
    );
    manager.appendMessage(fauxAssistantMessage([fauxText("Changing the cart to cents.")]));
    manager.appendCustomMessageEntry("reminder", "Run the tests before you finish.", true);
    manager.appendMessage({
        role: "bashExecution",
        command: "npm test",
        output: "12 passing",
        exitCode: 0,
        cancelled: false,
        truncated: false,
        timestamp: 6,
    });
    manager.appendMessage({
        role: "bashExecution",
        command: "git status",
        output: "clean",
        exitCode: 0,
        cancelled: false,
        truncated: false,
        timestamp: 7,
        excludeFromContext: true,
    });
    const kept = manager.appendMessage({ role: "user", content: "Now the tax", timestamp: 8 });
    const long = manager.appendMessage(fauxAssistantMessage([fauxText("A long answer.")]));
    const noise = manager.appendMessage({ role: "user", content: "noise", timestamp: 9 });

    manager.appendCompaction("Cart totals use cents now.", kept, 5000);
    manager.appendMessage({ role: "user", content: "And rounding?", timestamp: 10 });
    manager.appendMessage(fauxAssistantMessage([fauxText("Round half to even.")]));
    manager.appendContextEdit(long, { content: "A short answer." });
    manager.appendContextEdit(noise, null);
    // Pi's model is the last one picked or answering: picked last here.
    manager.appendModelChange("faux", "faux-2");

    return manager;
}

/**
 * What Pi in the terminal sends the model for this session, Pi's own system messages left out. A reply that failed or
 * was stopped is in Pi's context but never sent: pi-ai's `transformMessages` drops it from every request, as Pi
 * Durable leaves it out of the context.
 */
function piContext(path: string): Message[] {
    const entries = parseSessionEntries(readFileSync(path, "utf8")).slice(1) as SessionEntry[];

    return convertToLlm(buildSessionContext(entries).messages).filter(
        (message) =>
            message.role !== "system" &&
            !(
                message.role === "assistant" &&
                (message.stopReason === "error" || message.stopReason === "aborted")
            ),
    );
}

/** What this session sends the model before Pi Pocket's own prompt joins it. */
async function pocketContext(id: ConversationId): Promise<Message[]> {
    const view = await (await app.harness.conversation(id, context))!.context(context);

    return (view.messages as Message[]).filter((message) => message.role !== "system");
}

/** The kinds of a session's entries, as people see them. */
async function shown(id: ConversationId) {
    const page = await (await app.harness.conversation(id, context))!.entries(
        {},
        500,
        undefined,
        context,
    );

    return [...page.items].reverse();
}

async function continueSession(path: string) {
    const preview = await app.piSessions.preview(owner(app), { path });

    return app.piSessions.create(owner(app), {
        path,
        sha256: preview.sha256,
        leafId: preview.leafId,
        acknowledged: true,
        model: preview.hasImages
            ? "faux/faux-vision"
            : preview.sourceModel
              ? `${preview.sourceModel.provider}/${preview.sourceModel.modelId}`
              : "faux/faux-1",
        thinkingLevel: "off",
    });
}

test("Pi gets canonical context, people get original history, and provenance survives restart", async () => {
    const path = save(rich());
    const { id } = await continueSession(path);
    const expected = piContext(path);

    assert.ok(expected.length > 4);
    assert.deepEqual(await pocketContext(id), expected);
    const entries = await shown(id);
    const texts = JSON.stringify(entries.map((entry) => entry.model ?? []));

    assert.match(texts, /The total is off by a cent/);
    assert.match(texts, /Tried doubles/);
    assert.match(texts, /Changing th/);
    assert.doesNotMatch(texts, /Pi's own prompt/);
    assert.doesNotMatch(texts, /git status/);
    assert.ok(entries.some((entry) => entry.kind === "pi.compaction"));
    assert.ok(entries.some((entry) => entry.kind === "pocket.from-pi"));
    assert.equal(app.sessionMeta(id)?.title, "Fix the checkout total");
    assert.equal(app.sessionMeta(id)?.threadType, "chat");
    assert.equal(app.sessionMeta(id)?.ownerOnly, true);
    assert.equal(await app.piSessions.archive(owner(app), id), readFileSync(path, "utf8"));
    await app.close();
    app = await openApp(scriptedModel(route), join(root, "pi-sessions-data"));
    assert.deepEqual(await pocketContext(id), expected);
    assert.equal((await continueSession(path)).id, id);
});

test("a copied session answers with its selected model, folder, compactions and context edits", async () => {
    const { id } = await continueSession(save(rich(), "continued"));
    const agent = await (await app.harness.conversation(id, context))!.agent(context);

    assert.deepEqual(agent.model, { provider: "faux", modelId: "faux-2" });
    assert.equal(agent.cwd, work);
    await say(app, id, "Carry on");
    assert.match(JSON.stringify(requested), /Round half to even/);
    assert.match(JSON.stringify(requested), /A short answer/);
    assert.doesNotMatch(JSON.stringify(requested), /A long answer/);
});

test("unfinished tools get an unavailable-result note, never resume or claim the original did not execute", async () => {
    const marker = join(work, "must-not-exist");
    const manager = SessionManager.inMemory(work);

    manager.appendMessage({ role: "user", content: "Make the file", timestamp: 1 });
    manager.appendMessage(
        fauxAssistantMessage(
            [fauxToolCall("bash", { command: `touch ${marker}` }, { id: "open" })],
            { stopReason: "toolUse" },
        ),
    );
    const { id } = await continueSession(save(manager, "open"));
    const results = (await pocketContext(id)).filter((message) => message.role === "toolResult");

    assert.equal(results.length, 1);
    assert.equal(results[0]!.isError, true);
    assert.match(JSON.stringify(results[0]!.content), /snapshot|copied/i);
    assert.doesNotMatch(JSON.stringify(results[0]!.content), /not run:|session ended/i);
    await say(app, id, "What happened?");
    assert.equal(existsSync(marker), false);
});

test("a final cut-off record stays byte-identical in the archive and source", async () => {
    const path = save(rich(), "cut");
    const cut = readFileSync(path, "utf8") + '{"type":"message","id":"half';

    writeFileSync(path, cut);
    const { id } = await continueSession(path);

    assert.equal(readFileSync(path, "utf8"), cut);
    assert.equal(await app.piSessions.archive(owner(app), id), cut);
    assert.deepEqual(await pocketContext(id), piContext(path));
});

test("unsupported versions and missing working folders cannot create copies", async () => {
    const newer = save(rich(), "newer");
    const lines = readFileSync(newer, "utf8").split("\n");

    lines[0] = JSON.stringify({ ...JSON.parse(lines[0]!), version: 99 });
    writeFileSync(newer, lines.join("\n"));
    await assert.rejects(continueSession(newer), /format v3|supported/);
    await assert.rejects(
        continueSession(save(rich(join(root, "deleted-project")), "gone")),
        /not there|directory|folder/i,
    );
});

test("owner-only discovery and preview refuse ordinary guests before reading local content", async () => {
    const guest = app.config.addUser("Guest", "guest").user;

    await assert.rejects(app.piSessions.list(guest), { status: 403 });
    await assert.rejects(app.piSessions.preview(guest, { path: "/etc/passwd" }), { status: 403 });
    await assert.rejects(app.piSessions.create(guest, { path: "/etc/passwd" }), { status: 403 });
});

test("two compactions keep Pi's canonical context, including a user-only saved tail", async () => {
    const manager = SessionManager.inMemory(work);

    manager.appendMessage({ role: "user", content: "one", timestamp: 1 });
    manager.appendMessage(fauxAssistantMessage([fauxText("reply one")]));
    const kept = manager.appendMessage({ role: "user", content: "two", timestamp: 2 });

    manager.appendMessage(fauxAssistantMessage([fauxText("reply two")]));
    manager.appendCompaction("First summary.", kept, 1000);
    manager.appendMessage({ role: "user", content: "three", timestamp: 3 });
    const second = manager.appendMessage(fauxAssistantMessage([fauxText("reply three")]));

    manager.appendCompaction("Second summary.", second, 2000);
    manager.appendMessage({ role: "user", content: "four", timestamp: 4 });
    const path = save(manager, "two-compactions");
    const { id } = await continueSession(path);

    assert.deepEqual(await pocketContext(id), piContext(path));
    assert.match(JSON.stringify(await pocketContext(id)), /Second summary/);
    assert.doesNotMatch(JSON.stringify(await pocketContext(id)), /First summary/);
});

test("cyclic trees, damaged complete records and orphan tool results are rejected, not repaired", () => {
    const manager = SessionManager.inMemory(work);

    manager.appendMessage({ role: "user", content: "one", timestamp: 1 });
    manager.appendMessage(fauxAssistantMessage([fauxText("reply")]));
    const [header, first, second] = [manager.getHeader(), ...manager.getEntries()];
    const circle = [header, { ...first, parentId: second!.id }, second];

    assert.throws(
        () =>
            parsePiSession(
                circle.map((entry) => JSON.stringify(entry)).join("\n"),
                undefined,
                "snapshot",
            ),
        /parent|entry/i,
    );
    const damaged = [
        header,
        { ...first, message: { role: "user", content: null, timestamp: 1 } },
        second,
    ];

    assert.throws(
        () =>
            parsePiSession(
                damaged.map((entry) => JSON.stringify(entry)).join("\n"),
                undefined,
                "snapshot",
            ),
        /content/i,
    );
    manager.appendMessage({
        role: "toolResult",
        toolCallId: "missing",
        toolName: "read",
        content: [{ type: "text", text: "stray" }],
        isError: false,
        timestamp: 2,
    });
    assert.throws(
        () =>
            parsePiSession(
                [header, ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n"),
                undefined,
                "snapshot",
            ),
        /tool result/i,
    );
});
