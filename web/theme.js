// Appearance: Coop's palettes, saved color modes, UI fonts and layout, with optional theme folders.
// No desktop-theme or wallpaper synchronization. Theme CSS still participates in safe mode.
import { THEMES } from "./themes.js";
import { onSafeModeEnd, safeMode } from "./safe-mode.js";
import { store } from "./store.js";

const KEY = "pocket.appearance";
const CACHE = "pocket.themeCache";
const DEFAULT_CACHE = "pocket.themeDefault";
const FOLLOW_DEFAULT = "pocket.followThemeDefault";
const PINNED = "pocket.pinned";
const FALLBACK = "tokyo-night";

/** The app's own look, which every theme builds on: it loads no stylesheet. */
export const BASE_LOOK = "pocket";

/** Local font stacks; code and terminals keep the bundled monospace face. */
export const FONTS = {
    "jetbrains-mono": {
        name: "JetBrains Mono",
        family: '"Pocket Mono", "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace',
    },
    "system-sans": {
        name: "System sans",
        family: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    },
    "system-mono": {
        name: "System mono",
        family: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    },
    serif: {
        name: "Serif",
        family: 'Charter, "Bitstream Charter", Georgia, serif',
    },
};

const DEFAULTS = {
    /** A key of the bundled THEMES. */
    theme: FALLBACK,
    /** Optional theme-folder CSS; the standalone app loads no extra stylesheet by default. */
    look: BASE_LOOK,
    /** "system" activates saved palette choices as the device changes its color scheme. */
    mode: "dark",
    darkTheme: FALLBACK,
    lightTheme: "catppuccin-latte",
    font: "jetbrains-mono",
    /** Wide screens: the sidebar and the conversation as tiled windows, with gaps and borders. */
    tiling: true,
    /** "auto" follows the system's reduced-motion setting. */
    motion: "auto",
    /** The conversation's text in pixels, 12 to 17; the rest of the app keeps its own sizes. */
    text: 14,
    /** How much room the spacing takes: "comfortable", "compact", or "tight". Font sizes stay. */
    density: "comfortable",
    /**
     * How wide the conversation and the message box are on a wide screen: "comfortable" (the theme's width, which grows
     * with the pane), "wide" (most of the pane), or "full" (all of it).
     */
    width: "comfortable",
    /** The sidebar on wide screens: "open", or "rail" (icons and numbered sessions only). */
    sidebar: "open",
    /** The standalone Coop sidebar's saved width. */
    sidebarWidth: 300,
    /** How the session list groups: "recent" (by day) or "folder". */
    group: "recent",
    /** Project-capable Collab lists default to Projects, without changing the old-server preference. */
    projectGroup: "projects",
    /** Other sessions' live work as peek tiles beside the session (a strip on narrow screens). Off until turned on. */
    peeks: false,
    /** How fast the last answer came, in the status line under the message box. Off until turned on. */
    speed: false,
    /** Pi's current thought above the live line, and its finished thoughts open. Off until turned on. */
    showThinking: false,
};

function readJson(key, fallback) {
    try {
        const value = JSON.parse(localStorage.getItem(key) ?? "null");

        return value ?? fallback;
    } catch {
        return fallback;
    }
}

const reduceQuery = matchMedia("(prefers-reduced-motion: reduce)");
// System mode and explicitly selected paired folder palettes follow the device's color scheme.
const lightQuery = matchMedia("(prefers-color-scheme: light)");

/**
 * Appearance's Width, past Comfortable: the column's width and the message box's, set inline so they win over a theme's.
 * Each grows with the pane (a percentage of it) and has a floor of today's column, so phones and narrow windows stay as
 * they are.
 */
const WIDTHS = {
    wide: {
        "--transcript-width": "clamp(720px, 92%, 1600px)",
        "--composer-width": "calc(clamp(720px, 92%, 1600px) + 48px)",
    },
    full: { "--transcript-width": "100%", "--composer-width": "100%" },
};

/** The standalone sidebar's width, matching its drag and reset controls. */
const sidebarWidth = (p) => `${Math.min(520, Math.max(260, p.sidebarWidth))}px`;

/** Keep selected folder palettes while their listing is pending, including reloads without a palette cache. */
function knownPalette(id) {
    return (
        typeof id === "string" &&
        id !== "desktop" &&
        (Object.hasOwn(THEMES, id) ||
            folderColors(id) !== undefined ||
            readJson(CACHE, {}).attrs?.colors === id ||
            !Array.isArray(store.state.themeList))
    );
}

/** Retired desktop settings fall back to Tokyo Night without resetting saved Coop layout choices. */
function normalizePrefs(saved) {
    const appearance = { ...DEFAULTS, ...saved };

    if (!knownPalette(appearance.theme)) {
        appearance.theme = FALLBACK;
    }

    if (typeof appearance.look !== "string") {
        appearance.look = BASE_LOOK;
    }

    const width = Number(appearance.sidebarWidth);

    appearance.sidebarWidth = Number.isFinite(width)
        ? Math.min(520, Math.max(260, width))
        : DEFAULTS.sidebarWidth;
    const palette = paletteOf(appearance.theme);
    const cached = readJson(CACHE, {});
    const paired = palette.pair || (cached.attrs?.colors === appearance.theme && cached.pair);
    const nativeMode =
        cached.attrs?.colors === appearance.theme &&
        !Object.hasOwn(THEMES, appearance.theme) &&
        !folderColors(appearance.theme)
            ? cached.attrs.mode
            : palette.colors.mode === "light"
              ? "light"
              : "dark";

    if (!["system", "dark", "light"].includes(saved.mode)) {
        appearance.mode = paired ? "system" : nativeMode === "light" ? "light" : "dark";

        if (paired) {
            appearance.systemPalette = appearance.theme;
        }
    }

    for (const mode of ["dark", "light"]) {
        const key = `${mode}Theme`;

        if (!knownPalette(saved[key])) {
            appearance[key] = paired
                ? `${appearance.theme}@${mode}`
                : nativeMode === mode
                  ? appearance.theme
                  : DEFAULTS[key];
        }
    }

    // Native pairs follow their own halves; System's saved palette slots remain independent.
    if (appearance.mode !== "system" || !knownPalette(appearance.systemPalette)) {
        delete appearance.systemPalette;
    }

    if (!Object.hasOwn(FONTS, appearance.font)) {
        appearance.font = DEFAULTS.font;
    }

    delete appearance.wallpaper;

    return appearance;
}

// Treat every pre-existing appearance record as a personal choice, even if it matches our defaults.
// Only genuinely new browsers get a follower marker; it survives layout edits and reloads until a theme/look choice.
const following = localStorage.getItem(FOLLOW_DEFAULT);
let followsDefault =
    following === "1" || (following === null && localStorage.getItem(KEY) === null);
let own = normalizePrefs(readJson(KEY, {}));

// Resolve System in memory: startup must not rewrite this browser's saved preference record.
if (own.mode === "system") {
    own.theme = themeForMode("system", own);
}

if (followsDefault) {
    localStorage.setItem(FOLLOW_DEFAULT, "1");
}

/** Before hello, only a new/unconfigured browser may reuse the last owner default. */
const ownerDefault = () => (store.state.server ? themeDefault() : readJson(DEFAULT_CACHE, null));

function inForce() {
    const current = followsDefault ? ownerDefault() : null;

    return current
        ? normalizePrefs({
              ...own,
              look: current.look,
              theme: current.colors,
              mode: undefined,
              systemPalette: undefined,
          })
        : own;
}

localStorage.removeItem("pocket.desktopTheme");
// Startup never rewrites an existing browser's saved preferences, nor saves an inherited default as a choice.
store.set({ appearance: inForce(), pinned: readJson(PINNED, []) });

export const prefs = () => store.state.appearance;

export function setPrefs(patch) {
    const choosing = Object.hasOwn(patch, "theme") || Object.hasOwn(patch, "look");
    // A theme/look choice adopts both currently displayed values. Layout-only changes leave inheritance intact.
    const base = choosing ? prefs() : own;

    if (choosing) {
        followsDefault = false;
        localStorage.setItem(FOLLOW_DEFAULT, "0");
    }

    own = normalizePrefs({ ...base, ...patch });
    localStorage.setItem(KEY, JSON.stringify(own));
    store.set({ appearance: inForce() });
    apply();
}

/** The owner's default for browsers that have not chosen (`hello`), or null. */
export function themeDefault() {
    return store.state.server?.themeDefault ?? null;
}

// ─── Pinned sessions (this browser) ──────────────────────────────────────────────

export const isPinned = (id) => store.state.pinned.includes(id);

export function togglePin(id) {
    const pinned = isPinned(id)
        ? store.state.pinned.filter((each) => each !== id)
        : [...store.state.pinned, id];

    localStorage.setItem(PINNED, JSON.stringify(pinned));
    store.set({ pinned });
}

// ─── Palettes ───────────────────────────────────────────────────────────────────

/** A bundled palette, or an explicitly chosen optional theme-folder palette; never the desktop. */
export function paletteOf(id = prefs().theme) {
    // Own ids only: a folder named "constructor" is no palette of the app's.
    if (Object.hasOwn(THEMES, id)) {
        return { id, ...THEMES[id] };
    }

    const folder = folderColors(id);

    return folder ?? { id: FALLBACK, ...THEMES[FALLBACK] };
}

/** A theme folder's palette, when the server lists one by that id that can be used. */
function folderColors(id) {
    const [base, half] = id.split("@");
    const folder = store.state.themeList?.find(
        (each) => each.id === base && each.usable && each.colors,
    );

    if (!folder) {
        return undefined;
    }

    // A pair (colors.toml and colors-light.toml): the half asked for, or the one the system's light or dark asks for.
    const light =
        folder.colorsLight !== undefined &&
        (half === "light" || (half === undefined && lightQuery.matches));

    return {
        id,
        name: folder.colorsLight && half ? `${folder.name} · ${half}` : folder.name,
        colors: light ? folder.colorsLight : folder.colors,
        folder: true,
        pair: folder.colorsLight !== undefined && half === undefined,
    };
}

/**
 * Whether the palette `id` names is known here yet: one that comes with the app, or any once the server
 * listed its theme folders. Until then, the palette index.html put on the page from the cache stays.
 */
const paletteKnown = (id) => Object.hasOwn(THEMES, id) || themesListed();

/** The server listed its theme folders (`hello`). */
const themesListed = () => Array.isArray(store.state.themeList);

// ─── Theme folders ──────────────────────────────────────────────────────────────

/** The theme folder this browser uses: the one it chose, if the server offers it; else the app's own look. */
function lookOf(id = prefs().look) {
    if (safeMode() || id === BASE_LOOK) {
        return null;
    }

    return (
        store.state.themeList?.find(
            (each) => each.id === id && each.usable && each.css.length > 0,
        ) ?? null
    );
}

/** The stylesheets of the theme this tab shows, or null while the server has not listed them yet. */
function themeSheets() {
    if (safeMode() || prefs().look === BASE_LOOK) {
        return [];
    }

    return themesListed() ? (lookOf()?.css ?? []) : null;
}

/** Settles once the newest theme's stylesheets loaded (or failed to). */
let sheetsLoaded = Promise.resolve();

/**
 * Put a theme's stylesheets in the theme layer: the new ones load beside the old, which go once they did, so nothing
 * shows the app without a theme between two. The element holding them is `#pocket-theme`, as index.html names the one
 * it writes before the first paint.
 */
function loadSheets(urls) {
    const key = JSON.stringify(urls);
    const current = document.getElementById("pocket-theme");

    if ((current?.dataset.urls ?? "[]") === key) {
        return sheetsLoaded;
    }

    const next = document.createElement("style");

    next.dataset.urls = key;
    next.textContent = urls.map((url) => `@import url("${url}") layer(theme);`).join("\n");
    current?.removeAttribute("id");
    next.id = "pocket-theme";

    const old = () => {
        for (const each of document.querySelectorAll("style[data-urls]")) {
            if (each !== document.getElementById("pocket-theme")) {
                each.remove();
            }
        }
    };

    if (urls.length === 0) {
        document.head.append(next);
        old();
        requestAnimationFrame(() => document.dispatchEvent(new Event("pocket:theme")));
        sheetsLoaded = Promise.resolve();

        return sheetsLoaded;
    }

    sheetsLoaded = new Promise((resolve) => {
        next.addEventListener("load", resolve, { once: true });
        next.addEventListener("error", resolve, { once: true });
        // A server that does not answer: show what there is.
        setTimeout(resolve, 4000);
    }).then(() => {
        old();
        // What reads where things are laid out (`useSide`) looks again.
        document.dispatchEvent(new Event("pocket:theme"));
    });
    document.head.append(next);

    return sheetsLoaded;
}

/** Switch to the theme folder `id` (or "pocket"), with the reveal; a theme with colors of its own brings them too. */
export function chooseLook(id, event) {
    const at =
        event && "clientX" in event && (event.clientX || event.clientY)
            ? { x: event.clientX, y: event.clientY }
            : undefined;

    if (id === prefs().look) {
        // Choosing the inherited look still makes it this browser's own choice.
        setPrefs({ look: id });

        return;
    }

    const look = store.state.themeList?.find((each) => each.id === id);

    transition(() => {
        setPrefs({ look: id, ...(look?.colors ? paletteChoice(id) : {}) });

        return sheetsLoaded;
    }, at);
}

/**
 * The look in use, in words: the theme's name, and the colors' when they are not the theme's own ("Lantern", "Pocket ·
 * Gruvbox"). For the menu's Appearance row and the home screen.
 */
export function lookLabel() {
    const look = lookOf();
    const palette = paletteOf();
    const colors = palette.name;

    return look && prefs().theme.split("@")[0] === look.id
        ? look.name
        : `${look?.name ?? "Pocket"} · ${colors}`;
}

/** Theme folders that change the look, in the order the server lists them: the app's own first. */
export function lookIds() {
    return [
        BASE_LOOK,
        ...(store.state.themeList ?? [])
            .filter(
                (each) =>
                    each.id !== BASE_LOOK &&
                    (each.css.length > 0 || !each.usable) &&
                    !colorsOnly(each),
            )
            .map((each) => each.id),
    ];
}

/** A theme folder with colors and no CSS: it shows under Colors only. */
export const colorsOnly = (each) =>
    each.css.length === 0 && each.colors !== undefined && each.usable;

/** Theme folders' palettes, after the app's own: their ids. */
export function folderPaletteIds() {
    return (store.state.themeList ?? [])
        .filter((each) => each.usable && each.colors && each.id !== BASE_LOOK)
        .flatMap((each) =>
            each.colorsLight ? [each.id, `${each.id}@dark`, `${each.id}@light`] : [each.id],
        );
}

/** CSS variables for a palette. Everything else in style.css mixes from these. */
export function themeVars(palette) {
    const c = palette.colors;
    const pick = (...keys) =>
        keys
            .map((key) => c[key])
            .find((value) => typeof value === "string" && /^#[0-9a-f]{3,8}$/i.test(value));
    const bg = pick("background") ?? "#1a1b26";
    const fg = pick("foreground") ?? "#a9b1d6";
    const accent = pick("accent", "blue") ?? fg;
    const stops = c.active_border ?? [accent];

    return {
        "--o-bg": bg,
        "--o-bg-dark": pick("dark_background") ?? bg,
        "--o-bg-darker": pick("darker_background", "dark_background") ?? bg,
        "--o-bg-light": pick("lighter_background") ?? bg,
        "--o-fg": fg,
        "--o-fg-dim": pick("dark_foreground", "muted") ?? fg,
        "--o-fg-light": pick("light_foreground") ?? fg,
        "--o-fg-bright": pick("bright_foreground") ?? fg,
        "--o-accent": accent,
        "--o-selection": pick("selection", "lighter_background") ?? accent,
        "--o-red": pick("red") ?? "#f7768e",
        "--o-yellow": pick("yellow", "bright_yellow") ?? "#e0af68",
        "--o-orange": pick("orange", "bright_yellow", "yellow") ?? "#ff9e64",
        "--o-green": pick("green") ?? "#9ece6a",
        "--o-cyan": pick("cyan") ?? "#7dcfff",
        "--o-blue": pick("blue", "accent") ?? accent,
        "--o-magenta": pick("magenta") ?? "#bb9af7",
        "--o-active-a": stops[0],
        "--o-active-b": stops[stops.length - 1],
        "--o-active":
            stops.length > 1
                ? `linear-gradient(45deg, ${stops.join(", ")})`
                : `linear-gradient(${stops[0]}, ${stops[0]})`,
        // Only when the theme names one: otherwise style.css's default for dark or light themes.
        "--o-inactive": c.inactive_border ?? null,
    };
}

/** Variables as an inline style. */
export const varsStyle = (vars) =>
    Object.entries(vars)
        .filter(([, value]) => value !== null && value !== undefined)
        .map(([name, value]) => `${name}:${value}`)
        .join(";");

/**
 * Put a palette's variables in the palette layer (index.html declares the layers): under the theme, which may set them
 * again, and over the app's defaults. Inline they would beat the theme. Variables an older version of this page left
 * inline go.
 */
function setPalette(vars) {
    const root = document.documentElement;
    let style = document.getElementById("pocket-palette");

    if (style === null) {
        style = document.createElement("style");
        style.id = "pocket-palette";
        document.head.append(style);
    }

    const text = `@layer palette{:root{${varsStyle(vars)}}}`;

    if (style.textContent !== text) {
        style.textContent = text;
    }

    for (const name of Object.keys(vars)) {
        root.style.removeProperty(name);
    }
}

export const modeOf = (palette) => (palette.colors.mode === "light" ? "light" : "dark");

const reducedMotion = () => {
    const motion = prefs().motion;

    return motion === "reduced" || (motion === "auto" && reduceQuery.matches);
};

/** Put the current look on the page: variables, mode, and the switches style.css reads from data attributes. */
export function apply() {
    const root = document.documentElement;
    const p = prefs();
    const cached = readJson(CACHE, {});
    // Colors of a theme folder before the server listed them: keep what index.html put on the page from the cache.
    const palette = paletteKnown(p.theme) ? paletteOf() : null;
    const vars = palette ? themeVars(palette) : (cached.palette ?? themeVars(paletteOf(FALLBACK)));

    if (palette) {
        setPalette(vars);
    }

    const sheets = themeSheets();

    if (sheets !== null) {
        loadSheets(sheets);
    }

    // A retired cache or preference cannot restore desktop wallpaper.
    root.style.removeProperty("--wallpaper");
    // Width other than Comfortable is the person's choice, inline over the theme's; Comfortable leaves it to the theme.
    const width = WIDTHS[p.width];
    const inline = {
        "--font": FONTS[p.font].family,
        "--text-size": `${p.text}px`,
        "--sidebar-w": sidebarWidth(p),
        ...(width ?? {}),
    };

    if (!width) {
        root.style.removeProperty("--transcript-width");
        root.style.removeProperty("--composer-width");
    }

    for (const [name, value] of Object.entries(inline)) {
        root.style.setProperty(name, value);
    }

    const attrs = {
        mode: palette ? modeOf(palette) : (cached.attrs?.mode ?? "dark"),
        // Before the list, the theme index.html painted from the cache stays named, as its stylesheets stay.
        theme: sheets === null ? (cached.attrs?.theme ?? BASE_LOOK) : (lookOf()?.id ?? BASE_LOOK),
        colors: palette?.id ?? cached.attrs?.colors ?? p.theme,
        tiling: p.tiling ? "on" : "off",
        motion: reducedMotion() ? "reduced" : "full",
        rail: p.sidebar === "rail" ? "on" : "off",
        density: p.density,
        width: WIDTHS[p.width] ? p.width : "comfortable",
    };

    Object.assign(root.dataset, attrs);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", vars["--o-bg"]);
    document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", attrs.mode);
    // In safe mode, or before the list, the theme's stylesheets stay as the cache has them, for the next load.
    const css = sheets === null || safeMode() ? (cached.css ?? []) : sheets;
    const fonts = sheets === null || safeMode() ? (cached.fonts ?? []) : (lookOf()?.fonts ?? []);
    // A pair of palettes: both halves, so the first paint takes the one the system's light or dark asks for.
    const pair = palette?.pair
        ? Object.fromEntries(
              ["dark", "light"].map((half) => {
                  const each = themeVars(paletteOf(`${palette.id}@${half}`));

                  return [half, { palette: each, color: each["--o-bg"] }];
              }),
          )
        : palette
          ? undefined
          : cached.pair;

    localStorage.setItem(
        CACHE,
        JSON.stringify({
            palette: vars,
            vars: inline,
            attrs,
            color: vars["--o-bg"],
            css,
            fonts,
            ...(pair ? { pair } : {}),
        }),
    );
}

/**
 * Change the look with a circle that grows from `at` (a click's place) over the old one, as a view transition. Without
 * view transitions, or with reduced motion, it changes at once.
 */
let transitions = 0;

function transition(change, at) {
    const root = document.documentElement;

    if (
        typeof document.startViewTransition !== "function" ||
        reducedMotion() ||
        document.visibilityState !== "visible"
    ) {
        change();

        return;
    }

    const x = at?.x ?? innerWidth / 2;
    const y = at?.y ?? innerHeight / 2;

    root.style.setProperty("--vt-x", `${x}px`);
    root.style.setProperty("--vt-y", `${y}px`);
    root.style.setProperty(
        "--vt-r",
        `${Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))}px`,
    );
    root.classList.add("theme-vt");
    // A second change while one runs skips the first; only the newest one takes the class off when it ends.
    const mine = ++transitions;
    const run = document.startViewTransition(async () => {
        await change();
        // The store renders in a microtask; let it finish before the new look is captured.
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

    run.finished.finally(() => mine === transitions && root.classList.remove("theme-vt"));
}

function themeForMode(mode, p = prefs()) {
    if (mode === "system" && p.systemPalette) {
        return p.systemPalette;
    }

    const resolved = mode === "system" ? (lightQuery.matches ? "light" : "dark") : mode;
    const id = p[`${resolved}Theme`];

    return folderColors(id)?.pair ? `${id}@${resolved}` : id;
}

function paletteChoice(id) {
    const palette = paletteOf(id);

    return {
        theme: id,
        mode: palette.pair ? "system" : modeOf(palette),
        systemPalette: palette.pair ? id : undefined,
    };
}

function changeTheme(id, mode, event, systemPalette) {
    const at =
        event && "clientX" in event && (event.clientX || event.clientY)
            ? { x: event.clientX, y: event.clientY }
            : undefined;

    if (id === prefs().theme && mode === prefs().mode) {
        // Choosing the inherited palette/mode still makes it this browser's own choice.
        setPrefs({ theme: id, mode, systemPalette });

        return;
    }

    transition(() => setPrefs({ theme: id, mode, systemPalette }), at);
}

/** Choose a live palette, independently of the saved Dark/Light assignments and optional look. */
export function chooseTheme(id, event) {
    if (!knownPalette(id)) {
        return;
    }

    const choice = paletteChoice(id);

    if (previewing === id) {
        setPrefs(choice);
    } else {
        changeTheme(id, choice.mode, event, choice.systemPalette);
    }
}

/** Activate a saved palette slot; System follows later device changes. */
export function chooseMode(mode, event) {
    if (["system", "dark", "light"].includes(mode)) {
        changeTheme(themeForMode(mode, { ...prefs(), systemPalette: undefined }), mode, event);
    }
}

/** Assign a palette for later mode changes without replacing the live palette or following mode. */
export function assignTheme(mode, id) {
    if (["dark", "light"].includes(mode) && knownPalette(id)) {
        setPrefs({ [`${mode}Theme`]: id });
    }
}

/** Look at a theme without choosing it, as the launcher does while arrowing through themes. null goes back. */
let previewing = null;

export function preview(id) {
    if (id === previewing) {
        return;
    }

    previewing = id;
    const palette = id === null ? paletteOf() : paletteOf(id);

    setPalette(themeVars(palette));
    document.documentElement.dataset.mode = modeOf(palette);
}

let started = false;

/** Apply this browser's appearance; only unconfigured new browsers follow the owner's default. */
export function startTheme() {
    apply();

    if (started) {
        return;
    }

    started = true;
    reduceQuery.addEventListener?.("change", apply);
    lightQuery.addEventListener?.("change", () => {
        if (followsDefault) {
            store.set({ appearance: inForce() });
        } else if (prefs().mode === "system") {
            const theme = themeForMode("system");

            if (theme !== prefs().theme) {
                setPrefs({ theme });
            }
        }

        apply();
        // A launcher preview stays temporary while a System choice changes underneath it.
        const id = previewing;

        previewing = null;
        preview(id);
    });
    onSafeModeEnd(apply);
    // Optional folder/default changes never replace a personal selection or write the appearance record.
    let list = store.state.themeList;
    let inherited = JSON.stringify(ownerDefault());

    if (store.state.server) {
        localStorage.setItem(DEFAULT_CACHE, inherited);
    }

    store.subscribe((state) => {
        const next = JSON.stringify(ownerDefault());
        const changed = next !== inherited || state.themeList !== list;

        if (state.server && next !== inherited) {
            localStorage.setItem(DEFAULT_CACHE, next);
        }

        // Update these before store.set, which can synchronously notify subscribers again.
        inherited = next;
        list = state.themeList;

        if (changed) {
            if (followsDefault) {
                store.set({ appearance: inForce() });
            } else if (own.mode === "system") {
                // A pending folder assignment can now resolve to its explicit light/dark half, without rewriting a save.
                const theme = themeForMode("system", own);

                if (theme !== own.theme) {
                    own = { ...own, theme };
                    store.set({ appearance: own });
                }
            }

            apply();
        }
    });
}

/** Theme ids in the order the picker shows them: dark themes, then light ones. */
export function themeIds() {
    const ids = Object.keys(THEMES);

    return [
        ...ids.filter((id) => THEMES[id].colors.mode !== "light"),
        ...ids.filter((id) => THEMES[id].colors.mode === "light"),
    ];
}

export { THEMES };
