// Browser eligibility owner: shared reads against fake browser events and deferred API replies.
// No app server or UI subscribers are required; lifecycle and scope fences are the contracts.
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";
import type { TestContext } from "node:test";

const { createHandoffState } = await import(
    new URL("../src/server/extensions/work-items/state.js", import.meta.url).href
);
const { default: setup } = await import(
    new URL("../src/server/extensions/work-items/index.js", import.meta.url).href
);
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const makeSession = () => ({
    me: { id: "alice", role: "owner" },
    id: 1,
    canSteer: true,
    busy: false,
    conversation: { kind: "session" },
    sessions: [{ id: 1, workflow: { readOnly: false } }],
    profiles: [{ id: "worker", name: "Worker" }],
});

type Session = ReturnType<typeof makeSession>;
type Data = {
    marker: string;
    options?: { targetType: string; relationship: string; enabled: boolean }[];
};
type Context = {
    session: Session;
    status: { data: Data | null; loading: boolean; error: string };
};
type Request = {
    id: number;
    signal: AbortSignal;
    resolve: (data: Data) => void;
    reject: (error: Error) => void;
};

function fixture(t: TestContext, visibilityState = "visible", onLine = true) {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const document = Object.assign(new EventTarget(), { visibilityState });
    const window = new EventTarget();
    const navigator = { onLine };
    const descriptors = new Map<string, PropertyDescriptor | undefined>();

    for (const [name, value] of Object.entries({ document, window, navigator })) {
        descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, { configurable: true, value });
    }

    let session = makeSession();
    let context: Context;
    const observers = new Set<(value: Session) => void>();
    const effects: (() => void)[] = [];
    const requests: Request[] = [];
    let suggest: (text: string) => Promise<unknown[]>;
    let contributionUpdates = 0;
    const pocket = {
        session: () => session,
        onSessionChange(listener: (value: Session) => void) {
            observers.add(listener);

            return () => observers.delete(listener);
        },
        sessionApi(id: number, path: string, _body: undefined, options: { signal: AbortSignal }) {
            assert.equal(path, "handoffs");

            // Ignore abort here: real responses can race suspension or identity changes.
            return new Promise<Data>((resolve, reject) => {
                requests.push({ id, signal: options.signal, resolve, reject });
            });
        },
        useState(initial: () => Context) {
            context = initial();

            return [context, (value: Context) => (context = value)];
        },
        useEffect(effect: () => () => void) {
            effects.push(effect());
        },
        onDispose: (stop: () => void) => effects.push(stop),
        style() {},
        sessionControl() {},
        sheet() {},
        inputCommand(spec: { suggest: typeof suggest }) {
            suggest = spec.suggest;

            return {
                update(patch: { suggest: typeof suggest }) {
                    assert.notEqual(
                        patch.suggest,
                        suggest,
                        "hint updates replace the contribution",
                    );
                    suggest = patch.suggest;
                    contributionUpdates++;
                },
            };
        },
    };
    const state = createHandoffState(pocket);

    t.after(() => {
        state.dispose();
        effects.forEach((stop) => stop());

        for (const [name, descriptor] of descriptors) {
            if (descriptor) {
                Object.defineProperty(globalThis, name, descriptor);
            } else {
                Reflect.deleteProperty(globalThis, name);
            }
        }
    });

    return {
        state,
        requests,
        document,
        window,
        navigator,
        observers,
        get contributionUpdates() {
            return contributionUpdates;
        },
        installHints() {
            state.dispose();
            setup(pocket);

            return (text: string) => suggest(text);
        },
        mountContext() {
            state.useContext();
        },
        get context() {
            return context;
        },
        setSession(value: Session) {
            session = value;
            observers.forEach((listener) => listener(value));
        },
        async tick(ms = 10_000) {
            t.mock.timers.tick(ms);
            await flush();
        },
    };
}

test("context reads share and cache but mounted controls do not create polling demand", async (t) => {
    const f = fixture(t);

    await flush();
    assert.equal(f.requests.length, 1);
    const read = f.state.read(1);
    const refresh = f.state.refresh(1);

    await f.tick();
    assert.equal(f.requests.length, 1, "a poll joins the read already in flight");
    const data = { marker: "initial" };

    f.requests[0]!.resolve(data);
    assert.deepEqual(await Promise.all([read, refresh]), [data, data]);
    assert.deepEqual(await f.state.read(1), data);
    assert.equal(f.requests.length, 1);
    f.setSession({ ...makeSession(), busy: true });
    await flush();
    assert.equal(f.requests.length, 2, "a relevant session change refreshes eligibility");
    f.requests[1]!.resolve({ marker: "busy" });
    await flush();
    f.mountContext();
    f.mountContext();
    await f.tick(60_000);
    assert.equal(f.requests.length, 2, "header/composer subscribers alone must not keep polling");
    const failed = f.state.refresh(1);

    await flush();
    const rejected = assert.rejects(failed, /unavailable/);

    f.requests[2]!.reject(new Error("unavailable"));
    await rejected;
    const retry = f.state.read(1);

    await flush();
    assert.equal(f.requests.length, 4, "a failed read permits a fresh retry");
    f.requests[3]!.resolve({ marker: "retry" });
    assert.deepEqual(await retry, { marker: "retry" });
});

for (const reason of ["hidden", "offline", "pagehide"] as const) {
    test(`${reason} suspends and fences replies across one fresh resume`, async (t) => {
        const f = fixture(t);

        f.mountContext();
        f.state.watchPicker(1);
        await flush();
        const obsolete = f.state.read(1);

        if (reason === "hidden") {
            f.document.visibilityState = "hidden";
            f.document.dispatchEvent(new Event("visibilitychange"));
        } else if (reason === "offline") {
            f.navigator.onLine = false;
            f.window.dispatchEvent(new Event("offline"));
        } else {
            f.window.dispatchEvent(new Event("pagehide"));
        }

        assert.equal(f.requests[0]!.signal.aborted, true);
        assert.equal(f.context.status.loading, false);
        assert.equal(await f.state.read(1), null);
        assert.equal(await f.state.refresh(1), null);
        await f.tick(60_000);
        assert.equal(f.requests.length, 1);

        if (reason === "pagehide") {
            f.document.dispatchEvent(new Event("visibilitychange"));
            f.window.dispatchEvent(new Event("online"));
            f.setSession({ ...makeSession(), busy: true });
            await f.tick();
            assert.equal(f.requests.length, 1, "stray events cannot resume a departed page");
        }

        f.document.visibilityState = "visible";
        f.navigator.onLine = true;
        f.document.dispatchEvent(new Event("visibilitychange"));
        f.window.dispatchEvent(new Event("online"));
        f.window.dispatchEvent(new Event("pageshow"));
        await flush();
        assert.equal(f.requests.length, 2, "resume events share one fresh read");
        const current = f.state.read(1);

        f.requests[0]!.resolve({ marker: "obsolete" });
        assert.equal(await obsolete, null, "a pre-suspension response stays fenced on resume");
        assert.equal(f.context.status.data, null);
        assert.equal(f.context.status.loading, true);
        assert.equal(f.state.read(1), current, "an old request cannot clear the resumed read");
        f.requests[1]!.resolve({ marker: "current" });
        assert.deepEqual(await current, { marker: "current" });
        assert.deepEqual(f.context.status.data, { marker: "current" });
        f.document.dispatchEvent(new Event("visibilitychange"));
        f.window.dispatchEvent(new Event("online"));
        f.window.dispatchEvent(new Event("pageshow"));
        await flush();
        assert.equal(f.requests.length, 2, "redundant events do not re-read a settled scope");
        await f.tick();
        assert.equal(f.requests.length, 3);
    });
}

test("initial suspension resumes only the latest source and person", async (t) => {
    const f = fixture(t, "hidden", false);

    await flush();
    assert.equal(f.requests.length, 0);
    assert.equal(await f.state.refresh(1), null);
    f.setSession({ ...makeSession(), me: { id: "bob", role: "guest" }, id: 2 });
    f.document.visibilityState = "visible";
    f.document.dispatchEvent(new Event("visibilitychange"));
    f.window.dispatchEvent(new Event("pageshow"));
    await f.tick(60_000);
    assert.equal(f.requests.length, 0, "visibility alone cannot resume an offline page");
    f.navigator.onLine = true;
    f.window.dispatchEvent(new Event("online"));
    await flush();
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0]!.id, 2);
    assert.equal(await f.state.read(1), null);
    const current = f.state.read(2);

    f.requests[0]!.resolve({ marker: "bob/source-2" });
    assert.deepEqual(await current, { marker: "bob/source-2" });
});

test("suspension before dispatch cancels queued work across immediate resume", async (t) => {
    const f = fixture(t);
    const obsolete = f.state.read(1);

    f.window.dispatchEvent(new Event("pagehide"));
    f.window.dispatchEvent(new Event("pageshow"));
    await flush();
    assert.equal(f.requests.length, 1, "only the fresh request reaches the API");
    const current = f.state.read(1);

    f.requests[0]!.resolve({ marker: "resumed" });
    assert.equal(await obsolete, null);
    assert.deepEqual(await current, { marker: "resumed" });
});

test("user, role, source and steering changes fence stale replies", async (t) => {
    const f = fixture(t);

    f.mountContext();
    await flush();
    const oldPerson = f.state.read(1);
    const bob = { ...makeSession(), me: { id: "bob", role: "guest" } };

    f.setSession(bob);
    await flush();
    assert.equal(f.requests[0]!.signal.aborted, true);
    const oldSource = f.state.read(1);
    const source = { ...bob, id: 2 };

    f.setSession(source);
    await flush();
    assert.equal(f.requests[1]!.signal.aborted, true);
    const oldRole = f.state.read(2);
    const role = { ...source, me: { ...source.me, role: "viewer" } };

    f.setSession(role);
    await flush();
    assert.equal(f.requests[2]!.signal.aborted, true);
    const oldSteering = f.state.read(2);

    f.setSession({ ...role, canSteer: false });
    await flush();
    assert.equal(f.requests[3]!.signal.aborted, true);
    assert.equal(f.requests.length, 5);
    const current = f.state.read(2);

    f.requests[4]!.resolve({ marker: "current" });
    await current;
    f.requests[0]!.resolve({ marker: "old-person" });
    f.requests[1]!.reject(new Error("old-source"));
    f.requests[2]!.resolve({ marker: "old-role" });
    f.requests[3]!.resolve({ marker: "old-steering" });
    assert.deepEqual(await Promise.all([oldPerson, oldSource, oldRole, oldSteering]), [
        null,
        null,
        null,
        null,
    ]);
    assert.deepEqual(f.context.status, {
        data: { marker: "current" },
        loading: false,
        error: "",
    });
});

test("dispose aborts reads, removes subscriptions and prevents revival", async (t) => {
    const f = fixture(t);

    await flush();
    const pending = f.state.read(1);

    f.state.dispose();
    assert.equal(f.requests[0]!.signal.aborted, true);
    assert.equal(f.observers.size, 0);
    assert.equal(getEventListeners(f.document, "visibilitychange").length, 0);

    for (const event of ["online", "offline", "pagehide", "pageshow"]) {
        assert.equal(getEventListeners(f.window, event).length, 0);
        f.window.dispatchEvent(new Event(event));
    }

    f.document.dispatchEvent(new Event("visibilitychange"));
    f.setSession({ ...makeSession(), id: 2 });
    assert.equal(await f.state.refresh(1), null);
    assert.equal(await f.state.read(1), null);
    await f.tick(60_000);
    assert.equal(f.requests.length, 1);
    f.requests[0]!.resolve({ marker: "disposed" });
    assert.equal(await pending, null);
});

test("only live Picker demand polls, shares one timer and cleans up on the last close", async (t) => {
    const f = fixture(t);

    await flush();
    f.requests[0]!.resolve({ marker: "baseline" });
    await flush();
    const closeFirst = f.state.watchPicker(1);
    const closeSecond = f.state.watchPicker(1);

    await f.tick();
    assert.equal(f.requests.length, 2);
    f.requests[1]!.resolve({ marker: "one-shared-poll" });
    await flush();
    closeFirst();
    await f.tick();
    assert.equal(f.requests.length, 3, "the remaining picker keeps the one shared timer");
    f.requests[2]!.resolve({ marker: "last-poll" });
    await flush();
    closeSecond();
    closeSecond();
    await f.tick(60_000);
    assert.equal(f.requests.length, 3, "no timer remains after the last picker closes");
});

test("a context invalidation during a read replaces its result with one fresh follow-up", async (t) => {
    const f = fixture(t);

    f.mountContext();
    await flush();
    const shared = f.state.read(1);
    let settled = false;

    shared.then(() => (settled = true));
    f.setSession({ ...makeSession(), busy: true });
    f.setSession({ ...makeSession(), busy: false });
    f.requests[0]!.resolve({ marker: "obsolete-before-busy-completed" });
    await flush();
    assert.equal(f.requests.length, 2, "invalidations coalesce into a read after the old one");
    assert.equal(settled, false, "callers must wait for the fresh follow-up, not stale options");
    assert.equal(f.context.status.data, null, "an invalidated response cannot populate controls");
    assert.equal(f.state.read(1), shared, "all callers share the full freshness chain");
    f.requests[1]!.resolve({ marker: "after-completion" });
    assert.deepEqual(await shared, { marker: "after-completion" });
    await f.tick(60_000);
    assert.equal(f.requests.length, 2, "context changes do not create a periodic timer");
});

test("an invalidated failed read still follows through to current eligibility", async (t) => {
    const f = fixture(t);

    await flush();
    const shared = f.state.read(1);

    f.setSession({ ...makeSession(), busy: true });
    f.requests[0]!.reject(new Error("obsolete failure"));
    await flush();
    assert.equal(f.requests.length, 2);
    f.requests[1]!.resolve({ marker: "fresh" });
    assert.deepEqual(await shared, { marker: "fresh" });
});

test("command hints refresh settled cache and share pending reads without an idle timer", async (t) => {
    const f = fixture(t);
    const suggest = f.installHints();

    await flush();
    f.requests[0]!.resolve({ marker: "baseline", options: [] });
    await flush();
    const first = suggest("/handoff re");
    const second = suggest("/handoff rev");

    await flush();
    assert.equal(f.requests.length, 2, "routing demand must not use old checkout eligibility");
    f.requests[1]!.resolve({
        marker: "fresh",
        options: [{ targetType: "reviewer", relationship: "same-work", enabled: true }],
    });
    assert.equal((await first).length, 1);
    assert.equal((await second).length, 1);
    const later = suggest("/handoff rev");

    await flush();
    assert.equal(f.requests.length, 3, "each new routing request rechecks settled eligibility");
    f.requests[2]!.resolve({ marker: "diff-removed", options: [] });
    assert.deepEqual(await later, [], "removed checkout eligibility cannot survive in hints");
    await f.tick(60_000);
    assert.equal(f.requests.length, 3, "completion demand cannot keep an interval alive");
    assert.equal(f.contributionUpdates, 0, "request completion cannot trigger a hint refresh loop");
    f.setSession({
        ...makeSession(),
        sessions: [{ id: 1, workflow: { readOnly: true } }],
    });
    await flush();
    assert.equal(f.contributionUpdates, 1, "workflow changes must invalidate displayed hints");
    const changed = suggest("/handoff rev");

    assert.equal(f.requests.length, 4, "the new hint joins the context invalidation read");
    f.requests[3]!.resolve({ marker: "read-only", options: [] });
    assert.deepEqual(await changed, []);
    assert.equal(
        f.contributionUpdates,
        1,
        "settling replacement hints cannot invalidate them again",
    );
});

test("read-only context tracks its Work Item catalogue but ignores unrelated activity", async (t) => {
    const f = fixture(t);
    const source = {
        id: 1,
        workflow: { readOnly: true },
        workItemId: "item",
        threadType: "worker",
    };
    let session = {
        ...makeSession(),
        sessions: [source, { ...source, id: 2 }, { ...source, id: 3, workItemId: "other" }],
    };

    f.setSession(session);
    await flush();
    f.requests[0]!.resolve({ marker: "read-only-context" });
    await flush();
    session = {
        ...session,
        sessions: session.sessions.map((each) => (each.id === 3 ? { ...each, busy: true } : each)),
    };
    f.setSession(session);
    await f.tick(60_000);
    assert.equal(f.requests.length, 1, "unrelated threads cannot keep read-only context polling");
    session = {
        ...session,
        sessions: session.sessions.map((each) => (each.id === 2 ? { ...each, busy: true } : each)),
    };
    f.setSession(session);
    await flush();
    assert.equal(
        f.requests.length,
        2,
        "busy state of another Work Item member affects eligibility",
    );
    f.requests[1]!.resolve({ marker: "related-busy" });
    await flush();
    f.setSession({
        ...session,
        sessions: session.sessions.filter((each) => each.id !== 2),
    });
    await flush();
    assert.equal(f.requests.length, 3, "membership/visibility changes refresh the context");
    f.requests[2]!.resolve({ marker: "membership-changed" });
    await flush();
    await f.tick(60_000);
    assert.equal(f.requests.length, 3);
});
