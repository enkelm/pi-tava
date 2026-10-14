import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

const modulePath: string = "../web/terminal-viewport.js";
const { terminalViewport } = await import(modulePath);

type Size = { cols: number; rows: number; cell_width_px: number; cell_height_px: number };

function fixture(t: TestContext) {
    const window = new EventTarget();
    const observers: Resize[] = [];
    const stops: (() => void)[] = [];
    const originals = new Map([
        ["window", Object.getOwnPropertyDescriptor(globalThis, "window")],
        ["ResizeObserver", Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver")],
    ]);

    class Resize {
        callback: () => void;
        constructor(callback: () => void) {
            this.callback = callback;
            observers.push(this);
        }
        observe() {}
        disconnect() {}
    }

    Object.defineProperty(globalThis, "window", { configurable: true, value: window });
    Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: Resize });
    t.after(() => {
        stops.forEach((stop) => stop());

        for (const [name, descriptor] of originals) {
            if (descriptor) {
                Object.defineProperty(globalThis, name, descriptor);
            } else {
                Reflect.deleteProperty(globalThis, name);
            }
        }
    });

    const reporter = terminalViewport();
    const element = { clientWidth: 800, clientHeight: 480 };
    const state = { active: true, epoch: "connection-1" };
    const sizes: Size[] = [];
    const metrics = { cw: 10, ch: 20 };

    const observe = () => {
        const stop = reporter.observe(element, {
            ...metrics,
            maxCells: 1_000_000,
            read: () => state,
            report: (size: Size) => sizes.push(size),
        });

        stops.push(stop);

        return stop;
    };

    return { observe, element, state, sizes, metrics, observers, window };
}

test("metadata/surface availability cycles never resend an unchanged viewport without user input", (t) => {
    const f = fixture(t);
    let stop = f.observe();

    for (let update = 0; update < 20; update++) {
        // A metadata revision temporarily fences input until its matching surface arrives.
        f.state.active = false;
        stop();
        stop = f.observe();
        f.state.active = true;
        stop();
        stop = f.observe();
    }

    assert.deepEqual(
        f.sizes,
        [{ cols: 80, rows: 24, cell_width_px: 10, cell_height_px: 20 }],
        "resuming painting/input is not a physical terminal resize",
    );
});

test("real geometry and cell metrics changes report once; repeated observer/window notifications do not", (t) => {
    const f = fixture(t);
    const stop = f.observe();
    const observer = f.observers[0];

    assert.ok(observer);
    f.element.clientWidth = 900;
    observer.callback();
    f.window.dispatchEvent(new Event("resize"));
    observer.callback();
    stop();
    f.metrics.cw = 20;
    f.observe();
    // A callback already queued by the disconnected old observer must not revert the metrics.
    observer.callback();
    assert.deepEqual(f.sizes, [
        { cols: 80, rows: 24, cell_width_px: 10, cell_height_px: 20 },
        { cols: 90, rows: 24, cell_width_px: 10, cell_height_px: 20 },
        { cols: 45, rows: 24, cell_width_px: 20, cell_height_px: 20 },
    ]);
});

test("a fresh connection reports the same geometry once instead of inheriting old delivery state", (t) => {
    const f = fixture(t);
    const stop = f.observe();

    stop();
    f.state.epoch = "connection-2";
    f.observe();
    const observer = f.observers.at(-1);

    assert.ok(observer);
    observer.callback();
    assert.deepEqual(f.sizes, [
        { cols: 80, rows: 24, cell_width_px: 10, cell_height_px: 20 },
        { cols: 80, rows: 24, cell_width_px: 10, cell_height_px: 20 },
    ]);
});

test("inactive or zero-sized views never resize shared panes; active geometry remains bounded", (t) => {
    const f = fixture(t);

    f.state.active = false;
    f.observe();
    const observer = f.observers[0];

    assert.ok(observer);
    observer.callback();
    assert.deepEqual(f.sizes, []);
    f.state.active = true;
    f.element.clientWidth = 0;
    f.window.dispatchEvent(new Event("resize"));
    assert.deepEqual(f.sizes, []);
    f.element.clientWidth = 1_000_000;
    f.element.clientHeight = 1_000_000;
    f.window.dispatchEvent(new Event("resize"));
    assert.deepEqual(f.sizes, [{ cols: 4096, rows: 244, cell_width_px: 10, cell_height_px: 20 }]);
});
