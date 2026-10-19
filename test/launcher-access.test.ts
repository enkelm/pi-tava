// How the launcher chooses its access mode, and what it does with one that is not ready, such as Tailscale while it is
// not connected.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { type AccessChoice, type AccessMode, chooseAccess } from "../src/launcher/access.ts";

/** A launch where only `ready` modes can be used. */
function launch(
    choice: Partial<AccessChoice> & { ready: AccessMode[]; picks?: (AccessMode | undefined)[] },
) {
    const tried: AccessMode[] = [];
    const picks = [...(choice.picks ?? [])];

    const result = chooseAccess({
        given: choice.given,
        saved: choice.saved,
        ask: choice.ask ?? false,
        menu: async () => {
            if (picks.length === 0) {
                throw new Error("the menu showed more often than the test expected");
            }

            return picks.shift();
        },
        prepare: async (mode) => {
            tried.push(mode);

            // Before 0.13.1, -y with a saved mode that was not ready tried it again forever.
            if (tried.length > 10) {
                throw new Error(`tried ${mode} over and over`);
            }

            return choice.ready.includes(mode)
                ? mode === "cloudflare"
                    ? "/bin/cloudflared"
                    : true
                : false;
        },
    });

    return { result };
}

test("-y with a saved mode that is not ready ends the start instead of trying it forever", async () => {
    for (const saved of ["tailscale", "tailscale-https"] as const) {
        const run = launch({ saved, ask: false, ready: ["local", "lan"] });

        assert.equal(await run.result, "unready");
    }
});

test("a mode from the menu that is not ready goes back to the menu", async () => {
    const run = launch({
        saved: "tailscale",
        ask: true,
        ready: ["lan"],
        picks: ["tailscale", "lan"],
    });

    assert.deepEqual(await run.result, { mode: "lan" });
});

test("Tailscale HTTPS is an explicit CLI choice and saved HTTP access is not silently upgraded", async () => {
    const script = `import { parseArgs } from './src/launcher/options.ts'; console.log(JSON.stringify(parseArgs(process.argv.slice(1))));`;
    const result = spawnSync(
        process.execPath,
        [
            "--input-type=module",
            "-e",
            script,
            "--",
            "--access",
            "tailscale-https",
            "--port",
            "9443",
        ],
        {
            encoding: "utf8",
            env: { ...process.env, PI_POCKET_ACCESS: "", PI_POCKET_PORT: "8787" },
        },
    );

    assert.equal(result.status, 0, result.stderr);
    const options = JSON.parse(result.stdout);

    assert.equal(options.access, "tailscale-https");
    assert.equal(options.port, 9443);
    assert.deepEqual(await launch({ given: options.access, ready: ["tailscale-https"] }).result, {
        mode: "tailscale-https",
    });
    assert.deepEqual(
        await launch({ saved: "tailscale", ready: ["tailscale", "tailscale-https"] }).result,
        { mode: "tailscale" },
    );
});

test("a ready mode starts, with the cloudflared to run for a tunnel", async () => {
    assert.deepEqual(await launch({ given: "cloudflare", ready: ["cloudflare"] }).result, {
        mode: "cloudflare",
        binary: "/bin/cloudflared",
    });
});
