import assert from "node:assert/strict";
import { test } from "node:test";

const modulePath: string = "../web/terminal-touch.js";
const { terminalTouch } = await import(modulePath);
const pointer = (clientX = 200, clientY = 200, pointerId = 1) => ({
    clientX,
    clientY,
    pointerId,
});

function fixture() {
    const events: unknown[] = [];
    let revision = 1;
    const touch = terminalTouch({
        context: () => revision,
        onTap: ({ target }: { target: string }) => events.push(["tap", target]),
        onScroll: ({ target, dx, dy }: { target: string; dx: number; dy: number }) =>
            events.push(["scroll", target, dx, dy]),
        onSelectionStart: ({ event }: { event: ReturnType<typeof pointer> }) =>
            events.push(["select-start", event.clientX, event.clientY]),
        onSelectionMove: ({ event }: { event: ReturnType<typeof pointer> }) =>
            events.push(["select-move", event.clientX, event.clientY]),
        onSelectionEnd: ({ event }: { event: ReturnType<typeof pointer> }) =>
            events.push(["select-end", event.clientX, event.clientY]),
        onCancel: (mode: string) => events.push(["cancel", mode]),
    });

    return { touch, events, changeTarget: () => revision++ };
}

test("a swipe scrolls with the finger, reverses immediately, and never selects or clicks", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { touch, events } = fixture();

    touch.start(pointer(), "left-pane");
    touch.move(pointer(200, 205));
    assert.deepEqual(events, [], "small initial jitter does not commit an intent");
    touch.move(pointer(200, 240));
    touch.move(pointer(200, 220));
    touch.end(pointer(200, 220));
    t.mock.timers.tick(1000);
    assert.deepEqual(events, [
        ["scroll", "left-pane", 0, -40],
        ["scroll", "left-pane", 0, 20],
    ]);
});

test("a short tap is delayed until release; a release-only swipe is still scrolling", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { touch, events } = fixture();

    touch.start(pointer(), "pane");
    t.mock.timers.tick(100);
    assert.deepEqual(events, [], "no mouse down or selection is sent while intent is undecided");
    touch.end(pointer(204, 203));
    touch.start(pointer(), "pane");
    touch.end(pointer(200, 140));
    t.mock.timers.tick(1000);
    assert.deepEqual(events, [
        ["tap", "pane"],
        ["scroll", "pane", 0, 60],
    ]);
});

test("a stationary hold starts selection; dragging and release extend it without scrolling", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { touch, events } = fixture();

    touch.start(pointer(), "pane");
    touch.move(pointer(203, 204));
    t.mock.timers.tick(600);
    assert.deepEqual(events, [["select-start", 200, 200]]);
    touch.move(pointer(250, 230));
    touch.end(pointer(270, 240));
    t.mock.timers.tick(1000);
    assert.deepEqual(events, [
        ["select-start", 200, 200],
        ["select-move", 250, 230],
        ["select-move", 270, 240],
        ["select-end", 270, 240],
    ]);
});

for (const phase of ["pending", "select"] as const) {
    test(`${phase}: context changes fence the hold timer and further pointer input`, (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const { touch, events, changeTarget } = fixture();

        touch.start(pointer(), "old-pane");

        if (phase === "select") {
            t.mock.timers.tick(600);
            events.length = 0;
        }

        changeTarget();
        t.mock.timers.tick(1000);
        touch.move(pointer(200, 250));
        touch.end(pointer(200, 250));
        assert.deepEqual(events, [["cancel", phase]]);
        touch.start(pointer(), "new-pane");
        touch.end(pointer());
        assert.deepEqual(events.at(-1), ["tap", "new-pane"], "old input is not replayed");
    });
}

test("reset and pointer cancellation discard a hold before it can select", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { touch, events } = fixture();

    touch.start(pointer(), "pane");
    touch.cancel(1);
    touch.end(pointer(200, 260));
    touch.start(pointer(), "pane");
    touch.cancel();
    t.mock.timers.tick(1000);
    touch.end(pointer());
    assert.deepEqual(events, [
        ["cancel", "pending"],
        ["cancel", "pending"],
    ]);
});

test("rejected pane admission never starts a timer, scroll, tap or selection", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const events: string[] = [];
    const touch = terminalTouch({
        context: () => 1,
        onStart: () => false,
        onTap: () => events.push("tap"),
        onScroll: () => events.push("scroll"),
        onSelectionStart: () => events.push("select"),
    });

    assert.equal(touch.start(pointer(), "rejected-pane"), false);
    t.mock.timers.tick(1000);
    touch.move(pointer(200, 270));
    touch.end(pointer(200, 270));
    assert.deepEqual(events, []);
});

test("multiple fingers cancel terminal intent until all contacts lift, leaving pinch to the browser", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { touch, events } = fixture();

    touch.start(pointer(), "pane");
    touch.start(pointer(300, 300, 2), "pane");
    t.mock.timers.tick(1000);
    touch.end(pointer(300, 300, 2));
    touch.move(pointer(200, 280));
    touch.start(pointer(300, 300, 3), "pane");
    touch.end(pointer(200, 280));
    touch.end(pointer(300, 300, 3));
    assert.deepEqual(events, [["cancel", "pending"]]);
    touch.start(pointer(), "pane");
    touch.end(pointer());
    assert.deepEqual(events.at(-1), ["tap", "pane"]);
});
