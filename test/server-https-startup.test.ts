// Owns the executable server entry point's shutdown-before-resume/readiness ordering.
// A memory-only listener stand-in avoids network capabilities; real TLS/HTTP is owned by tailscale-https.test.ts.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

async function run(phase: "bind" | "open") {
    const directory = await mkdtemp(join(tmpdir(), "coop-https-startup-"));
    const preload = join(directory, "preload.mjs");
    const events = join(directory, "events.jsonl");
    const source = (body: string) =>
        `import {appendFileSync} from 'node:fs'; const record = (kind) => appendFileSync(${JSON.stringify(events)}, JSON.stringify({kind}) + '\\n'); ${body}`;
    const replacements = {
        [new URL("../src/server/tailscale-https.ts", import.meta.url).href]: source(`
            import {createServer} from 'node:http';
            export async function createTailscaleHttpsServer({handler}) {
                const server = createServer(handler);
                server.listen = (_port, _host, ready) => {
                    ${phase === "bind" ? "process.emit('SIGTERM');" : ""}
                    queueMicrotask(ready);
                    return server;
                };
                return {server, hostname:'fixture.tail-example.ts.net', address:'100.64.0.42', async close(){record('tls-close');}};
            }
        `),
        [new URL("../src/server/app.ts", import.meta.url).href]: source(`
            export const PocketApp = {async open() {
                record('app-open');
                ${
                    phase === "bind"
                        ? "throw new Error('App.open ran after a pending stop');"
                        : `
                    process.emit('SIGTERM');
                    return {config:{ownerToken:'disposable-fixture-token'},loader:{watch(){}},themes:{watch(){}},async close(){record('app-close');}};
                `
                }
            }};
        `),
        [new URL("../src/server/http.ts", import.meta.url).href]: source(
            "export function createHandler(){record('handler');return ()=>{};}",
        ),
        [new URL("../src/server/reload.ts", import.meta.url).href]:
            "export function watchTree(){return ()=>{};}",
    };

    await writeFile(
        preload,
        `
        import {registerHooks} from 'node:module';
        const replacements = ${JSON.stringify(replacements)};
        registerHooks({load(url, context, next) {
            return replacements[url] === undefined ? next(url, context) : {format:'module',source:replacements[url],shortCircuit:true};
        }});
    `,
    );
    const child = spawn(
        process.execPath,
        ["src/server/main.ts", "--tailscale-https", "--data", directory, "--port", "9443"],
        {
            stdio: ["ignore", "pipe", "pipe", "ipc"],
            env: {
                ...process.env,
                PI_POCKET_LAUNCHER: "1",
                NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
            },
        },
    );
    const messages: unknown[] = [];
    let output = "";

    assert.ok(child.stdout && child.stderr);
    child.on("message", (message) => messages.push(message));
    child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
        output += chunk.toString();
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);

    try {
        const code = await new Promise<number | null>((resolve, reject) => {
            child.once("exit", resolve);
            child.once("error", reject);
        });
        const recorded: { kind: string }[] = (
            await readFile(events, "utf8").catch((error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") {
                    return "";
                }

                throw error;
            })
        )
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line));

        return { code, messages, output, recorded };
    } finally {
        clearTimeout(timer);
        child.kill();
        await rm(directory, { recursive: true, force: true });
    }
}

test("pending shutdown after bind cannot open/resume the app or publish readiness", async () => {
    const result = await run("bind");

    assert.equal(
        result.recorded.some(({ kind }) => kind === "app-open"),
        false,
    );
    assert.equal(result.code, 0, result.output);
    assert.equal(
        result.recorded.some(({ kind }) => kind === "tls-close"),
        true,
    );
    assert.deepEqual(result.messages, []);
});

test("a shutdown while app opening closes the app without installing routes or publishing ready", async () => {
    const result = await run("open");

    assert.equal(
        result.recorded.some(({ kind }) => kind === "app-open"),
        true,
    );
    assert.equal(
        result.recorded.some(({ kind }) => kind === "app-close"),
        true,
    );
    assert.equal(
        result.recorded.some(({ kind }) => kind === "handler"),
        false,
    );
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(result.messages, []);
});
