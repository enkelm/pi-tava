// Actual transport and mounted component effects against memory-only browser/HTTP/WebSocket stubs.
// This owns hidden traffic, pooled retry eligibility and input non-replay, not Preact DOM or GPU paint.
// Existing browser coverage requires Chromium/listeners; these deterministic lifecycle races do not.
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { registerHooks } from "node:module";
import { test, type TestContext } from "node:test";

const storeListeners = new Set<() => void>();
const fixture = {
    component: null as Component | null,
    uid: 0,
    calls: [] as { path: string; signal: AbortSignal }[],
    api: async (_path: string, _body: unknown, _options: { signal: AbortSignal }) => ({
        url: "/api/private-terminal?ticket=synthetic",
    }),
    store: {
        state: { me: { id: "owner", role: "owner" } },
        subscribe(listener: () => void) {
            storeListeners.add(listener);

            return () => storeListeners.delete(listener);
        },
        set(value: { me: { id: string; role: string } }) {
            Object.assign(this.state, value);
            storeListeners.forEach((listener) => listener());
        },
    },
};

Object.assign(globalThis, { terminalLifecycleFixture: fixture });
const stubs: Record<string, string> = {
    "preact/hooks": `
        const f = globalThis.terminalLifecycleFixture;
        export const useState = initial => {
            const c = f.component, index = c.stateIndex++;
            if (!(index in c.states)) c.states[index] = typeof initial === 'function' ? initial() : initial;
            return [c.states[index], value => { c.states[index] = typeof value === 'function' ? value(c.states[index]) : value; }];
        };
        export const useRef = current => {
            const c = f.component;
            return c.refs[c.refIndex++] ??= {current};
        };
        export const useMemo = fn => fn();
        export const useEffect = (effect, deps) => f.component.effect(effect, deps);
        export const useLayoutEffect = useEffect;
    `,
    "./store.js": `
        const f = globalThis.terminalLifecycleFixture;
        export const store = f.store;
        export const uid = () => String(++f.uid);
        export const api = (path, body, options) => {
            f.calls.push({path, signal: options.signal});
            return f.api(path, body, options);
        };
    `,
    "./theme.js": `export const prefs = () => ({}); export const setPrefs = () => {};`,
    "./ui.js": `export const html = () => null; export const Icon = () => null;`,
    "./terminal-grid.js": `
        export const TerminalGrid = () => null;
        export const keyEvent = () => null;
        export const DEFAULT_THEME = {palette: []};
    `,
};

registerHooks({
    resolve(specifier, context, next) {
        const stub = stubs[specifier];

        return context.parentURL?.endsWith("/web/private-terminal.js") && stub !== undefined
            ? { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
            : next(specifier, context);
    },
});

const { terminalConnection, PrivateTerminal, syncTerminalTargets, disconnectPrivateTerminal } =
    await import(new URL("../web/private-terminal.js", import.meta.url).href);
const flush = async () => {
    for (let i = 0; i < 4; i++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
};
const size = { cols: 80, rows: 24, cellWidth: 8, cellHeight: 20 };

class Socket {
    static all: Socket[] = [];
    readyState = 1;
    sent: any[] = [];
    onmessage?: (event: { data: string }) => void;
    onclose?: () => void;

    constructor() {
        Socket.all.push(this);
    }

    send(text: string) {
        this.sent.push(JSON.parse(text));
    }

    close() {
        this.readyState = 3;
        this.onclose?.();
    }

    receive(frame: unknown) {
        this.onmessage?.({ data: JSON.stringify(frame) });
    }
}

function browser(t: TestContext) {
    const window = new EventTarget();
    const document = Object.assign(new EventTarget(), {
        visibilityState: "visible",
        documentElement: { dataset: {} },
        hasFocus: () => true,
        createElement: () => ({
            getContext: () => ({ measureText: () => ({ width: 8 }) }),
        }),
    });
    const navigator = { onLine: true };
    const cleanup: (() => void)[] = [];
    const globals = {
        window,
        document,
        navigator,
        location: new URL("https://fixture.invalid/"),
        WebSocket: Socket,
        matchMedia: () => ({ matches: false }),
        getComputedStyle: () => ({ getPropertyValue: () => "" }),
        MutationObserver: class {
            observe() {}
            disconnect() {}
        },
    };
    const descriptors = Object.keys(globals).map(
        (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
    );

    for (const [key, value] of Object.entries(globals)) {
        Object.defineProperty(globalThis, key, { configurable: true, value });
    }

    Socket.all = [];
    fixture.calls = [];
    fixture.store.set({ me: { id: "owner", role: "owner" } });
    fixture.api = async () => ({ url: "/api/private-terminal?ticket=synthetic" });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    t.after(() => {
        cleanup.reverse().forEach((stop) => stop());
        fixture.store.set({ me: { id: "owner", role: "viewer" } });

        for (const [key, descriptor] of descriptors) {
            if (descriptor) {
                Object.defineProperty(globalThis, key, descriptor);
            } else {
                Reflect.deleteProperty(globalThis, key);
            }
        }
    });

    return {
        document,
        window,
        cleanup,
        hide() {
            document.visibilityState = "hidden";
            document.dispatchEvent(new Event("visibilitychange"));
        },
        show() {
            document.visibilityState = "visible";
            document.dispatchEvent(new Event("visibilitychange"));
        },
        offline() {
            navigator.onLine = false;
            window.dispatchEvent(new Event("offline"));
        },
        online() {
            navigator.onLine = true;
            window.dispatchEvent(new Event("online"));
        },
    };
}

function project(socket = Socket.all.at(-1)!) {
    socket.receive({ type: "connected", welcome: { methods: ["client_shell.surface.set"] } });
    socket.receive({
        type: "snapshot",
        snapshot: { boot_id: "boot", revision: 1, focused_pane_id: "pane", panes: [] },
    });

    for (const request of socket.sent.filter(
        (frame) => frame.method === "client_shell.surface.set",
    )) {
        socket.receive({ type: "response", requestId: request.requestId, response: { result: {} } });
    }
}

function listTarget() {
    syncTerminalTargets({
        instances: [
            {
                id: "instance",
                workspaces: [
                    { tabs: [{ panes: [{ id: "opaque", nativeId: "pane" }] }] },
                ],
            },
        ],
    });
}

// Minimal hook scheduler: real dependency changes and cleanup, no DOM reconciliation or paint.
class Component {
    states: unknown[] = [];
    refs: { current: unknown }[] = [];
    effects: { deps?: unknown[]; stop?: () => void }[] = [];
    queued: (() => void)[] = [];
    stateIndex = 0;
    refIndex = 0;
    effectIndex = 0;

    effect(run: () => void | (() => void), deps?: unknown[]) {
        const index = this.effectIndex++;
        const previous = this.effects[index];

        if (
            deps &&
            previous?.deps &&
            deps.every((value, at) => Object.is(value, previous.deps![at]))
        ) {
            return;
        }

        this.queued.push(() => {
            previous?.stop?.();
            const stop = run();

            this.effects[index] = { deps, stop: stop || undefined };
        });
    }

    render() {
        fixture.component = this;
        this.stateIndex = this.refIndex = this.effectIndex = 0;
        PrivateTerminal({ id: "opaque", instanceId: "instance", nativeId: "pane" });
        this.queued.splice(0).forEach((run) => run());
    }

    unmount = () => {
        this.effects.splice(0).reverse().forEach((effect) => effect.stop?.());
    };
}

async function mount() {
    const component = new Component();

    component.render();
    await flush(); // The painter module resolves; no DOM or native renderer is created.
    component.render();

    return component.unmount;
}

test("hidden/pagehide abort terminal startup and fence late tickets until a real return", async (t) => {
    const b = browser(t);
    let finish!: (value: { url: string }) => void;
    let available = 0;
    const states: any[] = [];

    fixture.api = () =>
        new Promise((resolve) => {
            finish = resolve;
        });
    const connection = terminalConnection("opaque", (state: unknown) => states.push(state), {
        available: () => available++,
    });

    b.cleanup.push(() => connection.dispose());
    const starting = connection.connect(size);

    b.hide();
    assert.equal(fixture.calls[0]!.signal.aborted, true, "hidden startup must release its request");
    finish({ url: "/api/private-terminal?ticket=late" });
    await starting;
    assert.equal(Socket.all.length, 0, "an ignored abort cannot open a hidden socket");
    assert.equal(states.at(-1).paused, true);
    b.show();
    assert.equal(available, 1);
    b.window.dispatchEvent(new Event("pagehide"));
    b.online();
    b.show();
    await connection.connect(size);
    assert.equal(fixture.calls.length, 1, "departed pages cannot reopen via stray online/visible events");
    b.window.dispatchEvent(new Event("pageshow"));
    assert.equal(available, 2, "pageshow resumes availability once");
});

test("terminal transport closes in background and reconnects fresh without replaying input", async (t) => {
    const b = browser(t);
    const states: any[] = [];
    let connection: any;

    connection = terminalConnection("opaque", (state: unknown) => states.push(state), {
        available: () => connection.connect(size),
    });
    b.cleanup.push(() => connection.dispose());
    await connection.connect(size);
    project();
    const first = Socket.all[0]!;
    const epoch = states.at(-1).inputEpoch;

    assert.equal(connection.send({ type: "input", events: ["synthetic"] }), true);
    b.hide();
    assert.equal(first.readyState, 3, "visibilitychange alone releases the socket");
    assert.equal(states.at(-1).snapshot, null);
    assert.equal(connection.send({ type: "input", events: ["hidden"] }), false);
    b.show();
    await flush();
    project();
    assert.equal(Socket.all.length, 2);
    assert.notEqual(states.at(-1).inputEpoch, epoch);
    assert.deepEqual(Socket.all[1]!.sent, [], "the new socket never replays old input");
    first.receive({ type: "closed", reason: "late failure" });
    assert.equal(states.at(-1).phase, "connected", "old socket callbacks cannot close the new epoch");
    b.offline();
    assert.equal(Socket.all[1]!.readyState, 3);
    b.online();
    await flush();
    assert.equal(Socket.all.length, 3);
    fixture.store.set({ me: { id: "owner", role: "viewer" } });
    assert.equal(Socket.all[2]!.readyState, 3, "owner-access loss closes an active transport");
    assert.equal(connection.send({ type: "input", events: ["revoked"] }), false);
    connection.dispose();
    assert.equal(getEventListeners(b.document, "visibilitychange").length, 0);

    for (const event of ["online", "offline", "pagehide", "pageshow"]) {
        assert.equal(getEventListeners(b.window, event).length, 0);
        b.window.dispatchEvent(new Event(event));
    }

    await connection.connect(size);
    assert.equal(Socket.all.length, 3, "disposed transports cannot reconnect");
});

test("pooled foreground reuse survives one listener leaving; unused pools never reconnect", async (t) => {
    const b = browser(t);

    listTarget();
    const firstUnmount = await mount();

    b.cleanup.push(firstUnmount);
    t.mock.timers.tick(1);
    await flush();
    project();
    assert.equal(Socket.all.length, 1);
    const secondUnmount = await mount();

    b.cleanup.push(secondUnmount);
    firstUnmount();
    b.hide();
    assert.equal(Socket.all[0]!.readyState, 3);
    b.show();
    t.mock.timers.tick(1);
    await flush();
    assert.equal(Socket.all.length, 2, "another active listener still reconnects");
    project();
    secondUnmount();
    assert.equal(Socket.all[1]!.readyState, 1, "foreground Chat retains its existing connection");
    b.hide();
    assert.equal(Socket.all[1]!.readyState, 3, "backgrounding Collab closes the retained socket");
    b.show();
    t.mock.timers.tick(30_000);
    await flush();
    assert.equal(Socket.all.length, 2, "returning to Collab leaves the detached pool asleep");
    const unmount = await mount();

    b.cleanup.push(unmount);
    t.mock.timers.tick(1);
    await flush();
    project();
    assert.equal(Socket.all.length, 3, "reopening Terminal is fresh connection intent");
    unmount();
    Socket.all[2]!.close();
    t.mock.timers.tick(30_000);
    await flush();
    assert.equal(Socket.all.length, 3, "an unused foreground pool must not reconnect or resize a pane");
    const finalUnmount = await mount();

    b.cleanup.push(finalUnmount);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(Socket.all.length, 4);
    disconnectPrivateTerminal("instance");
    b.hide();
    b.show();
    b.offline();
    b.online();
    b.window.dispatchEvent(new Event("pagehide"));
    b.window.dispatchEvent(new Event("pageshow"));
    t.mock.timers.tick(30_000);
    await flush();
    assert.equal(Socket.all.length, 4, "explicit Disconnect survives all lifecycle resumes");
});

for (const stage of ["ticket", "socket", "welcome", "backoff"] as const) {
    test(`leaving the last Terminal view cancels ${stage} startup work`, async (t) => {
        const b = browser(t);
        let finish!: (value: { url: string }) => void;

        fixture.api =
            stage === "ticket"
                ? () =>
                      new Promise((resolve) => {
                          finish = resolve;
                      })
                : async () => {
                      if (stage === "backoff") {
                          throw new Error("Synthetic temporary failure");
                      }

                      return { url: "/api/private-terminal?ticket=synthetic" };
                  };
        listTarget();
        const unmount = await mount();

        b.cleanup.push(unmount);
        t.mock.timers.tick(1);
        await flush();
        assert.equal(fixture.calls.length, 1);

        if (stage === "welcome") {
            Socket.all[0]!.receive({
                type: "connected",
                welcome: { methods: ["client_shell.surface.set"] },
            });
        }

        unmount();

        if (stage === "socket" || stage === "welcome") {
            assert.equal(Socket.all[0]!.readyState, 3, "unfinished handshakes close immediately");
            project(Socket.all[0]);
            assert.deepEqual(Socket.all[0]!.sent, [], "late snapshots cannot revive native work");
        }

        if (stage === "ticket") {
            assert.equal(fixture.calls[0]!.signal.aborted, true);
            finish({ url: "/api/private-terminal?ticket=late" });
        }

        t.mock.timers.tick(30_000);
        await flush();
        b.online();
        b.show();
        t.mock.timers.tick(30_000);
        await flush();
        assert.equal(fixture.calls.length, 1, "no hidden request or retry can attach from Collab");
        assert.equal(
            Socket.all.length,
            stage === "socket" || stage === "welcome" ? 1 : 0,
            "late startup cannot attach or resize a pane after navigation",
        );
    });
}
