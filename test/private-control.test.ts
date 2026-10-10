// Generated journals, synthetic Herdr/processes and disposable SQLite only. Never send real terminal input/signals.
import {
    cleanUp,
    context,
    openApp,
    owner,
    root,
    scriptedModel,
    work,
    until,
    type App,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, mock, test } from "node:test";
import type { Context } from "@earendil-works/chord";
import type { Tx } from "@earendil-works/pi-durable";
import { fileURLToPath } from "node:url";
import { PrivateControlDoc } from "../src/server/docs.ts";
import { ROOM_DOCS } from "../src/server/room.ts";
import { fakeHerdr } from "./active-import-fixture.ts";
import { importFixture } from "./import-fixtures.ts";

after(cleanUp);
const socket = "/synthetic/herdr.sock";
const ack = { type: "agent_prompted", agent: { pane_id: "pane", agent: "pi" } };

function attach(app: App, path: string) {
    const fake = fakeHerdr(app, path);
    const original = fake.local.request;
    const state = { sent: 0, response: ack as unknown, fail: false, admitted: false };

    fake.state.omitArgv = true;

    fake.local.request = async <T>(endpoint: string, method: string, params = {}): Promise<T> => {
        if (method === "pane.read") {
            return { read: { pane_id: "pane", text: "generated terminal" } } as T;
        }

        if (method === "agent.prompt") {
            state.sent++;
            state.admitted = Boolean(await app.privateSessions.control.reason(endpoint, "pane"));
            assert.equal(state.admitted, true, "receipt is durable before transport is invoked");
            assert.deepEqual(Object.keys(params).sort(), ["target", "text"]);

            if (state.fail) {
                throw new Error("lost reply after queueing Enter");
            }

            return state.response as T;
        }

        return original(endpoint, method, params);
    };

    return { ...fake, transport: state };
}

async function selected(app: App) {
    const tree = await app.privateSessions.list(owner(app));
    const pane = tree.instances[0]!.workspaces[0]!.tabs[0]!.panes[0]!;
    const view = await app.privateSessions.pane(owner(app), pane.id);

    return { pane, view };
}

async function fixture(name: string) {
    const directory = join(work, name);

    mkdirSync(directory);
    const source = importFixture(directory);
    const model = scriptedModel();
    const data = join(root, name);
    const app = await openApp(model, data);

    return { app, model, data, source, ...attach(app, source.path) };
}

test("pending admission survives restart, blocks fresh revisions and all app stop paths without replay", async () => {
    const f = await fixture("pending-control");
    const before = await selected(f.app);
    const active = (await f.local.list()).sessions[0]!;
    const receipt = await f.app.privateSessions.control.admitPrompt(socket, "pane");

    assert.equal(f.transport.sent, 0, "crash boundary before send is still conservatively fenced");
    assert.equal(ROOM_DOCS.has(PrivateControlDoc.definition.kind), false);
    const document = await f.app.harness.snapshot(PrivateControlDoc, context);

    assert.equal(Object.keys(document!.items).length, 1);
    assert.doesNotMatch(
        JSON.stringify(document),
        /synthetic|session\.jsonl|prompt text|revision|digest/,
    );
    assert.deepEqual(f.app.sessions(), []);
    assert.equal((await f.app.harness.inspect(context)).tasks.length, 0);
    await f.app.close();
    const app = await openApp(f.model, f.data);
    const next = attach(app, f.source.path);

    try {
        const current = await selected(app);

        assert.notEqual(current.view.revision, before.view.revision);
        assert.equal(current.view.canPrompt, false);
        assert.equal(current.view.canImport, false);
        assert.match(current.view.reason!, /Restarting.*does not clear/);
        await assert.rejects(
            app.privateSessions.prompt(owner(app), current.pane.id, {
                revision: current.view.revision,
                text: "A fresh request cannot bypass the old receipt",
                requestId: "new-after-restart",
            }),
            /delivery is uncertain/,
        );
        await assert.rejects(next.local.stop(active), /delivery is uncertain/);
        await assert.rejects(
            next.local.withPane(socket, "pane", async () => next.local.stop(active)),
            /delivery is uncertain/,
        );
        await assert.rejects(
            app.imports.active.move(owner(app), { id: active.id, acknowledged: true }),
            /delivery is uncertain/,
        );
        // Explicit raw control is still available after restart, but must not settle the unknown Chat receipt.
        let rawWrites = 0;

        await next.local.withTerminalInput(socket, "pane", async () => {
            await app.privateSessions.markTerminalInput(owner(app), socket);
            rawWrites++;
        });
        assert.equal(rawWrites, 1);
        assert.match(
            (await app.privateSessions.control.reason(socket, "pane"))!,
            /delivery is uncertain/,
        );
        // Fresh snapshots, PID/session replacement and local process disappearance are not queue cancellation.
        next.state.table = [next.shell];
        await next.local.list();
        assert.ok(await app.privateSessions.control.reason(socket, "pane"));
        assert.equal(next.transport.sent, 0);
        assert.deepEqual(next.state.signals, []);
        assert.equal(f.model.state.callCount, 0);
        assert.equal(
            (await app.harness.snapshot(PrivateControlDoc, context))!.items[
                Object.keys(document!.items)[0]!
            ]!.id,
            receipt.id,
        );
    } finally {
        await app.close();
    }
});

test("restart while agent.prompt is awaiting a reply cannot admit another prompt or takeover", async () => {
    const f = await fixture("in-flight-control");
    const { pane, view } = await selected(f.app);
    const original = f.local.request;
    let entered = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });

    f.local.request = async <T>(endpoint: string, method: string, params = {}): Promise<T> => {
        if (method === "agent.prompt") {
            entered = true;
            await gate;

            throw new Error("connection lost while the old process was closing");
        }

        return original(endpoint, method, params);
    };

    const sending = assert.rejects(
        f.app.privateSessions.prompt(owner(f.app), pane.id, {
            revision: view.revision,
            text: "Pending transport",
            requestId: "pending",
        }),
        /did not confirm delivery/,
    );

    await until(() => entered, "synthetic request awaiting response");
    assert.ok(await f.app.privateSessions.control.reason(socket, "pane"));
    await f.app.close();
    const app = await openApp(f.model, f.data);
    const next = attach(app, f.source.path);

    try {
        const current = await selected(app);

        await assert.rejects(
            app.privateSessions.prompt(owner(app), pane.id, {
                revision: current.view.revision,
                text: "Must not be sent",
                requestId: "after-restart",
            }),
            /delivery is uncertain/,
        );
        await assert.rejects(
            next.local.withPane(socket, "pane", async () => true),
            /delivery is uncertain/,
        );
        release();
        await sending;
        assert.ok(await app.privateSessions.control.reason(socket, "pane"));
        assert.equal(next.transport.sent, 0);
        assert.deepEqual(next.state.signals, []);
    } finally {
        release();
        await sending;
        await app.close();
    }
});

test("validated acknowledgement settles only its receipt; successful prompts do not persist private text", async () => {
    const f = await fixture("settled-control");

    try {
        const { pane, view } = await selected(f.app);
        const request = {
            revision: view.revision,
            text: "NEVER_STORE_THIS_PRIVATE_TEXT",
            requestId: "once",
        };

        assert.deepEqual(await f.app.privateSessions.prompt(owner(f.app), pane.id, request), {
            sent: true,
        });
        await f.app.privateSessions.prompt(owner(f.app), pane.id, request);
        assert.equal(f.transport.sent, 1);
        assert.equal(f.transport.admitted, true);
        assert.deepEqual((await f.app.harness.snapshot(PrivateControlDoc, context))?.items, {});
        assert.deepEqual(f.app.sessions(), []);
        assert.equal((await f.app.harness.inspect(context)).tasks.length, 0);
        assert.equal(f.model.state.callCount, 0);
        const first = await f.app.privateSessions.control.admitPrompt(socket, "pane");

        await f.app.privateSessions.control.settlePrompt(first, ack);
        const second = await f.app.privateSessions.control.admitPrompt(socket, "pane");

        await assert.rejects(
            f.app.privateSessions.control.settlePrompt(first, ack),
            /no longer matches/,
        );
        assert.ok(await f.app.privateSessions.control.reason(socket, "pane"));
        await f.app.privateSessions.control.settlePrompt(second, ack);
        assert.equal(await f.app.privateSessions.control.reason(socket, "pane"), undefined);
    } finally {
        await f.app.close();
    }
});

for (const [name, response] of [
    ["legacy-ok", { type: "ok" }],
    ["missing-agent", { type: "agent_prompted" }],
    ["wrong-pane", { type: "agent_prompted", agent: { pane_id: "other", agent: "pi" } }],
    ["wrong-agent", { type: "agent_prompted", agent: { pane_id: "pane", agent: "shell" } }],
    ["null", null],
    ["lost-delivery", ack],
] as const) {
    test(`${name}: unknown delivery never retries or clears on restart`, async () => {
        const f = await fixture(`ack-${name}`);
        const { pane, view } = await selected(f.app);
        const request = {
            revision: view.revision,
            text: "Generated message",
            requestId: "same-id",
        };

        f.transport.response = response;
        f.transport.fail = name === "lost-delivery";
        await assert.rejects(
            f.app.privateSessions.prompt(owner(f.app), pane.id, request),
            /did not confirm delivery/,
        );
        await assert.rejects(
            f.app.privateSessions.prompt(owner(f.app), pane.id, request),
            /did not confirm delivery/,
        );
        assert.equal(f.transport.sent, 1);
        assert.equal(
            Object.keys((await f.app.harness.snapshot(PrivateControlDoc, context))!.items).length,
            1,
        );
        await f.app.close();
        const app = await openApp(f.model, f.data);
        const next = attach(app, f.source.path);

        try {
            const current = await selected(app);

            await assert.rejects(
                app.privateSessions.prompt(owner(app), pane.id, {
                    ...request,
                    revision: current.view.revision,
                    requestId: "new-id",
                }),
                /delivery is uncertain/,
            );
            assert.equal(current.view.canImport, false);
            assert.equal(next.transport.sent, 0);
            assert.deepEqual(next.state.signals, []);
        } finally {
            await app.close();
        }
    });
}

for (const failingCommit of [1, 2]) {
    test(`failed ${failingCommit === 1 ? "admission" : "settlement"} commit cannot claim a delivered prompt`, async () => {
        const f = await fixture(`commit-${failingCommit}`);
        const { pane, view } = await selected(f.app);
        const commit = f.app.harness.commit.bind(f.app.harness);
        let calls = 0;
        const fault = mock.method(
            f.app.harness,
            "commit",
            <T>(change: (tx: Tx) => T | Promise<T>, ctx: Context) =>
                commit(async (tx) => {
                    const result = await change(tx);

                    if (++calls === failingCommit) {
                        throw new Error("injected commit failure");
                    }

                    return result;
                }, ctx),
        );

        try {
            await assert.rejects(
                f.app.privateSessions.prompt(owner(f.app), pane.id, {
                    revision: view.revision,
                    text: "Do not claim success without durable settlement",
                    requestId: "commit-fails",
                }),
                failingCommit === 1 ? /injected commit failure/ : /did not confirm delivery/,
            );
            fault.mock.restore();
            assert.equal(f.transport.sent, failingCommit - 1);
            assert.equal(
                Boolean(await f.app.privateSessions.control.reason(socket, "pane")),
                failingCommit === 2,
            );
            assert.deepEqual(f.state.signals, []);
        } finally {
            fault.mock.restore();
            await f.app.close();
        }
    });
}

test("known terminal receipts survive restart without fencing Chat or import, but cannot mask uncertain delivery", async () => {
    const f = await fixture("terminal-control");
    const guest = f.app.config.addUser("Guest", "guest").user;

    await assert.rejects(f.app.privateSessions.markTerminalInput(guest, socket), /Only the owner/);
    assert.deepEqual((await f.app.harness.snapshot(PrivateControlDoc, context))?.items ?? {}, {});
    await f.app.privateSessions.markTerminalInput(owner(f.app), socket);
    await f.app.privateSessions.markTerminalInput(owner(f.app), socket);
    const stored = await f.app.harness.snapshot(PrivateControlDoc, context);
    const current = await selected(f.app);

    assert.equal(Object.keys(stored!.items).length, 1);
    assert.equal(current.view.canPrompt, true);
    assert.equal(current.view.canImport, true);
    assert.equal(current.view.reason, undefined);
    assert.equal(current.view.importReason, undefined);
    assert.deepEqual(
        await f.app.privateSessions.prompt(owner(f.app), current.pane.id, {
            revision: current.view.revision,
            text: "Chat after native input",
            requestId: "after-terminal",
        }),
        { sent: true },
    );
    assert.deepEqual(
        (await f.app.harness.snapshot(PrivateControlDoc, context))!.items,
        stored!.items,
    );
    await f.app.close();
    const app = await openApp(f.model, f.data);
    const next = attach(app, f.source.path);

    try {
        const restarted = await selected(app);

        assert.equal(restarted.view.canPrompt, true);
        assert.equal(restarted.view.canImport, true);
        assert.equal(restarted.view.reason, undefined);
        assert.equal(restarted.view.importReason, undefined);
        assert.deepEqual(
            (await app.harness.snapshot(PrivateControlDoc, context))!.items,
            stored!.items,
        );
        assert.deepEqual(
            await app.privateSessions.prompt(owner(app), restarted.pane.id, {
                revision: restarted.view.revision,
                text: "Chat after restart",
                requestId: "after-restart",
            }),
            { sent: true },
        );
        next.transport.response = { type: "ok" };
        await assert.rejects(
            app.privateSessions.prompt(owner(app), restarted.pane.id, {
                revision: restarted.view.revision,
                text: "Lost Chat acknowledgement",
                requestId: "unknown-chat",
            }),
            /did not confirm delivery/,
        );
        const uncertain = await selected(app);

        assert.equal(uncertain.view.canPrompt, false);
        assert.equal(uncertain.view.canImport, false);
        assert.match(uncertain.view.reason!, /Input delivery is uncertain/);
        assert.match(uncertain.view.importReason!, /Input delivery is uncertain/);
        await assert.rejects(
            next.local.withPane(socket, "pane", async () => true, "prompt"),
            /delivery is uncertain/,
        );
        assert.equal(next.transport.sent, 2);
        assert.deepEqual(next.state.signals, []);
    } finally {
        await app.close();
    }
});

test("native writes reject active Chat while input to unrelated panes stays available", async () => {
    const f = await fixture("native-chat-exclusion");
    const { pane, view } = await selected(f.app);
    const original = f.local.request;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    let entered = false;
    let writes = 0;

    f.local.request = async <T>(endpoint: string, method: string, params = {}): Promise<T> => {
        if (method === "agent.prompt") {
            entered = true;
            await gate;
        }

        return original(endpoint, method, params);
    };

    const sending = f.app.privateSessions.prompt(owner(f.app), pane.id, {
        revision: view.revision,
        text: "In-flight Chat",
        requestId: "active-chat",
    });

    try {
        await until(() => entered, "synthetic prompt awaiting response");
        await assert.rejects(
            f.local.withTerminalInput(socket, "pane", () => {
                writes++;
            }),
            /operation in progress/,
        );
        await assert.rejects(
            f.local.withTerminalInput(socket, undefined, () => {
                writes++;
            }),
            /operation in progress/,
        );
        assert.equal(writes, 0);
        assert.equal(
            await f.local.withTerminalInput(socket, "other-pane", () => "other-pane"),
            "other-pane",
        );
        assert.equal(
            await f.local.withTerminalInput("/other/herdr.sock", undefined, () => "other-instance"),
            "other-instance",
        );
        release();
        await sending;
        await f.local.withTerminalInput(socket, "pane", () => {
            writes++;
        });
        assert.equal(writes, 1);
        assert.equal(f.transport.sent, 1);
        assert.deepEqual(f.state.signals, []);
    } finally {
        release();
        await sending;
        await f.app.close();
    }
});

test("native reservation covers asynchronous admission and pipe write, blocks new Chat, and releases on errors", async () => {
    const f = await fixture("native-admission-exclusion");
    const { pane, view } = await selected(f.app);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    let admitted = false;
    let writes = 0;
    const forwarding = f.local.withTerminalInput(socket, undefined, async () => {
        await f.app.privateSessions.markTerminalInput(owner(f.app), socket);
        admitted = true;
        await gate;
        writes++;

        return "written";
    });

    try {
        // Reservation precedes durable I/O; undefined pane fences every pane in this instance.
        await assert.rejects(
            f.local.withPane(socket, "other-pane", async () => true, "prompt"),
            /operation in progress/,
        );
        await assert.rejects(
            f.local.withTerminalInput(socket, "pane", () => {
                writes++;
            }),
            /operation in progress/,
        );
        await until(() => admitted, "durable admission before native write");
        assert.equal(writes, 0);
        await assert.rejects(
            f.app.privateSessions.prompt(owner(f.app), pane.id, {
                revision: view.revision,
                text: "Cannot overlap native write",
                requestId: "overlap-native",
            }),
            /operation in progress/,
        );
        assert.equal(
            await f.local.withPane("/other/herdr.sock", "pane", async () => true, "prompt"),
            true,
        );
        release();
        assert.equal(await forwarding, "written");
        assert.equal(writes, 1);
        assert.deepEqual(
            await f.app.privateSessions.prompt(owner(f.app), pane.id, {
                revision: view.revision,
                text: "Native forwarding ended",
                requestId: "after-native",
            }),
            { sent: true },
        );
        await assert.rejects(
            f.local.withTerminalInput(socket, "pane", async () => {
                throw new Error("synthetic pipe write failed");
            }),
            /pipe write failed/,
        );
        assert.equal(await f.local.withPane(socket, "pane", async () => true, "prompt"), true);
        assert.deepEqual(f.state.signals, []);
    } finally {
        release();
        await forwarding;
        await f.app.close();
    }
});

test("standalone stop reserves the pane against native writes and new Chat", async () => {
    const f = await fixture("native-stop-exclusion");
    const active = (await f.local.list()).sessions[0]!;
    const processes = f.local.processes;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });

    f.local.processes = async () => {
        await gate;

        return processes();
    };

    const stopping = f.local.stop(active);
    let writes = 0;

    try {
        await assert.rejects(
            f.local.withTerminalInput(socket, "pane", () => {
                writes++;
            }),
            /operation in progress/,
        );
        await assert.rejects(
            f.local.withTerminalInput(socket, undefined, () => {
                writes++;
            }),
            /operation in progress/,
        );
        await assert.rejects(
            f.local.withPane(socket, "pane", async () => true, "prompt"),
            /operation in progress/,
        );
        assert.equal(writes, 0);
        assert.deepEqual(f.state.signals, []);
        release();
        await stopping;
        assert.deepEqual(f.state.signals, [f.pi.pid], "only the fake signal hook ran");
        await f.local.withTerminalInput(socket, "pane", () => {
            writes++;
        });
        assert.equal(writes, 1);
    } finally {
        release();
        await stopping;
        await f.app.close();
    }
});

test("abrupt process exit after committed admission retains the fence without startup replay", async () => {
    const data = join(root, "crash-control");
    const helper = new URL("./helpers.ts", import.meta.url).href;
    const script = `
        import { openApp, root, scriptedModel } from ${JSON.stringify(helper)};
        const app = await openApp(scriptedModel(), ${JSON.stringify(data)});
        await app.privateSessions.control.admitPrompt(${JSON.stringify(socket)}, "pane");
        console.log(JSON.stringify({ root }));
        process.exit(23); // Deliberately do not close the app/storage, and never contact Herdr.
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        encoding: "utf8",
        timeout: 30_000,
    });

    assert.equal(child.status, 23, child.stderr);
    const childRoot = JSON.parse(child.stdout.trim().split("\n").at(-1)!).root;

    rmSync(childRoot, { recursive: true, force: true });
    const model = scriptedModel();
    const app = await openApp(model, data);
    const source = importFixture(work);
    const next = attach(app, source.path);

    try {
        await assert.rejects(
            next.local.withPane(socket, "pane", async () => true),
            /delivery is uncertain/,
        );
        assert.equal(next.transport.sent, 0);
        assert.deepEqual(next.state.signals, []);
        assert.equal(model.state.callCount, 0);
        assert.equal((await app.harness.inspect(context)).tasks.length, 0);
    } finally {
        await app.close();
    }
});
