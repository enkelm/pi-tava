// Authoring gate: exercise the real History click -> actions.history -> fetch -> store publication.
// Delayed completion must not cross user/thread/context boundaries or move another reader's scroll.
// Only rendering/hooks and unrelated adapters are opaque. No server or production test-only seam.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { after, test } from "node:test";

type Template = { parts: string[]; values: any[] };
type Row = { id: number; kind: string; summary?: string; text?: string };
const target = new URL("../web/transcript.js", import.meta.url).href;
const hooks = `
    export const useState = value => [typeof value === "function" ? value() : value, () => {}];
    export const useRef = current => ({current});
    export const useMemo = run => run();
    export const useEffect = () => {};
    export const useLayoutEffect = () => {};
`;
const stubs = new Map<string, string>();

for (const match of readFileSync(new URL(target), "utf8").matchAll(
    /import\s*\{([^}]+)\}\s*from\s*"([^"]+)"/g,
)) {
    const specifier = match[2]!;

    if (["./store.js", "./turns.js"].includes(specifier)) {
        continue;
    }

    const names = match[1]!
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);

    stubs.set(
        specifier,
        specifier === "preact"
            ? "export class Component {}"
            : specifier === "preact/hooks"
              ? hooks
              : names
                    .map((name) =>
                        name === "html"
                            ? "export const html = (parts, ...values) => ({parts: [...parts], values});"
                            : `export const ${name} = () => null;`,
                    )
                    .join("\n"),
    );
}

const page = new EventTarget();
const document = Object.assign(new EventTarget(), {
    visibilityState: "hidden",
    documentElement: { dataset: {} },
    querySelector: () => null,
});

const storage = () => {
    const values = new Map<string, string>();

    return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
    };
};

const globals = {
    document,
    localStorage: storage(),
    sessionStorage: storage(),
    location: { pathname: "/s/1", hostname: "example.test" },
    navigator: { onLine: false },
    addEventListener: page.addEventListener.bind(page),
    removeEventListener: page.removeEventListener.bind(page),
    matchMedia: () => ({ matches: false, addEventListener() {} }),
};
const descriptors = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);

for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
}

const loader = registerHooks({
    resolve(specifier, context, next) {
        const stub =
            context.parentURL === target
                ? stubs.get(specifier)
                : context.parentURL?.endsWith("/web/store.js") && specifier === "./back.js"
                  ? "export const onRoute = () => {}; export const pushRoute = () => {};"
                  : undefined;

        return stub === undefined
            ? next(specifier, context)
            : { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true };
    },
    load(url, context, next) {
        const loaded = next(url, context);

        // In-memory component access follows visible-clock.test.ts; no production export.
        return url === target
            ? { ...loaded, source: `${loaded.source}\nexport { History };` }
            : loaded;
    },
});
const { History } = await import(target);
const { store } = await import(new URL("../web/store.js", import.meta.url).href);

loader.deregister();
after(() => {
    page.dispatchEvent(new Event("pagehide"));

    for (const [key, descriptor] of descriptors) {
        if (descriptor) {
            Object.defineProperty(globalThis, key, descriptor);
        } else {
            Reflect.deleteProperty(globalThis, key);
        }
    }
});

const owner = { id: "owner", role: "owner" };
const boundary: Row = { id: 100, kind: "compaction", summary: "Current context" };
const active: Row = { id: 101, kind: "user", text: "Current message" };
const old: Row = { id: 90, kind: "user", text: "Earlier message" };
const view = (id = 1, first = boundary) => ({
    ...store.state.view,
    conversation: { id },
    order: [first.id, active.id],
    entries: new Map([
        [first.id, first],
        [active.id, active],
    ]),
});

function show() {
    store.set({
        me: owner,
        conversationId: 1,
        privateId: null,
        missing: null,
        view: view(),
        history: null,
    });
}

function history(keepPlace: () => void): Template {
    return History({
        firstId: boundary.id,
        conversationId: 1,
        results: new Map(),
        keepPlace,
    });
}

function click(keepPlace: () => void) {
    return history(keepPlace).values.find((value) => typeof value === "function")!();
}

test("retained history publishes in its current context, without duplicating active rows", async (t) => {
    show();
    let complete!: (response: Response) => void;
    let kept = 0;

    t.mock.method(globalThis, "fetch", (url: unknown) => {
        assert.equal(url, "/api/c/1/history?before=100");

        return new Promise<Response>((resolve) => {
            complete = resolve;
        });
    });
    const pending = click(() => kept++);

    assert.equal(store.state.history, null);
    // A regular streaming update is not a new context and must not invalidate the read.
    store.set({ view: view() });
    complete(Response.json([old, boundary, active]));
    await pending;
    assert.equal(kept, 1);
    assert.deepEqual(store.state.history, [old]);
    const loadedItems = history(() => {}).values.find(Array.isArray)!;

    assert.equal(
        loadedItems.filter((item: any) => item.entry?.id === old.id).length,
        1,
        "the retained row is rendered once before it becomes active",
    );

    // An update can promote a retained entry into the active context after it was loaded.
    store.set({
        view: {
            ...store.state.view,
            entries: new Map([...store.state.view.entries, [old.id, old]]),
        },
    });
    const items = history(() => {}).values.find(Array.isArray)!;

    assert.equal(items.length, 0, "rendering filters entries that became active after loading");
    store.set({ view: view(1, { id: 120, kind: "reset" }) });
    assert.equal(store.state.history, null, "a new context also clears already-loaded history");
});

test("delayed History responses cannot cross route, user, private-view or context boundaries", async (t) => {
    const cases: [string, () => void][] = [
        ["another conversation", () => store.set({ conversationId: 2, view: view(2) })],
        [
            "leave and return to the same conversation",
            () => {
                store.set({ conversationId: 2, view: view(2) });
                store.set({ conversationId: 1, view: view() });
            },
        ],
        ["reset", () => store.set({ view: view(1, { id: 110, kind: "reset" }) })],
        ["compaction", () => store.set({ view: view(1, { ...boundary, id: 120 }) })],
        [
            "context cleared then restored",
            () => {
                store.set({ view: { ...view(), order: [], entries: new Map() } });
                store.set({ view: view() });
            },
        ],
        ["another user", () => store.set({ me: { id: "guest", role: "guest" } })],
        ["same user changed scope", () => store.set({ me: { ...owner, projectAccess: {} } })],
        [
            "private Herdr view",
            () =>
                store.set({
                    conversationId: null,
                    privateId: "pane",
                    view: { ...view(), conversation: null },
                }),
        ],
    ];

    for (const [name, change] of cases) {
        await t.test(name, async (t) => {
            show();
            let complete!: (response: Response) => void;
            let kept = 0;

            t.mock.method(
                globalThis,
                "fetch",
                () =>
                    new Promise<Response>((resolve) => {
                        complete = resolve;
                    }),
            );
            const pending = click(() => kept++);

            change();
            complete(Response.json([old]));
            await pending;
            assert.equal(store.state.history, null);
            assert.equal(kept, 0, "a stale response must not change the current reader's scroll");
        });
    }
});

test("a retained outgoing History click cannot read the newly selected conversation", async (t) => {
    show();
    const onClick = history(() => assert.fail("stale scroll")).values.find(
        (value) => typeof value === "function",
    )!;
    let requests = 0;

    t.mock.method(globalThis, "fetch", () => {
        requests++;

        return Promise.resolve(Response.json([old]));
    });
    store.set({ conversationId: 2, view: view(2) });
    await onClick();
    assert.equal(requests, 0);
    assert.equal(store.state.history, null);
});
