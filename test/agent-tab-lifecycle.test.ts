// Real Preact hooks/reconciliation plus native store navigation and draft disposal.
// Minimal in-memory DOM/Event targets: no browser layout, history or touch claims.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, test, type TestContext } from "node:test";
import { h, options, render } from "preact";
import { act } from "preact/test-utils";

const template = (await import(import.meta.resolve("htm"))).default.bind(h);

type Props = Record<string, any>;
let active: { paths: string[]; requests: { path: string; method: string }[] };
const storage = new Map<string, string>();
const local = new Map<string, string>();
const location = new URL("http://offline.invalid/s/19");

class Primitive {
    parentNode: Primitive | null = null;
    childNodes: Primitive[] = [];
    attributes: Props = {};
    listeners = new Map<string, (this: Primitive, event: Props) => void>();
    nodeType = 1;
    data = "";
    namespaceURI = "http://www.w3.org/1999/xhtml";
    style = { setProperty() {} };
    tag: string;

    constructor(tag: string) {
        assert.match(
            tag,
            /^[a-z][a-z0-9-]*$/i,
            "native elements need a valid tag, not htm's empty fragment",
        );
        this.tag = tag;
    }

    get ownerDocument() {
        return document;
    }
    get localName() {
        return this.tag;
    }
    get firstChild(): Primitive | null {
        return this.childNodes[0] ?? null;
    }
    get nextSibling(): Primitive | null {
        const siblings = this.parentNode?.childNodes;

        return siblings?.[siblings.indexOf(this) + 1] ?? null;
    }
    get props(): Props {
        return {
            ...this.attributes,
            onClick: (event: Props) => this.listeners.get("clickfalse")?.call(this, event),
        };
    }
    get textContent(): string {
        return this.nodeType === 3
            ? this.data
            : this.childNodes.map((child) => child.textContent).join("");
    }
    setAttribute(name: string, value: unknown) {
        this.attributes[name] = String(value);
    }
    removeAttribute(name: string) {
        delete this.attributes[name];
    }
    addEventListener(
        type: string,
        handler: (this: Primitive, event: Props) => void,
        capture = false,
    ) {
        this.listeners.set(`${type}${capture}`, handler);
    }
    removeEventListener(type: string, _handler: unknown, capture = false) {
        this.listeners.delete(`${type}${capture}`);
    }
    insertBefore(child: Primitive, before: Primitive | null) {
        child.parentNode?.removeChild(child);
        const at = before ? this.childNodes.indexOf(before) : -1;

        this.childNodes.splice(at === -1 ? this.childNodes.length : at, 0, child);
        child.parentNode = this;
    }
    appendChild(child: Primitive) {
        this.insertBefore(child, null);
    }
    removeChild(child: Primitive) {
        const at = this.childNodes.indexOf(child);

        assert.notEqual(at, -1);
        this.childNodes.splice(at, 1);
        child.parentNode = null;
    }
    remove() {
        this.parentNode?.removeChild(this);
    }
    focus() {}
    getClientRects() {
        return [{}];
    }
    scrollIntoView() {}
}

const document = Object.assign(new EventTarget(), {
    visibilityState: "hidden",
    documentElement: { dataset: {} },
    querySelector: () => null,
    querySelectorAll: () => [],
    createElementNS: (_namespace: string, tag: string) => new Primitive(tag),
    createTextNode(data: string) {
        const text = new Primitive("text");

        text.nodeType = 3;
        text.data = data;

        return text;
    },
});

const bridge = {
    html: template,
    primitive: (name: string, props: Props) => h(`test-${name.toLowerCase()}`, props),
    paths: (path: string) => {
        location.href = new URL(path, location).href;
        active.paths.push(path);
    },
};
const globals: Record<string, unknown> = {
    agentTabLifecycle: bridge,
    document,
    history: { state: { pocket: { layers: 0 } }, length: 1 },
    location,
    navigator: { platform: "", onLine: false },
    matchMedia: () => Object.assign(new EventTarget(), { matches: false }),
    addEventListener() {},
    removeEventListener() {},
    localStorage: {
        getItem: (key: string) => local.get(key) ?? null,
        setItem: (key: string, value: string) => local.set(key, value),
        removeItem: (key: string) => local.delete(key),
    },
    sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
    },
    fetch: async (path: string, init: RequestInit) => {
        active.requests.push({ path, method: init.method ?? "GET" });
        const saved = /\/c\/(\d+)\/private-agent$/.exec(path);

        return Response.json(
            saved
                ? { id: Number(saved[1]), agentId: "agent-a", controllers: [] }
                : { agentId: "agent-a", chats: store.state.namedAgents[0]?.chats ?? [] },
        );
    },
};
const descriptors = Object.keys(globals).map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
);

for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
}

const inert = (...names: string[]) =>
    names.map((name) => `export const ${name}=()=>null;`).join("\n");
const sources: Record<string, string> = {
    "./ui.js": `const f=globalThis.agentTabLifecycle; export const html=f.html;
        export const Icon=props=>f.primitive('Icon',props),NamedAgentAvatar=props=>f.primitive('Avatar',props);
        export const Sheet=props=>props.children;
        export const item=(label,onClick,hint,props)=>html\`<button onClick=\${onClick} ...\${props}>\${label}</button>\`;
        export const useEdge=()=>()=>{},shortPath=value=>value,timeAgo=()=>'';
        ${inert("Loader", "Spinner")}`,
    "./back.js":
        "export const onRoute=()=>{},pushRoute=path=>globalThis.agentTabLifecycle.paths(path);",
    "./sessions.js": `import {navigate} from ${JSON.stringify(new URL("../web/store.js", import.meta.url).href)};
        import {goHome} from ${JSON.stringify(new URL("../web/back.js", import.meta.url).href)};
        export const toSessions=()=>goHome(()=>navigate(null));`,
    "./named-agent-avatar.js":
        "export const NamedAgentAvatar=props=>globalThis.agentTabLifecycle.primitive('Avatar',props);",
    "./sheets/model.js": inert("ModelPicker"),
    "./sidebar-context.js": inert("openSidebarOptions", "useSidebarContext"),
    "./avatar.js": "export const folderColor=()=>'';",
    "./browser-panel.js": inert("BrowserButton"),
    "./chat.js": inert("PeopleButton"),
    "./diff.js": "export const useChanges=()=>({changes:null});",
    "./files-panel.js": `${inert("FilesButton", "setFilesOpen")} export const filesAvailable=()=>false;`,
    "./extension-ui.js": inert("ExtensionSessionControls"),
    "./peeks.js": inert("PeeksButton"),
    "./sheets/branch.js": "export const branchAvailable=()=>false,headLabel=()=>'';",
    "./subagents.js": inert("openSubagents"),
    "./thread-type.js": inert("ThreadTypeTag"),
    "./workspace-location.js": "export const conversationLocation=()=>null;",
};
const owned = /\/web\/(agent-tabs|topbar|named-agents|agent-history|agent-drafts|store)\.js$/;
const imports = registerHooks({
    resolve(specifier, context, next) {
        // A browser reload refreshes both the tab component and its local dismissal module.
        if (
            specifier === "./agent-tab-state.js" &&
            context.parentURL?.includes("agent-tabs.js?reload=")
        ) {
            return next(`${specifier}${new URL(context.parentURL).search}`, context);
        }

        const source = owned.test(context.parentURL?.split("?")[0] ?? "")
            ? sources[specifier]
            : undefined;

        return source === undefined
            ? next(specifier, context)
            : { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    },
});
const { store, navigate, drafts } = await import(new URL("../web/store.js", import.meta.url).href);
const { Topbar, AgentHeaderSheet } = await import(
    new URL("../web/topbar.js", import.meta.url).href
);
const { openAgentDraft, selectedAgentDraft } = await import(
    new URL("../web/agent-drafts.js", import.meta.url).href
);
const { NamedAgents } = await import(new URL("../web/named-agents.js", import.meta.url).href);
const initial = store.state;
let owners = 0;

after(() => {
    imports.deregister();

    for (const [key, descriptor] of descriptors) {
        if (descriptor) {
            Object.defineProperty(globalThis, key, descriptor);
        } else {
            Reflect.deleteProperty(globalThis, key);
        }
    }
});

async function fixture(t: TestContext, { settle = true, lastSaved = false } = {}) {
    active = { paths: [], requests: [] };
    const observed = active;
    const agent = {
        agentId: "agent-a",
        name: "Ada",
        id: 7,
        chatIds: [7, 19, 27],
        chats: [
            { id: 7, title: "First" },
            { id: 19, title: "Selected", busy: true },
            { id: 27, title: "Last" },
        ],
    };

    if (lastSaved) {
        agent.id = 19;
        agent.chatIds = [19];
        agent.chats = [agent.chats[1]!];
    }

    drafts.set(19, "Unsent composer text");
    const retained = { text: drafts.get(19), revision: drafts.revision(19) };

    store.state = {
        ...initial,
        me: { id: `lifecycle-owner-${++owners}`, role: "owner" },
        server: { privateAgents: 4, extensions: ["pocket-memory"] },
        namedAgents: [agent],
        conversationId: 19,
        view: { ...initial.view, conversation: { id: 19, pipAgentId: "agent-a" } },
    };
    const dom = new Primitive("root");
    const root = dom as unknown as HTMLElement;

    function Host() {
        return [
            h(NamedAgents, {}),
            h(Topbar, {}),
            store.state.sheet?.type === "agent-header"
                ? h(AgentHeaderSheet, { sheet: store.state.sheet })
                : null,
        ];
    }

    // Match app.js: store notifications coalesce into root renders in a microtask.
    let queued = false;
    let disposed = false;
    const stop = store.subscribe(() => {
        if (!queued) {
            queued = true;
            queueMicrotask(() => {
                queued = false;

                if (!disposed) {
                    render(h(Host, {}), root);
                }
            });
        }
    });
    const perform = (action: () => void) =>
        act(async () => {
            action();
            await Promise.resolve();
        });
    const update = () => perform(() => render(h(Host, {}), root));

    if (settle) {
        await update();
    } else {
        render(h(Host, {}), root);
    }

    t.after(async () => {
        disposed = true;
        stop();
        await act(() => render(null, root));
    });
    const descendants = (node: Primitive): Primitive[] => [
        node,
        ...node.childNodes.flatMap(descendants),
    ];
    const all = () => descendants(dom).filter((node) => node.nodeType === 1);

    const label = (name: string) => {
        const element = all().find((element) => element.props["aria-label"] === name);

        assert.ok(element, `${name} is rendered`);

        return element;
    };

    const click = (element: Primitive) =>
        perform(() => element.props.onClick({ preventDefault() {}, stopPropagation() {} }));
    const arrive = (id: number) =>
        perform(() =>
            store.set({ view: { ...initial.view, conversation: { id, pipAgentId: "agent-a" } } }),
        );

    return {
        all,
        label,
        click,
        arrive,
        update,
        perform,
        observed,
        agent,
        retained,
        root,
        text: () => dom.textContent,
    };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const link = (f: Fixture, id: number) =>
    f.all().find((element) => element.tag === "a" && element.props.href === `/s/${id}`);
const named = (f: Fixture) =>
    f.all().some((element) => element.props.class === "topbar agent-topbar");
const composerRetained = (f: Fixture) =>
    assert.deepEqual({ text: drafts.get(19), revision: drafts.revision(19) }, f.retained);
const onlyReads = (f: Fixture) =>
    assert.ok(
        f.observed.requests.every((request) => request.method === "GET"),
        "closing cannot mutate server state",
    );

test("real route metadata gaps keep named chrome instead of the plain Loading fallback", async (t) => {
    const f = await fixture(t);
    const memory = f.label("Memory");

    await f.click(link(f, 7)!);
    assert.equal(store.state.conversationId, 7);
    assert.equal(store.state.view.conversation, null, "native navigate clears old metadata");
    assert.equal(f.text().includes("Loading…"), false, "no ordinary loading-title flash");
    assert.ok(named(f), "named header survives the pending destination");
    assert.ok(link(f, 7));
    await f.click(memory);
    await f.click(f.label("Ada: settings"));
    assert.equal(store.state.sheet, null, "navigation intent is not authority for remote actions");
    assert.equal(
        f.observed.requests.some((request) => request.path.endsWith("c/7/private-agent")),
        false,
    );
    await f.arrive(7);
    assert.ok(
        f.observed.requests.some((request) => request.path.endsWith("c/7/private-agent")),
        "passive reads start once exact destination metadata arrives",
    );
});

test("a second selected close works while its destination metadata is still pending", async (t) => {
    const f = await fixture(t);

    await f.click(f.label("Close Selected tab, chat 19"));
    assert.equal(store.state.conversationId, 27);
    assert.equal(store.state.view.conversation, null);
    await f.click(f.label("Close Last tab, chat 27"));
    assert.equal(store.state.conversationId, 7);
    await f.arrive(7);
    assert.equal(Boolean(link(f, 19)), false);
    assert.equal(Boolean(link(f, 27)), false);
    assert.ok(link(f, 7));
    assert.equal(f.agent.chats.length, 3);
    composerRetained(f);
    onlyReads(f);
});

test("the phone chat picker can close a selected tab during its pending view", async (t) => {
    const f = await fixture(t);

    await f.click(link(f, 7)!);
    await f.click(f.label("First: switch chats"));
    assert.equal(store.state.sheet?.panel, "chats");
    const close = f
        .all()
        .filter((element) => element.props["aria-label"] === "Close First tab, chat 7")
        .at(-1);

    assert.ok(close);
    await f.click(close);
    assert.equal(store.state.sheet, null);
    assert.equal(store.state.conversationId, 19);
    assert.equal(Boolean(link(f, 7)), false);
    onlyReads(f);
});

test("closing before opening effects preserves dismissal through neighbor or native home navigation", async (t) => {
    for (const lastSaved of [false, true]) {
        await t.test(lastSaved ? "last saved tab" : "saved neighbor", async (t) => {
            const frames: (() => void)[] = [];
            const requestFrame = options.requestAnimationFrame;

            options.requestAnimationFrame = (callback) => {
                frames.push(callback);
            };

            try {
                const f = await fixture(t, { settle: false, lastSaved });

                // Use Preact's default microtask scheduler, not act's render queue override:
                // a local close render can precede native goHome's queued route change.
                f.label("Close Selected tab, chat 19").props.onClick({
                    preventDefault() {},
                    stopPropagation() {},
                });
                await new Promise<void>((resolve) => setImmediate(resolve));

                for (const frame of frames.splice(0)) {
                    frame();
                }

                assert.deepEqual(
                    JSON.parse(
                        storage.get(`pocket.pipClosedTabs.${store.state.me.id}.agent-a`) ?? "[]",
                    ),
                    [19],
                    "the outgoing opening effect must not erase the saved dismissal",
                );
                assert.equal(store.state.conversationId, lastSaved ? null : 27);

                if (!lastSaved) {
                    await f.arrive(27);
                }

                assert.equal(Boolean(link(f, 19)), false);
                const row = f.all().find((element) => element.props["data-agent-id"] === "agent-a");

                assert.ok(row);
                await f.click(row);
                assert.equal(store.state.conversationId, lastSaved ? null : 7);
                assert.equal(Boolean(selectedAgentDraft()), lastSaved);
                composerRetained(f);
                onlyReads(f);
            } finally {
                options.requestAnimationFrame = requestFrame;
            }
        });
    }
});

test("selected close stays dismissed across native navigation and keyed header remount", async (t) => {
    const f = await fixture(t);

    await f.click(f.label("Close Selected tab, chat 19"));
    assert.equal(store.state.conversationId, 27);
    await f.arrive(27);
    assert.equal(
        Boolean(link(f, 19)),
        false,
        "closed saved tab must not reopen when the neighbor loads",
    );
    composerRetained(f);
});

test("inactive close survives a fresh module load and actual History can reopen it", async (t) => {
    const f = await fixture(t);

    await f.click(f.label("Close First tab, chat 7"));
    assert.equal(Boolean(link(f, 7)), false);
    assert.equal(store.state.conversationId, 19);
    await f.perform(() => render(null, f.root));
    const { AgentTabs } = await import(
        new URL(`../web/agent-tabs.js?reload=${owners}`, import.meta.url).href
    );

    await f.perform(() => render(h(AgentTabs, {}), f.root));
    assert.equal(Boolean(link(f, 7)), false, "fresh dismissal state reads sessionStorage");
    assert.ok(link(f, 19));
    await f.update();
    await f.click(f.label("History"));
    const history = f
        .all()
        .find(
            (element) =>
                element.props.class === "agent-history-chat " && element.props.href === "/s/7",
        );

    assert.ok(history, "dismissed chat remains discoverable in native History");
    await f.click(history);
    assert.equal(store.state.conversationId, 7);
    await f.arrive(7);
    assert.ok(link(f, 7), "History restores the closed tab");
    onlyReads(f);
});

test("closing the last saved tab returns home without removing its chat or retained work", async (t) => {
    const f = await fixture(t);

    await f.perform(() => {
        f.agent.chats = [f.agent.chats[1]!];
        f.agent.chatIds = [19];
        store.set({});
    });
    await f.click(f.label("Close Selected tab, chat 19"));
    assert.equal(store.state.conversationId, null);
    assert.equal(named(f), false);
    assert.deepEqual(f.agent.chats, [{ id: 19, title: "Selected", busy: true }]);
    composerRetained(f);
    assert.equal(f.observed.paths.at(-1), "/");
    onlyReads(f);
});

test("sidebar re-entry respects closed tabs and uses a draft when no saved tab remains", async (t) => {
    for (const mode of [
        "remaining saved tab",
        "saved tab before draft",
        "all closed",
        "existing draft",
    ]) {
        await t.test(mode, async (t) => {
            const f = await fixture(t);
            const hasSaved = mode === "remaining saved tab" || mode === "saved tab before draft";
            let existingDraft: Props | undefined;

            await f.click(f.label("Close First tab, chat 7"));

            if (!hasSaved) {
                await f.click(f.label("Close Selected tab, chat 19"));
                await f.click(f.label("Close Last tab, chat 27"));
            }

            if (mode === "existing draft" || mode === "saved tab before draft") {
                await f.perform(() => {
                    existingDraft = openAgentDraft("agent-a");
                });
            }

            const reopen = async () => {
                await f.perform(() => navigate(null));
                const row = f.all().find((element) => element.props["data-agent-id"] === "agent-a");

                assert.ok(row, "the actual sidebar identity is available outside its chats");
                await f.click(row);
            };

            await reopen();

            if (hasSaved) {
                assert.equal(store.state.conversationId, 19, "skip the closed default chat");
                await f.arrive(19);
                assert.equal(Boolean(link(f, 7)), false);
                assert.ok(link(f, 19));

                if (existingDraft) {
                    assert.equal(selectedAgentDraft(), null, "prefer an open saved Chat");
                    assert.ok(f.label(`Close New chat draft, chat ${existingDraft.id}`));
                }
            } else {
                assert.equal(store.state.conversationId, null);
                const draft = selectedAgentDraft();

                assert.ok(draft, "opening an identity with all saved tabs closed shows a draft");
                assert.equal(draft.agentId, "agent-a");
                assert.equal(draft.text, "");

                if (existingDraft) {
                    assert.equal(draft.id, existingDraft.id, "reuse the still-open local draft");
                }

                assert.ok(named(f));
                assert.equal(Boolean(link(f, 7)), false);
                assert.equal(Boolean(link(f, 19)), false);
                assert.equal(Boolean(link(f, 27)), false);
                await reopen();
                assert.equal(
                    selectedAgentDraft()?.id,
                    draft.id,
                    "re-entry does not pile up drafts",
                );
                await f.click(f.label(`Close New chat draft, chat ${draft.id}`));
                assert.equal(selectedAgentDraft(), null);
                await reopen();
                assert.ok(selectedAgentDraft());
                assert.notEqual(
                    selectedAgentDraft()?.id,
                    draft.id,
                    "a disposed draft stays closed",
                );
            }

            assert.equal(f.agent.chats.length, 3, "closed conversations remain in History");
            assert.equal(f.agent.chats[1]?.busy, true, "closing does not stop retained work");
            composerRetained(f);
            onlyReads(f);
        });
    }
});

test("sidebar entry checks the live owner, capability and identity catalogue before navigating", async (t) => {
    for (const [name, change] of Object.entries({
        owner: () => ({ me: { ...store.state.me, id: "different-owner" } }),
        role: () => ({ me: { ...store.state.me, role: "member" } }),
        capability: () => ({ server: { privateAgents: 3 } }),
        removed: () => ({ namedAgents: [] }),
        replaced: () => ({
            namedAgents: [{ agentId: "agent-b", id: 88, chatIds: [88], chats: [{ id: 88 }] }],
        }),
        refreshed: () => ({
            namedAgents: [
                { ...store.state.namedAgents[0], id: 27, chatIds: [27], chats: [{ id: 27 }] },
            ],
        }),
    })) {
        await t.test(name, async (t) => {
            const f = await fixture(t);

            await f.perform(() => navigate(null));
            const row = f.all().find((element) => element.props["data-agent-id"] === "agent-a");

            assert.ok(row);
            const updated = change();

            // The native click can run after a store change but before app.js's queued render.
            await f.perform(() => {
                store.set(updated);
                row.props.onClick({ preventDefault() {}, stopPropagation() {} });
            });
            assert.equal(store.state.conversationId, name === "refreshed" ? 27 : null);
            assert.equal(selectedAgentDraft(), null, "a stale row must not create a draft");
            assert.deepEqual(
                store.state.namedAgents,
                "namedAgents" in updated ? updated.namedAgents : [f.agent],
            );
            onlyReads(f);
        });
    }
});

test("sidebar and phone picker share local dismissals when browser storage is unavailable", async (t) => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage")!;

    Object.defineProperty(globalThis, "sessionStorage", {
        configurable: true,
        get() {
            throw new Error("Browser storage is unavailable");
        },
    });
    t.after(() => Object.defineProperty(globalThis, "sessionStorage", descriptor));
    const f = await fixture(t);

    await f.click(f.label("Selected: switch chats"));

    for (const title of ["First", "Selected", "Last"]) {
        const id = { First: 7, Selected: 19, Last: 27 }[title];
        const close = f
            .all()
            .filter((element) => element.props["aria-label"] === `Close ${title} tab, chat ${id}`)
            .at(-1);

        assert.ok(close);
        await f.click(close);
    }

    assert.equal(store.state.conversationId, null);
    const row = f.all().find((element) => element.props["data-agent-id"] === "agent-a");

    assert.ok(row);
    await f.click(row);
    assert.ok(selectedAgentDraft());
    assert.equal(Boolean(link(f, 7) || link(f, 19) || link(f, 27)), false);
    assert.equal(f.agent.chats.length, 3);
    composerRetained(f);
    onlyReads(f);
});

test("closing the last empty draft disposes it locally without creating a saved Chat", async (t) => {
    const f = await fixture(t);
    let draft: Props;

    await f.perform(() => {
        f.agent.chats = [];
        f.agent.chatIds = [];
        draft = openAgentDraft("agent-a");
    });
    assert.ok(selectedAgentDraft());
    await f.click(f.label(`Close New chat draft, chat ${draft!.id}`));
    assert.equal(selectedAgentDraft(), null);
    assert.equal(store.state.agentDraft, null);
    assert.equal(store.state.conversationId, null);
    assert.deepEqual(f.agent.chats, []);
    assert.equal(named(f), false);
    composerRetained(f);
    onlyReads(f);
});

test("native navigation alone never infers identity from matching catalogue chat IDs", async (t) => {
    const f = await fixture(t);

    await f.perform(() => navigate(7));
    assert.equal(named(f), false);
    assert.equal(Boolean(link(f, 7)), false);
});

test("pending chrome and captured close handlers remain owner, route and metadata fenced", async (t) => {
    for (const [name, change] of Object.entries({
        role: () => ({ me: { ...store.state.me, role: "member" } }),
        owner: () => ({ me: { ...store.state.me, id: "different-owner" } }),
        capability: () => ({ server: { privateAgents: 3 } }),
        catalogue: () => ({ namedAgents: [] }),
        route: () => ({ conversationId: 777 }),
        privateRoute: () => ({ privateId: "private-pane" }),
        draft: () => ({ agentDraft: { id: "other-draft", agentId: "agent-a" } }),
        missing: () => ({ missing: "Not found" }),
        staleView: () => ({
            view: { ...initial.view, conversation: { id: 777, pipAgentId: "agent-a" } },
        }),
        conflictingIdentity: () => ({
            view: { ...initial.view, conversation: { id: 7, pipAgentId: "different-agent" } },
        }),
    })) {
        await t.test(name, async (t) => {
            const f = await fixture(t);
            const owner = store.state.me;
            const server = store.state.server;

            await f.click(link(f, 7)!);
            const close = f.label("Close First tab, chat 7");
            const dismissed = [...storage];

            await f.perform(() => store.set(change()));
            assert.equal(named(f), false);
            const route = store.state.conversationId;

            await f.click(close);
            assert.equal(store.state.conversationId, route);
            assert.deepEqual([...storage], dismissed, "stale callback cannot dismiss anything");
            await f.perform(() =>
                store.set({
                    me: owner,
                    server,
                    namedAgents: [f.agent],
                    conversationId: 7,
                    privateId: null,
                    agentDraft: null,
                    missing: null,
                    view: { ...initial.view, conversation: null },
                }),
            );
            assert.equal(
                named(f),
                false,
                "lost intent cannot revive after access or route restoration",
            );
            onlyReads(f);
        });
    }
});
