// Production file/folder/diff components own abandoned read cancellation. Only hook scheduling,
// presentation dependencies and HTTP delivery are stood in for; no fixture cancels requests or
// implements the diff queue. This complements server request-close tests, without a browser/listener.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { isValidElement, type VNode } from "preact";

type Hook = { value?: unknown; current?: unknown; deps?: unknown[]; cleanup?: () => void };
type Mount = {
    render: () => unknown;
    hooks: Hook[];
    scheduled?: boolean;
    disposed?: boolean;
    tree?: unknown;
};
let current: Mount;
let index = 0;
let effects: (() => void)[] = [];

function render(mount: Mount) {
    current = mount;
    index = 0;
    mount.tree = mount.render();
    const pending = effects;

    effects = [];

    for (const effect of pending) {
        effect();
    }

    return mount.tree;
}

function dispose(mount: Mount) {
    if (mount.disposed) {
        return;
    }

    mount.disposed = true;

    for (const hook of mount.hooks) {
        hook.cleanup?.();
    }
}

function useState(initial: unknown) {
    const mount = current;
    const slot = index++;
    const hook = (mount.hooks[slot] ??= {
        value: typeof initial === "function" ? initial() : initial,
    });

    return [
        hook.value,
        (update: unknown) => {
            const value = typeof update === "function" ? update(hook.value) : update;

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

function useMemo(make: () => unknown, deps: unknown[]) {
    const slot = index++;
    const previous = current.hooks[slot];

    if (!previous || deps.some((value, i) => !Object.is(value, previous.deps![i]))) {
        current.hooks[slot] = { deps, value: make() };
    }

    return current.hooks[slot]!.value;
}

function useEffect(effect: () => (() => void) | undefined, deps?: unknown[]) {
    const mount = current;
    const slot = index++;
    const previous = mount.hooks[slot];

    if (!previous || !deps || deps.some((value, i) => !Object.is(value, previous.deps?.[i]))) {
        const next: Hook = { deps };

        mount.hooks[slot] = next;
        effects.push(() => {
            previous?.cleanup?.();
            next.cleanup = effect();
        });
    }
}

const changedFiles = Array.from({ length: 7 }, (_, i) => ({
    path: `file-${i}.txt`,
    kind: "modified",
    added: 1,
    removed: 1,
    version: 1,
}));
const changes = {
    repo: { root: "/fixture", branch: "main", head: "base" },
    files: changedFiles,
    piOnly: [],
};
const listeners = new Set<() => void>();
const requests: { path: string; signal?: AbortSignal | null; resolve: (value: unknown) => void }[] =
    [];
const fixture = {
    hooks: { useState, useRef, useMemo, useEffect, useLayoutEffect: useEffect },
    store: {
        state: {
            conversationId: 1,
            me: { id: "owner", role: "owner" },
            server: { localReviews: 2, sshWorkspaces: 1, home: "/home", defaultCwd: "/fixture" },
            view: {
                agent: { cwd: "/fixture" },
                conversation: {},
                entries: [],
                reviews: { threads: [] },
            },
            filesTab: "files",
            folderFavorites: [],
            filesOpen: true,
        },
        subscribe(listener: () => void) {
            listeners.add(listener);

            return () => listeners.delete(listener);
        },
        set() {
            for (const listener of listeners) {
                listener();
            }
        },
    },
    read(path: string, options?: RequestInit): Promise<unknown> {
        return new Promise((resolve) => requests.push({ path, signal: options?.signal, resolve }));
    },
    changes: () => Promise.resolve(changes),
};

Object.assign(globalThis, { workspaceReadFixture: fixture });
const sources: Record<string, string> = {
    "preact/hooks":
        "export const {useState,useRef,useMemo,useEffect,useLayoutEffect} = globalThis.workspaceReadFixture.hooks;",
    "store.js": `
        const f = globalThis.workspaceReadFixture;
        export const store = f.store;
        export const actions = {
            view: (path, options) => f.read('view:' + path, options),
            reviewContext: (id, path, options) => f.read('context:' + path, options),
            reviewDiff: (id, path, options) => f.read('diff:' + path, options),
            reviewChanges: () => f.changes(), changes: () => f.changes(),
        };
        export const api = (path, body, options) => /\\/changes$/.test(path) ? f.changes() : f.read(body === undefined ? path : 'mutation:' + path, options);
        export const canSteer = () => true;
        export const panelsBeside = () => true;
        export const attempt = operation => operation();
        export const closeSheet = () => {}, closePeople = () => {}, insertIntoComposer = () => {}, navigate = () => {}, notify = () => {}, openSheet = () => {}, scoped = () => false;
    `,
    "ui.js": `
        import {h} from ${JSON.stringify(import.meta.resolve("preact"))};
        import htm from ${JSON.stringify(import.meta.resolve("htm"))};
        export const html = htm.bind(h), APPLE = false;
        export const Icon = () => null, Loader = () => null, Markdown = () => null, Marked = () => null, Sheet = () => null;
        export const shortPath = path => path, fileUrl = path => path, formatBytes = value => value;
        export const usePresence = value => [value], item = () => null, copyText = () => {}, openFile = () => {};
    `,
    "workspace-location.js":
        "export const conversationLocation = () => ({kind:'ssh', host:'fixture'}), recentSshFolders = () => [], rememberSshFolder = () => {};",
    "ssh-status.js": "export const observeSsh = (_, operation) => operation();",
    "ssh-login.js": "export const SshLogin = () => null;",
    "back.js": "export const useBack = () => {};",
    "chat.js": "export const jumpToEntry = () => {};",
    "highlight.js":
        "export const highlight = text => text, highlightLines = lines => lines, langOf = () => null;",
    "reviews.js": "export const ReviewsPanel = () => null, ReviewThreads = () => null;",
    "branch.js": "export const branchAvailable = () => true;",
    "browser.js": "export const browserAvailable = () => false, openInBrowser = () => {};",
    "files.js":
        "export const loadFiles = () => {}, suggestFiles = () => [], mentionText = () => '';",
    "file-editor.js": "export const FileEditor = () => null;",
    "rich.js": "export const HtmlPreview = () => null;",
    "run-frame.js":
        "export const RunFrame = () => null, usePreviewRuntime = () => ({allowed:false});",
    "pi-sessions.js": "export const piSessionsAvailable = () => false;",
};

registerHooks({
    resolve(specifier, context, next) {
        const target = /\/web\/(files-panel|diff|sheets\/file|sheets\/folder)\.js$/.test(
            context.parentURL ?? "",
        );
        const source = target
            ? sources[specifier === "preact/hooks" ? specifier : specifier.split("/").pop()!]
            : undefined;

        return source === undefined
            ? next(specifier, context)
            : { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    },
});

function storage() {
    const data = new Map<string, string>();

    return {
        getItem: (key: string) => data.get(key) ?? null,
        setItem: (key: string, value: string) => data.set(key, value),
        removeItem: (key: string) => data.delete(key),
    };
}

const page = new EventTarget();

Object.assign(globalThis, {
    localStorage: storage(),
    sessionStorage: storage(),
    matchMedia: () => ({ matches: false }),
    document: Object.assign(new EventTarget(), { hidden: false }),
    addEventListener: page.addEventListener.bind(page),
    removeEventListener: page.removeEventListener.bind(page),
});
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { onLine: true } });
const { FileView } = await import(new URL("../web/sheets/file.js", import.meta.url).href);
const { FolderPicker } = await import(new URL("../web/sheets/folder.js", import.meta.url).href);
const { FilesPanel } = await import(new URL("../web/files-panel.js", import.meta.url).href);
const { DiffReview, DiffBlock } = await import(new URL("../web/diff.js", import.meta.url).href);

async function flush() {
    for (let i = 0; i < 20; i++) {
        await Promise.resolve();
    }
}

function nodes(tree: unknown): VNode<Record<string, unknown>>[] {
    if (Array.isArray(tree)) {
        return tree.flatMap(nodes);
    }

    if (!isValidElement(tree)) {
        return [];
    }

    const node = tree as VNode<Record<string, unknown>>;

    return [node, ...nodes(node.props.children)];
}

function child(tree: unknown, predicate: (node: VNode<Record<string, unknown>>) => boolean) {
    const node = nodes(tree).find(predicate);

    assert.ok(node, "production component renders the requested child");

    return node;
}

function mountChild(node: VNode<Record<string, unknown>>, props = node.props): Mount {
    assert.equal(typeof node.type, "function");

    return { hooks: [], render: () => Reflect.apply(node.type as Function, null, [props]) };
}

test("file viewers abort superseded and unmounted reads", async (t) => {
    const mounts: Mount[] = [];

    t.after(() => mounts.forEach(dispose));
    let path = "/fixture/one.txt";
    let active = true;
    let loaded = 0;
    const file: Mount = {
        hooks: [],
        render: () => FileView({ path, active, onLoad: () => loaded++ }),
    };

    mounts.push(file);
    render(file);
    const first = requests.at(-1)!;

    path = "/fixture/two.txt";
    render(file);
    const second = requests.at(-1)!;

    assert.equal(first.signal?.aborted, true, "selection change aborts the previous file fetch");
    first.resolve({ kind: "text", text: "old" });
    await flush();
    assert.equal(loaded, 0, "late old file data cannot reach the viewer");
    active = false;
    render(file);
    assert.equal(second.signal?.aborted, true, "leaving the Files tab aborts its file read");
    active = true;
    render(file);
    const resumed = requests.at(-1)!;

    dispose(file);
    assert.equal(resumed.signal?.aborted, true, "closing the viewer aborts its read");
});

test("leaving and returning to Files preserves an already loaded editor without replaying its read", async (t) => {
    let active = true;
    const file: Mount = {
        hooks: [],
        render: () => FileView({ path: "/fixture/draft.txt", active }),
    };

    t.after(() => dispose(file));
    render(file);
    requests
        .at(-1)!
        .resolve({ kind: "text", path: "/fixture/draft.txt", text: "draft base", editable: true });
    await flush();
    const controls = child(file.tree, (node) => node.props.onEdit !== undefined);

    (controls.props.onEdit as Function)();
    await flush();
    const editor = child(file.tree, (node) => node.props.onSaved !== undefined);
    const before = requests.length;

    active = false;
    render(file);
    active = true;
    render(file);
    const resumed = child(file.tree, (node) => node.props.onSaved !== undefined);

    assert.equal(resumed.type, editor.type);
    assert.equal(
        resumed.props.file,
        editor.props.file,
        "the mounted editor retains its same source document",
    );
    assert.equal(
        requests.length,
        before,
        "returning to loaded Files does not replay its completed read",
    );
});

test("tree folders abort refreshed and unmounted listings", (t) => {
    const mounts: Mount[] = [];

    t.after(() => mounts.forEach(dispose));
    const panel: Mount = { hooks: [], render: () => FilesPanel({}) };

    mounts.push(panel);
    const tabNode = child(
        render(panel),
        (node) => node.props.covering !== undefined && "changes" in node.props,
    );
    const tab = mountChild(tabNode);

    mounts.push(tab);
    const folderNode = child(
        render(tab),
        (node) => node.props.ctx !== undefined && node.props.depth === 0,
    );
    const folderProps = { ...folderNode.props };
    const folder = mountChild(folderNode, folderProps);

    mounts.push(folder);
    render(folder);
    const treeRead = requests.at(-1)!;

    folderProps.ctx = { ...(folderProps.ctx as object), version: "new-version" };
    render(folder);
    assert.equal(treeRead.signal?.aborted, true, "tree refresh aborts the old listing");
    const refreshed = requests.at(-1)!;

    folderProps.ctx = { ...(folderProps.ctx as object), active: false };
    render(folder);
    assert.equal(refreshed.signal?.aborted, true, "leaving Files aborts its tree listing");
    folderProps.ctx = { ...(folderProps.ctx as object), active: true };
    render(folder);
    const resumed = requests.at(-1)!;

    dispose(folder);
    assert.equal(
        resumed.signal?.aborted,
        true,
        "folding/removing a tree folder aborts its listing",
    );
});

test("picker navigation aborts superseded and unmounted listings", (t) => {
    const mounts: Mount[] = [];

    t.after(() => mounts.forEach(dispose));
    const picker: Mount = {
        hooks: [],
        render: () => FolderPicker({ mode: "change", initialPath: "/fixture" }),
    };

    mounts.push(picker);
    render(picker);
    const initial = requests.at(-1)!;
    const computer = child(
        picker.tree,
        (node) => node.type === "button" && node.props.title === "/",
    );

    (computer.props.onClick as Function)();
    const next = requests.at(-1)!;

    assert.equal(
        initial.signal?.aborted,
        true,
        "navigating the picker aborts its prior folder request",
    );
    assert.notEqual(next, initial);
    dispose(picker);
    assert.equal(next.signal?.aborted, true, "closing the picker aborts its current listing");
});

test("closing a picker leaves an admitted folder creation alone and does not start its follow-up read", async (t) => {
    const picker: Mount = {
        hooks: [],
        render: () => FolderPicker({ mode: "change", initialPath: "/fixture" }),
    };

    t.after(() => dispose(picker));
    render(picker);
    requests.at(-1)!.resolve({ path: "/fixture", home: "/home", dirs: [], recent: [] });
    await flush();
    const create = child(
        picker.tree,
        (node) => node.type === "button" && node.props.class === "button small fp-new",
    );

    (create.props.onClick as Function)();
    await flush();
    const input = child(picker.tree, (node) => node.props.label === "The new folder's name");
    const creation = (input.props.onSubmit as Function)("created");
    const mutation = requests.at(-1)!;

    assert.equal(mutation.path, "mutation:fs");
    dispose(picker);
    assert.equal(
        mutation.signal,
        undefined,
        "closing the picker does not abort or reinterpret its mutation",
    );
    const before = requests.length;

    mutation.resolve({ path: "/fixture/created" });
    await creation;
    await flush();
    assert.equal(
        requests.length,
        before,
        "an unmounted picker neither replays the create nor browses its result",
    );
});

test("review and legacy diffs abort active reads and remove abandoned queued files before dispatch", async (t) => {
    const mounts: Mount[] = [];

    t.after(() => {
        mounts.forEach(dispose);
        fixture.store.state.server.localReviews = 2;
    });
    t.mock.method(globalThis, "fetch", (input: string | URL | Request, options?: RequestInit) => {
        const path = new URL(String(input), "http://fixture").searchParams.get("path");

        return fixture
            .read(`workingdiff:${path}`, options)
            .then((text) => new Response(String(text)));
    });

    for (const review of [true, false]) {
        fixture.store.state.server.localReviews = review ? 2 : 0;
        const root: Mount = { hooks: [], render: () => DiffReview({}) };

        mounts.push(root);
        render(root);
        await flush();
        const files = nodes(root.tree).filter(
            (node) => node.props.onLoaded !== undefined && node.props.file !== undefined,
        );

        assert.equal(files.length, 7);
        requests.length = 0;
        const readerProps = files.map((node) => ({ ...node.props, target: {}, active: true }));
        const readers = files.map((node, i) => mountChild(node, readerProps[i]!));

        mounts.push(...readers);
        readers.forEach(render);
        assert.equal(requests.length, 4, "the production queue limits simultaneous reads");
        const first = [...requests];
        const answer = review ? { diff: "" } : "";

        // Remove two queued files, keeping one waiting reader. Even if abort delivery settles late,
        // the cancelled queue entries must never start when active slots later become available.
        dispose(readers[4]!);
        readerProps[5]!.active = false;
        render(readers[5]!);
        dispose(readers[0]!);
        assert.equal(first[0]!.signal?.aborted, true, "an active diff read is aborted on teardown");
        first[0]!.resolve(answer);
        await flush();
        assert.equal(requests.length, 5, "only the surviving queued file starts");
        assert.equal(requests[4]!.path, `${review ? "diff" : "workingdiff"}:file-6.txt`);
        readers.slice(1, 4).forEach(dispose);
        dispose(readers[6]!);
        requests.slice(1).forEach((request) => request.resolve(answer));
        await flush();
        assert.equal(
            requests.length,
            5,
            "cancelled queued diffs stay removed after all active reads settle",
        );
        dispose(root);
    }
});

test("diff context reads are cancelled without caching an abandoned failure", async (t) => {
    const text =
        "diff --git a/context.txt b/context.txt\n--- a/context.txt\n+++ b/context.txt\n@@ -4 +4 @@\n-old\n+new\n";

    for (const scoped of [false, true]) {
        const block: Mount = {
            hooks: [],
            render: () => DiffBlock({ text, path: "/fixture/context.txt", bare: true }),
        };
        const node = child(render(block), (each) => each.props.file !== undefined);
        const props = {
            ...node.props,
            expand: true,
            reviewPath: scoped ? "context.txt" : null,
            discussion: { cwd: "/fixture", threads: [{ cwd: "/fixture", line: 1, side: "new" }] },
        };
        const diff = mountChild(node, props);

        t.after(() => {
            dispose(block);
            dispose(diff);
        });
        render(diff);
        const request = requests.at(-1)!;

        assert.equal(request.path, scoped ? "context:context.txt" : "view:/fixture/context.txt");
        props.discussion.threads = [];
        render(diff);
        assert.equal(
            request.signal?.aborted,
            true,
            "context no longer needed by the diff is aborted",
        );
        request.resolve({ kind: "text", text: "abandoned" });
        await flush();
        const before = requests.length;

        props.discussion.threads = [{ cwd: "/fixture", line: 1, side: "new" }];
        render(diff);
        assert.equal(
            requests.length,
            before + 1,
            "abandoned context does not poison the cache for the next reader",
        );
        dispose(diff);
    }
});
