// Real-app appearance owns browser-local legacy fallback/persistence, native palettes, mode assignments,
// font rendering and pointer/keyboard disclosure. Launcher previews/commands share that boundary.
// The fixture controls only the platform color-scheme signal, before the app loads; no production seam.
import { type App, cleanUp, openApp, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
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
const browserOptions = {
    skip: findBrowser() === undefined ? "no Chromium installed" : false,
    timeout: 90_000,
};

// BrowserPage has no public color-scheme emulation. Keep the MediaQueryList stand-in in
// this disposable HTTP fixture, delegating every other query to the real browser.
const systemScript = (dark: boolean) => `<script>
    (() => {
        const nativeMatchMedia = window.matchMedia.bind(window);
        const queries = ['dark', 'light'].map(scheme => {
            const query = new EventTarget();

            query.media = '(prefers-color-scheme: ' + scheme + ')';
            query.matches = scheme === 'dark' ? ${dark} : ${!dark};

            return query;
        });

        window.fixtureColorScheme = dark => {
            // A platform change updates both matches before either listener runs.
            queries[0].matches = dark;
            queries[1].matches = !dark;

            for (const query of queries) {
                query.dispatchEvent(new MediaQueryListEvent('change', {
                    media: query.media, matches: query.matches,
                }));
            }
        };
        window.matchMedia = media => queries.find(query => query.media === media) ?? nativeMatchMedia(media);
    })();
</script>`;

type Fixture = {
    app: App;
    page: BrowserPage;
    browsers: Browsers;
    base: string;
    themeRequests: string[];
    deviceSchemeForReload: (dark: boolean) => void;
};

after(cleanUp);

async function withAppearance(run: (fixture: Fixture) => Promise<void>, controlledSystem = false) {
    const app = await openApp(scriptedModel());
    const themeRequests: string[] = [];
    let deviceDark = true;
    const index = controlledSystem
        ? readFileSync(new URL("../web/index.html", import.meta.url), "utf8")
        : "";
    const handler = createHandler({
        app,
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
    });
    const server = createServer(async (request, response) => {
        if (/^\/api\/theme(?:[/?]|$)/.test(request.url ?? "")) {
            themeRequests.push(request.url!);
        }

        if (controlledSystem && request.url === "/") {
            response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            response.end(index.replace("<head>", `<head>${systemScript(deviceDark)}`));

            return;
        }

        await handler(request, response);
    });
    const browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "theme-browser-")),
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
        await run({
            app,
            page,
            browsers,
            base,
            themeRequests,
            deviceSchemeForReload: (dark) => {
                deviceDark = dark;
            },
        });
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
}

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
        preferences: {
            theme: string;
            mode: string;
            darkTheme: string;
            lightTheme: string;
            font: string;
        };
        saved: {
            theme: string;
            mode?: string;
            darkTheme?: string;
            lightTheme?: string;
            font?: string;
            wallpaper?: boolean;
            text?: number;
            tiling?: boolean;
        } | null;
        desktopCache: string | null;
        cachedWallpaper?: string;
        bg: string;
        active: string;
        inactive: string;
        defaultInactive: string;
        mode: string;
        tiling: string;
        wallpaper: string;
        colors: Record<string, string>;
        font: string;
        mono: string;
        bodyFont: string;
        codeFont: string | null;
        cachedFont: string;
        transitions: number;
        hasTransitions: boolean;
    }>(
        page,
        `
        const { prefs } = await import('/theme.js');
        const root = document.documentElement;
        const style = getComputedStyle(root);

        return JSON.stringify({
            theme: prefs().theme,
            preferences: prefs(),
            saved: JSON.parse(localStorage.getItem('pocket.appearance')),
            desktopCache: localStorage.getItem('pocket.desktopTheme'),
            cachedWallpaper: JSON.parse(localStorage.getItem('pocket.themeCache')).vars['--wallpaper'],
            bg: style.getPropertyValue('--o-bg').trim(),
            active: style.getPropertyValue('--o-active').trim(),
            inactive: style.getPropertyValue('--o-inactive').trim(),
            defaultInactive: style.getPropertyValue('--line-strong').trim(),
            mode: root.dataset.mode,
            tiling: root.dataset.tiling,
            wallpaper: root.style.getPropertyValue('--wallpaper'),
            colors: Object.fromEntries([...style]
                .filter(name => name.startsWith('--o-'))
                .map(name => [name, style.getPropertyValue(name).trim()])),
            font: getComputedStyle(document.body).getPropertyValue('--font').trim(),
            mono: getComputedStyle(document.body).getPropertyValue('--mono').trim(),
            bodyFont: getComputedStyle(document.body).fontFamily,
            codeFont: document.querySelector('#font-probe code')
                ? getComputedStyle(document.querySelector('#font-probe code')).fontFamily : null,
            cachedFont: JSON.parse(localStorage.getItem('pocket.themeCache')).vars['--font'],
            transitions: window.appearanceTransitions ?? 0,
            hasTransitions: typeof document.startViewTransition === 'function',
        });
    `,
    );
}

/** A persisted choice is required only after an explicit edit, never merely after startup. */
function saved(look: Awaited<ReturnType<typeof appearance>>) {
    assert.ok(look.saved, "an explicit edit persisted this browser's preferences");

    return look.saved;
}

async function openAppearance(page: BrowserPage) {
    await page.evaluate(
        `(await import('/store.js')).openSheet({ type: 'settings', tab: 'appearance' })`,
    );
    await present(page, `${settings} .theme-card.on`);
}

const card = (name: string) => `${settings} .theme-card[title="${name}"]`;
const assignment = (name: string, mode: string) =>
    `${card(name)} .tc-modes button[aria-label="Use ${name} for ${mode} mode"]`;

async function clickText(page: BrowserPage, scope: string, text: string) {
    await page.evaluate(`
        [...document.querySelectorAll(${JSON.stringify(`${scope} button`)})]
            .find(button => button.textContent.trim() === ${JSON.stringify(text)}).click();
    `);
    await settleTheme(page);
}

async function settleTheme(page: BrowserPage) {
    // Wait before native clicks that could hit the transition overlay, and before negative
    // assertions: an erroneous live switch can apply asynchronously in its update callback.
    await until(
        () =>
            inPage<boolean>(
                page,
                `return JSON.stringify(!document.documentElement.classList.contains('theme-vt'))`,
            ),
        "theme transition settles",
    );
}

function liveLook(look: Awaited<ReturnType<typeof appearance>>) {
    return {
        theme: look.theme,
        savedTheme: look.saved?.theme ?? null,
        savedMode: look.saved?.mode ?? null,
        mode: look.preferences.mode,
        actualMode: look.mode,
        colors: look.colors,
        font: look.font,
        transitions: look.transitions,
    };
}

async function activated(
    page: BrowserPage,
    theme: string,
    mode: "system" | "dark" | "light",
    actualMode: string,
    bg: string,
) {
    await until(async () => {
        const look = await appearance(page);

        return look.theme === theme && saved(look).mode === mode && look.mode === actualMode;
    }, `activate ${mode}: ${theme}`);
    await settleTheme(page);
    const look = await appearance(page);

    assert.equal(saved(look).theme, theme);
    assert.equal(saved(look).mode, mode);
    assert.equal(look.mode, actualMode, "the live theme keeps its native palette");
    assert.equal(look.bg, bg);
    assert.equal(
        await inPage<string>(
            page,
            `return JSON.stringify(document.querySelector('${settings} .color-modes button[aria-pressed="true"]')
                ?.textContent.trim())`,
        ),
        { system: "System", dark: "Dark", light: "Light" }[mode],
    );
}

async function assignments(page: BrowserPage, dark: string, light: string) {
    assert.deepEqual(
        await inPage<string[]>(
            page,
            `return JSON.stringify([...document.querySelectorAll('${settings} .tc-modes button[aria-pressed="true"]')]
                .map(button => button.getAttribute('aria-label')).sort())`,
        ),
        [`Use ${dark} for Dark mode`, `Use ${light} for Light mode`].sort(),
        "each saved slot has its own pressed indicator, independent of the live card",
    );
}

async function nativeCards(page: BrowserPage) {
    for (const [name, bg] of [
        ["Gruvbox", "rgb(40, 40, 40)"],
        ["Catppuccin Latte", "rgb(239, 241, 245)"],
    ]) {
        assert.equal(
            await inPage<string>(
                page,
                `return JSON.stringify(getComputedStyle(document.querySelector(${JSON.stringify(card(name!))})).backgroundColor)`,
            ),
            bg,
            `${name} preview is not recolored by the active mode`,
        );
    }
}

async function modesVisible(page: BrowserPage, name: string, visible: boolean) {
    await until(
        () =>
            inPage<boolean>(
                page,
                `const style = getComputedStyle(document.querySelector(${JSON.stringify(`${card(name)} .tc-modes`)}));

                return JSON.stringify(${visible ? "style.visibility === 'visible' && Number(style.opacity) === 1" : "style.visibility === 'hidden' && Number(style.opacity) === 0"});`,
            ),
        `${name} assignment controls ${visible ? "visible" : "hidden"}`,
    );
}

async function pointer(page: BrowserPage, selector: string, type: string, x = 30, pointerId = 1) {
    await page.evaluate(`
        document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new PointerEvent(${JSON.stringify(type)}, {
            bubbles: true, pointerType: 'touch', pointerId: ${pointerId}, isPrimary: ${pointerId === 1},
            button: 0, buttons: ${type === "pointerup" || type === "pointercancel" ? 0 : 1}, clientX: ${x}, clientY: 30,
        }));
    `);
}

async function touchClick(page: BrowserPage, selector: string) {
    await pointer(page, selector, "pointerup");
    await page.evaluate(`document.querySelector(${JSON.stringify(selector)})
        .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }))`);
    await settleTheme(page);
}

async function previewTheme(page: BrowserPage, query: string, bg: string, name: string) {
    await page.evaluate(`(await import('/store.js')).store.set({ launcher: true })`);
    await present(page, `${launcher} input`);
    await page.evaluate(`
        const input = document.querySelector('${launcher} input');

        input.value = ${JSON.stringify(`#${query}`)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
    `);
    await until(
        () =>
            inPage<boolean>(
                page,
                `return JSON.stringify(document.querySelector('${launcher} [role="option"][aria-selected="true"] .main > span')?.textContent === ${JSON.stringify(name)})`,
            ),
        `launcher selects ${name}`,
    );
    await until(async () => (await appearance(page)).bg === bg, `launcher previews ${query}`);
}

test(
    "legacy desktop preferences render the fallback without rewrites; cards, previews and commands work",
    browserOptions,
    async () => {
        await withAppearance(async ({ page, base, themeRequests }) => {
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
            assert.deepEqual(
                migrated.saved,
                { theme: "desktop", wallpaper: true, text: 16, tiling: true, motion: "reduced" },
                "startup renders the supported fallback without rewriting the existing preference record",
            );
            assert.equal(migrated.desktopCache, null);
            assert.equal(migrated.cachedWallpaper, undefined);
            assert.equal(migrated.saved?.text, 16, "unrelated preferences survive");
            assert.equal(migrated.tiling, "on");
            assert.equal(migrated.bg, "#1a1b26");
            assert.equal(migrated.mode, "dark");
            assert.ok(!migrated.wallpaper.includes("url("));
            assert.deepEqual(themeRequests, [], "startup never asks for a desktop palette");

            await openAppearance(page);
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
                    `document.querySelector('${settings} .theme-card[title="${name}"] .tc-select').click()`,
                );
                await until(async () => (await appearance(page)).bg === bg, name!);
                const chosen = await appearance(page);

                assert.equal(chosen.mode, mode);
                assert.equal(chosen.active, border);
                assert.notEqual(chosen.defaultInactive, "", "the app's fallback border is defined");
                assert.equal(chosen.inactive, inactive || chosen.defaultInactive);
                assert.equal(chosen.tiling, "on");
            }

            await page.press("Escape");
            await present(page, settings, false);
            await page.setViewport(VIEWPORTS.desktop);

            const openLauncher = () => previewTheme(page, "gruvbox", "#282828", "Gruvbox");

            await openLauncher();
            assert.equal(
                saved(await appearance(page)).theme,
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
            assert.equal(saved(await appearance(page)).theme, "gruvbox");

            // Execute the actual slash-command parser/runner, without sending anything to the model.
            await page.evaluate(`
                const { parseCommand } = await import('/commands.js');
                const parsed = parseCommand('/theme Tokyo Night');

                await parsed.command.run(parsed.arg);
            `);
            assert.equal(saved(await appearance(page)).theme, "tokyo-night");
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
                /No theme or colors called/,
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
        });
    },
);

test(
    "saved mode assignments never switch the live look; modes, fonts and System survive reload",
    browserOptions,
    async () => {
        await withAppearance(async ({ page, app, browsers, base, deviceSchemeForReload }) => {
            await openAppearance(page);
            await clickText(page, settings, "Full");
            await page.evaluate(`
            window.appearanceTransitions = 0;
            const nativeTransition = document.startViewTransition;

            if (typeof nativeTransition === 'function') {
                document.startViewTransition = function (...args) {
                    window.appearanceTransitions++;

                    return nativeTransition.apply(this, args);
                };
            }
        `);
            const before = liveLook(await appearance(page));

            await nativeCards(page);
            await assignments(page, "Tokyo Night", "Catppuccin Latte");
            await modesVisible(page, "Gruvbox", false);
            await page.hover({ selector: `${card("Gruvbox")} .tc-select` });
            await modesVisible(page, "Gruvbox", true);
            await page.click({ selector: assignment("Gruvbox", "Dark") });
            await assignments(page, "Gruvbox", "Catppuccin Latte");
            assert.equal(saved(await appearance(page)).darkTheme, "gruvbox");
            assert.deepEqual(
                liveLook(await appearance(page)),
                before,
                "a real pointer click saving the currently active Dark slot must not switch or animate",
            );

            // A path-target click must bubble to its sibling assignment button, never the main selection.
            await page.evaluate(`document.querySelector(${JSON.stringify(`${assignment("Gruvbox", "Light")} svg path`)})
            .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }))`);
            await assignments(page, "Gruvbox", "Gruvbox");
            assert.equal(saved(await appearance(page)).lightTheme, "gruvbox");
            assert.deepEqual(
                liveLook(await appearance(page)),
                before,
                "SVG bubbling only saves the Light slot",
            );
            await page.evaluate(
                `document.querySelector(${JSON.stringify(card("Gruvbox"))}).click()`,
            );
            assert.deepEqual(
                liveLook(await appearance(page)),
                before,
                "the card group itself is not a selection button",
            );
            assert.equal(
                await inPage<string>(
                    page,
                    `return JSON.stringify(document.querySelector(${JSON.stringify(`${card("Gruvbox")} .tc-select`)}).getAttribute('aria-pressed'))`,
                ),
                "false",
                "saved assignment is not the live-card selection indicator",
            );

            await clickText(page, `${settings} .color-modes`, "Light");
            await activated(page, "gruvbox", "light", "dark", "#282828");
            await nativeCards(page);
            assert.ok(
                !(await appearance(page)).hasTransitions ||
                    (await appearance(page)).transitions > 0,
                "the transition observer sees live switches, but not saved assignments",
            );
            await page.hover({ selector: `${card("Catppuccin Latte")} .tc-select` });
            await modesVisible(page, "Catppuccin Latte", true);
            const beforeLightAssignment = liveLook(await appearance(page));

            await page.click({ selector: assignment("Catppuccin Latte", "Light") });
            await assignments(page, "Gruvbox", "Catppuccin Latte");
            assert.deepEqual(
                liveLook(await appearance(page)),
                beforeLightAssignment,
                "saving the active Light slot is also deferred until mode activation",
            );
            await clickText(page, `${settings} .color-modes`, "Light");
            await activated(page, "catppuccin-latte", "light", "light", "#eff1f5");
            await clickText(page, `${settings} .color-modes`, "Dark");
            await activated(page, "gruvbox", "dark", "dark", "#282828");
            await nativeCards(page);

            // Render a code sample with the real markdown CSS, not just a variable-only assertion.
            await page.evaluate(`
            const sample = document.createElement('div');

            sample.id = 'font-probe';
            sample.className = 'md';
            sample.innerHTML = '<pre><code>const answer = 42;</code></pre>';
            sample.hidden = true;
            document.body.append(sample);
        `);
            const mono = (await appearance(page)).mono;
            const codeFont = (await appearance(page)).codeFont;

            assert.match(codeFont!, /Pocket Mono/);

            for (const [font, family] of [
                ["system-sans", /system-ui.*sans-serif/],
                ["system-mono", /ui-monospace.*monospace/],
                ["jetbrains-mono", /Pocket Mono.*JetBrains Mono.*monospace/],
                ["serif", /Charter.*Georgia.*serif/],
            ] as const) {
                await page.select({ selector: `${settings} select[aria-label="Font"]` }, font);
                const look = await appearance(page);

                assert.equal(saved(look).font, font, `${font} is saved per browser`);
                assert.match(look.font, family);
                assert.match(look.bodyFont, family, `${font} renders on the body`);
                assert.equal(
                    look.cachedFont,
                    look.font,
                    "font is included in the first-paint cache",
                );
                assert.equal(look.mono, mono, "the code/terminal font variable is unchanged");
                assert.equal(look.codeFont, codeFont, "rendered code stays monospace");
            }

            await clickText(page, `${settings} .color-modes`, "System");
            await activated(page, "gruvbox", "system", "dark", "#282828");
            await page.evaluate(`
            window.fixtureColorScheme(false);
        `);
            await activated(page, "catppuccin-latte", "system", "light", "#eff1f5");
            await page.press("Escape");
            await present(page, settings, false);
            await openAppearance(page);
            await activated(page, "catppuccin-latte", "system", "light", "#eff1f5");
            await assignments(page, "Gruvbox", "Catppuccin Latte");
            assert.equal(
                await inPage<string>(
                    page,
                    `return JSON.stringify(document.querySelector('${settings} select[aria-label="Font"]').value)`,
                ),
                "serif",
                "font picker restores its value when reopened",
            );

            // A second browser signs in as the same person but must not inherit their appearance.
            const other = await browsers.open(2);

            await other.navigate(
                `${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`,
            );
            await present(other, ".sidebar");
            const isolated = await appearance(other);

            assert.equal(isolated.theme, "tokyo-night");
            assert.equal(isolated.preferences.mode, "dark");
            assert.equal(isolated.preferences.darkTheme, "tokyo-night");
            assert.equal(isolated.preferences.lightTheme, "catppuccin-latte");
            assert.equal(isolated.preferences.font, "jetbrains-mono");
            assert.equal(
                isolated.saved,
                null,
                "startup does not persist defaults as a personal choice",
            );
            assert.match(isolated.bodyFont, /Pocket Mono/);

            // The device changes while this app is closed: bootstrap must resolve System afresh,
            // rather than leaving the last saved Light palette from the previous page.
            deviceSchemeForReload(true);
            await page.reload();
            await present(page, ".sidebar");
            await openAppearance(page);
            await activated(page, "gruvbox", "system", "dark", "#282828");
            await assignments(page, "Gruvbox", "Catppuccin Latte");
            assert.equal(saved(await appearance(page)).font, "serif");
            assert.match((await appearance(page)).bodyFont, /Charter.*Georgia.*serif/);

            await clickText(page, `${settings} .color-modes`, "Dark");
            await page.evaluate(`
            window.fixtureColorScheme(false);
        `);
            await activated(page, "gruvbox", "dark", "dark", "#282828");
            await clickText(page, `${settings} .color-modes`, "System");
            await activated(page, "catppuccin-latte", "system", "light", "#eff1f5");
            await page.click({ selector: `${card("Hackerman")} .tc-select` });
            await activated(page, "hackerman", "dark", "dark", "#0b0c16");
            await assignments(page, "Gruvbox", "Catppuccin Latte");
            assert.equal(saved(await appearance(page)).darkTheme, "gruvbox");
            assert.equal(saved(await appearance(page)).lightTheme, "catppuccin-latte");
            await nativeCards(page);
        }, true);
    },
);

test(
    "touch holds disclose assignments without selection; cancellation, outside tap and keyboard work",
    browserOptions,
    async () => {
        await withAppearance(async ({ page }) => {
            await page.setViewport(VIEWPORTS.mobile);
            await openAppearance(page);
            const select = `${card("Gruvbox")} .tc-select`;
            const before = liveLook(await appearance(page));

            await modesVisible(page, "Gruvbox", false);
            await pointer(page, select, "pointerdown");
            await page.waitFor({ ms: 250 });
            assert.equal(
                await inPage<string>(
                    page,
                    `return JSON.stringify(getComputedStyle(document.querySelector(${JSON.stringify(`${card("Gruvbox")} .tc-modes`)})).visibility)`,
                ),
                "hidden",
                "a short press must not disclose the hold controls",
            );
            await page.waitFor({ ms: 300 });
            assert.equal(
                await inPage<string>(
                    page,
                    `return JSON.stringify(getComputedStyle(document.querySelector(${JSON.stringify(`${card("Gruvbox")} .tc-modes`)})).visibility)`,
                ),
                "visible",
                "the 450ms hold discloses by 550ms, before waiting for its fade to finish",
            );
            await modesVisible(page, "Gruvbox", true);
            await touchClick(page, select);
            assert.deepEqual(
                liveLook(await appearance(page)),
                before,
                "the hold's resulting click is consumed",
            );

            await pointer(page, `${settings} .theme-mode-hint`, "pointerdown");
            await pointer(page, `${settings} .theme-mode-hint`, "pointerup");
            await modesVisible(page, "Gruvbox", false);
            assert.deepEqual(
                liveLook(await appearance(page)),
                before,
                "outside tap only dismisses controls",
            );

            for (const cancel of ["pointermove", "pointercancel"]) {
                await pointer(page, select, "pointerdown");
                await pointer(page, select, cancel, cancel === "pointermove" ? 41 : 30);
                await page.waitFor({ ms: 550 });
                await modesVisible(page, "Gruvbox", false);
                await touchClick(page, select);
                assert.deepEqual(
                    liveLook(await appearance(page)),
                    before,
                    `${cancel} cancels both hold and selection`,
                );
            }

            await pointer(page, select, "pointerdown");
            await modesVisible(page, "Gruvbox", true);
            await touchClick(page, select);
            await page.press("Escape");
            await modesVisible(page, "Gruvbox", false);
            await present(page, settings);
            assert.deepEqual(
                liveLook(await appearance(page)),
                before,
                "Escape dismisses the disclosure before the sheet",
            );
            await pointer(page, select, "pointerdown");
            await touchClick(page, select);
            await activated(page, "gruvbox", "dark", "dark", "#282828");
            await assignments(page, "Tokyo Night", "Catppuccin Latte");

            await page.setViewport(VIEWPORTS.desktop);
            await page.hover({ selector: `${settings} .theme-mode-hint` });
            // Theme-folder controls precede palette cards in v14. Start at the palette's
            // selection button; Tab must still reach its sibling assignment controls.
            await page.evaluate(
                `document.querySelector(${JSON.stringify(`${card("Catppuccin")} .tc-select`)}).focus()`,
            );
            assert.equal(
                await inPage<string>(
                    page,
                    `return JSON.stringify(document.activeElement.getAttribute('aria-label'))`,
                ),
                "Use Catppuccin theme",
                "the main selection is a keyboard-focusable button",
            );
            await modesVisible(page, "Catppuccin", true);
            const keyboardBefore = liveLook(await appearance(page));

            for (const [mode, key] of [
                ["Dark", "Space"],
                ["Light", "Enter"],
            ]) {
                await page.press("Tab");
                assert.equal(
                    await inPage<string>(
                        page,
                        `return JSON.stringify(document.activeElement.getAttribute('aria-label'))`,
                    ),
                    `Use Catppuccin for ${mode} mode`,
                    "disclosed assignment buttons are reachable siblings in tab order",
                );
                await page.press(key!);
                assert.deepEqual(
                    liveLook(await appearance(page)),
                    keyboardBefore,
                    `${key} saves without live switching`,
                );
            }

            await assignments(page, "Catppuccin", "Catppuccin");
            await page.press("Shift+Tab");
            await page.press("Shift+Tab");
            await page.press("Enter");
            await activated(page, "catppuccin", "dark", "dark", "#1e1e2e");
        });
    },
);

test("secondary touches cannot steal the primary theme hold", browserOptions, async (t) => {
    await withAppearance(async ({ page, base }) => {
        await page.setViewport(VIEWPORTS.mobile);
        const select = `${card("Gruvbox")} .tc-select`;

        await t.test(
            "a secondary press after disclosure cannot release the primary click guard",
            async () => {
                await openAppearance(page);
                const before = liveLook(await appearance(page));

                await pointer(page, select, "pointerdown");
                await modesVisible(page, "Gruvbox", true);
                await pointer(page, select, "pointerdown", 30, 2);
                await touchClick(page, select);
                assert.deepEqual(
                    liveLook(await appearance(page)),
                    before,
                    "the primary hold still consumes its click after a nonprimary pointerdown",
                );
            },
        );

        for (const event of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) {
            await t.test(
                `${event} from a secondary touch cannot cancel the pending primary hold`,
                async () => {
                    await page.navigate(`${base}/`);
                    await present(page, ".sidebar");
                    await openAppearance(page);
                    const before = liveLook(await appearance(page));

                    await pointer(page, select, "pointerdown");

                    if (event !== "pointerdown") {
                        // The other finger starts outside the card, then delivers an unrelated
                        // move/release/cancel to it: primary pointer ownership must be checked there too.
                        await pointer(page, `${settings} .theme-mode-hint`, "pointerdown", 30, 2);
                    }

                    await pointer(page, select, event, event === "pointermove" ? 41 : 30, 2);
                    await page.waitFor({ ms: 550 });
                    assert.equal(
                        await inPage<string>(
                            page,
                            `return JSON.stringify(getComputedStyle(document.querySelector(${JSON.stringify(`${card("Gruvbox")} .tc-modes`)})).visibility)`,
                        ),
                        "visible",
                        `${event} from pointer 2 must leave pointer 1's 450ms disclosure timer intact`,
                    );
                    await touchClick(page, select);
                    assert.deepEqual(
                        liveLook(await appearance(page)),
                        before,
                        "the primary hold click remains consumed",
                    );
                },
            );
        }
    });
});

test(
    "a hidden Appearance panel cannot consume Escape after a keyboard tab change",
    browserOptions,
    async () => {
        await withAppearance(async ({ page }) => {
            await page.setViewport(VIEWPORTS.mobile);
            await openAppearance(page);
            const select = `${card("Gruvbox")} .tc-select`;

            await pointer(page, select, "pointerdown");
            await modesVisible(page, "Gruvbox", true);
            await touchClick(page, select);
            await page.evaluate(`
            [...document.querySelectorAll('${settings} [role="tab"]')]
                .find(tab => tab.textContent.trim() === 'Providers').focus();
        `);
            await page.press("Enter");
            assert.equal(
                await inPage<string>(
                    page,
                    `return JSON.stringify(document.querySelector('${settings} [role="tab"][aria-selected="true"]').textContent.trim())`,
                ),
                "Providers",
            );
            assert.equal(
                await inPage<boolean>(
                    page,
                    `return JSON.stringify(document.querySelector(${JSON.stringify(select)}).getClientRects().length === 0)`,
                ),
                true,
                "Appearance is retained but hidden after the keyboard-only tab change",
            );
            await page.press("Escape");
            await present(page, settings, false);
        });
    },
);

test(
    "committing a launcher theme leaves System and keeps the manual native look on reload",
    browserOptions,
    async (t) => {
        await withAppearance(async ({ page, base, deviceSchemeForReload }) => {
            for (const [theme, name, bg] of [
                ["nord", "Nord", "#2e3440"],
                ["tokyo-night", "Tokyo Night", "#1a1b26"],
            ]) {
                await t.test(
                    `commit ${name} ${theme === "tokyo-night" ? "already active under System" : "from a different System theme"}`,
                    async () => {
                        deviceSchemeForReload(true);
                        await page.navigate(`${base}/`);
                        await present(page, ".sidebar");
                        await openAppearance(page);
                        await clickText(page, `${settings} .color-modes`, "System");
                        await activated(page, "tokyo-night", "system", "dark", "#1a1b26");
                        await page.press("Escape");
                        await present(page, settings, false);
                        await previewTheme(page, theme!, bg!, name!);
                        const preview = await appearance(page);

                        assert.equal(
                            saved(preview).theme,
                            "tokyo-night",
                            "preview remains temporary",
                        );
                        assert.equal(
                            saved(preview).mode,
                            "system",
                            "preview does not leave System",
                        );
                        await page.press("Enter");
                        await present(page, launcher, false);
                        await settleTheme(page);
                        const committed = await appearance(page);

                        assert.equal(saved(committed).theme, theme);
                        assert.equal(
                            saved(committed).mode,
                            "dark",
                            `committing ${name} leaves System for its native Dark mode`,
                        );
                        assert.equal(
                            saved(committed).darkTheme,
                            "tokyo-night",
                            "a launcher commit does not rewrite the Dark assignment",
                        );
                        assert.equal(
                            saved(committed).lightTheme,
                            "catppuccin-latte",
                            "a launcher commit does not rewrite the Light assignment",
                        );
                        deviceSchemeForReload(false);
                        await page.reload();
                        await present(page, ".sidebar");
                        await openAppearance(page);
                        await activated(page, theme!, "dark", "dark", bg!);
                        await assignments(page, "Tokyo Night", "Catppuccin Latte");
                    },
                );
            }
        }, true);
    },
);
