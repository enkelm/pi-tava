// Offline public component checks: controlled runtime/HTTP, not browser or device proof.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, test, type TestContext } from "node:test";
import { h } from "preact";

const html = (await import(import.meta.resolve("htm"))).default.bind(h);

type Props = Record<string, any>;
type Slot = { value?: any; deps?: unknown[]; cleanup?: () => void };
type Fiber = { slots: Slot[]; cursor: number };
let active: Props;
const bridge = {
    html,
    store: {
        get state() {
            return active.state;
        },
    },
    api: (...args: any[]) => active.api(...args),
    uid: () => active.uid(),
    navigate: (id: number) => active.navigate(id),
    toSessions: () => active.toSessions(),
    openSheet: (sheet: Props) => active.openSheet(sheet),
    projectsAvailable: () => true,
    useChanges: () => ({ changes: active.changes }),
    headLabel: () => "feature/tabs",
    branchAvailable: () => true,
    folderColor: (cwd: string) => {
        active.folders.push(cwd);

        return "var(--test-folder)";
    },
    conversationLocation: () => null,
    useEdge: (name: string) => {
        active.edges.push(name);

        return () => {};
    },
    setFilesOpen: (...args: unknown[]) => active.actions.push(["files", ...args]),
    openSubagents: () => active.actions.push(["subagents"]),
    marker: (utility: string, props: Props) => h("test-utility", { utility, ...props }),
    hooks: {
        useState: (...args: any[]) => active.hooks.useState(...args),
        useRef: (...args: any[]) => active.hooks.useRef(...args),
        useEffect: (...args: any[]) => active.hooks.useEffect(...args),
    },
};
const descriptor = Object.getOwnPropertyDescriptor(globalThis, "agentTabsUiFixture");
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
const storage = new Map<string, string>();

Object.defineProperty(globalThis, "agentTabsUiFixture", { configurable: true, value: bridge });
Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
    },
});
after(() => {
    for (const [key, previous] of [
        ["agentTabsUiFixture", descriptor],
        ["sessionStorage", storageDescriptor],
    ] as const) {
        if (previous) {
            Object.defineProperty(globalThis, key, previous);
        } else {
            Reflect.deleteProperty(globalThis, key);
        }
    }
});
const sources: Record<string, string> = {
    "preact/hooks": "export const {useState,useRef,useEffect}=globalThis.agentTabsUiFixture.hooks;",
    "./store.js":
        "export const {store,api,uid,navigate,openSheet,projectsAvailable}=globalThis.agentTabsUiFixture; export const closeSheet=()=>{};",
    "./sessions.js": "export const {toSessions}=globalThis.agentTabsUiFixture;",
    "./ui.js":
        "export const {html,useEdge}=globalThis.agentTabsUiFixture,Icon=()=>null; export const shortPath=(path)=>path,Loader=()=>null,Sheet=()=>null,timeAgo=()=>'';",
    "./avatar.js": "export const {folderColor}=globalThis.agentTabsUiFixture;",
    "./diff.js": "export const {useChanges}=globalThis.agentTabsUiFixture;",
    "./sheets/branch.js": "export const {headLabel,branchAvailable}=globalThis.agentTabsUiFixture;",
    "./subagents.js": "export const {openSubagents}=globalThis.agentTabsUiFixture;",
    "./workspace-location.js": "export const {conversationLocation}=globalThis.agentTabsUiFixture;",
    "./browser-panel.js":
        "export const BrowserButton=(props)=>globalThis.agentTabsUiFixture.marker('BrowserButton',props);",
    "./chat.js":
        "export const PeopleButton=(props)=>globalThis.agentTabsUiFixture.marker('PeopleButton',props);",
    "./peeks.js":
        "export const PeeksButton=(props)=>globalThis.agentTabsUiFixture.marker('PeeksButton',props);",
    "./files-panel.js":
        "export const {setFilesOpen}=globalThis.agentTabsUiFixture,filesAvailable=()=>true,FilesButton=(props)=>globalThis.agentTabsUiFixture.marker('FilesButton',props);",
    "./extension-ui.js":
        "export const ExtensionSessionControls=(props)=>globalThis.agentTabsUiFixture.marker('ExtensionSessionControls',props);",
    "./thread-type.js":
        "export const ThreadTypeTag=(props)=>globalThis.agentTabsUiFixture.marker('ThreadTypeTag',props);",
};

registerHooks({
    resolve(specifier, context, next) {
        const source = /\/web\/(?:agent-tabs|named-agents|named-agent-avatar|topbar)\.js$/.test(
            context.parentURL?.split("?")[0] ?? "",
        )
            ? sources[specifier]
            : undefined;

        return source === undefined
            ? next(specifier, context)
            : { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    },
});
const { AgentTabs } = await import(new URL("../web/agent-tabs.js", import.meta.url).href);
const { Topbar } = await import(new URL("../web/topbar.js", import.meta.url).href);
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
let owners = 0;

function nodes(value: any): any[] {
    return Array.isArray(value)
        ? value.flatMap(nodes)
        : value?.props
          ? [value, ...nodes(value.props.children)]
          : [];
}

function textOf(value: any): string {
    return Array.isArray(value)
        ? value.map(textOf).join("")
        : value?.props
          ? textOf(value.props.children)
          : typeof value === "string"
            ? value
            : "";
}

function fixture(t: TestContext, Component = AgentTabs) {
    const fibers = new Map<string, Fiber>();
    const effects: (() => void)[] = [];
    const requests: any[] = [];
    const navigated: number[] = [];
    const returned: string[] = [];
    const opened: Props[] = [];
    const actions: unknown[][] = [];
    const folders: string[] = [];
    const edges: string[] = [];
    const elements = new Map<string, any>();
    let focused: any = null;
    let committedRefs = new Map<string, { ref: any; element: any }>();
    let nextRefs = new Map<string, { ref: any; element: any }>();
    let attached = new Set<string>();
    const state: Props = {
        me: { id: `tabs-owner-${++owners}`, role: "owner" },
        server: { privateAgents: 3 },
        sessions: [],
        conversationId: 19,
        view: { conversation: { id: 19, pipAgentId: "stable-agent" } },
        retained: {
            drafts: { 7: "Unsaved first draft", 19: "Unsaved active draft" },
            runs: { 19: { busy: true, task: "running-task" } },
            history: { 7: ["setup"], 19: ["review"] },
        },
        namedAgents: [
            {
                agentId: "stable-agent",
                id: 7,
                name: "Reviewer",
                chatIds: [7, 19],
                chats: [
                    { id: 7, title: "Initial setup", busy: false, updatedAt: 1 },
                    { id: 19, title: "Accessibility review", busy: true, updatedAt: 2 },
                ],
            },
        ],
    };
    let current: Fiber;
    let dirty = true;
    let tree: any;
    let sequence = 0;
    const slot = () => (current.slots[current.cursor++] ??= {});
    const hooks = {
        useState(initial: any) {
            const item = slot();

            if (!("value" in item)) {
                item.value = typeof initial === "function" ? initial() : initial;
            }

            return [
                item.value,
                (value: any) => {
                    item.value = typeof value === "function" ? value(item.value) : value;
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
        actions,
        folders,
        edges,
        changes: { files: [{ path: "src/feature.ts", added: 2, removed: 1 }], repo: true },
        openSheet(sheet: Props) {
            opened.push(sheet);
            state.sheet = sheet;
            dirty = true;
        },
        navigate(id: number) {
            navigated.push(id);
            state.conversationId = id;
            state.view = { conversation: null };
            dirty = true;
        },
        toSessions() {
            returned.push("sessions");
            state.conversationId = null;
            state.view = { conversation: null };
            dirty = true;
        },
        uid: () => `tab-request-${++sequence}`,
        api: (path: string, body: Props) =>
            new Promise((resolve, reject) => requests.push({ path, body, resolve, reject })),
    };

    const resolve = (node: any, path: string, visited: Set<string>): any => {
        if (Array.isArray(node)) {
            return node.map((child, index) =>
                resolve(
                    child,
                    `${path}.${child?.key === undefined ? index : `key:${child.key}`}`,
                    visited,
                ),
            );
        }

        if (!node?.props) {
            return node;
        }

        if (typeof node.type === "function") {
            const key = `${path}:${node.key ?? ""}`;

            current = fibers.get(key) ?? { slots: [], cursor: 0 };
            fibers.set(key, current);
            visited.add(key);
            current.cursor = 0;

            return resolve(node.type(node.props), `${key}.child`, visited);
        }

        const element = elements.get(path) ?? {
            focus() {
                focused = element;
            },
            scrolls: [] as unknown[],
            scrollIntoView(options: unknown) {
                element.scrolls.push(options);
            },
        };

        elements.set(path, element);
        element.props = node.props;
        attached.add(path);
        const ref = node.ref ?? node.props.ref;

        if (ref) {
            nextRefs.set(path, { ref, element });
        }

        return {
            ...node,
            element,
            props: {
                ...node.props,
                children: resolve(node.props.children, `${path}.children`, visited),
            },
        };
    };

    const render = () => {
        for (let count = 0; dirty; count++) {
            assert.ok(count < 20);
            dirty = false;
            const visited = new Set<string>();

            nextRefs = new Map();
            attached = new Set();
            tree = resolve(h(Component, {}), "root", visited);

            for (const [key, fiber] of fibers) {
                if (!visited.has(key)) {
                    fiber.slots.forEach((item) => item.cleanup?.());
                    fibers.delete(key);
                }
            }

            const assign = (ref: any, element: any) => {
                if (typeof ref === "function") {
                    ref(element);
                } else {
                    ref.current = element;
                }
            };

            for (const [path, previous] of committedRefs) {
                if (nextRefs.get(path)?.ref !== previous.ref) {
                    assign(previous.ref, null);
                }
            }

            for (const [path, next] of nextRefs) {
                if (committedRefs.get(path)?.ref !== next.ref) {
                    assign(next.ref, next.element);
                }
            }

            committedRefs = nextRefs;

            for (const [path, element] of elements) {
                if (!attached.has(path)) {
                    if (focused === element) {
                        focused = null;
                    }

                    elements.delete(path);
                }
            }

            effects.splice(0).forEach((run) => run());
        }
    };

    t.after(() => fibers.forEach((fiber) => fiber.slots.forEach((item) => item.cleanup?.())));
    render();

    return {
        state,
        requests,
        navigated,
        returned,
        opened,
        actions,
        folders,
        edges,
        focused: () => focused?.props.href ?? null,
        focus(node: any) {
            node.element.focus();
        },
        route(id: number, agentId = "stable-agent") {
            state.conversationId = id;
            state.view = { conversation: { id, pipAgentId: agentId } };
            dirty = true;
            render();
        },
        patch(value: Props) {
            Object.assign(state, value);
            dirty = true;
            render();
        },
        label(name: string) {
            render();
            const found = nodes(tree).find((node) => node.props["aria-label"] === name);

            assert.ok(found, `${name} not found`);

            return found;
        },
        click(node: any) {
            node.props.onClick({
                preventDefault() {},
                stopPropagation() {},
                currentTarget: node.element,
                target: node.element,
            });
            render();
        },
        key(node: any, key: string) {
            let prevented = false;

            node.props.onKeyDown({
                key,
                preventDefault() {
                    prevented = true;
                },
                stopPropagation() {},
                currentTarget: node.element,
                target: node.element,
            });
            render();

            return prevented;
        },
        all: () => {
            render();

            return nodes(tree);
        },
        text: () => {
            render();

            return textOf(tree);
        },
        async settle() {
            await flush();
            render();
            await flush();
            render();
        },
    };
}

test("pane tabs use the current room identity, exact destinations and a trailing new-chat control", (t) => {
    const f = fixture(t);
    const controls = nodes(f.label("Reviewer chats")).filter(
        (node) => node.type === "a" || node.props["aria-label"] === "New chat with Reviewer",
    );

    assert.deepEqual(
        controls.map((node) => node.props.href ?? node.props["aria-label"]),
        ["/s/7", "/s/19", "New chat with Reviewer"],
    );
    assert.equal(controls[1].props["aria-current"], "page");
    assert.match(f.text(), /Initial setup/);
    assert.match(f.text(), /Accessibility review/);
    assert.doesNotMatch(f.text(), /Inbox|Home|Set inbox/);
    assert.equal(f.requests.length, 0);
    f.click(controls[0]);
    assert.deepEqual(f.navigated, [7]);
    f.patch({ view: { conversation: { id: 19, pipAgentId: "other-agent" } } });
    assert.equal(f.text(), "", "a sidebar selection cannot bind an unrelated room");
    f.patch({
        conversationId: 19,
        view: { conversation: { id: 19, pipAgentId: "stable-agent" } },
        server: { privateAgents: 2 },
    });
    assert.equal(f.text(), "", "an older running server cannot receive v3 actions");
    f.patch({ server: { privateAgents: 3 }, me: { id: "guest", role: "guest" } });
    assert.equal(f.text(), "");
});

test("the trailing plus creates one same-agent chat directly and opens the acknowledged exact id", async (t) => {
    const f = fixture(t);
    const plus = f.label("New chat with Reviewer");

    f.click(plus);
    f.click(plus);
    assert.equal(f.requests.length, 1, "double taps cannot create multiple chats");
    assert.equal(f.requests[0].path, "c/19/private-agent");
    assert.deepEqual(
        { ...f.requests[0].body, requestId: "stable" },
        { action: "new_chat", requestId: "stable" },
    );
    assert.equal(f.label("New chat with Reviewer").props.disabled, true);
    f.requests[0].resolve({ agentId: "stable-agent", id: 29, chatIds: [7, 19, 29] });
    await f.settle();
    assert.deepEqual(f.navigated, [29]);
    assert.equal(f.requests.length, 1, "no settings or onboarding request");
});

test("uncertain new-chat retries survive reload without replay and retain the original source and receipt", async (t) => {
    const first = fixture(t);

    first.click(first.label("New chat with Reviewer"));
    const original = first.requests[0];

    original.reject(new Error("Connection lost"));
    await first.settle();
    assert.match(first.text(), /retry the same request/);
    const owner = first.state.me;

    first.patch({ view: { conversation: null } });
    const reloaded = await import(new URL("../web/agent-tabs.js?reload", import.meta.url).href);
    const resumed = fixture(t, reloaded.AgentTabs);

    resumed.patch({
        me: owner,
        conversationId: 7,
        view: { conversation: { id: 7, pipAgentId: "stable-agent" } },
    });
    assert.equal(resumed.requests.length, 0, "remount and reload never replay a mutation");
    resumed.click(resumed.label("Retry new chat with Reviewer"));
    assert.equal(resumed.requests[0].path, original.path);
    assert.deepEqual(resumed.requests[0].body, original.body);
    resumed.requests[0].resolve({ agentId: "stable-agent", id: 32, chatIds: [7, 19, 32] });
    await resumed.settle();
    assert.deepEqual(resumed.navigated, [32]);
    assert.equal(storage.get(`pocket.pipNewChat.${owner.id}.stable-agent`), undefined);
});

test("switching chats during creation cannot steal navigation or replay the request", async (t) => {
    const f = fixture(t);

    f.click(f.label("New chat with Reviewer"));
    f.patch({ conversationId: 7, view: { conversation: { id: 7, pipAgentId: "stable-agent" } } });
    assert.equal(f.label("New chat with Reviewer").props.disabled, true);
    f.requests[0].resolve({ agentId: "stable-agent", id: 35, chatIds: [7, 19, 35] });
    await f.settle();
    assert.deepEqual(
        f.navigated,
        [],
        "an old acknowledgement cannot redirect the newly chosen chat",
    );
    assert.equal(f.requests.length, 1);
    assert.equal(f.label("New chat with Reviewer").props.disabled, false);
    const stalePlus = f.label("New chat with Reviewer");

    f.patch({ server: { privateAgents: 2 } });
    f.click(stalePlus);
    assert.equal(
        f.requests.length,
        1,
        "a stale button cannot mutate against a downgraded capability",
    );
});

function chatLink(f: ReturnType<typeof fixture>, id: number) {
    const link = f.all().find((node) => node.type === "a" && node.props.href === `/s/${id}`);

    assert.ok(link, `chat link ${id} not found`);

    return link;
}

function threeChats(f: ReturnType<typeof fixture>) {
    const agent = f.state.namedAgents[0];

    f.patch({
        namedAgents: [
            {
                ...agent,
                chatIds: [7, 19, 27],
                chats: [...agent.chats, { id: 27, title: "Follow up", busy: false, updatedAt: 3 }],
            },
        ],
    });
}

const closeInitial = "Close Initial setup tab, chat 7";
const closeActive = "Close Accessibility review tab, chat 19";
const closeFollowup = "Close Follow up tab, chat 27";

test("dismissal is local: sibling controls preserve retained chats, choose the next/previous route, and leave the last chat for Sessions", async (t) => {
    for (const direction of ["next", "previous"] as const) {
        await t.test(direction, (t) => {
            const f = fixture(t);

            threeChats(f);
            const metadata = structuredClone(f.state.namedAgents);
            const retained = structuredClone(f.state.retained);
            const inactive = f.label(direction === "next" ? closeInitial : closeFollowup);
            const link = chatLink(f, direction === "next" ? 7 : 27);
            const parent = f
                .all()
                .find((node) => [node.props.children].flat(Infinity).includes(link));

            assert.ok(parent);
            assert.ok(
                [parent.props.children].flat(Infinity).includes(inactive),
                "close and link are siblings, never nested interactive controls",
            );
            assert.equal(
                nodes(link).some((node) => node.type === "button"),
                false,
            );
            f.focus(inactive);
            f.click(inactive);
            assert.deepEqual(f.navigated, [], "closing an inactive tab never activates its anchor");
            assert.equal(f.state.conversationId, 19);
            assert.equal(f.focused(), `/s/19`, "focus returns to the selected link, not body");
            f.focus(f.label(closeActive));
            f.click(f.label(closeActive));
            const neighbor = direction === "next" ? 27 : 7;

            assert.deepEqual(f.navigated, [neighbor]);
            assert.equal(
                f.state.view.conversation,
                null,
                "route transition temporarily has no room metadata",
            );
            f.route(neighbor);
            assert.equal(
                f.focused(),
                `/s/${neighbor}`,
                "focus intent survives the view-empty transition",
            );
            f.click(f.label(direction === "next" ? closeFollowup : closeInitial));
            assert.deepEqual(f.returned, ["sessions"]);
            assert.deepEqual(f.navigated, [neighbor]);
            assert.equal(
                f.requests.length,
                0,
                "dismissal cannot create, stop, archive or delete a chat",
            );
            assert.deepEqual(f.state.namedAgents, metadata, "retained chat metadata is unchanged");
            assert.deepEqual(
                f.state.retained,
                retained,
                "drafts, history and running work survive every dismissal",
            );
        });
    }
});

test("dismissed tabs survive reload only for their owner and identity, and an exact retained route reopens them", async (t) => {
    const f = fixture(t);
    const owner = f.state.me;
    const agent = f.state.namedAgents[0];

    f.click(f.label(closeInitial));
    assert.ok(storage.has(`pocket.pipClosedTabs.${owner.id}.stable-agent`));
    f.patch({ view: { conversation: null } });
    const reloaded = await import(
        new URL("../web/agent-tabs.js?dismissed-reload", import.meta.url).href
    );
    const resumed = fixture(t, reloaded.AgentTabs);

    resumed.patch({ me: owner });
    assert.equal(
        resumed.all().some((node) => node.props.href === "/s/7"),
        false,
    );
    assert.ok(chatLink(resumed, 19));
    resumed.patch({ me: { id: `${owner.id}-other`, role: "owner" } });
    assert.ok(chatLink(resumed, 7), "another owner has no inherited closed tabs");
    resumed.patch({
        me: owner,
        namedAgents: [{ ...agent, agentId: "other-agent" }],
        view: { conversation: { id: 19, pipAgentId: "other-agent" } },
    });
    assert.ok(chatLink(resumed, 7), "another identity has its own closed-tab set");
    resumed.patch({
        namedAgents: [agent],
        view: { conversation: { id: 19, pipAgentId: "stable-agent" } },
    });
    assert.equal(
        resumed.all().some((node) => node.props.href === "/s/7"),
        false,
    );
    resumed.route(7);
    assert.ok(chatLink(resumed, 7), "ordinary exact navigation reopens the retained chat");
    assert.equal(resumed.requests.length, 0, "reopening only changes local tab visibility");
});

test("link keys move focus without activation and Delete dismisses with neighbor focus", (t) => {
    const f = fixture(t);

    threeChats(f);
    f.focus(chatLink(f, 19));
    assert.equal(f.key(chatLink(f, 19), "ArrowRight"), true);
    assert.equal(f.focused(), `/s/27`);
    f.key(chatLink(f, 27), "Home");
    assert.equal(f.focused(), `/s/7`);
    f.key(chatLink(f, 7), "End");
    assert.equal(f.focused(), `/s/27`);
    f.key(chatLink(f, 27), "ArrowLeft");
    assert.equal(f.focused(), `/s/19`);
    assert.deepEqual(f.navigated, [], "arrow keys focus links; they do not select routes");
    assert.equal(f.key(chatLink(f, 19), "Enter"), false, "Enter remains native link activation");
    assert.equal(f.key(chatLink(f, 19), "Delete"), true);
    assert.deepEqual(f.navigated, [27]);
    f.route(27);
    assert.equal(f.focused(), `/s/27`);
    assert.equal(
        f.all().some((node) => node.props.href === "/s/19"),
        false,
    );
    assert.equal(f.requests.length, 0);
});

test("closing the source tab retains pending and uncertain plus receipts without late navigation theft", async (t) => {
    for (const [status, last] of [
        ["pending", false],
        ["pending", true],
        ["uncertain", false],
        ["uncertain", true],
    ] as const) {
        await t.test(`${status}, ${last ? "last tab" : "neighbor"}`, async (t) => {
            const f = fixture(t);
            const previous = last ? [] : [7];

            if (last) {
                f.click(f.label(closeInitial));
            }

            f.click(f.label("New chat with Reviewer"));
            const original = f.requests[0];
            const receiptKey = `pocket.pipNewChat.${f.state.me.id}.stable-agent`;
            const receipt = storage.get(receiptKey);

            if (status === "uncertain") {
                original.reject(new Error("Acknowledgement lost"));
                await f.settle();
            }

            f.click(f.label(closeActive));
            assert.equal(
                storage.get(receiptKey),
                receipt,
                "tab dismissal cannot clear the new-chat receipt",
            );
            assert.deepEqual(f.navigated, previous);
            assert.deepEqual(f.returned, last ? ["sessions"] : []);
            f.route(7);

            if (status === "pending") {
                original.resolve({ agentId: "stable-agent", id: 40, chatIds: [7, 19, 40] });
                await f.settle();
                assert.deepEqual(
                    f.navigated,
                    previous,
                    "the late original acknowledgement cannot steal navigation",
                );
                assert.equal(f.requests.length, 1);
            } else {
                assert.equal(
                    f.requests.length,
                    1,
                    "closing and reopening do not replay an uncertain request",
                );
                f.click(f.label("Retry new chat with Reviewer"));
                assert.equal(f.requests[1].path, original.path);
                assert.deepEqual(f.requests[1].body, original.body);
                f.requests[1].resolve({ agentId: "stable-agent", id: 41, chatIds: [7, 19, 41] });
                await f.settle();
                assert.deepEqual(
                    f.navigated,
                    [...previous, 41],
                    "only the explicit retry opening navigates to its new chat",
                );
            }
        });
    }
});

test("last-tab dismissal returns focus to visible existing navigation, never under a newer sheet", async (t) => {
    for (const mode of ["agent", "collapsed-group", "folded-sidebar", "newer-sheet"]) {
        await t.test(mode, async (t) => {
            const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
            let focused = "";
            const button = (name: string, visible: boolean, agentId?: string) => ({
                dataset: { agentId },
                getClientRects: () => (visible ? [{}] : []),
                focus: () => {
                    focused = name;
                },
            });
            const agent = button("agent", mode === "agent", "stable-agent");
            const group = button("group", mode === "collapsed-group");
            const rail = button("rail", true);

            Object.defineProperty(globalThis, "document", {
                configurable: true,
                value: {
                    querySelectorAll: () => [group, agent],
                    querySelector: () => rail,
                },
            });
            t.after(() => {
                if (previous) {
                    Object.defineProperty(globalThis, "document", previous);
                } else {
                    Reflect.deleteProperty(globalThis, "document");
                }
            });
            const f = fixture(t);

            f.click(f.label(closeInitial));
            f.click(f.label(closeActive));

            if (mode === "newer-sheet") {
                f.patch({ sheet: { type: "settings" } });
            }

            await f.settle();
            assert.deepEqual(f.returned, ["sessions"]);
            assert.equal(
                focused,
                mode === "newer-sheet"
                    ? ""
                    : mode === "agent"
                      ? "agent"
                      : mode === "collapsed-group"
                        ? "group"
                        : "rail",
            );
            assert.equal(f.requests.length, 0);
        });
    }
});

function headerContext(f: ReturnType<typeof fixture>, agent = true) {
    const conversation = {
        id: 19,
        kind: "session",
        title: "Review session",
        cwd: "/repo/project",
        ownerOnly: agent,
        pipAgentId: agent ? "stable-agent" : undefined,
        worktree: { branch: "worktree-fallback" },
    };

    f.patch({
        view: {
            conversation,
            agent: { cwd: "/repo/project" },
            branch: { detached: false },
            artifacts: [{ id: "artifact" }],
            subagents: [{ id: 77, busy: true }],
        },
        sessions: [
            { id: 19, title: "Review session", waiting: true },
            { id: 81, waiting: true },
        ],
    });
}

test("the real Topbar composes private-agent tabs inside its one header while preserving context and native utilities", (t) => {
    const f = fixture(t, Topbar);

    headerContext(f);
    const headers = f.all().filter((node) => node.type === "header");
    const navigation = f.label("Reviewer chats");
    const title = f.all().find((node) => node.props.class === "title title-agent");
    const context = f.all().find((node) => node.props["data-part"] === "topbar-sub");

    assert.equal(headers.length, 1, "tabs do not introduce a second header");
    assert.equal(f.all().filter((node) => node.type === "nav").length, 1);
    assert.ok(nodes(headers[0]).includes(navigation));
    assert.ok(
        title && nodes(title).includes(navigation),
        "navigation lives in the existing title area",
    );
    assert.ok(title && context && nodes(title).includes(context), "context shares that title area");
    assert.match(textOf(context), /project/);
    assert.match(textOf(context), /feature\/tabs/);
    assert.ok(nodes(context).some((node) => node.props.class === "folder-mark"));
    assert.ok(f.folders.includes("/repo/project"));
    assert.ok(f.edges.includes("--topbar-h"), "the ordinary header edge registration remains");
    const utilities = f.all().filter((node) => node.type === "test-utility");

    for (const utility of [
        "ThreadTypeTag",
        "PeeksButton",
        "FilesButton",
        "BrowserButton",
        "PeopleButton",
    ]) {
        assert.equal(
            utilities.filter((node) => node.props.utility === utility).length,
            1,
            `${utility} is still invoked exactly once in this header`,
        );
    }

    assert.equal(
        utilities.find((node) => node.props.utility === "ThreadTypeTag")?.props.session,
        f.state.view.conversation,
    );
    assert.equal(
        utilities.find((node) => node.props.utility === "ExtensionSessionControls")?.props.slot,
        "header",
    );
    assert.ok(nodes(headers[0]).includes(f.label("Menu")));
    assert.match(headers[0].props["aria-description"], /scroll horizontally.*chats.*tools/i);
    assert.equal(f.label("Menu").props.class, "icon-button topbar-menu");
    assert.ok(
        nodes(f.label("Menu")).some((node) => node.props.class === "agent-header-scroll-hint"),
    );
    f.click(f.label("Branch feature/tabs: switch or make a branch"));
    assert.deepEqual(f.opened.at(-1), { type: "branch" });
    f.click(f.label("Changes: 1 file, 2 lines added and 1 removed"));
    assert.deepEqual(
        f.actions.at(-1),
        ["files", true, "changes"],
        "real ChangesButton delegates to the native changes panel",
    );
    f.click(f.label("Subagents: 1 working"));
    assert.deepEqual(f.actions.at(-1), ["subagents"]);
    f.click(f.label("Artifacts"));
    assert.deepEqual(f.opened.at(-1), { type: "artifacts" });
    f.click(f.label("Menu"));
    assert.deepEqual(f.opened.at(-1), { type: "menu" });
    assert.equal(f.label("Menu").props["aria-expanded"], true);
    f.click(f.label("Back to sessions, 1 waiting for you"));
    assert.deepEqual(f.returned, ["sessions"]);
    assert.equal(f.requests.length, 0, "header context/actions do not create or activate chats");
});

test("chat selection requests whole-tab reveal including its sibling Close target", (t) => {
    const f = fixture(t);

    f.route(7);
    const link = f.all().find((node) => node.props.href === "/s/7");
    const tab = f
        .all()
        .find((node) => nodes(node).includes(link) && node.props.class === "agent-tab-item on");

    assert.ok(tab);
    assert.deepEqual(tab.element.scrolls.at(-1), { block: "nearest", inline: "nearest" });
    assert.equal(
        link.element.scrolls.length,
        0,
        "revealing the link alone would omit its sibling Close target",
    );
    assert.ok(nodes(tab).includes(f.label("Close Initial setup tab, chat 7")));
    assert.equal(f.requests.length, 0);
});

test("ordinary and older-server Topbars keep the normal title/menu without tab controls", async (t) => {
    for (const mode of ["ordinary", "older-server"] as const) {
        await t.test(mode, (t) => {
            const f = fixture(t, Topbar);

            headerContext(f, mode === "older-server");

            if (mode === "older-server") {
                f.patch({ server: { privateAgents: 2 } });
            }

            assert.equal(f.all().filter((node) => node.type === "header").length, 1);
            assert.equal(
                f.all().some((node) => node.type === "nav"),
                false,
            );
            assert.equal(
                f
                    .all()
                    .some((node) =>
                        /^(?:Close .* tab, chat|(?:New|Retry new) chat with)/.test(
                            node.props["aria-label"] ?? "",
                        ),
                    ),
                false,
            );
            const title = f.all().find((node) => node.props["data-part"] === "topbar-title");

            assert.equal(textOf(title), "Review session");
            assert.ok(f.label("Menu"));
            assert.ok(f.label("Branch feature/tabs: switch or make a branch"));
            f.click(f.label("Review session, in project: session menu"));
            assert.deepEqual(f.opened.at(-1), { type: "menu" });
            assert.equal(f.label("Menu").props["aria-expanded"], true);
            assert.equal(f.requests.length, 0);
        });
    }
});
