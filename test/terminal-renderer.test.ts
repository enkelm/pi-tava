import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";

const modulePath: string = "../web/terminal-renderer-bridge.js";
const { createTerminalRendererBridge } = await import(modulePath);
const origin = "https://coop.example";
const session = "random-session-for-this-iframe";
const secret = "PRIVATE_TERMINAL_SENTINEL_7a13";

type Message = {
    type: string;
    session: string;
    sequence: number;
    fence: string;
    payload?: string;
    module?: WebAssembly.Module;
};

type Status = { phase: string; fence: string; message?: string };

function fixture(t: TestContext, post?: (message: Message) => void) {
    const frame = {};
    const messages: Message[] = [];
    const statuses: Status[] = [];
    const bridge = createTerminalRendererBridge({
        source: () => frame,
        origin,
        session,
        post: (message: Message) => {
            messages.push(message);
            post?.(message);
        },
        onStatus: (status: Status) => statuses.push(status),
    });
    const receive = (data: object) => bridge.receive({ origin, source: frame, data });
    const ready = () => receive({ type: "gpui-ready", session });
    const painted = (message: Message) =>
        receive({
            type: "gpui-painted",
            session,
            sequence: message.sequence,
            fence: message.fence,
        });

    t.after(() => bridge.dispose());

    return { bridge, frame, messages, statuses, receive, ready, painted };
}

function presentation(text: string, asset = "image-1") {
    return {
        surface: {
            boot_id: "boot-1",
            projection_revision: "9007199254740999",
            frame: { width: 1, height: 1, cells: [{ symbol: text }] },
            images: [{ image_id: asset, cell_x: 0, cell_y: 0 }],
        },
        images: [{ id: asset, rgba: [1, 2, 3, 255], width: 1, height: 1 }],
    };
}

function last<T>(values: T[]): T {
    const value = values.at(-1);

    assert.notEqual(value, undefined);

    return value!;
}

test("only the exact iframe, origin and session can change bridge state", (t) => {
    const f = fixture(t);
    const pending = presentation(secret);

    f.bridge.present(pending, "epoch-1");
    const before = f.statuses.length;

    for (const event of [
        { origin: "https://foreign.example", source: f.frame },
        { origin, source: {} },
        { origin, source: null },
    ]) {
        const data = Object.defineProperty({}, "session", {
            get() {
                assert.fail("Untrusted message data must not be read");
            },
        });

        assert.equal(f.bridge.receive({ ...event, data }), false);
    }

    for (const type of ["gpui-bootstrap", "gpui-ready", "gpui-painted", "gpui-error"]) {
        assert.equal(f.receive({ type, session: "a-different-iframe-session" }), false);
    }

    assert.equal(f.messages.length, 0);
    assert.equal(f.statuses.length, before);
    assert.equal(f.ready(), true);
    assert.equal(f.messages.length, 1);
    assert.equal(f.messages[0]?.type, "gpui-present");
    assert.deepEqual(JSON.parse(f.messages[0]?.payload || "null"), pending);
    assert.equal(last(f.statuses).phase, "loading", "ready handshake is not a paint receipt");
    assert.equal(f.ready(), false, "duplicate handshakes cannot refill the wire queue");
    const sent = last(f.messages);

    assert.equal(
        f.receive({
            type: "gpui-painted",
            session,
            sequence: sent.sequence + 1,
            fence: sent.fence,
        }),
        false,
    );
    assert.equal(f.painted(sent), true);
    assert.deepEqual(last(f.statuses), { phase: "ready", fence: "epoch-1" });
});

test("an unattached iframe cannot authenticate a null-source handshake", (t) => {
    const messages: Message[] = [];
    const statuses: Status[] = [];
    const bridge = createTerminalRendererBridge({
        source: () => null,
        origin,
        session,
        post: (message: Message) => messages.push(message),
        onStatus: (status: Status) => statuses.push(status),
    });

    t.after(() => bridge.dispose());
    bridge.present(presentation(secret), "epoch-1");
    assert.equal(
        bridge.receive({ origin, source: null, data: { type: "gpui-ready", session } }),
        false,
    );
    assert.equal(messages.length, 0);
    assert.deepEqual(statuses, [
        { phase: "loading", fence: "" },
        { phase: "loading", fence: "epoch-1" },
    ]);
});

test("bursts keep only the latest full image-bearing presentation and serialize only sends", (t) => {
    const f = fixture(t);
    const serialized: string[] = [];
    const frame = (label: string) => ({
        toJSON() {
            serialized.push(label);

            return presentation(label, `asset-${label}`);
        },
    });

    f.bridge.present(frame("replaced-before-ready"), "same-fence");
    f.bridge.present(frame("first-sent"), "same-fence");
    assert.deepEqual(serialized, []);
    f.ready();
    const first = last(f.messages);

    for (let index = 0; index < 500; index++) {
        f.bridge.present(frame(`burst-${index}`), "same-fence");
    }

    assert.equal(f.messages.length, 1, "an unacknowledged scene bounds the outgoing queue");
    assert.deepEqual(serialized, ["first-sent"]);
    assert.equal(f.painted(first), true);
    assert.equal(f.messages.length, 2);
    const latest = last(f.messages);

    assert.equal(latest.sequence, first.sequence + 1);
    assert.deepEqual(
        JSON.parse(latest.payload || "null"),
        presentation("burst-499", "asset-burst-499"),
    );
    assert.deepEqual(serialized, ["first-sent", "burst-499"]);
    assert.deepEqual(last(f.statuses), { phase: "ready", fence: "same-fence" });
    assert.equal(f.painted(first), false, "duplicate paint receipts cannot release another slot");
    assert.equal(f.messages.length, 2);
    assert.equal(f.painted(latest), true);
    assert.equal(f.messages.length, 2);
});

test("fence changes hide immediately and one acknowledged clear protects all newer epochs", (t) => {
    const f = fixture(t);

    f.ready();
    f.bridge.present(presentation("old-visible"), "epoch-1");
    const old = last(f.messages);

    f.painted(old);
    assert.equal(last(f.statuses).phase, "ready");
    f.bridge.present(presentation("old-inflight"), "epoch-1");
    const cancelled = last(f.messages);

    f.bridge.present(presentation("new-frame"), "epoch-2");
    const clear = last(f.messages);

    assert.deepEqual(last(f.statuses), { phase: "loading", fence: "epoch-2" });
    assert.equal(clear.type, "gpui-clear");
    assert.equal(clear.sequence, cancelled.sequence + 1);
    assert.equal(clear.fence, "epoch-2");
    assert.equal(clear.payload, undefined);

    for (let index = 3; index <= 500; index++) {
        f.bridge.present(presentation(`epoch-${index}`), `epoch-${index}`);
    }

    assert.equal(f.messages.length, 3, "rapid fence changes cannot queue repeated clears");
    assert.equal(f.painted(cancelled), false);
    assert.equal(f.painted(old), false);
    assert.equal(
        f.receive({
            type: "gpui-error",
            session,
            sequence: cancelled.sequence,
            fence: cancelled.fence,
            message: secret,
        }),
        false,
    );
    assert.deepEqual(last(f.statuses), { phase: "loading", fence: "epoch-500" });
    assert.equal(f.messages.length, 3);
    assert.equal(f.painted(clear), true);
    const latest = last(f.messages);

    assert.equal(latest.type, "gpui-present");
    assert.equal(latest.sequence, clear.sequence + 1);
    assert.equal(latest.fence, "epoch-500");
    assert.deepEqual(JSON.parse(latest.payload || "null"), presentation("epoch-500"));
    assert.equal(last(f.statuses).phase, "loading", "clear receipts never enable the iframe");
    assert.equal(
        f.receive({ type: "gpui-painted", session, sequence: latest.sequence, fence: "epoch-2" }),
        false,
    );
    assert.equal(f.painted(latest), true);
    assert.deepEqual(last(f.statuses), { phase: "ready", fence: "epoch-500" });
});

test("explicit clear discards pending content, deduplicates barriers and preserves readiness", (t) => {
    const f = fixture(t);

    f.ready();
    f.bridge.present(presentation("inflight"), "epoch-1");
    const old = last(f.messages);

    f.bridge.present(presentation("must-be-discarded"), "epoch-1");
    f.bridge.clear("hidden-epoch");
    const clear = last(f.messages);

    assert.equal(clear.type, "gpui-clear");
    assert.deepEqual(last(f.statuses), { phase: "loading", fence: "hidden-epoch" });

    for (let index = 0; index < 100; index++) {
        f.bridge.clear("hidden-epoch");
    }

    assert.equal(f.messages.length, 2);
    assert.equal(f.painted(old), false);
    f.painted(clear);
    assert.equal(f.messages.length, 2, "discarded pending content cannot return after clearing");
    f.bridge.clear("hidden-epoch");
    assert.equal(f.messages.length, 2, "an already blank fence needs no repeated wire clear");
    f.bridge.present(presentation("resumed"), "hidden-epoch");
    assert.equal(f.messages.length, 3, "transport readiness survives clear without a handshake");
    const resumed = last(f.messages);

    assert.equal(resumed.type, "gpui-present");
    f.painted(resumed);
    f.bridge.clear("hidden-epoch");
    assert.equal(
        last(f.messages).type,
        "gpui-clear",
        "same-fence clear still removes visible pixels",
    );
    assert.equal(last(f.statuses).phase, "loading");
});

test("disposal prevents sends, status updates and late acknowledgements", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const f = fixture(t);

    f.ready();
    f.bridge.present(presentation("inflight"), "epoch-1");
    const old = last(f.messages);

    f.bridge.present(presentation("queued"), "epoch-1");
    f.bridge.dispose();
    const before = structuredClone({ messages: f.messages, statuses: f.statuses });

    assert.equal(f.bridge.present(presentation(secret), "epoch-2"), false);
    assert.equal(f.bridge.clear("epoch-2"), false);
    assert.equal(f.painted(old), false);
    assert.equal(f.ready(), false);
    assert.equal(f.receive({ type: "gpui-error", session, message: secret }), false);
    t.mock.timers.tick(60_000);
    assert.deepEqual({ messages: f.messages, statuses: f.statuses }, before);
});

test("startup and paint/clear deadlines fail closed without exposing child content", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });

    for (const kind of ["startup", "paint", "clear"]) {
        const f = fixture(t);

        f.bridge.present(presentation(secret), "epoch-1");

        if (kind !== "startup") {
            f.ready();
        }

        if (kind === "clear") {
            f.bridge.clear("epoch-2");
        }

        const deadline = kind === "startup" ? 20_000 : 10_000;

        t.mock.timers.tick(deadline - 1);
        assert.equal(last(f.statuses).phase, "loading");
        t.mock.timers.tick(1);
        assert.equal(last(f.statuses).phase, "error");
        assert.equal(last(f.statuses).message, "Terminal renderer unavailable.");
        assert.equal(JSON.stringify(f.statuses).includes(secret), false);
        const before = structuredClone({ messages: f.messages, statuses: f.statuses });

        assert.equal(f.ready(), false, "a late child cannot recover a failed iframe lifecycle");
        assert.equal(f.bridge.present(presentation("late"), "epoch-3"), false);
        assert.equal(f.bridge.clear("epoch-3"), false);
        t.mock.timers.tick(60_000);
        assert.deepEqual({ messages: f.messages, statuses: f.statuses }, before);
        f.bridge.dispose();
    }
});

test("valid acknowledgements restart the deadline, but stale receipts cannot extend it", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const f = fixture(t);

    f.ready();
    f.bridge.present(presentation("first"), "epoch-1");
    const first = last(f.messages);

    f.bridge.present(presentation("next"), "epoch-1");
    t.mock.timers.tick(9_000);
    f.painted(first);
    t.mock.timers.tick(9_000);
    assert.equal(last(f.statuses).phase, "ready");
    assert.equal(f.painted(first), false);
    t.mock.timers.tick(1_000);
    assert.equal(last(f.statuses).phase, "error");
});

test("serialization failures and trusted child/post errors become one fixed redacted failure", (t) => {
    const circular: { self?: object } = {};

    circular.self = circular;

    for (const invalid of [
        null,
        [],
        "not-a-presentation",
        circular,
        { terminal: BigInt(1) },
        { toJSON: () => undefined },
        { toJSON: () => secret },
        {
            toJSON() {
                throw new Error(secret);
            },
        },
    ]) {
        const f = fixture(t);

        f.ready();
        assert.equal(f.bridge.present(invalid, "epoch-1"), false);
        assert.equal(f.messages.length, 0);
        assert.equal(last(f.statuses).phase, "error");
        assert.equal(JSON.stringify(f.statuses).includes(secret), false);
        assert.equal(f.bridge.present(presentation("after-failure"), "epoch-1"), false);
    }

    const brokenPost = fixture(t, () => {
        throw new Error(secret);
    });

    brokenPost.ready();
    assert.doesNotThrow(() => brokenPost.bridge.present(presentation(secret), "epoch-1"));
    const childError = fixture(t);

    childError.ready();
    assert.equal(
        childError.receive({ type: "gpui-error", session, message: secret, stack: secret }),
        true,
    );

    for (const f of [brokenPost, childError]) {
        assert.equal(last(f.statuses).phase, "error");
        assert.equal(last(f.statuses).message, "Terminal renderer unavailable.");
        assert.equal(JSON.stringify(f.statuses).includes(secret), false);
    }
});

test("the 32 MiB presentation cap counts UTF-8 bytes, including JSON framing", (t) => {
    const f = fixture(t);
    const limit = 32 * 1024 * 1024;
    // {"text":""} is 11 ASCII bytes; each é occupies two UTF-8 bytes.
    const text = "é".repeat((limit - 12) / 2) + "a";

    f.ready();
    assert.equal(f.bridge.present({ text }, "same-fence"), true);
    const accepted = last(f.messages);

    assert.equal(Buffer.byteLength(accepted.payload || ""), limit);
    f.painted(accepted);
    assert.equal(f.bridge.present({ text: `${text}a${secret}` }, "same-fence"), false);
    assert.equal(f.messages.length, 1, "oversize content must never be posted to the child");
    assert.equal(last(f.statuses).phase, "error");
    assert.equal(JSON.stringify(f.statuses).includes(secret), false);
});

type HostFrame = {
    source: string;
    messages: Message[];
    contentWindow: { postMessage(message: Message, targetOrigin: string): void };
};

type RendererState = {
    iframe: { current: HostFrame | null };
    source: string;
    active: boolean;
    visible: boolean;
    editorReady: boolean;
    inputReady: boolean;
    loading: boolean;
    error: boolean;
    retry(): void;
};

async function hookFixture(t: TestContext, dpr = 1) {
    const viewPath: string = "../web/terminal-renderer.js";
    const { useTerminalRenderer } = await import(viewPath);
    const window = Object.assign(new EventTarget(), {
        location: { origin },
        devicePixelRatio: dpr,
    });
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const requests: { url: string; signal: AbortSignal; resolve(response: Response): void }[] = [];
    const reports: string[] = [];
    const surface: ReturnType<typeof presentation>["surface"] & {
        panes: {
            pane_id: string;
            focused: boolean;
            rect: { x: number; y: number; width: number; height: number };
            inner_rect: { x: number; y: number; width: number; height: number };
        }[];
        popup: null | {
            terminal_id: string;
            frame: ReturnType<typeof presentation>["surface"]["frame"];
        };
    } = {
        ...presentation(secret).surface,
        panes: [
            {
                pane_id: "pane-1",
                focused: true,
                rect: { x: 0, y: 0, width: 1, height: 1 },
                inner_rect: { x: 0, y: 0, width: 1, height: 1 },
            },
        ],
        popup: null,
    };
    const options = {
        drawable: true,
        surface,
        images: presentation(secret).images,
        cw: 10,
        ch: 20,
        fontSize: 14,
        inputEpoch: 1,
        theme: {},
        report: (message: string) => reports.push(message),
    };
    // Preact owns real hook/effect scheduling. A null-rendering host supplies only
    // the iframe ref and browser messages; this does not simulate DOM/GPU painting.
    const root = { nodeType: 1, firstChild: null } as unknown as HTMLElement;
    let state: RendererState;
    let frame: HostFrame | null = null;

    function Host() {
        state = useTerminalRenderer(options);

        if (state.source !== (frame?.source || "")) {
            const messages: Message[] = [];

            frame = state.source
                ? {
                      source: state.source,
                      messages,
                      contentWindow: {
                          postMessage(message, targetOrigin) {
                              assert.equal(targetOrigin, origin);
                              messages.push(message);
                          },
                      },
                  }
                : null;
        }

        state.iframe.current = frame;

        return null;
    }

    Object.defineProperty(globalThis, "window", { configurable: true, value: window });
    t.mock.method(globalThis, "fetch", (url: string, init: RequestInit) => {
        assert.ok(init.signal);
        const signal = init.signal;

        if (url.endsWith(".wasm")) {
            return Promise.resolve(new Response(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])));
        }

        return new Promise<Response>((resolve) => requests.push({ url, signal, resolve }));
    });
    t.after(async () => {
        await act(() => render(null, root));

        if (originalWindow) {
            Object.defineProperty(globalThis, "window", originalWindow);
        } else {
            Reflect.deleteProperty(globalThis, "window");
        }
    });

    const flush = () => act(() => new Promise<void>((resolve) => setImmediate(resolve)));
    const update = () => act(() => render(h(Host, {}), root));

    const load = async (request = last(requests)) => {
        request.resolve(
            Response.json({
                schema: 2,
                kind: "live-terminal",
                entry: "0123456789abcdef/index.html",
            }),
        );
        await flush();
        await flush();
    };

    const receive = (node: HostFrame, data: object) =>
        act(() => {
            window.dispatchEvent(
                Object.assign(new Event("message"), {
                    origin,
                    source: node.contentWindow,
                    data: { ...data, session: node.source.split("#")[1] },
                }),
            );
        });
    const ready = (node: HostFrame) => receive(node, { type: "gpui-ready" });
    const painted = (node: HostFrame, message = last(node.messages)) =>
        receive(node, { type: "gpui-painted", sequence: message.sequence, fence: message.fence });

    await update();

    return {
        options,
        window,
        requests,
        reports,
        flush,
        update,
        load,
        receive,
        ready,
        painted,
        get state() {
            return state;
        },
        get frame() {
            assert.ok(frame);

            return frame;
        },
    };
}

test("the sole renderer mounts without an opt-in and clears pixels across input and visibility fences", async (t) => {
    const f = await hookFixture(t);

    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0]?.url, "/herdr-renderer/build.json");
    assert.equal(f.state.active, false);
    await f.load();
    const node = f.frame;

    assert.equal(node.source.split("#")[0], "/herdr-renderer/0123456789abcdef/index.html");

    await f.ready(node);
    const first = last(node.messages);
    const payload = JSON.parse(first.payload || "null");

    assert.deepEqual(payload.images, f.options.images);
    assert.deepEqual(payload.metrics, { cw: 10, ch: 20, fontSize: 14 });
    assert.equal(f.state.active, false, "a startup handshake does not enable blind input");
    assert.equal(f.state.inputReady, false);
    await f.painted(node);
    assert.equal(f.state.active, true);
    assert.equal(f.state.loading, false);
    f.options.inputEpoch++;
    await f.update();
    const clear = last(node.messages);

    assert.equal(clear.type, "gpui-clear");
    assert.equal(f.state.active, false);
    await f.painted(node, first);
    assert.equal(f.state.active, false, "old paint receipts cannot restore current interactivity");
    await f.painted(node, clear);
    assert.equal(last(node.messages).type, "gpui-present");
    await f.painted(node);
    assert.equal(f.state.active, true);
    f.options.drawable = false;
    await f.update();
    assert.equal(last(node.messages).type, "gpui-clear");
    assert.equal(f.state.active, false);
    await f.painted(node);
    assert.equal(f.state.active, false);
    assert.equal(f.requests.length, 1, "clearing does not reconnect or replace the renderer");
});

test("explicit retry shares startup work but replaces only the renderer session and rejects late child messages", async (t) => {
    const f = await hookFixture(t);

    assert.equal(f.requests.length, 1);
    const firstRequest = last(f.requests);

    await act(() => f.state.retry());
    assert.equal(firstRequest.signal.aborted, false, "another mount can still use shared loading");
    assert.equal(f.state.source, "");
    assert.equal(f.state.active, false);
    assert.equal(f.requests.length, 1, "concurrent startup shares the manifest check too");
    await f.load(firstRequest);
    const oldNode = f.frame;

    await f.receive(oldNode, { type: "gpui-bootstrap" });
    const sharedModule = last(oldNode.messages).module;

    assert.ok(sharedModule instanceof WebAssembly.Module);
    await f.receive(oldNode, { type: "gpui-bootstrap" });
    assert.equal(oldNode.messages.length, 1, "bootstrap sends the module only once per child");
    await f.ready(oldNode);
    await f.painted(oldNode);
    assert.equal(f.state.active, true);
    await f.receive(oldNode, { type: "gpui-error", message: secret, stack: secret });
    assert.equal(f.state.source, "");
    assert.equal(f.state.active, false);
    assert.equal(f.state.error, true);
    assert.equal(f.state.loading, false);
    assert.equal(f.state.inputReady, false);
    assert.deepEqual(f.reports, ["Terminal renderer unavailable."]);
    f.options.inputEpoch++;
    await f.update();
    await f.flush();
    assert.equal(f.requests.length, 1, "renderer failure waits for an explicit retry");
    await act(() => f.state.retry());
    assert.equal(f.state.source, "");
    assert.equal(f.state.active, false);
    assert.equal(f.state.error, false);
    assert.equal(f.state.inputReady, false);
    assert.equal(f.requests.length, 2);
    await f.load();
    const replacement = f.frame;

    assert.notEqual(replacement.source, oldNode.source);
    await f.ready(oldNode);
    await f.painted(oldNode);
    assert.equal(f.state.active, false);
    assert.equal(replacement.messages.length, 0);
    await f.receive(replacement, { type: "gpui-bootstrap" });
    assert.equal(
        last(replacement.messages).module,
        sharedModule,
        "retry reuses the compiled module",
    );
    await f.ready(replacement);
    assert.notEqual(last(replacement.messages).fence, last(oldNode.messages).fence);
    await f.painted(replacement);
    assert.equal(f.state.active, true);
    assert.equal(f.state.inputReady, true);
    assert.equal(f.requests.length, 2);
});

test("an over-budget DPR stays in error until the budget changes or an explicit retry", async (t) => {
    const f = await hookFixture(t, 3);

    f.options.surface.frame = {
        width: 200,
        height: 100,
        cells: Array.from({ length: 20_000 }, () => ({ symbol: " " })),
    };
    await f.update();
    const requestCount = f.requests.length;

    assert.equal(f.state.error, true);
    assert.equal(f.state.source, "");
    assert.equal(f.state.active, false);

    for (let epoch = 2; epoch <= 5; epoch++) {
        f.options.inputEpoch = epoch;
        await f.update();
        assert.equal(f.state.error, true);
        assert.equal(f.state.loading, false);
        assert.equal(f.requests.length, requestCount);
    }

    await act(() => f.state.retry());
    assert.equal(f.state.error, true);
    assert.equal(f.requests.length, requestCount, "retry cannot allocate an over-budget surface");
    f.window.devicePixelRatio = 2;
    await act(() => {
        f.window.dispatchEvent(new Event("resize"));
    });
    assert.equal(f.state.error, false);
    assert.equal(f.requests.length, requestCount, "the in-flight manifest remains shareable");
    await f.load();
    await f.ready(f.frame);
    await f.painted(f.frame);
    assert.equal(f.state.active, true, "exactly 16 million backing pixels fit at the actual DPR");
    assert.equal(f.state.inputReady, true);
    assert.equal(f.options.cw, 10);
    assert.equal(f.options.ch, 20);
});

test("same-split focus and metadata updates retain the warm painter, not stale input readiness", async (t) => {
    const f = await hookFixture(t);
    const firstPane = f.options.surface.panes[0]!;
    const secondPane = {
        ...firstPane,
        pane_id: "pane-2",
        focused: false,
        rect: { ...firstPane.rect, x: 1 },
        inner_rect: { ...firstPane.inner_rect, x: 1 },
    };

    f.options.surface = {
        ...f.options.surface,
        frame: { width: 2, height: 1, cells: [{ symbol: "a" }, { symbol: "b" }] },
        panes: [firstPane, secondPane],
    };
    await f.update();
    await f.load();
    const node = f.frame;

    await f.ready(node);
    await f.painted(node);
    const before = last(node.messages);

    f.options.surface = {
        ...f.options.surface,
        projection_revision: "9007199254741000",
        panes: f.options.surface.panes
            .map((pane) => ({ ...pane, focused: pane.pane_id === "pane-2" }))
            .reverse(),
    };
    await f.update();
    assert.equal(f.frame, node, "focus navigation reuses the same child session");
    assert.equal(last(node.messages).type, "gpui-present", "no clear or blank scene");
    assert.equal(f.state.visible, true, "retain acknowledged same-split pixels");
    assert.equal(f.state.loading, false, "warm focus is not renderer startup");
    assert.equal(f.state.active, false);
    assert.equal(f.state.editorReady, false, "composition cannot migrate to the new pane");
    assert.equal(f.state.inputReady, false);
    await f.painted(node, before);
    assert.equal(
        f.state.inputReady,
        false,
        "the old target's receipt cannot authorize the new one",
    );
    await f.painted(node);
    assert.equal(f.state.active, true);
    assert.equal(f.state.inputReady, true);

    f.options.surface = { ...f.options.surface, projection_revision: "9007199254741001" };
    await f.update();
    assert.equal(f.state.visible, true);
    assert.equal(f.state.loading, false);
    assert.equal(f.state.editorReady, true, "the unchanged editor keeps focus/IME intent");
    assert.equal(
        f.state.inputReady,
        false,
        "editor continuity is not permission to send blind input",
    );
    await f.painted(node);
    assert.equal(f.state.inputReady, true);

    f.options.surface = {
        ...f.options.surface,
        projection_revision: "9007199254741002",
        panes: f.options.surface.panes.map((pane) => ({
            ...pane,
            pane_id: `other-${pane.pane_id}`,
        })),
    };
    await f.update();
    assert.equal(f.frame, node, "even a real view change reuses the renderer connection");
    assert.equal(last(node.messages).type, "gpui-clear");
    assert.equal(
        f.state.visible,
        false,
        "a different native view cannot expose old terminal content",
    );
    assert.equal(f.state.loading, true);
    assert.equal(f.state.editorReady, false);
    assert.equal(f.state.inputReady, false);
    assert.equal(f.requests.length, 1, "navigation never starts another renderer download/session");
});

test("geometry-only repaints preserve acknowledged input intent, but new input contexts need their own paint", async (t) => {
    const f = await hookFixture(t);

    await f.load();
    const node = f.frame;

    await f.ready(node);
    await f.painted(node);
    const pane = f.options.surface.panes[0]!;
    const geometry: [string, () => void][] = [
        [
            "frame dimensions",
            () => {
                f.options.surface.frame = {
                    width: 2,
                    height: 1,
                    cells: [{ symbol: "a" }, { symbol: "b" }],
                };
                pane.rect.width = pane.inner_rect.width = 2;
            },
        ],
        [
            "cell metrics",
            () => {
                f.options.cw = 11;
                f.options.ch = 22;
            },
        ],
        [
            "backing DPR",
            () => {
                f.window.devicePixelRatio = 2;
                f.window.dispatchEvent(new Event("resize"));
            },
        ],
        [
            "pane rectangles",
            () => {
                pane.inner_rect.width = 1;
            },
        ],
    ];

    for (const [label, change] of geometry) {
        await act(change);
        await f.update();
        assert.equal(f.state.active, false, `${label}: pixels wait for the new scene`);
        assert.equal(
            f.state.inputReady,
            true,
            `${label}: preserve acknowledged IME/held-key intent`,
        );
        assert.equal(last(node.messages).type, "gpui-clear");
        await f.painted(node);
        assert.equal(last(node.messages).type, "gpui-present");
        assert.equal(f.state.active, false);
        assert.equal(f.state.inputReady, true);
        await f.painted(node);
        assert.equal(f.state.active, true);
        assert.equal(f.state.inputReady, true);
    }

    const contexts: [string, () => void][] = [
        ["input epoch", () => f.options.inputEpoch++],
        ["boot", () => (f.options.surface.boot_id = "boot-2")],
        [
            "popup opens",
            () => {
                f.options.surface.popup = {
                    terminal_id: "popup-1",
                    frame: presentation("popup").surface.frame,
                };
            },
        ],
        ["popup target", () => (f.options.surface.popup!.terminal_id = "popup-2")],
        ["popup closes", () => (f.options.surface.popup = null)],
        [
            "focused pane",
            () => {
                pane.focused = false;
                f.options.surface.panes.push({ ...pane, pane_id: "pane-2", focused: true });
            },
        ],
    ];

    for (const [label, change] of contexts) {
        const previous = last(node.messages);

        change();
        await f.update();
        assert.equal(f.state.active, false, label);
        assert.equal(f.state.inputReady, false, `${label}: a new target must not inherit input`);
        const clear = last(node.messages);

        assert.equal(clear.type, "gpui-clear");
        await f.painted(node, previous);
        assert.equal(f.state.inputReady, false, `${label}: an old receipt cannot restore input`);
        await f.painted(node, clear);
        assert.equal(last(node.messages).type, "gpui-present");
        assert.equal(f.state.inputReady, false, `${label}: a clear receipt cannot restore input`);
        await f.painted(node);
        assert.equal(f.state.active, true, label);
        assert.equal(f.state.inputReady, true, label);
    }

    const beforePause = last(node.messages);

    f.options.drawable = false;
    await f.update();
    assert.equal(f.state.inputReady, false, "pause/metadata absence retires acknowledged input");
    await f.painted(node, beforePause);
    assert.equal(f.state.inputReady, false);
    await f.painted(node);
    assert.equal(f.state.inputReady, false);
    f.options.drawable = true;
    await f.update();
    assert.equal(f.state.inputReady, false, "resuming the same target still needs a fresh paint");
    assert.equal(last(node.messages).type, "gpui-present");
    await f.painted(node);
    assert.equal(f.state.active, true);
    assert.equal(f.state.inputReady, true);
    assert.equal(f.requests.length, 1, "geometry and input fences never reconnect the renderer");
});
