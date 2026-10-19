import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { X509Certificate, createPrivateKey } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:https";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { duplexPair } from "node:stream";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { connect } from "node:tls";
import { origin, setAuthCookie } from "../src/server/auth.ts";
import {
    createTailscaleHttpsServer,
    loadTailscaleCertificate,
} from "../src/server/tailscale-https.ts";

const HOSTNAME = "coop.tail1234.ts.net";
const ADDRESS = "100.101.102.103";
const INTERVAL = 12 * 60 * 60 * 1000;
const status = () => ({
    BackendState: "Running",
    Self: { DNSName: `${HOSTNAME}.`, TailscaleIPs: ["fd7a:115c:a1e0::1", ADDRESS] },
});
let root: string;
let first: { cert: Buffer; key: Buffer; pair: string; fingerprint: string };
let second: typeof first;

before(async () => {
    root = await mkdtemp(join(tmpdir(), "coop-tls-test-"));
    await chmod(root, 0o700);

    async function certificate(name: string) {
        const keyFile = join(root, `${name}.key`);
        const certFile = join(root, `${name}.crt`);

        execFileSync(
            "openssl",
            [
                "req",
                "-x509",
                "-newkey",
                "rsa:2048",
                "-nodes",
                "-keyout",
                keyFile,
                "-out",
                certFile,
                "-days",
                "3",
                "-subj",
                `/CN=${HOSTNAME}/OU=${name}`,
                "-addext",
                `subjectAltName=DNS:${HOSTNAME}`,
            ],
            { stdio: "ignore" },
        );

        const cert = await readFile(certFile);
        const key = await readFile(keyFile);
        const pair = join(root, `${name}.pem`);

        await writeFile(pair, Buffer.concat([cert, key]), { mode: 0o600 });

        return { cert, key, pair, fingerprint: new X509Certificate(cert).fingerprint256 };
    }

    first = await certificate("first");
    second = await certificate("second");
});

after(async () => {
    first?.key.fill(0);
    second?.key.fill(0);

    if (root) {
        await rm(root, { recursive: true, force: true });
    }
});

type Spec = { status: unknown; pair: string; fail?: string; hang?: string; huge?: string };
type Invocation = { args: string[]; cli: string; pid: number };

async function fixture(t: { after(fn: () => Promise<void>): void }) {
    const directory = await mkdtemp(join(root, "cli-"));
    const bin = join(directory, "bin");
    const config = join(directory, "spec.json");
    const log = join(directory, "calls.jsonl");
    const oldPath = process.env.PATH;
    const oldFixture = process.env.COOP_TLS_FIXTURE;

    await mkdir(bin, { mode: 0o700 });
    await writeFile(log, "");
    await writeFile(
        join(bin, "tailscale"),
        `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.COOP_TLS_FIXTURE;
const args = process.argv.slice(2);
const spec = JSON.parse(fs.readFileSync(path.join(root, "spec.json"), "utf8"));
fs.appendFileSync(path.join(root, "calls.jsonl"), JSON.stringify({args, cli: process.env.TAILSCALE_BE_CLI, pid: process.pid}) + "\\n");
if (spec.fail === args[0]) {
    process.stderr.write("PRIVATE_DIAGNOSTIC_MUST_NOT_ESCAPE");
    process.stdout.write("PRIVATE_STDOUT_MUST_NOT_ESCAPE");
    process.exitCode = 1;
} else if (spec.hang === args[0]) {
    setInterval(() => {}, 1000);
} else if (spec.huge === args[0]) {
    process.stdout.write(Buffer.alloc(2 * 1024 * 1024, 88));
} else if (args[0] === "status" && args[1] === "--json") {
    process.stdout.write(JSON.stringify(spec.status));
} else if (args[0] === "cert" && args[1] === "--cert-file=-" && args[2] === "--key-file=-" && args[3] === "--min-validity=168h") {
    process.stdout.write(fs.readFileSync(spec.pair));
} else {
    process.exitCode = 2;
}
`,
        { mode: 0o700 },
    );

    const spec: Spec = { status: status(), pair: first.pair };

    const configure = async (next: Partial<Spec> = {}) => {
        Object.assign(spec, next);
        await writeFile(config, JSON.stringify(spec));
    };

    const calls = async (): Promise<Invocation[]> =>
        (await readFile(log, "utf8"))
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line));

    await configure();

    process.env.PATH = bin;
    process.env.COOP_TLS_FIXTURE = directory;
    t.after(async () => {
        if (oldPath === undefined) {
            delete process.env.PATH;
        } else {
            process.env.PATH = oldPath;
        }

        if (oldFixture === undefined) {
            delete process.env.COOP_TLS_FIXTURE;
        } else {
            process.env.COOP_TLS_FIXTURE = oldFixture;
        }

        await rm(directory, { recursive: true, force: true });
    });

    return { directory, bin, configure, calls };
}

async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
    const deadline = Date.now() + 5000;

    for (;;) {
        const value = await read();

        if (accept(value)) {
            return value;
        }

        assert.ok(Date.now() < deadline, "condition did not settle");
        await delay(5);
    }
}

/** Real TLS and HTTP over paired memory streams. No listening socket or network is used. */
async function request(server: Server) {
    const [clientStream, serverStream] = duplexPair();
    const client = connect({
        socket: clientStream,
        servername: HOSTNAME,
        ca: [first.cert, second.cert],
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
    });
    let fingerprint: string | undefined;
    let protocol: string | null;

    server.emit("connection", serverStream);

    try {
        const response = await new Promise<string>((resolve, reject) => {
            const chunks: Buffer[] = [];

            client.on("error", reject);
            client.on("secureConnect", () => {
                assert.equal(client.authorized, true);
                fingerprint = client.getPeerCertificate().fingerprint256;
                protocol = client.getProtocol();
                client.write(`GET / HTTP/1.1\r\nHost: ${HOSTNAME}\r\nConnection: close\r\n\r\n`);
            });
            client.on("data", (chunk: Buffer) => chunks.push(chunk));
            client.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        });

        return { response, fingerprint, protocol: protocol! };
    } finally {
        client.destroy();
        clientStream.destroy();
        serverStream.destroy();
    }
}

test("loads the native stdout pair without app certificate files or shell arguments", async (t) => {
    const cli = await fixture(t);
    const beforeFiles = await readdir(cli.directory);
    const certificate = await loadTailscaleCertificate();

    try {
        assert.equal(certificate.hostname, HOSTNAME);
        assert.equal(certificate.address, ADDRESS);
        assert.equal(new X509Certificate(certificate.cert).fingerprint256, first.fingerprint);
        assert.equal(
            new X509Certificate(first.cert).checkPrivateKey(createPrivateKey(certificate.key)),
            true,
        );
        assert.deepEqual(await readdir(cli.directory), beforeFiles);
        assert.deepEqual(
            (await cli.calls()).map(({ args, cli }) => ({ args, cli })),
            [
                { args: ["status", "--json"], cli: "1" },
                {
                    args: [
                        "cert",
                        "--cert-file=-",
                        "--key-file=-",
                        "--min-validity=168h",
                        HOSTNAME,
                    ],
                    cli: "1",
                },
            ],
        );
    } finally {
        certificate.key.fill(0);
    }
});

test("skips a writable executable on PATH instead of running untrusted code", async (t) => {
    const cli = await fixture(t);
    const unsafe = join(cli.directory, "unsafe");
    const marker = join(cli.directory, "unsafe-was-run");

    await mkdir(unsafe, { mode: 0o700 });
    await writeFile(
        join(unsafe, "tailscale"),
        `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "unsafe");`,
        { mode: 0o700 },
    );
    await chmod(join(unsafe, "tailscale"), 0o777);
    process.env.PATH = `${unsafe}${delimiter}${cli.bin}`;

    const certificate = await loadTailscaleCertificate();

    certificate.key.fill(0);
    await assert.rejects(readFile(marker), { code: "ENOENT" });
    assert.equal((await cli.calls()).length, 2);
});

test(
    "serves genuine TLS with HTTPS origin and Secure authentication cookie before any listen",
    { timeout: 10_000 },
    async (t) => {
        await fixture(t);

        const https = await createTailscaleHttpsServer({
            host: ADDRESS,
            handler(req, res) {
                setAuthCookie(req, res, "test-token");
                res.end(origin(req));
            },
        });

        t.after(() => https.close());
        assert.equal(https.hostname, HOSTNAME);
        assert.equal(https.address, ADDRESS);
        assert.equal(https.server.listening, false);

        const result = await request(https.server);

        assert.equal(result.fingerprint, first.fingerprint);
        assert.match(result.protocol!, /^TLSv1\.[23]$/);
        assert.match(result.response, /HTTP\/1\.1 200 OK/);
        assert.match(result.response, /set-cookie: pocket_auth=test-token;[^\r\n]*; Secure/i);
        assert.ok(result.response.endsWith(`https://${HOSTNAME}`));
    },
);

test("rejects unsafe or unavailable self identity before requesting a certificate", async (t) => {
    const cli = await fixture(t);
    const invalid = [
        null,
        { ...status(), BackendState: "NeedsLogin" },
        { ...status(), Self: null },
        { ...status(), Self: { ...status().Self, DNSName: "*.tail1234.ts.net." } },
        { ...status(), Self: { ...status().Self, DNSName: "coop.tail1234.ts.net;touch bad" } },
        { ...status(), Self: { ...status().Self, DNSName: "coop.example.net" } },
        { ...status(), Self: { ...status().Self, DNSName: "ts.net" } },
        { ...status(), Self: { ...status().Self, TailscaleIPs: ["127.0.0.1", "100.128.0.1"] } },
        { ...status(), Self: { ...status().Self, TailscaleIPs: ["fd7a:115c:a1e0::1"] } },
    ];

    for (const value of invalid) {
        await cli.configure({ status: value });
        await assert.rejects(
            createTailscaleHttpsServer({ handler: (_req, res) => res.end() }),
            /must be Running/,
        );
    }

    assert.ok((await cli.calls()).every(({ args }) => args[0] === "status"));
});

test("rejects malformed PEM, mismatched key, wrong SAN, trailing data and duplicate keys", async (t) => {
    const cli = await fixture(t);
    const malformed = join(cli.directory, "bad.pem");
    const pairs = [
        Buffer.from("PRIVATE_DIAGNOSTIC_MUST_NOT_ESCAPE"),
        Buffer.concat([first.cert, second.key]),
        Buffer.concat([first.cert, first.key, first.key]),
        Buffer.concat([first.cert, first.key, Buffer.from("unexpected trailer")]),
        Buffer.concat([
            Buffer.from("-----BEGIN CERTIFICATE-----\nnot-base64\n-----END CERTIFICATE-----\n"),
            first.key,
        ]),
    ];

    for (const pair of pairs) {
        await writeFile(malformed, pair, { mode: 0o600 });
        await cli.configure({ pair: malformed });
        await assert.rejects(loadTailscaleCertificate(), { message: /invalid HTTPS certificate/ });
    }

    await cli.configure({
        pair: first.pair,
        status: { ...status(), Self: { ...status().Self, DNSName: "other.tail1234.ts.net." } },
    });
    await assert.rejects(loadTailscaleCertificate(), /invalid HTTPS certificate/);
});

test("refuses expired and not-yet-valid certificates, even when PEM and key match", async (t) => {
    await fixture(t);

    const certificate = new X509Certificate(first.cert);

    for (const now of [
        Date.parse(certificate.validTo) + 1,
        Date.parse(certificate.validFrom) - 1,
    ]) {
        t.mock.timers.enable({ apis: ["Date"], now });

        try {
            await assert.rejects(loadTailscaleCertificate(), /invalid HTTPS certificate/);
        } finally {
            t.mock.timers.reset();
        }
    }
});

test("CLI failures and oversized stdout produce fixed errors without private diagnostics", async (t) => {
    const cli = await fixture(t);

    for (const command of ["status", "cert"]) {
        for (const mode of ["fail", "huge"] as const) {
            await cli.configure({ fail: undefined, huge: undefined, [mode]: command });
            await assert.rejects(loadTailscaleCertificate(), (error: unknown) => {
                assert.ok(error instanceof Error);
                assert.match(
                    error.message,
                    command === "status"
                        ? /Cannot read Tailscale status/
                        : /Cannot obtain a Tailscale HTTPS certificate/,
                );
                assert.doesNotMatch(error.stack!, /PRIVATE_|XXXXX/);
                assert.equal(error.cause, undefined);

                return true;
            });
        }
    }
});

test("refuses an incompatible host before certificate issuance can disclose its name", async (t) => {
    const cli = await fixture(t);

    for (const host of ["0.0.0.0", "127.0.0.1", "100.101.102.104", HOSTNAME]) {
        await assert.rejects(
            createTailscaleHttpsServer({ host, handler: (_req, res) => res.end() }),
            /must bind to the active profile/,
        );
    }

    assert.ok(
        (await cli.calls()).every(({ args }) => args[0] === "status"),
        "Rejected bind targets must not request a publicly logged certificate",
    );
});

test(
    "abort joins a stuck native certificate command and never returns an HTTPS server",
    { timeout: 10_000 },
    async (t) => {
        const cli = await fixture(t);
        const controller = new AbortController();

        await cli.configure({ hang: "cert" });

        const pending = createTailscaleHttpsServer({
            signal: controller.signal,
            handler: (_req, res) => res.end(),
        });
        const rejected = assert.rejects(pending, { name: "AbortError" });
        const invocations = await until(cli.calls, (calls) =>
            calls.some(({ args }) => args[0] === "cert"),
        );

        controller.abort();
        await rejected;

        const child = invocations.find(({ args }) => args[0] === "cert")!;

        assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
    },
);

test(
    "refresh replaces the TLS context, retains the old one on identity change, and close joins renewal",
    { timeout: 15_000 },
    async (t) => {
        const cli = await fixture(t);
        const warnings: string[] = [];

        t.mock.timers.enable({ apis: ["setInterval"] });

        const renewing = await createTailscaleHttpsServer({
            handler: (_req, res) => res.end("ok"),
            onProblem(message) {
                warnings.push(message);
            },
        });

        t.after(() => renewing.close());
        await cli.configure({ pair: second.pair });
        t.mock.timers.tick(INTERVAL);

        const refreshed = await until(
            () => request(renewing.server),
            (result) => result.fingerprint === second.fingerprint,
        );

        assert.equal(refreshed.response.endsWith("ok"), true);
        const issuedBeforeIdentityChange = (await cli.calls()).filter(
            ({ args }) => args[0] === "cert",
        ).length;

        for (const change of [
            { TailscaleIPs: ["100.101.102.104"] },
            { DNSName: "other.tail1234.ts.net." },
        ]) {
            await cli.configure({ status: { ...status(), Self: { ...status().Self, ...change } } });
            const previousWarnings = warnings.length;

            t.mock.timers.tick(INTERVAL);
            await until(
                async () => warnings,
                (messages) => messages.length === previousWarnings + 1,
            );
            assert.doesNotMatch(warnings.at(-1)!, /PRIVATE_/);
            assert.equal((await request(renewing.server)).fingerprint, second.fingerprint);
            assert.equal(
                (await cli.calls()).filter(({ args }) => args[0] === "cert").length,
                issuedBeforeIdentityChange,
                "Refresh cannot issue for a different profile without a new explicit setup",
            );
        }

        await cli.configure({ status: status(), hang: "cert" });

        const countBefore = (await cli.calls()).filter(({ args }) => args[0] === "cert").length;

        t.mock.timers.tick(INTERVAL);

        const running = await until(
            cli.calls,
            (calls) => calls.filter(({ args }) => args[0] === "cert").length > countBefore,
        );

        t.mock.timers.tick(INTERVAL * 2);
        assert.equal((await cli.calls()).length, running.length, "renewals must not overlap");

        const closing = renewing.close();

        assert.equal(renewing.close(), closing, "close is idempotent");
        await closing;
        assert.throws(() => process.kill(running.at(-1)!.pid, 0), { code: "ESRCH" });
        t.mock.timers.tick(INTERVAL * 2);
        assert.equal((await cli.calls()).length, running.length);
        assert.equal(warnings.length, 2, "cancelling refresh is not a certificate failure");
        assert.equal(
            (await request(renewing.server)).fingerprint,
            second.fingerprint,
            "refresh close does not close the HTTPS server",
        );
    },
);
