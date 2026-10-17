// Conversation routes own scoped access; generic extension routes retain their app-wide isolation.
// Only transport byte capture is substituted: authentication, loading and bound core operations are real.
import {
    type App,
    cleanUp,
    fakeTab,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createHandler } from "../src/server/http.ts";
import type { ConversationId } from "@earendil-works/pi-durable";

let app: App;
let visible: ConversationId;
let hidden: ConversationId;
const data = join(root, "session-extension-routes");

before(async () => {
    app = await openApp(scriptedModel(), data);
    visible = await newSession(app);
    hidden = await newSession(app);
    const extensions = join(data, "extensions");

    mkdirSync(extensions, { recursive: true });
    writeFileSync(
        join(extensions, "contextual.js"),
        "export const pocketApi = 1; export default () => {};\n",
    );
    writeFileSync(
        join(extensions, "contextual.ts"),
        `/** Conversation-aware extension. */
export default (_host, web) => {
    web.client("contextual.js", { access: "conversation" });
    web.route("GET", "shared", () => ({ appWide: true }), { access: "view" });
    web.route("GET", "broadcast", () => { web.send("scope-test", { appWide: true }); return {}; });
    web.sessionRoute("GET", "status", async ({ conversationId, user, session }) => ({
        conversationId, user: user.id, status: await session.transfers.status()
    }), { access: "view" });
    web.sessionRoute("POST", "steer", () => ({ reached: true }), { access: "steer" });
    web.sessionRoute("POST", "cannot-grant-write", ({ session }) =>
        session.transfers.updateGroup({ archived: true }), { access: "view" });
};\n`,
    );
    writeFileSync(
        join(extensions, "app-only.ts"),
        `/** App-wide browser module. */
export default (_host, web) => web.client("contextual.js", { access: "view" });\n`,
    );
    await app.setExtensionEnabled(owner(app), "contextual.ts", true);
    await app.setExtensionEnabled(owner(app), "app-only.ts", true);
});
after(async () => {
    await app.close();
    cleanUp();
});

function call(path: string, token: string, body?: unknown, pocket = true, delayed = false) {
    const request = new IncomingMessage(new Socket());
    const response = new ServerResponse(request);
    let output = "";

    request.url = path;
    request.method = body === undefined ? "GET" : "POST";
    request.headers = {
        authorization: `Bearer ${token}`,
        ...(pocket ? { "x-pocket": "1" } : {}),
        "content-type": "application/json",
    };

    response.end = (chunk?: unknown) => {
        output = String(chunk ?? "");

        return response;
    };

    const done = createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} })(
        request,
        response,
    ).then(() => ({ status: response.statusCode, output, allow: response.getHeader("allow") }));

    const send = () => {
        if (body !== undefined) {
            request.push(Buffer.from(JSON.stringify(body)));
        }

        request.push(null);
    };

    if (!delayed) {
        send();
    }

    return { done, request, send };
}

const route = (id: number, path: string) => `/api/c/${id}/x/contextual/${path}`;

test("conversation extension routes admit scoped participants without exposing app-wide routes or write authority", async () => {
    const guest = app.config.addUser("Scoped driver", "guest", [String(visible)]);
    const viewer = app.config.addUser("Scoped reader", "viewer", [String(visible)]);
    const accepted = await call(route(visible, "status"), guest.token).done;

    assert.equal(accepted.status, 200, accepted.output);
    const result = JSON.parse(accepted.output);

    assert.equal(result.conversationId, visible);
    assert.equal(result.user, guest.user.id);
    assert.equal(result.status.workflow.profileAvailable, true);
    assert.equal((await call(route(hidden, "status"), guest.token).done).status, 404);
    assert.equal((await call("/api/x/contextual/shared", guest.token).done).status, 404);
    assert.equal((await call("/api/x/contextual/shared", app.config.ownerToken).done).status, 200);
    assert.equal(
        (await call(route(visible, "status"), guest.token, undefined, false).done).status,
        403,
    );
    const wrongMethod = await call(route(visible, "status"), guest.token, {}).done;

    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.allow, "GET");
    assert.equal((await call(route(visible, "status"), viewer.token).done).status, 200);
    assert.equal((await call(route(visible, "steer"), viewer.token, {}).done).status, 404);
    assert.equal(
        (await call(route(visible, "cannot-grant-write"), viewer.token, {}).done).status,
        403,
    );
    const clients = app.webs.clients(viewer.user);
    const contextual = clients.find((client) => client.module === "contextual");

    assert.ok(contextual);
    assert.equal(
        clients.some((client) => client.module === "app-only"),
        false,
    );
    assert.equal((await call(contextual.url, viewer.token).done).status, 200);
});

test("conversation extension admission is rechecked after an asynchronous body and module removal", async () => {
    for (const change of ["scope", "role", "module"] as const) {
        const guest = app.config.addUser(`Raced ${change}`, "guest", [String(visible)]);
        const pending = call(route(visible, "steer"), guest.token, {}, true, true);

        try {
            await until(
                () => pending.request.listenerCount("readable") > 0,
                "route awaits JSON body",
            );

            if (change === "scope") {
                app.config.updateUser(guest.user.id, { sessions: [] });
            } else if (change === "role") {
                app.config.updateUser(guest.user.id, { role: "viewer" });
            } else {
                await app.setExtensionEnabled(owner(app), "contextual.ts", false);
            }
        } finally {
            pending.send();
        }

        const refused = await pending.done;

        assert.equal(refused.status, 404, `${change}: ${refused.output}`);
        assert.equal(refused.output.includes("reached"), false);
        await app.setExtensionEnabled(owner(app), "contextual.ts", true);
    }
});

test("scoped service results cannot be published after their requester loses access", async (t) => {
    const guest = app.config.addUser("Removed during read", "guest", [String(visible)]);
    const original = app.handoffs.list.bind(app.handoffs);
    const read = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    // Hold only delivery of the real service result, after its genuine core read completes.
    t.mock.method(app.handoffs, "list", async (...args: Parameters<typeof original>) => {
        const result = await original(...args);

        read.resolve();
        await release.promise;

        return result;
    });
    const pending = call(route(visible, "status"), guest.token).done;

    try {
        await read.promise;
        app.config.removeUser(guest.user.id);
    } finally {
        release.resolve();
    }

    const refused = await pending;

    assert.equal(refused.status, 401, refused.output);
    assert.equal(refused.output.includes("profileAvailable"), false);
});

test("conversation-accessible static clients do not authorize app-wide event delivery to scoped people", async () => {
    const scoped = app.config.addUser("Event-scoped", "guest", [String(visible)]);
    const unscoped = app.config.addUser("Event-full", "guest");
    const restricted = fakeTab(visible, scoped.user);
    const full = fakeTab(visible, unscoped.user);

    await app.attach(restricted.client);
    await app.attach(full.client);

    try {
        const response = await call("/api/x/contextual/broadcast", app.config.ownerToken).done;

        assert.equal(response.status, 200, response.output);
        assert.ok(
            full.events.some(({ event, data }) => event === "ext" && data.event === "scope-test"),
        );
        assert.equal(
            restricted.events.some(
                ({ event, data }) => event === "ext" && data.event === "scope-test",
            ),
            false,
        );
    } finally {
        app.detach(restricted.client);
        app.detach(full.client);
    }
});

test("superseded handoff and milestone routes cannot create work; passive transfer receipts remain core", async () => {
    const count = app.sessions().length;

    for (const path of [
        "handoffs",
        "handoffs/complete",
        "handoffs/external-review",
        "handoffs/accept-validation",
    ]) {
        const response = await call(`/api/c/${visible}/${path}`, app.config.ownerToken, {
            targetType: "worker",
            relationship: "same-work",
            requestId: `removed-${path}`,
            summary: "Not an admission path",
        }).done;

        assert.equal(response.status, 404, `${path}: ${response.output}`);
    }

    assert.equal(
        (await call(`/api/c/${visible}/handoffs`, app.config.ownerToken).done).status,
        404,
    );
    assert.equal(app.sessions().length, count);
    await app.setExtensionEnabled(owner(app), "work-items.ts", false);

    try {
        const response = await call(`/api/c/${visible}/transfers`, app.config.ownerToken).done;

        assert.equal(response.status, 200, response.output);
        assert.deepEqual(JSON.parse(response.output), { transfers: [] });
    } finally {
        await app.setExtensionEnabled(owner(app), "work-items.ts", true);
    }
});
