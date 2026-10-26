// Exercise the exported private-agent UI with deferred API responses and memory-only hooks.
// This covers drafts, revision/retry admission and stale openings, not browser layout or device focus.
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { registerHooks } from "node:module";
import { after, test, type TestContext } from "node:test";
import { h } from "preact";

const htm = (await import(import.meta.resolve("htm"))).default;

type Props = Record<string, any>;
type VNode = { type: string | ((props: Props) => any); props: Props; key?: string };
type Slot = { value?: any; deps?: unknown[]; cleanup?: () => void };
type Fiber = { slots: Slot[]; cursor: number };
type Request = {
    path: string;
    body?: Props;
    options: Props;
    resolve: (value: Props) => void;
    reject: (error: Error) => void;
};
let active: Props;
const bridge = {
    h,
    html: htm.bind(h),
    hooks: {
        useState: (...args: any[]) => active.hooks.useState(...args),
        useRef: (...args: any[]) => active.hooks.useRef(...args),
        useEffect: (...args: any[]) => active.hooks.useEffect(...args),
        useMemo: (run: () => unknown) => run(),
    },
    store: {
        get state() {
            return active.state;
        },
        set(patch: Props) {
            Object.assign(active.state, patch);
            active.invalidate();
        },
    },
    api: (...args: any[]) => active.api(...args),
    uid: () => active.uid(),
    openSheet: (sheet: Props) => bridge.store.set({ sheet }),
    closeSheet: () => bridge.store.set({ sheet: null }),
    navigate: (id: number) => active.navigated.push(id),
    openAgentDraft: (agentId: string) => active.openedDrafts.push(agentId),
};
const descriptor = Object.getOwnPropertyDescriptor(globalThis, "namedAgentsUiFixture");
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
const storage = new Map<string, string>();
const browserEvents = new EventTarget();
const browserDescriptors = new Map(
    ["document", "getSelection", "addEventListener", "removeEventListener"].map((key) => [
        key,
        Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
);

Object.defineProperties(globalThis, {
    document: { configurable: true, value: new EventTarget() },
    getSelection: { configurable: true, value: () => null },
    addEventListener: {
        configurable: true,
        value: browserEvents.addEventListener.bind(browserEvents),
    },
    removeEventListener: {
        configurable: true,
        value: browserEvents.removeEventListener.bind(browserEvents),
    },
});

Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
    },
});
Object.defineProperty(globalThis, "namedAgentsUiFixture", { configurable: true, value: bridge });
after(() => {
    for (const [key, previous] of browserDescriptors) {
        if (previous) {
            Object.defineProperty(globalThis, key, previous);
        } else {
            Reflect.deleteProperty(globalThis, key);
        }
    }

    if (descriptor) {
        Object.defineProperty(globalThis, "namedAgentsUiFixture", descriptor);
    } else {
        Reflect.deleteProperty(globalThis, "namedAgentsUiFixture");
    }

    if (storageDescriptor) {
        Object.defineProperty(globalThis, "sessionStorage", storageDescriptor);
    } else {
        Reflect.deleteProperty(globalThis, "sessionStorage");
    }
});

const sources: Record<string, string> = {
    "preact/hooks":
        "export const {useState,useRef,useEffect}=globalThis.namedAgentsUiFixture.hooks;",
    "./store.js": `export const {store,api,uid,openSheet,closeSheet,navigate}=globalThis.namedAgentsUiFixture;`,
    "./agent-drafts.js": `export const {openAgentDraft}=globalThis.namedAgentsUiFixture; export const agentDrafts=()=>[],selectAgentDraft=()=>{};`,
    "./sheets/model.js": `export const ModelPicker=()=>null;`,
    "./ui.js": `const f=globalThis.namedAgentsUiFixture;
        export const html=f.html,Icon=({name,size})=>f.h('test-icon',{name,size}),Loader=({label})=>f.h('test-loader',{label});
        export const Sheet=({children})=>children,timeAgo=()=>"Recently",Spinner=props=>f.h('test-spinner',props);`,
};

const blobatarModule = import.meta.resolve("blobatar/react");

registerHooks({
    resolve(specifier, context, next) {
        if (context.parentURL === blobatarModule) {
            if (specifier === "react") {
                return {
                    url: `data:text/javascript,${encodeURIComponent("export const {useMemo}=globalThis.namedAgentsUiFixture.hooks;")}`,
                    shortCircuit: true,
                };
            }

            if (specifier === "react/jsx-runtime") {
                return next("preact/jsx-runtime", context);
            }
        }

        const source = /\/web\/(?:named-agents|named-agent-avatar|sidebar-context)\.js$/.test(
            context.parentURL?.split("?")[0] ?? "",
        )
            ? sources[specifier]
            : undefined;

        return source === undefined
            ? next(specifier, context)
            : { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    },
});
const { NamedAgents, NamedAgentSheet, openAgentSettings } = await import(
    new URL("../web/named-agents.js", import.meta.url).href
);
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
let owner = 0;

function nodes(value: any): VNode[] {
    if (Array.isArray(value)) {
        return value.flatMap(nodes);
    }

    return value?.props ? [value, ...nodes(value.props.children)] : [];
}

function textOf(value: any): string {
    if (Array.isArray(value)) {
        return value.map(textOf).join("");
    }

    return typeof value === "string" || typeof value === "number"
        ? String(value)
        : value?.props
          ? textOf(value.props.children)
          : "";
}

function fixture(t: TestContext, components = { NamedAgents, NamedAgentSheet, openAgentSettings }) {
    const fibers = new Map<string, Fiber>();
    const effects: (() => void)[] = [];
    const requests: Request[] = [];
    const navigated: number[] = [];
    const openedDrafts: string[] = [];
    const elements = new Map<string, Props>();
    const state: Props = {
        me: { id: `owner-${++owner}`, role: "owner" },
        server: { privateAgents: 4, extensions: ["pocket-memory"] },
        namedAgents: [
            {
                agentId: "agent-reviewer",
                id: 7,
                chatIds: [7],
                name: "Long-lived reviewer",
                busy: true,
                updatedAt: 10,
            },
        ],
        conversationId: 2,
        sessions: [{ id: 2, projectId: "current-project" }],
        projects: [{ id: "current-project", name: "Currently open project" }],
        sheet: null,
    };
    let sequence = 0;
    let current: Fiber;
    let dirty = true;
    let tree: any;
    const slot = () => (current.slots[current.cursor++] ??= {});
    const hooks = {
        useState(initial: any) {
            const item = slot();

            if (!("value" in item)) {
                item.value = typeof initial === "function" ? initial() : initial;
            }

            return [
                item.value,
                (change: any) => {
                    item.value = typeof change === "function" ? change(item.value) : change;
                    dirty = true;
                },
            ];
        },
        useRef: (initial: any) => (slot().value ??= { current: initial }),
        useEffect(run: () => (() => void) | void, deps: unknown[]) {
            const item = slot();

            if (!item.deps || deps.some((value, index) => !Object.is(value, item.deps![index]))) {
                item.deps = deps;
                effects.push(() => {
                    item.cleanup?.();
                    item.cleanup = run() || undefined;
                });
            }
        },
    };

    active = {
        state,
        hooks,
        navigated,
        openedDrafts,
        invalidate: () => {
            dirty = true;
        },
        uid: () => `request-${++sequence}`,
        api: (path: string, body?: Props, options: Props = {}) =>
            new Promise((resolve, reject) =>
                requests.push({ path, body, options, resolve, reject }),
            ),
    };
    let visited = new Set<string>();

    const resolve = (node: any, path: string): any => {
        if (Array.isArray(node)) {
            return node.map((child, index) => resolve(child, `${path}.${index}`));
        }

        if (!node?.props) {
            return node;
        }

        if (typeof node.type === "function") {
            const key = `${path}:${node.key ?? ""}`;
            const fiber = fibers.get(key) ?? { slots: [], cursor: 0 };

            fibers.set(key, fiber);
            visited.add(key);
            current = fiber;
            current.cursor = 0;

            return resolve(node.type(node.props), `${key}.child`);
        }

        const element =
            elements.get(path) ??
            Object.assign(new EventTarget(), {
                closest: () => null,
                getBoundingClientRect: () => ({ left: 16, bottom: 44 }),
            });

        elements.set(path, element);

        if (typeof node.ref === "function") {
            node.ref(element);
        } else if (node.ref) {
            node.ref.current = element;
        }

        return {
            ...node,
            element,
            props: { ...node.props, children: resolve(node.props.children, `${path}.children`) },
        };
    };

    const render = () => {
        for (let count = 0; dirty; count++) {
            assert.ok(count < 20, "UI did not settle");
            dirty = false;
            visited = new Set();
            tree = resolve(
                [
                    h(components.NamedAgents, {}),
                    state.sheet?.type === "named-agent"
                        ? h(components.NamedAgentSheet, { sheet: state.sheet })
                        : null,
                ],
                "root",
            );

            for (const [key, fiber] of fibers) {
                if (!visited.has(key)) {
                    fiber.slots.forEach((item) => item.cleanup?.());
                    fibers.delete(key);
                }
            }

            effects.splice(0).forEach((run) => run());
        }
    };

    t.after(() => fibers.forEach((fiber) => fiber.slots.forEach((item) => item.cleanup?.())));

    const find = (type: string, text?: string) => {
        render();
        const found = nodes(tree).find(
            (node) => node.type === type && (text === undefined || textOf(node).trim() === text),
        );

        assert.ok(found, `${type} ${text ?? ""} not found`);

        return found;
    };

    const label = (name: string) => {
        render();
        const found = nodes(tree).find((node) => node.props["aria-label"] === name);

        assert.ok(found, `${name} not found`);

        return found;
    };

    const settle = async () => {
        await flush();
        render();
        await flush();
        render();
    };

    const click = (node: VNode) => {
        node.props.onClick({ preventDefault() {}, stopPropagation() {} });
        render();
    };

    const input = (name: string, value: string) => {
        const node = label(name);

        (node.props.onInput ?? node.props.onChange)({ currentTarget: { value } });
        render();
    };

    const submit = () => {
        find("form").props.onSubmit({ preventDefault() {} });
        render();
    };

    const patch = (value: Props) => {
        bridge.store.set(value);
        render();
    };

    render();

    return {
        state,
        requests,
        request(index: number) {
            const request = requests[index];

            assert.ok(request, `request ${index} not found`);

            return request;
        },
        navigated,
        openedDrafts,
        context(node: any, keyboard?: "F10" | "ContextMenu") {
            const event = Object.assign(
                new Event(keyboard ? "keydown" : "contextmenu", { cancelable: true }),
                keyboard
                    ? { key: keyboard, shiftKey: keyboard === "F10" }
                    : { clientX: 120, clientY: 80, button: 2, pointerType: "mouse" },
            );

            node.element.dispatchEvent(event);
            render();

            return event.defaultPrevented;
        },
        openSettings(agent = state.namedAgents[0]) {
            components.openAgentSettings(agent.id, agent.agentId);
            render();
        },
        beginCreation() {
            // Retained native creation intents/uncertain receipts remain compatible;
            // the global library's callback creation is covered by project-view.test.ts.
            components.openAgentSettings();
            render();
        },
        find,
        label,
        settle,
        click,
        input,
        submit,
        patch,
        text: () => {
            render();

            return textOf(tree);
        },
    };
}

const settings = (revision = 3) => ({
    agentId: "agent-reviewer",
    id: 7,
    chatIds: [7],
    name: "Reviewer",
    instructions: "Review carefully",
    notes: "Private memory",
    focus: "Accessibility",
    revision,
    history: [
        {
            revision: 1,
            at: 10,
            by: "owner",
            source: "create",
            name: "First name",
            instructions: "Initial remit",
            notes: "Old note",
            focus: "",
        },
        { revision, name: "Reviewer", instructions: "Review carefully" },
    ],
});

test("settings keeps exact retained chats available without creating or cancelling work", async (t) => {
    const f = fixture(t);

    f.openSettings();
    await f.settle();
    f.request(0).resolve({
        ...settings(),
        chatIds: [7, 19],
        chats: [
            { id: 7, title: "Initial setup", busy: false },
            { id: 19, title: "Accessibility review", busy: true },
        ],
    });
    await f.settle();
    const history = f.label("Chats with Reviewer");
    const links = nodes(history).filter((node) => node.type === "a");

    assert.deepEqual(
        links.map((node) => node.props.href),
        ["/s/7", "/s/19"],
    );
    assert.match(textOf(history), /Accessibility reviewWorking/);
    assert.match(textOf(history), /Closing a tab keeps its chat and running work/);
    const working = links[1];

    assert.ok(working);
    working.props.onClick({ ctrlKey: true, preventDefault: assert.fail });
    assert.deepEqual(f.navigated, [], "modified links retain native browser navigation");
    assert.ok(f.state.sheet, "a modified link does not dismiss settings");
    f.click(working);
    assert.deepEqual(f.navigated, [19]);
    assert.equal(f.state.sheet, null);
    assert.equal(
        f.requests.length,
        1,
        "reopening uses navigation, not a lifecycle or creation API",
    );
});

test("only a capable owner sees the agent library, with route-based selection, navigation and public settings", async (t) => {
    const f = fixture(t);

    assert.equal(f.requests.length, 0, "listing uses the realtime catalogue, not polling");
    assert.match(f.text(), /Long-lived reviewer/);
    f.patch({ conversationId: 7 });
    assert.equal(f.find("button", "Long-lived reviewer").props["aria-current"], "page");
    f.click(f.find("button", "Long-lived reviewer"));
    assert.deepEqual(f.navigated, [7]);
    f.patch({ namedAgents: [{ ...f.state.namedAgents[0], chatIds: [7, 19] }] });

    for (const [patch, selected, reason] of [
        [{ conversationId: 19 }, true, "any retained saved chat selects its identity"],
        [
            { conversationId: null, agentDraft: { id: "local-draft", agentId: "agent-reviewer" } },
            true,
            "a local PiP draft selects its identity without a saved chat",
        ],
        [
            { agentDraft: { id: "other-draft", agentId: "another-agent" } },
            false,
            "an unrelated draft deselects PiPs",
        ],
        [
            { conversationId: 2, agentDraft: null },
            false,
            "an unrelated route is not selected even while expanded",
        ],
        [{ conversationId: null }, false, "leaving every saved chat and draft clears selection"],
    ] as const) {
        f.patch(patch);
        assert.equal(
            f.find("button", "Long-lived reviewer").props["aria-current"],
            selected ? "page" : undefined,
            reason,
        );
    }

    f.openSettings();
    await f.settle();
    assert.equal(f.request(0).path, "c/7/private-agent");
    f.request(0).resolve(settings());
    await f.settle();
    assert.equal(f.label("Agent name").props.value, "Reviewer");

    for (const patch of [
        { me: { id: "guest", role: "guest" } },
        { me: { id: "owner", role: "owner" }, server: { privateAgents: 2 } },
        { server: {} },
    ]) {
        f.patch(patch);
        assert.equal(f.text(), "");
        assert.equal(f.requests.length, 1, "hidden UI must not request unsupported/private routes");
    }
});

test("busy named agents use the shared thread spinner and idle agents keep recency", (t) => {
    const f = fixture(t);
    const row = f.find("button", "Long-lived reviewer");

    assert.equal(nodes(row).filter((node) => node.type === "test-spinner").length, 1);
    assert.doesNotMatch(textOf(row), /Working|Recently|Ready/);
    f.patch({ namedAgents: [{ ...f.state.namedAgents[0], busy: false }] });
    const idle = f.find("button", "Long-lived reviewerRecently");

    assert.equal(
        nodes(idle).some((node) => node.type === "test-spinner"),
        false,
    );
    f.patch({ namedAgents: [{ ...f.state.namedAgents[0], updatedAt: null }] });
    assert.ok(f.find("button", "Long-lived reviewerReady"));
});

test("named-agent row touch holds open exact options, cancel for scroll/lift, and consume the held release", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const f = fixture(t);
    const row = f.find("button", "Long-lived reviewer");
    const element = (row as any).element as EventTarget & {
        closest: (selector: string) => unknown;
    };

    // The gesture target is the row button itself, not an inert container. Nested controls
    // remain excluded by the native recognizer; only the root row is the hold surface.
    element.closest = (selector) => (selector.includes("button") ? element : null);

    const touch = (type: string, x = 120, y = 80) => {
        const finger = { identifier: 7, clientX: x, clientY: y };
        const event = Object.assign(new Event(type, { cancelable: true }), {
            touches: type === "touchend" || type === "touchcancel" ? [] : [finger],
            changedTouches: [finger],
        });

        element.dispatchEvent(event);

        return event;
    };

    touch("touchstart");
    t.mock.timers.tick(449);
    assert.equal(f.state.sheet, null);
    touch("touchend");
    t.mock.timers.tick(1);
    assert.equal(f.state.sheet, null, "a short tap is not a hold");
    touch("touchstart");
    touch("touchmove", 130);
    t.mock.timers.tick(450);
    assert.equal(f.state.sheet, null, "scroll intent cancels before opening");
    touch("touchstart");
    touch("touchcancel");
    t.mock.timers.tick(450);
    assert.equal(f.state.sheet, null, "native cancellation cannot open later");
    touch("touchstart");
    t.mock.timers.tick(450);
    assert.deepEqual(f.state.sheet, {
        type: "sidebar-options",
        kind: "named-agent",
        id: "agent-reviewer",
        userId: f.state.me.id,
        at: { x: 120, y: 80, touch: true },
    });
    assert.equal(touch("touchend").defaultPrevented, true);
    const click = Object.assign(new Event("click", { cancelable: true }), { detail: 1 });

    document.dispatchEvent(click);
    assert.equal(click.defaultPrevented, true, "the held contact cannot click through the menu");
    assert.deepEqual(f.navigated, []);
    assert.deepEqual(f.openedDrafts, []);
});

test("named-agent rows open exact anchored options through right-click and keyboard without navigating", (t) => {
    const f = fixture(t);
    const row = f.find("button", "Long-lived reviewer");

    assert.equal(f.context(row), true);
    assert.deepEqual(f.state.sheet, {
        type: "sidebar-options",
        kind: "named-agent",
        id: "agent-reviewer",
        userId: f.state.me.id,
        at: { x: 120, y: 80, touch: false },
    });
    assert.equal(f.state.conversationId, 2, "right-click does not select the agent first");
    assert.deepEqual(f.navigated, []);
    assert.deepEqual(f.openedDrafts, []);
    assert.equal(f.requests.length, 0, "opening object options is passive");

    for (const key of ["F10", "ContextMenu"] as const) {
        f.patch({ sheet: null });
        assert.equal(f.context(row, key), true);
        assert.deepEqual(f.state.sheet.at, { x: 32, y: 44, keyboard: true });
        assert.equal(f.state.sheet.id, "agent-reviewer");
    }

    f.patch({ sheet: null, me: { id: "guest", role: "guest" } });
    assert.equal(f.context(row), false, "revoked rows detach their context listener");
    assert.equal(f.state.sheet, null);
});

// Sidebar entry placement belongs to sidebar-navigation.test.ts. The obsolete collapsible
// global heading is gone; the library owns empty-state creation and retained owner fencing.
test("an empty PiPs library keeps global creation available and stale controls cannot bypass private access loss", (t) => {
    const f = fixture(t);

    f.patch({ namedAgents: [] });
    assert.match(f.text(), /No named agents yet/);
    const create = f.find("button", "Create named agent");

    f.click(create);
    assert.equal(f.state.sheet.type, "named-agent");
    assert.equal(f.state.sheet.id, null);
    assert.equal(typeof f.state.sheet.onCreated, "function");
    f.patch({ sheet: null, me: { id: "guest", role: "guest" } });
    create.props.onClick();
    assert.equal(f.state.sheet, null, "a stale create control cannot bypass private access loss");
});

test("genuine Blobatar images keep their identity through rename and remount and fail quietly", async (t) => {
    await import("blobatar/react");
    const { NamedAgentAvatar } = await import(
        new URL("../web/named-agent-avatar.js", import.meta.url).href
    );
    // Home uses a still identity preview; the PiPs library now uses animated identities.
    const mountAvatar = () =>
        fixture(t, {
            NamedAgentSheet,
            openAgentSettings,
            NamedAgents: () =>
                h(NamedAgentAvatar, { agentId: active.state.namedAgents[0].agentId }),
        });
    const f = mountAvatar();

    await f.settle();
    const avatar = f.find("img");
    const source = avatar.props.src;

    assert.match(source, /^data:image\/svg\+xml,/);
    assert.equal(avatar.props.alt, "");
    assert.equal(avatar.props["aria-hidden"], "true");
    assert.equal(avatar.props.width, 28);
    assert.equal(avatar.props.height, 28);
    f.patch({
        namedAgents: [
            {
                agentId: "agent-reviewer",
                id: 19,
                chatIds: [7, 19],
                name: "Renamed PiP",
                busy: false,
            },
        ],
    });
    await f.settle();
    assert.equal(f.find("img").props.src, source);
    const remounted = mountAvatar();

    await remounted.settle();
    assert.equal(remounted.find("img").props.src, source);
    remounted.patch({
        namedAgents: [{ agentId: "agent-other", id: 8, chatIds: [8], name: "Long-lived reviewer" }],
    });
    await remounted.settle();
    assert.notEqual(
        remounted.find("img").props.src,
        source,
        "identity comes from stable agentId, not display name or chat id",
    );
    remounted.find("img").props.onError();
    assert.throws(
        () => remounted.find("img"),
        /not found/,
        "a failed decorative image leaves only its quiet reserved space",
    );
});

test("named identities stay static at idle and animate genuine Blobatar only while working", async (t) => {
    const { NamedAgentAvatar } = await import(
        new URL("../web/named-agent-avatar.js", import.meta.url).href
    );
    const f = fixture(t, {
        NamedAgentSheet,
        openAgentSettings,
        NamedAgents: () =>
            h(NamedAgentAvatar, {
                agentId: "agent-reviewer",
                animated: active.state.motionAllowed !== false,
                thinking: active.state.thinking === true,
            }),
    });

    await f.settle();
    const idle = f.find("img");

    assert.match(idle.props.src, /^data:image\/svg\+xml,/);
    assert.equal(idle.props.width, 28);
    assert.equal(idle.props["aria-hidden"], "true");
    f.patch({ thinking: true });
    await f.settle();
    const thinking = f.find("svg");

    assert.match(f.find("g").props.className, /mo-always/);
    assert.match(f.find("g").props.className, /mo-expr/);
    assert.equal(thinking.props.width, idle.props.width);
    assert.equal(thinking.props["aria-hidden"], "true");
    assert.equal(
        thinking.props.role,
        undefined,
        "the face is decoration; callers announce actual activity",
    );
    f.patch({ motionAllowed: false });
    await f.settle();
    assert.notEqual(
        f.find("img").props.src,
        idle.props.src,
        "the static face keeps its working pose",
    );
    f.patch({ thinking: false, motionAllowed: true });
    await f.settle();
    assert.equal(
        f.find("img").props.src,
        idle.props.src,
        "finishing work restores the same idle identity",
    );
});

test("working avatars suspend while hidden or departed and clean up their lifecycle listeners", async (t) => {
    const { NamedAgentAvatar } = await import(
        new URL("../web/named-agent-avatar.js", import.meta.url).href
    );
    const original = Object.getOwnPropertyDescriptor(document, "visibilityState");
    const events = [
        [document, "visibilitychange"],
        [browserEvents, "pagehide"],
        [browserEvents, "pageshow"],
    ] as const;
    const before = events.map(([target, type]) => getEventListeners(target, type).length);

    const visibility = (value: "visible" | "hidden") => {
        Object.defineProperty(document, "visibilityState", { configurable: true, value });
        document.dispatchEvent(new Event("visibilitychange"));
    };

    t.after(() => {
        if (original) {
            Object.defineProperty(document, "visibilityState", original);
        } else {
            Reflect.deleteProperty(document, "visibilityState");
        }
    });
    visibility("hidden");
    const f = fixture(t, {
        NamedAgentSheet,
        openAgentSettings,
        NamedAgents: () =>
            active.state.avatarMounted === false
                ? null
                : h(NamedAgentAvatar, {
                      agentId: "agent-reviewer",
                      animated: true,
                      thinking: active.state.thinking !== false,
                  }),
    });

    await f.settle();
    const stillWorking = f.find("img").props.src;

    visibility("visible");
    await f.settle();
    assert.match(f.find("g").props.className, /mo-expr/);
    visibility("hidden");
    await f.settle();
    assert.equal(f.find("img").props.src, stillWorking);
    browserEvents.dispatchEvent(new Event("pageshow"));
    await f.settle();
    assert.equal(f.find("img").props.src, stillWorking, "pageshow cannot animate a hidden page");
    visibility("visible");
    await f.settle();
    f.find("svg");
    browserEvents.dispatchEvent(new Event("pagehide"));
    document.dispatchEvent(new Event("visibilitychange"));
    await f.settle();
    assert.equal(f.find("img").props.src, stillWorking, "visibility alone cannot undo departure");
    f.patch({ thinking: false });
    await f.settle();
    assert.notEqual(f.find("img").props.src, stillWorking, "activity still updates while paused");
    f.patch({ thinking: true });
    await f.settle();
    assert.equal(f.find("img").props.src, stillWorking);
    browserEvents.dispatchEvent(new Event("pageshow"));
    await f.settle();
    f.find("svg");
    f.patch({ avatarMounted: false });
    assert.deepEqual(
        events.map(([target, type]) => getEventListeners(target, type).length),
        before,
        "unmount releases visibility and page lifecycle subscriptions",
    );
});

test("settings have charter and Memory without inbox or attachment configuration", async (t) => {
    const f = fixture(t);

    f.patch({ conversationId: 7, view: { conversation: { id: 7, pipAgentId: "agent-reviewer" } } });
    f.openSettings();
    await f.settle();
    f.request(0).resolve(settings());
    await f.settle();
    assert.doesNotMatch(
        f.text(),
        /Inbox|Set inbox|New chat|Private notes|Private memory|Old note|Link controller|Detach|Stop supervision/,
    );
    f.patch({ server: { privateAgents: 4, extensions: [] } });
    assert.equal(f.find("button", "Memory").props.disabled, true);
    assert.match(f.text(), /Memory extension is off/);
    f.patch({ server: { privateAgents: 4, extensions: ["pocket-memory"] } });
    f.input("Agent instructions", "Keep my unsaved charter");
    const sheet = f.state.sheet;

    f.click(f.find("button", "Memory"));
    assert.deepEqual(f.state.sheet, { type: "memory", conversationId: "agent:agent-reviewer" });
    f.patch({ sheet });
    await f.settle();
    f.request(1).resolve(settings());
    await f.settle();
    assert.equal(f.label("Agent instructions").props.value, "Keep my unsaved charter");
    f.click(f.find("button", "Model"));
    assert.deepEqual(
        f.state.sheet,
        { type: "model", agentId: "agent-reviewer" },
        "uses the existing model picker with explicit shared identity scope",
    );
    f.patch({ sheet });
    await f.settle();
    f.request(2).resolve(settings(4));
    await f.settle();
    assert.equal(f.label("Agent instructions").props.value, "Keep my unsaved charter");
    assert.equal(
        f.find("button", "Save settings").props.disabled,
        true,
        "an external revision is not silently rebased under the preserved draft",
    );
    f.click(f.find("button", "Load latest settings (replaces draft)"));
    await f.settle();
    f.request(3).resolve(settings(4));
    await f.settle();
    assert.equal(f.label("Agent instructions").props.value, "Review carefully");
});

test("an identity without saved Chats opens a local draft and edits approved shared settings without creating a Chat", async (t) => {
    const f = fixture(t);

    f.patch({
        namedAgents: [
            { agentId: "agent-reviewer", id: null, chatIds: [], chats: [], name: "Reviewer" },
        ],
    });
    f.click(f.find("button", "ReviewerReady"));
    assert.deepEqual(f.openedDrafts, ["agent-reviewer"]);
    assert.deepEqual(f.navigated, []);
    assert.equal(f.requests.length, 0);
    f.openSettings();
    await f.settle();
    assert.equal(f.request(0).path, "pip/agents/agent-reviewer");
    f.request(0).resolve({ ...settings(), id: null, chatIds: [], chats: [] });
    await f.settle();
    assert.equal(f.label("Agent instructions").props.value, "Review carefully");
    f.input("Agent focus", "A shared purpose before first send");
    f.submit();
    assert.equal(f.request(1).path, "pip/agents/agent-reviewer");
    assert.equal(f.request(1).body?.expectedRevision, 3);
    assert.equal(f.request(1).body?.focus, "A shared purpose before first send");
    assert.deepEqual(f.navigated, []);
});

test("legacy native creation preserves its optional context and explicitly retries the same uncertain request", async (t) => {
    const f = fixture(t);

    f.beginCreation();
    await f.settle();
    assert.equal(f.request(0).path, "projects");
    f.request(0).resolve({
        projects: [
            { id: "current-project", name: "Currently open project" },
            { id: "chosen-project", name: "Explicit remit" },
        ],
    });
    await f.settle();
    assert.equal(f.label("Agent name").props.value, "");
    assert.equal(f.label("PiP project").props.value, "", "never inherit the open project");
    assert.doesNotMatch(f.text(), /Instructions|Private notes|History|blueprint|Focus/);
    f.input("Agent name", "My PiP");
    f.input("PiP project", "chosen-project");
    f.submit();
    const first = f.request(1);

    assert.equal(first.path, "pip/agents?identityOnly=1");
    assert.deepEqual(
        { ...first.body, requestId: "stable" },
        { requestId: "stable", name: "My PiP", projectId: "chosen-project" },
    );
    first.reject(new Error("Connection lost"));
    await f.settle();
    assert.match(f.text(), /Creation may have succeeded/);
    assert.equal(f.label("Agent name").props.disabled, true);
    f.click(f.find("button", "Close"));
    f.beginCreation();
    await f.settle();
    f.request(2).resolve({ projects: [] });
    await f.settle();
    assert.equal(f.label("Agent name").props.value, "My PiP");
    assert.equal(f.label("PiP project").props.value, "chosen-project");
    assert.match(f.text(), /Unavailable project/);
    assert.equal(textOf(f.find("button", "Retry creation")), "Retry creation");
    f.submit();
    assert.deepEqual(
        f.request(3).body,
        first.body,
        "retry retains exact id and content even after reopening",
    );
    f.request(3).resolve({ id: null, agentId: "new-pip", name: "My PiP", chats: [] });
    await f.settle();
    assert.deepEqual(f.navigated, [], "identity creation never opens a saved conversation");
    assert.deepEqual(f.openedDrafts, ["new-pip"]);
    assert.equal(f.state.sheet, null);
});

test("tab reload recovers an uncertain creation without automatically repeating it", async (t) => {
    const first = fixture(t);

    first.beginCreation();
    await first.settle();
    first.request(0).resolve({ projects: [] });
    await first.settle();
    first.input("Agent name", "Reloaded PiP");
    first.submit();
    const body = first.request(1).body;

    first.request(1).reject(new Error("Unknown acknowledgement"));
    await first.settle();
    first.click(first.find("button", "Close"));
    const reloaded = await import(new URL("../web/named-agents.js?reload", import.meta.url).href);
    const resumed = fixture(t, reloaded);

    resumed.patch({ me: { ...first.state.me } });
    resumed.beginCreation();
    await resumed.settle();
    resumed.request(0).resolve({ projects: [] });
    await resumed.settle();
    assert.equal(resumed.requests.length, 1, "reloading is read-only until an explicit retry");
    assert.equal(resumed.label("Agent name").props.value, "Reloaded PiP");
    assert.equal(resumed.label("Agent name").props.disabled, true);
    resumed.submit();
    assert.deepEqual(resumed.request(1).body, body);
    resumed
        .request(1)
        .resolve({ id: null, agentId: "reloaded-pip", name: "Reloaded PiP", chats: [] });
    await resumed.settle();
    assert.deepEqual(resumed.navigated, []);
    assert.deepEqual(resumed.openedDrafts, ["reloaded-pip"]);
    assert.equal(storage.get(`pocket.pipCreation.${first.state.me.id}`), undefined);
});

test("a reopened legacy creation joins the original acknowledgement and opens that exact PiP", async (t) => {
    const f = fixture(t);

    f.beginCreation();
    await f.settle();
    f.request(0).resolve({ projects: [] });
    await f.settle();
    f.input("Agent name", "Still creating");
    f.submit();
    f.click(f.find("button", "Close"));
    f.beginCreation();
    await f.settle();
    assert.equal(f.requests.length, 2, "the new opening joins the in-flight request");
    f.request(1).resolve({ id: null, agentId: "joined-pip", name: "Still creating", chats: [] });
    await f.settle();
    assert.deepEqual(f.navigated, []);
    assert.deepEqual(f.openedDrafts, ["joined-pip"]);
    assert.equal(f.state.sheet, null);
    assert.equal(f.requests.length, 2);
});

test("a legacy rejected context stays correctable and No project creates without the open project's remit", async (t) => {
    const f = fixture(t);

    f.beginCreation();
    await f.settle();
    f.request(0).resolve({ projects: [{ id: "removed-project", name: "Soon removed" }] });
    await f.settle();
    f.input("Agent name", "Independent PiP");
    f.input("PiP project", "removed-project");
    f.submit();
    f.request(1).reject(Object.assign(new Error("No such project"), { status: 404 }));
    await f.settle();
    assert.match(f.text(), /No such project/);
    assert.equal(f.label("PiP project").props.disabled, false);
    assert.equal(f.label("Agent name").props.value, "Independent PiP");
    assert.equal(f.requests.length, 2, "no automatic mutation retry");
    f.input("PiP project", "");
    f.submit();
    assert.deepEqual(
        { ...f.request(2).body, requestId: "fresh" },
        { requestId: "fresh", name: "Independent PiP", projectId: null },
    );
    assert.notEqual(f.request(2).body?.requestId, f.request(1).body?.requestId);
    f.request(2).resolve({
        id: null,
        agentId: "no-project-pip",
        name: "Independent PiP",
        chats: [],
    });
    await f.settle();
    assert.deepEqual(f.navigated, []);
    assert.deepEqual(f.openedDrafts, ["no-project-pip"]);
});

test("settings conflict preserves the draft, requires a fresh revision, and undo is a durable server mutation", async (t) => {
    const f = fixture(t);

    f.openSettings();
    await f.settle();
    f.request(0).resolve(settings());
    await f.settle();
    f.input("Agent focus", "Unsaved draft");
    f.submit();
    assert.deepEqual(f.request(1).body, {
        expectedRevision: 3,
        name: "Reviewer",
        instructions: "Review carefully",
        focus: "Unsaved draft",
    });
    f.request(1).reject(Object.assign(new Error("Conflict"), { status: 409 }));
    await f.settle();
    assert.match(f.text(), /changed elsewhere/);
    assert.equal(f.label("Agent focus").props.value, "Unsaved draft");
    assert.equal(f.find("button", "Save settings").props.disabled, true);
    assert.equal(f.find("button", "Restore revision 1").props.disabled, true);
    f.click(f.find("button", "Load latest settings (replaces draft)"));
    await f.settle();
    f.request(2).resolve(settings(4));
    await f.settle();
    assert.equal(f.label("Agent focus").props.value, "Accessibility");
    f.click(f.find("button", "Restore revision 1"));
    assert.deepEqual(f.request(3).body, { action: "undo", expectedRevision: 4, revision: 1 });
    f.request(3).resolve({ revision: 5 });
    await f.settle();
    assert.equal(f.request(4).path, "c/7/private-agent");
    f.request(4).resolve({
        ...settings(5),
        name: "First name",
        instructions: "Initial remit",
        notes: "Old note",
        focus: "",
    });
    await f.settle();
    assert.equal(f.label("Agent name").props.value, "First name");
    assert.match(f.text(), /Restored revision 1/);
});

test("a definite validation rejection keeps the draft editable for a corrected revisioned save", async (t) => {
    const f = fixture(t);

    f.openSettings();
    await f.settle();
    f.request(0).resolve(settings());
    await f.settle();
    f.input("Agent instructions", "Keep this independent charter edit");
    f.input("Agent focus", "x".repeat(2_001));
    f.submit();
    f.request(1).reject(
        Object.assign(new Error("focus must be text of at most 2000 characters"), {
            status: 400,
        }),
    );
    await f.settle();
    assert.equal(f.requests.length, 2, "a rejection never retries automatically");
    assert.equal(f.label("Agent focus").props.value, "x".repeat(2_001));
    assert.equal(f.find("button", "Save settings").props.disabled, false);
    assert.doesNotMatch(f.text(), /may have reached the server/);
    f.input("Agent focus", "Corrected remit");
    f.submit();
    assert.deepEqual(f.request(2).body, {
        expectedRevision: 3,
        name: "Reviewer",
        instructions: "Keep this independent charter edit",
        focus: "Corrected remit",
    });
    f.request(2).resolve({ revision: 4 });
    await f.settle();
    f.request(3).resolve({
        ...settings(4),
        instructions: "Keep this independent charter edit",
        focus: "Corrected remit",
    });
    await f.settle();
    assert.match(f.text(), /Settings saved/);
    assert.equal(f.label("Agent focus").props.value, "Corrected remit");
});

// The HTTP tests own persistence/privacy. This boundary independently owns the settings draft,
// explicit clear/omission semantics and immediate catalogue metadata without waiting for SSE.
test("agent settings save and clear a project link without retargeting Chats or project defaults", async (t) => {
    const f = fixture(t);
    const original = f.state.namedAgents[0];

    f.patch({
        server: { ...f.state.server, projectAgentLinks: 1 },
        projectsLoaded: true,
        projects: [
            { id: "current-project", name: "Build", defaultAgentId: "another-agent" },
            { id: "other-project", name: "Research", defaultAgentId: null },
        ],
        namedAgents: [
            {
                ...original,
                projectId: "current-project",
                chats: [{ id: 7, projectId: "current-project", busy: true }],
            },
        ],
    });
    f.openSettings();
    await f.settle();
    f.request(0).resolve({ ...settings(), projectId: "current-project", updatedAt: 10 });
    await f.settle();
    assert.equal(f.label("PiP project").props.value, "current-project");
    f.input("PiP project", "other-project");
    f.submit();
    assert.equal(f.request(1).body?.projectId, "other-project");
    assert.equal(f.request(1).body?.expectedRevision, 3);
    f.request(1).resolve({ ...settings(4), projectId: "other-project", updatedAt: 20 });
    await f.settle();
    assert.equal(
        f.state.namedAgents[0].projectId,
        "other-project",
        "save updates navigation before a catalogue event",
    );
    assert.equal(
        f.state.namedAgents[0].busy,
        true,
        "settings never replace live aggregate activity",
    );
    assert.equal(f.state.namedAgents[0].chats[0].projectId, "current-project");
    assert.equal(f.state.projects[0].defaultAgentId, "another-agent");
    assert.equal(f.state.projects[1].defaultAgentId, null);
    f.request(2).resolve({ ...settings(4), projectId: "other-project", updatedAt: 20 });
    await f.settle();
    f.input("PiP project", "");
    f.submit();
    assert.equal(f.request(3).body?.projectId, null, "only the explicit clear sends null");
    f.request(3).resolve({ ...settings(5), updatedAt: 30 });
    await f.settle();
    assert.equal(f.state.namedAgents[0].projectId, undefined);
    f.request(4).resolve({ ...settings(5), updatedAt: 30 });
    await f.settle();
    f.input("Agent focus", "Only a charter edit");
    f.submit();
    assert.equal(
        Object.hasOwn(f.request(5).body!, "projectId"),
        false,
        "an unchanged link is omitted",
    );
    f.request(5).resolve({ ...settings(6), updatedAt: 40 });
    await f.settle();
    f.request(6).resolve({ ...settings(6), updatedAt: 40 });
    await f.settle();
    assert.deepEqual(f.navigated, []);
    assert.deepEqual(f.openedDrafts, []);
    assert.ok(f.requests.every((request) => request.path === "c/7/private-agent"));
});

test("older servers report project remit without offering an unsupported editing field", async (t) => {
    for (const [project, label] of [
        [{ id: "chosen", available: true, name: "Current project name" }, "Current project name"],
        [{ id: "gone", available: false, name: "Stale name" }, "Unavailable project"],
        [undefined, "No project"],
    ] as const) {
        const f = fixture(t);

        f.openSettings();
        await f.settle();
        f.request(0).resolve({ ...settings(), project });
        await f.settle();
        assert.match(f.text(), new RegExp(`Project remit: ${label}`));
        assert.doesNotMatch(f.text(), /Project \(optional\)|Stale name/);
        f.input("Agent focus", "Keep the existing remit");
        f.submit();
        assert.equal(Object.hasOwn(f.request(1).body!, "projectId"), false);
        f.request(1).resolve({ revision: 4 });
        await f.settle();
        f.request(2).resolve({ ...settings(4), project });
        await f.settle();
    }
});

test("an inactive instruction proposal only fills the owner's draft until an explicit revisioned save", async (t) => {
    const f = fixture(t);

    f.openSettings();
    await f.settle();
    f.request(0).resolve({
        ...settings(),
        proposal: { instructions: "Proposed charter", expectedRevision: 2, at: 10 },
    });
    await f.settle();
    assert.equal(f.label("Agent instructions").props.value, "Review carefully");
    assert.equal(f.label("Proposed instructions").props.value, "Proposed charter");
    assert.equal(f.label("Proposed instructions").props.readOnly, true);
    assert.match(f.text(), /Agent proposal — not active/);
    assert.equal(f.requests.length, 1, "loading a proposal never applies it");
    f.input("Agent focus", "Keep my unsaved remit");
    f.click(f.find("button", "Use proposal"));
    assert.equal(f.label("Agent instructions").props.value, "Proposed charter");
    assert.equal(f.label("Agent focus").props.value, "Keep my unsaved remit");
    assert.equal(f.requests.length, 1, "using a proposal is draft-only, not approval");
    f.input("Agent instructions", "Proposed charter, edited by owner");
    f.submit();
    assert.deepEqual(f.request(1).body, {
        expectedRevision: 3,
        name: "Reviewer",
        instructions: "Proposed charter, edited by owner",
        focus: "Keep my unsaved remit",
    });
    f.request(1).resolve({ revision: 4 });
    await f.settle();
    f.request(2).resolve({
        ...settings(4),
        instructions: "Proposed charter, edited by owner",
        focus: "Keep my unsaved remit",
    });
    await f.settle();
    assert.doesNotMatch(f.text(), /Agent proposal — not active/);
    assert.equal(f.label("Agent instructions").props.value, "Proposed charter, edited by owner");
});

test("Work Item quick access reports server states and links exact native orchestrators without activation", async (t) => {
    const f = fixture(t);
    const controllers = [
        { workItemId: "work-a", conversationId: 41, title: "Parser", state: "active" },
        {
            workItemId: "work-b",
            conversationId: 42,
            title: "Mobile",
            state: "human control",
            reason: "Owner reclaimed",
        },
        {
            workItemId: "work-c",
            conversationId: 43,
            title: "Storage",
            state: "needs owner",
            reason: "Approval required",
        },
        {
            workItemId: "work-d",
            conversationId: 44,
            title: "Search",
            state: "held",
            reason: "Budget hold",
        },
        {
            workItemId: "work-e",
            conversationId: 45,
            title: "Export",
            state: "failure",
            reason: "Wake failed",
        },
        {
            workItemId: "work-gone",
            conversationId: 46,
            title: "Unavailable Work Item",
            state: "unavailable",
            accessible: false,
            reason: "This Work Item is no longer accessible.",
        },
    ];

    f.patch({
        sessions: [
            {
                id: 91,
                workItemId: "work-new",
                workItemTitle: "Available Work Item",
                supervisor: { conversationId: 60, status: "reclaimed" },
            },
            {
                id: 92,
                workItemId: "work-new",
                supervisor: { conversationId: 60, status: "reclaimed" },
            },
            { id: 93, workItemId: "work-no-controller", title: "Must not create a controller" },
        ],
    });
    f.openSettings();
    await f.settle();
    f.request(0).resolve({ ...settings(), controllers });
    await f.settle();

    assert.equal(textOf(f.find("h3")), "Work Items");
    assert.ok(f.label("Contacted Work Items"));

    for (const item of controllers) {
        if (item.accessible === false) {
            assert.equal(
                nodes(f.label("Contacted Work Items")).some(
                    (node) => node.props.href === `/s/${item.conversationId}`,
                ),
                false,
                "unavailable Work Items must not navigate away from Settings",
            );
            assert.match(f.text(), /Unavailable Work ItemUnavailable/);

            continue;
        }

        assert.match(f.text(), new RegExp(`${item.title}${item.state}`));

        if (item.reason) {
            assert.match(f.text(), new RegExp(item.reason));
        }

        const link = f.label(`Open orchestrator for ${item.title}`);

        assert.equal(link.props.href, `/s/${item.conversationId}`);
    }

    assert.equal(f.requests.length, 1, "projected statuses never activate or poll controllers");
    assert.doesNotMatch(f.text(), /\d+ subagents|Must not create a controller/);
    f.input("Agent instructions", "Unsaved charter stays private");
    f.click(f.find("button", "Refresh Work Items"));
    await f.settle();
    assert.equal(f.request(1).body, undefined, "refresh is a read, not a link or activation");
    f.request(1).resolve({ ...settings(), controllers });
    await f.settle();
    assert.equal(f.label("Agent instructions").props.value, "Unsaved charter stays private");
    assert.doesNotMatch(f.text(), /Existing controller|Link controller|Detach|Stop supervision/);
    f.click(f.label("Open orchestrator for Mobile"));
    assert.deepEqual(f.navigated, [42], "not an execution thread or a designated home chat");
    assert.equal(f.requests.length, 2, "opening an independent controller performs no mutation");
});

test("a dismissed opening cannot overwrite a new draft or navigate when its mutation finishes", async (t) => {
    const f = fixture(t);

    f.beginCreation();
    await f.settle();
    f.request(0).resolve({ projects: [] });
    await f.settle();
    f.input("Agent name", "My PiP");
    f.submit();
    f.click(f.find("button", "Close"));
    f.openSettings();
    await f.settle();
    f.request(2).resolve(settings());
    await f.settle();
    f.input("Agent name", "New draft");
    f.request(1).resolve({ id: 18 });
    await f.settle();
    assert.equal(f.label("Agent name").props.value, "New draft");
    assert.deepEqual(f.navigated, []);
    assert.equal(f.state.sheet.id, 7);

    f.submit();
    f.patch({ conversationId: 99 });
    f.request(3).resolve({ revision: 4 });
    await f.settle();
    assert.equal(
        f.requests.length,
        4,
        "a stale completion does not reload into another conversation",
    );
});
