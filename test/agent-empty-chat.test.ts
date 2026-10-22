// Welcome identity selection belongs to the real Transcript and AgentDraftPane output.
// Vendor rendering/fallback belongs to named-agent-avatar tests; scroll, effects and Composer
// callbacks have other owners. These tests keep the native avatar opaque and use real draft selection.
// Loading comparisons protect the existing shared thread treatment; they are not a reproduction
// of the reported plain-text loading symptom, which has not been localized.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, test } from "node:test";
import { h, isValidElement, type VNode } from "preact";

const html = (await import(import.meta.resolve("htm"))).default.bind(h);

type Props = Record<string, any>;
type Element = VNode<Props>;
const storage = new Map<string, string>();
let owner = 0;
let next = 0;
const fixture = {
    html,
    store: {
        state: {} as Props,
        set(patch: Props | ((state: Props) => Props)) {
            this.state = {
                ...this.state,
                ...(typeof patch === "function" ? patch(this.state) : patch),
            };
        },
    },
    uid: () => `draft-${++next}`,
    navigate(id: number | null, options?: { agentDraft?: Props }) {
        fixture.store.set({ conversationId: id, agentDraft: options?.agentDraft ?? null });
    },
};
const globals: Record<string, unknown> = {
    agentEmptyChatFixture: fixture,
    document: new EventTarget(),
    matchMedia: () => ({ matches: false }),
    sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
    },
};
const descriptors = Object.keys(globals).map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
);

for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
}

const inert = (...names: string[]) =>
    names.map((name) => `export const ${name} = () => null;`).join("\n");
const sources: Record<string, string> = {
    "preact/hooks": `
        export const useEffect = () => {}, useLayoutEffect = () => {};
        export const useRef = current => ({current});
        export const useState = initial => [typeof initial === 'function' ? initial() : initial, () => {}];
        export const useMemo = run => run();`,
    "./store.js": `
        export const {store, uid, navigate} = globalThis.agentEmptyChatFixture;
        export const api = () => { throw new Error('Welcome rendering must not call HTTP'); };
        export const canSteer = () => store.state.me?.role === 'owner';
        export const collab = () => false, isRow = entry => entry.kind === 'user';
        export const TRANSCRIPT_ROWS = 100, actions = {};
        ${inert("attempt", "closeSheet", "discuss", "notify", "openSheet", "revealReviewThread")}`,
    "./ui.js": `
        export const html = globalThis.agentEmptyChatFixture.html;
        ${inert(
            "Boot",
            "copyText",
            "entryImageUrl",
            "fileUrl",
            "Icon",
            "Loader",
            "Markdown",
            "openFile",
            "plainText",
            "readable",
            "replyText",
            "Sheet",
            "Spinner",
            "splitAttachments",
            "Thumb",
            "timeAgo",
        )}`,
    "./avatar.js": inert("initials", "personColor"),
    "./browser.js": inert("browserAvailable", "setBrowserOpen"),
    "./calls.js": `${inert("describeCall")} export const describersRevision = 0;`,
    "./composer.js": inert("Composer"),
    "./diff.js": inert("DiffBlock"),
    "./linked-sessions.js": inert("LinkedSessions"),
    "./pip-question.js": inert("PipQuestion"),
    "./review-comments.js": inert("DiffComments"),
    "./rich.js": inert("Highlighted"),
    "./seen.js": "export const fromServer = value => value;",
    "./sidebar-context.js": inert("openSidebarOptions", "useSidebarContext"),
    "./subagents.js": inert("openSubagent", "stateOf"),
    "./theme.js": "export const prefs = () => ({showThinking: true});",
    "./visible-clock.js": inert("useVisibleClock"),
    "./workspace-location.js": inert("conversationLocation"),
    "./sheets/memory.js": inert("LessonCall", "memoryAvailable"),
    "./sheets/model.js": inert("ModelPicker"),
};
const parents =
    /\/web\/(transcript|agent-draft-pane|agent-drafts|named-agents|named-agent-avatar)\.js$/;
const hooks = registerHooks({
    resolve(specifier, context, next) {
        const source = parents.test(context.parentURL ?? "") ? sources[specifier] : undefined;

        return source === undefined
            ? next(specifier, context)
            : { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    },
});
const { Transcript } = await import(new URL("../web/transcript.js", import.meta.url).href);
const { AgentDraftPane } = await import(
    new URL("../web/agent-draft-pane.js", import.meta.url).href
);
const { NamedAgentAvatar } = await import(
    new URL("../web/named-agent-avatar.js", import.meta.url).href
);
const { openAgentDraft, closeAgentDraft } = await import(
    new URL("../web/agent-drafts.js", import.meta.url).href
);

after(() => {
    hooks.deregister();

    for (const [key, descriptor] of descriptors) {
        if (descriptor) {
            Object.defineProperty(globalThis, key, descriptor);
        } else {
            Reflect.deleteProperty(globalThis, key);
        }
    }
});

function nodes(value: unknown): Element[] {
    if (Array.isArray(value)) {
        return value.flatMap(nodes);
    }

    if (!isValidElement(value)) {
        return [];
    }

    const element = value as Element;

    return [element, ...nodes(element.props.children)];
}

function text(value: unknown): string {
    if (Array.isArray(value)) {
        return value.map(text).join("");
    }

    if (isValidElement(value)) {
        return text((value as Element).props.children);
    }

    return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function reset() {
    storage.clear();
    fixture.store.state = {
        me: { id: `owner-${++owner}`, role: "owner" },
        server: { privateAgents: 4 },
        conversationId: 19,
        agentDraft: null,
        namedAgents: [
            { agentId: "previous-agent", id: 19, name: "Previous Ada", chatIds: [19] },
            { agentId: "current-agent", id: 73, name: "Current Bea", chatIds: [73] },
        ],
        sessions: [],
        sessionsLoaded: true,
        pendingShells: [],
        transcriptFrom: null,
        history: null,
        missing: null,
        view: {
            conversation: { id: 19, kind: "session", pipAgentId: "current-agent" },
            entries: new Map(),
            order: [],
            live: { busy: false },
            approvals: [],
        },
    };
}

const ask =
    "Ask anything. Pi works in this session's folder, and keeps working if the server restarts.";
const avatars = (tree: unknown) => nodes(tree).filter((node) => node.type === NamedAgentAvatar);
const piMarks = (tree: unknown) => nodes(tree).filter((node) => node.props.class === "pi");
const welcome = (tree: unknown) => nodes(tree).find((node) => node.props.class === "empty hint");

function assertPiWelcome(tree: unknown, copy = ask) {
    const hint = welcome(tree);

    assert.ok(hint, "the standard empty welcome remains visible");
    assert.equal(avatars(tree).length, 0);
    assert.deepEqual(
        piMarks(hint).map((node) => text(node)),
        ["π"],
    );
    assert.equal(text(hint).replace(/\s+/g, " ").trim(), `π${copy}`);
}

test("unloaded named and ordinary saved chats share the native thread loading surface, not an empty welcome", () => {
    for (const [connection, caption] of [
        ["connecting", "connecting"],
        ["open", "loading session"],
        ["closed", "reconnecting"],
    ]) {
        const loaders: Element[] = [];

        for (const named of [false, true]) {
            reset();
            fixture.store.state.connection = connection;
            fixture.store.state.sessions = [
                {
                    id: 19,
                    title: named ? "Bea's saved chat" : "Ordinary thread",
                    ...(named ? { pipAgentId: "current-agent" } : {}),
                },
            ];
            fixture.store.state.view.conversation = null;
            const tree = Transcript() as Element;
            const loader = nodes(tree).find((node) => node.props.inline === true);

            assert.equal(tree.type, "main");
            assert.equal(tree.props.class, "scroller");
            assert.ok(
                loader,
                "the native thread loader occupies the transcript's scrolling surface",
            );
            assert.equal(typeof loader.type, "function", "not plain loading text");
            assert.equal(loader.props.caption, caption);
            assert.equal(loader.props.detail, fixture.store.state.sessions[0].title);
            assert.equal(welcome(tree), undefined, "loading is not an empty chat");
            assert.equal(avatars(tree).length, 0);
            loaders.push(loader);
        }

        assert.equal(
            loaders[1]!.type,
            loaders[0]!.type,
            "named chats reuse the ordinary thread's component",
        );
    }
});

test("unavailable named and ordinary saved chats show the route error rather than loading or an empty welcome", () => {
    for (const named of [false, true]) {
        reset();
        fixture.store.state.sessions = [
            { id: 19, ...(named ? { pipAgentId: "current-agent" } : {}) },
        ];
        fixture.store.state.view.conversation = null;
        fixture.store.state.missing = "This session is no longer available.";
        const tree = Transcript();

        assert.match(text(tree), /This session is no longer available/);
        assert.match(text(tree), /All sessions/);
        assert.equal(
            nodes(tree).some((node) => node.props.inline === true),
            false,
        );
        assert.equal(welcome(tree), undefined);
        assert.equal(avatars(tree).length, 0);
    }
});

test("the exact selected saved identity replaces π with its keyed native avatar, not a catalogue chat-list match", () => {
    reset();
    const tree = Transcript();
    const hint = welcome(tree);
    const avatar = avatars(tree);

    assert.equal(avatar.length, 1, "named saved welcome must mount the existing NamedAgentAvatar");
    assert.ok(hint);
    assert.equal(avatar[0]!.props.agentId, "current-agent");
    assert.equal(avatar[0]!.props.size, 48);
    assert.equal(avatar[0]!.key, "current-agent");
    assert.equal(piMarks(hint).length, 0);
    assert.equal(text(hint).trim(), ask, "only the emblem changes, not the ordinary welcome copy");
    fixture.store.state.view.conversation.pipAgentId = "previous-agent";
    const switched = avatars(Transcript());

    assert.equal(switched.length, 1);
    assert.equal(switched[0]!.props.agentId, "previous-agent");
    assert.notEqual(
        switched[0]!.key,
        avatar[0]!.key,
        "identity change resets native quiet fallback",
    );
});

for (const kind of ["session", "subagent"]) {
    test(`an ordinary ${kind} keeps π and its existing welcome text`, () => {
        reset();
        fixture.store.state.view.conversation = { id: 19, kind };
        assertPiWelcome(
            Transcript(),
            kind === "subagent" ? "This subagent has no messages yet." : ask,
        );
    });
}

const unavailable: [string, () => void][] = [
    [
        "stale view for another selected conversation",
        () => (fixture.store.state.conversationId = 73),
    ],
    ["missing catalogue", () => (fixture.store.state.namedAgents = [])],
    ["unknown identity", () => (fixture.store.state.view.conversation.pipAgentId = "unknown")],
    ["non-owner", () => (fixture.store.state.me.role = "viewer")],
    ["capability downgrade", () => (fixture.store.state.server.privateAgents = 3)],
];

for (const [reason, change] of unavailable) {
    test(`${reason} cannot decorate the saved welcome with a private identity`, () => {
        reset();
        change();
        assertPiWelcome(Transcript());
    });
}

for (const occupied of ["busy", "nonempty"]) {
    test(`a ${occupied} saved chat has no empty welcome or welcome avatar`, () => {
        reset();

        if (occupied === "busy") {
            fixture.store.state.view.live.busy = true;
        } else {
            fixture.store.state.view.entries.set(1, {
                id: 1,
                kind: "user",
                text: "First question",
            });
            fixture.store.state.view.order = [1];
        }

        const tree = Transcript();

        assert.equal(welcome(tree), undefined);
        assert.equal(avatars(tree).length, 0);
        assert.equal(piMarks(tree).length, 0);
    });
}

test("unsent drafts fill the native thread scroll region and keep the Composer outside it", () => {
    reset();
    const normalThread = Transcript() as Element;
    const draft = openAgentDraft("current-agent");
    const tree = AgentDraftPane();

    assert.ok(Array.isArray(tree), "scroll content and the native Composer remain pane siblings");
    const roots = tree.filter(isValidElement) as Element[];
    const [scroller, composer] = roots;

    assert.equal(roots.length, 2);
    assert.ok(scroller);
    assert.equal(scroller.type, normalThread.type, "drafts use the normal main scrolling surface");
    assert.equal(
        scroller.props.class,
        normalThread.props.class,
        "the native scroller fills the pane's spare height",
    );
    assert.ok(
        nodes(scroller).some((node) =>
            String(node.props.class).split(/\s+/).includes("transcript"),
        ),
    );
    assert.ok(composer);
    assert.equal(typeof composer.type, "function");
    assert.equal(composer.props.draft, draft);
    assert.equal(
        nodes(scroller).some((node) => node.props.draft === draft),
        false,
        "the Composer stays outside the region that scrolls when the welcome grows",
    );
});

test("the unsent draft welcome uses the selected draft's keyed avatar, not the previous saved identity", () => {
    reset();
    fixture.store.state.view.conversation.pipAgentId = "previous-agent";
    openAgentDraft("current-agent");
    const tree = AgentDraftPane();
    const avatar = avatars(tree);

    assert.equal(avatar.length, 1, "unsent welcome must mount the existing NamedAgentAvatar");
    assert.equal(avatar[0]!.props.agentId, "current-agent");
    assert.equal(avatar[0]!.props.size, 48);
    assert.equal(avatar[0]!.key, "current-agent");
    const copy = text(tree).replace(/\s+/g, " ").trim();

    assert.match(copy, /^New chat with Current Bea/);
    assert.ok(copy.includes("Memory and instructions are shared across this PiP's chats."));
    assert.ok(copy.includes("Saved to History when your first message is accepted."));
});

for (const invalid of ["closed", "unknown target"]) {
    test(`a draft with ${invalid} cannot borrow the previous saved avatar`, () => {
        reset();
        const draft = openAgentDraft("current-agent");

        if (invalid === "closed") {
            closeAgentDraft(draft.id);
        } else {
            fixture.store.state.namedAgents = fixture.store.state.namedAgents.slice(0, 1);
        }

        const tree = AgentDraftPane();

        assert.equal(avatars(tree).length, 0);
        assert.match(
            text(tree),
            invalid === "closed" ? /This draft was closed/ : /New chat with your PiP/,
        );
    });
}
