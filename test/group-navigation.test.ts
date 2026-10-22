// Authoring gate: execute the real group navigation consumers, not a second routing model.
// A consumer using mutation IDs as destinations, or failing to recognize the private controller,
// must fail here. Existing orchestration tests cover server privacy and grouping fields only;
// browser tests need sockets. Hooks, unrelated UI, history and event delivery are inert stand-ins.
// No production export or test-only routing seam is added.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, test } from "node:test";
import { h } from "preact";

const htm = (await import(import.meta.resolve("htm"))).default;
const { workItemRows } = await import(new URL("../web/work-items.js", import.meta.url).href);

type Props = Record<string, any>;
type Node = { type: string | ((props: Props) => unknown); props: Props; key?: string };
type Slot = { value?: any; current?: any; deps?: unknown[]; cleanup?: () => void };
type Fiber = { slots: Slot[]; cursor: number };
let current: Fiber;
let effects: (() => void)[] = [];
const events = new EventTarget();
const dom = () => ({
    checkVisibility: () => true,
    getClientRects: () => [{}],
    querySelector: () => null,
    closest: () => null,
    focus() {},
});
const hooks = {
    useState(initial: unknown) {
        const slot = (current.slots[current.cursor++] ??= {
            value: typeof initial === "function" ? initial() : initial,
        });

        return [
            slot.value,
            (next: unknown) => {
                slot.value = typeof next === "function" ? next(slot.value) : next;
            },
        ];
    },
    useRef(value: unknown) {
        return (current.slots[current.cursor++] ??= { current: value });
    },
    useMemo(make: () => unknown) {
        return make();
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
};
const fixture = {
    hooks,
    html: htm.bind(h),
    store: {
        state: {} as Props,
        set(patch: Props | ((state: Props) => Props)) {
            Object.assign(this.state, typeof patch === "function" ? patch(this.state) : patch);
        },
        subscribe: () => () => {},
    },
    navigated: [] as number[],
    opening: [] as number[],
    mutations: [] as Props[],
    opened: [] as Props[],
    // Order is supplied by the existing grouping projection; routing/selection is never mocked.
    workspaceOrder: () =>
        workItemRows(fixture.store.state.sessions).filter((row: Props) => !row.archived),
};

const noop = () => {};

const descriptors = new Map<string, PropertyDescriptor | undefined>();

for (const [name, value] of Object.entries({
    groupNavigationFixture: fixture,
    document: Object.assign(new EventTarget(), {
        documentElement: { dataset: {} },
        getElementById: () => dom(),
        querySelector: () => null,
    }),
    location: { search: "", pathname: "/" },
    localStorage: { getItem: () => null, setItem: noop },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    matchMedia: () => ({ matches: false }),
    HTMLElement: class {},
    ResizeObserver: class {
        observe() {}
        disconnect() {}
    },
})) {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
}

after(() => {
    for (const [name, descriptor] of descriptors) {
        if (descriptor) {
            Object.defineProperty(globalThis, name, descriptor);
        } else {
            Reflect.deleteProperty(globalThis, name);
        }
    }
});

const sources: Record<string, string> = {
    preact: "export const render=()=>{};",
    "preact/hooks": `export const {useState,useRef,useEffect,useMemo}=globalThis.groupNavigationFixture.hooks;
        export const useLayoutEffect=()=>{};`,
    "store.js": `const f=globalThis.groupNavigationFixture;
        export const {store,workspaceOrder}=f;
        export const navigate=id=>f.navigated.push(id);
        export const actions={openWorkPip:async id=>f.mutations.push({id,action:"openPiP"}),controlWorkPip:async(id,action)=>f.mutations.push({id,action}),abort:async()=>f.mutations.push({id:store.state.conversationId,action:"abort"}),updateWorkItem:async(id,patch)=>f.mutations.push({id,...patch}),updateSession:async()=>{}};
        export const drafts={get:()=>"",set:()=>{}},typing=()=>{};
        export const attempt=fn=>fn(),notify=()=>{},openSheet=sheet=>f.opened.push(sheet),dismiss=()=>{},holdNotice=()=>{},uid=()=>"row-opening";
        export const canSteer=()=>true,collab=()=>false,scoped=()=>false,handoffsAvailable=()=>true,projectsAvailable=()=>false;
        export const isUnread=()=>false,sessionUnread=()=>false,setUnread=()=>{},stillMoving=moving=>moving;
        export const signOut=()=>{},start=()=>{},filesShown=()=>false,panelsBeside=()=>false,peopleDocked=()=>false;`,
    "ui.js": `export const html=globalThis.groupNavigationFixture.html;
        export const apartFromViews=component=>component;
        export const APPLE=false,BOTTOM_SHEETS={matches:false},Boot=()=>null,Icon=()=>null,Keys=()=>null,Marked=()=>null,Slide=()=>null,Spinner=()=>null;
        export const shortPath=value=>value,timeAgo=()=>"now",railState=()=>"",scrimPress=()=>()=>{},copyText=()=>{};
        export const contextLevel=()=>"",formatBytes=String,formatTokens=String,modelLabel=()=>"Model";
        export const useSlide=()=>null,useSide=()=>"left",usePresence=()=>[],useEdge=()=>null,iconPath=()=>"";`,
    "theme.js": `export const prefs=()=>({group:"recent"}),isPinned=()=>false,setPrefs=()=>{},togglePin=()=>{},lookLabel=()=>"Pocket",startTheme=()=>{};
        export const BASE_LOOK="pocket",chooseLook=()=>{},chooseTheme=()=>{},folderPaletteIds=()=>[],lookIds=()=>[],paletteOf=()=>({colors:{}}),preview=()=>{},themeIds=()=>[],themeVars=()=>({}),varsStyle=()=>"";`,
    "avatar.js": "export const Avatar=()=>null,folderColor=()=>'',initials=()=>'';",
    "back.js":
        "export const goHome=run=>run(),useBack=()=>{},canGoBack=()=>false,goBack=()=>{},replaceAddress=()=>{},startHistory=()=>{};",
    "gestures.js": "export const useDragToClose=()=>{},startEdgeBack=()=>{},startSwipes=()=>{};",
    "extension-ui.js":
        "export const ExtensionRailButtons=()=>null,ExtensionPage=()=>null,ExtensionSessionControls=()=>null,extensionLauncherItems=()=>[],extensionInputSuggestions=async()=>[];",
    "peeks.js":
        "export const PeeksRailButton=()=>null,PeekHost=()=>null,PeeksButton=()=>null,PeekStrip=()=>null,PEEK_WIDE={},peekTiles=()=>[],peeksWanted=()=>false,togglePeeks=()=>{};",
    "pip.js":
        "export const PipRailButton=()=>null,PipHost=()=>null,openPip=()=>{},closePip=()=>{},pipAvailable=()=>false,togglePip=()=>{};",
    "private.js": "export const PrivateList=()=>null,PrivateTabs=()=>null,PrivatePane=()=>null;",
    "named-agents.js": "export const NamedAgents=()=>null;",
    "agent-tabs.js": "export const AgentTabs=()=>null;",
    "session-hold.js": "export const useSessionHold=()=>({hold:null,consumeClick:()=>false});",
    "session-moves.js":
        "export const canMoveSessions=()=>false,useSessionDrag=()=>({busy:false,consumeClick:()=>false});",
    "session-seen.js": "export const sessionResultUnread=()=>false;",
    "ssh-status.js": "export const RemoteProjectIcon=()=>null;",
    "sidebar-context.js": "export const openSidebarOptions=()=>{},useSidebarContext=()=>{};",
    "thread-type.js": 'export const ThreadTypeTag=()=>null,threadTypeLabel=()=>"Worker";',
    "browser.js":
        "export const browserAvailable=()=>false,setBrowserOpen=()=>{},toggleBrowser=()=>{};",
    "commands.js":
        "export const planAvailable=()=>false,schedulesAvailable=()=>false,loadTemplates=()=>{},parseCommand=()=>null,parseTemplate=()=>null,suggestCommands=()=>[];",
    "files-panel.js":
        "export const FilesButton=()=>null,FilesPanel=()=>null,filesAvailable=()=>false,setFilesOpen=()=>{},toggleFiles=()=>{};",
    "model-refresh.js": "export const modelRefreshAvailable=()=>false,refreshModels=()=>{};",
    "branch.js": "export const branchAvailable=()=>false,headLabel=()=>'';",
    "folder.js": "export const recentLabels=()=>[];",
    "gallery.js": "export const galleryAvailable=()=>false;",
    "pi-sessions.js": "export const piSessionsAvailable=()=>false;",
    "browser-panel.js": "export const BrowserButton=()=>null,BrowserPanel=()=>null;",
    "chat.js":
        "export const PeopleButton=()=>null,PeoplePanel=()=>null,TypingLine=()=>null,chatUnread=()=>0;",
    "files.js":
        "export const loadFiles=()=>{},mentionAt=()=>null,mentionText=()=>'',suggestFiles=()=>[];",
    "history.js": "export const remember=()=>{},searchHistory=()=>[],sentHistory=()=>[];",
    "dock.js": "export const useDock=()=>{};",
    "trust.js": "export const TrustBar=()=>null;",
    "turns.js": "export const says=()=>'';",
    "message-box.js": "export const MessageBox=props=>props.children,SendButton=()=>null;",
    "composer.js":
        "export const Composer=()=>null,openingByAlt=id=>globalThis.groupNavigationFixture.opening.push(id);",
    "diff.js": "export const useChanges=()=>({changes:null});",
    "notify.js": "export const registerWorker=()=>{},updateBadge=()=>{};",
    "rich.js": "",
    "share.js": "export const takeShare=()=>{};",
    "sheets.js": "export const Sheets=()=>null;",
    "signin.js": "export const SignIn=()=>null;",
    "subagents.js": "export const openSubagents=()=>{},SubagentsBar=()=>null;",
    "subagents-board.js": "export const SubagentsBoard=()=>null;",
    "transcript.js": "export const Transcript=()=>null;",
    "topbar.js": "export const Topbar=()=>null;",
    "workspace-location.js": "export const conversationLocation=()=>null;",
    "terminal-renderer-assets.js": "export const startTerminalRendererPrefetch=()=>{};",
    "voice.js":
        "export const toggleDictation=()=>{},MicButton=()=>null,useDictation=()=>({stop(){}});",
};
const consumers = /\/web\/(app|home|launcher|sessions|composer)\.js$/;
const real = /^(\.\/(home|launcher|sessions|work-items|session-tree|project-groups)\.js)$/;

registerHooks({
    resolve(specifier, context, next) {
        const parent = context.parentURL && new URL(context.parentURL).pathname;
        const source =
            parent && consumers.test(parent) && !real.test(specifier)
                ? (sources[specifier] ?? sources[specifier.split("/").at(-1)!])
                : undefined;

        return source === undefined
            ? next(specifier, context)
            : { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    },
});

const { SessionList, Rail, RailNav } = await import(
    new URL("../web/sessions.js", import.meta.url).href
);
const { Launcher } = await import(new URL("../web/launcher.js", import.meta.url).href);
const { Splash } = await import(new URL("../web/home.js", import.meta.url).href);
const { Composer } = await import(new URL("../web/composer.js", import.meta.url).href);

await import(new URL("../web/app.js", import.meta.url).href);

function mount(component: (props: Props) => any, props: Props = {}, runEffects = true) {
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

        if (value.ref && typeof value.ref === "object") {
            value.ref.current = dom();
        }

        return {
            ...value,
            props: { ...value.props, children: visit(value.props.children, `${path}/children`) },
        };
    };

    return {
        render() {
            const tree = visit(h(component, props), "root");
            const pending = effects;

            effects = [];

            if (runEffects) {
                for (const run of pending) {
                    run();
                }
            }

            return tree;
        },
        dispose() {
            for (const fiber of fibers.values()) {
                for (const slot of fiber.slots) {
                    slot.cleanup?.();
                }
            }
        },
    };
}

function nodes(value: any): Node[] {
    if (Array.isArray(value)) {
        return value.flatMap(nodes);
    }

    return value?.props ? [value, ...nodes(value.props.children)] : [];
}

function setup(
    status: "running" | "paused" | "reclaimed" | "new" | "collaborator" = "running",
    conversationId: number | null = 99,
) {
    const supervisor =
        status === "collaborator" || status === "new"
            ? {}
            : { supervisor: { conversationId: 99, status } };

    fixture.store.state = {
        me: {
            id: status === "collaborator" ? "guest" : "owner",
            role: status === "collaborator" ? "guest" : "owner",
        },
        conversationId,
        privateId: null,
        sessions: [
            {
                id: 1,
                title: "Worker",
                workItemId: "work-1",
                workItemTitle: "Build app",
                activeThreadId: 2,
                updatedAt: 3,
                cwd: "/repo",
                ...supervisor,
            },
            {
                id: 2,
                title: "Reviewer",
                workItemId: "work-1",
                workItemTitle: "Build app",
                activeThreadId: 2,
                updatedAt: 4,
                cwd: "/repo",
                ...supervisor,
            },
            { id: 3, title: "Other chat", updatedAt: 1, cwd: "/other" },
        ],
        pinned: [],
        projects: [],
        sessionsLoaded: true,
        moving: {},
        server: { workItems: 1 },
        models: [],
        folderFavorites: [],
        view: {},
        launcher: false,
    };
    fixture.navigated = [];
    fixture.opening = [];
    fixture.mutations = [];
    fixture.opened = [];
}

function key(key: string, code: string, altKey = false) {
    const event = new Event("keydown", { cancelable: true });

    Object.assign(event, { key, code, altKey, ctrlKey: false, metaKey: false, shiftKey: false });
    events.dispatchEvent(event);

    return event;
}

const click = { preventDefault() {}, stopPropagation() {}, detail: 1 };
const classHas = (node: Node, name: string) => String(node.props.class).split(" ").includes(name);

for (const status of ["running", "paused", "reclaimed", "collaborator"] as const) {
    const destination = status === "collaborator" ? 2 : 99;

    test(`launcher and home open the ${status} group's destination, not its mutation ID`, () => {
        setup(status);
        const launcher = mount(Launcher);
        const home = mount(Splash);

        try {
            const option = nodes(launcher.render()).find(
                (node) => node.props.id === "launcher-option-session%3A2",
            )!;

            assert.ok(option, "group retains its execution-based key");
            option.props.onClick(click);
            assert.equal(fixture.navigated.pop(), destination, "launcher activation");

            const recent = nodes(home.render()).find(
                (node) => node.props["data-part"] === "home-recent-row",
            )!;

            recent.props.onClick(click);
            assert.equal(fixture.navigated.pop(), destination, "home activation");
            key("1", "Digit1");
            assert.equal(fixture.navigated.pop(), destination, "visible home digit");
        } finally {
            launcher.dispose();
            home.dispose();
        }
    });

    test(`Alt navigation uses the ${status} group destination and steps from its controller or members`, () => {
        setup(status, destination);
        key("1", "Digit1", true);
        assert.deepEqual(fixture.navigated, [destination]);
        assert.deepEqual(
            fixture.opening,
            [destination],
            "composer focus tracks the actual destination",
        );

        for (const id of new Set([destination, 1, 2, ...(status === "collaborator" ? [] : [99])])) {
            fixture.store.state.conversationId = id;
            key("ArrowDown", "ArrowDown", true);
            assert.equal(fixture.navigated.pop(), 3, `next from ${id}`);
            key("ArrowUp", "ArrowUp", true);
            assert.equal(fixture.navigated.pop(), 3, `previous wraps from ${id}`);
        }

        fixture.store.state.conversationId = 3;
        key("ArrowDown", "ArrowDown", true);
        assert.equal(fixture.navigated.pop(), destination, "step into group");
    });
}

test("launcher marks the controller or any visible member as Current even after reclaim", () => {
    for (const status of ["running", "paused", "reclaimed"] as const) {
        for (const id of [99, 1, 2]) {
            setup(status, id);
            const launcher = mount(Launcher);

            try {
                const option = nodes(launcher.render()).find(
                    (node) => node.props.id === "launcher-option-session%3A2",
                )!;

                assert.match(
                    option.props["aria-label"],
                    /Current/,
                    `current ${status} group from ${id}`,
                );
            } finally {
                launcher.dispose();
            }
        }
    }
});

test("both folded rails open and select the private controller without changing their row keys", () => {
    for (const component of [Rail, RailNav]) {
        setup();
        const rail = mount(component, { foldable: true, folded: true });

        try {
            const buttons = nodes(rail.render()).filter((node) => classHas(node, "ws"));

            assert.equal(buttons.length, 2);
            assert.equal(buttons[0]!.key, 2);
            buttons[0]!.props.onClick(click);
            assert.equal(fixture.navigated.pop(), 99, `${component.name} activation`);
            assert.ok(classHas(buttons[0]!, "active"), `${component.name} active group`);

            if (component === RailNav) {
                assert.equal(buttons[0]!.props["aria-current"], "page");
            }
        } finally {
            rail.dispose();
        }
    }
});

test("expanded group opens/selects the controller, children stay exact, and archive keeps the execution mutation ID", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    setup();
    const list = mount(SessionList);

    try {
        const rows = nodes(list.render()).filter(
            (node) => node.props["data-part"] === "session-row",
        );
        const head = rows.find((node) => classHas(node, "work-item-head"))!;
        const button = nodes(head).find((node) => node.props["data-part"] === "session-button")!;

        button.props.onClick(click);
        assert.equal(fixture.navigated.pop(), 99);
        assert.equal(button.props["aria-current"], "page");

        for (const id of [1, 2]) {
            const child = rows.find(
                (node) => classHas(node, "work-item-member") && node.props["data-id"] === id,
            )!;
            const open = nodes(child).find((node) => node.props["data-part"] === "session-button")!;

            assert.notEqual(
                open.props["aria-current"],
                "page",
                "controller selection belongs to the group, not each execution child",
            );
            open.props.onClick(click);
            assert.equal(fixture.navigated.pop(), id, "explicit execution child remains exact");
        }

        const archive = nodes(head).find(
            (node) => node.props["aria-label"] === "Archive Work Item",
        )!;

        await archive.props.onClick(click);
        assert.deepEqual(fixture.mutations, [{ id: 2, archived: true }]);
    } finally {
        list.dispose();
    }
});

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

// The whole-item quick action replaces mark-read, opens the one PiP Thread without
// granting authority, and never leaks onto exact execution children.
for (const status of ["running", "paused", "reclaimed", "new"] as const) {
    test(`home Work Item row ${status} opens the same PiP Thread without changing authority`, async () => {
        setup(status, null);
        const list = mount(SessionList, { home: true });

        try {
            const rows = nodes(list.render()).filter(
                (node) => node.props["data-part"] === "session-row",
            );
            const head = rows.find((node) => classHas(node, "work-item-head"))!;
            const state = status === "running" ? "PiP active" : "Human control";
            const label = "Open PiP Thread for Build app";
            const action = nodes(head).find((node) => classHas(node, "session-orchestrate"));

            assert.ok(action, label);
            await action.props.onClick(click);
            assert.deepEqual(fixture.mutations, [{ id: 2, action: "openPiP" }]);
            assert.equal(action.props["aria-label"], label);

            assert.equal(
                action.props["aria-pressed"],
                undefined,
                "opening a thread is not an authority toggle",
            );
            assert.equal(
                nodes(head).filter((node) => classHas(node, "session-orchestrate")).length,
                1,
            );
            assert.equal(
                nodes(head).some((node) => classHas(node, "session-unread")),
                false,
                "PiP replaces grouped mark-read",
            );
            assert.ok(nodes(head).some((node) => node.props["aria-label"] === "Pin"));
            assert.ok(nodes(head).some((node) => node.props["aria-label"] === "Archive Work Item"));
            assert.doesNotMatch(textOf(head), /PiP running|PiP paused|PiP active|Human control/);
            assert.ok(
                nodes(head).some(
                    (node) => node.props.role === "img" && node.props["aria-label"] === state,
                ),
                "icon-only status exposes the actual active/human state",
            );

            assert.equal(
                rows
                    .filter((node) => classHas(node, "work-item-member"))
                    .flatMap(nodes)
                    .filter((node) => classHas(node, "session-orchestrate")).length,
                0,
                "children never duplicate a whole-item control",
            );
            assert.deepEqual(fixture.opened, [], "the row never opens an orchestration popup");
            assert.deepEqual(
                fixture.navigated,
                [],
                "opening is delegated to the native store action",
            );
            assert.equal(
                nodes(list.render()).some((node) => classHas(node, "session-unread")),
                true,
                "ordinary and child row mark-read actions remain",
            );
        } finally {
            list.dispose();
        }
    });
}

// Render the real Composer and dispatch the app's real Escape handler. Effects for sizing,
// dictation and suggestions are irrelevant here; native abort semantics are owned server-side.
test("one normal Stop and double Escape stop active PiP even while it is idle", async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 3000 });

    for (const [status, busy, expected] of [
        ["running", false, 1],
        ["running", true, 1],
        ["reclaimed", false, 0],
        ["paused", false, 0],
        [undefined, false, 0],
        [undefined, true, 1],
    ] as const) {
        setup();
        fixture.store.state.presence = [];
        fixture.store.state.view = {
            conversation: {
                kind: "session",
                ...(status ? { workSupervisor: { status } } : {}),
            },
            live: { busy },
            entries: new Map(),
            order: [],
            inbox: [],
            stats: {},
        };
        const composer = mount(Composer, {}, false);

        try {
            const stop = nodes(composer.render()).filter(
                (node) => node.type === "button" && node.props["aria-label"] === "Stop",
            );

            t.mock.timers.tick(3000);
            key("Escape", "Escape");
            assert.equal(fixture.mutations.length, 0, "one Escape never stops work");
            key("Escape", "Escape");
            assert.equal(
                fixture.mutations.length,
                expected,
                "keyboard uses the same normal Stop route",
            );
            fixture.mutations = [];
            assert.equal(stop.length, expected, `${status ?? "ordinary"}, busy=${busy}`);

            if (expected) {
                await stop[0]!.props.onClick();
                assert.deepEqual(fixture.mutations, [{ id: 99, action: "abort" }]);
            }
        } finally {
            composer.dispose();
        }
    }
});

test("collaborator rows expose no orchestration label or owner control", () => {
    setup("collaborator", null);
    const list = mount(SessionList, { home: true });

    try {
        const tree = list.render();

        assert.equal(
            nodes(tree).some((node) => classHas(node, "session-orchestrate")),
            false,
        );
        assert.doesNotMatch(textOf(tree), /PiP running|PiP paused|Let PiP take over|Manage PiP/);
    } finally {
        list.dispose();
    }
});

test("collaborator rows never gain a private destination or private-current state", () => {
    setup("collaborator", 99);

    for (const [component, props] of [
        [SessionList, {}],
        [Rail, {}],
        [RailNav, { foldable: true, folded: true }],
    ] as const) {
        const mounted = mount(component, props);

        try {
            const rows = nodes(mounted.render());
            const button = rows.find((node) =>
                component === SessionList
                    ? node.props["data-part"] === "session-button"
                    : classHas(node, "ws"),
            )!;

            assert.notEqual(button.props["aria-current"], "page");
            assert.ok(!classHas(button, "active"));
            button.props.onClick(click);
            assert.equal(fixture.navigated.pop(), 2);
        } finally {
            mounted.dispose();
        }
    }
});
