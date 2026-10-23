// Offline public component checks: controlled runtime/HTTP, not browser or device proof.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, test, type TestContext } from "node:test";
import { h, render as renderPreact } from "preact";

const html = (await import(import.meta.resolve("htm"))).default.bind(h);

type Props = Record<string, any>;
type Slot = { value?: any; deps?: unknown[]; cleanup?: () => void };
type Fiber = { slots: Slot[]; cursor: number };
let active: Props;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
const bridge = {
    html,
    store: {
        get state() {
            return active.state;
        },
        set: (value: Props) => active.patch(value),
        subscribe(listener: () => void) {
            listeners.add(listener);

            return () => listeners.delete(listener);
        },
    },
    api: (...args: any[]) => active.api(...args),
    uid: () => active.uid(),
    navigate: (id: number) => active.navigate(id),
    toSessions: () => active.toSessions(),
    openSheet: (sheet: Props) => active.openSheet(sheet),
    closeSheet: () => active.patch({ sheet: null }),
    projectsAvailable: () => true,
    sheet: (props: Props) => h("test-sheet", props),
    avatar: (props: Props) => h("test-avatar", props),
    icon: (props: Props) => h("test-icon", props),
    item: (label: string, run: () => void, _hint: string, options: Props) =>
        h("button", { class: "list-item", onClick: run, ...options }, label),
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
        useLayoutEffect: (...args: any[]) => active.hooks.useEffect(...args),
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
    "preact/hooks":
        "export const {useState,useRef,useEffect,useLayoutEffect}=globalThis.agentTabsUiFixture.hooks;",
    "./store.js":
        "export const {store,api,uid,navigate,openSheet,closeSheet,projectsAvailable}=globalThis.agentTabsUiFixture;",
    "./sessions.js": "export const {toSessions}=globalThis.agentTabsUiFixture;",
    "./named-agents.js":
        "const b=globalThis.agentTabsUiFixture; export const namedAgentsAvailable=()=>b.store.state.me?.role==='owner' && b.store.state.server?.privateAgents>=4; export const openAgentSettings=(id,agentId,section)=>b.openSheet({type:'named-agent',id,agentId,section});",
    "./agent-drafts.js":
        "const b=globalThis.agentTabsUiFixture; const drafts=()=>b.store.state.localDrafts.filter(d=>d.userId===b.store.state.me.id); export const agentDrafts=(agentId)=>drafts().filter(d=>d.agentId===agentId); export const selectedAgentDraft=()=>drafts().find(d=>d.id===b.store.state.agentDraft?.id)??null; export const openAgentDraft=(agentId)=>{const draft={id:b.uid(),userId:b.store.state.me.id,agentId,title:'New chat',draft:true,text:''}; b.store.state.localDrafts.push(draft); b.navigate(null); b.store.state.agentDraft=draft;}; export const closeAgentDraft=(id)=>{b.store.state.localDrafts=b.store.state.localDrafts.filter(d=>d.id!==id);}; export const selectAgentDraft=(id)=>{const draft=drafts().find(d=>d.id===id); b.navigate(null); b.store.state.agentDraft=draft;};",
    "./ui.js":
        "export const {html,useEdge,item}=globalThis.agentTabsUiFixture,Icon=(props)=>globalThis.agentTabsUiFixture.icon(props); export const shortPath=(path)=>path,Loader=()=>null,Sheet=(props)=>globalThis.agentTabsUiFixture.sheet(props),timeAgo=()=>'';",
    "./named-agent-avatar.js":
        "export const NamedAgentAvatar=(props)=>globalThis.agentTabsUiFixture.avatar(props);",
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
};

registerHooks({
    resolve(specifier, context, next) {
        const source =
            /\/web\/(?:agent-tabs|agent-history|named-agents|named-agent-avatar|thread-type|topbar)\.js$/.test(
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
const { Topbar, AgentHeaderSheet, AgentMenuItems } = await import(
    new URL("../web/topbar.js", import.meta.url).href
);
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
          : typeof value === "string" || typeof value === "number"
            ? String(value)
            : "";
}

// Pass resolved component output through real Preact: walking props.children alone can
// report controls that Preact actually renders as a text node (for example an empty tag).
function renderedText(value: any): string {
    const document = {
        createTextNode: (data: any) => ({ nodeType: 3, data: String(data) }),
        createElementNS(_namespace: string, localName: string) {
            const element: any = {
                localName,
                ownerDocument: document,
                childNodes: [],
                insertBefore(child: any, before: any) {
                    const previous = element.childNodes.indexOf(child);

                    if (previous !== -1) {
                        element.childNodes.splice(previous, 1);
                    }

                    const index = before ? element.childNodes.indexOf(before) : -1;

                    element.childNodes.splice(
                        index === -1 ? element.childNodes.length : index,
                        0,
                        child,
                    );
                },
                removeChild(child: any) {
                    element.childNodes.splice(element.childNodes.indexOf(child), 1);
                },
            };

            return element;
        },
    };
    // Hooks and callbacks belong to the fixture; this sink checks only real text/element rendering.
    const content = (node: any): any =>
        Array.isArray(node)
            ? node.map(content)
            : node?.props
              ? h(node.type, null, content(node.props.children))
              : node;
    const textContent = (node: any): string =>
        node.nodeType === 3 ? node.data : node.childNodes.map(textContent).join("");
    const root = document.createElementNS("", "root");

    renderPreact(content(value), root);

    return textContent(root);
}

function fixture(t: TestContext, Component = AgentTabs, initial: Props = {}) {
    const fibers = new Map<string, Fiber>();
    const effects: (() => void)[] = [];
    const requests: any[] = [];
    const navigated: (number | null)[] = [];
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
        server: { privateAgents: 4, extensions: ["pocket-memory"] },
        localDrafts: [],
        agentDraft: null,
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

    Object.assign(state, initial);

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
        patch(value: Props) {
            Object.assign(state, value);
            notify();
            dirty = true;
        },
        navigate(id: number | null) {
            navigated.push(id);
            state.agentDraft = null;
            state.conversationId = id;
            state.sheet = null;
            state.view = { conversation: null };
            notify();
            dirty = true;
        },
        toSessions() {
            returned.push("sessions");
            state.agentDraft = null;
            state.conversationId = null;
            state.sheet = null;
            state.view = { conversation: null };
            notify();
            dirty = true;
        },
        uid: () => `tab-request-${++sequence}`,
        api: (path: string, body: Props, options: Props) =>
            new Promise((resolve, reject) =>
                requests.push({ path, body, options, resolve, reject }),
            ),
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
            const sheet = state.sheet;

            tree = resolve(
                [
                    h(Component, {}),
                    sheet?.type === "agent-header"
                        ? h(AgentHeaderSheet, {
                              key: `${sheet.userId}:${sheet.agentId}:${sheet.source}:${sheet.panel}`,
                              sheet,
                          })
                        : sheet?.type === "menu"
                          ? h(AgentMenuItems, {})
                          : null,
                ],
                "root",
                visited,
            );

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
        focusedElement: () => focused,
        focus(node: any) {
            node.element.focus();
        },
        route(id: number, agentId = "stable-agent") {
            state.agentDraft = null;
            state.conversationId = id;
            state.sheet = null;
            state.view = { conversation: { id, pipAgentId: agentId } };
            notify();
            dirty = true;
            render();
        },
        patch(value: Props) {
            active.patch(value);
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
        renderedText: (value?: any) => {
            render();

            return renderedText(value ?? tree);
        },
        async settle() {
            await flush();
            render();
            await flush();
            render();
        },
    };
}

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
            const f = fixture(t, Topbar, { server: { privateAgents: 3 } });

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

test("controller titles use one leading native PiP icon without changing native header bindings", async (t) => {
    for (const [mode, title, expected] of [
        ["controller", "PiP · Review routing", " · Review routing"],
        ["renamed-controller", "Keep this renamed title", " Keep this renamed title"],
        ["ordinary", "PiP · Literal ordinary title", "PiP · Literal ordinary title"],
    ] as const) {
        await t.test(mode, (t) => {
            const f = fixture(t, Topbar, {
                view: { conversation: { id: 19, kind: "session", title } },
            });
            const controller = mode !== "ordinary";

            headerContext(f, false);
            f.patch({
                server: {
                    ...f.state.server,
                    agentProfiles: [{ id: "worker", name: "Worker", icon: "bot" }],
                },
                view: {
                    ...f.state.view,
                    conversation: {
                        ...f.state.view.conversation,
                        title,
                        threadType: "worker",
                        ...(controller
                            ? { workSupervisor: { workItemId: "exact-item", status: "running" } }
                            : {}),
                    },
                },
            });
            const heading = f.all().find((node) => node.props["data-part"] === "topbar-title");
            const detail = f.all().find((node) => node.props["data-part"] === "topbar-sub");
            const tags = (node: any) =>
                nodes(node).filter((child) =>
                    child.props.class?.split(" ").includes("thread-type"),
                );
            const leading = tags(heading);

            assert.equal(
                textOf(heading),
                expected,
                "only the generated controller prefix changes visually",
            );
            assert.equal(leading.length, controller ? 1 : 0);
            assert.equal(
                tags(detail).length,
                controller ? 0 : 1,
                "only the marked controller duplicate disappears",
            );

            if (controller) {
                assert.equal(
                    heading.props["aria-hidden"],
                    undefined,
                    "the icon keeps its accessible role",
                );
                assert.equal(leading[0].props.role, "img");
                assert.equal(leading[0].props["aria-label"], "PiP");
                assert.equal(leading[0].props.title, "PiP");
                assert.ok(leading[0].props.class.split(" ").includes("icon-only"));
                const icon = nodes(leading[0]).find((node) => node.type === "test-icon");

                assert.equal(icon.props.name, "pip");
                assert.equal(
                    icon.props.size,
                    14,
                    "same native icon-only indicator as sidebar threads",
                );
            } else {
                assert.equal(
                    textOf(tags(detail)[0]),
                    "Worker",
                    "ordinary type text remains visible",
                );
            }

            assert.equal(
                f.state.view.conversation.title,
                title,
                "display changes never rename the chat",
            );
            f.click(f.label(`${title}, in project: session menu`));
            assert.deepEqual(f.opened.at(-1), { type: "menu" });
            f.click(f.label("Branch feature/tabs: switch or make a branch"));
            assert.deepEqual(f.opened.at(-1), { type: "branch" });
            f.click(f.label("Menu"));
            assert.deepEqual(f.opened.at(-1), { type: "menu" });
            assert.equal(f.label("Menu").props["aria-expanded"], true);
            assert.equal(f.requests.length, 0, "controller chrome only uses native header actions");
        });
    }
});

test("saved navigation uses exact selected room identity and capability", (t) => {
    const f = fixture(t);

    assert.ok(chatLink(f, 7));
    assert.equal(chatLink(f, 19).props["aria-current"], "page");
    f.click(chatLink(f, 7));
    assert.deepEqual(f.navigated, [7]);
    f.patch({ view: { conversation: { id: 19, pipAgentId: "stable-agent" } } });
    assert.equal(f.text(), "", "a stale selected view must not bind catalogue identity");
    f.route(19);
    const stale = f.label("New chat with Reviewer");

    f.patch({ server: { privateAgents: 3 } });
    f.click(stale);
    assert.equal(f.state.localDrafts.length, 0);
    f.patch({ server: { privateAgents: 4 }, me: { id: "guest", role: "guest" } });
    f.click(stale);
    assert.equal(f.text(), "");
    assert.equal(f.requests.length, 0);
});

test("plus creates only a local draft and close deletes only that unsent view", (t) => {
    const f = fixture(t);
    const retained = structuredClone(f.state.retained);
    const metadata = structuredClone(f.state.namedAgents);

    f.click(f.label("New chat with Reviewer"));
    const draft = f.state.agentDraft;

    assert.equal(typeof draft.id, "string");
    assert.equal(f.state.conversationId, null);
    assert.equal(f.requests.length, 0, "opening a draft cannot reserve a server conversation");
    assert.match(f.text(), /New chat/);
    assert.ok(chatLink(f, 7), "saved chats stay alongside drafts");
    f.click(f.label("Close New chat draft, chat " + draft.id));
    assert.equal(f.state.localDrafts.length, 0);
    assert.equal(f.navigated.at(-1), 19);
    assert.deepEqual(f.state.retained, retained);
    assert.deepEqual(f.state.namedAgents, metadata);
    assert.equal(f.requests.length, 0);
});

test("draft tab selection uses its local identity rather than a fabricated native route", (t) => {
    const f = fixture(t);

    f.click(f.label("New chat with Reviewer"));
    const first = f.state.agentDraft.id;

    f.click(f.label("New chat with Reviewer"));
    const local = f
        .all()
        .find((node) => node.props.role === "button" && node.props["aria-current"] !== "page");

    assert.ok(local);
    assert.equal(local.props.href, undefined);
    f.key(local, "Enter");
    assert.equal(f.state.agentDraft.id, first);
    assert.equal(f.requests.length, 0);
});

test("named header excludes workspace utilities while preserving context and the native app menu", (t) => {
    const f = fixture(t, Topbar);

    headerContext(f);
    assert.match(f.renderedText(), /Initial setup.*Accessibility review/s);
    const avatar = nodes(f.label("Reviewer: settings")).find((node) => node.type === "test-avatar");

    assert.equal(avatar.props.agentId, "stable-agent");
    assert.equal(textOf(f.label("Reviewer: settings")), "");
    assert.ok(
        !f
            .all()
            .some((node) => ["Goal / purpose", "System prompt"].includes(node.props["aria-label"])),
    );
    assert.doesNotMatch(f.renderedText(), /\[object Object\]/);
    assert.equal(f.all().filter((node) => node.type === "header").length, 1);
    assert.equal(f.all().filter((node) => node.type === "test-utility").length, 0);
    assert.deepEqual(f.folders, []);
    assert.ok(f.edges.includes("--topbar-h"));
    f.click(f.label("Menu"));
    assert.deepEqual(f.opened.at(-1), { type: "menu" });
    const menu = f.label("Reviewer actions");

    for (const label of [
        "Memory",
        "Goal / purpose",
        "System prompt",
        "Rename",
        "Agent settings",
        "History",
        "All Work Items",
    ]) {
        assert.match(textOf(menu), new RegExp(label));
    }

    assert.ok(!nodes(menu).some((node) => node.type === "button" && textOf(node) === "App menu"));
    f.click(
        nodes(menu).find((node) => node.type === "button" && textOf(node) === "Agent settings"),
    );
    assert.deepEqual(f.opened.at(-1), {
        type: "named-agent",
        id: 19,
        agentId: "stable-agent",
        section: undefined,
    });
    assert.ok(
        f.requests.every((request) => request.body === undefined),
        "native chrome never activates work",
    );
});

test("phone chooser registers outside the header and closes through sheet state", (t) => {
    const f = fixture(t, Topbar);
    const opener = f.label("Accessibility review: switch chats");

    f.click(opener);
    const header = f.all().find((node) => node.type === "header");
    const sheet = f.all().find((node) => node.type === "test-sheet");

    assert.deepEqual(f.state.sheet, {
        type: "agent-header",
        panel: "chats",
        agentId: "stable-agent",
        source: 19,
        userId: f.state.me.id,
    });
    assert.equal(f.label("Accessibility review: switch chats").props["aria-expanded"], true);
    assert.ok(sheet);
    assert.match(
        f.renderedText(sheet),
        /Closing a saved tab.*Initial setup.*Accessibility review/s,
    );
    assert.doesNotMatch(f.renderedText(sheet), /\[object Object\]/);
    assert.ok(
        !nodes(header).some((node) => node.type === "test-sheet"),
        "the overlay must escape topbar containment",
    );
    const choices = f.label("Reviewer open chats");
    const inactive = nodes(choices).find((node) => node.props["aria-label"] === closeInitial);
    const selected = nodes(choices).find((node) => node.props.href === "/s/19");

    f.focus(inactive);
    f.click(inactive);
    assert.equal(
        f.focusedElement(),
        selected.element,
        "inactive dismissal keeps focus inside the chooser",
    );
    assert.equal(f.navigated.length, 0);
    sheet.props.onClose();
    assert.ok(!f.all().some((node) => node.type === "test-sheet"));
    assert.equal(f.state.sheet, null);
    assert.equal(f.label("Accessibility review: switch chats").props["aria-expanded"], false);
    assert.equal(f.navigated.length, 0);
});

test("History retains dismissed chats and reopens their exact routes without new work", (t) => {
    const f = fixture(t, Topbar);

    f.click(f.label(closeInitial));
    assert.ok(!f.all().some((node) => node.props.href === "/s/7"));
    f.click(f.label("History"));
    const history = f.label("Reviewer saved chats");

    assert.ok(nodes(history).some((node) => node.props.href === "/s/7"));
    f.click(nodes(history).find((node) => node.props.href === "/s/7"));
    assert.equal(f.navigated.at(-1), 7);
    f.route(7);
    assert.equal(chatLink(f, 7).props["aria-current"], "page");
    assert.ok(f.requests.every((request) => request.body === undefined));
});

test("draft context actions address the identity, not the previous saved chat", (t) => {
    const f = fixture(t, Topbar);

    f.click(f.label("New chat with Reviewer"));
    assert.match(f.renderedText(), /New chat.*Draft/s);
    assert.doesNotMatch(f.renderedText(), /\[object Object\]/);
    f.click(f.label("Reviewer: settings"));
    assert.deepEqual(f.opened.at(-1), {
        type: "named-agent",
        id: null,
        agentId: "stable-agent",
        section: undefined,
    });
    f.click(f.label("Menu"));
    const action = (label: string) =>
        nodes(f.label("Reviewer actions")).find(
            (node) => node.type === "button" && textOf(node) === label,
        );

    f.click(action("Goal / purpose"));
    assert.deepEqual(f.opened.at(-1), {
        type: "named-agent",
        id: null,
        agentId: "stable-agent",
        section: "focus",
    });
    f.click(f.label("Menu"));
    f.click(action("System prompt"));
    assert.equal(f.opened.at(-1)?.section, "instructions");
    f.click(f.label("Memory"));
    assert.deepEqual(f.opened.at(-1), { type: "memory", conversationId: "agent:stable-agent" });
});

test("selected-chat controller links expose only current rows and complete history keeps unavailable rows inert", async (t) => {
    const f = fixture(t, Topbar);

    assert.equal(f.requests[0].path, "c/19/private-agent");
    const data = {
        id: 19,
        agentId: "stable-agent",
        controllers: [
            {
                workItemId: 1,
                conversationId: 30,
                title: "Current work",
                state: "active",
                current: true,
                accessible: true,
            },
            {
                workItemId: 2,
                conversationId: 40,
                title: "Historical work",
                state: "held",
                current: false,
                accessible: true,
            },
            {
                workItemId: 3,
                conversationId: 50,
                title: "Do not expose this title",
                state: "unavailable",
                current: false,
                accessible: false,
            },
        ],
    };

    f.requests[0].resolve(data);
    await f.settle();
    const strip = f.label("Current orchestrators for this chat");

    assert.match(textOf(strip), /Current work/);
    assert.doesNotMatch(textOf(strip), /Historical work|Do not expose/);
    f.click(f.label("1 current orchestrator, 1 active: all Work Items for this chat"));
    const panelRead = f.requests.at(-1);

    assert.equal(panelRead.path, "c/19/private-agent");
    panelRead.resolve(data);
    await f.settle();
    const complete = f.all().find((node) => node.type === "details");

    assert.match(textOf(complete), /All Work Items for this chat \(3\)/);

    for (const title of ["Current work", "Historical work", "Unavailable Work Item"]) {
        assert.ok(textOf(complete).includes(title));
    }

    assert.doesNotMatch(f.text(), /Do not expose this title/);
    assert.ok(!f.all().some((node) => node.props.href === "/s/50"));
    f.click(nodes(strip).find((node) => node.props.href === "/s/30"));
    assert.equal(f.navigated.at(-1), 30);
    assert.ok(f.requests.every((request) => request.body === undefined));
});

test("native catalogue control revisions refresh current orchestrators without switching Chats", async (t) => {
    const f = fixture(t, Topbar);

    f.requests[0].resolve({ id: 19, agentId: "stable-agent", controllers: [] });
    await f.settle();
    f.patch({
        namedAgents: f.state.namedAgents.map((agent: Props) => ({ ...agent, controlRevision: 1 })),
    });
    await f.settle();
    const activated = f.requests.at(-1);

    assert.equal(f.requests.length, 2);
    assert.equal(activated.path, "c/19/private-agent");
    activated.resolve({
        id: 19,
        agentId: "stable-agent",
        controllers: [
            {
                workItemId: 1,
                conversationId: 30,
                title: "Newly delegated",
                state: "active",
                current: true,
                accessible: true,
            },
        ],
    });
    await f.settle();
    assert.match(textOf(f.label("Current orchestrators for this chat")), /Newly delegated/);
    f.patch({
        namedAgents: f.state.namedAgents.map((agent: Props) => ({ ...agent, controlRevision: 2 })),
    });
    await f.settle();
    assert.equal(f.requests.length, 3);
    f.requests.at(-1).resolve({
        id: 19,
        agentId: "stable-agent",
        controllers: [
            {
                workItemId: 1,
                conversationId: 30,
                title: "Newly delegated",
                state: "human control",
                current: false,
                accessible: true,
            },
        ],
    });
    await f.settle();
    assert.doesNotMatch(textOf(f.label("Current orchestrators for this chat")), /Newly delegated/);
    assert.equal(f.state.conversationId, 19);
    assert.ok(f.requests.every((request) => request.body === undefined));
});

test("controller reads reject mismatched identities and ignore late departed-source or owner results", async (t) => {
    for (const mode of ["source", "owner", "mismatch", "failure"]) {
        await t.test(mode, async (t) => {
            const f = fixture(t, Topbar);
            const request = f.requests[0];

            if (mode === "source") {
                f.route(7);
            } else if (mode === "owner") {
                f.patch({ me: { id: "other-owner", role: "owner" } });
            }

            if (mode === "failure") {
                request.reject(new Error("Offline"));
            } else {
                request.resolve({
                    id: 19,
                    agentId: mode === "mismatch" ? "other-agent" : "stable-agent",
                    controllers: [
                        {
                            workItemId: 1,
                            conversationId: 30,
                            title: "Stale controller",
                            state: "active",
                            current: true,
                            accessible: true,
                        },
                    ],
                });
            }

            await f.settle();
            assert.doesNotMatch(f.text(), /Stale controller/);

            if (mode === "source" || mode === "owner") {
                assert.ok(request.options.signal.aborted);
            } else {
                assert.ok(
                    f
                        .all()
                        .some((node) =>
                            String(node.props["aria-label"]).startsWith(
                                "Orchestrators unavailable",
                            ),
                        ),
                );
            }
        });
    }
});

test("History authoritatively recovers saved chats missing from the catalogue, with passive Refresh", async (t) => {
    const f = fixture(t, Topbar);

    f.click(f.label("History"));
    const request = f.requests.at(-1);

    assert.equal(request.path, "pip/agents/stable-agent");
    assert.match(f.text(), /Loading saved chats/);
    assert.ok(chatLink(f, 7), "summary chats remain usable while the authoritative read loads");
    request.resolve({
        agentId: "stable-agent",
        chats: [
            ...f.state.namedAgents[0].chats,
            { id: 45, title: "Recovered first send", busy: true, updatedAt: 3 },
        ],
    });
    await f.settle();
    const history = f.label("Reviewer saved chats");

    assert.ok(nodes(history).some((node) => node.props.href === "/s/45"));
    assert.ok(
        !f.state.namedAgents[0].chats.some((chat: Props) => chat.id === 45),
        "this proves the authoritative result, not a catalogue event",
    );
    f.click(f.all().find((node) => node.type === "button" && textOf(node) === "Refresh"));
    const refresh = f.requests.at(-1);

    assert.equal(refresh.path, request.path);
    refresh.reject(new Error("Offline"));
    await f.settle();
    assert.match(f.text(), /Offline.*Showing last known chats/);
    assert.ok(nodes(f.label("Reviewer saved chats")).some((node) => node.props.href === "/s/45"));
    f.click(f.all().find((node) => node.props.href === "/s/45"));
    assert.equal(f.navigated.at(-1), 45);
    assert.ok(
        f.requests.every((read) => read.body === undefined),
        "History never retries a first-send POST",
    );
});

test("History fences departed source/owner reads and rejects another identity's chats", async (t) => {
    for (const mode of ["source", "owner", "identity"]) {
        await t.test(mode, async (t) => {
            const f = fixture(t, Topbar);

            f.click(f.label("History"));
            const request = f.requests.at(-1);

            if (mode === "source") {
                f.route(7);
            } else if (mode === "owner") {
                f.patch({ me: { id: "new-owner", role: "owner" } });
            }

            request.resolve({
                agentId: mode === "identity" ? "other-agent" : "stable-agent",
                chats: [{ id: 45, title: "Stale private history" }],
            });
            await f.settle();
            assert.doesNotMatch(f.text(), /Stale private history/);

            if (mode === "identity") {
                assert.match(f.text(), /response did not match this agent/);
            } else {
                assert.ok(request.options.signal.aborted);
            }
        });
    }
});

test("native agent-menu callbacks stay pinned to their owner, chat and logical opening", async (t) => {
    for (const [mode, label] of [
        ["source", "Agent settings"],
        ["owner", "History"],
        ["opening", "Memory"],
        ["capability", "All Work Items"],
    ]) {
        await t.test(mode, (t) => {
            const f = fixture(t, Topbar);

            f.click(f.label("Menu"));
            const opening = f.state.sheet;
            const stale = nodes(f.label("Reviewer actions")).find(
                (node) => node.type === "button" && textOf(node) === label,
            );
            const count = f.opened.length;

            if (mode === "source") {
                f.patch({
                    conversationId: 7,
                    view: { conversation: { id: 7, pipAgentId: "stable-agent" } },
                });
            } else if (mode === "owner") {
                f.patch({ me: { id: "another-owner", role: "owner" } });
            } else if (mode === "opening") {
                f.patch({ sheet: { type: "menu" } });
            } else {
                f.patch({ server: { privateAgents: 3, extensions: ["pocket-memory"] } });
            }

            if (mode !== "opening") {
                assert.equal(
                    f.state.sheet,
                    opening,
                    "only the tested authority coordinate changes",
                );
            }

            f.click(stale);
            assert.equal(
                f.opened.length,
                count,
                "a departed menu action cannot open or replace a sheet",
            );
        });
    }
});

test("Memory cannot open an inert sheet when the extension is unavailable", (t) => {
    const f = fixture(t, Topbar);
    const stale = f.label("Memory");

    f.patch({ server: { privateAgents: 4, extensions: [] } });
    assert.equal(f.label("Memory").props.disabled, true);
    assert.match(f.label("Memory").props.title, /Enable Memory in Extensions/);
    f.click(stale);
    assert.equal(f.opened.length, 0, "a stale enabled control must also recheck availability");
    f.click(f.label("Menu"));
    const menu = f.label("Reviewer actions");
    const memory = nodes(menu).find((node) => node.type === "button" && textOf(node) === "Memory");

    assert.equal(memory.props.disabled, true);
    assert.match(memory.props.title, /Enable Memory in Extensions/);
    f.click(memory);
    assert.deepEqual(
        f.opened.map((sheet) => sheet.type),
        ["menu"],
        "the native menu opens, but unavailable Memory does not replace it",
    );
});
