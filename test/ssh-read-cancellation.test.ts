// An HTTP reader leaving during a real SFTP READ must end its transport and not dispatch later work.
// Existing transport-only cancellation tests cannot catch a missing HTTP -> workspace context.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { realpath, rm, writeFile } from "node:fs/promises";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { join } from "node:path";
import { after, test } from "node:test";
import { createHandler } from "../src/server/http.ts";
import { cleanUp, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
import { sshFixture } from "./ssh-fixture.ts";

after(cleanUp);

for (const [name, route, packet] of [
    ["image bytes", "file?path=abandoned.png", 5],
    ["mention traversal", "files", 12],
] as const) {
    test(`closing an HTTP ${name} read cancels and joins SFTP before any later read is dispatched`, async () => {
        const ssh = await sshFixture();
        const app = await openApp(scriptedModel(), join(root, `ssh-read-cancellation-${packet}`));
        const hold = join(ssh.root, `hold-sftp-${packet}`);
        let pending: Promise<void> | undefined;

        try {
            const cwd = await realpath(ssh.root);
            const file = join(cwd, "abandoned.png");

            await writeFile(file, "remote bytes");
            const { id } = await app.commands.createSession(owner(app), {
                cwd,
                location: { kind: "ssh", host: "fixture-host" },
                threadType: "chat",
            });
            const handler = createHandler({
                app,
                listen: { host: "127.0.0.1", port: 0 },
                restart() {},
            });
            const incoming = new IncomingMessage(new Socket());
            const response = new ServerResponse(incoming);
            let ended = false;
            let output = "";

            incoming.url = `/api/c/${id}/${route}`;
            incoming.method = "GET";
            incoming.headers = { authorization: `Bearer ${app.config.ownerToken}` };
            incoming.push(null);

            response.end = (body?: unknown) => {
                ended = true;
                output = String(body ?? "");

                return response;
            };

            await writeFile(hold, "wait");
            pending = handler(incoming, response);
            const ready = join(ssh.root, `sftp-${packet}-ready`);

            await until(() => existsSync(ready) || ended, "actual SFTP read waits");
            assert.equal(ended, false, output);
            const pid = Number(readFileSync(ready, "utf8"));
            const before = readFileSync(join(ssh.root, "packets"), "utf8");

            response.emit("close");
            // Keep the peer gated: cancellation, not releasing the read, must settle the route.
            await until(() => ended, "HTTP cancellation settles while the peer remains gated");
            await pending;
            assert.throws(() => process.kill(pid, 0), /ESRCH/, "the SFTP child is joined");
            assert.equal(
                readFileSync(join(ssh.root, "packets"), "utf8"),
                before,
                "no FSTAT/native follow-up or queued read",
            );
            assert.notEqual(response.statusCode, 200);
            assert.equal(incoming.listenerCount("aborted"), 0);
            assert.equal(response.listenerCount("close"), 0);
        } finally {
            await rm(hold, { force: true });
            await pending;
            await app.close();
            await ssh.close();
        }
    });
}
