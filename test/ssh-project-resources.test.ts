// Actual App/Commands/config persistence owns this lifecycle. Only SSH transport paths are mapped to files.
// The exact production native reader runs on disposable files; no SSH service or native sandbox is exercised.
import {
    type App,
    cleanUp,
    context,
    modelTexts,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { err, ExecutionError, type ShellExecOptions } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { HttpError } from "../src/server/errors.ts";
import { SshExecutionEnv } from "../src/server/ssh-env.ts";
import { inspectRemoteFileEdit } from "../src/server/remote-file-edits.ts";
import { WorkspaceBackend } from "../src/server/workspace-backend.ts";
import { NamespaceEnv } from "./remote-project-fixture.ts";

test("the owner persists and revokes remote trust across reopen; real slash submission and new-session defaults use remote bytes", async (t) => {
    const namespace = join(await realpath(root), "remote-files");
    const cwd = join(await realpath(root), "namesake");
    const data = join(root, "app-resources");
    const location = { kind: "ssh" as const, host: "fixture-project-resources" };
    const skillPath = join(cwd, ".pi", "skills", "guide", "SKILL.md");
    const model = scriptedModel();
    const native = new NodeExecutionEnv({ cwd: namespace });
    let readerProgram: string | undefined;

    const put = async (path: string, content: string) => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content);
    };

    const backing = (env: SshExecutionEnv) => new NamespaceEnv(namespace, env.id, env.cwd);
    let app: App | undefined;
    let canonicalGate:
        { remaining: number; entered: () => void; released: Promise<void> } | undefined;
    let readGate: { entered: () => void; released: Promise<void> } | undefined;

    // The production factory, target selection, policy wrappers and canonical trust checks still run.
    // Transport methods map real disposable files; no owner key/config, receipt or trust result is supplied.
    t.mock.method(
        SshExecutionEnv.prototype,
        "absolutePath",
        function (this: SshExecutionEnv, path: string) {
            return backing(this).absolutePath(path);
        },
    );
    t.mock.method(
        SshExecutionEnv.prototype,
        "canonicalPath",
        async function (this: SshExecutionEnv, path: string) {
            if (path === cwd && canonicalGate !== undefined) {
                canonicalGate.remaining--;

                if (canonicalGate.remaining === 0) {
                    const gate = canonicalGate;

                    canonicalGate = undefined;
                    gate.entered();
                    await gate.released;
                }
            }

            return backing(this).canonicalPath(path, context);
        },
    );
    t.mock.method(
        SshExecutionEnv.prototype,
        "fileInfo",
        function (this: SshExecutionEnv, path: string) {
            return backing(this).fileInfo(path, context);
        },
    );
    t.mock.method(
        SshExecutionEnv.prototype,
        "openDirReader",
        function (this: SshExecutionEnv, path: string) {
            return backing(this).openDirReader(path, context);
        },
    );
    t.mock.method(
        SshExecutionEnv.prototype,
        "openBinaryReader",
        function (
            this: SshExecutionEnv,
            path: string,
            options: { noFollow?: boolean } | undefined,
        ) {
            return backing(this).openBinaryReader(path, options, context);
        },
    );
    t.mock.method(
        SshExecutionEnv.prototype,
        "exec",
        async function (
            this: SshExecutionEnv,
            command: string | readonly string[],
            options: ShellExecOptions | undefined,
            ctx: typeof context,
        ) {
            if (
                typeof command === "string" ||
                command.length !== 6 ||
                command[0] !== "python3" ||
                command[1] !== "-I" ||
                command[2] !== "-c" ||
                readerProgram === undefined ||
                command[3] !== readerProgram ||
                command[4] !== "inspect"
            ) {
                return err(
                    new ExecutionError(
                        "shell_unavailable",
                        "This resource fixture only executes the fixed native reader",
                    ),
                );
            }

            const request = JSON.parse(command[5]!) as { root: string; file: string };
            const mapped = backing(this);
            let stdout = "";
            const result = await native.exec(
                [
                    ...command.slice(0, 5),
                    JSON.stringify({
                        root: mapped.path(request.root),
                        file: mapped.path(request.file),
                    }),
                ],
                {
                    ...options,
                    onOutput(text, outputContext, info) {
                        if (info.stream === "stdout") {
                            stdout += text;
                        } else {
                            options?.onOutput?.(text, outputContext, info);
                        }
                    },
                },
                ctx,
            );

            if (request.file === skillPath && readGate !== undefined) {
                const gate = readGate;

                readGate = undefined;
                gate.entered();
                await gate.released;
            }

            if (stdout !== "") {
                const response = JSON.parse(stdout) as { ok?: boolean; value?: { path: string } };

                if (response.ok === true && response.value !== undefined) {
                    assert.equal(response.value.path, mapped.path(request.file));
                    response.value.path = request.file;
                }

                options?.onOutput?.(JSON.stringify(response), ctx, { stream: "stdout" });
            }

            return result;
        },
    );

    try {
        await mkdir(join(namespace, "home", "remote"), { recursive: true });
        await mkdir(join(namespace, cwd, ".git"), { recursive: true });
        await put(
            skillPath,
            "---\nname: guide\ndescription: Host namesake\n---\nHOST_PROJECT_TRAP",
        );
        await put(
            join(namespace, skillPath),
            "---\nname: guide\ndescription: Remote guide\n---\nREMOTE_PROJECT_INSTRUCTIONS",
        );
        await put(join(namespace, cwd, ".pi", "prompts", "remote.md"), "Remote template $1");
        await put(
            join(namespace, cwd, ".pi", "settings.json"),
            JSON.stringify({
                defaultProvider: "faux",
                defaultModel: "faux-2",
                defaultThinkingLevel: "off",
            }),
        );
        // Obtain the fixed reader through its production entry point, without exporting or
        // source-grepping the embedded program. Run it once rather than fabricating a snapshot.
        const runNative = native.exec.bind(native);
        const recording = t.mock.method(
            native,
            "exec",
            (
                command: string | readonly string[],
                options: ShellExecOptions | undefined,
                ctx: typeof context,
            ) => {
                assert.notEqual(typeof command, "string");

                if (typeof command !== "string") {
                    assert.deepEqual(command.slice(0, 3), ["python3", "-I", "-c"]);
                    assert.equal(command[4], "inspect");
                    readerProgram = command[3];
                }

                return runNative(command, options, ctx);
            },
        );

        try {
            await inspectRemoteFileEdit({
                backend: new WorkspaceBackend(native, { remote: true, context }),
                root: join(namespace, cwd),
                file: join(namespace, skillPath),
                offline: false,
            });
        } finally {
            recording.mock.restore();
        }

        const transport = new SshExecutionEnv({ host: location.host, cwd });

        for (const command of [
            "printf 'arbitrary shell'",
            ["python3", "-I", "-c", "print('arbitrary Python')", "inspect", "{}"],
            ["python3", "-I", "-c", readerProgram!, "prepare", "{}"],
        ]) {
            const refused = await transport.exec(command, undefined, context);

            assert.equal(
                refused.ok,
                false,
                "the fixture never opens an arbitrary-command or mutating-script escape",
            );
        }

        app = await openApp(model, data);
        app.config.lastModel = { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
        const first = await app.commands.createSession(owner(app), {
            cwd,
            location,
            threadType: "chat",
        });

        assert.equal((await app.agentState(first.id))?.model?.modelId, "faux-1");
        assert.equal((await app.projectTrust(first.id, owner(app))).ask, true);
        assert.deepEqual(await app.skillCommands(first.id, owner(app)), []);
        const guest = app.config.addUser("Guest cannot trust", "guest").user;

        await assert.rejects(
            app.setProjectTrust(first.id, guest, "trust"),
            (error: unknown) => error instanceof HttpError && error.status === 403,
        );
        assert.deepEqual(app.config.remoteProjectTrust, []);
        const opened = app;

        await t.test(
            "rotating the owner's token during the final remote trust lookup rejects the old request without saving a decision",
            async () => {
                let entered!: () => void;
                let release!: () => void;
                const waiting = new Promise<void>((resolve) => {
                    entered = resolve;
                });
                const released = new Promise<void>((resolve) => {
                    release = resolve;
                });

                // The first canonical cwd read is the trust preview; the second is saveTrust's last remote read.
                // No decision may persist, whether the transport fence or final owner check detects rotation first.
                canonicalGate = { remaining: 2, entered, released };
                const changing = opened.setProjectTrust(first.id, owner(opened), "trust");

                await waiting;
                opened.config.rotateOwnerToken();
                release();
                await assert.rejects(
                    changing,
                    (error: unknown) => error instanceof HttpError && error.status === 403,
                );
                assert.deepEqual(opened.config.remoteProjectTrust, []);
            },
        );
        await app.setProjectTrust(first.id, owner(app), "trust");
        assert.deepEqual(app.config.remoteProjectTrust, [
            { filesystem: `ssh:${location.host}`, path: cwd, trusted: true },
        ]);
        await say(app, first.id, "/skill:guide inspect src/auth.ts");
        const messages = (await modelTexts(app, first.id)).join("\n");

        assert.match(messages, /REMOTE_PROJECT_INSTRUCTIONS/);
        assert.doesNotMatch(messages, /HOST_PROJECT_TRAP/);
        await say(app, first.id, "/remote auth.ts");
        assert.match((await modelTexts(app, first.id)).join("\n"), /Remote template auth\.ts/);
        await app.close();
        app = await openApp(model, data);
        assert.equal((await app.projectTrust(first.id, owner(app))).trusted, true);
        const second = await app.commands.createSession(owner(app), {
            cwd,
            location,
            threadType: "chat",
        });

        assert.equal((await app.agentState(second.id))?.model?.modelId, "faux-2");
        await t.test(
            "revoking trust during an opened resource read prevents stale skill admission",
            async () => {
                let entered!: () => void;
                let release!: () => void;
                const waiting = new Promise<void>((resolve) => {
                    entered = resolve;
                });
                const released = new Promise<void>((resolve) => {
                    release = resolve;
                });

                readGate = { entered, released };
                const loading = app!.skillCommands(second.id, owner(app!));

                await waiting;
                await app!.setProjectTrust(first.id, owner(app!), "distrust");
                release();
                await assert.rejects(loading, /trust changed/i);
            },
        );
        assert.deepEqual(await app.skillCommands(first.id, owner(app)), []);
        assert.equal(
            (await app.agentState(second.id))?.model?.modelId,
            "faux-2",
            "revoking resources never reconfigures an existing model",
        );
        await app.close();
        app = await openApp(model, data);
        assert.equal((await app.projectTrust(first.id, owner(app))).trusted, false);
        assert.equal(app.config.remoteProjectTrust[0]?.trusted, false);
        const afterRevoke = await app.commands.createSession(owner(app), {
            cwd,
            location,
            threadType: "chat",
        });

        assert.equal((await app.agentState(afterRevoke.id))?.model?.modelId, "faux-1");
    } finally {
        await app?.close();
        await native.cleanup(context);
        cleanUp();
    }
});
