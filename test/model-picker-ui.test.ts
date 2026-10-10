// One real-browser fixture for desktop/mobile grouping. Synthetic providers supply the catalog;
// real faux models prove selection reaches the shared configure action and saved agent state.
import { cleanUp, newSession, openApp, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const picker = '[role="dialog"][aria-label="Model"]';
const search = `${picker} input[placeholder="Search models"]`;
const currentModels = ["faux/faux-1", "faux/faux-2", "faux/faux-vision"] as const;
const alphaModels = ["alpha/atlas-id", "alpha/cedar-id", "alpha/courier-id"] as const;
const betaModels = ["beta/nova-id", "beta/orbit-id", "beta/pulse-id"] as const;
// Interleaved providers, with neither the current provider nor model first.
const catalog = [
    ["alpha", "atlas-id", "Atlas Display"],
    ["faux", "faux-2", "Faux Second"],
    ["beta", "nova-id", "Beacon Display"],
    ["alpha", "cedar-id", "Cedar Display"],
    ["faux", "faux-vision", "Faux Vision"],
    ["beta", "orbit-id", "Orbit Display"],
    ["faux", "faux-1", "Faux Current"],
    ["alpha", "courier-id", "Courier Display"],
    ["beta", "pulse-id", "Pulse Display"],
].map(([provider, id, name]) => ({ provider, id, name, contextWindow: 128_000 }));

type Group = [provider: string, expanded: boolean, visibleModels: string[]];
type ConfigureRequest = { body: string; status?: number };

after(cleanUp);

async function inPage<T>(page: BrowserPage, script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

async function present(page: BrowserPage, selector: string, expected = true) {
    await until(
        () =>
            inPage<boolean>(
                page,
                `return JSON.stringify(!!document.querySelector(${JSON.stringify(selector)}) === ${expected})`,
            ),
        `${expected ? "show" : "hide"} ${selector}`,
    );
}

async function focus(page: BrowserPage, selector: string) {
    await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
}

async function click(page: BrowserPage, selector: string) {
    await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
}

/** Dispatch the picker's custom keyboard events at the focused control. */
async function press(page: BrowserPage, name: string) {
    await page.evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {
        key: ${JSON.stringify(name)}, bubbles: true, cancelable: true,
    }))`);
}

async function fill(page: BrowserPage, query: string) {
    await page.evaluate(`
        const input = document.querySelector(${JSON.stringify(search)});

        input.focus();
        input.value = ${JSON.stringify(query)};
        input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    `);
}

const toggle = (provider: string) => `${picker} .model-provider-toggle:has([title="${provider}"])`;

/** Disclosure accessibility and visible options, allowing hidden options to remain mounted. */
async function groups(page: BrowserPage): Promise<Group[]> {
    return inPage<Group[]>(
        page,
        `
        return JSON.stringify([...document.querySelectorAll('${picker} .model-provider')].map(section => {
            const button = section.querySelector('.model-provider-toggle');
            const boxes = section.querySelectorAll('[role=listbox]');
            const list = document.getElementById(button.getAttribute('aria-controls'));
            const expanded = button.getAttribute('aria-expanded') === 'true';

            if (boxes.length !== 1 || list !== boxes[0] || !section.contains(list)
                || list.hidden !== !expanded || (list.getClientRects().length > 0) !== expanded) {
                throw new Error('Provider disclosure must control its own visible/hidden listbox');
            }

            return [button.querySelector('.model-provider-name').textContent.trim(), expanded,
                expanded ? [...list.querySelectorAll('[role=option]')].map(option => option.title.split(' · ')[0]) : []];
        }));
    `,
    );
}

async function defaults(page: BrowserPage, models: readonly string[] = currentModels) {
    assert.deepEqual(
        await groups(page),
        [
            ["faux", true, models],
            ["alpha", false, []],
            ["beta", false, []],
        ],
        "current provider/model first and visible, others collapsed",
    );
    assert.deepEqual(
        await inPage(
            page,
            `
        return JSON.stringify([...document.querySelectorAll('${picker} [role=listbox]:not([hidden]) [aria-selected=true]')]
            .map(option => option.title.split(' · ')[0]));
    `,
        ),
        [models[0]],
        "the saved current model is selected",
    );
}

test(
    "provider-grouped model picker: disclosure, search and visible-only keyboard configure",
    { skip: findBrowser() === undefined ? "no Chromium installed" : false, timeout: 90_000 },
    async (t) => {
        const app = await openApp(scriptedModel());
        const requests: ConfigureRequest[] = [];
        const handler = createHandler({
            app,
            listen: { host: "127.0.0.1", port: 0 },
            restart: () => {},
        });
        const server = createServer(async (request, response) => {
            if (request.method === "POST" && request.url?.endsWith("/configure")) {
                const record: ConfigureRequest = { body: "" };

                requests.push(record);
                request.on("data", (chunk) => {
                    record.body += chunk;
                });
                response.on("finish", () => {
                    record.status = response.statusCode;
                });
            }

            await handler(request, response);
        });
        const browsers = new Browsers({
            dataDir: join(root, "model-picker-browser"),
            load: async () => undefined,
            save: () => {},
        });

        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

        try {
            const page = await browsers.open(1);

            for (const viewport of ["desktop", "mobile"] as const) {
                await t.test(viewport, async () => {
                    const id = await newSession(app);
                    const start = requests.length;

                    const open = async () => {
                        await page.evaluate(`
                            const { store, openSheet } = await import('/store.js');

                            store.set({ models: ${JSON.stringify(catalog)} });
                            openSheet({ type: 'model' });
                        `);
                        await present(page, search);
                        // Preact's after-paint autofocus must finish before native disclosure keys.
                        await until(
                            () =>
                                inPage<boolean>(
                                    page,
                                    `
                            return JSON.stringify(document.activeElement === document.querySelector(${JSON.stringify(viewport === "mobile" ? picker : search)}));
                        `,
                                ),
                            "initial picker focus",
                        );
                    };

                    const move = async (key: string, model: string) => {
                        await press(page, key);
                        await until(
                            () =>
                                inPage<boolean>(
                                    page,
                                    `
                            return JSON.stringify(document.querySelector('${picker} [role=option].on')?.title.split(' · ')[0] === ${JSON.stringify(model)});
                        `,
                                ),
                            `keyboard reaches visible ${model}`,
                        );
                    };

                    const configured = async (modelId: string, count: number) => {
                        await until(
                            () =>
                                requests.length === start + count &&
                                requests.at(-1)?.status === 200,
                            "actual configure HTTP acknowledgement",
                        );
                        const model = { provider: "faux", modelId };

                        assert.deepEqual(JSON.parse(requests.at(-1)!.body), { model });
                        assert.deepEqual(
                            (await app.agentState(id))?.model,
                            model,
                            "chosen model is saved",
                        );
                        await present(page, picker, false);
                        await until(
                            () =>
                                inPage<boolean>(
                                    page,
                                    `
                            const { store } = await import('/store.js');

                            return JSON.stringify(store.state.view.agent?.model?.modelId === ${JSON.stringify(modelId)});
                        `,
                                ),
                            "browser observes saved current model",
                        );
                    };

                    await page.setViewport(VIEWPORTS[viewport]);
                    await page.navigate(
                        `${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`,
                    );
                    await page.navigate(`${base}/s/${id}`);
                    await present(page, ".composer .model-chip");
                    await open();
                    await defaults(page);

                    // No visible models: arrows/Enter cannot select from collapsed providers.
                    await click(page, toggle("faux"));
                    assert.deepEqual(await groups(page), [
                        ["faux", false, []],
                        ["alpha", false, []],
                        ["beta", false, []],
                    ]);
                    await focus(page, picker);
                    await press(page, "ArrowDown");
                    await press(page, "ArrowUp");
                    await press(page, "Enter");
                    assert.equal(requests.length, start, "Enter cannot choose a collapsed model");
                    await present(page, picker);

                    // Provider disclosure is separate from model selection.
                    await click(page, toggle("beta"));
                    assert.deepEqual((await groups(page))[2], ["beta", true, betaModels]);
                    await click(page, toggle("beta"));
                    assert.deepEqual((await groups(page))[2], ["beta", false, []]);
                    assert.equal(
                        requests.length,
                        start,
                        "provider disclosure never selects a model",
                    );

                    // Each search resets collapse overrides and reveals provider/id/name matches.
                    for (const [query, matches] of [
                        [" BETA ", betaModels],
                        ["NOVA-ID", [betaModels[0]]],
                        ["beacon display", [betaModels[0]]],
                        ["beta/nova-id", [betaModels[0]]],
                    ] as const) {
                        await fill(page, query);
                        assert.deepEqual(
                            await groups(page),
                            [["beta", true, matches]],
                            `search ${query}`,
                        );
                        await click(page, toggle("beta"));
                        assert.deepEqual(await groups(page), [["beta", false, []]]);
                    }

                    await fill(page, "no-such-model");
                    assert.deepEqual(await groups(page), []);
                    await press(page, "Enter");
                    assert.equal(
                        requests.length,
                        start,
                        "empty search cannot choose a stale model",
                    );
                    await fill(page, "");
                    await defaults(page);

                    // Reach alpha, then collapse it: stale/flat indices must never pick its hidden models.
                    await click(page, toggle("alpha"));
                    assert.deepEqual((await groups(page))[1], ["alpha", true, alphaModels]);
                    await focus(page, search);
                    await move("ArrowUp", alphaModels[2]);
                    await click(page, toggle("alpha"));
                    await focus(page, search);
                    await move("ArrowDown", currentModels[1]);
                    await move("ArrowDown", currentModels[2]);
                    await move("ArrowDown", currentModels[0]);
                    await move("ArrowUp", currentModels[2]);
                    await move("ArrowUp", currentModels[1]);
                    await press(page, "Enter");
                    await configured("faux-2", 1);

                    // Root keys use the same visible-only flattening; reopening resets disclosure.
                    await open();
                    await defaults(page, [currentModels[1], currentModels[2], currentModels[0]]);
                    await focus(page, picker);
                    await move("ArrowUp", currentModels[0]);
                    await move("ArrowDown", currentModels[1]);
                    await move("ArrowDown", currentModels[2]);
                    await press(page, "Enter");
                    await configured("faux-vision", 2);
                    assert.deepEqual(
                        page.logs().filter((entry) => entry.level === "error"),
                        [],
                        "no browser errors",
                    );
                });
            }
        } finally {
            await browsers.closeAll({ final: true });
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await app.close();
        }
    },
);
