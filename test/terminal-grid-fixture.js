import { h, render } from "preact";
import { TerminalGrid, symbolWidth } from "/terminal-grid.js";

const cell = (symbol = " ", extra = {}) => ({
    symbol,
    fg: 0,
    bg: 0,
    modifier: 0,
    skip: false,
    hyperlink: null,
    ...extra,
});
const frame = (width, height) => ({
    width,
    height,
    cells: Array.from({ length: width * height }, () => cell()),
    cursor: { x: 2, y: 9, visible: true, shape: 2 },
    hyperlinks: ["https://example.com/docs", "javascript:alert(1)"],
    graphics: [],
});
const rect = (x, y, width, height) => ({ x, y, width, height });
const pane = (id, x, width, focused) => ({
    pane_id: id,
    content_revision: 1,
    rect: rect(x, 0, width, 14),
    inner_rect: rect(x, 0, width, 14),
    scrollbar_rect: null,
    scroll: null,
    focused,
    mouse_reporting: false,
    sgr_pixel_mouse: false,
    alternate_screen_active: false,
    pixel_width: width * 10,
    pixel_height: 280,
});
const surface = {
    boot_id: "synthetic-boot",
    projection_revision: 1,
    surface_revision: 1,
    frame: frame(64, 14),
    panes: [pane("pane-left", 0, 31, true), pane("pane-right", 33, 31, false)],
    splits: [
        {
            direction: "Vertical",
            pos: 32,
            area: rect(0, 0, 64, 14),
            hit_rect: rect(31, 0, 2, 14),
            path: [],
        },
    ],
    popup: null,
    graphics: { assets: [], placements: [], retained_assets: [] },
};

function text(x, y, value, style = {}) {
    for (const symbol of value) {
        surface.frame.cells[y * 64 + x] = cell(symbol, style);
        x += symbolWidth(symbol);
    }
}

text(0, 0, "Herdr structured grid", { modifier: 1 });
text(33, 0, "Second pane", { fg: 0x0200ffff });
text(0, 2, "colors  bold  italic");
text(0, 3, "underline", { modifier: 8 });
text(11, 3, "strike", { modifier: 256 });
text(0, 4, "reversed", { modifier: 64 });
text(12, 4, "dim", { modifier: 2 });
text(0, 5, "漢字 é 👩", { fg: 0x02ffcc66 });
text(0, 6, "SAFE", { hyperlink: 0, modifier: 8 });
text(6, 6, "UNSAFE", { hyperlink: 1, modifier: 8 });
text(0, 8, "hidden", { modifier: 128 });
text(0, 9, "$ ");

for (let y = 0; y < 14; y++) {
    text(31, y, "│");
}

for (let i = 0; i < 16; i++) {
    surface.frame.cells[11 * 64 + i] = cell(" ", { bg: i + 1 });
}

surface.frame.cells[12 * 64] = cell(" ", { bg: 0x02123456 });
surface.frame.cells[12 * 64 + 1] = cell(" ", { bg: 0x010000c4 });
window.fixture = {
    props: { surface, images: [], enabled: true, cellWidth: 10, cellHeight: 20 },
    inputs: [],
    order: [],
    focusRef: { current: null },
    sizes: [],
    actions: [],
    opened: [],
    copied: [],
    pastedImages: [],
};
window.open = (...args) => window.fixture.opened.push(args);
Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
        writeText: async (value) => window.fixture.copied.push(value),
        readText: async () => {
            throw new Error("Automatic clipboard reads forbidden");
        },
    },
});

window.fixture.draw = (patch = {}) => {
    Object.assign(window.fixture.props, patch);
    render(
        h(TerminalGrid, {
            ...window.fixture.props,
            focusRef: window.fixture.focusRef,
            onInput: (id, events, popup) => {
                window.fixture.order.push({ type: "input", id, events, popup });
                window.fixture.inputs.push({ id, events, popup });
            },
            onPasteImage:
                window.fixture.props.onPasteImage === null
                    ? undefined
                    : (id, image, popup) => window.fixture.pastedImages.push({ id, image, popup }),
            onResize: (size) => window.fixture.sizes.push(size),
            onAction: (action) => {
                window.fixture.order.push({ type: "action", action });
                window.fixture.actions.push(action);

                return window.fixture.focusReply;
            },
        }),
        document.querySelector("#fixture"),
    );
};

window.fixture.point = (type, x, y, extra = {}) => {
    const canvas = document.querySelector("canvas"),
        bounds = canvas.getBoundingClientRect();

    // Synthetic PointerEvents are not registered with the browser's pointer capture system.
    canvas.setPointerCapture = () => {};

    canvas.releasePointerCapture = () => {};

    canvas.dispatchEvent(
        new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerId: 1,
            clientX: bounds.left + x * 10 + 1,
            clientY: bounds.top + y * 20 + 1,
            ...extra,
        }),
    );
};

window.fixture.draw();
document.querySelector("#outside").focus();
