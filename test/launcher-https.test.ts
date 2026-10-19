// Owns the launcher's terminal/child-IPC contract, not cryptographic TLS or a real Tailscale account.
// Core TLS tests own real certificates and handshake. These process fixtures own preflight-before-stop,
// same-address HTTP/HTTPS transitions, announcements and saved access without opening any listener.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

async function fixture(mode: string, failing = false, missingReadyUrl = false) {
    const directory = await mkdtemp(join(tmpdir(), "coop-launcher-tls-"));
    const eventsFile = join(directory, "events.jsonl");
    const failureFile = join(directory, "certificate-failure");
    const preload = join(directory, "preload.mjs");
    const serverUrl = new URL("../src/server/main.ts", import.meta.url).href;
    const tlsUrl = new URL("../src/server/tailscale-https.ts", import.meta.url).href;
    const childSource = `
        import { appendFileSync } from 'node:fs';
        const args = process.argv.slice(2);
        const https = args.includes('--tailscale-https');
        const record = (kind) => appendFileSync(${JSON.stringify(eventsFile)}, JSON.stringify({ kind, https, pid: process.pid, args }) + '\\n');
        record('server-start');
        process.on('SIGUSR2', () => { record('server-restart'); process.exit(75); });
        process.on('SIGTERM', () => { record('server-stop'); process.exit(0); });
        process.on('disconnect', () => { record('server-stop'); process.exit(0); });
        process.on('message', () => {});
        process.send({ type: 'ready', loginPath: '/login?token=disposable-fixture-token', ...(https && ${!missingReadyUrl} ? { url: 'https://coop-fixture.tail-example.ts.net:9443' } : {}) });
        setInterval(() => {}, 1000);
    `;
    const tlsSource = `
        import { appendFileSync, existsSync } from 'node:fs';
        export async function loadTailscaleCertificate() {
            appendFileSync(${JSON.stringify(eventsFile)}, JSON.stringify({ kind: 'certificate-preflight' }) + '\\n');
            if (existsSync(${JSON.stringify(failureFile)})) throw new Error('Fixture certificate unavailable');
            return { hostname: 'coop-fixture.tail-example.ts.net', address: '100.64.0.42', key: Buffer.from('disposable-fixture-key'), cert: Buffer.from('disposable-fixture-cert') };
        }
    `;

    await writeFile(
        preload,
        `
        import { registerHooks, syncBuiltinESMExports } from 'node:module';
        import os from 'node:os';
        os.networkInterfaces = () => ({ tailscale0: [{ family: 'IPv4', internal: false, address: '100.64.0.42' }] });
        syncBuiltinESMExports();
        Object.defineProperty(process.stdin, 'isTTY', { value: true });
        Object.defineProperty(process.stdout, 'isTTY', { value: true });
        process.stdin.setRawMode = () => {};
        registerHooks({ load(url, context, next) {
            if (url === ${JSON.stringify(serverUrl)}) return { format: 'module', source: ${JSON.stringify(childSource)}, shortCircuit: true };
            if (url === ${JSON.stringify(tlsUrl)}) return { format: 'module', source: ${JSON.stringify(tlsSource)}, shortCircuit: true };
            return next(url, context);
        } });
    `,
    );

    if (failing) {
        await writeFile(failureFile, "unavailable");
    }

    const child = spawn(
        process.execPath,
        [
            "src/launcher/main.ts",
            "--access",
            mode,
            "--port",
            "9443",
            "--data",
            directory,
            "--cwd",
            directory,
        ],
        {
            stdio: ["pipe", "pipe", "pipe"],
            env: {
                ...process.env,
                NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
                NO_COLOR: "1",
                PI_POCKET_HOST: "",
                PI_POCKET_ACCESS: "",
                PI_POCKET_PORT: "8787",
            },
        },
    );
    let output = "";

    child.stdout.on("data", (data: Buffer) => {
        output = (output + data.toString()).slice(-256 * 1024);
    });
    child.stderr.on("data", (data: Buffer) => {
        output = (output + data.toString()).slice(-256 * 1024);
    });
    const exited = new Promise<number | null>((resolve, reject) => {
        child.once("exit", resolve);
        child.once("error", reject);
    });

    const events = async (): Promise<
        { kind: string; https?: boolean; pid?: number; args?: string[] }[]
    > => {
        const text = await readFile(eventsFile, "utf8").catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") {
                return "";
            }

            throw error;
        });

        return text.trim()
            ? text
                  .trim()
                  .split("\n")
                  .map((line) => JSON.parse(line))
            : [];
    };

    const wait = async (predicate: () => boolean | Promise<boolean>) => {
        const deadline = Date.now() + 5000;

        while (!(await predicate())) {
            if (Date.now() >= deadline) {
                throw new Error(`Launcher did not reach the expected state:\n${output}`);
            }

            await delay(10);
        }
    };

    return {
        child,
        directory,
        failureFile,
        events,
        wait,
        exited,
        output: () => output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""),
        async choose(mode: "http" | "https") {
            const before = output.length;

            child.stdin.write("a");
            await wait(() =>
                output.slice(before).includes("How should your devices reach Pi Coop?"),
            );
            child.stdin.write(mode === "https" ? "4\r" : "5\r");
        },
        async close() {
            if (child.exitCode === null) {
                child.stdin.write("q");
                const timer = setTimeout(() => child.kill("SIGKILL"), 5000);

                await exited.finally(() => clearTimeout(timer));
            }

            await wait(async () => {
                const entries = await events();
                const stopped = new Set(
                    entries
                        .filter(
                            (event) =>
                                event.kind === "server-stop" || event.kind === "server-restart",
                        )
                        .map((event) => event.pid),
                );

                return entries
                    .filter((event) => event.kind === "server-start")
                    .every((event) => stopped.has(event.pid));
            });
            await rm(directory, { recursive: true, force: true });
        },
    };
}

test("certificate preflight failure preserves a running HTTP child; same-address TLS switches restart with the right URLs", async () => {
    const f = await fixture("tailscale");

    try {
        await f.wait(() => f.output().includes("http://100.64.0.42:9443/login?token="));
        await writeFile(f.failureFile, "unavailable");
        await f.choose("https");
        await f.wait(() => f.output().includes("Fixture certificate unavailable"));
        let events = await f.events();

        assert.equal(events.filter((event) => event.kind === "server-start").length, 1);
        assert.equal(
            events.some((event) => event.kind === "server-restart"),
            false,
        );
        const initial = events.find((event) => event.kind === "server-start");

        assert.ok(initial?.pid);
        assert.doesNotThrow(() => process.kill(initial.pid!, 0));
        assert.equal(
            JSON.parse(await readFile(join(f.directory, "launcher.json"), "utf8")).access,
            "tailscale",
        );
        await rm(f.failureFile);
        await f.choose("https");
        await f.wait(() =>
            f.output().includes("https://coop-fixture.tail-example.ts.net:9443/login?token="),
        );
        events = await f.events();
        const restarts = events.filter((event) => event.kind === "server-start");

        assert.deepEqual(
            restarts.map((event) => event.https),
            [false, true],
        );
        assert.ok(restarts[1]?.args?.includes("--tailscale-https"));
        assert.ok(
            events.findIndex((event) => event.kind === "certificate-preflight") <
                events.findIndex((event) => event.kind === "server-restart"),
        );
        assert.equal(
            JSON.parse(await readFile(join(f.directory, "launcher.json"), "utf8")).access,
            "tailscale-https",
        );
        const before = f.output().length;

        await f.choose("http");
        await f.wait(() =>
            f.output().slice(before).includes("http://100.64.0.42:9443/login?token="),
        );
        assert.deepEqual(
            (await f.events())
                .filter((event) => event.kind === "server-start")
                .map((event) => event.https),
            [false, true, false],
        );
        assert.equal(
            f
                .output()
                .slice(before)
                .includes("https://coop-fixture.tail-example.ts.net:9443/login?token="),
            false,
        );
    } finally {
        await f.close();
    }
});

test("the launcher cannot announce HTTPS readiness without the child's actual HTTPS URL", async () => {
    const f = await fixture("tailscale-https", false, true);

    try {
        await f.wait(() => f.child.exitCode !== null || f.output().includes("/login?token="));
        assert.equal(f.output().includes("/login?token="), false);
        assert.equal(await f.exited, 1);
    } finally {
        await f.close();
    }
});

test("an explicitly requested HTTPS launch fails closed before starting any child when certificates are unavailable", async () => {
    const f = await fixture("tailscale-https", true);

    try {
        assert.equal(await f.exited, 1);
        assert.ok(f.output().includes("Fixture certificate unavailable"));
        assert.equal(
            (await f.events()).some((event) => event.kind === "server-start"),
            false,
        );
        assert.equal(f.output().includes("/login?token="), false);
    } finally {
        await f.close();
    }
});
