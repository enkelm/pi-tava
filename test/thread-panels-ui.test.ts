// Right-side panel selection belongs to a thread, not the whole tab. Drive the real app and its
// history in isolated Chromium; all files, sessions and browser pages are synthetic.
import {
    type App,
    cleanUp,
    newSession,
    openApp,
    root,
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

const real = { skip: findBrowser() === undefined ? "no Chromium installed" : false };
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base: string;
let first: ConversationId;
let second: ConversationId;
let third: ConversationId;

async function value<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

async function click(selector: string) {
    await until(
        async () =>
            value<boolean>(
                `return JSON.stringify(document.querySelector(${JSON.stringify(selector)}) !== null)`,
            ),
        selector,
    );
    await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
}

type Panel = "files" | "browser" | "people" | null;

async function reach(id: ConversationId | null, panel: Panel, layers = 0) {
    let last: { path: string; panels: string[]; layers: number } | undefined;

    await until(async () => {
        const actual = await value<{ path: string; panels: string[]; layers: number }>(`
            return JSON.stringify({
                path: location.pathname,
                panels: [
                    ['files', '.files-tile:not(.leaving)'],
                    ['browser', '.browser.window:not(.leaving)'],
                    ['people', '.people:not(.leaving)'],
                ].filter(([, selector]) => document.querySelector(selector)).map(([name]) => name),
                layers: history.state?.pocket?.layers ?? 0,
            });
        `);

        last = actual;

        return (
            actual.path === (id === null ? "/" : `/s/${id}`) &&
            JSON.stringify(actual.panels) === JSON.stringify(panel === null ? [] : [panel]) &&
            actual.layers === layers
        );
    }, `thread ${id}, panel ${panel}, ${layers} Back layers`).catch(async () => {
        assert.fail(
            `Expected thread ${id}, ${panel}, ${layers} Back layers; got ${JSON.stringify(last)}; file: ${await page.evaluate(`JSON.stringify({name: document.querySelector('.ft-view:not(.leaving) .ft-view-name')?.textContent, width: document.querySelector('.ft')?.clientWidth, body: document.body.innerText.slice(-1500)})`)}; errors: ${JSON.stringify(page.logs().filter((entry) => entry.level === "error"))}`,
        );
    });
}

async function go(id: ConversationId | null) {
    await page.evaluate(`(await import('/store.js')).navigate(${id})`);
    await until(
        async () => {
            const loaded = await value<{ path: string; id: number | null; open: boolean }>(`
            const { store } = await import('/store.js');

            return JSON.stringify({
                path: location.pathname,
                id: store.state.view.conversation?.id ?? null,
                open: store.state.connection === 'open',
            });
        `);

            return (
                loaded.path === (id === null ? "/" : `/s/${id}`) && loaded.id === id && loaded.open
            );
        },
        `loaded thread ${id}`,
        20_000,
    );
}

async function fresh(mobile = false) {
    await page.setViewport(mobile ? VIEWPORTS.mobile : VIEWPORTS.desktop);
    await page.evaluate("sessionStorage.clear()");
    await page.navigate(`${base}/`);
    await until(
        async () =>
            value<boolean>(
                `return JSON.stringify(document.querySelector('.session-row[data-id="${first}"]') !== null)`,
            ),
        "synthetic session list",
    );

    // Browser history entries require trusted input. Home owns creation; on phones its
    // native sessions button opens the real drawer before the row starts a route.
    if (mobile) {
        await click('.topbar [aria-label="Open sessions"]');
        await until(
            () =>
                value<boolean>(
                    `return JSON.stringify(!!document.querySelector('.drawer:not([data-state="closing"]) .session-row[data-id="${first}"]'))`,
                ),
            "the phone session drawer",
        );
    }

    await page.click({
        selector: `${mobile ? ".drawer" : ".sidebar"} .session-row[data-id="${first}"] .session`,
    });
    await go(first);
}

before(async () => {
    if (real.skip) {
        return;
    }

    writeFileSync(join(work, "first.txt"), "Only the first thread selects this file.\n");
    writeFileSync(join(work, "second.txt"), "Only the second thread selects this file.\n");
    app = await openApp(scriptedModel());
    const handler = createHandler({
        app,
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
    });

    server = createServer((request, response) => {
        // Never discover or attach to real local Herdr panes, even on Private navigation.
        if (request.url?.startsWith("/api/private")) {
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ instances: [], errors: [] }));

            return;
        }

        if (request.url?.startsWith("/panel-page/")) {
            response.writeHead(200, { "Content-Type": "text/html" });
            response.end(`<title>${request.url}</title><p>Synthetic page</p>`);

            return;
        }

        void handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    first = await newSession(app);
    second = await newSession(app);
    third = await newSession(app);
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "thread-panels-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await until(
        async () =>
            value<boolean>(
                `return JSON.stringify(document.querySelector('.session-row') !== null)`,
            ),
        "signed in",
    );
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test(
    "desktop threads restore their own panel, files and browser pages across navigation and reload",
    real,
    async () => {
        await fresh();
        await go(first);
        await click('.topbar [aria-label="Files"]');
        await reach(first, "files");
        await click('.ft-row.file[data-path$="/first.txt"]');
        await go(second);
        await reach(second, null);
        await click('.topbar [aria-label="Browser"]');
        await reach(second, "browser");
        await page.evaluate(
            `await (await import('/browser.js')).openInBrowser(${JSON.stringify(`${base}/panel-page/second`)})`,
            { timeoutMs: 60_000 },
        );
        await until(
            async () =>
                value<boolean>(
                    `return JSON.stringify(document.querySelector('.browser-address input')?.value.includes('/panel-page/second') === true)`,
                ),
            "initial second-thread browser navigation",
            30_000,
        );
        await go(first);
        await reach(first, "files");
        await until(
            async () =>
                value<boolean>(
                    `return JSON.stringify(document.querySelector('.ft-view-name')?.textContent === 'first.txt')`,
                ),
            "first thread's selected file",
        );
        await go(third);
        await reach(third, null);
        await page.evaluate(`(await import('/store.js')).openSheet({ type: 'chat' })`);
        await reach(third, "people");
        await go(second);
        await reach(second, "browser");
        await page.evaluate("history.back()");
        await reach(third, "people");
        await page.evaluate("history.forward()");
        await reach(second, "browser");
        await until(
            async () =>
                value<boolean>(
                    `return JSON.stringify(document.querySelector('.browser-address input')?.value.includes('/panel-page/second') === true)`,
                ),
            "second thread's existing browser address",
            30_000,
        );
        await click('.topbar [aria-label="Files"]');
        await reach(second, "files");
        await click('.ft-row.file[data-path$="/second.txt"]');
        await page.evaluate(`(await import('/files-panel.js')).setFilesOpen(true, 'changes')`);
        await go(first);
        await reach(first, "files");
        assert.equal(
            await value<string>(
                `return JSON.stringify(document.querySelector('.files-tabs [aria-selected="true"]').textContent.trim())`,
            ),
            "Files",
        );
        await page.navigate(`${base}/s/${second}`);
        await reach(second, "files");
        assert.ok(
            (
                await value<string>(
                    `return JSON.stringify(document.querySelector('.files-tabs [aria-selected="true"]').textContent)`,
                )
            ).includes("Changes"),
        );
        await click(".files-tabs button:first-child");
        await until(
            async () =>
                value<boolean>(
                    `return JSON.stringify(document.querySelector('.ft-view-name')?.textContent === 'second.txt')`,
                ),
            "second thread's selected file after reload",
        );
        await click('[aria-label="Close the files"]');
        await reach(second, null);
        await go(third);
        await reach(third, "people");
        await click('[aria-label="Close the People panel"]');
        await go(first);
        await reach(first, "files");
        await go(second);
        await reach(second, null);
        await go(third);
        await reach(third, null);
    },
);

test(
    "mobile restores panels on route Back, then Back closes the restored file and panel",
    real,
    async () => {
        await fresh(true);
        await go(first);
        await click('.topbar [aria-label="Files"]');
        await reach(first, "files", 1);
        await click('.ft-row.file[data-path$="/first.txt"]');
        await reach(first, "files", 2);
        await go(second);
        await reach(second, null);
        await page.evaluate(`(await import('/browser.js')).setBrowserOpen(true)`);
        await reach(second, "browser", 1);
        await page.evaluate("history.back()");
        await reach(second, null);
        await page.evaluate("history.back()");
        await reach(first, "files", 2);
        await page.evaluate("history.back()");
        await reach(first, "files", 1);
        assert.equal(
            await value<boolean>(
                `return JSON.stringify(document.querySelector('.ft-view:not(.leaving)') === null)`,
            ),
            true,
        );
        await page.evaluate("history.back()");
        await reach(first, null);
        await go(second);
        await reach(second, null);
        await go(first);
        await reach(first, null);

        // A multi-entry route traversal (such as the history menu) leaves the old thread's layers behind.
        await click('.topbar [aria-label="Files"]');
        await reach(first, "files", 1);
        await click('.ft-row.file[data-path$="/first.txt"]');
        await reach(first, "files", 2);
        await go(second);
        await reach(second, null);
        await page.evaluate(`(await import('/files-panel.js')).setFilesOpen(true)`);
        await reach(second, "files", 1);
        await click('.ft-row.file[data-path$="/second.txt"]');
        await reach(second, "files", 2);
        await page.evaluate("history.go(-3)");
        await reach(first, "files", 2);
        await go(second);
        await reach(second, "files", 2);
        assert.equal(
            await value<string>(
                `return JSON.stringify(document.querySelector('.ft-view-name')?.textContent)`,
            ),
            "second.txt",
        );

        // The same route ownership applies to Browser's covering Back layer.
        await go(first);
        await reach(first, "files", 2);
        await page.evaluate(`(await import('/browser.js')).setBrowserOpen(true)`);
        await reach(first, "browser", 1);
        await go(second);
        await reach(second, "files", 2);
        await page.evaluate(`(await import('/browser.js')).setBrowserOpen(true)`);
        await reach(second, "browser", 1);
        await page.evaluate("history.go(-2)");
        await reach(first, "browser", 1);
        await page.evaluate("history.back()");
        await reach(first, null);
        await go(second);
        await reach(second, "browser", 1);
    },
);

test(
    "new threads and home/Private routes do not inherit panels; legacy preferences bind only once",
    real,
    async () => {
        await fresh();
        await page.evaluate(`
        sessionStorage.setItem('pocket.files', '1');
        sessionStorage.setItem('pocket.filesTab', 'changes');
    `);
        await page.navigate(`${base}/s/${first}`);
        await reach(first, "files");
        assert.ok(
            (
                await value<string>(
                    `return JSON.stringify(document.querySelector('.files-tabs [aria-selected="true"]').textContent)`,
                )
            ).includes("Changes"),
        );
        const created = await newSession(app);

        await go(created);
        await reach(created, null);
        await go(first);
        await reach(first, "files");
        await go(null);
        await reach(null, null);
        await page.evaluate(
            `(await import('/store.js')).navigate(null, { privateId: 'synthetic-missing-pane' })`,
        );
        await until(
            async () =>
                value<boolean>(
                    `return JSON.stringify(location.pathname === '/private/synthetic-missing-pane' && document.querySelector('.files-tile, .browser.window, .people') === null)`,
                ),
            "Private has no shared-thread panel",
        );
        await go(first);
        await reach(first, "files");
        await page.evaluate(`sessionStorage.setItem('pocket.panels.${second}', '{malformed')`);
        await page.navigate(`${base}/s/${second}`);
        await reach(second, null);
        await go(first);
        await reach(first, "files");

        // Old globals found at the home screen cannot leak to the next thread opened.
        await page.evaluate(`
        sessionStorage.removeItem('pocket.panels.${third}');
        sessionStorage.setItem('pocket.browser', '1');
    `);
        await page.navigate(`${base}/`);
        await reach(null, null);
        await go(third);
        await reach(third, null);
    },
);
