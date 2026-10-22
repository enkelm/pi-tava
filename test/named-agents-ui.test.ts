// Exercise the exported private-agent UI with deferred API responses and memory-only hooks.
// This covers drafts, revision/retry admission and stale openings, not browser layout or device focus.
import assert from "node:assert/strict";
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
};
const descriptor = Object.getOwnPropertyDescriptor(globalThis, "namedAgentsUiFixture");
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
const storage = new Map<string, string>();

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
    "./ui.js": `const f=globalThis.namedAgentsUiFixture;
        export const html=f.html,Icon=({name,size})=>f.h('test-icon',{name,size}),Loader=({label})=>f.h('test-loader',{label});
        export const Sheet=({children})=>children,timeAgo=()=>"Recently";`,
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

        const source = /\/web\/(?:named-agents|named-agent-avatar)\.js$/.test(
            context.parentURL?.split("?")[0] ?? "",
        )
            ? sources[specifier]
            : undefined;

        return source === undefined
            ? next(specifier, context)
            : { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    },
});
const { NamedAgents, NamedAgentSheet } = await import(
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

function fixture(t: TestContext, components = { NamedAgents, NamedAgentSheet }) {
    const fibers = new Map<string, Fiber>();
    const effects: (() => void)[] = [];
    const requests: Request[] = [];
    const navigated: number[] = [];
    const state: Props = {
        me: { id: `owner-${++owner}`, role: "owner" },
        server: { privateAgents: 3, extensions: ["pocket-memory"] },
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

        return { ...node, props: { ...node.props, children: resolve(node.props.children, path) } };
    };

    const render = () => {
        for (let count = 0; dirty; count++) {
            assert.ok(count < 20, "UI did not settle");
            dirty = false;
            visited = new Set();
            tree = resolve(
                [
                    h(components.NamedAgents, {}),
                    state.sheet ? h(components.NamedAgentSheet, { sheet: state.sheet }) : null,
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

    f.click(f.label("Edit Long-lived reviewer"));
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

test("only a capable owner sees agents, with disclosure, exact conversation navigation and pinned edit", async (t) => {
    const f = fixture(t);

    assert.equal(f.requests.length, 0, "listing uses the realtime catalogue, not polling");
    assert.match(f.text(), /Long-lived reviewerWorking/);
    const toggle = f.label("Collapse PiPs");
    const listId = toggle.props["aria-controls"];

    assert.ok(listId, "disclosure identifies its controlled list");
    assert.equal(toggle.props["aria-expanded"], true);
    f.click(toggle);
    assert.equal(f.label("Expand PiPs").props["aria-expanded"], false);
    assert.equal(
        nodes(f.label("PiPs")).find((node) => node.props.id === listId)?.props.hidden,
        true,
    );
    assert.doesNotMatch(f.text(), /Long-lived reviewer/);
    f.click(f.label("Expand PiPs"));
    f.patch({ conversationId: 7 });
    assert.equal(f.find("button", "Long-lived reviewerWorking").props["aria-current"], "page");
    f.click(f.find("button", "Long-lived reviewerWorking"));
    assert.deepEqual(f.navigated, [7]);
    f.click(f.label("Edit Long-lived reviewer"));
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

test("the PiPs entry has a leading PiP icon, no count or chevron, and a semantic sibling creation control", (t) => {
    const f = fixture(t);
    const entry = f.label("PiPs controls");
    const toggle = f.label("Collapse PiPs");
    const create = f.label("New PiP");
    const buttons = nodes(entry).filter((node) => node.type === "button");

    assert.equal(entry.props.role, "group");
    assert.deepEqual(buttons, [toggle, create], "both native controls share the same entry");
    assert.equal(entry.props.onClick, undefined, "the shared entry is not a competing toggle");
    assert.equal(textOf(toggle), "PiPs", "no numeric count or empty-count label");
    assert.equal(toggle.props["aria-describedby"], undefined, "no obsolete count reference");
    assert.ok(nodes(entry).every((node) => !String(node.props.id ?? "").endsWith("-count")));
    assert.deepEqual(
        nodes(toggle)
            .filter((node) => node.type === "test-icon")
            .map((node) => node.props.name),
        ["pip"],
        "the PiP icon is the sole leading icon; no disclosure chevron",
    );
    assert.equal(nodes(toggle)[1]?.type, "test-icon");
    assert.deepEqual(
        nodes(create)
            .filter((node) => node.type === "test-icon")
            .map((node) => node.props.name),
        ["plus"],
    );

    for (const button of buttons) {
        assert.equal(button.props.type, "button");
        assert.equal(button.props.disabled, undefined);
        assert.equal(button.props.tabIndex, undefined, "native keyboard tab order is retained");
        assert.equal(
            nodes(button)
                .slice(1)
                .some((node) => node.type === "button" || node.type === "a"),
            false,
            "interactive controls are siblings, never nested",
        );
    }

    let stopped = 0;

    create.props.onClick({ stopPropagation: () => stopped++ });
    assert.equal(stopped, 1, "creation cannot bubble into entry disclosure");
    assert.equal(f.label("Collapse PiPs").props["aria-expanded"], true);
    assert.equal(f.state.sheet.type, "named-agent");
    assert.equal(f.state.sheet.id, null);
    f.patch({ sheet: null });
    f.click(f.label("Collapse PiPs"));
    assert.equal(f.label("Expand PiPs").props["aria-expanded"], false);
    f.click(f.label("New PiP"));
    assert.equal(
        f.label("Expand PiPs").props["aria-expanded"],
        false,
        "creation does not expand a folded entry",
    );
    assert.equal(f.state.sheet.id, null);
    f.patch({ sheet: null, me: { id: "guest", role: "guest" } });
    create.props.onClick({ stopPropagation() {} });
    assert.equal(f.state.sheet, null, "a stale create control cannot bypass private access loss");
});

test("an empty PiPs group offers an inline named create action without a helper paragraph", (t) => {
    const f = fixture(t);

    f.patch({ namedAgents: [] });
    assert.equal(textOf(f.label("New PiP")), "New PiP");
    assert.equal(textOf(f.label("Collapse PiPs")), "PiPs");
    assert.doesNotMatch(f.text(), /Create a PiP to work with privately/);
    f.click(f.label("Collapse PiPs"));
    assert.equal(f.label("Expand PiPs").props["aria-expanded"], false);
    assert.equal(textOf(f.label("New PiP")), "New PiP", "create remains available while folded");
    f.click(f.label("New PiP"));
    assert.equal(f.state.sheet.type, "named-agent");
    assert.equal(f.state.sheet.id, null);
});

test("genuine Blobatar images keep their identity through rename and remount and fail quietly", async (t) => {
    await import("blobatar/react");
    const f = fixture(t);

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
    const remounted = fixture(t);

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
    assert.equal(
        nodes(remounted.label("PiPs")).some((node) => node.type === "img"),
        false,
    );
    remounted.click(remounted.find("button", "Long-lived reviewerReady"));
    assert.deepEqual(remounted.navigated, [8], "a failed image cannot disable its PiP");
    assert.ok(remounted.label("Edit Long-lived reviewer"));
});

test("settings have charter and Memory without inbox or attachment configuration", async (t) => {
    const f = fixture(t);

    f.patch({ conversationId: 7, view: { conversation: { id: 7, pipAgentId: "agent-reviewer" } } });
    f.click(f.label("Edit Long-lived reviewer"));
    await f.settle();
    f.request(0).resolve(settings());
    await f.settle();
    assert.doesNotMatch(
        f.text(),
        /Inbox|Set inbox|New chat|Private notes|Private memory|Old note|Link controller|Detach|Stop supervision/,
    );
    f.patch({ server: { privateAgents: 3, extensions: [] } });
    assert.equal(f.find("button", "Memory").props.disabled, true);
    assert.match(f.text(), /Memory extension is off/);
    f.patch({ server: { privateAgents: 3, extensions: ["pocket-memory"] } });
    f.input("Agent instructions", "Keep my unsaved charter");
    const sheet = f.state.sheet;

    f.click(f.find("button", "Memory"));
    assert.deepEqual(f.state.sheet, { type: "memory", conversationId: 7 });
    f.patch({ sheet });
    await f.settle();
    f.request(1).resolve(settings());
    await f.settle();
    assert.equal(f.label("Agent instructions").props.value, "Keep my unsaved charter");
    f.click(f.find("button", "Model"));
    assert.deepEqual(
        f.state.sheet,
        { type: "model" },
        "uses the existing current-chat model picker",
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

test("creation asks only for name and optional project and explicitly retries the same uncertain request", async (t) => {
    const f = fixture(t);

    f.click(f.label("New PiP"));
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

    assert.equal(first.path, "pip/agents");
    assert.deepEqual(
        { ...first.body, requestId: "stable" },
        { requestId: "stable", name: "My PiP", projectId: "chosen-project" },
    );
    first.reject(new Error("Connection lost"));
    await f.settle();
    assert.match(f.text(), /Creation may have succeeded/);
    assert.equal(f.label("Agent name").props.disabled, true);
    f.click(f.find("button", "Close"));
    f.click(f.label("New PiP"));
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
    f.request(3).resolve({ id: 12 });
    await f.settle();
    assert.deepEqual(f.navigated, [12]);
    assert.equal(f.state.sheet, null);
});

test("tab reload recovers an uncertain creation without automatically repeating it", async (t) => {
    const first = fixture(t);

    first.click(first.label("New PiP"));
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
    resumed.click(resumed.label("New PiP"));
    await resumed.settle();
    resumed.request(0).resolve({ projects: [] });
    await resumed.settle();
    assert.equal(resumed.requests.length, 1, "reloading is read-only until an explicit retry");
    assert.equal(resumed.label("Agent name").props.value, "Reloaded PiP");
    assert.equal(resumed.label("Agent name").props.disabled, true);
    resumed.submit();
    assert.deepEqual(resumed.request(1).body, body);
    resumed.request(1).resolve({ id: 26 });
    await resumed.settle();
    assert.deepEqual(resumed.navigated, [26]);
    assert.equal(storage.get(`pocket.pipCreation.${first.state.me.id}`), undefined);
});

test("a reopened creation joins the original acknowledgement and opens that exact PiP", async (t) => {
    const f = fixture(t);

    f.click(f.label("New PiP"));
    await f.settle();
    f.request(0).resolve({ projects: [] });
    await f.settle();
    f.input("Agent name", "Still creating");
    f.submit();
    f.click(f.find("button", "Close"));
    f.click(f.label("New PiP"));
    await f.settle();
    assert.equal(f.requests.length, 2, "the new opening joins the in-flight request");
    f.request(1).resolve({ id: 27 });
    await f.settle();
    assert.deepEqual(f.navigated, [27]);
    assert.equal(f.state.sheet, null);
    assert.equal(f.requests.length, 2);
});

test("a rejected project stays correctable and No project creates without the open project's remit", async (t) => {
    const f = fixture(t);

    f.click(f.label("New PiP"));
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
    f.request(2).resolve({ id: 23 });
    await f.settle();
    assert.deepEqual(f.navigated, [23]);
});

test("settings conflict preserves the draft, requires a fresh revision, and undo is a durable server mutation", async (t) => {
    const f = fixture(t);

    f.click(f.label("Edit Long-lived reviewer"));
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

    f.click(f.label("Edit Long-lived reviewer"));
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

test("advanced settings report project remit availability without a project editing field", async (t) => {
    for (const [project, label] of [
        [{ id: "chosen", available: true, name: "Current project name" }, "Current project name"],
        [{ id: "gone", available: false, name: "Stale name" }, "Unavailable project"],
        [undefined, "No project"],
    ] as const) {
        const f = fixture(t);

        f.click(f.label("Edit Long-lived reviewer"));
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

    f.click(f.label("Edit Long-lived reviewer"));
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
    f.click(f.label("Edit Long-lived reviewer"));
    await f.settle();
    f.request(0).resolve({ ...settings(), controllers });
    await f.settle();

    assert.equal(textOf(f.find("h3")), "Work Items");
    assert.ok(f.label("Contacted Work Items"));

    for (const item of controllers) {
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

    f.click(f.label("New PiP"));
    await f.settle();
    f.request(0).resolve({ projects: [] });
    await f.settle();
    f.input("Agent name", "My PiP");
    f.submit();
    f.click(f.find("button", "Close"));
    f.click(f.label("Edit Long-lived reviewer"));
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
