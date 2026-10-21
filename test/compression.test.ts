// Delivery contracts over genuine HTTP and paired memory streams: no listener or live data.
// The disposable source root permits same-size edits without reloading anyone's running app.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { cp, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { Agent, createServer, type IncomingMessage, request, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import zlib from "node:zlib";
import { join } from "node:path";
import { duplexPair } from "node:stream";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { brotliDecompressSync, createBrotliDecompress, createGunzip, gunzipSync } from "node:zlib";
import type { PocketApp } from "../src/server/app.ts";
import type { User } from "../src/server/config.ts";
import type { createHandler } from "../src/server/http.ts";
import type { Client } from "../src/server/room.ts";
import { until } from "./helpers.ts";

let directory: string;
let handler: ReturnType<typeof createHandler>;
let io: typeof import("../src/server/http/io.ts");
const clients = new Set<Client>();
const sample = { message: "shared delivery text — ".repeat(4096) };
const css = fs.readFileSync(new URL("../web/style.css", import.meta.url));
const user = { id: "owner", name: "Owner", role: "owner" } as User;

before(async () => {
    directory = await mkdtemp(join(tmpdir(), "pi-compression-"));
    await cp(new URL("../src", import.meta.url), join(directory, "src"), { recursive: true });
    await symlink(
        fileURLToPath(new URL("../node_modules", import.meta.url)),
        join(directory, "node_modules"),
    );
    await cp(new URL("../web", import.meta.url), join(directory, "web"), {
        recursive: true,
        filter: (source) => !source.includes("/herdr-renderer"),
    });
    await writeFile(join(directory, "package.json"), '{"type":"module"}');
    const fixtures: Record<string, string | Buffer> = {
        "index.html":
            '<!doctype html><head><script type="importmap">{"imports":{"preact":"/vendor/preact.mjs"}}</script></head>',
        "app.js":
            'import "./store.js";\nimport("./editor-library.js");\nimport("./terminal-grid.js");',
        "store.js": 'export { value } from "./nested.js";\nimport { h } from "preact";',
        "nested.js": 'import "./store.js";\nexport const value = 1;',
        "style.css": css,
        "image.png": randomBytes(4096),
    };

    for (const [file, body] of Object.entries(fixtures)) {
        await writeFile(join(directory, "web", file), body);
    }

    const loaded: typeof import("../src/server/http.ts") = await import(
        pathToFileURL(join(directory, "src/server/http.ts")).href
    );

    io = await import(pathToFileURL(join(directory, "src/server/http/io.ts")).href);
    const app = {
        config: { userByToken: () => user, userById: () => user },
        webRevision: "delivery-fixture",
        hello: () => sample,
        attach: async (client: Client) => {
            clients.add(client);
            client.send("hello", sample);
        },
        detach: (client: Client) => clients.delete(client),
    } as unknown as PocketApp;

    handler = loaded.createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart() {} });
});

after(async () => {
    for (const client of clients) {
        client.close?.();
    }

    await rm(directory, { recursive: true, force: true });
});

/** Use Node's HTTP parser, ServerResponse, client, and backpressure without opening a socket. */
async function open(
    path: string,
    headers: Record<string, string> = {},
    method = "GET",
    serve = handler,
) {
    const [client, peer] = duplexPair();
    const agent = new Agent();
    let response: ServerResponse | undefined;
    const server = createServer((incoming, outgoing) => {
        response = outgoing;
        void serve(incoming, outgoing);
    });

    agent.createConnection = () => client as ReturnType<Agent["createConnection"]>;
    server.emit("connection", peer);
    const pending = request({
        host: "memory",
        path,
        method,
        agent,
        headers: { authorization: "Bearer fixture", ...headers },
    });
    const result = new Promise<IncomingMessage>((resolve, reject) => {
        pending.once("response", resolve);
        pending.once("error", reject);
    });

    const close = () => {
        pending.destroy();
        client.destroy();
        peer.destroy();
        agent.destroy();
        server.close();
    };

    pending.end();
    let incoming: IncomingMessage;

    try {
        incoming = await result;
    } catch (error) {
        close();

        throw error;
    }

    return {
        incoming,
        response: response!,
        close() {
            incoming.destroy();
            close();
        },
    };
}

async function get(
    path: string,
    headers: Record<string, string> = {},
    method = "GET",
    serve = handler,
) {
    const connection = await open(path, headers, method, serve);
    const chunks: Buffer[] = [];

    try {
        for await (const chunk of connection.incoming) {
            chunks.push(chunk);
        }

        return {
            status: connection.incoming.statusCode,
            headers: connection.incoming.headers,
            body: Buffer.concat(chunks),
        };
    } finally {
        connection.close();
    }
}

function decoded(body: Buffer, encoding: string | undefined): Buffer {
    return encoding === "br"
        ? brotliDecompressSync(body)
        : encoding === "gzip"
          ? gunzipSync(body)
          : body;
}

test("static text saves measured bytes with either encoding and revalidates across encodings", async (t) => {
    for (const encoding of ["br", "gzip"]) {
        const first = await get("/style.css", { "accept-encoding": encoding });

        assert.equal(first.headers["content-encoding"], encoding);
        assert.deepEqual(decoded(first.body, encoding), css);
        assert.ok(first.body.length < css.length / 3);
        assert.match(String(first.headers.vary), /accept-encoding/i);
        assert.equal(first.headers["cache-control"], "no-cache");
        t.diagnostic(`${encoding}: ${css.length} -> ${first.body.length} bytes`);
        const again = await get("/style.css", {
            "accept-encoding": "identity",
            "if-none-match": `"other", ${first.headers.etag}`,
        });

        assert.equal(again.status, 304);
        assert.equal(again.body.length, 0);
        assert.equal((await get("/style.css", { "if-none-match": "*" })).status, 304);
    }

    const identity = await get("/style.css", { "accept-encoding": "br;q=0, gzip;q=0" });

    assert.equal(identity.headers["content-encoding"], undefined);
    assert.deepEqual(identity.body, css);
    const head = await get("/style.css", { "accept-encoding": "gzip" }, "HEAD");

    assert.equal(head.body.length, 0);
    assert.ok(Number(head.headers["content-length"]) < css.length);
});

test("an equal-sized live edit invalidates both the ETag and previously compressed bytes on a coarse clock", async (t) => {
    const file = join(directory, "web", "fresh.css");
    const firstBody = "a".repeat(4096);
    const secondBody = "b".repeat(4096);
    const timestamp = new Date();

    const stat = fs.statSync;

    // Model a filesystem tick that cannot distinguish the two equal-sized writes. Content, not
    // a test-supplied ETag, must determine the second response even with identical metadata.
    t.mock.method(fs, "statSync", (path: fs.PathLike, options?: fs.StatSyncOptions) => {
        const result = stat(path, options);

        if (result !== undefined && String(path) === file && options?.bigint) {
            const time = BigInt(timestamp.getTime()) * 1_000_000n;

            Object.assign(result, { mtimeNs: time, ctimeNs: time });
        }

        return result;
    });
    syncBuiltinESMExports();
    t.after(() => {
        t.mock.restoreAll();
        syncBuiltinESMExports();
    });
    await writeFile(file, firstBody);
    await utimes(file, timestamp, timestamp);
    const first = await get("/fresh.css", { "accept-encoding": "gzip" });

    await writeFile(file, secondBody);
    await utimes(file, timestamp, timestamp);
    const second = await get("/fresh.css", {
        "accept-encoding": "gzip",
        "if-none-match": String(first.headers.etag),
    });

    assert.equal(second.status, 200);
    assert.notEqual(second.headers.etag, first.headers.etag);
    assert.equal(decoded(second.body, second.headers["content-encoding"]).toString(), secondBody);
    await rm(file);
    assert.equal((await get("/fresh.css")).status, 404);
});

test("app preloads traverse static imports and cycles but leave editor and terminal payloads lazy", async () => {
    const page = await get("/");
    const body = page.body.toString();
    const links = [...body.matchAll(/rel="modulepreload" href="([^"]+)"/g)].map(
        (match) => match[1],
    );

    assert.deepEqual(
        new Set(links),
        new Set(["/app.js", "/store.js", "/nested.js", "/vendor/preact.mjs"]),
    );
    assert.equal(links.length, new Set(links).size);
    assert.match(body, /name="pocket-web-revision" content="delivery-fixture"/);
    assert.match(String(page.headers["content-security-policy"]), /'wasm-unsafe-eval'/);
    assert.doesNotMatch(String(page.headers["content-security-policy"]), /'unsafe-eval'/);
});

test("API JSON and poll answers compress without changing their payload or acknowledgement replay", async (t) => {
    const api = await get("/api/me", { "accept-encoding": "br;q=0.5, gzip;q=1" });

    assert.equal(api.headers["content-encoding"], "gzip");
    assert.deepEqual(JSON.parse(decoded(api.body, "gzip").toString()), sample);
    const poll = await get("/api/poll", { "accept-encoding": "br" });

    try {
        assert.equal(poll.headers["content-encoding"], "br");
        const payload = JSON.parse(decoded(poll.body, "br").toString());

        assert.deepEqual(payload.events, [{ seq: 1, event: "hello", data: sample }]);
        assert.ok(poll.body.length < Buffer.byteLength(JSON.stringify(payload)) / 3);
        const replay = await get(`/api/poll?session=${payload.session}&ack=0`, {
            "accept-encoding": "gzip",
        });

        assert.deepEqual(JSON.parse(decoded(replay.body, "gzip").toString()), payload);
        await get(`/api/poll?session=${payload.session}&close=1`);
        t.diagnostic(
            `poll: ${Buffer.byteLength(JSON.stringify(payload))} -> ${poll.body.length} bytes`,
        );
    } finally {
        for (const client of clients) {
            client.close?.();
        }
    }
});

for (const encoding of ["br", "gzip", "identity"]) {
    test(
        `${encoding} SSE flushes a second event before close and rejects sends during graceful close`,
        { timeout: 5000 },
        async (t) => {
            const connection = await open("/api/events", { "accept-encoding": encoding });
            const inflate =
                encoding === "br"
                    ? createBrotliDecompress()
                    : encoding === "gzip"
                      ? createGunzip()
                      : undefined;
            const stream =
                inflate === undefined ? connection.incoming : connection.incoming.pipe(inflate);
            let text = "";
            let bytes = 0;
            let ended = false;

            connection.incoming.on(
                "data",
                (chunk: Buffer | string) => (bytes += Buffer.byteLength(chunk)),
            );
            stream.setEncoding("utf8");
            stream.on("data", (chunk: string) => (text += chunk));
            stream.on("end", () => (ended = true));
            stream.on("error", () => {});

            try {
                assert.equal(
                    connection.incoming.headers["content-encoding"],
                    encoding === "identity" ? undefined : encoding,
                );
                await until(() => text.includes("event: hello\n"), "first flushed event");
                const client = [...clients].find((item) => item.connection !== "")!;
                const before = bytes;

                client.send("next", { marker: "arrived-live" });
                await until(
                    () => text.includes('data: {"marker":"arrived-live"}\n\n'),
                    "second flushed event",
                );
                assert.equal(ended, false);
                assert.ok(bytes > before);
                t.diagnostic(
                    `${encoding} live stream: ${Buffer.byteLength(text)} -> ${bytes} bytes before close`,
                );
                client.close?.();
                client.send("late", { shouldNotArrive: true });
                await until(() => ended, "gracefully ended compressed stream");
                assert.doesNotMatch(text, /shouldNotArrive/);
                await until(() => !clients.has(client), "response close detaches tab");
            } finally {
                connection.close();
                inflate?.destroy();
            }
        },
    );
}

test("send preserves Vary, skips small/binary/already encoded answers, and negotiates quality weights", async () => {
    for (const [accept, expected] of [
        ["br, gzip", "br"],
        ["br;q=0.5, gzip;q=1", "gzip"],
        ["identity;q=1, gzip;q=0.1", undefined],
        ["identity;q=0.9, br;q=0.5, gzip;q=0.8", undefined],
        ["identity;q=0.1, gzip;q=0.8", "gzip"],
        ["br;q=0, *;q=0.8", "gzip"],
        ["br;q=2, gzip;q=garbage", undefined],
        ["identity", undefined],
    ] as const) {
        const body = JSON.stringify(sample);
        const result = await get(
            "/",
            { "accept-encoding": accept },
            "GET",
            async (_request, response) => {
                response.setHeader("Vary", "Origin");
                io.send(response, 200, body, "application/json", {
                    "Content-Length": String(Buffer.byteLength(body)),
                });
            },
        );

        assert.equal(result.headers["content-encoding"], expected, accept);
        assert.equal(decoded(result.body, expected).toString(), body);
        assert.deepEqual(
            String(result.headers.vary)
                .toLowerCase()
                .split(",")
                .map((part) => part.trim()),
            ["origin", "accept-encoding"],
        );
        assert.equal(Number(result.headers["content-length"]), result.body.length);
    }

    for (const [body, type, headers] of [
        ["small", "text/plain", {}],
        [Buffer.alloc(4096, 7), "image/png", {}],
        [
            zlib.gzipSync(JSON.stringify(sample)),
            "application/json",
            { "Content-Encoding": "gzip", Vary: "*" },
        ],
    ] as const) {
        const result = await get(
            "/",
            { "accept-encoding": "br" },
            "GET",
            async (_request, response) => {
                io.send(response, 200, body, type, headers);
            },
        );

        assert.deepEqual(result.body, Buffer.isBuffer(body) ? body : Buffer.from(body));
        assert.equal(
            result.headers["content-encoding"],
            "Content-Encoding" in headers ? "gzip" : undefined,
        );

        if ("Vary" in headers) {
            assert.equal(result.headers.vary, "*");
        }
    }
});

test("one-shot and cached compression failures fall back to identity and later requests can retry", async (t) => {
    const original = zlib.gzip;
    const settledNow = Date.now() + 5000;
    let fail = true;

    // Exercise retry on a retained file version, not on a fresh read that discarded its cache.
    t.mock.method(Date, "now", () => settledNow);

    t.mock.method(zlib, "gzip", (...args: Parameters<typeof zlib.gzip>) => {
        if (!fail) {
            return original(...args);
        }

        const callback = args.at(-1) as (error: Error) => void;

        queueMicrotask(() => callback(new Error("scripted zlib failure")));
    });
    syncBuiltinESMExports();

    try {
        const first = await get("/style.css", { "accept-encoding": "gzip" });

        assert.equal(first.status, 200);
        assert.equal(first.headers["content-encoding"], undefined);
        assert.deepEqual(first.body, css);
        const api = await get("/api/me", { "accept-encoding": "gzip" });

        assert.equal(api.headers["content-encoding"], undefined);
        assert.deepEqual(JSON.parse(api.body.toString()), sample);
        fail = false;
        const retry = await get("/style.css", { "accept-encoding": "gzip" });

        assert.equal(retry.headers["content-encoding"], "gzip");
        assert.deepEqual(gunzipSync(retry.body), css);
    } finally {
        t.mock.restoreAll();
        syncBuiltinESMExports();
    }
});

test(
    "a blocked compressed SSE reader backpressures output, caps pending input, and detaches on abort",
    { timeout: 15000 },
    async (t) => {
        const connection = await open("/api/events", { "accept-encoding": "gzip" });
        const client = [...clients][0]!;
        const noise = randomBytes(256 * 1024).toString("base64");

        connection.incoming.on("error", () => {});
        connection.incoming.pause();

        try {
            // Give zlib time to produce substantially more than the HTTP high-water mark. A data
            // handler that ignores response.write(false), unlike pipe, queues all of it in HTTP.
            for (let index = 0; index < 32; index++) {
                client.send("noise", { index, noise });
                await new Promise((resolve) => setTimeout(resolve, 10));
            }

            await until(
                () => connection.response.writableLength > 0,
                "HTTP output is actually blocked",
            );
            await new Promise((resolve) => setTimeout(resolve, 200));
            assert.ok(
                connection.response.writableLength < 1024 * 1024,
                "compressed output stops at HTTP backpressure, not an unbounded data listener",
            );
            t.diagnostic(
                `blocked HTTP buffer: ${connection.response.writableLength} bytes after ${32 * Buffer.byteLength(noise)} bytes of input`,
            );
            const chunk = "x".repeat(1024 * 1024);

            // The producer API is synchronous. The compressor's unsent input therefore needs an
            // admission cap independent of compressed bytes already buffered for the browser.
            for (let index = 0; index < 140 && !connection.response.destroyed; index++) {
                client.send("pending", { chunk });
            }

            assert.equal(
                connection.response.destroyed,
                true,
                "bounded pending input cuts off the tab even without another ping/event",
            );
            await until(() => !clients.has(client), "aborted reader detaches");
            client.send("late", sample);
        } finally {
            connection.close();
        }
    },
);

// With pipe, compressed HTTP output stays near its high-water mark. A stalled reader must
// still time out when it strands a large upstream input queue, rather than waiting for 128 MB.
test(
    "a compressed SSE tab that strands a backlog without taking bytes is cut off after 30 seconds",
    { timeout: 5000 },
    async (t) => {
        const connection = await open("/api/events", { "accept-encoding": "gzip" });
        const client = [...clients][0]!;
        const noise = randomBytes(256 * 1024).toString("base64");

        connection.incoming.on("error", () => {});
        connection.incoming.pause();

        try {
            for (let index = 0; index < 32; index++) {
                client.send("noise", { index, noise });
            }

            await until(() => connection.response.writableNeedDrain, "blocked HTTP writer");
            // Account for bytes taken before the writer blocked. Only the following interval
            // has no progress; an observation of earlier progress correctly restarts the clock.
            client.send("mark", {});
            const later = Date.now() + 31_000;

            t.mock.method(Date, "now", () => later);
            client.send("ping", {});
            assert.equal(
                connection.response.destroyed,
                true,
                "backpressure must not hide a stalled input backlog from the timeout",
            );
            await until(() => !clients.has(client), "stalled tab detaches");
        } finally {
            t.mock.restoreAll();
            connection.close();
        }
    },
);

test(
    "large one-shot compression leaves the event loop free before its HTTP answer completes",
    { timeout: 10000 },
    async (t) => {
        const body = randomBytes(8 * 1024 * 1024).toString("base64");
        let tickBeforeFinish = false;
        let launchMs = 0;
        const started = performance.now();
        const answer = await get(
            "/",
            { "accept-encoding": "br" },
            "GET",
            async (_request, response) => {
                const before = performance.now();

                io.send(response, 200, body);
                launchMs = performance.now() - before;
                setImmediate(() => (tickBeforeFinish = !response.writableEnded));
            },
        );

        assert.equal(
            tickBeforeFinish,
            true,
            "another event-loop turn runs while the large answer is compressing",
        );
        assert.equal(answer.headers["content-encoding"], "br");
        assert.equal(brotliDecompressSync(answer.body).toString(), body);
        t.diagnostic(
            "11.18 MB one-shot: send returned in " +
                launchMs.toFixed(2) +
                " ms; HTTP answer in " +
                (performance.now() - started).toFixed(2) +
                " ms",
        );
    },
);

test(
    "a compressed response header failure closes its reader without an unhandled rejection",
    { timeout: 5000 },
    async () => {
        await assert.rejects(
            get("/", { "accept-encoding": "gzip" }, "GET", async (_request, response) => {
                io.send(response, 200, "large answer ".repeat(1024), "text/plain", {
                    "x-invalid": "\n",
                });
            }),
            { code: "ECONNRESET" },
        );
    },
);

test("closing a one-shot reader before compression completes fences late headers and body", async (t) => {
    const original = zlib.gzip;
    let release: (() => void) | undefined;
    let response: ServerResponse | undefined;

    // Hold the real zlib result at the dependency boundary, not a synthetic encoded receipt.
    t.mock.method(zlib, "gzip", (...args: Parameters<typeof zlib.gzip>) => {
        const done = args.at(-1) as (error: Error | null, result: Buffer) => void;

        original(args[0], (error, result) => {
            release = () => done(error, result);
        });
    });
    syncBuiltinESMExports();

    try {
        await assert.rejects(
            get("/", { "accept-encoding": "gzip" }, "GET", async (_request, outgoing) => {
                response = outgoing;
                io.send(outgoing, 200, JSON.stringify(sample), "application/json");
                queueMicrotask(() => outgoing.destroy());
            }),
            /socket hang up|ECONNRESET/,
        );
        await until(() => release !== undefined, "real zlib result is ready");
        release!();
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(response?.destroyed, true);
        assert.equal(response?.headersSent, false, "no late compressed headers");
        assert.equal(response?.writableEnded, false, "no late compressed end/body");
    } finally {
        release?.();
        t.mock.restoreAll();
        syncBuiltinESMExports();
    }
});
