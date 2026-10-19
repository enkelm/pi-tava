// Public handoff/fingerprint behavior using an isolated remote namespace, not real SSH or native seatbelt.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import {
    mkdtemp,
    mkdir,
    readlink,
    lstat,
    writeFile,
    chmod,
    symlink,
    unlink,
    rm,
    truncate,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { mock, test } from "node:test";
import type { Context } from "@earendil-works/chord";
import {
    err,
    ok,
    FileError,
    ExecutionError,
    type Result,
    type FileInfo,
    type ShellExecOptions,
    type ShellExecResult,
} from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { SessionsDoc } from "../src/server/docs.ts";
import { SshExecutionEnv } from "../src/server/ssh-env.ts";
import { withWorkflowPublicationLock } from "../src/server/workflow-policy.ts";
import { context, executeHandoff, openApp, owner, scriptedModel, until } from "./helpers.ts";

const run = promisify(execFile);

/** A remote transport fixture maps one virtual namespace to a different disposable filesystem root. */
class RemoteFixture extends SshExecutionEnv {
    readonly local: NodeExecutionEnv;
    readonly physical: string;
    readonly virtual: string;
    badPath?: string;
    fail = false;
    inspections = 0;

    constructor(host: string, virtual: string, physical: string) {
        super({ host, cwd: virtual });
        this.virtual = virtual;
        this.physical = physical;
        this.local = new NodeExecutionEnv({ cwd: physical });
    }

    physicalPath(path: string): string {
        return resolve(this.physical, relative(this.virtual, resolve(this.virtual, path)));
    }

    virtualPath(path: string): string {
        return resolve(this.virtual, relative(this.physical, path));
    }

    override async absolutePath(
        path: string,
        _context: Context,
    ): Promise<Result<string, FileError>> {
        return ok(resolve(this.virtual, path));
    }

    override async canonicalPath(path: string, ctx: Context): Promise<Result<string, FileError>> {
        const result = await this.local.canonicalPath(this.physicalPath(path), ctx);

        return result.ok ? ok(this.virtualPath(result.value)) : result;
    }

    override async openBinaryReader(
        path: string,
        options: { noFollow?: boolean } | undefined,
        ctx: Context,
    ) {
        return this.local.openBinaryReader(this.physicalPath(path), options, ctx);
    }

    override async fileInfo(path: string, ctx: Context) {
        return this.local.fileInfo(this.physicalPath(path), ctx);
    }

    override async lstat(path: string): Promise<Result<FileInfo & { mode: number }, FileError>> {
        try {
            const info = await lstat(this.physicalPath(path));

            return ok({
                path,
                name: path.split("/").at(-1)!,
                mode: info.mode,
                size: info.size,
                mtimeMs: info.mtimeMs,
                kind: info.isSymbolicLink() ? "symlink" : info.isFile() ? "file" : "directory",
            });
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;

            return err(new FileError(code === "ENOENT" ? "not_found" : "unknown", String(error)));
        }
    }

    override async readlink(path: string): Promise<Result<Uint8Array, FileError>> {
        return ok(await readlink(this.physicalPath(path), { encoding: "buffer" }));
    }

    override async exec(): Promise<Result<ShellExecResult, ExecutionError>> {
        throw new Error("Fixture forbids unrestricted remote execution");
    }

    override async execConfined(
        inspection: boolean,
        command: string | readonly string[],
        options: ShellExecOptions | undefined,
        ctx: Context,
    ): Promise<Result<ShellExecResult, ExecutionError>> {
        // This fixture executes trusted read-only Git queries, not a pretend OS sandbox.
        assert.equal(inspection, true);
        assert.ok(Array.isArray(command));
        this.inspections++;

        if (this.fail) {
            return err(
                new ExecutionError("shell_unavailable", "fixture native launch unavailable"),
            );
        }

        const argv = command as readonly string[];
        const result = await run(argv[0]!, argv.slice(1), {
            cwd: this.physicalPath(options?.cwd ?? this.virtual),
            encoding: "buffer",
            maxBuffer: 48 * 1024 * 1024,
            env: {
                ...process.env,
                ...options?.env,
                GIT_CONFIG_SYSTEM: "/dev/null",
                GIT_CONFIG_GLOBAL: "/dev/null",
                GIT_TERMINAL_PROMPT: "0",
                HOME: this.physical,
            },
        });
        let bytes = Buffer.from(result.stdout.toString("utf8").replace(/\s/g, ""), "base64");

        if (argv.at(-1)!.includes("'--show-toplevel'")) {
            bytes = Buffer.from(this.virtualPath(bytes.toString("utf8").replace(/\n$/, "")) + "\n");
        }

        if (this.badPath !== undefined && argv.at(-1)!.includes("'--cached'")) {
            bytes = Buffer.from(this.badPath + "\0");
        }

        options?.onOutput?.(bytes.toString("base64"), ctx, { stream: "stdout" });

        return ok({ exitCode: 0 });
    }
}

test("SSH fingerprints bind the remote namespace and physical bytes; handoffs keep ordinary live ownership gates", async () => {
    const root = await mkdtemp(join(tmpdir(), "coop-remote-handoff-"));
    const physical = join(root, "remote");
    const virtual = join(root, "local-namesake");

    await mkdir(physical);
    await mkdir(virtual);
    await writeFile(join(physical, "code.txt"), "remote A\n");
    await writeFile(join(virtual, "code.txt"), "host private sentinel\n");
    const git = (...args: string[]) =>
        execFileSync("git", args, {
            cwd: physical,
            encoding: "utf8",
            env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
        }).trim();

    git("init", "-q");
    git("add", ".");
    git(
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-qm",
        "baseline",
    );
    const app = await openApp(scriptedModel(), join(root, "app"));
    const patches: { mock: { restore(): void } }[] = [];
    const environments = new Map<string, RemoteFixture>();

    const fixtureEnv = (host: string) => {
        let env = environments.get(host);

        if (env === undefined) {
            env = new RemoteFixture(host, virtual, physical);
            environments.set(host, env);
        }

        return env;
    };

    try {
        const { id } = await app.commands.createSession(owner(app), {
            cwd: virtual,
            threadType: "worker",
        });

        await app.commands.configure(id, owner(app), {
            model: { provider: "faux", modelId: "faux-1" },
        });
        await app.harness.commit(async (tx) => {
            const meta = (await tx.doc(SessionsDoc)).items[String(id)]!;

            meta.location = { kind: "ssh", host: "fixture-a" };
            meta.ownerOnly = true;
        }, context);

        for (const method of [
            "absolutePath",
            "canonicalPath",
            "openBinaryReader",
            "fileInfo",
            "lstat",
            "readlink",
            "execConfined",
        ] as const) {
            patches.push(
                mock.method(
                    SshExecutionEnv.prototype,
                    method,
                    function (this: SshExecutionEnv, ...args: unknown[]) {
                        const env = fixtureEnv(this.host);

                        return Reflect.apply(env[method], env, args);
                    },
                ),
            );
        }

        const fingerprint = () => app.workItems.fingerprint(id, owner(app), context);
        let previous = await fingerprint();

        assert.equal(await fingerprint(), previous);
        await writeFile(join(virtual, "code.txt"), "local changed sentinel\n");
        assert.equal(
            await fingerprint(),
            previous,
            "matching local paths are never fingerprint inputs",
        );

        const changed = async (reason: string) => {
            const next = await fingerprint();

            assert.notEqual(next, previous, reason);
            previous = next;
        };

        await writeFile(join(physical, "code.txt"), "remote B\n");
        await changed("equal-length physical remote bytes change the fingerprint");
        await chmod(join(physical, "code.txt"), 0o755);
        await changed("physical executable mode is bound independently of Git status");
        await symlink(Buffer.from([0x61, 0x80]), join(physical, "link"));
        await changed("raw symlink targets are included without UTF-8 normalization");
        await unlink(join(physical, "link"));
        await symlink(Buffer.from([0x61, 0x81]), join(physical, "link"));
        await changed("equal-size non-UTF-8 symlink targets remain distinct");
        git("add", "code.txt");
        await changed("index contents are bound");
        git(
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "-qm",
            "second",
        );
        await changed("HEAD is bound");
        await app.harness.commit(async (tx) => {
            (await tx.doc(SessionsDoc)).items[String(id)]!.location = {
                kind: "ssh",
                host: "fixture-b",
            };
        }, context);
        await changed("identical paths and files on different SSH identities cannot alias");
        const env = fixtureEnv("fixture-b");

        for (const path of ["../outside", "/absolute", "dir/../file", ".git/config"]) {
            env.badPath = path;
            await assert.rejects(fingerprint(), /Cannot fingerprint this checkout safely/);
        }

        await mkdir(join(root, "outside"));
        await writeFile(join(root, "outside", "secret"), "outside must not be read");
        await symlink(join(root, "outside"), join(physical, "escape"));
        env.badPath = "escape/secret";
        await assert.rejects(fingerprint(), /Cannot fingerprint this checkout safely/);
        env.badPath = Array.from({ length: 50_001 }, (_, at) => `file-${at}`).join("\0");
        await assert.rejects(fingerprint(), /Cannot fingerprint this checkout safely/);
        env.badPath = undefined;
        await unlink(join(physical, "escape"));
        await writeFile(join(physical, "oversized"), "");
        await truncate(join(physical, "oversized"), 64 * 1024 * 1024 + 1);
        await assert.rejects(fingerprint(), /Cannot fingerprint this checkout safely/);
        await unlink(join(physical, "oversized"));
        const module = join(physical, "module");

        await mkdir(module);
        const moduleGit = (...args: string[]) =>
            execFileSync("git", args, {
                cwd: module,
                encoding: "utf8",
                env: {
                    ...process.env,
                    GIT_CONFIG_GLOBAL: "/dev/null",
                    GIT_CONFIG_SYSTEM: "/dev/null",
                },
            }).trim();

        moduleGit("init", "-q");
        await writeFile(join(module, "tracked.txt"), "clean\n");
        moduleGit("add", ".");
        moduleGit(
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "-qm",
            "module",
        );
        await writeFile(
            join(physical, ".gitmodules"),
            '[submodule "module"]\n\tpath = module\n\turl = https://fixture.invalid/module\n',
        );
        git(
            "update-index",
            "--add",
            "--cacheinfo",
            `160000,${moduleGit("rev-parse", "HEAD")},module`,
        );
        git("config", "submodule.module.active", "true");
        await fingerprint();
        await writeFile(join(module, "tracked.txt"), "dirty\n");
        await assert.rejects(fingerprint(), /Cannot fingerprint this checkout safely/);
        git("update-index", "--force-remove", "module");
        await rm(module, { recursive: true, force: true });
        await unlink(join(physical, ".gitmodules"));
        env.fail = true;
        await assert.rejects(fingerprint(), /Cannot fingerprint this checkout safely/);
        env.fail = false;
        await assert.rejects(
            app.workItems.fingerprint(id, { ...owner(app), tokenHash: "stale" }),
            /authorized requester/,
        );
        const list = await app.workItems.list(id, owner(app));

        assert.ok(
            list.options.some((option) => option.targetType === "researcher" && option.enabled),
        );
        await withWorkflowPublicationLock(app, id, async () => {
            const busy = await app.workItems.list(id, owner(app));

            assert.ok(busy.options.every((option) => !option.enabled));
        });
        const successor = await executeHandoff(app, id, "researcher");

        await until(
            () => !app.isBusy(successor.id as typeof id),
            "remote successor delivery settles",
        );
        assert.deepEqual(app.locationOf(successor.id as typeof id), {
            kind: "ssh",
            host: "fixture-b",
        });
        assert.equal(app.workItems.isReadOnly(id), true);
        await assert.rejects(
            executeHandoff(app, id, "researcher"),
            /read-only|active|writer|Continue/i,
        );
    } finally {
        for (const patch of patches.reverse()) {
            patch.mock.restore();
        }

        await app.close();
        await rm(root, { recursive: true, force: true });
    }
});
