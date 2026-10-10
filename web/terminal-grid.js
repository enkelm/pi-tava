/*
 * Structured Herdr terminal renderer. No ANSI parser, transport, or automatic clipboard I/O.
 * Color, input, selection and image geometry rules adapted from Herdr GPUI
 * e370bf0a55b1bf3e7e7fcb5b3f130ebc1a9e68bf, crates/herdr-gpui/src/{terminal.rs,
 * terminal/selection.rs,terminal_painter.rs,terminal_painter/images.rs,config/theme.rs}.
 * Copyright the Herdr and Herdr GPUI contributors. Licensed under Apache-2.0.
 * https://www.apache.org/licenses/LICENSE-2.0
 * Full license: native/herdr-web/LICENSE-APACHE. Upstream: https://github.com/penso/herdr-gpui
 * Changes: browser Canvas2D painting, DOM input/selection, bounded RGBA decoding.
 */
import { h } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import htm from "htm";

const html = htm.bind(h);

export const MAX_SELECTION_BYTES = 1024 * 1024;
const MAX_CELLS = 1_000_000;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

export const MAX_CLIPBOARD_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_CANVAS_PIXELS = 16_000_000;
const BOLD = 1,
    DIM = 2,
    ITALIC = 4,
    UNDERLINE = 8,
    REVERSE = 64,
    HIDDEN = 128,
    STRIKE = 256;
const encoder = new TextEncoder();
const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
const rgb = (n) => `#${(n >>> 0).toString(16).padStart(6, "0").slice(-6)}`;
const integer = (n, max) => Number.isInteger(n) && n >= 0 && n <= max;
// Preact 11 does not append CSS units to numeric values.
const pixels = (style) =>
    Object.fromEntries(
        Object.entries(style).map(([key, value]) => [
            key,
            typeof value === "number" ? `${value}px` : value,
        ]),
    );
const palette = [
    0x000000, 0x800000, 0x008000, 0x808000, 0x000080, 0x800080, 0x008080, 0xc0c0c0, 0x808080,
    0xff0000, 0x00ff00, 0xffff00, 0x0000ff, 0xff00ff, 0x00ffff, 0xffffff,
];

for (let i = 16; i < 256; i++) {
    const n = i - 16;
    const level = (v) => (v === 0 ? 0 : 55 + v * 40);

    palette.push(
        i < 232
            ? (level(Math.floor(n / 36)) << 16) | (level(Math.floor(n / 6) % 6) << 8) | level(n % 6)
            : (8 + (i - 232) * 10) * 0x010101,
    );
}

export const DEFAULT_THEME = Object.freeze({
    foreground: 0xd8dee9,
    background: 0x101419,
    cursor: 0xd8dee9,
    bold: null,
    palette: Object.freeze(palette),
});

export function wireColor(value, fallback, theme = DEFAULT_THEME) {
    switch (value >>> 24) {
        case 0:
            return (value & 255) >= 1 && (value & 255) <= 16
                ? theme.palette[(value & 255) - 1]
                : fallback;
        case 1:
            return theme.palette[value & 255];
        case 2:
            return value & 0xffffff;
        default:
            return fallback;
    }
}

export function cellColors(cell, theme = DEFAULT_THEME) {
    const isDefault = wireColor(cell.fg, -1, theme) === -1;
    let fg =
        cell.modifier & BOLD && isDefault && theme.bold != null
            ? theme.bold
            : wireColor(cell.fg, theme.foreground, theme);
    let bg = wireColor(cell.bg, theme.background, theme);

    if (cell.modifier & REVERSE) {
        [fg, bg] = [bg, fg];
    }

    if (cell.modifier & DIM) {
        fg = ((fg & 0xfefefe) >> 1) + ((bg & 0xfefefe) >> 1);
    }

    if (cell.modifier & HIDDEN) {
        fg = bg;
    }

    return { fg, bg };
}

// The adapter can provide exact unicode-width crate results as frame.cell_widths.
// This fallback covers common CJK, combining sequences, VS16, flags and emoji ZWJ.
// It is not a replacement for the pinned Rust Unicode tables.
export function symbolWidth(symbol) {
    if (
        !symbol ||
        (symbol.length === 1 && symbol.charCodeAt(0) >= 32 && symbol.charCodeAt(0) < 127)
    ) {
        return 1;
    }

    if (
        /\p{Extended_Pictographic}/u.test(symbol) &&
        (symbol.includes("\u200d") || symbol.includes("\ufe0f"))
    ) {
        return 2;
    }

    if (/^[\u{1f1e6}-\u{1f1ff}]{2}$/u.test(symbol) || /[0-9#*]\ufe0f?\u20e3/u.test(symbol)) {
        return 2;
    }

    let width = 0;

    for (const ch of symbol) {
        const n = ch.codePointAt(0);

        if (/\p{Mark}/u.test(ch) || n === 0x200d || n < 32 || (n >= 0x7f && n < 0xa0)) {
            continue;
        }

        width +=
            (/\p{Emoji_Presentation}/u.test(ch) && !symbol.includes("\ufe0e")) ||
            (n >= 0x1100 &&
                (n <= 0x115f ||
                    n === 0x2329 ||
                    n === 0x232a ||
                    (n >= 0x2e80 && n <= 0xa4cf && n !== 0x303f) ||
                    (n >= 0xac00 && n <= 0xd7a3) ||
                    (n >= 0xf900 && n <= 0xfaff) ||
                    (n >= 0xfe10 && n <= 0xfe19) ||
                    (n >= 0xfe30 && n <= 0xfe6f) ||
                    (n >= 0xff00 && n <= 0xff60) ||
                    (n >= 0xffe0 && n <= 0xffe6) ||
                    (n >= 0x1f300 && n <= 0x1faff) ||
                    (n >= 0x20000 && n <= 0x3fffd)))
                ? 2
                : 1;
    }

    return Math.max(1, width);
}

function cellSpan(frame, index, available) {
    const supplied = frame.cell_widths?.[index];

    return Math.min(
        available,
        Math.max(1, integer(supplied, 64) ? supplied : symbolWidth(frame.cells[index].symbol)),
    );
}

export function validFrame(frame) {
    return (
        !!frame &&
        integer(frame.width, 4096) &&
        integer(frame.height, 4096) &&
        frame.width > 0 &&
        frame.height > 0 &&
        frame.width * frame.height <= MAX_CELLS &&
        Array.isArray(frame.cells) &&
        frame.cells.length === frame.width * frame.height &&
        frame.cells.every(
            (c) =>
                c &&
                typeof c.symbol === "string" &&
                c.symbol.length <= 1024 &&
                integer(c.fg, 0xffffffff) &&
                integer(c.bg, 0xffffffff) &&
                integer(c.modifier, 0xffff),
        )
    );
}

export function safeHyperlink(value) {
    if (
        typeof value !== "string" ||
        value.length > 8192 ||
        !/^https?:\/\//i.test(value) ||
        /[\x00-\x20\x7f]/.test(value)
    ) {
        return null;
    }

    try {
        const url = new URL(value);

        return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
            ? url.href
            : null;
    } catch {
        return null;
    }
}

export function keyEvent(event, { altKeys = false, reportAllKeys = false } = {}) {
    if (
        event.metaKey ||
        event.isComposing ||
        event.key === "Dead" ||
        event.key === "Process" ||
        event.keyCode === 229 ||
        event.getModifierState?.("AltGraph")
    ) {
        return null;
    }

    const names = {
        Escape: "Esc",
        Enter: "Enter",
        Backspace: "Backspace",
        Tab: event.shiftKey ? "BackTab" : "Tab",
        ArrowLeft: "Left",
        ArrowRight: "Right",
        ArrowUp: "Up",
        ArrowDown: "Down",
        Home: "Home",
        End: "End",
        PageUp: "PageUp",
        PageDown: "PageDown",
        Insert: "Insert",
        Delete: "Delete",
    };
    let code = names[event.key];

    if (!code && /^F([1-9]|1[0-9]|2[0-4])$/.test(event.key)) {
        code = { F: Number(event.key.slice(1)) };
    }

    if (
        !code &&
        (event.ctrlKey || (event.altKey && altKeys)) &&
        [...(event.key || "")].length === 1
    ) {
        code = { Char: event.key };
    }

    if (!code) {
        return null;
    }

    return {
        Key: {
            code,
            modifiers: modifiers(event),
            kind: event.repeat ? "Repeat" : "Press",
            repeat_count: 1,
            shifted_codepoint: null,
            generated_text: null,
            tracks_release: reportAllKeys,
            physical_key_id: null,
            windows_record: null,
        },
    };
}

const modifiers = (e) =>
    (e.shiftKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.altKey ? 4 : 0) | (e.metaKey ? 8 : 0);
const contains = (r, x, y) => r && x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height;

export function targetAt(surface, x, y) {
    if (!surface?.frame) {
        return null;
    }

    if (surface.popup) {
        const p = surface.popup;
        const rect = {
            x: Math.max(0, (surface.frame.width - p.frame.width) / 2),
            y: Math.max(0, (surface.frame.height - p.frame.height) / 2),
            width: p.frame.width,
            height: p.frame.height,
        };

        return contains(rect, x, y)
            ? { ...p, id: p.terminal_id, popup: true, rect, frame: p.frame }
            : null;
    }

    const p = surface.panes?.find((pane) => contains(pane.inner_rect, x, y));

    return p
        ? { ...p, id: p.pane_id, popup: false, rect: p.inner_rect, frame: surface.frame }
        : null;
}

export function mouseEvent(target, x, y, kind, event, cell, lines = 1) {
    const r = target.rect;
    const localX = clamp(x - r.x, 0, Math.max(0, r.width - 0.001));
    const localY = clamp(y - r.y, 0, Math.max(0, r.height - 0.001));
    const column = Math.floor(localX),
        row = Math.floor(localY);
    const geometry =
        target.sgr_pixel_mouse && target.pixel_width > 0 && target.pixel_height > 0
            ? {
                  cols: r.width,
                  rows: r.height,
                  width_px: target.pixel_width,
                  height_px: target.pixel_height,
              }
            : null;
    const position = geometry
        ? {
              Pixels: {
                  x: Math.floor((localX / r.width) * geometry.width_px),
                  y: Math.floor((localY / r.height) * geometry.height_px),
                  column,
                  row,
              },
          }
        : { Cell: { column, row } };

    return {
        Mouse: {
            kind,
            position,
            geometry,
            modifiers: modifiers(event),
            lines: clamp(lines, 1, 128),
        },
    };
}

/** Selection never crosses a pane boundary, exposes hidden cells, or copies more than 1 MiB. */
export function selectionText(frame, region, anchor, head, limit = MAX_SELECTION_BYTES) {
    if (!validFrame(frame)) {
        return "";
    }

    const left = clamp(Math.floor(region.x), 0, frame.width - 1);
    const right = clamp(Math.floor(region.x + region.width), left + 1, frame.width);
    const top = clamp(Math.floor(region.y), 0, frame.height - 1);
    const bottom = clamp(Math.floor(region.y + region.height), top + 1, frame.height);
    const point = (p) => ({
        x: clamp(Math.floor(p.x), left, right - 1),
        y: clamp(Math.floor(p.y), top, bottom - 1),
    });
    let a = point(anchor),
        b = point(head);

    if (a.y * frame.width + a.x > b.y * frame.width + b.x) {
        [a, b] = [b, a];
    }

    let text = "",
        bytes = 0;

    for (let y = a.y; y <= b.y; y++) {
        let row = "";

        for (let x = left; x < right;) {
            const index = y * frame.width + x;
            const c = frame.cells[index];
            const span = cellSpan(frame, index, right - x);

            if (
                !c.skip &&
                x + span > (y === a.y ? a.x : left) &&
                x <= (y === b.y ? b.x : right - 1)
            ) {
                const symbol = c.modifier & HIDDEN ? " " : c.symbol || " ";
                const size = encoder.encode(symbol).length;

                if (bytes + size > Math.min(limit, MAX_SELECTION_BYTES)) {
                    return text + row;
                }

                row += symbol;
                bytes += size;
            }

            x += c.skip ? 1 : span;
        }

        text += row.replace(/ +$/, "");

        if (y < b.y && bytes < limit) {
            text += "\n";
            bytes++;
        }
    }

    return text;
}

export function decodeRGBA(image) {
    const { width, height, rgba_base64: data } = image || {};

    if (
        !integer(width, 4096) ||
        !integer(height, 4096) ||
        !width ||
        !height ||
        width * height * 4 > MAX_IMAGE_BYTES ||
        typeof data !== "string" ||
        data.length !== Math.ceil((width * height * 4) / 3) * 4 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
    ) {
        throw new Error("Image exceeds browser RGBA limits or has invalid dimensions");
    }

    const decoded = atob(data);

    if (decoded.length !== width * height * 4) {
        throw new Error("Image RGBA byte length does not match its dimensions");
    }

    return Uint8ClampedArray.from(decoded, (c) => c.charCodeAt(0));
}

export function imageBytes(image) {
    const key = image?.key;
    const width = key?.image_width,
        height = key?.image_height,
        data = image?.data;

    if (
        image?.encoding !== "base64" ||
        !integer(width, 4096) ||
        !integer(height, 4096) ||
        !width ||
        !height ||
        width * height * 4 > MAX_IMAGE_BYTES ||
        typeof data !== "string" ||
        data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
        data.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
    ) {
        throw new Error("Image exceeds browser decoding limits");
    }

    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));

    if (String(bytes.length) !== String(key.data_len)) {
        throw new Error("Image byte length does not match its asset key");
    }

    if (key.format === "Rgb" || key.format === "Rgba") {
        if (bytes.length !== width * height * (key.format === "Rgb" ? 3 : 4)) {
            throw new Error("Image pixel length does not match its dimensions");
        }
    } else if (key.format === "Png") {
        const view = new DataView(bytes.buffer);

        if (
            bytes.length < 33 ||
            view.getUint32(0) !== 0x89504e47 ||
            view.getUint32(4) !== 0x0d0a1a0a ||
            view.getUint32(8) !== 13 ||
            view.getUint32(12) !== 0x49484452 ||
            view.getUint32(16) !== width ||
            view.getUint32(20) !== height
        ) {
            throw new Error("PNG dimensions or signature do not match its asset key");
        }
    } else {
        throw new Error("Unsupported image format");
    }

    return bytes;
}

async function browserImage(image) {
    const bytes = imageBytes(image),
        key = image.key;

    if (key.format === "Png") {
        // Local validated bytes only; never fetch a terminal-supplied URL.
        const blob = new Blob([bytes], { type: "image/png" });

        if (typeof createImageBitmap === "function") {
            return createImageBitmap(blob);
        }

        const url = URL.createObjectURL(blob);

        try {
            const element = new Image();

            await new Promise((resolve, reject) => {
                element.onload = resolve;
                element.onerror = () => reject(new Error("PNG could not be decoded"));
                element.src = url;
            });

            return element;
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    const rgba = new Uint8ClampedArray(key.image_width * key.image_height * 4);

    if (key.format === "Rgba") {
        rgba.set(bytes);
    } else {
        for (let i = 0, j = 0; i < bytes.length; i += 3, j += 4) {
            rgba.set([bytes[i], bytes[i + 1], bytes[i + 2], 255], j);
        }
    }

    const element = document.createElement("canvas");

    element.width = key.image_width;
    element.height = key.image_height;
    element.getContext("2d").putImageData(new ImageData(rgba, element.width, element.height), 0, 0);

    return element;
}

/** Validate a file supplied by an explicit paste event. Never reads navigator.clipboard. */
export async function clipboardPNG(file) {
    if (file?.type !== "image/png") {
        throw new Error(
            "Only PNG clipboard images are supported. Copy a PNG image and paste again.",
        );
    }

    if (!integer(file.size, MAX_CLIPBOARD_IMAGE_BYTES) || file.size < 33) {
        throw new Error("Clipboard image must be a PNG no larger than 8 MiB.");
    }

    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    if (bytes.length !== file.size) {
        throw new Error("Clipboard image changed while being read. Paste again.");
    }

    const view = new DataView(buffer);
    const width = view.getUint32(16),
        height = view.getUint32(20);

    if (
        view.getUint32(0) !== 0x89504e47 ||
        view.getUint32(4) !== 0x0d0a1a0a ||
        view.getUint32(8) !== 13 ||
        view.getUint32(12) !== 0x49484452 ||
        !width ||
        !height ||
        width > 4096 ||
        height > 4096
    ) {
        throw new Error("Clipboard PNG has an invalid header or exceeds 4096 × 4096 pixels.");
    }

    let binary = "";

    for (let i = 0; i < bytes.length; i += 32768) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    }

    return { encoding: "base64", format: "png", data: btoa(binary) };
}

function imageKey(key) {
    // Native JSON retains u64 fingerprints as strings. Do not parse them as numbers.
    return JSON.stringify([
        key?.source,
        key?.image_width,
        key?.image_height,
        key?.format,
        key?.data_len,
        key?.data_fingerprint,
    ]);
}

const frameRect = (frame) => ({ x: 0, y: 0, width: frame.width, height: frame.height });

function intersectRect(a, b) {
    if (
        !a ||
        !b ||
        ![a.x, a.y, a.width, a.height, b.x, b.y, b.width, b.height].every(Number.isFinite)
    ) {
        return null;
    }

    const x = Math.max(a.x, b.x),
        y = Math.max(a.y, b.y);
    const width = Math.min(a.x + a.width, b.x + b.width) - x;
    const height = Math.min(a.y + a.height, b.y + b.height) - y;

    return width > 0 && height > 0 ? { x, y, width, height } : null;
}

function visiblePaneRect(frame, pane) {
    return intersectRect(intersectRect(frameRect(frame), pane?.rect), pane?.inner_rect);
}

function canvasClip(ctx, rect, cw, ch) {
    ctx.beginPath();
    ctx.rect(rect.x * cw, rect.y * ch, rect.width * cw, rect.height * ch);
    ctx.clip();
}

// The composite grid also contains borders/chrome. Partition each row at every
// pane and content edge, so a wide symbol cannot cover a divider or suppress the
// next pane's glyphs. Cell positions/colors remain authoritative; the flattened
// grid does not identify which original pane produced a misplaced character.
function rowRanges(frame, panes, y) {
    const edges = new Set([0, frame.width]);

    for (const pane of panes) {
        for (const rect of [
            intersectRect(frameRect(frame), pane.rect),
            visiblePaneRect(frame, pane),
        ]) {
            if (rect && y >= rect.y && y < rect.y + rect.height) {
                edges.add(rect.x);
                edges.add(rect.x + rect.width);
            }
        }
    }

    const sorted = [...edges].sort((a, b) => a - b);

    return sorted.slice(0, -1).map((start, i) => [start, sorted[i + 1]]);
}

function paintImages(ctx, images, placements, popupId, cw, ch, below, cache, report, frame, panes) {
    for (const p of [...placements].sort((a, b) => a.z - b.z)) {
        const popup = p.asset?.source?.Terminal?.target?.Popup?.terminal_id;

        if (p.z < 0 !== below || (popupId ? popup !== popupId : !!popup)) {
            continue;
        }

        const paneId =
            p.asset?.source?.Terminal?.target?.Pane?.pane_id || p.asset?.source?.PaneLayer?.pane_id;
        const targetPane = panes.find((pane) => pane.pane_id === paneId);

        if (!popupId && !targetPane) {
            report("A graphics placement has no target pane; it was not painted.");
            continue;
        }

        const clip = popupId ? frameRect(frame) : visiblePaneRect(frame, targetPane);

        if (!clip) {
            continue;
        }

        const key = imageKey(p.asset);
        const image = images.find((i) => imageKey(i.key || i.placement?.asset) === key);

        if (!image) {
            report("Image data is unavailable for a graphics placement");
            continue;
        }

        const bitmap = cache.get(image);

        if (!bitmap) {
            continue;
        }

        const iw = p.asset.image_width,
            ih = p.asset.image_height;
        const sx = p.source_x || 0,
            sy = p.source_y || 0;
        const sw = Math.min(p.source_width || iw, iw - sx),
            sh = Math.min(p.source_height || ih, ih - sy);
        const ox =
            (clamp(p.x_offset || 0, 0, Math.max(0, p.cols * Math.round(cw) - 1)) * cw) /
            Math.round(cw);
        const oy =
            (clamp(p.y_offset || 0, 0, Math.max(0, p.rows * Math.round(ch) - 1)) * ch) /
            Math.round(ch);

        if (sw > 0 && sh > 0 && p.cols * cw > ox && p.rows * ch > oy) {
            ctx.save();
            canvasClip(ctx, clip, cw, ch);
            ctx.drawImage(
                bitmap,
                (sx / iw) * bitmap.width,
                (sy / ih) * bitmap.height,
                (sw / iw) * bitmap.width,
                (sh / ih) * bitmap.height,
                p.x * cw + ox,
                p.y * ch + oy,
                p.cols * cw - ox,
                p.rows * ch - oy,
            );
            ctx.restore();
        }
    }
}

// Keep common terminal borders continuous at the cell edges instead of relying on font ascent.
function paintCellGraphic(ctx, symbol, x, y, cw, ch) {
    const arms = {
        "─": 3,
        "│": 12,
        "┌": 10,
        "┐": 9,
        "└": 6,
        "┘": 5,
        "├": 14,
        "┤": 13,
        "┬": 11,
        "┴": 7,
        "┼": 15,
        "━": 3,
        "┃": 12,
        "┏": 10,
        "┓": 9,
        "┗": 6,
        "┛": 5,
        "┣": 14,
        "┫": 13,
        "┳": 11,
        "┻": 7,
        "╋": 15,
    };
    const arm = arms[symbol];

    if (arm) {
        const thick = "━┃┏┓┗┛┣┫┳┻╋".includes(symbol) ? 2 : 1;
        const mx = x + cw / 2,
            my = y + ch / 2;

        if (arm & 1) {
            ctx.fillRect(x, my - thick / 2, cw / 2 + thick / 2, thick);
        }

        if (arm & 2) {
            ctx.fillRect(mx - thick / 2, my - thick / 2, cw / 2 + thick / 2, thick);
        }

        if (arm & 4) {
            ctx.fillRect(mx - thick / 2, y, thick, ch / 2 + thick / 2);
        }

        if (arm & 8) {
            ctx.fillRect(mx - thick / 2, my - thick / 2, thick, ch / 2 + thick / 2);
        }

        return true;
    }

    const cp = symbol.codePointAt(0);

    if (symbol.length === 1 && cp >= 0x2581 && cp <= 0x2588) {
        const part = (cp - 0x2580) / 8;

        ctx.fillRect(x, y + ch * (1 - part), cw, ch * part);

        return true;
    }

    if (symbol.length === 1 && cp >= 0x2589 && cp <= 0x258f) {
        ctx.fillRect(x, y, (cw * (0x2590 - cp)) / 8, ch);

        return true;
    }

    if (symbol === "▀" || symbol === "▐") {
        ctx.fillRect(
            x + (symbol === "▐" ? cw / 2 : 0),
            y,
            symbol === "▐" ? cw / 2 : cw,
            symbol === "▀" ? ch / 2 : ch,
        );

        return true;
    }

    return false;
}

function paintFrame(
    ctx,
    frame,
    { cw, ch, fontSize, fontFamily, theme, images, placements, popupId, cache, report, panes = [] },
) {
    ctx.save();
    canvasClip(ctx, frameRect(frame), cw, ch);

    // Backgrounds are one-cell quads, never measured text runs.
    for (let i = 0; i < frame.cells.length; i++) {
        ctx.fillStyle = rgb(cellColors(frame.cells[i], theme).bg);
        ctx.fillRect((i % frame.width) * cw, Math.floor(i / frame.width) * ch, cw, ch);
    }

    paintImages(ctx, images, placements, popupId, cw, ch, true, cache, report, frame, panes);
    ctx.textBaseline = "alphabetic";

    for (let y = 0; y < frame.height; y++) {
        for (const [start, end] of rowRanges(frame, panes, y)) {
            ctx.save();
            canvasClip(ctx, { x: start, y, width: end - start, height: 1 }, cw, ch);
            let covered = start;

            for (let x = start; x < end; x++) {
                const index = y * frame.width + x,
                    c = frame.cells[index];
                const span = cellSpan(frame, index, end - x);

                ctx.fillStyle = rgb(cellColors(c, theme).fg);

                if (x >= covered && !c.skip) {
                    covered = x + span;
                    ctx.font = `${c.modifier & ITALIC ? "italic " : ""}${c.modifier & BOLD ? "bold " : ""}${fontSize}px ${fontFamily}`;
                    ctx.save();
                    canvasClip(ctx, { x, y, width: span, height: 1 }, cw, ch);

                    if (
                        !(c.modifier & HIDDEN) &&
                        !paintCellGraphic(ctx, c.symbol, x * cw, y * ch, cw, ch)
                    ) {
                        ctx.fillText(
                            c.symbol,
                            x * cw,
                            y * ch + (ch - fontSize) / 2 + fontSize * 0.8,
                        );
                    }

                    ctx.restore();
                }

                if (c.modifier & UNDERLINE) {
                    ctx.fillRect(x * cw, (y + 1) * ch - 2, cw, 1);
                }

                if (c.modifier & STRIKE) {
                    ctx.fillRect(x * cw, y * ch + ch / 2, cw, 1);
                }
            }

            ctx.restore();
        }
    }

    paintImages(ctx, images, placements, popupId, cw, ch, false, cache, report, frame, panes);
    ctx.restore();
}

/**
 * Preact component. Parent owns connection/authentication and loads complete frames.
 * images: [{key: SurfaceGraphicsAssetKey, serial, encoding: "base64", data}], never URLs.
 * Native Rgb, Rgba and Png; PNG dimensions are checked before decoding.
 * onInput(paneIdOrPopupTerminalId, ClientPaneInputEvent[], popupBoolean).
 * onShortcut(KeyboardEvent, {targetId, popup}) synchronously returns true to consume
 * an application binding or chord prefix before any PTY input. UI owns chord state/timers.
 * Terminal key events do not bubble; document/window capture listeners must also check focus.
 * onPasteImage(targetId, {encoding:"base64",format:"png",data}, popupBoolean) handles
 * only explicit image paste gestures. Parent wraps this in native clipboard-image + bootId.
 * onResize({cols,rows,cell_width_px,cell_height_px}) fires only while enabled.
 * onAction: focus-pane, unsupported; no Herdr mutation is inferred from a render.
 * focus-pane is called before the first mouse event; false / Promise<false> rejects it.
 * inputEpoch identifies the UI connection/stream generation, even for the same boot/pane.
 * Changing it cancels pending clipboard/IME input and local focus intent; never replay those.
 * focusRef.current: focus() restores desktop input if safe; isFocused() checks it;
 * setTarget(paneId) records a known navigation target without an RPC and returns a
 * cancellation function. Call that function if navigation/focus is rejected.
 * Optional exact widths: frame.cell_widths[] from the pinned unicode-width crate.
 */
export function TerminalGrid({
    surface,
    images = [],
    enabled = false,
    disabled = false,
    onInput,
    onShortcut,
    onPasteImage,
    onResize,
    onAction,
    focusRef,
    inputEpoch = 0,
    theme: suppliedTheme,
    fontSize = 14,
    cellHeight = 20,
    cellWidth,
    fontFamily = '"SFMono-Regular", Menlo, Consolas, monospace',
    altKeys = false,
    reportAllKeys = false,
    showKeybar = true,
    className = "",
    label = "Terminal",
    clipboardOffer = null,
}) {
    const theme = { ...DEFAULT_THEME, ...suppliedTheme };
    const interactive = enabled && !disabled;
    const viewport = useRef(null),
        canvas = useRef(null),
        input = useRef(null);
    const latest = useRef(null),
        drag = useRef(null),
        composing = useRef(false),
        cancelledComposition = useRef(false),
        compositionTarget = useRef(null),
        lastCommit = useRef(null);
    const held = useRef(new Map()),
        imageCache = useRef(new Map()),
        reports = useRef(new Set());
    const wheel = useRef({ id: null, x: 0, y: 0 });
    const pasteState = useRef({ context: "", epoch: 0, pending: false, inputEpoch });
    const pendingPane = useRef(null);
    const externalActivity = useRef({ composing: false, dragging: false });
    const [metrics, setMetrics] = useState({ cw: cellWidth || fontSize * 0.6, ch: cellHeight });
    const [selection, setSelection] = useState(null),
        [focused, setFocused] = useState(false);
    const [ctrl, setCtrl] = useState(false),
        [notice, setNotice] = useState("");
    const [imageVersion, setImageVersion] = useState(0);
    const [linkOffer, setLinkOffer] = useState(null);
    const frame = surface?.frame;
    const valid = validFrame(frame) && (!surface.popup || validFrame(surface.popup.frame));
    const { cw, ch } = metrics;
    const width = valid ? frame.width * cw : 1,
        height = valid ? frame.height * ch : 1;
    const drawable =
        valid && width <= 8192 && height <= 8192 && width * height <= MAX_CANVAS_PIXELS;

    const report = (feature) => {
        if (!reports.current.has(feature)) {
            reports.current.add(feature);
            setNotice(feature);
            onAction?.({ type: "unsupported", feature });
        }
    };

    const activeTarget = () => {
        const pending = pendingPane.current;

        if (pending) {
            const pane = surface?.panes?.find((p) => p.pane_id === pending.id);

            if (
                pending.boot !== surface?.boot_id ||
                pending.inputEpoch !== inputEpoch ||
                !interactive ||
                (pending.seen && !pane)
            ) {
                pendingPane.current = null;
            } else if (pane) {
                pending.seen = true;

                // Do not mistake the frame from before the request for an acknowledgement.
                if (pane.focused && surface !== pending.before) {
                    pendingPane.current = null;
                }
            }
        }

        if (surface?.popup) {
            return { id: surface.popup.terminal_id, popup: true };
        }

        return {
            id: pendingPane.current?.id || surface?.panes?.find((p) => p.focused)?.pane_id,
            popup: false,
        };
    };

    const setTarget = (paneId) => {
        if (!interactive || !surface?.boot_id || typeof paneId !== "string" || !paneId) {
            return null;
        }

        const pending = {
            id: paneId,
            boot: surface.boot_id,
            inputEpoch,
            before: surface,
            seen: surface.panes?.some((p) => p.pane_id === paneId) || false,
        };

        pendingPane.current = pending;
        pasteState.current.epoch++;

        return () => {
            if (pendingPane.current === pending) {
                pendingPane.current = null;
                pasteState.current.epoch++;
            }
        };
    };

    const send = (events, target = activeTarget()) => {
        if (interactive && drawable && target?.id && events.length) {
            onInput?.(target.id, events, !!target.popup);
        }
    };

    const target = activeTarget();

    if (pasteState.current.inputEpoch !== inputEpoch) {
        if (composing.current) {
            cancelledComposition.current = true;
        }

        held.current.clear();
        drag.current = null;
        pasteState.current.inputEpoch = inputEpoch;
    }

    const pasteContext = JSON.stringify([
        interactive,
        inputEpoch,
        surface?.boot_id,
        target.id,
        target.popup,
    ]);

    if (pasteState.current.context !== pasteContext) {
        if (composing.current && pasteState.current.context) {
            cancelledComposition.current = true;
        }

        pasteState.current.context = pasteContext;
        pasteState.current.epoch++;
    }

    latest.current = { interactive, inputEpoch, onResize, onPasteImage, surface, send, report };

    useLayoutEffect(() => {
        const context = document.createElement("canvas").getContext("2d");

        const measure = () => {
            context.font = `${fontSize}px ${fontFamily}`;
            setMetrics({
                cw: Math.max(1, cellWidth || context.measureText("M").width),
                ch: Math.max(1, cellHeight),
            });
        };

        measure();
        let alive = true;

        document.fonts?.ready.then(() => {
            if (alive) {
                measure();
            }
        });

        return () => {
            alive = false;
        };
    }, [fontSize, cellHeight, cellWidth, fontFamily]);

    useEffect(() => {
        let last = "";

        const resize = () => {
            const el = viewport.current;

            if (!el || !latest.current.interactive || !el.clientWidth || !el.clientHeight) {
                return;
            }

            const cols = clamp(Math.floor(el.clientWidth / cw), 1, 4096);
            const rows = clamp(
                Math.floor(el.clientHeight / ch),
                1,
                Math.min(4096, Math.floor(MAX_CELLS / cols)),
            );
            const size = {
                cols,
                rows,
                cell_width_px: Math.max(1, Math.round(cw)),
                cell_height_px: Math.max(1, Math.round(ch)),
            };
            const key = JSON.stringify(size);

            if (key !== last) {
                last = key;
                latest.current.onResize?.(size);
            }
        };

        const observer = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;

        observer?.observe(viewport.current);
        window.addEventListener("resize", resize);
        resize();

        return () => {
            observer?.disconnect();
            window.removeEventListener("resize", resize);
        };
    }, [cw, ch, interactive]);

    useEffect(() => {
        setSelection(null);
        setLinkOffer(null);
        setCtrl(false);
        drag.current = null;
        held.current.clear();
        composing.current = false;
        lastCommit.current = null;
        reports.current.clear();
        setNotice("");

        if (input.current) {
            input.current.value = "";
        }
    }, [surface?.boot_id, surface?.popup?.terminal_id, interactive, inputEpoch]);

    useEffect(() => {
        setSelection(null);
        drag.current = null;
    }, [frame?.width, frame?.height]);

    useEffect(() => {
        let alive = true;
        const cache = imageCache.current;
        const accepted = Array.isArray(images) ? images.slice(0, 128) : [];

        for (const [key, bitmap] of cache) {
            if (!accepted.includes(key)) {
                bitmap.close?.();
                cache.delete(key);
            }
        }

        let bytes = 0;

        const decode = async () => {
            for (const image of accepted) {
                if (!alive) {
                    return;
                }

                bytes += (image.key?.image_width || 0) * (image.key?.image_height || 0) * 4;

                if (bytes > MAX_IMAGE_BYTES) {
                    latest.current.report("Graphics exceed the 32 MiB browser image memory limit");
                    break;
                }

                if (cache.has(image)) {
                    continue;
                }

                try {
                    const bitmap = await browserImage(image);

                    if (!alive) {
                        bitmap.close?.();

                        return;
                    }

                    cache.set(image, bitmap);
                    setImageVersion((v) => v + 1);
                } catch (error) {
                    if (alive) {
                        latest.current.report(error.message);
                    }
                }
            }

            if (images.length > 128 && alive) {
                latest.current.report("Graphics exceed the 128-image browser limit");
            }
        };

        decode();

        return () => {
            alive = false;
        };
    }, [images]);

    useEffect(
        () => () => {
            for (const bitmap of imageCache.current.values()) {
                bitmap.close?.();
            }

            imageCache.current.clear();
        },
        [],
    );

    useLayoutEffect(() => {
        if (!drawable || !canvas.current) {
            return;
        }

        const dpr = Math.min(
            window.devicePixelRatio || 1,
            2,
            Math.sqrt(MAX_CANVAS_PIXELS / (width * height)),
        );
        const element = canvas.current;

        element.width = Math.ceil(width * dpr);
        element.height = Math.ceil(height * dpr);
        const ctx = element.getContext("2d");

        if (!ctx) {
            report("Canvas2D is unavailable in this browser");

            return;
        }

        ctx.scale(dpr, dpr);
        const bounded = Array.isArray(images) ? images.slice(0, 128) : [];

        const options = {
            cw,
            ch,
            fontSize,
            fontFamily,
            theme,
            images: bounded,
            placements: surface.graphics?.placements?.slice(0, 4096) || [],
            panes: surface.panes || [],
            cache: imageCache.current,
            report,
        };

        paintFrame(ctx, frame, options);

        if (selection && selection.boot === surface.boot_id && !selection.target.popup) {
            paintSelection(
                ctx,
                selection,
                cw,
                ch,
                theme,
                visiblePaneRect(
                    frame,
                    surface.panes?.find((pane) => pane.pane_id === selection.target.id),
                ),
            );
        }

        if (surface.popup) {
            ctx.fillStyle = "rgba(0,0,0,0.35)";
            ctx.fillRect(0, 0, width, height);
            const popup = surface.popup;

            ctx.save();
            ctx.translate(
                Math.floor(Math.max(0, width - popup.frame.width * cw) / 2),
                Math.max(0, height - popup.frame.height * ch) / 2,
            );
            paintFrame(ctx, popup.frame, { ...options, panes: [], popupId: popup.terminal_id });

            if (selection?.target.popup) {
                paintSelection(ctx, selection, cw, ch, theme, frameRect(popup.frame));
            }

            ctx.restore();
        }

        if (frame.graphics?.length || surface.popup?.frame.graphics?.length) {
            report(
                "Legacy inline graphics controls are not rendered; structured RGBA placements are required",
            );
        }
    }, [
        surface,
        images,
        imageVersion,
        cw,
        ch,
        fontSize,
        fontFamily,
        suppliedTheme,
        selection,
        drawable,
    ]);

    const point = (event) => {
        const bounds = canvas.current.getBoundingClientRect();

        return { x: (event.clientX - bounds.left) / cw, y: (event.clientY - bounds.top) / ch };
    };

    const focusInput = () => {
        if (interactive) {
            input.current?.focus({ preventScroll: true });
        }
    };

    // The UI explicitly calls this after navigation. There is no render-time or
    // document-wide autofocus loop; pointer entry and this ref share one guard.
    const focusSafely = () => {
        const element = input.current;

        if (!interactive || !drawable || !element?.isConnected) {
            return false;
        }

        if (document.activeElement === element) {
            return true;
        }

        if (
            !window.matchMedia("(min-width: 601px) and (hover: hover) and (pointer: fine)")
                .matches ||
            composing.current ||
            externalActivity.current.composing ||
            externalActivity.current.dragging ||
            drag.current
        ) {
            return false;
        }

        const active = document.activeElement;

        if (
            active?.isContentEditable ||
            active?.closest(
                "input, textarea, select, form, [contenteditable='true'], [role='textbox']",
            )
        ) {
            return false;
        }

        const modal = [
            ...document.querySelectorAll(
                "dialog[open], [aria-modal='true'], [role='dialog'], [role='alertdialog']",
            ),
        ].some(
            (node) =>
                node.getClientRects().length && getComputedStyle(node).visibility !== "hidden",
        );

        if (modal) {
            return false;
        }

        element.focus({ preventScroll: true });

        return document.activeElement === element;
    };

    latest.current.focusSafely = focusSafely;
    latest.current.setTarget = setTarget;

    useLayoutEffect(() => {
        if (!focusRef) {
            return;
        }

        const controls = {
            focus: () => latest.current.focusSafely(),
            isFocused: () => !!input.current && document.activeElement === input.current,
            setTarget: (paneId) => latest.current.setTarget(paneId),
        };

        focusRef.current = controls;

        return () => {
            if (focusRef.current === controls) {
                focusRef.current = null;
            }
        };
    }, [focusRef]);

    useEffect(() => {
        const startComposition = () => {
            externalActivity.current.composing = true;
        };

        const endComposition = () => {
            externalActivity.current.composing = false;
        };

        const startDrag = () => {
            externalActivity.current.dragging = true;
        };

        const endDrag = () => {
            externalActivity.current.dragging = false;
        };

        const events = [
            ["compositionstart", startComposition],
            ["compositionend", endComposition],
            ["dragstart", startDrag],
            ["dragend", endDrag],
            ["drop", endDrag],
        ];

        for (const [name, handler] of events) {
            document.addEventListener(name, handler, true);
        }

        return () => {
            for (const [name, handler] of events) {
                document.removeEventListener(name, handler, true);
            }
        };
    }, []);

    const enter = (event) => {
        if (event.pointerType === "mouse" && !event.buttons) {
            focusSafely();
        }
    };

    const focusPane = (target) => {
        if (
            !interactive ||
            target.popup ||
            pendingPane.current?.id === target.id ||
            (!pendingPane.current && target.focused)
        ) {
            return true;
        }

        const cancel = setTarget(target.id);

        const rejected = () => {
            cancel?.();

            if (input.current?.isConnected && latest.current.inputEpoch === inputEpoch) {
                latest.current.report("Pane focus was rejected; input was not retried.");
            }
        };

        try {
            if (!onAction) {
                rejected();

                return false;
            }

            // The owner queues pane.focus on the same connection before onInput.
            const result = onAction({ type: "focus-pane", paneId: target.id });

            if (result === false) {
                rejected();

                return false;
            }

            if (result?.then) {
                Promise.resolve(result).then((accepted) => {
                    if (accepted === false) {
                        rejected();
                    }
                }, rejected);
            }

            return true;
        } catch {
            rejected();

            return false;
        }
    };

    const selectPoint = (p, target) => ({
        x: Math.floor(
            clamp(
                p.x - (target.popup ? target.rect.x : 0),
                target.popup ? 0 : target.rect.x,
                (target.popup ? 0 : target.rect.x) + target.rect.width - 1,
            ),
        ),
        y: Math.floor(
            clamp(
                p.y - (target.popup ? target.rect.y : 0),
                target.popup ? 0 : target.rect.y,
                (target.popup ? 0 : target.rect.y) + target.rect.height - 1,
            ),
        ),
    });

    const down = (event) => {
        if (!drawable || event.button < 0 || event.button > 2) {
            return;
        }

        const p = point(event),
            target = targetAt(surface, p.x, p.y);

        if (!target) {
            const split = surface.splits?.find((s) => contains(s.hit_rect, p.x, p.y));

            if (split && interactive) {
                report("Split resizing is not supported in the browser yet");
            }

            if (
                interactive &&
                surface.panes?.some((pane) => contains(pane.scrollbar_rect, p.x, p.y))
            ) {
                report(
                    "Scrollbar dragging is not supported; use the wheel to scroll terminal history",
                );
            }

            return;
        }

        const hit = selectPoint(p, target);
        const cell = target.frame.cells[hit.y * target.frame.width + hit.x];
        const linkClick =
            (event.ctrlKey || event.metaKey) &&
            !(cell?.modifier & HIDDEN) &&
            safeHyperlink(target.frame.hyperlinks?.[cell?.hyperlink]);
        const application = interactive && target.mouse_reporting && !event.shiftKey && !linkClick;

        if (event.button !== 0 && !application) {
            return;
        }

        event.preventDefault();

        if (!focusPane(target)) {
            return;
        }

        focusInput();
        canvas.current.setPointerCapture?.(event.pointerId);
        const button = ["Left", "Middle", "Right"][event.button] || "Left";

        drag.current = { target, button, application, start: p, moved: false };

        if (application) {
            setSelection(null);
            send([mouseEvent(target, p.x, p.y, { Down: button }, event, metrics)], target);
        } else {
            const anchor = selectPoint(p, target);

            setSelection({ boot: surface.boot_id, target, anchor, head: anchor, text: "" });
        }
    };

    const move = (event) => {
        if (!drawable) {
            return;
        }

        const p = point(event),
            d = drag.current;

        if (!d) {
            const target = targetAt(surface, p.x, p.y);

            if (interactive && target?.mouse_reporting && !event.shiftKey && focused) {
                send([mouseEvent(target, p.x, p.y, "Moved", event, metrics)], target);
            }

            return;
        }

        d.moved ||= Math.abs(p.x - d.start.x) + Math.abs(p.y - d.start.y) > 0.3;

        if (d.application) {
            send([mouseEvent(d.target, p.x, p.y, { Drag: d.button }, event, metrics)], d.target);
        } else {
            setSelection((s) => s && { ...s, head: selectPoint(p, d.target) });
        }
    };

    const up = (event) => {
        const d = drag.current;

        if (!d || !drawable) {
            return;
        }

        drag.current = null;
        const p = point(event);

        if (d.application) {
            send([mouseEvent(d.target, p.x, p.y, { Up: d.button }, event, metrics)], d.target);
        } else {
            const head = selectPoint(p, d.target),
                anchor = selectPoint(d.start, d.target);
            const region = d.target.popup
                ? { x: 0, y: 0, width: d.target.rect.width, height: d.target.rect.height }
                : d.target.rect;
            const text = d.moved ? selectionText(d.target.frame, region, anchor, head) : "";

            setSelection(
                text ? { boot: surface.boot_id, target: d.target, anchor, head, text } : null,
            );

            if (!d.moved) {
                let x = head.x;
                const row = head.y * d.target.frame.width;

                for (let start = region.x; start <= head.x;) {
                    const span = cellSpan(
                        d.target.frame,
                        row + start,
                        region.x + region.width - start,
                    );

                    if (start + span > head.x) {
                        x = start;
                        break;
                    }

                    start += span;
                }

                const c = d.target.frame.cells[row + x];
                const url =
                    !(c.modifier & HIDDEN) &&
                    safeHyperlink(d.target.frame.hyperlinks?.[c.hyperlink]);

                setLinkOffer(url || null);

                if (url && (event.ctrlKey || event.metaKey)) {
                    window.open(url, "_blank", "noopener,noreferrer");
                }
            }
        }

        canvas.current.releasePointerCapture?.(event.pointerId);
    };

    const cancel = () => {
        if (drag.current?.application) {
            report("Pointer capture was interrupted; the application drag may need a fresh click");
        }

        drag.current = null;
    };

    useEffect(() => {
        const element = viewport.current;

        const scroll = (event) => {
            if (!latest.current.interactive || !canvas.current) {
                return;
            }

            const bounds = canvas.current.getBoundingClientRect();
            const x = (event.clientX - bounds.left) / cw,
                y = (event.clientY - bounds.top) / ch;
            const target = targetAt(latest.current.surface, x, y);

            if (!target || event.ctrlKey || event.metaKey) {
                return;
            }

            event.preventDefault();
            const w = wheel.current;

            if (w.id !== target.id) {
                w.id = target.id;
                w.x = 0;
                w.y = 0;
            }

            const add = (axis, delta) => {
                if (Math.sign(delta) !== Math.sign(w[axis])) {
                    w[axis] = 0;
                }

                const total = clamp(w[axis] + delta, -128, 128),
                    steps = Math.trunc(total);

                w[axis] = total - steps;

                return steps;
            };

            const scaleY =
                event.deltaMode === 1 ? 1 : event.deltaMode === 2 ? target.rect.height : 1 / ch;
            const scaleX =
                event.deltaMode === 1 ? 1 : event.deltaMode === 2 ? target.rect.width : 1 / cw;
            const dy = add("y", event.deltaY * scaleY);
            const dx =
                target.mouse_reporting && Math.abs(event.deltaX) > Math.abs(event.deltaY)
                    ? add("x", event.deltaX * scaleX)
                    : 0;
            const events = [];

            if (dy) {
                events.push(
                    mouseEvent(
                        target,
                        x,
                        y,
                        dy < 0 ? "ScrollUp" : "ScrollDown",
                        event,
                        metrics,
                        Math.abs(dy),
                    ),
                );
            }

            if (dx) {
                events.push(
                    mouseEvent(
                        target,
                        x,
                        y,
                        dx < 0 ? "ScrollLeft" : "ScrollRight",
                        event,
                        metrics,
                        Math.abs(dx),
                    ),
                );
            }

            latest.current.send(events, target);
        };

        element.addEventListener("wheel", scroll, { passive: false });

        return () => element.removeEventListener("wheel", scroll);
    }, [cw, ch]);

    const commit = (text) => {
        if (!text) {
            return;
        }

        if (encoder.encode(text).length > MAX_SELECTION_BYTES) {
            report("Text input exceeds the 1 MiB limit");

            return;
        }

        if (ctrl && [...text].length === 1) {
            send([keyEvent({ key: text, ctrlKey: true })]);
            setCtrl(false);
        } else {
            send([{ TextCommit: text }]);
        }
    };

    const keydown = (event) => {
        if (!interactive) {
            return;
        }

        // Pocket's bubbling global shortcuts must never claim terminal-focused keys.
        // Browser defaults still work when neither Herdr nor the terminal can represent a key.
        event.stopPropagation();

        if (
            event.defaultPrevented ||
            composing.current ||
            event.isComposing ||
            event.key === "Dead" ||
            event.key === "Process" ||
            event.keyCode === 229 ||
            event.getModifierState?.("AltGraph")
        ) {
            return;
        }

        const target = activeTarget();

        if (onShortcut && drawable && target.id) {
            try {
                const consumed = onShortcut(event, { targetId: target.id, popup: !!target.popup });

                if (consumed?.then) {
                    event.preventDefault();
                    report(
                        "Terminal shortcut handlers must return synchronously; this key was not sent.",
                    );

                    return;
                }

                if (consumed === true || event.defaultPrevented) {
                    event.preventDefault();

                    return;
                }
            } catch {
                event.preventDefault();
                report("The terminal shortcut failed; this key was not sent or retried.");

                return;
            }
        }

        // Browser paste and copying a local selection remain browser clipboard gestures.
        if (
            (event.ctrlKey || event.metaKey) &&
            (event.key.toLowerCase() === "v" ||
                (event.key.toLowerCase() === "c" && selection?.text))
        ) {
            return;
        }

        // A keyboard-only escape from terminal Tab capture; never a global listener.
        if (event.key === "Escape" && event.shiftKey) {
            event.preventDefault();
            input.current.blur();
            viewport.current.focus();

            return;
        }

        const translated = keyEvent(event, { altKeys, reportAllKeys });

        if (translated) {
            event.preventDefault();

            if (reportAllKeys) {
                if (held.current.size >= 16) {
                    held.current.delete(held.current.keys().next().value);
                }

                held.current.set(event.code || event.key, {
                    target: activeTarget(),
                    event: translated,
                });
            }

            send([translated]);
        }
    };

    const keyup = (event) => {
        if (interactive) {
            event.stopPropagation();
        }

        const heldKey = held.current.get(event.code || event.key);

        if (heldKey) {
            held.current.delete(event.code || event.key);
            event.preventDefault();
            send(
                [{ Key: { ...heldKey.event.Key, kind: "Release", repeat_count: 1 } }],
                heldKey.target,
            );
        }
    };

    const paste = (event) => {
        if (!interactive) {
            return;
        }

        const text = event.clipboardData?.getData("text/plain");

        event.preventDefault();

        const files = Array.from(event.clipboardData?.files || []);

        if (!files.length) {
            for (const item of Array.from(event.clipboardData?.items || [])) {
                if (item.kind === "file") {
                    const file = item.getAsFile();

                    if (file) {
                        files.push(file);
                    }
                }
            }
        }

        if (files.length) {
            input.current.value = "";

            if (files.length !== 1) {
                report("Paste one PNG image at a time.");

                return;
            }

            if (typeof onPasteImage !== "function") {
                report("Clipboard image upload is unavailable in this terminal view.");

                return;
            }

            if (pasteState.current.pending) {
                report("A clipboard image is still being read. Wait before pasting another.");

                return;
            }

            const target = activeTarget(),
                epoch = pasteState.current.epoch;

            if (!drawable || !target.id) {
                report("No terminal input target is available for this clipboard image.");

                return;
            }

            pasteState.current.pending = true;
            clipboardPNG(files[0])
                .then(async (image) => {
                    if (!input.current?.isConnected) {
                        return;
                    }

                    if (!latest.current.interactive || pasteState.current.epoch !== epoch) {
                        latest.current.report(
                            "The terminal target changed while reading the clipboard image; it was not sent.",
                        );

                        return;
                    }

                    if (typeof latest.current.onPasteImage !== "function") {
                        latest.current.report(
                            "Clipboard image upload is unavailable in this terminal view.",
                        );

                        return;
                    }

                    const accepted = await latest.current.onPasteImage(
                        target.id,
                        image,
                        !!target.popup,
                    );

                    if (accepted === false && input.current?.isConnected) {
                        latest.current.report(
                            "The clipboard image was not accepted. It was not retried.",
                        );
                    }
                })
                .catch((error) => {
                    if (input.current?.isConnected) {
                        latest.current.report(
                            error.message || "Clipboard image could not be read or sent.",
                        );
                    }
                })
                .finally(() => {
                    pasteState.current.pending = false;
                });

            return;
        }

        if (text && encoder.encode(text).length <= MAX_SELECTION_BYTES) {
            send([{ Paste: text }]);
        } else if (text) {
            report("Paste exceeds the 1 MiB limit");
        } else if (event.clipboardData?.types?.length) {
            report(
                "The browser did not provide plain text or a readable PNG image for this paste.",
            );
        }

        input.current.value = "";
    };

    const copy = (event) => {
        if (
            selection?.text &&
            event.clipboardData &&
            !event.target.classList?.contains("terminal-grid-selection")
        ) {
            event.preventDefault();
            event.clipboardData.setData("text/plain", selection.text);
        }
    };

    const explicitCopy = async (text) => {
        try {
            if (!navigator.clipboard?.writeText) {
                throw new Error("Copy is unavailable; use the selected-text field");
            }

            await navigator.clipboard.writeText(text);
            setNotice("Copied");
        } catch {
            setNotice(
                "Copy was blocked. Select the text in the selection field and use your browser's Copy command.",
            );
        }
    };

    const cursorFrame = surface?.popup?.frame || frame;
    const cursor = drawable && cursorFrame?.cursor?.visible ? cursorFrame.cursor : null;
    const originX = surface?.popup
        ? Math.floor(Math.max(0, width - cursorFrame.width * cw) / 2)
        : 0;
    const originY = surface?.popup ? Math.max(0, height - cursorFrame.height * ch) / 2 : 0;
    const cursorPane =
        surface?.panes?.find((pane) => pane.focused) ||
        surface?.panes?.find((pane) => cursor && contains(pane.inner_rect, cursor.x, cursor.y));
    const cursorClip =
        cursorFrame &&
        (surface?.popup || !surface?.panes?.length
            ? frameRect(cursorFrame)
            : visiblePaneRect(cursorFrame, cursorPane));
    const underlineCursor = cursor?.shape === 3 || cursor?.shape === 4;
    const cursorBounds =
        cursor &&
        integer(cursor.x, cursorFrame.width - 1) &&
        integer(cursor.y, cursorFrame.height - 1) &&
        intersectRect(
            intersectRect(
                {
                    x: originX + cursor.x * cw,
                    y: originY + cursor.y * ch + (underlineCursor ? ch - 2 : 0),
                    width: cursor.shape === 5 || cursor.shape === 6 ? 2 : cw,
                    height: underlineCursor ? 2 : ch,
                },
                cursorClip && {
                    x: originX + cursorClip.x * cw,
                    y: originY + cursorClip.y * ch,
                    width: cursorClip.width * cw,
                    height: cursorClip.height * ch,
                },
            ),
            { x: 0, y: 0, width, height },
        );
    const cursorValid = !!cursorBounds;
    const cursorStyle = cursorBounds
        ? {
              left: cursorBounds.x,
              top: cursorBounds.y,
              width: cursorBounds.width,
              height: cursorBounds.height,
              backgroundColor: rgb(theme.cursor),
          }
        : {};

    return html`
        <section class=${`terminal-grid ${className}`} aria-label=${label}
            data-enabled=${interactive} data-focused=${focused} onCopy=${copy}>
            <link rel="stylesheet" href="/terminal-grid.css" />
            <div class="terminal-grid-viewport" ref=${viewport} tabIndex="-1"
                style=${{ backgroundColor: rgb(theme.background) }}>
                ${
                    drawable
                        ? html`
                    <div class="terminal-grid-stage" style=${pixels({ width, height })}>
                        <canvas ref=${canvas} style=${pixels({ width, height })} role="img"
                            aria-label=${`${label}. ${frame.width} columns, ${frame.height} rows. Click to type; Shift-drag to select; Control-click or Command-click to open links. Shift-Escape leaves keyboard input.`}
                            onPointerEnter=${enter}
                            onPointerDown=${down} onPointerMove=${move} onPointerUp=${up}
                            onPointerCancel=${cancel} onLostPointerCapture=${cancel}
                            onContextMenu=${(e) => {
                                if (
                                    interactive &&
                                    targetAt(surface, point(e).x, point(e).y)?.mouse_reporting
                                ) {
                                    e.preventDefault();
                                }
                            }} />
                        ${
                            cursorValid &&
                            html`<span class="terminal-grid-cursor" aria-hidden="true"
                            data-shape=${cursor.shape || 0} style=${pixels(cursorStyle)} />`
                        }
                        ${surface.popup && html`<span class="terminal-grid-popup-title">${surface.popup.title}</span>`}
                        <textarea ref=${input} class="terminal-grid-input" aria-label="Terminal input"
                            disabled=${!interactive} readOnly=${!interactive} spellcheck="false"
                            autocapitalize="off" autocomplete="off" autocorrect="off" enterkeyhint="enter"
                            style=${pixels({
                                left: clamp(
                                    originX + (cursor?.x || 0) * cw,
                                    0,
                                    Math.max(0, width - 20),
                                ),
                                top: clamp(
                                    originY + (cursor?.y || 0) * ch,
                                    0,
                                    Math.max(0, height - 24),
                                ),
                            })}
                            onFocus=${() => setFocused(true)} onBlur=${() => {
                                setFocused(false);
                                composing.current = false;
                                held.current.clear();

                                if (input.current) {
                                    input.current.value = "";
                                }
                            }} onKeyDown=${keydown} onKeyUp=${keyup} onPaste=${paste}
                            onCompositionStart=${() => {
                                cancelledComposition.current = false;
                                composing.current = true;
                                compositionTarget.current = {
                                    ...activeTarget(),
                                    boot: surface?.boot_id,
                                    inputEpoch,
                                };
                                lastCommit.current = null;
                            }}
                            onCompositionEnd=${(e) => {
                                if (!composing.current || cancelledComposition.current) {
                                    composing.current = false;
                                    cancelledComposition.current = false;
                                    lastCommit.current = { text: e.data, until: Date.now() + 100 };
                                    e.currentTarget.value = "";

                                    return;
                                }

                                composing.current = false;
                                const target = activeTarget();
                                const original = compositionTarget.current;

                                if (
                                    interactive &&
                                    target.id === original?.id &&
                                    target.popup === original.popup &&
                                    surface?.boot_id === original.boot &&
                                    original.inputEpoch === inputEpoch
                                ) {
                                    commit(e.data);
                                } else if (interactive) {
                                    report(
                                        "The terminal target changed during composition; the text was not sent",
                                    );
                                }

                                lastCommit.current = { text: e.data, until: Date.now() + 100 };
                                e.currentTarget.value = "";
                            }}
                            onBeforeInput=${(e) => {
                                if (!interactive || composing.current || e.isComposing) {
                                    return;
                                }

                                const codes = {
                                    deleteContentBackward: "Backspace",
                                    deleteContentForward: "Delete",
                                    insertLineBreak: "Enter",
                                    insertParagraph: "Enter",
                                };

                                if (codes[e.inputType]) {
                                    e.preventDefault();
                                    send([keyEvent({ key: codes[e.inputType] })]);
                                }
                            }}
                            onInput=${(e) => {
                                if (cancelledComposition.current) {
                                    e.currentTarget.value = "";

                                    return;
                                }

                                if (!interactive || composing.current || e.isComposing) {
                                    return;
                                }

                                const text = e.currentTarget.value || e.data || "";

                                if (!(
                                    lastCommit.current?.text === text &&
                                    Date.now() < lastCommit.current.until
                                )) {
                                    commit(text);
                                }

                                lastCommit.current = null;
                                e.currentTarget.value = "";
                            }} />
                    </div>`
                        : html`<p class="terminal-grid-empty">${surface ? "This frame exceeds browser rendering limits or is invalid." : "Waiting for a terminal frame…"}</p>`
                }
            </div>
            <div class="terminal-grid-tools">
                <span class="terminal-grid-mode">${interactive ? (focused ? "Keyboard active" : "Click terminal to type") : "Read only"}</span>
                ${
                    showKeybar &&
                    html`<div class="terminal-grid-keybar" role="group" aria-label="Terminal keys">
                    ${[
                        ["Escape", "Esc"],
                        ["Control", "Ctrl"],
                        ["Tab", "Tab"],
                        ["ArrowLeft", "Left"],
                        ["ArrowUp", "Up"],
                        ["ArrowDown", "Down"],
                        ["ArrowRight", "Right"],
                    ].map(
                        ([key, text]) => html`
                        <button type="button" disabled=${!interactive || !drawable} aria-label=${key}
                            aria-pressed=${key === "Control" ? ctrl : undefined}
                            onPointerDown=${(e) => e.preventDefault()}
                            onClick=${() => {
                                focusInput();

                                if (key === "Control") {
                                    setCtrl(!ctrl);
                                } else {
                                    send([keyEvent({ key, ctrlKey: ctrl })]);
                                    setCtrl(false);
                                }
                            }}>${text}</button>`,
                    )}
                </div>`
                }
            </div>
            ${
                typeof clipboardOffer === "string" &&
                clipboardOffer.length <= MAX_SELECTION_BYTES &&
                html`<div class="terminal-grid-clipboard-offer">
                    <button type="button" onClick=${() => explicitCopy(clipboardOffer)}>Copy terminal clipboard request</button>
                </div>`
            }
            ${
                (selection?.text || linkOffer) &&
                html`
                <div class="terminal-grid-selection-actions">
                    ${selection?.text && html`<button type="button" onClick=${() => explicitCopy(selection.text)}>Copy selection</button>`}
                    ${linkOffer && html`<a href=${linkOffer} target="_blank" rel="noopener noreferrer">Open link</a>`}
                    <button type="button" onClick=${() => {
                        setSelection(null);
                        setLinkOffer(null);
                    }}>Dismiss</button>
                </div>`
            }
            ${selection?.text && html`<textarea class="terminal-grid-selection" aria-label="Selected terminal text" readOnly value=${selection.text} />`}
            ${notice && html`<p class="terminal-grid-notice" role="status">${notice}</p>`}
        </section>`;
}

function paintSelection(ctx, selection, cw, ch, theme, clip) {
    if (!clip) {
        return;
    }

    ctx.save();
    canvasClip(ctx, clip, cw, ch);
    let { anchor: a, head: b } = selection;
    const r = selection.target.popup
        ? { x: 0, width: selection.target.rect.width }
        : selection.target.rect;

    if (a.y > b.y || (a.y === b.y && a.x > b.x)) {
        [a, b] = [b, a];
    }

    ctx.fillStyle = `${rgb(theme.palette[5])}59`;

    for (let y = a.y; y <= b.y; y++) {
        const start = y === a.y ? a.x : r.x,
            end = y === b.y ? b.x + 1 : r.x + r.width;

        ctx.fillRect(start * cw, y * ch, (end - start) * cw, ch);
    }

    ctx.restore();
}
