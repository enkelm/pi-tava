// Owns project landing destinations and identity-picker creation lifecycle, not layout/device proof.
// Existing grouping tests own the projection; these consumers must preserve grouped vs exact links.
// Existing agent tests own native creation receipts. Here deferred responses exercise the actual
// form's callback, close/reopen recovery and stale-owner admission without adding production seams.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, test, type TestContext } from "node:test";
import { h, isValidElement, type VNode } from "preact";

const htm = (await import(import.meta.resolve("htm"))).default;

type Props = Record<string, any>;
type Element = VNode<Props>;
type Slot = { value?: any; deps?: unknown[]; cleanup?: () => void };
type Fiber = { slots: Slot[]; cursor: number };
type Request = {
    path: string;
    body?: Props;
    resolve: (value: Props) => void;
    reject: (error: Error) => void;
};
let active: Props;
const bridge = {
    html: htm.bind(h),
    h,
    hooks: {
        useState: (...args: unknown[]) => active.hooks.useState(...args),
        useRef: (...args: unknown[]) => active.hooks.useRef(...args),
        useEffect: (...args: unknown[]) => active.hooks.useEffect(...args),
    },
    store: {
        get state() {
            return active.state;
        },
        set(patch: Props) {
            Object.assign(active.state, patch);
            active.invalidate();
        },
    },
    api: (path: string, body?: Props) => active.api(path, body),
    uid: () => active.uid(),
    navigate: (id: number) => active.navigation.push(id),
    openSheet: (sheet: Props) => bridge.store.set({ sheet }),
    closeSheet: () => bridge.store.set({ sheet: null }),
    openAgentDraft: (agentId: string) => active.drafts.push(agentId),
};
const storage = new Map<string, string>();
const globals = {
    projectViewFixture: bridge,
    sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
    },
};
const descriptors = Object.keys(globals).map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
);

for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, value });
}

const sources: Record<string, string> = {
    "preact/hooks": "export const {useState,useRef,useEffect}=globalThis.projectViewFixture.hooks;",
    "./store.js": `const f=globalThis.projectViewFixture;
        export const {store,api,uid,navigate,openSheet,closeSheet}=f;
        export const canSteer=()=>store.state.me?.role!=="viewer";
        export const scoped=()=>Array.isArray(store.state.me?.sessions);`,
    "./ui.js": `const f=globalThis.projectViewFixture;
        export const html=f.html,Icon=props=>f.h("native-icon",props);
        export const Sheet=props=>f.h("native-sheet",props);
        export const Loader=props=>f.h("native-loader",props),Spinner=props=>f.h("native-spinner",props);
        export const timeAgo=()=>"Recently",shortPath=value=>value;`,
    "./named-agent-avatar.js": `export const NamedAgentAvatar=props=>globalThis.projectViewFixture.h("native-avatar",props);`,
    "./agent-drafts.js": `export const {openAgentDraft}=globalThis.projectViewFixture;
        export const agentDrafts=()=>[],selectAgentDraft=()=>{};`,
    "./sheets/model.js": "export const ModelPicker=()=>null;",
    "./sidebar-context.js": "export const openSidebarOptions=()=>{},useSidebarContext=()=>{};",
};
const hooks = registerHooks({
    resolve(specifier, context, next) {
        const source = /\/web\/(?:project-view|named-agents|thread-type)\.js$/.test(
            context.parentURL ?? "",
        )
            ? sources[specifier]
            : undefined;

        return source === undefined
            ? next(specifier, context)
            : { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    },
});
const { ProjectView } = await import(new URL("../web/project-view.js", import.meta.url).href);
const { NamedAgentsSheet, NamedAgentSheet, openAgentSettings } = await import(
    new URL("../web/named-agents.js", import.meta.url).href
);

after(() => {
    hooks.deregister();

    for (const [name, descriptor] of descriptors) {
        if (descriptor) {
            Object.defineProperty(globalThis, name, descriptor);
        } else {
            Reflect.deleteProperty(globalThis, name);
        }
    }
});

function nodes(value: unknown): Element[] {
    if (Array.isArray(value)) {
        return value.flatMap(nodes);
    }

    if (!isValidElement(value)) {
        return [];
    }

    const node = value as Element;

    return [node, ...nodes(node.props.children)];
}

function text(value: unknown): string {
    if (Array.isArray(value)) {
        return value.map(text).join("");
    }

    return isValidElement(value)
        ? text((value as Element).props.children)
        : typeof value === "string" || typeof value === "number"
          ? String(value)
          : "";
}

let owner = 0;

function fixture(t: TestContext, project = false) {
    let current: Fiber;
    let dirty = true;
    let tree: unknown;
    let sequence = 0;
    const fibers = new Map<string, Fiber>();
    const effects: (() => void)[] = [];
    const requests: Request[] = [];
    const navigation: number[] = [];
    const backs: string[] = [];
    const drafts: string[] = [];
    const state: Props = {
        me: { id: `project-owner-${++owner}`, role: "owner" },
        projects: [{ id: "one", name: "Project One", cwd: "/workspace" }],
        projectsLoaded: true,
        sessions: [],
        namedAgents: [],
        server: { privateAgents: 4, agentProfiles: [{ id: "chat", name: "Chat", icon: "chat" }] },
        conversationId: null,
        sheet: project ? null : { type: "named-agents" },
    };
    const slot = () => (current.slots[current.cursor++] ??= {});

    active = {
        state,
        navigation,
        drafts,
        uid: () => `request-${++sequence}`,
        invalidate: () => {
            dirty = true;
        },
        api: (path: string, body?: Props) =>
            new Promise((resolve, reject) => requests.push({ path, body, resolve, reject })),
        hooks: {
            useState(initial: any) {
                const item = slot();

                if (!("value" in item)) {
                    item.value = typeof initial === "function" ? initial() : initial;
                }

                return [
                    item.value,
                    (next: any) => {
                        item.value = typeof next === "function" ? next(item.value) : next;
                        dirty = true;
                    },
                ];
            },
            useRef: (initial: any) => (slot().value ??= { current: initial }),
            useEffect(run: () => (() => void) | void, deps: unknown[]) {
                const item = slot();

                if (
                    !item.deps ||
                    deps.some((value, index) => !Object.is(value, item.deps![index]))
                ) {
                    item.deps = deps;
                    effects.push(() => {
                        item.cleanup?.();
                        item.cleanup = run() || undefined;
                    });
                }
            },
        },
    };

    let visited = new Set<string>();

    const resolve = (value: any, path: string): any => {
        if (Array.isArray(value)) {
            return value.map((child, index) => resolve(child, `${path}.${index}`));
        }

        if (!isValidElement(value)) {
            return value;
        }

        const node = value as Element;

        if (typeof node.type === "function") {
            const key = `${path}:${node.key ?? ""}`;

            current = fibers.get(key) ?? { slots: [], cursor: 0 };
            current.cursor = 0;
            fibers.set(key, current);
            visited.add(key);

            return resolve((node.type as (props: Props) => unknown)(node.props), `${key}.child`);
        }

        return {
            ...node,
            props: { ...node.props, children: resolve(node.props.children, `${path}.children`) },
        };
    };

    const render = () => {
        for (let count = 0; dirty; count++) {
            assert.ok(count < 20, "component updates settle");
            dirty = false;
            visited = new Set();
            const sheet = state.sheet;

            tree = resolve(
                [
                    project
                        ? h(ProjectView, {
                              projectId: "one",
                              onBack: () => backs.push("sessions"),
                          })
                        : null,
                    sheet?.type === "named-agent"
                        ? h(NamedAgentSheet, { sheet })
                        : sheet?.type === "named-agents"
                          ? h(NamedAgentsSheet, {})
                          : null,
                ],
                "root",
            );

            for (const [key, fiber] of fibers) {
                if (!visited.has(key)) {
                    fiber.slots.forEach((item) => item.cleanup?.());
                    fibers.delete(key);
                }
            }

            effects.splice(0).forEach((run) => run());
        }
    };

    t.after(() => fibers.forEach((fiber) => fiber.slots.forEach((item) => item.cleanup?.())));

    const patch = (value: Props) => {
        bridge.store.set(value);
        render();
    };

    const all = () => {
        render();

        return nodes(tree);
    };

    const find = (type: string, label?: string) => {
        const found = all().find(
            (node) => node.type === type && (label === undefined || text(node).trim() === label),
        );

        assert.ok(found, `${type} ${label ?? ""} exists`);

        return found;
    };

    const click = (node: Element, modifiers = {}) => {
        node.props.onClick({ preventDefault() {}, stopPropagation() {}, ...modifiers });
        render();
    };

    const settle = async () => {
        await new Promise<void>((done) => setImmediate(done));
        render();
        await new Promise<void>((done) => setImmediate(done));
        render();
    };

    render();

    return {
        state,
        requests,
        navigation,
        backs,
        drafts,
        patch,
        all,
        find,
        click,
        settle,
        text: () => text(tree),
        open: (options: Props = {}) => {
            openAgentSettings(null, null, null, options);
            render();
        },
        create: async () => {
            await settle();
            requests.at(-1)!.resolve({ projects: state.projects });
            await settle();
            const input = all().find((node) => node.props["aria-label"] === "Agent name")!;

            input.props.onInput({ currentTarget: { value: "New identity" } });
            render();
            find("form").props.onSubmit({ preventDefault() {} });
            render();

            return requests.at(-1)!;
        },
    };
}

const identity = { agentId: "new-agent", id: null, name: "New identity", chats: [], chatIds: [] };

test("project landing keeps access-filtered membership, grouped controller links and exact threads distinct", (t) => {
    const f = fixture(t, true);

    f.patch({
        sessions: [
            {
                id: 11,
                projectId: "one",
                title: "Old worker",
                workItemId: "work",
                activeThreadId: 12,
                workItemTitle: "Grouped work",
            },
            {
                id: 12,
                projectId: "one",
                title: "Review thread",
                workItemId: "work",
                activeThreadId: 12,
                supervisor: { conversationId: 91 },
            },
            {
                id: 21,
                projectId: "one",
                title: "Same chat name",
                threadType: "chat",
                pipAgentId: "agent-a",
            },
            {
                id: 22,
                projectId: "one",
                title: "Same chat name",
                threadType: "chat",
                pipAgentId: "agent-b",
            },
            {
                id: 23,
                projectId: "other",
                cwd: "/workspace",
                title: "Other project",
                threadType: "chat",
            },
        ],
    });
    const links = f.all().filter((node) => node.type === "a");
    const group = links.find((node) => node.props.href === "/s/91")!;
    const exact = links.find((node) => node.props.href === "/s/11")!;

    assert.deepEqual(links.map((node) => node.props.href).sort(), [
        "/s/11",
        "/s/12",
        "/s/21",
        "/s/22",
        "/s/91",
    ]);
    assert.doesNotMatch(f.text(), /Other project/);
    f.click(group);
    f.click(exact);
    f.click(group, { metaKey: true });
    assert.deepEqual(
        f.navigation,
        [91, 11],
        "group opens its controller, exact links remain exact and modified links stay native",
    );
    f.patch({
        sessions: f.state.sessions.map((session: Props) =>
            session.id === 12 ? { ...session, supervisor: { conversationId: 92 } } : session,
        ),
    });
    f.click(group);
    assert.deepEqual(
        f.navigation,
        [91, 11, 92],
        "a retained row resolves current controller identity",
    );
    f.patch({ sessions: f.state.sessions.filter((session: Props) => session.id !== 11) });
    f.click(exact);
    assert.deepEqual(
        f.navigation,
        [91, 11, 92],
        "removed exact threads cannot navigate from stale callbacks",
    );
});

test("project chats use each native chat's project, not identity remit or project default", (t) => {
    const f = fixture(t, true);

    f.patch({
        projects: [{ ...f.state.projects[0], defaultAgentId: "agent-a" }],
        namedAgents: [
            {
                agentId: "agent-a",
                name: "Same identity name",
                projectId: "one",
                chats: [
                    {
                        id: 31,
                        title: "In this project",
                        projectId: "one",
                        busy: false,
                        managing: true,
                    },
                    { id: 32, title: "Different project", projectId: "two" },
                    { id: 33, title: "Unassigned chat" },
                ],
            },
            {
                agentId: "agent-b",
                name: "Same identity name",
                projectId: "one",
                chats: [{ id: 34, title: "In this project", projectId: "one" }],
            },
        ],
    });
    const links = f.all().filter((node) => node.type === "a");

    assert.deepEqual(
        links.map((node) => node.props.href),
        ["/s/31", "/s/34"],
    );
    assert.doesNotMatch(f.text(), /Different project|Unassigned chat/);
    assert.equal(
        f
            .all()
            .find(
                (node) =>
                    node.type === "native-avatar" &&
                    node.props.agentId === "agent-a" &&
                    node.props.size === undefined,
            )?.props.thinking,
        true,
    );
    const [first, second] = links;

    assert.ok(first);
    assert.ok(second);
    f.click(first);
    f.click(second);
    assert.deepEqual(
        f.navigation,
        [31, 34],
        "same-named identities and chats keep exact native destinations",
    );
    const related = f
        .all()
        .filter((node) => node.type === "span" && node.props.class === "project-view-agent");

    assert.deepEqual(
        related.flatMap((node) =>
            nodes(node)
                .filter((child) => child.type === "native-avatar")
                .map((child) => child.props.agentId),
        ),
        ["agent-a", "agent-b"],
        "related identities are explicit metadata, not fabricated Chats",
    );
    f.patch({ projects: [{ ...f.state.projects[0], defaultAgentId: null }] });
    assert.match(f.text(), /No default selected/);
    assert.deepEqual(
        f
            .all()
            .filter((node) => node.type === "a")
            .map((node) => node.props.href),
        ["/s/31", "/s/34"],
    );
    f.patch({ me: { ...f.state.me, role: "guest" } });
    assert.doesNotMatch(f.text(), /Related PiPs|Same identity name/);
    assert.deepEqual(
        f.all().filter((node) => node.type === "a"),
        [],
        "private catalogue data cannot appear after owner revocation",
    );
    f.click(first);
    assert.deepEqual(f.navigation, [31, 34]);
});

test("project content keeps its heading, gated actions and Back through loading and unavailability", (t) => {
    const f = fixture(t, true);
    const settings = f.find("button", "Project settings");
    const create = f.find("button", "New Session");

    const backToSessions = () => {
        const content = f.all().find((node) => node.props.class === "project-view-content");
        const back = nodes(content).find((node) => node.props["aria-label"] === "Back to sessions");

        assert.ok(back, "Back is inside the content, including empty/loading states");
        assert.equal(back.type, "button");
        assert.equal(back.props.type, "button");
        assert.ok(String(back.props.class).split(" ").includes("button"));
        assert.equal(text(back).trim(), "Sessions");
        assert.ok(
            nodes(back).some((node) => node.type === "native-icon" && node.props.name === "back"),
        );
        const before = f.backs.length;

        f.click(back);
        assert.equal(f.backs.length, before + 1, "Back invokes the actual caller's callback");
        assert.deepEqual(f.navigation, [], "returning never chooses a conversation");
    };

    const mutationButtons = () =>
        f
            .all()
            .filter(
                (node) => node.type === "button" && node.props["aria-label"] !== "Back to sessions",
            );

    assert.equal(text(f.find("h1")), "Project One");
    assert.ok(String(create.props.class).split(" ").includes("primary"));
    backToSessions();
    f.click(settings);
    assert.deepEqual(f.state.sheet, { type: "project", projectId: "one" });
    f.click(create);
    assert.deepEqual(f.state.sheet, { type: "new-session", projectId: "one" });
    f.patch({ me: { ...f.state.me, role: "viewer" }, sheet: null });
    f.click(settings);
    f.click(create);
    assert.equal(f.state.sheet, null);
    assert.deepEqual(mutationButtons(), []);
    backToSessions();
    f.patch({ me: { ...f.state.me, role: "guest" } });
    f.click(f.find("button", "New Session"));
    assert.deepEqual(f.state.sheet, { type: "new-session", projectId: "one" });
    f.patch({ me: { ...f.state.me, sessions: [21] }, sheet: null });
    assert.deepEqual(mutationButtons(), []);
    backToSessions();
    f.patch({ projects: [], projectsLoaded: false });
    assert.equal(f.find("main").props["aria-label"], "Loading project");
    assert.doesNotMatch(f.text(), /Project unavailable/);
    backToSessions();
    f.patch({ projectsLoaded: true });
    assert.equal(text(f.find("h1")), "Project unavailable");
    backToSessions();
    f.click(create);
    assert.equal(f.state.sheet, null);
});

test("PiPs library creates a global identity and returns without opening or assigning a chat", async (t) => {
    const f = fixture(t);

    assert.equal(f.find("native-sheet").props.title, "PiPs");
    f.click(f.find("button", "Create named agent"));
    assert.equal(typeof f.state.sheet.onCreated, "function");
    const request = await f.create();

    assert.equal(request.path, "pip/agents?identityOnly=1");
    assert.equal(request.body?.projectId, null);
    assert.equal(
        f.all().some((node) => node.props["aria-label"] === "PiP project"),
        false,
    );
    request.resolve(identity);
    await f.settle();
    assert.equal(f.state.sheet.type, "named-agents");
    assert.equal(f.state.namedAgents[0].agentId, identity.agentId);
    assert.equal(f.state.projects[0].defaultAgentId, undefined);
    assert.deepEqual(f.navigation, []);
    assert.deepEqual(f.drafts, []);
    f.click(f.all().find((node) => node.props["data-agent-id"] === identity.agentId)!);
    assert.equal(f.state.sheet, null, "library closes before identity navigation");
    assert.deepEqual(
        f.drafts,
        [identity.agentId],
        "explicitly opening uses the native identity draft path",
    );
});

test("creation picker registers before close-then-callback and pending recovery uses that same path", async (t) => {
    const f = fixture(t);
    const calls: Props[] = [];
    const onCreated = (result: Props) =>
        calls.push({ result, sheet: f.state.sheet, agents: f.state.namedAgents });

    f.open({ onCreated });
    const request = await f.create();

    f.patch({ sheet: null });
    f.open({ onCreated });
    request.resolve(identity);
    await f.settle();
    assert.equal(calls.length, 1, "only the reopened live form accepts the acknowledgement");
    const call = calls[0];

    assert.ok(call);
    assert.equal(call.sheet, null, "close runs before callback");
    assert.equal(
        call.agents[0].agentId,
        identity.agentId,
        "caller can select the registered identity",
    );
    assert.deepEqual(f.navigation, []);
    assert.deepEqual(f.drafts, []);
});

test("uncertain picker retry retains the same request and late acceptance cannot act after owner revocation", async (t) => {
    const f = fixture(t);
    const accepted: Props[] = [];

    f.open({ onCreated: (result: Props) => accepted.push(result) });
    const first = await f.create();

    first.reject(new Error("Acknowledgement lost"));
    await f.settle();
    assert.match(f.text(), /Creation may have succeeded/);
    assert.equal(f.find("button", "Retry creation").props.disabled, false);
    f.find("form").props.onSubmit({ preventDefault() {} });
    const second = f.requests.at(-1)!;

    assert.deepEqual(second.body, first.body, "uncertain acceptance never allocates a new request");
    f.patch({ me: { ...f.state.me, role: "viewer" } });
    second.resolve(identity);
    await f.settle();
    assert.deepEqual(accepted, []);
    assert.deepEqual(f.state.namedAgents, []);
    assert.deepEqual(f.navigation, []);
    assert.deepEqual(f.drafts, []);
});
