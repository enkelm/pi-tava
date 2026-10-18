// A suspended tab misses broadcasts. The real app/HTML/hello boundary must retain a revision
// independently of connected clients, so the browser can reconcile it without background polling.
import assert from "node:assert/strict";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { test } from "node:test";
import { createHandler } from "../src/server/http.ts";
import { cleanUp, fakeTab, openApp, owner, scriptedModel } from "./helpers.ts";

test("web revisions survive missed broadcasts and match the document and reconnect hello", async (t) => {
    const app = await openApp(scriptedModel());
    const user = owner(app);
    const handler = createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart() {} });

    t.after(async () => {
        await app.close();
        cleanUp();
    });

    const get = async (path: string) => {
        const request = new IncomingMessage(new Socket());
        const response = new ServerResponse(request);
        let body = "";

        request.url = path;
        request.method = "GET";
        request.headers = { authorization: `Bearer ${app.config.ownerToken}` };

        response.end = (chunk?: unknown) => {
            body = String(chunk ?? "");

            return response;
        };

        await handler(request, response);
        assert.equal(response.statusCode, 200, body);

        return body;
    };

    const hello = JSON.parse(await get("/api/me"));
    const revision = hello.server.webRevision;

    assert.equal(typeof revision, "string", "hello identifies the web assets a tab must reconcile");

    for (const route of ["/", "/s/1", "/private", "/index.html"]) {
        assert.ok(
            (await get(route)).includes(`name="pocket-web-revision" content="${revision}"`),
            "every app document records the revision before its modules load",
        );
    }

    assert.equal(app.clients.size, 0);
    app.reloadClients("file-language.js");
    const updated = JSON.parse(await get("/api/me")).server.webRevision;

    assert.notEqual(updated, revision, "web changes remain observable with no connected tabs");
    assert.ok((await get("/")).includes(`content="${updated}"`));
    const tab = fakeTab(undefined, user);

    await app.attach(tab.client);

    try {
        const event = tab.events.find((item) => item.event === "hello");

        assert.ok(event);
        assert.equal(
            (event.data as typeof hello).server.webRevision,
            updated,
            "the reconnect snapshot carries the same revision through either event transport",
        );
    } finally {
        app.detach(tab.client);
    }
});
