import {
    type App,
    cleanUp,
    newSession,
    openApp,
    root,
    say,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let first: ConversationId;
/** A session whose reply has selectable prose and a code block. */
let rich: ConversationId;
/** A conversation taller than the screen, for the overscroll contract. */
let long: ConversationId;

/** Run a script in the page and read back the JSON it returns. */
async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

type Where = {
    path: string;
    layers: number;
    sheet: string | null;
    files: boolean;
    file: string | null;
};

/** Where the app is: its address, how many layers its history entry stands for, and what is open. */
const where = () =>
    inPage<Where>(`
        const { store } = await import("/store.js");

        return JSON.stringify({
            path: location.pathname,
            layers: history.state?.pocket?.layers ?? 0,
            sheet: store.state.sheet?.type ?? null,
            files: document.querySelector(".files-tile:not(.leaving)") !== null,
            file: document.querySelector(".ft-view:not(.leaving) .ft-view-name")?.textContent ?? null,
        });
    `);

/** Wait until the app is where `expected` says, in the fields it names. */
async function reach(expected: Partial<Where>, what: string): Promise<void> {
    let last: Where | undefined;

    try {
        await until(async () => {
            last = await where();

            return Object.entries(expected).every(
                ([key, value]) => last![key as keyof Where] === value,
            );
        }, what);
    } catch {
        assert.fail(`${what}: the app is at ${JSON.stringify(last)}`);
    }
}

/** Back, as a phone's back gesture or button does it. */
const back = () => page.evaluate(`history.back()`);

const tap = async (selector: string) => {
    await until(
        async () =>
            (await inPage<boolean>(
                `return JSON.stringify(document.querySelector(${JSON.stringify(selector)}) !== null)`,
            )) === true,
        selector,
    );
    await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
};

const row = (id: ConversationId) => `.home-list .session-row[data-id="${id}"] .session`;

/** Open the Files tile from the menu's tiles, where the top bar keeps it while it is closed. */
async function openFiles(): Promise<void> {
    await tap('.topbar [aria-label="Menu"]');
    await reach({ sheet: "menu" }, "the menu");
    await tap('.place[data-place="files"]');
}

/** The session list, freshly loaded at phone size with no panel open: each test starts from here. */
async function fresh(): Promise<void> {
    await page.setViewport(VIEWPORTS.mobile);
    await page.evaluate(`
        for (const key of Object.keys(sessionStorage)) {
            if (/^pocket\.(files|browser|panels)/.test(key)) {
                sessionStorage.removeItem(key);
            }
        }
    `);
    await page.navigate(`${base}/`);
    await until(
        async () =>
            (await inPage<boolean>(
                `return JSON.stringify(document.querySelector(${JSON.stringify(row(first))}) !== null)`,
            )) === true,
        "the session list",
        20_000,
    );
}

/** Go to a session from inside the app, as a peek tile or a subagent's link does. */
const goTo = (id: ConversationId) =>
    page.evaluate(`(await import("/store.js")).navigate(${Number(id)})`);

/** Past a route's slide: the screen rests where a finger finds it. */
const slid = () =>
    until(
        async () =>
            (await inPage<boolean>(
                `return JSON.stringify(document.documentElement.dataset.route === undefined)`,
            )) === true,
        "the slide's end",
    );

before(async () => {
    if (chromium === undefined) {
        return;
    }

    writeFileSync(join(work, "README.md"), "# Hello\n\nA file to read.\n");
    writeFileSync(join(work, "web.env"), "PORT=3000\nHOST=127.0.0.1\n");
    // The Changes-filter font regression needs an actual changed checkout, not invented DOM.
    const git = (...args: string[]) =>
        execFileSync("git", ["-C", work, "-c", "user.name=T", "-c", "user.email=t@t.t", ...args]);

    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-qm", "Start");
    writeFileSync(join(work, "README.md"), "# Hello\n\nA file to read, changed.\n");
    app = await openApp(scriptedModel());
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "mobile-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    first = await newSession(app);
    rich = await newSession(app);
    await say(
        app,
        rich,
        ["Selectable prose and code:", "", "```ts", "export const answer = 42;", "```"].join("\n"),
    );
    long = await newSession(app);

    for (let turn = 1; turn <= 6; turn++) {
        await say(
            app,
            long,
            Array.from({ length: 20 }, (_, line) => `- Turn ${turn}, line ${line + 1}`).join("\n"),
        );
    }

    page = await browsers.open(1);
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await until(
        async () =>
            (await inPage<boolean>(
                `return JSON.stringify(document.querySelector(${JSON.stringify(row(first))}) !== null)`,
            )) === true,
        "the session list",
        20_000,
    );
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

/** Visible feedback, not declarations: these properties can change without moving a control. */
const feedback = (selector: string) =>
    inPage<Record<string, string>>(`
        const style = getComputedStyle(document.querySelector(${JSON.stringify(selector)}));

        return JSON.stringify(Object.fromEntries(
            ["backgroundColor", "borderColor", "color", "transform"].map((key) => [key, style[key]]),
        ));
    `);

const pauseFeedback = () => new Promise((resolve) => setTimeout(resolve, 220));

test("mobile-native inputs stay at least 16px across text preferences", real, async (t) => {
    await fresh();
    const original = await inPage<number>(
        `return JSON.stringify((await import('/theme.js')).prefs().text)`,
    );
    const measurements: {
        control: string;
        text: number;
        preference: number;
        root: number;
        font: number;
        visible: boolean;
    }[] = [];

    const measure = async (control: string, selector: string, text: number) => {
        measurements.push(
            await inPage(`
                const input = document.querySelector(${JSON.stringify(selector)});
                const rect = input.getBoundingClientRect();

                return JSON.stringify({ control: ${JSON.stringify(control)}, text: ${text},
                    preference: (await import('/theme.js')).prefs().text,
                    root: parseFloat(getComputedStyle(document.documentElement).fontSize),
                    font: parseFloat(getComputedStyle(input).fontSize),
                    visible: rect.width > 0 && rect.height > 0 });
            `),
        );
    };

    const conversation = async () => {
        await fresh();
        await tap(row(first));
        await slid();
    };

    try {
        assert.equal(
            await inPage<boolean>(`return JSON.stringify(matchMedia('(pointer: coarse)').matches)`),
            true,
        );

        for (const text of [12, 13, 14, 15, 16]) {
            // Exercise persisted initial typography, not live resizing of an already mounted diff.
            await fresh();
            await page.evaluate(`(await import('/theme.js')).setPrefs({ text: ${text} })`);
            await fresh();
            await tap(row(first));
            await slid();
            await measure("Composer", ".composer textarea", text);

            await conversation();
            await page.evaluate(
                `(await import('/store.js')).openSheet({ type: 'cwd', mode: 'change' })`,
            );
            await tap(".dir-tools .button");
            await until(
                async () =>
                    await inPage<boolean>(`
                        return JSON.stringify(document.activeElement === document.querySelector('.new-folder input'));
                    `),
                "New folder autofocus",
            );
            await measure("New folder", ".new-folder input", text);

            await conversation();
            await page.evaluate(`(await import('/files-panel.js')).setFilesOpen(true, 'files')`);
            await tap(".ft-filter");
            await measure("Go to file", ".ft-filter", text);

            await conversation();
            await page.evaluate(`(await import('/files-panel.js')).setFilesOpen(true, 'changes')`);
            await tap(".dr-filter");
            await measure("Changes filter", ".dr-filter", text);

            await fresh();
            await page.evaluate(`(await import('/store.js')).store.set({ launcher: true })`);
            await tap(".launcher-input input");
            await measure("Launcher", ".launcher-input input", text);
        }

        t.diagnostic(JSON.stringify(measurements));

        for (const measured of measurements) {
            assert.equal(
                measured.preference,
                measured.text,
                "production preference survives reload",
            );
            assert.equal(
                measured.root,
                measured.text,
                "initial root typography uses the preference",
            );
            assert.ok(
                measured.visible && measured.font >= 16,
                `${measured.control} at text ${measured.text}: ${measured.font}px, visible=${measured.visible}`,
            );
        }
    } finally {
        await fresh();
        await page.evaluate(`(await import('/theme.js')).setPrefs({ text: ${original} })`);
        await fresh();
    }
});

test(
    "mobile-native hover is capability-gated while keyboard focus stays visible",
    real,
    async (t) => {
        for (const mobile of [false, true]) {
            await t.test(mobile ? "coarse pointer" : "desktop pointer", async () => {
                await fresh();
                await tap(row(first));
                await page.setViewport({ ...VIEWPORTS.mobile, mobile });
                await slid();
                assert.equal(
                    await inPage<boolean>(`
                return JSON.stringify(matchMedia('(hover: hover) and (pointer: fine)').matches);
            `),
                    !mobile,
                );
                const results = [];

                for (const selector of [
                    '.topbar [aria-label="Menu"]',
                    ".topbar .title",
                    ".model-chip",
                ]) {
                    await page.input([{ type: "mouse", action: "move", x: 1, y: 400 }]);
                    await pauseFeedback();
                    const idle = await feedback(selector);

                    await page.hover({ selector });
                    await pauseFeedback();
                    assert.equal(
                        await inPage<boolean>(`
                    return JSON.stringify(document.querySelector(${JSON.stringify(selector)}).matches(':hover'));
                `),
                        true,
                        "trusted mouse movement reaches CSS hover even under touch emulation",
                    );
                    results.push({ selector, idle, hovered: await feedback(selector) });
                }

                await page.input([{ type: "mouse", action: "move", x: 1, y: 400 }]);
                await page.press("Tab");
                await page.evaluate(
                    `document.querySelector('.topbar [aria-label="Menu"]').focus()`,
                );
                assert.equal(
                    await inPage<boolean>(`
                const control = document.activeElement;
                const style = getComputedStyle(control);

                return JSON.stringify(control.matches(':focus-visible') &&
                    style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0);
            `),
                    true,
                    "keyboard focus feedback does not depend on hover capability",
                );

                for (const { selector, idle, hovered } of results) {
                    if (mobile) {
                        assert.deepEqual(
                            hovered,
                            idle,
                            `${selector}: no hover-only feedback on coarse pointers`,
                        );
                    } else {
                        assert.notDeepEqual(
                            hovered,
                            idle,
                            `${selector}: desktop hover feedback remains`,
                        );
                    }
                }
            });
        }
    },
);

test("mobile-native title and model chip respond during a trusted held press", real, async (t) => {
    await fresh();
    await tap(row(first));
    await slid();

    for (const selector of [
        ".topbar .title",
        ".model-chip",
        '.composer button[aria-label="Send"]',
    ]) {
        await t.test(selector, async () => {
            await page.input([{ type: "mouse", action: "move", x: 1, y: 400 }]);
            await pauseFeedback();
            const idle = await feedback(selector);
            const disabled = await inPage<boolean>(`
                return JSON.stringify(document.querySelector(${JSON.stringify(selector)}).disabled);
            `);
            const at = await page.locate({ selector });

            await page.input([{ type: "mouse", action: "move", ...at }]);
            await pauseFeedback();
            const beforePress = await feedback(selector);

            try {
                await page.input([{ type: "mouse", action: "down", ...at }]);
                await pauseFeedback();

                if (disabled) {
                    assert.deepEqual(
                        await feedback(selector),
                        beforePress,
                        "disabled Send does not look pressed",
                    );
                } else {
                    assert.equal(
                        await inPage<boolean>(`
                        return JSON.stringify(document.querySelector(${JSON.stringify(selector)}).matches(':active'));
                    `),
                        true,
                        "CDP mousePressed creates an actual CSS active state",
                    );
                    assert.notDeepEqual(
                        await feedback(selector),
                        beforePress,
                        "feedback changes before release",
                    );
                }
            } finally {
                // Release away from the target: do not open its menu or send anything.
                await page.input([
                    { type: "mouse", action: "move", x: 1, y: 400, pressed: true },
                    { type: "mouse", action: "up", x: 1, y: 400 },
                ]);
                await pauseFeedback();
                assert.deepEqual(await feedback(selector), idle, "feedback returns after release");
                assert.equal(
                    await inPage<boolean>(`
                    return JSON.stringify(document.querySelector(${JSON.stringify(selector)}).disabled);
                `),
                    disabled,
                    "press does not change eligibility",
                );
                await reach({ sheet: null }, "no accidental activation");
            }
        });
    }
});

test("mobile-native touch defaults preserve content selection and pinch zoom", real, async (t) => {
    await fresh();
    await goTo(rich);
    await tap(".md pre code");
    await slid();
    const platform = await inPage<{
        viewport: string;
        controls: { selector: string; select: string; touch: string; highlight: string }[];
        content: { selector: string; select: string; touch: string; selected: boolean }[];
    }>(`
        const controls = ['.topbar .title', '.model-chip', '.code-head .copy'].map((selector) => {
            const style = getComputedStyle(document.querySelector(selector));

            return { selector, select: style.userSelect, touch: style.touchAction,
                highlight: style.webkitTapHighlightColor };
        });
        const content = ['.md p', '.md pre code', '.bubble .user-text'].map((selector) => {
            const element = document.querySelector(selector);
            const style = getComputedStyle(element);
            const range = document.createRange();

            range.selectNodeContents(element);
            getSelection().removeAllRanges();
            getSelection().addRange(range);

            return { selector, select: style.userSelect, touch: style.touchAction,
                selected: getSelection().toString().length > 0 };
        });

        getSelection().removeAllRanges();

        return JSON.stringify({ viewport: document.querySelector('meta[name="viewport"]').content,
            controls, content });
    `);

    await t.test("content and viewport remain accessible", async () => {
        assert.doesNotMatch(
            platform.viewport,
            /user-scalable\s*=\s*(no|0)|maximum-scale\s*=\s*1(?:[\s,]|$)/i,
        );

        for (const content of platform.content) {
            assert.notEqual(
                content.select,
                "none",
                `${content.selector}: content remains selectable`,
            );
            assert.equal(content.selected, true);
            assert.notEqual(
                content.touch,
                "none",
                `${content.selector}: content is not a gesture lock`,
            );
        }
    });
    await t.test("controls have touch defaults", async () => {
        for (const control of platform.controls) {
            assert.equal(
                control.select,
                "none",
                `${control.selector}: controls do not select their labels`,
            );
            assert.ok(
                control.touch === "manipulation" || control.touch.includes("pinch-zoom"),
                `${control.selector}: taps preserve pinch zoom (${control.touch})`,
            );
            assert.equal(control.highlight, "rgba(0, 0, 0, 0)");
        }
    });
});

test(
    "mobile-native scroll containers contain vertical overscroll without blocking navigation",
    real,
    async () => {
        await fresh();
        const policies: { selector: string; policy: string }[] = [];
        const record = async (selectors: string[]) =>
            policies.push(
                ...(await inPage<{ selector: string; policy: string }[]>(`
        return JSON.stringify(${JSON.stringify(selectors)}.map((selector) => ({ selector,
            policy: getComputedStyle(document.querySelector(selector)).overscrollBehaviorY })));
    `)),
            );

        await record(["html", "body", ".home-list .session-items"]);
        await goTo(long);
        await slid();
        await record([".pane > .scroller"]);
        await page.evaluate(`document.querySelector('.pane > .scroller').scrollTop = 0`);
        await until(
            async () =>
                await inPage<boolean>(`
        return JSON.stringify(document.querySelector('.pane > .scroller').scrollTop === 0);
    `),
            "ordinary scrolling still works",
        );
        await tap('.topbar [aria-label="Menu"]');
        await reach({ sheet: "menu", layers: 1 }, "ordinary sheet");
        await record([".sheet-body"]);
        await back();
        await reach({ sheet: null, layers: 0 }, "Back dismisses the sheet");
        await page.evaluate(`(await import('/store.js')).store.set({ launcher: true })`);
        await tap(".launcher-input input");
        await record([".launcher-list"]);
        await back();
        await until(
            async () =>
                await inPage<boolean>(`
        return JSON.stringify((await import('/store.js')).store.state.launcher === false);
    `),
            "Back dismisses the launcher",
        );

        for (const { selector, policy } of policies) {
            assert.ok(
                selector === "html" || selector === "body"
                    ? policy === "none"
                    : ["contain", "none"].includes(policy),
                `${selector}: vertical overscroll is isolated (${policy})`,
            );
        }
    },
);

test(
    "mobile-native horizontal safe areas protect edge controls without nested padding",
    real,
    async (t) => {
        for (const [width, height] of [
            [390, 844],
            [844, 390],
            [320, 700],
        ] as const) {
            await t.test(`${width}x${height}`, async () => {
                await fresh();
                await page.setViewport({ ...VIEWPORTS.mobile, width, height });
                await page.evaluate(`
                document.documentElement.style.setProperty('--safe-left', '28px');
                document.documentElement.style.setProperty('--safe-right', '44px');
            `);
                const boxes: { selector: string; left: number; right: number; owned: boolean }[] =
                    [];
                let popup: { left: number; right: number; width: number; padding: string[] };

                const measure = async (selectors: string[]) => {
                    await pauseFeedback();
                    boxes.push(
                        ...(await inPage<typeof boxes>(`
                    return JSON.stringify(${JSON.stringify(selectors)}.map((selector) => {
                        const element = document.querySelector(selector);
                        const box = element.getBoundingClientRect();
                        const at = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);

                        return { selector, left: box.left, right: box.right,
                            owned: at === element || element.contains(at) };
                    }));
                `)),
                    );
                    assert.equal(
                        await inPage<boolean>(
                            `return JSON.stringify(document.documentElement.scrollWidth <= innerWidth)`,
                        ),
                        true,
                    );
                };

                try {
                    await measure([".home-list .search input", ".home-list .new-button"]);
                    await tap(row(first));
                    await slid();
                    await measure([
                        ".topbar-back",
                        '.topbar [aria-label="Menu"]',
                        ".composer textarea",
                        ".model-chip",
                    ]);
                    const popupGeometry = () =>
                        inPage<{ left: number; right: number; width: number; padding: string[] }>(`
                    const menu = document.querySelector('[role="dialog"][aria-label="Model"]');
                    const rect = menu.getBoundingClientRect();
                    const style = getComputedStyle(menu);

                    return JSON.stringify({ left: rect.left, right: rect.right, width: rect.width,
                        padding: [style.paddingLeft, style.paddingRight] });
                `);

                    await tap(".model-chip");
                    await reach({ sheet: "model" }, "model popup from its real chip");
                    await new Promise((resolve) => setTimeout(resolve, 400));
                    popup = await popupGeometry();
                    await back();
                    await reach({ sheet: null }, "model popup dismissed");

                    if (width === 844) {
                        // There is room for an ordinary anchored popup in landscape: safe tokens should
                        // clamp its exterior, not consume its interior with another layer of padding.
                        await until(
                            async () =>
                                await inPage<boolean>(`
                        return JSON.stringify(document.querySelector('[role="dialog"][aria-label="Model"]') === null);
                    `),
                            "model popup unmounted",
                        );
                        await page.evaluate(`
                        document.documentElement.style.setProperty('--safe-left', '0px');
                        document.documentElement.style.setProperty('--safe-right', '0px');
                    `);
                        await tap(".model-chip");
                        await reach({ sheet: "model" }, "ordinary anchored popup");
                        await new Promise((resolve) => setTimeout(resolve, 400));
                        const ordinary = await popupGeometry();

                        assert.deepEqual(
                            popup.padding,
                            ordinary.padding,
                            "a safely anchored popup has no extra interior safe padding",
                        );
                        assert.equal(
                            popup.width,
                            ordinary.width,
                            "landscape preserves ordinary popup width when it fits",
                        );
                        await back();
                        await reach({ sheet: null }, "ordinary popup dismissed");
                        await page.evaluate(`
                        document.documentElement.style.setProperty('--safe-left', '28px');
                        document.documentElement.style.setProperty('--safe-right', '44px');
                    `);
                    }

                    await page.evaluate(
                        `(await import('/files-panel.js')).setFilesOpen(true, 'files')`,
                    );
                    await reach({ files: true }, "Files");
                    await new Promise((resolve) => setTimeout(resolve, 400));
                    await measure([".files-back", ".ft-filter"]);
                    await tap('.ft-row[data-path$="/README.md"]');
                    await reach({ file: "README.md" }, "file over the tree");
                    await new Promise((resolve) => setTimeout(resolve, 400));
                    await measure([
                        ".ft-view-head .icon-button",
                        '.ft-view .file-tools [title^="Mention"]',
                    ]);
                    // Landscape can show tree and file side by side, where the file is not a Back layer.
                    await tap(".ft-view-head .icon-button");
                    await reach({ file: null, layers: 1 }, "file dismissed");
                    await back();
                    await reach({ files: false }, "Files dismissed");
                    await tap('.topbar [aria-label="Menu"]');
                    await reach({ sheet: "menu" }, "ordinary sheet");
                    await new Promise((resolve) => setTimeout(resolve, 400));
                    await measure(['.sheet-head [aria-label="Close"]', ".sheet-body .list-item"]);
                    await back();
                    await reach({ sheet: null }, "sheet dismissed");
                    await page.evaluate(
                        `(await import('/store.js')).store.set({ launcher: true })`,
                    );
                    await tap(".launcher-input input");
                    await new Promise((resolve) => setTimeout(resolve, 400));
                    await measure([".launcher-input input"]);

                    t.diagnostic(JSON.stringify({ width, height, popup, boxes }));
                    assert.ok(
                        popup.left >= 35 && popup.right <= width - 51,
                        `opened model popup respects asymmetric insets plus its 8px margins: ${JSON.stringify(popup)}`,
                    );

                    for (const box of boxes) {
                        assert.ok(
                            box.left >= 27 && box.right <= width - 43 && box.owned,
                            `${box.selector} inside safe rectangle and reachable: ${JSON.stringify(box)}`,
                        );
                    }

                    for (const selector of [
                        ".topbar-back",
                        ".files-back",
                        ...(width < 640 ? [".ft-view-head .icon-button"] : []),
                    ]) {
                        const box = boxes.find((box) => box.selector === selector)!;

                        assert.ok(
                            box.left < 52,
                            `${selector}: inset is not applied twice (${box.left}px)`,
                        );
                    }
                } finally {
                    await page.evaluate(`
                    document.documentElement.style.removeProperty('--safe-left');
                    document.documentElement.style.removeProperty('--safe-right');
                `);
                }
            });
        }

        await t.test("zero insets keep desktop tiling unchanged", async () => {
            await fresh();
            await page.setViewport(VIEWPORTS.desktop);
            await goTo(first);
            await slid();
            const layout = () =>
                inPage<[number, number, number, number, number, number]>(`
            return JSON.stringify(['.sidebar', '.pane'].flatMap((selector) => {
                const box = document.querySelector(selector).getBoundingClientRect();

                return [box.left, box.right, box.width];
            }));
        `);
            const ordinary = await layout();

            await page.evaluate(`
            document.documentElement.style.setProperty('--safe-left', '0px');
            document.documentElement.style.setProperty('--safe-right', '0px');
        `);
            assert.deepEqual(
                await layout(),
                ordinary,
                "zero tokens do not change ordinary window widths or gaps",
            );
            assert.ok(
                ordinary[0] > 0 && ordinary[3] > ordinary[1],
                "desktop window borders retain their gap",
            );
            await page.evaluate(`
            document.documentElement.style.removeProperty('--safe-left');
            document.documentElement.style.removeProperty('--safe-right');
        `);
        });
    },
);

test("a session opened from the list: back goes back to the list", real, async () => {
    await fresh();
    await tap(row(first));
    await reach({ path: `/s/${first}`, layers: 0 }, "the session");
    await back();
    await reach({ path: "/" }, "the list");
});

test("back closes the open file, then the Files tile, then leaves the session", real, async () => {
    await fresh();
    await tap(row(first));
    await reach({ path: `/s/${first}` }, "the session");
    await openFiles();
    await reach({ files: true, layers: 1 }, "the Files tile");
    await tap('.ft-row[data-path$="/README.md"]');
    await reach({ file: "README.md", layers: 2 }, "the file, over the tree");

    await back();
    await reach({ files: true, file: null, layers: 1 }, "back to the tree");
    await back();
    await reach({ files: false, layers: 0, path: `/s/${first}` }, "back to the conversation");
    await back();
    await reach({ path: "/" }, "back to the list");
});

test(
    "Settings combines appearance and providers behind the rightmost footer button",
    real,
    async () => {
        await fresh();
        await page.setViewport(VIEWPORTS.desktop);
        await tap(".sidebar .foot-tile:last-child");
        await reach({ sheet: "settings", layers: 1 }, "Settings from the footer");
        const layout = await inPage<{
            footer: string[];
            dialogs: number;
            sidebar: boolean;
            appearance: boolean;
        }>(`
        const tabs = document.querySelector('[role="tablist"][aria-label="Settings categories"]');
        const panel = document.querySelector('[role="tabpanel"]:not([hidden])');

        return JSON.stringify({
            footer: [...document.querySelectorAll('.sidebar .foot-tile')].map((each) => each.textContent.trim()),
            dialogs: document.querySelectorAll('[role="dialog"][aria-label="Settings"]').length,
            sidebar: tabs.getBoundingClientRect().right <= panel.getBoundingClientRect().left,
            appearance: panel.textContent.includes('Layout and motion'),
        });
    `);

        assert.equal(layout.footer.at(-1), "Settings");
        assert.ok(!layout.footer.includes("Providers") && !layout.footer.includes("Theme"));
        assert.equal(layout.dialogs, 1);
        assert.equal(layout.sidebar, true, "categories sit beside the content on desktop");
        assert.equal(layout.appearance, true);

        await tap('[role="tab"][aria-controls="settings-panel-providers"]');
        await until(
            async () =>
                await inPage<boolean>(`
                return JSON.stringify(document.querySelector('#settings-panel-providers .provider') !== null);
            `),
            "the provider list",
        );
        await page.evaluate(`
        const search = document.querySelector('[aria-label="Search providers"]');

        search.value = 'no-provider-with-this-name';
        search.dispatchEvent(new Event('input', { bubbles: true }));
    `);
        await until(
            async () =>
                await inPage<boolean>(`
                return JSON.stringify(document.querySelector('#settings-panel-providers [role="status"]')?.textContent.includes('No matching providers') === true);
            `),
            "no matching providers",
        );
        await tap('[role="tab"][aria-controls="settings-panel-appearance"]');
        await tap('[role="tab"][aria-controls="settings-panel-providers"]');
        assert.equal(
            await inPage<string>(`
            return JSON.stringify(document.querySelector('[aria-label="Search providers"]').value);
        `),
            "no-provider-with-this-name",
            "switching tabs keeps the provider search",
        );
        await reach({ sheet: "settings", layers: 1 }, "tabs stay within one popup and back step");
        await page.press("Escape");
        await reach({ sheet: null, layers: 0 }, "Settings closed");
    },
);

test(
    "Settings tabs fit a phone, support keyboard navigation, and back returns to the menu",
    real,
    async () => {
        await fresh();
        await tap(row(first));
        await tap('.topbar [aria-label="Menu"]');
        await page.evaluate(`
        [...document.querySelectorAll('.sheet .list-item')].find((each) => each.querySelector('span')?.textContent === 'Settings').click();
    `);
        await reach({ sheet: "settings", layers: 2 }, "Settings from the menu");
        await page.evaluate(
            `document.querySelector('[role="tab"][aria-controls="settings-panel-appearance"]').focus()`,
        );
        await page.press("ArrowRight");
        assert.equal(
            await inPage<string>(`
            return JSON.stringify(document.activeElement.textContent.trim());
        `),
            "Providers",
        );
        assert.equal(
            await inPage<boolean>(`
            const tabs = document.querySelector('[role="tablist"][aria-label="Settings categories"]');
            const panel = document.querySelector('[role="tabpanel"]:not([hidden])');
            const sheet = document.querySelector('[role="dialog"][aria-label="Settings"]');

            return JSON.stringify(
                tabs.getAttribute('aria-orientation') === 'horizontal' &&
                tabs.getBoundingClientRect().bottom <= panel.getBoundingClientRect().top &&
                sheet.getBoundingClientRect().left >= 0 &&
                sheet.getBoundingClientRect().right <= innerWidth &&
                panel.scrollWidth <= panel.clientWidth
            );
        `),
            true,
            "phone tabs sit above the content without horizontal overflow",
        );
        await page.press("ArrowLeft");
        assert.equal(
            await inPage<string>(
                `return JSON.stringify(document.activeElement.textContent.trim());`,
            ),
            "Appearance",
        );
        await reach({ sheet: "settings", layers: 2 }, "switching tabs adds no back steps");
        await back();
        await reach({ sheet: "menu", layers: 1 }, "back to the menu");
        await back();
        await reach({ sheet: null, layers: 0, path: `/s/${first}` }, "back to the conversation");
    },
);

test(
    "PiP settings pick independent models and nested Back keeps the settings page open",
    real,
    async () => {
        // HTTP model independence belongs to pip-settings.test.ts. This owns routing the real picker
        // to each setting (not the open coding thread), mobile fit, and its separate Back layer.
        await fresh();
        await tap(row(first));
        await tap('.topbar [aria-label="Menu"]');
        await page.evaluate(`
            [...document.querySelectorAll('.sheet .list-item')].find((each) => each.querySelector('span')?.textContent === 'Settings').click();
        `);
        await tap("#settings-tab-pip");
        await until(
            async () =>
                inPage<boolean>(`
            return JSON.stringify(document.querySelector('[aria-label="Choose Collaborator model"]') !== null);
        `),
            "PiP settings loaded",
        );
        await reach({ sheet: "settings", layers: 2 }, "PiP is a top-level settings category");
        await tap('[aria-label="Choose Collaborator model"]');
        await until(
            async () => (await where()).layers === 3,
            "collaborator picker has its own Back layer",
        );
        await tap('[aria-label="Collaborator model"] [role="option"][title^="faux/faux-2 "]');
        await until(
            () => app.config.pipCollaborator?.choice.modelId === "faux-2",
            "collaborator selection saved",
        );
        await reach({ sheet: "settings", layers: 2 }, "model selection returns to PiP settings");
        const person = app.config.users.find((user) => user.role === "owner")!;

        assert.equal(
            app.pip.idOf(person.id),
            undefined,
            "collaborator picker does not open private chat",
        );
        assert.equal(
            (await app.agentState(first))?.model?.modelId,
            "faux-1",
            "the coding thread behind settings is untouched",
        );
        await tap('[aria-label="Choose PiP chats model"]');
        await tap('[aria-label="PiP chats model"] [role="option"][title^="faux/faux-vision "]');
        await until(async () => {
            const id = app.pip.idOf(person.id);

            return id !== undefined && (await app.agentState(id))?.model?.modelId === "faux-vision";
        }, "private model selection saved");
        await reach({ sheet: "settings", layers: 2 }, "private selection closes only the picker");
        assert.equal(app.config.pipCollaborator?.choice.modelId, "faux-2");
        assert.equal((await app.agentState(first))?.model?.modelId, "faux-1");
        assert.equal(
            await inPage<boolean>(`
            const panel = document.querySelector('#settings-panel-pip');

            return JSON.stringify(panel.scrollWidth <= panel.clientWidth);
        `),
            true,
            "PiP settings fit a phone without horizontal scrolling",
        );
        await tap('[aria-label="Choose Collaborator model"]');
        await until(async () => (await where()).layers === 3, "reopened collaborator picker");
        await page.press("Escape");
        await reach({ sheet: "settings", layers: 2 }, "Escape closes only the picker");
        await tap('[aria-label="Choose Collaborator model"]');
        await until(
            async () => (await where()).layers === 3,
            "collaborator picker reopened for Back",
        );
        await back();
        await reach({ sheet: "settings", layers: 2 }, "Back closes only the picker");
        await until(
            async () =>
                inPage<boolean>(`
            return JSON.stringify(document.querySelector('[aria-label="Collaborator model"]') === null);
        `),
            "collaborator picker unmounted",
        );
        assert.equal(
            await inPage<string>(`
            return JSON.stringify(document.querySelector('[role="tab"][aria-selected="true"]').textContent.trim());
        `),
            "PiP",
        );
        await back();
        await reach({ sheet: "menu", layers: 1 }, "Back leaves PiP settings for the menu");
        await back();
        await reach({ sheet: null, layers: 0 }, "menu closed");
    },
);

test(
    "Settings preserves account and budget drafts, saves preferences, and returns from invites",
    real,
    async () => {
        await fresh();
        await page.setViewport(VIEWPORTS.desktop);
        await tap(".sidebar .foot-tile:nth-child(2)");
        await reach({ sheet: "settings", layers: 1 }, "People opens Account & access");
        const originalName = await inPage<string>(`
        return JSON.stringify((await import('/store.js')).store.state.me.name);
    `);

        await page.evaluate(`
        window.settingsInviteRequests = 0;
        window.settingsFetch = window.fetch;
        window.fetch = (url, ...rest) => {
            if (String(url).endsWith('/api/invite')) {
                window.settingsInviteRequests++;
            }

            return window.settingsFetch(url, ...rest);
        };
        const name = document.querySelector('#settings-panel-account input[name="name"]');

        name.value = 'Settings owner';
        name.dispatchEvent(new Event('input', { bubbles: true }));
    `);
        await tap("#settings-tab-notifications");
        await until(
            async () =>
                await inPage<boolean>(`
            return JSON.stringify(document.querySelector('#settings-panel-notifications [aria-label="Chat messages"]') !== null);
        `),
            "notification preferences",
        );
        const originalChat = await inPage<boolean>(`
        return JSON.stringify((await (await import('/store.js')).api('push')).prefs.chat);
    `);

        await tap('#settings-panel-notifications [aria-label="Chat messages"]');
        await until(
            async () =>
                (await inPage<boolean>(`
            return JSON.stringify((await (await import('/store.js')).api('push')).prefs.chat);
        `)) !== originalChat,
            "notification preference saved",
        );
        await tap('#settings-panel-notifications [aria-label="Chat messages"]');
        await until(
            async () =>
                (await inPage<boolean>(`
            return JSON.stringify((await (await import('/store.js')).api('push')).prefs.chat);
        `)) === originalChat,
            "notification preference restored",
        );
        await tap("#settings-tab-extensions");
        await until(
            async () =>
                await inPage<boolean>(`
            return JSON.stringify(document.querySelector('#settings-panel-extensions .switch') !== null);
        `),
            "extensions inside Settings",
        );
        await tap("#settings-tab-usage");
        await tap("#settings-panel-usage .spend-row .link");
        await page.evaluate(`
        const budget = document.querySelector('#settings-panel-usage input[type="number"]');

        budget.value = '45.5';
        budget.dispatchEvent(new Event('input', { bubbles: true }));
    `);
        await tap("#settings-tab-account");
        assert.equal(
            await inPage<string>(`
        return JSON.stringify(document.querySelector('#settings-panel-account input[name="name"]').value);
    `),
            "Settings owner",
            "switching categories keeps the name draft",
        );
        await tap("#settings-tab-usage");
        assert.equal(
            await inPage<string>(`
        return JSON.stringify(document.querySelector('#settings-panel-usage input[type="number"]').value);
    `),
            "45.5",
            "switching categories keeps the budget draft",
        );
        assert.equal(
            await inPage<number>(`return JSON.stringify(window.settingsInviteRequests);`),
            0,
            "visiting Settings does not create hidden invitations",
        );
        await tap("#settings-tab-account");
        await tap("#settings-panel-account button[type='submit']");
        await until(
            async () =>
                (await inPage<string>(`
            return JSON.stringify((await (await import('/store.js')).api('me')).user.name);
        `)) === "Settings owner",
            "name saved without closing Settings",
        );
        await reach({ sheet: "settings", layers: 1 }, "saving keeps Settings open");
        await page.evaluate(`
        const name = document.querySelector('#settings-panel-account input[name="name"]');

        name.value = ${JSON.stringify(originalName)};
        name.dispatchEvent(new Event('input', { bubbles: true }));
    `);
        await tap("#settings-panel-account button[type='submit']");
        await until(
            async () =>
                (await inPage<string>(`
            return JSON.stringify((await (await import('/store.js')).api('me')).user.name);
        `)) === originalName,
            "name restored",
        );
        await tap("#settings-panel-account .settings-actions button:first-child");
        await reach(
            { sheet: "invite", layers: 2 },
            "signing in another device is an explicit flow",
        );
        assert.equal(
            await inPage<boolean>(`
        return JSON.stringify(document.querySelector('.sheet input[type="checkbox"]').checked);
    `),
            true,
            "another device signs in as the owner by default",
        );
        await back();
        await reach({ sheet: "settings", layers: 1 }, "back returns to Settings");
        assert.equal(
            await inPage<string>(`
        return JSON.stringify(document.querySelector('.settings-tabs [aria-selected="true"]').textContent.trim());
    `),
            "Account & access",
        );
        await page.evaluate(`window.fetch = window.settingsFetch;`);
        await page.press("Escape");
        await reach({ sheet: null, layers: 0 }, "Settings closed");
    },
);

// Authoring gate: the browser owns pencil opt-in, floating actions, draft retention and save/error feedback.
// HTTP authorization and provider prompt delivery are exercised by agent-settings and thread-prompts tests.
test(
    "Agents settings requires pencil opt-in, floats actions and preserves drafts on failed saves",
    real,
    async () => {
        await fresh();
        await page.evaluate(
            `(await import('/store.js')).openSheet({ type: 'settings', tab: 'agents' });`,
        );
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelectorAll('#settings-panel-agents textarea').length === 5);`,
                ),
            "the agent prompt list",
        );
        const field = "#agent-prompt-worker";
        const form = ".agent-prompt:has(#agent-prompt-worker)";
        const editButton = `${form} [aria-label="Edit Worker prompt"]`;
        const cancelButton = `${form} [aria-label="Cancel editing Worker prompt"]`;
        const saveButton = `${form} [aria-label="Save Worker prompt"]`;
        const restoreButton = `${form} [aria-label="Restore Worker default prompt"]`;
        const toolbar = `${form} [aria-label="Worker prompt actions"]`;
        // These overlay controls must pass browser hit-testing, unlike the older DOM-click helper.
        const tap = (selector: string) => page.click({ selector });

        assert.equal(
            await inPage<boolean>(`
                const icons = [...document.querySelectorAll('#settings-panel-agents h4 .thread-type.icon-only')];

                return JSON.stringify(icons.length === 5 && icons.every(icon => icon.querySelector('svg') !== null));
            `),
            true,
            "every agent heading uses its thread-type icon",
        );
        const original = await inPage<string>(
            `return JSON.stringify(document.querySelector(${JSON.stringify(field)}).value);`,
        );
        const draft = `${original}\nUse the UI_PROMPT_EDIT_CONTRACT.\n`;
        const fill = (text: string) =>
            page.evaluate(`
        const input = document.querySelector(${JSON.stringify(field)});

        input.value = ${JSON.stringify(text)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
    `);

        for (const viewport of [VIEWPORTS.mobile, VIEWPORTS.desktop]) {
            await page.setViewport(viewport);
            assert.equal(
                await inPage<boolean>(`
                    const panel = document.querySelector('#settings-panel-agents');

                    return JSON.stringify(panel.scrollWidth <= panel.clientWidth && [...panel.querySelectorAll('.agent-prompt-editor')].every(editor => {
                        const frame = editor.getBoundingClientRect();
                        const field = editor.querySelector('textarea');
                        const group = editor.querySelector('[role="group"]');
                        const input = field.getBoundingClientRect();
                        const tools = group.getBoundingClientRect();
                        const fieldStyle = getComputedStyle(field);
                        const groupStyle = getComputedStyle(group);
                        const unreserved = parseFloat(fieldStyle.paddingTop) <= parseFloat(fieldStyle.paddingBottom);
                        const floating = groupStyle.backgroundColor === 'rgba(0, 0, 0, 0)' && groupStyle.backgroundImage === 'none' && ['Top', 'Right', 'Bottom', 'Left'].every(side => parseFloat(groupStyle['border' + side + 'Width']) === 0);

                        return unreserved && floating && frame.width <= panel.clientWidth && Math.abs(frame.height - input.height) < 1 && Math.abs(frame.top - input.top) < 1 && tools.top > input.top && tools.right < input.right && tools.bottom < input.bottom;
                    }));
                `),
                true,
                "actions float inside the prompt without a reserved topbar on either screen size",
            );

            if (viewport.mobile) {
                assert.equal(
                    await inPage<boolean>(`
                        const toolbar = document.querySelector(${JSON.stringify(toolbar)});

                        return JSON.stringify(getComputedStyle(toolbar).opacity === '1' && [...toolbar.querySelectorAll('button')].every(button => button.getBoundingClientRect().height >= 40));
                    `),
                    true,
                    "touch actions remain visible with thumb-sized targets",
                );
            }
        }

        await page.hover({ selector: "#settings-panel-agents > h3" });
        assert.equal(
            await inPage<string>(
                `return JSON.stringify(getComputedStyle(document.querySelector(${JSON.stringify(toolbar)})).opacity);`,
            ),
            "0",
            "desktop actions rest hidden",
        );
        await page.hover({ selector: field });
        assert.equal(
            await inPage<string>(
                `return JSON.stringify(getComputedStyle(document.querySelector(${JSON.stringify(toolbar)})).opacity);`,
            ),
            "1",
            "hover reveals actions",
        );
        await page.type({ selector: field }, "READ_ONLY_INPUT_MUST_NOT_CHANGE_PROMPT");
        assert.equal(
            await inPage<string>(
                `return JSON.stringify(document.querySelector(${JSON.stringify(field)}).value);`,
            ),
            original,
            "typing cannot change a prompt before opting into editing",
        );
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector(${JSON.stringify(saveButton)}) === null && document.querySelector(${JSON.stringify(restoreButton)}) === null);`,
            ),
            true,
            "read mode offers only the pencil",
        );
        await page.press("Tab");
        assert.equal(
            await inPage<string>(
                `return JSON.stringify(document.activeElement.getAttribute('aria-label'));`,
            ),
            "Edit Worker prompt",
            "keyboard navigation reaches the pencil",
        );
        await page.press("Enter");
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(${JSON.stringify(field)}).readOnly === false && document.activeElement.id === 'agent-prompt-worker');`,
                ),
            "pencil enables and focuses editing",
        );
        await fill("CANCELLED_PROMPT_DRAFT");
        await page.hover({ selector: `${form} h4` });
        await page.hover({ selector: field });
        await tap(cancelButton);
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(${JSON.stringify(field)}).readOnly && document.querySelector(${JSON.stringify(field)}).value === ${JSON.stringify(original)});`,
                ),
            "cancel discards the draft and returns to read mode",
        );
        assert.equal(app.config.agentPrompts.worker, undefined, "cancel does not save settings");
        await tap(editButton);
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify(!document.querySelector(${JSON.stringify(field)}).readOnly);`,
                ),
            "editing opted into again",
        );
        await fill(draft);
        assert.equal(
            await inPage<string>(
                `return JSON.stringify(getComputedStyle(document.querySelector(${JSON.stringify(toolbar)})).opacity);`,
            ),
            "0",
            "typing hides even a hovered toolbar",
        );
        await page.press("Tab");
        assert.equal(
            await inPage<string>(
                `return JSON.stringify(document.activeElement.getAttribute('aria-label'));`,
            ),
            "Save Worker prompt",
            "keyboard navigation reaches the hidden actions",
        );
        assert.equal(
            await inPage<string>(
                `return JSON.stringify(getComputedStyle(document.querySelector(${JSON.stringify(toolbar)})).opacity);`,
            ),
            "1",
            "keyboard focus reveals actions",
        );
        await tap("#settings-tab-appearance");
        await tap("#settings-tab-agents");
        assert.equal(
            await inPage<string>(
                `return JSON.stringify(document.querySelector(${JSON.stringify(field)}).value);`,
            ),
            draft,
        );
        await reach(
            { sheet: "settings", layers: 1 },
            "agent drafts stay in the same Settings page",
        );
        await page.evaluate(`
        window.agentSettingsFetch = window.fetch;
        window.fetch = (url, options) => String(url).endsWith('/api/agents/worker') && options?.method === 'POST'
            ? Promise.resolve(new Response(JSON.stringify({ error: 'Simulated save unavailable' }), { status: 503, headers: { 'Content-Type': 'application/json' } }))
            : window.agentSettingsFetch(url, options);
    `);

        await page.hover({ selector: field });
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify([...document.querySelectorAll(${JSON.stringify(`${toolbar} button`)})].every(button => button.querySelector('svg') && button.title && button.textContent.trim() === ''));`,
            ),
            true,
            "overlay actions are labeled icon buttons, not text buttons",
        );

        try {
            await tap(saveButton);
            await until(
                async () =>
                    await inPage<boolean>(
                        `return JSON.stringify(document.querySelector(${JSON.stringify(`${form} [role='alert']`)})?.textContent.includes('Simulated save unavailable') === true);`,
                    ),
                "inline save error",
            );
            assert.equal(
                await inPage<string>(
                    `return JSON.stringify(document.querySelector(${JSON.stringify(field)}).value);`,
                ),
                draft,
                "a failed save keeps the draft",
            );
            assert.equal(
                app.config.agentPrompts.worker,
                undefined,
                "failed delivery does not save settings",
            );
            assert.equal(
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(${JSON.stringify(field)}).readOnly);`,
                ),
                false,
                "a failed save keeps editing available",
            );
        } finally {
            await page.evaluate(`window.fetch = window.agentSettingsFetch;`);
        }

        await tap(saveButton);
        await until(() => app.config.agentPrompts.worker === draft, "agent prompt saved");
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(${JSON.stringify(`${form} [role='status']`)})?.textContent.includes('Worker prompt saved') === true);`,
                ),
            "inline save confirmation",
        );
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector(${JSON.stringify(field)}).readOnly && document.querySelector(${JSON.stringify(editButton)}) !== null && document.querySelector(${JSON.stringify(saveButton)}) === null);`,
            ),
            true,
            "a successful save returns to read mode",
        );
        await page.press("Escape");
        await reach({ sheet: null, layers: 0 }, "Settings closed after save");
        await page.evaluate(
            `(await import('/store.js')).openSheet({ type: 'settings', tab: 'agents' });`,
        );
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(${JSON.stringify(field)})?.value === ${JSON.stringify(draft)});`,
                ),
            "saved prompt on reopening",
        );
        await page.setViewport(VIEWPORTS.mobile);
        await tap(editButton);
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify(!document.querySelector(${JSON.stringify(field)}).readOnly);`,
                ),
            "reopened prompts require the pencil again",
        );
        await page.type(undefined, " \n ");
        assert.equal(
            await inPage<string>(
                `return JSON.stringify(getComputedStyle(document.querySelector(${JSON.stringify(toolbar)})).opacity);`,
            ),
            "0",
            "typing hides the coarse-pointer actions too",
        );
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector(${JSON.stringify(saveButton)}).disabled);`,
            ),
            true,
            "blank prompts cannot be saved",
        );
        await tap(`${form} h4`);
        assert.equal(
            await inPage<boolean>(`
                const group = document.querySelector(${JSON.stringify(toolbar)});

                return JSON.stringify(getComputedStyle(group).opacity === '1' && [...group.querySelectorAll('button')].every(button => button.getBoundingClientRect().height >= 40));
            `),
            true,
            "blurring the field reveals thumb-sized actions in the mobile viewport",
        );
        await tap(restoreButton);
        assert.equal(
            await inPage<string>(
                `return JSON.stringify(document.querySelector(${JSON.stringify(field)}).value);`,
            ),
            original,
        );
        assert.equal(
            app.config.agentPrompts.worker,
            draft,
            "restoring the editor still needs an explicit save",
        );
        await tap(saveButton);
        await until(
            () => app.config.agentPrompts.worker === undefined,
            "default restored by a hit-tested mobile Save click",
        );
        await page.press("Escape");
        await reach({ sheet: null, layers: 0 }, "Settings closed");
    },
);

test(
    "Settings phone tabs fit owner extension paths and keep owner controls read-only for guests",
    real,
    async () => {
        await fresh();
        await page.setViewport({ ...VIEWPORTS.mobile, width: 320 });
        await page.evaluate(`
            (await import("/store.js")).openSheet({ type: "settings", tab: "extensions" });
        `);
        await until(
            async () =>
                await inPage<boolean>(`
                return JSON.stringify(document.querySelector("#settings-panel-extensions .switch") !== null);
            `),
            "owner extension settings",
        );
        assert.equal(
            await inPage<boolean>(`
                const panel = document.querySelector("#settings-panel-extensions");

                return JSON.stringify(panel.scrollWidth <= panel.clientWidth);
            `),
            true,
            "the owner’s extension directory wraps within a narrow phone panel",
        );
        const guest = app.config.addUser("Settings guest", "guest");

        await page.navigate(`${base}/login?token=${encodeURIComponent(guest.token)}`);
        await tap("form button");

        try {
            await fresh();
            await page.setViewport({ ...VIEWPORTS.mobile, width: 320 });
            await page.evaluate(`(await import('/store.js')).openSheet({ type: 'settings' });`);
            await reach({ sheet: "settings", layers: 1 }, "guest Settings");
            await page.evaluate(`document.querySelector('#settings-tab-appearance').focus();`);
            await page.press("End");
            await until(
                async () =>
                    await inPage<boolean>(`
                const tab = document.querySelector('#settings-tab-usage').getBoundingClientRect();
                const nav = document.querySelector('.settings-tabs').getBoundingClientRect();
                const panel = document.querySelector('#settings-panel-usage');

                return JSON.stringify(
                    document.activeElement.id === 'settings-tab-usage' &&
                    tab.left >= nav.left - 1 && tab.right <= nav.right + 1 &&
                    panel.scrollWidth <= panel.clientWidth &&
                    document.documentElement.scrollWidth <= innerWidth
                );
            `),
                "the last category is scrolled into view without widening the phone",
            );
            await until(
                async () =>
                    await inPage<boolean>(`
                return JSON.stringify(document.querySelector('#settings-panel-usage .spend-row') !== null);
            `),
                "guest usage",
            );
            assert.equal(
                await inPage<number>(`
            return JSON.stringify(document.querySelectorAll('#settings-panel-usage .spend-row button').length);
        `),
                0,
                "guests cannot change budgets",
            );
            await tap("#settings-tab-extensions");
            await until(
                async () =>
                    await inPage<boolean>(`
                const switches = [...document.querySelectorAll('#settings-panel-extensions .switch')];

                return JSON.stringify(switches.length > 0 && switches.every((each) => each.disabled));
            `),
                "guests can inspect extensions but not change them",
            );
            await tap("#settings-tab-agents");
            await until(
                async () =>
                    await inPage<boolean>(`
                    const panel = document.querySelector('#settings-panel-agents');

                    return JSON.stringify(panel.textContent.includes('Only the owner') && panel.querySelector('textarea') === null);
                `),
                "guests do not load global prompt editors",
            );
            await tap("#settings-tab-account");
            assert.equal(
                await inPage<number>(`
            return JSON.stringify(document.querySelectorAll('#settings-panel-account .person-actions').length);
        `),
                0,
                "guests cannot change access",
            );
            await back();
            await reach({ sheet: null, layers: 0 }, "one back step closes all Settings categories");
        } finally {
            await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
            await tap("form button");
            await fresh();
        }
    },
);

test("local Markdown file links use the viewer", real, async () => {
    const linked = await newSession(app);

    await say(
        app,
        linked,
        [
            "[web.env](web.env)",
            "[Website](https://example.com/web.env)",
            "[Unsafe](javascript:alert%281%29)",
            '<a href="https://example.com" data-path="web.env">Forged</a>',
        ].join("\n\n"),
    );
    await fresh();
    await goTo(linked);
    await reach({ path: `/s/${linked}` }, "the reply with file links");
    await until(
        async () =>
            (await inPage<boolean>(
                `return JSON.stringify(document.querySelector('.reply .md a[data-path="web.env"]') !== null)`,
            )) === true,
        "the rendered links",
    );
    const links = await inPage<
        Record<string, { path: string | null; target: string | null; href: string | null }>
    >(`
        return JSON.stringify(Object.fromEntries(
            [...document.querySelectorAll(".reply .md a")].map((link) => [link.textContent, {
                path: link.getAttribute("data-path"),
                target: link.getAttribute("target"),
                href: link.getAttribute("href"),
            }]),
        ));
    `);

    assert.equal(links["web.env"]?.path, "web.env");
    assert.equal(links["web.env"]?.target, null, "local links stay in the app");

    for (const label of ["Website", "Unsafe", "Forged"]) {
        assert.equal(links[label]?.path, null, `${label} stays outside the file viewer`);
    }

    assert.equal(links.Unsafe?.href, null, "unsafe schemes are still stripped");
    await page.evaluate(`document.querySelector('.reply .md a[data-path="web.env"]').focus()`);
    await page.press("Enter");
    await reach({ sheet: "file", layers: 1 }, "the file opened by keyboard");
    await until(
        async () =>
            (await inPage<boolean>(
                `return JSON.stringify(document.querySelector(".file-viewer")?.textContent.includes("PORT=3000") === true)`,
            )) === true,
        "the environment file contents",
    );
});

test(
    "on a phone, an invite lasts as long as chosen, and the one it replaces ends",
    real,
    async () => {
        const code = () =>
            inPage<string | null>(
                `return JSON.stringify(document.querySelector(".invite-code-value")?.textContent.replace(/\\s/g, "") ?? null)`,
            );
        const status = async (invite: string | null) =>
            (await fetch(`${base}/join/${invite}`)).status;

        await fresh();
        await page.evaluate(`(await import("/store.js")).openSheet({ type: "invite" })`);
        await until(async () => (await code()) !== null, "the first invite");
        const first = await code();

        await page.evaluate(
            `[...document.querySelectorAll(".sheet .segmented button")].find((each) => each.textContent.trim() === "1 week").click()`,
        );
        await until(async () => ![null, first].includes(await code()), "the week's invite");
        const week = await code();

        assert.equal(await status(week), 200);
        await until(async () => (await status(first)) === 410, "the 15 minutes' invite, ended");

        await tap('.sheet label.check input[type="checkbox"]');
        await until(async () => ![null, week].includes(await code()), "the owner's invite");
        await until(async () => (await status(week)) === 410, "the week's invite, ended");
        await tap('.sheet label.check input[type="checkbox"]');
        await until(async () => (await code()) !== null, "a guest's invite again");
        const steer = await code();

        // Not for a frame does the sheet show an invite made for other settings: View only shows no Steer invite.
        await page.evaluate(`
            window.frames = [];
            const watch = () => {
                const on = document.querySelector(".sheet .segmented .on")?.textContent.trim();
                const code = document.querySelector(".invite-code-value")?.textContent.replace(/\\s/g, "");

                window.frames.push([on, code ?? null]);

                if (window.frames.length < 60) {
                    requestAnimationFrame(watch);
                }
            };

            requestAnimationFrame(watch);
            [...document.querySelectorAll(".sheet .segmented button")].find((each) => each.textContent.trim() === "View only").click();
        `);
        await until(async () => ![null, steer].includes(await code()), "the view-only invite");
        const frames = await inPage<[string, string | null][]>(
            `return JSON.stringify(window.frames)`,
        );

        assert.ok(
            !frames.some(([on, shown]) => on === "View only" && shown === steer),
            "no frame shows the Steer invite under View only",
        );
        const viewOnly = await code();

        // New invite makes another and leaves the one before working; closing leaves the last one working.
        await tap(".sheet .button.wide:last-of-type");
        await until(async () => ![null, viewOnly].includes(await code()), "another invite");
        const another = await code();

        assert.equal(await status(viewOnly), 200, "the one before New invite still works");
        await back();
        await reach({ sheet: null, layers: 0 }, "closed");
        assert.equal(await status(another), 200, "the last one shown still works");
    },
);

test(
    "project invite access starts empty and delayed broad grants never appear under a cleared checkbox",
    real,
    async () => {
        const { Auth } = await import("../src/server/auth.ts");
        const auth = new Auth(app.config);
        const input = ".sheet input[aria-describedby]";
        const code = () =>
            inPage<string | null>(
                `return JSON.stringify(document.querySelector(".invite-code-value")?.textContent.replace(/\\s/g, "") ?? null)`,
            );

        await fresh();
        await page.evaluate(`(await import("/store.js")).openSheet({ type: "invite" })`);
        await until(async () => (await code()) !== null, "an ordinary invite");
        const original = await code();

        assert.deepEqual(auth.invite(original!)!.projectAccess, {});
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector(${JSON.stringify(input)}).checked)`,
            ),
            false,
        );
        assert.match(
            await inPage<string>(
                `return JSON.stringify(document.getElementById(document.querySelector(${JSON.stringify(input)}).getAttribute('aria-describedby')).textContent)`,
            ),
            /Includes future projects/,
        );
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector('#invite-pi-sessions-help') === null)`,
            ),
            true,
        );
        // Hold the actual server response, not an invented grant: a newer unchecked request must win.
        await page.evaluate(`
            window.inviteFetch = window.fetch;
            window.delayedProjectInvite = null;
            window.fetch = async (...args) => {
                const response = await window.inviteFetch(...args);

                if (String(args[0]).endsWith('/api/invite') && JSON.parse(args[1]?.body ?? '{}').projectAccess?.all === true) {
                    window.delayedProjectInvite = (await response.clone().json()).code;
                    await new Promise((resolve) => { window.releaseProjectInvite = resolve; });
                }

                return response;
            };
        `);

        try {
            await tap(input);
            await until(
                async () =>
                    await inPage<boolean>(`return JSON.stringify(!!window.delayedProjectInvite)`),
                "the granted response held in transit",
            );
            const delayed = await inPage<string>(
                `return JSON.stringify(window.delayedProjectInvite)`,
            );

            assert.deepEqual(auth.invite(delayed)!.projectAccess, { all: true });
            await tap(input);
            await until(
                async () => ![null, original].includes(await code()),
                "the unchecked replacement",
            );
            const replacement = await code();

            assert.deepEqual(auth.invite(replacement!)!.projectAccess, {});
            await page.evaluate(`window.releaseProjectInvite()`);
            await until(
                () => auth.invite(delayed) === undefined,
                "the delayed granted invite cancelled",
            );
            assert.equal(await code(), replacement);
            assert.equal(
                auth.invite(original!),
                undefined,
                "changing the grant ends the original invite",
            );
        } finally {
            await page.evaluate(`
                window.fetch = window.inviteFetch;
                window.releaseProjectInvite?.();
            `);
        }

        await tap(input);
        await until(async () => {
            const shown = await code();

            return shown !== null && auth.invite(shown)?.projectAccess?.all === true;
        }, "the explicit all-projects grant");
        const granted = await code();

        await page.evaluate(
            `[...document.querySelectorAll(".sheet .segmented button")].find((each) => each.textContent.trim() === "View only").click()`,
        );
        await until(async () => ![null, granted].includes(await code()), "a viewer invite");
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector(${JSON.stringify(input)}).checked)`,
            ),
            true,
            "viewers keep the selected projects but cannot steer",
        );
        assert.equal(auth.invite(granted!), undefined);
        assert.deepEqual(auth.invite((await code())!)!.projectAccess, { all: true });
        assert.equal(auth.invite((await code())!)!.role, "viewer");
        assert.equal(auth.invite((await code())!)!.continuePiSessions, undefined);
    },
);

/** PiP closed and forgotten in this tab, so the tests after start without it. */
async function noPip(): Promise<void> {
    await page.evaluate(`
        (await import("/pip.js")).closePip();
        sessionStorage.removeItem("pocket.pip");
        localStorage.removeItem("pocket.pip.draft");
    `);
    await until(
        async () =>
            (await inPage<boolean>(
                `return JSON.stringify(document.querySelector(".pip-panel") === null)`,
            )) === true,
        "PiP's panel, gone",
    );
}

test(
    "/pip with words that cannot be sent leaves them in PiP's box, after its draft",
    real,
    async () => {
        await fresh();
        await page.setViewport(VIEWPORTS.desktop);
        await page.evaluate(`
        localStorage.setItem("pocket.pip.draft", "a draft");
        const fetched = window.fetch;
        window.fetch = (url, init) =>
            String(url).endsWith("/submit") ? Promise.reject(new TypeError("offline")) : fetched(url, init);
        (await import("/pip.js")).askPip("hello pip");
    `);
        await until(
            async () =>
                (await inPage<string | null>(
                    `return JSON.stringify(document.querySelector(".pip-composer textarea")?.value ?? null)`,
                )) === "a draft\n\nhello pip",
            "the words, back in PiP's box after the draft",
        );
        await noPip();
    },
);
