// Authoring gate: the real browser store owns whether its event transport survives app suspension.
// A stand-in network records opens, aborts and stale deliveries; it does not implement suspension.
// UI tests cannot reliably background an installed PWA. No production seams or server are needed.
import assert from "node:assert/strict";
import { test } from "node:test";

function storage() {
    const values = new Map<string, string>();

    return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, String(value)),
        removeItem: (key: string) => values.delete(key),
    };
}

test("hidden pages stop live transports and resume once with fresh state", async (t) => {
    for (const mode of ["stream", "poll"]) {
        await t.test(mode, async (t) => {
            const page = new EventTarget();
            const document = Object.assign(new EventTarget(), {
                visibilityState: "hidden",
                documentElement: { dataset: {} },
                querySelector: () => ({ content: "loaded-web" }),
            });
            const navigator = { onLine: true };
            const localStorage = storage();
            const streams: Stream[] = [];
            const polls: {
                url: string;
                signal: AbortSignal;
                resolve: (response: Response) => void;
            }[] = [];
            const closed: string[] = [];
            let releaseOptions: RequestInit | undefined;
            let reloads = 0;

            class Stream {
                handlers = new Map<string, (event: { data: string }) => void>();
                closed = false;
                onopen?: () => void;
                onerror?: () => Promise<void>;
                readyState = 2;
                static CLOSED = 2;
                url: string;

                constructor(url: string) {
                    this.url = url;
                    streams.push(this);
                }

                addEventListener(name: string, handler: (event: { data: string }) => void) {
                    this.handlers.set(name, handler);
                }

                emit(name: string, data: unknown) {
                    this.handlers.get(name)?.({ data: JSON.stringify(data) });
                }

                close() {
                    this.closed = true;
                }
            }

            if (mode === "poll") {
                localStorage.setItem("pocket.transport", `poll:${Date.now()}`);
            }

            const globals = {
                document,
                navigator,
                localStorage,
                sessionStorage: storage(),
                location: {
                    pathname: "/s/1",
                    hostname: "example.test",
                    href: "https://example.test/s/1",
                    reload: () => reloads++,
                },
                history: { state: null },
                addEventListener: page.addEventListener.bind(page),
                removeEventListener: page.removeEventListener.bind(page),
                matchMedia: () => ({ matches: false, addEventListener() {} }),
                EventSource: Stream,
            };
            const descriptors = new Map<string, PropertyDescriptor | undefined>();

            for (const [name, value] of Object.entries(globals)) {
                descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
                Object.defineProperty(globalThis, name, { configurable: true, value });
            }

            t.after(() => {
                page.dispatchEvent(new Event("pagehide"));

                for (const [name, descriptor] of descriptors) {
                    if (descriptor) {
                        Object.defineProperty(globalThis, name, descriptor);
                    } else {
                        Reflect.deleteProperty(globalThis, name);
                    }
                }
            });
            t.mock.timers.enable({ apis: ["setTimeout"] });
            t.mock.method(globalThis, "fetch", (url: string, options: RequestInit = {}) => {
                if (url.includes("close=1")) {
                    closed.push(url);

                    return Promise.resolve(Response.json({}));
                }

                if (url === "/api/c/2/lsp") {
                    releaseOptions = options;

                    return Promise.resolve(Response.json({}));
                }

                if (url === "/api/visibility" || url === "/api/me") {
                    return Promise.resolve(Response.json({}));
                }

                assert.ok(url.startsWith("/api/poll?"), `unexpected fetch ${url}`);
                assert.ok(options.signal);
                const signal = options.signal;

                // A response already being delivered may outlive abort. The real store must fence it.
                return new Promise<Response>((resolve) => {
                    polls.push({ url, signal, resolve });
                });
            });
            // Query imports model separate loaded tabs, without source rewriting.
            const { api, connect, start, store, drafts } = await import(
                new URL(`../web/store.js?lifecycle=${mode}`, import.meta.url).href
            );

            if (mode === "stream") {
                await api("c/2/lsp", { action: "close", session: "leaving" }, { keepalive: true });
                assert.equal(
                    releaseOptions?.keepalive,
                    true,
                    "lease cleanup fetch must survive page unloading",
                );
            }

            await start();
            assert.equal(
                streams.length + polls.length,
                0,
                "initial hidden load does not start networking",
            );
            store.set({ me: { id: "owner", role: "owner" }, server: { collab: 2 } });
            drafts.set(1, "Unsent draft");
            connect();
            assert.equal(
                streams.length + polls.length,
                0,
                "hidden navigation cannot open a transport",
            );
            document.visibilityState = "visible";
            document.dispatchEvent(new Event("visibilitychange"));

            if (mode === "stream") {
                streams[0]!.onopen?.();
                streams[0]!.emit("hello", {
                    user: { id: "owner", role: "owner" },
                    server: { collab: 2, webRevision: "loaded-web" },
                });
                streams[0]!.emit("sessions", [{ id: 1, title: "Before sleep" }]);
            } else {
                polls[0]!.resolve(
                    Response.json({
                        session: "first",
                        events: [
                            {
                                seq: 1,
                                event: "hello",
                                data: {
                                    user: { id: "owner", role: "owner" },
                                    server: { collab: 2, webRevision: "loaded-web" },
                                },
                            },
                            { seq: 2, event: "sessions", data: [{ id: 1, title: "Before sleep" }] },
                        ],
                    }),
                );
                await new Promise<void>((resolve) => setImmediate(resolve));
                assert.equal(polls.length, 2, "a visible poll acknowledges its first batch");
            }

            if (mode === "stream") {
                await t.test(
                    "chat deltas replace native status without duplicating, reordering or renotifying",
                    () => {
                        const stream = streams[0]!;

                        store.set({ users: [{ id: "owner", name: "Owner", role: "owner" }] });
                        const human = {
                            id: "question",
                            userId: "owner",
                            name: "Owner",
                            text: "@PiP help",
                            at: 1,
                            pip: { status: "queued" },
                        };

                        stream.emit("chat", { conversationId: 1, full: true, messages: [human] });
                        stream.emit("chat", {
                            conversationId: 1,
                            messages: [{ ...human, pip: { status: "working" } }],
                        });
                        assert.equal(store.state.chat[0].pip.status, "working");
                        stream.emit("chat", {
                            conversationId: 1,
                            messages: [
                                {
                                    id: "reply",
                                    userId: "pip",
                                    name: "PiP",
                                    text: "A shared answer",
                                    at: 2,
                                    service: "pip",
                                },
                                { ...human, pip: { status: "answered", replyId: "reply" } },
                            ],
                        });
                        assert.deepEqual(
                            store.state.chat.map((message: { id: string }) => message.id),
                            ["question", "reply"],
                        );
                        assert.equal(store.state.chat[0].pip.status, "answered");
                        const notices = store.state.notices.length;

                        stream.emit("chat", {
                            conversationId: 1,
                            messages: [{ ...human, pip: { status: "answered", replyId: "reply" } }],
                        });
                        assert.equal(store.state.notices.length, notices);
                        stream.emit("chat", {
                            conversationId: 2,
                            messages: [{ ...human, pip: { status: "failed" } }],
                        });
                        assert.equal(store.state.chat[0].pip.status, "answered");
                    },
                );
            }

            document.visibilityState = "hidden";
            document.dispatchEvent(new Event("visibilitychange"));
            assert.ok(
                mode === "stream" ? streams[0]!.closed : polls[1]!.signal.aborted,
                "backgrounding must stop the live transport, not merely report away presence",
            );
            const count = streams.length + polls.length;

            // Navigation/reconnect requests and delayed old events must not wake a hidden page.
            store.set({ conversationId: 2 });
            connect();
            streams[0]?.emit("sessions", [{ id: 1, title: "Stale" }]);
            streams[0]?.emit("hello", { server: { webRevision: "retired-web" } });
            await new Promise<void>((resolve) => setImmediate(resolve));
            t.mock.timers.tick(60_000);
            assert.equal(streams.length + polls.length, count);
            assert.equal(store.state.sessions[0].title, "Before sleep");
            assert.equal(drafts.get(1), "Unsent draft", "suspension preserves drafts");
            assert.equal(reloads, 0, "unchanged and retired hellos must not reload the document");

            document.visibilityState = "visible";
            document.dispatchEvent(new Event("visibilitychange"));
            document.dispatchEvent(new Event("visibilitychange"));
            assert.equal(
                streams.length + polls.length,
                count + 1,
                "resume opens exactly one fresh transport",
            );

            if (mode === "poll") {
                polls[1]!.resolve(
                    Response.json({ error: "Expired old connection" }, { status: 401 }),
                );
                await new Promise<void>((resolve) => setImmediate(resolve));
                assert.equal(
                    store.state.me.id,
                    "owner",
                    "old auth failure cannot sign out a resumed tab",
                );
                assert.equal(
                    store.state.sessions[0].title,
                    "Before sleep",
                    "old response cannot overwrite the resumed tab",
                );
                assert.equal(
                    streams.length + polls.length,
                    count + 1,
                    "old response cannot restart its loop",
                );
            }

            if (mode === "stream") {
                assert.match(streams.at(-1)!.url, /&c=2$/);
                streams.at(-1)!.onopen?.();
                streams.at(-1)!.emit("hello", {
                    user: { id: "owner", role: "owner" },
                    server: { collab: 2, webRevision: "changed-while-asleep" },
                });
                streams.at(-1)!.emit("sessions", [{ id: 2, title: "While asleep" }]);
            } else {
                const latest = polls.at(-1)!;

                assert.match(latest.url, /&c=2$/);
                assert.ok(
                    !latest.url.includes("session="),
                    "resume requests a full snapshot, not stale deltas",
                );
                assert.equal(closed.length, 1, "the old server polling session is released");
                latest.resolve(
                    Response.json({
                        session: "resumed",
                        events: [
                            {
                                seq: 1,
                                event: "hello",
                                data: {
                                    user: { id: "owner", role: "owner" },
                                    server: { collab: 2, webRevision: "changed-while-asleep" },
                                },
                            },
                            { seq: 2, event: "sessions", data: [{ id: 2, title: "While asleep" }] },
                        ],
                    }),
                );
                await new Promise<void>((resolve) => setImmediate(resolve));
            }

            assert.equal(store.state.sessions[0].title, "While asleep");
            t.mock.timers.tick(200);
            assert.equal(reloads, 1, "resume reconciles a web edit whose reload event was missed");

            if (mode === "stream") {
                streams.at(-1)!.emit("reload", { file: "file-language.js" });
                streams.at(-1)!.emit("reload", { file: "file-language.js" });
                t.mock.timers.tick(200);
                assert.equal(
                    reloads,
                    2,
                    "a later update retries a cancelled reload while pending duplicates coalesce",
                );
            }

            // A network failure may have queued a reconnect before the app is backgrounded.
            if (mode === "stream") {
                await streams.at(-1)!.onerror?.();
            } else {
                polls.at(-1)!.resolve(Response.json({}, { status: 503 }));
                await new Promise<void>((resolve) => setImmediate(resolve));
            }

            document.visibilityState = "hidden";
            document.dispatchEvent(new Event("visibilitychange"));
            const failedCount = streams.length + polls.length;

            t.mock.timers.tick(60_000);
            await new Promise<void>((resolve) => setImmediate(resolve));
            assert.equal(streams.length + polls.length, failedCount, "failed retries stay asleep");
            navigator.onLine = false;
            document.visibilityState = "visible";
            document.dispatchEvent(new Event("visibilitychange"));
            assert.equal(
                streams.length + polls.length,
                failedCount,
                "visible but offline stays disconnected",
            );
            navigator.onLine = true;
            page.dispatchEvent(new Event("online"));
            page.dispatchEvent(new Event("online"));
            assert.equal(
                streams.length + polls.length,
                failedCount + 1,
                "online resumes only once",
            );
            navigator.onLine = false;
            page.dispatchEvent(new Event("offline"));
            assert.ok(mode === "stream" ? streams.at(-1)!.closed : polls.at(-1)!.signal.aborted);
            document.visibilityState = "hidden";
            navigator.onLine = true;
            page.dispatchEvent(new Event("online"));
            assert.equal(
                streams.length + polls.length,
                failedCount + 1,
                "online cannot wake a hidden page",
            );
            document.visibilityState = "visible";
            document.dispatchEvent(new Event("visibilitychange"));
            const beforeCache = streams.length + polls.length;
            const cachedPoll = polls.at(-1);

            page.dispatchEvent(new Event("pagehide"));
            assert.ok(mode === "stream" ? streams.at(-1)!.closed : polls.at(-1)!.signal.aborted);
            page.dispatchEvent(new Event("online"));
            connect();
            assert.equal(
                streams.length + polls.length,
                beforeCache,
                "pagehide prevents reopening before pageshow, even if visibility still says visible",
            );
            page.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
            page.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
            assert.equal(
                streams.length + polls.length,
                beforeCache + 1,
                "BFCache restoration reconnects exactly once",
            );

            if (mode === "poll") {
                cachedPoll!.resolve(
                    Response.json({
                        session: "stale",
                        events: [
                            {
                                seq: 1,
                                event: "sessions",
                                data: [{ id: 1, title: "Stale delivery" }],
                            },
                        ],
                    }),
                );
                await new Promise<void>((resolve) => setImmediate(resolve));
                assert.equal(
                    store.state.sessions[0].title,
                    "While asleep",
                    "old data cannot overwrite the restored tab",
                );
                assert.equal(streams.length + polls.length, beforeCache + 1);
            }

            document.visibilityState = "hidden";
            document.dispatchEvent(new Event("visibilitychange"));
            store.set({ me: null });
            const signedOutCount = streams.length + polls.length;

            document.visibilityState = "visible";
            document.dispatchEvent(new Event("visibilitychange"));
            assert.equal(
                streams.length + polls.length,
                signedOutCount,
                "resuming cannot reconnect a signed-out user",
            );
        });
    }
});

test("startup reconciles the document revision and a late hello cannot reopen a departed page", async (t) => {
    const page = new EventTarget();
    const document = Object.assign(new EventTarget(), {
        visibilityState: "visible",
        documentElement: { dataset: {} },
        querySelector: () => ({ content: "document-loaded" }),
    });
    let reloads = 0;
    let opens = 0;
    let reads = 0;
    let finishHello: ((response: Response) => void) | undefined;
    const globals = {
        document,
        navigator: { onLine: true },
        localStorage: storage(),
        sessionStorage: storage(),
        location: {
            pathname: "/",
            hostname: "localhost",
            href: "http://localhost/",
            reload: () => reloads++,
        },
        history: { state: null },
        addEventListener: page.addEventListener.bind(page),
        removeEventListener: page.removeEventListener.bind(page),
        matchMedia: () => ({ matches: false, addEventListener() {} }),
        EventSource: class {
            constructor() {
                opens++;
            }
            addEventListener() {}
            close() {}
        },
    };
    const descriptors = new Map<string, PropertyDescriptor | undefined>();

    for (const [name, value] of Object.entries(globals)) {
        descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, { configurable: true, value });
    }

    t.after(() => {
        page.dispatchEvent(new Event("pagehide"));

        for (const [name, descriptor] of descriptors) {
            if (descriptor) {
                Object.defineProperty(globalThis, name, descriptor);
            } else {
                Reflect.deleteProperty(globalThis, name);
            }
        }
    });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    t.mock.method(globalThis, "fetch", (url: string) => {
        assert.equal(url, "/api/me");
        reads++;

        return new Promise<Response>((resolve) => {
            finishHello = resolve;
        });
    });
    const { start } = await import(
        new URL("../web/store.js?lifecycle=startup", import.meta.url).href
    );
    const pending = start();

    await start();
    assert.equal(reads, 1, "concurrent startup requests share the initial read");
    assert.ok(finishHello);
    page.dispatchEvent(new Event("pagehide"));
    finishHello(
        Response.json({
            user: { id: "owner", role: "owner" },
            server: { webRevision: "changed-before-first-hello" },
        }),
    );
    await pending;
    assert.equal(opens, 0, "a late startup response cannot undo pagehide");
    t.mock.timers.tick(200);
    assert.equal(reloads, 1, "an edit during initial load is detected against the HTML revision");
    page.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    assert.equal(opens, 1);
});
