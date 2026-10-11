// Real Settings/browser boundary with metadata-only HTTP fixtures. No package code or installer runs.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";
import type { ProviderPackagesSnapshot } from "../src/server/provider-packages.ts";
import { cleanUp, openApp, root, scriptedModel, until } from "./helpers.ts";

const section = '[aria-label="Provider packages"]';
const name = "@a-very-long-scope/provider-with-a-long-name-that-must-wrap-on-a-phone";
const snapshot: ProviderPackagesSnapshot & { recoveryRequired: boolean } = {
    enabled: false,
    activeEnabled: false,
    restartRequired: false,
    recoveryRequired: false,
    packages: [
        {
            id: "managed-one",
            name,
            version: "4.3.0",
            installedVersion: "4.3.0",
            activeVersion: "4.2.0",
            enabled: false,
            active: false,
            compatible: true,
            status: "disabled",
            source: `npm:${name}@4.3.0`,
            previousVersion: "4.2.0",
            settings: { baseUrl: "https://provider.example", aliases: {} },
        },
    ],
    available: [
        {
            id: "local-one",
            name: "pi-provider-litellm",
            version: "4.2.0",
            source: "npm:pi-provider-litellm@4.2.0",
            compatible: true,
        },
        {
            id: "unsupported",
            name: "pi-provider-without-a-profile",
            version: "1.0.0",
            source: "npm:pi-provider-without-a-profile@1.0.0",
            compatible: false,
            reason: "No supported provider-host compatibility profile.",
        },
    ],
};

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

async function click(page: BrowserPage, selector: string) {
    await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
}

async function fill(page: BrowserPage, selector: string, value: string) {
    await page.evaluate(`
        const input = document.querySelector(${JSON.stringify(selector)});
        input.value = ${JSON.stringify(value)};
        input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    `);
}

test(
    "Providers packages: owner/capability gate, trust cancellation, restart queue, errors and mobile wrapping",
    { skip: findBrowser() === undefined ? "no Chromium installed" : false, timeout: 90_000 },
    async () => {
        // Guards public UI behavior, not server authorization (covered at the HTTP/package owner).
        // Credible risks: a new section fetching on old servers/guest accounts; confirmation bypass;
        // presenting desired versions as running code; scoped names forcing horizontal overflow.
        // Existing Settings tests do not exercise package metadata; no production test seam is needed.
        const app = await openApp(scriptedModel());
        const guest = app.config.addUser("Package guest", "guest");
        const requests: Record<string, unknown>[] = [];
        const refreshRequests: unknown[] = [];
        let releaseRefresh: (() => void) | undefined;
        let nativeModels = 2;
        let reads = 0;
        let fail = false;
        let data = structuredClone(snapshot);
        const handler = createHandler({
            app,
            listen: { host: "127.0.0.1", port: 0 },
            restart: () => {},
        });
        const server = createServer(async (request, response) => {
            const json = (body: unknown, status = 200) => {
                response.writeHead(status, {
                    "Content-Type": "application/json",
                    "Cache-Control": "no-store",
                });
                response.end(JSON.stringify(body));
            };

            if (request.url === "/api/provider-packages") {
                if (request.method === "GET") {
                    reads++;
                    json(
                        fail ? { error: "Package discovery unavailable. Try again." } : data,
                        fail ? 503 : 200,
                    );
                } else {
                    let raw = "";

                    for await (const chunk of request) {
                        raw += chunk;
                    }

                    const body = JSON.parse(raw) as Record<string, unknown>;

                    requests.push(body);
                    // The fixture only supplies acknowledgments. Assertions inspect real rendered controls,
                    // the actual HTTP request and the response's unchanged active runtime fields.
                    data.restartRequired = true;

                    if (body.action === "module") {
                        data.enabled = body.enabled === true;
                    }

                    if (body.action === "enable") {
                        data.packages[0]!.enabled = body.enabled === true;
                    }

                    json(data);
                }

                return;
            }

            if (request.url === "/api/providers") {
                json([
                    {
                        id: "native",
                        name: "Native provider",
                        configured: false,
                        models: nativeModels,
                        apiKey: true,
                        hosted: true,
                    },
                    ...Array.from({ length: 40 }, (_, index) => ({
                        id: `ordinary-${index}`,
                        name: `Ordinary provider ${index + 1}`,
                        configured: false,
                        models: 2,
                        apiKey: true,
                    })),
                ]);

                return;
            }

            if (request.url === "/api/providers/native/refresh" && request.method === "POST") {
                let raw = "";

                for await (const chunk of request) {
                    raw += chunk;
                }

                refreshRequests.push(JSON.parse(raw));
                await new Promise<void>((resolve) => {
                    releaseRefresh = resolve;
                });
                nativeModels = 3;
                json({ ok: true });

                return;
            }

            if (request.url === "/api/extensions") {
                json({
                    modules: [
                        {
                            file: "pi-providers.ts",
                            title: "Pi provider compatibility",
                            summary: "Provider packages",
                            enabled: true,
                            active: false,
                            restartOnly: true,
                            restartRequired: true,
                            extensions: [],
                            source: "built-in",
                        },
                        {
                            file: "ordinary.ts",
                            title: "Ordinary extension",
                            enabled: true,
                            extensions: [],
                            source: "built-in",
                        },
                    ],
                });

                return;
            }

            await handler(request, response);
        });
        const browsers = new Browsers({
            dataDir: join(root, "provider-package-browser"),
            load: async () => undefined,
            save: () => {},
        });

        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

        try {
            const page = await browsers.open(1);

            const open = async (capability: number, tab = "providers", expand = true) => {
                await page.evaluate(`
                    const { store, openSheet } = await import('/store.js');
                    store.set({ server: { ...store.state.server, providerPackages: ${capability} } });
                    openSheet({ type: 'settings', tab: ${JSON.stringify(tab)} });
                `);
                await present(page, '[role="dialog"][aria-label="Settings"]');

                if (expand && capability >= 1 && tab === "providers") {
                    await page.evaluate(`
                        const disclosure = document.querySelector('${section} > details');
                        if (disclosure && !disclosure.open) {
                            disclosure.querySelector('summary').click();
                        }
                    `);
                }
            };

            await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
            await present(page, ".sidebar");
            await open(0);
            await present(page, ".provider .button");
            await present(page, section, false);
            assert.equal(reads, 0, "old server does not receive unsupported package requests");
            const refreshButton = '.provider [aria-label="Refresh models for Native provider"]';

            await present(page, refreshButton);
            assert.equal(
                await inPage<number>(
                    page,
                    `return JSON.stringify([...document.querySelectorAll('.provider button')].filter(button => button.textContent.trim() === 'Refresh models').length)`,
                ),
                1,
                "only hosted native rows offer refresh",
            );
            await click(page, refreshButton);
            await until(
                () => refreshRequests.length === 1 && releaseRefresh !== undefined,
                "hosted refresh HTTP request",
            );
            assert.deepEqual(
                refreshRequests,
                [{}],
                "refresh uses the owner endpoint without package settings or credentials",
            );
            assert.ok(
                await inPage<boolean>(
                    page,
                    `return JSON.stringify(document.querySelector(${JSON.stringify(refreshButton)}).disabled && document.querySelector(${JSON.stringify(refreshButton)}).getAttribute('aria-busy') === 'true')`,
                ),
                "refresh shows an in-flight state",
            );
            releaseRefresh!();
            await until(
                () =>
                    inPage<boolean>(
                        page,
                        `return JSON.stringify(!document.querySelector(${JSON.stringify(refreshButton)}).disabled && document.querySelector(${JSON.stringify(refreshButton)}).closest('.provider').textContent.includes('3 models'))`,
                    ),
                "refreshed catalog displayed",
            );
            assert.equal(requests.length, 0, "model refresh never stages package changes");
            await page.evaluate(`(await import('/store.js')).store.set({ sheet: null })`);
            await open(1, "providers", false);
            await present(page, `${section} .extension`);
            assert.equal(reads, 1, "opening packages discovers once, not registry polling");

            for (const viewport of ["desktop", "mobile"] as const) {
                await page.setViewport(VIEWPORTS[viewport]);
                assert.ok(
                    await inPage<boolean>(
                        page,
                        `
                    const packages = document.querySelector('${section}');
                    const disclosure = packages.querySelector(':scope > details');
                    const search = document.querySelector('input[aria-label="Search providers"]');
                    const nativeButton = document.querySelector('.provider button');
                    const panel = document.querySelector('.settings-panel:not([hidden])');
                    return JSON.stringify(!disclosure.open && packages.getBoundingClientRect().height <= 48
                        && packages.getBoundingClientRect().bottom <= search.getBoundingClientRect().top
                        && nativeButton.checkVisibility()
                        && nativeButton.getBoundingClientRect().bottom <= panel.getBoundingClientRect().bottom
                        && !packages.querySelector('.extension').checkVisibility());
                `,
                    ),
                    `${viewport}: package management is compact and discoverable above 40 native providers, without hiding sign-in`,
                );
            }

            await click(page, `${section} > details > summary`);
            assert.ok(
                await inPage<boolean>(
                    page,
                    `return JSON.stringify(document.querySelector('${section}').textContent.includes('API-key chat only. While enabled, Coop ignores models.json custom models/overrides.'))`,
                ),
                "compatibility limitation is visible before enabling",
            );
            assert.ok(
                await inPage<boolean>(
                    page,
                    `return JSON.stringify(document.querySelector(${JSON.stringify(section)}).textContent.includes('No supported provider-host compatibility profile.'))`,
                ),
            );
            assert.equal(
                await inPage<number>(
                    page,
                    `return JSON.stringify([...document.querySelectorAll('${section} .extension')].find(row => row.textContent.includes('pi-provider-without-a-profile')).querySelectorAll('button').length)`,
                ),
                0,
                "incompatible package cannot be selected or enabled",
            );

            // Native confirm is stubbed only in this disposable browser, to prove cancel does not mutate.
            await page.evaluate(
                `window.confirmations = []; window.confirm = text => { window.confirmations.push(text); return false; }`,
            );
            const managedSwitch = `${section} .extension [role="switch"]`;

            await click(page, managedSwitch);
            assert.equal(requests.length, 0);
            assert.ok(
                await inPage<boolean>(
                    page,
                    `return JSON.stringify(window.confirmations[0].includes("server's rights") && window.confirmations[0].includes('credentials'))`,
                ),
            );
            await page.evaluate(`window.confirm = () => true`);
            await click(page, managedSwitch);
            await until(() => requests.length === 1, "enable HTTP request");
            assert.deepEqual(requests[0], {
                action: "enable",
                name,
                enabled: true,
                trusted: true,
            });
            await until(
                () =>
                    inPage<boolean>(
                        page,
                        `return JSON.stringify(document.querySelector('${section}').textContent.includes('Changes queued.'))`,
                    ),
                "restart note",
            );
            assert.ok(
                await inPage<boolean>(
                    page,
                    `return JSON.stringify(document.querySelector('${section}').textContent.includes('Selected: 4.3.0') && document.querySelector('${section}').textContent.includes('Active: 4.2.0'))`,
                ),
            );
            await click(page, `${section} .setting [role="switch"]`);
            await until(() => requests.length === 2, "module HTTP request");
            assert.deepEqual(requests[1], { action: "module", enabled: true, trusted: true });
            assert.equal(data.activeEnabled, false, "no runtime activation or automatic restart");
            await present(page, `${section} [role="status"].ok`);

            for (const viewport of ["desktop", "mobile"] as const) {
                await page.setViewport(VIEWPORTS[viewport]);
                await page.evaluate(
                    `document.querySelector('${section}').scrollIntoView({ block: 'start' })`,
                );
                assert.ok(
                    await inPage<boolean>(
                        page,
                        `
                    const panel = document.querySelector('.settings-panel:not([hidden])');
                    const rows = [...document.querySelectorAll('${section} .extension')];
                    return JSON.stringify(panel.scrollWidth <= panel.clientWidth + 1 && rows.every(row => row.getBoundingClientRect().right <= innerWidth));
                `,
                    ),
                    `${viewport}: scoped names and source fit without horizontal scrolling`,
                );
                await page.evaluate(`
                    await Promise.all(document.getAnimations()
                        .filter(animation => animation.effect?.getTiming().iterations !== Infinity)
                        .map(animation => animation.finished.catch(() => {})));
                    if (${JSON.stringify(viewport)} === 'mobile') {
                        document.querySelector('${section} .extension').scrollIntoView({ block: 'start' });
                    }
                `);
                const shot = await page.screenshot();

                await writeFile(
                    `/tmp/pi-coop-provider-packages-${viewport}.jpg`,
                    Buffer.from(shot.data, "base64"),
                );
            }

            await page.evaluate(
                `[...document.querySelectorAll('${section} summary')].find(summary => summary.textContent.trim() === 'Add package').click()`,
            );
            await fill(
                page,
                `${section} input[placeholder="npm:package-name@1.2.3"]`,
                "npm:pi-provider-litellm@4.2.0",
            );
            await page.evaluate(
                `document.querySelector('${section} input[placeholder="npm:package-name@1.2.3"]').closest('form').querySelector('button[type="submit"]').click()`,
            );
            await until(() => requests.length === 3, "install HTTP request");
            assert.deepEqual(requests[2], {
                action: "install",
                source: "npm:pi-provider-litellm@4.2.0",
                trusted: true,
            });
            await present(page, `${section} [role="status"].ok`);

            for (const [label, action] of [
                ["Update", "update"],
                ["Roll back to 4.2.0", "rollback"],
                ["Select package", "select"],
            ] as const) {
                const count = requests.length;

                await page.evaluate(
                    `[...document.querySelectorAll('${section} button')].find(button => button.textContent.trim() === ${JSON.stringify(label)}).click()`,
                );
                await until(() => requests.length === count + 1, `${action} HTTP request`);
                assert.deepEqual(
                    requests.at(-1),
                    action === "select"
                        ? { action, id: "local-one", trusted: true }
                        : { action, name, trusted: true },
                );
                await present(page, `${section} [role="status"].ok`);
            }

            await click(page, `${section} .extension details summary`);
            await fill(page, `${section} input[type="url"]`, "https://new-provider.example");
            await fill(page, `${section} textarea`, "team=https://team-provider.example");
            await click(page, `${section} .extension details button[type="submit"]`);
            await until(() => requests.length === 7, "public configuration HTTP request");
            assert.deepEqual(requests.at(-1), {
                action: "configure",
                name,
                settings: {
                    baseUrl: "https://new-provider.example",
                    aliases: { team: "https://team-provider.example" },
                },
            });
            await present(page, `${section} [role="status"].ok`);

            await open(1, "extensions");
            await present(page, ".settings-panel:not([hidden]) .extension");
            assert.equal(
                await inPage<number>(
                    page,
                    `return JSON.stringify([...document.querySelectorAll('.settings-panel:not([hidden]) .extension')].find(row => row.textContent.includes('Pi provider compatibility')).querySelectorAll('.link').length)`,
                ),
                0,
                "restart-only module never offers Reload",
            );
            assert.ok(
                await inPage<boolean>(
                    page,
                    `return JSON.stringify(document.querySelector('.settings-panel:not([hidden])').textContent.includes('Change queued') && [...document.querySelectorAll('.settings-panel:not([hidden]) .extension')].find(row => row.textContent.includes('Ordinary extension')).textContent.includes('Reload'))`,
                ),
            );

            // Reopen to exercise load failure, retry and the empty snapshot.
            await page.evaluate(`(await import('/store.js')).store.set({ sheet: null })`);
            await present(page, '[role="dialog"][aria-label="Settings"]', false);
            fail = true;
            await open(1);
            await present(page, `${section} [role="alert"]`);
            fail = false;
            data = { ...data, packages: [], available: [] };
            await click(page, `${section} [role="alert"] button`);
            await until(
                () =>
                    inPage<boolean>(
                        page,
                        `return JSON.stringify(document.querySelector('${section}').textContent.includes('No managed provider packages yet.'))`,
                    ),
                "empty state after retry",
            );
            await present(page, `${section} [role="alert"]`, false);

            data = structuredClone(snapshot);
            data.recoveryRequired = true;
            data.enabled = true;
            delete data.packages[0]!.previousVersion;
            await page.evaluate(`(await import('/store.js')).store.set({ sheet: null })`);
            await present(page, '[role="dialog"][aria-label="Settings"]', false);
            await open(1);
            await present(page, `${section} .extension`);
            assert.equal(
                await inPage<boolean>(
                    page,
                    `return JSON.stringify([...document.querySelectorAll('${section} button')].find(button => button.textContent.trim() === 'Roll back').disabled)`,
                ),
                true,
                "rollback requires a retained previous version",
            );
            await present(page, `${section} [role="alert"]`);
            assert.ok(
                await inPage<boolean>(
                    page,
                    `return JSON.stringify(document.querySelector('${section} [role="alert"]').textContent.includes('Durable work is paused. Fix or disable provider compatibility, then restart.'))`,
                ),
            );
            assert.ok(
                await inPage<boolean>(
                    page,
                    `return JSON.stringify(!document.querySelector('${section} .setting [role="switch"]').disabled && !document.querySelector('${section} .extension [role="switch"]').disabled)`,
                ),
                "package recovery controls remain usable while Durable work is paused",
            );
            await click(page, `${section} .setting [role="switch"]`);
            await until(
                () => requests.length === 8,
                "recovery selection can disable compatibility",
            );
            assert.deepEqual(requests.at(-1), { action: "module", enabled: false });
            await present(page, `${section} [role="status"].ok`);
            assert.ok(
                await inPage<boolean>(
                    page,
                    `return JSON.stringify(document.querySelector('${section} [role="alert"]').textContent.includes('Durable work is paused.'))`,
                ),
                "saving a recovery selection never implies scheduling resumed",
            );
            await click(page, `${section} > details > summary`);
            assert.ok(
                await inPage<boolean>(
                    page,
                    `return JSON.stringify(document.querySelector('${section} [role="alert"]').checkVisibility())`,
                ),
                "recovery warning stays visible when package management is collapsed",
            );

            const beforeGuest = reads;

            await page.setViewport(VIEWPORTS.desktop);
            await page.navigate(`${base}/login?token=${encodeURIComponent(guest.token)}`);
            await present(page, '.plain form button[type="submit"]');
            await click(page, '.plain form button[type="submit"]');
            await present(page, ".sidebar");
            await open(1);
            await present(page, ".provider");
            await present(page, section, false);
            assert.equal(reads, beforeGuest, "guest never fetches owner package metadata");
            assert.equal(
                await inPage<number>(
                    page,
                    `return JSON.stringify(document.querySelectorAll('.provider button').length)`,
                ),
                0,
                "native sign-in controls remain owner-only",
            );
            assert.deepEqual(
                page
                    .logs()
                    .filter((entry) => entry.level === "error" && !entry.text.includes("503")),
                [],
                "no JavaScript errors",
            );
        } finally {
            releaseRefresh?.();
            await browsers.closeAll({ final: true });
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await app.close();
        }
    },
);
