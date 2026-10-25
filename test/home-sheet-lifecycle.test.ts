// Regression boundary: real Preact, Sheets/Home, ImportPanel, named-agent form, store and Back.
// Alternate starts stay inline, keep named Chat primary, and retain native import consent/drafts.
// Nested sheets and resize must retain one opening without keeping hidden handlers active.
// Import guard matrices live in project-access-ui; this owns Home's real integration and exact route.
// Unrelated forms and synthetic HTTP are leaves. No layout, native focus or touch claims.
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { registerHooks } from "node:module";
import { after, test, type TestContext } from "node:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";

type Props = Record<string, any>;
type Request = { path: string; method: string; body?: Props };
let requests: Request[] = [];
let pending: ((response: Response) => void) | null = null;
const events = new EventTarget();
const location = new URL("http://offline.invalid/projects/alpha");
const storage = new Map<string, string>();
const media = new Map<string, EventTarget & { matches: boolean }>();
let width = 390;
const visualViewport = Object.assign(new EventTarget(), { height: 600, offsetTop: 40 });

function queryMatches(query: string) {
    const size = /^\((min|max)-width: (\d+)px\)$/.exec(query);

    return size
        ? size[1] === "min"
            ? width >= Number(size[2])
            : width <= Number(size[2])
        : query === "(pointer: coarse)";
}

function matchMedia(query: string) {
    if (!media.has(query)) {
        media.set(query, Object.assign(new EventTarget(), { matches: queryMatches(query) }));
    }

    return media.get(query)!;
}

function resize(next: number) {
    width = next;

    for (const [query, target] of media) {
        const matches = queryMatches(query);

        if (target.matches !== matches) {
            target.matches = matches;
            target.dispatchEvent(new Event("change"));
        }
    }
}

class Primitive {
    parentNode: Primitive | null = null;
    childNodes: Primitive[] = [];
    attributes: Props = {};
    listeners = new Map<string, (this: Primitive, event: Props) => void>();
    nodeType = 1;
    data = "";
    value = "";
    disabled = false;
    checked = false;
    namespaceURI = "http://www.w3.org/1999/xhtml";
    style = {
        properties: new Map<string, string>(),
        setProperty(name: string, value: string) {
            this.properties.set(name, value);
        },
        getPropertyValue(name: string) {
            return this.properties.get(name) ?? "";
        },
        removeProperty(name: string) {
            this.properties.delete(name);
        },
    };
    tag: string;

    constructor(tag: string) {
        this.tag = tag;
    }

    get ownerDocument() {
        return document;
    }
    get localName() {
        return this.tag;
    }
    get parentElement() {
        return this.parentNode;
    }
    get firstChild(): Primitive | null {
        return this.childNodes[0] ?? null;
    }
    get nextSibling(): Primitive | null {
        const siblings = this.parentNode?.childNodes;

        return siblings?.[siblings.indexOf(this) + 1] ?? null;
    }
    get isConnected(): boolean {
        return this === document.body || Boolean(this.parentNode?.isConnected);
    }
    get textContent(): string {
        return this.nodeType === 3
            ? this.data
            : this.childNodes.map((child) => child.textContent).join("");
    }
    getAttribute(name: string) {
        return this.attributes[name] ?? null;
    }
    setAttribute(name: string, value: unknown) {
        this.attributes[name] = String(value);
    }
    removeAttribute(name: string) {
        delete this.attributes[name];
    }
    addEventListener(
        type: string,
        handler: (this: Primitive, event: Props) => void,
        options: boolean | AddEventListenerOptions = false,
    ) {
        const capture = typeof options === "boolean" ? options : Boolean(options.capture);

        this.listeners.set(`${type}${capture}`, handler);
    }
    removeEventListener(
        type: string,
        _handler: unknown,
        options: boolean | EventListenerOptions = false,
    ) {
        const capture = typeof options === "boolean" ? options : Boolean(options.capture);

        this.listeners.delete(`${type}${capture}`);
    }
    insertBefore(child: Primitive, before: Primitive | null) {
        child.parentNode?.removeChild(child);
        const at = before ? this.childNodes.indexOf(before) : -1;

        this.childNodes.splice(at === -1 ? this.childNodes.length : at, 0, child);
        child.parentNode = this;
    }
    appendChild(child: Primitive) {
        this.insertBefore(child, null);
    }
    removeChild(child: Primitive) {
        const at = this.childNodes.indexOf(child);

        assert.notEqual(at, -1);
        this.childNodes.splice(at, 1);
        child.parentNode = null;
    }
    remove() {
        this.parentNode?.removeChild(this);
    }
    matches(selector: string): boolean {
        return selector.split(",").some((part) => {
            const choice = part.trim();
            const attribute = /^\[([^=\]]+)(?:=["']?([^"'\]]+)["']?)?\]$/.exec(choice);

            if (attribute) {
                return (
                    attribute[1]! in this.attributes &&
                    (attribute[2] === undefined || this.attributes[attribute[1]!] === attribute[2])
                );
            }

            return choice.startsWith(".")
                ? String(this.attributes.class ?? "")
                      .split(/\s+/)
                      .includes(choice.slice(1))
                : choice === this.tag;
        });
    }
    closest(selector: string): Primitive | null {
        return this.matches(selector) ? this : (this.parentNode?.closest(selector) ?? null);
    }
    querySelector(selector: string): Primitive | null {
        return this.querySelectorAll(selector)[0] ?? null;
    }
    querySelectorAll(selector: string): Primitive[] {
        return this.childNodes.flatMap((child) => [
            ...(child.matches(selector) ? [child] : []),
            ...child.querySelectorAll(selector),
        ]);
    }
    contains(node: Primitive | null): boolean {
        return (
            node !== null &&
            (node === this || this.childNodes.some((child) => child.contains(node)))
        );
    }
    focus() {
        document.activeElement = this;
    }
    getClientRects() {
        return this.closest("[hidden], [inert]") ? [] : [{}];
    }
}

const document = Object.assign(new EventTarget(), {
    visibilityState: "hidden",
    documentElement: { dataset: { motion: "reduced" } },
    body: null as unknown as Primitive,
    activeElement: null as Primitive | null,
    querySelector: (selector: string) => document.body.querySelector(selector),
    querySelectorAll: (selector: string) => document.body.querySelectorAll(selector),
    createElement: (tag: string) => new Primitive(tag),
    createElementNS: (_namespace: string, tag: string) => new Primitive(tag),
    createTextNode(data: string) {
        const text = new Primitive("text");

        text.nodeType = 3;
        text.data = data;

        return text;
    },
});

document.body = new Primitive("body");
document.activeElement = document.body;

// A small history transport, not a second Back policy: production back.js owns layer ordering.
const entries: { state: Props; path: string }[] = [
    { state: { pocket: { layers: 0, back: 0 } }, path: location.href },
];
let at = 0;
const history = {
    get state() {
        return entries[at]!.state;
    },
    get length() {
        return entries.length;
    },
    pushState(state: Props, _title: string, path: string) {
        location.href = new URL(path, location).href;
        entries.splice(++at, entries.length, { state, path: location.href });
    },
    replaceState(state: Props, _title: string, path: string) {
        location.href = new URL(path, location).href;
        entries[at] = { state, path: location.href };
    },
    go(delta: number) {
        const next = Math.max(0, Math.min(entries.length - 1, at + delta));

        if (next !== at) {
            at = next;
            location.href = entries[at]!.path;
            queueMicrotask(() =>
                events.dispatchEvent(
                    Object.assign(new Event("popstate"), { state: history.state }),
                ),
            );
        }
    },
    back() {
        history.go(-1);
    },
};
const globals: Record<string, unknown> = {
    document,
    history,
    location,
    navigator: { platform: "", onLine: false },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    matchMedia,
    visualViewport,
    innerHeight: 844,
    localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
    },
    sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
    },
    fetch: (path: string, init: RequestInit) => {
        const request = {
            path,
            method: init.method ?? "GET",
            body: init.body ? JSON.parse(String(init.body)) : undefined,
        };

        requests.push(request);

        if (path === "/api/projects" && request.method === "GET") {
            return Promise.resolve(Response.json({ projects: [] }));
        }

        if (path === "/api/pi-sessions/active" && request.method === "GET") {
            return Promise.resolve(Response.json({ sessions: [], warnings: [] }));
        }

        if (path === "/api/pi-sessions/history" && request.method === "GET") {
            return Promise.resolve(
                Response.json({
                    sessions: [
                        {
                            path: "/synthetic/session.jsonl",
                            cwd: "/synthetic",
                            title: "Synthetic saved session",
                            messages: 2,
                            modified: new Date().toISOString(),
                        },
                    ],
                    warnings: [],
                }),
            );
        }

        assert.ok(
            [
                "/api/pip/agents?identityOnly=1",
                "/api/pi-sessions/preview",
                "/api/pi-sessions/continue",
            ].includes(path),
            `no unexpected request: ${path}`,
        );
        assert.equal(request.method, "POST");

        return new Promise<Response>((resolve) => {
            assert.equal(pending, null, "one creation in flight");
            pending = resolve;
        });
    },
};
const descriptors = Object.keys(globals).map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
);

for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
}

const inert = (...names: string[]) =>
    names.map((name) => `export const ${name}=()=>null;`).join("\n");
const ui = new URL("../web/ui.js", import.meta.url).href;
const storeUrl = new URL("../web/store.js", import.meta.url).href;
const sources: Record<string, string> = {
    "./named-agent-avatar.js": inert("NamedAgentAvatar"),
    "./sidebar-context.js": inert("openSidebarOptions", "useSidebarContext"),
    "./ssh-status.js": inert("RemoteProjectIcon"),
    "./workspace-location.js": `${inert("LocationPicker", "rememberSshFolder")} export const recentSshFolders=()=>[];`,
    "./sheets/project.js": inert("ProjectForm", "ProjectSheet"),
    "./sheets/session-projects.js": `import {html} from ${JSON.stringify(ui)};
        export const ProjectSessionPanel=props=>html\`<native-session-panel
            data-project=\${props.projectId} data-one-time=\${String(Boolean(props.oneTime))}
            data-visible=\${String(props.visible)} />\`;`,
    "./sheets/session.js": `import {html,Sheet} from ${JSON.stringify(ui)};
        import {openSheet,closeSheet} from ${JSON.stringify(storeUrl)};
        // Only the legacy explicit Import sheet is a leaf; Home uses the actual ImportPanel.
        export const NewSessionSheet=()=>html\`<\${Sheet} title="Import from Pi" onClose=\${closeSheet}>
            <button onClick=\${()=>openSheet({type:'new-session',tab:'new'})}>Start new</button>
        <//>\`;
        ${inert("SessionActions")}`,
    "./extension-ui.js": `${inert("ExtensionSheet", "onExtensionsGone")}`,
    "./chat.js": inert("ChatSheet"),
    "./share.js": inert("ShareSheet"),
    "./sheets/branch.js": inert("BranchPicker"),
    "./sheets/file.js": inert("FileSheet"),
    "./sheets/find.js": inert("FindSheet"),
    "./sheets/gallery.js": `${inert("GalleryEntrySheet", "GalleryShareSheet", "GallerySheet", "GallerySourceSheet", "GalleryUpdateSheet")} export const galleryAvailable=()=>false;`,
    "./sheets/folder.js": inert("CwdSheet"),
    "./sheets/memory.js": inert("MemorySheet"),
    "./sheets/menu.js": inert("MenuSheet", "PlacesSheet"),
    "./sheets/message.js": inert("MessageSheet"),
    "./sheets/model.js": inert("ModelPicker"),
    "./sheets/pip.js": inert("PipModelPicker"),
    "./sheets/people.js": inert("InviteSheet"),
    "./sheets/providers.js": inert("AuthDialog"),
    "./sheets/running.js": inert("RunningSheet"),
    "./sheets/hooks.js": inert("HooksSheet"),
    "./sheets/schedules.js": inert("SchedulesSheet"),
    "./sheets/settings.js": inert("SettingsSheet"),
    "./sheets/session-move.js": inert("SessionMoveSheet"),
    "./sheets/sidebar-options.js": inert("SidebarOptions"),
    "./sheets/named-agent-options.js": inert("NamedAgentOptions"),
    "./sheets/shortcuts.js": inert("ShortcutsSheet"),
    "./sheets/text.js": inert("TextSheet"),
    "./sheets/viewers.js": inert("ArtifactsSheet", "ArtifactViewer", "ImageViewer"),
    "./sheets/work-item-limits.js": inert("WorkItemLimitsSheet"),
    "./sheets/worktree.js": inert("WorktreeSheet"),
    "./trust.js": inert("TrustSheet"),
    "./topbar.js": inert("AgentHeaderSheet"),
};
const imports = registerHooks({
    resolve(specifier, context, next) {
        // Markdown is outside this lifecycle boundary; DOMPurify has no Window in this DOM.
        if (specifier === "dompurify" && context.parentURL?.endsWith("/web/ui.js")) {
            return {
                url: `data:text/javascript,${encodeURIComponent("export default {addHook(){}};")}`,
                shortCircuit: true,
            };
        }

        const source = /\/web\/(sheets|home|named-agents)\.js$/.test(context.parentURL ?? "")
            ? sources[specifier]
            : undefined;

        return source === undefined
            ? next(specifier, context)
            : { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    },
    load(url, context, next) {
        const loaded = next(url, context);

        // Manual negative control only: remove native retention without changing any files on disk.
        // HOME_SHEET_CONTROL=unmount node --test test/home-sheet-lifecycle.test.ts must fail
        // when the project setup disappears beneath its child, not during fixture/module setup.
        if (process.env.HOME_SHEET_CONTROL === "unmount" && url.endsWith("/web/sheets.js")) {
            return {
                ...loaded,
                source: String(loaded.source).replace(
                    /const layers = creation && creation !== sheet \? \[creation, sheet\] : \[sheet\];/,
                    "const layers = [sheet];",
                ),
            };
        }

        // The resize counterfactual keys the real surface by breakpoint, reproducing lost form state.
        if (process.env.HOME_SHEET_CONTROL === "resize-remount" && url.endsWith("/web/home.js")) {
            return {
                ...loaded,
                source: String(loaded.source).replace(
                    "inline=${roomy}",
                    "key=${roomy} inline=${roomy}",
                ),
            };
        }

        if (process.env.HOME_SHEET_CONTROL === "forget-default" && url.endsWith("/web/home.js")) {
            return {
                ...loaded,
                source: String(loaded.source).replace(
                    "onInteract=${engage}",
                    "onInteract=${undefined}",
                ),
            };
        }

        if (process.env.HOME_SHEET_CONTROL === "always-bottom" && url.endsWith("/web/home.js")) {
            return {
                ...loaded,
                source: String(loaded.source).replace(
                    "bottom=${compact && !inline}",
                    "bottom=${!inline}",
                ),
            };
        }

        return loaded;
    },
});
const { store, openSheet, closeSheet, navigate } = await import(storeUrl);
const { agentDrafts } = await import(new URL("../web/agent-drafts.js", import.meta.url).href);
const { Sheets } = await import(new URL("../web/sheets.js", import.meta.url).href);
const { HomeCreationPage } = await import(new URL("../web/home.js", import.meta.url).href);
const initial = store.state;
let owner = 0;

after(async () => {
    // Production Back's route-heading timer is 600 ms; retain its document until it has settled.
    await new Promise<void>((resolve) => setTimeout(resolve, 650));
    imports.deregister();

    for (const [key, descriptor] of descriptors) {
        if (descriptor) {
            Object.defineProperty(globalThis, key, descriptor);
        } else {
            Reflect.deleteProperty(globalThis, key);
        }
    }
});

async function fixture(
    t: TestContext,
    {
        page = false,
        defaultPage = false,
        initialWidth = page ? 1280 : 390,
    }: { page?: boolean; defaultPage?: boolean; initialWidth?: number } = {},
) {
    requests = [];
    pending = null;
    resize(initialWidth);
    visualViewport.height = 600;
    visualViewport.offsetTop = 40;
    const alpha = { id: "alpha", name: "Alpha", defaultAgentId: "ada" };
    const beta = { id: "beta", name: "Beta", defaultAgentId: "ada" };

    store.state = {
        ...initial,
        me: { id: `home-sheet-owner-${++owner}`, role: "owner" },
        server: { projects: 1, privateAgents: 4 },
        projectId: "alpha",
        conversationId: null,
        projects: [alpha, beta],
        projectsLoaded: true,
        pinned: [],
        namedAgents: [{ agentId: "ada", name: "Ada", chatIds: [], chats: [] }],
        sheet: null,
    };
    // A completed inline import changes the real route. Begin each opening with matching native
    // route/store state rather than leaving the next test over that previous imported Chat.
    navigate(null, { projectId: "alpha", replace: true });
    await new Promise<void>((resolve) => setTimeout(resolve, 80));

    if (page) {
        if (defaultPage) {
            navigate(null);
        } else {
            openSheet({ type: "new-session" });
        }

        // Let native desktop/tablet entry settle before mounting its page, or the default Home.
        await new Promise<void>((resolve) => setTimeout(resolve, 80));
    }

    const root = new Primitive("root");

    document.body.appendChild(root);
    let queued = false;
    let disposed = false;
    const update = () =>
        render(
            page ? [h(HomeCreationPage, {}), h(Sheets, {})] : h(Sheets, {}),
            root as unknown as HTMLElement,
        );
    const stop = store.subscribe(() => {
        if (!queued) {
            queued = true;
            queueMicrotask(() => {
                queued = false;

                if (!disposed) {
                    update();
                }
            });
        }
    });

    const perform = async (action: () => void) => {
        await act(async () => {
            action();
            await new Promise<void>((resolve) => setImmediate(resolve));
        });
        // Passive mount effects can start native api()/Response.text() after the first act flush.
        await act(async () => {
            await new Promise<void>((resolve) => setImmediate(resolve));
        });
    };

    const all = (): Primitive[] =>
        root.querySelectorAll(
            "button, select, input, form, main, section, div, header, h1, native-session-panel",
        );

    const one = (predicate: (node: Primitive) => boolean, description: string) => {
        const found = all().find(predicate);

        assert.ok(found, `${description} is rendered`);

        return found;
    };

    const label = (name: string) => one((node) => node.attributes["aria-label"] === name, name);
    const button = (text: string) =>
        one((node) => node.tag === "button" && node.textContent.trim() === text, text);
    const fire = (node: Primitive, type: string, extra: Props = {}) =>
        perform(() => {
            assert.ok(node.listeners.has(`${type}false`), `${type} handler exists`);

            if (extra.currentTarget) {
                Object.assign(node, extra.currentTarget);
            }

            const path: Primitive[] = [];
            let stopped = false;
            const event: Props = {
                ...extra,
                target: node,
                currentTarget: node,
                defaultPrevented: false,
                preventDefault() {
                    this.defaultPrevented = true;
                },
                stopPropagation() {
                    stopped = true;
                },
            };

            for (let item: Primitive | null = node; item; item = item.parentNode) {
                path.push(item);
            }

            // Real Preact proxies receive capture then bubble delivery. This lets the default page
            // observe actual descendant interactions; the fixture never sets its engaged state.
            for (const [phase, targets] of [
                [true, [...path].reverse()],
                [false, path],
            ] as const) {
                for (const item of targets) {
                    if (stopped) {
                        return;
                    }

                    event.currentTarget = item;
                    item.listeners.get(`${type}${phase}`)?.call(item, event);
                }
            }
        });
    const click = (text: string) => fire(button(text), "click");
    const home = () => one((node) => node.attributes["data-part"] === "home", "Home creation");

    const selected = (name: string) => {
        const choice = one(
            (node) =>
                node.tag === "button" &&
                node.textContent.includes(name) &&
                node.matches(".home-project-choice"),
            `${name} project choice`,
        );

        return choice.attributes["aria-pressed"];
    };

    const disclosure = () => button("Other ways to start");
    const hidden = (node: Primitive) => Boolean(node.closest("[hidden], [inert]"));
    const key = (name: string, extra: Props = {}) =>
        perform(() =>
            events.dispatchEvent(
                Object.assign(new Event("keydown", { cancelable: true }), { key: name, ...extra }),
            ),
        );

    const unmount = async () => {
        disposed = true;
        stop();
        await act(() => render(null, root as unknown as HTMLElement));
    };

    t.after(async () => {
        await perform(() => store.set({ sheet: null }));
        await unmount();
        document.body.removeChild(root);
        document.activeElement = document.body;
        // Let the real Back module drain its bounded history synchronization before the next owner.
        await new Promise<void>((resolve) => setTimeout(resolve, 80));
    });
    await perform(update);

    return {
        perform,
        all,
        one,
        label,
        button,
        fire,
        click,
        home,
        selected,
        disclosure,
        hidden,
        key,
        unmount,
    };
}

test("Other ways to start retains real inline import, independent project and consent through alternates, child setup and resize", async (t) => {
    const f = await fixture(t);

    await f.perform(() =>
        store.set({
            projects: [
                ...store.state.projects,
                {
                    id: "remote",
                    name: "Remote",
                    location: { kind: "ssh", host: "test-host" },
                },
            ],
        }),
    );
    await f.perform(() => openSheet({ type: "new-session" }));
    const opening = store.state.sheet;
    const route = location.pathname;
    const home = f.home();
    const alternatives = f.button("Other ways to start");

    const field = (id: string) =>
        f.one(
            (node) =>
                typeof node.attributes.id === "string" &&
                (node.attributes.id === id || node.attributes.id.endsWith(`-${id}`)),
            id,
        );
    const inlineImport = () =>
        f.one((node) => node.matches(".home-import-options"), "inline Import");

    const sameOpening = () => {
        assert.equal(store.state.sheet, opening, "Import keeps the native Home opening");
        assert.equal(location.pathname, route, "the underlying project route is unchanged");
        assert.equal(f.home(), home);
    };

    const primary = () =>
        assert.equal(f.hidden(f.button("Chat with Ada")), false, "named Chat remains primary");

    assert.equal(alternatives.attributes["aria-expanded"], "false");
    assert.equal(
        f
            .all()
            .filter(
                (node) =>
                    node.tag === "button" && node.textContent.trim() === "Other ways to start",
            ).length,
        1,
        "one disclosure owns all alternatives",
    );
    assert.equal(
        f
            .all()
            .filter(
                (node) =>
                    node.tag === "button" &&
                    node.attributes["aria-label"] === "Close" &&
                    !f.hidden(node),
            ).length,
        1,
        "embedded Home has only its native Close",
    );
    assert.equal(
        f.all().some((node) => node.attributes["aria-label"] === "Cancel New Session"),
        false,
        "embedded Home has no duplicate content cancel",
    );
    assert.equal(requests.length, 0, "Import is lazy before its first visit");
    await f.fire(alternatives, "click");
    assert.equal(alternatives.attributes["aria-expanded"], "true");

    for (const name of ["New Work Item", "Import from Pi", "One-time Chat"]) {
        const choice = f.button(name);

        assert.equal(choice.tag, "button");
        assert.equal(choice.attributes["aria-pressed"], "false");
        assert.notEqual(choice.attributes.role, "tab", "choices are actions, not a tab widget");
    }

    await f.click("New Work Item");
    primary();
    const work = f.one((node) => node.matches(".home-work-options"), "Work Item options");

    assert.equal(f.hidden(work), false);
    await f.click("One-time Chat");
    primary();
    const oneTime = f.one((node) => node.matches(".home-one-time-options"), "one-time options");
    const oneTimePanel = oneTime.querySelector("native-session-panel");

    assert.ok(oneTimePanel);
    assert.equal(
        oneTimePanel.attributes["data-project"],
        undefined,
        "one-time never inherits Home's project",
    );
    assert.equal(f.hidden(work), true);
    assert.equal(requests.length, 0, "non-import choices do not mount the importer");
    await f.click("Import from Pi");
    sameOpening();
    primary();
    const importHost = inlineImport();

    assert.equal(f.button("Import from Pi").attributes["aria-pressed"], "true");
    assert.equal(f.hidden(importHost), false);
    assert.equal(f.hidden(oneTime), true);
    assert.ok(requests.some((request) => request.path === "/api/pi-sessions/active"));
    await f.click("History");
    await f.fire(field("import-history-search"), "input", {
        currentTarget: { value: "Synthetic" },
    });
    await f.fire(
        f.one(
            (node) =>
                node.matches(".pi-session") && node.textContent.includes("Synthetic saved session"),
            "saved session",
        ),
        "click",
    );
    assert.ok(pending, "native History selection requests a real preview");
    assert.deepEqual(requests.at(-1)?.body, { path: "/synthetic/session.jsonl" });
    assert.equal(
        f.button("New Work Item").disabled,
        true,
        "busy import blocks alternate switching",
    );
    assert.equal(f.button("Local").disabled, true, "busy import blocks host filters");
    assert.equal(
        f.one(
            (node) => node.matches(".home-project-choice") && node.textContent.includes("Beta"),
            "Beta",
        ).disabled,
        true,
    );
    await f.perform(() => {
        pending!(
            Response.json({
                path: "/synthetic/session.jsonl",
                sha256: "synthetic-digest",
                leafId: "saved-leaf",
                title: "Synthetic preview",
                cwd: "/synthetic",
                entries: 2,
                messages: 2,
                history: [
                    { role: "user", text: "Synthetic question" },
                    { role: "assistant", text: "Synthetic answer" },
                ],
                warnings: [],
                hasImages: false,
                models: [{ provider: "synthetic", id: "model", images: true, levels: ["off"] }],
                sourceModel: { provider: "synthetic", modelId: "model" },
                sourceThinkingLevel: "off",
            }),
        );
        pending = null;
    });
    const preview = field("import-preview");

    assert.equal(
        field("import-project").value,
        "",
        "preview starts independently of selected Alpha",
    );
    await f.fire(field("import-project"), "change", { currentTarget: { value: "beta" } });
    await f.fire(field("import-consent"), "change", { currentTarget: { checked: true } });
    assert.equal(f.button("Move").disabled, false, "native model and consent permit import");
    await f.click("New Work Item");
    assert.equal(f.hidden(importHost), true);
    assert.equal(preview.isConnected, true, "switching keeps the actual import draft mounted");
    assert.equal(
        f.one((node) => node.matches(".home-work-options"), "Work Item options"),
        work,
    );
    await f.click("Other ways to start");
    assert.equal(alternatives.attributes["aria-expanded"], "false");
    assert.equal(f.hidden(work), true);
    assert.equal(preview.isConnected, true, "collapsing retains all visited draft models");
    primary();
    await f.click("Other ways to start");
    await f.click("Import from Pi");
    assert.equal(inlineImport(), importHost);
    assert.equal(field("import-preview"), preview);
    assert.equal(field("import-project").value, "beta");
    assert.equal(field("import-consent").checked, true);
    assert.equal(field("import-history-search").value, "Synthetic");
    assert.equal(f.button("History").attributes["aria-selected"], "true");
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    await f.perform(() => history.back());
    sameOpening();
    assert.equal(f.hidden(importHost), true, "system Back returns from Import to the choice group");
    assert.equal(alternatives.attributes["aria-expanded"], "true");
    assert.equal(preview.isConnected, true, "Back hides rather than discards the import draft");
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    await f.perform(() => history.back());
    sameOpening();
    assert.equal(
        alternatives.attributes["aria-expanded"],
        "false",
        "next Back collapses the alternatives",
    );
    assert.equal(preview.isConnected, true);
    await f.click("Other ways to start");
    await f.click("Import from Pi");
    assert.equal(field("import-consent").checked, true);

    await f.click("test-host");
    assert.equal(
        f
            .all()
            .some(
                (node) =>
                    node.matches(".home-project-choice") &&
                    node.attributes["aria-pressed"] === "true",
            ),
        false,
        "filter can clear Home's selected project",
    );
    assert.equal(f.button("New Work Item").disabled, true, "Work Item requires a project");
    assert.equal(f.hidden(importHost), false, "Import remains usable with no project");
    assert.equal(
        field("import-project").value,
        "beta",
        "Home filter does not rewrite the import destination",
    );
    await f.click("One-time Chat");
    assert.equal(f.hidden(oneTime), false, "one-time is usable without a project");
    assert.equal(oneTime.querySelector("native-session-panel"), oneTimePanel);
    assert.equal(oneTimePanel.attributes["data-project"], undefined);
    await f.click("All");
    await f.fire(
        f.one(
            (node) => node.matches(".home-project-choice") && node.textContent.includes("Beta"),
            "Beta",
        ),
        "click",
    );
    assert.equal(f.hidden(oneTime), false, "selecting a project does not force one-time into Work");
    assert.equal(oneTimePanel.attributes["data-project"], undefined);
    primary();
    await f.click("Import from Pi");
    await f.click("New Project");
    sameOpening();
    assert.equal(
        preview.isConnected,
        true,
        "New Project must retain the actual native import preview",
    );
    assert.equal(
        inlineImport() === importHost,
        true,
        "New Project must not remount the alternate flow",
    );
    assert.equal(f.hidden(importHost), true, "New Project covers the retained alternate flow");
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    await f.perform(() => history.back());
    sameOpening();
    assert.equal(f.hidden(importHost), false);
    assert.equal(field("import-preview"), preview, "project setup does not remount Import");
    assert.equal(field("import-consent").checked, true);
    await f.fire(f.label("Named agent"), "change", { currentTarget: { value: "__create" } });
    assert.equal(store.state.sheet?.type, "named-agent");
    assert.equal(f.hidden(home), true);
    await f.key("Escape");
    sameOpening();
    assert.equal(
        field("import-preview"),
        preview,
        "child setup returns to the same import preview",
    );

    for (const next of [820, 390]) {
        await f.perform(() => resize(next));
        sameOpening();
        assert.equal(inlineImport(), importHost);
        assert.equal(field("import-preview"), preview);
        assert.equal(field("import-consent").checked, true);
        assert.equal(field("import-project").value, "beta");
        assert.equal(f.hidden(importHost), false);
        primary();
    }

    await f.fire(
        f.one((node) => node.tag === "form" && node.matches(".import-form"), "native import form"),
        "submit",
    );
    assert.ok(pending);
    assert.deepEqual(requests.at(-1), {
        path: "/api/pi-sessions/continue",
        method: "POST",
        body: {
            path: "/synthetic/session.jsonl",
            sha256: "synthetic-digest",
            leafId: "saved-leaf",
            model: "synthetic/model",
            thinkingLevel: "off",
            acknowledged: true,
            visibility: "owner",
            projectId: "beta",
        },
    });
    await f.perform(() => {
        pending!(Response.json({ id: 741 }));
        pending = null;
    });
    assert.equal(
        store.state.conversationId,
        741,
        "completion navigates to the exact imported Chat",
    );
    assert.equal(store.state.projectId, null);
    assert.equal(store.state.sheet, null);
    await f.perform(() => {});
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    assert.equal(location.pathname, "/s/741", "native route matches the imported Chat");
});

test("eligible collaborators see native Work and Import alternatives but no owner-only one-time Chat", async (t) => {
    const f = await fixture(t);

    await f.perform(() =>
        store.set({ me: { id: `home-guest-${owner}`, role: "guest", continuePiSessions: true } }),
    );
    await f.perform(() => openSheet({ type: "new-session" }));
    await f.click("Other ways to start");
    assert.ok(f.button("New Work Item"));
    assert.ok(f.button("Import from Pi"));
    assert.equal(
        f
            .all()
            .some((node) => node.tag === "button" && node.textContent.trim() === "One-time Chat"),
        false,
    );
    assert.deepEqual(requests, [], "opening choices does not visit the importer");
});

test("mobile creation retains project, disclosure and native-created agent across child sheets, then resets on close", async (t) => {
    const f = await fixture(t);
    const route = location.pathname;

    await f.perform(() => openSheet({ type: "new-session" }));
    assert.equal(
        store.state.sheet?.type,
        "home-creation",
        "mobile creation is a sheet, not a route",
    );
    assert.equal(location.pathname, route, "the project route stays behind creation");
    assert.equal(store.state.projectId, "alpha");
    const opening = store.state.sheet;

    await f.click("Local");
    await f.fire(
        f.one(
            (node) => node.matches(".home-project-choice") && node.textContent.includes("Beta"),
            "Beta",
        ),
        "click",
    );
    await f.click("Other ways to start");
    await f.click("New Work Item");
    const retainedHome = f.home();
    const parentDialog = retainedHome.closest(".sheet");

    assert.ok(parentDialog);
    assert.equal(
        parentDialog.listeners.has("touchstartfalse"),
        true,
        "active Sheet has native drag handlers",
    );
    assert.equal(f.selected("Beta"), "true");
    assert.equal(f.disclosure().attributes["aria-expanded"], "true");
    await f.fire(f.label("Named agent"), "change", { currentTarget: { value: "__create" } });
    assert.equal(store.state.sheet?.type, "named-agent");
    assert.equal(
        store.state.sheet?.creationParent,
        opening,
        "the real store links the exact opening",
    );
    assert.equal(f.home(), retainedHome, "Preact did not unmount the setup");
    assert.ok(
        f.hidden(retainedHome),
        "retained setup is hidden and inert while the child is active",
    );
    assert.equal(retainedHome.closest("[hidden]")?.attributes.hidden, "true");
    assert.equal(retainedHome.closest("[inert]")?.attributes.inert, "true");
    assert.equal(parentDialog.attributes["aria-modal"], undefined, "hidden Sheet is inactive");
    assert.equal(
        parentDialog.listeners.has("touchstartfalse"),
        false,
        "hidden Sheet drops drag handlers",
    );
    assert.equal(
        document.activeElement,
        f.label("New PiP"),
        "only the child receives the native Sheet's focus call",
    );
    await f.fire(f.label("Agent name"), "input", { currentTarget: { value: "Clio" } });
    await f.fire(
        f.one(
            (node) => node.tag === "form" && node.matches(".named-agent-form"),
            "native agent form",
        ),
        "submit",
    );
    const creation = requests.find((request) => request.method === "POST");

    assert.ok(creation);
    assert.equal(creation.body?.name, "Clio");
    assert.equal(creation.body?.projectId, null, "identity creation does not start a project chat");
    assert.ok(pending, "the real agent form submitted identity-only creation");
    await f.perform(() => {
        pending!(Response.json({ agentId: "clio", name: "Clio", chats: [], chatIds: [] }));
        pending = null;
    });
    assert.equal(
        store.state.sheet,
        opening,
        "native onCreated closes its child and restores setup",
    );
    assert.equal(f.home(), retainedHome);
    assert.equal(f.selected("Beta"), "true");
    assert.equal(f.label("Named agent").value, "clio");
    assert.equal(f.disclosure().attributes["aria-expanded"], "true");
    assert.equal(f.hidden(retainedHome), false);
    assert.equal(parentDialog.attributes["aria-modal"], "true");
    assert.equal(document.activeElement, parentDialog, "reactivated Sheet regains logical focus");
    assert.equal(
        parentDialog.listeners.has("touchstartfalse"),
        true,
        "restored Sheet reactivates its drag handlers",
    );
    assert.equal(
        agentDrafts("clio").length,
        0,
        "creation callback selects only, without a duplicate draft",
    );
    assert.equal(store.state.agentDraft, null);
    assert.equal(store.state.conversationId, null);
    assert.equal(location.pathname, route);

    // Legacy explicit Import openings remain children; Home's own Import is inline below.
    await f.perform(() => openSheet({ type: "new-session", tab: "import" }));
    assert.equal(store.state.sheet?.creationParent, opening);
    assert.equal(f.home(), retainedHome);
    assert.ok(f.hidden(retainedHome));
    await f.click("Start new");
    assert.equal(store.state.sheet, opening, "Import Start new resumes the exact opening");
    assert.equal(f.home(), retainedHome);
    assert.equal(f.selected("Beta"), "true");
    assert.equal(f.label("Named agent").value, "clio");
    assert.equal(f.disclosure().attributes["aria-expanded"], "true");
    assert.equal(f.button("Local").attributes["aria-pressed"], "true");

    await f.perform(() => openSheet({ type: "new-session", tab: "import" }));
    await act(async () => {
        // Native Back settles the history entries after the child replaced the parent's local layers.
        await new Promise<void>((resolve) => setTimeout(resolve, 80));
    });
    await f.perform(() => history.back());
    assert.equal(
        store.state.sheet,
        opening,
        "system Back restores setup, not its underlying project route",
    );
    assert.equal(f.disclosure().attributes["aria-expanded"], "true");
    assert.equal(location.pathname, route);

    await f.perform(() => openSheet({ type: "new-session", tab: "import" }));
    await f.key("Escape");
    assert.equal(store.state.sheet, opening, "one Escape closes only the active child");
    assert.equal(f.disclosure().attributes["aria-expanded"], "true", "return did not reset setup");
    assert.equal(requests.filter((request) => request.method === "POST").length, 1);
    await f.perform(closeSheet);
    assert.equal(store.state.sheet, null);
    assert.equal(
        f.all().some((node) => node.attributes["data-part"] === "home"),
        false,
        "closing unmounts the retained setup",
    );
    await f.perform(() => openSheet({ type: "new-session" }));
    assert.notEqual(store.state.sheet?.id, opening.id);
    assert.notEqual(f.home(), retainedHome, "later opening mounts fresh state");
    assert.equal(f.selected("Alpha"), "true");
    assert.equal(f.selected("Beta"), "false");
    assert.equal(f.label("Named agent").value, "ada");
    assert.equal(f.button("All").attributes["aria-pressed"], "true");
    assert.equal(f.disclosure().attributes["aria-expanded"], "false");
    assert.ok(f.button("Other ways to start"));
});

// A separate reconciliation risk: replacing desktop/mobile component branches would reset native form drafts.
// Existing mobile-child coverage never changes the page's inline/modal presentation. No production seam is needed.
test("desktop creation page preserves setup and its native panel through mobile resize and back", async (t) => {
    for (const initialWidth of [1280, 820]) {
        await t.test(`${initialWidth}px native New Session entry`, async (t) => {
            const f = await fixture(t, { page: true, initialWidth });
            const intent = store.state.homeCreation;

            assert.ok(intent);
            assert.equal(location.pathname, "/");
            assert.equal(store.state.sheet, null);
            assert.equal(f.selected("Alpha"), "true");
            assert.equal(
                f.all().some((node) => node.matches(".topbar")),
                false,
                "roomy Home has no redundant page toolbar or retained header slot",
            );
            const heading = f.one(
                (node) => node.tag === "h1" && node.textContent === "New Session",
                "in-content heading",
            );

            assert.ok(heading.closest(".home-creation-content"));
            assert.equal(heading.getAttribute("hidden"), null);
            await f.click("Local");
            await f.fire(
                f.one(
                    (node) =>
                        node.matches(".home-project-choice") && node.textContent.includes("Beta"),
                    "Beta",
                ),
                "click",
            );
            await f.click("Other ways to start");
            await f.click("New Work Item");
            const retainedHome = f.home();
            const shell = retainedHome.closest(".sheet");
            const viewport = retainedHome.closest(".home-creation-viewport");
            const panel = () =>
                f.one(
                    (node) =>
                        node.tag === "native-session-panel" &&
                        node.attributes["data-project"] === "beta",
                    "Beta's native Work Item panel",
                );
            const retainedPanel = panel();

            assert.ok(shell);
            assert.ok(viewport);
            assert.equal(shell.attributes.role, undefined, "desktop shell is inline, not a modal");
            assert.equal(shell.attributes["aria-modal"], undefined);
            assert.equal(shell.matches(".bottom-sheet"), false);
            assert.equal(retainedPanel.attributes["data-visible"], "true");
            assert.equal(getEventListeners(visualViewport, "resize").length, 0);
            assert.equal(getEventListeners(visualViewport, "scroll").length, 0);

            await f.perform(() => resize(390));
            assert.equal(
                f.selected("Beta"),
                "true",
                "project choice survives desktop-to-mobile resize",
            );
            assert.equal(
                f.disclosure().attributes["aria-expanded"],
                "true",
                "work mode survives resize",
            );
            assert.equal(f.home(), retainedHome, "the shared Home component was not remounted");
            assert.equal(
                panel(),
                retainedPanel,
                "the native panel's mounted state survives resize",
            );
            assert.equal(f.home().closest(".sheet"), shell);
            assert.equal(shell.attributes.role, "dialog");
            assert.equal(shell.attributes["aria-modal"], "true");
            assert.equal(
                shell.matches(".bottom-sheet"),
                true,
                "narrow explicit page uses the native bottom shell",
            );
            assert.equal(f.hidden(retainedHome), false);
            assert.equal(getEventListeners(visualViewport, "resize").length, 1);
            assert.equal(getEventListeners(visualViewport, "scroll").length, 1);
            // Only custom-property publication is tested; these numbers do not establish rendered geometry.
            assert.equal(viewport.style.getPropertyValue("--creation-viewport-height"), "600px");
            assert.equal(viewport.style.getPropertyValue("--creation-viewport-top"), "40px");
            assert.equal(viewport.style.getPropertyValue("--creation-viewport-bottom"), "204px");
            await f.perform(() => {
                visualViewport.height = 580;
                visualViewport.offsetTop = 50;
                visualViewport.dispatchEvent(new Event("scroll"));
            });
            assert.equal(viewport.style.getPropertyValue("--creation-viewport-height"), "580px");
            assert.equal(viewport.style.getPropertyValue("--creation-viewport-top"), "50px");
            assert.equal(viewport.style.getPropertyValue("--creation-viewport-bottom"), "214px");
            await f.perform(() => {
                visualViewport.height = 650;
                visualViewport.offsetTop = 0;
                visualViewport.dispatchEvent(new Event("resize"));
            });
            assert.equal(viewport.style.getPropertyValue("--creation-viewport-height"), "650px");
            assert.equal(viewport.style.getPropertyValue("--creation-viewport-top"), "0px");
            assert.equal(viewport.style.getPropertyValue("--creation-viewport-bottom"), "194px");

            for (const next of [767, 768, 820, 1180, 540]) {
                await f.perform(() => resize(next));
                const compact = next < 768;

                assert.equal(
                    matchMedia("(pointer: coarse)").matches,
                    true,
                    "input method stays coarse at every width",
                );
                assert.equal(
                    retainedHome.matches(".home-creation-compact"),
                    compact,
                    "width selects the compact form shape",
                );
                assert.equal(retainedHome.matches(".home-creation-embedded"), compact);
                assert.equal(f.selected("Beta"), "true", `${next}px preserves the chosen project`);
                assert.equal(f.disclosure().attributes["aria-expanded"], "true");
                assert.equal(f.home(), retainedHome, `${next}px keeps the same form`);
                assert.equal(panel(), retainedPanel, `${next}px keeps the same native panel`);
                assert.equal(shell.attributes.role, compact ? "dialog" : undefined);
                assert.equal(shell.attributes["aria-modal"], compact ? "true" : undefined);
                assert.equal(shell.matches(".bottom-sheet"), compact);
                assert.equal(f.hidden(retainedHome), false);
                assert.equal(getEventListeners(visualViewport, "resize").length, compact ? 1 : 0);
                assert.equal(getEventListeners(visualViewport, "scroll").length, compact ? 1 : 0);
                assert.equal(
                    f.all().filter((node) => node.matches(".home-creation-sheet")).length,
                    1,
                    "resize does not duplicate the native shell",
                );
            }

            await f.perform(() => openSheet({ type: "new-session" }));
            assert.equal(
                store.state.sheet,
                null,
                "New Session resumes the explicit compact page rather than duplicating it",
            );
            assert.equal(store.state.homeCreation, intent);
            assert.equal(f.home(), retainedHome);
            assert.equal(panel(), retainedPanel);
            await f.perform(() => resize(1280));
            assert.equal(f.selected("Beta"), "true");
            assert.equal(f.disclosure().attributes["aria-expanded"], "true");
            assert.equal(f.button("Local").attributes["aria-pressed"], "true");
            assert.equal(f.home(), retainedHome);
            assert.equal(panel(), retainedPanel);
            assert.equal(retainedPanel.attributes["data-visible"], "true");
            assert.equal(shell.attributes.role, undefined);
            assert.equal(shell.attributes["aria-modal"], undefined);
            assert.equal(shell.matches(".bottom-sheet"), false);
            assert.equal(
                getEventListeners(visualViewport, "resize").length,
                0,
                "inline mode releases viewport listeners",
            );
            assert.equal(getEventListeners(visualViewport, "scroll").length, 0);
            assert.equal(
                store.state.homeCreation,
                intent,
                "resize does not replace the creation intent",
            );
            assert.equal(store.state.sheet, null);
            assert.equal(store.state.conversationId, null);
            assert.equal(store.state.agentDraft, null);
            assert.equal(agentDrafts("ada").length, 0);
            assert.deepEqual(requests, [], "resizing creates no Work Item, chat or API request");
            const cancel = f.label("Cancel New Session");

            assert.ok(
                cancel.closest(".home-creation-content"),
                "return is a quiet content action, not a replacement toolbar",
            );
            assert.equal(cancel.closest("header"), null);
            assert.equal(cancel.matches(".icon-button"), true);
            assert.equal(cancel.matches(".home-creation-close"), true);
            assert.equal(cancel.textContent, "", "content cancel is icon-only");
            assert.equal(
                f
                    .all()
                    .some((node) => node.tag === "button" && node.textContent.trim() === "Cancel"),
                false,
            );

            if (initialWidth === 820) {
                await f.fire(cancel, "click");
            } else {
                await f.key("Escape", { isComposing: true });
                assert.equal(store.state.homeCreation, intent, "IME Escape belongs to the field");
                await f.perform(() => store.set({ launcher: true }));
                await f.key("Escape");
                assert.equal(
                    store.state.homeCreation,
                    intent,
                    "an overlay takes Escape before the page",
                );
                await f.perform(() => store.set({ launcher: false }));
                await f.perform(() => openSheet({ type: "new-session", tab: "import" }));
                await f.key("Escape");
                assert.equal(store.state.sheet, null, "the first Escape closes the native child");
                assert.equal(
                    store.state.homeCreation,
                    intent,
                    "child dismissal does not also cancel the page",
                );
                await f.key("Escape");
            }

            assert.equal(store.state.homeCreation, null);
            assert.equal(
                store.state.projectId,
                "alpha",
                "Cancel/Escape returns to the original project, not the selected setup project",
            );
            assert.equal(location.pathname, "/projects/alpha");
            assert.deepEqual(requests, []);

            await f.perform(() => resize(390));
            await f.unmount();
            assert.equal(
                getEventListeners(visualViewport, "resize").length,
                0,
                "unmount releases mobile viewport listeners",
            );
            assert.equal(getEventListeners(visualViewport, "scroll").length, 0);
            assert.equal(
                getEventListeners(matchMedia("(min-width: 768px)"), "change").length,
                0,
                "unmount releases the page's media listener",
            );
        });
    }
});

test("phone-opened creation keeps one form while tablet widths center its native dialog", async (t) => {
    const f = await fixture(t);
    const route = location.pathname;

    await f.perform(() => openSheet({ type: "new-session" }));
    const intent = store.state.sheet;

    assert.equal(intent?.type, "home-creation");
    await f.fire(
        f.one(
            (node) => node.matches(".home-project-choice") && node.textContent.includes("Beta"),
            "Beta",
        ),
        "click",
    );
    await f.click("Other ways to start");
    await f.click("New Work Item");
    const retainedHome = f.home();
    const shell = retainedHome.closest(".sheet");
    const panel = () =>
        f.one(
            (node) =>
                node.tag === "native-session-panel" && node.attributes["data-project"] === "beta",
            "Beta's native Work Item panel",
        );
    const retainedPanel = panel();

    assert.ok(shell);

    for (const next of [767, 768, 820, 1180, 540]) {
        await f.perform(() => resize(next));
        const compact = next < 768;

        assert.equal(matchMedia("(pointer: coarse)").matches, true);
        assert.equal(f.selected("Beta"), "true");
        assert.equal(f.disclosure().attributes["aria-expanded"], "true");
        assert.equal(f.home(), retainedHome, `${next}px keeps the phone-opened form`);
        assert.equal(retainedHome.matches(".home-creation-compact"), compact);
        assert.equal(
            retainedHome.matches(".home-creation-embedded"),
            true,
            "embedded does not force compact columns on a tablet",
        );
        assert.equal(panel(), retainedPanel);
        assert.equal(retainedHome.closest(".sheet"), shell);
        assert.equal(
            shell.attributes.role,
            "dialog",
            "a phone-opened sheet never becomes an inline page",
        );
        assert.equal(shell.attributes["aria-modal"], "true");
        assert.equal(shell.matches(".bottom-sheet"), compact);
        assert.equal(shell.matches(".wide"), !compact, "tablet shape uses the native wide dialog");
        assert.equal(f.hidden(retainedHome), false);
        assert.equal(store.state.sheet, intent);
        assert.equal(store.state.homeCreation, null);
        assert.equal(
            location.pathname,
            route,
            "presentation changes do not navigate away from the source",
        );
        assert.equal(f.all().filter((node) => node.matches(".home-creation-sheet")).length, 1);
    }

    assert.equal(store.state.agentDraft, null);
    assert.equal(agentDrafts("ada").length, 0);
    assert.deepEqual(requests, []);
    await f.perform(closeSheet);
    assert.equal(f.all().filter((node) => node.matches(".home-creation-sheet")).length, 0);
    assert.equal(getEventListeners(visualViewport, "resize").length, 0);
    assert.equal(getEventListeners(visualViewport, "scroll").length, 0);
    assert.equal(getEventListeners(matchMedia("(min-width: 768px)"), "change").length, 0);
});

test("interacting with default Home retains setup across tablet and compact widths until Close resets it", async (t) => {
    const f = await fixture(t, { page: true, defaultPage: true, initialWidth: 820 });

    assert.equal(
        store.state.homeCreation,
        null,
        "this is the default Home, not an explicit creation intent",
    );
    assert.equal(f.selected("Beta"), "false");
    await f.click("Local");
    await f.fire(
        f.one(
            (node) => node.matches(".home-project-choice") && node.textContent.includes("Beta"),
            "Beta",
        ),
        "click",
    );
    await f.click("Other ways to start");
    await f.click("New Work Item");
    const retainedHome = f.home();
    const shell = retainedHome.closest(".sheet");
    const panel = () =>
        f.one(
            (node) =>
                node.tag === "native-session-panel" && node.attributes["data-project"] === "beta",
            "Beta's native Work Item panel",
        );
    const retainedPanel = panel();
    const intent = store.state.homeCreation;

    assert.ok(shell);
    assert.ok(intent, "real interactions make the default setup resumable");

    for (const next of [767, 768, 820, 1180, 540]) {
        await f.perform(() => resize(next));
        const compact = next < 768;

        assert.equal(matchMedia("(pointer: coarse)").matches, true);
        assert.equal(f.selected("Beta"), "true");
        assert.equal(f.disclosure().attributes["aria-expanded"], "true");
        assert.equal(f.home(), retainedHome, `${next}px retains an interacted default form`);
        assert.equal(retainedHome.matches(".home-creation-compact"), compact);
        assert.equal(retainedHome.matches(".home-creation-embedded"), compact);
        assert.equal(panel(), retainedPanel);
        assert.equal(shell.attributes.role, compact ? "dialog" : undefined);
        assert.equal(shell.attributes["aria-modal"], compact ? "true" : undefined);
        assert.equal(shell.matches(".bottom-sheet"), compact);
        assert.equal(f.hidden(retainedHome), false, "narrowing cannot strand an interacted setup");
        assert.equal(f.all().filter((node) => node.matches(".home-creation-sheet")).length, 1);
        assert.equal(store.state.homeCreation, intent);
        assert.equal(store.state.sheet, null);
    }

    await f.perform(() => openSheet({ type: "new-session" }));
    assert.equal(store.state.sheet, null, "New Session resumes the interacted compact default");
    assert.equal(store.state.homeCreation, intent);
    assert.equal(f.home(), retainedHome);
    assert.equal(panel(), retainedPanel);
    await f.fire(
        f.one(
            (node) =>
                node.tag === "button" &&
                node.attributes["aria-label"] === "Close" &&
                node.closest(".sheet") === shell,
            "native Close header control",
        ),
        "click",
    );
    assert.equal(
        store.state.homeCreation,
        null,
        "the native header close must not reengage the default through bubbling",
    );
    assert.equal(
        f.all().filter((node) => node.attributes["aria-modal"] === "true" && !f.hidden(node))
            .length,
        0,
        "Close leaves no stranded modal",
    );
    await f.perform(() => resize(820));
    assert.notEqual(f.home(), retainedHome, "Close resets the engaged default generation");
    assert.equal(retainedPanel.isConnected, false);
    assert.equal(
        f.selected("Beta"),
        "false",
        "a later default generation does not inherit unfinished choices",
    );
    assert.equal(f.button("All").attributes["aria-pressed"], "true");
    await f.fire(
        f.one(
            (node) => node.matches(".home-project-choice") && node.textContent.includes("Beta"),
            "Beta",
        ),
        "click",
    );
    assert.ok(f.button("Other ways to start"), "the new default's work settings start collapsed");
    assert.ok(store.state.homeCreation);
    assert.notEqual(
        store.state.homeCreation,
        intent,
        "a new interaction starts a distinct default generation",
    );
    assert.equal(store.state.sheet, null);
    assert.equal(store.state.agentDraft, null);
    assert.deepEqual(requests, [], "interaction and presentation changes create no session");
    await f.unmount();
    assert.equal(getEventListeners(visualViewport, "resize").length, 0);
    assert.equal(getEventListeners(visualViewport, "scroll").length, 0);
    assert.equal(getEventListeners(matchMedia("(min-width: 768px)"), "change").length, 0);
});
