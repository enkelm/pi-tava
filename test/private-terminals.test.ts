// Real HTTP/WebSocket and child pipes. The child and Unix socket are synthetic, never a live Herdr client.
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createConnection, createServer as socketServer, type Socket } from "node:net";
import { join } from "node:path";
import { after, test } from "node:test";
import { WebSocket } from "ws";
import { createHandler } from "../src/server/http.ts";
import { PrivateControlDoc } from "../src/server/docs.ts";
import { cleanUp, context, openApp, owner, scriptedModel, until } from "./helpers.ts";
import { fakeHerdr } from "./active-import-fixture.ts";
import { importFixture } from "./import-fixtures.ts";

after(cleanUp);

type Event = { type: string; [key: string]: any };

async function fixture() {
    const directory = mkdtempSync("/tmp/pi-terminal-test-");
    const endpoint = socketServer();

    await new Promise<void>((resolve) =>
        endpoint.listen(join(directory, "herdr-client.sock"), resolve),
    );
    const app = await openApp(scriptedModel());
    const target = {
        socket: join(directory, "herdr.sock"),
        pane: "w1:p1",
        terminal: "terminal-a",
        instanceId: "instance-a",
    };
    let reads = 0;
    let checks = 0;
    let launches = 0;
    let bad = false;
    let waitForSnapshot = false;
    let closedHelpers = 0;
    const helpers: ChildProcessWithoutNullStreams[] = [];
    const inputLog: Event[] = [];
    const { local } = fakeHerdr(app, importFixture(directory).path);
    const request = local.request;

    local.sockets = async () => [target.socket];

    local.request = async <T>(socket: string, method: string, params = {}): Promise<T> => {
        if (method === "pane.read") {
            return { read: { pane_id: target.pane, text: "Synthetic Pi" } } as T;
        }

        if (method === "session.snapshot") {
            const { snapshot } = await request<{
                snapshot: { panes: Record<string, unknown>[]; workspaces: unknown[] };
            }>(socket, method, params);

            return {
                snapshot: {
                    ...snapshot,
                    panes: snapshot.panes.map((pane) => ({
                        ...pane,
                        pane_id: target.pane,
                        terminal_id: target.terminal,
                    })),
                },
            } as T;
        }

        return request<T>(socket, method, params);
    };

    app.privateSessions.terminalTarget = async () => {
        reads++;

        return { ...target };
    };

    app.privateTerminals.checkExecutable = async () => {
        checks++;
    };

    const script = join(directory, "fake-client.mjs");

    writeFileSync(
        script,
        `
        import {createInterface} from 'node:readline';
        const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
        const methods=['pane.focus','pane.focus_direction','pane.zoom','pane.resize','layout.set_split_ratio',
            'tab.focus','workspace.focus','pane.rename','tab.rename','workspace.rename','pane.scroll',
            'pane.selection.read','worktree.list','pane.close','tab.create','command.invoke','client_shell.surface.set'];
        const snapshot = () => {
            send({type:'snapshot',snapshot:{boot_id:'boot-a',revision:'9007199254740993',
                workspaces:[{workspace_id:'w1'}],tabs:[{tab_id:'t1'}],panes:[{pane_id:'w1:p1'}],
                commands:[{command_id:'known-command'}]}});
            send({type:'surface',surface:{boot_id:'boot-a',projection_revision:'9007199254740993',surface_revision:1,
                frame:{width:2,height:1,cells:process.argv.includes('--bad')?[]:[{symbol:'A'},{symbol:'B'}]},popup:null}});
        };
        process.on('message', message => {
            if (message === 'snapshot') snapshot();
            if (message === 'fail') process.exit(1);
        });
        send({type:'connected',welcome:{generation:1,methods}});
        if (!process.argv.includes('--wait-snapshot')) snapshot();
        const reader=createInterface({input:process.stdin,crlfDelay:Infinity});
        reader.on('line',line=>{
            const command=JSON.parse(line);
            send({type:'message',message:{recorded:command}});
            if(command.type==='request') send({type:'response',requestId:command.requestId,response:{result:{type:'ok'}}});
        });
        reader.on('close',()=>process.exit(0));
    `,
    );

    app.privateTerminals.launch = (socket) => {
        launches++;
        assert.equal(socket, join(directory, "herdr-client.sock"));
        const child = spawn(
            process.execPath,
            [script, ...(bad ? ["--bad"] : []), ...(waitForSnapshot ? ["--wait-snapshot"] : [])],
            { stdio: ["pipe", "pipe", "pipe", "ipc"] },
        ) as ChildProcessWithoutNullStreams;

        helpers.push(child);
        child.once("close", () => closedHelpers++);
        let pending = "";

        child.stdout.on("data", (buffer) => {
            pending += String(buffer);
            let newline: number;

            while ((newline = pending.indexOf("\n")) >= 0) {
                const event = JSON.parse(pending.slice(0, newline));

                pending = pending.slice(newline + 1);

                if (event.message?.recorded) {
                    inputLog.push(event.message.recorded);
                }
            }
        });

        return child;
    };

    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    const transports = new Set<Socket>();

    server.on("connection", (socket) => {
        transports.add(socket);
        socket.once("close", () => transports.delete(socket));
    });
    server.on("upgrade", app.privateTerminals.upgrade);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const token = app.config.ownerToken;
    const headers = {
        authorization: `Bearer ${token}`,
        "x-pocket": "1",
        "content-type": "application/json",
    };
    const ticket = async (
        body: Record<string, unknown> = { acknowledged: true },
        extra: Record<string, string> = headers,
    ) =>
        fetch(`${base}/api/private/opaque/terminal`, {
            method: "POST",
            headers: extra,
            body: JSON.stringify(body),
        });
    const sockets = new Set<WebSocket>();

    const connect = (path: string, changes: Record<string, string> = {}) => {
        const ws = new WebSocket(base.replace("http:", "ws:") + path, {
            headers: { authorization: headers.authorization, origin: base, ...changes },
        });

        sockets.add(ws);

        return ws;
    };

    return {
        app,
        target,
        ticket,
        connect,
        base,
        headers,
        inputLog,
        counts: () => ({ reads, checks, launches }),
        transports: () => transports.size,
        bad: () => {
            bad = true;
        },
        pauseHandshake: (paused = true) => {
            waitForSnapshot = paused;
        },
        helper: (message: "snapshot" | "fail") => helpers.at(-1)!.send!(message),
        closedHelpers: () => closedHelpers,
        async view() {
            const tree = await app.privateSessions.list(owner(app));
            const pane = tree.instances[0]!.workspaces[0]!.tabs[0]!.panes[0]!;

            return app.privateSessions.pane(owner(app), pane.id);
        },
        async close() {
            for (const ws of sockets) {
                ws.terminate();
            }

            await app.close();
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await new Promise<void>((resolve) => endpoint.close(() => resolve()));
            rmSync(directory, { recursive: true, force: true });
        },
    };
}

async function rejected(ws: WebSocket) {
    return new Promise<number>((resolve, reject) => {
        ws.once("unexpected-response", (_request, response) => {
            response.resume();
            ws.terminate();
            resolve(response.statusCode!);
        });
        ws.once("error", () => {});
        ws.once("open", () => reject(new Error("Unexpected terminal access")));
    });
}

function gate() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
        release = resolve;
    });

    return { promise, release };
}

function collect(ws: WebSocket): Event[] {
    const events: Event[] = [];

    ws.on("message", (data) => events.push(JSON.parse(String(data))));
    ws.on("error", () => {});

    return events;
}

test("attachment reserves through handshake and initial focus dispatch, not the connected lifetime", async () => {
    const f = await fixture();

    f.pauseHandshake();

    try {
        const grant = (await (await f.ticket()).json()) as { url: string };
        const ws = f.connect(grant.url);
        const events = collect(ws);

        ws.on("message", (data) => {
            if (JSON.parse(String(data)).type === "snapshot") {
                ws.send(
                    JSON.stringify({
                        type: "request",
                        bootId: "boot-a",
                        requestId: "initial-surface-interest",
                        method: "client_shell.surface.set",
                        params: { active: true },
                    }),
                );
            }
        });
        await until(() => events.some((event) => event.type === "connected"), "paused handshake");
        await assert.rejects(
            f.app.piSessions.active.local.withPane(f.target.socket, f.target.pane, async () => {}),
            /input in progress/,
            "Chat input must not cross the helper's pending attachment",
        );
        assert.equal(f.inputLog.length, 0, "no initial focus before the snapshot");
        f.helper("snapshot");
        await until(
            () =>
                events.some(
                    (event) =>
                        event.type === "response" && event.requestId === "initial-surface-interest",
                ),
            "surface-interest command after initialization",
        );
        assert.deepEqual(
            f.inputLog.map((event) => event.requestId),
            ["pocket-initial-focus", "initial-surface-interest"],
            "focus dispatch must precede browser navigation without lock reentry",
        );
        await f.app.piSessions.active.local.withPane(f.target.socket, f.target.pane, async () => {
            assert.equal(ws.readyState, WebSocket.OPEN);
        });
        assert.equal((await f.view()).canImport, true);
        const nextGrant = (await (await f.ticket()).json()) as { url: string };
        const next = f.connect(nextGrant.url);
        const nextEvents = collect(next);

        await until(
            () => nextEvents.some((event) => event.type === "connected"),
            "next initialization",
        );
        const writesBefore = f.inputLog.length;
        const observe = {
            type: "request",
            bootId: "boot-a",
            requestId: "observe-initialization",
            method: "worktree.list",
            params: {},
        };

        ws.send(
            JSON.stringify({
                type: "input",
                bootId: "boot-a",
                paneId: f.target.pane,
                events: [{ TextCommit: "never" }],
            }),
        );
        ws.send(
            JSON.stringify({
                type: "request",
                bootId: "boot-a",
                requestId: "focus-during-initialization",
                method: "pane.focus",
                params: { pane_id: f.target.pane },
            }),
        );
        ws.send(JSON.stringify(observe));
        await until(
            () =>
                events.some(
                    (event) => event.type === "response" && event.requestId === observe.requestId,
                ),
            "existing connection can observe during another attachment",
        );
        const refused = events.filter((event) => event.type === "rejected");

        assert.equal(
            refused.length,
            2,
            "existing connections cannot inherit initialization lock ownership",
        );

        for (const event of refused) {
            assert.match(event.reason, /input in progress/);
        }

        assert.deepEqual(f.inputLog.slice(writesBefore), [observe]);
        f.helper("snapshot");
        await until(
            () => nextEvents.some((event) => event.type === "surface"),
            "next initialization completes",
        );
        await f.app.piSessions.active.local.withPane(
            f.target.socket,
            f.target.pane,
            async () => {},
        );
        assert.equal(ws.readyState, WebSocket.OPEN);
        assert.equal(next.readyState, WebSocket.OPEN);
        assert.deepEqual(
            (await f.app.harness.snapshot(PrivateControlDoc, context))?.items ?? {},
            {},
            "attachment, surface interest and rejected input create no terminal admission",
        );
    } finally {
        await f.close();
    }
});

for (const failure of ["helper", "browser", "timeout"] as const) {
    test(`failed ${failure} initialization releases its attachment reservation`, async (t) => {
        const f = await fixture();

        f.pauseHandshake();

        try {
            const grant = (await (await f.ticket()).json()) as { url: string };

            if (failure === "timeout") {
                t.mock.timers.enable({ apis: ["setTimeout"] });
            }

            const ws = f.connect(grant.url);
            const events = collect(ws);
            const connected = new Promise<void>((resolve) => {
                ws.on("message", (data) => {
                    if (JSON.parse(String(data)).type === "connected") {
                        resolve();
                    }
                });
            });
            const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));

            await connected;
            await assert.rejects(
                f.app.piSessions.active.local.withPane(
                    f.target.socket,
                    f.target.pane,
                    async () => {},
                ),
                /input in progress/,
            );

            if (failure === "helper") {
                f.helper("fail");
            } else if (failure === "browser") {
                ws.close();
            } else {
                t.mock.timers.tick(15_000);
            }

            await closed;
            t.mock.timers.reset();
            await until(() => f.closedHelpers() === 1, "initializing helper reaped");
            await f.app.piSessions.active.local.withPane(
                f.target.socket,
                f.target.pane,
                async () => {},
            );
            assert.equal(f.inputLog.length, 0, "failed initialization never sends focus or input");

            if (failure === "timeout") {
                assert.match(events.find((event) => event.type === "closed")!.reason, /handshake/);
            }
        } finally {
            t.mock.timers.reset();
            await f.close();
        }
    });
}

test("rejected unauthenticated upgrades close TCP even when the peer keeps its write side open", async () => {
    const f = await fixture();
    const address = new URL(f.base);
    const peer = createConnection({
        host: address.hostname,
        port: Number(address.port),
        allowHalfOpen: true,
    });
    let response = "";

    peer.on("error", () => {});
    peer.on("data", (data) => {
        response += data.toString();
    });
    peer.write(
        `GET /api/private-terminal?ticket=invalid HTTP/1.1\r\nHost: ${address.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
    );

    try {
        await until(() => response.includes("Rejected"), "unauthenticated rejection", 2000);
        assert.match(response, /^HTTP\/1\.1 401 Rejected/);
        assert.equal(peer.writableEnded, false);
        await until(() => f.transports() === 0, "server destroys rejected half-open TCP", 2000);
        assert.deepEqual(f.counts(), { reads: 0, checks: 0, launches: 0 });
    } finally {
        peer.destroy();
        await f.close();
    }
});

test("terminal authorization/CSRF/origin/consent and one-use tickets precede endpoint or child access", async () => {
    const f = await fixture();

    try {
        const guest = f.app.config.addUser("Guest", "guest");
        const viewer = f.app.config.addUser("Viewer", "viewer");

        for (const token of [guest.token, viewer.token, "invalid"]) {
            const response = await f.ticket(
                { acknowledged: true },
                { ...f.headers, authorization: `Bearer ${token}` },
            );

            assert.ok([401, 403].includes(response.status));
        }

        assert.equal((await f.ticket({}, { ...f.headers, "x-pocket": "0" })).status, 403);
        assert.equal(
            (
                await f.ticket(
                    { acknowledged: true },
                    { ...f.headers, origin: "https://evil.invalid" },
                )
            ).status,
            403,
        );
        assert.equal((await f.ticket({})).status, 400);
        assert.equal((await f.ticket({ acknowledged: true, cols: 99999 })).status, 400);
        assert.deepEqual(f.counts(), { reads: 0, checks: 0, launches: 0 });
        assert.equal(
            await rejected(
                f.connect("/api/private-terminal?ticket=forged", {
                    authorization: "Bearer invalid",
                }),
            ),
            401,
        );
        assert.equal(
            await rejected(
                f.connect("/api/private-terminal?ticket=forged", {
                    origin: "https://evil.invalid",
                }),
            ),
            403,
        );
        assert.deepEqual(f.counts(), { reads: 0, checks: 0, launches: 0 });
        const response = await f.ticket();

        assert.equal(response.status, 200);
        assert.equal(response.headers.get("cache-control"), "no-store");
        const grant = (await response.json()) as { url: string };

        assert.equal(await rejected(f.connect(grant.url, { origin: "https://evil.invalid" })), 403);
        assert.equal(f.counts().launches, 0);
        const ws = f.connect(grant.url);
        const events = collect(ws);

        await until(() => events.some((event) => event.type === "surface"), "structured frame");
        assert.equal(await rejected(f.connect(grant.url)), 403);
        assert.equal(f.counts().launches, 1);
        assert.equal(f.app.sessions().length, 0);
        assert.equal((await f.app.harness.inspect(context)).tasks.length, 0);
    } finally {
        await f.close();
    }
});

test("parallel ticket issuance and upgrades honor ticket and native-child limits", async () => {
    const f = await fixture();

    try {
        const responses = await Promise.all(Array.from({ length: 24 }, () => f.ticket()));
        const accepted = responses.filter((response) => response.status === 200);

        assert.equal(accepted.length, 16);
        assert.equal(responses.filter((response) => response.status === 409).length, 8);
        assert.equal(f.counts().launches, 0);
        const tickets = await Promise.all(
            accepted.map((response) => response.json() as Promise<{ url: string }>),
        );

        f.pauseHandshake();
        const first = f.connect(tickets[0]!.url);
        const events = collect(first);

        await until(() => events.some((event) => event.type === "connected"), "pending attachment");
        assert.deepEqual(
            await Promise.all(tickets.slice(1, 4).map((ticket) => rejected(f.connect(ticket.url)))),
            [409, 409, 409],
            "same-instance upgrades cannot cross an initializing attachment",
        );
        f.pauseHandshake(false);
        f.helper("snapshot");
        await until(() => events.some((event) => event.type === "surface"), "first attachment");

        for (const ticket of tickets.slice(4, 7)) {
            const next = collect(f.connect(ticket.url));

            await until(() => next.some((event) => event.type === "surface"), "next attachment");
        }

        assert.equal(f.counts().launches, 4);
        assert.deepEqual(
            await Promise.all(tickets.slice(7).map((ticket) => rejected(f.connect(ticket.url)))),
            Array(9).fill(409),
            "native child limits still apply after initialization reservations release",
        );
        assert.equal(f.counts().launches, 4);
    } finally {
        await f.close();
    }
});

test("structured terminal preserves revisions, fences targets and input, and does not replay commands", async () => {
    const f = await fixture();

    try {
        const grant = (await (await f.ticket()).json()) as { url: string };
        const ws = f.connect(grant.url);
        const events = collect(ws);

        await until(() => events.some((event) => event.type === "surface"), "structured frame");
        assert.equal(
            events.find((event) => event.type === "surface")!.surface.projection_revision,
            "9007199254740993",
        );
        const invalid = [
            { type: "input", bootId: "old", paneId: "w1:p1", events: [{ TextCommit: "never" }] },
            {
                type: "input",
                bootId: "boot-a",
                paneId: "other-instance",
                events: [{ TextCommit: "never" }],
            },
            {
                type: "request",
                bootId: "boot-a",
                requestId: "bad-1",
                method: "server.reload_config",
                params: {},
            },
            {
                type: "request",
                bootId: "boot-a",
                requestId: "bad-2",
                method: "pane.close",
                params: { pane_id: "w1:p1" },
            },
            {
                type: "request",
                bootId: "boot-a",
                requestId: "bad-3",
                method: "command.invoke",
                params: { command_id: "not-advertised" },
            },
        ];

        for (const command of invalid) {
            ws.send(JSON.stringify(command));
        }

        await until(
            () => events.filter((event) => event.type === "rejected").length === invalid.length,
            "rejected unsafe commands",
        );
        assert.ok(!f.inputLog.some((event) => event.type === "input"));
        const input = {
            type: "input",
            bootId: "boot-a",
            paneId: "w1:p1",
            events: [{ TextCommit: "fixture" }],
        };

        ws.send(JSON.stringify(input));
        await until(
            () => f.inputLog.some((event) => event.type === "input"),
            "ordered semantic input",
        );
        assert.deepEqual(
            f.inputLog.find((event) => event.type === "input"),
            input,
        );
        const command = {
            type: "request",
            bootId: "boot-a",
            requestId: "one-request",
            method: "pane.focus",
            params: { pane_id: "w1:p1" },
        };

        ws.send(JSON.stringify(command));
        ws.send(JSON.stringify(command));
        await until(
            () =>
                events.some(
                    (event) => event.type === "response" && event.requestId === "one-request",
                ),
            "native response correlation",
        );
        await until(
            () => events.filter((event) => event.type === "rejected").length === invalid.length + 1,
            "duplicate refused",
        );
        assert.equal(f.inputLog.filter((event) => event.requestId === "one-request").length, 1);
        ws.close();
        await until(() => ws.readyState === WebSocket.CLOSED, "websocket closed");
        assert.equal(f.counts().launches, 1, "no implicit reconnect");
    } finally {
        await f.close();
    }
});

test("terminal replacement, malformed frames and revoked owner tokens close without leaking a native child", async () => {
    const f = await fixture();

    try {
        const stale = (await (await f.ticket()).json()) as { url: string };

        f.target.terminal = "replacement";
        assert.equal(await rejected(f.connect(stale.url)), 409);
        assert.equal(f.counts().launches, 0);
        f.bad();
        const malformed = (await (await f.ticket()).json()) as { url: string };
        const bad = f.connect(malformed.url);
        const badEvents = collect(bad);

        await until(() => bad.readyState === WebSocket.CLOSED, "invalid frame disconnect");
        assert.ok(badEvents.some((event) => event.type === "closed"));
        assert.ok(!badEvents.some((event) => event.type === "surface"));
        assert.equal(f.counts().launches, 1);
        f.app.config.rotateOwnerToken();
        assert.equal((await f.ticket()).status, 401);
    } finally {
        await f.close();
    }
});

test("an attached terminal permits snapshot copying while Chat still excludes native writes without disconnecting", async (t) => {
    const f = await fixture();
    const chatGate = gate();
    const copyGate = gate();
    let sending: ReturnType<typeof f.app.privateSessions.prompt> | undefined;
    let copying: ReturnType<typeof f.app.piSessions.active.move> | undefined;

    try {
        const grant = (await (await f.ticket()).json()) as { url: string };
        const ws = f.connect(grant.url);
        const events = collect(ws);
        const input = (text: string) => ({
            type: "input",
            bootId: "boot-a",
            paneId: f.target.pane,
            events: [{ TextCommit: text }],
        });
        const forwarded = (text: string) =>
            f.inputLog.some((event) => event.events?.[0]?.TextCommit === text);
        const controls = (phase: string) => [
            { type: "resize", bootId: "boot-a", cols: 80, rows: 24, cellWidth: 8, cellHeight: 18 },
            { type: "focus", bootId: "boot-a", focused: true },
            ...[
                ["pane.focus", { pane_id: f.target.pane }],
                ["pane.focus_direction", { pane_id: f.target.pane, direction: "right" }],
                ["pane.zoom", { pane_id: f.target.pane }],
                ["pane.resize", { pane_id: f.target.pane, direction: "right", amount: 0.1 }],
                ["layout.set_split_ratio", { tab_id: "t1", path: [], ratio: 0.5 }],
                ["tab.focus", { tab_id: "t1" }],
                ["workspace.focus", { workspace_id: "w1" }],
                ["pane.rename", { pane_id: f.target.pane, label: "Pi" }],
                ["tab.rename", { tab_id: "t1", label: "Tab" }],
                ["workspace.rename", { workspace_id: "w1", label: "Workspace" }],
                ["client_shell.surface.set", { active: true }],
            ].map(([method, params], index) => ({
                type: "request",
                bootId: "boot-a",
                requestId: `${phase}-control-${index}`,
                method,
                params,
            })),
        ];

        await until(() => events.some((event) => event.type === "surface"), "structured frame");
        await until(
            () => f.inputLog.some((event) => event.requestId === "pocket-initial-focus"),
            "initial focus dispatch",
        );
        const beforeControls = controls("before");
        const initializedWrites = f.inputLog.length;
        const receiptsBefore =
            (await f.app.harness.snapshot(PrivateControlDoc, context))?.items ?? {};

        for (const command of beforeControls) {
            ws.send(JSON.stringify(command));
        }

        await until(
            () => f.inputLog.length === initializedWrites + beforeControls.length,
            "native geometry and focus before Chat",
        );
        assert.deepEqual(f.inputLog.slice(initializedWrites), beforeControls);
        assert.deepEqual(
            (await f.app.harness.snapshot(PrivateControlDoc, context))?.items ?? {},
            receiptsBefore,
            "geometry and focus acquire reservations without recording terminal input",
        );
        assert.equal(
            (await f.view()).canImport,
            true,
            "an attached terminal is not a lifetime lease",
        );
        ws.send(JSON.stringify(input("before-import")));
        await until(() => forwarded("before-import"), "native input before import");
        const view = await f.view();

        assert.equal(view.canImport, true, "known native input must not fence imports");
        assert.equal(view.importReason, undefined);

        const local = f.app.piSessions.active.local;
        const request = local.request;
        const chatEntered = gate();
        let prompts = 0;

        t.mock.method(
            local,
            "request",
            async <T>(socket: string, method: string, params = {}): Promise<T> => {
                if (method === "agent.prompt") {
                    prompts++;
                    chatEntered.release();
                    await chatGate.promise;

                    return {
                        type: "agent_prompted",
                        agent: { pane_id: f.target.pane, agent: "pi" },
                    } as T;
                }

                return request<T>(socket, method, params);
            },
        );
        sending = f.app.privateSessions.prompt(owner(f.app), view.pane.id, {
            revision: view.revision,
            requestId: "active-chat",
            text: "Chat owns input admission",
        });
        await Promise.race([chatEntered.promise, sending]);
        const preview = await f.app.privateSessions.importPreview(owner(f.app), view.pane.id, {
            revision: view.revision,
        });
        const archive = readFileSync(preview.path, "utf8");
        const rejectedBefore = events.filter((event) => event.type === "rejected").length;
        const writesBefore = f.inputLog.length;
        const blockedControls = controls("prompt");
        const observation = {
            type: "request",
            bootId: "boot-a",
            requestId: "observe-prompt",
            method: "worktree.list",
            params: {},
        };

        ws.send(JSON.stringify(input("during-prompt")));
        ws.send(
            JSON.stringify({
                type: "request",
                bootId: "boot-a",
                requestId: "blocked-prompt",
                method: "tab.create",
                params: { workspace_id: "w1" },
            }),
        );

        for (const command of blockedControls) {
            ws.send(JSON.stringify(command));
        }

        ws.send(JSON.stringify(observation));
        await until(
            () =>
                events.some(
                    (event) =>
                        event.type === "response" && event.requestId === observation.requestId,
                ),
            "observation remains available during Chat admission",
        );
        const rejections = events
            .filter((event) => event.type === "rejected")
            .slice(rejectedBefore);

        assert.equal(rejections.length, 2 + blockedControls.length);
        assert.ok(rejections.some((event) => event.requestId === "blocked-prompt"));

        for (const event of rejections) {
            assert.match(event.reason, /input in progress/);
        }

        assert.deepEqual(f.inputLog.slice(writesBefore), [observation]);
        assert.equal(ws.readyState, WebSocket.OPEN);
        const blocked = (await (await f.ticket()).json()) as { url: string };

        assert.equal(await rejected(f.connect(blocked.url)), 409);
        assert.equal(f.counts().launches, 1, "upgrade cannot cross active Chat admission");
        chatGate.release();
        await sending;
        ws.send(JSON.stringify(input("after-prompt")));
        await until(() => forwarded("after-prompt"), "native input resumes after Chat");
        assert.equal(forwarded("during-prompt"), false);

        const copyEntered = gate();
        const prepare = f.app.piSessions.prepare.bind(f.app.piSessions);

        t.mock.method(f.app.piSessions, "prepare", async (...args: Parameters<typeof prepare>) => {
            copyEntered.release();
            await copyGate.promise;

            return prepare(...args);
        });
        copying = f.app.piSessions.active.move(owner(f.app), {
            id: preview.activeId,
            sha256: preview.sha256,
            leafId: preview.leafId,
            model: "faux/faux-vision",
            thinkingLevel: "off",
            acknowledged: true,
            visibility: "shared",
        });
        await Promise.race([copyEntered.promise, copying]);
        const writesBeforeCopy = f.inputLog.length;
        const rejectedBeforeCopy = events.filter((event) => event.type === "rejected").length;
        const copyControls = controls("copy");

        ws.send(JSON.stringify(input("during-copy")));

        for (const command of copyControls) {
            ws.send(JSON.stringify(command));
        }

        await until(
            () => f.inputLog.length === writesBeforeCopy + copyControls.length + 1,
            "native input, geometry and focus remain available during copying",
        );
        assert.deepEqual(f.inputLog.slice(writesBeforeCopy), [
            input("during-copy"),
            ...copyControls,
        ]);
        assert.equal(
            events.filter((event) => event.type === "rejected").length,
            rejectedBeforeCopy,
        );
        await f.app.privateSessions.prompt(owner(f.app), view.pane.id, {
            revision: view.revision,
            requestId: "chat-during-copy",
            text: "Read-only copying does not reserve Chat input",
        });
        assert.equal(prompts, 2);
        copyGate.release();
        const imported = await copying;

        assert.equal(await f.app.piSessions.archive(owner(f.app), imported.id), archive);
        assert.equal(readFileSync(preview.path, "utf8"), archive);
        assert.equal(ws.readyState, WebSocket.OPEN);
        assert.equal(f.counts().launches, 1, "copying needs no detach or reconnect");
        assert.equal((await f.view()).canImport, true);
        assert.equal((await f.app.harness.inspect(context)).tasks.length, 0);
    } finally {
        chatGate.release();
        copyGate.release();
        await Promise.allSettled([sending, copying]);
        await f.close();
    }
});

test("rotating the owner token terminates a live structured stream", async () => {
    const f = await fixture();

    try {
        const grant = (await (await f.ticket()).json()) as { url: string };
        const ws = f.connect(grant.url);
        const events = collect(ws);

        await until(() => events.some((event) => event.type === "surface"), "structured frame");
        f.app.config.rotateOwnerToken();
        await until(() => ws.readyState === WebSocket.CLOSED, "live owner revocation");
        assert.ok(
            events.some(
                (event) => event.type === "closed" && String(event.reason).includes("Owner access"),
            ),
        );
    } finally {
        await f.close();
    }
});
