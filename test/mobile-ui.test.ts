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
            if (/^pocket\.(files|browser)/.test(key)) {
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

before(async () => {
    if (chromium === undefined) {
        return;
    }

    writeFileSync(join(work, "README.md"), "# Hello\n\nA file to read.\n");
    writeFileSync(join(work, "web.env"), "PORT=3000\nHOST=127.0.0.1\n");
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
