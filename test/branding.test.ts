// The installed-app contract: the document and manifest agree on the display name, and every
// advertised icon is actually served with the declared type and raster dimensions. No listener.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createHandler } from "../src/server/http.ts";
import { cleanUp, openApp, scriptedModel } from "./helpers.ts";

test("the primary and compatibility package commands both open pi-tava help", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

    assert.equal(manifest.name, "pi-tava");

    for (const command of ["pi-tava", "pi-coop"]) {
        assert.equal(typeof manifest.bin[command], "string", `${command} is a packaged executable`);
        const entry = fileURLToPath(new URL(`../${manifest.bin[command]}`, import.meta.url));
        const result = spawnSync(process.execPath, [entry, "--help"], { encoding: "utf8" });

        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /pi-tava:.*durable/);
        assert.match(result.stdout, /Usage: pi-tava/);
    }
});

test("pi-tava serves its favicon, home-screen icons and background-free mark", async (t) => {
    const app = await openApp(scriptedModel());
    const handler = createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart() {} });

    t.after(async () => {
        await app.close();
        cleanUp();
    });

    const get = async (path: string) => {
        const request = new IncomingMessage(new Socket());
        const response = new ServerResponse(request);
        let body: Buffer = Buffer.alloc(0);

        request.url = path;
        request.method = "GET";
        request.headers = {};

        response.end = (chunk?: unknown) => {
            body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ""));

            return response;
        };

        await handler(request, response);
        assert.equal(response.statusCode, 200, path);

        return { body, type: response.getHeader("content-type") };
    };

    const page = (await get("/")).body.toString();

    assert.match(page, /<title>pi-tava<\/title>/);

    const manifestPath = /<link rel="manifest" href="([^"]+)"/.exec(page)?.[1];
    const faviconPath = /<link rel="icon" href="([^"]+)"/.exec(page)?.[1];
    const touchPath = /<link rel="apple-touch-icon" href="([^"]+)"/.exec(page)?.[1];

    assert.ok(manifestPath);
    assert.ok(faviconPath);
    assert.ok(touchPath);

    const manifest = JSON.parse((await get(manifestPath)).body.toString());

    assert.equal(manifest.name, "pi-tava");
    assert.equal(manifest.short_name, "pi-tava");

    for (const icon of [
        ...manifest.icons,
        { src: touchPath, sizes: "180x180", type: "image/png" },
    ]) {
        const served = await get(icon.src);

        assert.equal(served.type, icon.type, icon.src);

        if (icon.type === "image/png") {
            assert.equal(served.body.subarray(1, 8).toString(), "PNG\r\n\x1a\n");
            assert.equal(
                `${served.body.readUInt32BE(16)}x${served.body.readUInt32BE(20)}`,
                icon.sizes,
                icon.src,
            );
        } else {
            assert.match(served.body.toString(), /<svg\s/);
        }
    }

    assert.equal((await get(faviconPath)).type, "image/svg+xml");
    assert.equal((await get("/pi-tava-mark.svg")).type, "image/svg+xml");
});
