// The native delivered-finding index owns disclosure and original-source link intent.
// Real store navigation/access/races live in review-navigation.test.ts; this boundary checks
// actual rendered controls without a DOM, socket, generated prose parser, or production seam.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, test } from "node:test";
import { h } from "preact";

const htm = (await import(import.meta.resolve("htm"))).default;

type Props = Record<string, any>;
type Node = { type: string | ((props: Props) => unknown); props: Props };
type Mount = { slots: any[]; cursor: number; tree?: unknown; render: () => void };
let current: Mount;
const fixture = {
    html: htm.bind(h),
    store: { state: {} as Props },
    navigated: [] as Props[],
    hooks: {
        useId() {
            return `disclosure-${current.cursor++}`;
        },
        useState(initial: unknown) {
            const mount = current;
            const index = mount.cursor++;

            mount.slots[index] ??= { value: initial };

            return [
                mount.slots[index].value,
                (next: (value: unknown) => unknown) => {
                    mount.slots[index].value = next(mount.slots[index].value);
                    mount.render();
                },
            ];
        },
    },
};
const previous = Object.getOwnPropertyDescriptor(globalThis, "pipReviewerUiFixture");

Object.assign(globalThis, { pipReviewerUiFixture: fixture });
after(() => {
    if (previous) {
        Object.defineProperty(globalThis, "pipReviewerUiFixture", previous);
    } else {
        Reflect.deleteProperty(globalThis, "pipReviewerUiFixture");
    }
});
const sources: Record<string, string> = {
    "preact/hooks": "export const {useId,useState}=globalThis.pipReviewerUiFixture.hooks;",
    "./store.js": `export const {store}=globalThis.pipReviewerUiFixture;
        export const revealReviewThread=ref=>globalThis.pipReviewerUiFixture.navigated.push(ref);`,
    "./ui.js": "export const {html}=globalThis.pipReviewerUiFixture; export const Icon=()=>null;",
};

registerHooks({
    resolve(specifier, context, next) {
        const source = context.parentURL?.endsWith("/web/review-comments.js")
            ? sources[specifier]
            : undefined;

        return source === undefined
            ? next(specifier, context)
            : { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    },
});
const { DiffComments } = await import(new URL("../web/review-comments.js", import.meta.url).href);

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
          ? textOf(value.props.children)
          : "";
}

function mount(entry: Props) {
    const mount: Mount = {
        slots: [],
        cursor: 0,
        render() {
            current = mount;
            mount.cursor = 0;
            mount.tree = DiffComments({ entry });
        },
    };

    mount.render();

    return {
        render: mount.render,
        nodes: () => nodes(mount.tree),
        text: () => textOf(mount.tree),
        header: () =>
            nodes(mount.tree).find(
                (node) => node.type === "button" && "aria-expanded" in node.props,
            )!,
        list: () => nodes(mount.tree).find((node) => node.type === "ul")!,
        rows: () => nodes(mount.tree).filter((node) => node.type === "li"),
    };
}

const reference = (extra: Props = {}): Props => ({
    conversationId: 12,
    threadId: "original-discussion",
    commentId: "posted-finding",
    path: "src/changes.ts",
    side: "new",
    startLine: 8,
    line: 11,
    text: "This span loses the earlier check.",
    ...extra,
});
const entry = (id: string, diffComments?: Props[]): Props => ({
    id,
    kind: "assistant",
    stopReason: "stop",
    ...(diffComments === undefined ? {} : { diffComments }),
});

function session(conversationId: number, entries: Props[], threads: Props[] = []) {
    fixture.store.state = {
        conversationId,
        view: {
            order: entries.map((entry) => entry.id),
            entries: new Map(entries.map((entry) => [entry.id, entry])),
            reviews: { threads },
        },
    };
    fixture.navigated = [];
}

test("native disclosure follows the latest answer until manually changed, and retains that choice", () => {
    const answer = entry("manual-answer", [reference()]);

    session(12, [answer]);
    const panel = mount(answer);

    assert.equal(panel.header().props["aria-expanded"], true);
    assert.equal(panel.list().props.hidden, false);
    assert.equal(panel.header().props["aria-controls"], panel.list().props.id);
    panel.header().props.onClick();
    assert.equal(panel.header().props["aria-expanded"], false);
    assert.equal(panel.list().props.hidden, true);
    assert.deepEqual(fixture.navigated, [], "the disclosure header never navigates");
    const newer = entry("newer-answer", [reference({ commentId: "second" })]);

    fixture.store.state.view.order.push(newer.id);
    fixture.store.state.view.entries.set(newer.id, newer);
    panel.render();
    assert.equal(panel.list().props.hidden, true, "new output cannot undo a manual collapse");
    const remounted = mount(answer);

    assert.equal(remounted.list().props.hidden, true, "folding/remounting preserves manual state");
    remounted.header().props.onClick();
    remounted.render();
    assert.equal(remounted.list().props.hidden, false, "an older answer can be manually expanded");
    assert.equal(
        mount(newer).list().props.hidden,
        false,
        "a new answer starts expanded independently",
    );
    const older = entry("unopened-older", [reference()]);

    fixture.store.state.view.order.unshift(older.id);
    fixture.store.state.view.entries.set(older.id, older);
    assert.equal(
        mount(older).list().props.hidden,
        true,
        "untouched older assessments start collapsed",
    );
    remounted.header().props.onClick();
    assert.equal(remounted.list().props.hidden, true);
    session(91, [answer]);
    assert.equal(
        mount(answer).list().props.hidden,
        false,
        "a fork has its own disclosure preference",
    );
});

test("successful references render inclusive locations and local status; only their rows navigate", () => {
    const range = reference();
    const single = reference({
        threadId: "resolved-discussion",
        commentId: "single-finding",
        side: "old",
        startLine: undefined,
        line: 5,
        text: "Keep this original branch.",
    });
    const answer = entry("delivered-assessment", [range, single]);

    session(
        12,
        [answer],
        [
            { id: range.threadId, resolved: false },
            { id: single.threadId, resolved: true },
        ],
    );
    const panel = mount(answer);

    assert.match(panel.text(), /Diff comments · 2/);
    assert.match(textOf(panel.rows()[0]), /src\/changes\.ts · new lines 8–11/);
    assert.match(textOf(panel.rows()[0]), /This span loses the earlier check\./);
    assert.match(textOf(panel.rows()[0]), /Open/);
    assert.match(textOf(panel.rows()[1]), /src\/changes\.ts · old line 5/);
    assert.match(textOf(panel.rows()[1]), /Resolved/);
    panel.header().props.onClick();
    panel.header().props.onClick();
    assert.deepEqual(fixture.navigated, []);
    const rowButton = nodes(panel.rows()[0]).find((node) => node.type === "button");

    assert.ok(rowButton);
    rowButton.props.onClick();
    assert.deepEqual(
        fixture.navigated,
        [range],
        "link intent preserves original source/thread/comment identifiers",
    );
});

test("a forked assessment links to the original discussion, not a local same-ID thread", () => {
    const original = reference();
    const answer = entry("copied-assessment", [original]);

    session(91, [answer], [{ id: original.threadId, resolved: true }]);
    const panel = mount(answer);
    const statuses = panel.nodes().filter((node) => node.props.class === "diff-comment-status");

    assert.equal(
        statuses.length,
        0,
        "fork-local state cannot claim the original finding is resolved",
    );
    assert.match(panel.text(), /new lines 8–11/);
    const button = nodes(panel.rows()[0]).find((node) => node.type === "button");

    assert.ok(button);
    button.props.onClick();
    assert.equal(fixture.navigated[0]?.conversationId, 12);
    assert.equal(fixture.navigated[0]?.threadId, "original-discussion");
    assert.equal(fixture.store.state.conversationId, 91, "rendering alone does not leave the fork");
});

test("answers without successful comment references have no disclosure or navigation control", () => {
    for (const answer of [entry("ordinary-answer"), entry("no-posted-findings", [])]) {
        session(12, [answer]);
        const panel = mount(answer);

        assert.deepEqual(panel.nodes(), []);
        assert.equal(panel.text(), "");
        assert.deepEqual(fixture.navigated, []);
    }
});
