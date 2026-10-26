// The real palette API owns folder choices, startup defaults, and legacy pair resolution.
// Browser theme tests own rendering/mode controls; these cover initialization without a DOM.
// Only browser storage/media and each exact theme module's store/safe-mode dependencies are replaced.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test, type TestContext } from "node:test";

const key = "pocket.appearance";
const dark = { mode: "dark", background: "#101820", foreground: "#f0f1f2" };
const light = { mode: "light", background: "#fff4e6", foreground: "#30241e" };
const themeList = [
    { id: "pocket", name: "Pocket", usable: true, css: [], colors: dark },
    {
        id: "tava",
        name: "Tava",
        usable: true,
        css: [],
        colors: dark,
        colorsLight: light,
    },
    {
        id: "broken",
        name: "Broken",
        usable: false,
        css: [],
        colors: dark,
        colorsLight: light,
    },
    { id: "css-only", name: "CSS only", usable: true, css: ["/themes/css-only/theme.css"] },
    { id: "sepia", name: "Sepia", usable: true, css: [], colors: light },
];

type Options = {
    saved?: Record<string, unknown>;
    prefersLight?: boolean;
    pendingList?: boolean;
    ownerDefault?: { look: string; colors: string };
};
let instance = 0;

async function setup(
    t: TestContext,
    { saved, prefersLight = false, pendingList = false, ownerDefault }: Options = {},
) {
    const savedJson = saved === undefined ? null : JSON.stringify(saved);
    const values = new Map<string, string>(savedJson === null ? [] : [[key, savedJson]]);
    const writes: string[] = [];
    const localStorage = {
        getItem: (name: string) => values.get(name) ?? null,
        setItem: (name: string, value: string) => {
            writes.push(name);
            values.set(name, String(value));
        },
        removeItem: (name: string) => values.delete(name),
    };
    const lightQuery = { matches: prefersLight };
    const globals = {
        localStorage,
        matchMedia: (query: string) =>
            query === "(prefers-color-scheme: light)" ? lightQuery : { matches: false },
    };
    const descriptors = Object.keys(globals).map(
        (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
    );

    t.after(() => {
        for (const [name, descriptor] of descriptors) {
            if (descriptor) {
                Object.defineProperty(globalThis, name, descriptor);
            } else {
                Reflect.deleteProperty(globalThis, name);
            }
        }
    });

    for (const [name, value] of Object.entries(globals)) {
        Object.defineProperty(globalThis, name, { configurable: true, value });
    }

    const themeURL = new URL("../web/theme.js", import.meta.url);

    themeURL.searchParams.set("palette-choices", String(++instance));
    const state = {
        ...(pendingList ? {} : { themeList }),
        ...(ownerDefault ? { server: { themeDefault: ownerDefault } } : {}),
    };
    const replacements = new Map([
        [
            "./store.js",
            `export const store = {
                state: ${JSON.stringify(state)},
                set(patch) { Object.assign(this.state, patch); }
            };`,
        ],
        ["./safe-mode.js", "export const safeMode = () => false, onSafeModeEnd = () => {};"],
    ]);
    const hooks = registerHooks({
        resolve(specifier, context, next) {
            const source =
                context.parentURL === themeURL.href ? replacements.get(specifier) : undefined;

            return source === undefined
                ? next(specifier, context)
                : {
                      url: `data:text/javascript,${encodeURIComponent(source)}#fixture-${instance}`,
                      shortCircuit: true,
                  };
        },
    });
    const theme = await import(themeURL.href).finally(() => hooks.deregister());

    return {
        theme,
        lightQuery,
        assertNoPreferenceWrites() {
            assert.equal(localStorage.getItem(key), savedJson);
            assert.ok(
                !writes.includes(key),
                "initialization must not persist personal preferences",
            );
        },
    };
}

test("folder palette choices preserve saved system pairs without a redundant choice", async (t) => {
    const { theme, lightQuery, assertNoPreferenceWrites } = await setup(t, {
        saved: {
            theme: "tava",
            look: "tava",
            mode: "system",
            systemPalette: "tava",
            darkTheme: "tava@dark",
            lightTheme: "tava@light",
            density: "compact",
        },
    });

    await t.test(
        "usable pairs offer only dark/light halves; standalone colors stay selectable",
        () => {
            assert.deepEqual(theme.folderPaletteIds(), ["tava@dark", "tava@light", "sepia"]);
        },
    );

    await t.test("a saved base pair follows the OS without rewriting personal preferences", () => {
        assert.equal(theme.prefs().theme, "tava");
        assert.equal(theme.prefs().mode, "system");

        for (const [prefersLight, mode, background] of [
            [false, "dark", "#101820"],
            [true, "light", "#fff4e6"],
            [false, "dark", "#101820"],
        ] as const) {
            lightQuery.matches = prefersLight;
            const palette = theme.paletteOf("tava");

            assert.equal(palette.id, "tava");
            assert.equal(palette.pair, true);
            assert.equal(palette.colors.mode, mode);
            assert.equal(palette.colors.background, background);
            assertNoPreferenceWrites();
        }
    });
});

for (const pendingList of [false, true]) {
    for (const [prefersLight, mode, background] of [
        [false, "dark", "#101820"],
        [true, "light", "#fff4e6"],
    ] as const) {
        test(`fresh ${mode}-OS browser uses Tava/System with ${pendingList ? "pending" : "listed"} folders`, async (t) => {
            const { theme, assertNoPreferenceWrites } = await setup(t, {
                pendingList,
                prefersLight,
            });
            const p = theme.prefs();

            assert.deepEqual(
                {
                    look: p.look,
                    theme: p.theme,
                    mode: p.mode,
                    systemPalette: p.systemPalette,
                    darkTheme: p.darkTheme,
                    lightTheme: p.lightTheme,
                },
                {
                    look: "tava",
                    theme: "tava",
                    mode: "system",
                    systemPalette: "tava",
                    darkTheme: "tava@dark",
                    lightTheme: "tava@light",
                },
            );

            if (!pendingList) {
                const palette = theme.paletteOf();

                assert.equal(palette.id, "tava");
                assert.equal(palette.colors.mode, mode);
                assert.equal(palette.colors.background, background);
            }

            assertNoPreferenceWrites();
        });
    }
}

test("personal Pocket/Gruvbox and explicit mode slots survive new defaults unchanged", async (t) => {
    const { theme, assertNoPreferenceWrites } = await setup(t, {
        saved: {
            look: "pocket",
            theme: "gruvbox",
            mode: "dark",
            darkTheme: "tokyo-night",
            lightTheme: "catppuccin-latte",
            font: "serif",
            density: "compact",
        },
        prefersLight: true,
        ownerDefault: { look: "tava", colors: "tava" },
    });
    const p = theme.prefs();

    assert.deepEqual(
        {
            look: p.look,
            theme: p.theme,
            mode: p.mode,
            darkTheme: p.darkTheme,
            lightTheme: p.lightTheme,
            font: p.font,
            density: p.density,
        },
        {
            look: "pocket",
            theme: "gruvbox",
            mode: "dark",
            darkTheme: "tokyo-night",
            lightTheme: "catppuccin-latte",
            font: "serif",
            density: "compact",
        },
    );
    assert.equal(theme.paletteOf().colors.background, "#282828");
    assertNoPreferenceWrites();
});

test("an explicit owner default overrides Tava for a fresh follower without saving a choice", async (t) => {
    const { theme, assertNoPreferenceWrites } = await setup(t, {
        prefersLight: true,
        ownerDefault: { look: "pocket", colors: "gruvbox" },
    });
    const p = theme.prefs();

    assert.deepEqual(
        { look: p.look, theme: p.theme, mode: p.mode },
        { look: "pocket", theme: "gruvbox", mode: "dark" },
    );
    assert.equal(theme.paletteOf().colors.background, "#282828");
    assertNoPreferenceWrites();
});
