// Real elapsed-time components and their shared hook, with manually batched hooks/browser events.
// Owns timer admission, cancellation, resume labels and disposal; not Preact DOM or device energy.
// Private components are exposed only by an in-memory loader, never a production test export.
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { registerHooks } from "node:module";
import { test, type TestContext } from "node:test";

type Template = { parts: string[]; values: unknown[] };
type Hook = { value?: any; deps?: unknown[]; cleanup?: () => void };
const fixture = {
    current: null as Mounted | null,
    peeks: 0,
    state: {
        me: { id: "fixture-owner", role: "owner" },
        server: {},
        boardAgents: [] as Record<string, any>[],
        sessions: [] as Record<string, any>[],
        peeks: {},
    },
};

Object.assign(globalThis, { visibleClockFixture: fixture });
const hooks = `
    const f = globalThis.visibleClockFixture;
    export const useState = initial => {
        const c = f.current, hook = c.hook();
        if (!("value" in hook)) hook.value = typeof initial === "function" ? initial() : initial;
        return [hook.value, value => {
            const next = typeof value === "function" ? value(hook.value) : value;
            if (!Object.is(next, hook.value)) { hook.value = next; c.dirty = true; }
        }];
    };
    export const useRef = current => {
        const hook = f.current.hook();
        return hook.value ??= {current};
    };
    export const useEffect = (run, deps) => f.current.effect(run, deps);
    export const useLayoutEffect = useEffect;
    export const useMemo = (run, deps) => {
        const hook = f.current.hook();
        if (!hook.deps || deps.some((value, i) => !Object.is(value, hook.deps[i]))) {
            hook.value = run(); hook.deps = deps;
        }
        return hook.value;
    };
`;
const inert = (names: string[]) =>
    names.map((name) => `export const ${name} = () => null;`).join("\n");
const stubs: Record<string, string> = {
    preact: "export class Component {}",
    "preact/hooks": hooks,
    "./avatar.js": inert(["initials", "personColor", "folderColor"]),
    "./back.js": inert(["useBack"]),
    "./browser.js": inert(["browserAvailable", "setBrowserOpen"]),
    "./calls.js": `${inert(["describeCall"])} export const describersRevision = 0;`,
    "./diff.js": inert(["DiffBlock"]),
    "./review-comments.js": inert(["DiffComments"]),
    "./linked-sessions.js": inert(["LinkedSessions"]),
    "./seen.js": "export const fromServer = value => value;",
    "./rich.js": inert(["Highlighted"]),
    "./peeks.js": "export const useOnScreen = () => { globalThis.visibleClockFixture.peeks++; };",
    "./store.js": `
        const f = globalThis.visibleClockFixture;
        export const store = {
            get state() {return f.state;}, subscribe() {return () => {};}, set() {}
        };
        export const api = async () => ({});
        export const canSteer = () => true;
        ${inert([
            "actions",
            "attempt",
            "collab",
            "discuss",
            "isRow",
            "navigate",
            "notify",
            "openSheet",
            "revealReviewThread",
        ])}
        export const TRANSCRIPT_ROWS = 100;
    `,
    "./theme.js": "export const prefs = () => ({showThinking: true});",
    "./workspace-location.js": inert(["conversationLocation"]),
    "./ui.js": `
        export const html = (parts, ...values) => ({parts: [...parts], values});
        ${inert([
            "Boot",
            "copyText",
            "entryImageUrl",
            "fileUrl",
            "Icon",
            "Markdown",
            "openFile",
            "plainText",
            "readable",
            "replyText",
            "Spinner",
            "splitAttachments",
            "Thumb",
            "timeAgo",
        ])}
    `,
    "./sheets/memory.js": inert(["LessonCall", "memoryAvailable"]),
};
const targets = ["transcript", "subagents", "subagents-board", "visible-clock"];

registerHooks({
    resolve(specifier, context, next) {
        const stub = stubs[specifier];
        const parent = context.parentURL ?? "";

        return targets.some((name) => parent.endsWith(`/web/${name}.js`)) && stub !== undefined
            ? { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
            : next(specifier, context);
    },
    load(url, context, next) {
        const result = next(url, context);
        const names = url.endsWith("/web/transcript.js")
            ? "GroupTime, LiveLine"
            : url.endsWith("/web/subagents.js")
              ? "Bar"
              : "";

        return names ? { ...result, source: `${result.source}\nexport { ${names} };` } : result;
    },
});

class Mounted {
    hooks: Hook[] = [];
    cursor = 0;
    dirty = true;
    renders = 0;
    tree: unknown;
    effects: (() => void)[] = [];
    component: (props: any) => unknown;
    props: Record<string, any>;

    constructor(component: (props: any) => unknown, props: Record<string, any>) {
        this.component = component;
        this.props = props;
    }

    hook() {
        return (this.hooks[this.cursor++] ??= {});
    }

    effect(run: () => (() => void) | void, deps: unknown[]) {
        const hook = this.hook();

        if (!hook.deps || deps.some((value, index) => !Object.is(value, hook.deps![index]))) {
            hook.deps = deps;
            this.effects.push(() => {
                hook.cleanup?.();
                hook.cleanup = run() ?? undefined;
            });
        }
    }

    flush() {
        while (this.dirty) {
            this.dirty = false;
            this.cursor = 0;
            fixture.current = this;
            this.tree = this.component(this.props);
            fixture.current = null;
            this.renders++;
            this.effects.splice(0).forEach((run) => run());
        }
    }

    dispose() {
        this.hooks.forEach((hook) => hook.cleanup?.());
        this.hooks = [];
    }
}

function markup(value: unknown): string {
    if (Array.isArray(value)) {
        return value.map(markup).join("");
    }

    if (value && typeof value === "object" && "parts" in value) {
        const template = value as Template;

        return template.parts.map((part, index) => part + markup(template.values[index])).join("");
    }

    return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

async function browser(t: TestContext) {
    const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
    const window = new EventTarget();
    const timers = new Map<number, () => void>();
    let sequence = 0;
    let now = 1_000_000;
    const globals = {
        window,
        document,
        matchMedia: () => Object.assign(new EventTarget(), { matches: false }),
        sessionStorage: { getItem: () => null, setItem() {} },
        addEventListener: window.addEventListener.bind(window),
        removeEventListener: window.removeEventListener.bind(window),
        setInterval: (callback: () => void, ms: number) => {
            assert.equal(ms, 1000);
            const id = ++sequence;

            timers.set(id, callback);

            return id;
        },
        clearInterval: (id: number) => timers.delete(id),
    };
    const descriptors = Object.keys(globals).map(
        (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
    );

    for (const [key, value] of Object.entries(globals)) {
        Object.defineProperty(globalThis, key, { configurable: true, value });
    }

    t.mock.method(Date, "now", () => now);
    const mounted: Mounted[] = [];
    const components = await import(new URL("../web/transcript.js", import.meta.url).href);
    const { Bar } = await import(new URL("../web/subagents.js", import.meta.url).href);
    const { SubagentsBoard } = await import(
        new URL("../web/subagents-board.js", import.meta.url).href
    );

    fixture.state.boardAgents = [];
    fixture.state.sessions = [];
    fixture.peeks = 0;
    t.after(() => {
        mounted.forEach((component) => component.dispose());
        // Release a remembered pagehide latch even if a failed assertion left the page departed.
        window.dispatchEvent(new Event("pageshow"));

        for (const [key, descriptor] of descriptors) {
            if (descriptor) {
                Object.defineProperty(globalThis, key, descriptor);
            } else {
                Reflect.deleteProperty(globalThis, key);
            }
        }
    });

    return {
        ...components,
        Bar,
        SubagentsBoard,
        document,
        window,
        timers,
        mount(component: (props: any) => unknown, props: Record<string, any> = {}) {
            const current = new Mounted(component, props);

            mounted.push(current);
            current.flush();

            return current;
        },
        advance(ms: number) {
            now += ms;
        },
        tick() {
            [...timers.values()].forEach((run) => run());
            mounted.forEach((component) => component.flush());
        },
        flush() {
            mounted.forEach((component) => component.flush());
        },
        visible(value: boolean) {
            document.visibilityState = value ? "visible" : "hidden";
            document.dispatchEvent(new Event("visibilitychange"));
        },
    };
}

const waitingAgent = () => ({
    id: 1,
    conversationId: 2,
    name: "Synthetic agent",
    busy: true,
    waiting: true,
    askedAt: 990_000,
    approval: { tool: "test", subject: "fixture only" },
});

test("live group pauses hidden ticks and catches up on batched return", async (t) => {
    const b = await browser(t);
    const group = b.mount(b.GroupTime, { id: "synthetic-group", start: 990_000, live: true });

    assert.match(markup(group.tree), />10s<\/span>/);
    const lateTick = [...b.timers.values()][0]!;
    const before = group.renders;

    b.visible(false);
    assert.equal(b.timers.size, 0, "no application-eligible hidden elapsed interval");
    b.advance(125_000);
    lateTick();
    b.flush();
    assert.equal(group.renders, before, "already queued hidden ticks cannot render");
    b.visible(true);
    b.visible(false);
    b.visible(true);
    b.flush();
    assert.equal(b.timers.size, 1, "batched transitions leave one clock");
    assert.match(markup(group.tree), />2m 15s<\/span>/, "return uses wall time immediately");
    const resumed = group.renders;

    lateTick();
    b.flush();
    assert.equal(group.renders, resumed, "old interval remains fenced after return");
    group.props.live = false;
    group.dirty = true;
    group.flush();
    assert.equal(b.timers.size, 0, "completed groups release clock demand");
    assert.equal(getEventListeners(b.document, "visibilitychange").length, 0);
});

test("approval live line latches pagehide until pageshow and immediately catches up", async (t) => {
    const b = await browser(t);
    const line = b.mount(b.LiveLine, {
        live: { busy: true },
        approvals: [{ id: "synthetic-approval" }],
        start: 990_000,
        entries: [],
        conversationId: 9,
    });

    assert.match(markup(line.tree), /Waiting for your approval/);
    const before = line.renders;

    b.window.dispatchEvent(new Event("pagehide"));
    assert.equal(b.timers.size, 0, "pagehide stops ticks even if visibility still says visible");
    b.advance(90_000);
    b.visible(true);
    b.window.dispatchEvent(new Event("online"));
    b.flush();
    assert.equal(line.renders, before, "unrelated events do not unlatch departure");
    b.window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    b.window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    b.flush();
    assert.equal(b.timers.size, 1);
    assert.match(markup(line.tree), />1m 40s<\/span>/);
    assert.match(markup(line.tree), /Waiting for your approval/, "agent state stays unchanged");
    line.dispose();
    assert.equal(b.timers.size, 0);
    assert.equal(getEventListeners(b.window, "pageshow").length, 0);
});

test("bar and approval board share only visible clock demand", async (t) => {
    const b = await browser(t);
    const agents = [waitingAgent()];

    fixture.state.boardAgents = [{ ...agents[0], busy: false }];
    fixture.state.sessions = [{ id: 1, title: "Synthetic session" }];
    const bar = b.mount(b.Bar, { agents, active: true, open: true });
    const board = b.mount(b.SubagentsBoard);

    assert.equal(b.timers.size, 1, "bar and board share a visible interval");
    assert.equal(getEventListeners(b.document, "visibilitychange").length, 1);
    assert.ok(fixture.peeks >= 2, "existing peek hooks still run");
    const before = [bar.renders, board.renders];

    b.visible(false);
    assert.equal(b.timers.size, 0);
    b.advance(60_000);
    b.tick();
    assert.deepEqual([bar.renders, board.renders], before);
    b.visible(true);
    b.flush();
    assert.ok(bar.renders > before[0]! && board.renders > before[1]!, "both resume immediately");
    bar.dispose();
    assert.equal(b.timers.size, 1, "one subscriber leaving cannot stop another clock");
    b.tick();
    board.dispose();
    assert.equal(b.timers.size, 0);
    assert.equal(getEventListeners(b.document, "visibilitychange").length, 0);
    assert.equal(getEventListeners(b.window, "pagehide").length, 0);
    assert.equal(getEventListeners(b.window, "pageshow").length, 0);
});

test("hidden mounts and departed subscription churn stay paused", async (t) => {
    const b = await browser(t);

    b.visible(false);
    const group = b.mount(b.GroupTime, { id: "hidden-group", start: 990_000, live: true });

    assert.equal(b.timers.size, 0, "a hidden mount does not admit a clock");
    b.visible(true);
    b.flush();
    assert.equal(b.timers.size, 1);
    b.window.dispatchEvent(new Event("pagehide"));
    group.dispose();
    assert.equal(b.timers.size, 0);
    assert.equal(getEventListeners(b.document, "visibilitychange").length, 0);
    const next = b.mount(b.GroupTime, { id: "departed-group", start: 990_000, live: true });

    assert.equal(b.timers.size, 0, "new subscribers cannot undo the pagehide latch");
    b.window.dispatchEvent(new Event("pageshow"));
    b.flush();
    assert.equal(b.timers.size, 1);
    next.dispose();
    b.mount(b.GroupTime, { id: "finished-group", start: 990_000, end: 995_000, live: false });
    b.mount(b.GroupTime, { id: "static-group", start: 990_000, end: 995_000 });
    b.mount(b.Bar, { agents: [], active: false, open: false });
    fixture.state.boardAgents = [];
    b.mount(b.SubagentsBoard);
    assert.equal(b.timers.size, 0, "finished/empty components do not keep a clock or poll");
    assert.equal(getEventListeners(b.document, "visibilitychange").length, 0);
});

test("an unsubscribed return clears the latch without hidden ticking", async (t) => {
    const b = await browser(t);
    const group = b.mount(b.GroupTime, { id: "departing-group", start: 990_000, live: true });

    b.window.dispatchEvent(new Event("pagehide"));
    group.dispose();
    assert.equal(b.timers.size, 0);
    assert.equal(getEventListeners(b.document, "visibilitychange").length, 0);
    assert.equal(getEventListeners(b.window, "pagehide").length, 0);
    assert.equal(getEventListeners(b.window, "pageshow").length, 1, "latch release remains");
    b.visible(false);
    b.window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    assert.equal(getEventListeners(b.window, "pageshow").length, 0);
    const next = b.mount(b.GroupTime, { id: "return-group", start: 990_000, live: true });

    b.window.dispatchEvent(new Event("pageshow"));
    assert.equal(b.timers.size, 0, "pageshow does not override hidden visibility");
    b.visible(true);
    b.flush();
    assert.equal(b.timers.size, 1, "an unobserved return cannot strand later subscribers");
    next.dispose();
    assert.equal(b.timers.size, 0);
    assert.equal(getEventListeners(b.window, "pageshow").length, 0);
});
