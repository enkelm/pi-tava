// Exercise real launcher keyboard/shutdown handling with a disposable app and a fake Cloudflare login process.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

const ENTRY = new URL("../bin/pi-coop.js", import.meta.url).href;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

for (const scenario of ["initial", "initial-yes", "menu", "menu-yes", "transition"] as const) {
    const fromMenu = scenario === "menu" || scenario === "menu-yes";
    const transition = scenario === "transition";
    const startupYes = scenario === "initial-yes" || scenario === "menu-yes";

    test(
        scenario === "initial-yes"
            ? "startup -y cannot provision an unconfigured custom domain even in a terminal"
            : scenario === "menu-yes"
              ? "the access menu after startup -y allows confirmed custom-domain setup"
              : transition
                ? "quitting during a tunnel access transition joins the old tunnel and cannot start its replacement"
                : `Ctrl+C ${fromMenu ? "from the access menu" : "during initial custom setup"} joins the setup child before exiting`,
        {
            skip: process.platform === "win32" ? "requires POSIX signal handling" : false,
            timeout: 45_000,
        },
        async () => {
            const directory = mkdtempSync(join(tmpdir(), "pp-custom-lifecycle-"));
            const bin = join(directory, "bin");
            const home = join(directory, "home");
            const agent = join(directory, "agent");
            const pidFile = join(directory, "setup-child.pid");
            const stopFile = join(directory, "stop-seen");
            const callsFile = join(directory, "calls.jsonl");
            const data = join(directory, "data");

            mkdirSync(bin);
            mkdirSync(home);
            mkdirSync(agent);
            writeFileSync(
                join(bin, "cloudflared"),
                `#!${process.execPath}
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(process.argv.slice(2)) + "\\n");
process.on("SIGTERM", () => fs.writeFileSync(${JSON.stringify(stopFile)}, "stopping"));
console.log(process.argv.includes("login") ? "FAKE_LOGIN_WAIT"
    : "https://offline-probe.trycloudflare.com\\nRegistered tunnel connection");
setInterval(() => {}, 1000);
`,
                { mode: 0o700 },
            );

            if (transition) {
                const custom = join(data, "cloudflare-custom");
                const tunnelId = "89ff53fb-326a-40a8-93e6-b7d09983087a";

                mkdirSync(custom, { recursive: true });
                writeFileSync(
                    join(custom, "setup.json"),
                    JSON.stringify({
                        version: 1,
                        domain: "example.invalid",
                        hostname: "pi-coop-test.example.invalid",
                        tunnelName: "pi-coop-test",
                        stage: "ready",
                        tunnelId,
                    }),
                );
                writeFileSync(
                    join(custom, "credentials.json"),
                    JSON.stringify({ TunnelID: tunnelId }),
                );
            }

            const probe = createServer();

            await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
            const port = (probe.address() as { port: number }).port;

            await new Promise<void>((resolve) => probe.close(() => resolve()));
            // The real key parser receives pipe input. Only the TTY capabilities are replaced; no personal terminal
            // is opened or changed, and both the app and its cloudflared subprocess get temporary homes.
            const wrapper = `
Object.defineProperty(process.stdin, "isTTY", { value: true });
Object.defineProperty(process.stdout, "isTTY", { value: true });
process.stdin.setRawMode = () => process.stdin;
await import(${JSON.stringify(ENTRY)});
`;
            const child = spawn(
                process.execPath,
                [
                    "--input-type=module",
                    "-e",
                    wrapper,
                    "--",
                    "launcher-fixture",
                    "--access",
                    transition ? "cloudflare" : fromMenu ? "local" : "cloudflare-custom",
                    "--data",
                    data,
                    "--port",
                    String(port),
                    "--cwd",
                    directory,
                    ...(startupYes ? ["--yes"] : []),
                ],
                {
                    detached: true,
                    stdio: ["pipe", "pipe", "pipe"],
                    env: {
                        PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
                        HOME: home,
                        USERPROFILE: home,
                        PI_CODING_AGENT_DIR: agent,
                        PI_OFFLINE: "1",
                        PI_POCKET_GUARD: "off",
                        NO_COLOR: "1",
                    },
                },
            );
            let output = "";

            child.stdout!.on("data", (chunk) => {
                output += chunk;
            });
            child.stderr!.on("data", (chunk) => {
                output += chunk;
            });
            const closed = new Promise<number | null>((resolve, reject) => {
                child.once("error", reject);
                child.once("close", resolve);
            });

            const until = async (check: () => boolean, what: string, timeout = 15_000) => {
                const start = Date.now();

                while (!check()) {
                    assert.equal(child.exitCode, null, `launcher exited while waiting for ${what}`);
                    assert.ok(Date.now() - start < timeout, `timed out waiting for ${what}`);
                    await delay(25);
                }
            };

            const kill = () => {
                if (child.pid !== undefined) {
                    try {
                        process.kill(-child.pid, "SIGKILL");
                    } catch (error) {
                        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
                            throw error;
                        }
                    }
                }
            };

            const watchdog = setTimeout(kill, 40_000);

            try {
                if (scenario === "initial-yes") {
                    assert.equal(await closed, 1);
                    assert.ok(output.includes("Custom domain is not configured."));
                    assert.equal(
                        existsSync(callsFile),
                        false,
                        "startup -y made no cloudflared calls",
                    );

                    return;
                }

                if (fromMenu || transition) {
                    await until(
                        () => output.includes("● running"),
                        "the disposable server",
                        25_000,
                    );
                    child.stdin!.write("a");
                    await until(
                        () => output.includes("How should your devices reach pi-tava?"),
                        "the access menu",
                    );
                    assert.ok(
                        output.includes("Cloudflare custom domain"),
                        "a shows custom domains in the access menu",
                    );
                    child.stdin!.write("4\r");
                }

                if (transition) {
                    await until(() => existsSync(stopFile), "the access transition's tunnel stop");
                } else {
                    await until(
                        () =>
                            output.includes("Sign in to Cloudflare for pi-tava?") ||
                            output.includes("Custom domain is not configured."),
                        "sign-in confirmation or setup refusal",
                    );
                    assert.ok(
                        output.includes("Sign in to Cloudflare for pi-tava?"),
                        "explicit access-menu selection must allow confirmed setup even after startup -y",
                    );
                    child.stdin!.write("y");
                    await until(() => output.includes("FAKE_LOGIN_WAIT"), "the fake browser login");
                }

                const setupPid = Number(readFileSync(pidFile, "utf8"));
                const start = Date.now();

                child.stdin!.write(transition ? "q" : "\x03");
                await until(
                    () => output.includes("Stopping pi-tava"),
                    "Ctrl+C while setup is busy",
                    3000,
                );
                assert.equal(await closed, scenario === "initial" ? 130 : 0);
                assert.ok(Date.now() - start >= 3000, "shutdown awaited forced setup termination");
                let alive = true;

                try {
                    process.kill(setupPid, 0);
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
                        throw error;
                    }

                    alive = false;
                }

                assert.equal(alive, false, "the child was reaped before launcher exit");
                assert.equal(
                    readFileSync(callsFile, "utf8").trim().split("\n").length,
                    1,
                    "no replacement tunnel or provisioning command started during shutdown",
                );
            } finally {
                clearTimeout(watchdog);
                kill();
                await closed.catch(() => {});
                rmSync(directory, { recursive: true, force: true });
            }
        },
    );
}
