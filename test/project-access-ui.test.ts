// Authoring gate: real components own grant choices, invite races and fixed-destination creation.
// A broadened invite, lost manual choice, stale QR, or guest destination override must fail here.
// App permission tests own enforcement; they do not render controls or deliver late invite responses.
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
    remembered: [] as unknown[],
    opened: [] as Props[],
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
        export const collab=()=>true,closeSheet=()=>{},notify=()=>{},uid=()=>"request";
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
    "thread-type.js":
        "export const ThreadTypeTag=()=>null,threadTypeLabel=({threadType})=>threadType==='worker'?'Worker':'Chat';",
    "workspace-location.js": `export const LocationPicker=()=>null;
        export const conversationLocation=()=>globalThis.projectAccessUiFixture.store.state.view.conversation?.location??null;
        export const rememberSshFolder=(...args)=>globalThis.projectAccessUiFixture.remembered.push(args);`,
    "ssh-status.js": "export const RemoteProjectIcon=()=>null;",
    "folder.js":
        "export const FolderPicker=()=>null,recentLabels=paths=>paths.map(path=>path.split('/').at(-1));",
    "sidebar-context.js": "export const openSidebarOptions=()=>{};",
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
    /\/web\/(project-access|workspace-field|session-moves|launcher|sheets\/(people|project|session-projects|pi-sessions|sidebar-options|message|menu|worktree|branch))\.js$/;

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
const { ImportPanel } = await import(new URL("../web/sheets/pi-sessions.js", import.meta.url).href);
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
    fixture.remembered = [];
    fixture.opened = [];
}

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
        assert.match(textOf(panel.tree), /not available with project-only access/);
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
    assert.match(textOf(legacy.tree), /not available with project-only access/);
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
