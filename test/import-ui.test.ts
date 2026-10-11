// New Session and import flows in real browser views, with isolated contexts and a scripted model.
import { cleanUp, openApp, root, scriptedModel, until, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";
import { importFixture } from "./import-fixtures.ts";
import { fakeHerdr } from "./active-import-fixture.ts";

const chromium = findBrowser();

after(cleanUp);

async function value<T>(page: BrowserPage, expression: string): Promise<T> {
    return JSON.parse(await page.evaluate(`return JSON.stringify(${expression})`)) as T;
}

async function present(page: BrowserPage, selector: string) {
    await until(
        () => value(page, `document.querySelector(${JSON.stringify(selector)}) !== null`),
        selector,
        20_000,
    );
}

async function typeField(page: BrowserPage, selector: string, text: string) {
    await present(page, selector);
    // Focus directly so the sheet's entrance animation cannot move the field away from a pointer click.
    await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
    await page.type(undefined, text);
    assert.equal(
        await value(page, `document.querySelector(${JSON.stringify(selector)}).value`),
        text,
    );
}

async function sessionTab(page: BrowserPage, tab: "new" | "import") {
    await present(page, `#session-tab-${tab}`);
    await page.evaluate(`document.querySelector("#session-tab-${tab}").click()`);
    await until(
        () =>
            value(
                page,
                `document.querySelector("#session-tab-${tab}")?.getAttribute("aria-selected") === "true" &&
                 document.querySelector("#session-panel-${tab}")?.hidden === false`,
            ),
        `${tab} session panel`,
    );
}

async function savedFileMode(page: BrowserPage) {
    await present(page, "#import-tab-history");
    await page.evaluate(`document.querySelector('#import-tab-history').click()`);
    await present(page, "#import-file-mode");
    await page.evaluate(`
        document.querySelector('.import-manual').open = true;
        document.querySelector('#import-file-mode').click();
    `);
    await present(page, "#import-path");
}

async function noLegacyImport(page: BrowserPage) {
    await until(
        () => value(page, `document.querySelector('[role="dialog"]') === null`),
        "the previous dialog has finished closing",
    );
    // Exercise the still-public legacy entry point, not a test-only route or permission flag.
    await page.evaluate(`(await import('/store.js')).openSheet({ type: 'import' })`);
    assert.equal(
        await value(
            page,
            `document.querySelector('[role="dialog"], #session-tab-import, #session-panel-import, .import-form') === null`,
        ),
        true,
        "the legacy Import entry cannot reveal private import UI to a non-owner",
    );
    await page.evaluate(`(await import('/store.js')).closeSheet()`);
}

async function wideNewButton(page: BrowserPage, scope: string) {
    const selector = `${scope} .new-button[aria-label="New session"]`;

    await present(page, selector);
    await until(
        () =>
            value(
                page,
                `document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().width > 0`,
            ),
        `${scope} is visible after resizing`,
    );
    // The desktop window animates its scale on entry; measure its resting bounds, not that transition.
    await page.evaluate(`
        await Promise.all(document.getAnimations()
            .filter((animation) => Number.isFinite(animation.effect.getComputedTiming().endTime))
            .map((animation) => animation.finished.catch(() => {})));
    `);
    const layout = await value<{
        text: string;
        visible: boolean;
        belowSearch: boolean;
        fullWidth: boolean;
        headerActions: number;
    }>(
        page,
        `(() => {
            const list = document.querySelector(${JSON.stringify(scope)} + " .sessions");
            const button = list.querySelector('.new-button[aria-label="New session"]');
            const search = list.querySelector('[placeholder="Search sessions"]').closest('.search');
            const bounds = button.getBoundingClientRect();
            const searchBounds = search.getBoundingClientRect();
            const style = getComputedStyle(list);
            const contentWidth = list.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);

            return {
                text: button.textContent.trim(),
                visible: bounds.width > 0 && bounds.height >= 40 && bounds.left >= 0 && bounds.right <= innerWidth,
                belowSearch: bounds.top >= searchBounds.bottom,
                fullWidth: Math.abs(bounds.width - contentWidth) <= 1 && Math.abs(bounds.left - searchBounds.left) <= 1,
                headerActions: list.querySelectorAll('.sessions-head .new-button, .sessions-head [aria-label="Import Pi session"]').length,
            };
        })()`,
    );

    assert.deepEqual(
        layout,
        {
            text: "New Session",
            visible: true,
            belowSearch: true,
            fullWidth: true,
            headerActions: 0,
        },
        `${scope}: one wide New Session button below Search sessions`,
    );
}

/** The secondary source choice is a compact, bordered control, not another full-width tab row. */
async function sourceToggle(page: BrowserPage) {
    await page.evaluate(`
        await Promise.all(document.getAnimations()
            .filter((animation) => Number.isFinite(animation.effect.getComputedTiming().endTime))
            .map((animation) => animation.finished.catch(() => {})));
    `);
    const layout = await value<{
        compact: boolean;
        bordered: boolean;
        touchable: boolean;
        fits: boolean;
    }>(
        page,
        `(() => {
            const tabs = document.querySelector('[role="tablist"][aria-label="Import source"]');
            const bounds = tabs.getBoundingClientRect();
            const style = getComputedStyle(tabs);

            return {
                compact: bounds.width > 0 && bounds.width <= 220,
                bordered: ['Top', 'Right', 'Bottom', 'Left'].every(side => parseFloat(style['border' + side + 'Width']) >= 1),
                touchable: [...tabs.querySelectorAll('button')].every(button => button.getBoundingClientRect().height >= 40),
                fits: bounds.left >= 0 && bounds.right <= innerWidth,
            };
        })()`,
    );

    assert.deepEqual(layout, { compact: true, bordered: true, touchable: true, fits: true });
}

async function shot(page: BrowserPage, name: string) {
    const directory = process.env.IMPORT_SCREENSHOT_DIR;

    if (directory === undefined) {
        return;
    }

    mkdirSync(directory, { recursive: true });
    await page.evaluate(`
        await Promise.all(document.getAnimations()
            .filter((animation) => Number.isFinite(animation.effect.getComputedTiming().endTime))
            .map((animation) => animation.finished.catch(() => {})));
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    `);
    const captured = await page.screenshot();

    writeFileSync(join(directory, `${name}.jpg`), Buffer.from(captured.data, "base64"));
}

test(
    "mobile import, desktop preview, two browser views and reconnect during a run",
    {
        skip: chromium === undefined ? "no Chromium browser installed" : false,
        timeout: 60_000,
    },
    async () => {
        const fixture = importFixture(work, "compacted");
        let finish!: () => void;
        const gate = new Promise<void>((resolve) => {
            finish = resolve;
        });
        const model = scriptedModel(async (request) => {
            assert.match(JSON.stringify(request.messages), /EDITED_CONTEXT/);
            await gate;

            return fauxAssistantMessage("BROWSER_CONTINUATION");
        });
        const app = await openApp(model);

        app.imports.active.local.sockets = async () => [];
        const server = createServer(
            createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
        );
        const browsers = new Browsers({
            dataDir: join(root, "ui-browser"),
            load: async () => undefined,
            save: () => {},
        });

        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

        try {
            const first = await browsers.open(1);

            await first.setViewport(VIEWPORTS.mobile);
            await first.navigate(
                `${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`,
            );
            await wideNewButton(first, ".home-list");
            await first.setViewport(VIEWPORTS.desktop);
            await wideNewButton(first, ".sidebar");
            await first.setViewport(VIEWPORTS.mobile);
            await first.evaluate(
                `document.querySelector('.home-list .new-button[aria-label="New session"]').click()`,
            );
            await present(first, '[role="dialog"][aria-label="New Session"]');
            await present(first, "#session-panel-new .dir-list");
            assert.deepEqual(
                await value(
                    first,
                    `(() => {
                    const dialog = document.querySelector('[role="dialog"][aria-label="New Session"]');

                    return [...dialog.querySelectorAll('[role="tab"]')].map((tab) => ({
                        label: tab.textContent.trim(),
                        selected: tab.getAttribute('aria-selected'),
                        panelRole: dialog.querySelector('#' + tab.getAttribute('aria-controls'))?.getAttribute('role'),
                        associated: document.getElementById(tab.getAttribute('aria-controls'))?.getAttribute('aria-labelledby') === tab.id,
                    }));
                })()`,
                ),
                [
                    {
                        label: "Start new",
                        selected: "true",
                        panelRole: "tabpanel",
                        associated: true,
                    },
                    {
                        label: "Import",
                        selected: "false",
                        panelRole: "tabpanel",
                        associated: true,
                    },
                ],
            );
            const folderDraft = join(work, "folder draft");

            await typeField(
                first,
                '#session-panel-new input[aria-label="Working directory"]',
                folderDraft,
            );
            await first.evaluate(
                `document.querySelector('#session-panel-new .check input[type="checkbox"]').click()`,
            );
            await sessionTab(first, "import");
            await savedFileMode(first);
            await typeField(first, "#import-path", fixture.path);
            await typeField(first, "#import-leaf", "draft-branch");
            await sessionTab(first, "new");
            assert.deepEqual(
                await value(
                    first,
                    `({
                    path: document.querySelector('#session-panel-new input[aria-label="Working directory"]').value,
                    worktree: document.querySelector('#session-panel-new .check input[type="checkbox"]').checked,
                })`,
                ),
                { path: folderDraft, worktree: true },
                "switching tabs keeps the typed folder and worktree choice",
            );
            await sessionTab(first, "import");
            assert.deepEqual(
                await value(
                    first,
                    `({
                    path: document.querySelector('#import-path').value,
                    leaf: document.querySelector('#import-leaf').value,
                    dialogs: document.querySelectorAll('[role="dialog"]').length,
                })`,
                ),
                { path: fixture.path, leaf: "draft-branch", dialogs: 1 },
                "switching tabs keeps the saved-file draft in the same dialog",
            );
            await first.evaluate("history.back()");
            await until(
                () =>
                    value(
                        first,
                        `document.querySelector('[role="dialog"][aria-label="New Session"]') === null && location.pathname === '/'`,
                    ),
                "one browser Back closes New Session after tab switches",
            );
            await first.evaluate(
                `document.querySelector('.home-list .new-button[aria-label="New session"]').click()`,
            );
            await sessionTab(first, "import");
            await savedFileMode(first);
            // No actual file is read for this error; the path is rejected before filesystem access.
            await first.evaluate(`
            const field = document.querySelector("#import-path");
            field.value = "relative.jsonl";
            field.dispatchEvent(new Event("input", { bubbles: true }));
        `);
            await first.evaluate(`document.querySelector(".import-form").requestSubmit()`);
            await present(first, "[role=alert]");
            assert.match(
                await value<string>(first, `document.querySelector("[role=alert]").textContent`),
                /absolute/,
            );
            await first.evaluate(`
            const field = document.querySelector("#import-path");
            field.value = ${JSON.stringify(fixture.path)};
            field.dispatchEvent(new Event("input", { bubbles: true }));
        `);
            await first.evaluate(`document.querySelector(".import-form").requestSubmit()`);
            await present(first, "#import-model");
            assert.equal(
                await value(
                    first,
                    `document.querySelector(".import-form button[type=submit]").disabled`,
                ),
                true,
            );
            assert.equal(
                await value(first, `document.documentElement.scrollWidth <= innerWidth`),
                true,
            );
            await first.evaluate(`document.querySelector(".sheet-body").scrollTop = 0`);
            await shot(first, "mobile-preview");
            await first.setViewport(VIEWPORTS.desktop);
            assert.equal(
                await value(first, `document.documentElement.scrollWidth <= innerWidth`),
                true,
            );
            await shot(first, "desktop-preview");
            await first.setViewport(VIEWPORTS.mobile);
            await first.evaluate(`
            const field = document.querySelector("#import-model");
            field.value = "faux/faux-vision";
            field.dispatchEvent(new Event("change", { bubbles: true }));
            for (const input of document.querySelectorAll(".import-form input[type=checkbox]")) input.click();
        `);
            await until(
                () =>
                    value(
                        first,
                        `!document.querySelector(".import-form button[type=submit]").disabled`,
                    ),
                "confirmed import button",
            );
            await first.evaluate(
                `document.querySelector(".sheet-body").scrollTop = document.querySelector(".sheet-body").scrollHeight`,
            );
            await shot(first, "mobile-confirmation");
            await first.evaluate(`document.querySelector(".import-form").requestSubmit()`);
            await until(
                () =>
                    value(
                        first,
                        `/^\\/s\\/\\d+$/.test(location.pathname) && document.querySelector("#import-path") === null`,
                    ),
                "imported session",
            );
            const sessionPath = await value<string>(first, "location.pathname");

            await until(
                () => value(first, `document.body.textContent.includes("Ready to continue")`),
                "imported transcript",
            );
            await shot(first, "mobile-conversation");
            const second = await browsers.open(2);

            await second.setViewport(VIEWPORTS.desktop);
            await second.navigate(
                `${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`,
            );
            await until(
                () => value(second, `(await import("/store.js")).store.state.me?.role === "owner"`),
                "second owner login",
            );
            await second.navigate(`${base}${sessionPath}`);
            await until(
                () => value(second, `document.body.textContent.includes("Ready to continue")`),
                "same history in second browser",
            );
            assert.equal(app.sessions().length, 1);
            await first.evaluate(
                `await (await import("/store.js")).actions.submit("Continue in both tabs")`,
            );
            await until(() => model.state.callCount === 1, "the one model request");
            await first.navigate("about:blank");
            finish();
            await until(
                () => value(second, `document.body.textContent.includes("BROWSER_CONTINUATION")`),
                "answer after first browser disconnects",
            );
            await first.navigate(`${base}${sessionPath}`);
            await until(
                () => value(first, `document.body.textContent.includes("BROWSER_CONTINUATION")`),
                "answer after reconnect",
            );
            await first.evaluate(`document.querySelector('[aria-label="Menu"]').click()`);
            await present(first, `a[href^="/api/imports/"]`);
            await first.evaluate(`
                [...document.querySelectorAll('.sheet .list-item')]
                    .find((item) => item.querySelector('span')?.textContent === 'Import Pi session').click();
            `);
            await present(first, '[role="dialog"][aria-label="New Session"]');
            await until(
                () =>
                    value(
                        first,
                        `document.querySelector('#session-tab-import')?.getAttribute('aria-selected') === 'true'`,
                    ),
                "the legacy menu Import entry opens the Import tab",
            );
            await until(
                () => value(first, `history.state?.pocket?.layers === 2`),
                "the menu and New Session history entries",
            );
            await sessionTab(first, "new");
            await first.evaluate("history.back()");
            await until(
                () =>
                    value(
                        first,
                        `document.querySelector('[role="dialog"][aria-label="New Session"]') === null && document.querySelector('a[href^="/api/imports/"]') !== null && location.pathname === ${JSON.stringify(sessionPath)}`,
                    ),
                "one Back returns to the menu after a legacy Import tab switch",
            );
            assert.equal(model.state.callCount, 1);
            const errors = [first, second]
                .flatMap((page) => page.logs())
                .filter((entry) => entry.level === "error");

            const expectedFailure = (entry: (typeof errors)[number]) =>
                entry.source === `${base}/api/imports/preview` &&
                entry.text.includes("status of 400");

            assert.equal(
                errors.filter(expectedFailure).length,
                1,
                "the deliberate invalid-path preview",
            );
            assert.deepEqual(
                errors.filter((entry) => !expectedFailure(entry)),
                [],
            );
        } finally {
            finish();
            await browsers.closeAll({ final: true });
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await app.close();
        }
    },
);

test(
    "guests can start sessions without import access; viewers cannot open New Session",
    {
        skip: chromium === undefined ? "no Chromium browser installed" : false,
        timeout: 60_000,
    },
    async () => {
        const folder = join(work, "guest-new-session");

        mkdirSync(folder);
        const model = scriptedModel();
        const app = await openApp(model, join(root, "data-session-permissions-ui"));
        const guest = app.config.addUser("Session guest", "guest");
        const viewer = app.config.addUser("Session viewer", "viewer");
        let discoveries = 0;

        // Even a permission regression must never contact the machine's actual Herdr instances.
        app.imports.active.local.sockets = async () => {
            discoveries++;

            return [];
        };

        const server = createServer(
            createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
        );
        const privateRequests: string[] = [];

        server.on("request", (request) => {
            const path = request.url?.split("?")[0] ?? "";

            if (/^\/api\/(imports|private)(\/|$)/.test(path)) {
                privateRequests.push(`${request.method} ${path}`);
            }
        });
        const browsers = new Browsers({
            dataDir: join(root, "session-permissions-ui-browser"),
            load: async () => undefined,
            save: () => {},
        });

        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

        try {
            const guestPage = await browsers.open(1);

            await guestPage.setViewport(VIEWPORTS.mobile);
            await guestPage.navigate(`${base}/login?token=${encodeURIComponent(guest.token)}`);
            await present(guestPage, '.new-button[aria-label="New session"]');
            await guestPage.evaluate(
                `document.querySelector('.new-button[aria-label="New session"]').click()`,
            );
            await present(guestPage, '[role="dialog"][aria-label="New Session"]');
            await present(guestPage, "#session-panel-new .dir-list");
            assert.equal(
                await value(
                    guestPage,
                    `document.querySelector('#session-tab-import, #session-panel-import, #import-file-mode, .import-form') === null`,
                ),
                true,
                "a guest's New Session dialog exposes no import controls",
            );
            await typeField(
                guestPage,
                '#session-panel-new input[aria-label="Working directory"]',
                folder,
            );
            await guestPage.evaluate(
                `document.querySelector('#session-panel-new .button.primary.wide').click()`,
            );
            await until(
                () =>
                    value(
                        guestPage,
                        `/^\\/s\\/\\d+$/.test(location.pathname) && document.querySelector('[role="dialog"][aria-label="New Session"]') === null`,
                    ),
                "the guest's newly created session",
            );
            assert.equal(app.sessions().length, 1);
            const created = app.sessions()[0];

            assert.ok(created, "the created session is in the catalogue");
            assert.equal(created.cwd, folder);
            assert.equal(created.createdBy, guest.user.id);
            await guestPage.evaluate(`document.querySelector('[aria-label="Menu"]').click()`);
            await present(guestPage, ".sheet .list-item");
            assert.equal(
                await value(
                    guestPage,
                    `[...document.querySelectorAll('.sheet .list-item')].some((item) => item.querySelector('span')?.textContent === 'Import Pi session')`,
                ),
                false,
                "the guest menu has no legacy Import entry",
            );
            await guestPage.evaluate(`
                [...document.querySelectorAll('.sheet .list-item')]
                    .find((item) => item.querySelector('span')?.textContent === 'Working directory').click();
            `);
            await present(guestPage, '[role="dialog"][aria-label="Working directory"] .dir-list');
            assert.equal(
                await value(
                    guestPage,
                    `document.querySelector('#session-tab-new, #session-tab-import, .import-form') === null`,
                ),
                true,
                "changing Working directory stays separate from New Session",
            );
            await guestPage.press("Escape");
            await guestPage.press("Escape");
            await noLegacyImport(guestPage);

            const viewerPage = await browsers.open(2);

            await viewerPage.setViewport(VIEWPORTS.mobile);
            await viewerPage.navigate(`${base}/login?token=${encodeURIComponent(viewer.token)}`);
            await present(viewerPage, `.home-list .session-row[data-id="${created.id}"]`);

            for (const viewport of [VIEWPORTS.mobile, VIEWPORTS.desktop]) {
                await viewerPage.setViewport(viewport);
                assert.equal(
                    await value(
                        viewerPage,
                        `document.querySelector('.new-button, [aria-label="New session"], [aria-label="Import Pi session"], #session-tab-import, #session-panel-import, .import-form') === null`,
                    ),
                    true,
                    `${viewport.width}px: viewers have no New Session or Import affordance`,
                );
            }

            await viewerPage.press("Alt+N");
            assert.equal(
                await value(
                    viewerPage,
                    `document.querySelector('[role="dialog"][aria-label="New Session"]') === null`,
                ),
                true,
                "the New Session keyboard shortcut is unavailable to viewers",
            );
            await viewerPage.navigate(`${base}/s/${created.id}`);
            await present(viewerPage, '[aria-label="Menu"]');
            await viewerPage.evaluate(`document.querySelector('[aria-label="Menu"]').click()`);
            await present(viewerPage, ".sheet .list-item");
            assert.equal(
                await value(
                    viewerPage,
                    `[...document.querySelectorAll('.sheet .list-item')].some((item) => item.querySelector('span')?.textContent === 'Import Pi session')`,
                ),
                false,
                "the viewer menu has no legacy Import entry",
            );
            await viewerPage.press("Escape");

            await noLegacyImport(viewerPage);

            assert.deepEqual(
                privateRequests,
                [],
                "guest and viewer UI sends no private/import requests",
            );
            assert.equal(app.sessions().length, 1, "view-only actions create no session");
            assert.equal(model.state.callCount, 0, "session creation submits no model work");
            assert.equal(discoveries, 0, "non-owner views do not discover running Pi sessions");
            assert.deepEqual(
                [guestPage, viewerPage]
                    .flatMap((page) => page.logs())
                    .filter((entry) => entry.level === "error"),
                [],
            );
        } finally {
            await browsers.closeAll({ final: true });
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await app.close();
        }
    },
);

test(
    "running-session picker moves Pi without a path on mobile and desktop",
    {
        skip: chromium === undefined ? "no Chromium browser installed" : false,
        timeout: 60_000,
    },
    async () => {
        const fixture = importFixture(work);
        const records = fixture.archive
            .trimEnd()
            .split("\n")
            .map((line) => JSON.parse(line));
        const failed = records.find((entry) => entry.message?.role === "assistant");

        failed.message.stopReason = "error";
        failed.message.content = [];
        failed.message.errorMessage = "Earlier provider failure";
        writeFileSync(
            fixture.path,
            records.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
        );
        const app = await openApp(scriptedModel(), join(root, "data-active-ui"));
        const { state, shell } = fakeHerdr(app, fixture.path);

        state.omitArgv = true;
        const server = createServer(
            createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
        );
        const browsers = new Browsers({
            dataDir: join(root, "active-ui-browser"),
            load: async () => undefined,
            save: () => {},
        });

        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

        try {
            state.status = "working";
            const page = await browsers.open(1);

            await page.setViewport(VIEWPORTS.mobile);
            await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
            await present(page, '.new-button[aria-label="New session"]');
            await page.evaluate(
                `document.querySelector('.new-button[aria-label="New session"]').click()`,
            );
            await sessionTab(page, "import");
            await present(page, ".import-session button");
            assert.equal(
                await value(page, `document.querySelector(".import-session button").disabled`),
                false,
                "working Pi opens a warning instead of an unusable disabled row",
            );
            assert.equal(
                await value(page, `document.querySelector("#import-path") === null`),
                true,
            );
            await shot(page, "running-mobile");
            await page.setViewport(VIEWPORTS.desktop);
            await shot(page, "running-desktop");
            await page.evaluate(`document.querySelector(".import-session button").click()`);
            await present(page, "#import-model");
            assert.deepEqual(state.signals, [], "preview does not stop Pi");
            await page.setViewport(VIEWPORTS.mobile);
            await page.evaluate(
                `const field = document.querySelector("#import-model"); field.value = "faux/faux-vision"; field.dispatchEvent(new Event("change", { bubbles: true }));`,
            );
            await present(page, "#import-abort-consent");
            assert.equal(
                await value(
                    page,
                    `document.querySelector('.import-form button[type=submit]').disabled`,
                ),
                true,
                "running operations cannot be aborted without explicit consent",
            );
            assert.equal(
                await value(
                    page,
                    `document.querySelector('[role=alert]').textContent.includes('Running operations will be aborted')`,
                ),
                true,
            );
            await page.evaluate(`document.querySelector('.import-form').requestSubmit()`);
            assert.deepEqual(state.signals, [], "unconfirmed submission must not stop Pi");
            await page.evaluate(`document.querySelector('#import-abort-consent').click()`);
            await until(
                () =>
                    value(
                        page,
                        `!document.querySelector(".import-form button[type=submit]").disabled`,
                    ),
                "confirmed abort and move action",
            );
            await shot(page, "move-mobile");
            await page.setViewport(VIEWPORTS.desktop);
            await shot(page, "move-desktop");
            await page.evaluate(`document.querySelector(".import-form").requestSubmit()`);
            await until(
                () =>
                    value(
                        page,
                        `document.querySelector(".import-form") === null && document.body.textContent.includes("Ready to continue")`,
                    ),
                "moved conversation",
            );
            assert.equal(state.signals.length, 1);
            assert.equal(
                await value(page, `document.body.textContent.includes("Earlier provider failure")`),
                true,
            );
            assert.deepEqual(state.table, [shell]);
            assert.equal(app.sessions().length, 1);
            assert.deepEqual(
                page.logs().filter((entry) => entry.level === "error"),
                [],
            );
        } finally {
            await browsers.closeAll({ final: true });
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await app.close();
        }
    },
);

test(
    "saved history has source tabs, searchable titles and paths, and a lazy inline branch preview",
    { skip: chromium === undefined ? "no Chromium browser installed" : false, timeout: 60_000 },
    async () => {
        const fixture = importFixture(work, "historic-browser");
        const title = "Archived rollout notes <not markup>";

        fixture.source.appendSessionInfo(title);
        const directory = join(root, "agent", "sessions", "--historic-ui--");
        const savedPath = join(directory, "2026-10-10_saved-rollout.jsonl");

        mkdirSync(directory, { recursive: true });
        copyFileSync(fixture.path, savedPath);
        const canonicalPath = realpathSync(savedPath);
        const original = readFileSync(savedPath, "utf8");
        const model = scriptedModel();
        const app = await openApp(model, join(root, "history-ui-app"));

        assert.equal(
            app.sessions().length,
            0,
            "history preview starts with its own empty app data",
        );
        app.imports.active.local.sockets = async () => [];
        const server = createServer(
            createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
        );
        const browsers = new Browsers({
            dataDir: join(root, "history-ui-browser"),
            load: async () => undefined,
            save: () => {},
        });

        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

        try {
            const page = await browsers.open(1);

            await page.setViewport(VIEWPORTS.mobile);
            await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
            await present(page, '.home-list .new-button[aria-label="New session"]');
            await page.evaluate(`document.querySelector('.home-list .new-button').click()`);
            await sessionTab(page, "import");
            await present(page, "#import-tab-history");
            await sourceToggle(page);
            assert.equal(
                await value(
                    page,
                    `document.querySelector('#import-tab-history').textContent.trim()`,
                ),
                "History",
            );
            assert.equal(
                await value(
                    page,
                    `document.querySelector('#import-tab-live').getAttribute('aria-selected')`,
                ),
                "true",
            );
            await page.evaluate(`document.querySelector('#import-tab-live').focus()`);
            await page.press("ArrowRight");
            await until(
                () =>
                    value(
                        page,
                        `document.querySelector('#import-tab-history').getAttribute('aria-selected') === 'true' && document.activeElement.id === 'import-tab-history'`,
                    ),
                "keyboard selection of History",
            );
            await present(page, "#import-history-search");
            await until(
                () =>
                    value(
                        page,
                        `document.querySelector('.import-history-list')?.textContent.includes(${JSON.stringify(title)})`,
                    ),
                "discovered saved history",
            );
            await typeField(page, "#import-history-search", "rollout");
            const row = `.import-history-session[data-path=${JSON.stringify(canonicalPath)}]`;

            await present(page, row);
            assert.equal(
                await value(
                    page,
                    `document.querySelector(${JSON.stringify(row)}).textContent.includes(${JSON.stringify(canonicalPath)})`,
                ),
                true,
                "the row shows the actual source path, not a manual path prompt",
            );
            assert.equal(
                await value(page, `document.querySelector('.import-history-preview') === null`),
                true,
            );
            await page.evaluate(
                `document.querySelector(${JSON.stringify(row)} + ' > button').click()`,
            );
            await present(page, ".import-history-preview");
            await until(
                () =>
                    value(
                        page,
                        `document.querySelector('.import-history-preview')?.textContent.includes('Ready to continue')`,
                    ),
                "saved branch excerpt",
            );
            assert.equal(
                await value(
                    page,
                    `document.querySelector(${JSON.stringify(row)} + ' > button').getAttribute('aria-expanded')`,
                ),
                "true",
            );
            assert.equal(
                await value(
                    page,
                    `document.querySelector('.import-history-preview').textContent.includes('ABANDONED_BRANCH')`,
                ),
                false,
                "unselected branches do not leak into the short history preview",
            );
            assert.equal(app.sessions().length, 0, "expanding is read-only, not importing");
            assert.equal(model.state.callCount, 0, "preview never resumes historical work");
            assert.equal(readFileSync(savedPath, "utf8"), original);
            assert.equal(
                await value(page, `document.documentElement.scrollWidth <= innerWidth`),
                true,
            );
            await shot(page, "mobile-history-expanded");
            await page.setViewport(VIEWPORTS.desktop);
            assert.equal(
                await value(page, `document.documentElement.scrollWidth <= innerWidth`),
                true,
            );
            await sourceToggle(page);
            await shot(page, "desktop-history-expanded");
            await sessionTab(page, "new");
            await sessionTab(page, "import");
            assert.equal(
                await value(page, `document.querySelector('#import-history-search').value`),
                "rollout",
            );
            assert.equal(
                await value(
                    page,
                    `document.querySelector(${JSON.stringify(row)} + ' > button').getAttribute('aria-expanded')`,
                ),
                "true",
            );
            await page.evaluate(
                `document.querySelector('.import-history-preview .button').click()`,
            );
            await present(page, "#import-model");
            assert.equal(
                await value(
                    page,
                    `document.querySelector('.import-form button[type=submit]').disabled`,
                ),
                true,
                "continuing still requires stopped-process and import-limit confirmations",
            );
            assert.equal(app.sessions().length, 0);
            assert.equal(readFileSync(savedPath, "utf8"), original);
            assert.deepEqual(
                page.logs().filter((entry) => entry.level === "error"),
                [],
            );
        } finally {
            await browsers.closeAll({ final: true });
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await app.close();
        }
    },
);
