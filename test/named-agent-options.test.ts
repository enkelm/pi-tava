// The real menu and native identity subflows own target selection and live callback admission.
// Draft tests own first Send; generic popup tests own focus, Escape and placement lifecycle.
// Only OptionsSurface rendering and the unused Node-incompatible sanitizer are replaced.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, test } from "node:test";
import { h, isValidElement, type VNode } from "preact";

type Props = Record<string, any>;
type Element = VNode<Props>;
type Opening = {
    type: "sidebar-options";
    kind: "named-agent";
    id: string;
    userId?: string;
    at?: { x: number; y: number; keyboard?: boolean; touch?: boolean };
};

let width = 1280;
const storage = new Map<string, string>();
const requests: unknown[][] = [];
const location = new URL("http://offline.invalid/s/19");
const windowEvents = new EventTarget();
const document = Object.assign(new EventTarget(), {
    visibilityState: "hidden",
    querySelector: () => null,
    documentElement: { dataset: {} },
});
const surface = (props: Props) => h("test-options", props);
const globals: Record<string, unknown> = {
    namedAgentOptionsFixture: { surface },
    document,
    location,
    navigator: { platform: "", onLine: false },
    history: {
        state: null as unknown,
        pushState(this: { state: unknown }, state: unknown, _title: string, path: string) {
            this.state = state;
            location.href = new URL(path, location).href;
        },
    },
    sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
    },
    localStorage: { getItem: () => null },
    matchMedia: (query: string) =>
        Object.defineProperty(new EventTarget(), "matches", {
            get() {
                const max = query.match(/max-width: (\d+)px/);
                const min = query.match(/min-width: (\d+)px/);

                return max ? width <= Number(max[1]) : min ? width >= Number(min[1]) : false;
            },
        }),
    addEventListener: windowEvents.addEventListener.bind(windowEvents),
    removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
    fetch: async (...args: unknown[]) => {
        requests.push(args);

        throw new Error("No HTTP is expected while opening identity actions");
    },
};
const descriptors = Object.keys(globals).map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
);

for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
}

const hooks = registerHooks({
    resolve(specifier, context, next) {
        const source =
            context.parentURL?.endsWith("/web/sheets/named-agent-options.js") &&
            specifier === "./sidebar-options.js"
                ? "export const OptionsSurface = globalThis.namedAgentOptionsFixture.surface;"
                : context.parentURL?.endsWith("/web/ui.js") && specifier === "dompurify"
                  ? "export default { addHook() {} };"
                  : undefined;

        return source === undefined
            ? next(specifier, context)
            : { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    },
});
const { NamedAgentOptions } = await import(
    new URL("../web/sheets/named-agent-options.js", import.meta.url).href
);
const { store } = await import(new URL("../web/store.js", import.meta.url).href);
const { agentDrafts } = await import(new URL("../web/agent-drafts.js", import.meta.url).href);
const initial = store.state;
let owner = 0;

after(async () => {
    // Native navigation's history/heading timers finish before restoring their browser globals.
    await new Promise((resolve) => setTimeout(resolve, 650));
    hooks.deregister();

    for (const [key, descriptor] of descriptors) {
        if (descriptor) {
            Object.defineProperty(globalThis, key, descriptor);
        } else {
            Reflect.deleteProperty(globalThis, key);
        }
    }
});

function nodes(value: unknown): Element[] {
    if (Array.isArray(value)) {
        return value.flatMap(nodes);
    }

    if (!isValidElement(value)) {
        return [];
    }

    const element = value as Element;

    return [element, ...nodes(element.props.children)];
}

function text(value: unknown): string {
    if (Array.isArray(value)) {
        return value.map(text).join("");
    }

    if (isValidElement(value)) {
        return text((value as Element).props.children);
    }

    return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function reset(chatless = false) {
    width = 1280;
    requests.length = 0;
    storage.clear();
    const userId = `owner-${++owner}`;
    const sheet: Opening = {
        type: "sidebar-options",
        kind: "named-agent",
        id: "inactive-agent",
        userId,
        at: { x: 150, y: 220, touch: false },
    };

    store.state = {
        ...initial,
        me: { id: userId, role: "owner" },
        server: { privateAgents: 4, extensions: ["pocket-memory"] },
        namedAgents: [
            { agentId: "active-agent", id: 19, name: "Active Ada", chatIds: [19] },
            {
                agentId: "inactive-agent",
                id: chatless ? null : 73,
                name: "Inactive Bea",
                chatIds: chatless ? [] : [73],
            },
        ],
        sessions: [
            { id: 19, pipAgentId: "active-agent" },
            ...(chatless ? [] : [{ id: 73, pipAgentId: "inactive-agent" }]),
        ],
        view: { ...initial.view, conversation: { id: 19, pipAgentId: "active-agent" } },
        conversationId: 19,
        sidebarTab: "private",
        sheet,
    };

    return sheet;
}

function menu(sheet: Opening) {
    const frame = NamedAgentOptions({ sheet }) as Element;

    assert.equal(frame.type, surface, "identity options use the shared native surface");
    const buttons = nodes(frame.props.children).filter((node) => node.type === "button");

    return {
        frame,
        buttons,
        labels: buttons.map((button) => text(button.props.children).trim()),
        message: text(frame.props.children),
        button(label: string) {
            const button = buttons.find((node) => text(node.props.children).trim() === label);

            assert.ok(button, `rendered ${label} action exists`);

            return button.props;
        },
    };
}

const labels = ["New chat", "Memory", "Rename…", "Agent settings…"];

for (const chatless of [false, true]) {
    test(`${chatless ? "an identity without chats" : "an inactive identity"} opens native actions for itself without selecting a saved chat`, () => {
        for (const label of labels) {
            const sheet = reset(chatless);
            const rendered = menu(sheet);
            const sessions = store.state.sessions;
            const agents = store.state.namedAgents;

            assert.equal(rendered.frame.props.title, "Inactive Bea");
            assert.deepEqual(rendered.labels, labels, "no run, archive or delete actions");
            rendered.button(label).onClick();

            if (label === "New chat") {
                assert.equal(store.state.sidebarTab, "sessions");
                assert.equal(store.state.conversationId, null);
                assert.equal(store.state.sheet, null);
                assert.equal(store.state.agentDraft.agentId, "inactive-agent");
                assert.equal(agentDrafts("inactive-agent").length, 1);
                assert.equal(agentDrafts("active-agent").length, 0);
            } else {
                assert.equal(store.state.conversationId, 19, "editing does not navigate first");
                assert.equal(store.state.agentDraft, null);

                if (label === "Memory") {
                    assert.deepEqual(store.state.sheet, {
                        type: "memory",
                        conversationId: "agent:inactive-agent",
                    });
                } else {
                    assert.equal(store.state.sheet.type, "named-agent");
                    assert.equal(
                        store.state.sheet.id,
                        null,
                        "settings bind the identity, not a chat",
                    );
                    assert.equal(store.state.sheet.agentId, "inactive-agent");
                    assert.equal(store.state.sheet.section, label === "Rename…" ? "name" : null);
                    assert.equal(store.state.sheet.userId, sheet.userId);
                }
            }

            assert.equal(store.state.sessions, sessions, "the menu does not create a stored chat");
            assert.equal(store.state.namedAgents, agents);
            assert.deepEqual(requests, [], "native subflows, not the menu, own API operations");
        }
    });
}

test("Memory explains its disabled state and rechecks extension availability before acting", () => {
    const sheet = reset();

    store.state.server.extensions = [];
    const disabled = menu(sheet).button("Memory");

    assert.equal(disabled.disabled, true);
    assert.match(disabled.title, /Enable Memory in Extensions/);
    disabled.onClick();
    assert.equal(store.state.sheet, sheet);
    store.state.server.extensions = ["pocket-memory"];
    const enabled = menu(sheet).button("Memory");

    assert.equal(enabled.disabled, false);
    store.state.server.extensions = [];
    enabled.onClick();
    assert.equal(store.state.sheet, sheet, "an enabled render cannot retain revoked Memory access");
    store.state.server.extensions = ["pocket-memory"];
    menu(sheet).button("Memory").onClick();
    assert.equal(store.state.sheet.conversationId, "agent:inactive-agent");
    assert.deepEqual(requests, []);
});

const revocations: [string, (sheet: Opening) => void][] = [
    ["owner switch", () => (store.state.me = { id: "other-owner", role: "owner" })],
    ["owner role loss", () => (store.state.me.role = "guest")],
    ["sign out", () => (store.state.me = null)],
    ["capability downgrade", () => (store.state.server.privateAgents = 3)],
    ["server availability loss", () => (store.state.server = null)],
    [
        "catalogue target removal",
        () => (store.state.namedAgents = store.state.namedAgents.slice(0, 1)),
    ],
    ["catalogue availability loss", () => (store.state.namedAgents = undefined)],
    ["replacement opening with the same values", (sheet) => (store.state.sheet = { ...sheet })],
    ["closed opening", () => (store.state.sheet = null)],
];

for (const [reason, revoke] of revocations) {
    test(`${reason} hides options and refuses every retained action callback`, () => {
        for (const label of labels) {
            const sheet = reset();
            const callback = menu(sheet).button(label).onClick;

            revoke(sheet);
            const before = store.state;
            const saved = [...storage];

            callback();
            assert.equal(store.state, before, `${label} must not affect a revoked opening`);
            assert.deepEqual([...storage], saved);
            assert.deepEqual(requests, []);
            const unavailable = menu(sheet);

            assert.equal(unavailable.buttons.length, 0);
            assert.match(unavailable.message, /This agent is no longer available/);
        }
    });
}

for (const invalid of ["unknown identity", "missing opening owner", "different opening owner"]) {
    test(`${invalid} never falls back to the active identity`, () => {
        const sheet = reset();

        if (invalid === "unknown identity") {
            sheet.id = "missing-agent";
        } else if (invalid === "missing opening owner") {
            delete sheet.userId;
        } else {
            sheet.userId = "other-owner";
        }

        const unavailable = menu(sheet);

        assert.equal(unavailable.buttons.length, 0);
        assert.match(unavailable.message, /This agent is no longer available/);
        assert.notEqual(unavailable.frame.props.title, "Active Ada");
    });
}

test("the shared surface gets the same narrow touch threshold and keyboard/mouse semantics", () => {
    const sheet = reset();
    const cases: [number, Opening["at"], boolean][] = [
        [1280, { x: 200, y: 300, touch: false }, false],
        [700, { x: 200, y: 300, touch: true }, false],
        [699, { x: 200, y: 300, touch: true }, true],
        [699, { x: 200, y: 300, touch: false }, false],
        [699, { x: 200, y: 300, keyboard: true }, false],
        [699, { x: 200, y: 300, keyboard: true, touch: true }, false],
        [699, undefined, true],
    ];

    for (const [viewport, at, bottom] of cases) {
        width = viewport;
        sheet.at = at;
        const rendered = menu(sheet);

        assert.equal(
            rendered.frame.props.at,
            at,
            "contact and keyboard provenance reach the surface",
        );
        assert.equal(Boolean(rendered.frame.props.bottom), bottom);

        for (const button of rendered.buttons) {
            assert.equal(button.props.role, bottom ? undefined : "menuitem");
            assert.equal(button.props.tabindex, bottom ? undefined : -1);
        }
    }
});
