// Authoring gate: real components own grant choices, invite races and fixed-destination creation.
// A broadened invite, lost manual choice, stale QR, or guest destination override must fail here.
// App permission tests own enforcement; they do not render controls or deliver late invite responses.
// Import confirmation owns visibility/placement consent and fences stale accounts, targets and openings.
// API tests cannot deliver retained component callbacks or a response after that component is disposed.
// Only hooks/scheduling and external UI dependencies are replaced; no production test seams or listeners.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, test } from "node:test";
import { h } from "preact";

const htm = (await import(import.meta.resolve("htm"))).default;

type Props = Record<string, any>;
type Node = { type: string | ((props: Props) => unknown); props: Props };
type Slot = { value?: any; current?: any; deps?: unknown[]; cleanup?: () => void };
type Mount = { run: () => unknown; slots: Slot[]; tree?: unknown; disposed?: boolean };
let current: Mount;
let cursor = 0;
let pendingEffects: (() => void)[] = [];

function render(mount: Mount) {
    current = mount;
    cursor = 0;
    mount.tree = mount.run();
    const effects = pendingEffects;

    pendingEffects = [];

    for (const effect of effects) {
        effect();
    }
}

const hooks = {
    useState(initial: unknown) {
        const mount = current;
        const slot = (mount.slots[cursor++] ??= {
            value: typeof initial === "function" ? initial() : initial,
        });

        return [
            slot.value,
            (next: unknown) => {
                const value = typeof next === "function" ? next(slot.value) : next;

                if (!Object.is(slot.value, value)) {
                    slot.value = value;
                    queueMicrotask(() => !mount.disposed && render(mount));
                }
            },
        ];
    },
    useRef(value: unknown) {
        return (current.slots[cursor++] ??= { current: value });
    },
    useId() {
        return `field-${cursor++}`;
    },
    useEffect(effect: () => (() => void) | undefined, deps: unknown[]) {
        const mount = current;
        const slot = cursor++;
        const previous = mount.slots[slot];

        if (!previous || deps.some((value, index) => !Object.is(value, previous.deps?.[index]))) {
            const next: Slot = { deps };

            mount.slots[slot] = next;
            pendingEffects.push(() => {
                previous?.cleanup?.();
                next.cleanup = effect();
            });
        }
    },
};

const projects = [
    { id: "local", name: "Local app", cwd: "/local" },
    { id: "a", name: "Remote app", cwd: "/a", location: { kind: "ssh", host: "machine-a" } },
    { id: "b", name: "Remote docs", cwd: "/b", location: { kind: "ssh", host: "machine-b" } },
];
const fixture = {
    hooks,
    html: htm.bind(h),
    store: {
        state: {} as Props,
        set(patch: Props) {
            Object.assign(this.state, patch);
        },
        subscribe() {
            return () => {};
        },
    },
    actions: {} as Props,
    api: async (_path: string, _body: Props): Promise<Props> => ({}),
    errors: [] as string[],
    navigated: [] as number[],
    notified: [] as unknown[][],
    remembered: [] as unknown[],
    opened: [] as Props[],
    closed: [] as Props[],
};

const mediaDescriptor = Object.getOwnPropertyDescriptor(globalThis, "matchMedia");

Object.defineProperty(globalThis, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false }),
});
after(() => {
    if (mediaDescriptor) {
        Object.defineProperty(globalThis, "matchMedia", mediaDescriptor);
    } else {
        Reflect.deleteProperty(globalThis, "matchMedia");
    }
});
Object.assign(globalThis, { projectAccessUiFixture: fixture });
const sources: Record<string, string> = {
    "preact/hooks":
        "export const {useState,useRef,useEffect,useId} = globalThis.projectAccessUiFixture.hooks; export const useLayoutEffect=useEffect,useContext=()=>null,useMemo=make=>make();",
    "store.js": `const f=globalThis.projectAccessUiFixture;
        export const {store,actions}=f;
        export const api=(...args)=>f.api(...args);
        export const attempt=fn=>Promise.resolve().then(fn).catch(error=>f.errors.push(error.message));
        export const collab=()=>true,notify=(...args)=>f.notified.push(args),uid=()=>"request";
        export const closeSheet=()=>f.closed.push(store.state.sheet);
        export const projectsAvailable=()=>true,insertIntoComposer=()=>{},handoffsAvailable=()=>true;
        export const canSteer=()=>store.state.me?.role!=='viewer';
        export const scoped=()=>store.state.me?.sessions!==undefined;
        export const canToggleTurns=()=>false,isUnread=()=>false,setUnread=()=>{};
        export const signOut=()=>{},workspaceOrder=()=>[];
        export const openSheet=sheet=>f.opened.push(sheet);
        export const navigate=id=>f.navigated.push(id);`,
    "ui.js": `export const html=globalThis.projectAccessUiFixture.html;
        export const Icon=()=>null,Loader=()=>null,Sheet=()=>null,copyText=()=>{},timeAgo=()=>"now";
        export const shortPath=value=>value,Switch=()=>null,SheetInfo={};
        export const anchorStyle=()=>undefined,popAnchor=()=>null,BOTTOM_SHEETS={matches:false};
        export const APPLE=false,Keys=()=>null,Marked=()=>null,scrimPress=run=>()=>run();
        export const modelLabel=()=>"current model",replyText=entry=>entry.text,writtenText=entry=>entry.text;
        export const item=(label,onClick,hint)=>html\`<button onClick=\${onClick}>\${label}<span>\${hint}</span></button>\`;`,
    "back.js": "export const useBack=()=>{};",
    "gestures.js": "export const useDragToClose=()=>{};",
    "avatar.js": "export const Avatar=()=>null,folderColor=()=>'';",
    "workspace-location.js": `export const LocationPicker=()=>null;
        export const conversationLocation=()=>globalThis.projectAccessUiFixture.store.state.view.conversation?.location??null;
        export const rememberSshFolder=(...args)=>globalThis.projectAccessUiFixture.remembered.push(args);`,
    "ssh-status.js": "export const RemoteProjectIcon=()=>null;",
    "folder.js":
        "export const FolderPicker=()=>null,recentLabels=paths=>paths.map(path=>path.split('/').at(-1));",
    "sidebar-context.js": "export const openSidebarOptions=()=>{};",
    "agent-tabs.js": "export const tabAgent=()=>null;",
    "topbar.js": "export const AgentMenuItems=()=>null;",
    "sessions.js": "export const selectFromList=()=>{},setArchived=()=>{};",
    "theme.js": `export const isPinned=()=>false,togglePin=()=>{};
        export const BASE_LOOK='pocket',chooseLook=()=>{},chooseTheme=()=>{},folderPaletteIds=()=>[],lookIds=()=>[];
        export const paletteOf=()=>({colors:{}}),prefs=()=>({}),preview=()=>{},setPrefs=()=>{},themeIds=()=>[],themeVars=()=>({}),varsStyle=()=>'';`,
    "memory.js": "export const memoryAvailable=()=>false,memoryHint=()=>'',useMemory=()=>null;",
    "browser.js":
        "export const browserAvailable=()=>false,displayUrl=value=>value,setBrowserOpen=()=>{},toggleBrowser=()=>{};",
    "chat.js": "export const chatUnread=()=>0;",
    "commands.js":
        "export const planAvailable=()=>false,schedulesAvailable=()=>false,triggersOn=()=>false,watchAvailable=()=>false,watchPr=()=>{};",
    "extension-ui.js":
        "export const extensionMenuItems=()=>[],extensionLauncherItems=()=>[],safeMode=()=>false;",
    "diff.js": "export const useChanges=()=>({changes:null});",
    "files-panel.js":
        "export const filesAvailable=()=>false,setFilesOpen=()=>{},toggleFiles=()=>{};",
    "peeks.js": "export const peeksOn=()=>false,togglePeeks=()=>{};",
    "model-refresh.js": "export const modelRefreshAvailable=()=>false,refreshModels=()=>{};",
    "pip.js": "export const openPip=()=>{},pipAvailable=()=>false,pipUnread=()=>0;",
    "subagents.js": "export const openSubagent=()=>{};",
    "trust.js": "export const currentTrust=()=>null,trustAvailable=()=>false;",
    "branch.js": "export const branchAvailable=()=>false,headLabel=()=>'';",
    "gallery.js": "export const galleryAvailable=()=>false;",
    "model.js": "export const defaultLabel=()=>'',defaultsKept=()=>false;",
    "ssh-login.js": "export const SshLogin=()=>null;",
};
const owned =
    /\/web\/(project-access|thread-type|workspace-field|session-moves|launcher|sheets\/(people|project|session-projects|session|pi-sessions|sidebar-options|message|menu|worktree|branch))\.js$/;

registerHooks({
    resolve(specifier, context, next) {
        const parent = context.parentURL && new URL(context.parentURL).pathname;
        const source =
            parent && owned.test(parent)
                ? (sources[specifier.split("/").at(-1)!] ?? sources[specifier])
                : undefined;

        return source === undefined
            ? next(specifier, context)
            : { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    },
});

const { ProjectAccessPicker, ProjectFilters } = await import(
    new URL("../web/project-access.js", import.meta.url).href
);
const { InviteSheet, PeopleList } = await import(
    new URL("../web/sheets/people.js", import.meta.url).href
);
const { ProjectSessionPanel } = await import(
    new URL("../web/sheets/session-projects.js", import.meta.url).href
);
const { ProjectForm } = await import(new URL("../web/sheets/project.js", import.meta.url).href);
const { WorkspaceField } = await import(new URL("../web/workspace-field.js", import.meta.url).href);
const { ImportPanel, ShareImportSheet } = await import(
    new URL("../web/sheets/pi-sessions.js", import.meta.url).href
);
const { NewSessionSheet } = await import(new URL("../web/sheets/session.js", import.meta.url).href);
const { SidebarOptions } = await import(
    new URL("../web/sheets/sidebar-options.js", import.meta.url).href
);
const { MessageSheet } = await import(new URL("../web/sheets/message.js", import.meta.url).href);
const { MenuSheet } = await import(new URL("../web/sheets/menu.js", import.meta.url).href);
const { WorktreeSheet } = await import(new URL("../web/sheets/worktree.js", import.meta.url).href);
const { BranchPicker } = await import(new URL("../web/sheets/branch.js", import.meta.url).href);
const { moveSessions } = await import(new URL("../web/session-moves.js", import.meta.url).href);
const { Launcher } = await import(new URL("../web/launcher.js", import.meta.url).href);

function mount(run: () => unknown): Mount {
    const instance: Mount = { run, slots: [] };

    render(instance);

    return instance;
}

function dispose(instance: Mount) {
    instance.disposed = true;

    for (const slot of instance.slots) {
        slot?.cleanup?.();
    }
}

function nodes(value: any): Node[] {
    if (Array.isArray(value)) {
        return value.flatMap(nodes);
    }

    if (!value || typeof value !== "object" || !value.props) {
        return [];
    }

    return [value, ...nodes(value.props.children)];
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

function find(instance: Mount, predicate: (node: Node) => boolean): Node {
    const result = nodes(instance.tree).find(predicate);

    assert.ok(result, "rendered control exists");

    return result;
}

const button = (instance: Mount, text: string) =>
    find(
        instance,
        (node) => node.type === "button" && textOf(node).replace(/\s+/g, " ").trim() === text,
    );
const checkbox = (instance: Mount, label: string) =>
    find(instance, (node) => node.type === "input" && node.props["aria-label"] === label);
const child = (instance: Mount, component: unknown) =>
    find(instance, (node) => node.type === component);

const field = (instance: Mount, id: string): Node => {
    const node = find(instance, (candidate) => candidate.props.id === id);

    if (typeof node.type === "function") {
        const component = node.type;

        return field(
            mount(() => component(node.props)),
            id,
        );
    }

    return node;
};

const submit = (instance: Mount) =>
    find(instance, (node) => node.type === "form").props.onSubmit({ preventDefault() {} });

const flush = async () => {
    for (let index = 0; index < 20; index++) {
        await Promise.resolve();
    }
};

function reset() {
    fixture.store.state = {
        me: { id: "owner", role: "owner" },
        view: {},
        sheet: { type: "invite" },
        projects: [...projects],
        projectsLoaded: true,
        users: [],
        sessions: [],
        server: {
            projects: 1,
            sshWorkspaces: 1,
            defaultCwd: "/default",
            agentProfiles: [
                { id: "worker", name: "Worker", starter: true },
                { id: "chat", name: "Chat", starter: true },
            ],
        },
    };

    fixture.actions.loadProjects = async () => {};

    fixture.errors = [];
    fixture.navigated = [];
    fixture.notified = [];
    fixture.remembered = [];
    fixture.opened = [];
    fixture.closed = [];
}

function importPreview(patch: Props = {}) {
    return {
        title: "Saved conversation",
        cwd: "/local",
        path: "/history/session.jsonl",
        sha256: "a".repeat(64),
        leafId: "saved-leaf",
        sourceModel: { provider: "provider", modelId: "one" },
        sourceThinkingLevel: "low",
        models: [
            { provider: "provider", id: "one", images: true, levels: ["off", "low", "high"] },
            { provider: "provider", id: "two", images: true, levels: ["off", "low", "high"] },
        ],
        hasImages: false,
        entries: 2,
        messages: 1,
        history: [{ role: "user", text: "A saved request" }],
        warnings: [],
        ...patch,
    };
}

async function changeField(instance: Mount, id: string, value: string | boolean) {
    field(instance, id).props.onChange({
        currentTarget: typeof value === "boolean" ? { checked: value } : { value },
    });
    await flush();
}

test("owner import visibility and project choices invalidate consent together with model and thinking", async () => {
    reset();
    const requests: unknown[] = [];

    fixture.store.state.sheet = { type: "import" };

    fixture.api = async (path, body) => {
        requests.push([path, body]);

        return { id: 45 };
    };

    const preview = importPreview();
    const panel = mount(() => ImportPanel({ initialPreview: preview }));

    await flush();
    const visibility = field(panel, "import-visibility");
    const options = nodes(visibility).filter((node) => node.type === "option");

    assert.equal(visibility.props.value, "owner");
    assert.deepEqual(
        options.map((option) => option.props.value),
        ["owner", "shared"],
    );
    assert.match(textOf(options[0]), /Private/);
    assert.match(textOf(options[1]), /Shared/);
    assert.equal(field(panel, "import-project").type, "select");

    for (const [id, value] of [
        ["import-model", "provider/two"],
        ["import-thinking", "high"],
        ["import-project", "local"],
        ["import-visibility", "shared"],
    ] as const) {
        await changeField(panel, "import-consent", true);
        const staleSubmit = find(panel, (node) => node.type === "form").props.onSubmit;

        await changeField(panel, id, value);
        assert.equal(field(panel, "import-consent").props.checked, false, id);
        await staleSubmit({ preventDefault() {} });
        await submit(panel);
        await flush();
        assert.deepEqual(
            requests,
            [],
            `${id} needs fresh acknowledgement, even through an old form`,
        );
    }

    dispose(panel);
});

test("reopening a private receipt identifies the entire existing Chat and explicitly clears project placement", async () => {
    reset();
    fixture.store.state.sheet = { type: "import" };
    const requests = holdApi();
    const preview = importPreview({
        existing: 45,
        existingTitle: "Continued confidential Chat",
        visibility: "owner",
        projectId: "local",
    });
    const panel = mount(() => ImportPanel({ initialPreview: preview }));

    await flush();
    await changeField(panel, "import-visibility", "shared");
    await changeField(panel, "import-project", "");
    assert.match(textOf(panel.tree), /Continued confidential Chat/);
    assert.match(textOf(panel.tree), /#45/);
    assert.match(
        textOf(panel.tree),
        /entire current history, including messages added since import/i,
    );
    await changeField(panel, "import-consent", true);
    const saving = submit(panel);

    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.body.projectId, null);
    assert.equal(requests[0]!.body.existingId, 45);
    requests[0]!.resolve({ id: 45, existing: true });
    await saving;
    dispose(panel);
});

test("New Session preserves import choices across its own tabs but rejects a replacement opening", async () => {
    reset();
    fixture.store.state.sheet = { type: "new-session", tab: "import" };
    const requests = holdApi();
    const preview = importPreview();
    const sheet = mount(() =>
        NewSessionSheet({ tab: fixture.store.state.sheet.tab, initialPreview: preview }),
    );
    const panel = mount(() => ImportPanel(child(sheet, ImportPanel).props));

    await flush();
    await changeField(panel, "import-visibility", "shared");
    await changeField(panel, "import-project", "local");
    await changeField(panel, "import-consent", true);

    for (const tab of ["Start new", "Import"]) {
        button(sheet, tab).props.onClick();
        fixture.store.state.sheet = fixture.opened.at(-1)!;
        render(sheet);
        await flush();
        render(panel);
        await flush();
    }

    assert.equal(field(panel, "import-visibility").props.value, "shared");
    assert.equal(field(panel, "import-project").props.value, "local");
    assert.equal(field(panel, "import-consent").props.checked, true);
    const retainedSubmit = find(panel, (node) => node.type === "form").props.onSubmit;
    const saving = submit(panel);

    assert.equal(requests.length, 1);
    requests[0]!.resolve({ id: 45 });
    await saving;
    await flush();
    fixture.store.state.sheet = { ...fixture.store.state.sheet };
    render(sheet);
    render(panel);
    await retainedSubmit({ preventDefault() {} });
    assert.equal(requests.length, 1, "a genuine replacement opening cannot reuse old consent");
    dispose(panel);
    dispose(sheet);
});

function holdApi() {
    const requests: {
        path: string;
        body: Props;
        resolve: (value: Props) => void;
        reject: (failure: Error) => void;
    }[] = [];

    fixture.api = (path, body) =>
        new Promise((resolve, reject) => requests.push({ path, body, resolve, reject }));

    return requests;
}

// Inline Home owns completion without owning store.sheet. The real panel, not an API mock,
// must retain valid consent across child setup yet suppress hidden/retired asynchronous effects.
// Existing standalone import tests cannot exercise this host predicate or completion override.
// The saved picker is mounted through its rendered node, never a new production export.
test("inline import completion follows its host instead of capturing the default sheet owner", async () => {
    reset();
    fixture.store.state.sheet = null;
    fixture.store.state.projects = [];
    const requests = holdApi();
    const completed: number[] = [];
    const obsoleteCompleted: number[] = [];
    const created: number[] = [];
    const busy: boolean[] = [];
    const preview = importPreview();
    const props: Props = {
        initialPreview: preview,
        visible: true,
        isCurrentOpening: () => true,
        isActive: () => fixture.store.state.homeCreation?.source === "import",
        onComplete: (id: number) => obsoleteCompleted.push(id),
        onCreated: (id: number) => created.push(id),
        onBusyChange: (value: boolean) => busy.push(value),
    };

    fixture.store.state.homeCreation = { source: "import" };
    const panel = mount(() => ImportPanel(props));

    await flush();
    await changeField(panel, "import-consent", true);
    const retained = find(panel, (node) => node.type === "form").props.onSubmit;

    props.visible = false;
    fixture.store.state.sheet = { type: "project" };
    render(panel);
    const hiddenDispatch = retained({ preventDefault() {} });

    assert.equal(requests.length, 0, "a retained hidden form cannot copy");
    await hiddenDispatch;
    assert.equal(field(panel, "import-consent").props.checked, true);
    props.visible = true;
    fixture.store.state.sheet = null;
    render(panel);
    const saving = submit(panel);

    assert.deepEqual(busy, [false, true], "Home's pending gate closes before dispatch returns");
    await flush();
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.body.projectId, null, "no Home project is inferred");
    props.onComplete = (id: number) => completed.push(id);
    render(panel);
    // This logical host remains active even though its native sheet bookkeeping changes.
    fixture.store.state.sheet = { type: "home", opening: "same-host" };
    requests[0]!.resolve({ id: 48 });
    await saving;
    await flush();
    assert.deepEqual(completed, [48]);
    assert.deepEqual(obsoleteCompleted, [], "pending callbacks use the latest host contract");
    assert.deepEqual(created, [48]);
    assert.deepEqual(fixture.closed, [], "inline completion must not close a native child");
    assert.deepEqual(fixture.navigated, [], "the inline host owns navigation");
    assert.deepEqual(busy, [false, true, false]);
    dispose(panel);
});

// A retained inline form can coexist with native Import & share. Labels, ARIA and tab focus
// must resolve within their own form; browser geometry/focus execution remains separate evidence.
test("retained inline import IDs cannot capture native import labels or tab focus", async (t) => {
    reset();
    fixture.store.state.sheet = null;
    fixture.api = async () => ({ sessions: [], warnings: [] });
    const preview = importPreview();
    const props: Props = {
        initialPreview: preview,
        idPrefix: "home-import",
        visible: true,
        isCurrentOpening: () => true,
        isActive: () => fixture.store.state.sheet === null,
    };
    const inline = mount(() => ImportPanel(props));

    t.after(() => dispose(inline));
    await flush();
    props.visible = false;
    fixture.store.state.sheet = { type: "import", fromPrivate: true };
    render(inline);
    const native = mount(() => ImportPanel({ initialPreview: preview, fromPrivate: true }));

    t.after(() => dispose(native));
    await flush();
    const inlineIds = nodes(inline.tree)
        .filter((node) => node.props.id)
        .map((node) => node.props.id);
    const nativeIds = nodes(native.tree)
        .filter((node) => node.props.id)
        .map((node) => node.props.id);

    assert.equal(
        inlineIds.some((id) => nativeIds.includes(id)),
        false,
        "hidden inline IDs must not steal native label targets",
    );
    assert.equal(field(native, "import-model").props.value, "provider/one");
    assert.equal(field(inline, "home-import-import-model").props.value, "provider/one");
    const selectors: string[] = [];
    const keyEvent = {
        key: "ArrowRight",
        preventDefault() {},
        currentTarget: {
            querySelector: (selector: string) => ({ focus: () => selectors.push(selector) }),
        },
    };
    const tabs = () => find(inline, (node) => node.props.role === "tablist");

    tabs().props.onKeyDown(keyEvent);
    assert.deepEqual(selectors, [], "a hidden retained panel must not focus its own tabs");
    fixture.store.state.sheet = null;
    props.visible = true;
    render(inline);
    tabs().props.onKeyDown(keyEvent);
    await flush();
    assert.deepEqual(selectors, ["#home-import-import-tab-history"]);
    const selectedTab = find(
        inline,
        (node) => node.props.role === "tab" && node.props["aria-selected"],
    );
    const tabPanel = find(inline, (node) => node.props.role === "tabpanel");

    assert.equal(selectedTab.props["aria-controls"], tabPanel.props.id);
    assert.equal(tabPanel.props["aria-labelledby"], selectedTab.props.id);
    const picker = mountImportChild(inline, (props) => typeof props.onManual === "function");

    t.after(() => dispose(picker));
    await flush();
    assert.equal(field(picker, "home-import-import-history-search").props.type, "search");
    button(picker, "Choose a file or branch").props.onClick();
    await flush();
    const labels = nodes(inline.tree).filter((node) => node.type === "label" && node.props.for);

    assert.equal(labels.length, 2);

    for (const label of labels) {
        assert.ok(label.props.for.startsWith("home-import-"));
        assert.equal(field(inline, label.props.for).type, "input");
    }
});

test("inline imports recheck live opening, activity, access and reviewed destination before dispatch and completion", async (t) => {
    const changes: [string, (props: Props, host: Props) => void, boolean?][] = [
        ["hidden panel", (props) => (props.visible = false)],
        ["another Home source without a render", () => (fixture.store.state.homeSource = "new")],
        ["retired opening without a sheet change", (_props, host) => (host.current = false)],
        ["updated lifetime predicate", (props) => (props.isCurrentOpening = () => false)],
        ["updated activity predicate", (props) => (props.isActive = () => false)],
        ["another account", () => (fixture.store.state.me.id = "other-owner")],
        [
            "revoked guest history access",
            () => (fixture.store.state.me.continuePiSessions = false),
            true,
        ],
        ["new guest project scope", () => (fixture.store.state.me.projectAccess = {}), true],
        ["removed project", () => (fixture.store.state.projects = [])],
        ["renamed project", () => (fixture.store.state.projects[0].name = "New audience")],
        [
            "changed project destination",
            () => (fixture.store.state.projects[0].cwd = "/replacement"),
        ],
    ];

    for (const phase of ["before dispatch", "late success", "late failure"]) {
        for (const [name, change, guest] of changes) {
            await t.test(`${name}: ${phase}`, async (t) => {
                reset();
                fixture.store.state.sheet = null;
                fixture.store.state.homeSource = "import";
                fixture.store.state.projects = projects.map((project) => ({ ...project }));

                if (guest) {
                    fixture.store.state.me = {
                        id: "guest",
                        role: "guest",
                        continuePiSessions: true,
                    };
                }

                const requests = holdApi();
                const host = { current: true };
                const completed: number[] = [];
                const created: number[] = [];
                const props: Props = {
                    initialPreview: importPreview(),
                    visible: true,
                    isCurrentOpening: () => host.current,
                    isActive: () => fixture.store.state.homeSource === "import",
                    onComplete: (id: number) => completed.push(id),
                    onCreated: (id: number) => created.push(id),
                };
                const panel = mount(() => ImportPanel(props));

                t.after(() => dispose(panel));
                await flush();

                if (!guest) {
                    await changeField(panel, "import-project", "local");
                }

                await changeField(panel, "import-consent", true);
                const retained = find(panel, (node) => node.type === "form").props.onSubmit;
                const saving = phase === "before dispatch" ? null : submit(panel);

                change(props, host);

                if (name === "hidden panel" || name.startsWith("updated")) {
                    render(panel);
                }

                const staleDispatch = retained({ preventDefault() {} });

                assert.equal(requests.length, phase === "before dispatch" ? 0 : 1);

                if (phase !== "before dispatch") {
                    if (phase === "late success") {
                        requests[0]!.resolve({ id: 49 });
                    } else {
                        requests[0]!.reject(new Error("Expired inline import failure"));
                    }
                }

                await Promise.all([saving, staleDispatch]);
                await flush();
                assert.deepEqual(completed, []);
                assert.deepEqual(created, []);
                assert.deepEqual(fixture.notified, []);
                assert.deepEqual(fixture.closed, []);
                assert.deepEqual(fixture.navigated, []);
                assert.doesNotMatch(textOf(panel.tree), /Expired inline import failure/);
            });
        }
    }
});

// Mount children from the actual ImportPanel tree so SavedSessions' own deferred reads and
// folder callbacks run through production code, while the shared fixture supplies only hooks/API.
function mountImportChild(parent: Mount, predicate: (props: Props) => boolean): Mount {
    return mount(() => {
        const node = find(
            parent,
            (node) => typeof node.type === "function" && predicate(node.props),
        );

        return (node.type as (props: Props) => unknown)(node.props);
    });
}

async function prepareImportSource(source: string, t: { after: (fn: () => void) => void }) {
    reset();
    fixture.store.state.sheet = null;
    fixture.store.state.homeSource = "import";
    const requests = holdApi();
    const host = { current: true };
    const completed: number[] = [];
    const busy: boolean[] = [];
    const props: Props = {
        visible: true,
        isCurrentOpening: () => host.current,
        isActive: () => fixture.store.state.homeSource === "import",
        onComplete: (id: number) => completed.push(id),
        onBusyChange: (value: boolean) => busy.push(value),
    };
    const panel = mount(() => ImportPanel(props));

    t.after(() => dispose(panel));
    await flush();
    assert.equal(requests[0]!.path, "pi-sessions/active");
    requests[0]!.resolve({
        sessions: [
            {
                id: "live-source",
                title: "A live Pi",
                cwd: "/local",
                location: "local",
                state: "idle",
            },
        ],
        warnings: [],
    });
    await flush();
    let picker = panel;

    if (source !== "live") {
        button(panel, "History").props.onClick();
        await flush();
        picker = mountImportChild(panel, (props) => typeof props.onManual === "function");
        t.after(() => dispose(picker));
        await flush();
        assert.equal(requests[1]!.path, "pi-sessions/history");
        requests[1]!.resolve({
            sessions: [
                { path: "/history/session.jsonl", title: "A saved Pi", cwd: "/local", messages: 1 },
            ],
            warnings: [],
        });
        await flush();
    }

    let read: () => Promise<unknown>;

    if (source === "manual") {
        button(picker, "Choose a file or branch").props.onClick();
        await flush();
        field(panel, "import-path").props.onInput({
            currentTarget: { value: " /history/manual.jsonl " },
        });
        field(panel, "import-leaf").props.onInput({ currentTarget: { value: " branch-entry " } });
        await flush();
        read = () => submit(panel);
    } else {
        const folders = mountImportChild(picker, (props) => Array.isArray(props.sessions));

        t.after(() => dispose(folders));

        read = () => {
            render(picker);
            render(folders);

            return find(folders, (node) => node.type === "button").props.onClick();
        };
    }

    return { panel, picker, requests, props, host, completed, busy, read };
}

test("Live, History and Advanced import use one guarded preview and recoverable confirmation", async (t) => {
    for (const source of ["live", "saved", "manual"]) {
        await t.test(source, async (t) => {
            const { panel, requests, completed, busy, read } = await prepareImportSource(source, t);
            const first = read();

            assert.deepEqual(
                busy,
                [false, true],
                "every source closes Home's pending gate synchronously",
            );
            const repeated = read();
            const request = requests.at(-1)!;

            assert.equal(
                requests.length,
                source === "live" ? 2 : 3,
                "one preview admission even through retained callbacks",
            );
            assert.equal(
                request.path,
                source === "live" ? "pi-sessions/active/preview" : "pi-sessions/preview",
            );
            assert.deepEqual(
                request.body,
                source === "live"
                    ? { id: "live-source" }
                    : source === "saved"
                      ? { path: "/history/session.jsonl" }
                      : { path: "/history/manual.jsonl", leafId: "branch-entry" },
            );
            request.resolve(importPreview(source === "live" ? { activeId: "live-source" } : {}));
            await Promise.all([first, repeated]);
            await flush();
            assert.match(textOf(panel.tree), /Saved conversation/);
            assert.equal(field(panel, "import-model").props.value, "provider/one");
            assert.equal(field(panel, "import-thinking").props.value, "low");
            await changeField(panel, "import-consent", true);
            const copying = submit(panel);

            requests.at(-1)!.reject(new Error("Temporary copy failure"));
            await copying;
            await flush();
            assert.match(textOf(panel.tree), /Temporary copy failure/);
            assert.equal(field(panel, "import-consent").props.checked, true);
            assert.equal(Boolean(button(panel, "Move").props.disabled), false);
            const retry = submit(panel);

            requests.at(-1)!.resolve({ id: 50 });
            await retry;
            await flush();
            assert.deepEqual(completed, [50]);
            assert.deepEqual(fixture.closed, []);
            assert.deepEqual(fixture.navigated, []);
        });
    }
});

test("all import source previews fence late successes and errors from hidden, retired or changed-access hosts", async (t) => {
    for (const source of ["live", "saved", "manual"]) {
        for (const change of ["hidden", "retired", "account", "access", "source"]) {
            for (const failure of [false, true]) {
                await t.test(
                    `${source}, ${change}, ${failure ? "error" : "preview"}`,
                    async (t) => {
                        const { panel, picker, requests, props, host, read } =
                            await prepareImportSource(source, t);
                        const reading = read();
                        const request = requests.at(-1)!;

                        if (change === "hidden") {
                            props.visible = false;
                            render(panel);
                        } else if (change === "retired") {
                            host.current = false;
                        } else if (change === "account") {
                            fixture.store.state.me.id = "other-owner";
                        } else if (change === "access") {
                            fixture.store.state.me.role = "viewer";
                        } else {
                            fixture.store.state.homeSource = "new";
                        }

                        if (failure) {
                            request.reject(new Error("Abandoned preview error"));
                        } else {
                            request.resolve(importPreview({ title: "Abandoned preview" }));
                        }

                        await reading;
                        await flush();
                        assert.doesNotMatch(textOf(panel.tree), /Abandoned preview/);
                        assert.doesNotMatch(textOf(picker.tree), /Abandoned preview/);
                        assert.equal(
                            nodes(panel.tree).some((node) => node.props.id === "import-preview"),
                            false,
                        );
                        assert.deepEqual(fixture.notified, []);
                    },
                );
            }
        }
    }
});

test("late Live and History catalogues cannot populate a hidden, replaced or changed-account host", async (t) => {
    for (const source of ["live", "saved"]) {
        for (const change of ["hidden", "retired", "account", "access"]) {
            for (const failure of [false, true]) {
                await t.test(
                    `${source}, ${change}, ${failure ? "error" : "listing"}`,
                    async (t) => {
                        reset();
                        fixture.store.state.sheet = null;
                        const requests = holdApi();
                        const host = { current: true };
                        const props: Props = {
                            visible: true,
                            isCurrentOpening: () => host.current,
                        };
                        const panel = mount(() => ImportPanel(props));

                        t.after(() => dispose(panel));
                        await flush();
                        let picker = panel;

                        if (source === "saved") {
                            requests[0]!.resolve({ sessions: [], warnings: [] });
                            await flush();
                            button(panel, "History").props.onClick();
                            await flush();
                            picker = mountImportChild(
                                panel,
                                (props) => typeof props.onManual === "function",
                            );
                            t.after(() => dispose(picker));
                            await flush();
                        }

                        const request = requests.at(-1)!;
                        const refresh = find(
                            picker,
                            (node) => node.type === "button" && /Refresh/.test(textOf(node)),
                        ).props.onClick;

                        if (change === "hidden") {
                            props.visible = false;
                            render(panel);
                        } else if (change === "retired") {
                            host.current = false;
                        } else if (change === "account") {
                            fixture.store.state.me.id = "other-owner";
                        } else {
                            fixture.store.state.me.role = "viewer";
                        }

                        if (failure) {
                            request.reject(new Error("Abandoned catalogue error"));
                        } else {
                            request.resolve({
                                sessions: [
                                    {
                                        id: "abandoned",
                                        path: "/abandoned",
                                        cwd: "/abandoned",
                                        title: "Abandoned catalogue",
                                    },
                                ],
                                warnings: [],
                            });
                        }

                        await flush();
                        assert.equal(
                            nodes(picker.tree).some((node) => node.props.sessions?.length > 0),
                            false,
                        );
                        assert.doesNotMatch(textOf(picker.tree), /Abandoned catalogue/);
                        const count = requests.length;

                        refresh();
                        await flush();
                        assert.equal(
                            requests.length,
                            count,
                            "a retained refresh cannot read for an abandoned host",
                        );
                    },
                );
            }
        }
    }
});

test("import conflicts preserve retry inputs but require a fresh reviewed source and consent", async (t) => {
    for (const source of ["saved", "manual", "private-pane"]) {
        await t.test(source, async (t) => {
            let panel: Mount;
            let requests: ReturnType<typeof holdApi>;
            let read: (() => Promise<unknown>) | undefined;

            if (source === "private-pane") {
                reset();
                fixture.store.state.sheet = { type: "import" };
                requests = holdApi();
                const preview = importPreview();

                panel = mount(() => ImportPanel({ initialPreview: preview, fromPrivate: true }));
                t.after(() => dispose(panel));
                await flush();
            } else {
                ({ panel, requests, read } = await prepareImportSource(source, t));
                const reading = read!();

                requests.at(-1)!.resolve(importPreview());
                await reading;
                await flush();
            }

            await changeField(panel, "import-consent", true);
            const oldSubmit = find(panel, (node) => node.type === "form").props.onSubmit;
            const copying = submit(panel);

            requests
                .at(-1)!
                .reject(Object.assign(new Error("Source changed: preview again"), { status: 409 }));
            await copying;
            await flush();
            assert.match(textOf(panel.tree), /Source changed: preview again/);
            const count = requests.length;
            const stale = oldSubmit({ preventDefault() {} });

            assert.equal(
                requests.length,
                count,
                "conflicted consent is invalid even through an old form",
            );
            await stale;

            if (source === "private-pane") {
                assert.match(textOf(panel.tree), /Saved conversation/);
                assert.equal(field(panel, "import-consent").props.checked, false);
            } else {
                assert.equal(
                    nodes(panel.tree).some((node) => node.props.id === "import-preview"),
                    false,
                );

                if (source === "manual") {
                    assert.equal(
                        field(panel, "import-path").props.value,
                        " /history/manual.jsonl ",
                    );
                    assert.equal(field(panel, "import-leaf").props.value, " branch-entry ");
                }

                const rereading = read!();

                requests
                    .at(-1)!
                    .resolve(importPreview({ sha256: "c".repeat(64), title: "Fresh source" }));
                await rereading;
                await flush();
                assert.match(textOf(panel.tree), /Fresh source/);
                assert.equal(field(panel, "import-consent").props.checked, false);
                await changeField(panel, "import-consent", true);
                const retry = submit(panel);

                assert.equal(requests.at(-1)!.body.sha256, "c".repeat(64));
                requests.at(-1)!.resolve({ id: 51 });
                await retry;
            }
        });
    }
});

test("saved and live import confirmations send the reviewed source and destination only once", async (t) => {
    for (const active of [false, true]) {
        await t.test(active ? "shared live snapshot" : "private saved snapshot", async () => {
            reset();
            const opening = { type: "import" };
            const requests = holdApi();
            const created: number[] = [];
            const preview = importPreview(active ? { activeId: "live-source" } : {});

            fixture.store.state.sheet = opening;
            const panel = mount(() =>
                ImportPanel({
                    initialPreview: preview,
                    onCreated: (id: number) => created.push(id),
                }),
            );

            await flush();
            await changeField(panel, "import-model", "provider/two");
            await changeField(panel, "import-thinking", "high");
            await changeField(panel, "import-visibility", active ? "shared" : "owner");
            await changeField(panel, "import-project", "local");
            await changeField(panel, "import-consent", true);
            const first = submit(panel);
            const second = submit(panel);

            await flush();
            assert.equal(requests.length, 1, "a second click cannot start another copy");
            assert.deepEqual(
                [requests[0]!.path, requests[0]!.body],
                [
                    active ? "pi-sessions/active" : "pi-sessions/continue",
                    {
                        ...(active ? { id: "live-source" } : { path: "/history/session.jsonl" }),
                        sha256: "a".repeat(64),
                        leafId: "saved-leaf",
                        model: "provider/two",
                        thinkingLevel: "high",
                        visibility: active ? "shared" : "owner",
                        projectId: "local",
                        acknowledged: true,
                    },
                ],
            );
            assert.equal(field(panel, "import-consent").props.disabled, true);
            requests[0]!.resolve({ id: 45 });
            await Promise.all([first, second]);
            await flush();
            assert.deepEqual(fixture.navigated, [45]);
            assert.deepEqual(fixture.closed, [opening]);
            assert.deepEqual(created, [45]);
            dispose(panel);
        });
    }
});

test("guest imports, private-pane moves and already-shared previews cannot request Private", async (t) => {
    for (const kind of ["guest", "private-pane", "already-shared"]) {
        await t.test(kind, async () => {
            reset();
            const requests = holdApi();
            const preview = importPreview(
                kind === "already-shared" ? { existing: 45, visibility: "shared" } : {},
            );

            fixture.store.state.sheet = { type: "import" };

            if (kind === "guest") {
                fixture.store.state.me = { id: "guest", role: "guest", continuePiSessions: true };
            }

            const panel = mount(() =>
                ImportPanel({
                    initialPreview: preview,
                    fromPrivate: kind === "private-pane",
                }),
            );

            await flush();
            assert.equal(field(panel, "import-visibility").props.value, "shared");
            assert.equal(field(panel, "import-visibility").props.disabled, true);

            if (kind === "guest") {
                assert.equal(
                    nodes(panel.tree).some((node) => node.props.id === "import-project"),
                    false,
                );
            }

            await changeField(panel, "import-visibility", "owner");
            assert.equal(field(panel, "import-visibility").props.value, "shared");
            await changeField(panel, "import-consent", true);
            const saving = submit(panel);

            assert.equal(requests.length, 1);
            assert.equal(requests[0]!.body.visibility, "shared");
            assert.equal(requests[0]!.body.projectId, kind === "guest" ? undefined : null);
            requests[0]!.resolve({ id: 45 });
            await saving;
            await flush();
            dispose(panel);
        });
    }
});

test("import confirmations reject a replacement preview until its new source is acknowledged", async () => {
    reset();
    fixture.store.state.sheet = { type: "import" };
    const requests = holdApi();
    let preview = importPreview();
    const panel = mount(() => ImportPanel({ initialPreview: preview }));

    await flush();
    await changeField(panel, "import-consent", true);
    const oldSubmit = find(panel, (node) => node.type === "form").props.onSubmit;

    preview = importPreview({
        path: "/history/other.jsonl",
        sha256: "b".repeat(64),
        leafId: "new-leaf",
    });
    render(panel);
    await flush();
    assert.equal(field(panel, "import-consent").props.checked, false);
    const staleDispatch = oldSubmit({ preventDefault() {} });
    const unacknowledgedDispatch = submit(panel);

    await flush();
    assert.equal(requests.length, 0);
    await Promise.all([staleDispatch, unacknowledgedDispatch]);
    await changeField(panel, "import-consent", true);
    const saving = submit(panel);

    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.body.path, "/history/other.jsonl");
    assert.equal(requests[0]!.body.sha256, "b".repeat(64));
    assert.equal(requests[0]!.body.leafId, "new-leaf");
    requests[0]!.resolve({ id: 46 });
    await saving;
    await flush();
    dispose(panel);
});

const lifecycleChanges: [string, (instance: Mount) => void][] = [
    [
        "another owner account",
        () => {
            fixture.store.state.me = { id: "other-owner", role: "owner" };
        },
    ],
    [
        "guest with import access",
        () => {
            fixture.store.state.me = { id: "owner", role: "guest", continuePiSessions: true };
        },
    ],
    [
        "a newer opening of the same sheet",
        () => {
            fixture.store.state.sheet = { ...fixture.store.state.sheet };
        },
    ],
    ["component disposal", dispose],
];

test("import callbacks cannot dispatch or finish into a changed account, opening or disposed panel", async (t) => {
    for (const phase of ["before dispatch", "while copying"]) {
        for (const [name, change] of lifecycleChanges) {
            await t.test(`${name}, ${phase}`, async () => {
                reset();
                fixture.store.state.sheet = { type: "import" };
                const requests = holdApi();
                const created: number[] = [];
                const preview = importPreview();
                const panel = mount(() =>
                    ImportPanel({
                        initialPreview: preview,
                        onCreated: (id: number) => created.push(id),
                    }),
                );

                await flush();
                await changeField(panel, "import-consent", true);
                const oldSubmit = find(panel, (node) => node.type === "form").props.onSubmit;
                const saving = phase === "while copying" ? submit(panel) : null;

                change(panel);

                if (!panel.disposed) {
                    render(panel);
                }

                const staleDispatch = oldSubmit({ preventDefault() {} });

                await flush();

                if (phase === "while copying") {
                    assert.equal(requests.length, 1);
                    requests[0]!.resolve({ id: 47 });
                    await saving;
                } else {
                    assert.equal(requests.length, 0);
                }

                await staleDispatch;
                await flush();
                assert.deepEqual(fixture.closed, [], "the newer sheet stays open");
                assert.deepEqual(fixture.navigated, []);
                assert.deepEqual(created, []);
                dispose(panel);
            });
        }
    }
});

function privateImportRow(patch: Props = {}) {
    return {
        id: 71,
        title: "Continued imported Chat",
        imported: true,
        ownerOnly: true,
        threadType: "chat",
        ...patch,
    };
}

test("Share imported Chat confirms its selected target and optional project only once", async (t) => {
    for (const projectId of ["local", ""]) {
        await t.test(projectId || "no project", async () => {
            reset();
            const opening = { type: "share-import", id: 71 };
            const requests = holdApi();

            fixture.store.state.sheet = opening;
            fixture.store.state.conversationId = 99;
            fixture.store.state.sessions = [privateImportRow(), privateImportRow({ id: 99 })];
            const sheet = mount(() => ShareImportSheet({ id: 71 }));

            await flush();
            assert.equal(field(sheet, "share-import-project").type, "select");
            const unacknowledgedDispatch = submit(sheet);

            await flush();
            assert.equal(requests.length, 0, "sharing requires explicit consent");
            await unacknowledgedDispatch;
            await changeField(sheet, "share-import-consent", true);
            const oldSubmit = find(sheet, (node) => node.type === "form").props.onSubmit;

            await changeField(sheet, "share-import-project", projectId || "a");
            assert.equal(field(sheet, "share-import-consent").props.checked, false);
            const staleDispatch = oldSubmit({ preventDefault() {} });

            await flush();
            assert.equal(
                requests.length,
                0,
                "a retained confirmation cannot use the old project consent",
            );
            await staleDispatch;

            if (!projectId) {
                await changeField(sheet, "share-import-project", "");
            }

            await changeField(sheet, "share-import-consent", true);
            const first = submit(sheet);
            const second = submit(sheet);

            assert.equal(requests.length, 1);
            assert.equal(requests[0]!.path, "pi-sessions/71/share");
            assert.equal(requests[0]!.body.acknowledged, true);
            assert.equal(requests[0]!.body.projectId ?? null, projectId || null);
            assert.ok(
                Object.keys(requests[0]!.body).every((key) =>
                    ["acknowledged", "projectId"].includes(key),
                ),
            );
            // The room event may arrive before the POST response; it must not suppress this success.
            fixture.store.state.sessions[0].ownerOnly = false;
            render(sheet);
            requests[0]!.resolve({ id: 71 });
            await Promise.all([first, second]);
            await flush();
            assert.deepEqual(fixture.closed, [opening]);
            assert.deepEqual(fixture.navigated, [], "sharing does not switch the viewed Chat");
            dispose(sheet);
        });
    }
});

test("share callbacks are bound to the owner, target and sheet opening across late responses", async (t) => {
    const changes: [string, (instance: Mount) => void][] = [
        ...lifecycleChanges,
        [
            "a different target sheet",
            () => {
                fixture.store.state.sheet = { type: "share-import", id: 99 };
            },
        ],
    ];

    for (const phase of ["before dispatch", "while sharing"]) {
        for (const [name, change] of changes) {
            await t.test(`${name}, ${phase}`, async () => {
                reset();
                fixture.store.state.sheet = { type: "share-import", id: 71 };
                fixture.store.state.sessions = [privateImportRow(), privateImportRow({ id: 99 })];
                const requests = holdApi();
                const sheet = mount(() => ShareImportSheet({ id: 71 }));

                await flush();
                await changeField(sheet, "share-import-consent", true);
                const oldSubmit = find(sheet, (node) => node.type === "form").props.onSubmit;
                const saving = phase === "while sharing" ? submit(sheet) : null;

                change(sheet);

                if (!sheet.disposed) {
                    render(sheet);
                }

                const staleDispatch = oldSubmit({ preventDefault() {} });

                await flush();

                if (phase === "while sharing") {
                    assert.equal(requests.length, 1);
                    requests[0]!.resolve({ id: 71 });
                    await saving;
                } else {
                    assert.equal(requests.length, 0);
                }

                await staleDispatch;
                await flush();
                assert.deepEqual(fixture.closed, []);
                assert.deepEqual(fixture.navigated, []);
                dispose(sheet);
            });
        }
    }
});

test("sidebar and Chat menu sharing are owner-only and offered only for an independent private imported Chat", async () => {
    for (const [role, patch, offered] of [
        ["owner", {}, true],
        ["guest", {}, false],
        ["owner", { ownerOnly: false }, false],
        ["owner", { imported: false }, false],
        ["owner", { workItemId: "work" }, false],
        ["owner", { forkedFrom: 12 }, false],
    ] as const) {
        reset();
        fixture.store.state.me.role = role;
        fixture.store.state.conversationId = 99;
        fixture.store.state.sheet = { type: "sidebar-options", kind: "thread", id: 71 };
        fixture.store.state.sessions = [privateImportRow(patch)];
        const menu = mount(() => SidebarOptions({ kind: "thread", id: 71 }));
        const share = nodes(menu.tree).find(
            (node) => node.type === "button" && textOf(node).trim() === "Share imported Chat…",
        );

        assert.equal(Boolean(share), offered, `${role}: ${JSON.stringify(patch)}`);

        if (share) {
            await share.props.onClick();
            await flush();
            assert.deepEqual(fixture.opened, [{ type: "share-import", id: 71 }]);
            assert.deepEqual(fixture.navigated, []);
        }

        dispose(menu);
        const { workItemId, ...conversation } = fixture.store.state.sessions[0];

        fixture.store.state.view.conversation = {
            ...conversation,
            kind: "session",
            ...(workItemId ? { workflow: { workItemId } } : {}),
        };
        fixture.store.state.view.subagents = [];
        const chatMenu = mount(() => MenuSheet({ places: false }));

        assert.equal(
            nodes(chatMenu.tree).some(
                (node) => node.type === "button" && textOf(node).startsWith("Share imported Chat…"),
            ),
            offered,
            `Chat menu ${role}: ${JSON.stringify(patch)}`,
        );
        dispose(chatMenu);
    }
});

test("unchecking consent invalidates retained acknowledged import and share submissions", async (t) => {
    for (const sharing of [false, true]) {
        await t.test(sharing ? "share" : "import", async () => {
            reset();
            fixture.store.state.sheet = { type: sharing ? "share-import" : "import", id: 71 };
            fixture.store.state.sessions = [privateImportRow()];
            const requests = holdApi();
            const preview = importPreview();
            const panel = mount(() =>
                sharing ? ShareImportSheet({ id: 71 }) : ImportPanel({ initialPreview: preview }),
            );
            const consentId = sharing ? "share-import-consent" : "import-consent";

            await flush();
            await changeField(panel, consentId, true);
            const oldSubmit = find(panel, (node) => node.type === "form").props.onSubmit;

            await changeField(panel, consentId, false);
            const dispatch = oldSubmit({ preventDefault() {} });

            await flush();
            assert.equal(
                requests.length,
                0,
                "withdrawn consent cannot be restored by an old callback",
            );
            await dispatch;
            dispose(panel);
        });
    }
});

test("retained share confirmations recheck that the selected row is still an independent private import", async (t) => {
    for (const patch of [
        { ownerOnly: false },
        { imported: false },
        { workItemId: "new-work" },
        { forkedFrom: 12 },
    ]) {
        await t.test(JSON.stringify(patch), async () => {
            reset();
            fixture.store.state.sheet = { type: "share-import", id: 71 };
            fixture.store.state.sessions = [privateImportRow()];
            const requests = holdApi();
            const sheet = mount(() => ShareImportSheet({ id: 71 }));

            await flush();
            await changeField(sheet, "share-import-consent", true);
            const oldSubmit = find(sheet, (node) => node.type === "form").props.onSubmit;

            fixture.store.state.sessions = [privateImportRow(patch)];
            render(sheet);
            const dispatch = oldSubmit({ preventDefault() {} });

            await flush();
            assert.equal(requests.length, 0);
            await dispatch;
            assert.deepEqual(fixture.closed, []);
            dispose(sheet);
        });
    }
});

test("a retained sidebar Share action cannot open for a new account, opening or ineligible target", async (t) => {
    for (const [name, change] of [
        [
            "another owner",
            () => {
                fixture.store.state.me = { id: "another-owner", role: "owner" };
            },
        ],
        [
            "guest",
            () => {
                fixture.store.state.me.role = "guest";
            },
        ],
        [
            "newer sheet",
            () => {
                fixture.store.state.sheet = { type: "sidebar-options", kind: "thread", id: 71 };
            },
        ],
        [
            "already shared",
            () => {
                fixture.store.state.sessions[0].ownerOnly = false;
            },
        ],
        [
            "grouped",
            () => {
                fixture.store.state.sessions[0].workItemId = "work";
            },
        ],
    ] as const) {
        await t.test(name, async () => {
            reset();
            fixture.store.state.sheet = { type: "sidebar-options", kind: "thread", id: 71 };
            fixture.store.state.sessions = [privateImportRow()];
            const menu = mount(() => SidebarOptions({ kind: "thread", id: 71 }));
            const oldShare = button(menu, "Share imported Chat…").props.onClick;

            change();
            render(menu);
            await oldShare();
            await flush();
            assert.deepEqual(fixture.opened, []);
            assert.deepEqual(fixture.closed, [], "stale options must not close a newer sheet");
            dispose(menu);
        });
    }
});

test("Work Item options offer only optional Limits for the selected PiP Thread", async () => {
    for (const state of [undefined, "running", "paused", "reclaimed"]) {
        reset();
        fixture.store.state.conversationId = 2;
        fixture.store.state.sessions = [
            {
                id: 1,
                workItemId: "selected-work",
                supervisor: state ? { conversationId: 99, status: state } : undefined,
            },
            { id: 2, workItemId: "other-work" },
        ];
        const menu = mount(() => SidebarOptions({ kind: "work-item", id: 1 }));
        const pipLabels = nodes(menu.tree)
            .filter((node) => node.type === "button")
            .map((node) => textOf(node).trim())
            .filter((label) => /PiP|Reclaim work|Limits/.test(label));

        assert.deepEqual(pipLabels, state ? ["Limits…"] : [], String(state));

        if (state) {
            await button(menu, "Limits…").props.onClick();
            const sheet = fixture.opened.at(-1)!;

            assert.equal(sheet.type, "work-item-limits");
            assert.equal(sheet.id, 1);
            assert.equal(sheet.workItemId, "selected-work");
            assert.equal(sheet.viewId, 2);
            assert.equal(sheet.userId, "owner");
        }

        assert.deepEqual(fixture.navigated, [], "Limits never changes the viewed thread");
    }
});

test("Limits reject stale owner, item, controller, state, epoch, view and menu and never appear on child menus", async () => {
    for (const mutation of [
        (state: Props) => (state.me = { id: "owner", role: "guest" }),
        (state: Props) => (state.me = { id: "another-owner", role: "owner" }),
        (state: Props) => (state.sessions = []),
        (state: Props) => (state.sessions[0].workItemId = "replacement-work"),
        (state: Props) => (state.sessions[0].supervisor.status = "reclaimed"),
        (state: Props) => (state.sessions[0].supervisor.epoch = 2),
        (state: Props) => (state.sessions[0].supervisor.conversationId = 100),
        (state: Props) => (state.sessions[0].archived = true),
        (state: Props) => (state.conversationId = 3),
        (state: Props) => (state.sheet = { type: "another-menu" }),
    ]) {
        reset();
        fixture.store.state.sessions = [
            {
                id: 1,
                workItemId: "selected-work",
                supervisor: { conversationId: 99, status: "paused", epoch: 1 },
            },
        ];
        const menu = mount(() => SidebarOptions({ kind: "work-item", id: 1 }));
        const staleLimits = button(menu, "Limits…");

        mutation(fixture.store.state);
        await staleLimits.props.onClick();
        assert.deepEqual(fixture.opened, []);
        assert.deepEqual(fixture.navigated, []);
    }

    for (const [kind, role, archived] of [
        ["thread", "owner", false],
        ["work-item", "guest", false],
        ["work-item", "owner", true],
    ]) {
        reset();
        fixture.store.state.me.role = role;
        fixture.store.state.sessions = [
            {
                id: 1,
                workItemId: "work",
                archived,
                supervisor: { conversationId: 99, status: "paused" },
            },
        ];
        const menu = mount(() => SidebarOptions({ kind, id: 1 }));

        assert.doesNotMatch(textOf(menu.tree), /Resume PiP|Reclaim work|Limits/);
    }
});

function chooseFilter(instance: Mount, label: string) {
    const filter = child(instance, ProjectFilters);
    const rendered = mount(() => ProjectFilters(filter.props));

    button(rendered, label).props.onClick();
}

test("project quick grants are dynamic, machine-scoped and preserve individual choices", async () => {
    reset();
    let access: Props = {};
    let picker: Mount;

    const change = (value: Props) => {
        access = value;
        render(picker);
    };

    picker = mount(() => ProjectAccessPicker({ value: access, onChange: change }));
    assert.match(textOf(picker.tree), /No project access selected/);
    assert.equal(checkbox(picker, "Remote app").props.checked, false);
    checkbox(picker, "Remote app").props.onChange({ currentTarget: { checked: true } });
    assert.deepEqual({ ...access }, { projectIds: ["a"] });
    chooseFilter(picker, "machine-b");
    await flush();
    assert.equal(
        nodes(picker.tree).some((node) => node.props["aria-label"] === "Remote app"),
        false,
    );
    find(picker, (node) => node.type === "input" && node.props["aria-describedby"]).props.onChange({
        currentTarget: { checked: true },
    });
    assert.deepEqual({ ...access }, { projectIds: ["a"], hosts: ["machine-b"] });
    fixture.store.state.projects.push({
        id: "future",
        name: "Future B",
        cwd: "/new",
        location: { kind: "ssh", host: "machine-b" },
    });
    render(picker);
    assert.equal(checkbox(picker, "Future B").props.checked, true);
    assert.equal(checkbox(picker, "Future B").props.disabled, true);
    chooseFilter(picker, "Local");
    await flush();
    find(picker, (node) => node.type === "input" && node.props["aria-describedby"]).props.onChange({
        currentTarget: { checked: true },
    });
    assert.equal(access.local, true);
    chooseFilter(picker, "All");
    await flush();
    find(picker, (node) => node.type === "input" && node.props["aria-describedby"]).props.onChange({
        currentTarget: { checked: true },
    });
    assert.ok(access.all);
    assert.ok(checkbox(picker, "Remote app").props.disabled);
    find(picker, (node) => node.type === "input" && node.props["aria-describedby"]).props.onChange({
        currentTarget: { checked: false },
    });
    assert.deepEqual({ ...access }, { projectIds: ["a"], hosts: ["machine-b"], local: true });
    assert.equal(checkbox(picker, "Remote app").props.checked, true);
    assert.equal(checkbox(picker, "Remote app").props.disabled, false);
    assert.match(textOf(picker.tree), /Includes future projects/);
});

test("invite project changes revoke shown codes, fence late replies and reject missing grant acknowledgements", async (t) => {
    reset();
    const requests: { body: Props; resolve: (answer: Props) => void }[] = [];
    const cancelled: string[] = [];

    fixture.api = async (_path, body) => new Promise((resolve) => requests.push({ body, resolve }));
    t.mock.method(
        globalThis,
        "fetch",
        async (_url: Parameters<typeof fetch>[0], options?: RequestInit) => {
            cancelled.push(JSON.parse(String(options?.body)).code);

            return Response.json({});
        },
    );
    const sheet = mount(() => InviteSheet({}));
    const answer = (index: number, code: string, grant = requests[index]!.body) =>
        requests[index]!.resolve({
            code,
            minutes: 15,
            url: `https://example.test/${code}`,
            svg: "",
            grant,
        });

    await flush();
    assert.deepEqual(requests[0]!.body.projectAccess, {});
    assert.equal(requests[0]!.body.continuePiSessions, undefined);
    assert.doesNotMatch(textOf(sheet.tree), /Continue Pi sessions/);
    answer(0, "initial-code");
    await flush();
    assert.match(textOf(sheet.tree), /initial-code/);
    child(sheet, ProjectAccessPicker).props.onChange({ hosts: ["machine-a"] });
    await flush();
    assert.ok(cancelled.includes("initial-code"));
    assert.doesNotMatch(textOf(sheet.tree), /initial-code/);
    child(sheet, ProjectAccessPicker).props.onChange({ projectIds: ["b"] });
    await flush();
    answer(1, "stale-code");
    await flush();
    assert.ok(cancelled.includes("stale-code"));
    answer(2, "wrong-code", { role: "guest" });
    await flush();
    assert.ok(cancelled.includes("wrong-code"));
    assert.ok(fixture.errors.some((error) => error.includes("project access")));
    button(sheet, "New invite").props.onClick();
    await flush();
    answer(3, "valid-code");
    await flush();
    assert.match(textOf(sheet.tree), /valid-code/);
    assert.deepEqual(requests[3]!.body.projectAccess, { projectIds: ["b"] });
    button(sheet, "New invite").props.onClick();
    await flush();
    answer(4, "history-code", { ...requests[4]!.body, continuePiSessions: true });
    await flush();
    assert.ok(cancelled.includes("history-code"));
    assert.doesNotMatch(textOf(sheet.tree), /history-code/);
    assert.ok(fixture.errors.some((error) => error.includes("local Pi history")));
});

test("collaborators create only inside granted project defaults while owner disclosure and overrides remain", async () => {
    reset();
    fixture.store.state.me.role = "guest";
    const created: unknown[][] = [];

    fixture.actions.createSession = async (...args: unknown[]) => {
        created.push(args);

        return { id: 44 };
    };

    const props = { projectId: "a", cwd: "/not-granted", visible: true, onBusyChange() {} };
    const panel = mount(() => ProjectSessionPanel(props));

    assert.doesNotMatch(textOf(panel.tree), /New Project|one-time chat|Own Git worktree/);
    const fieldProps = child(panel, WorkspaceField).props;
    const field = mount(() => WorkspaceField(fieldProps));

    assert.equal(
        nodes(field.tree).some((node) => node.type === "button"),
        false,
    );
    assert.match(textOf(field.tree), /\/a/);
    await button(panel, "Start Worker").props.onClick();
    await flush();
    assert.equal(created[0]![0], "/a");
    assert.deepEqual(created[0]![1], {
        location: { kind: "ssh", host: "machine-a" },
        threadType: "worker",
        projectId: "a",
        worktree: false,
        requestId: "request",
    });
    assert.deepEqual(fixture.remembered, []);
    assert.deepEqual(fixture.navigated, [44]);
    const form = mount(() => ProjectForm({}));

    assert.equal(
        nodes(form.tree).some((node) => node.type === "form"),
        false,
    );
    fixture.store.state.projects = [];
    const empty = mount(() => ProjectSessionPanel({ visible: true, onBusyChange() {} }));

    assert.match(textOf(empty.tree), /Ask the owner to grant a project/);
    assert.doesNotMatch(textOf(empty.tree), /New Project|one-time chat/);
    fixture.store.state.me.role = "owner";
    fixture.store.state.projects = [...projects];
    const ownerPanel = mount(() => ProjectSessionPanel(props));
    const ownerField = mount(() => WorkspaceField(child(ownerPanel, WorkspaceField).props));

    assert.equal(
        nodes(ownerField.tree).some((node) => node.type === "input"),
        false,
    );
    button(ownerField, "Change").props.onClick();
    await flush();
    assert.ok(
        find(
            ownerField,
            (node) => node.type === "input" && node.props["aria-label"] === "Working directory",
        ),
    );
    assert.ok(button(ownerField, "Browse"));
    child(ownerPanel, WorkspaceField).props.onChange(
        { kind: "ssh", host: "machine-b" },
        "/override",
    );
    await flush();
    await button(ownerPanel, "Start Worker").props.onClick();
    await flush();
    assert.equal(created[1]![0], "/override");
    assert.deepEqual((created[1]![1] as Props).location, { kind: "ssh", host: "machine-b" });
    fixture.store.state.me.role = "viewer";
    render(ownerPanel);
    assert.equal(button(ownerPanel, "Start Worker").props.disabled, true);
});

// Older hosts acknowledge unknown project fields without saving them. The owner form must
// not offer a false-success default edit; the HTTP association test owns durable persistence.
test("project defaults require the advertised link capability and explicit clears remain explicit", async () => {
    const previous = fixture.actions.updateProject;

    try {
        for (const capable of [false, true]) {
            reset();
            fixture.store.state.server.privateAgents = 4;
            fixture.store.state.server.projectAgentLinks = capable ? 1 : undefined;
            fixture.store.state.namedAgents = [{ agentId: "nora", name: "Nora" }];
            const project = { ...projects[0], defaultAgentId: "nora" };
            const saved: Props[] = [];

            fixture.actions.updateProject = async (_id: string, body: Props) => saved.push(body);
            const form = mount(() => ProjectForm({ project }));
            const picker = nodes(form.tree).find(
                (node) => node.props["aria-label"] === "Default named agent",
            );

            if (capable) {
                assert.ok(picker);
                assert.equal(picker.props.value, "nora");
                picker.props.onChange({ currentTarget: { value: "" } });
                await flush();
            } else {
                assert.equal(picker, undefined);
                assert.match(textOf(form.tree), /cannot save project-agent defaults yet/);
            }

            await submit(form);
            await flush();
            assert.equal(saved.length, 1);
            assert.equal(Object.hasOwn(saved[0]!, "defaultAgentId"), capable);
            assert.equal(saved[0]!.defaultAgentId, capable ? null : undefined);
            assert.equal(
                project.defaultAgentId,
                "nora",
                "the form does not mutate the existing default locally",
            );
            dispose(form);
        }
    } finally {
        fixture.actions.updateProject = previous;
    }
});

// Home keeps this real native panel mounted while disclosure visibility changes. Prop changes
// must update placement without retaining a local folder/worktree on an SSH destination.
test("embedded native work settings survive hiding and follow project changes without local overrides", async () => {
    reset();
    fixture.store.state.server.agentProfiles.push({
        id: "researcher",
        name: "Researcher",
        starter: true,
    });
    const created: unknown[][] = [];

    fixture.actions.createSession = async (...args: unknown[]) => {
        created.push(args);

        return { id: 45 };
    };

    const props: Props = {
        projectId: "local",
        cwd: "/explicit-local",
        embedded: true,
        visible: true,
    };
    const panel = mount(() => ProjectSessionPanel(props));
    const type = () => find(panel, (node) => node.props["aria-label"] === "Thread type");
    const worktree = () =>
        find(panel, (node) => node.type === "input" && node.props.type === "checkbox");

    assert.equal(child(panel, WorkspaceField).props.cwd, "/explicit-local");
    type().props.onChange({ currentTarget: { value: "researcher" } });
    child(panel, WorkspaceField).props.onChange(null, "/edited-local");
    worktree().props.onChange({ currentTarget: { checked: true } });
    await flush();
    props.visible = false;
    render(panel);
    props.visible = true;
    render(panel);
    assert.equal(child(panel, WorkspaceField).props.cwd, "/edited-local");
    assert.equal(type().props.value, "researcher");
    assert.equal(worktree().props.checked, true);
    assert.deepEqual(created, [], "viewing and hiding options never starts work");
    props.projectId = "a";
    render(panel);
    assert.equal(
        button(panel, "Start Researcher").props.disabled,
        true,
        "old placement cannot start during a controlled project transition",
    );
    await button(panel, "Start Researcher").props.onClick();
    assert.deepEqual(created, []);
    await flush();
    assert.equal(child(panel, WorkspaceField).props.cwd, "/a");
    assert.deepEqual(child(panel, WorkspaceField).props.location, {
        kind: "ssh",
        host: "machine-a",
    });
    assert.equal(type().props.value, "researcher");
    assert.equal(worktree().props.checked, false);
    await button(panel, "Start Researcher").props.onClick();
    await flush();
    assert.equal(created[0]![0], "/a");
    assert.deepEqual(created[0]![1], {
        location: { kind: "ssh", host: "machine-a" },
        threadType: "researcher",
        projectId: "a",
        worktree: false,
        requestId: "request",
    });
    const remote = mount(() => ProjectSessionPanel({ ...props, cwd: "/must-not-cross-machines" }));

    assert.equal(
        child(remote, WorkspaceField).props.cwd,
        "/a",
        "an embedded remote initial destination also ignores a local cwd hint",
    );
});

test("owner People editor saves explicit access and nonowners cannot invite or edit grants", async () => {
    reset();
    const patches: unknown[] = [];

    fixture.store.state.users = [{ id: "guest", name: "Alex", role: "guest" }];

    fixture.actions.setAccess = async (id: string, patch: Props) => {
        patches.push([id, patch]);

        return fixture.store.state.users;
    };

    const people = mount(() => PeopleList());

    button(people, "Projects").props.onClick();
    await flush();
    const editorNode = find(
        people,
        (node) =>
            typeof node.type === "function" &&
            node.props.person === fixture.store.state.users[0] &&
            typeof node.props.onClose === "function",
    );
    const editor = mount(() => (editorNode.type as (props: Props) => unknown)(editorNode.props));

    assert.match(textOf(editor.tree), /Legacy access is unchanged until you save/);
    child(editor, ProjectAccessPicker).props.onChange({ local: true, projectIds: ["a"] });
    await flush();
    await button(editor, "Save project access").props.onClick();
    await flush();
    assert.deepEqual(patches, [["guest", { projectAccess: { local: true, projectIds: ["a"] } }]]);
    fixture.store.state.me.role = "guest";
    render(people);
    assert.equal(
        nodes(people.tree).some((node) => node.type === "button"),
        false,
    );
    let inviteCalls = 0;

    fixture.api = async () => {
        inviteCalls++;

        return {};
    };

    const invite = mount(() => InviteSheet({}));

    await flush();
    assert.equal(inviteCalls, 0);
    assert.match(textOf(invite.tree), /Only the owner can invite/);
});

test("project grants cannot browse Pi history or expose continuation grants, while legacy access remains", async () => {
    reset();
    let reads = 0;
    const patches: unknown[] = [];

    fixture.api = async () => {
        reads++;

        return { sessions: [], warnings: [] };
    };

    fixture.actions.setAccess = async (id: string, patch: Props) => {
        patches.push([id, patch]);

        return fixture.store.state.users;
    };

    for (const access of [{}, { all: true }]) {
        fixture.store.state.me = {
            id: "guest",
            role: "guest",
            projectAccess: access,
            continuePiSessions: true,
        };
        const panel = mount(() => ImportPanel({}));

        await flush();
        assert.match(textOf(panel.tree), /history.*(?:not available|unavailable)/);
        assert.equal(
            nodes(panel.tree).some((node) => node.type === "button"),
            false,
        );
        assert.equal(reads, 0);
        fixture.store.state.me = { id: "owner", role: "owner" };
        fixture.store.state.users = [
            {
                id: "guest",
                name: "Alex",
                role: "guest",
                projectAccess: access,
                continuePiSessions: true,
            },
        ];
        const people = mount(() => PeopleList());

        assert.equal(
            nodes(people.tree).some(
                (node) => node.props["aria-label"] === "Continue Pi sessions for Alex",
            ),
            false,
        );
    }

    fixture.store.state.users = [{ id: "legacy", name: "Legacy", role: "guest" }];
    const people = mount(() => PeopleList());

    checkbox(people, "Continue Pi sessions for Legacy").props.onChange({
        currentTarget: { checked: true },
    });
    await flush();
    assert.deepEqual(patches, [["legacy", { continuePiSessions: true }]]);
    fixture.store.state.me = { id: "legacy", role: "guest", continuePiSessions: true };
    const legacy = mount(() => ImportPanel({}));

    await flush();
    assert.equal(reads, 1);
    assert.match(textOf(legacy.tree), /No live Pi instances/);
    const staleRefresh = button(legacy, "Refresh").props.onClick;

    fixture.store.state.me.projectAccess = { all: true };
    render(legacy);
    await staleRefresh();
    await flush();
    assert.equal(reads, 1, "an old refresh control cannot continue reading after a project grant");
    assert.match(textOf(legacy.tree), /history.*(?:not available|unavailable)/);
    fixture.store.state.me = { id: "owner", role: "owner" };
    mount(() => ImportPanel({}));
    await flush();
    assert.equal(reads, 2, "owner history browsing is unchanged");
});

test("sidebar project creation stays available to guests but placement and project editing are owner-only", async () => {
    reset();
    const moved: unknown[] = [];

    fixture.store.state.sessions = [{ id: 1, title: "Thread", projectId: "local" }];
    fixture.actions.updateSession = async (id: number, patch: Props) => moved.push([id, patch]);
    fixture.store.state.me.role = "guest";
    const project = mount(() => SidebarOptions({ kind: "project", id: "local" }));

    assert.doesNotMatch(textOf(project.tree), /Edit project/);
    await button(project, "New Session here…").props.onClick();
    await flush();
    assert.deepEqual(fixture.opened, [{ type: "new-session", projectId: "local" }]);
    const thread = mount(() => SidebarOptions({ kind: "thread", id: 1 }));

    assert.doesNotMatch(textOf(thread.tree), /Move to project/);
    const destination = { projectId: "a", label: "Remote app" };
    const denied = await moveSessions([1], destination);

    assert.deepEqual(denied.failed, [1]);
    assert.equal(moved.length, 0, "a stale move form cannot dispatch placement as a guest");
    fixture.store.state.me.role = "owner";
    render(project);
    render(thread);
    assert.ok(button(project, "Edit project…"));
    assert.ok(button(thread, "Move to project…"));
    const accepted = await moveSessions([1], destination);

    assert.deepEqual(accepted.moved, [1]);
    assert.deepEqual(moved, [[1, { projectId: "a" }]]);
    fixture.store.state.me.role = "viewer";
    render(project);
    assert.doesNotMatch(textOf(project.tree), /New Session here|Edit project/);
});

test("guest menus keep fixed-location forks but hide directory and own-worktree choices", async () => {
    reset();
    const forks: unknown[] = [];
    const resends: unknown[] = [];
    const prompt = { id: "prompt", kind: "user", text: "Do the task" };
    const reply = { id: "reply", kind: "assistant", text: "Done" };

    fixture.store.state.models = [];
    fixture.store.state.view = {
        conversation: { id: 1, kind: "session", inRepository: true },
        agent: { cwd: "/local" },
        entries: new Map([
            [prompt.id, prompt],
            [reply.id, reply],
        ]),
        order: [prompt.id, reply.id],
        subagents: [],
    };

    fixture.actions.fork = async (id: string, options: Props) => {
        forks.push([id, options]);

        return { id: 10 };
    };

    fixture.actions.resend = async (id: string, options: Props) => {
        resends.push([id, options]);

        return { id: 11 };
    };

    const action = (instance: Mount, label: string) =>
        find(instance, (node) => node.type === "button" && textOf(node).startsWith(label));

    fixture.store.state.me.role = "guest";
    const menu = mount(() => MenuSheet({ places: false }));
    const message = mount(() => MessageSheet({ entryId: reply.id }));

    assert.doesNotMatch(textOf(menu.tree), /Working directory/);
    assert.doesNotMatch(textOf(message.tree), /worktree of their own/);
    action(message, "Fork from here").props.onClick();
    await flush();
    assert.deepEqual(forks, [["reply", { worktree: false }]]);
    const resendNode = find(
        message,
        (node) => typeof node.type === "function" && node.props.prompt === prompt,
    );
    const resend = mount(() => (resendNode.type as (props: Props) => unknown)(resendNode.props));

    action(resend, "With current model").props.onClick();
    await flush();
    assert.deepEqual(resends, [["prompt", { worktree: false }]]);
    fixture.store.state.me.role = "owner";
    render(menu);
    render(message);
    assert.ok(action(menu, "Working directory"));
    find(
        message,
        (node) => node.props.label === "New sessions get a git worktree of their own",
    ).props.onChange();
    await flush();
    action(message, "Fork from here").props.onClick();
    await flush();
    assert.deepEqual(forks[1], ["reply", { worktree: true }]);
    fixture.store.state.me.role = "guest";
    render(message);
    action(message, "Fork from here").props.onClick();
    await flush();
    assert.deepEqual(
        forks[2],
        ["reply", { worktree: false }],
        "owner toggle state cannot follow a role downgrade",
    );
});

test("worktree details are readable to guests but removal and stale removal callbacks require the owner", async () => {
    reset();
    const removed: boolean[] = [];

    fixture.store.state.view.conversation = {
        kind: "session",
        worktree: { branch: "feature", source: "/source" },
        workflow: { managed: false },
    };
    fixture.actions.removeWorktree = async (force: boolean) => removed.push(force);
    fixture.store.state.me.role = "guest";
    const sheet = mount(() => WorktreeSheet());

    assert.match(textOf(sheet.tree), /feature/);
    assert.equal(
        nodes(sheet.tree).some((node) => node.type === "button"),
        false,
    );
    fixture.store.state.me.role = "owner";
    render(sheet);
    const oldRemove = button(sheet, "Remove the worktree").props.onClick;

    fixture.store.state.me.role = "guest";
    render(sheet);
    await oldRemove();
    await flush();
    assert.deepEqual(removed, []);
    fixture.store.state.me.role = "owner";
    render(sheet);
    await button(sheet, "Remove the worktree").props.onClick();
    await flush();
    assert.deepEqual(removed, [false]);
});

test("branch picker lists branches but only a current owner may dispatch a switch", async (t) => {
    const descriptors = new Map(
        ["addEventListener", "removeEventListener", "visualViewport"].map((name) => [
            name,
            Object.getOwnPropertyDescriptor(globalThis, name),
        ]),
    );
    const events = new EventTarget();

    Object.defineProperties(globalThis, {
        addEventListener: { configurable: true, value: events.addEventListener.bind(events) },
        removeEventListener: { configurable: true, value: events.removeEventListener.bind(events) },
        visualViewport: { configurable: true, value: undefined },
    });
    t.after(() => {
        for (const [name, descriptor] of descriptors) {
            if (descriptor) {
                Object.defineProperty(globalThis, name, descriptor);
            } else {
                Reflect.deleteProperty(globalThis, name);
            }
        }
    });
    const switched: Props[] = [];

    const setup = async (role: string) => {
        reset();
        switched.length = 0;
        fixture.store.state.me = {
            id: role,
            role,
            ...(role === "guest" ? { projectAccess: { all: true } } : {}),
        };
        fixture.store.state.sheet = { type: "branch" };
        fixture.store.state.view = { branch: { branch: "main" }, live: { busy: false } };
        fixture.actions.branches = async () => ({
            local: [
                { name: "main", current: true },
                { name: "feature", subject: "Feature change" },
            ],
            remote: [{ name: "origin/other", subject: "Remote change" }],
            changed: 0,
            more: 0,
        });

        fixture.actions.switchBranch = async (target: Props) => {
            switched.push(target);

            return { branch: "feature" };
        };

        const picker = mount(() => BranchPicker());

        await flush();

        return picker;
    };

    const feature = (picker: Mount) =>
        find(
            picker,
            (node) =>
                node.type === "button" &&
                node.props.role === "option" &&
                textOf(node).includes("Feature change"),
        );

    await t.test("an owner can switch a listed branch", async () => {
        const picker = await setup("owner");

        assert.equal(feature(picker).props.disabled, false);
        feature(picker).props.onClick();
        await flush();
        assert.deepEqual(switched, [{ name: "feature" }]);
    });
    await t.test("a project guest can list but cannot switch or make branches", async () => {
        const picker = await setup("guest");

        assert.match(textOf(picker.tree), /main/);
        assert.match(textOf(picker.tree), /origin\/other/);
        feature(picker).props.onClick();
        await flush();
        assert.deepEqual(switched, [], "a guest branch row must never dispatch a mutation");
        assert.equal(feature(picker).props.disabled, true);
        assert.match(textOf(picker.tree), /Only the owner.*switch/i);
        find(picker, (node) => node.type === "input").props.onInput({
            currentTarget: { value: "new-topic" },
        });
        await flush();
        const make = find(
            picker,
            (node) => node.type === "button" && textOf(node).includes("Make the branch"),
        );

        assert.equal(make.props.disabled, true);
        make.props.onClick();
        await flush();
        assert.deepEqual(switched, [], "a guest make-branch row must not dispatch a mutation");
    });
    await t.test("a stale owner callback rechecks the current guest identity", async () => {
        const picker = await setup("owner");
        const stalePick = feature(picker).props.onClick;

        fixture.store.state.me = { id: "owner", role: "guest", projectAccess: { all: true } };
        render(picker);
        stalePick();
        await flush();
        assert.deepEqual(switched, [], "captured owner UI must not dispatch after a downgrade");
    });
});

test("launcher favorites require a current owner while guests retain the general project-picker action", async (t) => {
    reset();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const created: string[] = [];

    fixture.store.state.conversationId = null;
    fixture.store.state.folderFavorites = ["/favorite/project"];

    fixture.actions.createSession = async (path: string) => {
        created.push(path);

        return { id: 12 };
    };

    // Leaving skips unrelated browser focus isolation; the real catalogue and dispatch callbacks still run.
    const launcher = mount(() => Launcher({ leaving: true }));
    const favorite = find(
        launcher,
        (node) =>
            node.type === "button" &&
            node.props["aria-label"]?.startsWith("New session in project,"),
    );
    const staleFavorite = favorite.props.onClick;

    favorite.props.onClick({});
    await flush();
    assert.deepEqual(created, ["/favorite/project"]);
    fixture.store.state.me = { id: "guest", role: "guest", projectAccess: { all: true } };
    render(launcher);
    assert.equal(
        nodes(launcher.tree).some((node) =>
            node.props["aria-label"]?.startsWith("New session in "),
        ),
        false,
    );
    staleFavorite({});
    await flush();
    assert.deepEqual(
        created,
        ["/favorite/project"],
        "a captured owner favorite cannot create after access changes",
    );
    find(
        launcher,
        (node) => node.type === "button" && node.props["aria-label"]?.startsWith("New session,"),
    ).props.onClick({});
    assert.deepEqual(
        fixture.opened,
        [{ type: "cwd", mode: "new" }],
        "the general creation action still opens the incumbent project-first flow",
    );
    t.mock.timers.tick(150);
    await flush();
});
