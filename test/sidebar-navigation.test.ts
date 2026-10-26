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

const noop = (): void => {};

const storage = new Map<string, string>();
const fixture = {
    state: {} as Props,
    navigations: [] as Props[],
    sheets: [] as Props[],
    drags: [] as Props[],
    touchDrags: [] as Props[],
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
    eventListeners = new Map<string, Set<(this: Element, event: Props) => void>>();
    nodeType = 1;
    data = "";
    value = "";
    scrollTop = 0;
    namespaceURI = "http://www.w3.org/1999/xhtml";
    style = { setProperty() {} };
    localName: string;

    constructor(name: string) {
        this.localName = name;
    }
    get ownerDocument() {
        return document;
    }
    get isConnected(): boolean {
        return this === document.body || Boolean(this.parentNode?.isConnected);
    }
    contains(node: Element | null): boolean {
        return (
            node !== null &&
            (node === this || this.childNodes.some((child) => child.contains(node)))
        );
    }
    matches(selector: string) {
        return selector.split(",").some((part) => {
            const value = part.trim();

            if (value.startsWith(".")) {
                return String(this.attributes.class).split(" ").includes(value.slice(1));
            }

            if (value.startsWith("[")) {
                return Object.hasOwn(this.attributes, value.slice(1, -1));
            }

            return value === this.localName;
        });
    }
    closest(selector: string): Element | null {
        return this.matches(selector) ? this : (this.parentNode?.closest(selector) ?? null);
    }
    getBoundingClientRect() {
        return { left: 0, right: 320, top: 0, bottom: 44, width: 320, height: 44 };
    }
    focus() {
        document.activeElement = this;
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
        options: boolean | { capture?: boolean; passive?: boolean } = false,
    ) {
        const key = `${type}${typeof options === "boolean" ? options : !!options.capture}`;
        const handlers = this.eventListeners.get(key) ?? new Set();

        handlers.add(handler);
        this.eventListeners.set(key, handlers);
        this.listeners.set(key, handler);
    }
    removeEventListener(
        type: string,
        handler: (this: Element, event: Props) => void,
        options: boolean | { capture?: boolean } = false,
    ) {
        const key = `${type}${typeof options === "boolean" ? options : !!options.capture}`;

        this.eventListeners.get(key)?.delete(handler);

        if (this.listeners.get(key) === handler) {
            this.listeners.delete(key);
        }
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
const documentEvents = new Element("document");
const document = {
    addEventListener: documentEvents.addEventListener.bind(documentEvents),
    removeEventListener: documentEvents.removeEventListener.bind(documentEvents),
    body: null as Element | null,
    activeElement: null as Element | null,
    documentElement: { dataset: {} },
    createElementNS: (_namespace: string, name: string) => new Element(name),
    createTextNode(data: string) {
        const text = new Element("text");

        text.nodeType = 3;
        text.data = data;

        return text;
    },
};

document.body = new Element("body");
document.activeElement = document.body;
const descriptors = new Map<string, PropertyDescriptor | undefined>();

for (const [name, value] of Object.entries({
    sidebarNavigationFixture: fixture,
    document,
    localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
    },
    matchMedia: () => ({ matches: false }),
    getSelection: (): null => null,
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
        export const isUnread=id=>f.state.unread.has(id),sessionUnread=()=>false,setUnread=(id,value)=>value?f.state.unread.add(id):f.state.unread.delete(id),stillMoving=m=>m,workspaceOrder=()=>[];`,
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
    "session-moves.js": `const f=globalThis.sidebarNavigationFixture; export const canMoveSessions=()=>f.state.me?.role==='owner'&&!!f.state.server?.projects,useSessionDrag=()=>({busy:false,consumeClick:()=>false,start:(event,id,chosen)=>f.drags.push({id,chosen})});`,
    "session-seen.js": `export const sessionResultUnread=()=>false;`,
    "ssh-status.js": `export const RemoteProjectIcon=()=>null;`,
    "sidebar-context.js": `export const openSidebarOptions=(kind,id,at,options)=>globalThis.sidebarNavigationFixture.sheets.push({kind,id,at,...options}),useSidebarContext=()=>{};`,
    "thread-type.js": `export const ThreadTypeTag=()=>null,threadTypeLabel=()=>'';`,
    "theme.js": `const f=globalThis.sidebarNavigationFixture; export const isPinned=id=>f.state.pinned.includes(id),prefs=()=>({projectGroup:'projects'}),setPrefs=()=>{},togglePin=id=>f.state.pinned=f.state.pinned.includes(id)?f.state.pinned.filter(each=>each!==id):[id,...f.state.pinned];`,
};

registerHooks({
    resolve(specifier, context, next) {
        if (context.parentURL?.endsWith("/web/session-navigation.js")) {
            if (specifier === "./sessions.js") {
                return next(
                    new URL("../web/sessions.js?native-render", import.meta.url).href,
                    context,
                );
            }

            if (specifier === "./ui.js") {
                return {
                    url: `data:text/javascript,${encodeURIComponent(sources["ui.js"]!)}`,
                    shortCircuit: true,
                };
            }
        }

        const owner = context.parentURL?.split("?")[0];
        const sessions = owner?.endsWith("/web/sessions.js");
        const holdIntegration = context.parentURL?.endsWith("?hold-render");

        if (
            holdIntegration &&
            (specifier === "./session-hold.js" || specifier === "./sidebar-context.js")
        ) {
            return next(new URL(`${specifier}?hold-render`, context.parentURL).href, context);
        }

        const nativeHooks =
            (context.parentURL?.endsWith("?native-render") || holdIntegration) &&
            specifier === "preact/hooks";
        const integrationDependency =
            holdIntegration &&
            (owner?.endsWith("/web/session-hold.js") || owner?.endsWith("/web/sidebar-context.js"));
        const source =
            (sessions || integrationDependency) && !nativeHooks
                ? holdIntegration && specifier === "./session-moves.js"
                    ? `const f=globalThis.sidebarNavigationFixture;
                        export const canMoveSessions=()=>f.state.me?.role==='owner'&&!!f.state.server?.projects;
                        export const useSessionDrag=()=>({busy:false,consumeClick:()=>false,
                            startTouch:(point,id,chosen)=>{f.touchDrags.push({phase:'start',id,chosen,point});return true},
                            moveTouch:point=>f.touchDrags.push({phase:'move',point}),
                            endTouch:point=>f.touchDrags.push({phase:'end',point}),
                            cancelTouch:()=>f.touchDrags.push({phase:'cancel'})});`
                    : (sources[specifier] ?? sources[specifier.split("/").at(-1)!])
                : undefined;

        return source === undefined
            ? next(specifier, context)
            : { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    },
});
const { SessionList } = await import(new URL("../web/sessions.js", import.meta.url).href);
const { PhoneSessionList } = await import(
    new URL("../web/session-navigation.js", import.meta.url).href
);
const { SessionList: NativeSessionList } = await import(
    new URL("../web/sessions.js?native-render", import.meta.url).href
);
const { SessionList: HeldSessionList } = await import(
    new URL("../web/sessions.js?hold-render", import.meta.url).href
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
    fixture.drags = [];
    fixture.touchDrags = [];
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
        unread: new Set(),
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

// Row actions must address the hovered Chat/identity, not the selected sibling. The old row
// had no actions; existing exact-navigation coverage could not catch that omission or stale clicks.
test("named Chat quick actions target their source and pinned Chats rise within their project", () => {
    setup();
    fixture.state.conversationId = 11;
    fixture.state.namedAgents[0].chats = [
        { id: 11, title: "Selected sibling", projectId: "build" },
        { id: 10, title: "Hovered Chat", projectId: "build" },
    ];
    const list = mount();
    const row = () =>
        nodes(list.render()).find(
            (node) => classHas(node, "project-chat") && node.props["data-chat-id"] === 10,
        )!;
    const action = (label: string) =>
        nodes(row()).find((node) => node.props["aria-label"] === label)!;
    const event = {
        detail: 1,
        pointerType: "mouse",
        currentTarget: { getBoundingClientRect: () => ({ left: 80, bottom: 120 }) },
    };

    try {
        assert.ok(action("Options for Nora"), "saved named Chats expose quick actions");
        action("Options for Nora").props.onClick(event);
        assert.deepEqual(fixture.sheets, [
            {
                kind: "named-agent",
                id: "nora",
                userId: "owner",
                chatId: 10,
                at: { x: 80, y: 120, touch: false, keyboard: false },
            },
        ]);
        action("Pin").props.onClick(click);
        assert.deepEqual(fixture.state.pinned, [10]);
        assert.deepEqual(
            nodes(list.render())
                .filter((node) => classHas(node, "project-chat"))
                .map((node) => node.props["data-chat-id"]),
            [10, 11],
        );
        action("Mark unread").props.onClick(click);
        assert.deepEqual([...fixture.state.unread], [10]);
        assert.ok(classHas(row(), "marked-unread"));
        action("Mark read").props.onClick(click);
        action("Unpin").props.onClick(click);
        assert.deepEqual([...fixture.state.unread], []);
        assert.deepEqual(fixture.state.pinned, []);
        assert.deepEqual(fixture.navigations, [], "quick actions do not open the Chat");
        nodes(list.render())
            .find((node) => node.props.role === "tab" && node.props.children === "Recent")!
            .props.onClick(click);
        action("Pin").props.onClick(click);
        const pinnedGroup = nodes(list.render()).find(
            (node) =>
                classHas(node, "session-group") &&
                nodes(node).some((child) => child.props.children === "Pinned"),
        );

        assert.ok(pinnedGroup, "a named Chat pin works in Recent as well as within its project");
        assert.ok(nodes(pinnedGroup).some((node) => node.props["data-chat-id"] === 10));
        action("Unpin").props.onClick(click);
        const dragSource = nodes(row()).find((node) => classHas(node, "project-chat-open"))!;

        assert.equal(dragSource.props.draggable, true);
        dragSource.props.onDragStart(click);
        assert.deepEqual(
            fixture.drags,
            [{ id: 10, chosen: [] }],
            "dragging the hovered Chat never moves its selected sibling",
        );

        const stale = [
            action("Options for Nora"),
            action("Pin"),
            action("Mark unread"),
            dragSource,
        ];

        for (const revoke of [
            () => {
                fixture.state.me = { id: "other", role: "owner" };
            },
            () => {
                fixture.state.me.role = "guest";
            },
            () => {
                fixture.state.server.privateAgents = 0;
            },
            () => {
                fixture.state.namedAgents[0].chats[1].archived = true;
            },
            () => {
                fixture.state.namedAgents = [];
            },
        ]) {
            setup();
            fixture.state.namedAgents[0].chats = [{ id: 11 }, { id: 10 }];
            revoke();

            for (const button of stale) {
                button.props.onClick(event);
                button.props.onDragStart?.(event);
            }

            assert.deepEqual(fixture.drags, []);
            assert.deepEqual(fixture.state.pinned, []);
            assert.deepEqual([...fixture.state.unread], []);
            assert.deepEqual(fixture.sheets, []);
        }
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
// must never become generic session IDs for bulk selection or organization operations.
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

// The callback-only test above cannot detect a missing hold binding on the named header.
// Real hooks and contact propagation own recognition/exclusion/click consumption here; the
// existing drag owner tests own destination hit-testing and placement after startTouch succeeds.
// This DOM host supplies geometry, not browser gesture/device acceptance.
test("named Chat real hold requires fresh intent and preserves exact Options and touch drag boundaries", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    setup();
    fixture.state.conversationId = 11;
    fixture.state.namedAgents[0].chats = [
        { id: 10, title: "Held source", projectId: "build" },
        { id: 11, title: "Selected sibling", projectId: "build" },
    ];
    fixture.state.sessions = [
        {
            id: 2,
            title: "Owned work",
            projectId: "build",
            groupingParentChatId: 10,
            workItemId: "owned",
            activeThreadId: 2,
            updatedAt: 1,
        },
    ];
    const root = new Element("root");
    const all = (node: Element): Element[] => [node, ...node.childNodes.flatMap(all)];
    const has = (node: Element, name: string) =>
        String(node.attributes.class).split(" ").includes(name);
    const chat = () => all(root).find((node) => node.attributes["data-chat-id"] === "10")!;
    const control = (name: string) => all(chat()).find((node) => has(node, name))!;
    const overlay = () => all(chat()).find((node) => has(node, "session-hold"));
    const tick = (ms: number) => act(() => t.mock.timers.tick(ms));

    // Dispatch document/ancestor capture before target/bubble listeners, including native
    // listeners installed by the real recognizer and Preact's normal event proxy.
    const dispatch = (target: Element, type: string, values: Props = {}) => {
        const ancestors: Element[] = [];

        for (let node: Element | null = target; node; node = node.parentNode) {
            ancestors.push(node);
        }

        const path = [documentEvents, ...ancestors.reverse()];
        let stopped = false;
        let immediate = false;
        const event: Props = {
            type,
            target,
            currentTarget: target,
            cancelable: true,
            defaultPrevented: false,
            detail: 1,
            preventDefault() {
                this.defaultPrevented = true;
            },
            stopPropagation() {
                stopped = true;
            },
            stopImmediatePropagation() {
                stopped = immediate = true;
            },
            ...values,
        };

        for (const capture of [true, false]) {
            for (const node of capture ? path : [...path].reverse()) {
                event.currentTarget = node;
                const handlers = node.eventListeners.get(`${type}${capture}`);

                for (const handler of [...(handlers ?? [])]) {
                    if (handlers?.has(handler)) {
                        handler.call(node, event);
                    }

                    if (immediate) {
                        break;
                    }
                }

                if (stopped) {
                    return event;
                }
            }
        }

        return event;
    };

    const contact = (target: Element, type: string, x = 100): void => {
        const finger = { clientX: x, clientY: 22, identifier: 7 };
        const released = type === "touchend" || type === "touchcancel";

        dispatch(target, type, {
            touches: released ? [] : [finger],
            changedTouches: [finger],
        });
    };

    const release = async (target: Element, type = "touchend", x = 100) => {
        await act(() => contact(target, type, x));
        let event: Props = {};

        await act(() => {
            event = dispatch(target, "click", { sourceCapabilities: { firesTouchEvents: true } });
        });

        assert.equal(event.defaultPrevented, true, "a held release cannot activate its source");
        assert.deepEqual(fixture.navigations, []);
    };

    const start = async (target: Element, x = 100) => {
        await act(() => contact(target, "touchstart", x));
        await tick(450);
        assert.ok(overlay(), "holding the named Chat header reveals its native chooser");
    };

    const slide = async (target: Element, x: number) => {
        await act(() => contact(target, "touchmove", x));
        await tick(600);
        await tick(140);
    };

    document.body!.appendChild(root);

    try {
        await act(() => render(h(HeldSessionList, {}), root as unknown as HTMLElement));
        const open = control("project-chat-open");
        const title = all(open).find((node) => has(node, "project-chat-name"))!;

        await act(() => contact(title, "touchstart"));
        await tick(449);
        assert.equal(overlay(), undefined, "a short press does not reveal actions");
        await tick(1);
        assert.ok(overlay(), "holding the named Chat header reveals its native chooser");
        await tick(1500);
        assert.deepEqual(fixture.sheets, [], "a stationary hold cannot commit Options");
        assert.deepEqual(fixture.touchDrags, [], "a stationary hold cannot start a drag");
        await release(title);
        assert.equal(overlay(), undefined);

        await start(title);
        await act(() => contact(title, "touchmove", 260));
        await tick(599);
        assert.deepEqual(fixture.sheets, []);
        await tick(1);
        await tick(139);
        assert.deepEqual(fixture.sheets, [], "Options waits for the complete dwell");
        await tick(1);
        assert.deepEqual(fixture.sheets, [
            {
                type: "sidebar-options",
                kind: "named-agent",
                id: "nora",
                userId: "owner",
                chatId: 10,
                at: { x: 260, y: 22, touch: true },
            },
        ]);
        await release(title, "touchend", 260);
        fixture.sheets = [];

        for (const ending of ["touchend", "touchcancel"]) {
            await start(title);
            await act(() => contact(title, "touchmove", 260));
            await tick(100);
            await release(title, ending, 260);
            await tick(1000);
            assert.equal(overlay(), undefined);
            assert.deepEqual(fixture.sheets, [], `${ending} cancels a pending Options choice`);
            assert.deepEqual(fixture.touchDrags, []);
        }

        await act(() => contact(title, "touchstart"));
        await tick(100);
        await act(() => contact(title, "touchend"));
        await tick(1000);
        assert.equal(overlay(), undefined, "early lift never reaches the hold gate");
        await act(() => {
            dispatch(title, "click");
        });
        assert.deepEqual(fixture.navigations, [{ id: 10, options: undefined }]);
        fixture.navigations = [];

        for (const name of ["project-chat-disclosure", "session-pin"]) {
            const button = control(name);
            const icon = button.firstChild!;

            await act(() => contact(icon, "touchstart"));
            await tick(1500);
            assert.equal(overlay(), undefined, `${name}'s descendants must not arm a hold`);
            assert.deepEqual(fixture.sheets, []);
            assert.deepEqual(fixture.touchDrags, []);
            await act(() => contact(icon, "touchend"));
            await act(() => {
                dispatch(icon, "click");
            });
            assert.deepEqual(fixture.navigations, []);
        }

        assert.equal(control("project-chat-disclosure").attributes["aria-expanded"], "false");
        assert.deepEqual(fixture.state.pinned, [10], "the excluded pin still activates normally");

        await start(title, 230);
        await slide(title, 40);
        assert.deepEqual(
            fixture.touchDrags,
            [
                {
                    phase: "start",
                    id: 10,
                    chosen: [],
                    point: { x: 40, y: 22, identifier: 7, source: title },
                },
            ],
            "fresh drag intent hands only the held Chat to the list-level drag owner",
        );
        await act(() => contact(title, "touchmove", 60));
        await release(title, "touchend", 60);
        assert.deepEqual(
            fixture.touchDrags.map(({ phase }) => phase),
            ["start", "move", "end"],
        );
        assert.deepEqual(fixture.sheets, []);
        fixture.touchDrags = [];
        await start(title, 230);
        await slide(title, 40);
        await release(title, "touchcancel", 40);
        assert.deepEqual(
            fixture.touchDrags.map(({ phase }) => phase),
            ["start", "cancel"],
            "a cancelled activated drag reaches its owner instead of dropping",
        );
    } finally {
        await act(() => render(null, root as unknown as HTMLElement));
        root.remove();
        document.activeElement = document.body;
    }

    assert.equal(
        [...documentEvents.eventListeners.values()].reduce(
            (count, handlers) => count + handlers.size,
            0,
        ),
        0,
        "contact and row listeners settle on unmount",
    );
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

// The shell owner must retain the actual Preact list, not reconstruct its query/scroll from mocks.
// Hidden catalogue updates are withheld until return; row ownership/activity remains the real consumer's job.
test("phone navigation retains rows, search, scroll and focus without hidden redraws", async () => {
    setup();
    const root = new Element("root");

    document.body!.appendChild(root);
    const all = (node: Element): Element[] => [node, ...node.childNodes.flatMap(all)];
    const has = (node: Element, name: string) =>
        String(node.attributes.class).split(" ").includes(name);
    const update = (active: boolean, key = "owner") =>
        act(() => render(h(PhoneSessionList, { active, key }), root as unknown as HTMLElement));

    try {
        await update(false);
        assert.equal(
            all(root).some((node) => node.localName === "input"),
            false,
            "a direct Chat open must not mount a CSS-hidden list",
        );
        await update(true);
        const search = all(root).find((node) => node.localName === "input")!;
        const scroller = all(root).find((node) => has(node, "session-items"))!;
        const row = all(root).find((node) => has(node, "session"))!;

        assert.ok(search);
        assert.ok(scroller);
        assert.ok(row);
        await act(() => {
            search.value = "Arbitrary";
            search.listeners.get("inputfalse")!.call(search, { currentTarget: search });
        });
        scroller.scrollTop = 137;
        row.focus();
        await update(false);
        assert.ok("hidden" in root.firstChild!.attributes);
        assert.ok("inert" in root.firstChild!.attributes);
        fixture.state.sessions = [{ ...fixture.state.sessions[0], title: "Arbitrary refreshed" }];
        await update(false);
        assert.equal(
            root.textContent.includes("refreshed"),
            false,
            "hidden catalogue must not redraw",
        );
        document.activeElement = document.body;
        await update(true);
        assert.equal(
            all(root).find((node) => node.localName === "input"),
            search,
        );
        assert.equal(
            all(root).find((node) => has(node, "session")),
            row,
        );
        assert.equal(search.value, "Arbitrary");
        assert.equal(scroller.scrollTop, 137);
        assert.equal(document.activeElement, row, "Back restores the surviving keyboard row");
        assert.ok(root.textContent.includes("refreshed"), "return receives the current catalogue");
        await update(false);
        await update(false, "another-owner");
        assert.equal(search.isConnected, false, "retention cannot cross the account-keyed shell");
    } finally {
        await act(() => render(null, root as unknown as HTMLElement));
        root.remove();
        document.activeElement = document.body;
    }
});
