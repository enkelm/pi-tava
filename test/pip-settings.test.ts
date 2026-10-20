// ConfigStore owns migration/atomic-save behavior; real HTTP requests own authority and model independence.
// These tests catch legacy pauses waking on upgrade, collaborator edits configuring private chat, and stale saves.
// Model execution is scripted; no provider requests or live data are used.
import {
    type App,
    cleanUp,
    echo,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { ConfigStore } from "../src/server/config.ts";
import { createHandler } from "../src/server/http.ts";

test("PiP native settings preserve a legacy pause, prefer explicit choices and roll back failed saves", (t) => {
    const directory = mkdtempSync(join(tmpdir(), "coop-pip-settings-"));

    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const original = new ConfigStore(directory);

    original.setExtensionEnabled("pip.ts", false);
    const saved = readFileSync(original.file, "utf8");
    const config = new ConfigStore(directory);

    assert.equal(config.pipEnabled, false);
    assert.equal(
        readFileSync(config.file, "utf8"),
        saved,
        "migration reads do not rewrite old choices",
    );
    config.pipEnabled = true;
    const reopened = new ConfigStore(directory);

    assert.equal(
        reopened.pipEnabled,
        true,
        "the native selection supersedes the old disabled extension",
    );
    assert.equal(reopened.extensionChoice("pip.ts"), false);
    const selection = {
        choice: { provider: "faux", modelId: "faux-2", thinkingLevel: "off" as const },
        revision: 1,
    };

    reopened.pipCollaborator = selection;
    selection.choice.modelId = "not-saved";
    assert.equal(new ConfigStore(directory).pipCollaborator?.choice.modelId, "faux-2");
    const before = readFileSync(config.file, "utf8");
    const blockedTemp = `${config.file}.${process.pid}.tmp`;

    mkdirSync(blockedTemp);
    assert.throws(() => {
        reopened.pipEnabled = false;
    });
    assert.throws(() => {
        reopened.pipCollaborator = { choice: { provider: "faux", modelId: "faux-1" }, revision: 2 };
    });
    assert.equal(reopened.pipEnabled, true);
    assert.equal(reopened.pipCollaborator?.revision, 1);
    assert.equal(readFileSync(config.file, "utf8"), before);
});

const data = join(root, "pip-settings-data");
let app: App;
let handler: ReturnType<typeof createHandler>;
let holding: Promise<void> | undefined;

const route: FauxResponseStep = async (...args) => {
    if (holding !== undefined) {
        await holding;
    }

    return typeof echo === "function" ? echo(...args) : echo;
};

before(async () => {
    const config = new ConfigStore(data);

    config.setExtensionEnabled("pip.ts", false);
    app = await openApp(scriptedModel(route), data);
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

    request.url = `/api/pip/settings${path}`;
    request.method = body === undefined ? "GET" : "POST";
    request.headers = {
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        ...(pocket ? { "x-pocket": "1" } : {}),
        "content-type": "application/json",
    };

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

    return new Response(output, {
        status: response.statusCode,
        headers: { "cache-control": String(response.getHeader("cache-control") ?? "") },
    });
}

async function settings() {
    const response = await request();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");

    return response.json();
}

test("PiP has native owner-only settings while the legacy-disabled assistant stays paused", async () => {
    const initial = await settings();

    assert.equal(initial.enabled, false);
    assert.equal(initial.chats.id, null);
    assert.equal(initial.collaborator.model, null);
    assert.equal(initial.collaborator.revision, 0);
    assert.equal(app.pip.available(owner(app)), false);
    assert.equal((await request("", undefined, null)).status, 401);
    assert.equal((await request("", { enabled: true }, app.config.ownerToken, false)).status, 403);

    for (const role of ["guest", "viewer"] as const) {
        const { token } = app.config.addUser(role, role);

        assert.equal((await request("", undefined, token)).status, 403);
        assert.equal((await request("", { enabled: true }, token)).status, 403);
        assert.equal(
            (await request("/chats", { model: { provider: "faux", modelId: "faux-1" } }, token))
                .status,
            403,
        );
        assert.equal(
            (
                await request(
                    "/collaborator",
                    { model: { provider: "faux", modelId: "faux-2" }, expectedRevision: 0 },
                    token,
                )
            ).status,
            403,
        );
    }

    for (const invalid of [
        null,
        {},
        [],
        { enabled: "yes" },
        { enabled: true, compactAt: 0 },
        { compactAt: 1 },
    ]) {
        assert.equal((await request("", invalid)).status, 400);
        assert.equal((await settings()).enabled, false);
    }

    assert.equal(
        (await app.extensions(owner(app))).modules.some((module) => module.file === "pip.ts"),
        false,
    );
    await assert.rejects(
        app.setExtensionEnabled(owner(app), "pip.ts", true),
        /no extension module/i,
    );
    await assert.rejects(app.reloadExtension("pip.ts"), /no extension module/i);
    assert.equal((await request("", { enabled: true })).status, 200);
    assert.equal(app.pip.available(owner(app)), true);
});

test("collaborator selection neither creates private chat nor changes private/default choices, even while PiP works", async () => {
    const one = { provider: "faux", modelId: "faux-1" };
    const two = { provider: "faux", modelId: "faux-2" };
    const defaults = app.config.lastModel;

    assert.equal((await request("/collaborator", { model: two, expectedRevision: 0 })).status, 200);
    assert.equal(
        app.pip.idOf(owner(app).id),
        undefined,
        "saving a collaborator choice must not create a private conversation",
    );
    assert.deepEqual(app.config.lastModel, defaults);
    assert.equal((await request("/chats", { model: one })).status, 200);
    const id = app.pip.idOf(owner(app).id)!;

    assert.deepEqual((await app.agentState(id))?.model, one);
    assert.deepEqual((await settings()).collaborator.model, two);
    assert.deepEqual(
        app.config.lastModel,
        defaults,
        "the settings picker does not change defaults for new coding threads",
    );
    let release!: () => void;

    holding = new Promise<void>((resolve) => {
        release = resolve;
    });
    const run = say(app, id, "Keep the private assistant busy");

    try {
        await until(() => app.isBusy(id), "private PiP working");
        assert.equal(
            (await request("/collaborator", { model: one, expectedRevision: 1 })).status,
            200,
        );
        assert.equal((await request("/chats", { model: two })).status, 409);
        assert.deepEqual((await app.agentState(id))?.model, one);
        assert.deepEqual((await settings()).collaborator.model, one);
    } finally {
        holding = undefined;
        release();
        await run;
    }

    assert.equal((await request("/chats", { model: two })).status, 200);
    assert.deepEqual((await settings()).collaborator.model, one);
    assert.deepEqual((await app.agentState(id))?.model, two);
    assert.deepEqual(app.config.lastModel, defaults);

    for (const invalid of [
        null,
        {},
        [],
        { model: null, expectedRevision: 2 },
        { model: "faux/faux-1", expectedRevision: 2 },
        { model: { provider: "faux" }, expectedRevision: 2 },
        { model: { provider: "faux", modelId: 1 }, expectedRevision: 2 },
        { model: { provider: "faux", modelId: "missing" }, expectedRevision: 2 },
        { model: two, thinkingLevel: "invented", expectedRevision: 2 },
        { model: two, thinkingLevel: null, expectedRevision: 2 },
        { model: two, thinkingLevel: 1, expectedRevision: 2 },
    ]) {
        assert.equal((await request("/collaborator", invalid)).status, 400);
        assert.equal((await request("/chats", invalid)).status, 400);
    }

    assert.deepEqual((await app.agentState(id))?.model, two);
    assert.deepEqual(app.config.lastModel, defaults);

    assert.equal((await request("/collaborator", { model: two, expectedRevision: 1 })).status, 409);
    assert.deepEqual((await settings()).collaborator.model, one);
    assert.equal((await settings()).collaborator.revision, 2);
    assert.equal((await request("", { compactAt: 40000 })).status, 200);
    assert.equal((await request("", { enabled: false })).status, 200);
    await app.close();
    app = await openApp(scriptedModel(route), data);
    handler = createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} });
    const reopened = await settings();

    assert.equal(reopened.enabled, false);
    assert.equal(reopened.compactAt, 40000);
    assert.equal(reopened.chats.id, Number(id));
    assert.deepEqual(reopened.chats.model, two);
    assert.deepEqual(reopened.collaborator.model, one);
    assert.equal(reopened.collaborator.revision, 2);
});

test("a token revoked while a settings request arrives cannot change PiP", async () => {
    let deliver!: (value: unknown) => void;
    const body = new Promise((resolve) => {
        deliver = resolve;
    });
    const pending = request("", body);

    await new Promise((resolve) => setImmediate(resolve));
    app.config.rotateOwnerToken();
    deliver({ enabled: true });
    assert.equal((await pending).status, 401);
    assert.equal((await settings()).enabled, false);
});
