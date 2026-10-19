// Real PrivateList/PrivatePane snapshot subscriptions with inert hooks and deferred private GETs.
// Owns timer/request/publication lifecycle, not Preact DOM, native Herdr or device energy.
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { registerHooks } from "node:module";
import { test, type TestContext } from "node:test";

type Slot = { value: any; updates: number; deps?: any[]; stop?: () => void };
type Request = {
    path: string;
    signal: AbortSignal;
    resolve: (value: any) => void;
    reject: (error: Error) => void;
};
const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
const window = new EventTarget();
const navigator = { onLine: true };
const observers = new Set<() => void>();
const fixture = {
    component: null as Component | null,
    requests: [] as Request[],
    store: {
        state: { me: { id: "alice", role: "owner" } as any, models: [] },
        subscribe(listener: () => void) {
            observers.add(listener);

            return () => observers.delete(listener);
        },
        set(value: any) {
            Object.assign(this.state, value);
            observers.forEach((listener) => listener());
        },
    },
};

for (const [key, value] of Object.entries({ document, window, navigator })) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
}

Object.assign(globalThis, { privateSnapshotFixture: fixture });
const stubs: Record<string, string> = {
    "preact/hooks": `
        const f = globalThis.privateSnapshotFixture;
        export const useState = initial => f.component.state(initial);
        export const useRef = current => f.component.memo(() => ({current}), []);
        export const useMemo = (fn, deps) => f.component.memo(fn, deps);
        export const useEffect = (fn, deps) => f.component.effect(fn, deps);
        export const useLayoutEffect = useEffect;
        export const useId = () => 'fixture';
    `,
    "./store.js": `
        const f = globalThis.privateSnapshotFixture;
        export const store = f.store;
        export const api = (path, body, {signal}) => new Promise((resolve, reject) => {
            f.requests.push({path, signal, resolve, reject});
        });
        export const navigate = () => {};
        export const openSheet = () => {};
        export const uid = () => 'fixture';
    `,
    "./ui.js": `
        export const html = (strings, ...values) => ({values});
        export const Icon = () => null;
        export const Loader = () => null;
        export const modelLabel = () => '';
    `,
    "./back.js": `export const goHome = () => {};`,
    "./message-box.js": `
        export const MessageBox = () => null;
        export const SendButton = () => null;
    `,
    "./transcript.js": `export const TranscriptEntry = () => null;`,
    "./private-input.js": `
        export const privateCommands = () => [];
        export const PrivateModelPicker = () => null;
        export const PrivateAttachmentChips = () => null;
        export const usePrivateAttachments = () => ({files: []});
    `,
    "./private-terminal.js": `
        export const PrivateTerminal = () => null;
        export const useLiveTerminal = () => null;
        export const selectTerminalInstance = () => {};
        export const syncTerminalTargets = () => {};
    `,
};

registerHooks({
    resolve(specifier, context, next) {
        const stub = stubs[specifier];

        return context.parentURL?.endsWith("/web/private.js") && stub !== undefined
            ? { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
            : next(specifier, context);
    },
});
const { PrivateList, PrivatePane } = await import(
    new URL("../web/private.js", import.meta.url).href
);
const flush = async () => {
    for (let i = 0; i < 4; i++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
};
const sameDeps = (left?: any[], right?: any[]) =>
    Boolean(left && right && left.length === right.length && left.every((v, i) => v === right[i]));

class Component {
    slots: Slot[] = [];
    index = 0;
    effects: (() => void)[] = [];

    render: (props: any) => any;
    props: any;

    constructor(render: (props: any) => any, props: any) {
        this.render = render;
        this.props = props;
    }

    state(initial: any) {
        const slot = (this.slots[this.index++] ??= {
            value: typeof initial === "function" ? initial() : initial,
            updates: 0,
        });

        return [
            slot.value,
            (value: any) => {
                slot.value = typeof value === "function" ? value(slot.value) : value;
                slot.updates++;
            },
        ];
    }

    memo(fn: () => any, deps: any[]) {
        const index = this.index++;
        const prior = this.slots[index];

        if (!prior || !sameDeps(prior.deps, deps)) {
            this.slots[index] = { value: fn(), deps, updates: 0 };
        }

        return this.slots[index]!.value;
    }

    effect(fn: () => (() => void) | void, deps: any[]) {
        const index = this.index++;
        const prior = this.slots[index];

        if (!prior || !sameDeps(prior.deps, deps)) {
            this.effects.push(() => {
                prior?.stop?.();
                this.slots[index] = { value: null, deps, updates: 0, stop: fn() || undefined };
            });
        }
    }

    run() {
        fixture.component = this;
        this.index = 0;
        const result = this.render(this.props);

        this.effects.splice(0).forEach((effect) => effect());
        fixture.component = null;

        return result;
    }

    get snapshot() {
        return this.slots.find((slot) => slot.value && "paused" in Object(slot.value))!;
    }

    stop() {
        this.slots.forEach((slot) => {
            slot.stop?.();
            slot.stop = undefined;
        });
    }
}

const listData = () => ({
    instances: [
        {
            id: "instance",
            available: true,
            workspaces: [
                {
                    id: "workspace",
                    label: "Synthetic",
                    tabs: [
                        {
                            id: "tab",
                            panes: [
                                { id: "pane", nativeId: "native", agent: "pi", state: "idle" },
                            ],
                        },
                    ],
                },
            ],
        },
    ],
    warnings: [],
});
const paneData = (capturedAt = 1) => ({
    pane: { id: "pane", title: "Synthetic", state: "idle" },
    revision: "revision",
    entries: [],
    terminal: "synthetic output",
    warnings: [],
    canPrompt: true,
    canImport: true,
    capturedAt,
});

function browser(t: TestContext) {
    document.visibilityState = "visible";
    navigator.onLine = true;
    fixture.requests = [];
    fixture.store.set({ me: { id: "alice", role: "owner" } });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const components: Component[] = [];
    const query = { matches: true, addEventListener() {}, removeEventListener() {} };

    Object.assign(globalThis, { matchMedia: () => query });
    t.after(async () => {
        components.reverse().forEach((component) => component.stop());
        // The fake wire deliberately ignores abort; release serialized predecessors between cases.
        fixture.requests.forEach((request) => request.resolve(listData()));
        await flush();
        window.dispatchEvent(new Event("pageshow"));
    });

    return {
        mount(render = PrivateList, props: any = { compact: true }) {
            const component = new Component(render, props);

            components.push(component);
            component.run();

            return component;
        },
        requests: fixture.requests,
        async tick(ms: number) {
            t.mock.timers.tick(ms);
            await flush();
        },
    };
}

function findView(node: any): any {
    if (typeof node === "function" && node.name === "PrivatePaneView") {
        return node;
    }

    for (const value of Array.isArray(node) ? node : node?.values || []) {
        const found = findView(value);

        if (found) {
            return found;
        }
    }
}

async function detail(t: TestContext) {
    const f = browser(t);
    const outer = f.mount(PrivatePane, { id: "pane" });

    await flush();
    f.requests[0]!.resolve(listData());
    await flush();
    const view = findView(outer.run());

    assert.equal(typeof view, "function", "real pane routing mounts the detail subscriber");
    const pane = f.mount(view, { id: "pane", mode: "chat" });

    await flush();

    return { ...f, pane };
}

test("visible list shares reads and skips unchanged publications", async (t) => {
    const f = browser(t);
    const first = f.mount();
    const second = f.mount();

    await flush();
    assert.equal(f.requests.length, 1);
    f.requests[0]!.resolve(listData());
    await flush();
    const retained = first.snapshot.value;
    const updates = first.snapshot.updates;

    await f.tick(4000);
    assert.equal(f.requests.length, 2);
    f.requests[1]!.resolve(listData());
    await flush();
    assert.equal(first.snapshot.value, retained);
    assert.equal(first.snapshot.updates, updates, "unchanged polling does not rerender the tree");
    first.stop();
    await f.tick(4000);
    const changed = listData();

    changed.instances[0]!.workspaces[0]!.label = "Native rename";
    f.requests[2]!.resolve(changed);
    await flush();
    assert.equal(second.snapshot.value.data.instances[0].workspaces[0].label, "Native rename");
});

test("pane skips capture-only updates, not content or permission changes", async (t) => {
    const f = await detail(t);

    assert.equal(f.requests[1]!.path, "private/pane");
    f.requests[1]!.resolve(paneData());
    await flush();
    const retained = f.pane.snapshot.value;
    const updates = f.pane.snapshot.updates;

    await f.tick(2000);
    assert.equal(f.requests.length, 3);
    f.requests[2]!.resolve(paneData(2));
    await flush();
    assert.equal(f.pane.snapshot.value, retained);
    assert.equal(f.pane.snapshot.updates, updates);
    await f.tick(2000);
    const request = f.requests.findLast((each) => each.path === "private/pane")!;

    request.resolve({ ...paneData(3), canPrompt: false, reason: "Busy", terminal: "new output" });
    await flush();
    assert.equal(f.pane.snapshot.value.data.canPrompt, false);
    assert.equal(f.pane.snapshot.value.data.terminal, "new output");
    assert.equal(f.pane.snapshot.value.data.capturedAt, 3);
});

test("batched pagehide/pageshow fences old replies before a fresh read", async (t) => {
    const f = browser(t);
    const component = f.mount();

    await flush();
    window.dispatchEvent(new Event("pagehide"));
    window.dispatchEvent(new Event("pageshow"));
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("online"));
    f.requests[0]!.resolve({ instances: [], warnings: ["obsolete"] });
    await flush();
    await f.tick(0);
    assert.equal(f.requests.length, 2);
    assert.equal(component.snapshot.value.data, null);
    f.requests[1]!.resolve(listData());
    await flush();
    assert.equal(component.snapshot.value.data.warnings.length, 0);
});

for (const reason of ["hidden", "offline", "pagehide"] as const) {
    test(`${reason} aborts, fences late replies and resumes one serialized read`, async (t) => {
        const f = browser(t);
        const component = f.mount();

        await flush();
        const old = f.requests[0]!;

        if (reason === "hidden") {
            document.visibilityState = "hidden";
            document.dispatchEvent(new Event("visibilitychange"));
        } else if (reason === "offline") {
            navigator.onLine = false;
            window.dispatchEvent(new Event("offline"));
        } else {
            window.dispatchEvent(new Event("pagehide"));
            window.dispatchEvent(new Event("online"));
            document.dispatchEvent(new Event("visibilitychange"));
        }

        assert.equal(old.signal.aborted, true);
        assert.equal(component.snapshot.value.paused, true);
        await f.tick(60_000);
        assert.equal(f.requests.length, 1);
        document.visibilityState = "visible";
        navigator.onLine = true;

        if (reason === "pagehide") {
            window.dispatchEvent(new Event("pageshow"));
        } else {
            document.dispatchEvent(new Event("visibilitychange"));
        }

        old.resolve({ instances: [], warnings: ["obsolete"] });
        await flush();
        await f.tick(0);
        assert.equal(f.requests.length, 2, "one fresh read follows old wire completion");
        assert.equal(component.snapshot.value.data, null, "old response stays fenced after return");
        f.requests[1]!.resolve(listData());
        await flush();
        assert.equal(component.snapshot.value.data.warnings.length, 0);
        assert.equal(component.snapshot.value.paused, false);
    });
}

for (const remountBeforeReturn of [false, true]) {
    const when = remountBeforeReturn ? "before" : "after";

    test(`departure cleanup permits remount ${when} return`, async (t) => {
        const f = browser(t);
        const original = f.mount();

        await flush();
        f.requests[0]!.resolve(listData());
        await flush();
        window.dispatchEvent(new Event("pagehide"));
        original.stop();
        assert.equal(getEventListeners(window, "pagehide").length, 0);
        assert.equal(getEventListeners(window, "pageshow").length, 1);
        let replacement: Component;

        if (remountBeforeReturn) {
            replacement = f.mount();
            await f.tick(60_000);
            assert.equal(f.requests.length, 1);
            assert.equal(replacement.snapshot.value.paused, true);
        }

        window.dispatchEvent(new Event("pageshow"));

        if (!remountBeforeReturn) {
            assert.equal(getEventListeners(window, "pageshow").length, 0);
            replacement = f.mount();
        }

        await flush();
        assert.equal(f.requests.length, 2);
        f.requests[1]!.resolve(listData());
        await flush();
        assert.equal(replacement!.snapshot.value.paused, false);
        assert.equal(replacement!.snapshot.value.data.instances.length, 1);
    });
}

test("owner replacement clears data and fences old forbidden replies", async (t) => {
    const f = browser(t);
    const component = f.mount();

    await flush();
    f.requests[0]!.resolve(listData());
    await flush();
    await f.tick(4000);
    const old = f.requests[1]!;

    fixture.store.set({ me: { id: "bob", role: "owner" } });
    assert.equal(component.snapshot.value.data, null);
    assert.equal(old.signal.aborted, true);
    old.reject(Object.assign(new Error("obsolete forbidden"), { status: 403 }));
    await flush();
    await f.tick(0);
    assert.equal(fixture.store.state.me.id, "bob");
    assert.equal(f.requests.length, 3);
    f.requests[2]!.reject(Object.assign(new Error("forbidden"), { status: 403 }));
    await flush();
    assert.equal(fixture.store.state.me.role, "viewer");
    assert.equal(component.snapshot.value.data, null);
    await f.tick(60_000);
    assert.equal(f.requests.length, 3);
});

test("last listener removes handlers, aborts its read and admits no later poll", async (t) => {
    const f = browser(t);
    const component = f.mount();

    await flush();
    component.stop();
    assert.equal(f.requests[0]!.signal.aborted, true);
    assert.equal(getEventListeners(document, "visibilitychange").length, 0);

    for (const type of ["online", "offline", "pagehide", "pageshow"]) {
        assert.equal(getEventListeners(window, type).length, 0, type);
    }

    f.requests[0]!.resolve(listData());
    await flush();
    await f.tick(60_000);
    assert.equal(f.requests.length, 1);
});
