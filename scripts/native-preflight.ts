/** Bounded native capability checks. No retries, permission changes, live app, or implicit dependency install. */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectDependencies } from "./prepare-worktree.ts";

const controller = new AbortController();

const stop = () => {
    controller.abort(new Error("Preflight cancelled; no retry attempted."));
    process.exitCode = 130;
};

process.on("SIGINT", stop);
process.on("SIGTERM", stop);

let root: string | undefined;

async function probe(name: string, run: () => Promise<unknown>): Promise<void> {
    try {
        controller.signal.throwIfAborted();
        const detail = await run();

        controller.signal.throwIfAborted();
        console.log(JSON.stringify({ probe: name, status: "ok", detail }));
    } catch (error) {
        const failure = error as NodeJS.ErrnoException;

        console.log(
            JSON.stringify({
                probe: name,
                status: "failed",
                code: failure.code,
                error: failure.message,
            }),
        );
        process.exitCode = controller.signal.aborted ? 130 : 1;
    }
}

try {
    if (process.argv.slice(2).some((arg) => arg !== "--listen") || process.argv.length > 3) {
        throw new Error("Usage: node scripts/native-preflight.ts [--listen]");
    }

    console.log(
        JSON.stringify({
            node: process.version,
            platform: process.platform,
            cwd: process.cwd(),
            tmpdir: tmpdir(),
            listenerRequested: process.argv.includes("--listen"),
        }),
    );
    await probe("dependencies", async () => ({
        packages: await inspectDependencies(process.cwd()),
    }));
    await probe("private-temp", async () => {
        root = await mkdtemp(join(tmpdir(), "coop-native-preflight-"));
        await writeFile(join(root, "probe.log"), "native-temp-ok\n", { flag: "wx", mode: 0o600 });

        if ((await readFile(join(root, "probe.log"), "utf8")) !== "native-temp-ok\n") {
            throw new Error("Temporary log did not round-trip.");
        }

        return { path: root };
    });
    await probe("child-cancel-and-join", async () => {
        if (root === undefined) {
            throw new Error("No authorized private temporary directory; child not started.");
        }

        const script = `
            const { writeFileSync } = require('node:fs');
            const { join } = require('node:path');
            writeFileSync(join(process.env.TMPDIR, 'child.log'), 'child-temp-ok');
            process.stdout.write('ready\\n');
            setTimeout(() => process.exit(23), 1500);
        `;
        const child = spawn(process.execPath, ["--eval", script], {
            env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let failure: Error | undefined;
        let output = "";

        const cancel = () => {
            try {
                if (!child.kill("SIGTERM")) {
                    failure ??= new Error("Child could not be signalled.");
                }
            } catch (error) {
                failure ??= error as Error;
            }
        };

        const timer = setTimeout(cancel, 3000);

        controller.signal.addEventListener("abort", cancel, { once: true });

        if (controller.signal.aborted) {
            cancel();
        }

        child.stdout.on("data", (chunk: Buffer) => {
            output = (output + chunk.toString()).slice(-4096);

            if (output.includes("ready\n")) {
                cancel();
            }
        });
        // Drain stderr but never expose arbitrary environment or credential-bearing output.
        child.stderr.resume();
        child.on("error", (error) => {
            failure ??= error;
        });
        const result = await new Promise<{ code: number | null; signal: string | null }>(
            (resolve) => {
                child.once("close", (code, signal) => resolve({ code, signal }));
            },
        );

        clearTimeout(timer);
        controller.signal.removeEventListener("abort", cancel);
        controller.signal.throwIfAborted();

        if (failure !== undefined) {
            throw failure;
        }

        if (
            result.signal !== "SIGTERM" ||
            (await readFile(join(root, "child.log"), "utf8")) !== "child-temp-ok"
        ) {
            throw new Error(`Child cancellation was not confirmed: ${JSON.stringify(result)}`);
        }

        return { ...result, joined: true };
    });

    if (process.argv.includes("--listen")) {
        await probe(
            "loopback-listen",
            () =>
                new Promise((resolve, reject) => {
                    const server = createServer();

                    server.once("error", reject);
                    server.listen(0, "127.0.0.1", () => {
                        const address = server.address();

                        server.close((error) =>
                            error ? reject(error) : resolve({ address, closed: true }),
                        );
                    });
                }),
        );
    }
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = controller.signal.aborted ? 130 : 1;
} finally {
    if (root !== undefined) {
        await rm(root, { recursive: true, force: true });
    }

    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
}
