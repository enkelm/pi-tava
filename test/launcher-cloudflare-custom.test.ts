// Account-backed setup runs against a fake executable and a strict fetch fixture, never a real Cloudflare account.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    realpathSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import {
    ACCESS_LABELS,
    ACCESS_MODES,
    bindHost,
    chooseAccess,
    isAccessMode,
    isCloudflareMode,
    type NamedTunnel,
} from "../src/launcher/access.ts";
import { suggestedCloudflareHostname } from "../src/launcher/cloudflare-custom.ts";

const ACCESS = new URL("../src/launcher/access.ts", import.meta.url).href;
const CUSTOM = new URL("../src/launcher/cloudflare-custom.ts", import.meta.url).href;
const ZONE = "0123456789abcdef0123456789abcdef";
const TUNNEL = "89ff53fb-326a-40a8-93e6-b7d09983087a";
const HOSTNAME = "pi-coop-test-device.example.invalid";
const TOKEN = "test-only-zone-bearer";
const SIGN_IN = "Sign in to Cloudflare for pi-tava? No tunnel or DNS is created by sign-in.";
const PROVISION = "Create this tunnel and DNS record?";
const FINISH = "Finish this saved tunnel's DNS setup?";
const FORGET =
    "Forget this incomplete local attempt? This will NOT delete any Cloudflare resources.";

interface Options {
    interactive?: boolean;
    confirmations?: boolean[];
    answer?: string | null;
    certificate?:
        | "unsupported"
        | "invalid-json"
        | "null"
        | "array"
        | "missing-zone"
        | "bad-zone"
        | "empty-token"
        | "oversized";
    zone?:
        | "unavailable"
        | "forbidden"
        | "invalid-json"
        | "unsuccessful"
        | "wrong-id"
        | "invalid-name"
        | "other";
    create?: "interrupted" | "no-credentials" | "interrupted-after-credentials";
    route?: "conflict" | "wrong-name" | "unconfirmed" | "already-configured";
    runtime?: "quick" | "named";
    pauseAt?: "ask" | "confirm";
    pauseQuestion?: string;
    mutateAuthorizationAfterPreflight?: boolean;
}

interface Command {
    kind: "command";
    command: string;
    args: string[];
    configFile: string;
    configContent: string;
    isolatedHome: boolean;
    isolatedCertificate: boolean;
    matchingUserProfile: boolean;
    inheritedTunnelOverrides: boolean;
    preservedSentinel: boolean;
    snapshotMatchesPreflight: boolean;
    snapshotReadOnly: boolean;
    savedStage: string | null;
}

type Event =
    | Command
    | { kind: "show"; line: string }
    | { kind: "ask"; question: string; initial: string }
    | { kind: "confirm"; question: string; fallback: boolean; answer: boolean | null }
    | {
          kind: "fetch";
          url: string;
          method: string;
          bearerMatches: boolean;
          redirect: string | undefined;
          hasSignal: boolean;
      };

interface Run {
    result: NamedTunnel | null;
    events: Event[];
    runtime?: { urls: string[]; problems: string[]; code: number | null };
}

// Node treats this extensionless file as the fake cloudflared's `tunnel` command. The fixture only reads/writes its
// temporary cwd and HOME. Environment capture contains booleans, not credentials or the parent's environment.
const FAKE_TUNNEL = `
const { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } = require("node:fs");
const { basename, dirname, join } = require("node:path");
const options = JSON.parse(readFileSync(process.env.PP_TEST_OPTIONS_FILE, "utf8"));
const args = process.argv.slice(2);
const directory = join(process.cwd(), "data", "cloudflare-custom");
const stateFile = join(directory, "setup.json");
const configFile = args[args.indexOf("--config") + 1];
const certIndex = args.indexOf("--origincert");
const commandHome = process.env.HOME;
const attemptDir = dirname(commandHome);
const isolatedHome = dirname(attemptDir) === directory && /^auth-[A-Za-z0-9]+$/.test(basename(attemptDir))
    && basename(commandHome) === "home";
const snapshot = certIndex < 0 ? undefined : args[certIndex + 1];
let snapshotMatchesPreflight = false;

if (snapshot && existsSync(snapshot)) {
    try {
        const block = /-----BEGIN ARGO TUNNEL TOKEN-----\\s+([A-Za-z0-9+/=\\s]+?)\\s+-----END ARGO TUNNEL TOKEN-----/.exec(readFileSync(snapshot, "utf8"));
        const auth = JSON.parse(Buffer.from(block?.[1] ?? "", "base64").toString("utf8"));

        snapshotMatchesPreflight = auth.zoneID === ${JSON.stringify(ZONE)} && auth.apiToken === ${JSON.stringify(TOKEN)};
    } catch {}
}
const command = ["login", "create", "route", "run"].find((word) => args.includes(word))
    ?? (args.includes("--url") ? "quick" : "unknown");

appendFileSync(process.env.PP_TEST_EVENTS_FILE, JSON.stringify({
    kind: "command", command, args, configFile,
    configContent: readFileSync(configFile, "utf8"),
    isolatedHome,
    isolatedCertificate: isolatedHome && snapshot === join(attemptDir, "cert.pem"),
    matchingUserProfile: process.env.HOME === process.env.USERPROFILE,
    inheritedTunnelOverrides: Object.keys(process.env).some((key) => /^TUNNEL_/i.test(key)),
    preservedSentinel: process.env.PP_TEST_SENTINEL === "keep-this-test-value",
    snapshotMatchesPreflight,
    snapshotReadOnly: Boolean(snapshot && existsSync(snapshot) && (statSync(snapshot).mode & 0o777) === 0o400),
    savedStage: existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")).stage : null,
}) + "\\n");

if (command === "login") {
    const auth = { zoneID: ${JSON.stringify(ZONE)}, apiToken: ${JSON.stringify(TOKEN)},
        endpoint: "https://never-contact-this.example.invalid" };

    if (options.certificate === "missing-zone") { delete auth.zoneID; }
    if (options.certificate === "bad-zone") { auth.zoneID = "not-a-zone-id"; }
    if (options.certificate === "empty-token") { auth.apiToken = ""; }
    const content = options.certificate === "invalid-json" ? "not JSON"
        : options.certificate === "null" ? "null"
        : options.certificate === "array" ? "[]" : JSON.stringify(auth);
    let pem = "-----BEGIN ARGO TUNNEL TOKEN-----\\n" + Buffer.from(content).toString("base64")
        + "\\n-----END ARGO TUNNEL TOKEN-----\\n";

    if (options.certificate === "unsupported") { pem = "-----BEGIN CERTIFICATE-----\\nTEST ONLY\\n-----END CERTIFICATE-----\\n"; }
    if (options.certificate === "oversized") { pem += " ".repeat(64001); }
    const folder = join(process.env.HOME, ".cloudflared");

    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "cert.pem"), pem, { mode: 0o600 });
    console.log("Open the test-only Cloudflare browser zone chooser.");
} else if (command === "create") {
    if (options.create === "interrupted") { process.kill(process.pid, "SIGTERM"); }
    if (options.create !== "no-credentials") {
        writeFileSync(args[args.indexOf("--credentials-file") + 1], JSON.stringify({
            TunnelID: ${JSON.stringify(TUNNEL)}, TunnelSecret: "test-only-tunnel-secret",
        }), { mode: 0o600 });
    }
    if (options.create === "interrupted-after-credentials") { process.kill(process.pid, "SIGTERM"); }
    console.log("Created the test-only dedicated tunnel.");
} else if (command === "route") {
    const requested = args[args.length - 1];
    const dnsFile = "dns-records.json";
    const records = existsSync(dnsFile) ? JSON.parse(readFileSync(dnsFile, "utf8")) : undefined;

    if (options.route === "conflict" || records?.[requested] !== undefined && records[requested] !== ${JSON.stringify(TUNNEL)}) {
        console.error("ERR A record with that host already exists; refusing to replace it.");
        process.exit(1);
    }
    if (records !== undefined) {
        records[requested] = ${JSON.stringify(TUNNEL)};
        writeFileSync(dnsFile, JSON.stringify(records));
    }

    if (options.route === "wrong-name") {
        console.log("Added CNAME " + requested + ".unexpected.invalid which will route to this tunnel");
    } else if (options.route === "unconfirmed") {
        console.log("DNS command finished without an exact hostname confirmation.");
    } else if (options.route === "already-configured") {
        console.log(requested + " is already configured to route to your tunnel");
    } else {
        console.log("Added CNAME " + requested + " which will route to this tunnel");
    }
} else if (command === "run" || command === "quick") {
    console.log("https://offline-probe.trycloudflare.com");
    console.log("Registered tunnel connection");
    console.log("Registered tunnel connection");
} else {
    console.error("Unexpected fake cloudflared command");
    process.exit(90);
}
`;

// Every run gets its own Node process, with a deliberately small synthetic environment. Neither process.cwd nor
// process.env in the test worker is changed. fetch is replaced outright, so even an unexpected URL cannot go online.
const RUNNER = `
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prepareCustomCloudflare } from ${JSON.stringify(CUSTOM)};
import { CloudflareTunnel } from ${JSON.stringify(ACCESS)};

const options = JSON.parse(readFileSync(process.env.PP_TEST_OPTIONS_FILE, "utf8"));
const record = (event) => appendFileSync(process.env.PP_TEST_EVENTS_FILE, JSON.stringify(event) + "\\n");
const fixtureErrors = [];
const controller = new AbortController();

process.on("message", (message) => {
    if (message === "abort") { controller.abort(); }
});

const unresolvedPrompt = () => {
    process.send({ kind: "paused" });

    return new Promise(() => {});
};

globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const bearerMatches = new Headers(init?.headers).get("Authorization") === ${JSON.stringify(`Bearer ${TOKEN}`)};

    record({ kind: "fetch", url, method, bearerMatches, redirect: init?.redirect,
        hasSignal: init?.signal instanceof AbortSignal });
    if (url !== ${JSON.stringify(`https://api.cloudflare.com/client/v4/zones/${ZONE}`)} || method !== "GET"
        || !bearerMatches || init?.redirect !== "error") {
        fixtureErrors.push("Unexpected request to the offline Cloudflare fixture");
        throw new Error("No real network requests are permitted");
    }
    if (options.zone === "unavailable") { throw new Error("test-only network failure"); }
    if (options.zone === "forbidden") { return new Response("denied", { status: 403 }); }
    if (options.zone === "invalid-json") { return new Response("not JSON"); }
    const result = { id: ${JSON.stringify(ZONE)}, name: "example.invalid" };

    if (options.zone === "wrong-id") { result.id = "ffffffffffffffffffffffffffffffff"; }
    if (options.zone === "invalid-name") { result.name = "https://example.invalid/path"; }
    if (options.zone === "other") { result.name = "other.invalid"; }

    return new Response(JSON.stringify({ success: options.zone !== "unsuccessful", result }));
};

let result = null;
let runtime;

if (options.runtime) {
    const urls = [];
    const problems = [];
    const exited = Promise.withResolvers();
    const named = options.runtime === "named" ? {
        hostname: ${JSON.stringify(HOSTNAME)}, tunnelId: ${JSON.stringify(TUNNEL)},
        credentialsFile: join(process.cwd(), "data", "cloudflare-custom", "credentials.json"),
    } : undefined;
    const tunnel = new CloudflareTunnel(process.execPath, 9182, join(process.cwd(), "runtime.log"), {
        ready: (url) => urls.push(url), problem: (line) => problems.push(line), exit: exited.resolve,
    }, named);

    try {
        tunnel.start();
        runtime = { urls, problems, code: await exited.promise };
    } finally {
        await tunnel.stop();
    }
} else {
    const confirmations = options.confirmations ?? [true, true];
    let index = 0;

    result = await prepareCustomCloudflare(process.execPath, join(process.cwd(), "data"), {
        interactive: options.interactive ?? true,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]),
        ask: async (question, initial) => {
            record({ kind: "ask", question, initial });
            if (options.mutateAuthorizationAfterPreflight) {
                const directory = join(process.cwd(), "data", "cloudflare-custom");
                const pem = "-----BEGIN ARGO TUNNEL TOKEN-----\\n" + Buffer.from(JSON.stringify({
                    zoneID: "ffffffffffffffffffffffffffffffff", apiToken: "test-only-late-login-token",
                })).toString("base64") + "\\n-----END ARGO TUNNEL TOKEN-----\\n";

                writeFileSync(join(directory, "home", ".cloudflared", "cert.pem"), pem);
                for (const name of readdirSync(directory).filter((name) => name.startsWith("auth-"))) {
                    const destination = join(directory, name, "home", ".cloudflared", "cert.pem");

                    if (existsSync(destination)) { writeFileSync(destination, pem); }
                }
            }
            if (options.pauseAt === "ask") { return unresolvedPrompt(); }

            return options.answer === null ? undefined : (options.answer ?? ${JSON.stringify(HOSTNAME)});
        },
        confirm: async (question, fallback) => {
            if (options.pauseAt === "confirm" && (!options.pauseQuestion || options.pauseQuestion === question)) {
                record({ kind: "confirm", question, fallback, answer: null });

                return unresolvedPrompt();
            }
            if (index >= confirmations.length) {
                fixtureErrors.push("Unexpected confirmation: " + question);
            }
            const answer = confirmations[index++] ?? false;

            record({ kind: "confirm", question, fallback, answer });

            return answer;
        },
        show: (line) => record({ kind: "show", line }),
    }) ?? null;
}

assert.deepEqual(fixtureErrors, []);
console.log(JSON.stringify({ result, runtime }));
if (process.connected) { process.disconnect(); }
`;

function fixture(t: TestContext) {
    // macOS exposes /var through /private/var; a child process's cwd uses the canonical path.
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "pp-custom-cloudflare-")));
    const home = join(directory, "unrelated-home");
    const data = join(directory, "data");
    const setup = join(data, "cloudflare-custom");
    const stateFile = join(setup, "setup.json");
    const credentialsFile = join(setup, "credentials.json");
    const sentinels = new Map([
        [
            join(home, ".cloudflared", "config.yml"),
            '{"tunnel":"unrelated","ingress":[{"service":"http_status:404"}]}\n',
        ],
        [join(home, ".cloudflared", "cert.pem"), "unrelated test-only account certificate\n"],
        [join(home, ".cloudflared", "credentials.json"), '{"TunnelID":"unrelated"}\n'],
        [join(directory, "xdg", "cloudflared", "config.yml"), "unrelated XDG configuration\n"],
    ]);

    for (const [file, content] of sentinels) {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, content, { mode: 0o600 });
    }

    writeFileSync(join(directory, "tunnel"), FAKE_TUNNEL);
    const cleanups = new Set<() => Promise<void>>();
    let sequence = 0;

    t.after(async () => {
        try {
            await Promise.allSettled([...cleanups].map((cleanup) => cleanup()));
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    const start = (options: Options = {}) => {
        const current = ++sequence;
        const optionsFile = join(directory, `options-${current}.json`);
        const eventsFile = join(directory, `events-${current}.jsonl`);

        writeFileSync(optionsFile, JSON.stringify(options));
        writeFileSync(eventsFile, "");
        const grouped = process.platform !== "win32";
        const child = spawn(process.execPath, ["--input-type=module", "-e", RUNNER], {
            cwd: directory,
            detached: grouped,
            stdio: ["ignore", "pipe", "pipe", "ipc"],
            env: {
                PATH: dirname(process.execPath),
                HOME: home,
                USERPROFILE: home,
                XDG_CONFIG_HOME: join(directory, "xdg"),
                APPDATA: join(directory, "appdata"),
                PP_TEST_OPTIONS_FILE: optionsFile,
                PP_TEST_EVENTS_FILE: eventsFile,
                PP_TEST_SENTINEL: "keep-this-test-value",
                TUNNEL_TOKEN: "test-only-unrelated-token",
                TUNNEL_ORIGIN_CERT: join(home, ".cloudflared", "cert.pem"),
                TUNNEL_CONFIG: join(home, ".cloudflared", "config.yml"),
                TUNNEL_URL: "http://unrelated.invalid",
                TUNNEL_FORCE_PROVISIONING_DNS: "true",
                tunnel_lowercase_override: "test-only-unrelated-override",
            },
        });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const paused = Promise.withResolvers<void>();

        // Normal runs never await this promise; a paused runner must still reject if it exits early.
        void paused.promise.catch(() => {});
        child.on("message", (message) => {
            if (
                typeof message === "object" &&
                message !== null &&
                "kind" in message &&
                message.kind === "paused"
            ) {
                paused.resolve();
            }
        });
        child.once("close", () =>
            paused.reject(new Error("Runner exited without a paused prompt")),
        );

        const kill = () => {
            if (child.pid !== undefined && grouped) {
                try {
                    process.kill(-child.pid, "SIGKILL");
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
                        throw error;
                    }
                }
            } else {
                child.kill("SIGKILL");
            }
        };

        const timer = setTimeout(() => {
            timedOut = true;
            kill();
        }, 10_000);

        child.stdout!.on("data", (chunk) => {
            stdout += chunk;
        });
        child.stderr!.on("data", (chunk) => {
            stderr += chunk;
        });

        const finished = (async (): Promise<Run> => {
            try {
                const code = await new Promise<number | null>((resolve, reject) => {
                    child.once("error", reject);
                    child.once("close", resolve);
                });

                assert.equal(timedOut, false, "offline launcher fixture timed out");
                assert.equal(code, 0, stderr);

                for (const [file, content] of sentinels) {
                    assert.equal(
                        readFileSync(file, "utf8"),
                        content,
                        `unrelated file changed: ${file}`,
                    );
                }

                const lines = readFileSync(eventsFile, "utf8").trim();

                return {
                    ...JSON.parse(stdout),
                    events: lines === "" ? [] : lines.split("\n").map((line) => JSON.parse(line)),
                };
            } finally {
                clearTimeout(timer);
                // Also reap any fake command left behind if the runner failed or timed out.
                kill();
            }
        })();

        const cleanup = async () => {
            kill();
            await finished.catch(() => {});
        };

        cleanups.add(cleanup);
        void finished.then(
            () => cleanups.delete(cleanup),
            () => cleanups.delete(cleanup),
        );

        return {
            paused: paused.promise,
            finished,
            abort: () => {
                if (child.connected) {
                    child.send("abort", () => {});
                }
            },
        };
    };

    const run = (options: Options = {}) => start(options).finished;

    return {
        directory,
        setup,
        stateFile,
        credentialsFile,
        run,
        start,
        state: () =>
            JSON.parse(readFileSync(stateFile, "utf8")) as {
                version: number;
                domain: string;
                hostname: string;
                tunnelName: string;
                stage: string;
                tunnelId?: string;
            },
    };
}

function commands(run: Run): Command[] {
    return run.events.filter((event) => event.kind === "command");
}

function messages(run: Run): string {
    return run.events
        .filter((event) => event.kind === "show")
        .map((event) => event.line)
        .join("\n");
}

function assertNoProvisioning(run: Run) {
    assert.equal(run.result, null);
    assert.equal(
        commands(run).some((command) => command.command !== "login"),
        false,
    );
}

function assertNoAuthDirectories(setup: string) {
    assert.deepEqual(
        existsSync(setup) ? readdirSync(setup).filter((name) => name.startsWith("auth-")) : [],
        [],
    );
}

function assertNoAccountCalls(run: Run) {
    assert.deepEqual(commands(run), []);
    assert.deepEqual(
        run.events.filter((event) => event.kind === "fetch"),
        [],
    );
}

test("custom domains are a separate Cloudflare mode and keep the app bound to loopback", async () => {
    assert.ok(ACCESS_MODES.includes("cloudflare"));
    assert.ok(ACCESS_MODES.includes("cloudflare-custom"));
    assert.notEqual(ACCESS_LABELS.cloudflare, ACCESS_LABELS["cloudflare-custom"]);
    assert.equal(isAccessMode("cloudflare-custom"), true);
    assert.equal(isCloudflareMode("cloudflare-custom"), true);
    assert.equal(isCloudflareMode("cloudflare"), true);
    assert.equal(isCloudflareMode("local"), false);
    assert.equal(isAccessMode("cloudflare-custom-extra"), false);
    assert.equal(bindHost("cloudflare-custom"), "127.0.0.1");
    assert.deepEqual(
        await chooseAccess({
            given: undefined,
            saved: "cloudflare-custom",
            ask: false,
            menu: async () => {
                throw new Error("a saved noninteractive choice must not open a menu");
            },
            prepare: async (mode) => {
                assert.equal(mode, "cloudflare-custom");

                return process.execPath;
            },
        }),
        { mode: "cloudflare-custom", binary: process.execPath },
    );
});

test("hostname suggestions are flat, sanitized, IDNA-normalized, and fit one DNS label", () => {
    assert.equal(
        suggestedCloudflareHostname("EXAMPLE.INVALID.", "  Alice___Laptop!!.local"),
        "pi-coop-alice-laptop.example.invalid",
    );
    assert.equal(
        suggestedCloudflareHostname("bücher.example", "---💻---.local"),
        "pi-coop-device.xn--bcher-kva.example",
    );
    assert.equal(
        suggestedCloudflareHostname("example.invalid", "A".repeat(100)),
        `pi-coop-${"a".repeat(55)}.example.invalid`,
    );
    assert.equal(
        suggestedCloudflareHostname("example.invalid", `${"a".repeat(54)}-${"b".repeat(10)}`),
        `pi-coop-${"a".repeat(54)}.example.invalid`,
    );

    for (const domain of [
        "https://example.invalid",
        "example.invalid/path",
        "example.invalid:443",
        "*.example.invalid",
        "localhost",
    ]) {
        assert.throws(() => suggestedCloudflareHostname(domain, "device"), /DNS hostname/);
    }
});

test("noninteractive unconfigured setup makes no account calls or local setup files", async (t) => {
    const f = fixture(t);
    const run = await f.run({ interactive: false, confirmations: [] });

    assertNoAccountCalls(run);
    assert.equal(run.result, null);
    assert.match(messages(run), /without -y/);
    assert.equal(existsSync(f.setup), false);
});

test("declining browser sign-in cannot create a tunnel or DNS record", async (t) => {
    const f = fixture(t);
    const run = await f.run({ confirmations: [false] });

    assertNoAccountCalls(run);
    assert.equal(existsSync(f.stateFile), false);
    assert.deepEqual(
        run.events.filter((event) => event.kind === "confirm"),
        [{ kind: "confirm", question: SIGN_IN, fallback: false, answer: false }],
    );
});

for (const canceledAt of ["hostname", "preview"] as const) {
    test(`canceling at the ${canceledAt} leaves sign-in read-only`, async (t) => {
        const f = fixture(t);
        const run = await f.run(
            canceledAt === "hostname"
                ? { answer: null, confirmations: [true] }
                : { confirmations: [true, false] },
        );

        assertNoProvisioning(run);
        assert.deepEqual(
            commands(run).map((command) => command.command),
            ["login"],
        );
        assert.equal(run.events.filter((event) => event.kind === "fetch").length, 1);
        assert.equal(existsSync(f.stateFile), false);
        assert.equal(existsSync(f.credentialsFile), false);

        if (canceledAt === "preview") {
            assert.match(
                messages(run),
                new RegExp(`Public address: https://${HOSTNAME.replaceAll(".", "\\.")}`),
            );
            assert.match(messages(run), /Dedicated tunnel: pi-coop-[a-f0-9]{16}/);
            assert.match(messages(run), /Existing DNS records and tunnels will not be replaced/);
            assert.deepEqual(run.events.filter((event) => event.kind === "confirm").at(-1), {
                kind: "confirm",
                question: PROVISION,
                fallback: false,
                answer: false,
            });
        }
    });
}

test("confirmed setup isolates account auth and config, refuses DNS overwrite, and saves the exact UUID and hostname", async (t) => {
    const f = fixture(t);
    const run = await f.run();
    const calls = commands(run);
    const state = f.state();
    const certFile = join(f.setup, "home", ".cloudflared", "cert.pem");
    const configFile = join(f.setup, "setup.yml");
    const snapshot = calls[0]!.args[calls[0]!.args.indexOf("--origincert") + 1]!;
    const prefix = [
        "--config",
        configFile,
        "--origincert",
        snapshot,
        "--no-autoupdate",
        "--loglevel",
        "info",
    ];

    assert.deepEqual(run.result, {
        hostname: HOSTNAME,
        tunnelId: TUNNEL,
        credentialsFile: f.credentialsFile,
    });
    assert.deepEqual(
        calls.map((call) => call.args),
        [
            [...prefix, "login"],
            [...prefix, "create", "--credentials-file", f.credentialsFile, state.tunnelName],
            [...prefix, "route", "dns", "--overwrite-dns=false", TUNNEL, HOSTNAME],
        ],
    );
    assert.deepEqual(
        calls.map((call) => call.savedStage),
        [null, "creating", "created"],
    );
    assert.notEqual(snapshot, certFile);
    assert.equal(dirname(dirname(snapshot)), f.setup);
    assert.equal(
        existsSync(snapshot),
        false,
        "the attempt snapshot must be removed after child close",
    );
    assert.deepEqual(
        calls.map((call) => call.snapshotMatchesPreflight),
        [false, true, true],
    );
    assertNoAuthDirectories(f.setup);

    if (process.platform !== "win32") {
        assert.deepEqual(
            calls.map((call) => call.snapshotReadOnly),
            [false, true, true],
        );
    }

    for (const call of calls) {
        assert.equal(call.configFile, configFile);
        assert.equal(call.configContent, "{}\n");
        assert.equal(call.isolatedHome, true);
        assert.equal(call.isolatedCertificate, true);
        assert.equal(call.matchingUserProfile, true);
        assert.equal(call.inheritedTunnelOverrides, false);
        assert.equal(call.preservedSentinel, true);
    }

    assert.deepEqual(
        run.events.filter((event) => event.kind === "fetch"),
        [
            {
                kind: "fetch",
                url: `https://api.cloudflare.com/client/v4/zones/${ZONE}`,
                method: "GET",
                bearerMatches: true,
                redirect: "error",
                hasSignal: true,
            },
        ],
    );
    assert.deepEqual(
        run.events.filter((event) => event.kind === "confirm"),
        [
            { kind: "confirm", question: SIGN_IN, fallback: false, answer: true },
            { kind: "confirm", question: PROVISION, fallback: false, answer: true },
        ],
    );
    const preview = run.events.findIndex(
        (event) => event.kind === "show" && event.line === `Public address: https://${HOSTNAME}`,
    );
    const confirmation = run.events.findIndex(
        (event) => event.kind === "confirm" && event.question === PROVISION,
    );
    const create = run.events.findIndex(
        (event) => event.kind === "command" && event.command === "create",
    );

    assert.ok(preview >= 0 && preview < confirmation && confirmation < create);
    assert.match(state.tunnelName, /^pi-coop-[a-f0-9]{16}$/);
    assert.deepEqual(state, {
        version: 1,
        domain: "example.invalid",
        hostname: HOSTNAME,
        tunnelName: state.tunnelName,
        stage: "ready",
        tunnelId: TUNNEL,
    });
    assert.doesNotMatch(messages(run), /test-only-zone-bearer|test-only-tunnel-secret|BEGIN ARGO/);

    if (process.platform !== "win32") {
        for (const file of [
            f.stateFile,
            f.credentialsFile,
            configFile,
            certFile,
            join(f.setup, "setup.log"),
        ]) {
            assert.equal(statSync(file).mode & 0o777, 0o600, file);
        }
    }
});

test("post-preflight changes to master and login certificates cannot change the provisioning snapshot", async (t) => {
    const f = fixture(t);
    const run = await f.run({ mutateAuthorizationAfterPreflight: true });
    const provisioning = commands(run).filter((command) => command.command !== "login");
    const snapshots = provisioning.map(
        (command) => command.args[command.args.indexOf("--origincert") + 1],
    );

    assert.equal(run.result?.hostname, HOSTNAME);
    assert.equal(run.result?.tunnelId, TUNNEL);
    assert.deepEqual(
        provisioning.map((command) => command.command),
        ["create", "route"],
    );
    assert.equal(new Set(snapshots).size, 1, "create and route must use the same certificate path");
    assert.equal(
        run.events.filter((event) => event.kind === "fetch" && event.bearerMatches).length,
        1,
    );

    for (const command of provisioning) {
        assert.equal(command.isolatedHome, true);
        assert.equal(command.isolatedCertificate, true);
        assert.equal(
            command.snapshotMatchesPreflight,
            true,
            "provisioning must retain the zone/token verified before the prompt",
        );

        if (process.platform !== "win32") {
            assert.equal(command.snapshotReadOnly, true);
        }
    }

    const master = readFileSync(join(f.setup, "home", ".cloudflared", "cert.pem"), "utf8");
    const block =
        /-----BEGIN ARGO TUNNEL TOKEN-----\s+([A-Za-z0-9+/=\s]+?)\s+-----END ARGO TUNNEL TOKEN-----/.exec(
            master,
        );
    const lateAuth = JSON.parse(Buffer.from(block![1]!, "base64").toString("utf8"));

    assert.equal(
        lateAuth.zoneID,
        "ffffffffffffffffffffffffffffffff",
        "the fixture must actually replace master authorization after preflight",
    );
    assertNoAuthDirectories(f.setup);
});

test("a saved ready setup restarts without cloudflared, API calls, prompts, or rewriting setup", async (t) => {
    const f = fixture(t);
    const first = await f.run();
    const files = [
        f.stateFile,
        f.credentialsFile,
        join(f.setup, "setup.log"),
        join(f.setup, "setup.yml"),
    ];
    const before = files.map((file) => readFileSync(file, "utf8"));

    // A ready launch must not need account authorization at all, even if it is now unavailable or expired.
    rmSync(join(f.setup, "home", ".cloudflared", "cert.pem"));
    const resumed = await f.run({ interactive: false, confirmations: [], zone: "unavailable" });

    assert.deepEqual(resumed.result, first.result);
    assert.deepEqual(resumed.events, []);
    assert.deepEqual(
        files.map((file) => readFileSync(file, "utf8")),
        before,
    );
});

for (const certificate of [
    "unsupported",
    "invalid-json",
    "null",
    "array",
    "missing-zone",
    "bad-zone",
    "empty-token",
    "oversized",
] as const) {
    test(`a ${certificate} authorization certificate cannot provision anything`, async (t) => {
        const f = fixture(t);
        const run = await f.run({ certificate, confirmations: [true] });

        assertNoProvisioning(run);
        assert.deepEqual(
            commands(run).map((command) => command.command),
            ["login"],
        );
        assert.deepEqual(
            run.events.filter((event) => event.kind === "fetch" || event.kind === "ask"),
            [],
        );
        assert.match(messages(run), /authorization|zone credentials/);
        assert.equal(existsSync(f.stateFile), false);
        assertNoAuthDirectories(f.setup);
    });
}

for (const zone of [
    "unavailable",
    "forbidden",
    "invalid-json",
    "unsuccessful",
    "wrong-id",
    "invalid-name",
] as const) {
    test(`a ${zone} zone preflight cannot create a tunnel or DNS record`, async (t) => {
        const f = fixture(t);
        const run = await f.run({ zone, confirmations: [true] });

        assertNoProvisioning(run);
        assert.equal(run.events.filter((event) => event.kind === "fetch").length, 1);
        assert.deepEqual(
            run.events.filter((event) => event.kind === "ask"),
            [],
        );
        assert.equal(existsSync(f.stateFile), false);
    });
}

for (const answer of [
    "pi-coop-device.other.invalid",
    "example.invalid",
    "https://pi-coop-device.example.invalid",
    "*.example.invalid",
    `${HOSTNAME}/path`,
    `${HOSTNAME}?query`,
    `${HOSTNAME}#fragment`,
    `${HOSTNAME}\\path`,
]) {
    test(`an invalid or out-of-zone hostname cannot be provisioned: ${answer}`, async (t) => {
        const f = fixture(t);
        const run = await f.run({ answer, confirmations: [true] });

        assertNoProvisioning(run);
        assert.equal(existsSync(f.stateFile), false);
        assert.equal(existsSync(f.credentialsFile), false);
    });
}

test("a nested hostname warns about certificates before the provisioning confirmation", async (t) => {
    const f = fixture(t);
    const run = await f.run({
        answer: "device.pi-coop.example.invalid",
        confirmations: [true, false],
    });

    assertNoProvisioning(run);
    assert.match(messages(run), /nested hostname.*additional Cloudflare edge certificate/);
});

test("conflicting DNS stops without overwriting, then resumes the same created tunnel after confirmation", async (t) => {
    const f = fixture(t);
    const conflict = await f.run({ route: "conflict" });
    const created = f.state();

    assert.equal(conflict.result, null);
    assert.equal(created.stage, "created");
    assert.equal(created.tunnelId, TUNNEL);
    assert.match(messages(conflict), /Existing DNS records were not overwritten/);
    assert.deepEqual(
        commands(conflict).map((command) => command.command),
        ["login", "create", "route"],
    );
    const declined = await f.run({ confirmations: [false] });

    assertNoProvisioning(declined);
    assert.deepEqual(commands(declined), []);
    assert.deepEqual(f.state(), created);
    const resumed = await f.run({ confirmations: [true], route: "already-configured" });

    assert.deepEqual(
        commands(resumed).map((command) => command.command),
        ["route"],
    );
    assert.deepEqual(commands(resumed)[0]!.args.slice(-5), [
        "route",
        "dns",
        "--overwrite-dns=false",
        TUNNEL,
        HOSTNAME,
    ]);
    assert.deepEqual(
        resumed.events.filter((event) => event.kind === "confirm"),
        [{ kind: "confirm", question: FINISH, fallback: false, answer: true }],
    );
    assert.equal(resumed.result?.tunnelId, TUNNEL);
    assert.equal(f.state().stage, "ready");
    assert.equal(f.state().tunnelName, created.tunnelName);
});

test("a DNS conflict can be retried with an unused hostname without recreating the tunnel or changing old DNS", async (t) => {
    const f = fixture(t);
    const replacement = "pi-coop-replacement.example.invalid";
    const dnsFile = join(f.directory, "dns-records.json");
    const unrelated = { type: "A", content: "192.0.2.25", owner: "not-pi-coop" };

    writeFileSync(dnsFile, JSON.stringify({ [HOSTNAME]: unrelated }));
    const conflict = await f.run();
    const saved = f.state();
    const credentials = readFileSync(f.credentialsFile, "utf8");

    assert.equal(conflict.result, null);
    assert.equal(saved.stage, "created");
    assert.equal(saved.tunnelId, TUNNEL);
    assert.deepEqual(JSON.parse(readFileSync(dnsFile, "utf8")), { [HOSTNAME]: unrelated });
    assert.equal(commands(conflict).filter((command) => command.command === "create").length, 1);
    const declined = await f.run({ answer: replacement, confirmations: [false] });

    assertNoProvisioning(declined);
    assert.deepEqual(commands(declined), []);
    assert.deepEqual(
        f.state(),
        saved,
        "declining the replacement must leave the saved attempt untouched",
    );
    const resumed = await f.run({ answer: replacement, confirmations: [true] });

    assert.deepEqual(
        resumed.events.filter((event) => event.kind === "ask").map((event) => event.initial),
        [HOSTNAME],
    );
    assert.deepEqual(
        resumed.events.filter((event) => event.kind === "confirm"),
        [{ kind: "confirm", question: FINISH, fallback: false, answer: true }],
    );
    assert.deepEqual(
        commands(resumed).map((command) => command.command),
        ["route"],
    );
    assert.deepEqual(commands(resumed)[0]!.args.slice(-5), [
        "route",
        "dns",
        "--overwrite-dns=false",
        TUNNEL,
        replacement,
    ]);
    const preview = resumed.events.findIndex(
        (event) => event.kind === "show" && event.line === `Public address: https://${replacement}`,
    );
    const confirm = resumed.events.findIndex((event) => event.kind === "confirm");
    const route = resumed.events.findIndex((event) => event.kind === "command");

    assert.ok(preview >= 0 && preview < confirm && confirm < route);
    assert.match(messages(resumed), /Existing DNS aliases will be left alone/);
    assert.deepEqual(resumed.result, {
        hostname: replacement,
        tunnelId: TUNNEL,
        credentialsFile: f.credentialsFile,
    });
    assert.deepEqual(f.state(), { ...saved, hostname: replacement, stage: "ready" });
    assert.equal(readFileSync(f.credentialsFile, "utf8"), credentials);
    const previousSnapshot =
        commands(conflict)[0]!.args[commands(conflict)[0]!.args.indexOf("--origincert") + 1];
    const nextSnapshot =
        commands(resumed)[0]!.args[commands(resumed)[0]!.args.indexOf("--origincert") + 1];

    assert.notEqual(
        nextSnapshot,
        previousSnapshot,
        "each interactive attempt needs a unique auth directory",
    );
    assert.equal(commands(resumed)[0]!.snapshotMatchesPreflight, true);
    assertNoAuthDirectories(f.setup);
    assert.deepEqual(JSON.parse(readFileSync(dnsFile, "utf8")), {
        [HOSTNAME]: unrelated,
        [replacement]: TUNNEL,
    });
    const ready = await f.run({ interactive: false, confirmations: [] });

    assert.deepEqual(ready.result, resumed.result);
    assertNoAccountCalls(ready);
});

for (const create of ["interrupted", "no-credentials"] as const) {
    test(`${create} creation is never automatically repeated and local forgetting needs acknowledgment`, async (t) => {
        const f = fixture(t);
        const attempt = await f.run({ create });
        const uncertain = f.state();

        assert.equal(attempt.result, null);
        assert.deepEqual(
            commands(attempt).map((command) => command.command),
            ["login", "create"],
        );
        assert.equal(uncertain.stage, "creating");
        assert.equal(existsSync(f.credentialsFile), false);
        const unattended = await f.run({ interactive: false, confirmations: [] });

        assertNoAccountCalls(unattended);
        assert.deepEqual(f.state(), uncertain);
        const retained = await f.run({ confirmations: [false] });

        assertNoAccountCalls(retained);
        assert.deepEqual(f.state(), uncertain);
        assert.match(messages(retained), /outcome.*uncertain/);
        assert.deepEqual(
            retained.events.filter((event) => event.kind === "confirm"),
            [{ kind: "confirm", question: FORGET, fallback: false, answer: false }],
        );
        const forgotten = await f.run({ confirmations: [true] });

        assertNoAccountCalls(forgotten);
        assert.equal(forgotten.result, null);
        assert.equal(existsSync(f.stateFile), false);
        assert.equal(existsSync(join(f.setup, "home", ".cloudflared", "cert.pem")), true);
        assert.deepEqual(
            forgotten.events.filter((event) => event.kind === "confirm"),
            [{ kind: "confirm", question: FORGET, fallback: false, answer: true }],
        );
    });
}

test("credentials recovered from an interrupted create resume DNS without making another tunnel", async (t) => {
    const f = fixture(t);
    const first = await f.run({ create: "interrupted-after-credentials" });

    assert.equal(first.result, null);
    assert.equal(f.state().stage, "creating");
    assert.equal(existsSync(f.credentialsFile), true);
    const resumed = await f.run({ confirmations: [true] });

    assert.deepEqual(
        commands(resumed).map((command) => command.command),
        ["route"],
    );
    assert.equal(resumed.result?.tunnelId, TUNNEL);
    assert.equal(f.state().stage, "ready");
});

for (const route of ["wrong-name", "unconfirmed"] as const) {
    test(`${route} DNS output cannot mark the requested hostname ready`, async (t) => {
        const f = fixture(t);
        const run = await f.run({ route });

        assert.equal(run.result, null);
        assert.equal(f.state().stage, "created");
        assert.equal(f.state().hostname, HOSTNAME);
        assert.equal(f.state().tunnelId, TUNNEL);
        assert.match(messages(run), /did not confirm the exact requested DNS name/);
    });
}

test("a changed authorized zone cannot resume a saved attempt against another domain", async (t) => {
    const f = fixture(t);

    await f.run({ route: "conflict" });
    const before = f.state();
    const run = await f.run({ zone: "other", confirmations: [] });

    assertNoProvisioning(run);
    assert.deepEqual(commands(run), []);
    assert.deepEqual(f.state(), before);
    assert.match(messages(run), /different authorized domain/);
});

for (const stage of ["planned", "creating", "created", "ready"] as const) {
    for (const damage of ["missing", "mismatched", "invalid"] as const) {
        test(`${damage} saved credentials at stage ${stage} fail closed without account calls`, async (t) => {
            const f = fixture(t);
            const saved = {
                version: 1,
                domain: "example.invalid",
                hostname: HOSTNAME,
                tunnelName: "pi-coop-test-attempt",
                stage,
                tunnelId: TUNNEL,
            };

            mkdirSync(f.setup, { recursive: true });
            writeFileSync(f.stateFile, JSON.stringify(saved));

            if (damage !== "missing") {
                writeFileSync(
                    f.credentialsFile,
                    JSON.stringify({
                        TunnelID:
                            damage === "invalid"
                                ? "not-a-uuid"
                                : "ffffffff-ffff-ffff-ffff-ffffffffffff",
                    }),
                );
            }

            const run = await f.run({ confirmations: [] });

            assertNoAccountCalls(run);
            assert.equal(run.result, null);
            assert.deepEqual(f.state(), saved);
            assert.match(messages(run), /credentials.*missing|credential file is invalid/);
        });
    }
}

test("a paused setup excludes a second process before state reads or account calls, then abort releases its lease", async (t) => {
    const f = fixture(t);
    const first = f.start({ pauseAt: "confirm", confirmations: [] });

    try {
        await first.paused;
        assert.equal(existsSync(f.stateFile), false);
        // If the competing process read state before acquiring the lease, it would report invalid JSON instead.
        writeFileSync(f.stateFile, "not a setup record");
        const blocked = await f.run({ confirmations: [] });

        assertNoAccountCalls(blocked);
        assert.equal(blocked.result, null);
        assert.deepEqual(
            blocked.events.filter((event) => event.kind === "ask" || event.kind === "confirm"),
            [],
        );
        assert.match(
            messages(blocked),
            /Another custom-domain setup is running.*setup-lock port is unavailable/,
        );
        assert.doesNotMatch(messages(blocked), /setup record is invalid/);
        assert.equal(readFileSync(f.stateFile, "utf8"), "not a setup record");

        if (process.platform !== "win32") {
            assert.equal(statSync(f.setup).mode & 0o777, 0o700);
        }
    } finally {
        first.abort();
        const canceled = await first.finished;

        assert.equal(canceled.result, null);
        assertNoAccountCalls(canceled);
        assertNoAuthDirectories(f.setup);
    }

    rmSync(f.stateFile);
    const next = await f.run();

    assert.equal(next.result?.tunnelId, TUNNEL);
    assert.deepEqual(
        commands(next).map((command) => command.command),
        ["login", "create", "route"],
    );
});

test("an occupied SHA256-derived loopback lease port fails closed without state reads or account calls", async (t) => {
    const f = fixture(t);

    mkdirSync(f.setup, { recursive: true, mode: 0o700 });
    writeFileSync(f.stateFile, "not a setup record");
    const digest = createHash("sha256").update(realpathSync(f.setup)).digest();
    const port = 49152 + (digest.readUInt16BE(0) % 16384);
    const occupied = createServer((socket) => socket.destroy());

    t.after(async () => {
        if (occupied.listening) {
            await new Promise<void>((resolve) => occupied.close(() => resolve()));
        }
    });
    await new Promise<void>((resolve, reject) => {
        occupied.once("error", reject);
        occupied.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
    });
    const blocked = await f.run({ confirmations: [] });

    assertNoAccountCalls(blocked);
    assert.equal(blocked.result, null);
    assert.match(messages(blocked), /setup-lock port is unavailable/);
    assert.equal(readFileSync(f.stateFile, "utf8"), "not a setup record");
    assert.equal(occupied.listening, true, "a collision must not take over the existing listener");
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
    rmSync(f.stateFile);
    const next = await f.run();

    assert.equal(next.result?.tunnelId, TUNNEL);
});

for (const pauseAt of ["ask", "confirm"] as const) {
    test(`abort settles an unresolved ${pauseAt} after sign-in and permits another setup`, async (t) => {
        const f = fixture(t);
        const paused = f.start({ pauseAt, pauseQuestion: PROVISION, confirmations: [true] });

        try {
            await paused.paused;
        } finally {
            paused.abort();
        }

        const canceled = await paused.finished;

        assertNoProvisioning(canceled);
        assert.deepEqual(
            commands(canceled).map((command) => command.command),
            ["login"],
        );
        assert.equal(canceled.events.filter((event) => event.kind === "fetch").length, 1);
        assert.equal(existsSync(f.stateFile), false);
        assertNoAuthDirectories(f.setup);
        const next = await f.run({ confirmations: [true] });

        assert.equal(next.result?.tunnelId, TUNNEL);
        assert.deepEqual(
            commands(next).map((command) => command.command),
            ["create", "route"],
        );
    });
}

test("abort settles an unresolved forget confirmation without forgetting or repeating creation", async (t) => {
    const f = fixture(t);

    await f.run({ create: "no-credentials" });
    const before = f.state();
    const paused = f.start({ pauseAt: "confirm", pauseQuestion: FORGET, confirmations: [] });

    try {
        await paused.paused;
    } finally {
        paused.abort();
    }

    const canceled = await paused.finished;

    assertNoAccountCalls(canceled);
    assert.equal(canceled.result, null);
    assert.deepEqual(f.state(), before);
    const next = await f.run({ confirmations: [false] });

    assertNoAccountCalls(next);
    assert.deepEqual(f.state(), before);
    assert.deepEqual(
        next.events.filter((event) => event.kind === "confirm"),
        [{ kind: "confirm", question: FORGET, fallback: false, answer: false }],
    );
});

for (const runtime of ["quick", "named"] as const) {
    test(`${runtime} tunnel runtime uses app-owned configuration and the intended public URL`, async (t) => {
        const f = fixture(t);
        const run = await f.run({ runtime });
        const call = commands(run)[0]!;
        const config = JSON.parse(call.configContent);

        assert.deepEqual(run.runtime, {
            urls: [
                runtime === "named"
                    ? `https://${HOSTNAME}`
                    : "https://offline-probe.trycloudflare.com",
            ],
            problems: [],
            code: 0,
        });
        assert.equal(commands(run).length, 1);
        assert.equal(
            call.configFile,
            join(f.directory, `cloudflared-${runtime === "named" ? "custom" : "quick"}.yml`),
        );
        assert.ok(call.args.includes("--no-autoupdate"));
        assert.equal(call.inheritedTunnelOverrides, false);
        assert.equal(call.preservedSentinel, true);
        assert.deepEqual(
            run.events.filter((event) => event.kind === "fetch"),
            [],
        );

        if (runtime === "named") {
            assert.deepEqual(call.args.slice(-2), ["run", TUNNEL]);
            assert.equal(call.args.includes("--url"), false);
            assert.deepEqual(config, {
                tunnel: TUNNEL,
                "credentials-file": f.credentialsFile,
                ingress: [
                    { hostname: HOSTNAME, service: "http://127.0.0.1:9182" },
                    { service: "http_status:404" },
                ],
            });
        } else {
            assert.deepEqual(config, {});
            assert.deepEqual(call.args.slice(-2), ["--url", "http://127.0.0.1:9182"]);
        }
    });
}
