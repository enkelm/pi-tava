// Offline public-component regression: actual TerminalGrid, Preact h, and htm produce VNodes.
// Inert hooks expose the render body and its public pointer handlers; this does not test
// Preact lifecycle, DOM reconciliation, font measurement, painting or browser rasterization.
// Renderer readiness is an external precondition here; the authenticated bridge owns receipts.
// Existing pure protocol tests do not execute this boundary; browser tests require a listener.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { build } from "esbuild";
import { isValidElement, type VNode } from "preact";

const painterKey = Symbol.for("terminal-grid-render-test-painter");
const ready = () => Reflect.set(globalThis, painterKey, { active: true, error: false });

ready();

const bundle = await build({
    entryPoints: [fileURLToPath(new URL("../web/terminal-grid.js", import.meta.url))],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    plugins: [
        {
            name: "initial-render-hooks",
            setup(build) {
                build.onResolve({ filter: /^\.\/terminal-renderer\.js$/ }, () => ({
                    path: "renderer-precondition",
                    namespace: "test-renderer",
                }));
                build.onLoad({ filter: /.*/, namespace: "test-renderer" }, () => ({
                    contents: `export const useTerminalRenderer = () => {
                        const state = globalThis[Symbol.for("terminal-grid-render-test-painter")];
                        return {
                            ...state,
                            inputReady: state.inputReady ?? state.active,
                            editorReady: state.editorReady ?? state.inputReady ?? state.active,
                            visible: state.visible ?? state.active,
                            loading: state.loading ?? (!state.active && !state.error),
                            iframe: {current: null}, source: "", retry() {},
                        };
                    };`,
                }));
                build.onResolve({ filter: /^preact\/hooks$/ }, () => ({
                    path: "initial-render-hooks",
                    namespace: "test-hooks",
                }));
                build.onLoad({ filter: /.*/, namespace: "test-hooks" }, () => ({
                    contents: `
                        export const useRef = current => ({ current });
                        export const useState = initial => [
                            typeof initial === "function" ? initial() : initial,
                            () => {},
                        ];
                        export const useEffect = () => {};
                        export const useLayoutEffect = () => {};
                    `,
                }));
            },
        },
    ],
});
const output = bundle.outputFiles[0];

assert.ok(output);

const { TerminalGrid } = await import(
    `data:text/javascript;base64,${Buffer.from(output.text).toString("base64")}`
);

function descendants(node: unknown): VNode[] {
    if (Array.isArray(node)) {
        return node.flatMap(descendants);
    }

    if (!isValidElement(node)) {
        return [];
    }

    return [node, ...descendants(node.props.children)];
}

function frame(width: number, height: number, cursor: { x: number; y: number; shape: number }) {
    return {
        width,
        height,
        cells: Array.from({ length: width * height }, () => ({
            symbol: " ",
            fg: 0,
            bg: 0,
            modifier: 0,
            skip: false,
        })),
        cursor: { ...cursor, visible: true },
    };
}

for (const popup of [false, true]) {
    test(`initial ${popup ? "popup" : "no-pane"} render preserves interaction and cursor geometry`, () => {
        const surface = {
            boot_id: "generated-render-fixture",
            frame: frame(8, 6, { x: 7, y: 5, shape: 3 }),
            panes: popup
                ? [
                      {
                          pane_id: "underlay",
                          focused: true,
                          rect: { x: 0, y: 0, width: 2, height: 2 },
                          inner_rect: { x: 0, y: 0, width: 2, height: 2 },
                      },
                  ]
                : [],
            popup: popup
                ? {
                      terminal_id: "generated-popup",
                      title: "Synthetic popup",
                      frame: frame(4, 2, { x: 3, y: 1, shape: 5 }),
                  }
                : null,
        };
        const nodes = descendants(
            TerminalGrid({
                surface,
                enabled: true,
                showKeybar: false,
                cellWidth: 10,
                cellHeight: 20,
            }),
        );
        const interaction = nodes.find(
            (node) => "class" in node.props && node.props.class === "terminal-grid-interaction",
        );
        const cursor = nodes.find(
            (node) =>
                node.type === "span" &&
                "class" in node.props &&
                node.props.class === "terminal-grid-cursor",
        );

        assert.ok(interaction, "valid generated frames produce a interaction");
        assert.ok("style" in interaction.props);
        assert.deepEqual(interaction.props.style, { width: "80px", height: "120px" });
        assert.ok(cursor, "visible in-bounds cursor is not lost to underlay clipping");
        assert.ok("style" in cursor.props);
        assert.partialDeepStrictEqual(
            cursor.props.style,
            popup
                ? { left: "50px", top: "60px", width: "2px", height: "20px" }
                : { left: "70px", top: "118px", width: "10px", height: "2px" },
        );
    });
}

// Sampling must not change how many complete terminal lines a physical swipe crosses.
test("touch scroll distance is independent of pointer sample size", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });

    const cases = [20, 20.2].flatMap((ch) =>
        [1, -1].flatMap((direction) =>
            [false, true].flatMap((mouse) =>
                [200, 20, 10, 5, 4, 2, 1].map((step) => ({ ch, direction, mouse, step })),
            ),
        ),
    );

    for (const { ch, direction, mouse, step } of cases) {
        const delivered: { Mouse: { kind: string; lines: number } }[] = [];
        const rect = { x: 0, y: 0, width: 8, height: 40 };
        const nodes = descendants(
            TerminalGrid({
                surface: {
                    boot_id: "synthetic-touch-scroll",
                    frame: frame(8, 40, { x: 0, y: 0, shape: 0 }),
                    panes: [
                        {
                            pane_id: "pane",
                            focused: true,
                            mouse_reporting: mouse,
                            rect,
                            inner_rect: rect,
                        },
                    ],
                },
                enabled: true,
                showKeybar: false,
                cellWidth: 10,
                cellHeight: ch,
                onInput: (_id: string, events: typeof delivered) => delivered.push(...events),
            }),
        );
        const interaction = nodes.find(
            (node) => "class" in node.props && node.props.class === "terminal-grid-interaction",
        );
        const viewport = nodes.find(
            (node) => "class" in node.props && node.props.class === "terminal-grid-viewport",
        );

        assert.ok(interaction && viewport);
        assert.ok(
            interaction.ref && typeof interaction.ref === "object" && "current" in interaction.ref,
        );
        assert.ok(viewport.ref && typeof viewport.ref === "object" && "current" in viewport.ref);
        interaction.ref.current = {
            isConnected: true,
            getBoundingClientRect: () => ({ left: 0, top: 0 }),
            setPointerCapture() {},
            releasePointerCapture() {},
        };
        viewport.ref.current = { clientWidth: 80, clientHeight: 40 * ch };
        const pointer = (y: number) => ({
            pointerId: 1,
            pointerType: "touch",
            button: 0,
            clientX: 40,
            clientY: y,
            preventDefault() {},
        });

        assert.ok(
            "onPointerDown" in interaction.props &&
                typeof interaction.props.onPointerDown === "function",
        );
        assert.ok(
            "onPointerMove" in interaction.props &&
                typeof interaction.props.onPointerMove === "function",
        );
        assert.ok(
            "onPointerUp" in interaction.props &&
                typeof interaction.props.onPointerUp === "function",
        );
        interaction.props.onPointerDown(pointer(400));

        const distance = 10 * ch;

        for (let travelled = step; travelled <= 200; travelled += step) {
            interaction.props.onPointerMove(
                pointer(400 - (travelled / 200) * distance * direction),
            );
        }

        for (let travelled = step; travelled <= 200; travelled += step) {
            interaction.props.onPointerMove(
                pointer(400 - (1 - travelled / 200) * distance * direction),
            );
        }

        interaction.props.onPointerUp(pointer(400));
        assert.ok(
            delivered.every((event) => ["ScrollDown", "ScrollUp"].includes(event.Mouse.kind)),
        );

        for (const kind of ["ScrollDown", "ScrollUp"]) {
            assert.equal(
                delivered
                    .filter((event) => event.Mouse.kind === kind)
                    .reduce((total, event) => total + event.Mouse.lines, 0),
                10,
                `${kind}: ${distance}px at ${ch}px per line, ${(step / 200) * distance}px samples, direction ${direction}, mouse ${mouse}`,
            );
        }
    }
});

test("loading and failed rendering disable the existing input surface instead of accepting blind input", (t) => {
    t.after(ready);

    for (const phase of ["loading", "error"]) {
        Reflect.set(globalThis, painterKey, { active: false, error: phase === "error" });

        const delivered: unknown[] = [];
        const rect = { x: 0, y: 0, width: 8, height: 6 };
        const nodes = descendants(
            TerminalGrid({
                surface: {
                    boot_id: "synthetic-unavailable-renderer",
                    frame: frame(8, 6, { x: 0, y: 0, shape: 0 }),
                    panes: [{ pane_id: "pane", focused: true, rect, inner_rect: rect }],
                },
                enabled: true,
                showKeybar: false,
                cellWidth: 10,
                cellHeight: 20,
                onInput: (...args: unknown[]) => delivered.push(args),
            }),
        );
        const input = nodes.find((node) => node.type === "textarea");
        const interaction = nodes.find(
            (node) => "class" in node.props && node.props.class === "terminal-grid-interaction",
        );
        const status = nodes.find(
            (node) => "class" in node.props && node.props.class === "terminal-grid-renderer-status",
        );
        const retry = nodes.find(
            (node) => "class" in node.props && node.props.class === "terminal-grid-renderer-retry",
        );

        assert.ok(input && interaction && status);
        assert.ok(
            interaction.ref && typeof interaction.ref === "object" && "current" in interaction.ref,
        );
        interaction.ref.current = {
            isConnected: true,
            getBoundingClientRect: () => ({ left: 0, top: 0 }),
        };
        assert.ok("disabled" in input.props && input.props.disabled);
        assert.equal(
            Boolean(retry),
            phase === "error",
            "retry is an explicit error recovery action",
        );
        assert.ok("onInput" in input.props && typeof input.props.onInput === "function");
        input.props.onInput({ currentTarget: { value: "must-not-be-sent" } });
        assert.ok(
            "onPointerDown" in interaction.props &&
                typeof interaction.props.onPointerDown === "function",
        );
        interaction.props.onPointerDown({
            pointerId: 1,
            pointerType: "touch",
            button: 0,
            clientX: 40,
            clientY: 50,
            preventDefault() {},
        });
        assert.deepEqual(delivered, []);
    }
});

test("warm editor continuity never buffers or sends input before current paint admission", (t) => {
    t.after(ready);
    Reflect.set(globalThis, painterKey, {
        active: false,
        visible: true,
        editorReady: true,
        inputReady: false,
        loading: false,
        error: false,
    });

    for (const admission of [
        { enabled: true, inputPending: false },
        { enabled: false, inputPending: true },
    ]) {
        const delivered: unknown[] = [];
        const rect = { x: 0, y: 0, width: 8, height: 6 };
        const nodes = descendants(
            TerminalGrid({
                ...admission,
                surface: {
                    boot_id: "synthetic-warm-editor",
                    frame: frame(8, 6, { x: 0, y: 0, shape: 0 }),
                    panes: [{ pane_id: "pane", focused: true, rect, inner_rect: rect }],
                },
                showKeybar: false,
                cellWidth: 10,
                cellHeight: 20,
                onInput: (...args: unknown[]) => delivered.push(args),
            }),
        );
        const input = nodes.find((node) => node.type === "textarea");
        const status = nodes.find(
            (node) => "class" in node.props && node.props.class === "terminal-grid-renderer-status",
        );

        assert.ok(input);
        assert.ok("disabled" in input.props && !input.props.disabled, "retain the native editor");
        assert.equal(status, undefined, "an acknowledged warm scene is not a cold load");
        assert.ok("onKeyDown" in input.props && typeof input.props.onKeyDown === "function");
        let prevented = 0;

        input.props.onKeyDown({
            key: "q",
            preventDefault: () => prevented++,
            stopPropagation() {},
        });
        assert.equal(prevented, 1);
        assert.ok("onInput" in input.props && typeof input.props.onInput === "function");
        const textarea = { value: "must-not-buffer-unacknowledged-text" };

        input.props.onInput({ currentTarget: textarea });
        assert.equal(
            textarea.value,
            "",
            "DOM text must not leak into a later admitted input event",
        );
        assert.ok("onPaste" in input.props && typeof input.props.onPaste === "function");
        input.props.onPaste({ preventDefault: () => prevented++ });
        assert.equal(prevented, 2, "native paste cannot buffer text either");
        assert.deepEqual(delivered, []);
    }
});

test("an acknowledged editor retains composition during a geometry-only painter refresh", (t) => {
    t.after(ready);
    Reflect.set(globalThis, painterKey, { active: false, inputReady: true, error: false });

    const delivered: unknown[] = [];
    const rect = { x: 0, y: 0, width: 8, height: 6 };
    const nodes = descendants(
        TerminalGrid({
            surface: {
                boot_id: "synthetic-geometry-refresh",
                frame: frame(8, 6, { x: 0, y: 0, shape: 0 }),
                panes: [{ pane_id: "pane", focused: true, rect, inner_rect: rect }],
            },
            enabled: true,
            showKeybar: false,
            cellWidth: 10,
            cellHeight: 20,
            onInput: (...args: unknown[]) => delivered.push(args),
        }),
    );
    const input = nodes.find((node) => node.type === "textarea");

    assert.ok(input);
    assert.ok(
        "disabled" in input.props && !input.props.disabled,
        "a geometry-only paint fence must not disable and tear down the active editor",
    );
    assert.ok(
        "onCompositionStart" in input.props && typeof input.props.onCompositionStart === "function",
    );
    assert.ok(
        "onCompositionEnd" in input.props && typeof input.props.onCompositionEnd === "function",
    );
    input.props.onCompositionStart();
    input.props.onCompositionEnd({
        data: "composed text",
        currentTarget: { value: "composed text" },
    });
    assert.deepEqual(delivered, [["pane", [{ TextCommit: "composed text" }], false]]);
});
