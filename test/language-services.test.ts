// HTTP is the security owner for editor sessions: pool tests cannot exercise identity or conversation binding.
import { cleanUp, newSession, openApp, owner, root, scriptedModel, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { createHandler } from "../src/server/http.ts";
import type { LspServerStatus } from "../src/server/lsp.ts";

after(cleanUp);

test("HTTP language leases bind to one conversation; status requires owner access but not the wheel or a session", async () => {
    const project = join(work, "language-http");
    const next = join(work, "language-next");

    mkdirSync(project);
    mkdirSync(next);
    writeFileSync(join(project, "tsconfig.json"), '{"compilerOptions":{"strict":true}}');
    writeFileSync(join(project, "main.ts"), "export const answer: number = 42;\n");
    const app = await openApp(scriptedModel(), join(root, "language-data"));
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const post = (id: number, body: unknown, token = app.config.ownerToken) =>
        fetch(`${base}/api/c/${id}/lsp`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${token}`,
                "X-Pocket": "1",
                "content-type": "application/json",
            },
            body: JSON.stringify(body),
        });

    try {
        const id = await newSession(app, project);
        const other = await newSession(app, project);
        const guest = app.config.addUser("Guest", "guest");
        const viewer = app.config.addUser("Viewer", "viewer");

        for (const token of [guest.token, viewer.token]) {
            for (const action of ["status", "open"]) {
                const denied = await post(id, { action, path: "main.ts" }, token);

                assert.equal(
                    denied.status,
                    403,
                    "LSP activity is owner-only even for someone who can edit",
                );
            }
        }

        const emptyStatus = await post(id, { action: "status" });

        assert.equal(emptyStatus.status, 200, "Status does not require a document session");
        assert.deepEqual(
            await emptyStatus.json(),
            { servers: [] },
            "Reading status and denied attempts cannot start a server",
        );
        const protectedPath = join(app.dataDir, "config.json");

        assert.equal((await post(id, { action: "open", path: protectedPath })).status, 403);
        const openedResponse = await post(id, { action: "open", path: "main.ts" });

        assert.equal(openedResponse.status, 200);
        const opened = (await openedResponse.json()) as { session: string; status: string };

        assert.equal(opened.status, "ready");
        assert.equal(typeof opened.session, "string");
        const session = opened.session;

        await app.collab.turns(id, owner(app), { action: "on" });
        await app.collab.turns(id, owner(app), { action: "handover", to: guest.user.id });
        assert.equal((await post(id, { action: "open", path: "main.ts" })).status, 409);
        const statusResponse = await post(id, { action: "status" });

        assert.equal(
            statusResponse.status,
            200,
            "The owner can inspect servers while someone else is driving",
        );
        const status = (await statusResponse.json()) as { servers: LspServerStatus[] };

        assert.equal(status.servers.length, 1);
        assert.equal(status.servers[0]!.name, "TypeScript 7 (tsgo)");
        assert.equal(status.servers[0]!.status, "running");
        assert.equal(status.servers[0]!.documents, 1);
        assert.equal((await post(id, { action: "status" }, guest.token)).status, 403);
        await app.collab.turns(id, guest.user, { action: "off" });

        assert.equal((await post(other, { action: "poll", session })).status, 404);
        assert.equal((await post(other, { action: "close", session })).status, 404);
        assert.equal((await post(id, { action: "poll", session }, guest.token)).status, 403);
        assert.equal(
            (await post(id, { action: "poll", session })).status,
            200,
            "denied attempts did not close the owner's lease",
        );
        const busy = (await (await post(other, { action: "open", path: "main.ts" })).json()) as {
            session: string | null;
            status: string;
        };

        assert.equal(busy.status, "busy");
        assert.equal(busy.session, null);
        const changed = await fetch(`${base}/api/c/${id}/configure`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${app.config.ownerToken}`,
                "X-Pocket": "1",
                "content-type": "application/json",
            },
            body: JSON.stringify({ cwd: next }),
        });

        assert.equal(changed.status, 200);
        assert.equal((await post(id, { action: "poll", session })).status, 409);
        assert.equal(
            (await post(id, { action: "poll", session })).status,
            404,
            "a changed cwd retires the old session",
        );
        const reopened = (await (
            await post(other, { action: "open", path: "main.ts" })
        ).json()) as { session: string; status: string };

        assert.equal(
            reopened.status,
            "ready",
            "invalidating the previous context released its document lease",
        );
        assert.equal(
            (await post(other, { action: "close", session: reopened.session })).status,
            200,
        );
        const idleStatus = (await (await post(other, { action: "status" })).json()) as {
            servers: LspServerStatus[];
        };

        assert.equal(idleStatus.servers.length, 1);
        assert.equal(idleStatus.servers[0]!.id, status.servers[0]!.id);
        assert.equal(idleStatus.servers[0]!.status, "idle");
        assert.equal(idleStatus.servers[0]!.documents, 0);
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await app.close();
    }
});
