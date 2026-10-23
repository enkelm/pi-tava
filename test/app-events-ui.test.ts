// Exercise the shared transcript dispatch and disclosure, keeping unrelated browser adapters opaque.
// This is component/native-control evidence, not mounted-browser, keyboard-event or real-phone proof.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHooks } from "node:module";
import { after, test } from "node:test";
import { h, isValidElement, type VNode } from "preact";
import { projectEntry } from "../src/server/projection.ts";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";

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

function textContent(value: any): string {
    if (Array.isArray(value)) {
        return value.map(textContent).join("");
    }

    return isValidElement(value)
        ? textContent(value.props.children)
        : typeof value === "string"
          ? value
          : "";
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
        textContent(nodes(tree).find((node) => node.type === "pre")),
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

test("native assistant reports reuse the closed disclosure without losing immutable links or full evidence", () => {
    for (const [report, state] of [
        ["workItem", "reported"],
        ["thread", "reported"],
        ["helper", "reported"],
        ["helper", "held"],
    ]) {
        chosen = false;
        const entry = {
            id: 12,
            kind: "appEvent",
            event: "report",
            report,
            state,
            source: 73,
            sourceEntryId: 91,
            controllerId: 74,
            originChatId: 75,
            summary: state === "held" ? "Report held" : "Report observed",
            text: "Original evidence\n" + "unbroken".repeat(400),
        };
        let tree = render(entry);
        const button = nodes(tree).find((node) => node.type === "button")!;
        const link = nodes(tree).find((node) => node.type === "a")!;

        assert.equal(button.props["aria-expanded"], false);
        assert.equal(link.props.href, "/s/73#entry-91");
        assert.ok(!nodes(button).includes(link));
        assert.equal(tree.props["data-state"], state);
        assert.doesNotMatch(String(tree.props.class), /prompt|settled/);
        assert.ok(!nodes(tree).some((node) => node.type === "pre"));
        button.props.onClick();
        tree = render(entry);
        assert.equal(textContent(nodes(tree).find((node) => node.type === "pre")), entry.text);
        const links = nodes(tree)
            .filter((node) => node.type === "a")
            .map((node) => node.props.href);

        assert.ok(links.includes("/s/74"), "the captured controller remains navigable");
        assert.ok(links.includes("/s/75"), "the captured origin remains navigable");
    }

    chosen = false;
    const historicalEntry = {
        id: 13,
        kind: "appEvent",
        event: "report",
        report: "workItem",
        state: "reported",
        summary: "Report observed",
        text: [
            "Original source /s/37 remains in details; controller (/s/38).",
            "Exact answer /s/39#entry-91.",
            "Keep https://example.com/s/40 and /tmp/s/41.txt as evidence, not Coop links.",
            "Malformed /s/42extra /s/43/child /s/44#entry-x /s/45?query=1 stay plain.",
        ].join("\n"),
    };
    const historical = render(historicalEntry);

    assert.ok(!nodes(historical).some((node) => node.type === "a"));
    nodes(historical)
        .find((node) => node.type === "button")!
        .props.onClick();
    const expanded = render(historicalEntry);

    assert.equal(
        textContent(nodes(expanded).find((node) => node.type === "pre")),
        historicalEntry.text,
    );
    assert.deepEqual(
        nodes(expanded)
            .filter((node) => node.type === "a")
            .map((node) => node.props.href),
        ["/s/37", "/s/38", "/s/39#entry-91"],
        "only standalone, complete historical thread references become internal links",
    );
});

test("human-decision reports are prominent expanded content, never a passive disclosure", () => {
    chosen = false;
    const tree = render({
        id: 14,
        kind: "appEvent",
        event: "report",
        report: "workItem",
        state: "question",
        source: 73,
        summary: "Human decision needed",
        text: "Human decision needed: choose a scope.\nComplete context",
    });

    assert.equal(tree.props["data-part"], "app-event-question");
    assert.ok(!nodes(tree).some((node) => node.type === "button"));
    assert.ok(
        nodes(tree).some(
            (node) =>
                node.props.text === "Human decision needed: choose a scope.\nComplete context",
        ),
    );
    assert.equal(nodes(tree).find((node) => node.type === "a")!.props.href, "/s/73");
});

test("passive reports separate activity and stale thinking without resetting response timing", () => {
    chosen = false;
    const sent = Date.now() - 5000;
    const entries = [
        { id: 1, kind: "user", at: sent, text: "Earlier request" },
        {
            id: 2,
            kind: "assistant",
            stopReason: "toolUse",
            blocks: [{ type: "thinking", text: "OLD_THOUGHT" }],
        },
        { id: 3, kind: "appEvent", event: "report", at: sent + 2000, state: "reported" },
    ];

    adapter.store.state = {
        view: {
            conversation: { id: 200 },
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

    assert.equal(live.props.start, sent, "a passive observation is not a new model input");
    const status = Reflect.apply(live.type as Function, undefined, [live.props]);
    const thought = nodes(status).find((node) => node.props.id === "live-thought-200")!;
    const shown = Reflect.apply(thought.type as Function, undefined, [thought.props]);

    assert.ok(!JSON.stringify(shown).includes("OLD_THOUGHT"));
    const items = nodes(tree).find((node) => Array.isArray(node.props.items))!;
    const rendered = Reflect.apply(items.type as Function, undefined, [items.props]);
    const group = nodes(rendered).find((node) => node.props.item?.steps)!;

    assert.equal(group.props.newest, false, "the report closes the preceding activity group");
    assert.ok(items.props.items.some((item: any) => item.type === "row" && item.entry.id === 3));

    const answer = {
        id: 4,
        kind: "assistant",
        stopReason: "stop",
        blocks: [
            { type: "thinking", text: "New activity" },
            { type: "text", text: "REAL_ANSWER" },
        ],
    };

    adapter.store.state.view.order.push(answer.id);
    adapter.store.state.view.entries.set(answer.id, answer);
    const answered = nodes(Transcript()).find((node) => Array.isArray(node.props.items))!;
    const replies = answered.props.items.filter((item: any) => item.type === "reply");
    const activities = answered.props.items.filter((item: any) => item.type === "activity");

    assert.equal(activities.length, 2, "activity cannot merge across a passive report row");
    assert.equal(replies.length, 1);
    assert.equal(replies[0].entry.id, answer.id);
    assert.equal(replies[0].blocks[0].block.text, "REAL_ANSWER");
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

// Distinct browser-owned risks: real Preact state, native keyboard activation/focus, and narrow wrapping.
// Unrelated transcript adapters remain opaque; this is not a real-phone or full-app navigation claim.
test(
    "mounted passive disclosure supports native keyboard and narrow layouts",
    {
        skip: findBrowser() ? false : "No Chromium installed",
        timeout: 30_000,
    },
    async (t) => {
        const entry = {
            id: 21,
            kind: "appEvent",
            event: "report",
            report: "helper",
            state: "held",
            source: 123456789,
            summary: "Reportheld".repeat(20),
            text: "Complete evidence\n" + "unbroken".repeat(400),
        };
        const assets = new Map([
            ["/transcript.js", target],
            ["/turns.js", new URL("../web/turns.js", import.meta.url)],
            ["/style.css", new URL("../web/style.css", import.meta.url)],
            ["/preact.mjs", new URL("../node_modules/preact/dist/preact.mjs", import.meta.url)],
            ["/hooks.mjs", new URL("../node_modules/preact/hooks/dist/hooks.mjs", import.meta.url)],
            ["/htm.mjs", new URL("../node_modules/htm/dist/htm.module.js", import.meta.url)],
        ]);
        const adapters = new Map(
            [...sources]
                .filter(([name]) => name !== "preact/hooks")
                .map(([name, source]) => [new URL(name, "http://fixture/").pathname, source]),
        );
        const pageHtml = `<!doctype html><html><head>
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <script type="importmap">{"imports":{"preact":"/preact.mjs","preact/hooks":"/hooks.mjs","htm":"/htm.mjs"}}</script>
        <link rel="stylesheet" href="/style.css">
        </head><body><main id="fixture"></main><script type="module">
        import {h, render} from 'preact';
        import htm from 'htm';
        globalThis.appEventFixture = {html:htm.bind(h),store:{state:{view:{},users:[]}}};
        const {TranscriptEntry} = await import('/transcript.js');
        render(h(TranscriptEntry, {entry:${JSON.stringify(entry)},readOnly:true}), document.querySelector('#fixture'));
        globalThis.fixtureReady = true;
        </script></body></html>`;
        const server = createServer((request, response) => {
            const path = new URL(request.url ?? "/", "http://fixture/").pathname;
            const asset = assets.get(path);
            const adapter = adapters.get(path);

            response.setHeader(
                "Content-Type",
                path === "/" ? "text/html" : path === "/style.css" ? "text/css" : "text/javascript",
            );

            if (path === "/") {
                response.end(pageHtml);
            } else if (asset !== undefined) {
                response.end(readFileSync(asset));
            } else if (adapter !== undefined) {
                response.end(adapter);
            } else {
                response.writeHead(404).end();
            }
        });

        t.after(() => server.close());
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();

        assert.ok(address && typeof address !== "string");
        const directory = mkdtempSync(join(tmpdir(), "passive-event-ui-"));
        const browsers = new Browsers({ dataDir: directory });

        t.after(async () => {
            await browsers.closeAll({ final: true });
            rmSync(directory, { recursive: true, force: true });
        });
        const page = await browsers.open(1);

        await page.setViewport(VIEWPORTS.desktop);
        await page.navigate(`http://127.0.0.1:${address.port}/`);
        await page.evaluate(`const deadline = Date.now() + 5000;
        while (!globalThis.fixtureReady) {
            if (Date.now() > deadline) throw new Error('Transcript fixture did not mount');
            await new Promise(resolve => setTimeout(resolve, 20));
        }`);
        const value = async (expression: string) =>
            JSON.parse(await page.evaluate(`return JSON.stringify(${expression})`));

        assert.equal(
            await value("document.querySelector('button').getAttribute('aria-expanded')"),
            "false",
        );
        await page.press("Tab");
        assert.equal(await value("document.activeElement.tagName"), "BUTTON");
        await page.press("Enter");
        await page.evaluate("await new Promise(resolve => requestAnimationFrame(resolve))");
        assert.equal(await value("document.querySelector('pre').textContent"), entry.text);
        assert.equal(await value("document.activeElement.tagName"), "BUTTON");
        await page.press("Space");
        await page.evaluate("await new Promise(resolve => requestAnimationFrame(resolve))");
        assert.equal(
            await value("document.querySelector('button').getAttribute('aria-expanded')"),
            "false",
        );
        await page.press("Tab");
        assert.equal(await value("document.activeElement.getAttribute('href')"), "/s/123456789");

        for (const viewport of [
            VIEWPORTS.desktop,
            VIEWPORTS.mobile,
            { ...VIEWPORTS.mobile, width: 320 },
        ]) {
            await page.setViewport(viewport);
            await page.click({ selector: "button" });
            assert.equal(await value("document.documentElement.scrollWidth <= innerWidth"), true);
            assert.equal(await value("document.querySelector('pre').textContent"), entry.text);
            assert.ok(
                await value(
                    "document.querySelector('button').getBoundingClientRect().height >= 40",
                ),
            );
            await page.click({ selector: "button" });
        }
    },
);

test("agent answer stays expanded with service identity and exact source, outside passive disclosure", () => {
    const actor = { questionId: "q1", agentId: "ada", name: "Ada", chatId: 87 };
    const tree = render({ id: 10, kind: "agentAnswer", text: "Complete answer", actor });

    assert.equal(nodes(tree).find((node) => node.type === "a")!.props.href, "/s/87");
    assert.ok(!nodes(tree).some((node) => node.type === "button"));
    assert.ok(!nodes(tree).some((node) => /prompt|app-event/.test(node.props.class ?? "")));
    assert.ok(nodes(tree).some((node) => node.props.text === "Complete answer"));
});
