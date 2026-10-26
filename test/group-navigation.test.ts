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
    useCallback(callback: (...args: any[]) => unknown) {
        return callback;
    },
    useId: () => "unrelated-field-id",
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
    app: null as Node | null,
    roomy: false,
    phoneList: (props: Props) => h("native-phone-list", props),
    hooks,
    html: htm.bind(h),
    icon: (props: Props) => h("native-icon", props),
    spinner: () => h("native-spinner", {}),
    projectView: (props: Props) => h("native-project-view", props),
    topbar: (props: Props) => h("native-topbar", props),
    threadTypeTag: (props: Props) => h("native-thread-type", props),
    projectsAvailable: false,
    store: {
        state: {} as Props,
        set(patch: Props | ((state: Props) => Props)) {
            Object.assign(this.state, typeof patch === "function" ? patch(this.state) : patch);
        },
        subscribe: () => () => {},
    },
    navigated: [] as (number | null)[],
    opening: [] as number[],
    mutations: [] as Props[],
    opened: [] as Props[],
    agentDrafts: [] as Props[],
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
    matchMedia: (query: string) => ({ matches: query === "(min-width: 768px)" && fixture.roomy }),
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
    preact: "export const render=tree=>{globalThis.groupNavigationFixture.app=tree;};",
    "preact/hooks": `export const {useState,useRef,useEffect,useMemo,useCallback,useId}=globalThis.groupNavigationFixture.hooks;
        export const useLayoutEffect=()=>{};`,
    "store.js": `const f=globalThis.groupNavigationFixture;
        export const {store,workspaceOrder}=f;
        export const navigate=id=>f.navigated.push(id);
        export const actions={openWorkPip:async id=>f.mutations.push({id,action:"openPiP"}),controlWorkPip:async(id,action)=>f.mutations.push({id,action}),abort:async()=>f.mutations.push({id:store.state.conversationId,action:"abort"}),updateWorkItem:async(id,patch)=>f.mutations.push({id,...patch}),updateSession:async()=>{}};
        export const drafts={get:()=>"",set:()=>{}},typing=()=>{};
        export const attempt=fn=>fn(),notify=()=>{},openSheet=sheet=>f.opened.push(sheet),closeSheet=()=>{},dismiss=()=>{},holdNotice=()=>{},uid=()=>"row-opening";
        export const canSteer=()=>true,collab=()=>false,scoped=()=>false,handoffsAvailable=()=>true,projectsAvailable=()=>f.projectsAvailable;
        export const isUnread=()=>false,sessionUnread=()=>false,setUnread=()=>{},stillMoving=moving=>moving;
        export const signOut=()=>{},start=()=>{},filesShown=()=>false,panelsBeside=()=>false,peopleDocked=()=>false;`,
    "ui.js": `export const html=globalThis.groupNavigationFixture.html;
        export const apartFromViews=component=>component;
        export const Icon=globalThis.groupNavigationFixture.icon;
        export const Spinner=globalThis.groupNavigationFixture.spinner;
        export const Loader=()=>null,Sheet=props=>props.children;
        export const APPLE=false,BOTTOM_SHEETS={matches:false},Boot=()=>null,Keys=()=>null,Marked=()=>null,Slide=()=>null;
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
        "export const PeeksRailButton=()=>null,PeekHost=()=>null,PeeksButton=()=>null,PeekStrip=()=>null,PEEK_WIDE={},peekContext=()=>null,peekTiles=()=>[],peeksWanted=()=>false,togglePeeks=()=>{};",
    "pip.js":
        "export const PipRailButton=()=>null,PipHost=()=>null,openPip=()=>{},closePip=()=>{},pipAvailable=()=>false,togglePip=()=>{};",
    "private.js": "export const PrivateList=()=>null,PrivateTabs=()=>null,PrivatePane=()=>null;",
    "named-agents.js": `const f=globalThis.groupNavigationFixture;
        export const namedAgentsAvailable=()=>f.store.state.me?.role==='owner' && f.store.state.server?.privateAgents>=4;
        export const openAgentSettings=(id,agentId,section,options)=>f.opened.push({type:'named-agent',...options});
        export const NamedAgents=()=>null;`,
    "named-agent-avatar.js": "export const NamedAgentAvatar=()=>null;",
    "project-view.js": "export const ProjectView=globalThis.groupNavigationFixture.projectView;",
    "session-navigation.js": "export const PhoneSessionList=globalThis.groupNavigationFixture.phoneList;",
    "project.js":
        "export const ProjectForm=props=>globalThis.groupNavigationFixture.html`<native-project-form ...${props} />`;",
    "session-projects.js":
        "export const ProjectSessionPanel=props=>globalThis.groupNavigationFixture.html`<native-session-panel ...${props} />`;",
    "project-access.js":
        "export const ProjectFilters=props=>globalThis.groupNavigationFixture.html`<native-project-filters ...${props} />`; export const projectsMatchingFilter=(projects,filter)=>projects.filter(p=>filter==='local'?p.location?.kind!=='ssh':filter.startsWith('ssh:')?p.location?.host===filter.slice(4):true);",
    "agent-tabs.js": "export const AgentTabs=()=>null;",
    "agent-draft-pane.js": "export const AgentDraftPane=()=>null;",
    "agent-drafts.js": `export const sendAgentDraft=()=>{},updateAgentDraft=()=>{},updateAgentDraftFiles=()=>{},updateAgentDraftPastes=()=>{};
        export const openAgentDraft=(agentId,options)=>{const draft={agentId,...options};globalThis.groupNavigationFixture.agentDrafts.push(draft);return draft;};`,
    "session-hold.js": "export const useSessionHold=()=>({hold:null,consumeClick:()=>false});",
    "session-moves.js":
        "export const canMoveSessions=()=>false,useSessionDrag=()=>({busy:false,consumeClick:()=>false});",
    "session-seen.js": "export const sessionResultUnread=()=>false;",
    "ssh-status.js": "export const RemoteProjectIcon=()=>null;",
    "sidebar-context.js": "export const openSidebarOptions=()=>{},useSidebarContext=()=>{};",
    "thread-type.js":
        'export const ThreadTypeTag=globalThis.groupNavigationFixture.threadTypeTag,threadTypeLabel=()=>"Worker";',
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
    "pi-sessions.js": "export const piSessionsAvailable=()=>false,ImportPanel=()=>null;",
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
    "topbar.js": "export const Topbar=globalThis.groupNavigationFixture.topbar;",
    "workspace-location.js":
        "export const conversationLocation=()=>null,LocationPicker=()=>null,recentSshFolders=()=>[],rememberSshFolder=()=>{};",
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

const { SessionList, Rail, RailNav, toSessions } = await import(
    new URL("../web/sessions.js", import.meta.url).href
);
const { Launcher } = await import(new URL("../web/launcher.js", import.meta.url).href);
const { HomeCreation, HomeCreationPage } = await import(
    new URL("../web/home.js", import.meta.url).href
);
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
                threadType: "worker",
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
                threadType: "reviewer",
                workItemId: "work-1",
                workItemTitle: "Build app",
                activeThreadId: 2,
                updatedAt: 4,
                cwd: "/repo",
                ...supervisor,
            },
            { id: 3, title: "Other chat", threadType: "chat", updatedAt: 1, cwd: "/other" },
        ],
        pinned: [],
        projects: [],
        projectsLoaded: true,
        sessionsLoaded: true,
        moving: {},
        server: { workItems: 1 },
        models: [],
        folderFavorites: [],
        view: {},
        launcher: false,
    };
    fixture.projectsAvailable = false;
    fixture.navigated = [];
    fixture.opening = [];
    fixture.mutations = [];
    fixture.opened = [];
    fixture.agentDrafts = [];
}

function key(key: string, code: string, altKey = false) {
    const event = new Event("keydown", { cancelable: true });

    Object.assign(event, { key, code, altKey, ctrlKey: false, metaKey: false, shiftKey: false });
    events.dispatchEvent(event);

    return event;
}

const click = { preventDefault() {}, stopPropagation() {}, detail: 1 };
const classHas = (node: Node, name: string) => String(node.props.class).split(" ").includes(name);

// Home owns selection/disclosure and the native-draft handoff; draft-client and HTTP tests
// independently own receipt recovery and stored placement. No chat/creation model is mocked here.
// The real App shell owns mount placement, which Home's own lifecycle cannot see. A phone
// setup widened onto Home must not acquire a second blank creation page under its dialog.
test("App mounts one creation model and retains only a real unfinished page beneath child sheets", () => {
    const previous = fixture.store.state;

    fixture.roomy = true;
    const App = fixture.app!.type as (props: Props) => unknown;

    try {
        fixture.store.state = {
            me: { id: "layout-owner", role: "owner" },
            server: { projects: 1, privateAgents: 4 },
            conversationId: null,
            projectId: null,
            privateId: null,
            agentDraft: null,
            homeCreation: null,
            board: false,
            page: null,
            view: { conversation: null },
            sheet: null,
        };

        for (const sheet of [
            null,
            { type: "home-creation", id: "setup" },
            { type: "named-agent", creationParent: { type: "home-creation", id: "setup" } },
        ]) {
            fixture.store.state.sheet = sheet;
            current = { slots: [], cursor: 0 };
            const tree = nodes(App({}));

            assert.equal(
                tree.filter((node) => node.type === HomeCreationPage).length,
                sheet ? 0 : 1,
                "a native creation opening owns the sole form instead of duplicating blank Home",
            );
            assert.equal(
                tree.filter((node) => node.type === SessionList).length,
                1,
                "roomy Home has only the real sidebar, not a second CSS-hidden list",
            );
            effects = [];
        }

        fixture.store.state.homeCreation = { id: "home" };
        current = { slots: [], cursor: 0 };
        assert.equal(
            nodes(App({})).filter((node) => node.type === HomeCreationPage).length,
            1,
            "a genuine unfinished page stays mounted beneath its own child sheet",
        );
    } finally {
        effects = [];
        fixture.store.state = previous;
        fixture.roomy = false;
    }
});

// The caller, not CSS visibility, decides whether a navigation tree or creation model exists.
test("App lazily mounts only its active-width navigation and creation owners", () => {
    const previous = fixture.store.state;
    const App = fixture.app!.type as (props: Props) => unknown;

    try {
        for (const roomy of [false, true]) {
            fixture.roomy = roomy;

            for (const conversationId of [null, 10]) {
                fixture.store.state = {
                    me: { id: "shell-owner", role: "owner" },
                    server: {},
                    conversationId,
                    projectId: null,
                    privateId: null,
                    agentDraft: null,
                    board: false,
                    page: null,
                    view: {},
                    sheet: null,
                    homeCreation: null,
                };
                current = { slots: [], cursor: 0 };
                const tree = nodes(App({}));
                const phone = tree.filter((node) => node.type === fixture.phoneList);

                assert.equal(tree.filter((node) => node.type === SessionList).length, roomy ? 1 : 0);
                assert.equal(phone.length, roomy ? 0 : 1);

                if (!roomy) {
                    assert.equal(phone[0].props.active, conversationId === null);
                    assert.equal(phone[0].key, "shell-owner", "warm rows cannot cross accounts");
                }

                assert.equal(
                    tree.filter((node) => node.type === HomeCreationPage).length,
                    roomy && conversationId === null ? 1 : 0,
                );
                effects = [];
            }
        }
    } finally {
        fixture.store.state = previous;
        fixture.roomy = false;
        effects = [];
    }
});

// App owns route chrome: ProjectView's own heading cannot detect a second shell header.
// The same native toSessions callback must be delivered, while Chat keeps its conversation Topbar.
test("App gives the project content Back navigation without a redundant route header or menu", () => {
    const previous = fixture.store.state;
    const previousNavigation = fixture.navigated;
    const App = fixture.app!.type as (props: Props) => unknown;

    try {
        fixture.store.state = {
            me: { id: "project-owner", role: "owner" },
            server: { projects: 1, privateAgents: 4 },
            conversationId: null,
            projectId: "build",
            privateId: null,
            agentDraft: null,
            homeCreation: null,
            board: false,
            page: null,
            view: { conversation: null },
            sheet: null,
        };
        fixture.navigated = [];
        current = { slots: [], cursor: 0 };
        const pane = nodes(App({})).find((node) => node.props["data-part"] === "pane")!;
        const content = nodes(pane);
        const project = content.find((node) => node.type === fixture.projectView)!;

        assert.ok(project, "the real project route still mounts ProjectView");
        assert.equal(project.props.projectId, "build");
        assert.equal(
            content.some(
                (node) =>
                    node.type === "header" ||
                    node.type === fixture.topbar ||
                    classHas(node, "topbar") ||
                    node.props["aria-label"] === "Menu" ||
                    node.props["aria-label"] === "Open sessions",
            ),
            false,
            "ProjectView needs neither a Projects/ellipsis bar nor a replacement shell header",
        );
        assert.equal(project.props.onBack, toSessions, "Back uses the existing landing-list path");
        project.props.onBack();
        assert.deepEqual(fixture.navigated, [null]);
        assert.equal(fixture.store.state.drawer, undefined, "Back does not open a sessions drawer");

        fixture.store.state.conversationId = 21;
        fixture.store.state.projectId = null;
        current = { slots: [], cursor: 0 };
        const conversation = nodes(App({}));

        assert.equal(conversation.filter((node) => node.type === fixture.topbar).length, 1);
        assert.equal(
            conversation.some((node) => node.type === fixture.projectView),
            false,
        );
    } finally {
        effects = [];
        fixture.store.state = previous;
        fixture.navigated = previousNavigation;
    }
});

test("Home keeps named-agent creation local, returns to unfinished setup, and pins the chosen project's draft", () => {
    setup("running", null);
    Object.assign(fixture.store.state, {
        server: { privateAgents: 4, projects: 1 },
        homeCreation: { projectId: "app" },
        projects: [
            { id: "app", name: "Application", cwd: "/app", defaultAgentId: "ada" },
            {
                id: "remote",
                name: "Remote",
                cwd: "/remote",
                location: { kind: "ssh", host: "box" },
            },
        ],
        namedAgents: [{ agentId: "ada", name: "Ada", chats: [] }],
    });
    const home = mount(HomeCreation);
    const button = (label: RegExp) =>
        nodes(home.render()).find((node) => node.type === "button" && label.test(textOf(node)))!;

    try {
        assert.equal(
            nodes(home.render()).some(
                (node) => node.type === "native-session-panel" && node.props.visible,
            ),
            false,
        );
        assert.ok(button(/Chat with Ada/));
        fixture.store.state.namedAgents[0].projectId = "app";
        fixture.store.state.namedAgents.push({
            agentId: "max",
            name: "Max",
            projectId: "app",
            chats: [],
        });

        for (const defaultAgentId of [null, "unavailable"]) {
            fixture.store.state.projects[0].defaultAgentId = defaultAgentId;
            const tree = home.render();
            const picker = nodes(tree).find((node) => node.props["aria-label"] === "Named agent")!;

            assert.equal(
                picker.props.value,
                defaultAgentId ?? "",
                "related identities never replace an explicit clear or unavailable default",
            );
            assert.equal(button(/Chat with a named agent/).props.disabled, true);

            if (defaultAgentId === null) {
                assert.match(textOf(tree), /No default agent selected\. Related PiPs: Ada, Max/);
            }
        }

        fixture.store.state.projects[0].defaultAgentId = "ada";
        fixture.store.state.namedAgents.pop();
        button(/Other ways to start/).props.onClick();
        button(/New Work Item/).props.onClick();
        const work = nodes(home.render()).find(
            (node) => node.type === "native-session-panel" && node.props.visible,
        )!;

        assert.equal(work.props.projectId, "app");
        assert.equal(work.props.embedded, true);
        assert.deepEqual(fixture.agentDrafts, []);
        assert.ok(
            button(/Chat with Ada/),
            "disclosing work keeps the primary Chat action available",
        );
        button(/Other ways to start/).props.onClick();
        const picker = nodes(home.render()).find(
            (node) => node.props["aria-label"] === "Named agent",
        )!;

        picker.props.onChange({ currentTarget: { value: "__create" } });
        assert.equal(fixture.opened.at(-1)?.type, "named-agent");
        assert.deepEqual(fixture.agentDrafts, [], "creating an identity does not start a chat");
        fixture.store.state.namedAgents.push({ agentId: "bea", name: "Bea", chats: [] });
        fixture.opened.at(-1)!.onCreated({ agentId: "bea", name: "Bea" });
        button(/Other ways to start/).props.onClick();
        button(/New Work Item/).props.onClick();
        button(/Chat with Bea/).props.onClick();
        assert.deepEqual(fixture.agentDrafts, [{ agentId: "bea", projectId: "app" }]);
        assert.equal(
            fixture.store.state.projects[0].defaultAgentId,
            "ada",
            "a one-off selection does not rewrite defaults",
        );
    } finally {
        home.dispose();
    }
});

test("an explicit New Session folder reveals native work settings after Home project selection", () => {
    setup("running", null);
    Object.assign(fixture.store.state, {
        server: { privateAgents: 4, projects: 1 },
        homeCreation: { cwd: "/chosen-folder" },
        projects: [{ id: "app", name: "Application", cwd: "/app" }],
        namedAgents: [],
    });
    const home = mount(HomeCreation);

    try {
        nodes(home.render())
            .find((node) => node.type === "button" && textOf(node) === "Application")!
            .props.onClick();
        const work = nodes(home.render()).find(
            (node) => node.type === "native-session-panel" && node.props.visible,
        )!;

        assert.equal(work.props.cwd, "/chosen-folder");
        assert.equal(work.props.projectId, "app");
        assert.deepEqual(fixture.agentDrafts, []);
        assert.deepEqual(fixture.mutations, []);
    } finally {
        home.dispose();
    }
});

test("Home machine filters clear mismatched creation context and one-time Chat stays a separate native path", () => {
    setup("running", null);
    Object.assign(fixture.store.state, {
        server: { privateAgents: 4, projects: 1 },
        homeCreation: { projectId: "app" },
        projects: [
            { id: "app", name: "Application", cwd: "/app" },
            {
                id: "remote",
                name: "Remote",
                cwd: "/remote",
                location: { kind: "ssh", host: "box" },
            },
        ],
        namedAgents: [],
    });
    const home = mount(HomeCreation);
    const button = (label: RegExp) =>
        nodes(home.render()).find((node) => node.type === "button" && label.test(textOf(node)))!;

    try {
        button(/Other ways to start/).props.onClick();
        button(/New Work Item/).props.onClick();
        nodes(home.render())
            .find((node) => node.type === "native-project-filters")!
            .props.onChange("ssh:box");
        assert.equal(
            nodes(home.render()).some(
                (node) => node.type === "native-session-panel" && node.props.visible,
            ),
            false,
        );
        assert.equal(
            nodes(home.render()).some((node) => node.props["aria-label"] === "Named agent"),
            false,
        );
        button(/^Remote$/).props.onClick();
        button(/New Work Item/).props.onClick();
        assert.equal(
            nodes(home.render()).find(
                (node) => node.type === "native-session-panel" && node.props.visible,
            )!.props.projectId,
            "remote",
        );
        button(/One-time Chat/).props.onClick();
        const panels = nodes(home.render()).filter(
            (node) => node.type === "native-session-panel" && node.props.visible,
        );

        assert.equal(panels.length, 1, "only the selected creation mode is visible");
        assert.equal(panels[0]!.props.oneTime, true);
        assert.equal(panels[0]!.props.projectId, undefined);
        assert.deepEqual(fixture.agentDrafts, []);
        assert.deepEqual(fixture.mutations, []);
    } finally {
        home.dispose();
    }
});

for (const status of ["running", "paused", "reclaimed", "collaborator"] as const) {
    const destination = status === "collaborator" ? 2 : 99;

    test(`launcher and home open the ${status} group's destination, not its mutation ID`, () => {
        setup(status);
        const launcher = mount(Launcher);
        const home = mount(HomeCreation);

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

// The public controller state, not execution activity, owns the group's leading indicator.
for (const [status, executionBusy] of [
    ["running", false],
    ["reclaimed", true],
    ["paused", true],
] as const) {
    test(`${status} supervision with execution busy=${executionBusy} owns the primary PiP icon in both disclosure states`, () => {
        setup(status);
        fixture.store.state.sessions[1].busy = executionBusy;
        const list = mount(SessionList);

        try {
            for (const expanded of [true, false]) {
                const rows = nodes(list.render()).filter(
                    (node) => node.props["data-part"] === "session-row",
                );
                const head = rows.find((node) => classHas(node, "work-item-head"))!;
                const disclosure = nodes(head).find((node) =>
                    classHas(node, "work-item-disclosure"),
                )!;
                const indicator = nodes(disclosure).find((node) =>
                    classHas(node, "work-item-pip-state"),
                );
                const state = status === "running" ? "PiP active" : "Human control";

                assert.ok(indicator, "the controller dial replaces the leading latest-role icon");
                assert.equal(disclosure.props["aria-expanded"], expanded);
                assert.equal(
                    disclosure.props["aria-label"],
                    `${expanded ? "Collapse" : "Expand"} Work Item Build app · ${state}`,
                );
                assert.equal(indicator.props["aria-label"], state);
                assert.equal(indicator.props.role, "img");
                assert.equal(
                    indicator.props["data-status"],
                    status === "running" ? "running" : "reclaimed",
                );
                const icon = nodes(indicator).find((node) => node.type === "native-icon")!;

                assert.equal(icon.props.name, "pip");
                assert.equal(icon.props.size, 14);
                assert.equal(
                    nodes(disclosure).some((node) => node.type === "native-thread-type"),
                    false,
                );
                assert.equal(
                    nodes(head).filter((node) => classHas(node, "work-item-pip-state")).length,
                    1,
                    "the primary dial is not duplicated in metadata",
                );
                const metadata = nodes(head).find((node) => classHas(node, "session-meta"))!;

                assert.equal(
                    nodes(metadata).some((node) => classHas(node, "work-item-pip-state")),
                    false,
                );
                assert.deepEqual(
                    rows
                        .filter((node) => classHas(node, "work-item-member"))
                        .map((row) => {
                            assert.equal(
                                nodes(row).some((node) => classHas(node, "work-item-pip-state")),
                                false,
                            );
                            const role = nodes(row).find(
                                (node) => node.type === "native-thread-type",
                            )!;

                            return [role.props.session.id, role.props.session.threadType];
                        }),
                    [
                        [1, "worker"],
                        [2, "reviewer"],
                    ],
                    "execution children keep their exact role indicators",
                );

                if (expanded) {
                    disclosure.props.onClick(click);
                }
            }

            assert.deepEqual(fixture.navigated, [], "disclosure still only folds the group");
            assert.deepEqual(fixture.mutations, []);
        } finally {
            list.dispose();
        }
    });
}

test("only an actively PiP-controlled parent omits duplicate execution indicators; children and ordinary rows keep theirs", () => {
    for (const status of ["running", "reclaimed", "new", "collaborator"] as const) {
        setup(status);
        fixture.projectsAvailable = true;
        Object.assign(fixture.store.state.sessions[1], {
            busy: true,
            subagents: { working: 2 },
        });
        Object.assign(fixture.store.state.sessions[2], {
            busy: true,
            subagents: { working: 1 },
        });
        const list = mount(SessionList);

        try {
            const rows = nodes(list.render()).filter(
                (node) => node.props["data-part"] === "session-row",
            );
            const head = rows.find((node) => classHas(node, "work-item-head"))!;
            const child = rows.find(
                (node) => classHas(node, "work-item-member") && node.props["data-id"] === 2,
            )!;
            const ordinary = rows.find((node) => node.props["data-id"] === 3)!;
            const forks = (row: Node) =>
                nodes(row).filter((node) => classHas(node, "session-fork"));
            const working = (row: Node) =>
                nodes(row).filter((node) => node.type === "native-spinner");

            assert.equal(forks(head).length, status === "running" ? 0 : 1, status);
            assert.equal(working(head).length, status === "running" ? 0 : 1, status);
            assert.equal(
                head.props["data-state"],
                "working",
                "presentation never clears execution state",
            );
            assert.equal(textOf(forks(child)), "2", "the exact execution child keeps its count");
            assert.equal(working(child).length, 1);
            assert.equal(textOf(forks(ordinary)), "1");
            assert.equal(working(ordinary).length, 1);
            assert.equal(nodes(head).filter((node) => classHas(node, "session-time")).length, 1);
            assert.deepEqual(fixture.mutations, []);
        } finally {
            list.dispose();
        }
    }
});

test("PiP parent simplification keeps failure and waiting attention visible", () => {
    setup();
    Object.assign(fixture.store.state.sessions[1], {
        busy: true,
        subagents: { working: 2, waiting: 1, failed: 2, dealt: 1 },
    });
    const list = mount(SessionList);
    const head = () => nodes(list.render()).find((node) => classHas(node, "work-item-head"))!;

    try {
        const attention = nodes(head()).find((node) => classHas(node, "session-fork"))!;

        assert.equal(
            textOf(attention),
            "2",
            "only one waiting and one unhandled failure need attention",
        );
        assert.match(attention.props.title, /1 waiting/);
        assert.match(attention.props.title, /1 failed/);
        assert.doesNotMatch(attention.props.title, /working/);
        assert.equal(classHas(attention, "failed"), true);
        fixture.store.state.sessions[1].waiting = true;
        const waiting = nodes(head()).find(
            (node) => node.props["aria-label"] === "Waiting for approval",
        );

        assert.ok(waiting);
        assert.match(textOf(head()), /needs you/);
        fixture.store.state.sessions[1].waiting = false;
        fixture.store.state.sessions[1].failed = true;
        assert.ok(nodes(head()).find((node) => node.props["aria-label"] === "Failed"));
        assert.deepEqual(fixture.mutations, []);
    } finally {
        list.dispose();
    }
});

test("groups without a public supervisor and standalone threads retain native role indicators", () => {
    setup("new");
    fixture.projectsAvailable = true;
    const list = mount(SessionList);

    try {
        const rows = nodes(list.render()).filter(
            (node) => node.props["data-part"] === "session-row",
        );
        const head = rows.find((node) => classHas(node, "work-item-head"))!;
        const disclosure = nodes(head).find((node) => classHas(node, "work-item-disclosure"))!;
        const primary = nodes(disclosure).find((node) => node.type === "native-thread-type")!;

        assert.equal(primary.props.session.id, 2);
        assert.equal(primary.props.session.threadType, "reviewer");
        assert.equal(primary.props.iconOnly, true);
        assert.equal(
            nodes(disclosure).some((node) => classHas(node, "work-item-pip-state")),
            false,
        );
        assert.match(disclosure.props["aria-label"], / · Worker$/);
        const metadata = nodes(head).find((node) => classHas(node, "session-meta"))!;

        assert.equal(
            nodes(metadata).filter((node) => classHas(node, "work-item-pip-state")).length,
            1,
            "non-supervisor metadata remains unchanged",
        );
        const standalone = rows.find((node) => node.props["data-id"] === 3)!;
        const role = nodes(standalone).find((node) => node.type === "native-thread-type")!;

        assert.equal(role.props.session.id, 3);
        assert.equal(role.props.session.threadType, "chat");
        assert.equal(role.props.iconOnly, true);
        assert.equal(
            nodes(standalone).some((node) => classHas(node, "work-item-pip-state")),
            false,
        );
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

test("collaborator rows expose no private indicator or owner control even with stale supervisor metadata", () => {
    setup("collaborator", null);

    for (const session of fixture.store.state.sessions) {
        session.supervisor = { conversationId: 99, status: "running", epoch: 1 };
    }

    const list = mount(SessionList, { home: true });

    try {
        const tree = list.render();

        assert.equal(
            nodes(tree).some((node) => classHas(node, "session-orchestrate")),
            false,
        );
        assert.doesNotMatch(textOf(tree), /PiP running|PiP paused|Let PiP take over|Manage PiP/);
        assert.equal(
            nodes(tree).some((node) => classHas(node, "work-item-pip-state")),
            false,
        );
        const disclosure = nodes(tree).find((node) => classHas(node, "work-item-disclosure"))!;
        const role = nodes(disclosure).find((node) => node.type === "native-thread-type")!;

        assert.equal(role.props.session.id, 2);
        assert.equal(role.props.session.threadType, "reviewer");
        assert.doesNotMatch(disclosure.props["aria-label"], /PiP active|Human control/);
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
