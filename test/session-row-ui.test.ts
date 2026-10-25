// Session-row actions in a dedicated headless browser, with isolated app data and a scripted model.
import { type App, cleanUp, newSession, openApp, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
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
const DESKTOP = { width: 1440, height: 900, scale: 1, mobile: false };

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let active: ConversationId;
let folderSessions: ConversationId[];
const longFolder = "a-directory-with-a-name-long-enough-to-ellipsis-in-the-session-sidebar";

let list = ".sidebar";
const row = (id: ConversationId) => `${list} .session-row[data-id="${id}"]`;

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

async function selectTab(name: "Recent" | "Folders" | "Archived"): Promise<void> {
    const index = await inPage<number>(`
        const tabs = [...document.querySelectorAll(${JSON.stringify(`${list} .session-tabs [role="tab"]`)})];
        return JSON.stringify(tabs.findIndex((tab) => tab.textContent.trim() === ${JSON.stringify(name)}));
    `);

    assert.ok(index >= 0, `${name} tab exists in the current list`);
    await page.click({ selector: `${list} .session-tabs [role="tab"]:nth-of-type(${index + 1})` });
    await until(
        async () =>
            await inPage<boolean>(`
                const tab = document.querySelector(${JSON.stringify(`${list} .session-tabs [aria-selected="true"]`)});
                return JSON.stringify(tab?.textContent.trim() === ${JSON.stringify(name)});
            `),
        `${name} tab selected`,
    );
}

async function showList(): Promise<void> {
    if (
        list === ".drawer" &&
        !(await inPage<boolean>(
            `return JSON.stringify(!!document.querySelector('.drawer:not([data-state="closing"])'))`,
        ))
    ) {
        await page.press(
            (await inPage<boolean>(`return JSON.stringify((await import('/ui.js')).APPLE)`))
                ? "Meta+B"
                : "Control+B",
        );
    }

    await until(
        () =>
            inPage<boolean>(
                `return JSON.stringify(!!document.querySelector(${JSON.stringify(row(active))}))`,
            ),
        "the current session list",
    );
    await page.evaluate(`await Promise.all(document.getAnimations()
        .filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime))
        .map(animation => animation.finished.catch(() => {})))`);
}

async function fresh(mobile = false): Promise<void> {
    list = mobile ? ".drawer" : ".sidebar";
    await page.setViewport(mobile ? VIEWPORTS.mobile : DESKTOP);
    await page.navigate(`${base}/`);
    await until(
        () =>
            inPage<boolean>(
                `return JSON.stringify(!!document.querySelector('[data-part="home"]'))`,
            ),
        "Home loaded",
    );
    await showList();
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector(${JSON.stringify(row(active))}) !== null)`,
            ),
        "the session list",
        20_000,
    );
    await selectTab("Recent");
    await page.hover({ x: 1, y: 1 });
    assert.equal(
        await inPage<boolean>(`return JSON.stringify(matchMedia("(hover: hover)").matches)`),
        !mobile,
        "a mouse on the desktop, touch on the phone",
    );
}

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(scriptedModel());
    active = await newSession(app);
    const cwd = join(root, longFolder);

    mkdirSync(cwd);
    folderSessions = [await newSession(app, cwd)];
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "session-row-ui-")),
        load: async () => undefined,
        save: () => {},
        // A mouse, whatever this machine has: headless Chromium without one says (hover: none), and rows show their
        // buttons only where a pointer can hover. The phone size's touch emulation still makes it (hover: none).
        args: [
            "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
        ],
    });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

type Touched = {
    sheet: string | null;
    path: string;
    layers: number;
    pinned: number[];
};

const touched = () =>
    inPage<Touched>(`
        const { store } = await import("/store.js");

        return JSON.stringify({
            sheet: store.state.sheet?.type ?? null,
            path: location.pathname,
            layers: history.state?.pocket?.layers ?? 0,
            pinned: store.state.pinned,
        });
    `);

/** Wait until what a finger left is as `expected` says, in the fields it names. */
async function settled(expected: Partial<Touched>, what: string): Promise<Touched> {
    let last: Touched | undefined;

    try {
        await until(async () => {
            last = await touched();

            return Object.entries(expected).every(([key, value]) =>
                Array.isArray(value)
                    ? JSON.stringify(last![key as keyof Touched]) === JSON.stringify(value)
                    : last![key as keyof Touched] === value,
            );
        }, what);
    } catch {
        assert.fail(`${what}: ${JSON.stringify(last)}`);
    }

    return last!;
}

/**
 * A contact on the real drawer row. A deliberate hold slides into Options after reveal;
 * an ordinary tap keeps its compatibility click, while scroll intent never synthesizes one.
 */
const finger = async (id: ConversationId, { ms, dy = 0 }: { ms: number; dy?: number }) => {
    // Native actions may close the drawer. A new contact must target its visible, current row.
    await showList();

    return inPage(`
        const button = document.querySelector(${JSON.stringify(`${row(id)} > .session`)});
        const box = button.getBoundingClientRect();
        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;
        const fire = (type, at = { x, y }) => {
            const finger = new Touch({ identifier: 7, target: button, clientX: at.x, clientY: at.y });

            return button.dispatchEvent(new TouchEvent(type, {
                bubbles: true, cancelable: true,
                touches: type === 'touchend' ? [] : [finger], changedTouches: [finger],
            }));
        };
        const wait = (time) => new Promise((resolve) => setTimeout(resolve, time));

        fire('touchstart');
        await wait(Math.min(250, ${ms} / 2));

        if (${dy} !== 0) {
            fire('touchmove', { x, y: y + ${dy} });
        }

        await wait(${ms} - Math.min(250, ${ms} / 2));
        const deliberate = ${ms} >= 450 && ${dy} === 0;
        const release = { x: deliberate ? x + 16 : x, y: y + ${dy} };

        if (deliberate) {
            if (!button.closest('.session-row').querySelector('.session-hold')) {
                throw new Error('The hold must reveal its chooser before a fresh slide');
            }

            fire('touchmove', release);
            const deadline = Date.now() + 4000;

            while (!document.querySelector('.sidebar-options-sheet')) {
                if (Date.now() > deadline) {
                    throw new Error('The fresh slide and dwell did not open Options');
                }

                await wait(20);
            }
        }

        fire('touchend', release);

        if (${dy} === 0) {
            document.elementFromPoint(release.x, release.y)
                .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1,
                    clientX: release.x, clientY: release.y }));
        }

        return JSON.stringify({ });
    `);
};

/** Tap one of the open sheet's items by its label. */
async function choose(label: string): Promise<void> {
    await page.evaluate(`
        [...document.querySelectorAll('.sidebar-options-sheet .sidebar-option')]
            .find((each) => each.textContent.trim() === ${JSON.stringify(label)})
            .click();
    `);
}

test(
    "touch screens: hold and slide opens row Options, a tap opens the thread, and a scroll is not a press",
    real,
    async () => {
        await fresh(true);

        await finger(active, { ms: 600 });
        await settled(
            {
                sheet: "sidebar-options",
                path: "/",
            },
            "the row's actions, open",
        );
        await new Promise((resolve) => setTimeout(resolve, 300));
        await settled(
            { sheet: "sidebar-options", path: "/", layers: 2 },
            "Options stays open over its drawer after lift",
        );
        await choose("Pin to the top");
        await settled({ sheet: null, pinned: [Number(active)] }, "pinned, and the sheet closed");
        await finger(active, { ms: 600 });
        await settled({ sheet: "sidebar-options" }, "the pinned row offers Unpin");
        await choose("Unpin");
        await settled({ sheet: null, pinned: [] }, "unpinned");

        // A finger that moves is scrolling or dragging: no press, no actions.
        await finger(active, { ms: 600, dy: 30 });
        await new Promise((resolve) => setTimeout(resolve, 200));
        await settled({ sheet: null, path: "/" }, "no actions after a scroll");

        // A quick tap opens the session, as it always has.
        await finger(active, { ms: 80 });
        await settled({ sheet: null, path: `/s/${active}` }, "the session, opened by a tap");
    },
);

/** What this browser marked unread, and which rows show it. */
const marks = () =>
    inPage<{ stored: number[]; dots: number[] }>(`
        const rows = [...document.querySelectorAll(${JSON.stringify(`${list} .session-row`)})];

        return JSON.stringify({
            stored: JSON.parse(localStorage.getItem("pocket.unread") ?? "[]"),
            dots: rows.filter((each) => each.querySelector(".unread-dot")).map((each) => Number(each.dataset.id)),
        });
    `);

async function marked(ids: ConversationId[], what: string): Promise<void> {
    const want = JSON.stringify({
        stored: ids.map(Number),
        dots: ids.map(Number),
    });
    let last = "";

    try {
        await until(async () => (last = JSON.stringify(await marks())) === want, what);
    } catch {
        assert.fail(`${what}: ${last}`);
    }
}

test("a session marked unread shows it until it is opened", real, async () => {
    const [one] = folderSessions as [ConversationId];
    const click = (selector: string) =>
        page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);

    await fresh();
    await click(`${row(one)} [aria-label="Mark unread"]`);
    await marked([one], "marked: stored, a dot, and a bold title");
    await click(`${row(one)} [aria-label="Mark read"]`);
    await marked([], "read again from the row");

    // A tap on the row opens it.
    await click(`${row(one)} [aria-label="Mark unread"]`);
    await marked([one], "marked again");
    await click(`${row(one)} > .session`);
    await until(async () => (await touched()).path === `/s/${one}`, "opened");
    await marked([], "opening it read it");
});
