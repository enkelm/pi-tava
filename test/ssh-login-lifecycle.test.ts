// Drive the disclosed production login component's request/effect lifecycle without a browser.
// Only Preact scheduling and HTTP delivery are stood in for: fixtures do not implement expiry,
// suspension or resume. This owns clock-skew/background traffic, not server credential lifetime.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { isValidElement, type VNode } from "preact";

type Mount = { render: () => unknown; hooks: Hook[]; scheduled?: boolean; disposed?: boolean };
type Hook = { value?: unknown; current?: unknown; deps?: unknown[]; cleanup?: () => void };
let current: Mount;
let index = 0;
let effects: (() => void)[] = [];

function render(mount: Mount) {
    current = mount;
    index = 0;
    const result = mount.render();
    const pending = effects;

    effects = [];

    for (const effect of pending) {
        effect();
    }

    return result;
}

function useState(initial: unknown) {
    const mount = current;
    const slot = index++;
    const hook = (mount.hooks[slot] ??= { value: initial });

    return [
        hook.value,
        (value: unknown) => {
            if (Object.is(value, hook.value) || mount.disposed) {
                return;
            }

            hook.value = value;

            if (!mount.scheduled) {
                mount.scheduled = true;
                queueMicrotask(() => {
                    mount.scheduled = false;

                    if (!mount.disposed) {
                        render(mount);
                    }
                });
            }
        },
    ];
}

function useRef(initial: unknown) {
    return (current.hooks[index++] ??= { current: initial });
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

const listeners = new Set<() => void>();
const fixture = {
    hooks: { useState, useRef, useEffect, useLayoutEffect: useEffect },
    store: {
        state: { me: { id: "owner", role: "owner" }, server: { sshPasswords: 1 } },
        subscribe(listener: () => void) {
            listeners.add(listener);

            return () => listeners.delete(listener);
        },
    },
    api: async (_path: string, _body?: unknown, _options?: RequestInit): Promise<unknown> => ({}),
};

Object.assign(globalThis, { sshLoginLifecycleFixture: fixture });
const sources: Record<string, string> = {
    "preact/hooks":
        "export const {useState,useRef,useEffect,useLayoutEffect} = globalThis.sshLoginLifecycleFixture.hooks;",
    "./store.js":
        "export const {store} = globalThis.sshLoginLifecycleFixture; export const api = (...args) => globalThis.sshLoginLifecycleFixture.api(...args);",
    "./ui.js": `import {h} from ${JSON.stringify(import.meta.resolve("preact"))}; import htm from ${JSON.stringify(import.meta.resolve("htm"))}; export const html=htm.bind(h); export const Spinner=()=>null;`,
    "./ssh-status.js": "export const observeSsh = (_, operation) => operation();",
};

registerHooks({
    resolve(specifier, context, next) {
        const source = context.parentURL?.endsWith("/web/ssh-login.js")
            ? sources[specifier]
            : undefined;

        return source === undefined
            ? next(specifier, context)
            : { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    },
});

const { SshLogin } = await import(new URL("../web/ssh-login.js", import.meta.url).href);

const flush = async () => {
    for (let i = 0; i < 12; i++) {
        await Promise.resolve();
    }
};

test("SSH login status ignores wall-clock skew and suspends hidden/offline/departed requests", async (t) => {
    const page = new EventTarget();
    const document = Object.assign(new EventTarget(), { hidden: false });
    const navigator = { onLine: true };
    const globals = {
        document,
        navigator,
        isSecureContext: true,
        addEventListener: page.addEventListener.bind(page),
        removeEventListener: page.removeEventListener.bind(page),
    };
    const descriptors = new Map<string, PropertyDescriptor | undefined>();

    for (const [name, value] of Object.entries(globals)) {
        descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, { configurable: true, value });
    }

    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 31 * 60_000 });
    let reads = 0;

    fixture.api = async (path) => {
        assert.match(path, /^ssh-auth\?/);
        reads++;

        // The server's clock is 31 minutes behind this browser. Remaining lifetime is 60 seconds.
        return { authenticated: true, expiresAt: 60_000, expiresInMs: 60_000 };
    };

    const outer: Mount = { render: () => SshLogin({ host: "fixture-host" }), hooks: [] };
    const details = render(outer) as VNode<{
        onToggle: (event: unknown) => void;
        children: VNode[];
    }>;

    details.props.onToggle({ currentTarget: { open: true } });
    await flush();
    const opened = render(outer) as typeof details;
    const child = opened.props.children.find(
        (node) => isValidElement(node) && typeof node.type === "function",
    )!;
    const mount: Mount = {
        render: () => Reflect.apply(child.type as Function, null, [child.props]),
        hooks: [],
    };

    t.after(() => {
        mount.disposed = true;
        outer.disposed = true;

        for (const hook of mount.hooks) {
            hook.cleanup?.();
        }

        for (const [name, descriptor] of descriptors) {
            if (descriptor) {
                Object.defineProperty(globalThis, name, descriptor);
            } else {
                Reflect.deleteProperty(globalThis, name);
            }
        }
    });
    render(mount);
    await flush();
    assert.equal(reads, 1);

    for (let i = 0; i < 10; i++) {
        t.mock.timers.tick(1000);
        await flush();
    }

    assert.equal(reads, 1, "a skewed wall clock must not trigger a one-second status loop");
    t.mock.timers.tick(50_000);
    await flush();
    assert.equal(reads, 2, "server-relative expiry gets one refresh");

    for (const state of ["hidden", "offline", "departed"] as const) {
        if (state === "hidden") {
            document.hidden = true;
            document.dispatchEvent(new Event("visibilitychange"));
        } else if (state === "offline") {
            navigator.onLine = false;
            page.dispatchEvent(new Event("offline"));
        } else {
            page.dispatchEvent(new Event("pagehide"));
            page.dispatchEvent(new Event("online"));
        }

        await flush();
        const before: number = reads;

        t.mock.timers.tick(10 * 60_000);
        await flush();
        assert.equal(reads, before, `${state} pages must not refresh login status`);

        if (state === "hidden") {
            document.hidden = false;
            document.dispatchEvent(new Event("visibilitychange"));
        } else if (state === "offline") {
            navigator.onLine = true;
            page.dispatchEvent(new Event("online"));
        } else {
            page.dispatchEvent(new Event("pageshow"));
        }

        await flush();
        assert.equal(reads, before + 1, `${state} return performs one fresh status read`);
    }

    mount.disposed = true;

    for (const hook of mount.hooks) {
        hook.cleanup?.();
    }

    const before = reads;

    page.dispatchEvent(new Event("online"));
    t.mock.timers.tick(10 * 60_000);
    await flush();
    assert.equal(reads, before, "unmounted password controls own no background work");
});
