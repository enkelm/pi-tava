// The public asset loader owns download/compile reuse and idle startup admission. These tests
// use actual WASM compilation and observable fetches, not a mocked cache or GPU readiness.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";

const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const first = "0123456789abcdef/index.html";
const second = "fedcba9876543210/index.html";
let fixtureId = 0;

async function fixture(t: TestContext, mime = "application/wasm") {
    // Each import models a separate app page/module cache, without production reset hooks.
    const loader = await import(
        new URL(`../web/terminal-renderer-assets.js?page=${fixtureId++}`, import.meta.url).href
    );
    const requests: { url: string; init: RequestInit }[] = [];
    let entry = first;
    let fetchWasm = () =>
        Promise.resolve(new Response(wasm, { headers: { "content-type": mime } }));

    t.mock.method(globalThis, "fetch", (url: string, init: RequestInit) => {
        requests.push({ url, init });

        if (url === "/herdr-renderer/build.json") {
            return Promise.resolve(Response.json({ schema: 2, kind: "live-terminal", entry }));
        }

        assert.match(url, /^\/herdr-renderer\/[a-f0-9]{16}\/pkg\/herdr_renderer_bg\.wasm$/);

        return fetchWasm();
    });
    // Preloading must not instantiate WASM or create a hidden graphics instance.
    t.mock.method(WebAssembly, "instantiate", () => assert.fail("preload instantiated WASM"));
    t.mock.method(WebAssembly, "instantiateStreaming", () =>
        assert.fail("preload instantiated WASM"),
    );

    return {
        loadTerminalRenderer: loader.loadTerminalRenderer,
        startTerminalRendererPrefetch: loader.startTerminalRendererPrefetch,
        requests,
        set entry(value: string) {
            entry = value;
        },
        set fetchWasm(value: () => Promise<Response>) {
            fetchWasm = value;
        },
        get downloads() {
            return requests.filter(({ url }) => url.endsWith(".wasm"));
        },
    };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("preload, concurrent entry and renderer retries reuse one download and compiled module", async (t) => {
    for (const mime of ["application/wasm", "application/octet-stream"]) {
        await t.test(mime, async (t) => {
            const f = await fixture(t, mime);
            let finish!: (response: Response) => void;

            f.fetchWasm = () => new Promise((resolve) => (finish = resolve));
            const preload = f.loadTerminalRenderer({ background: true });
            const entry = f.loadTerminalRenderer();

            await flush();
            assert.equal(f.downloads.length, 1);
            finish(new Response(wasm, { headers: { "content-type": mime } }));
            const [loaded, joined] = await Promise.all([preload, entry]);
            const retry = await f.loadTerminalRenderer();

            assert.ok(loaded.module instanceof WebAssembly.Module);
            assert.equal(joined.module, loaded.module);
            assert.equal(retry.module, loaded.module);
            assert.equal(f.downloads.length, 1);
            assert.equal(f.requests.filter(({ url }) => url.endsWith("build.json")).length, 2);
            assert.equal(f.requests[0]?.init.cache, "no-store");
        });
    }
});

test("a cancelled mount does not cancel shared assets, and an updated manifest selects a new module", async (t) => {
    const f = await fixture(t);
    const controller = new AbortController();
    let finish!: (response: Response) => void;

    f.fetchWasm = () => new Promise((resolve) => (finish = resolve));
    const abandoned = f.loadTerminalRenderer({ signal: controller.signal });
    const cancelled = assert.rejects(abandoned, { name: "AbortError" });
    const active = f.loadTerminalRenderer();

    await flush();
    controller.abort();
    await cancelled;
    assert.equal(f.downloads[0]?.init.signal?.aborted, false);
    finish(new Response(wasm, { headers: { "content-type": "application/wasm" } }));
    const original = await active;

    f.entry = second;
    f.fetchWasm = () => Promise.resolve(new Response(wasm));
    const replacement = await f.loadTerminalRenderer();

    assert.equal(replacement.entry, `/herdr-renderer/${second}`);
    assert.notEqual(replacement.module, original.module);
    assert.equal(f.downloads.length, 2);
    f.entry = first;
    assert.equal((await f.loadTerminalRenderer()).module, original.module);
    assert.equal(f.downloads.length, 2, "an existing old revision remains reusable");
});

test("failed preload is not poisoned and cold loading gets a separate bounded transfer budget", async (t) => {
    const f = await fixture(t);

    f.entry = "../not-a-build/index.html";
    await assert.rejects(f.loadTerminalRenderer({ background: true }), /incompatible/);
    assert.equal(f.downloads.length, 0, "an invalid manifest cannot nominate an asset URL");
    f.entry = first;
    f.fetchWasm = () => Promise.resolve(new Response(new Uint8Array([0])));
    await assert.rejects(f.loadTerminalRenderer({ background: true }), WebAssembly.CompileError);
    f.fetchWasm = () => Promise.resolve(new Response(null, { status: 503 }));
    await assert.rejects(f.loadTerminalRenderer({ background: true }));
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let finish!: (response: Response) => void;

    f.fetchWasm = () => new Promise((resolve) => (finish = resolve));
    const retry = f.loadTerminalRenderer();

    await flush();
    t.mock.timers.tick(21_000);
    finish(new Response(wasm));
    assert.ok((await retry).module instanceof WebAssembly.Module);
    assert.equal(f.downloads.length, 3);
    f.entry = second;
    f.fetchWasm = () => new Promise(() => {});
    const timedOut = assert.rejects(f.loadTerminalRenderer(), /timed out/);

    await flush();
    t.mock.timers.tick(120_000);
    await timedOut;
    assert.equal(f.downloads.at(-1)?.init.signal?.aborted, true);
});

test("app startup waits for a visible online owner and cancels queued preload on departure or access loss", async (t) => {
    const f = await fixture(t);
    const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
    const window = new EventTarget();
    const navigator = { onLine: true };
    const descriptors = new Map<string, PropertyDescriptor | undefined>();

    for (const [name, value] of Object.entries({ document, window, navigator })) {
        descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, { configurable: true, value });
    }

    let stop = () => {};

    t.after(() => {
        stop();

        for (const [name, descriptor] of descriptors) {
            if (descriptor) {
                Object.defineProperty(globalThis, name, descriptor);
            } else {
                Reflect.deleteProperty(globalThis, name);
            }
        }
    });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    type Person = { id: string; role: string };
    const listeners = new Set<() => void>();
    const store = {
        state: { me: null as Person | null },
        subscribe(listener: () => void) {
            listeners.add(listener);

            return () => listeners.delete(listener);
        },
    };

    const setOwner = (me: Person | null) => {
        store.state.me = me;
        listeners.forEach((listener) => listener());
    };

    const tick = async () => {
        t.mock.timers.tick(500);
        await flush();
    };

    stop = f.startTerminalRendererPrefetch(store);

    await tick();
    setOwner({ id: "guest", role: "guest" });
    await tick();
    assert.equal(f.requests.length, 0);
    setOwner({ id: "owner", role: "owner" });
    setOwner(null);
    await tick();
    assert.equal(f.requests.length, 0, "sign-out cancels queued idle work");
    setOwner({ id: "owner", role: "owner" });
    window.dispatchEvent(new Event("pagehide"));
    await tick();
    assert.equal(f.requests.length, 0, "departed pages cannot start background work");
    document.visibilityState = "hidden";
    window.dispatchEvent(new Event("pageshow"));
    await tick();
    document.visibilityState = "visible";
    navigator.onLine = false;
    document.dispatchEvent(new Event("visibilitychange"));
    await tick();
    assert.equal(f.requests.length, 0);
    navigator.onLine = true;
    window.dispatchEvent(new Event("online"));
    await tick();
    await flush();
    const entry = await f.loadTerminalRenderer();

    assert.ok(entry.module instanceof WebAssembly.Module);
    assert.equal(f.downloads.length, 1, "foreground entry shares the startup download");
    listeners.forEach((listener) => listener());
    await tick();
    assert.equal(f.downloads.length, 1, "ordinary store updates do not preload again");
});
