// Synthetic Herdr replies/process identities only: no CLI, sockets, process table or native app.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { setImmediate as immediate } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import type { PocketApp } from "../src/server/app.ts";
import type { User } from "../src/server/config.ts";
import {
    herdrRequest,
    LocalPiSessions,
    type LocalProcess,
} from "../src/server/pi-sessions/herdr.ts";
import { PrivateSessions } from "../src/server/private-sessions.ts";
import type { HerdrAlertKind } from "../src/server/private-sessions/alerts.ts";

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });

    return { promise, resolve };
}

function fixture(t: TestContext) {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const owner: User = {
        id: "owner",
        name: "Owner",
        role: "owner",
        tokenHash: "credential-one",
        createdAt: 0,
    };
    const users = [owner];
    const local = new LocalPiSessions();
    const pane: Record<string, unknown> = {
        pane_id: "pane-one",
        terminal_id: "terminal-one",
        agent: "pi",
        agent_status: "working",
        label: "PRIVATE_TITLE_MUST_NOT_BE_DELIVERED",
        cwd: "/PRIVATE_PATH_MUST_NOT_BE_READ",
        agent_session: {
            agent: "pi",
            source: "herdr:pi",
            kind: "path",
            value: "/PRIVATE_JOURNAL_MUST_NOT_BE_READ",
        },
    };
    const table: LocalProcess[] = [
        {
            pid: 7001,
            parent: 1,
            uid: process.getuid!(),
            started: "shell-life",
            commandHash: "shell-hash",
            command: "bash",
        },
        {
            pid: 7002,
            parent: 7001,
            uid: process.getuid!(),
            started: "agent-life",
            commandHash: "agent-hash",
            command: "pi",
        },
    ];
    const state = {
        unavailable: false,
        missing: false,
        noProcess: false,
        sockets: ["/synthetic/herdr.sock"],
        sequence: undefined as number | undefined,
        subscribed: true,
        notifications: true,
        beforeRequest: async (_method: string, _signal?: AbortSignal) => {},
    };
    const calls: string[] = [];
    const delivered: { ownerId: string; paneId: string; kind: HerdrAlertKind }[] = [];

    local.sockets = async () => [...state.sockets];
    local.processes = async () => structuredClone(state.noProcess ? table.slice(0, 1) : table);

    local.request = async <T>(
        socket: string,
        method: string,
        _params = {},
        _timeout = 2000,
        signal?: AbortSignal,
    ): Promise<T> => {
        calls.push(method);
        await state.beforeRequest(method, signal);

        if (state.unavailable && socket === state.sockets[0]) {
            throw new Error("synthetic unavailable");
        }

        if (method === "session.snapshot") {
            return {
                snapshot: {
                    boot_id: "daemon-one",
                    workspaces: [],
                    panes: state.missing
                        ? []
                        : [
                              {
                                  ...pane,
                                  ...(state.sequence === undefined
                                      ? {}
                                      : { state_change_seq: state.sequence }),
                              },
                          ],
                },
            } as T;
        }

        assert.equal(
            method,
            "pane.process_info",
            "monitor never reads history/output or sends input",
        );

        return {
            process_info: {
                shell_pid: 7001,
                foreground_process_group_id: 7002,
                foreground_processes: [{ pid: 7002, argv: [table[1]!.command] }],
            },
        } as T;
    };

    const app = {
        config: {
            users,
            userById: (id: string) => users.find((user) => user.id === id),
        },
        piSessions: { active: { local } },
        pushStore: {
            prefs: () => ({ done: state.notifications, approval: state.notifications }),
            subscriptions: () => (state.subscribed ? [{}] : []),
        },
    } as unknown as PocketApp;
    const sessions = new PrivateSessions(app);
    const start = () =>
        sessions.startAlerts(async (ownerId, paneId, kind) => {
            delivered.push({ ownerId, paneId, kind });
        });

    const tick = async () => {
        t.mock.timers.tick(4000);
        await immediate();
    };

    t.after(() => sessions.close());

    return { owner, users, local, pane, table, state, calls, delivered, sessions, start, tick };
}

test("server monitor reports real working completions and new blocked attention once, using the actual private route", async (t) => {
    const f = fixture(t);

    // The list remains the browser route authority; no test-only observation entry point.
    delete f.pane.cwd;
    const tree = await f.sessions.list(f.owner);
    const paneId = tree.instances[0]!.workspaces[0]!.tabs[0]!.panes[0]!.id;

    f.start();
    f.start();
    await immediate();
    assert.deepEqual(f.delivered, [], "startup working state only establishes a baseline");
    f.pane.agent_status = "idle";
    await f.tick();
    await f.tick();
    f.pane.agent_status = "working";
    await f.tick();
    f.pane.agent_status = "done";
    await f.tick();
    f.pane.agent_status = "blocked";
    await f.tick();
    await f.tick();
    f.pane.agent_status = "idle";
    await f.tick();
    assert.deepEqual(f.delivered, [
        { ownerId: "owner", paneId, kind: "done" },
        { ownerId: "owner", paneId, kind: "done" },
        { ownerId: "owner", paneId, kind: "approval" },
    ]);
    assert.match(paneId, /^[a-f0-9]{64}$/);
    assert.ok(
        !JSON.stringify(f.delivered).includes("PRIVATE"),
        "only opaque routing and fixed kind reach Alerts",
    );
    assert.ok(
        f.calls.every((method) => ["session.snapshot", "pane.process_info"].includes(method)),
    );
});

test("startup done/blocked, unknown, disappearance, reconnect and replacement cannot manufacture a completion", async (t) => {
    for (const gap of [
        "unknown",
        "missing-status",
        "missing-agent",
        "missing-terminal",
        "disappeared",
        "unavailable",
        "missing-process",
        "terminal-replaced",
        "process-replaced",
        "session-replaced",
        "agent-replaced",
        "old-sequence",
    ] as const) {
        await t.test(gap, async (t) => {
            const f = fixture(t);

            f.pane.agent_status = "done";
            f.start();
            await immediate();
            f.pane.agent_status = "blocked";
            await f.tick();
            f.delivered.length = 0;
            f.pane.agent_status = "working";
            f.state.sequence = 20;
            await f.tick();

            switch (gap) {
                case "unknown":
                    f.pane.agent_status = "unknown";
                    break;
                case "missing-status":
                    delete f.pane.agent_status;
                    break;
                case "missing-agent":
                    delete f.pane.agent;
                    break;
                case "missing-terminal":
                    delete f.pane.terminal_id;
                    break;
                case "disappeared":
                    f.state.missing = true;
                    break;
                case "unavailable":
                    f.state.unavailable = true;
                    break;
                case "missing-process":
                    f.state.noProcess = true;
                    break;
                case "terminal-replaced":
                    f.pane.terminal_id = "replacement-terminal";
                    break;
                case "process-replaced":
                    f.table[1]!.started = "replacement-process-life";
                    break;
                case "session-replaced":
                    f.pane.agent_session = {
                        agent: "pi",
                        source: "herdr:pi",
                        kind: "path",
                        value: "/replacement-journal",
                    };
                    break;
                case "agent-replaced":
                    f.pane.agent = "codex";
                    f.table[1]!.command = "codex";
                    f.table[1]!.commandHash = "codex-command";
                    break;
                case "old-sequence":
                    f.state.sequence = 3;
                    break;
            }

            // Identity replacements can arrive directly as done, with no intervening unknown row.
            if (gap.endsWith("replaced")) {
                f.pane.agent_status = "done";
            }

            await f.tick();
            f.pane.agent_status = "done";
            f.pane.agent = gap === "agent-replaced" ? "codex" : "pi";
            f.pane.terminal_id ??= "terminal-one";
            f.state.missing = false;
            f.state.unavailable = false;
            f.state.noProcess = false;
            f.state.sequence = 21;
            await f.tick();
            assert.deepEqual(f.delivered, [], "a gap must rebaseline, not finish the former agent");
            f.pane.agent_status = "working";
            f.state.sequence = 22;
            await f.tick();
            f.pane.agent_status = "idle";
            f.state.sequence = 23;
            await f.tick();
            assert.equal(f.delivered.length, 1, "fresh work after recovery can finish normally");
        });
    }
});

test("replacement during observation I/O cannot finish the former process, terminal or session", async (t) => {
    for (const replacement of ["process", "terminal", "session"] as const) {
        await t.test(replacement, async (t) => {
            const f = fixture(t);

            f.start();
            await immediate();
            f.pane.agent_status = "done";

            f.state.beforeRequest = async (method) => {
                if (method === "pane.process_info") {
                    if (replacement === "process") {
                        f.table[1]!.started = "replacement-during-observation";
                    } else if (replacement === "terminal") {
                        f.pane.terminal_id = "replacement-terminal";
                    } else {
                        f.pane.agent_session = {
                            agent: "pi",
                            source: "herdr:pi",
                            kind: "path",
                            value: "/replacement-journal",
                        };
                    }
                }
            };

            await f.tick();
            assert.deepEqual(f.delivered, [], "stale metadata cannot finish the former agent");
            await f.tick();
            assert.deepEqual(f.delivered, [], "replacement must establish a fresh baseline");
            f.pane.agent_status = "working";
            await f.tick();
            f.pane.agent_status = "idle";
            await f.tick();
            assert.equal(f.delivered.length, 1, "fresh work after replacement can finish");
        });
    }
});

test("first blocked observation is quiet and a removed owner prevents all new native reads", async (t) => {
    const f = fixture(t);

    f.pane.agent_status = "blocked";
    f.start();
    await immediate();
    await f.tick();
    assert.deepEqual(f.delivered, []);
    f.users.length = 0;
    const count = f.calls.length;

    await f.tick();
    assert.equal(f.calls.length, count);
    f.users.push(f.owner);
    f.pane.agent_status = "done";
    await f.tick();
    assert.deepEqual(f.delivered, [], "returning owner never gets old states replayed");
});

test("without an eligible push subscription the monitor does no native discovery and re-enabling only baselines", async (t) => {
    const f = fixture(t);
    let discoveries = 0;

    f.local.sockets = async () => {
        discoveries++;

        return [...f.state.sockets];
    };

    f.state.subscribed = false;
    f.start();
    await immediate();
    await f.tick();
    assert.equal(discoveries, 0);
    f.state.subscribed = true;
    f.state.notifications = false;
    await f.tick();
    assert.equal(discoveries, 0, "both relevant preferences off avoids unrelated native reads");
    f.state.notifications = true;
    f.pane.agent_status = "done";
    await f.tick();
    assert.equal(discoveries, 1);
    assert.deepEqual(f.delivered, [], "no completion is inferred from time spent unsubscribed");
});

test("eligibility changes during discovery or snapshots fence later native reads and delivery", async (t) => {
    for (const phase of ["discovery", "snapshot"] as const) {
        for (const change of ["owner", "credential", "subscription", "preferences"] as const) {
            await t.test(`${phase}/${change}`, async (t) => {
                const f = fixture(t);

                f.start();
                await immediate();
                const gate = deferred();
                const reads: string[] = [];
                let entered = false;
                const processes = f.local.processes;
                const sockets = f.local.sockets;

                f.local.processes = async (signal) => {
                    reads.push("processes");

                    return processes(signal);
                };

                f.local.sockets = async (signal) => {
                    if (phase === "discovery") {
                        entered = true;
                        await gate.promise;
                    }

                    return sockets(signal);
                };

                f.state.beforeRequest = async (method) => {
                    reads.push(method);

                    if (phase === "snapshot" && method === "session.snapshot") {
                        entered = true;
                        await gate.promise;
                    }
                };

                f.pane.agent_status = "done";
                t.mock.timers.tick(4000);
                await immediate();
                assert.equal(entered, true);

                if (change === "owner") {
                    f.users.length = 0;
                } else if (change === "credential") {
                    f.owner.tokenHash = "credential-two";
                } else if (change === "subscription") {
                    f.state.subscribed = false;
                } else {
                    f.state.notifications = false;
                }

                const admitted = [...reads];

                gate.resolve();
                await immediate();
                assert.deepEqual(
                    reads,
                    admitted,
                    "revocation cannot admit a subsequent native read",
                );
                assert.deepEqual(f.delivered, [], "the stale observation cannot notify");
            });
        }
    }
});

test("closing cancels and joins outstanding discovery/process/snapshot/pane I/O, not just a wrapper", async (t) => {
    for (const phase of [
        "sockets",
        "processes",
        "session.snapshot",
        "pane.process_info",
    ] as const) {
        await t.test(phase, async (t) => {
            const f = fixture(t);
            const cleanup = deferred();
            let aborted = false;
            let entered = false;

            const io = async (signal?: AbortSignal) => {
                assert.ok(signal);
                entered = true;
                signal.addEventListener(
                    "abort",
                    () => {
                        aborted = true;
                    },
                    { once: true },
                );
                await cleanup.promise;
                signal.throwIfAborted();
            };

            if (phase === "sockets") {
                f.local.sockets = async (signal) => {
                    await io(signal);

                    return [];
                };
            } else if (phase === "processes") {
                f.local.processes = async (signal) => {
                    await io(signal);

                    return [];
                };
            } else {
                f.state.beforeRequest = async (method, signal) => {
                    if (method === phase) {
                        await io(signal);
                    }
                };
            }

            f.start();
            await immediate();
            assert.equal(entered, true);
            let closed = false;
            const closing = f.sessions.close().then(() => {
                closed = true;
            });

            await immediate();
            assert.equal(aborted, true);
            assert.equal(closed, false, "shutdown must wait for actual I/O cleanup after abort");
            cleanup.resolve();
            await closing;
            assert.equal(closed, true);
            assert.deepEqual(f.delivered, []);
            const reads = f.calls.length;

            f.start();
            await f.tick();
            assert.equal(f.calls.length, reads, "closed observers cannot restart or poll later");
        });
    }
});

test("shutdown also cancels and joins a delivery already admitted to Alerts", async (t) => {
    const f = fixture(t);
    const cleanup = deferred();
    let signal: AbortSignal | undefined;

    f.sessions.startAlerts(async (_ownerId, _paneId, _kind, active) => {
        signal = active;
        await cleanup.promise;
    });
    await immediate();
    f.pane.agent_status = "done";
    await f.tick();
    assert.ok(signal);
    let closed = false;
    const closing = f.sessions.close().then(() => {
        closed = true;
    });

    await immediate();
    assert.equal(signal.aborted, true, "delivery receives the same shutdown cancellation");
    assert.equal(closed, false, "admitted delivery cleanup is not detached");
    cleanup.resolve();
    await closing;
    assert.equal(closed, true);
});

test("bounded JSON transport joins socket close on success, abort, timeout and oversized replies", async (t) => {
    class Socket extends EventEmitter {
        destroyed = false;
        writes: string[] = [];
        setEncoding() {
            return this;
        }
        write(text: string) {
            this.writes.push(text);

            return true;
        }
        destroy() {
            this.destroyed = true;

            return this;
        }
    }
    let socket = new Socket();
    const mocked = t.mock.method(net, "createConnection", () => socket as unknown as net.Socket);

    syncBuiltinESMExports();
    t.after(() => {
        mocked.mock.restore();
        syncBuiltinESMExports();
    });
    t.mock.timers.enable({ apis: ["setTimeout"] });

    for (const result of ["success", "abort", "timeout", "oversized"] as const) {
        socket = new Socket();
        const abort = new AbortController();
        let settled = false;
        const request = herdrRequest<{ accepted: boolean }>(
            "/synthetic/herdr.sock",
            "session.snapshot",
            {},
            2000,
            abort.signal,
        );
        const observed = request.then(
            (value) => {
                settled = true;

                return value;
            },
            (error: unknown) => {
                settled = true;

                throw error;
            },
        );
        // Attach a rejection handler before driving cancellation.
        const outcome = observed.then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
        );

        socket.emit("connect");
        const id = JSON.parse(socket.writes[0]!).id;

        if (result === "success") {
            socket.emit("data", JSON.stringify({ id, result: { accepted: true } }) + "\n");
        } else if (result === "abort") {
            abort.abort();
        } else if (result === "timeout") {
            t.mock.timers.tick(2000);
        } else {
            socket.emit("data", "x".repeat(2 * 1024 * 1024 + 1));
        }

        await immediate();
        assert.equal(socket.destroyed, true);
        assert.equal(settled, false, `${result} must join the socket, not settle at destroy()`);
        socket.emit("close");
        const reply = await outcome;

        if (result === "success") {
            assert.deepEqual(reply, { value: { accepted: true } });
        } else {
            assert.ok("error" in reply && reply.error instanceof Error);
        }
    }

    const calls = mocked.mock.callCount();
    const abort = new AbortController();

    abort.abort();
    await assert.rejects(
        herdrRequest("/synthetic/herdr.sock", "session.snapshot", {}, 2000, abort.signal),
    );
    assert.equal(mocked.mock.callCount(), calls, "pre-cancelled reads never open a socket");
});
