// Header controls use their real factory; limits use real Sheets routing and SidebarOptions.
// Inert UI/hooks and deferred HTTP isolate selected-item, retry and stale-opening behavior.
// This does not claim browser layout, Preact reconciliation or device coverage.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, test, type TestContext } from "node:test";
import { h } from "preact";

const htm = (await import(import.meta.resolve("htm"))).default;
const subscriptions = new Set<(state: Props) => void>();
let active: Props;
const bridge = {
    h,
    html: htm.bind(h),
    store: {
        get state() {
            return active?.state ?? { conversationId: null };
        },
        set(patch: Props) {
            Object.assign(active.state, patch);
            active.invalidate();
            subscriptions.forEach((listener) => listener(active.state));
        },
        subscribe(listener: (state: Props) => void) {
            subscriptions.add(listener);

            return () => subscriptions.delete(listener);
        },
    },
    hooks: {
        useState: (...args: any[]) => active.hooks.useState(...args),
        useRef: (...args: any[]) => active.hooks.useRef(...args),
        useEffect: (...args: any[]) => active.hooks.useEffect(...args),
        useLayoutEffect() {},
        useContext: () => null,
    },
    api: (...args: any[]) => active.api(...args),
    closeSheet() {
        active.closes++;
        bridge.store.set({ sheet: null });
    },
    openSheet(sheet: Props) {
        active.opened.push(sheet);
        bridge.store.set({ sheet });
    },
    uid: () => active.uid(),
};
const descriptors = new Map<string, PropertyDescriptor | undefined>();

for (const [name, value] of Object.entries({
    orchestratorUiFixture: bridge,
    matchMedia: () => ({ matches: true }),
    document: { activeElement: null, body: {} },
    addEventListener() {},
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
    "preact/hooks": `export const {useState,useRef,useEffect,useLayoutEffect,useContext}=globalThis.orchestratorUiFixture.hooks;`,
    "store.js": `const f=globalThis.orchestratorUiFixture;
        export const {store,api,closeSheet,openSheet,uid}=f;
        export const handoffsAvailable=()=>true,canSteer=()=>true,scoped=()=>false,isUnread=()=>false;
        export const setUnread=()=>{},notify=()=>{},actions={};`,
    "ui.js": `const f=globalThis.orchestratorUiFixture;
        export const html=f.html,Icon=()=>null,Loader=({label})=>f.h("test-loader",{label});
        export const Sheet=({children})=>children,Boundary=Sheet;
        export const SheetBack={Provider:Sheet},SheetInfo={Provider:Sheet};
        export const usePresence=value=>[value,false],copyText=()=>{};`,
    "extension-ui.js": `export const onExtensionsGone=()=>{};
        export const ExtensionSheet=()=>"Extension UI unavailable (safe mode)";`,
    "back.js": "export const addLayer=()=>({}),removeLayer=()=>{},goBack=()=>{};",
    "session-moves.js": "export const canMoveSessions=()=>false;",
    "sidebar-context.js": "export const openSidebarOptions=()=>{};",
    "sessions.js": "export const selectFromList=()=>{},setArchived=()=>{};",
    "theme.js": "export const isPinned=()=>false,togglePin=()=>{};",
};
const unrelated = `export const ${[
    "ChatSheet",
    "ShareSheet",
    "BranchPicker",
    "FileSheet",
    "FindSheet",
    "galleryAvailable",
    "GalleryEntrySheet",
    "GalleryShareSheet",
    "GallerySheet",
    "GallerySourceSheet",
    "GalleryUpdateSheet",
    "ImportSheet",
    "CwdSheet",
    "MemorySheet",
    "MenuSheet",
    "PlacesSheet",
    "MessageSheet",
    "ModelPicker",
    "PipModelPicker",
    "InviteSheet",
    "AuthDialog",
    "RunningSheet",
    "HooksSheet",
    "SchedulesSheet",
    "SettingsSheet",
    "NewSessionSheet",
    "SessionActions",
    "ProjectSheet",
    "SessionMoveSheet",
    "ShortcutsSheet",
    "TextSheet",
    "ArtifactsSheet",
    "ArtifactViewer",
    "ImageViewer",
    "piSessionsAvailable",
    "WorktreeSheet",
    "TrustSheet",
]
    .map((name) => `${name}=()=>null`)
    .join(",")};`;

registerHooks({
    resolve(specifier, context, next) {
        const parent = context.parentURL && new URL(context.parentURL).pathname;
        const consumer =
            parent &&
            /\/web\/(sheets\.js|sheets\/(sidebar-options|work-item-limits)\.js)$/.test(parent);
        const real =
            specifier === "preact" || /(?:sidebar-options|work-item-limits)\.js$/.test(specifier);
        const source =
            consumer && !real
                ? (sources[specifier] ?? sources[specifier.split("/").at(-1)!] ?? unrelated)
                : undefined;

        return source === undefined
            ? next(specifier, context)
            : { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    },
});

const { Sheets } = await import(new URL("../web/sheets.js", import.meta.url).href);
const { createSupervisorUi } = await import(
    new URL("../src/server/work-items/browser/supervisor.js", import.meta.url).href
);
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

type Props = Record<string, any>;
type Node = { type: string | ((props: Props) => unknown); props: Props; key?: string };
type Slot = { value?: any; deps?: unknown[]; cleanup?: () => void };
type Fiber = { slots: Slot[]; cursor: number };
type Request = {
    url: string;
    body?: Props;
    signal?: AbortSignal;
    resolve: (body: Props, status?: number) => void;
    reject: (error: Error) => void;
};

const status = (extra: Props = {}) => ({
    orchestration: {
        conversationId: 99,
        workItemId: "work-1",
        status: "running",
        goal: "Finish the implementation",
        epoch: 1,
        actions: 3,
        maxActions: 20,
        spent: 1.25,
        maxCost: 5,
        ...extra,
    },
});
const preventDefault = { preventDefault() {} };

function nodes(value: any): Node[] {
    if (Array.isArray(value)) {
        return value.flatMap(nodes);
    }

    return value?.props ? [value, ...nodes(value.props.children)] : [];
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

function fixture(t: TestContext) {
    let session: Props = {
        me: { id: "owner", role: "owner" },
        id: 1,
        conversation: { kind: "session", threadType: "worker" },
        sessions: [
            {
                id: 1,
                threadType: "worker",
                workItemId: "work-1",
                supervisor: { conversationId: 99, status: "running", epoch: 1 },
            },
        ],
    };
    const observers = new Set<(session: Props) => void>();
    const requests: Request[] = [];
    const storage = new Map<string, string>();
    const fibers = new Map<string, Fiber>();
    const effects: (() => void)[] = [];
    const layouts: (() => void)[] = [];
    const descriptors = new Map<string, PropertyDescriptor | undefined>();
    let current: Fiber;
    let dirty = true;
    let tree: any;
    let sequence = 0;
    let opening = 0;
    const navigated: number[] = [];
    const opened: Props[] = [];
    const notices: string[] = [];
    const mockFetch = (url: string, init: RequestInit) =>
        new Promise((resolve, reject) => {
            requests.push({
                url,
                body: init.body ? JSON.parse(String(init.body)) : undefined,
                signal: init.signal ?? undefined,
                resolve(body, code = 200) {
                    resolve({
                        ok: code < 400,
                        status: code,
                        text: async () => JSON.stringify(body),
                    });
                },
                reject,
            });
        });

    for (const [name, value] of Object.entries({
        fetch: mockFetch,
        sessionStorage: {
            getItem: (key: string) => storage.get(key) ?? null,
            setItem: (key: string, value: string) => storage.set(key, value),
            removeItem: (key: string) => storage.delete(key),
        },
    })) {
        descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, { configurable: true, value });
    }

    const slot = () => (current.slots[current.cursor++] ??= {});

    const effect = (queue: (() => void)[], run: () => (() => void) | void, deps: unknown[]) => {
        const item = slot();

        if (!item.deps || deps.some((value, index) => !Object.is(value, item.deps![index]))) {
            item.deps = deps;
            queue.push(() => {
                item.cleanup?.();
                item.cleanup = run() || undefined;
            });
        }
    };

    const pocket = {
        html: htm.bind(h),
        h,
        Loader: ({ label }: Props) => h("test-loader", { label }),
        Icon: () => null,
        session: () => session,
        onSessionChange(listener: (session: Props) => void) {
            observers.add(listener);

            return () => observers.delete(listener);
        },
        requestId: () => `request-${++sequence}`,
        openSheet: (sheet: string, props: Props) => opened.push({ sheet, ...props }),
        navigate: (id: number) => navigated.push(id),
        notify: (_level: string, message: string) => notices.push(message),
        useState(initial: any) {
            const item = slot();

            if (!("value" in item)) {
                item.value = typeof initial === "function" ? initial() : initial;
            }

            return [
                item.value,
                (change: any) => {
                    const value = typeof change === "function" ? change(item.value) : change;

                    if (!Object.is(value, item.value)) {
                        item.value = value;
                        dirty = true;
                    }
                },
            ];
        },
        useRef: (initial: any) => (slot().value ??= { current: initial }),
        useEffect: (run: () => void, deps: unknown[]) => effect(effects, run, deps),
        useLayoutEffect: (run: () => void, deps: unknown[]) => effect(layouts, run, deps),
    };
    const state: Props = {
        me: session.me,
        conversationId: session.id,
        view: { conversation: session.conversation },
        sessions: session.sessions,
        projects: [],
        sheet: null,
    };

    active = {
        state,
        hooks: pocket,
        opened,
        closes: 0,
        invalidate: () => {
            dirty = true;
        },
        uid: () => `opening-${++opening}`,
        async api(path: string, body?: Props, options: Props = {}) {
            const response: any = await mockFetch(`/api/${path}`, {
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                signal: options.signal,
            });
            const result = JSON.parse(await response.text());

            if (!response.ok) {
                throw new Error(result.error ?? `HTTP ${response.status}`);
            }

            return result;
        },
    };
    const ui = createSupervisorUi(pocket);
    let visited = new Set<string>();

    const resolve = (node: any, path: string): any => {
        if (Array.isArray(node)) {
            return node.map((child, index) => resolve(child, `${path}.${index}`));
        }

        if (!node?.props) {
            return node;
        }

        if (typeof node.type === "function") {
            const key = `${path}:${node.key ?? ""}`;
            const fiber = fibers.get(key) ?? { slots: [], cursor: 0 };

            fibers.set(key, fiber);
            visited.add(key);
            current = fiber;
            current.cursor = 0;

            return resolve(node.type(node.props), `${key}.child`);
        }

        return { ...node, props: { ...node.props, children: resolve(node.props.children, path) } };
    };

    const render = () => {
        for (let count = 0; dirty; count++) {
            assert.ok(count < 20, "sheet render did not settle");
            dirty = false;
            visited = new Set();
            tree = resolve(h(Sheets, {}), "sheet");

            for (const [key, fiber] of fibers) {
                if (!visited.has(key)) {
                    fiber.slots.forEach((slot) => slot.cleanup?.());
                    fibers.delete(key);
                }
            }

            layouts.splice(0).forEach((run) => run());
            effects.splice(0).forEach((run) => run());
        }
    };

    const show = (fromRow = false) => {
        const logical = ++opening;

        bridge.openSheet({
            type: "work-item-limits",
            id: fromRow ? 1 : session.id,
            userId: session.me.id,
            workItemId: "work-1",
            viewId: session.id,
            opening: logical,
        });
        render();
    };

    const find = (type: string, text?: string) => {
        const node = nodes(tree).find(
            (node) => node.type === type && (text === undefined || textOf(node).trim() === text),
        );

        assert.ok(node, `missing ${type} ${text ?? ""}: ${textOf(tree)}`);

        return node;
    };

    t.after(() => {
        ui.dispose();
        bridge.store.set({ sheet: null });
        render();

        for (const [key, descriptor] of descriptors) {
            if (descriptor) {
                Object.defineProperty(globalThis, key, descriptor);
            } else {
                Reflect.deleteProperty(globalThis, key);
            }
        }
    });

    return {
        requests,
        opened,
        notices,
        navigated,
        render,
        show,
        menu() {
            bridge.openSheet({
                type: "sidebar-options",
                kind: "work-item",
                id: 1,
                at: { touch: true },
            });
            render();
        },
        close() {
            bridge.closeSheet();
            render();
        },
        get closes() {
            return active.closes;
        },
        get session() {
            return session;
        },
        changeSession(change: Props) {
            session = { ...session, ...change };
            bridge.store.set({
                me: session.me,
                conversationId: session.id,
                view: { conversation: session.conversation },
                sessions: session.sessions,
            });
            observers.forEach((listener) => listener(session));
            render();
        },
        button() {
            return ui.SupervisorButton({ session });
        },
        find,
        text: () => textOf(tree),
        input(index: number, value: string) {
            const field = nodes(tree).filter((node) =>
                ["input", "textarea"].includes(String(node.type)),
            )[index];

            assert.ok(field);
            field.props.onInput({ currentTarget: { value } });
            render();
        },
        click(text: string) {
            find("button", text).props.onClick();
            render();
        },
        submit() {
            find("form").props.onSubmit(preventDefault);
            render();
        },
        async settle() {
            await flush();
            render();
        },
    };
}

test("one PiP click creates or reopens its chat without a goal form or duplicate request", async (t) => {
    const f = fixture(t);

    assert.equal(f.button().props["aria-label"], "Open PiP chat");
    assert.equal(f.requests.length, 0);
    f.button().props.onClick();
    f.button().props.onClick();
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.requests[0]!.body, { action: "open" });
    assert.deepEqual(f.opened, []);
    f.requests[0]!.resolve(status());
    await f.settle();
    assert.deepEqual(f.navigated, [99]);
});

test("uncertain one-click delivery waits for an explicit retry instead of replaying creation", async (t) => {
    const f = fixture(t);

    f.button().props.onClick();
    f.requests[0]!.reject(new Error("Connection lost"));
    await f.settle();
    assert.equal(f.requests.length, 1);
    assert.match(f.notices[0]!, /Click PiP again to check or retry/);
    assert.deepEqual(f.navigated, []);
    f.button().props.onClick();
    assert.deepEqual(f.requests[1]!.body, { action: "open" });
    f.requests[1]!.resolve(status({ status: "paused" }));
    await f.settle();
    assert.deepEqual(f.navigated, [99]);
});

test("limits popup contains dollars only, never goal, questions, actions or execution controls", async (t) => {
    const f = fixture(t);

    f.show();
    await f.settle();
    f.requests[0]!.resolve(
        status({ question: { id: "question", text: "Which task should run?" } }),
    );
    await f.settle();
    assert.doesNotMatch(
        f.text(),
        /Finish the implementation|Which task|actions|Pause PiP|Resume PiP|Reclaim|Open PiP|take over/i,
    );
    assert.throws(() => f.find("textarea"));
    assert.equal(f.find("input").props.value, "3.75");
    f.input(0, "2.50");
    f.submit();
    f.submit();
    assert.deepEqual(f.requests[1]!.body, {
        action: "limits",
        budget: 2.5,
        expected: { workItemId: "work-1", conversationId: 99, epoch: 1 },
    });
    assert.equal(f.requests.length, 2);
    f.requests[1]!.resolve(status({ status: "paused", maxCost: 3.75 }));
    await f.settle();
    assert.equal(f.closes, 1);
});

test("uncapped dollars stay optional and clearing the field explicitly removes only the cost cap", async (t) => {
    const f = fixture(t);

    f.show();
    await f.settle();
    f.requests[0]!.resolve(status({ maxCost: undefined, maxActions: undefined, spent: 12.75 }));
    await f.settle();
    assert.match(f.text(), /12.75 spent.*No work cost cap/);
    assert.equal(f.find("input").props.value, "");
    f.submit();
    assert.deepEqual(f.requests[1]!.body, {
        action: "limits",
        budget: null,
        expected: { workItemId: "work-1", conversationId: 99, epoch: 1 },
    });
    f.requests[1]!.resolve(status({ status: "paused", maxCost: undefined }));
    await f.settle();
});

test("reopened limits wait for pending acceptance and read once without replaying the mutation", async (t) => {
    const f = fixture(t);

    f.show();
    await f.settle();
    f.requests[0]!.resolve(status());
    await f.settle();
    f.input(0, "2");
    f.submit();
    f.close();
    f.show();
    await f.settle();
    assert.equal(f.requests.length, 2);
    f.requests[1]!.resolve(status({ status: "paused" }));
    await f.settle();
    assert.equal(f.requests.length, 3);
    f.requests[2]!.resolve(status({ status: "paused" }));
    await f.settle();
    assert.equal(f.closes, 1, "an older acknowledgement cannot close the new opening");
    f.changeSession({
        sessions: f.session.sessions.map((row: Props) => ({
            ...row,
            supervisor: { ...row.supervisor, status: "paused" },
        })),
    });
    f.input(0, "0");
    f.submit();
    assert.equal(f.requests.length, 3);
    assert.match(f.text(), /positive dollar amount/);

    f.input(0, "2");
    f.submit();
    f.requests[3]!.reject(new Error("Connection lost"));
    await f.settle();
    assert.match(f.text(), /may have reached the server.*Reload limits before retrying/);
    f.submit();
    assert.equal(f.requests.length, 4, "an uncertain save is not replayed from stale data");
    f.click("Reload limits");
    await f.settle();
    assert.equal(f.requests[4]!.url, "/api/c/1/orchestrator");
    assert.equal(f.requests[4]!.body, undefined, "explicit recovery reads, rather than resaving");
    f.requests[4]!.resolve(status({ status: "paused", maxCost: 4 }));
    await f.settle();
    assert.equal(f.find("input").props.value, "2.75", "recovery uses fresh server limits");
    assert.equal(f.requests.length, 5);
});

test("late one-click responses cannot redirect another source or owner", async (t) => {
    const f = fixture(t);

    f.button().props.onClick();
    f.changeSession({ id: 2 });
    f.changeSession({ id: 1 });
    f.requests[0]!.resolve(status());
    await f.settle();
    assert.deepEqual(f.navigated, []);
    f.changeSession({ me: { id: "guest", role: "guest" } });
    assert.equal(f.button(), null);
    f.changeSession({ me: { id: "owner", role: "owner" }, id: 99, sessions: [] });
    assert.equal(f.button(), null, "global PiP is not a work controller");
});

test("Work Item menu opens native limits through Sheets when extension UI is unavailable", async (t) => {
    const f = fixture(t);

    f.changeSession({ id: 2 });
    f.menu();
    f.click("Limits…");
    await f.settle();
    assert.doesNotMatch(
        f.text(),
        /Extension UI unavailable/,
        "Work Item limits must not route through extension UI in safe mode",
    );
    assert.equal(f.requests[0]?.url, "/api/c/1/orchestrator");
    f.requests[0]!.resolve(status());
    await f.settle();
    assert.equal(f.find("input").props.value, "3.75");
    f.input(0, "2");
    f.submit();
    assert.deepEqual(f.requests[1]!.body, {
        action: "limits",
        budget: 2,
        expected: { workItemId: "work-1", conversationId: 99, epoch: 1 },
    });
    f.requests[1]!.resolve(status({ status: "reclaimed", epoch: 2, maxCost: 3.25 }));
    await f.settle();
    assert.equal(f.closes, 1);
    assert.deepEqual(
        f.navigated,
        [],
        "limits never navigate to the selected execution or PiP Thread",
    );
});

test("sidebar limits stay bound to the selected Work Item while another conversation is open", async (t) => {
    const f = fixture(t);

    f.changeSession({ id: 2 });
    f.show(true);
    await f.settle();
    assert.equal(f.requests[0]?.url, "/api/c/1/orchestrator");
    f.requests[0]!.resolve(status());
    await f.settle();
    f.input(0, "2");
    f.submit();
    assert.equal(f.requests[1]!.url, "/api/c/1/orchestrator");
    assert.deepEqual(f.requests[1]!.body, {
        action: "limits",
        budget: 2,
        expected: { workItemId: "work-1", conversationId: 99, epoch: 1 },
    });
    f.close();
    f.show(true);
    f.requests[1]!.resolve(status({ status: "paused" }));
    await f.settle();
    assert.equal(f.closes, 1, "a late save cannot dismiss a newer limits opening");
    f.requests[2]!.resolve(status({ status: "paused" }));
    await f.settle();
    f.changeSession({ sessions: [] });
    assert.equal(f.text(), "", "losing access removes the selected item's sheet");
});

test("loaded sidebar limits cannot mutate a renewed grant with unchanged status or redirect after navigation", async (t) => {
    const f = fixture(t);

    f.changeSession({ id: 2 });
    f.show(true);
    await f.settle();
    f.requests[0]!.resolve(status());
    await f.settle();
    f.input(0, "2");
    f.changeSession({
        sessions: [
            {
                id: 1,
                workItemId: "work-1",
                supervisor: { conversationId: 99, status: "running", epoch: 3 },
            },
        ],
    });
    f.submit();
    assert.equal(
        f.requests.length,
        1,
        "a renewed grant requires fresh limits inspection even when status is unchanged",
    );
    f.changeSession({ id: 3 });
    assert.equal(f.text(), "");
    assert.deepEqual(f.navigated, []);
});
