// The real store owns original-discussion navigation, source-access preflight and late-link
// fencing. Browser history/storage/events and HTTP delivery are stand-ins, not navigation mocks.
// No listener, real transport, application data, or production test export is involved.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test, type TestContext } from "node:test";

function storage() {
    const values = new Map<string, string>();

    return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, String(value)),
        removeItem: (key: string) => values.delete(key),
    };
}

// Isolate the real history module alongside each separately loaded browser store.
registerHooks({
    resolve(specifier, context, next) {
        const result = next(specifier, context);

        if (
            specifier === "./back.js" &&
            context.parentURL?.includes("/web/store.js?review-navigation=")
        ) {
            return { ...result, url: result.url + new URL(context.parentURL).search };
        }

        return result;
    },
});
type HistoryState = { pocket: { layers: number; back?: number } };
let instance = 0;

async function browser(t: TestContext) {
    const number = ++instance;
    const opening = number * 10;
    const source = opening + 1;
    const page = new EventTarget();
    const document = Object.assign(new EventTarget(), {
        visibilityState: "visible",
        documentElement: { dataset: { focus: "people-panel" } },
        querySelector: () => ({ content: "fixture-web" }),
    });
    const location = {
        pathname: `/s/${opening}`,
        hostname: "example.test",
        href: `https://example.test/s/${opening}`,
    };
    const sessionStorage = storage();
    const routes: string[] = [];
    const requests: { url: string; options: RequestInit; resolve: (response: Response) => void }[] =
        [];
    const history = {
        state: { pocket: { layers: 0 } },
        pushState(state: HistoryState, _title: string, path: string) {
            this.state = state;
            location.pathname = path;
            location.href = `https://example.test${path}`;
            routes.push(path);
        },
        replaceState(state: HistoryState, title: string, path: string) {
            this.pushState(state, title, path);
        },
    };
    const globals = {
        document,
        navigator: { onLine: true },
        localStorage: storage(),
        sessionStorage,
        location,
        history,
        addEventListener: page.addEventListener.bind(page),
        removeEventListener: page.removeEventListener.bind(page),
        matchMedia: () => ({ matches: false, addEventListener() {} }),
        EventSource: class {
            addEventListener() {}
            close() {}
        },
    };
    const descriptors = new Map<string, PropertyDescriptor | undefined>();

    for (const [name, value] of Object.entries(globals)) {
        descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, { configurable: true, value });
    }

    t.mock.timers.enable({ apis: ["setTimeout"] });
    t.mock.method(globalThis, "fetch", (url: string, options: RequestInit = {}) => {
        assert.ok(url.endsWith("/reviews"), `unexpected fetch: ${url}`);

        return new Promise<Response>((resolve) => requests.push({ url, options, resolve }));
    });
    const module = await import(
        new URL(`../web/store.js?review-navigation=${number}`, import.meta.url).href
    );
    const { store } = module;

    store.set({
        me: { id: "viewer", role: "viewer" },
        server: { localReviews: 2 },
        browserOpen: true,
        filesTab: "files",
        drawer: true,
        sheet: { type: "chat" },
        peopleOpen: true,
    });
    t.after(() => {
        page.dispatchEvent(new Event("pagehide"));

        for (const [name, descriptor] of descriptors) {
            if (descriptor) {
                Object.defineProperty(globalThis, name, descriptor);
            } else {
                Reflect.deleteProperty(globalThis, name);
            }
        }
    });

    return {
        ...module,
        opening,
        source,
        page,
        document,
        location,
        routes,
        requests,
        sessionStorage,
    };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const discussion = (threadId: string) =>
    Response.json({ threads: [{ id: threadId, resolved: false }] });
const genericError = "That review discussion is unavailable. Check your access and try again.";

test("review links preflight source visibility then open its exact discussion through per-thread Changes", async (t) => {
    const b = await browser(t);
    const pending = b.revealReviewThread(
        { conversationId: b.source, threadId: "original-thread" },
        { reply: true },
    );

    assert.equal(
        b.store.state.conversationId,
        b.opening,
        "access must be checked before leaving the current thread",
    );
    assert.deepEqual(b.routes, []);
    assert.equal(b.requests.length, 1);
    const request = b.requests[0]!;

    assert.equal(request.options.method, "GET");
    request.resolve(discussion("original-thread"));
    await pending;
    await flush();
    assert.equal(b.store.state.conversationId, b.source);
    assert.deepEqual(b.store.state.reviewTarget, {
        conversationId: b.source,
        threadId: "original-thread",
        reply: true,
        n: 1,
    });
    assert.equal(b.store.state.filesOpen, true);
    assert.equal(b.store.state.filesTab, "changes");
    assert.equal(b.store.state.filesAsk.tab, "changes");
    assert.equal(
        b.filesShown(),
        true,
        "a scoped reviewer sees Changes without generic Files authority",
    );
    assert.equal(b.store.state.browserOpen, false);
    assert.equal(b.store.state.peopleOpen, false);
    assert.equal(b.store.state.drawer, false);
    assert.equal(b.store.state.sheet, null);
    assert.equal(b.document.documentElement.dataset.focus, "pane");
    assert.deepEqual(b.routes, [`/s/${b.source}`]);
    assert.deepEqual(JSON.parse(b.sessionStorage.getItem(`pocket.panels.${b.source}`)!), {
        panel: "files",
        filesTab: "changes",
    });
    b.navigate(b.opening);
    assert.equal(
        b.store.state.filesOpen,
        false,
        "the source's Changes panel does not leak back into the fork",
    );
    assert.equal(b.store.state.browserOpen, true);
    assert.equal(b.store.state.filesTab, "files");
    b.navigate(b.source);
    assert.equal(b.store.state.filesOpen, true);
    assert.equal(
        b.store.state.filesTab,
        "changes",
        "normal per-thread panel restoration retains Changes",
    );
    assert.equal(
        b.store.state.reviewTarget,
        null,
        "a transient exact-thread request is not replayed by Back",
    );
    assert.equal(
        request.url,
        `/api/c/${b.source}/reviews`,
        "preflight uses the canonical source review endpoint",
    );
});

test("missing or revoked original discussions do not navigate or expose source errors", async (t) => {
    for (const outcome of ["missing-thread", "missing-source", "revoked-source"]) {
        await t.test(outcome, async (t) => {
            const b = await browser(t);
            const view = b.store.state.view;
            const pending = b.revealReviewThread({
                conversationId: b.source,
                threadId: "not-visible",
            });
            const response =
                outcome === "missing-thread"
                    ? discussion("different-thread")
                    : Response.json(
                          { error: "Private source details must not be shown" },
                          { status: outcome === "missing-source" ? 404 : 403 },
                      );

            b.requests[0]!.resolve(response);
            await pending;
            assert.equal(b.store.state.conversationId, b.opening);
            assert.equal(b.store.state.view, view);
            assert.equal(b.store.state.reviewTarget, null);
            assert.equal(b.store.state.filesOpen, false);
            assert.deepEqual(b.routes, []);
            assert.equal(b.store.state.notices.length, 1);
            assert.equal(b.store.state.notices[0].level, "error");
            assert.equal(b.store.state.notices[0].message, genericError);
        });
    }
});

test("route departure invalidates a pending source link even after returning to the opening thread", async (t) => {
    for (const returned of [false, true]) {
        await t.test(returned ? "returned" : "departed", async (t) => {
            const b = await browser(t);
            const pending = b.revealReviewThread({
                conversationId: b.source,
                threadId: "old-link",
            });
            const chosen = b.opening + 3;

            b.navigate(chosen);

            if (returned) {
                b.navigate(b.opening);
            }

            await flush();
            b.requests[0]!.resolve(discussion("old-link"));
            await pending;
            await flush();
            assert.equal(b.store.state.conversationId, returned ? b.opening : chosen);
            assert.equal(b.store.state.reviewTarget, null);
            assert.deepEqual(
                b.routes,
                returned ? [`/s/${chosen}`, `/s/${b.opening}`] : [`/s/${chosen}`],
            );
            assert.deepEqual(b.store.state.notices, []);
        });
    }
});

test("a source read finishing after pagehide cannot navigate a departed page", async (t) => {
    const b = await browser(t);
    const pending = b.revealReviewThread({ conversationId: b.source, threadId: "departed-link" });

    b.page.dispatchEvent(new Event("pagehide"));
    b.page.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    b.requests[0]!.resolve(discussion("departed-link"));
    await pending;
    await flush();
    assert.equal(b.store.state.conversationId, b.opening);
    assert.equal(b.store.state.reviewTarget, null);
    assert.deepEqual(b.routes, []);
    assert.deepEqual(b.store.state.notices, []);
});

test("a preflight response for a previous signed-in person cannot navigate the new person's page", async (t) => {
    const b = await browser(t);
    const pending = b.revealReviewThread({ conversationId: b.source, threadId: "previous-person" });

    b.store.set({ me: { id: "new-viewer", role: "viewer" } });
    b.requests[0]!.resolve(discussion("previous-person"));
    await pending;
    assert.equal(b.store.state.conversationId, b.opening);
    assert.equal(b.store.state.reviewTarget, null);
    assert.deepEqual(b.routes, []);
    assert.deepEqual(b.store.state.notices, []);
});

test("a newer review link supersedes an older response before either source has opened", async (t) => {
    const b = await browser(t);
    const older = b.revealReviewThread({ conversationId: b.source, threadId: "older-thread" });
    const newestSource = b.opening + 2;
    const newer = b.revealReviewThread({ conversationId: newestSource, threadId: "newer-thread" });

    assert.equal(b.requests.length, 2);
    b.requests[0]!.resolve(discussion("older-thread"));
    await older;
    assert.equal(
        b.store.state.conversationId,
        b.opening,
        "supersession fences old work before any navigation",
    );
    assert.deepEqual(b.routes, []);
    b.requests[1]!.resolve(discussion("newer-thread"));
    await newer;
    await flush();
    assert.equal(b.store.state.conversationId, newestSource);
    assert.deepEqual(b.store.state.reviewTarget, {
        conversationId: newestSource,
        threadId: "newer-thread",
        reply: false,
        n: 1,
    });
    assert.deepEqual(b.routes, [`/s/${newestSource}`]);
    assert.deepEqual(b.store.state.notices, []);
});
