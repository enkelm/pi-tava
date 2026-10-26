// Quick tunnels must not inherit ingress rules from an existing named-tunnel configuration.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const ACCESS = new URL("../src/launcher/access.ts", import.meta.url).href;

// Node runs this extensionless file as the fake cloudflared's `tunnel` command. It records the selected configuration
// and simulates a catch-all ingress rule taking precedence over --url, without connecting to Cloudflare.
const FAKE_TUNNEL = `
const { readFileSync, writeFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");
const args = process.argv.slice(2);
const at = args.indexOf("--config");
const configFile = at < 0 ? join(homedir(), ".cloudflared", "config.yml") : args[at + 1];
const configContent = readFileSync(configFile, "utf8");
const config = JSON.parse(configContent);
const requestHost = process.env.PP_TEST_HOST ?? "offline-probe.trycloudflare.com";
const origin = config.ingress?.find((rule) => !rule.hostname || rule.hostname === requestHost)?.service
    ?? args[args.indexOf("--url") + 1];
const inheritedOverride = Object.keys(process.env).some((key) => /^TUNNEL_/i.test(key));

writeFileSync("capture.json", JSON.stringify({ args, configFile, configContent, origin, inheritedOverride }));
console.log("https://offline-probe.trycloudflare.com");
console.log("Registered tunnel connection");
setInterval(() => {}, 1000);
`;

// A separate runner gives the fake command its own cwd and HOME without changing either in the test process.
const RUNNER = `
import { join } from "node:path";
import { CloudflareTunnel } from ${JSON.stringify(ACCESS)};

const ready = Promise.withResolvers();
const exited = Promise.withResolvers();
const problems = [];
const named = JSON.parse(process.env.PP_TEST_NAMED ?? "null") ?? undefined;
const tunnel = new CloudflareTunnel(process.execPath, 9182, join(process.cwd(), "cloudflared.log"), {
    ready: ready.resolve,
    problem: (line) => problems.push(line),
    exit(code) {
        ready.reject(new Error("Tunnel exited before becoming ready: " + code));
        exited.resolve();
    },
}, named);

try {
    tunnel.start();
    const url = await ready.promise;

    await tunnel.stop();
    await exited.promise;
    console.log(JSON.stringify({ url, problems }));
} finally {
    await tunnel.stop();
}
`;

for (const custom of [false, true]) {
    test(`${custom ? "custom" : "quick"} tunnels isolate configuration and route to the loopback app`, () => {
        const directory = mkdtempSync(join(tmpdir(), "pp-launcher-tunnel-"));
        const home = join(directory, "home");
        const defaultConfig = join(home, ".cloudflared", "config.yml");
        // JSON is valid YAML, and lets the offline stand-in inspect the real file passed by the launcher.
        const namedConfig = JSON.stringify({
            tunnel: "existing-named-tunnel",
            ingress: [
                { hostname: "*.example.invalid", service: "http://127.0.0.1:8080" },
                { service: "http_status:404" },
            ],
        });

        try {
            mkdirSync(join(home, ".cloudflared"), { recursive: true });
            writeFileSync(defaultConfig, namedConfig);
            writeFileSync(join(directory, "tunnel"), FAKE_TUNNEL);
            const named = custom
                ? {
                      hostname: "pi-coop-device.example.invalid",
                      tunnelId: "89ff53fb-326a-40a8-93e6-b7d09983087a",
                      credentialsFile: join(directory, "credentials.json"),
                  }
                : undefined;
            const run = spawnSync(process.execPath, ["--input-type=module", "-e", RUNNER], {
                cwd: directory,
                env: {
                    ...process.env,
                    HOME: home,
                    USERPROFILE: home,
                    PP_TEST_NAMED: JSON.stringify(named ?? null),
                    PP_TEST_HOST: named?.hostname ?? "offline-probe.trycloudflare.com",
                    TUNNEL_NAME: "unrelated-tunnel",
                    TUNNEL_TOKEN: "test-only-token",
                    TUNNEL_FORCE_PROVISIONING_DNS: "true",
                },
                encoding: "utf8",
                timeout: 10_000,
            });

            assert.equal(run.error, undefined);
            assert.equal(run.status, 0, run.stderr);
            assert.deepEqual(JSON.parse(run.stdout), {
                url: `https://${named?.hostname ?? "offline-probe.trycloudflare.com"}`,
                problems: [],
            });
            const capture = JSON.parse(readFileSync(join(directory, "capture.json"), "utf8"));

            assert.equal(
                capture.origin,
                "http://127.0.0.1:9182",
                "the quick tunnel must use --url, not the named tunnel's catch-all 404",
            );
            assert.ok(capture.args.includes("--config"));
            assert.ok(capture.args.includes("--no-autoupdate"));
            assert.notEqual(capture.configFile, defaultConfig);

            if (named === undefined) {
                assert.equal(capture.configContent, "{}\n");
                assert.equal(capture.args.includes("run"), false);
            } else {
                const config = JSON.parse(capture.configContent);

                assert.deepEqual(config, {
                    tunnel: named.tunnelId,
                    "credentials-file": named.credentialsFile,
                    ingress: [
                        { hostname: named.hostname, service: "http://127.0.0.1:9182" },
                        { service: "http_status:404" },
                    ],
                });
                assert.deepEqual(capture.args.slice(-2), ["run", named.tunnelId]);
                assert.equal(capture.args.includes("--url"), false);
            }

            assert.equal(capture.inheritedOverride, false);
            assert.equal(readFileSync(defaultConfig, "utf8"), namedConfig);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });
}
