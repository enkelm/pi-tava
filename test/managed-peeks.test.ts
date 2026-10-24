// Real Peeks/Preact/usePresence over in-memory elements and controlled observer notifications.
// Owns private UI scoping and live-interest messages, not native grants, geometry or browser rendering.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, mock, test } from "node:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";

type Props = Record<string, any>;
const subscribers = new Set<(state: Props) => void>();
const requests: { path: string; body: Props }[] = [];
const store = {
    state: {} as Props,
    set(patch: Props) {
        Object.assign(this.state, patch);
        subscribers.forEach((listener) => listener(this.state));
    },
    subscribe(listener: (state: Props) => void) {
        subscribers.add(listener);

        return () => subscribers.delete(listener);
    },
};

class Element extends EventTarget {
    parentNode: Element | null = null;
    childNodes: Element[] = [];
    attributes: Record<string, string> = {};
    nodeType = 1;
    data = "";
    mounted = false;
    style = { cssText: "", setProperty() {} };
    namespaceURI = "http://www.w3.org/1999/xhtml";
    offsetTop = 0;
    offsetHeight = 100;
    scrollTop = 0;
    clientHeight = 600;
    readonly localName: string;

    constructor(localName: string) {
        super();
        this.localName = localName;
    }

    get ownerDocument() {
        return document;
    }
    get firstChild(): Element | null {
        return this.childNodes[0] ?? null;
    }
    get nextSibling(): Element | null {
        const siblings = this.parentNode?.childNodes;

        return siblings?.[siblings.indexOf(this) + 1] ?? null;
    }
    get isConnected(): boolean {
        return this.mounted || this.parentNode?.isConnected === true;
    }
    get dataset() {
        return { peek: this.attributes["data-peek"] };
    }
    get textContent(): string {
        return this.nodeType === 3
            ? this.data
            : this.childNodes.map((child) => child.textContent).join("");
    }
    setAttribute(name: string, value: unknown) {
        this.attributes[name] = String(value);
    }
    removeAttribute(name: string) {
        delete this.attributes[name];
    }
    insertBefore(child: Element, before: Element | null) {
        child.parentNode?.removeChild(child);
        const index = before ? this.childNodes.indexOf(before) : -1;

        this.childNodes.splice(index === -1 ? this.childNodes.length : index, 0, child);
        child.parentNode = this;
    }
    appendChild(child: Element) {
        this.insertBefore(child, null);
    }
    removeChild(child: Element) {
        const index = this.childNodes.indexOf(child);

        assert.notEqual(index, -1);
        this.childNodes.splice(index, 1);
        child.parentNode = null;
    }
    remove() {
        this.parentNode?.removeChild(this);
    }
    querySelectorAll(selector: string): Element[] {
        const matches = (element: Element) => {
            if (selector.startsWith(".")) {
                const classes = (element.attributes.class ?? "").split(/\s+/);

                return selector
                    .slice(1)
                    .split(".")
                    .every((name) => classes.includes(name));
            }

            if (selector === "[data-peek]") {
                return element.attributes["data-peek"] !== undefined;
            }

            return element.localName === selector;
        };

        return this.childNodes.flatMap((child) => [
            ...(matches(child) ? [child] : []),
            ...child.querySelectorAll(selector),
        ]);
    }
    querySelector(selector: string) {
        return this.querySelectorAll(selector)[0] ?? null;
    }
}

class Intersections {
    static instances = new Set<Intersections>();
    targets = new Set<Element>();
    readonly callback: (entries: Props[]) => void;

    constructor(callback: (entries: Props[]) => void) {
        this.callback = callback;
        Intersections.instances.add(this);
    }
    observe(element: Element) {
        this.targets.add(element);
    }
    unobserve(element: Element) {
        this.targets.delete(element);
    }
    disconnect() {
        this.targets.clear();
        Intersections.instances.delete(this);
    }
    static visible(element: Element, visible: boolean) {
        const observers = [...this.instances].filter((observer) => observer.targets.has(element));

        assert.equal(observers.length, 1, "the mounted tile owns one native visibility watch");
        observers[0]!.callback([{ target: element, isIntersecting: visible }]);
    }
}

const document = Object.assign(new EventTarget(), {
    visibilityState: "visible",
    documentElement: { dataset: {} },
    createElementNS: (_namespace: string, tag: string) => new Element(tag),
    createTextNode(data: string) {
        const node = new Element("text");

        node.nodeType = 3;
        node.data = data;

        return node;
    },
});
const fixture = {
    store,
    api: async (path: string, body: Props) => {
        requests.push({ path, body });
    },
};
const globals: Props = {
    managedPeeksFixture: fixture,
    document,
    navigator: { platform: "" },
    matchMedia: () => Object.assign(new EventTarget(), { matches: true }),
    addEventListener() {},
    IntersectionObserver: Intersections,
    ResizeObserver: class {
        observe() {}
        disconnect() {}
    },
    requestAnimationFrame: (callback: () => void) => setTimeout(callback, 16),
    cancelAnimationFrame: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
};
const descriptors = Object.keys(globals).map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
);

for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
}

const sources: Record<string, string> = {
    "./store.js": `
        const fixture = globalThis.managedPeeksFixture;
        export const {store,api} = fixture;
        export const actions = {}, filesShown = () => false, notify = () => {}, openSheet = () => {};
        export const attempt = fn => fn(), canSteer = () => true, navigate = () => {};
        export const workspaceOrder = () => [];
    `,
    "./theme.js": "export const prefs=()=>({peeks:true}),setPrefs=()=>{};",
    "./seen.js": "export const finishedUnseen=()=>false,markSeen=()=>{},seenSince=()=>0;",
    "./gestures.js": "export const useDragToClose=()=>{};",
    "./highlight.js": "export const highlight=()=>'',langOf=()=>'';",
    dompurify: "export default {addHook(){}};",
};
const hooks = registerHooks({
    resolve(specifier, context, next) {
        const source = /\/web\/(peeks|ui)\.js$/.test(context.parentURL ?? "")
            ? sources[specifier]
            : undefined;

        return source === undefined
            ? next(specifier, context)
            : { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    },
});

store.state = { conversationId: null };
mock.timers.enable({ apis: ["setTimeout"] });
const { PeekHost, PeekStrip, peekContext, peekTiles, setManagedPeeks } = await import(
    new URL("../web/peeks.js", import.meta.url).href
);
const root = new Element("root");

root.mounted = true;
after(async () => {
    await act(() => render(null, root as unknown as HTMLElement));
    mock.timers.tick(1000);
    mock.timers.reset();
    hooks.deregister();

    for (const [key, descriptor] of descriptors) {
        if (descriptor) {
            Object.defineProperty(globalThis, key, descriptor);
        } else {
            Reflect.deleteProperty(globalThis, key);
        }
    }
});

const scope = () => ({ userId: store.state.me.id, agentId: "agent-a", source: 19 });
const controller = (conversationId: number, overrides: Props = {}) => ({
    conversationId,
    title: `Work ${conversationId}`,
    cwd: "/work/project",
    current: true,
    accessible: true,
    state: "active",
    busy: false,
    waiting: false,
    ...overrides,
});
let iteration = 0;

async function reset() {
    await act(() => render(null, root as unknown as HTMLElement));
    document.visibilityState = "visible";
    store.set({
        me: { id: `owner-${++iteration}`, role: "owner" },
        server: { privateAgents: 4, peeks: true },
        streamId: `connection-${iteration}`,
        conversationId: 19,
        view: { conversation: { id: 19, pipAgentId: "agent-a" } },
        namedAgents: [
            { agentId: "agent-a", name: "Ada" },
            { agentId: "agent-b", name: "Bea" },
        ],
        agentDraft: null,
        managedPeeks: null,
        missing: false,
        sessions: [{ id: 700, title: "Public busy work", busy: true }],
        pinned: [700],
        peeks: {},
    });
    mock.timers.tick(1000);
    await Promise.resolve();
    requests.length = 0;
}

async function paint(shown = true, tiles = peekTiles(), context = peekContext(), strip = false) {
    await act(() =>
        render(
            strip ? h(PeekStrip, { tiles, context }) : h(PeekHost, { shown, tiles, context }),
            root as unknown as HTMLElement,
        ),
    );
}

const ids = () => root.querySelectorAll("[data-peek]").map((node) => Number(node.dataset.peek));

const tick = async (ms: number) => {
    mock.timers.tick(ms);
    await Promise.resolve();
};

test("actual Peeks surfaces show only current private controllers, including idle active work", async () => {
    await reset();
    setManagedPeeks(scope(), {
        loading: false,
        data: {
            controllers: [
                controller(101),
                controller(102, { current: false, state: "human control" }),
                controller(103, { current: false, state: "observing" }),
                controller(104, { accessible: false }),
            ],
        },
    });

    for (const strip of [false, true]) {
        await paint(true, peekTiles(), peekContext(), strip);
        assert.deepEqual(ids(), [101], "public/pinned, historical and passive work stays out");
        const tile = root.querySelector(".peek")!;

        assert.equal(tile.attributes["data-state"], "working");
        assert.match(tile.textContent, /PiP · Work 101/);
        assert.equal(tile.querySelector(".peek-status")!.textContent, "orchestrating");
        assert.equal(tile.querySelector(".peek-seen"), null, "idle active work is not finished");
    }

    assert.equal(requests.length, 0, "mounting without an intersection does not subscribe");
});

test("private loading, error/retry and empty states never fall back to public Peeks", async () => {
    await reset();
    const previous = setManagedPeeks(scope(), {
        loading: false,
        data: { controllers: [controller(101)] },
    });
    let retries = 0;

    for (const strip of [false, true]) {
        setManagedPeeks(scope(), { loading: true, data: { controllers: [controller(101)] } });
        await paint(true, peekTiles(), peekContext(), strip);
        assert.deepEqual(ids(), []);
        assert.match(root.textContent, /Loading managed orchestrators/);
        setManagedPeeks(scope(), {
            loading: false,
            error: "Native controller read unavailable",
            refresh: () => retries++,
            data: { controllers: [controller(101)] },
        });
        previous();
        await paint(true, peekTiles(), peekContext(), strip);
        assert.deepEqual(ids(), []);
        assert.match(root.textContent, /Native controller read unavailable/);
        const retry = root.querySelectorAll("button").find((node) => node.textContent === "Retry");

        assert.ok(retry, "native error includes the current read's Retry control");
        retry.dispatchEvent(new Event("click"));
        setManagedPeeks(scope(), { loading: false, data: { controllers: [] } });
        await paint(true, peekTiles(), peekContext(), strip);
        assert.deepEqual(ids(), []);
        assert.match(root.textContent, /No orchestrators currently managed by this agent/);
        assert.doesNotMatch(root.textContent, /Public busy work/);
    }

    assert.equal(retries, 2);
});

test("owner, identity and exact source changes immediately revoke retained private tiles", async () => {
    for (const change of [
        { me: { id: "another-owner", role: "owner" } },
        { me: { id: "guest", role: "guest" } },
        { conversationId: 20, view: { conversation: { id: 20, pipAgentId: "agent-a" } } },
        { view: { conversation: { id: 19, pipAgentId: "agent-b" } } },
        { namedAgents: [] },
    ]) {
        await reset();
        setManagedPeeks(scope(), { loading: false, data: { controllers: [controller(101)] } });
        const tiles = peekTiles();
        const context = peekContext();

        await paint(true, tiles, context);
        assert.deepEqual(ids(), [101]);
        await paint(false, tiles, context);
        assert.deepEqual(ids(), [101], "ordinary dismissal retains its exit until animation ends");
        assert.equal(root.querySelector(".peeks")!.attributes["data-state"], "closing");
        store.set(change);
        await paint(false, tiles, context);
        assert.deepEqual(ids(), [], "scope revocation cannot animate the old private tiles out");
        await paint(true, tiles, context);
        assert.deepEqual(
            ids(),
            [],
            "retained props cannot bypass the current owner/identity/source",
        );
        await paint(true, peekTiles(), peekContext());
        assert.ok(!ids().includes(101), "stale managed read is not accepted by the new view");
    }
});

test("entering a named Chat discards retained public tiles instead of animating them into private Peeks", async () => {
    await reset();
    store.set({ view: { conversation: { id: 19 } } });
    const tiles = peekTiles();
    const context = peekContext();

    assert.equal(context, null);
    await paint(true, tiles, context);
    assert.deepEqual(ids(), [700]);
    await paint(false, tiles, context);
    assert.deepEqual(ids(), [700], "public dismissal normally retains its exit");
    store.set({ view: { conversation: { id: 19, pipAgentId: "agent-a" } } });
    await paint(false, tiles, context);
    assert.deepEqual(ids(), [], "public retained data is revoked on entry to a private identity");
    await paint(true, peekTiles(), peekContext());
    assert.deepEqual(ids(), []);
    assert.match(root.textContent, /Loading managed orchestrators/);
    assert.doesNotMatch(root.textContent, /Public busy work/);
});

test("only intersecting managed tiles subscribe; hide, removal and unmount drop live interest", async () => {
    await reset();
    setManagedPeeks(scope(), {
        loading: false,
        data: { controllers: [controller(101), controller(102)] },
    });
    await paint();
    await tick(1000);
    assert.equal(requests.length, 0, "rendering private tiles does not make them all live");
    const [first, second] = root.querySelectorAll("[data-peek]");

    assert.ok(first && second);
    Intersections.visible(first, true);
    await tick(249);
    assert.equal(requests.length, 0, "scrolling must settle before native interest is sent");
    await tick(1);
    assert.equal(requests.at(-1)!.path, "peeks");
    assert.equal(requests.at(-1)!.body.connection, store.state.streamId);
    assert.deepEqual(requests.at(-1)!.body.ids, [101]);
    Intersections.visible(second, true);
    Intersections.visible(first, false);
    await tick(250);
    assert.deepEqual(requests.at(-1)!.body.ids, [102]);
    document.visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    await tick(0);
    assert.deepEqual(requests.at(-1)!.body.ids, [], "hidden documents release private streams");
    document.visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await tick(250);
    assert.deepEqual(requests.at(-1)!.body.ids, [102]);
    setManagedPeeks(scope(), { loading: false, data: { controllers: [] } });
    await paint();
    await tick(250);
    assert.deepEqual(requests.at(-1)!.body.ids, [], "revoked management is no longer watched");
    assert.equal(second.isConnected, false);
    setManagedPeeks(scope(), { loading: false, data: { controllers: [controller(101)] } });
    await paint();
    Intersections.visible(root.querySelector(".peek")!, true);
    await tick(250);
    assert.deepEqual(requests.at(-1)!.body.ids, [101]);
    await act(() => render(null, root as unknown as HTMLElement));
    await tick(250);
    assert.deepEqual(requests.at(-1)!.body.ids, [], "unmount also releases an active subscription");
    assert.equal(
        Intersections.instances.size,
        0,
        "unmount disconnects native visibility observers",
    );
});
