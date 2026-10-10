// Public pool calls against real child pipes; no process-launch, clock or protocol seams in production.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { pathToFileURL } from "node:url";
import { setImmediate as immediate } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { LSPClient } from "@codemirror/lsp-client";
import { HttpError } from "../src/server/errors.ts";
import { LspPool, type LspOpenResult } from "../src/server/lsp.ts";

type Rpc = {
    id?: string | number;
    method?: string;
    result?: any;
    error?: { code: number };
    params?: any;
};

async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
    const deadline = performance.now() + 8000;

    while (!(await predicate())) {
        assert.ok(performance.now() < deadline, "Timed out waiting for the LSP peer");
        await immediate();
    }
}

async function fixture(t: TestContext, mode = "normal") {
    const base = await mkdtemp(join(tmpdir(), "pi-lsp-test-"));
    const bin = join(base, "bin");
    const roots = [join(base, "project-a"), join(base, "project-b")];
    const pool = new LspPool();
    const oldPath = process.env.PATH;

    t.after(async () => {
        t.mock.timers.reset();
        pool.close();

        if (oldPath === undefined) {
            delete process.env.PATH;
        } else {
            process.env.PATH = oldPath;
        }

        await rm(base, { recursive: true, force: true });
    });
    await mkdir(bin);
    await writeFile(join(bin, "package.json"), '{"type":"module"}');
    await writeFile(
        join(bin, "pyright-langserver"),
        `#!${process.execPath}\nimport ${JSON.stringify(new URL("./lsp-fixture.mjs", import.meta.url).href)};\n`,
        { mode: 0o755 },
    );
    process.env.PATH = bin;

    for (const root of roots) {
        await mkdir(root);
        await writeFile(join(root, "fixture-mode"), mode);
        await writeFile(join(root, "a.py"), "on disk A");
        await writeFile(join(root, "b.py"), "on disk B");
    }

    const trace = async (root = roots[0]!) => {
        try {
            return (await readFile(join(root, "lsp-trace.jsonl"), "utf8"))
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line));
        } catch {
            return [];
        }
    };

    return { base, bin, roots, pool, trace };
}

function ready(result: LspOpenResult): LspOpenResult & { session: string } {
    assert.equal(result.status, "ready");
    assert.ok(result.session);

    return { ...result, session: result.session };
}

function send(
    pool: LspPool,
    session: string,
    method: string,
    params: unknown = {},
    id?: string | number,
): Rpc[] {
    return pool
        .send(
            session,
            JSON.stringify({ jsonrpc: "2.0", method, params, ...(id === undefined ? {} : { id }) }),
        )
        .map((message) => JSON.parse(message));
}

function initialize(pool: LspPool, opened: LspOpenResult & { session: string }, text: string): Rpc {
    const response = send(
        pool,
        opened.session,
        "initialize",
        {
            processId: 123456,
            rootUri: "file:///not-the-project",
            initializationOptions: { command: "never-run" },
            capabilities: {},
        },
        "init",
    ).find((message) => message.id === "init");

    assert.ok(response?.result, "Browser initialize must return the cached result immediately");
    send(pool, opened.session, "initialized");
    send(pool, opened.session, "textDocument/didOpen", {
        textDocument: { uri: opened.uri, languageId: opened.languageId, version: 0, text },
    });

    return response;
}

async function reply(pool: LspPool, session: string, id: string | number): Promise<Rpc> {
    let result: Rpc | undefined;

    await until(() => {
        result = pool
            .poll(session)
            .map((message) => JSON.parse(message))
            .find((message) => message.id === id);

        return !!result;
    });

    return result!;
}

function gone(error: unknown): boolean {
    return error instanceof HttpError && error.status === 410;
}

// The synthetic peer cannot prove native executable discovery/flags, actual TS features,
// diagnostic pull-to-push compatibility, or the official client's initialization handshake.
test("native TypeScript 7 serves unsaved edits through the official CodeMirror client without writing files", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pi-native-lsp-"));
    const file = join(root, "a.ts");
    const disk = "const value = 1;\nvalue;\n";
    const text = 'const value = "unsaved";\nvalue;\n';
    const pool = new LspPool();
    let receiver: ((message: string) => void) | undefined;
    let pump: NodeJS.Timeout | undefined;
    const diagnostics: any[] = [];
    const client = new LSPClient({
        timeout: 7000,
        notificationHandlers: {
            "textDocument/publishDiagnostics": (_client, params) => {
                diagnostics.push(params);

                return true;
            },
        },
    });

    t.after(async () => {
        clearInterval(pump);
        client.disconnect();
        pool.close();
        await rm(root, { recursive: true, force: true });
    });
    await writeFile(file, disk);
    const opened = ready(await pool.open(root, file, text));

    client.connect({
        send(message) {
            for (const response of pool.send(opened.session, message)) {
                receiver?.(response);
            }
        },
        subscribe(handler) {
            receiver = handler;
        },
        unsubscribe() {
            receiver = undefined;
        },
    });
    pump = setInterval(() => {
        for (const response of pool.poll(opened.session)) {
            receiver?.(response);
        }
    }, 5);
    await client.initializing;
    client.notification("textDocument/didOpen", {
        textDocument: { uri: opened.uri, languageId: "typescript", version: 0, text },
    });
    const params = { textDocument: { uri: opened.uri }, position: { line: 1, character: 1 } };
    const hover = await client.request<unknown, any>("textDocument/hover", params);

    assert.match(hover.contents.value, /unsaved/);
    client.notification("textDocument/didChange", {
        textDocument: { uri: opened.uri, version: 1 },
        contentChanges: [{ text: "const value = true;\nvalue;\n" }],
    });
    const changed = await client.request<unknown, any>("textDocument/hover", params);

    assert.match(changed.contents.value, /true/);
    const completion = await client.request<unknown, any>("textDocument/completion", {
        textDocument: { uri: opened.uri },
        position: { line: 1, character: 2 },
    });

    assert.ok(
        (Array.isArray(completion) ? completion : completion.items).some(
            (item: any) => item.label === "value",
        ),
    );
    const formatting = await client.request<unknown, any>("textDocument/formatting", {
        textDocument: { uri: opened.uri },
        options: { tabSize: 4, insertSpaces: true },
    });

    assert.ok(Array.isArray(formatting));
    client.notification("textDocument/didChange", {
        textDocument: { uri: opened.uri, version: 2 },
        contentChanges: [{ text: "const value: number = 'wrong';\n" }],
    });
    const report = await client.request<unknown, any>("textDocument/diagnostic", {
        textDocument: { uri: opened.uri },
    });

    assert.ok(report.items.some((item: any) => /not assignable/.test(item.message)));
    await until(() => diagnostics.some((item) => item.version === 2 && item.diagnostics.length));
    assert.equal(await readFile(file, "utf8"), disk);
});

// Trace receipts expose real child initialization and delivery, independently of private maps.
test("canonical roots reuse a server, document leases exclude aliases, and browser IDs and diagnostics stay isolated", async (t) => {
    const f = await fixture(t);
    const root = f.roots[0]!;
    const otherRoot = f.roots[1]!;
    const alias = join(f.base, "alias");

    await symlink(root, alias, "dir");
    const results = await Promise.all([
        f.pool.open(root, "a.py", "unsaved A"),
        f.pool.open(alias, "b.py", "unsaved B"),
        f.pool.open(otherRoot, "a.py", "other project"),
    ]);
    const a = ready(results[0]!);
    const b = ready(results[1]!);
    const other = ready(results[2]!);
    const initA = initialize(f.pool, a, "unsaved A");
    const initB = initialize(f.pool, b, "unsaved B");
    const initOther = initialize(f.pool, other, "other project");

    assert.equal(initA.result.serverInfo.version, initB.result.serverInfo.version);
    assert.notEqual(initA.result.serverInfo.version, initOther.result.serverInfo.version);
    assert.equal((await f.pool.open(alias, "a.py", "divergent")).status, "busy");
    assert.equal(
        (await f.pool.open(f.base, join(root, "a.py"), "nested root divergent")).status,
        "busy",
    );
    send(
        f.pool,
        a.session,
        "textDocument/hover",
        { textDocument: { uri: a.uri }, position: { line: 0, character: 0 } },
        7,
    );
    send(
        f.pool,
        b.session,
        "textDocument/hover",
        { textDocument: { uri: b.uri }, position: { line: 0, character: 1 } },
        7,
    );
    const responses: Rpc[][] = [[], []];

    await until(() => {
        responses[0]!.push(...f.pool.poll(a.session).map((message) => JSON.parse(message)));
        responses[1]!.push(...f.pool.poll(b.session).map((message) => JSON.parse(message)));

        return responses.every(
            (messages) =>
                messages.some((message) => message.id === 7) &&
                messages.some((message) => message.method === "textDocument/publishDiagnostics"),
        );
    });

    for (const [index, expected] of ["unsaved A", "unsaved B"].entries()) {
        assert.equal(
            responses[index]!.find((message) => message.id === 7)!.result.contents.value,
            expected,
        );
        const pushed = responses[index]!.filter((message) => message.method);

        assert.ok(pushed.length);
        assert.ok(
            pushed.every(
                (message) =>
                    message.params.uri === [a, b][index]!.uri &&
                    message.params.version === 0 &&
                    message.params.diagnostics[0].message === expected,
            ),
        );
    }

    assert.equal(
        send(f.pool, a.session, "shutdown", {}, 8).find((message) => message.id === 8)?.result,
        null,
    );
    send(f.pool, a.session, "exit");
    send(
        f.pool,
        b.session,
        "textDocument/hover",
        { textDocument: { uri: b.uri }, position: { line: 0, character: 1 } },
        9,
    );
    assert.equal((await reply(f.pool, b.session, 9)).result.contents.value, "unsaved B");
    const reopened = ready(await f.pool.open(alias, "a.py", "reopened"));

    assert.equal(
        initialize(f.pool, reopened, "reopened").result.serverInfo.version,
        initA.result.serverInfo.version,
    );
    await until(async () => (await f.trace()).some((event) => event.event === "applyEditReply"));
    const trace = await f.trace();
    const initializations = trace.filter((event) => event.event === "initialize");

    assert.equal(initializations.length, 1);
    assert.equal(initializations[0].params.rootUri, a.rootUri);
    assert.equal(initializations[0].params.processId, process.pid);
    assert.equal(trace.filter((event) => event.event === "initialized").length, 1);
    assert.equal(
        trace.filter((event) => event.event === "didOpen" && event.document.uri === a.uri).length,
        2,
    );
    assert.ok(!trace.some((event) => event.method === "shutdown" || event.method === "exit"));
    assert.equal(trace.find((event) => event.event === "applyEditReply").result.applied, false);
    assert.equal(await readFile(join(root, "a.py"), "utf8"), "on disk A");
});

test("safe requests and notifications cannot target another document or execute commands", async (t) => {
    const f = await fixture(t);
    const opened = ready(await f.pool.open(f.roots[0]!, "a.py", "owned"));

    initialize(f.pool, opened, "owned");
    const alien = new URL("b.py", opened.uri).href;

    for (const [index, method] of [
        "workspace/executeCommand",
        "workspace/applyEdit",
        "textDocument/rename",
        "textDocument/codeAction",
        "completionItem/resolve",
    ].entries()) {
        assert.equal(
            send(
                f.pool,
                opened.session,
                method,
                { textDocument: { uri: opened.uri }, command: "touch something" },
                index,
            ).find((message) => message.id === index)?.error?.code,
            -32601,
        );
    }

    for (const params of [
        { textDocument: { uri: alien } },
        { textDocument: { uri: opened.uri }, nested: { uri: alien } },
    ]) {
        assert.equal(
            send(f.pool, opened.session, "textDocument/hover", params, "wrong-uri").find(
                (message) => message.id === "wrong-uri",
            )?.error?.code,
            -32602,
        );
    }

    for (const method of [
        "textDocument/didOpen",
        "textDocument/didChange",
        "textDocument/didClose",
        "textDocument/didSave",
        "workspace/didChangeConfiguration",
    ]) {
        assert.throws(
            () =>
                send(f.pool, opened.session, method, {
                    textDocument: { uri: alien },
                    settings: { command: "bad" },
                }),
            (error) => error instanceof HttpError && error.status === 400,
        );
    }

    for (const contentChanges of [
        [],
        [{ text: "a" }, { text: "b" }],
        [{ rangeLength: 1, text: "x" }],
        [
            {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
                text: "x",
            },
        ],
        [
            {
                range: { start: { line: 100, character: 0 }, end: { line: 100, character: 1 } },
                text: "x",
            },
        ],
    ]) {
        assert.throws(
            () =>
                send(f.pool, opened.session, "textDocument/didChange", {
                    textDocument: { uri: opened.uri, version: 1 },
                    contentChanges,
                }),
            (error) =>
                error instanceof HttpError &&
                error.status === 400 &&
                /full-document/.test(error.message),
        );
    }

    send(f.pool, opened.session, "textDocument/didChange", {
        textDocument: { uri: opened.uri, version: 1 },
        contentChanges: [{ text: "safe snapshot" }],
    });
    send(
        f.pool,
        opened.session,
        "textDocument/hover",
        { textDocument: { uri: opened.uri }, position: { line: 0, character: 1 } },
        "valid",
    );
    assert.equal(
        (await reply(f.pool, opened.session, "valid")).result.contents.value,
        "safe snapshot",
    );
    const trace = await f.trace();

    assert.equal(trace.filter((event) => event.event === "hover").length, 1);
    assert.ok(
        !trace.some(
            (event) =>
                event.method === "workspace/executeCommand" ||
                event.method === "workspace/didChangeConfiguration",
        ),
    );
});

test("unsupported, absent and outside-root servers degrade locally and project PATH binaries are never run", async (t) => {
    const f = await fixture(t);
    const root = f.roots[0]!;

    await writeFile(join(root, "a.md"), "markdown");
    assert.equal((await f.pool.open(root, "a.md", "markdown")).status, "unavailable");
    assert.equal(
        (await f.pool.open(root, join(f.roots[1]!, "a.py"), "outside")).status,
        "unavailable",
    );
    await symlink(join(f.roots[1]!, "a.py"), join(root, "outside.py"));
    assert.equal((await f.pool.open(root, "outside.py", "outside symlink")).status, "unavailable");
    const projectBin = join(root, "bin");

    await mkdir(projectBin);
    await writeFile(
        join(projectBin, "pyright-langserver"),
        `#!${process.execPath}\nthrow new Error('project binary must not run');\n`,
        { mode: 0o755 },
    );
    process.env.PATH = [".", projectBin].join(delimiter);
    assert.equal((await f.pool.open(root, "a.py", "no trusted executable")).status, "unavailable");
    assert.equal((await f.trace()).length, 0);
    process.env.PATH = [projectBin, f.bin].join(delimiter);
    const opened = ready(await f.pool.open(root, "a.py", "available"));

    assert.ok(initialize(f.pool, opened, "available").result);
    assert.equal(opened.rootUri, new URL(`file://${await realpath(root)}`).href);
});

// Status is a production snapshot, not a second discovery/lifecycle mechanism. Real peers prove
// that inspecting an idle process neither launches another child nor renews its recycling deadline.
test("server status names owned processes, counts document leases and retains idle servers without renewing them", async (t) => {
    const f = await fixture(t);
    const root = f.roots[0]!;

    assert.deepEqual(f.pool.status(), []);
    assert.deepEqual(await f.trace(), []);
    const a = ready(await f.pool.open(root, "a.py", "a"));
    const b = ready(await f.pool.open(root, "b.py", "b"));
    const running = f.pool.status();
    const server = running[0]!;
    const canonicalRoot = await realpath(root);
    const pid = (await f.trace()).find((event) => event.event === "start").pid;

    assert.equal(running.length, 1);
    assert.equal(typeof server.id, "string");
    assert.notEqual(server.id, String(pid), "Status exposes an opaque ID, not an OS process ID");
    assert.ok(!Object.values(server).includes(pid));
    assert.equal(server.name, "Python (pyright-langserver)");
    assert.equal(server.root, canonicalRoot);
    assert.equal(server.rootUri, pathToFileURL(canonicalRoot).href);
    assert.equal(server.status, "running");
    assert.equal(server.documents, 2);
    f.pool.close(a.session);
    assert.equal(f.pool.status()[0]!.documents, 1);
    f.pool.close(b.session);
    assert.equal(server.documents, 2, "Earlier snapshots do not change with the pool");
    const idle = f.pool.status()[0]!;
    const now = Date.now();

    assert.equal(idle.id, server.id);
    assert.equal(idle.status, "idle");
    assert.equal(idle.documents, 0);
    t.mock.timers.enable({ apis: ["Date"], now });
    t.mock.timers.setTime(now + 179_000);
    assert.equal(f.pool.status()[0]!.id, server.id);
    t.mock.timers.setTime(now + 181_000);
    assert.equal(f.pool.status()[0]!.status, "idle", "Inspection does not trigger cleanup");
    const reopened = ready(await f.pool.open(root, "a.py", "recycled"));
    const recycled = f.pool.status()[0]!;

    assert.notEqual(recycled.id, server.id, "Inspection did not extend the original idle deadline");
    assert.equal(recycled.status, "running");
    assert.equal(recycled.documents, 1);
    assert.equal((await f.trace()).filter((event) => event.event === "start").length, 2);
    assert.doesNotThrow(() => f.pool.poll(reopened.session));
    f.pool.close();
    assert.deepEqual(f.pool.status(), []);
});

test("heartbeats renew only live leases, expired documents reopen, and idle servers recycle", async (t) => {
    const f = await fixture(t);
    const a = ready(await f.pool.open(f.roots[0]!, "a.py", "a"));
    const b = ready(await f.pool.open(f.roots[0]!, "b.py", "b"));
    const pid = initialize(f.pool, a, "a").result.serverInfo.version;
    const now = Date.now();

    initialize(f.pool, b, "b");
    t.mock.timers.enable({ apis: ["Date"], now });
    t.mock.timers.setTime(now + 119_000);
    assert.equal(f.pool.status()[0]!.documents, 2);
    f.pool.poll(a.session);
    t.mock.timers.setTime(now + 121_000);
    assert.throws(() => f.pool.poll(b.session), gone);
    assert.doesNotThrow(() => f.pool.poll(a.session));
    const replacement = ready(await f.pool.open(f.roots[0]!, "b.py", "replacement"));

    assert.equal(initialize(f.pool, replacement, "replacement").result.serverInfo.version, pid);
    f.pool.close(a.session);
    f.pool.close(replacement.session);
    t.mock.timers.setTime(now + 302_000);
    const recycled = ready(await f.pool.open(f.roots[0]!, "a.py", "recycled"));

    assert.notEqual(initialize(f.pool, recycled, "recycled").result.serverInfo.version, pid);
    f.pool.close();
    assert.throws(() => f.pool.poll(recycled.session), gone);
});

test("initialization failures and crashes invalidate leases and allow fresh child processes", async (t) => {
    for (const mode of ["crash-initialize", "crash-hover"]) {
        await t.test(mode, async (t) => {
            const f = await fixture(t, mode);
            const root = f.roots[0]!;
            const first = await f.pool.open(root, "a.py", "a");

            if (mode === "crash-initialize") {
                assert.equal(first.status, "unavailable");
                assert.deepEqual(f.pool.status(), []);
            } else {
                const a = ready(first);
                const b = ready(await f.pool.open(root, "b.py", "b"));

                initialize(f.pool, a, "a");
                initialize(f.pool, b, "b");
                send(
                    f.pool,
                    a.session,
                    "textDocument/hover",
                    { textDocument: { uri: a.uri }, position: { line: 0, character: 0 } },
                    1,
                );
                await until(() => {
                    try {
                        f.pool.poll(a.session);
                    } catch (error) {
                        return gone(error);
                    }

                    return false;
                });
                assert.throws(() => f.pool.poll(b.session), gone);
                assert.deepEqual(f.pool.status(), []);
            }

            await writeFile(join(root, "fixture-mode"), "normal");
            const reopened = ready(await f.pool.open(root, "a.py", "fresh"));

            initialize(f.pool, reopened, "fresh");
            send(
                f.pool,
                reopened.session,
                "textDocument/hover",
                { textDocument: { uri: reopened.uri }, position: { line: 0, character: 1 } },
                2,
            );
            assert.equal((await reply(f.pool, reopened.session, 2)).result.contents.value, "fresh");
            assert.equal((await f.trace()).filter((event) => event.event === "start").length, 2);
        });
    }
});

test("hung initialization and requests terminate their owned child on timeout", async (t) => {
    for (const mode of ["hang-initialize", "hang-hover"]) {
        await t.test(mode, async (t) => {
            const f = await fixture(t, mode);

            t.mock.timers.enable({ apis: ["setTimeout"] });
            const opening = f.pool.open(f.roots[0]!, "a.py", "a");

            if (mode === "hang-initialize") {
                await until(async () =>
                    (await f.trace()).some((event) => event.event === "initialize"),
                );
                const starting = f.pool.status();

                assert.equal(starting.length, 1);
                assert.equal(starting[0]!.status, "starting");
                assert.equal(starting[0]!.documents, 1);
                t.mock.timers.tick(12_001);
                assert.equal((await opening).status, "unavailable");
                assert.deepEqual(f.pool.status(), []);
                assert.equal(starting[0]!.status, "starting");
            } else {
                const opened = ready(await opening);

                initialize(f.pool, opened, "a");
                send(
                    f.pool,
                    opened.session,
                    "textDocument/hover",
                    { textDocument: { uri: opened.uri }, position: { line: 0, character: 0 } },
                    1,
                );
                await until(async () => (await f.trace()).some((event) => event.event === "hover"));
                t.mock.timers.tick(20_001);
                assert.throws(() => f.pool.poll(opened.session), gone);
            }

            t.mock.timers.reset();
            const pid = (await f.trace()).find((event) => event.event === "start").pid;

            await until(() => {
                try {
                    process.kill(pid, 0);

                    return false;
                } catch {
                    return true;
                }
            });
        });
    }
});

test("request and outbound bounds refuse overload instead of retaining unlimited work", async (t) => {
    await t.test("inflight", async (t) => {
        const f = await fixture(t, "hang-hover");
        const opened = ready(await f.pool.open(f.roots[0]!, "a.py", "a"));

        initialize(f.pool, opened, "a");

        for (let id = 0; id < 16; id++) {
            send(
                f.pool,
                opened.session,
                "textDocument/hover",
                { textDocument: { uri: opened.uri }, position: { line: 0, character: 0 } },
                id,
            );
        }

        assert.equal(
            send(
                f.pool,
                opened.session,
                "textDocument/hover",
                { textDocument: { uri: opened.uri }, position: { line: 0, character: 0 } },
                16,
            ).find((message) => message.id === 16)?.error?.code,
            -32000,
        );
        assert.throws(
            () => f.pool.send(opened.session, " ".repeat(1024 * 1024 + 1)),
            (error) => error instanceof HttpError && error.status === 413,
        );
    });
    await t.test("output", async (t) => {
        const f = await fixture(t, "flood");
        const opened = ready(await f.pool.open(f.roots[0]!, "a.py", "a"));

        initialize(f.pool, opened, "a");
        await until(async () => (await f.trace()).some((event) => event.event === "didClose"));
        assert.throws(() => f.pool.poll(opened.session), gone);
        assert.equal((await f.pool.open(f.roots[0]!, "a.py", "new lease")).status, "ready");
    });
});

test("session and project process limits refuse excess leases and reclaim only idle servers", async (t) => {
    await t.test("sessions", async (t) => {
        const f = await fixture(t);
        const root = f.roots[0]!;
        const opened: (LspOpenResult & { session: string })[] = [];

        for (let index = 0; index < 33; index++) {
            await writeFile(join(root, `${index}.py`), "disk");
        }

        for (let index = 0; index < 32; index++) {
            opened.push(ready(await f.pool.open(root, `${index}.py`, "unsaved")));
        }

        assert.equal((await f.pool.open(root, "32.py", "excess")).status, "busy");
        f.pool.close(opened[0]!.session);
        assert.equal((await f.pool.open(root, "32.py", "replacement")).status, "ready");
        assert.doesNotThrow(() => f.pool.poll(opened[1]!.session));
    });
    await t.test("servers", async (t) => {
        const f = await fixture(t);
        const opened: (LspOpenResult & { session: string })[] = [];
        const roots: string[] = [];

        for (let index = 0; index < 9; index++) {
            const root = join(f.base, `bounded-${index}`);

            await mkdir(root);
            await writeFile(join(root, "a.py"), "disk");
            roots.push(root);

            if (index < 8) {
                opened.push(ready(await f.pool.open(root, "a.py", "unsaved")));
            }
        }

        assert.equal((await f.pool.open(roots[8]!, "a.py", "excess")).status, "busy");
        f.pool.close(opened[0]!.session);
        assert.equal((await f.pool.open(roots[8]!, "a.py", "replacement")).status, "ready");
        assert.doesNotThrow(() => f.pool.poll(opened[1]!.session));
    });
});
