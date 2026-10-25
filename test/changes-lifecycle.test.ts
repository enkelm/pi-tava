// Mount the production Changes hook and mention-list reader with a browser event/clock fixture.
// Only Preact scheduling and HTTP delivery are replaced; refresh ownership and suspension stay real.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test, type TestContext } from "node:test";

type Hook = { value?: unknown; current?: unknown; deps?: unknown[]; cleanup?: () => void };
type Mount = { render: () => unknown; hooks: Hook[]; value?: unknown; disposed?: boolean };
let current: Mount;
let index = 0;
let effects: (() => void)[] = [];

function render(mount: Mount) {
    current = mount;
    index = 0;
    mount.value = mount.render();
    const pending = effects;

    effects = [];

    for (const effect of pending) {
        effect();
    }
}

function useEffect(effect: () => (() => void) | undefined, deps: unknown[]) {
    const mount = current;
    const slot = index++;
    const previous = mount.hooks[slot];

    if (!previous || deps.some((value, position) => !Object.is(value, previous.deps![position]))) {
        const next: Hook = { deps };

        mount.hooks[slot] = next;
        effects.push(() => {
            previous?.cleanup?.();
            next.cleanup = effect();
        });
    }
}

function useState(initial: unknown) {
    const mount = current;
    const hook = (mount.hooks[index++] ??= { value: initial });

    return [
        hook.value,
        (value: unknown) => {
            hook.value = typeof value === "function" ? value(hook.value) : value;
            queueMicrotask(() => !mount.disposed && render(mount));
        },
    ];
}

const listeners = new Set<() => void>();
const fixture = {
    hooks: {
        useEffect,
        useLayoutEffect: useEffect,
        useState,
        useRef: (value: unknown) => (current.hooks[index++] ??= { current: value }),
        useMemo: (make: () => unknown) => make(),
    },
    drafts: [] as {
        id: string;
        agentId: string;
        projectId?: string | null;
        requestId?: string;
        payload?: { projectId?: string | null };
    }[],
    store: {
        state: {
            conversationId: 1 as number | null,
            agentDraft: null as { id: string; agentId: string } | null,
            projects: [] as {
                id: string;
                cwd: string;
                location?: { kind: "ssh"; host: string };
                updatedAt?: number;
            }[],
            namedAgents: [] as {
                agentId: string;
                projectId?: string;
                updatedAt?: number;
                controlRevision?: number;
            }[],
            me: { id: "owner", role: "owner", sessions: undefined as number[] | undefined },
            server: { localReviews: 2, defaultCwd: "/host" },
            view: { agent: { cwd: "/project" }, order: ["entry-1"], live: { busy: false } },
            filesLoaded: 0,
        },
        set(patch: Record<string, unknown>) {
            Object.assign(this.state, patch);

            for (const listener of listeners) {
                listener();
            }
        },
        subscribe(listener: () => void) {
            listeners.add(listener);

            return () => listeners.delete(listener);
        },
    },
    api: async (_path: string, _body?: unknown, _options?: RequestInit): Promise<unknown> => ({}),
};

Object.assign(globalThis, { changesLifecycleFixture: fixture });
const sources: Record<string, string> = {
    "preact/hooks":
        "export const {useState,useRef,useEffect,useLayoutEffect,useMemo} = globalThis.changesLifecycleFixture.hooks;",
    "./store.js": `export const {store} = globalThis.changesLifecycleFixture;
        export const api = (...args) => globalThis.changesLifecycleFixture.api(...args);
        export const canSteer = () => store.state.me?.role !== 'viewer';
        export const actions = { changes: id => api('c/'+id+'/changes'), reviewChanges: id => api('c/'+id+'/reviews/changes') };
        export const attempt=()=>{},notify=()=>{},openSheet=()=>{};`,
    "./agent-drafts.js": `export const selectedAgentDraft=()=>{
        const f=globalThis.changesLifecycleFixture;
        return f.drafts.find(draft=>draft.id===f.store.state.agentDraft?.id)??null;
    };`,
    "./back.js": "export const useBack=()=>{};",
    "./chat.js": "export const jumpToEntry=()=>{};",
    "./highlight.js": "export const highlight=()=>{},highlightLines=()=>{},langOf=()=>{};",
    "./reviews.js":
        "export const ReviewsPanel=()=>{},ReviewThreads=()=>{},useReviewRange=()=>({select(){}});",
    "./sheets/branch.js": "export const branchAvailable=()=>{};",
    "./ui.js":
        "export const html=()=>{},Icon=()=>{},Loader=()=>{},openFile=()=>{},shortPath=()=>{};",
};

registerHooks({
    resolve(specifier, context, next) {
        const parent = context.parentURL && new URL(context.parentURL).pathname;
        const source =
            parent && /\/web\/(diff|files)\.js$/.test(parent) ? sources[specifier] : undefined;

        return source === undefined
            ? next(specifier, context)
            : { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    },
});

const flush = async () => {
    for (let index = 0; index < 20; index++) {
        await Promise.resolve();
    }
};

let instance = 0;

async function setup(t: TestContext) {
    const page = new EventTarget();
    const document = Object.assign(new EventTarget(), { hidden: false });
    const navigator = { onLine: true };
    const descriptors = new Map<string, PropertyDescriptor | undefined>();

    for (const [name, value] of Object.entries({
        document,
        navigator,
        localStorage: { getItem: () => null },
        addEventListener: page.addEventListener.bind(page),
        removeEventListener: page.removeEventListener.bind(page),
    })) {
        descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, { configurable: true, value });
    }

    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 60_000 });
    fixture.drafts = [];
    fixture.store.state = {
        conversationId: 1,
        agentDraft: null,
        projects: [],
        namedAgents: [],
        me: { id: "owner", role: "owner", sessions: undefined },
        server: { localReviews: 2, defaultCwd: "/host" },
        view: { agent: { cwd: "/project" }, order: ["entry-1"], live: { busy: false } },
        filesLoaded: 0,
    };
    const requests: {
        path: string;
        signal?: AbortSignal | null;
        resolve: (data: unknown) => void;
    }[] = [];
    let held = false;

    fixture.api = (path, _body, options) => {
        const promise = new Promise((resolve) => {
            requests.push({ path, signal: options?.signal, resolve });

            if (!held) {
                resolve(
                    path.endsWith("changes")
                        ? { files: [], marker: requests.length }
                        : { files: ["one.txt"], version: "v1", truncated: false },
                );
            }
        });

        return promise;
    };

    const mounts = new Set<Mount>();
    const redraw = () =>
        queueMicrotask(() => {
            for (const mount of mounts) {
                render(mount);
            }
        });

    listeners.add(redraw);
    const diff = await import(
        new URL(`../web/diff.js?changes-lifecycle=${instance++}`, import.meta.url).href
    );
    const files = await import(
        new URL(`../web/files.js?changes-lifecycle=${instance++}`, import.meta.url).href
    );

    const unmount = (mount: Mount) => {
        mount.disposed = true;
        mounts.delete(mount);

        for (const hook of mount.hooks) {
            hook.cleanup?.();
        }
    };

    t.after(() => {
        for (const mount of mounts) {
            unmount(mount);
        }

        listeners.clear();

        for (const [name, descriptor] of descriptors) {
            if (descriptor) {
                Object.defineProperty(globalThis, name, descriptor);
            } else {
                Reflect.deleteProperty(globalThis, name);
            }
        }
    });

    return {
        page,
        document,
        navigator,
        requests,
        diff,
        files,
        unmount,
        hold: () => {
            held = true;
        },
        mount: () => {
            const mount: Mount = { render: () => diff.useChanges(), hooks: [] };

            mounts.add(mount);
            render(mount);

            return mount;
        },
        tick: async (ms: number) => {
            t.mock.timers.tick(ms);
            await flush();
        },
    };
}

for (const suspended of ["hidden", "offline", "departed"]) {
    test(`Changes and mention lists do not read on an initially ${suspended} page`, async (t) => {
        const app = await setup(t);

        if (suspended === "hidden") {
            app.document.hidden = true;
        } else if (suspended === "offline") {
            app.navigator.onLine = false;
        } else {
            app.page.dispatchEvent(new Event("pagehide"));
        }

        app.mount();
        app.files.loadFiles();
        await flush();
        await app.tick(20_000);
        assert.equal(
            app.requests.length,
            0,
            "initial suspension must prevent all background reads",
        );
        app.document.hidden = false;
        app.navigator.onLine = true;
        app.page.dispatchEvent(new Event("online"));
        app.document.dispatchEvent(new Event("visibilitychange"));
        await flush();

        if (suspended === "departed") {
            assert.equal(
                app.requests.length,
                0,
                "online/visibility events cannot reopen a departed page",
            );
            app.page.dispatchEvent(new Event("pageshow"));
            await flush();
        }

        assert.equal(
            app.requests.length,
            1,
            "resume performs one Changes read, not a mention-list replay",
        );
        app.files.loadFiles();
        await flush();
        assert.equal(app.requests.length, 2, "new foreground mention intent can read again");
    });
}

test("staggered Changes consumers share one lifecycle, debounce and explicit refresh", async (t) => {
    const app = await setup(t);
    const first = app.mount();

    await flush();
    await app.tick(200);
    const second = app.mount();

    await flush();
    await app.tick(200);
    const third = app.mount();

    await flush();
    await app.tick(800);
    await app.tick(200);
    await app.tick(200);
    assert.equal(
        app.requests.length,
        1,
        "three staggered first-look timers must not force reads 200ms apart",
    );
    assert.deepEqual(second.value, first.value);
    assert.deepEqual(third.value, first.value);
    fixture.store.state.view.order.push("entry-2");
    fixture.store.set({});
    await flush();
    await app.tick(1199);
    assert.equal(app.requests.length, 1);
    await app.tick(1);
    assert.equal(app.requests.length, 2, "all three consumers share the quiet debounce");
    await app.tick(60_000);
    assert.equal(app.requests.length, 2, "a quiet conversation does not poll");
    await app.diff.reloadChanges();
    await flush();
    assert.equal(
        app.requests.length,
        3,
        "explicit Refresh still reads unchanged conversation state",
    );
    app.hold();
    const refresh = app.diff.reloadChanges();
    const sameRefresh = app.diff.reloadChanges();

    assert.equal(
        app.requests.length,
        4,
        "concurrent explicit Refresh actions share one pending read",
    );
    app.requests.at(-1)!.resolve({ files: [], marker: "refreshed" });
    await Promise.all([refresh, sameRefresh]);
    await flush();
    const abandoned = app.diff.reloadChanges();
    const request = app.requests.at(-1)!;

    app.unmount(first);
    assert.equal(
        request.signal?.aborted,
        false,
        "one departing reader must not cancel another reader's request",
    );
    app.unmount(second);
    app.unmount(third);
    assert.equal(request.signal?.aborted, true, "the last reader aborts the shared request");
    request.resolve({ files: [], marker: "abandoned" });
    await abandoned;
    fixture.store.state.view.order.push("entry-3");
    fixture.store.set({});
    await app.tick(20_000);
    assert.equal(app.requests.length, 5, "the last consumer releases the lifecycle");
});

test("Changes share busy refresh budgets and suspend debounced work until one foreground return", async (t) => {
    const app = await setup(t);

    app.mount();
    app.mount();
    await flush();
    fixture.store.state.view.live.busy = true;
    fixture.store.set({});
    await flush();

    for (let index = 0; index < 7; index++) {
        await app.tick(1000);
        fixture.store.state.view.order.push(`busy-${index}`);
        fixture.store.set({});
        await flush();
    }

    assert.equal(app.requests.length, 1, "streaming entries share one busy debounce");
    await app.tick(1000);
    assert.equal(
        app.requests.length,
        2,
        "continued entries cannot postpone a read beyond the busy maximum",
    );
    fixture.store.state.view.order.push("next-entry");
    fixture.store.set({});
    app.navigator.onLine = false;
    app.page.dispatchEvent(new Event("offline"));
    await app.tick(20_000);
    assert.equal(app.requests.length, 2, "offline cancels the pending shared debounce");
    await app.diff.reloadChanges();
    assert.equal(app.requests.length, 2, "even explicit stale actions do not read while offline");
    app.navigator.onLine = true;
    app.page.dispatchEvent(new Event("online"));
    app.page.dispatchEvent(new Event("online"));
    await flush();
    assert.equal(app.requests.length, 3, "online return checks once for both consumers");
    app.document.hidden = true;
    app.document.dispatchEvent(new Event("visibilitychange"));
    await app.tick(20_000);
    app.document.hidden = false;
    app.document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    assert.equal(app.requests.length, 4, "visibility return also checks external edits just once");
    await app.tick(20_000);
    assert.equal(app.requests.length, 4, "unchanged busy state alone is not a status poller");
    app.hold();
    const read = app.diff.reloadChanges();
    const request = app.requests.at(-1)!;

    app.navigator.onLine = false;
    app.page.dispatchEvent(new Event("offline"));
    assert.equal(
        request.signal?.aborted,
        true,
        "offline also aborts an already-dispatched Changes read",
    );
    request.resolve({ files: [], marker: "offline" });
    await read;
});

test("Changes cancel on departure and scope replacement without publishing late data", async (t) => {
    const app = await setup(t);

    app.hold();
    const mount = app.mount();

    await flush();
    const first = app.requests[0]!;

    app.page.dispatchEvent(new Event("pagehide"));
    assert.equal(first.signal?.aborted, true, "departure aborts the active Changes request");
    first.resolve({ files: [], marker: "departed" });
    await flush();
    assert.equal((mount.value as { changes: unknown }).changes, null);
    app.page.dispatchEvent(new Event("pageshow"));
    await flush();
    assert.equal(app.requests.length, 2);
    const oldCwd = app.requests[1]!;

    fixture.store.state.view.agent.cwd = "/other-project";
    fixture.store.set({});
    await flush();
    assert.equal(oldCwd.signal?.aborted, true);
    oldCwd.resolve({ files: [], marker: "old-cwd" });
    await flush();
    assert.equal((mount.value as { changes: unknown }).changes, null);
    const oldAuth = app.requests.at(-1)!;

    fixture.store.set({ me: { id: "guest", role: "viewer", sessions: [1] } });
    await flush();
    assert.equal(oldAuth.signal?.aborted, true);
    oldAuth.resolve({ files: [], marker: "old-person" });
    const current = app.requests.at(-1)!;

    assert.match(current.path, /reviews\/changes$/);
    current.resolve({ files: [], marker: "current" });
    await flush();
    assert.equal((mount.value as { changes: { marker: string } }).changes.marker, "current");
    fixture.store.set({ me: { id: "guest", role: "viewer", sessions: [1, 2] } });
    await flush();
    assert.equal(
        (mount.value as { changes: unknown }).changes,
        null,
        "same-person scope changes cannot reuse old answers",
    );
    app.requests.at(-1)!.resolve({ files: [], marker: "new-scope" });
    await flush();
    fixture.store.set({ server: { localReviews: 0 } });
    await flush();
    assert.equal(
        (mount.value as { changes: unknown }).changes,
        null,
        "viewers cannot reuse review data as working Changes",
    );
    const before = app.requests.length;

    await app.diff.reloadChanges();
    assert.equal(app.requests.length, before);
    fixture.store.set({ me: { id: "guest", role: "guest", sessions: [1] } });
    await flush();
    assert.match(app.requests.at(-1)!.path, /^c\/1\/changes$/);
    app.requests.at(-1)!.resolve({ files: [], marker: "working" });
    await flush();
    assert.equal((mount.value as { changes: { marker: string } }).changes.marker, "working");
    fixture.store.set({ conversationId: 2 });
    await flush();
    assert.match(app.requests.at(-1)!.path, /^c\/2\/changes$/);
    assert.equal((mount.value as { changes: unknown }).changes, null);
});

test("mention lists are caller/cwd scoped and discard cancelled late results", async (t) => {
    const app = await setup(t);

    app.hold();
    app.files.loadFiles({ ifMissing: true });
    app.page.dispatchEvent(new Event("pagehide"));
    assert.equal(app.requests[0]!.signal?.aborted, true);
    app.page.dispatchEvent(new Event("pageshow"));
    app.files.loadFiles({ ifMissing: true });
    assert.equal(app.requests.length, 2, "new focus retries an abandoned initial list");
    app.requests.at(-1)!.resolve({ files: ["one.txt"], version: "v1", truncated: false });
    await flush();
    assert.equal(app.files.suggestFiles("").items[0].path, "one.txt");
    fixture.store.state.view.agent.cwd = "/other-project";
    fixture.store.set({});
    assert.equal(app.files.suggestFiles("").items.length, 0, "new cwd must not display old paths");
    app.files.loadFiles();
    const old = app.requests.at(-1)!;

    fixture.store.set({ me: { id: "guest", role: "guest", sessions: [1] } });
    assert.equal(old.signal?.aborted, true);
    old.resolve({ files: ["private.txt"], version: "v2", truncated: false });
    await flush();
    assert.equal(
        app.files.suggestFiles("").items.length,
        0,
        "a late result cannot publish another person's paths",
    );
    app.files.loadFiles();
    app.requests.at(-1)!.resolve({ files: ["guest.txt"], version: "v3", truncated: false });
    await flush();
    assert.equal(app.files.suggestFiles("").items[0].path, "guest.txt");
    const before = app.requests.length;

    app.files.loadFiles();
    assert.equal(app.requests.length, before, "fresh mentions reuse the exact caller's list");
    await app.tick(5000);
    app.files.loadFiles();
    assert.match(app.requests.at(-1)!.path, /\?since=v3$/);
    app.document.hidden = true;
    app.document.dispatchEvent(new Event("visibilitychange"));
    assert.equal(app.requests.at(-1)!.signal?.aborted, true);
    app.document.hidden = false;
    app.document.dispatchEvent(new Event("visibilitychange"));
    const beforeRetry = app.requests.length;

    app.files.loadFiles();
    assert.equal(
        app.requests.length,
        beforeRetry + 1,
        "a cancelled refresh does not count as a fresh answer",
    );
});

// The client owns draft-local cache/cancellation; native composition tests own the listing's
// workspace and inline bytes. Two drafts of one identity must not share the previous root's names.
test("draft mentions follow the selected project, exact draft and frozen first-send context", async (t) => {
    const app = await setup(t);
    const first = { id: "first", agentId: "ada", projectId: "local" };
    const second = { id: "second", agentId: "ada", projectId: "remote" };

    fixture.drafts = [first, second];
    fixture.store.set({
        conversationId: null,
        agentDraft: { id: first.id, agentId: first.agentId },
        namedAgents: [{ agentId: "ada", projectId: "local", updatedAt: 1 }],
        projects: [
            { id: "local", cwd: "/local" },
            { id: "remote", cwd: "/remote", location: { kind: "ssh", host: "box" } },
        ],
    });
    app.hold();
    app.files.loadFiles();
    app.requests
        .at(-1)!
        .resolve({ files: ["local-only.txt"], version: "local-v1", truncated: false });
    await flush();
    assert.equal(app.files.suggestFiles("").items[0].path, "local-only.txt");
    fixture.store.set({ agentDraft: { id: second.id, agentId: second.agentId } });
    assert.deepEqual(
        app.files.suggestFiles("").items,
        [],
        "SSH draft cannot reuse local namesakes",
    );
    app.files.loadFiles();
    const remote = app.requests.at(-1)!;

    assert.equal(new URL(remote.path, "https://fixture/").searchParams.get("projectId"), "remote");
    fixture.store.set({ agentDraft: { id: first.id, agentId: first.agentId } });
    assert.equal(remote.signal?.aborted, true);
    remote.resolve({ files: ["remote-only.txt"], version: "remote-v1", truncated: false });
    await flush();
    assert.equal(app.files.suggestFiles("").items[0].path, "local-only.txt");

    for (const [draft, expected] of [
        [{ id: "unassigned", agentId: "ada", projectId: null }, ""],
        [{ id: "default", agentId: "ada" }, null],
        [
            {
                id: "retry",
                agentId: "ada",
                projectId: "remote",
                requestId: "uncertain",
                payload: { projectId: "local" },
            },
            "local",
        ],
    ] as const) {
        fixture.drafts.push(draft);
        fixture.store.set({ agentDraft: { id: draft.id, agentId: draft.agentId } });
        app.files.loadFiles();
        const request = app.requests.at(-1)!;
        const params = new URL(request.path, "https://fixture/").searchParams;

        assert.equal(params.get("projectId"), expected);
        assert.equal(params.get("requestId"), "requestId" in draft ? draft.requestId : null);
        request.resolve({ files: [`${draft.id}.txt`], version: draft.id, truncated: false });
        await flush();
        assert.equal(app.files.suggestFiles("").items[0].path, `${draft.id}.txt`);
    }

    fixture.store.set({ agentDraft: { id: "default", agentId: "ada" } });
    assert.equal(app.files.suggestFiles("").items[0].path, "default.txt");
    fixture.store.set({
        projects: fixture.store.state.projects.map((project) =>
            project.id === "local" ? { ...project, cwd: "/moved-default" } : project,
        ),
    });
    assert.deepEqual(
        app.files.suggestFiles("").items,
        [],
        "editing the identity's effective default project also invalidates its cached paths",
    );
    app.files.loadFiles();
    const moved = app.requests.at(-1)!;

    assert.equal(new URL(moved.path, "https://fixture/").searchParams.has("since"), false);
    fixture.store.set({ namedAgents: [{ agentId: "ada", projectId: "remote", updatedAt: 2 }] });
    assert.equal(moved.signal?.aborted, true, "changing the identity default cancels the old root");
    moved.resolve({ files: ["old-default.txt"], version: "moved", truncated: false });
    await flush();
    assert.deepEqual(app.files.suggestFiles("").items, [], "the former default cannot republish");
});
