// Synthetic Herdr/process records and generated journals only. No real Herdr or process signals.
import { cleanUp, context, openApp, owner, root, scriptedModel, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, utimesSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { herdrRequest, isPiArgv, parseProcesses } from "../src/server/pi-sessions/herdr.ts";
import { fakeHerdr } from "./active-import-fixture.ts";
import { importFixture } from "./import-fixtures.ts";

after(cleanUp);

const request = (
    preview: Awaited<
        ReturnType<Awaited<ReturnType<typeof openApp>>["piSessions"]["active"]["preview"]>
    >,
) => ({
    id: preview.activeId,
    sha256: preview.sha256,
    leafId: preview.leafId,
    model: "faux/faux-vision",
    thinkingLevel: "off",
    acknowledged: true,
});

async function fixture(name: string) {
    const folder = join(work, name);

    mkdirSync(folder);
    const source = importFixture(folder);
    const model = scriptedModel();
    const data = join(root, `data-${name}`);
    const app = await openApp(model, data);
    const herdr = fakeHerdr(app, source.path);
    const requests: string[] = [];
    const syntheticRequest = herdr.local.request;

    herdr.local.request = <T>(socket: string, method: string, params?: Record<string, unknown>) => {
        requests.push(method);

        return syntheticRequest<T>(socket, method, params);
    };

    return { source, app, model, data, requests, ...herdr };
}

function assertReadOnly(requests: string[]): void {
    assert.ok(requests.length > 0, "the operation actually inspected the synthetic source");
    assert.deepEqual([...new Set(requests)].sort(), ["pane.process_info", "session.snapshot"]);
}

for (const status of ["idle", "working", "blocked"]) {
    test(`${status} Pi copies its saved snapshot without control requests, source writes or historical execution`, async () => {
        const { source, app, model, state, requests } = await fixture(`copy-${status}`);

        state.status = status;
        const before = structuredClone(state.table);

        try {
            const list = await app.piSessions.active.list(owner(app));

            assert.equal(list.sessions.length, 1);
            assert.equal(list.sessions[0]!.reason, undefined);
            assert.equal(list.sessions[0]!.running, status !== "idle");
            assert.doesNotMatch(JSON.stringify(list), /73002|herdr\.sock/);
            assert.equal(JSON.stringify(list).includes(source.path), false);
            const preview = await app.piSessions.active.preview(owner(app), {
                id: list.sessions[0]!.id,
            });

            assert.equal(preview.running, status !== "idle");
            assert.match(preview.warnings.join(" "), /original.*untouched/i);
            assert.deepEqual(app.sessions(), [], "preview does not publish a conversation");
            const result = await app.piSessions.active.move(owner(app), request(preview));

            assert.equal(await app.piSessions.archive(owner(app), result.id), source.archive);
            assert.equal(readFileSync(source.path, "utf8"), source.archive);
            assert.deepEqual(state.table, before, "the original Pi and shell remain running");
            assert.equal(state.status, status);
            assertReadOnly(requests);
            assert.equal((await app.harness.inspect(context)).tasks.length, 0);
            assert.equal(model.state.callCount, 0);
        } finally {
            await app.close();
        }
    });
}

test("concurrent and reopened copies of the same live snapshot reuse one conversation", async () => {
    const { source, app, state, data, requests } = await fixture("copy-retry");
    let imported: number | undefined;
    let input: ReturnType<typeof request>;

    state.status = "working";

    try {
        const list = await app.piSessions.active.list(owner(app));
        const preview = await app.piSessions.active.preview(owner(app), {
            id: list.sessions[0]!.id,
        });

        input = request(preview);
        const results = await Promise.all([
            app.piSessions.active.move(owner(app), input),
            app.piSessions.active.move(owner(app), input),
        ]);

        assert.equal(results[0].id, results[1].id);
        assert.equal(Number(results[0].existing) + Number(results[1].existing), 1);
        imported = results[0].id;
        assert.equal(app.sessions().length, 1);
        assertReadOnly(requests);
    } finally {
        await app.close();
    }

    const reopened = await openApp(scriptedModel(), data);
    const recovered = fakeHerdr(reopened, source.path);

    recovered.state.status = "working";

    try {
        const retry = await reopened.piSessions.active.move(owner(reopened), input!);

        assert.deepEqual(retry, { id: imported, existing: true });
        assert.equal(reopened.sessions().length, 1);
        assert.deepEqual(recovered.state.table, [recovered.shell, recovered.pi]);
        assert.equal(recovered.state.status, "working");
        assert.equal(readFileSync(source.path, "utf8"), source.archive);
    } finally {
        await reopened.close();
    }
});

for (const condition of ["ancestor", "children", "older-journal"]) {
    test(`a Pi with ${condition} remains selectable because copying does not control its process`, async () => {
        const { app, source, state, pi, local, requests } = await fixture(`discovery-${condition}`);

        if (condition === "ancestor") {
            state.omitArgv = true;
            state.table.push({ ...pi, pid: process.pid, parent: pi.pid, command: "app" });
        } else if (condition === "children") {
            state.table.push({ ...pi, pid: 74000, parent: pi.pid, command: "sleep 100" });
        } else {
            utimesSync(source.path, new Date("2020-01-01"), new Date("2020-01-01"));
        }

        const before = structuredClone(state.table);

        try {
            const listing = await app.piSessions.active.list(owner(app));
            const id = listing.sessions[0]!.id;

            assert.equal(listing.sessions[0]!.reason, undefined);
            assert.equal((await local.find(id)).process!.pid, pi.pid);
            const preview = await app.piSessions.active.preview(owner(app), { id });
            const result = await app.piSessions.active.move(owner(app), request(preview));

            assert.equal(await app.piSessions.archive(owner(app), result.id), source.archive);
            assert.equal(readFileSync(source.path, "utf8"), source.archive);
            assert.deepEqual(state.table, before);
            assertReadOnly(requests);
        } finally {
            await app.close();
        }
    });
}

test("read-only discovery ignores input-control fences while private bridge input remains fenced", async () => {
    const { app, state, local, requests } = await fixture("copy-input-fence");

    try {
        await app.privateSessions.control.admitPrompt("/synthetic/herdr.sock", "pane");
        assert.match((await local.inputReason("/synthetic/herdr.sock", "pane"))!, /uncertain/i);
        await assert.rejects(
            local.withInput("/synthetic/herdr.sock", "pane", async () => {
                assert.fail("private input entered despite unresolved delivery");
            }),
            /uncertain/i,
        );
        await app.privateSessions.markTerminalInput(owner(app), "/synthetic/herdr.sock");
        const listing = await app.piSessions.active.list(owner(app));

        assert.equal(listing.sessions[0]!.reason, undefined);
        const preview = await app.piSessions.active.preview(owner(app), {
            id: listing.sessions[0]!.id,
        });
        const result = await app.piSessions.active.move(owner(app), request(preview));

        assert.ok(result.id);
        assert.deepEqual(
            state.table.map((item) => item.pid),
            [73001, 73002],
        );
        assertReadOnly(requests);
        assert.match((await local.inputReason("/synthetic/herdr.sock", "pane"))!, /uncertain/i);
    } finally {
        await app.close();
    }
});

for (const tail of ["user", "toolResult"] as const) {
    test(`an idle saved ${tail} tail is copied without submitting or replaying it`, async () => {
        const { app, source, model, requests } = await fixture(`copy-tail-${tail}`);

        source.source.appendMessage({
            role: "user",
            content: "SAVED_UNFINISHED_REQUEST",
            timestamp: Date.now(),
        });

        if (tail === "toolResult") {
            source.source.appendMessage({
                ...fauxAssistantMessage(""),
                stopReason: "toolUse",
                content: [
                    {
                        type: "toolCall",
                        id: "saved-call",
                        name: "bash",
                        arguments: { command: "NEVER_EXECUTE" },
                    },
                ],
            });
            source.source.appendMessage({
                role: "toolResult",
                toolCallId: "saved-call",
                toolName: "bash",
                content: [{ type: "text", text: "Saved terminal cancellation" }],
                isError: true,
                timestamp: Date.now(),
            });
        }

        const archive = readFileSync(source.path, "utf8");

        try {
            const listing = await app.piSessions.active.list(owner(app));
            const preview = await app.piSessions.active.preview(owner(app), {
                id: listing.sessions[0]!.id,
            });
            const result = await app.piSessions.active.move(owner(app), request(preview));

            assert.equal(await app.piSessions.archive(owner(app), result.id), archive);
            assert.equal(readFileSync(source.path, "utf8"), archive);
            assert.match(
                JSON.stringify(
                    (await (await app.conversation(result.id)).context(context)).messages,
                ),
                /SAVED_UNFINISHED_REQUEST/,
            );
            assert.equal((await app.harness.inspect(context)).tasks.length, 0);
            assert.equal(model.state.callCount, 0);
            assertReadOnly(requests);
        } finally {
            await app.close();
        }
    });
}

test("foreground identity accepts PID-only Pi but refuses unrelated, ambiguous, other-user and shell records", async () => {
    const { app, state, pi, shell, local } = await fixture("pid-only");

    state.omitArgv = true;

    try {
        const listing = await local.list();

        assert.equal(listing.sessions[0]!.reason, undefined);
        assert.equal((await local.find(listing.sessions[0]!.id)).process!.pid, pi.pid);

        for (const command of [
            "pi-rpc",
            "node unrelated.js",
            "sh -c pi",
            "pi --mode rpc",
            "pi-helper",
        ]) {
            state.table = [shell, { ...pi, command }];
            assert.match((await local.list()).sessions[0]!.reason!, /Cannot identify/, command);
        }

        state.table = [shell, { ...pi, uid: pi.uid + 1 }];
        assert.match((await local.list()).sessions[0]!.reason!, /Cannot identify/);
        state.table = [shell, pi];
        state.foregroundGroup = pi.pid + 1;
        assert.match((await local.list()).sessions[0]!.reason!, /Cannot identify/);
        state.foregroundGroup = pi.pid;
        state.shellPid = pi.pid;
        assert.match((await local.list()).sessions[0]!.reason!, /Cannot identify/);
        state.shellPid = shell.pid;
        state.table = [shell, { ...pi, parent: 98765 }];
        assert.match((await local.list()).sessions[0]!.reason!, /Cannot identify/);
        state.omitArgv = false;
        state.table = [shell, { ...pi, command: "pi-helper" }];
        assert.match((await local.list()).sessions[0]!.reason!, /Cannot identify/);
        state.table = [shell, pi];
        const syntheticRequest = local.request;

        local.request = <T>(socket: string, method: string, params?: Record<string, unknown>) => {
            if (method === "pane.process_info") {
                return Promise.resolve({
                    process_info: {
                        shell_pid: shell.pid,
                        foreground_process_group_id: pi.pid,
                        foreground_processes: [
                            { pid: pi.pid, argv: ["pi"] },
                            { pid: pi.pid + 1, argv: ["pi"] },
                        ],
                    },
                } as T);
            }

            return syntheticRequest<T>(socket, method, params);
        };

        const ambiguous = (await local.list()).sessions[0]!;

        assert.match(ambiguous.reason!, /Cannot identify/);
        await assert.rejects(local.find(ambiguous.id), /Cannot identify/);
    } finally {
        await app.close();
    }
});

test("replaced processes and switched source paths invalidate a discovered identity", async () => {
    const { app, source, state, pi, shell, local } = await fixture("discovery-identity");

    try {
        const id = (await local.list()).sessions[0]!.id;
        const preview = await app.piSessions.active.preview(owner(app), { id });

        for (const replacement of [
            { ...pi, started: "Tue Jan 2 00:00:00 2024" },
            { ...pi, commandHash: "replaced-argv-identity" },
            { ...pi, parent: 98765 },
        ]) {
            state.table = [shell, replacement];
            await assert.rejects(
                app.piSessions.active.move(owner(app), request(preview)),
                /changed or exited/,
            );
        }

        state.table = [shell, pi];
        state.path = `${source.path}.different`;
        await assert.rejects(
            app.piSessions.active.move(owner(app), request(preview)),
            /changed or exited/,
        );
        assert.deepEqual(app.sessions(), []);
        state.path = source.path;
        state.referenceAgent = "claude";
        const invalid = (await local.list()).sessions[0]!;

        assert.match(invalid.reason!, /not reported/);
        await assert.rejects(local.find(invalid.id), /not reported/);
        state.referenceAgent = "pi";
        state.path = work;
        const directory = (await local.list()).sessions[0]!;

        assert.match(directory.reason!, /file is unavailable/);
        await assert.rejects(local.find(directory.id), /file is unavailable/);
    } finally {
        await app.close();
    }
});

test("duplicate source files and incomplete discovery fail closed", async () => {
    const { app, local } = await fixture("discovery-ambiguous");
    const syntheticRequest = local.request;

    local.sockets = async () => ["/synthetic/herdr.sock", "/synthetic/second.sock"];

    try {
        const duplicate = await local.list();

        assert.equal(duplicate.sessions.length, 2);
        assert.ok(duplicate.sessions.every((session) => /duplicate/.test(session.reason!)));
        await assert.rejects(local.find(duplicate.sessions[0]!.id), /duplicate/);

        local.request = <T>(socket: string, method: string, params?: Record<string, unknown>) => {
            if (socket === "/synthetic/second.sock") {
                return Promise.reject(new Error("synthetic socket unavailable"));
            }

            return syntheticRequest<T>(socket, method, params);
        };

        const partial = await local.list();

        assert.equal(partial.sessions.length, 1);
        assert.equal(partial.warnings.length, 1);
        await assert.rejects(local.find(partial.sessions[0]!.id), /discovery warnings/);
    } finally {
        await app.close();
    }
});

test("invalid destinations, absent confirmation and stale previews publish nothing and do not control Pi", async () => {
    const { app, source, state, requests } = await fixture("copy-preflight");
    const before = structuredClone(state.table);

    try {
        const listing = await app.piSessions.active.list(owner(app));
        const preview = await app.piSessions.active.preview(owner(app), {
            id: listing.sessions[0]!.id,
        });
        const input = request(preview);

        await assert.rejects(
            async () => app.piSessions.active.move(owner(app), { ...input, acknowledged: false }),
            /Confirm/i,
        );
        await assert.rejects(
            app.piSessions.active.move(owner(app), { ...input, model: "missing/model" }),
            /available destination/,
        );
        await assert.rejects(
            async () => app.piSessions.active.move(owner(app), { ...input, abortRunning: true }),
            /Aborting.*not supported|only copies/i,
        );
        appendFileSync(source.path, "\n");
        const changed = readFileSync(source.path, "utf8");

        await assert.rejects(
            app.piSessions.active.move(owner(app), input),
            /changed since preview/,
        );
        assert.equal(readFileSync(source.path, "utf8"), changed);
        assert.deepEqual(state.table, before);
        assertReadOnly(requests);
        assert.deepEqual(app.sessions(), []);
        assert.equal((await app.harness.inspect(context)).tasks.length, 0);
    } finally {
        await app.close();
    }
});

test("users without local-session permission are rejected before process or socket access", async () => {
    const { app, local } = await fixture("copy-authorization");
    const guest = app.config.addUser("Guest", "guest").user;
    let accessed = 0;

    const unexpected = async (): Promise<never> => {
        accessed++;

        throw new Error("must not inspect local sources");
    };

    local.processes = unexpected;
    local.sockets = unexpected;
    local.request = unexpected;

    try {
        await assert.rejects(app.piSessions.active.list(guest), { status: 403 });
        await assert.rejects(
            async () => app.piSessions.active.preview(guest, { id: "a".repeat(64) }),
            { status: 403 },
        );
        await assert.rejects(
            async () =>
                app.piSessions.active.move(guest, { id: "a".repeat(64), acknowledged: true }),
            { status: 403 },
        );
        assert.equal(accessed, 0);
        assert.deepEqual(app.sessions(), []);
    } finally {
        await app.close();
    }
});

test("Pi detection and ps parsing distinguish interactive Pi from shells, RPC children and zombies", () => {
    for (const argv of [
        ["/bin/zsh", "pi"],
        ["node", "other.js", "pi"],
        ["pi-rpc"],
        ["pi", "--mode", "rpc"],
        ["pi", "--mode=json"],
        ["pi", "--print", "hello"],
    ]) {
        assert.equal(isPiArgv(argv), false, argv.join(" "));
    }

    assert.equal(isPiArgv(["pi"]), true);
    assert.equal(
        isPiArgv(["node", "/packages/@earendil-works/pi-coding-agent/dist/bundle/cli.js"]),
        true,
    );
    assert.equal(parseProcesses("12 1 501 Z Mon Jan 1 00:00:00 2024 pi").length, 0);
    assert.equal(parseProcesses("garbage").length, 0);
    const parsed = parseProcesses("12 1 501 S Mon Jan  1 00:00:00 2024 pi")[0]!;

    assert.equal(parsed.pid, 12);
    assert.equal(parsed.parent, 1);
    assert.equal(parsed.started, "Mon Jan 1 00:00:00 2024");
    assert.equal(parsed.command, "pi");
});

test("Herdr JSON-line transport handles split replies, error replies and EOF", async () => {
    const path = join(root, "transport.sock");
    let mode = "split";
    const server = createServer((socket) => {
        socket.once("data", (chunk) => {
            const input = JSON.parse(chunk.toString());

            if (mode === "eof") {
                socket.end();
            } else if (mode === "error") {
                socket.end(JSON.stringify({ id: input.id, error: { message: "no" } }) + "\n");
            } else {
                const response = JSON.stringify({ id: input.id, result: { ok: true } }) + "\n";

                socket.write(response.slice(0, 8));
                setImmediate(() => socket.end(response.slice(8)));
            }
        });
    });

    await new Promise<void>((resolve) => server.listen(path, resolve));

    try {
        assert.deepEqual(await herdrRequest(path, "session.snapshot"), { ok: true });
        mode = "error";
        await assert.rejects(herdrRequest(path, "session.snapshot"), /refused/);
        mode = "eof";
        await assert.rejects(herdrRequest(path, "session.snapshot"), /closed/);
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});
