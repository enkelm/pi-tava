// Real HTTP/WebSocket and child pipes. The child and Unix socket are synthetic, never a live Herdr client.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createConnection, createServer as socketServer, type Socket } from "node:net";
import { join } from "node:path";
import { after, test } from "node:test";
import { WebSocket } from "ws";
import { createHandler } from "../src/server/http.ts";
import { cleanUp, context, openApp, scriptedModel, until } from "./helpers.ts";

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
    const inputLog: Event[] = [];

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
        const methods=['pane.focus','pane.close','tab.create','command.invoke','client_shell.surface.set'];
        send({type:'connected',welcome:{generation:1,methods}});
        send({type:'snapshot',snapshot:{boot_id:'boot-a',revision:'9007199254740993',
            workspaces:[{workspace_id:'w1'}],tabs:[{tab_id:'t1'}],panes:[{pane_id:'w1:p1'}],
            commands:[{command_id:'known-command'}]}});
        send({type:'surface',surface:{boot_id:'boot-a',projection_revision:'9007199254740993',surface_revision:1,
            frame:{width:2,height:1,cells:process.argv.includes('--bad')?[]:[{symbol:'A'},{symbol:'B'}]},popup:null}});
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
        const child = spawn(process.execPath, [script, ...(bad ? ["--bad"] : [])], {
            stdio: ["pipe", "pipe", "pipe"],
        });
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

function collect(ws: WebSocket): Event[] {
    const events: Event[] = [];

    ws.on("message", (data) => events.push(JSON.parse(String(data))));
    ws.on("error", () => {});

    return events;
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
        const outcomes = await Promise.all(
            tickets.map(
                (ticket) =>
                    new Promise<number>((resolve) => {
                        const ws = f.connect(ticket.url);

                        ws.on("error", () => {});
                        ws.once("open", () => resolve(101));
                        ws.once("unexpected-response", (_request, response) => {
                            response.resume();
                            ws.terminate();
                            resolve(response.statusCode!);
                        });
                    }),
            ),
        );

        assert.equal(outcomes.filter((code) => code === 101).length, 4);
        assert.equal(outcomes.filter((code) => code === 409).length, 12);
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
        await assert.rejects(
            f.app.imports.active.local.withPane(f.target.socket, f.target.pane, async () => {}),
            /terminal|control|instance/i,
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

test("an attached terminal permits Chat; native writes cannot cross an active Chat admission", async () => {
    const f = await fixture();

    try {
        const grant = (await (await f.ticket()).json()) as { url: string };
        const ws = f.connect(grant.url);
        const events = collect(ws);

        await until(() => events.some((event) => event.type === "surface"), "structured frame");
        ws.send(
            JSON.stringify({
                type: "request",
                bootId: "boot-a",
                requestId: "pause-surfaces",
                method: "client_shell.surface.set",
                params: { active: false },
            }),
        );
        await until(
            () => f.inputLog.some((event) => event.method === "client_shell.surface.set"),
            "surface-interest request without disconnect",
        );
        assert.equal(
            await f.app.privateSessions.control.reason(f.target.socket, f.target.pane, "takeover"),
            undefined,
        );
        await f.app.imports.active.local.withPane(
            f.target.socket,
            f.target.pane,
            async () => {
                ws.send(
                    JSON.stringify({
                        type: "input",
                        bootId: "boot-a",
                        paneId: f.target.pane,
                        events: [{ TextCommit: "must-not-cross" }],
                    }),
                );
                await until(
                    () => events.some((event) => event.type === "rejected"),
                    "native write excluded by Chat",
                );
                assert.ok(!f.inputLog.some((event) => event.type === "input"));
            },
            "prompt",
        );
        ws.send(
            JSON.stringify({
                type: "input",
                bootId: "boot-a",
                paneId: f.target.pane,
                events: [{ TextCommit: "after-chat" }],
            }),
        );
        await until(
            () => f.inputLog.some((event) => event.type === "input"),
            "native write after Chat",
        );
        await f.app.imports.active.local.withPane(
            f.target.socket,
            f.target.pane,
            async () => {},
            "prompt",
        );
        await assert.rejects(
            f.app.imports.active.local.withPane(f.target.socket, f.target.pane, async () => {}),
            /terminal|Terminal/,
        );
    } finally {
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
