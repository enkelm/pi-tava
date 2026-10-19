// Authoring gate: real API promises and the real browser store drive the shared project marker.
// This owns recent evidence, auth-generation isolation and request races, not DOM layout or SSH transport.
// A response fixture supplies only HTTP delivery; it does not implement status, ordering or expiry.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { isValidElement } from "preact";

const htmlOnly = `
    import { h } from ${JSON.stringify(import.meta.resolve("preact"))};
    import htm from ${JSON.stringify(import.meta.resolve("htm"))};
    export const html = htm.bind(h);
`;

// Keep the production htm/Preact binding without importing Markdown, gestures and the page's DOM controls.
registerHooks({
    resolve(specifier, context, next) {
        return specifier === "./ui.js" && context.parentURL?.endsWith("/web/ssh-status.js")
            ? { url: `data:text/javascript,${encodeURIComponent(htmlOnly)}`, shortCircuit: true }
            : next(specifier, context);
    },
});

function storage() {
    const values = new Map<string, string>();

    return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, String(value)),
        removeItem: (key: string) => values.delete(key),
    };
}

test("remote project markers reflect only recent actual workspace requests for the current user", async (t) => {
    const page = new EventTarget();
    const globals = {
        document: Object.assign(new EventTarget(), {
            visibilityState: "visible",
            documentElement: { dataset: {} },
            querySelector: () => null,
        }),
        localStorage: storage(),
        sessionStorage: storage(),
        location: { pathname: "/", hostname: "localhost", href: "http://localhost/" },
        history: { state: null },
        addEventListener: page.addEventListener.bind(page),
        removeEventListener: page.removeEventListener.bind(page),
        matchMedia: () => ({ matches: false, addEventListener() {} }),
    };
    const descriptors = new Map<string, PropertyDescriptor | undefined>();

    for (const [name, value] of Object.entries(globals)) {
        descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, { configurable: true, value });
    }

    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_700_000_000_000 });
    const pending: {
        path: string;
        resolve: (response: Response) => void;
    }[] = [];

    t.mock.method(globalThis, "fetch", (path: string, options: RequestInit = {}) => {
        return new Promise<Response>((resolve, reject) => {
            pending.push({ path, resolve });
            options.signal?.addEventListener(
                "abort",
                () => reject(new DOMException("Request cancelled", "AbortError")),
                { once: true },
            );
        });
    });
    const { api, store } = await import(new URL("../web/store.js", import.meta.url).href);
    const { observeSsh, RemoteProjectIcon } = await import(
        new URL("../web/ssh-status.js", import.meta.url).href
    );
    const remote = { kind: "ssh", host: "devbox" };
    const owner = { id: "owner", role: "owner" };

    t.after(() => {
        store.set({ me: null });
        page.dispatchEvent(new Event("pagehide"));

        for (const [name, descriptor] of descriptors) {
            if (descriptor) {
                Object.defineProperty(globalThis, name, descriptor);
            } else {
                Reflect.deleteProperty(globalThis, name);
            }
        }
    });

    const reset = () => {
        store.set({ me: null });
        store.set({ me: owner, connection: "connecting" });
    };

    const badge = (location = remote) => {
        const icon = RemoteProjectIcon({ location });

        assert.ok(isValidElement(icon));

        return icon.props;
    };

    const state = (location = remote) => Reflect.get(badge(location), "data-status");

    const request = (location = remote, signal?: AbortSignal) => {
        const done = observeSsh(location, () =>
            api(`fs?host=${encodeURIComponent(location.host)}&path=~`, undefined, { signal }),
        );
        const response = pending.at(-1);

        assert.ok(response);
        assert.match(response.path, /^\/api\/fs\?/);

        return { done, response };
    };

    const finish = async (flight: ReturnType<typeof request>, status = 200) => {
        flight.response.resolve(
            Response.json(status === 200 ? { path: "/remote/project" } : { error: "SSH refused" }, {
                status,
            }),
        );

        if (status === 200) {
            return flight.done;
        }

        await assert.rejects(flight.done, { status });
    };

    await t.test(
        "local projects have no marker; login, discovery and Coop connectivity are not SSH evidence",
        async () => {
            reset();
            assert.equal(RemoteProjectIcon({ location: null }), null);
            assert.equal(RemoteProjectIcon({ location: { kind: "local" } }), null);
            assert.equal(await observeSsh(null, () => "local result"), "local result");
            assert.equal(pending.length, 0, "rendering and local work do not probe hosts");
            assert.equal(state(), "unknown");
            assert.match(String(Reflect.get(badge(), "aria-label")), /devbox: SSH status unknown/);
            assert.equal(Reflect.get(badge(), "role"), "img");
            store.set({ connection: "open", server: { sshWorkspaces: 1 } });

            for (const path of ["ssh-hosts", "ssh-auth?host=devbox"]) {
                const done = api(path);

                pending.at(-1)!.resolve(Response.json({ hosts: ["devbox"], saved: true }));
                await done;
                assert.equal(state(), "unknown");
            }
        },
    );

    await t.test(
        "actual requests show checking, share exact host evidence and expire without probing again",
        async () => {
            reset();
            let updates = 0;
            const stop = store.subscribe(() => updates++);
            const before = pending.length;
            const flight = request();

            assert.equal(state(), "checking");
            assert.match(String(Reflect.get(badge(), "title")), /Checking remote workspace/);
            assert.deepEqual(await finish(flight), { path: "/remote/project" });
            assert.equal(state({ kind: "ssh", host: "devbox" }), "reachable");
            assert.equal(state({ kind: "ssh", host: "Devbox" }), "unknown");
            assert.equal(state({ kind: "ssh", host: "user@devbox" }), "unknown");
            assert.match(
                String(Reflect.get(badge(), "aria-label")),
                /SSH reachable \(last checked recently\)/,
            );
            const afterRequest = updates;

            t.mock.timers.tick(30_000);
            assert.equal(state(), "reachable");
            t.mock.timers.tick(5 * 60_000);
            assert.equal(state(), "unknown");
            assert.ok(
                updates > afterRequest,
                "expiry asks the UI to redraw even without another operation",
            );
            assert.equal(pending.length, before + 1, "expiry never starts another request");
            stop();
        },
    );

    await t.test(
        "a failed SSH attempt is not a claim of physical offline status; ambiguous failures stay unknown",
        async () => {
            reset();
            const failed = request();

            await finish(failed, 409);
            assert.equal(state(), "unavailable");
            assert.match(
                String(Reflect.get(badge(), "title")),
                /devbox: Remote workspace unavailable/,
            );

            for (const status of [400, 401, 403, 404, 500, 502]) {
                const flight = request();

                await finish(flight, status);
                assert.equal(state(), "unknown", `HTTP ${status} does not prove SSH failure`);
            }

            const controller = new AbortController();
            const cancelled = request(remote, controller.signal);

            controller.abort();
            await assert.rejects(cancelled.done, { name: "AbortError" });
            assert.equal(state(), "unknown");
            const failure = new TypeError("Failed to fetch Coop");

            await assert.rejects(
                observeSsh(remote, () => Promise.reject(failure)),
                (error) => error === failure,
            );
            assert.equal(state(), "unknown");
        },
    );

    await t.test(
        "older HTTP completions cannot replace newer results for the same target",
        async () => {
            for (const [oldStatus, newStatus, expected] of [
                [200, 409, "unavailable"],
                [409, 200, "reachable"],
            ] as const) {
                reset();
                const older = request();
                const newer = request();

                await finish(newer, newStatus);
                assert.equal(state(), expected);
                await finish(older, oldStatus);
                assert.equal(state(), expected);
            }
        },
    );

    await t.test(
        "user changes and sign-out invalidate old results, including return to the same account",
        async () => {
            reset();
            await finish(request());
            const oldUser = request();

            store.set({ me: { id: "guest", role: "guest" } });
            assert.equal(state(), "unknown");
            await finish(request());
            await finish(oldUser, 409);
            assert.equal(state(), "reachable", "owner completion cannot overwrite guest evidence");
            const beforeSignOut = request();

            store.set({ me: null });
            store.set({ me: { id: "guest", role: "guest" } });
            await finish(beforeSignOut);
            assert.equal(state(), "unknown", "same-account sign-in still has a new generation");
            await finish(request());
            store.set({ me: { id: "guest", role: "guest", sessions: [7] } });
            assert.equal(state(), "unknown", "changed access scope cannot reuse previous evidence");
        },
    );

    await t.test(
        "recent target evidence has a bounded retention window, not an unbounded host catalogue",
        async () => {
            reset();

            for (let index = 0; index < 1000; index++) {
                await finish(request({ kind: "ssh", host: `fixture-${index}` }));
            }

            assert.equal(state({ kind: "ssh", host: "fixture-0" }), "unknown");
            assert.equal(state({ kind: "ssh", host: "fixture-999" }), "reachable");
        },
    );
});
