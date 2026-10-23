/** Explicit offline dependency preparation. Copies a matching sibling checkout; never installs or links it. */
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, renameSync, rmdirSync } from "node:fs";
import { lstat, mkdtemp, readFile, readdir, readlink, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

type Package = {
    version?: string;
    integrity?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
};
type Lock = { lockfileVersion: number; packages: Record<string, Package> };

function inside(root: string, path: string): boolean {
    const part = relative(root, path);

    return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`));
}

async function absent(path: string): Promise<boolean> {
    try {
        await lstat(path);

        return false;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
        }

        return true;
    }
}

function repository(path: string): string {
    const output = execFileSync(
        "git",
        ["-C", path, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"],
        { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] },
    )
        .trimEnd()
        .split("\n");

    if (output.length !== 2 || resolve(output[0]!) !== path) {
        throw new Error("Dependency preparation requires checkout roots, not subdirectories.");
    }

    return output[1]!;
}

/** Inspect installed metadata without importing package code or trusting a PATH-only tool override. */
export async function inspectDependencies(checkout: string): Promise<number> {
    return inspectInstallation(
        join(checkout, "node_modules"),
        JSON.parse(await readFile(join(checkout, "package.json"), "utf8")),
        JSON.parse(await readFile(join(checkout, "package-lock.json"), "utf8")),
    );
}

async function inspectInstallation(
    modules: string,
    manifest: Package,
    lock: Lock,
): Promise<number> {
    if (!(await lstat(modules)).isDirectory()) {
        throw new Error("node_modules must be an independent directory, not a dependency symlink.");
    }

    const installed: Lock = JSON.parse(await readFile(join(modules, ".package-lock.json"), "utf8"));

    if (lock.lockfileVersion !== 3 || installed.lockfileVersion !== 3) {
        throw new Error("Dependency preparation requires npm lockfile version 3.");
    }

    for (const field of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
        if (
            JSON.stringify(Object.entries(manifest[field] ?? {}).sort()) !==
            JSON.stringify(Object.entries(lock.packages[""]?.[field] ?? {}).sort())
        ) {
            throw new Error(`Manifest and lockfile disagree on ${field}.`);
        }
    }

    const records = installed.packages;

    for (const [path, record] of Object.entries(records)) {
        const directory = resolve(modules, path.slice("node_modules/".length));

        if (!path.startsWith("node_modules/") || !inside(modules, directory)) {
            throw new Error("Installed lockfile contains an invalid package path.");
        }

        const expected = lock.packages[path];
        const actual: Package = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));

        if (
            expected === undefined ||
            record.version !== expected.version ||
            record.integrity !== expected.integrity ||
            actual.version !== expected.version
        ) {
            throw new Error(`Installed package does not match the lockfile: ${path}`);
        }
    }

    const requirePackage = (name: string, from = "") => {
        // Resolve the locked location first: a missing nested version must not borrow an ancestor.
        let parent = from;

        while (true) {
            const path = `${parent === "" ? "" : `${parent}/`}node_modules/${name}`;

            if (lock.packages[path] !== undefined) {
                if (records[path] === undefined) {
                    throw new Error(
                        `Missing installed dependency: ${name} (from ${from || "root"}, locked at ${path})`,
                    );
                }

                return;
            }

            const boundary = parent.lastIndexOf("/node_modules/");

            if (boundary === -1) {
                if (parent === "") {
                    throw new Error(
                        `Missing installed dependency: ${name} (from ${from || "root"})`,
                    );
                }

                parent = "";
            } else {
                parent = parent.slice(0, boundary);
            }
        }
    };

    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
        requirePackage(name);
    }

    for (const path of Object.keys(records)) {
        for (const name of Object.keys(lock.packages[path]?.dependencies ?? {})) {
            if (lock.packages[path]?.optionalDependencies?.[name] === undefined) {
                requirePackage(name, path);
            }
        }
    }

    return Object.keys(records).length;
}

/** Byte/mode snapshot also rejects escaping symlinks, special files and unexpectedly large trees. */
async function snapshot(root: string, signal?: AbortSignal): Promise<string> {
    if (!(await lstat(root)).isDirectory()) {
        throw new Error("node_modules must be a directory, not a dependency symlink.");
    }

    const hash = createHash("sha256");
    let bytes = 0;
    let entries = 0;

    const walk = async (path: string): Promise<void> => {
        signal?.throwIfAborted();
        const stat = await lstat(path);

        if (++entries > 100_000 || (bytes += stat.isFile() ? stat.size : 0) > 512 * 1024 * 1024) {
            throw new Error("Dependency snapshot exceeds 100,000 entries or 512 MiB.");
        }

        hash.update(
            JSON.stringify([
                relative(root, path),
                stat.mode & 0o777,
                stat.isFile() ? stat.size : null,
            ]),
        );

        if (stat.isSymbolicLink()) {
            const link = await readlink(path);

            if (isAbsolute(link) || !inside(root, await realpath(path))) {
                throw new Error(
                    `Dependency symlink escapes its installation: ${relative(root, path)}`,
                );
            }

            hash.update(link);
        } else if (stat.isDirectory()) {
            for (const name of (await readdir(path)).sort()) {
                await walk(join(path, name));
            }
        } else if (stat.isFile()) {
            hash.update(await readFile(path));
        } else {
            throw new Error(`Unsupported dependency file: ${relative(root, path)}`);
        }
    };

    await walk(root);

    return hash.digest("hex");
}

class CopierUnsettledError extends Error {}

/** Fixed copier, inherited confinement, exact-child signals. Only close permits staging cleanup. */
async function copyDependencies(
    source: string,
    destination: string,
    signal?: AbortSignal,
): Promise<void> {
    if (process.platform !== "darwin" && process.platform !== "linux") {
        throw new Error("Offline dependency copying currently supports macOS and Linux only.");
    }

    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
        const child = spawn("/bin/cp", ["-R", "-P", "-p", source, destination], {
            stdio: "ignore",
        });
        let failure: unknown;
        let closed = false;
        let finished = false;
        let stopping = false;
        let deadline: NodeJS.Timeout | undefined;
        let escalation: NodeJS.Timeout | undefined;
        let settlement: NodeJS.Timeout | undefined;
        const signalFailures: string[] = [];

        const send = (signal: NodeJS.Signals) => {
            // Never signal a PID after Node has observed its exit (or use a process group).
            if (child.exitCode !== null || child.signalCode !== null) {
                return;
            }

            try {
                if (!child.kill(signal)) {
                    signalFailures.push(`${signal} was not delivered`);
                }
            } catch (error) {
                signalFailures.push(`${signal}: ${String(error)}`);
            }
        };

        const release = () => {
            clearTimeout(deadline);
            clearTimeout(escalation);
            clearTimeout(settlement);
            signal?.removeEventListener("abort", cancel);
        };

        const stop = (reason: unknown) => {
            if (stopping || closed || finished) {
                return;
            }

            stopping = true;
            failure ??= reason;
            clearTimeout(deadline);
            escalation = setTimeout(() => {
                send("SIGKILL");
                settlement = setTimeout(() => {
                    finished = true;
                    release();
                    // Ignore stdio means no inherited pipes to keep alive. Unref is NOT a join:
                    // the caller must retain staging and report an uncertain/blocking outcome.
                    child.unref();
                    reject(
                        new CopierUnsettledError(
                            `Dependency copier termination unconfirmed (pid ${child.pid ?? "unavailable"}): no close within 1 second after SIGKILL${signalFailures.length === 0 ? "" : `; ${signalFailures.join("; ")}`}`,
                            { cause: failure },
                        ),
                    );
                }, 1000);
            }, 1000);
            send("SIGTERM");
        };

        const cancel = () => stop(signal?.reason);

        child.on("error", (error) => {
            failure ??= error;
            stop(error);
        });
        child.once("close", (code, exitSignal) => {
            closed = true;
            release();

            if (finished) {
                return;
            }

            finished = true;

            if (signal?.aborted) {
                reject(signal.reason);
            } else if (failure !== undefined) {
                reject(failure);
            } else if (code !== 0) {
                reject(
                    new Error(
                        `Dependency copy failed (code ${code}, signal ${exitSignal}); no retry attempted.`,
                    ),
                );
            } else {
                resolve();
            }
        });
        deadline = setTimeout(
            () =>
                stop(
                    new Error("Dependency copy deadline exceeded (30000 ms); no retry attempted."),
                ),
            30_000,
        );
        signal?.addEventListener("abort", cancel, { once: true });

        if (signal?.aborted) {
            cancel();
        }
    });
}

/** No network, install scripts, hardlinks, overwrite, or source writes. A failed copy never becomes node_modules. */
export async function prepareWorktree(
    source: string,
    target = process.cwd(),
    signal?: AbortSignal,
    progress?: (phase: "copying" | "verifying", staging: string) => void,
): Promise<{ packages: number; digest: string }> {
    signal?.throwIfAborted();
    source = await realpath(source);
    target = await realpath(target);
    const destination = join(target, "node_modules");

    if (source === target || repository(source) !== repository(target)) {
        throw new Error(
            "Choose a different checkout of the same repository as the dependency source.",
        );
    }

    if (!(await absent(destination))) {
        throw new Error(
            "node_modules already exists; nothing was replaced or repaired automatically.",
        );
    }

    const inputs = new Map<string, Buffer>();

    for (const name of ["package.json", "package-lock.json"]) {
        const bytes = await readFile(join(target, name));

        if (!(await readFile(join(source, name))).equals(bytes)) {
            throw new Error(`Dependency source has a different ${name}.`);
        }

        inputs.set(name, bytes);
    }

    const packages = await inspectDependencies(source);
    const modules = join(source, "node_modules");
    const digest = await snapshot(modules, signal);
    const staging = await mkdtemp(join(target, ".coop-dependencies-"));
    let cleanup = true;

    try {
        const copy = join(staging, "node_modules");

        progress?.("copying", staging);
        await copyDependencies(modules, copy, signal);
        progress?.("verifying", staging);

        if ((await snapshot(copy, signal)) !== digest) {
            throw new Error(
                "Dependency source changed while copying; no installation was published.",
            );
        }

        // Validate the copied metadata, not only the donor as it was before the snapshot.
        await inspectInstallation(
            copy,
            JSON.parse(inputs.get("package.json")!.toString("utf8")),
            JSON.parse(inputs.get("package-lock.json")!.toString("utf8")),
        );

        for (const [name, bytes] of inputs) {
            if (
                !(await readFile(join(target, name))).equals(bytes) ||
                !(await readFile(join(source, name))).equals(bytes)
            ) {
                throw new Error(
                    `Dependency input ${name} changed while copying; no installation was published.`,
                );
            }
        }

        // Commit without an await: mkdir exclusively reserves the destination before rename can
        // replace an empty directory. Cancellation is honored up to this synchronous commit point.
        signal?.throwIfAborted();
        mkdirSync(destination, { mode: 0o700 });

        try {
            renameSync(copy, destination);
        } catch (error) {
            try {
                // Never recursively remove a destination another writer may have populated.
                rmdirSync(destination);
            } catch (cleanupError) {
                if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
                    throw new AggregateError(
                        [error, cleanupError],
                        "Dependency publication failed; destination retained for inspection.",
                    );
                }
            }

            throw error;
        }

        return { packages, digest };
    } catch (error) {
        if (error instanceof CopierUnsettledError) {
            cleanup = false;

            throw new Error(
                `${error.message}; staging retained at ${staging}. Inspection required; no safe transfer or retry established.`,
                { cause: error },
            );
        }

        throw error;
    } finally {
        // Only our fresh stage, and only once its exact copier is known to have closed.
        if (cleanup) {
            await rm(staging, { recursive: true, force: true });
        }
    }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const controller = new AbortController();

    const stop = () => {
        controller.abort(new Error("Dependency preparation cancelled; no retry attempted."));
        process.exitCode = 130;
    };

    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);

    try {
        if (process.argv.length !== 4 || process.argv[2] !== "--from") {
            throw new Error("Usage: node scripts/prepare-worktree.ts --from /matching/checkout");
        }

        console.log(
            JSON.stringify(
                await prepareWorktree(
                    process.argv[3]!,
                    process.cwd(),
                    controller.signal,
                    (phase, staging) => {
                        console.log(JSON.stringify({ phase, staging, pid: process.pid }));
                    },
                ),
            ),
        );
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = controller.signal.aborted ? 130 : 1;
    } finally {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
    }
}
