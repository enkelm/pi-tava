import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks } from "node:module";
import { h, render } from "preact";
import { act } from "preact/test-utils";

const htm = (await import(import.meta.resolve("htm"))).default;

const modulePath: string = "../web/terminal-renderer-bridge.js";
const { createTerminalRendererBridge } = await import(modulePath);

test("warm presentations retain pixels without accepting stale receipts or bypassing clears/deadlines", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });

    const source = {};
    const origin = "https://renderer.example";
    const session = "synthetic-navigation-session";
    const messages: { type: string; sequence: number; fence: string; payload?: string }[] = [];
    const statuses: { phase: string; fence: string }[] = [];
    const bridge = createTerminalRendererBridge({
        source: () => source,
        origin,
        session,
        post: (message: (typeof messages)[number]) => messages.push(message),
        onStatus: (status: (typeof statuses)[number]) => statuses.push(status),
    });
    const receive = (data: object) =>
        bridge.receive({ source, origin, data: { ...data, session } });
    const painted = (message = messages.at(-1)!) =>
        receive({ type: "gpui-painted", sequence: message.sequence, fence: message.fence });

    t.after(() => bridge.dispose());
    receive({ type: "gpui-ready" });
    bridge.present({ content: "same split, first focus" }, "first");
    painted();
    bridge.present({ content: "old in-flight output" }, "first");
    const old = messages.at(-1)!;

    bridge.present({ content: "second focus" }, "second", { preservePixels: true });
    bridge.present({ content: "latest focus" }, "latest", { preservePixels: true });
    assert.equal(messages.at(-1), old, "a warm switch must not clear the current scene");
    assert.deepEqual(statuses.at(-1), { phase: "loading", fence: "latest" });
    assert.equal(painted(old), true, "the old wire slot can settle without authorizing input");
    const latest = messages.at(-1)!;

    assert.equal(latest.type, "gpui-present");
    assert.equal(latest.fence, "latest");
    assert.deepEqual(JSON.parse(latest.payload!), { content: "latest focus" });
    assert.deepEqual(statuses.at(-1), { phase: "loading", fence: "latest" });
    assert.equal(painted(old), false);
    painted(latest);
    assert.deepEqual(statuses.at(-1), { phase: "ready", fence: "latest" });

    bridge.present({ content: "different native surface" }, "different");
    const clear = messages.at(-1)!;

    assert.equal(clear.type, "gpui-clear");
    bridge.present({ content: "newer focus on that surface" }, "newer", { preservePixels: true });
    assert.equal(messages.at(-1), clear, "warm updates cannot bypass an outstanding hard clear");
    assert.equal(painted(latest), false);
    painted(clear);
    const replacement = messages.at(-1)!;

    assert.equal(replacement.type, "gpui-present");
    assert.equal(replacement.fence, "newer");
    assert.deepEqual(statuses.at(-1), { phase: "loading", fence: "newer" });
    painted(replacement);
    assert.deepEqual(statuses.at(-1), { phase: "ready", fence: "newer" });

    bridge.present({ content: "stalled paint" }, "newer");
    const stalled = messages.at(-1)!;

    t.mock.timers.tick(9_999);
    bridge.present({ content: "warm update cannot reset the deadline" }, "final", {
        preservePixels: true,
    });
    t.mock.timers.tick(1);
    assert.equal(statuses.at(-1)?.phase, "error");
    assert.equal(painted(stalled), false);
    assert.equal(
        messages.at(-1),
        stalled,
        "a stalled old scene fails closed rather than hanging warm forever",
    );
});

test("a metadata gap retains the surface's images until its replacement arrives", async (t) => {
    // Preact runs the actual component and transport lifecycle. The null markup host
    // observes only the Grid presentation boundary, not browser layout or GPU pixels.
    let grid: Record<string, unknown> | undefined;
    const Grid = () => null;
    const fixture = {
        Grid,
        html: htm.bind((type: unknown, props: Record<string, unknown>) => {
            if (type === Grid) {
                grid = { surface: props.surface, images: props.images, enabled: props.enabled };
            }

            return null;
        }),
        store: { state: { me: { id: "owner", role: "owner" } }, subscribe() {} },
    };
    const fixtureKey = "terminal-retained-presentation-test";

    class Socket {
        static all: Socket[] = [];
        readyState = 1;
        onmessage?: (event: { data: string }) => void;

        constructor() {
            Socket.all.push(this);
        }

        send() {}
        close() {
            this.readyState = 3;
        }
        receive(frame: object) {
            this.onmessage?.({ data: JSON.stringify(frame) });
        }
    }

    const globals = {
        [fixtureKey]: fixture,
        window: new EventTarget(),
        document: Object.assign(new EventTarget(), {
            visibilityState: "visible",
            documentElement: { dataset: {} },
            hasFocus: () => true,
            createElement: () => ({ getContext: () => ({ measureText: () => ({ width: 8 }) }) }),
        }),
        navigator: { onLine: true },
        location: new URL("https://fixture.invalid/"),
        matchMedia: () => ({ matches: false }),
        getComputedStyle: () => ({ getPropertyValue: () => "" }),
        MutationObserver: class {
            observe() {}
            disconnect() {}
        },
        WebSocket: Socket,
    };
    const descriptors = Object.keys(globals).map(
        (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
    );

    for (const [key, value] of Object.entries(globals)) {
        Object.defineProperty(globalThis, key, { configurable: true, value });
    }

    const getFixture = `const f = globalThis[${JSON.stringify(fixtureKey)}];`;
    const stubs: Record<string, string> = {
        "./store.js": `${getFixture} export const store = f.store; export const uid = () => 'id';
            export const api = async () => ({url:'/api/private-terminal?ticket=synthetic'});`,
        "./theme.js": "export const prefs = () => ({}); export const setPrefs = () => {};",
        "./ui.js": `${getFixture} export const html = f.html; export const Icon = () => null;`,
        "./terminal-grid.js": `${getFixture} export const TerminalGrid = f.Grid;
            export const keyEvent = () => null; export const DEFAULT_THEME = {palette:[]};`,
    };
    const hooks = registerHooks({
        resolve(specifier, context, next) {
            const stub = stubs[specifier];

            return context.parentURL?.endsWith("/web/private-terminal.js") && stub !== undefined
                ? { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
                : next(specifier, context);
        },
    });
    const modulePath: string = "../web/private-terminal.js";
    const { PrivateTerminal, disconnectPrivateTerminal, syncTerminalTargets } = await import(
        modulePath
    );
    const root = { nodeType: 1, firstChild: null } as unknown as HTMLElement;

    t.after(async () => {
        try {
            await act(() => render(null, root));
        } finally {
            disconnectPrivateTerminal("image-fixture");
            hooks.deregister();

            for (const [key, descriptor] of descriptors) {
                if (descriptor) {
                    Object.defineProperty(globalThis, key, descriptor);
                } else {
                    Reflect.deleteProperty(globalThis, key);
                }
            }
        }
    });

    syncTerminalTargets({
        instances: [
            {
                id: "image-fixture",
                workspaces: [
                    {
                        tabs: [
                            {
                                panes: [{ id: "opaque-pane", nativeId: "pane" }],
                            },
                        ],
                    },
                ],
            },
        ],
    });
    await act(() =>
        render(
            h(PrivateTerminal, {
                id: "opaque-pane",
                instanceId: "image-fixture",
                nativeId: "pane",
            }),
            root,
        ),
    );
    const startupDeadline = Date.now() + 2000;

    while (!globals.WebSocket.all.length && Date.now() < startupDeadline) {
        await act(() => new Promise<void>((resolve) => setTimeout(resolve, 1)));
    }

    const socket = globals.WebSocket.all[0];

    assert.ok(socket, "opening the mounted Terminal starts its synthetic transport");
    const receive = (frame: object) => act(() => socket.receive(frame));
    const snapshot = {
        boot_id: "boot",
        revision: 1,
        focused_pane_id: "pane",
        panes: [{ pane_id: "pane" }],
        workspaces: [],
        tabs: [],
    };
    const surface = {
        boot_id: "boot",
        projection_revision: 1,
        panes: [{ pane_id: "pane", focused: true }],
    };
    const oldImages = [{ key: "old-image", data: "old-pixels" }];
    const nextImages = [{ key: "new-image", data: "new-pixels" }];

    await receive({ type: "connected", welcome: { methods: [] } });
    await receive({ type: "snapshot", snapshot });
    await receive({ type: "images", images: oldImages });
    await receive({ type: "surface", surface });
    assert.deepEqual(grid?.surface, surface);
    assert.deepEqual(grid?.images, oldImages);
    assert.equal(grid?.enabled, true);

    await receive({ type: "snapshot", snapshot: { ...snapshot, revision: 2 } });
    await receive({ type: "images", images: nextImages });
    assert.deepEqual(grid?.surface, surface, "keep the complete prior view during the gap");
    assert.deepEqual(
        grid?.images,
        oldImages,
        "new assets must not strip images from the retained view",
    );
    assert.equal(grid?.enabled, false, "retained pixels never authorize metadata-gap input");
    const replacement = { ...surface, projection_revision: 2 };

    await receive({ type: "surface", surface: replacement });
    assert.deepEqual(grid?.surface, replacement);
    assert.deepEqual(grid?.images, nextImages);
    assert.equal(grid?.enabled, true);
    await act(() => disconnectPrivateTerminal("image-fixture"));
    assert.equal(grid?.surface, null, "a real disconnect retires the retained presentation");
    assert.deepEqual(grid?.images, []);
    assert.equal(grid?.enabled, false);
});
