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
        set: (value: Props | ((state: Props) => Props)) =>
            active.patch(typeof value === "function" ? value(active.state) : value),
        subscribe(listener: () => void) {
            listeners.add(listener);

            return () => listeners.delete(listener);
        },
    },
    api: (...args: any[]) => active.api(...args),
    sessionActions: { updateSession: (...args: any[]) => active.updateSession(...args) },
    drafts: {
        revision: (id: number) => active.draftRevision(id),
        set: (...args: any[]) => active.setDraft(...args),
        discard: (id: number) => active.setDraft(id, ""),
    },
    notify: (...args: any[]) => active.notice(...args),
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
const confirmDescriptor = Object.getOwnPropertyDescriptor(globalThis, "confirm");

Object.defineProperty(globalThis, "agentTabsUiFixture", { configurable: true, value: bridge });
Object.defineProperty(globalThis, "confirm", {
    configurable: true,
    value: (message: string) => {
        active.confirm.messages.push(message);

        return active.confirm.allow;
    },
});
after(() => {
    for (const [key, previous] of [
        ["agentTabsUiFixture", descriptor],
        ["confirm", confirmDescriptor],
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
        "export const {store,api,uid,navigate,openSheet,closeSheet,projectsAvailable,drafts,notify}=globalThis.agentTabsUiFixture; export const actions=globalThis.agentTabsUiFixture.sessionActions;",
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
    "./peeks.js": `const b=globalThis.agentTabsUiFixture;
        export const PeeksButton=(props)=>b.marker('PeeksButton',props);
        export const peeksOn=()=>b.store.state.managedPeeksOn===true;
        export const togglePeeks=()=>b.store.set({managedPeeksOn:!peeksOn()});
        export const setManagedPeeks=(scope,read)=>{
            const value={...scope,...read}; b.store.set({managedPeeks:value});
            return ()=>{if(b.store.state.managedPeeks===value)b.store.set({managedPeeks:null});};
        };`,
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
    const mutations: any[] = [];
    const notices: unknown[][] = [];
    const draftWrites: unknown[][] = [];
    const draftRevisions = new Map<number, number>();
    const confirm = { allow: true, messages: [] as string[] };
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
        server: { privateAgents: 4, peeks: true, extensions: ["pocket-memory"] },
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
        confirm,
        notice: (...args: unknown[]) => notices.push(args),
        draftRevision: (id: number) => draftRevisions.get(id) ?? 0,
        setDraft: (id: number, text: string) => {
            draftRevisions.set(id, (draftRevisions.get(id) ?? 0) + 1);
            draftWrites.push([id, text]);
            state.retained.drafts[id] = text;
        },
        updateSession: (id: number, patch: Props) =>
            new Promise((resolve, reject) => mutations.push({ id, patch, resolve, reject })),
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
        mutations,
        notices,
        draftWrites,
        confirm,
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

test("saved Close waits for native archive acknowledgement before removing tabs or navigating", async (t) => {
    for (const direction of ["next", "previous"] as const) {
        await t.test(direction, async (t) => {
            const f = fixture(t);

            threeChats(f);
            const inactiveId = direction === "next" ? 7 : 27;
            const inactive = f.label(direction === "next" ? closeInitial : closeFollowup);
            const link = chatLink(f, inactiveId);
            const parent = f
                .all()
                .find((node) => [node.props.children].flat(Infinity).includes(link));

            assert.ok(parent);
            assert.ok(
                [parent.props.children].flat(Infinity).includes(inactive),
                "Close is a sibling of its link",
            );
            assert.equal(
                nodes(link).some((node) => node.type === "button"),
                false,
            );
            f.focus(inactive);
            f.click(inactive);
            assert.deepEqual(
                f.mutations.map(({ id, patch }) => ({ id, patch })),
                [{ id: inactiveId, patch: { archived: true } }],
            );
            assert.ok(
                chatLink(f, inactiveId),
                "the tab stays visible until the server accepts Close",
            );
            assert.deepEqual(f.draftWrites, []);
            assert.deepEqual(f.navigated, []);
            assert.equal(
                f.confirm.messages.length,
                0,
                "an idle Chat closes without a warning even when its sibling is working",
            );
            f.click(inactive);
            assert.equal(
                f.mutations.length,
                1,
                "duplicate clicks cannot submit duplicate archives",
            );
            f.mutations[0].resolve({});
            await f.settle();
            assert.equal(
                f.all().some((node) => node.props.href === "/s/" + inactiveId),
                false,
            );
            assert.equal(f.state.conversationId, 19);
            assert.equal(f.focused(), "/s/19");
            assert.deepEqual(f.draftWrites, [[inactiveId, ""]]);
            f.focus(f.label(closeActive));
            f.click(f.label(closeActive));
            const confirmation = f.confirm.messages[0];

            assert.ok(confirmation);
            assert.match(confirmation, /stops this Chat and its orchestration/);
            assert.match(confirmation, /Independent child Work Items keep running/);
            assert.match(confirmation, /Unsent drafts.*discarded/);
            assert.match(confirmation, /History/);
            assert.equal(
                f.state.conversationId,
                19,
                "selected route also waits for acknowledgement",
            );
            assert.equal(f.state.retained.drafts[19], "Unsaved active draft");
            f.mutations[1].resolve({});
            await f.settle();
            const neighbor = direction === "next" ? 27 : 7;

            assert.deepEqual(f.navigated, [neighbor]);
            assert.equal(f.state.retained.drafts[19], "");
            f.route(neighbor);
            assert.equal(f.focused(), "/s/" + neighbor);
            f.click(f.label(direction === "next" ? closeFollowup : closeInitial));
            f.mutations[2].resolve({});
            await f.settle();
            assert.deepEqual(f.returned, ["sessions"]);
            assert.deepEqual(f.state.namedAgents[0].chats, []);
            assert.equal(
                f.requests.length,
                0,
                "Close uses native metadata mutation, never a model request",
            );
        });
    }
});

test("saved Close warns only for the target Chat's current activity and preserves rejected drafts", async (t) => {
    for (const { before, activity, warn } of [
        { before: "busy", activity: "idle", warn: false },
        { before: "idle", activity: "busy", warn: true },
        { before: "idle", activity: "managing", warn: true },
    ]) {
        await t.test(`${before} → ${activity}`, async (t) => {
            const f = fixture(t);
            const setActivity = (value: string) =>
                f.patch({
                    namedAgents: f.state.namedAgents.map((agent: Props) => ({
                        ...agent,
                        chats: agent.chats.map((chat: Props) =>
                            chat.id !== 7
                                ? chat
                                : {
                                      ...chat,
                                      busy: value === "busy",
                                      managing: value === "managing",
                                  },
                        ),
                    })),
                });

            setActivity(before);
            const captured = f.label(closeInitial);

            setActivity(activity);
            f.confirm.allow = false;
            f.click(captured);
            assert.equal(f.confirm.messages.length, warn ? 1 : 0);

            if (warn) {
                assert.equal(f.mutations.length, 0);
                assert.ok(chatLink(f, 7));
                assert.deepEqual(f.draftWrites, []);
                f.confirm.allow = true;
                f.click(f.label(closeInitial));
                assert.equal(f.confirm.messages.length, 2);
            }

            assert.equal(f.mutations.length, 1);
            f.mutations[0].reject(new Error("Archive denied"));
            await f.settle();
            assert.ok(chatLink(f, 7));
            assert.deepEqual(f.draftWrites, []);
            assert.equal(f.state.retained.drafts[7], "Unsaved first draft");
            assert.deepEqual(f.navigated, []);
            assert.match(JSON.stringify(f.notices), /Archive denied/);
        });
    }
});

test("accepted Close cleans its own draft after source departure but cannot affect another owner or redirect", async (t) => {
    for (const mode of ["source", "owner"]) {
        await t.test(mode, async (t) => {
            const f = fixture(t);

            f.click(f.label(closeActive));
            const accepted = f.mutations[0];

            assert.deepEqual(accepted.patch, { archived: true });

            if (mode === "source") {
                f.route(7);
            } else {
                f.patch({ me: { id: "different-owner", role: "owner" } });
            }

            accepted.resolve({});
            await f.settle();
            assert.equal(f.state.conversationId, mode === "source" ? 7 : 19);
            assert.deepEqual(f.navigated, []);
            assert.deepEqual(f.returned, []);
            assert.deepEqual(
                f.draftWrites,
                mode === "source" ? [[19, ""]] : [],
                "closed-Chat cleanup is independent of navigation, but remains owner-fenced",
            );
        });
    }
});

test("link keys move focus without activation and Delete archives before choosing a neighbor", async (t) => {
    const f = fixture(t);

    threeChats(f);
    f.focus(chatLink(f, 19));
    assert.equal(f.key(chatLink(f, 19), "ArrowRight"), true);
    assert.equal(f.focused(), "/s/27");
    f.key(chatLink(f, 27), "Home");
    assert.equal(f.focused(), "/s/7");
    f.key(chatLink(f, 7), "End");
    assert.equal(f.focused(), "/s/27");
    f.key(chatLink(f, 27), "ArrowLeft");
    assert.equal(f.focused(), "/s/19");
    assert.deepEqual(f.navigated, []);
    assert.equal(f.key(chatLink(f, 19), "Enter"), false);
    assert.equal(f.key(chatLink(f, 19), "Delete"), true);
    assert.deepEqual(f.navigated, []);
    assert.deepEqual(f.mutations[0].patch, { archived: true });
    f.mutations[0].resolve({});
    await f.settle();
    assert.deepEqual(f.navigated, [27]);
    f.route(27);
    assert.equal(f.focused(), "/s/27");
    assert.equal(
        f.all().some((node) => node.props.href === "/s/19"),
        false,
    );
});

test("last-tab Close returns focus to visible existing navigation, never under a newer sheet", async (t) => {
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
                value: { querySelectorAll: () => [group, agent], querySelector: () => rail },
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
            f.mutations[0].resolve({});
            await f.settle();
            f.click(f.label(closeActive));
            f.mutations[1].resolve({});

            if (mode === "newer-sheet") {
                queueMicrotask(() => f.patch({ sheet: { type: "settings" } }));
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

test("every saved tab and phone switcher leads with its agent avatar and exposes active status", (t) => {
    const f = fixture(t);

    f.patch({
        namedAgents: [
            {
                ...f.state.namedAgents[0],
                chats: [
                    { id: 7, title: "Initial setup", busy: false, managing: true },
                    { id: 19, title: "Accessibility review", busy: true },
                    { id: 27, title: "Follow up", busy: false },
                ],
            },
        ],
    });

    for (const [id, thinking] of [
        [7, true],
        [19, true],
        [27, false],
    ] as const) {
        const children = nodes(chatLink(f, id));
        const avatar = children.find((node) => node.type === "test-avatar");
        const title = children.find((node) => node.props.class === "agent-tab-title");

        assert.ok(avatar);
        assert.equal(avatar.props.agentId, "stable-agent");
        assert.equal(avatar.props.size, 22);
        assert.equal(avatar.props.animated, true);
        assert.equal(Boolean(avatar.props.thinking), thinking);
        assert.ok(children.indexOf(avatar) < children.indexOf(title), "avatar precedes title");

        if (thinking) {
            assert.ok(
                children.some((node) =>
                    /Working|Managing|Running|Orchestrat/i.test(
                        node.props["aria-label"] ?? textOf(node),
                    ),
                ),
                "activity is accessible without relying on avatar animation",
            );
        }
    }

    const switcherButton = f.label("Accessibility review: switch chats");
    const switcher = nodes(switcherButton);
    const avatar = switcher.find((node) => node.type === "test-avatar");

    assert.ok(avatar);
    assert.equal(avatar.props.agentId, "stable-agent");
    assert.equal(avatar.props.size, 22);
    assert.equal(avatar.props.animated, true);
    assert.equal(Boolean(avatar.props.thinking), true);
    assert.ok(
        switcher.indexOf(avatar) <
            switcher.findIndex((node) => node.props.class === "agent-tab-title"),
    );
    assert.match(
        [switcherButton.props["aria-label"], switcherButton.props["aria-description"]].join(" "),
        /Working/,
        "the phone switcher's explicit accessible name must not hide its selected Chat's activity",
    );
    f.click(f.label("New chat with Reviewer"));
    const draft = f
        .all()
        .find((node) => node.props.role === "button" && node.props["aria-current"] === "page");
    const draftAvatar = nodes(draft).find((node) => node.type === "test-avatar");

    assert.ok(draftAvatar, "local draft tabs share the named identity avatar");
    assert.equal(draftAvatar.props.agentId, "stable-agent");
    assert.equal(draftAvatar.props.size, 22);
    assert.equal(draftAvatar.props.animated, true);
    assert.equal(Boolean(draftAvatar.props.thinking), false);
});

test("an archived native view cannot regenerate a saved source tab missing from the catalogue", async (t) => {
    for (const archived of [false, true]) {
        await t.test(archived ? "archived" : "catalogue event pending", (t) => {
            const f = fixture(t);

            f.patch({
                namedAgents: [
                    {
                        ...f.state.namedAgents[0],
                        chatIds: [7],
                        chats: [f.state.namedAgents[0].chats[0]],
                    },
                ],
                view: {
                    conversation: {
                        id: 19,
                        pipAgentId: "stable-agent",
                        title: "Accessibility review",
                        archived,
                    },
                },
            });
            assert.equal(
                f.all().some((node) => node.props.href === "/s/19"),
                !archived,
            );
            assert.ok(chatLink(f, 7));
            assert.deepEqual(
                f.mutations,
                [],
                "rendering an archived route never restores it implicitly",
            );
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
    const settings = f.label("Reviewer: settings");
    const cog = nodes(settings).find((node) => node.type === "test-icon");
    const header = f.all().find((node) => node.type === "header");
    const buttons = nodes(header).filter((node) => node.type === "button");

    assert.equal(cog.props.name, "settings");
    assert.equal(buttons.at(-2), settings, "settings is immediately before the native menu");
    assert.equal(buttons.at(-1).props["aria-label"], "Menu");
    assert.ok(
        nodes(header).some((node) => node.type === "test-avatar"),
        "tab avatars stay inside native header chrome",
    );
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

test("phone chooser closes a saved Chat only after native archive acknowledgement", async (t) => {
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
    assert.match(f.renderedText(sheet), /archives.*stops.*Initial setup.*Accessibility review/s);
    assert.doesNotMatch(f.renderedText(sheet), /\[object Object\]/);
    assert.ok(!nodes(header).some((node) => node.type === "test-sheet"));
    const choices = f.label("Reviewer open chats");
    const inactive = nodes(choices).find((node) => node.props["aria-label"] === closeInitial);
    const selected = nodes(choices).find((node) => node.props.href === "/s/19");

    f.focus(inactive);
    f.click(inactive);
    assert.equal(f.confirm.messages.length, 0, "the phone picker also closes idle Chats quietly");
    assert.ok(nodes(f.label("Reviewer open chats")).some((node) => node.props.href === "/s/7"));
    assert.deepEqual(f.mutations[0].patch, { archived: true });
    f.mutations[0].resolve({});
    await f.settle();
    assert.equal(
        f.focusedElement(),
        selected.element,
        "inactive Close keeps focus inside the chooser",
    );
    assert.equal(f.navigated.length, 0);
    sheet.props.onClose();
    assert.ok(!f.all().some((node) => node.type === "test-sheet"));
    assert.equal(f.state.sheet, null);
    assert.equal(f.label("Accessibility review: switch chats").props["aria-expanded"], false);
});

function restoreButton(f: ReturnType<typeof fixture>, title: string) {
    const row = nodes(f.label("Reviewer saved chats")).find(
        (node) =>
            node.props.class?.split(" ").includes("agent-history-chat") &&
            textOf(node).includes(title),
    );
    const button = nodes(row).find(
        (node) => node.type === "button" && /Restore/.test(textOf(node)),
    );

    assert.ok(button, "archived History rows expose an explicit Restore button");

    return button;
}

test("History explicitly restores an archived Chat before navigating and leaves ordinary open read-only", async (t) => {
    const f = fixture(t, Topbar);

    f.click(f.label("History"));
    f.requests.at(-1).resolve({
        agentId: "stable-agent",
        chats: [
            { id: 45, title: "Archived work", archived: true },
            { id: 7, title: "Initial setup", archived: false },
        ],
    });
    await f.settle();
    const restore = restoreButton(f, "Archived work");

    assert.equal(
        nodes(f.label("Reviewer saved chats")).some(
            (node) => node.type === "a" && node.props.href === "/s/45",
        ),
        false,
        "an archived row cannot navigate around Restore",
    );
    f.click(restore);
    assert.deepEqual(
        f.mutations.map(({ id, patch }) => ({ id, patch })),
        [{ id: 45, patch: { archived: false } }],
    );
    assert.deepEqual(f.navigated, []);
    assert.ok(f.state.sheet);
    f.mutations[0].reject(new Error("Restore denied"));
    await f.settle();
    assert.deepEqual(f.navigated, []);
    assert.ok(f.state.sheet);
    assert.match(JSON.stringify(f.notices) + f.text(), /Restore denied/);
    f.click(restoreButton(f, "Archived work"));
    f.mutations[1].resolve({});
    await f.settle();
    assert.equal(f.navigated.at(-1), 45);
    assert.equal(f.state.sheet, null);
    f.route(45);
    assert.equal(chatLink(f, 45).props["aria-current"], "page");
    f.click(f.label("History"));
    f.requests
        .at(-1)
        .resolve({ agentId: "stable-agent", chats: [{ id: 7, title: "Initial setup" }] });
    await f.settle();
    f.click(nodes(f.label("Reviewer saved chats")).find((node) => node.props.href === "/s/7"));
    assert.equal(f.navigated.at(-1), 7);
    assert.equal(f.mutations.length, 2, "an already open Chat needs no restore mutation");
    assert.ok(
        f.requests.every((request) => request.body === undefined),
        "History cannot start model work",
    );
});

test("late Restore acknowledgements cannot navigate from a departed History source or owner", async (t) => {
    for (const mode of ["source", "owner"]) {
        await t.test(mode, async (t) => {
            const f = fixture(t, Topbar);

            f.click(f.label("History"));
            f.requests.at(-1).resolve({
                agentId: "stable-agent",
                chats: [{ id: 45, title: "Archived work", archived: true }],
            });
            await f.settle();
            f.click(restoreButton(f, "Archived work"));
            assert.equal(f.mutations[0].id, 45);

            if (mode === "source") {
                f.route(7);
            } else {
                f.patch({ me: { id: "different-owner", role: "owner" } });
            }

            const sheet = f.state.sheet;

            f.mutations[0].resolve({});
            await f.settle();
            assert.deepEqual(f.navigated, []);
            assert.equal(
                f.state.sheet,
                sheet,
                "late Restore must not replace another owner's sheet",
            );
        });
    }
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

test("orchestrator button toggles native Peeks, while complete contact history stays in the menu", async (t) => {
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
    const peeks = f.label("Orchestrator Peeks");

    assert.equal(peeks.props["aria-pressed"], false);
    assert.equal(peeks.props["aria-description"], "1 currently managed, 1 active");
    f.click(peeks);
    assert.equal(f.label("Orchestrator Peeks").props["aria-pressed"], true);
    assert.equal(
        f.state.sheet ?? null,
        null,
        "Peeks uses the native tile surface, not the contact sheet",
    );
    f.click(f.label("Menu"));
    f.click(
        nodes(f.label("Reviewer actions")).find(
            (node) => node.type === "button" && textOf(node) === "All Work Items",
        ),
    );
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
    f.click(f.all().find((node) => node.props.href === "/s/30"));
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
    assert.equal(
        f.label("Orchestrator Peeks").props["aria-description"],
        "1 currently managed, 1 active",
    );
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
    assert.equal(
        f.label("Orchestrator Peeks").props["aria-description"],
        "No current orchestrators",
    );
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
                            String(node.props["aria-description"]).startsWith(
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
