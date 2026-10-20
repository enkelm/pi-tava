// Exercise production chat/review/settings rendering and keyboard handlers without sockets.
// Only browser scheduling, hooks and transport are replaced; there are no test-only exports.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, test, type TestContext } from "node:test";
import { h } from "preact";

const htm = (await import(import.meta.resolve("htm"))).default;

type Props = Record<string, any>;
type Slot = { value?: any; current?: any; deps?: unknown[]; cleanup?: () => void };
type Mount = { slots: Slot[] };
let current: Mount;
let cursor = 0;
let effects: (() => void)[] = [];

let redraw = () => {};

let requestId = 0;
const fixture = {
    html: htm.bind(h),
    store: {
        state: {} as Props,
        set(patch: Props) {
            Object.assign(this.state, patch);
            redraw();
        },
    },
    drafts: new (class extends Map {
        get(key: unknown) {
            return super.get(key) ?? "";
        }
    })(),
    actions: {} as Props,
    notices: [] as string[],
    uid: () => `mention-${++requestId}`,
    api: async () => ({
        enabled: true,
        compactAt: 40000,
        chats: { id: null },
        collaborator: { model: null, revision: 1 },
    }),
    hooks: {
        useState(initial: any) {
            const slot = (current.slots[cursor++] ??= {
                value: typeof initial === "function" ? initial() : initial,
            });

            return [
                slot.value,
                (next: any) => {
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
        useMemo(make: () => unknown, deps: unknown[]) {
            const index = cursor++;
            const previous = current.slots[index];

            if (!previous || deps.some((value, at) => !Object.is(value, previous.deps?.[at]))) {
                current.slots[index] = { deps, value: make() };
            }

            return current.slots[index]!.value;
        },
        useId() {
            return `field-${cursor++}`;
        },
        useEffect(effect: () => (() => void) | undefined, deps?: unknown[]) {
            const index = cursor++;
            const previous = current.slots[index];

            if (
                !deps ||
                !previous ||
                deps.some((value, index) => !Object.is(value, previous.deps?.[index]))
            ) {
                const slot: Slot = { deps };

                current.slots[index] = slot;
                effects.push(() => {
                    previous?.cleanup?.();
                    slot.cleanup = effect();
                });
            }
        },
    },
};
const descriptors = new Map<string, PropertyDescriptor | undefined>();

for (const [name, value] of Object.entries({
    pipMentionsUiFixture: fixture,
    document: { activeElement: null },
    matchMedia: () => ({ matches: false }),
    innerHeight: 844,
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    requestAnimationFrame: (callback: () => void) => queueMicrotask(callback),
    CSS: { escape: (value: string) => value },
    ResizeObserver: class {
        observe() {}
        disconnect() {}
    },
    MutationObserver: class {
        observe() {}
        disconnect() {}
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
    "preact/hooks": `export const {useState,useRef,useId,useEffect,useMemo}=globalThis.pipMentionsUiFixture.hooks;
        export const useLayoutEffect=useEffect;`,
    "./store.js": `export const {store,actions,drafts,uid,api}=globalThis.pipMentionsUiFixture;
        export const canSteer=()=>store.state.me?.role!=="viewer",collab=()=>true,canToggleTurns=()=>false;
        export const attempt=async action=>{await action();return true;};
        export const notify=(_kind,text)=>globalThis.pipMentionsUiFixture.notices.push(text);
        export const chatLogShown=()=>{},closePeople=()=>{},closeSheet=()=>{},insertIntoComposer=()=>{},
            markChatRead=()=>{},openSheet=()=>{},peopleDocked=()=>false,revealEntry=()=>{},
            revealReviewReviewer=()=>{},typing=()=>{};`,
    "./ui.js": `export const {html}=globalThis.pipMentionsUiFixture;
        export const Icon=()=>null,Loader=()=>null,Spinner=()=>null,Switch=()=>null,
            copyText=async()=>{},timeAgo=()=>"now",Sheet=props=>props.children;`,
    "./avatar.js": `export const Avatar=()=>null,initials=name=>name.slice(0,1),personColor=()=>"blue";`,
    "./model.js": `export const ModelPicker=()=>null,defaultLabel=()=>"Model";`,
};

registerHooks({
    resolve(specifier, context, next) {
        const parent = context.parentURL && new URL(context.parentURL).pathname;
        const eligible =
            parent &&
            /\/web\/(chat|reviews|pip-mentions|mention-composer|sheets\/pip)\.js$/.test(parent);
        const source = eligible ? sources[specifier.replace(/^\.\.\//, "./")] : undefined;

        return source === undefined
            ? next(specifier, context)
            : {
                  url: `data:text/javascript,${encodeURIComponent(source)}`,
                  shortCircuit: true,
              };
    },
});
const { PeoplePanel } = await import(new URL("../web/chat.js", import.meta.url).href);
const { ReviewThreads } = await import(new URL("../web/reviews.js", import.meta.url).href);
const { PipSettings } = await import(new URL("../web/sheets/pip.js", import.meta.url).href);

function nodes(value: any): Props[] {
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

const flush = async () => {
    for (let turn = 0; turn < 40; turn++) {
        await Promise.resolve();
    }
};

let conversation = 1000;

async function setup(
    t: TestContext,
    {
        surface = "chat",
        role = "guest",
        enabled = true,
        supported = true,
        chat = [],
        threads = [],
        composing = false,
        anchor = {},
        applySuggestion,
    }: Props = {},
) {
    const mounts = new Map<string, Mount>();
    const sent: Props[] = [];
    const applied: Props[] = [];
    const scrolls: string[] = [];
    const input = {
        selectionStart: 0,
        selectionEnd: 0,
        style: {},
        scrollHeight: 40,
        focus() {},
        setSelectionRange(start: number, end = start) {
            this.selectionStart = start;
            this.selectionEnd = end;
        },
    };
    const log = {
        children: [],
        scrollTop: 0,
        scrollHeight: 100,
        clientHeight: 100,
        addEventListener() {},
        removeEventListener() {},
        querySelector(selector: string) {
            return { scrollIntoView: () => scrolls.push(selector) };
        },
    };
    let tree: unknown;
    let live = true;
    let scheduled = false;

    fixture.store.state = {
        conversationId: ++conversation,
        me: { id: "human", name: "Taylor", role },
        users: [
            { id: "human", name: "Taylor", role },
            { id: "alex", name: "Alex", role: "guest" },
        ],
        server: {
            pipMentions: supported,
            pipEnabled: enabled,
            pip: false,
            pipSettings: 1,
            localReviews: 2,
            reviewSuggestions: 1,
        },
        presence: [],
        peopleAsk: { n: 0 },
        chat,
        chatRead: 0,
        chatQuote: null,
        view: { pins: [], live: {}, reviews: { threads } },
    };
    fixture.drafts.clear();
    fixture.notices = [];
    fixture.actions.chat = async (text: string, quote: unknown) => sent.push({ text, quote });
    fixture.actions.reviewComment = async (payload: Props) => sent.push(payload);

    fixture.actions.applyReviewSuggestion = async (payload: Props, id: number) => {
        applied.push({ ...payload, conversationId: id });

        return applySuggestion ? applySuggestion(payload, id) : { status: "applied" };
    };

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
            const output = value.type.prototype?.render
                ? new value.type(value.props).render(value.props)
                : value.type(value.props);

            return expand(output, `${key}/render`);
        }

        if (value.ref && typeof value.ref === "object") {
            value.ref.current = value.props.class === "chat-log" ? log : input;
        }

        return {
            ...value,
            props: { ...value.props, children: expand(value.props.children, `${path}/children`) },
        };
    };

    const render = () => {
        if (!live) {
            return;
        }

        tree = expand(
            surface === "chat"
                ? h(PeoplePanel, {})
                : surface === "settings"
                  ? h(PipSettings, {})
                  : h(ReviewThreads, { threads, composing, ...anchor }),
        );
        const pending = effects;

        effects = [];

        for (const effect of pending) {
            effect();
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
        sent,
        applied,
        input,
        scrolls,
        notices: fixture.notices,
        nodes: () => nodes(tree),
        text: () => textOf(tree),
        async click(label: string) {
            const node = nodes(tree).find(
                (each) =>
                    each.type === "button" &&
                    (each.props["aria-label"] === label || textOf(each).trim() === label),
            );

            assert.ok(node, `Missing button: ${label}`);
            assert.ok(!node.props.disabled, `${label} must be available`);
            node.props.onClick();
            await flush();
        },
        async type(text: string, caret = text.length) {
            input.selectionStart = caret;
            const field = nodes(tree).find((node) => node.type === "textarea");

            assert.ok(field);
            field.props.onInput({ currentTarget: { value: text, selectionStart: caret } });
            await flush();
        },
        async fieldEvent(handler: string, text: string, caret = text.length, extra: Props = {}) {
            input.selectionStart = caret;
            const field = nodes(tree).find((node) => node.type === "textarea");

            assert.ok(field?.props[handler]);
            field.props[handler]({
                currentTarget: { value: text, selectionStart: caret },
                ...extra,
            });
            await flush();
        },
        async key(key: string, extra: Props = {}) {
            const field = nodes(tree).find((node) => node.type === "textarea");
            let prevented = false;

            assert.ok(field);
            field.props.onKeyDown({
                key,
                preventDefault: () => {
                    prevented = true;
                },
                stopPropagation() {},
                ...extra,
            });
            await flush();

            return prevented;
        },
        async post() {
            if (surface === "chat") {
                nodes(tree)
                    .find((node) => node.props["aria-label"] === "Send")!
                    .props.onClick();
            } else {
                nodes(tree)
                    .find((node) => node.type === "form")!
                    .props.onSubmit({ preventDefault() {} });
            }

            await flush();
        },
        async update(patch: Props) {
            fixture.store.set(patch);
            await flush();
        },
    };
}

const message = (extra: Props = {}): Props => ({
    id: "question",
    userId: "human",
    name: "Taylor",
    text: "@PiP please explain",
    at: 1,
    ...extra,
});
const thread = (extra: Props = {}): Props => ({
    ...message(),
    resolved: false,
    replies: [],
    ...extra,
});

// Choice/keyboard coverage belongs at ChatTab: a helper-only test would miss roles,
// live capability changes, insertion at the caret, IME handling, or accidental sends.
test("PiP completion is a service choice for steering roles, with keyboard insertion and no premature send", async (t) => {
    for (const key of ["Tab", "Enter"]) {
        await t.test(key, async (t) => {
            const app = await setup(t);
            const users = [...fixture.store.state.users];

            await app.type("Ask @pi");
            assert.ok(app.nodes().some((node) => node.props["aria-label"] === "Mention PiP"));
            assert.equal(await app.key(key, { isComposing: true }), false);
            assert.equal(app.sent.length, 0);
            assert.equal(await app.key(key), true);
            assert.equal(
                app.nodes().find((node) => node.type === "textarea")!.props.value,
                "Ask @PiP ",
            );
            assert.equal(app.sent.length, 0);
            assert.deepEqual(
                fixture.store.state.users,
                users,
                "PiP never becomes a configured person",
            );
            await app.type("Ask @PiP why?");
            await app.post();
            assert.deepEqual(app.sent, [{ text: "Ask @PiP why?", quote: null }]);
        });
    }
});

test("completion follows public support and execution policy, while typed mentions still post normally", async (t) => {
    for (const options of [{ role: "viewer" }, { enabled: false }, { supported: false }]) {
        await t.test(JSON.stringify(options), async (t) => {
            const app = await setup(t, options);

            await app.type("@pi");
            assert.equal(
                app.nodes().some((node) => node.props["aria-label"] === "Mention PiP"),
                false,
            );
            await app.type("@PiP ordinary message even when unavailable");
            await app.post();
            assert.equal(app.sent[0]!.text, "@PiP ordinary message even when unavailable");
        });
    }

    await t.test("pause and resume without refreshing the private panel", async (t) => {
        const app = await setup(t, { enabled: false });

        await app.type("@pi");
        await app.update({ server: { ...fixture.store.state.server, pipEnabled: true } });
        assert.ok(app.nodes().some((node) => node.props["aria-label"] === "Mention PiP"));
        await app.key("Escape");
        assert.equal(
            app.nodes().some((node) => node.props["aria-label"] === "Mention PiP"),
            false,
        );
        await app.type("@Al");
        assert.ok(app.nodes().some((node) => node.props["aria-label"] === "Mention Alex"));
        await app.key("Tab");
        assert.equal(app.nodes().find((node) => node.type === "textarea")!.props.value, "@Alex ");
    });
});

test("chat and review messages show bounded in-place statuses, including admission failure reasons", async (t) => {
    const states = [
        ["queued", undefined, /PiP · queued/],
        ["working", undefined, /PiP · answering/],
        ["answered", undefined, /PiP · answered/],
        ["failed", undefined, /could not answer/],
        ["interrupted", undefined, /answer was interrupted/],
        ...Object.entries({
            paused: /PiP is paused/,
            model: /Settings → PiP/,
            budget: /spending limit/,
            permission: /role cannot request/,
            turn: /current driver/,
            capacity: /at capacity/,
            source: /cannot access/,
        }).map(([reason, expected]) => ["unavailable", reason, expected]),
    ];

    for (const surface of ["chat", "review"]) {
        await t.test(surface, async (t) => {
            const messages = states.map(([status, reason], index) =>
                message({
                    id: `state-${index}`,
                    pip: { status, reason, error: "RAW_PROVIDER_ERROR" },
                }),
            );
            const app = await setup(t, {
                surface,
                chat: messages,
                threads: [thread({ ...messages[0], replies: messages.slice(1) })],
            });
            const statuses = app.nodes().filter((node) => node.props.role === "status");

            assert.equal(statuses.length, states.length);

            for (const [index, state] of states.entries()) {
                assert.match(textOf(statuses[index]), state[2] as RegExp);
                assert.equal(statuses[index]!.props["aria-live"], "polite");
            }

            assert.equal(app.text().includes("RAW_PROVIDER_ERROR"), false);
        });
    }
});

test("explicit PiP prose is highlighted in chat and reviews without altering examples or person mentions", async (t) => {
    const text =
        "@PiP, @pip! @Alex\n> @PiP quoted\n`@PiP` inline\n@p`example`ip\n```\n@PiP code\n```\n\\@PiP @PiPizza x@PiP @@PiP";

    for (const surface of ["chat", "review"]) {
        await t.test(surface, async (t) => {
            const app = await setup(t, {
                surface,
                chat: [message({ text, mentions: ["alex"] })],
                threads: [thread({ text, replies: [message({ id: "reply", text })] })],
            });
            const body = app
                .nodes()
                .find(
                    (node) =>
                        node.props.class === (surface === "chat" ? "chat-text" : "rv-message"),
                );

            assert.ok(body);
            assert.equal(textOf(body), surface === "chat" ? text : text.replace(/\n```\n/g, ""));
            const highlights = nodes(body).filter((node) =>
                String(node.props.class).split(" ").includes("mention"),
            );

            assert.deepEqual(highlights.map(textOf), ["@PiP", "@pip", "@Alex"]);

            if (surface === "review") {
                const reply = app.nodes().filter((node) => node.props.class === "rv-message")[1];

                assert.deepEqual(
                    nodes(reply)
                        .filter((node) => String(node.props.class).split(" ").includes("mention"))
                        .map(textOf),
                    ["@PiP", "@pip", "@Alex"],
                );
            }
        });
    }
});

test("PiP chat answers keep an exact parent snapshot and navigate only within the recent source log", async (t) => {
    const parent = message({ text: "Original @PiP question" });
    const answer = message({
        id: "answer",
        service: "pip",
        userId: "pip",
        name: "PiP",
        text: "A source-bound answer",
        replyTo: { id: parent.id, name: "Original Taylor", text: parent.text },
    });
    const app = await setup(t, { chat: [parent, answer] });
    const quote = app
        .nodes()
        .find((node) => node.props["aria-label"] === "Show chat message from Original Taylor");

    assert.ok(quote);
    assert.equal(textOf(quote), "Original Taylor: Original @PiP question");
    quote.props.onClick();
    await flush();
    assert.deepEqual(app.scrolls, ['[data-chat="question"]']);
    const source = app.nodes().find((node) => node.props["data-chat"] === "question");

    assert.ok(source?.props.class.includes("open"));
    await app.update({ chat: [answer] });
    app.nodes()
        .find((node) => node.props["aria-label"] === "Show chat message from Original Taylor")!
        .props.onClick();
    await flush();
    assert.equal(app.scrolls.length, 1);
    assert.deepEqual(app.notices, ["That message is no longer in the recent chat log."]);
    assert.match(app.text(), /Original Taylor: Original @PiP question/);
    assert.equal(app.text().includes("via Reviewer"), false);
});

test("review opening and reply composers complete people and PiP at the active caret", async (t) => {
    for (const reply of [false, true]) {
        await t.test(reply ? "reply" : "new comment", async (t) => {
            const app = await setup(t, {
                surface: "review",
                composing: !reply,
                threads: reply ? [thread()] : [],
            });

            if (reply) {
                app.nodes()
                    .find((node) => node.props["aria-label"] === "Reply to Taylor")!
                    .props.onClick();
                await flush();
            }

            await app.type("First @Al, then @pi later", 9);
            assert.ok(app.nodes().some((node) => node.props["aria-label"] === "Mention Alex"));
            assert.equal(await app.key("Enter", { isComposing: true }), false);
            assert.equal(app.sent.length, 0);
            assert.equal(await app.key("Tab"), true);
            assert.equal(
                app.nodes().find((node) => node.type === "textarea")!.props.value,
                "First @Alex , then @pi later",
            );
            assert.equal(app.sent.length, 0);
            await app.type("First @Alex, then @pi later", 21);
            assert.ok(app.nodes().some((node) => node.props["aria-label"] === "Mention PiP"));
            await app.key("Enter");
            assert.equal(
                app.nodes().find((node) => node.type === "textarea")!.props.value,
                "First @Alex, then @PiP  later",
            );
            await app.post();
            assert.equal(app.sent[0]!.text, "First @Alex, then @PiP  later");
            assert.equal(app.sent[0]!.threadId, reply ? "question" : undefined);
        });
    }
});

test("new review comments and replies preserve Markdown indentation before admission", async (t) => {
    for (const reply of [false, true]) {
        await t.test(reply ? "reply" : "new comment", async (t) => {
            const app = await setup(t, {
                surface: "review",
                composing: !reply,
                threads: reply ? [thread()] : [],
            });

            if (reply) {
                app.nodes()
                    .find((node) => node.props["aria-label"] === "Reply to Taylor")!
                    .props.onClick();
                await flush();
            }

            await app.type("    @PiP example", 16);
            await app.post();
            assert.equal(
                app.sent[0]!.text,
                "    @PiP example",
                "client submission must not turn code into a live mention",
            );
            assert.equal(app.sent[0]!.threadId, reply ? "question" : undefined);
        });
    }
});

test("completion follows caret moves and keyboard choice, and composition cannot accidentally send", async (t) => {
    for (const surface of ["chat", "review"]) {
        await t.test(surface, async (t) => {
            const app = await setup(t, { surface, composing: surface === "review" });

            await app.type("Ask @Al, later @pi.");
            await app.fieldEvent(
                surface === "chat" ? "onSelect" : "onKeyUp",
                "Ask @Al, later @pi.",
                7,
                { key: "ArrowLeft" },
            );
            assert.ok(app.nodes().some((node) => node.props["aria-label"] === "Mention Alex"));
            await app.key("Escape");
            assert.equal(
                app.nodes().some((node) => node.props.role === "listbox"),
                false,
            );
            await app.type("@");
            await app.key("ArrowDown");
            assert.equal(
                app.nodes().find((node) => node.props["aria-label"] === "Mention Alex")!.props[
                    "aria-selected"
                ],
                true,
            );
            await app.key("Enter");
            assert.equal(
                app.nodes().find((node) => node.type === "textarea")!.props.value,
                "@Alex ",
            );
            assert.equal(app.sent.length, 0);

            await app.fieldEvent("onCompositionStart", "@Al");
            await app.type("@Al");
            assert.equal(
                app.nodes().some((node) => node.props.role === "listbox"),
                false,
            );
            assert.equal(
                await app.key("Enter"),
                false,
                "IME confirmation retains the browser default",
            );
            assert.equal(
                app.sent.length,
                0,
                "composition state still protects a final key without isComposing",
            );
            await app.fieldEvent("onCompositionEnd", "@Al");
            assert.ok(app.nodes().some((node) => node.props["aria-label"] === "Mention Alex"));
            await app.key("Tab");
            assert.equal(
                app.nodes().find((node) => node.type === "textarea")!.props.value,
                "@Alex ",
            );
        });
    }
});

test("viewers can select humans in review comments without gaining PiP execution", async (t) => {
    const app = await setup(t, { surface: "review", composing: true, role: "viewer" });

    await app.type("@");
    assert.ok(app.nodes().some((node) => node.props["aria-label"] === "Mention Alex"));
    assert.equal(
        app.nodes().some((node) => node.props["aria-label"] === "Mention PiP"),
        false,
    );
    app.nodes()
        .find((node) => node.props["aria-label"] === "Mention Alex")!
        .props.onClick();
    await flush();
    await app.post();
    assert.equal(app.sent[0]!.text, "@Alex");
});

test("review composers stay quiet across role and pause changes without blocking human posts", async (t) => {
    for (const options of [
        { role: "guest", enabled: true },
        { role: "viewer", enabled: true },
        { role: "guest", enabled: false },
    ]) {
        await t.test(JSON.stringify(options), async (t) => {
            const app = await setup(t, { surface: "review", composing: true, ...options });

            assert.equal(app.nodes().filter((node) => node.props.class === "rv-notice").length, 0);
            await app.type("@PiP review question");
            await app.post();
            assert.equal(app.sent[0]!.text, "@PiP review question");
        });
    }
});

test("PiP settings explain shared mention answers and the shared execution pause", async (t) => {
    const app = await setup(t, { surface: "settings", role: "owner" });

    assert.match(app.text(), /explicit @PiP mentions in shared chat and review discussions/);
    assert.match(app.text(), /Pausing stops private runs, shared mention answers and compaction/);
    assert.match(app.text(), /These model choices are independent/);
    assert.equal(app.text().includes("not connected yet"), false);
});

test("a human opens a suggestion with selected code without applying or generating work", async (t) => {
    const context = "    const fence = '```';";
    const app = await setup(t, {
        surface: "review",
        composing: true,
        role: "viewer",
        anchor: { path: "src/file.ts", side: "new", line: 3, context },
    });

    await app.type("Keep this explanation.");
    await app.click("Insert suggestion");
    const field = app.nodes().find((node) => node.type === "textarea")!;

    assert.equal(
        field.props.value,
        `Keep this explanation.\n\n\`\`\`\`suggestion\n${context}\n\`\`\`\`\n`,
    );
    assert.equal(
        field.props.value.slice(app.input.selectionStart, app.input.selectionEnd),
        context,
    );
    assert.equal(app.sent.length, 0);
    assert.equal(app.applied.length, 0);
    await app.post();
    assert.equal(app.sent[0]!.text, field.props.value.trim());
    assert.equal(app.applied.length, 0, "posting a suggestion never writes a file");
});

test("human and PiP suggestions render exact code and apply the chosen message block only on click", async (t) => {
    for (const source of ["human", "pip reply", "pip legacy reply"]) {
        await t.test(source, async (t) => {
            const code = "    return '<script>not markup</script>';";
            const text = `@Alex see [React docs](https://react.dev/reference/react/useEffect).\n\n\`\`\`js\nexample();\n\`\`\`\n\n> \`\`\`suggestion\n> quoted();\n> \`\`\`\n\n\`\`\`suggestion\nfirstChoice();\n\`\`\`\n\n~~~~suggestion\n${code}\n~~~~`;
            const comment = message({
                id: source === "human" ? "root" : "pip-answer",
                text,
                ...(source === "human" ? {} : { userId: "pip", name: "PiP", service: "pip" }),
                ...(source === "pip legacy reply" ? { workspace: "fresh-reply-destination" } : {}),
            });
            const thread = {
                ...message({ id: "root", text: "@PiP change this" }),
                path: "src/file.ts",
                side: "new",
                startLine: 2,
                line: 3,
                context: "old first\nold last",
                workspace: source === "pip legacy reply" ? undefined : "captured-destination",
                resolved: false,
                replies: source === "human" ? [] : [comment],
                ...(source === "human" ? comment : {}),
            };
            const app = await setup(t, { surface: "review", threads: [thread] });
            const buttons = () =>
                app
                    .nodes()
                    .filter(
                        (node) =>
                            node.type === "button" && textOf(node).trim() === "Apply suggestion",
                    );

            assert.equal(buttons().length, 2, "only eligible top-level suggestions are actions");
            assert.ok(app.nodes().some((node) => node.type === "pre" && textOf(node) === code));
            assert.ok(
                app
                    .nodes()
                    .some(
                        (node) =>
                            node.type === "a" &&
                            node.props.href === "https://react.dev/reference/react/useEffect",
                    ),
            );
            assert.ok(
                app
                    .nodes()
                    .some(
                        (node) =>
                            String(node.props.class).split(" ").includes("mention") &&
                            textOf(node) === "@Alex",
                    ),
            );
            assert.equal(app.applied.length, 0);
            buttons()[1]!.props.onClick();
            await flush();
            assert.equal(app.applied.length, 1);
            assert.deepEqual(app.applied[0], {
                threadId: "root",
                commentId: comment.id,
                index: 1,
                requestId: app.applied[0]!.requestId,
                conversationId: fixture.store.state.conversationId,
            });
            assert.ok(
                app
                    .nodes()
                    .some(
                        (node) =>
                            node.type === "button" &&
                            textOf(node).trim() === "Applied" &&
                            node.props.disabled,
                    ),
            );
        });
    }
});

test("suggestion controls respect current write access and fence completeness", async (t) => {
    for (const state of [
        "viewer",
        "busy",
        "other driver",
        "old side",
        "applied",
        "applying",
        "uncertain",
        "unclosed",
        "unsupported",
        "unbound",
    ]) {
        await t.test(state, async (t) => {
            const thread: Props = {
                ...message({ id: "root", text: "```suggestion\nreplacement();\n```" }),
                path: "src/file.ts",
                side: state === "old side" ? "old" : "new",
                workspace: state === "unbound" ? undefined : "captured-destination",
                line: 3,
                context: "old();",
                resolved: false,
                replies: [],
                ...(["applied", "applying", "uncertain"].includes(state)
                    ? { suggestions: { "0": { status: state, by: "human", at: 1 } } }
                    : {}),
            };

            if (state === "unclosed") {
                thread.text = "```suggestion\nreplacement();";
            }

            const app = await setup(t, {
                surface: "review",
                role: state === "viewer" ? "viewer" : "guest",
                threads: [thread],
            });

            if (state === "busy") {
                await app.update({ view: { ...fixture.store.state.view, live: { busy: true } } });
            } else if (state === "other driver") {
                await app.update({
                    view: { ...fixture.store.state.view, turns: { on: true, driver: "alex" } },
                });
            } else if (state === "unsupported") {
                await app.update({
                    server: { ...fixture.store.state.server, reviewSuggestions: undefined },
                });
            }

            const apply = app
                .nodes()
                .find(
                    (node) => node.type === "button" && textOf(node).trim() === "Apply suggestion",
                );

            assert.ok(!apply || apply.props.disabled, `${state} cannot apply`);
            assert.equal(app.applied.length, 0);
        });
    }
});

test("an uncertain application is never labelled applied and can explicitly check its result", async (t) => {
    const thread: Props = {
        ...message({ id: "root", text: "```suggestion\nreplacement();\n```" }),
        path: "src/file.ts",
        side: "new",
        line: 3,
        context: "old();",
        resolved: false,
        replies: [],
        workspace: "captured-destination",
    };
    let checks = 0;
    const app = await setup(t, {
        surface: "review",
        threads: [thread],
        applySuggestion: () => {
            if (++checks === 1) {
                thread.suggestions = { "0": { status: "uncertain", by: "human", at: 1 } };

                throw new Error("The application could not be confirmed. Check the result.");
            }

            return { status: "applied" };
        },
    });

    await app.click("Apply suggestion");
    assert.equal(
        app.nodes().some((node) => node.type === "button" && textOf(node).trim() === "Applied"),
        false,
    );
    assert.equal(app.applied.length, 1);
    await app.click("Check result");
    assert.equal(
        app.applied.length,
        2,
        "only another explicit human click asks for reconciliation",
    );
    assert.ok(
        app
            .nodes()
            .some(
                (node) =>
                    node.type === "button" &&
                    textOf(node).trim() === "Applied" &&
                    node.props.disabled,
            ),
    );
});

test("pending suggestion clicks deduplicate and late completion cannot affect another conversation", async (t) => {
    let finish!: (value: Props) => void;
    const held = new Promise<Props>((resolve) => {
        finish = resolve;
    });
    const thread = {
        ...message({ id: "root", text: "```suggestion\nreplacement();\n```" }),
        workspace: "captured-destination",
        path: "src/file.ts",
        side: "new",
        line: 3,
        context: "old();",
        resolved: false,
        replies: [],
    };
    const app = await setup(t, {
        surface: "review",
        threads: [thread],
        applySuggestion: () => held,
    });
    const button = app
        .nodes()
        .find((node) => node.type === "button" && textOf(node).trim() === "Apply suggestion");

    assert.ok(button);
    button.props.onClick();
    button.props.onClick();
    await flush();
    assert.equal(app.applied.length, 1);
    const original = fixture.store.state.conversationId;

    await app.update({ conversationId: original + 1 });
    button.props.onClick();
    assert.equal(app.applied.length, 1);
    finish({ status: "applied" });
    await flush();
    assert.equal(
        app.nodes().some((node) => node.type === "button" && textOf(node).trim() === "Applied"),
        false,
    );
});
