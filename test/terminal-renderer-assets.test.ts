// Exercise the real HTTP router and disk delivery without a listener. A disposable source copy
// gives its APP_ROOT synthetic assets without editing the live, reload-watched web directory.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { IncomingMessage, type ServerResponse } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import type { PocketApp } from "../src/server/app.ts";
import type { createHandler } from "../src/server/http.ts";

const revision = "0123456789abcdef";
const base = `/herdr-renderer/${revision}`;
const immutable = "public, max-age=31536000, immutable";
const inlineScript = '{"pi-sessions":{}}';
const wasm = Buffer.concat([Buffer.from("\0asm\x01\0\0\0"), Buffer.alloc(512 * 1024, 42)]);
const fixtures = new Map<string, Buffer>([
    [
        "/index.html",
        Buffer.from(
            `<!doctype html><head><script type="importmap">${inlineScript}</script></head>`,
        ),
    ],
    [`${base}/index.html`, Buffer.from("<!doctype html><title>synthetic renderer</title>")],
    [`${base}/renderer.js`, Buffer.from("// synthetic renderer code\n".repeat(2048))],
    [`${base}/style.css`, Buffer.from("body { margin: 0; }")],
    [`${base}/pkg/herdr_renderer.js`, Buffer.from("export default function init() {}")],
    [`${base}/pkg/herdr_renderer_bg.wasm`, wasm],
    [`${base}/NOTICE-PROTOCOL.md`, Buffer.from("Synthetic public notice")],
    [`${base}/fonts/JetBrainsMonoNerdFont-OFL.txt`, Buffer.from("Synthetic public font license")],
    ["/herdr-renderer/build.json", Buffer.from('{"entry":"0123456789abcdef/index.html"}')],
    ["/terminal-renderer.js", Buffer.from("// editable app source")],
    ["/herdr-renderer/dev/renderer.js", Buffer.from("// unversioned development code")],
    [`${base}/output.json`, Buffer.from('{"not":"a renderer build asset"}')],
]);
let directory: string;
let handle: ReturnType<typeof createHandler>;

class Response extends Writable {
    statusCode = 200;
    headersSent = false;
    headers = new Map<string, string>();
    chunks: Buffer[] = [];

    setHeader(name: string, value: string) {
        this.headers.set(name.toLowerCase(), value);
    }

    writeHead(status: number, headers: Record<string, string>) {
        this.statusCode = status;
        this.headersSent = true;

        for (const [name, value] of Object.entries(headers)) {
            this.setHeader(name, value);
        }

        return this;
    }

    _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
        this.chunks.push(Buffer.from(chunk));
        callback();
    }

    get body() {
        return Buffer.concat(this.chunks);
    }
}

before(async () => {
    directory = await mkdtemp(join(tmpdir(), "pi-renderer-assets-"));
    await cp(new URL("../src", import.meta.url), join(directory, "src"), { recursive: true });
    await symlink(
        fileURLToPath(new URL("../node_modules", import.meta.url)),
        join(directory, "node_modules"),
    );
    await mkdir(join(directory, "web"));
    await cp(
        new URL("../web/theme-surface.js", import.meta.url),
        join(directory, "web/theme-surface.js"),
    );
    await writeFile(join(directory, "package.json"), '{"type":"module"}');

    for (const [path, body] of fixtures) {
        const file = join(directory, "web", path);

        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, body);
    }

    const loaded: typeof import("../src/server/http.ts") = await import(
        pathToFileURL(join(directory, "src/server/http.ts")).href
    );
    const app = {
        config: { userByToken: () => undefined },
        webRevision: "synthetic",
    } as unknown as PocketApp;

    handle = loaded.createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart() {} });
});
after(async () => {
    if (directory) {
        await rm(directory, { recursive: true, force: true });
    }
});

async function request(path: string, headers: Record<string, string> = {}, method = "GET") {
    const incoming = new IncomingMessage(new Socket());
    const response = new Response();

    incoming.url = path;
    incoming.method = method;
    incoming.headers = headers;
    await handle(incoming, response as unknown as ServerResponse);
    await finished(response);

    return response;
}

test("app CSP permits WASM compile without allowing arbitrary script evaluation or remote sources", async () => {
    const response = await request("/");
    const policy = response.headers.get("content-security-policy");

    assert.equal(response.statusCode, 200);
    assert.ok(policy);
    const directives = new Map(
        policy.split("; ").map((entry) => {
            const [name, ...sources] = entry.split(" ");

            return [name, sources];
        }),
    );
    const hash = createHash("sha256").update(inlineScript).digest("base64");

    assert.deepEqual(directives.get("script-src"), [
        "'self'",
        "'wasm-unsafe-eval'",
        `'sha256-${hash}'`,
    ]);
    assert.deepEqual(directives.get("connect-src"), ["'self'"]);
    assert.deepEqual(directives.get("object-src"), ["'none'"]);
});

test("versioned renderer builds are typed immutable assets, not uncached app files", async () => {
    const assets: [string, string][] = [
        [`${base}/index.html`, "text/html; charset=utf-8"],
        [`${base}/renderer.js`, "text/javascript; charset=utf-8"],
        [`${base}/style.css`, "text/css; charset=utf-8"],
        [`${base}/pkg/herdr_renderer.js`, "text/javascript; charset=utf-8"],
        [`${base}/pkg/herdr_renderer_bg.wasm`, "application/wasm"],
        [`${base}/NOTICE-PROTOCOL.md`, "text/markdown; charset=utf-8"],
        [`${base}/fonts/JetBrainsMonoNerdFont-OFL.txt`, "text/plain; charset=utf-8"],
    ];

    for (const [path, type] of assets) {
        const response = await request(path);

        assert.equal(response.statusCode, 200, path);
        assert.equal(response.headers.get("cache-control"), immutable, path);
        assert.equal(response.headers.get("content-type"), type, path);
        assert.equal(response.headers.get("x-content-type-options"), "nosniff");
        assert.deepEqual(response.body, fixtures.get(path));
    }
});

test("renderer validators and HEAD reuse the selected resource without a response body", async () => {
    const path = `${base}/pkg/herdr_renderer_bg.wasm`;
    const first = await request(path);
    const etag = first.headers.get("etag");
    const modified = first.headers.get("last-modified");

    assert.ok(etag);
    assert.ok(modified);

    const conditions: Record<string, string>[] = [
        { "if-none-match": `"other-resource", ${etag}` },
        { "if-none-match": "*" },
        { "if-modified-since": modified },
    ];

    for (const headers of conditions) {
        const response = await request(path, headers);

        assert.equal(response.statusCode, 304);
        assert.equal(response.headers.get("cache-control"), immutable);
        assert.equal(response.headers.get("etag"), etag);
        assert.equal(response.body.length, 0);
    }

    const precedence = await request(path, {
        "if-none-match": '"another-version"',
        "if-modified-since": modified,
    });
    const head = await request(path, {}, "HEAD");

    assert.equal(precedence.statusCode, 200, "a nonmatching ETag takes precedence over the date");
    assert.equal(head.statusCode, 200);
    assert.equal(head.headers.get("content-length"), String(wasm.length));
    assert.equal(head.headers.get("content-type"), "application/wasm");
    assert.equal(head.headers.get("etag"), etag);
    assert.equal(head.body.length, 0);
});

test("gzip is negotiated for large renderer transfers, with identity and refusal respected", async () => {
    for (const path of [`${base}/pkg/herdr_renderer_bg.wasm`, `${base}/renderer.js`]) {
        const compressed = await request(path, { "accept-encoding": "br, gzip" });
        const source = fixtures.get(path)!;

        assert.equal(compressed.statusCode, 200);
        assert.equal(compressed.headers.get("content-encoding"), "gzip");
        assert.equal(compressed.headers.get("vary"), "accept-encoding");
        assert.equal(compressed.headers.get("content-length"), undefined);
        assert.ok(compressed.body.length < source.length);
        assert.deepEqual(gunzipSync(compressed.body), source);

        const head = await request(path, { "accept-encoding": "gzip" }, "HEAD");
        const unchanged = await request(path, {
            "accept-encoding": "gzip",
            "if-none-match": compressed.headers.get("etag")!,
        });
        const identity = await request(path, { "accept-encoding": "gzip ; q=0, *;q=1" });
        const refused = await request(path, { "accept-encoding": "gzip;q=0, identity;q=0" });

        assert.equal(head.headers.get("content-encoding"), "gzip");
        assert.equal(head.body.length, 0);
        assert.equal(unchanged.statusCode, 304);
        assert.equal(unchanged.headers.get("vary"), "accept-encoding");
        assert.equal(unchanged.body.length, 0);
        assert.equal(identity.headers.get("content-encoding"), undefined);
        assert.deepEqual(identity.body, source);
        assert.equal(refused.statusCode, 406);
        assert.equal(refused.headers.get("cache-control"), "no-store");
    }
});

test("cancelling an active renderer transfer stops delivery before the whole payload is buffered", async () => {
    const incoming = new IncomingMessage(new Socket());
    const response = new Response();

    incoming.url = `${base}/pkg/herdr_renderer_bg.wasm`;
    incoming.method = "GET";
    incoming.headers = {};

    response._write = (chunk, _encoding, callback) => {
        response.chunks.push(Buffer.from(chunk));
        response.destroy();
        callback();
    };

    const closed = finished(response).catch((error: unknown) => error);

    await handle(incoming, response as unknown as ServerResponse);
    await closed;
    assert.equal(response.destroyed, true);
    assert.ok(response.body.length > 0);
    assert.ok(
        response.body.length < wasm.length,
        "client cancellation does not deliver a full-file buffer",
    );
});

test("only expected immutable build paths opt into caching; fresh and private routes stay fresh", async () => {
    for (const path of [
        "/herdr-renderer/build.json",
        "/terminal-renderer.js",
        "/herdr-renderer/dev/renderer.js",
        `${base}/output.json`,
    ]) {
        const response = await request(path, { "accept-encoding": "gzip" });

        assert.equal(response.statusCode, 200);
        assert.equal(response.headers.get("cache-control"), "no-cache");
        assert.equal(response.headers.get("content-encoding"), undefined);
        assert.deepEqual(response.body, fixtures.get(path));
    }

    const missing = await request("/herdr-renderer/ffffffffffffffff/pkg/herdr_renderer_bg.wasm");
    const escape = await request(
        `/herdr-renderer/${revision}/%2e%2e%2f%2e%2e%2f%2e%2e%2fpackage.json`,
    );
    const privateRoute = await request("/api/private/sessions");
    const wrongMethod = await request(`${base}/renderer.js`, {}, "POST");

    assert.equal(missing.statusCode, 404);
    assert.equal(missing.headers.get("cache-control"), "no-store");
    assert.equal(escape.statusCode, 404);
    assert.equal(escape.headers.get("cache-control"), "no-store");
    assert.equal(privateRoute.statusCode, 401);
    assert.equal(privateRoute.headers.get("cache-control"), "no-store");
    assert.equal(wrongMethod.statusCode, 405);
    assert.equal(wrongMethod.headers.get("allow"), "GET, HEAD");
    assert.equal(wrongMethod.headers.get("cache-control"), "no-store");
});
