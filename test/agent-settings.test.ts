// Authoring gate: the real HTTP handler owns access, validation, conflict handling and durable prompt edits.
// Requests and responses are Node HTTP objects with an in-memory response sink; no server or network is needed.
// These cases catch unauthorized global changes, stale-tab overwrites and failed saves leaking into live prompts.
// Provider-request composition and helper inheritance are owned by thread-prompts.test.ts, not repeated here.
import { type App, cleanUp, openApp, owner, root, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createHandler } from "../src/server/http.ts";

const data = join(root, "agent-settings");
let app: App;
let handler: ReturnType<typeof createHandler>;

type Agent = { type: string; name: string; prompt: string; defaultPrompt: string };
type Settings = { agents: Agent[]; maxPromptLength: number };

before(async () => {
    app = await openApp(scriptedModel(), data);
    handler = createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} });
});
after(async () => {
    await app?.close();
    cleanUp();
});

async function request(
    path = "",
    body?: unknown,
    token: string | null = app.config.ownerToken,
    pocket = true,
) {
    const request = new IncomingMessage(new Socket());
    const response = new ServerResponse(request);
    let output = "";

    request.url = `/api/agents${path}`;
    request.method = body === undefined ? "GET" : "POST";
    request.headers = {
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        ...(pocket ? { "x-pocket": "1" } : {}),
        "content-type": "application/json",
    };

    // Capture only the transport output; authentication, parsing, routing and persistence run unchanged.
    response.end = (chunk?: unknown) => {
        output = String(chunk ?? "");

        return response;
    };

    const handled = handler(request, response);

    if (body !== undefined) {
        request.push(Buffer.from(JSON.stringify(await body)));
    }

    request.push(null);
    await handled;
    const headers = new Headers();

    for (const [key, value] of Object.entries(response.getHeaders())) {
        if (value !== undefined) {
            headers.set(key, String(value));
        }
    }

    return new Response(output, { status: response.statusCode, headers });
}

async function settings(): Promise<Settings> {
    const response = await request();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");

    return response.json();
}

test("only the owner can read or change app-wide agent prompts", async () => {
    const { agents } = await settings();
    const worker = agents.find((agent) => agent.type === "worker")!;
    const payload = { prompt: "New worker instructions", expectedPrompt: worker.prompt };

    assert.ok((await app.hello(owner(app))).server.agentSettings >= 1);
    assert.deepEqual(
        agents.map((agent) => agent.type),
        ["chat", "worker", "reviewer", "land", "publish"],
    );
    assert.ok(
        agents.every((agent) => agent.prompt.length > 0 && agent.prompt === agent.defaultPrompt),
    );
    assert.equal((await request("", undefined, null)).status, 401);
    assert.equal((await request("/worker", payload, app.config.ownerToken, false)).status, 403);

    for (const role of ["guest", "viewer"] as const) {
        const { token } = app.config.addUser(role, role);

        assert.equal((await request("", undefined, token)).status, 403);
        assert.equal((await request("/worker", payload, token)).status, 403);
    }

    assert.equal(
        (await settings()).agents.find((agent) => agent.type === "worker")!.prompt,
        worker.prompt,
    );
});

test("edits persist, reject stale tabs and invalid prompts, and restore bundled defaults", async () => {
    const initial = await settings();
    const worker = initial.agents.find((agent) => agent.type === "worker")!;
    const text = "Worker instructions\nKeep café, 日本語 and emoji 🧪 exactly as entered.\n";
    const body = { prompt: text, expectedPrompt: worker.prompt };
    const saved = await request("/worker", body);

    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).prompt, text);
    assert.equal(
        (await request("/worker", body)).status,
        409,
        "a stale browser cannot overwrite a newer save",
    );

    for (const prompt of ["", " \n\t", null, 42, "x".repeat(initial.maxPromptLength + 1)]) {
        assert.equal((await request("/worker", { prompt, expectedPrompt: text })).status, 400);
    }

    for (const body of [null, {}, [], "not an object"]) {
        assert.equal((await request("/worker", body)).status, 400);
    }

    assert.equal((await request("/unknown", { prompt: text, expectedPrompt: text })).status, 404);
    assert.equal((await request("/toString", { prompt: text, expectedPrompt: text })).status, 404);
    const current = await settings();

    assert.equal(current.agents.find((agent) => agent.type === "worker")!.prompt, text);
    assert.deepEqual(
        current.agents.filter((agent) => agent.type !== "worker"),
        initial.agents.filter((agent) => agent.type !== "worker"),
    );
    await app.close();
    app = await openApp(scriptedModel(), data);
    handler = createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} });
    assert.equal((await settings()).agents.find((agent) => agent.type === "worker")!.prompt, text);
    assert.equal(
        (await request("/worker", { prompt: worker.defaultPrompt, expectedPrompt: text })).status,
        200,
    );
    assert.equal(
        app.config.agentPrompts.worker,
        undefined,
        "restore follows future bundled defaults instead of pinning today's default",
    );
    assert.equal(
        (await settings()).agents.find((agent) => agent.type === "worker")!.prompt,
        worker.defaultPrompt,
    );
});

// The body can arrive after another save: sequential stale-tab tests cannot catch a pre-read snapshot merge.
test("overlapping request bodies merge different roles and reject late stale edits", async () => {
    const initial = await settings();
    const worker = initial.agents.find((agent) => agent.type === "worker")!;
    const chat = initial.agents.find((agent) => agent.type === "chat")!;
    let deliverWorker!: (body: unknown) => void;
    const pendingWorker = request(
        "/worker",
        new Promise((resolve) => {
            deliverWorker = resolve;
        }),
    );
    const chatText = "Chat instructions saved while a Worker body is arriving.";
    const workerText = "Worker instructions from a delayed request body.";

    assert.equal(
        (await request("/chat", { prompt: chatText, expectedPrompt: chat.prompt })).status,
        200,
    );
    deliverWorker({ prompt: workerText, expectedPrompt: worker.prompt });
    assert.equal((await pendingWorker).status, 200);
    const merged = await settings();

    assert.equal(merged.agents.find((agent) => agent.type === "chat")!.prompt, chatText);
    assert.equal(merged.agents.find((agent) => agent.type === "worker")!.prompt, workerText);
    let deliverStale!: (body: unknown) => void;
    const pendingStale = request(
        "/worker",
        new Promise((resolve) => {
            deliverStale = resolve;
        }),
    );
    const newerText = "The newer Worker save must win.";

    assert.equal(
        (await request("/worker", { prompt: newerText, expectedPrompt: workerText })).status,
        200,
    );
    deliverStale({ prompt: "Late stale draft", expectedPrompt: workerText });
    assert.equal((await pendingStale).status, 409);
    assert.equal(
        (await settings()).agents.find((agent) => agent.type === "worker")!.prompt,
        newerText,
    );
    assert.equal(
        (await request("/worker", { prompt: worker.defaultPrompt, expectedPrompt: newerText }))
            .status,
        200,
    );
    assert.equal(
        (await request("/chat", { prompt: chat.defaultPrompt, expectedPrompt: chatText })).status,
        200,
    );
});

test("a failed disk save leaves live and persisted prompts unchanged", async () => {
    const worker = (await settings()).agents.find((agent) => agent.type === "worker")!;
    const previous = readFileSync(app.config.file, "utf8");
    const blockedTemp = `${app.config.file}.${process.pid}.tmp`;

    mkdirSync(blockedTemp);

    try {
        assert.equal(
            (
                await request("/worker", {
                    prompt: "Must not become live",
                    expectedPrompt: worker.prompt,
                })
            ).status,
            500,
        );
        assert.equal(
            (await settings()).agents.find((agent) => agent.type === "worker")!.prompt,
            worker.prompt,
        );
        assert.equal(readFileSync(app.config.file, "utf8"), previous);
    } finally {
        rmSync(blockedTemp, { recursive: true });
    }
});
