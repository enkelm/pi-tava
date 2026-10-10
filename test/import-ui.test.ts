// The import sheet and two real browser views, in isolated Chromium contexts with a scripted model.
import { cleanUp, openApp, root, scriptedModel, until, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
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
            await present(first, '[aria-label="Import Pi session"]');
            await first.evaluate(
                `document.querySelector('[aria-label="Import Pi session"]').click()`,
            );
            await present(first, "#import-file-mode");
            await first.evaluate(`document.querySelector("#import-file-mode").click()`);
            await present(first, "#import-path");
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
            await present(page, '[aria-label="Import Pi session"]');
            await page.evaluate(
                `document.querySelector('[aria-label="Import Pi session"]').click()`,
            );
            await present(page, ".import-session button");
            assert.equal(
                await value(page, `document.querySelector(".import-session button").disabled`),
                true,
            );
            assert.equal(
                await value(page, `document.querySelector("#import-path") === null`),
                true,
            );
            state.status = "idle";
            await page.evaluate(
                `[...document.querySelectorAll("button")].find((button) => button.textContent === "Refresh").click()`,
            );
            await until(
                () => value(page, `!document.querySelector(".import-session button").disabled`),
                "ready source",
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
            await until(
                () =>
                    value(
                        page,
                        `!document.querySelector(".import-form button[type=submit]").disabled`,
                    ),
                "ready move action",
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
