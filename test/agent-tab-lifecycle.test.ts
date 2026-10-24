// Real Preact hooks/reconciliation plus native store navigation and draft disposal.
// Minimal in-memory DOM/Event targets: no browser layout, history or touch claims.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, test, type TestContext } from "node:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";

const template = (await import(import.meta.resolve("htm"))).default.bind(h);

type Props = Record<string, any>;
type Mutation = {
    path: string;
    method: string;
    patch: Props;
    resolve: (response: Response) => void;
    reject: (error: Error) => void;
};
let active: {
    paths: string[];
    requests: { path: string; method: string }[];
    mutations: Mutation[];
    history: Props[];
    confirms: string[];
};
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
let events: NativeEvents;

class NativeEvents extends EventTarget {
    constructor(_url: string) {
        super();
        events = this;
    }
    close() {}
    emit(name: string, data: unknown) {
        this.dispatchEvent(Object.assign(new Event(name), { data: JSON.stringify(data) }));
    }
}

const globals: Record<string, unknown> = {
    EventSource: NativeEvents,
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
    confirm: (message: string) => {
        active.confirms.push(message);

        return true;
    },
    fetch: async (path: string, init: RequestInit) => {
        active.requests.push({ path, method: init.method ?? "GET" });

        if (/\/api\/sessions\/\d+$/.test(path) && init.method === "POST") {
            return new Promise<Response>((resolve, reject) =>
                active.mutations.push({
                    path,
                    method: init.method!,
                    patch: JSON.parse(String(init.body)),
                    resolve,
                    reject,
                }),
            );
        }

        const saved = /\/c\/(\d+)\/private-agent$/.exec(path);

        return Response.json(
            saved
                ? { id: Number(saved[1]), agentId: "agent-a", controllers: [] }
                : { agentId: "agent-a", chats: active.history },
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
    "./peeks.js": inert("PeeksButton", "peeksOn", "setManagedPeeks", "togglePeeks"),
    "./sheets/branch.js": "export const branchAvailable=()=>false,headLabel=()=>'';",
    "./subagents.js": inert("openSubagents"),
    "./thread-type.js": inert("ThreadTypeTag"),
    "./workspace-location.js": "export const conversationLocation=()=>null;",
};
const owned = /\/web\/(agent-tabs|topbar|named-agents|agent-history|agent-drafts|store)\.js$/;
const imports = registerHooks({
    resolve(specifier, context, next) {
        const source = owned.test(context.parentURL?.split("?")[0] ?? "")
            ? sources[specifier]
            : undefined;

        return source === undefined
            ? next(specifier, context)
            : { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    },
});
const { store, navigate, drafts, dismiss, connect } = await import(
    new URL("../web/store.js", import.meta.url).href
);
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
    active = { paths: [], requests: [], mutations: [], history: [], confirms: [] };
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

    // Controlled HTTP history is separate from the client projection; it is not backend persistence proof.
    observed.history = structuredClone(agent.chats);
    drafts.set(19, "Unsent composer text");
    local.set("pocket.pastes.19", JSON.stringify([{ id: "paste-1", text: "Folded unsent text" }]));
    const retained = {
        text: drafts.get(19),
        revision: drafts.revision(19),
        pastes: local.get("pocket.pastes.19"),
    };

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
            // Native api() also awaits Response.text(), beyond the immediate click microtask.
            await new Promise<void>((resolve) => setImmediate(resolve));
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

        for (const notice of store.state.notices) {
            dismiss(notice.id);
        }

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
    const nativeEvent = (name: string, data: unknown) =>
        perform(() => {
            document.visibilityState = "visible";
            Object.assign(navigator, { onLine: true });
            connect();

            try {
                events.emit(name, data);
            } finally {
                document.visibilityState = "hidden";
                Object.assign(navigator, { onLine: false });
                connect();
            }
        });
    const acknowledge = (index = observed.mutations.length - 1) =>
        perform(() => observed.mutations[index]!.resolve(Response.json({})));

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
        nativeEvent,
        acknowledge,
        async accept(index = observed.mutations.length - 1) {
            const mutation = observed.mutations[index];

            assert.ok(mutation, "native session mutation was submitted");
            const id = Number(mutation.path.split("/").at(-1));
            const saved = observed.history.find((chat) => chat.id === id);

            assert.ok(saved);
            Object.assign(saved, mutation.patch);
            await acknowledge(index);
        },
        async catalogueEvent() {
            const chats = observed.history.filter((chat) => !chat.archived);

            await nativeEvent("namedAgents", [
                {
                    ...agent,
                    id: chats[0]?.id ?? null,
                    chats: structuredClone(chats),
                    chatIds: chats.map((chat) => chat.id),
                },
            ]);
        },
        text: () => dom.textContent,
    };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const link = (f: Fixture, id: number) =>
    f.all().find((element) => element.tag === "a" && element.props.href === `/s/${id}`);
const named = (f: Fixture) =>
    f.all().some((element) => element.props.class === "topbar agent-topbar");
const composerRetained = (f: Fixture) =>
    assert.deepEqual(
        {
            text: drafts.get(19),
            revision: drafts.revision(19),
            pastes: local.get("pocket.pastes.19"),
        },
        f.retained,
    );
const onlyReads = (f: Fixture) =>
    assert.ok(
        f.observed.requests.every((request) => request.method === "GET"),
        "this navigation-only scenario cannot mutate server state",
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

test("acknowledged selected Close clears the real composer draft and supports a second pending destination Close", async (t) => {
    const f = await fixture(t);

    await f.click(f.label("Close Selected tab, chat 19"));
    assert.equal(store.state.conversationId, 19);
    composerRetained(f);
    const archive = f.observed.mutations[0];

    assert.ok(archive);
    assert.deepEqual(archive.patch, { archived: true });
    await f.accept();
    assert.equal(drafts.get(19), "");
    assert.ok(drafts.revision(19) > f.retained.revision);
    assert.equal(
        local.has("pocket.pastes.19"),
        false,
        "discard also removes folded unsent paste bodies",
    );
    assert.equal(store.state.conversationId, 27);
    assert.equal(store.state.view.conversation, null);
    await f.click(f.label("Close Last tab, chat 27"));
    assert.equal(store.state.conversationId, 27);
    await f.accept();
    assert.equal(store.state.conversationId, 7);
    await f.arrive(7);
    assert.equal(Boolean(link(f, 19)), false);
    assert.equal(Boolean(link(f, 27)), false);
    assert.ok(link(f, 7));
    assert.ok(
        f.observed.requests.every(
            (request) => request.method === "GET" || /\/api\/sessions\/(19|27)$/.test(request.path),
        ),
        "only native metadata mutations supplement passive reads",
    );
});

test("accepted Close still removes its tab and navigates when draft storage removal throws", async (t) => {
    const f = await fixture(t);
    const removeItem = localStorage.removeItem;
    let failures = 0;

    localStorage.removeItem = () => {
        failures++;

        throw new Error("Browser storage is unavailable");
    };

    try {
        let closing: unknown;

        await f.perform(() => {
            closing = f.label("Close Selected tab, chat 19").props.onClick({
                preventDefault() {},
                stopPropagation() {},
            });
        });
        assert.equal(store.state.conversationId, 19, "native acknowledgement is still required");
        await Promise.all([f.accept(), assert.doesNotReject(Promise.resolve(closing))]);
        assert.ok(failures > 0, "the accepted Close exercised unavailable draft storage");
        assert.equal(store.state.conversationId, 27);
        assert.equal(Boolean(link(f, 19)), false);
        await f.arrive(27);
        assert.ok(link(f, 27));
        assert.equal(Boolean(link(f, 19)), false);
    } finally {
        localStorage.removeItem = removeItem;
    }
});

test("the phone picker can archive a selected tab during its pending native view", async (t) => {
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
    assert.equal(store.state.conversationId, 7);
    assert.ok(store.state.sheet);
    await f.accept();
    assert.equal(store.state.sheet, null);
    assert.equal(store.state.conversationId, 19);
    assert.equal(Boolean(link(f, 7)), false);
});

test("archive acknowledgement survives native catalogue refresh, keyed header remount and sidebar re-entry", async (t) => {
    const f = await fixture(t);

    await f.click(f.label("Close Selected tab, chat 19"));
    await f.accept();
    await f.catalogueEvent();
    await f.arrive(27);
    assert.equal(Boolean(link(f, 19)), false);
    assert.equal(drafts.get(19), "");
    await f.perform(() => render(null, f.root));
    await f.update();
    assert.equal(
        Boolean(link(f, 19)),
        false,
        "fresh component state follows the server-backed catalogue",
    );
    await f.perform(() => navigate(null));
    const row = f.all().find((element) => element.props["data-agent-id"] === "agent-a");

    assert.ok(row);
    await f.click(row);
    assert.equal(store.state.conversationId, 7);
    await f.arrive(7);
    assert.equal(Boolean(link(f, 19)), false);
    assert.equal(
        f.observed.mutations.length,
        1,
        "re-entry does not implicitly restore archived work",
    );
});

test("native History Restore waits for metadata acknowledgement before reopening the exact Chat", async (t) => {
    const f = await fixture(t);

    await f.click(f.label("Close First tab, chat 7"));
    await f.accept();
    await f.click(f.label("History"));
    await f.update();
    const restore = f
        .all()
        .find((element) => element.tag === "button" && /Restore/.test(element.textContent));

    assert.ok(restore);
    assert.equal(
        Boolean(link(f, 7)),
        false,
        "archived History row cannot use an ordinary open link",
    );
    await f.click(restore);
    assert.equal(store.state.conversationId, 19);
    const restoring = f.observed.mutations[1];

    assert.ok(restoring);
    assert.deepEqual(restoring.patch, { archived: false });
    await f.accept();
    assert.equal(store.state.conversationId, 7);
    await f.catalogueEvent();
    await f.arrive(7);
    assert.ok(link(f, 7));
    assert.equal(f.observed.mutations.length, 2);
    assert.ok(
        f.observed.requests.every(
            (request) => request.method === "GET" || request.path === "/api/sessions/7",
        ),
    );
});

test("closing the last saved Chat before passive effects returns home only after acknowledgement", async (t) => {
    const f = await fixture(t, { settle: false, lastSaved: true });

    await f.click(f.label("Close Selected tab, chat 19"));
    assert.equal(store.state.conversationId, 19);
    composerRetained(f);
    await f.accept();
    assert.equal(store.state.conversationId, null);
    assert.equal(named(f), false);
    assert.equal(drafts.get(19), "");
    assert.equal(f.observed.paths.at(-1), "/");
    assert.deepEqual(store.state.namedAgents[0].chats, []);
});

test("sidebar re-entry prefers a remaining saved Chat and reuses a local draft when all saved Chats are archived", async (t) => {
    for (const mode of ["saved chat", "existing draft", "new draft"]) {
        await t.test(mode, async (t) => {
            const f = await fixture(t);
            let draft: Props | undefined;

            await f.click(f.label("Close First tab, chat 7"));
            await f.accept();

            if (mode !== "saved chat") {
                await f.click(f.label("Close Selected tab, chat 19"));
                await f.accept();
                await f.click(f.label("Close Last tab, chat 27"));
                await f.accept();
            }

            if (mode !== "new draft") {
                await f.perform(() => {
                    draft = openAgentDraft("agent-a");
                });
            }

            const reopen = async () => {
                await f.perform(() => navigate(null));
                const row = f.all().find((element) => element.props["data-agent-id"] === "agent-a");

                assert.ok(row);
                await f.click(row);
            };

            await reopen();

            if (mode === "saved chat") {
                assert.ok([19, 27].includes(store.state.conversationId));
                await f.arrive(store.state.conversationId);
                assert.equal(
                    selectedAgentDraft(),
                    null,
                    "saved Chats take priority over local drafts",
                );
                assert.ok(f.label("Close New chat draft, chat " + draft!.id));
            } else {
                const selected = selectedAgentDraft();

                assert.ok(selected);
                assert.equal(selected.agentId, "agent-a");

                if (draft) {
                    assert.equal(selected.id, draft.id);
                }

                await reopen();
                assert.equal(
                    selectedAgentDraft()?.id,
                    selected.id,
                    "re-entry does not create duplicate drafts",
                );
                assert.equal(Boolean(link(f, 7) || link(f, 19) || link(f, 27)), false);
            }
        });
    }
});

test("late accepted Close discards only the closed Chat's unchanged draft, without redirecting a departed source or owner", async (t) => {
    for (const mode of ["owner", "source", "newer draft"]) {
        await t.test(mode, async (t) => {
            const f = await fixture(t);

            await f.click(f.label("Close Selected tab, chat 19"));

            if (mode === "owner") {
                await f.perform(() => store.set({ me: { id: "different-owner", role: "owner" } }));
            } else {
                await f.perform(() => navigate(7));

                if (mode === "newer draft") {
                    drafts.set(19, "A later composer edit");
                }
            }

            const paths = [...f.observed.paths];

            await f.accept();

            if (mode === "owner") {
                composerRetained(f);
            } else if (mode === "newer draft") {
                assert.equal(drafts.get(19), "A later composer edit");
            } else {
                assert.equal(drafts.get(19), "");
                assert.equal(local.has("pocket.pastes.19"), false);
                await f.catalogueEvent();
                assert.equal(drafts.get(19), "", "ack-before-catalogue cannot strand the draft");
            }

            assert.deepEqual(
                f.observed.paths,
                paths,
                "late success must not redirect the departed source",
            );
        });
    }
});

test("concurrent Close acknowledgements choose only current eligible saved or draft neighbors", async (t) => {
    for (const destination of ["saved", "draft", "home", "picker"]) {
        for (const order of [
            [0, 1],
            [1, 0],
        ]) {
            await t.test(`${destination}: ${order.join(" then ")}`, async (t) => {
                const f = await fixture(t);
                let draft: Props | undefined;

                if (destination === "draft" || destination === "home") {
                    await f.click(f.label("Close First tab, chat 7"));
                    await f.accept();
                    f.observed.mutations.length = 0;
                }

                if (destination === "draft") {
                    await f.perform(() => {
                        draft = openAgentDraft("agent-a");
                    });
                    await f.click(link(f, 19)!);
                    await f.arrive(19);
                }

                await f.click(f.label("Close Last tab, chat 27"));

                if (destination === "picker") {
                    await f.click(f.label("Selected: switch chats"));
                    const close = f
                        .all()
                        .filter(
                            (item) => item.props["aria-label"] === "Close Selected tab, chat 19",
                        )
                        .at(-1);

                    assert.ok(close);
                    await f.click(close);
                } else {
                    await f.click(f.label("Close Selected tab, chat 19"));
                }

                for (const index of order) {
                    await f.accept(index);
                }

                assert.equal(
                    store.state.conversationId,
                    destination === "saved" || destination === "picker" ? 7 : null,
                );
                assert.equal(selectedAgentDraft()?.id ?? null, draft?.id ?? null);
                assert.equal(Boolean(link(f, 19) || link(f, 27)), false);
            });
        }
    }
});

test("newer native Restore events survive a delayed Close response and preserve the fresh composer", async (t) => {
    const f = await fixture(t);

    await f.click(f.label("Close Selected tab, chat 19"));
    f.observed.history.find((chat) => chat.id === 19)!.archived = true;
    await f.catalogueEvent();
    await f.nativeEvent("view", {
        conversation: { id: 19, pipAgentId: "agent-a", archived: true },
        entries: [],
        live: {},
    });
    assert.equal(drafts.get(19), "", "native archive events discard the old composer");
    f.observed.history.find((chat) => chat.id === 19)!.archived = false;
    await f.catalogueEvent();
    await f.nativeEvent("view", {
        conversation: { id: 19, pipAgentId: "agent-a", archived: false },
        entries: [],
        live: {},
    });
    drafts.set(19, "Fresh text after Restore");
    local.set("pocket.pastes.19", "Fresh folded paste after Restore");
    const revision = drafts.revision(19);
    const paths = [...f.observed.paths];

    await f.acknowledge(0);
    assert.equal(store.state.conversationId, 19);
    assert.equal(store.state.view.conversation.archived, false);
    assert.ok(link(f, 19), "the restored tab is still open");
    assert.equal(drafts.get(19), "Fresh text after Restore");
    assert.equal(drafts.revision(19), revision);
    assert.equal(local.get("pocket.pastes.19"), "Fresh folded paste after Restore");
    assert.deepEqual(f.observed.paths, paths);
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

            await f.perform(() => store.set(change()));
            assert.equal(named(f), false);
            const route = store.state.conversationId;
            const catalogue = structuredClone(store.state.namedAgents);

            await f.click(close);
            assert.equal(store.state.conversationId, route);
            assert.deepEqual(
                store.state.namedAgents,
                catalogue,
                "stale callback cannot alter the catalogue",
            );
            assert.deepEqual(f.observed.mutations, [], "stale callback cannot archive a Chat");
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
