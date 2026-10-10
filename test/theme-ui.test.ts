// Bundled appearance through the real app: browser-local migration, theme cards, launcher previews and slash commands.
import { cleanUp, openApp, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const settings = '[role="dialog"][aria-label="Settings"]';
const launcher = '[role="dialog"][aria-label="Launcher"]';

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

async function appearance(page: BrowserPage) {
    return inPage<{
        theme: string;
        saved: { theme: string; wallpaper?: boolean; text: number; tiling: boolean };
        desktopCache: string | null;
        cachedWallpaper?: string;
        bg: string;
        active: string;
        inactive: string;
        mode: string;
        tiling: string;
        wallpaper: string;
    }>(
        page,
        `
        const { prefs } = await import('/theme.js');
        const root = document.documentElement;

        return JSON.stringify({
            theme: prefs().theme,
            saved: JSON.parse(localStorage.getItem('pocket.appearance')),
            desktopCache: localStorage.getItem('pocket.desktopTheme'),
            cachedWallpaper: JSON.parse(localStorage.getItem('pocket.themeCache')).vars['--wallpaper'],
            bg: root.style.getPropertyValue('--o-bg'),
            active: root.style.getPropertyValue('--o-active'),
            inactive: root.style.getPropertyValue('--o-inactive'),
            mode: root.dataset.mode,
            tiling: root.dataset.tiling,
            wallpaper: root.style.getPropertyValue('--wallpaper'),
        });
    `,
    );
}

test(
    "bundled themes migrate desktop preferences without syncing; cards, previews and commands work",
    { skip: findBrowser() === undefined ? "no Chromium installed" : false, timeout: 60_000 },
    async () => {
        const app = await openApp(scriptedModel());
        const themeRequests: string[] = [];
        const handler = createHandler({
            app,
            listen: { host: "127.0.0.1", port: 0 },
            restart: () => {},
        });
        const server = createServer(async (request, response) => {
            if (/^\/api\/theme(?:[/?]|$)/.test(request.url ?? "")) {
                themeRequests.push(request.url!);
            }

            await handler(request, response);
        });
        const browsers = new Browsers({
            dataDir: join(root, "theme-browser"),
            load: async () => undefined,
            save: () => {},
        });

        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

        try {
            const page = await browsers.open(1);

            await page.setViewport(VIEWPORTS.desktop);
            await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
            await present(page, ".sidebar");
            assert.equal((await appearance(page)).theme, "tokyo-night", "standalone default");
            await page.evaluate(`
                localStorage.setItem('pocket.appearance', JSON.stringify({
                    theme: 'desktop', wallpaper: true, text: 16, tiling: true, motion: 'reduced',
                }));
                localStorage.setItem('pocket.desktopTheme', JSON.stringify({
                    name: 'old-desktop', colors: { background: '#123456', foreground: '#ffffff' },
                    wallpaper: true, stamp: 'old',
                }));
                localStorage.setItem('pocket.themeCache', JSON.stringify({
                    vars: { '--o-bg': '#123456', '--wallpaper': 'url("/api/theme/wallpaper?v=old")' },
                    attrs: { mode: 'light' },
                }));
            `);
            await page.navigate(`${base}/`);
            await present(page, ".sidebar");
            const migrated = await appearance(page);

            assert.equal(migrated.theme, "tokyo-night");
            assert.equal(migrated.saved.theme, "tokyo-night", "migration is persisted");
            assert.equal(migrated.saved.wallpaper, undefined);
            assert.equal(migrated.desktopCache, null);
            assert.equal(migrated.cachedWallpaper, undefined);
            assert.equal(migrated.saved.text, 16, "unrelated preferences survive");
            assert.equal(migrated.tiling, "on");
            assert.equal(migrated.bg, "#1a1b26");
            assert.equal(migrated.mode, "dark");
            assert.ok(!migrated.wallpaper.includes("url("));
            assert.deepEqual(themeRequests, [], "startup never asks for a desktop palette");

            await page.evaluate(
                `(await import('/store.js')).openSheet({ type: 'settings', tab: 'appearance' })`,
            );
            await present(page, `${settings} .theme-card.on`);
            assert.equal(
                await inPage<string>(
                    page,
                    `return JSON.stringify(document.querySelector('${settings} .theme-card.on').title)`,
                ),
                "Tokyo Night",
            );
            assert.equal(
                await inPage<boolean>(
                    page,
                    `return JSON.stringify(/Follow desktop|Desktop wallpaper|Omarchy/.test(document.querySelector('${settings}').textContent))`,
                ),
                false,
            );

            // Palette selection still works on a phone and preserves the tiled-window borders.
            await page.setViewport(VIEWPORTS.mobile);

            for (const [name, bg, mode, border, inactive] of [
                [
                    "Hackerman",
                    "#0b0c16",
                    "dark",
                    "linear-gradient(45deg, #26a269ee, #2ec27eee)",
                    "",
                ],
                [
                    "Last Horizon",
                    "#0c0b0c",
                    "dark",
                    "linear-gradient(45deg, #8a8588ee, #e2dddcee)",
                    "#584e51aa",
                ],
                [
                    "Solitude",
                    "#101315",
                    "dark",
                    "linear-gradient(45deg, #798186ee, #caccccee)",
                    "#1e1e1e",
                ],
                ["Catppuccin Latte", "#eff1f5", "light", "linear-gradient(#1e66f5, #1e66f5)", ""],
            ]) {
                await page.evaluate(
                    `document.querySelector('${settings} .theme-card[title="${name}"]').click()`,
                );
                await until(async () => (await appearance(page)).bg === bg, name!);
                const chosen = await appearance(page);

                assert.equal(chosen.mode, mode);
                assert.equal(chosen.active, border);
                assert.equal(chosen.inactive, inactive);
                assert.equal(chosen.tiling, "on");
            }

            await page.press("Escape");
            await present(page, settings, false);
            await page.setViewport(VIEWPORTS.desktop);

            const openLauncher = async () => {
                await page.evaluate(`(await import('/store.js')).store.set({ launcher: true })`);
                await present(page, `${launcher} input`);
                await page.evaluate(`
                    const input = document.querySelector('${launcher} input');

                    input.value = '#gruvbox';
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                `);
                await until(
                    async () => (await appearance(page)).bg === "#282828",
                    "launcher preview",
                );
            };

            await openLauncher();
            assert.equal(
                (await appearance(page)).saved.theme,
                "catppuccin-latte",
                "preview is not saved",
            );
            await page.press("Escape");
            await present(page, launcher, false);
            assert.equal(
                (await appearance(page)).bg,
                "#eff1f5",
                "Escape restores the saved palette",
            );
            await openLauncher();
            await page.press("Enter");
            await present(page, launcher, false);
            assert.equal((await appearance(page)).saved.theme, "gruvbox");

            // Execute the actual slash-command parser/runner, without sending anything to the model.
            await page.evaluate(`
                const { parseCommand } = await import('/commands.js');
                const parsed = parseCommand('/theme Tokyo Night');

                await parsed.command.run(parsed.arg);
            `);
            assert.equal((await appearance(page)).saved.theme, "tokyo-night");
            assert.match(
                await inPage<string>(
                    page,
                    `
                    const { parseCommand } = await import('/commands.js');
                    const parsed = parseCommand('/theme desktop');

                    try {
                        await parsed.command.run(parsed.arg);
                    } catch (error) {
                        return JSON.stringify(error.message);
                    }

                    return JSON.stringify('accepted');
                `,
                ),
                /No theme called/,
            );
            await page.navigate(`${base}/`);
            await present(page, ".sidebar");
            assert.equal(
                (await appearance(page)).theme,
                "tokyo-night",
                "saved theme survives reload",
            );
            await page.evaluate(`
                dispatchEvent(new Event('focus'));
                document.dispatchEvent(new Event('visibilitychange'));
                await new Promise(resolve => setTimeout(resolve, 6500));
            `);
            assert.deepEqual(
                themeRequests,
                [],
                "no desktop requests after focus, visibility or a polling period",
            );
            assert.deepEqual(
                page.logs().filter((entry) => entry.level === "error"),
                [],
                "no browser errors",
            );
        } finally {
            await browsers.closeAll({ final: true });
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await app.close();
        }
    },
);
