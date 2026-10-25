// Authoring gate: the real sidebar's native button callbacks own project entry and exact-Chat
// activity. A project click opening a conversation, identity-wide thinking, or nesting work under
// a sibling Chat must fail here. Existing project tests cover catalogue placement; group-navigation
// owns exact Work Item controller/member destinations. No production test export is introduced.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, test } from "node:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";

const template = (await import(import.meta.resolve("htm"))).default.bind(h);

type Props = Record<string, any>;
type VNode = { type: string | ((props: Props) => unknown); props: Props };
type Slot = { value?: any; current?: any; deps?: unknown[]; cleanup?: () => void };
type Fiber = { slots: Slot[]; cursor: number };
let current: Fiber;
let effects: (() => void)[] = [];

const noop = () => {};

const storage = new Map<string, string>();
const fixture = {
    state: {} as Props,
    navigations: [] as Props[],
    sheets: [] as Props[],
    html: template,
    hooks: {
        useState(initial: any) {
            const slot = (current.slots[current.cursor++] ??= {
                value: typeof initial === "function" ? initial() : initial,
            });

            return [
                slot.value,
                (next: any) => (slot.value = typeof next === "function" ? next(slot.value) : next),
            ];
        },
        useRef(value: any) {
            return (current.slots[current.cursor++] ??= { current: value });
        },
        useEffect(run: () => (() => void) | undefined, deps: unknown[]) {
            const slot = (current.slots[current.cursor++] ??= {});

            if (!slot.deps || deps.some((value, index) => !Object.is(value, slot.deps![index]))) {
                slot.deps = deps;
                effects.push(() => {
                    slot.cleanup?.();
                    slot.cleanup = run();
                });
            }
        },
    },
};

// Minimal DOM host for real Preact reconciliation. It deliberately has no CSS/layout engine.
class Element {
    parentNode: Element | null = null;
    childNodes: Element[] = [];
    attributes: Props = {};
    listeners = new Map<string, (this: Element, event: Props) => void>();
    nodeType = 1;
    data = "";
    namespaceURI = "http://www.w3.org/1999/xhtml";
    style = { setProperty() {} };
    localName: string;

    constructor(name: string) {
        this.localName = name;
    }
    get ownerDocument() {
        return document;
    }
    get firstChild(): Element | null {
        return this.childNodes[0] ?? null;
    }
    get nextSibling(): Element | null {
        const siblings = this.parentNode?.childNodes;

        return siblings?.[siblings.indexOf(this) + 1] ?? null;
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
        handler: (this: Element, event: Props) => void,
        capture = false,
    ) {
        this.listeners.set(`${type}${capture}`, handler);
    }
    removeEventListener(type: string, _handler: unknown, capture = false) {
        this.listeners.delete(`${type}${capture}`);
    }
    insertBefore(child: Element, before: Element | null) {
        child.parentNode?.removeChild(child);
        const at = before ? this.childNodes.indexOf(before) : -1;

        this.childNodes.splice(at === -1 ? this.childNodes.length : at, 0, child);
        child.parentNode = this;
    }
    appendChild(child: Element) {
        this.insertBefore(child, null);
    }
    remove() {
        this.parentNode?.removeChild(this);
    }
    removeChild(child: Element) {
        const at = this.childNodes.indexOf(child);

        assert.notEqual(at, -1);
        this.childNodes.splice(at, 1);
        child.parentNode = null;
    }
}
const document = {
    documentElement: { dataset: {} },
    createElementNS: (_namespace: string, name: string) => new Element(name),
    createTextNode(data: string) {
        const text = new Element("text");

        text.nodeType = 3;
        text.data = data;

        return text;
    },
};
const descriptors = new Map<string, PropertyDescriptor | undefined>();

for (const [name, value] of Object.entries({
    sidebarNavigationFixture: fixture,
    document,
    localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
    },
    matchMedia: () => ({ matches: false }),
    addEventListener: noop,
    removeEventListener: noop,
})) {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
}

const sources: Record<string, string> = {
    "preact/hooks": `export const {useState,useRef,useEffect}=globalThis.sidebarNavigationFixture.hooks; export const useLayoutEffect=()=>{};`,
    "store.js": `const f=globalThis.sidebarNavigationFixture;
        export const store={get state(){return f.state},set:patch=>Object.assign(f.state,typeof patch==='function'?patch(f.state):patch)};
        export const navigate=(id,options)=>f.navigations.push({id,options}),openSheet=sheet=>f.sheets.push(sheet);
        export const actions={},attempt=run=>run(),notify=()=>{},canSteer=()=>store.state.me.role!=='viewer',collab=()=>false,handoffsAvailable=()=>true,projectsAvailable=()=>true,scoped=()=>!!store.state.me.sessionId;
        export const isUnread=()=>false,sessionUnread=()=>false,setUnread=()=>{},stillMoving=m=>m,workspaceOrder=()=>[];`,
    "ui.js": `export const html=globalThis.sidebarNavigationFixture.html;
        export const apartFromViews=c=>c,Icon=p=>html\`<native-icon ...\${p} />\`,Spinner=()=>html\`<native-spinner />\`;
        export const APPLE=false,Slide=()=>null,shortPath=p=>p??'',timeAgo=()=>'',railState=()=>'',scrimPress=()=>()=>{},usePresence=()=>[],useSide=()=>'',useSlide=()=>null;`,
    "avatar.js": `export const Avatar=()=>null,folderColor=()=>'',initials=()=>'';`,
    "back.js": `export const goHome=run=>run(),useBack=()=>{};`,
    "extension-ui.js": `export const ExtensionRailButtons=()=>null;`,
    "gestures.js": `export const useDragToClose=()=>{};`,
    "peeks.js": `export const PeeksRailButton=()=>null;`,
    "pip.js": `export const PipRailButton=()=>null;`,
    "private.js": `export const PrivateList=()=>null,PrivateTabs=()=>null;`,
    "named-agent-avatar.js": `export const NamedAgentAvatar=props=>globalThis.sidebarNavigationFixture.html\`<native-blobatar ...\${props} />\`;`,
    "named-agents.js": `export const NamedAgents=()=>globalThis.sidebarNavigationFixture.html\`<obsolete-pips-row />\`;`,
    "session-hold.js": `export const useSessionHold=()=>({hold:null,consumeClick:()=>false});`,
    "session-moves.js": `export const canMoveSessions=()=>false,useSessionDrag=()=>({busy:false,consumeClick:()=>false});`,
    "session-seen.js": `export const sessionResultUnread=()=>false;`,
    "ssh-status.js": `export const RemoteProjectIcon=()=>null;`,
    "sidebar-context.js": `export const openSidebarOptions=()=>{},useSidebarContext=()=>{};`,
    "thread-type.js": `export const ThreadTypeTag=()=>null,threadTypeLabel=()=>'';`,
    "theme.js": `export const isPinned=()=>false,prefs=()=>({projectGroup:'projects'}),setPrefs=()=>{},togglePin=()=>{};`,
};

registerHooks({
    resolve(specifier, context, next) {
        const sessions = context.parentURL?.split("?")[0]?.endsWith("/web/sessions.js");
        const nativeHooks =
            context.parentURL?.endsWith("?native-render") && specifier === "preact/hooks";
        const source =
            sessions && !nativeHooks
                ? (sources[specifier] ?? sources[specifier.split("/").at(-1)!])
                : undefined;

        return source === undefined
            ? next(specifier, context)
            : { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    },
});
const { SessionList } = await import(new URL("../web/sessions.js", import.meta.url).href);
const { SessionList: NativeSessionList } = await import(
    new URL("../web/sessions.js?native-render", import.meta.url).href
);

after(() => {
    for (const [name, descriptor] of descriptors) {
        if (descriptor) {
            Object.defineProperty(globalThis, name, descriptor);
        } else {
            Reflect.deleteProperty(globalThis, name);
        }
    }
});

function mount(props: Props = {}) {
    const fibers = new Map<string, Fiber>();

    const visit = (value: any, path: string): any => {
        if (Array.isArray(value)) {
            return value.map((child, index) => visit(child, `${path}/${index}`));
        }

        if (!value?.props) {
            return value;
        }

        if (typeof value.type === "function") {
            current = fibers.get(path) ?? { slots: [], cursor: 0 };
            current.cursor = 0;
            fibers.set(path, current);

            return visit(value.type(value.props), `${path}/render`);
        }

        return {
            ...value,
            props: { ...value.props, children: visit(value.props.children, `${path}/children`) },
        };
    };

    return {
        render() {
            const tree = visit(h(SessionList, props), "root");
            const pending = effects;

            effects = [];
            pending.forEach((run) => run());

            return tree;
        },
        dispose() {
            for (const fiber of fibers.values()) {
                fiber.slots.forEach((slot) => slot.cleanup?.());
            }
        },
    };
}

function nodes(value: any): VNode[] {
    if (Array.isArray(value)) {
        return value.flatMap(nodes);
    }

    return value?.props ? [value, ...nodes(value.props.children)] : [];
}

const classHas = (node: VNode, name: string) => String(node.props.class).split(" ").includes(name);
const click = { detail: 1, preventDefault() {}, stopPropagation() {} };

function setup(role = "owner") {
    storage.clear();
    fixture.sheets = [];
    fixture.navigations = [];
    fixture.state = {
        me: { id: role, role },
        conversationId: null,
        projectId: null,
        sidebarTab: "sessions",
        server: { projects: 1, privateAgents: 4 },
        sessions: [
            {
                id: 1,
                title: "Arbitrary existing chat",
                projectId: "build",
                cwd: "/repo",
                updatedAt: 1,
            },
        ],
        sessionsLoaded: true,
        projects: [{ id: "build", name: "Build", defaultAgentId: "nora" }],
        projectsLoaded: true,
        namedAgents: [{ agentId: "nora", name: "Nora", chats: [] }],
        pinned: [],
        moving: {},
    };
}

test("project header separates navigation from collapse and preserves native creation intents", () => {
    setup();
    const list = mount();

    try {
        const tree = list.render();
        const all = nodes(tree);
        const project = all.find((node) => node.props["aria-label"] === "Open project Build")!;
        const collapse = all.find((node) => node.props["aria-label"] === "Collapse Build")!;

        assert.ok(project);
        assert.ok(collapse);
        project.props.onClick(click);
        assert.deepEqual(fixture.navigations, [{ id: null, options: { projectId: "build" } }]);
        assert.equal(collapse.props["aria-expanded"], true);
        collapse.props.onClick(click);
        assert.ok(nodes(list.render()).some((node) => node.props["aria-label"] === "Expand Build"));
        assert.equal(fixture.navigations.length, 1, "collapse never picks a Chat or project route");
        all.find((node) => node.props["aria-label"] === "New Session in Build")!.props.onClick(
            click,
        );
        all.find((node) => node.props["aria-label"] === "New session")!.props.onClick(click);
        assert.deepEqual(fixture.sheets, [
            { type: "new-session", projectId: "build" },
            { type: "new-session" },
        ]);
        assert.equal(
            all.some((node) => node.props["aria-label"] === "Edit Build"),
            false,
        );
        assert.ok(
            nodes(project).some(
                (node) => node.type === "native-blobatar" && node.props.agentId === "nora",
            ),
        );
    } finally {
        list.dispose();
    }
});

// Newly linked identities must be visible before they have any Chats. Existing header coverage
// only supplies project.defaultAgentId, so it cannot catch the independent settings association.
test("a freshly linked identity appears in its project without inventing a Chat or a default", () => {
    setup();
    fixture.state.projects[0].defaultAgentId = null;
    fixture.state.namedAgents = [];
    const list = mount();

    try {
        list.render();
        // A successful settings/catalogue refresh supplies the saved association, not a new Chat.
        fixture.state.namedAgents = [
            { agentId: "nora", name: "Nora", projectId: "build", chats: [] },
        ];
        const project = nodes(list.render()).find(
            (node) => node.props["data-project-id"] === "build",
        )!;

        assert.ok(
            nodes(project).some(
                (node) => node.type === "native-blobatar" && node.props.agentId === "nora",
            ),
            "the linked identity is represented in project navigation with no Chat required",
        );
        assert.equal(
            fixture.state.projects[0].defaultAgentId,
            null,
            "explicit no-default survives",
        );
        assert.equal(
            nodes(project).some((node) => classHas(node, "project-chat")),
            false,
        );
        assert.deepEqual(fixture.navigations, []);

        fixture.state.namedAgents.push({
            agentId: "mia",
            name: "Mia",
            projectId: "build",
            chats: [],
        });
        let all = nodes(list.render());
        let related = all.find((node) => node.props["aria-label"] === "Related PiPs for Build")!;

        assert.ok(related, "multiple links remain explicit, rather than choosing a default");
        assert.deepEqual(
            nodes(related)
                .filter((node) => node.type === "native-blobatar")
                .map((node) => node.props.agentId),
            ["nora", "mia"],
        );
        assert.equal(fixture.state.projects[0].defaultAgentId, null);
        fixture.state.projects[0].defaultAgentId = "nora";
        all = nodes(list.render());
        related = all.find((node) => node.props["aria-label"] === "Related PiPs for Build")!;
        assert.deepEqual(
            nodes(related)
                .filter((node) => node.type === "native-blobatar")
                .map((node) => node.props.agentId),
            ["mia"],
            "the explicit default remains in the heading, other links remain visible",
        );
        fixture.state.projects[0].defaultAgentId = null;
        all = nodes(list.render());
        assert.ok(
            all.some((node) => node.props["aria-label"] === "Related PiPs for Build"),
            "clearing a default does not unlink identities",
        );
        fixture.state.namedAgents[0].projectId = "other";
        related = nodes(list.render()).find(
            (node) => node.props["aria-label"] === "Related PiPs for Build",
        )!;
        assert.deepEqual(
            nodes(related)
                .filter((node) => node.type === "native-blobatar")
                .map((node) => node.props.agentId),
            ["mia"],
            "reassignment removes the stale relationship on refresh",
        );
        fixture.state.projects[0].defaultAgentId = "nora";
        fixture.state.me = { id: "guest", role: "guest" };
        const guestTree = nodes(list.render());

        assert.equal(
            guestTree.find((node) => node.props["aria-label"] === "Open project Build")!.props[
                "aria-description"
            ],
            undefined,
            "cached owner defaults do not leak through accessibility text after revocation",
        );
        assert.equal(
            guestTree.some((node) => node.type === "native-blobatar"),
            false,
            "owner identity links are never exposed to collaborators",
        );
    } finally {
        list.dispose();
    }
});

test("saved Chats retain exact placement and activity while unassigned Chats remain reachable", () => {
    setup();
    fixture.state.namedAgents[0] = {
        agentId: "nora",
        name: "Nora",
        projectId: "build", // Identity remit is deliberately not Chat placement.
        busy: true,
        managing: true,
        chats: [
            { id: 10, title: "Idle sibling", projectId: "build", busy: false, managing: false },
            { id: 11, title: "Managing", projectId: "build", busy: false, managing: true },
            { id: 12, title: "Thinking", projectId: "build", busy: true, managing: false },
            {
                id: 13,
                title: "Different project",
                projectId: "other",
                busy: false,
                managing: false,
            },
            { id: 14, title: "Unassigned", busy: false, managing: false },
            {
                id: 15,
                title: "Closed",
                projectId: "build",
                archived: true,
                busy: false,
                managing: false,
            },
        ],
    };
    fixture.state.sessions.push({ id: 16, title: "Pinned independent", updatedAt: 0 });
    fixture.state.pinned = [16];
    const list = mount();

    try {
        const tree = list.render();
        const build = nodes(tree).find((node) => node.props["data-project-id"] === "build")!;
        const flat = nodes(tree).find(
            (node) => classHas(node, "session-group") && !node.props["data-project-id"],
        )!;
        const chats = nodes(tree).filter((node) => classHas(node, "project-chat"));

        assert.deepEqual(
            nodes(build)
                .filter((node) => classHas(node, "project-chat"))
                .map((node) => node.props["data-chat-id"]),
            [10, 11, 12],
        );
        assert.equal(
            nodes(flat).find(
                (node) => classHas(node, "session-row") || classHas(node, "project-chat"),
            )!.props["data-id"],
            16,
            "native pinned unassigned threads still precede newly reachable named Chats",
        );

        assert.deepEqual(
            chats.map((node) => node.props["data-chat-id"]),
            [10, 11, 12, 13, 14],
        );

        for (const chat of chats) {
            const face = nodes(chat).find((node) => node.type === "native-blobatar")!;
            const button = nodes(chat).find((node) => classHas(node, "project-chat-open"))!;
            const working = [11, 12].includes(chat.props["data-chat-id"]);

            assert.equal(
                nodes(chat).some((node) => classHas(node, "project-chat-disclosure")),
                false,
                "a leaf has no disclosure control or phantom placeholder",
            );
            assert.equal(face.props.agentId, "nora");
            assert.equal(face.props.animated, working);
            assert.equal(
                face.props.thinking,
                working,
                "idle siblings never inherit identity activity",
            );
            assert.equal(
                nodes(chat).some((node) => node.type === "native-spinner"),
                false,
            );
            assert.equal(
                nodes(chat).some((node) => classHas(node, "project-chat-activity")),
                false,
            );
            assert.equal(
                nodes(chat).some((node) => classHas(node, "group-body")),
                false,
            );
            assert.equal(nodes(button).filter((node) => node.type === "native-blobatar").length, 1);
            const activity =
                chat.props["data-chat-id"] === 11
                    ? "Managing work"
                    : working
                      ? "Working"
                      : undefined;

            assert.equal(button.props["aria-description"], activity);
            assert.equal(/ · (Managing work|Working)$/.test(button.props.title), working);

            if (activity) {
                assert.ok(button.props.title.endsWith(` · ${activity}`));
            }

            button.props.onClick(click);
        }

        assert.deepEqual(
            fixture.navigations.map((entry) => entry.id),
            [10, 11, 12, 13, 14],
        );
        const idle = nodes(chats[0]).find((node) => classHas(node, "project-chat-open"))!;

        fixture.state.me = { id: "another-owner", role: "owner" };
        idle.props.onClick(click);
        assert.equal(
            fixture.navigations.length,
            5,
            "a retained callback cannot cross owner identity",
        );
        fixture.state.me = { id: "owner", role: "owner" };
        fixture.state.namedAgents[0].chats = [];
        idle.props.onClick(click);
        assert.equal(
            fixture.navigations.length,
            5,
            "a removed Chat is never replaced with a sibling",
        );
        fixture.state.projects = [];
        fixture.state.sessions = [];
        fixture.state.namedAgents[0].chats = [{ id: 14, title: "Unassigned" }];
        const onlyUnassigned = nodes(list.render());

        assert.equal(
            onlyUnassigned.some((node) => node.props["data-chat-id"] === 14),
            true,
        );
        assert.equal(
            onlyUnassigned.some((node) => classHas(node, "sessions-empty")),
            false,
            "a sidebar with an existing unassigned named Chat is not empty",
        );
    } finally {
        list.dispose();
    }
});

// Chronology is owned by the real list consumer, not the project-only projection. Chat wrappers
// must never become generic session IDs for selection, pinning, drag or organization operations.
test("Recent interleaves exact saved Chats by own/owned-work recency without session-target aliases", () => {
    setup();
    const now = Date.now();

    fixture.state.namedAgents[0].chats = [
        {
            id: 10,
            title: "Managing exact",
            projectId: "build",
            updatedAt: now - 500,
            managing: true,
        },
        { id: 11, title: "Leaf exact", projectId: "build", updatedAt: now - 200 },
        { id: 12, title: "Closed exact", projectId: "build", archived: true, updatedAt: now },
    ];
    fixture.state.namedAgents[0].controllers = [{ id: 99 }];
    fixture.state.sessions = [
        { id: 1, title: "Middle ordinary", projectId: "build", updatedAt: now - 100 },
        { id: 2, title: "Older ordinary", updatedAt: now - 300 },
        {
            id: 3,
            title: "Recent owned work",
            projectId: "build",
            workItemId: "recent-owned",
            activeThreadId: 3,
            updatedAt: now - 50,
            groupingParentChatId: 10,
            supervisor: { conversationId: 99, status: "reclaimed" },
        },
    ];
    fixture.state.pinned = [11]; // A Chat ID is not a valid ordinary pin/organization target.
    const list = mount();

    try {
        nodes(list.render())
            .find((node) => node.props.role === "tab" && node.props.children === "Recent")!
            .props.onClick(click);
        let all = nodes(list.render());
        const entries = all.filter(
            (node) =>
                classHas(node, "project-chat") ||
                (classHas(node, "session-row") &&
                    !classHas(node, "work-item-head") &&
                    !classHas(node, "work-item-member")),
        );

        assert.deepEqual(
            entries.map((node) => node.props["data-chat-id"] ?? node.props["data-id"]),
            [10, 1, 11, 2],
        );
        assert.equal(
            all.filter((node) => node.props["data-work-item-id"] === "recent-owned").length,
            1,
        );
        assert.equal(
            all.some((node) => node.props["data-id"] === 99),
            false,
            "private controllers never become catalogue rows",
        );
        assert.equal(
            all.some(
                (node) =>
                    classHas(node, "session-group") &&
                    nodes(node).some((child) => child.props.children === "Pinned"),
            ),
            false,
        );
        const chat = all.find((node) => node.props["data-chat-id"] === 11)!;

        nodes(chat)
            .find((node) => classHas(node, "project-chat-open"))!
            .props.onClick({ ...click, ctrlKey: true });
        assert.deepEqual(
            fixture.navigations,
            [{ id: 11, options: undefined }],
            "even modifier activation opens the exact Chat rather than selecting it",
        );
        const search = all.find(
            (node) =>
                node.type === "input" && node.props["aria-label"] === "Search sessions, projects",
        )!;

        search.props.onInput({ currentTarget: { value: "managing exact" } });
        all = nodes(list.render());
        assert.deepEqual(
            all
                .filter((node) => classHas(node, "project-chat"))
                .map((node) => node.props["data-chat-id"]),
            [10],
        );
        assert.equal(
            all.filter((node) => node.props["data-work-item-id"] === "recent-owned").length,
            1,
            "Chat search retains its real children",
        );
        search.props.onInput({ currentTarget: { value: "build" } });
        all = nodes(list.render());
        assert.deepEqual(
            all
                .filter((node) => classHas(node, "project-chat"))
                .map((node) => node.props["data-chat-id"]),
            [10, 11],
        );
        assert.equal(
            all.some((node) => classHas(node, "session-row") && node.props["data-id"] === 2),
            false,
            "project search excludes unrelated flat rows",
        );
        search.props.onInput({ currentTarget: { value: "" } });
        fixture.state.pinned = [3];
        all = nodes(list.render());
        const pinned = all.find(
            (node) =>
                classHas(node, "session-group") &&
                nodes(node).some((child) => child.props.children === "Pinned"),
        )!;

        assert.ok(pinned, "a pinned owned Work Item keeps its Chat container reachable in Pinned");
        assert.deepEqual(
            nodes(pinned)
                .filter((node) => classHas(node, "project-chat"))
                .map((node) => node.props["data-chat-id"]),
            [10],
        );
        assert.equal(
            all.filter((node) => node.props["data-work-item-id"] === "recent-owned").length,
            1,
        );
        fixture.state.namedAgents[0].chats[0].managing = false;
        const stopped = nodes(list.render()).find((node) => node.props["data-chat-id"] === 10)!;

        assert.ok(nodes(stopped).some((node) => classHas(node, "project-chat-disclosure")));
        assert.equal(
            nodes(stopped).find((node) => node.type === "native-blobatar")!.props.thinking,
            false,
            "Recent retains stopped ownership with an inactive Avatar",
        );
        fixture.state.me = { id: "guest", role: "guest" };
        assert.equal(
            nodes(list.render()).some((node) => classHas(node, "project-chat")),
            false,
            "cached owner Chats remain private in Recent",
        );
    } finally {
        list.dispose();
    }
});

// Archived-row activation is owned by this sidebar boundary; native Chat tests separately own
// read-only rendering and explicit Restore. Listing a closed Chat must not leave a dead button.
test("Archived opens the exact closed named Chat without restoring or creating anything", () => {
    setup();
    fixture.state.namedAgents[0].chats = [
        { id: 15, title: "Closed", projectId: "build", archived: true, managing: false },
        { id: 16, title: "Open sibling", projectId: "build" },
    ];
    fixture.state.sessions = [
        {
            id: 2,
            title: "Completed worker",
            projectId: "build",
            archived: true,
            workItemId: "closed-owned",
            activeThreadId: 3,
            updatedAt: 1,
            groupingParentChatId: 15,
            supervisor: { conversationId: 99, status: "reclaimed" },
        },
        {
            id: 3,
            title: "Stopped follow-up",
            projectId: "build",
            archived: true,
            workItemId: "closed-owned",
            activeThreadId: 3,
            updatedAt: 2,
            groupingParentChatId: 15,
            supervisor: { conversationId: 99, status: "reclaimed" },
        },
        {
            id: 4,
            title: "Moved closed work",
            projectId: "unavailable",
            archived: true,
            workItemId: "closed-moved",
            activeThreadId: 4,
            updatedAt: 3,
            groupingParentChatId: 15,
        },
    ];
    const list = mount();

    try {
        nodes(list.render())
            .find((node) => node.props.role === "tab" && node.props.children === "Archived")!
            .props.onClick(click);
        const archived = nodes(list.render()).filter((node) => classHas(node, "project-chat"));

        assert.deepEqual(
            archived.map((node) => node.props["data-chat-id"]),
            [15],
        );
        assert.equal(
            nodes(archived[0]).filter((node) => node.props["data-work-item-id"] === "closed-owned")
                .length,
            1,
        );
        assert.equal(
            nodes(archived[0]).filter((node) => classHas(node, "work-item-member")).length,
            2,
        );
        assert.equal(
            nodes(archived[0]).some((node) => node.props["data-work-item-id"] === "closed-moved"),
            false,
        );
        assert.ok(nodes(archived[0]).some((node) => classHas(node, "project-chat-disclosure")));
        assert.equal(
            nodes(archived[0]).find((node) => node.type === "native-blobatar")!.props.thinking,
            false,
        );
        assert.equal(
            nodes(list.render()).filter(
                (node) => node.props["data-work-item-id"] === "closed-moved",
            ).length,
            1,
            "archived cross-project work remains normal in its actual flat section",
        );
        const search = nodes(list.render()).find(
            (node) =>
                node.type === "input" && node.props["aria-label"] === "Search sessions, projects",
        )!;

        for (const query of ["completed worker", "build"]) {
            search.props.onInput({ currentTarget: { value: query } });
            const matches = nodes(list.render());

            assert.deepEqual(
                matches
                    .filter((node) => classHas(node, "project-chat"))
                    .map((node) => node.props["data-chat-id"]),
                [15],
            );
            assert.equal(
                matches.filter((node) => node.props["data-work-item-id"] === "closed-owned").length,
                1,
            );
            assert.equal(
                matches.some((node) => node.props["data-work-item-id"] === "closed-moved"),
                false,
            );
        }

        search.props.onInput({ currentTarget: { value: "" } });
        nodes(archived[0])
            .find((node) => classHas(node, "project-chat-open"))!
            .props.onClick(click);
        assert.deepEqual(fixture.navigations, [{ id: 15, options: undefined }]);
        assert.equal(fixture.state.namedAgents[0].chats[0].archived, true);
        assert.deepEqual(fixture.sheets, []);
        fixture.state.me = { id: "guest", role: "guest" };
        assert.equal(
            nodes(list.render()).some((node) => classHas(node, "project-chat")),
            false,
            "Archived never reveals cached owner Chats to a collaborator",
        );
    } finally {
        list.dispose();
    }
});

test("nested Work Item buttons open their orchestrators while execution links remain exact", () => {
    setup();
    fixture.state.namedAgents[0].chats = [
        {
            id: 10,
            title: "First Chat",
            projectId: "build",
            busy: false,
            managing: true,
            waiting: true,
        },
        { id: 11, title: "Second Chat", projectId: "build", busy: false, managing: false },
        { id: 12, title: "Moved work's Chat", projectId: "other", busy: false, managing: false },
    ];
    fixture.state.projects.push({ id: "other", name: "Other" });
    fixture.state.sessions = [
        {
            id: 1,
            title: "Worker one",
            threadType: "worker",
            activeThreadId: 2,
            workItemId: "one",
            projectId: "build",
            updatedAt: 1,
            groupingParentChatId: 10,
            supervisor: { conversationId: 99, parentChatId: 10 },
        },
        {
            id: 2,
            title: "Reviewer one",
            threadType: "reviewer",
            activeThreadId: 2,
            workItemId: "one",
            projectId: "build",
            updatedAt: 2,
            groupingParentChatId: 10,
            supervisor: { conversationId: 99, parentChatId: 10 },
            busy: true,
        },
        {
            id: 3,
            title: "Worker two",
            threadType: "worker",
            activeThreadId: 4,
            workItemId: "two",
            projectId: "build",
            updatedAt: 3,
            linkedFrom: { id: 1 },
            groupingParentChatId: 11,
            supervisor: { conversationId: 98, parentChatId: 11 },
        },
        {
            id: 4,
            title: "Reviewer two",
            threadType: "reviewer",
            activeThreadId: 4,
            workItemId: "two",
            projectId: "build",
            updatedAt: 4,
            groupingParentChatId: 11,
            supervisor: { conversationId: 98, parentChatId: 11 },
        },
        {
            id: 5,
            title: "Explicitly moved work",
            workItemId: "moved",
            activeThreadId: 5,
            projectId: "build",
            updatedAt: 5,
            groupingParentChatId: 12,
            supervisor: { conversationId: 97, parentChatId: 12 },
        },
    ];
    fixture.state.namedAgents[0].busy = true;
    fixture.state.namedAgents[0].managing = true;
    const list = mount();

    try {
        const tree = list.render();
        const build = nodes(tree).find((node) => node.props["data-project-id"] === "build")!;
        const chats = nodes(build).filter((node) => classHas(node, "project-chat"));

        assert.deepEqual(
            chats.map((chat) => [
                chat.props["data-chat-id"],
                nodes(chat)
                    .filter((node) => node.props["data-work-item-id"])
                    .map((node) => node.props["data-work-item-id"]),
            ]),
            [
                [10, ["one"]],
                [11, ["two"]],
            ],
            "a linked origin cannot pull work into a sibling named Chat",
        );
        assert.ok(chats[0]);
        assert.ok(chats[1]);
        const other = nodes(tree).find((node) => node.props["data-project-id"] === "other")!;
        const movedChat = nodes(other).find((node) => classHas(node, "project-chat"))!;
        const movedWork = nodes(build).find((node) => node.props["data-work-item-id"] === "moved")!;

        assert.equal(movedChat.props["data-chat-id"], 12);
        assert.equal(
            nodes(movedChat).some((node) => node.props["data-work-item-id"]),
            false,
        );
        assert.equal(
            nodes(movedChat).some((node) => classHas(node, "project-chat-disclosure")),
            false,
        );
        assert.equal(
            nodes(movedWork).some((node) => classHas(node, "work-item-head")),
            true,
        );
        assert.deepEqual(
            nodes(tree)
                .filter((node) => classHas(node, "project-chat"))
                .map((node) => node.props["data-chat-id"]),
            [10, 11, 12],
            "cross-project work stays in its actual project without duplicating its Chat",
        );
        assert.equal(nodes(tree).filter((node) => node.props["data-work-item-id"]).length, 3);
        assert.equal(
            nodes(tree).some(
                (node) =>
                    node.type === "button" &&
                    nodes(node.props.children).some((child) => child.type === "button"),
            ),
            false,
            "Open and disclosure remain independent native controls, never nested buttons",
        );

        for (const [index, chat] of chats.entries()) {
            const disclosure = nodes(chat).find((node) =>
                classHas(node, "project-chat-disclosure"),
            )!;
            const open = nodes(chat).find((node) => classHas(node, "project-chat-open"))!;
            const leading = nodes(disclosure.props.children);

            assert.equal(disclosure.type, "button");
            assert.equal(disclosure.props.type, "button");
            assert.equal(open.type, "button");
            assert.equal(open.props.type, "button");
            assert.equal(disclosure.props["aria-expanded"], true);
            assert.deepEqual(
                leading.map((node) => node.type),
                ["native-blobatar", "native-icon"],
            );
            assert.ok(leading[0]);
            assert.ok(leading[1]);
            assert.equal(leading[0].props.size, 20);
            assert.equal(leading[0].props.animated, index === 0);
            assert.equal(
                leading[0].props.thinking,
                index === 0,
                "waiting manager remains thinking; its idle sibling does not",
            );
            assert.equal(leading[1].props.name, "down");
            assert.equal(
                nodes(open).some((node) => node.type === "native-blobatar"),
                false,
            );
            assert.equal(open.props["aria-description"], index === 0 ? "Managing work" : undefined);
            const head = nodes(chat).find((node) => classHas(node, "project-chat-head"))!;

            assert.equal(
                nodes(head).some((node) => node.type === "native-spinner"),
                false,
            );
        }

        const first = nodes(chats[0]).find((node) => classHas(node, "work-item-head"))!;
        const firstButton = nodes(first).find((node) => classHas(node, "session"))!;

        firstButton.props.onClick(click);
        assert.equal(fixture.navigations.at(-1)?.id, 99);
        const members = nodes(chats[0]).filter((node) => classHas(node, "work-item-member"));

        for (const member of members) {
            nodes(member)
                .find((node) => classHas(node, "session"))!
                .props.onClick(click);
        }

        assert.deepEqual(
            fixture.navigations.map((entry) => entry.id),
            [99, 1, 2],
        );
        nodes(chats[1])
            .find((node) => classHas(node, "project-chat-open"))!
            .props.onClick(click);
        assert.equal(fixture.navigations.at(-1)?.id, 11);
        nodes(chats[0])
            .find((node) => node.props["aria-label"] === "Collapse work for First Chat")!
            .props.onClick(click);
        const folded = nodes(list.render()).filter((node) => classHas(node, "project-chat"));

        assert.ok(folded[0]);
        assert.deepEqual(
            fixture.navigations.map((entry) => entry.id),
            [99, 1, 2, 11],
            "folding does not open the Chat",
        );
        assert.equal(folded[0].props.class.includes("closed"), true);
        assert.equal(
            nodes(folded[0]).find((node) => classHas(node, "project-chat-disclosure"))!.props[
                "aria-expanded"
            ],
            false,
        );
        nodes(folded[0])
            .find((node) => classHas(node, "project-chat-open"))!
            .props.onClick(click);
        assert.equal(fixture.navigations.at(-1)?.id, 10, "Open still opens the exact folded Chat");
        assert.equal(
            nodes(folded[0]).find((node) => classHas(node, "group-body"))!.props.inert,
            true,
        );
        assert.equal(
            nodes(folded[1]).find((node) => classHas(node, "group-body"))!.props.inert,
            false,
        );
        fixture.state.namedAgents[0].chats[0].managing = false;
        fixture.state.sessions = fixture.state.sessions.map((row: Props) => ({
            ...row,
            supervisor: { conversationId: row.supervisor.conversationId, status: "reclaimed" },
        }));
        const settledChat = nodes(list.render()).find((node) => node.props["data-chat-id"] === 10)!;

        assert.ok(
            nodes(settledChat).some((node) => classHas(node, "project-chat-disclosure")),
            "Stop/finish does not remove the owned-child disclosure",
        );
        const settledFace = nodes(settledChat).find((node) => node.type === "native-blobatar")!;

        assert.equal(
            settledFace.props.thinking,
            false,
            "busy children alone cannot invent exact-Chat activity",
        );
        assert.equal(settledFace.props.animated, false);
    } finally {
        list.dispose();
    }
});

// The manual VNode consumer above cannot prove Preact keeps each Avatar in its own keyed row.
// Exercise real hooks, DOM insertion/removal and reconciliation across parent/leaf transitions.
test("real Preact keeps the project face inline and exactly one Avatar inside each Chat's own control", async () => {
    setup();
    fixture.state.namedAgents[0].chats = [
        { id: 10, title: "Managed exact", projectId: "build", managing: true },
        { id: 11, title: "Leaf", projectId: "build" },
        { id: 12, title: "Sibling", projectId: "build" },
    ];
    const children = [
        {
            id: 2,
            title: "Owned work",
            projectId: "build",
            groupingParentChatId: 10,
            workItemId: "owned",
            activeThreadId: 2,
            updatedAt: 1,
            supervisor: { conversationId: 99, parentChatId: 10 },
        },
    ];

    fixture.state.sessions = children;
    const root = new Element("root");
    const all = (node: Element): Element[] => [node, ...node.childNodes.flatMap(all)];
    const has = (node: Element, name: string) =>
        String(node.attributes.class).split(" ").includes(name);
    const closest = (node: Element, name: string): Element | null =>
        has(node, name) ? node : node.parentNode ? closest(node.parentNode, name) : null;
    const update = () =>
        act(() => render(h(NativeSessionList, {}), root as unknown as HTMLElement));

    const assertOwnership = (parent: boolean) => {
        const header = all(root).find((node) => has(node, "project-group-head"))!;
        const headerFace = all(header).filter((node) => node.localName === "native-blobatar");
        const chats = all(root).filter((node) => has(node, "project-chat"));

        assert.equal(
            headerFace.length,
            1,
            "the project heading retains its single inline identity",
        );
        assert.ok(headerFace[0]);
        assert.ok(closest(headerFace[0], "project-open"));
        assert.equal(
            all(header).some((node) => has(node, "project-chat-disclosure")),
            false,
        );
        assert.equal(chats.length, 3);

        for (const chat of chats) {
            const id = Number(chat.attributes["data-chat-id"]);
            const faces = all(chat).filter((node) => node.localName === "native-blobatar");
            const disclosure = all(chat).find((node) => has(node, "project-chat-disclosure"));

            assert.equal(
                faces.length,
                1,
                `Chat ${id} has exactly one face after real reconciliation`,
            );
            assert.ok(faces[0]);
            assert.equal(closest(faces[0], "project-chat"), chat);

            if (id === 10 && parent) {
                assert.ok(disclosure);
                assert.equal(
                    has(disclosure, "work-item-disclosure"),
                    false,
                    "the Chat stack never inherits the global absolute Work Item disclosure class",
                );
                assert.equal(faces[0].parentNode, disclosure);
                assert.deepEqual(
                    disclosure.childNodes.map((node) => node.localName),
                    ["native-blobatar", "native-icon"],
                );
                assert.equal(
                    all(chat).filter((node) => node.attributes["data-work-item-id"] === "owned")
                        .length,
                    1,
                );
            } else {
                assert.equal(disclosure, undefined, "leaf rows have no disclosure or placeholder");
                assert.ok(closest(faces[0], "project-chat-open"));
                assert.equal(
                    all(chat).some((node) => has(node, "project-chat-items")),
                    false,
                );
            }
        }

        assert.equal(all(root).filter((node) => node.localName === "native-blobatar").length, 4);
        assert.equal(
            all(root).some(
                (node) =>
                    node.localName === "button" &&
                    all(node)
                        .slice(1)
                        .some((child) => child.localName === "button"),
            ),
            false,
        );
    };

    try {
        await update();
        assertOwnership(true);
        fixture.state.namedAgents[0].chats.reverse();
        fixture.state.namedAgents[0].chats.find((chat: Props) => chat.id === 10).managing = false;
        // Stop clears live authority, not passive ownership or its child disclosure.
        fixture.state.sessions = children.map((row) => ({
            ...row,
            supervisor: { conversationId: 99, status: "reclaimed" },
        }));
        await update();
        assertOwnership(true);
        fixture.state.sessions = [];
        await update();
        assertOwnership(false);
        fixture.state.sessions = children;
        await update();
        assertOwnership(true);
    } finally {
        await act(() => render(null, root as unknown as HTMLElement));
    }
});

// .button is the native theme surface, not just the icon/divider treatment. App mounts this
// same consumer in both the roomy sidebar and phone landing list; neither may fork library entry.
test("PiPs is a native secondary button beside primary New Session in sidebar and landing list", () => {
    for (const home of [false, true]) {
        for (const role of ["owner", "guest", "viewer"]) {
            setup(role);
            const list = mount({ home });

            try {
                const all = nodes(list.render());
                const entry = all.find((node) => classHas(node, "session-entry"))!;
                const people = nodes(entry).find(
                    (node) => node.props["aria-label"] === "Named agents (PiPs)",
                );
                const create = nodes(entry).find(
                    (node) => node.props["aria-label"] === "New session",
                );

                assert.equal(
                    all.some((node) => node.type === "obsolete-pips-row"),
                    false,
                );
                assert.equal(Boolean(people), role === "owner");
                assert.equal(
                    all.some((node) => node.type === "native-blobatar"),
                    role === "owner",
                    "private default-agent metadata is never drawn for a collaborator or viewer",
                );
                assert.equal(Boolean(create), role !== "viewer");

                if (create) {
                    assert.equal(create.type, "button");
                    assert.ok(classHas(create, "button"));
                    assert.ok(classHas(create, "primary"), "New Session keeps primary emphasis");
                    create.props.onClick(click);
                    assert.deepEqual(fixture.sheets, [{ type: "new-session" }]);
                    fixture.sheets = [];
                }

                if (people) {
                    assert.ok(
                        classHas(people, "button"),
                        "PiPs inherits the native button surface",
                    );
                    assert.equal(people.type, "button");
                    assert.equal(people.props.type, "button");
                    assert.equal(classHas(people, "primary"), false);
                    assert.equal(people.props.title, "PiPs · Named agents");
                    people.props.onClick(click);
                    assert.deepEqual(fixture.sheets, [{ type: "named-agents" }]);
                    assert.ok(
                        nodes(people).some(
                            (node) => node.type === "native-icon" && node.props.name === "users",
                        ),
                    );

                    fixture.state.server.privateAgents = 3;
                    assert.equal(
                        nodes(list.render()).some(
                            (node) => node.props["aria-label"] === "Named agents (PiPs)",
                        ),
                        false,
                        "servers without named-agent identity support do not advertise the library",
                    );
                }
            } finally {
                list.dispose();
            }
        }
    }
});
