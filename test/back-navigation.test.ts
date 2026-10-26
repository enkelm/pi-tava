// Back owns observable browser-history order. The fixture supplies only the browser primitives;
// route/layer entries, first-interaction handling and installed-iOS protection run in the real owner.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

registerHooks({
    resolve(specifier, context, next) {
        if (
            specifier === "preact/hooks" &&
            context.parentURL &&
            new URL(context.parentURL).pathname.endsWith("/web/back.js")
        ) {
            return {
                url: "data:text/javascript,export const useEffect=()=>{},useLayoutEffect=()=>{},useRef=()=>{};",
                shortCircuit: true,
            };
        }

        return next(specifier, context);
    },
});

let browserCase = 0;

async function browser(t: { after: (run: () => Promise<void>) => void }, standalone = false) {
    const events = new EventTarget();
    const pane = Object.assign(new EventTarget(), { dataset: {} as Record<string, string> });
    const root = { dataset: {} as Record<string, string> };
    const location = new URL("https://coop.test/s/3?chat=1#latest");
    const activation = { hasBeenActive: false };
    const media = { phone: true, reduced: false };
    const entries = [{ state: null as any, path: location.href }];
    let at = 0;
    const saved = new Map<string, PropertyDescriptor | undefined>();
    const visit = (path: string) => {
        location.href = new URL(path, location).href;
    };
    const history = {
        get state() {
            return entries[at]!.state;
        },
        get length() {
            return entries.length;
        },
        pushState(state: any, _title: string, path = location.href) {
            entries.splice(++at);
            entries.push({ state, path: new URL(path, location).href });
            visit(path);
        },
        replaceState(state: any, _title: string, path = location.href) {
            entries[at] = { state, path: new URL(path, location).href };
            visit(path);
        },
        go(delta: number) {
            const next = at + delta;

            if (next < 0 || next >= entries.length) {
                return;
            }

            at = next;
            visit(entries[at]!.path);
            setTimeout(() => {
                events.dispatchEvent(Object.assign(new Event("popstate"), { state: this.state }));
            }, 0);
        },
        back() {
            this.go(-1);
        },
    };

    for (const [name, value] of Object.entries({
        history,
        location,
        navigator: { standalone, userActivation: activation },
        document: { documentElement: root, querySelector: () => pane },
        matchMedia: (query: string) => ({
            matches: query === "(max-width: 767px)" ? media.phone : media.reduced,
        }),
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
    })) {
        saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, { configurable: true, value });
    }

    const back = await import(new URL(`../web/back.js?case=${++browserCase}`, import.meta.url).href);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 65));

    t.after(async () => {
        // The real owner's bounded route-mark timer must settle before restoring browser globals.
        await new Promise((resolve) => setTimeout(resolve, 650));

        for (const [name, descriptor] of saved) {
            if (descriptor) {
                Object.defineProperty(globalThis, name, descriptor);
            } else {
                Reflect.deleteProperty(globalThis, name);
            }
        }
    });

    return { back, history, location, entries, pane, root, activation, events, settle, media };
}

test("browser direct Chat: a held release puts the list under ordered layers", async (t) => {
    const { back, history, location, activation, events, settle, pane, root } = await browser(t);
    const closed: string[] = [];
    const routes: string[] = [];

    back.onRoute(() => routes.push(location.pathname));
    back.startHistory({ home: true });
    back.addLayer(() => closed.push("drawer"));
    back.addLayer(() => closed.push("sheet"));
    await settle();
    assert.equal(history.length, 1, "Chrome must not receive skippable entries before activation");
    activation.hasBeenActive = true;
    // A held row's release activates the page without a click. It still needs the list beneath its layers.
    events.dispatchEvent(new Event("pointerup"));
    await settle();
    assert.equal(history.state.pocket.layers, 2);

    history.back();
    await settle();
    assert.deepEqual(closed, ["sheet"]);
    assert.equal(location.pathname, "/s/3");
    history.back();
    await settle();
    assert.deepEqual(closed, ["sheet", "drawer"]);
    history.back();
    await settle();
    assert.equal(location.pathname, "/");
    assert.equal(back.canGoBack(), false, "an ordinary tab has no installed-app root guard");
    assert.equal(root.dataset.route, undefined, "navigation must not restyle every window");
    assert.equal(pane.dataset.route, "back");
    pane.dispatchEvent(Object.assign(new Event("animationend"), { animationName: "rise-in" }));
    assert.equal(pane.dataset.route, "back", "an unrelated child animation cannot end the slide");
    pane.dispatchEvent(Object.assign(new Event("animationend"), { animationName: "route-back" }));
    assert.equal(pane.dataset.route, undefined);
    assert.equal(routes.at(-1), "/");
});

test("route marks honor effective motion before the OS fallback and only animate phones", async (t) => {
    const { back, pane, root, media, history, settle } = await browser(t);
    const modes = [
        { name: "full-over-os-reduced", phone: true, motion: "full", os: true, mark: "forward" },
        { name: "app-reduced", phone: true, motion: "reduced", os: false, mark: undefined },
        { name: "app-and-os-reduced", phone: true, motion: "reduced", os: true, mark: undefined },
        { name: "os-fallback-reduced", phone: true, motion: undefined, os: true, mark: undefined },
        { name: "os-fallback-full", phone: true, motion: undefined, os: false, mark: "forward" },
        { name: "roomy", phone: false, motion: "full", os: true, mark: undefined },
    ];

    back.startHistory({ home: false });

    for (const mode of modes) {
        media.phone = mode.phone;
        media.reduced = mode.os;

        if (mode.motion === undefined) {
            delete root.dataset.motion;
        } else {
            root.dataset.motion = mode.motion;
        }

        back.pushRoute(`/projects/${mode.name}`);
        await settle();
        assert.equal(pane.dataset.route, mode.mark, mode.name);
        assert.equal(root.dataset.route, undefined, mode.name);
        assert.equal(history.state.pocket.layers, 0);
        pane.dispatchEvent(Object.assign(new Event("animationend"), { animationName: "route-forward" }));
        assert.equal(pane.dataset.route, undefined, "completed route marks are released");
    }
});

test("installed iOS: direct Chat has a list before a tap and bounded root Back", async (t) => {
    const { back, history, location, settle } = await browser(t, true);
    const closed: string[] = [];

    back.startHistory({ home: true });
    await settle();
    assert.deepEqual(history.state, { pocket: { layers: 0, back: 1 } });
    assert.equal(location.search, "?chat=1");
    assert.equal(location.hash, "#latest");
    history.back();
    await settle();
    assert.equal(location.pathname, "/");
    assert.deepEqual(history.state, { pocket: { layers: 0, back: 0, guard: true } });

    for (let count = 0; count < 3; count++) {
        history.back();
        await settle();
        assert.equal(location.pathname, "/");
        assert.equal(history.length, 2, "repeated root swipes reuse a bounded guard");
    }

    back.startHistory({ home: true });
    await settle();
    assert.equal(history.length, 2, "reinitializing a guarded root adds no duplicate");
    back.pushRoute("/s/4");
    await settle();
    back.addLayer(() => closed.push("handoff"));
    back.addLayer(() => closed.push("child settings"));
    await settle();
    // Activation is still false: iOS direct-route protection must not alter Chrome's layer rule.
    assert.equal(history.state.pocket.layers, 0);
    await back.goHome(() => assert.fail("the known list must be reachable"));
    await settle();
    assert.equal(location.pathname, "/");
    assert.deepEqual(closed, ["child settings", "handoff"]);
    assert.deepEqual(history.state, { pocket: { layers: 0, back: 0, guard: true } });
});
