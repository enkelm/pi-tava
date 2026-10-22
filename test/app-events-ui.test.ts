// Exercise the shared transcript dispatch and disclosure, keeping unrelated browser adapters opaque.
// This is component/native-control evidence, not mounted-browser, keyboard-event or real-phone proof.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { after, test } from "node:test";
import { h, isValidElement, type VNode } from "preact";
import { projectEntry } from "../src/server/projection.ts";
import type { EntryRecord } from "@earendil-works/pi-durable";

const html = (await import(import.meta.resolve("htm"))).default.bind(h);
let chosen = false;
const adapter = {
    html,
    store: { state: { view: {}, users: [] } as Record<string, any> },
    useMemo: (read: () => unknown) => read(),
    isRow: () => true,
    fromServer: (at: number) => at,
    prefs: () => ({ showThinking: true }),
    useState: () => [
        chosen,
        (next: boolean) => {
            chosen = next;
        },
    ],
};
const globals = {
    appEventFixture: adapter,
    document: new EventTarget(),
    matchMedia: () => ({ matches: false }),
};
const previous = Object.keys(globals).map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
);

for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
}

// Derive adapter exports from import declarations, not from behavior under test. Imported components
// remain opaque VNodes; only the real shared TranscriptEntry and its own children are evaluated.
const target = new URL("../web/transcript.js", import.meta.url);
const sources = new Map<string, string>();

for (const match of readFileSync(target, "utf8").matchAll(
    /import\s*\{([^}]+)\}\s*from\s*"([^"]+)"/g,
)) {
    const names = match[1]!
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);

    if (["preact", "./turns.js"].includes(match[2]!)) {
        continue;
    }

    sources.set(
        match[2]!,
        names
            .map((name) => {
                if (
                    [
                        "html",
                        "store",
                        "useState",
                        "useMemo",
                        "isRow",
                        "fromServer",
                        "prefs",
                    ].includes(name)
                ) {
                    return `export const ${name} = globalThis.appEventFixture.${name};`;
                }

                if (name === "useRef") {
                    return "export const useRef = current => ({current});";
                }

                return `export const ${name} = () => null;`;
            })
            .join("\n"),
    );
}

const linker = registerHooks({
    resolve(specifier, context, next) {
        const source = context.parentURL === target.href ? sources.get(specifier) : undefined;

        return source === undefined
            ? next(specifier, context)
            : {
                  url: `data:text/javascript,${encodeURIComponent(source)}`,
                  shortCircuit: true,
              };
    },
});
const { TranscriptEntry, Transcript } = await import(target.href);

after(() => {
    linker.deregister();

    for (const [key, descriptor] of previous) {
        if (descriptor) {
            Object.defineProperty(globalThis, key, descriptor);
        } else {
            Reflect.deleteProperty(globalThis, key);
        }
    }
});

type Node = VNode<Record<string, any>>;

function nodes(value: any): Node[] {
    if (Array.isArray(value)) {
        return value.flatMap(nodes);
    }

    return isValidElement(value) ? [value as Node, ...nodes(value.props.children)] : [];
}

function render(entry: unknown): Node {
    const vnode = TranscriptEntry({ entry, readOnly: true });

    assert.ok(
        isValidElement(vnode),
        "the projected native entry must remain a visible transcript row",
    );

    return typeof vnode.type === "function"
        ? Reflect.apply(vnode.type, undefined, [vnode.props])
        : vnode;
}

const native = (marker: unknown) =>
    projectEntry({
        id: 9,
        conversationId: 1,
        kind: "pi.user",
        model: [
            {
                role: "user",
                content: [
                    {
                        type: "text",
                        text: "Full technical details\nDo not infer success.",
                        pocketAppEvent: marker,
                    },
                ],
            },
        ],
    } as unknown as EntryRecord);

test("native wake is a collapsed non-human step with exact independent link and inspectable details", () => {
    chosen = false;
    const entry = native({
        kind: "workItem",
        source: 73,
        state: "idle",
        fingerprint: "f".repeat(64),
    });
    let tree = render(entry);
    const button = nodes(tree).find((node) => node.type === "button")!;
    const link = nodes(tree).find((node) => node.type === "a")!;

    assert.equal(button.props["aria-expanded"], false);
    assert.equal(button.props.type, "button");
    assert.equal(link.props.href, "/s/73");
    assert.ok(!nodes(button).includes(link), "source link is not nested in the disclosure button");
    assert.ok(!nodes(tree).some((node) => node.type === "pre"));
    assert.doesNotMatch(String(tree.props.class), /prompt|settled/);
    button.props.onClick();
    tree = render(entry);
    assert.equal(nodes(tree).find((node) => node.type === "button")!.props["aria-expanded"], true);
    assert.equal(
        nodes(tree).find((node) => node.type === "pre")!.props.children,
        "Full technical details\nDo not infer success.",
    );
    nodes(tree)
        .find((node) => node.type === "button")!
        .props.onClick();
    assert.equal(
        nodes(render(entry)).find((node) => node.type === "button")!.props["aria-expanded"],
        false,
    );
});

test("native service inputs start a fresh thinking, timing and activity turn in the shared transcript", () => {
    chosen = false;
    const sent = Date.now() - 2000;

    for (const [index, kind] of ["user", "appEvent", "agentAnswer"].entries()) {
        const entries = [
            { id: 1, kind: "user", at: sent - 5000, text: "Earlier request" },
            {
                id: 2,
                kind: "assistant",
                stopReason: "stop",
                blocks: [{ type: "thinking", text: "OLD_THOUGHT" }],
            },
            { id: 3, kind, at: sent, text: "New input", actor: {}, source: 73, state: "idle" },
        ];

        adapter.store.state = {
            view: {
                conversation: { id: 100 + index },
                order: entries.map((entry) => entry.id),
                entries: new Map(entries.map((entry) => [entry.id, entry])),
                live: { busy: true },
            },
            transcriptFrom: null,
            users: [],
            sessions: [],
        };
        const tree = Transcript();
        const live = nodes(tree).find((node) => node.props.live?.busy)!;

        assert.ok(live, `${kind} retains the real live-status component`);
        assert.equal(live.props.start, sent, `${kind} uses its own native input timestamp`);
        const status = Reflect.apply(live.type as Function, undefined, [live.props]);
        const thought = nodes(status).find(
            (node) => node.props.id === `live-thought-${100 + index}`,
        )!;
        const shown = Reflect.apply(thought.type as Function, undefined, [thought.props]);

        assert.ok(
            nodes(shown).some(
                (node) => node.props.children === "No thinking text shared for this response.",
            ),
        );
        assert.ok(
            !JSON.stringify(shown).includes("OLD_THOUGHT"),
            `${kind} cannot inherit prior-turn thinking`,
        );
        const items = nodes(tree).find((node) => Array.isArray(node.props.items))!;
        const rendered = Reflect.apply(items.type as Function, undefined, [items.props]);
        const group = nodes(rendered).find((node) => node.props.item?.steps)!;

        assert.equal(group.props.newest, false, `${kind} closes the prior activity turn`);
    }
});

test("agent answer stays expanded with service identity and exact source, outside passive disclosure", () => {
    const actor = { questionId: "q1", agentId: "ada", name: "Ada", chatId: 87 };
    const tree = render({ id: 10, kind: "agentAnswer", text: "Complete answer", actor });

    assert.equal(nodes(tree).find((node) => node.type === "a")!.props.href, "/s/87");
    assert.ok(!nodes(tree).some((node) => node.type === "button"));
    assert.ok(!nodes(tree).some((node) => /prompt|app-event/.test(node.props.class ?? "")));
    assert.ok(nodes(tree).some((node) => node.props.text === "Complete answer"));
});
