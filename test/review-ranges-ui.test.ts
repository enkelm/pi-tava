// Range placement is owned by the production Changes/review components. A changed interior
// line, omitted context, or old/new numbering mix-up must make a captured range outdated.
// Existing socket UI tests cover human single-line input, but cannot run in this environment.
// This fixture replaces only hooks, browser scheduling and reads; it adds no production exports.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, test, type TestContext } from "node:test";
import { h } from "preact";

const htm = (await import(import.meta.resolve("htm"))).default;

type Props = Record<string, any>;
type Node = { type: string | ((props: Props) => unknown); props: Props; key?: string };
type Slot = { value?: any; current?: any; deps?: unknown[]; cleanup?: () => void };
type Mount = { slots: Slot[] };
let current: Mount;
let cursor = 0;
let effects: (() => void)[] = [];

let redraw = () => {};

let requestNumber = 0;

const hooks = {
    useState(initial: unknown) {
        const slot = (current.slots[cursor++] ??= {
            value: typeof initial === "function" ? initial() : initial,
        });

        return [
            slot.value,
            (next: unknown) => {
                const value = typeof next === "function" ? next(slot.value) : next;

                if (!Object.is(slot.value, value)) {
                    slot.value = value;
                    redraw();
                }
            },
        ];
    },
    useRef(value: unknown) {
        return (current.slots[cursor++] ??= { current: value });
    },
    useId() {
        return `field-${cursor++}`;
    },
    useMemo(make: () => unknown, deps: unknown[]) {
        const index = cursor++;
        const previous = current.slots[index];

        if (!previous || deps.some((value, at) => !Object.is(value, previous.deps?.[at]))) {
            current.slots[index] = { deps, value: make() };
        }

        return current.slots[index]!.value;
    },
    useEffect(effect: () => (() => void) | undefined, deps: unknown[]) {
        const slot = cursor++;
        const previous = current.slots[slot];

        if (!previous || deps.some((value, index) => !Object.is(value, previous.deps?.[index]))) {
            const next: Slot = { deps };

            current.slots[slot] = next;
            effects.push(() => {
                previous?.cleanup?.();
                next.cleanup = effect();
            });
        }
    },
};
const fixture = {
    hooks,
    html: htm.bind((type: any, props: any, ...children: any[]) => {
        if (type === "table" && props.class?.startsWith("dv-table")) {
            fixture.work.tables++;
        }

        return h(type, props, ...children);
    }),
    work: { tables: 0, highlights: 0 },
    highlightLines(lines: string[]) {
        fixture.work.highlights++;

        return lines;
    },
    store: {
        state: {} as Props,
        set(patch: Props) {
            Object.assign(this.state, patch);
            redraw();
        },
        subscribe: () => () => {},
    },
    actions: {} as Props,
    uid: () => `request-${++requestNumber}`,
    api: async (): Promise<Props> => ({}),
    mutations: new Set<() => void>(),
    point: null as any,
    notices: [] as string[],
};
const descriptors = new Map<string, PropertyDescriptor | undefined>();
const windowEvents = new EventTarget();

for (const [name, value] of Object.entries({
    reviewRangesUiFixture: fixture,
    document: Object.assign(new EventTarget(), {
        hidden: false,
        elementFromPoint: () => fixture.point,
    }),
    navigator: { onLine: true },
    localStorage: { getItem: () => null, setItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    addEventListener: windowEvents.addEventListener.bind(windowEvents),
    removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
    matchMedia: () => ({ matches: false }),
    CSS: { escape: (value: string) => value },
    ResizeObserver: class {
        observe() {}
        disconnect() {}
    },
    IntersectionObserver: class {
        constructor(privateCallback: (entries: Props[]) => void) {
            this.callback = privateCallback;
        }
        callback: (entries: Props[]) => void;
        observe() {
            this.callback([{ isIntersecting: true }]);
        }
        disconnect() {}
    },
    MutationObserver: class {
        constructor(callback: () => void) {
            this.callback = callback;
        }
        callback: () => void;
        observe() {
            fixture.mutations.add(this.callback);
        }
        disconnect() {
            fixture.mutations.delete(this.callback);
        }
    },
    requestAnimationFrame: (callback: () => void) => {
        const frame = { cancelled: false };

        queueMicrotask(() => !frame.cancelled && callback());

        return frame;
    },
    cancelAnimationFrame: (frame: { cancelled: boolean } | number) => {
        if (typeof frame === "object") {
            frame.cancelled = true;
        }
    },
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
    "preact/hooks": `export const {useState,useRef,useId,useEffect,useMemo}=globalThis.reviewRangesUiFixture.hooks;
        export const useLayoutEffect=useEffect;`,
    "./store.js": `export const {store,actions}=globalThis.reviewRangesUiFixture;
        export const api=(...args)=>globalThis.reviewRangesUiFixture.api(...args);
        export const {uid}=globalThis.reviewRangesUiFixture;
        export const canSteer=()=>true,collab=()=>false;
        export const notify=(_kind,text)=>globalThis.reviewRangesUiFixture.notices.push(text);
        export const openSheet=()=>{},attempt=()=>{};`,
    "./ui.js": `export const {html}=globalThis.reviewRangesUiFixture;
        export const Icon=()=>null,Loader=()=>null,openFile=()=>{},shortPath=value=>value;`,
    "./back.js": "export const useBack=()=>{};",
    "./chat.js": "export const jumpToEntry=()=>{};",
    "./highlight.js": `export const {highlightLines}=globalThis.reviewRangesUiFixture;
        export const highlight=text=>text,langOf=()=>"text";`,
    "./sheets/branch.js": "export const branchAvailable=()=>false;",
    "./avatar.js": "export const Avatar=()=>null;",
};

registerHooks({
    resolve(specifier, context, next) {
        const parent = context.parentURL && new URL(context.parentURL).pathname;
        const source =
            parent && /\/web\/(diff|reviews|pip-mentions|mention-composer)\.js$/.test(parent)
                ? sources[specifier]
                : undefined;

        return source === undefined
            ? next(specifier, context)
            : { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    },
});
const { DiffReview } = await import(new URL("../web/diff.js", import.meta.url).href);

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
          ? (value.props.dangerouslySetInnerHTML?.__html ?? textOf(value.props.children))
          : "";
}

const flush = async () => {
    for (let turn = 0; turn < 40; turn++) {
        await Promise.resolve();
    }
};

let conversation = 0;

async function setup(
    t: TestContext,
    {
        diff,
        text,
        threads,
        contextError = false,
        failComments = false,
        delayedReviews = false,
        domWidth = null,
    }: {
        diff: string;
        text: string;
        threads: Props[];
        contextError?: boolean;
        failComments?: boolean;
        delayedReviews?: boolean;
        domWidth?: number | null;
    },
) {
    const id = ++conversation;
    const mounts = new Map<string, Mount>();
    const contextReads: string[] = [];
    const submissions: string[] = [];
    const comments: Props[] = [];
    const scrolled: string[] = [];
    const focused: string[] = [];
    let tree: unknown;
    let live = true;
    let scheduled = false;
    let active = true;

    fixture.work = { tables: 0, highlights: 0 };
    fixture.store.state = {
        conversationId: id,
        me: { id: "owner", role: "owner" },
        users: [],
        server: { localReviews: 2 },
        view: {
            agent: { cwd: "/project" },
            order: [],
            live: {},
            reviews: { threads: delayedReviews ? [] : threads },
        },
        reviewTarget: { conversationId: id, threadId: threads[0]!.id, n: 1 },
    };
    fixture.api = async () => ({
        repo: { root: "/project", branch: "main" },
        files: [{ path: "file.txt", kind: "modified", added: 1, removed: 1, version: String(id) }],
    });
    Object.assign(fixture.actions, {
        reviewDiff: async () => ({ diff }),
        reviewContext: async (_id: number, path: string) => {
            contextReads.push(path);

            if (contextError) {
                throw new Error("Context unavailable");
            }

            return { text };
        },
        submit: async (text: string) => submissions.push(text),
        reviewComment: async (payload: Props) => {
            comments.push(payload);

            if (failComments) {
                throw new Error("Response lost");
            }

            return {};
        },
    });

    // Only the DOM/scheduling seam is substituted. Queries look up the actual rendered tree;
    // they never supply a discussion or readiness state that the production component omitted.
    const hasClass = (node: Node, name: string) =>
        String(node.props.class ?? "")
            .split(" ")
            .includes(name);
    const element = (node: Node): any => ({
        node,
        clientWidth: domWidth,
        style: { setProperty() {} },
        dataset: Object.fromEntries(
            Object.entries(node.props)
                .filter(([key]) => key.startsWith("data-"))
                .map(([key, value]) => [
                    key.slice(5).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase()),
                    value,
                ]),
        ),
        classList: { contains: (name: string) => hasClass(node, name) },
        contains: (child: any) => nodes(node).includes(child?.node),
        getBoundingClientRect: () => ({ height: 20 }),
        scrollIntoView: () => scrolled.push(node.props.id),
        focus: () => focused.push(node.props.id),
        closest(selector: string) {
            if (selector === ".dv-comment-line" && hasClass(node, "dv-comment-line")) {
                return this;
            }

            const parent = nodes(tree).find(
                (candidate) =>
                    hasClass(candidate, selector.slice(1)) && nodes(candidate).includes(node),
            );

            return parent ? element(parent) : null;
        },
        querySelector(selector: string) {
            const found = nodes(node).find((child) =>
                selector.startsWith("#")
                    ? child.props.id === selector.slice(1)
                    : selector.includes("textarea")
                      ? child.type === "textarea"
                      : selector.includes("rv-form")
                        ? child.type === "form" && hasClass(child, "rv-form")
                        : hasClass(child, selector.slice(1)),
            );

            return found ? element(found) : null;
        },
    });
    const refElements = new Map<string, any>();

    const expand = (value: any, path = "root"): any => {
        if (Array.isArray(value)) {
            return value.map((child, index) => expand(child, `${path}/${child?.key ?? index}`));
        }

        if (!value?.props) {
            return value;
        }

        if (typeof value.type === "function") {
            const key = `${path}:${value.type.name}:${value.key ?? ""}`;

            current = mounts.get(key) ?? { slots: [] };
            mounts.set(key, current);
            cursor = 0;

            return expand(value.type(value.props), `${key}/render`);
        }

        const expanded = {
            ...value,
            props: { ...value.props, children: expand(value.props.children, `${path}/children`) },
        };
        const ref = value.ref ?? value.props.ref;

        if (domWidth !== null && ref && typeof ref === "object") {
            const host = refElements.get(path) ?? {};

            Object.assign(host, element(expanded));
            refElements.set(path, host);
            ref.current = host;
        }

        return expanded;
    };

    const render = () => {
        if (!live) {
            return;
        }

        tree = expand(h(DiffReview, { active }));
        const pending = effects;

        effects = [];

        for (const effect of pending) {
            effect();
        }

        for (const changed of fixture.mutations) {
            changed();
        }
    };

    redraw = () => {
        if (!scheduled && live) {
            scheduled = true;
            queueMicrotask(() => {
                scheduled = false;
                render();
            });
        }
    };

    t.after(() => {
        live = false;

        for (const mount of mounts.values()) {
            for (const slot of mount.slots) {
                slot?.cleanup?.();
            }
        }
    });
    render();
    await flush();

    return {
        contextReads,
        submissions,
        comments,
        scrolled,
        focused,
        async deliverReviews(next = threads) {
            fixture.store.state.view.reviews = { threads: next };
            redraw();
            await flush();
        },
        async setActive(next: boolean) {
            active = next;
            redraw();
            await flush();
        },
        async navigate(threadId: string) {
            fixture.store.set({
                reviewTarget: {
                    conversationId: id,
                    threadId,
                    n: fixture.store.state.reviewTarget.n + 1,
                },
            });
            await flush();
        },
        async unrelatedUpdate() {
            fixture.store.set({ unrelated: (fixture.store.state.unrelated ?? 0) + 1 });
            await flush();
        },
        async comment(side: string, line: number, extra: Props = {}) {
            const button = nodes(tree).find(
                (node) => node.props["aria-label"] === `Comment on ${side} line ${line}`,
            );

            assert.ok(button);
            button.props.onClick({ detail: 1, pointerType: "mouse", ...extra });
            await flush();
        },
        async gutter(side: string, line: number, handler: string, extra: Props = {}) {
            const button = nodes(tree).find(
                (node) => node.props["aria-label"] === `Comment on ${side} line ${line}`,
            );
            let prevented = false;

            assert.ok(
                button?.props[handler],
                `${handler} is installed on the actual gutter button`,
            );
            button.props[handler]({
                button: 0,
                pointerId: 7,
                pointerType: "mouse",
                preventDefault: () => {
                    prevented = true;
                },
                ...extra,
            });
            await flush();

            return prevented;
        },
        async touch(side: string, line: number, handler: string, extra: Props = {}) {
            const find = (wantedSide: string, wantedLine: number) =>
                nodes(tree).find(
                    (node) =>
                        node.props["aria-label"] === `Comment on ${wantedSide} line ${wantedLine}`,
                );
            const button = find(side, line);
            const hit = find(extra.atSide ?? side, extra.atLine ?? line);
            const contact = {
                identifier: 7,
                clientX: 20,
                clientY: (extra.atLine ?? line) * 24,
                ...extra.contact,
            };
            let prevented = false;

            assert.ok(button?.props[handler], `${handler} is installed on the real gutter`);
            fixture.point = hit ? element(hit) : null;
            button.props[handler]({
                type: handler.slice(2).toLowerCase(),
                // TouchList promises indexed access/length, not Array methods or iteration.
                changedTouches: { 0: contact, length: 1 },
                touches:
                    handler === "onTouchEnd" || handler === "onTouchCancel"
                        ? { length: 0 }
                        : { 0: contact, length: 1 },
                cancelable: true,
                currentTarget: element(button),
                preventDefault: () => {
                    prevented = true;
                },
                ...extra.event,
            });
            await flush();

            return prevented;
        },
        async blur() {
            windowEvents.dispatchEvent(new Event("blur"));
            await flush();
        },
        async releaseOutside() {
            document.dispatchEvent(Object.assign(new Event("pointerup"), { pointerId: 7 }));
            await flush();
        },
        async input(label: "Comment", value: string) {
            const fieldLabel = nodes(tree).find(
                (node) => node.type === "label" && textOf(node).startsWith("Comment on "),
            );

            assert.ok(fieldLabel, `${label} control is discoverable and labeled`);
            const field = nodes(tree).find((node) => node.props.id === fieldLabel.props.for);

            assert.ok(field);
            field.props.onInput({ currentTarget: { value } });
            await flush();
        },
        async post() {
            const form = nodes(tree).find(
                (node) => node.type === "form" && node.props.class === "rv-form",
            );

            assert.ok(form);
            form.props.onSubmit({ preventDefault() {} });
            await flush();
        },
        nodes: () => nodes(tree),
        text: () => textOf(tree),
        reviewed(side: string) {
            return nodes(tree)
                .filter(
                    (node) =>
                        node.type === "td" &&
                        String(node.props.class).split(" ").includes("dv-reviewed") &&
                        nodes(node).some((child) =>
                            child.props["aria-label"]?.startsWith(`Comment on ${side} line `),
                        ),
                )
                .map((node) => nodes(node).find((child) => child.props["data-n"])!.props["data-n"]);
        },
        async layout(label: string) {
            const button = nodes(tree).find(
                (node) => node.type === "button" && textOf(node) === label,
            );

            assert.ok(button);
            button.props.onClick();
            await flush();
        },
        placement(threadId: string) {
            const article = nodes(tree).find(
                (node) => node.props.id === `review-thread-${threadId}`,
            );

            assert.ok(article, "original discussion remains present and addressable");
            const annotation = nodes(tree).find(
                (node) => node.type === "tr" && nodes(node).includes(article),
            );

            if (!annotation) {
                return null;
            }

            const siblings = nodes(tree)
                .find((node) => node.type === "tbody" && nodes(node).includes(annotation))!
                .props.children.flat(Infinity)
                .filter(Boolean) as Node[];
            const before = siblings[siblings.indexOf(annotation) - 1];
            const captured = fixture.store.state.view.reviews.threads.find(
                (thread: Props) => thread.id === threadId,
            )!;

            assert.ok(
                nodes(before).some(
                    (node) =>
                        node.props["aria-label"] ===
                        `Comment on ${captured.side} line ${captured.line}`,
                ),
                "the annotation directly follows its original end line",
            );

            return textOf(before);
        },
    };
}

const thread = (extra: Props = {}): Props => ({
    id: "finding",
    userId: "pip",
    name: "PiP",
    cwd: "/project",
    path: "file.txt",
    side: "new",
    startLine: 2,
    line: 4,
    context: "first\ninterior\nlast",
    text: "Check this entire range.",
    resolved: false,
    replies: [],
    ...extra,
});

test("review discussion shows delegated authors and the latest resolve or reopen actor", async (t) => {
    const onBehalfOf = { id: "owner", name: "Work owner" };
    const actor = { userId: "pip", name: "PiP", service: "pip", onBehalfOf, at: 1 };
    const original = thread({
        userId: "reviewer",
        name: "Reviewer",
        resolved: true,
        resolution: actor,
        replies: [{ ...actor, id: "private-reply", text: "Keep the observed failure evidence." }],
    });
    const app = await setup(t, {
        diff: visibleDiff(),
        text: "",
        threads: [original],
        domWidth: 390,
    });

    assert.match(app.text(), /PiP for Work owner/);
    assert.match(app.text(), /Resolved by PiP for Work owner/);
    await app.deliverReviews([{ ...original, resolved: false }]);
    assert.match(app.text(), /Reopened by PiP for Work owner/);
    await app.deliverReviews([
        { ...original, resolution: { userId: "owner", name: "Work owner", at: 2 } },
    ]);
    assert.doesNotMatch(
        app.text(),
        /Resolved by PiP|Reopened by PiP/,
        "a later human resolution must not inherit PiP attribution",
    );
    assert.match(app.text(), /PiP for Work owner/, "the original delegated reply keeps its author");
});

test("exact review navigation waits for delayed reviews after Changes and diffs are ready", async (t) => {
    for (const delayedReviews of [false, true]) {
        await t.test(
            delayedReviews ? "delayed review projection" : "initial review projection",
            async (t) => {
                const app = await setup(t, {
                    diff: visibleDiff(),
                    text: "",
                    threads: [thread()],
                    delayedReviews,
                    domWidth: 390,
                });

                if (delayedReviews) {
                    assert.deepEqual(
                        app.scrolled,
                        [],
                        "no guessed destination before source discussion arrives",
                    );
                    await app.deliverReviews();
                }

                assert.deepEqual(app.scrolled, ["review-thread-finding"]);
                assert.deepEqual(app.focused.filter(Boolean), ["review-thread-finding"]);
                assert.equal(
                    fixture.mutations.size,
                    0,
                    "the reveal observer is retired after the exact scroll",
                );
            },
        );
    }
});

test("a superseded delayed reveal never scrolls the wrong discussion, including outdated context", async (t) => {
    const app = await setup(t, {
        diff: visibleDiff(),
        text: "",
        threads: [thread(), thread({ id: "outdated", context: "previous\ninterior\nlast" })],
        delayedReviews: true,
        domWidth: 1024,
    });

    await app.navigate("outdated");
    await app.setActive(false);
    await app.deliverReviews();
    assert.deepEqual(
        app.scrolled,
        [],
        "inactive panels do not reveal or install a lasting observer",
    );
    assert.equal(fixture.mutations.size, 0);
    await app.setActive(true);
    assert.deepEqual(app.scrolled, ["review-thread-outdated"]);
    assert.deepEqual(app.focused.filter(Boolean), ["review-thread-outdated"]);
    assert.equal(app.placement("outdated"), null);
    assert.equal(fixture.mutations.size, 0);
});

const visibleDiff = (interior = "interior", first = "first", last = "last") =>
    `diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1,5 +1,5 @@\n header\n ${first}\n-${interior}\n+${interior}\n ${last}\n footer\n`;

test("inclusive ranges attach only when every captured hunk line still matches", async (t) => {
    for (const side of ["old", "new"]) {
        await t.test(side, async (t) => {
            const app = await setup(t, {
                diff: visibleDiff(),
                text: "",
                threads: [thread({ side })],
            });

            for (const layout of ["Unified", "Split"]) {
                await app.layout(layout);
                assert.match(app.placement("finding")!, /last/);
                assert.deepEqual(
                    app.reviewed(side),
                    [2, 3, 4],
                    "the stored comment highlights its complete inclusive range, without composing",
                );
            }

            assert.equal(app.contextReads.length, 0, "visible ranges need no full-file read");
            assert.ok(app.text().includes(`file.txt · ${side} lines 2–4`));
        });
    }

    await t.test("changed interior with unchanged end", async (t) => {
        const app = await setup(t, {
            diff: visibleDiff("changed"),
            text: "",
            threads: [thread()],
        });

        assert.equal(
            app.placement("finding"),
            null,
            "an unchanged last line is not sufficient evidence",
        );
        assert.match(app.text(), /Earlier context/);
        assert.match(app.text(), /first\ninterior\nlast/);
        assert.deepEqual(app.reviewed("new"), [], "outdated ranges never highlight new code");
    });

    await t.test("range claims missing preceding lines", async (t) => {
        const app = await setup(t, {
            diff: visibleDiff(),
            text: "",
            threads: [thread({ context: "last" })],
        });

        assert.equal(app.placement("finding"), null, "an end-only excerpt cannot validate a range");
    });
});

function omittedFixture() {
    const original = Array.from({ length: 40 }, (_, index) => `original ${index + 1}`);
    const current = [...original];

    current.splice(2, 0, "insert A", "insert B");
    current[21] = "replacement 20";

    return {
        original,
        current,
        diff: `diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1,5 +1,7 @@\n original 1\n original 2\n+insert A\n+insert B\n original 3\n original 4\n original 5\n@@ -17,7 +19,7 @@\n original 17\n original 18\n original 19\n-original 20\n+replacement 20\n original 21\n original 22\n original 23\n`,
    };
}

test("unrelated room updates do not rebuild diff tables or recolor visible range context", async (t) => {
    const { original, current, diff } = omittedFixture();
    const captured = thread({
        side: "old",
        startLine: 15,
        line: 16,
        context: original.slice(14, 16).join("\n"),
    });
    const app = await setup(t, { diff, text: current.join("\n"), threads: [captured] });
    const before = { ...fixture.work };

    assert.ok(before.tables > 0 && before.highlights > 0);
    assert.ok(app.placement("finding"), "the measurement includes visible omitted context");

    for (let update = 0; update < 100; update++) {
        await app.unrelatedUpdate();
    }

    assert.deepEqual(fixture.work, before, "unchanged review content reuses its table and colors");
    await app.deliverReviews([
        captured,
        thread({
            id: "second",
            side: "old",
            startLine: 17,
            line: 18,
            context: original.slice(16, 18).join("\n"),
        }),
    ]);
    assert.ok(fixture.work.tables > before.tables, "a real new discussion still redraws");
    assert.ok(app.placement("second"));
    const beforePermissions = fixture.work.tables;

    fixture.store.set({ me: { id: "reader", role: "viewer" } });
    await flush();
    assert.ok(
        fixture.work.tables > beforePermissions,
        "permission changes invalidate cached discussion controls",
    );
    assert.equal(
        app.nodes().some((node) => node.props["aria-label"] === "Resolve comment"),
        false,
    );
});

test("ranges fetch omitted interior lines and apply old-side gap mapping before placing their end", async (t) => {
    for (const side of ["old", "new"]) {
        await t.test(side, async (t) => {
            const { original, current, diff } = omittedFixture();
            const lines = side === "old" ? original : current;
            const startLine = side === "old" ? 15 : 17;
            const line = side === "old" ? 20 : 22;
            const app = await setup(t, {
                diff,
                text: current.join("\n") + "\n",
                threads: [
                    thread({
                        side,
                        startLine,
                        line,
                        context: lines.slice(startLine - 1, line).join("\n"),
                    }),
                ],
            });

            assert.deepEqual(
                app.contextReads,
                ["file.txt"],
                "missing start lines trigger the existing full-file reader",
            );
            assert.match(
                app.placement("finding")!,
                side === "old" ? /original 20/ : /replacement 20/,
            );
            assert.deepEqual(
                app.reviewed(side),
                Array.from({ length: line - startLine + 1 }, (_, index) => startLine + index),
                "omitted range lines are also revealed and highlighted",
            );
        });
    }

    await t.test("changed omitted interior", async (t) => {
        const { original, current, diff } = omittedFixture();

        current[17] = "changed omitted line";
        const app = await setup(t, {
            diff,
            text: current.join("\n"),
            threads: [
                thread({
                    side: "old",
                    startLine: 15,
                    line: 20,
                    context: original.slice(14, 20).join("\n"),
                }),
            ],
        });

        assert.deepEqual(app.contextReads, ["file.txt"]);
        assert.equal(app.placement("finding"), null);
        assert.match(app.text(), /Earlier context/);
    });

    await t.test("end also omitted", async (t) => {
        const { original, current, diff } = omittedFixture();
        const app = await setup(t, {
            diff,
            text: current.join("\n"),
            threads: [
                thread({
                    side: "old",
                    startLine: 15,
                    line: 16,
                    context: original.slice(14, 16).join("\n"),
                }),
            ],
        });

        assert.match(app.placement("finding")!, /original 16/);
    });

    await t.test("unavailable complete context", async (t) => {
        const { original, current, diff } = omittedFixture();
        const app = await setup(t, {
            diff,
            text: current.join("\n"),
            contextError: true,
            threads: [
                thread({
                    side: "old",
                    startLine: 15,
                    line: 20,
                    context: original.slice(14, 20).join("\n"),
                }),
            ],
        });

        assert.equal(app.placement("finding"), null);
        assert.match(app.text(), /Earlier context/);
    });
});

test("range evidence is complete while legacy single-line evidence keeps its 1000-character contract", async (t) => {
    const long = "x".repeat(1500);

    for (const [name, captured, expectedInline] of [
        ["complete range", thread({ context: `${long}\ninterior\nlast` }), true],
        ["truncated range", thread({ context: `${long.slice(0, 1000)}\ninterior\nlast` }), false],
        [
            "range differs after 1000 characters",
            thread({ context: `${long.slice(0, -1)}y\ninterior\nlast` }),
            false,
        ],
        [
            "legacy single",
            thread({ startLine: undefined, line: 2, context: long.slice(0, 1000) }),
            true,
        ],
        ["explicit single range", thread({ startLine: 2, line: 2, context: long }), true],
        [
            "truncated explicit single range",
            thread({ startLine: 2, line: 2, context: long.slice(0, 1000) }),
            false,
        ],
    ] as const) {
        await t.test(name, async (t) => {
            const app = await setup(t, {
                diff: visibleDiff("interior", long),
                text: "",
                threads: [captured],
            });

            assert.equal(app.placement("finding") !== null, expectedInline);
        });
    }
});

test("review index, captured discussion and feedback prompt keep inclusive range locations", async (t) => {
    const captured = thread();
    const app = await setup(t, { diff: visibleDiff("changed"), text: "", threads: [captured] });
    const location = "file.txt · new lines 2–4";
    const jump = app
        .nodes()
        .find(
            (node) =>
                node.type === "button" && node.props["aria-label"]?.startsWith("Go to comment"),
        );

    assert.ok(jump);
    assert.ok(jump.props["aria-label"].includes(location));
    assert.ok(textOf(jump).includes(location));
    const article = app.nodes().find((node) => node.props.id === "review-thread-finding");

    assert.ok(article);
    assert.ok(textOf(article).includes(location));
    const send = app.nodes().find((node) => node.props["aria-label"] === "Send all reviews to Pi");

    assert.ok(send);
    send.props.onClick();
    await flush();
    assert.equal(app.submissions.length, 1);
    assert.ok(app.submissions[0]!.includes(`[Unresolved] ${location}`));
    assert.ok(app.submissions[0]!.includes("> first\n> interior\n> last"));
});

// These tests cross the human production composer, not the evidence helper: removing
// the range controls, truncating payloads, or reusing an end-only retry identity fails here.
test("gutter Shift-click selects inclusive old/new ranges and highlights their rows without numeric fields", async (t) => {
    for (const side of ["old", "new"]) {
        await t.test(side, async (t) => {
            const app = await setup(t, { diff: visibleDiff(), text: "", threads: [thread()] });

            await app.layout("Unified");
            await app.comment(side, 4);
            await app.input("Comment", "Keep this draft");
            await app.comment(side, 2, { shiftKey: true });
            assert.equal(
                app.nodes().some((node) => node.props.type === "number"),
                false,
            );
            await app.layout("Split");
            const selected = app
                .nodes()
                .filter(
                    (node) =>
                        node.props["aria-pressed"] === true &&
                        node.props["aria-label"]?.startsWith(`Comment on ${side} line `),
                );

            assert.deepEqual(
                selected.map((node) => node.props["data-n"]),
                [2, 3, 4],
            );
            assert.ok(
                app
                    .nodes()
                    .some(
                        (node) =>
                            node.type === "td" &&
                            String(node.props.class).includes("dv-code") &&
                            String(node.props.class).includes("dv-selected"),
                    ),
            );
            await app.post();
            assert.equal(app.comments[0]!.text, "Keep this draft");
            assert.equal(app.comments[0]!.startLine, 2);
            assert.equal(app.comments[0]!.line, 4);
            assert.equal(app.comments[0]!.side, side);
            assert.equal(app.comments[0]!.context, "first\ninterior\nlast");
        });
    }
});

test("gutter dragging previews and normalizes inclusive endpoints, including release outside the gutter", async (t) => {
    for (const side of ["old", "new"]) {
        await t.test(side, async (t) => {
            const app = await setup(t, { diff: visibleDiff(), text: "", threads: [thread()] });

            assert.equal(await app.gutter(side, 4, "onPointerDown"), true);
            await app.gutter(side, 2, "onPointerEnter", { pointerId: 8 });
            await app.gutter(side, 2, "onPointerUp", { pointerId: 8 });
            assert.deepEqual(
                app
                    .nodes()
                    .filter((node) => node.props["aria-pressed"] === true)
                    .map((node) => node.props["data-n"]),
                [4],
                "another pointer cannot move or settle this drag",
            );
            await app.gutter(side, 2, "onPointerEnter");
            assert.deepEqual(
                app
                    .nodes()
                    .filter((node) => node.props["aria-pressed"] === true)
                    .map((node) => node.props["data-n"]),
                [2, 3, 4],
            );
            assert.equal(
                app.nodes().some((node) => node.type === "form"),
                false,
                "preview does not insert a composer into the drag path",
            );
            await app.gutter(side === "old" ? "new" : "old", 1, "onPointerEnter");
            await app.releaseOutside();
            await app.comment(side, 2);
            await app.input("Comment", "Dragged range");
            await app.post();
            assert.equal(app.comments[0]!.startLine, 2);
            assert.equal(app.comments[0]!.line, 4);
            assert.equal(app.comments[0]!.side, side);
            assert.equal(app.comments[0]!.context, "first\ninterior\nlast");
        });
    }
});

test("touch hold and drag selects inclusive ranges on narrow and wide touch layouts", async (t) => {
    for (const [domWidth, side] of [
        [390, "new"],
        [1024, "old"],
    ] as const) {
        await t.test(`${domWidth}px ${side}`, async (t) => {
            const app = await setup(t, {
                diff: visibleDiff(),
                text: "",
                threads: [thread()],
                domWidth,
            });

            t.mock.timers.enable({ apis: ["setTimeout"] });
            assert.equal(
                await app.touch(side, 4, "onTouchStart"),
                false,
                "initial contact keeps native scrolling",
            );
            t.mock.timers.tick(450);
            await flush();
            assert.equal(await app.touch(side, 4, "onTouchMove", { atLine: 2 }), true);
            assert.deepEqual(
                app
                    .nodes()
                    .filter((node) => node.props["aria-pressed"] === true)
                    .map((node) => node.props["data-n"]),
                [2, 3, 4],
            );
            assert.equal(
                app.nodes().some((node) => node.type === "form"),
                false,
                "a hold preview does not move the drag path",
            );
            await app.touch(side, 4, "onTouchEnd", { atLine: 2 });
            await app.comment(side, 2, { pointerType: "touch" });
            await app.input("Comment", "Held range");
            await app.post();
            assert.equal(app.comments[0]!.side, side);
            assert.equal(app.comments[0]!.startLine, 2);
            assert.equal(app.comments[0]!.line, 4);
            assert.equal(app.comments[0]!.context, "first\ninterior\nlast");
        });
    }
});

test("held gutter selection bounds previews to 100 inclusive lines", async (t) => {
    const lines = Array.from({ length: 101 }, (_, at) => `line ${at + 1}`);
    const diff = `diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1,101 +1,101 @@\n${lines.map((line) => ` ${line}\n`).join("")}`;
    const app = await setup(t, { diff, text: "", threads: [thread()], domWidth: 390 });

    t.mock.timers.enable({ apis: ["setTimeout"] });
    await app.touch("new", 1, "onTouchStart");
    t.mock.timers.tick(450);
    await flush();
    await app.touch("new", 1, "onTouchMove", { atLine: 101 });
    const selected = app.nodes().filter((node) => node.props["aria-pressed"] === true);

    assert.equal(selected.length, 100);
    assert.equal(selected.at(-1)!.props["data-n"], 100);
    await app.touch("new", 1, "onTouchEnd", { atLine: 101 });
    await app.input("Comment", "Bounded hold");
    await app.post();
    assert.equal(app.comments[0]!.startLine, 1);
    assert.equal(app.comments[0]!.line, 100);
    assert.equal(app.comments[0]!.context, lines.slice(0, 100).join("\n"));
});

test("touch scroll, other contacts, cancellation and blur never commit a held range", async (t) => {
    const app = await setup(t, {
        diff: visibleDiff(),
        text: "",
        threads: [thread()],
        domWidth: 390,
    });

    t.mock.timers.enable({ apis: ["setTimeout"] });
    await app.touch("new", 4, "onTouchStart");
    assert.equal(
        await app.touch("new", 4, "onTouchMove", { atLine: 2 }),
        false,
        "moving before hold intent leaves native scrolling untouched",
    );
    t.mock.timers.tick(450);
    await app.touch("new", 4, "onTouchEnd", { atLine: 2 });
    await app.comment("new", 2, { pointerType: "touch" });
    assert.equal(
        app.nodes().some((node) => node.props["aria-pressed"] === true),
        false,
    );
    await app.touch("new", 4, "onTouchStart");
    await app.touch("new", 4, "onTouchEnd", { atLine: 2 });
    await app.comment("new", 2, { pointerType: "touch" });
    assert.equal(
        app.nodes().some((node) => node.type === "form"),
        false,
        "release-only scroll displacement also cancels the compatibility click",
    );

    for (const cancel of ["onTouchCancel", "blur", "multitouch", "uncancelable", "inactive"]) {
        await app.touch("new", 4, "onTouchStart");
        t.mock.timers.tick(450);
        await flush();
        await app.touch("new", 4, "onTouchEnd", { contact: { identifier: 8 } });
        assert.ok(
            app.nodes().some((node) => node.props["aria-pressed"] === true),
            "another finger's end cannot finish this selection",
        );
        await app.touch("new", 4, "onTouchMove", { atSide: "old", atLine: 2 });
        assert.deepEqual(
            app
                .nodes()
                .filter((node) => node.props["aria-pressed"] === true)
                .map((node) => node.props["data-n"]),
            [4],
            "cross-side hit testing does not move the endpoint",
        );

        if (cancel === "inactive") {
            await app.setActive(false);
            await app.setActive(true);
        } else if (cancel === "blur") {
            await app.blur();
        } else if (cancel === "multitouch") {
            document.dispatchEvent(
                Object.assign(new Event("touchstart"), {
                    touches: [{ identifier: 7 }, { identifier: 8 }],
                }),
            );
        } else if (cancel === "uncancelable") {
            assert.equal(
                await app.touch("new", 4, "onTouchMove", {
                    atLine: 2,
                    event: { cancelable: false },
                }),
                false,
            );
        } else {
            await app.touch("new", 4, cancel);
        }

        await app.touch("new", 4, "onTouchEnd");
        await app.comment("new", 4, { pointerType: "touch" });
        assert.equal(
            app.nodes().some((node) => node.type === "form"),
            false,
            `${cancel} also suppresses a compatibility click`,
        );
        assert.equal(
            app.nodes().some((node) => node.props["aria-pressed"] === true),
            false,
        );
    }

    assert.equal(app.comments.length, 0);
});

test("touch taps choose range endpoints without preventing native scrolling, and cancelled drags do not post", async (t) => {
    const app = await setup(t, { diff: visibleDiff(), text: "", threads: [thread()] });

    assert.equal(await app.gutter("new", 4, "onPointerDown", { pointerType: "touch" }), false);
    await app.comment("new", 4, { pointerType: "touch" });
    await app.input("Comment", "Touch range");
    assert.equal(await app.gutter("new", 2, "onPointerDown", { pointerType: "touch" }), false);
    await app.comment("new", 2, { pointerType: "touch" });
    await app.post();
    assert.equal(app.comments[0]!.startLine, 2);
    assert.equal(app.comments[0]!.line, 4);
    assert.equal(app.comments[0]!.text, "Touch range");

    await app.gutter("old", 1, "onPointerDown");
    await app.gutter("old", 3, "onPointerEnter");
    await app.gutter("old", 3, "onPointerCancel");
    await app.releaseOutside();
    assert.equal(
        app.nodes().some((node) => node.type === "form"),
        false,
    );
    assert.equal(
        app.nodes().some((node) => node.props["aria-pressed"] === true),
        false,
    );
    assert.equal(app.comments.length, 1);

    await app.gutter("old", 4, "onPointerDown");
    await app.gutter("old", 2, "onPointerEnter");
    await app.blur();
    await app.releaseOutside();
    assert.equal(
        app.nodes().some((node) => node.type === "form"),
        false,
    );
    assert.equal(
        app.nodes().some((node) => node.props["aria-pressed"] === true),
        false,
    );
});

test("humans select inclusive old/new ranges with complete context and keep legacy singles", async (t) => {
    const long = "x".repeat(1500);

    for (const side of ["old", "new"]) {
        await t.test(side, async (t) => {
            const app = await setup(t, {
                diff: visibleDiff("interior", long),
                text: "",
                threads: [thread()],
            });

            await app.comment(side, 4);
            await app.input("Comment", "Human range");
            await app.comment(side, 2, { shiftKey: true });
            const form = app.nodes().find((node) => node.type === "form");

            assert.ok(form);
            assert.equal(
                nodes(form).filter((node) => node.props.class === "rv-notice").length,
                0,
                "the composer contains no routine instructions or limit warnings",
            );
            assert.match(textOf(form), new RegExp(`Comment on file.txt · ${side} lines 2–4`));
            await app.post();
            assert.equal(app.comments.length, 1);
            assert.deepEqual(
                { ...app.comments[0], requestId: undefined },
                {
                    text: "Human range",
                    path: "file.txt",
                    side,
                    startLine: 2,
                    line: 4,
                    context: `${long}\ninterior\nlast`,
                    requestId: undefined,
                },
            );

            await app.comment(side, 2);
            await app.input("Comment", "Legacy single");
            await app.post();
            assert.equal(app.comments[1]!.context, "x".repeat(1000));
            assert.equal(Object.hasOwn(app.comments[1]!, "startLine"), false);
        });
    }
});

test("human range drafts survive closing and uncertain retries distinguish their start", async (t) => {
    const app = await setup(t, {
        diff: visibleDiff(),
        text: "",
        threads: [thread()],
        failComments: true,
    });

    await app.comment("new", 4);
    await app.input("Comment", "Keep my draft");
    await app.comment("new", 2, { shiftKey: true });
    await app.post();
    await app.post();
    assert.equal(app.comments[0]!.requestId, app.comments[1]!.requestId);

    const cancel = app.nodes().find((node) => node.props["aria-label"] === "Cancel");

    assert.ok(cancel);
    cancel.props.onClick();
    await flush();
    await app.comment("new", 4);
    const input = app.nodes().find((node) => node.type === "textarea");

    assert.equal(input?.props.value, "Keep my draft");
    assert.match(app.text(), /Comment on file.txt · new lines 2–4/);
    await app.comment("new", 3, { shiftKey: true });
    await app.post();
    assert.notEqual(app.comments[2]!.requestId, app.comments[0]!.requestId);
    assert.equal(app.comments[2]!.startLine, 3);
    assert.equal(app.comments[2]!.context, "interior\nlast");

    await app.comment("new", 4, { shiftKey: true });
    await app.post();
    assert.equal(Object.hasOwn(app.comments[3]!, "startLine"), false);
    assert.notEqual(app.comments[3]!.requestId, app.comments[2]!.requestId);
});

test("human ranges normalize CRLF across omitted interiors with old-side numbering", async (t) => {
    for (const side of ["old", "new"]) {
        await t.test(side, async (t) => {
            const { original, current, diff } = omittedFixture();
            const app = await setup(t, {
                diff: diff.replace(/\n/g, "\r\n"),
                text: current.join("\r\n") + "\r\n",
                threads: [thread()],
            });
            const end = side === "old" ? 20 : 22;
            const lines = side === "old" ? original : current;

            await app.comment(side, end);
            await app.comment(side, 4, { shiftKey: true });
            await app.input("Comment", "Across omitted lines");
            await app.post();
            assert.equal(app.comments.length, 1);
            assert.equal(app.comments[0]!.startLine, 4);
            assert.equal(app.comments[0]!.line, end);
            assert.equal(app.comments[0]!.side, side);
            assert.equal(app.comments[0]!.context, lines.slice(3, end).join("\n"));
            assert.deepEqual(app.contextReads, ["file.txt"]);
        });
    }
});

test("gutter ranges over 100 lines or without complete omitted evidence visibly block posting", async (t) => {
    const omitted = omittedFixture();
    const lines = Array.from({ length: 101 }, (_, at) => `line ${at + 1}`);
    const longDiff = `diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1,101 +1,101 @@\n${lines.map((line) => ` ${line}\n`).join("")}`;

    for (const [name, diff, start, end, expected] of [
        ["over 100", longDiff, 1, 101, /Choose a smaller range/],
        ["missing evidence", omitted.diff, 4, 22, /Complete range context is unavailable/],
    ] as const) {
        await t.test(name, async (t) => {
            const app = await setup(t, { diff, text: "", threads: [thread()], contextError: true });

            await app.comment("new", end);
            await app.comment("new", start, { shiftKey: true });
            await app.input("Comment", "Must not post");
            assert.match(app.text(), expected);
            const send = app.nodes().find((node) => node.props["aria-label"] === "Post comment");

            assert.equal(send?.props.disabled, true);
            await app.post();
            assert.equal(app.comments.length, 0);
        });
    }
});

test("human ranges allow exactly 100 lines and 8000 context characters, never truncate", async (t) => {
    for (const extra of [0, 1]) {
        await t.test(extra ? "8001 characters" : "inclusive limits", async (t) => {
            const lines = ["x".repeat(7802 + extra), ...Array(99).fill("x")];
            const diff = `diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1,100 +1,100 @@\n-${lines[0]}\n+${lines[0]}\n${lines
                .slice(1)
                .map((line) => ` ${line}\n`)
                .join("")}`;
            const app = await setup(t, { diff, text: "", threads: [thread()] });

            await app.comment("new", 1);
            await app.comment("new", 100, { shiftKey: true });
            await app.input("Comment", "Boundary range");
            await app.post();

            if (extra) {
                assert.match(app.text(), /Choose a smaller range/);
                assert.equal(app.comments.length, 0);
            } else {
                assert.equal(app.comments.length, 1);
                assert.equal(app.comments[0]!.startLine, 1);
                assert.equal(app.comments[0]!.line, 100);
                assert.equal(app.comments[0]!.context.length, 8000);
                assert.equal(app.comments[0]!.context, lines.join("\n"));
            }
        });
    }
});
