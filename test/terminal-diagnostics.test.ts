import assert from "node:assert/strict";
import { test } from "node:test";

const modulePath: string = "../web/terminal-diagnostics.js";
const { terminalDiagnostics } = await import(modulePath);
const secret = "PRIVATE_DIAGNOSTIC_SENTINEL_7a13";

function surface(revision = 1, offset: number | string = 0) {
    return {
        boot_id: "native-boot",
        projection_revision: revision,
        surface_revision: revision,
        frame: {
            width: 80,
            height: 24,
            cells: [{ symbol: "text" }],
            cursor: { x: 1, y: 2, visible: true },
        },
        panes: [
            {
                pane_id: "native-pane",
                inner_rect: { x: 0, y: 0, width: 80, height: 24 },
                pixel_width: 800,
                pixel_height: 480,
                content_revision: revision,
                alternate_screen_active: true,
                mouse_reporting: true,
                focused: true,
                scroll: {
                    offset_from_bottom: offset,
                    max_offset_from_bottom: "9007199254740999",
                    viewport_rows: 24,
                },
            },
        ],
        popup: { terminal_id: "popup-id" },
    };
}

test("diagnostic export preserves useful metadata but never payloads, key values or raw identifiers", () => {
    const trace = terminalDiagnostics();
    const frame = surface(3, "9007199254740997");

    frame.boot_id = secret;
    frame.panes = frame.panes.map((pane) => ({
        ...pane,
        pane_id: secret,
        title: secret,
        cwd: secret,
    }));
    frame.popup.terminal_id = secret;
    Object.defineProperty(frame.frame, "cells", {
        get() {
            throw new Error("Terminal cells must not be read");
        },
    });
    trace.received({ type: "surface", surface: frame, payload: secret });
    trace.received({
        type: "snapshot",
        snapshot: {
            boot_id: secret,
            revision: 3,
            focused_pane_id: secret,
            focused_tab_id: secret,
            focused_workspace_id: secret,
            label: secret,
            cwd: secret,
        },
    });
    trace.received({ type: "message", message: { Clipboard: { data: secret } } });
    trace.received({ type: "response", response: { error: { message: secret, stack: secret } } });
    trace.state({
        phase: "connected",
        inputEpoch: 4,
        bootId: secret,
        surface: frame,
        reason: secret,
    });
    trace.view({ width: 800, height: 480, scrollTop: 0, focus: secret, path: secret });
    trace.sent({
        type: "resize",
        cols: 80,
        rows: 24,
        cellWidth: 10,
        cellHeight: 20,
        token: secret,
    });
    trace.sent({ type: "focus", focused: true, text: secret });
    trace.sent({
        type: "request",
        method: "pane.focus",
        params: { pane_id: secret, text: secret },
    });
    trace.sent({ type: "request", method: secret, params: { text: secret } });
    trace.sent({
        type: "input",
        paneId: secret,
        events: [
            { Key: { code: { Char: secret } } },
            { TextCommit: secret },
            { Paste: secret },
            { Mouse: { kind: "ScrollUp", lines: 2, position: secret } },
            { Mouse: { kind: "__proto__", lines: 128 } },
        ],
    });
    const image = { type: "clipboard-image" };

    Object.defineProperty(image, "data", {
        get() {
            throw new Error("Image payload must not be read");
        },
    });
    trace.sent(image);
    const text = trace.report();
    const report = JSON.parse(text);

    assert.equal(text.includes(secret), false);
    assert.equal(report.diagnosticErrors, 0, "ignored payload fields are not even traversed");
    assert.equal(
        report.latest.surface.panes[0].offset,
        "9007199254740997",
        "64-bit offsets stay exact",
    );
    assert.equal(report.latest.surface.panes[0].alternate, true);
    assert.equal(report.latest.surface.panes[0].pane, "pane-1");
    assert.equal(report.latest.surface.popup, "popup-1");
    assert.equal(report.latest.view.focus, "other");
    assert.equal(report.counts.resize, 1);
    assert.equal(report.counts.focus, 1);
    const input = report.events.find((e: { kind: string }) => e.kind === "input-counts");

    assert.deepEqual(input.data, {
        target: "pane-1",
        keys: 1,
        textCommits: 1,
        pastes: 1,
        mouse: 2,
        scrollUp: 2,
        scrollDown: 0,
        scrollLeft: 0,
        scrollRight: 0,
    });
});

test("reports correlate outgoing resize/focus with incoming scroll offsets in relative arrival order", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 10_000 });
    const trace = terminalDiagnostics();

    trace.sent({ type: "resize", cols: 80, rows: 24, cellWidth: 10, cellHeight: 20 });
    t.mock.timers.tick(25);
    trace.received({ type: "surface", surface: surface(1, 2) });
    t.mock.timers.tick(10);
    trace.sent({ type: "focus", focused: false });
    t.mock.timers.tick(10);
    trace.received({ type: "surface", surface: surface(2, 5) });
    const report = JSON.parse(trace.report());

    assert.deepEqual(
        report.events.map((e: { kind: string; atMs: number }) => [e.kind, e.atMs]),
        [
            ["resize", 0],
            ["surface", 25],
            ["focus", 35],
            ["surface", 45],
        ],
    );
    assert.equal(report.latest.surface.panes[0].offset, 5);
    assert.equal(report.elapsedMs, 45);
});

test("content-only frames coalesce without losing frame counts or latest revisions", () => {
    const trace = terminalDiagnostics();

    for (let revision = 1; revision <= 500; revision++) {
        const frame = surface(revision);

        trace.received({
            type: "snapshot",
            snapshot: {
                boot_id: frame.boot_id,
                revision,
                focused_pane_id: "native-pane",
            },
        });
        trace.received({ type: "surface", surface: frame });
        trace.state({ phase: "connected", inputEpoch: 1, bootId: frame.boot_id, surface: frame });
    }

    const report = JSON.parse(trace.report());

    assert.equal(report.counts.surfaces, 500);
    assert.equal(report.counts.snapshots, 500);
    assert.equal(report.latest.surface.revision, 500);
    assert.equal(report.latest.snapshot.revision, 500);
    assert.ok(report.events.length <= 4, "render traffic cannot drown out useful control events");
});

test("trace, pane sampling and serialized export are bounded during a long unstable session", () => {
    const trace = terminalDiagnostics();

    for (let revision = 1; revision <= 500; revision++) {
        const frame = surface(revision, revision - 1);
        const pane = frame.panes[0];

        assert.ok(pane);
        frame.panes = Array.from({ length: 40 }, (_, index) => ({
            ...pane,
            pane_id: `pane-${index}`,
        }));
        trace.received({ type: "surface", surface: frame });
    }

    const text = trace.report();
    const report = JSON.parse(text);

    assert.ok(Buffer.byteLength(text) <= 32 * 1024);
    assert.ok(report.events.length <= 100);
    assert.ok(report.droppedEvents > 0);
    assert.equal(report.latest.surface.panes.length, 16);
    assert.equal(report.latest.surface.panes[0].offset, 499);
});

test("clearing drops old connection metadata and restarts relative time", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 10_000 });
    const trace = terminalDiagnostics();

    trace.received({ type: "surface", surface: surface() });
    trace.sent({ type: "focus", focused: true });
    t.mock.timers.tick(5000);
    trace.clear();
    const report = JSON.parse(trace.report());

    assert.deepEqual(report.events, []);
    assert.deepEqual(report.counts, {});
    assert.deepEqual(report.latest, {});
    assert.equal(report.elapsedMs, 0);
});

test("bad diagnostic data cannot throw into terminal delivery or export an exception message", () => {
    const trace = terminalDiagnostics();
    const invalid = Object.defineProperty({}, "type", {
        get() {
            throw new Error(secret);
        },
    });

    assert.doesNotThrow(() => trace.sent(invalid));
    trace.sent({ type: "focus", focused: false });
    const text = trace.report();
    const report = JSON.parse(text);

    assert.equal(text.includes(secret), false);
    assert.equal(report.diagnosticErrors, 1);
    assert.equal(report.counts.focus, 1, "recording continues after a malformed sample");
});
