/** Offline preparation is an explicit, independent copy; failures must not replace or partially publish dependencies. */
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import {
    mkdtemp,
    mkdir,
    readFile,
    readdir,
    realpath,
    rm,
    stat,
    symlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { inspectDependencies, prepareWorktree } from "../scripts/prepare-worktree.ts";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
    const root = await realpath(await mkdtemp(join(tmpdir(), "coop-native-environment-")));

    let retained = false;

    t.after(async () => {
        if (!retained) {
            await rm(root, { recursive: true, force: true });
        }
    });
    const source = join(root, "source");
    const target = join(root, "target");
    const common = join(root, "git");

    // Separate-git-dir checkouts suffice for read-only repository identity; no fixture commit needed.
    execFileSync("git", ["init", "--quiet", `--separate-git-dir=${common}`, source]);
    await mkdir(target);
    await writeFile(join(target, ".git"), `gitdir: ${common}\n`);
    const manifest = { dependencies: { example: "1.0.0" }, devDependencies: { tooling: "2.0.0" } };
    const packages = {
        "": manifest,
        "node_modules/example": { version: "1.0.0", dependencies: { tooling: "2.0.0" } },
        "node_modules/tooling": { version: "2.0.0" },
        "node_modules/optional-platform": { version: "3.0.0", optional: true },
    };
    const lock = { lockfileVersion: 3, packages };

    for (const folder of [source, target]) {
        await writeFile(join(folder, "package.json"), JSON.stringify(manifest));
        await writeFile(join(folder, "package-lock.json"), JSON.stringify(lock));
    }

    const modules = join(source, "node_modules");

    await mkdir(join(modules, ".bin"), { recursive: true });

    for (const [name, version] of [
        ["example", "1.0.0"],
        ["tooling", "2.0.0"],
    ]) {
        await mkdir(join(modules, name!));
        await writeFile(
            join(modules, name!, "package.json"),
            JSON.stringify({ name, version, main: "index.cjs" }),
        );
        await writeFile(join(modules, name!, "index.cjs"), `module.exports = '${version}';\n`);
    }

    await writeFile(join(modules, "tooling", "cli"), "#!/bin/sh\nprintf 'tooling-ok'\n", {
        mode: 0o755,
    });
    await symlink("../tooling/cli", join(modules, ".bin", "tooling"));
    const { "": _root, "node_modules/optional-platform": _optional, ...installed } = packages;

    await writeFile(
        join(modules, ".package-lock.json"),
        JSON.stringify({ lockfileVersion: 3, packages: installed }),
    );

    return { source, target, modules, retain: () => (retained = true) };
}

/** A failed CLI must not turn this test's cleanup into another indefinite SIGTERM-only wait. */
function boundedClose(child: ChildProcess, retain: () => void, timeoutMs = 10_000) {
    return new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
        let failure: Error | undefined;
        let escalation: NodeJS.Timeout | undefined;
        let settlement: NodeJS.Timeout | undefined;

        const send = (signal: NodeJS.Signals) => {
            try {
                child.kill(signal);
            } catch (error) {
                failure ??= error as Error;
            }
        };

        const deadline = setTimeout(() => {
            // CLI close after forced termination cannot establish its copier's settlement.
            retain();
            failure ??= new Error("CLI test watchdog expired; fixture retained for inspection.");
            send("SIGTERM");
            escalation = setTimeout(() => {
                send("SIGKILL");
                settlement = setTimeout(() => {
                    retain();
                    child.unref();
                    child.stdout?.destroy();
                    child.stderr?.destroy();
                    reject(new Error("CLI close unconfirmed; fixture retained, cleanup unsafe."));
                }, 1000);
            }, 1000);
        }, timeoutMs);

        child.on("error", (error) => {
            failure ??= error;
        });
        child.once("close", (code, signal) => {
            clearTimeout(deadline);
            clearTimeout(escalation);
            clearTimeout(settlement);

            if (failure !== undefined) {
                reject(failure);
            } else {
                resolve({ code, signal });
            }
        });
    });
}

// Standard Node preload interposition keeps arbitrary executables/options out of production.
// The replacement is a real owned process: it writes staging, acknowledges but ignores SIGTERM,
// and can only report SIGKILL settlement through Node's actual child close event.
function resistantCopierPreload(denySignals: boolean): string {
    const script = `
        const { mkdirSync, writeFileSync } = require('node:fs');
        const { join } = require('node:path');
        const destination = process.argv[1];
        mkdirSync(destination);
        process.on('SIGTERM', () => {
            writeFileSync(join(destination, 'term'), 'still present');
            console.log(JSON.stringify({ fixture: 'term' }));
        });
        setInterval(() => writeFileSync(join(destination, 'writing'), 'active'), 25);
        setTimeout(() => process.exit(88), 35_000);
        console.log(JSON.stringify({ fixture: 'ready' }));
    `;

    return `
        import cp from 'node:child_process';
        import { syncBuiltinESMExports } from 'node:module';
        import { existsSync } from 'node:fs';
        import { dirname } from 'node:path';
        const spawn = cp.spawn;
        cp.spawn = (command, args, options) => {
            if (command !== '/bin/cp') throw new Error('Unexpected executable');
            const destination = args.at(-1);
            const staging = dirname(destination);
            const child = spawn(process.execPath, ['--eval', ${JSON.stringify(script)}, destination], {
                ...options, stdio: ['ignore', 'pipe', 'pipe'],
            });
            child.stdout.on('data', chunk => process.stdout.write(chunk));
            child.stderr.on('data', chunk => process.stderr.write(chunk));
            child.once('close', (code, signal) => {
                console.log(JSON.stringify({ fixture: 'closed', code, signal, stagingExists: existsSync(staging) }));
            });
            if (${denySignals}) {
                child.stdout.unref();
                child.stderr.unref();
                const kill = child.kill.bind(child);
                child.kill = signal => {
                    console.log(JSON.stringify({ fixture: 'signal-denied', signal }));
                    return false;
                };
                process.once('beforeExit', () => {
                    console.log(JSON.stringify({ fixture: 'retained', stagingExists: existsSync(staging) }));
                    child.ref();
                    kill('SIGKILL'); // Test-owned teardown after the production uncertain outcome.
                });
            }
            return child;
        };
        syncBuiltinESMExports();
    `;
}

test("offline bootstrap preserves working resolution, executable links and independent file bytes", async (t) => {
    const f = await fixture(t);
    const result = await prepareWorktree(f.source, f.target);

    assert.equal(result.packages, 2);
    assert.equal(await inspectDependencies(f.target), 2);
    assert.equal(
        execFileSync(process.execPath, ["-e", "process.stdout.write(require('example'))"], {
            cwd: f.target,
            encoding: "utf8",
        }),
        "1.0.0",
    );
    assert.equal(
        execFileSync(join(f.target, "node_modules/.bin/tooling"), { encoding: "utf8" }),
        "tooling-ok",
    );
    const from = join(f.modules, "example/index.cjs");
    const to = join(f.target, "node_modules/example/index.cjs");

    assert.notEqual((await stat(from)).ino, (await stat(to)).ino, "never a mutable hardlink");
    await writeFile(to, "target-only change");
    assert.equal(await readFile(from, "utf8"), "module.exports = '1.0.0';\n");
    assert.deepEqual((await readdir(f.target)).sort(), [
        ".git",
        "node_modules",
        "package-lock.json",
        "package.json",
    ]);
});

test("invalid dependency donors fail closed without publishing a partial installation", async (t) => {
    const cases = [
        {
            name: "different lockfile",
            change: async (f: Awaited<ReturnType<typeof fixture>>) =>
                writeFile(join(f.source, "package-lock.json"), "{}"),
            error: /different package-lock.json/,
        },
        {
            name: "different repository",
            change: async (f: Awaited<ReturnType<typeof fixture>>) => {
                await rm(join(f.target, ".git"));
                execFileSync("git", ["init", "--quiet", f.target]);
            },
            error: /same repository/,
        },
        {
            name: "unrecorded package version",
            change: async (f: Awaited<ReturnType<typeof fixture>>) =>
                writeFile(join(f.modules, "example/package.json"), '{"version":"9.0.0"}'),
            error: /does not match the lockfile/,
        },
        {
            name: "missing required transitive dependency",
            change: async (f: Awaited<ReturnType<typeof fixture>>) => {
                const path = join(f.source, "package-lock.json");
                const lock = JSON.parse(await readFile(path, "utf8"));

                lock.packages["node_modules/example"].dependencies.missing = "1.0.0";

                for (const folder of [f.source, f.target]) {
                    await writeFile(join(folder, "package-lock.json"), JSON.stringify(lock));
                }
            },
            error: /Missing installed dependency: missing/,
        },
        {
            name: "missing locked nested version cannot borrow an incompatible ancestor",
            change: async (f: Awaited<ReturnType<typeof fixture>>) => {
                const lock = JSON.parse(
                    await readFile(join(f.source, "package-lock.json"), "utf8"),
                );

                lock.packages["node_modules/example"].dependencies.tooling = "1.0.0";
                lock.packages["node_modules/example/node_modules/tooling"] = { version: "1.0.0" };

                for (const folder of [f.source, f.target]) {
                    await writeFile(join(folder, "package-lock.json"), JSON.stringify(lock));
                }
            },
            error: /Missing installed dependency: tooling.*example/,
        },
        {
            name: "escaping dependency link",
            change: async (f: Awaited<ReturnType<typeof fixture>>) =>
                symlink("../package.json", join(f.modules, "outside")),
            error: /symlink escapes/,
        },
    ];

    for (const entry of cases) {
        await t.test(entry.name, async (t) => {
            const f = await fixture(t);

            await entry.change(f);
            await assert.rejects(prepareWorktree(f.source, f.target), entry.error);
            assert.equal(
                (await readdir(f.target)).some(
                    (name) => name === "node_modules" || name.startsWith(".coop-dependencies-"),
                ),
                false,
            );
        });
    }
});

test("bootstrap refuses an existing installation, including a dangling link, without changing it", async (t) => {
    for (const kind of ["directory", "link"]) {
        await t.test(kind, async (t) => {
            const f = await fixture(t);
            const destination = join(f.target, "node_modules");

            if (kind === "directory") {
                await mkdir(destination);
                await writeFile(join(destination, "keep"), "inherited dependency bytes");
            } else {
                await symlink("missing-donor", destination);
            }

            await assert.rejects(prepareWorktree(f.source, f.target), /already exists/);

            if (kind === "directory") {
                assert.equal(
                    await readFile(join(destination, "keep"), "utf8"),
                    "inherited dependency bytes",
                );
            } else {
                assert.equal((await readdir(f.target)).includes("node_modules"), true);
            }
        });
    }
});

test("native preflight reports missing dependencies as failure while joining its child and cleaning its private logs", async (t) => {
    const f = await fixture(t);
    const result = spawnSync(process.execPath, [resolve("scripts/native-preflight.ts")], {
        cwd: f.target,
        encoding: "utf8",
        timeout: 10_000,
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.signal, null);
    const rows = result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));

    assert.equal(rows.find((row) => row.probe === "dependencies").status, "failed");
    assert.equal(rows.find((row) => row.probe === "private-temp").status, "ok");
    assert.deepEqual(rows.find((row) => row.probe === "child-cancel-and-join").detail, {
        code: null,
        signal: "SIGTERM",
        joined: true,
    });
    await assert.rejects(stat(rows.find((row) => row.probe === "private-temp").detail.path), {
        code: "ENOENT",
    });
});

test("native preflight cancellation after its final probe still fails and cleans its private logs", async (t) => {
    const f = await fixture(t);
    // Schedule a real signal at the public JSON delivery boundary, before asynchronous cleanup.
    const preload = `
        const log = console.log;
        console.log = (line) => {
            log(line);
            if (JSON.parse(line).probe === 'child-cancel-and-join') {
                process.kill(process.pid, 'SIGTERM');
            }
        };
    `;
    const result = spawnSync(
        process.execPath,
        [
            "--import",
            `data:text/javascript,${encodeURIComponent(preload)}`,
            resolve("scripts/native-preflight.ts"),
        ],
        { cwd: f.source, encoding: "utf8", timeout: 10_000 },
    );

    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 130, result.stderr);
    const rows = result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));

    assert.equal(rows.find((row) => row.probe === "dependencies").status, "ok");
    assert.equal(rows.find((row) => row.probe === "child-cancel-and-join").status, "ok");
    await assert.rejects(stat(rows.find((row) => row.probe === "private-temp").detail.path), {
        code: "ENOENT",
    });
});

test("in-flight preparation cannot publish after cancellation or manifest drift", async (t) => {
    for (const action of ["cancel", "change-manifest"]) {
        await t.test(action, async (t) => {
            const f = await fixture(t);

            // Keep verification active until the parent can act on the real CLI copy-start event.
            await writeFile(join(f.modules, "payload"), Buffer.alloc(16 * 1024 * 1024, 42));
            const child = spawn(
                process.execPath,
                [resolve("scripts/prepare-worktree.ts"), "--from", f.source],
                {
                    cwd: f.target,
                    stdio: ["ignore", "pipe", "pipe"],
                },
            );
            let error = "";
            let output = "";
            let acted = false;

            child.stderr.on("data", (chunk: Buffer) => {
                error += chunk.toString();
            });
            child.stdout.on("data", (chunk: Buffer) => {
                output += chunk.toString();

                if (!acted && output.includes('"phase":"copying"')) {
                    acted = true;

                    if (action === "cancel") {
                        child.kill("SIGTERM");
                    } else {
                        writeFileSync(join(f.target, "package.json"), '{"dependencies":{}}');
                    }
                }
            });
            const result = await boundedClose(child, f.retain);

            assert.equal(
                acted,
                true,
                "the race must cross real staging, not pre-admission failure",
            );
            assert.equal(
                result.signal,
                null,
                "the CLI must finish its cleanup instead of dying on SIGTERM",
            );
            assert.equal(result.code, action === "cancel" ? 130 : 1, error);
            assert.match(error, action === "cancel" ? /cancelled/ : /changed/);
            assert.equal(
                (await readdir(f.target)).some(
                    (name) => name === "node_modules" || name.startsWith(".coop-dependencies-"),
                ),
                false,
            );
        });
    }
});

for (const action of ["deadline", "cancel", "denied-signals"]) {
    test(`copier ${action} bounds a real resistant child and preserves staging until settlement`, async (t) => {
        const f = await fixture(t);
        const preload = resistantCopierPreload(action === "denied-signals");
        const child = spawn(
            process.execPath,
            [
                "--import",
                `data:text/javascript,${encodeURIComponent(preload)}`,
                resolve("scripts/prepare-worktree.ts"),
                "--from",
                f.source,
            ],
            { cwd: f.target, stdio: ["ignore", "pipe", "pipe"] },
        );
        let output = "";
        let error = "";
        let cancelled = false;

        child.stderr.on("data", (chunk: Buffer) => {
            error += chunk.toString();
        });
        child.stdout.on("data", (chunk: Buffer) => {
            output += chunk.toString();

            if (action !== "deadline" && !cancelled && output.includes('"fixture":"ready"')) {
                cancelled = true;
                child.kill("SIGTERM");
            }
        });
        const result = await boundedClose(child, f.retain, 40_000);
        const rows = output
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
        const closed = rows.find((row) => row.fixture === "closed");
        const stage = rows.find((row) => row.phase === "copying").staging;

        assert.equal(result.signal, null, error);
        assert.equal(result.code, action === "deadline" ? 1 : 130, error);
        assert.ok(
            rows.some((row) => row.fixture === "ready"),
            "fixture was active before stop",
        );
        assert.equal(closed.signal, "SIGKILL", "SIGTERM alone must not settle the fixture");
        assert.equal(closed.stagingExists, true, "staging must survive until exact child close");
        await assert.rejects(stat(join(f.target, "node_modules")), { code: "ENOENT" });

        if (action === "denied-signals") {
            assert.deepEqual(
                rows.filter((row) => row.fixture === "signal-denied").map((row) => row.signal),
                ["SIGTERM", "SIGKILL"],
            );
            assert.equal(rows.find((row) => row.fixture === "retained").stagingExists, true);
            assert.match(error, /termination unconfirmed.*staging retained/i);
            assert.ok((await stat(stage)).isDirectory(), "uncertain stage is never auto-cleaned");
        } else {
            assert.ok(
                rows.some((row) => row.fixture === "term"),
                "child acknowledged SIGTERM but kept writing",
            );
            assert.match(error, action === "deadline" ? /deadline/ : /cancelled/);
            await assert.rejects(stat(stage), { code: "ENOENT" });
        }
    });
}

test("already cancelled preparation allocates no installation or staging directory", async (t) => {
    const f = await fixture(t);
    const controller = new AbortController();

    controller.abort(new Error("revoked test invocation"));
    await assert.rejects(
        prepareWorktree(f.source, f.target, controller.signal),
        /revoked test invocation/,
    );
    assert.deepEqual((await readdir(f.target)).sort(), [
        ".git",
        "package-lock.json",
        "package.json",
    ]);
});
