import assert from "node:assert/strict";
import { test } from "node:test";
import { TerminalOutput } from "../src/server/terminal-output.ts";

function surface(offset: number, projection = "9007199254740993", width = 2) {
    return {
        type: "surface",
        surface: {
            boot_id: "synthetic-boot",
            projection_revision: projection,
            surface_revision: String(100 - offset),
            frame: {
                width,
                height: 1,
                cells: Array.from({ length: width }, () => ({ symbol: String(offset) })),
            },
            panes: [{ pane_id: "synthetic-pane", scroll: { offset_from_bottom: offset } }],
            popup: null,
        },
    };
}

function fixture() {
    const writes: unknown[] = [];
    const completions: ((error?: Error) => void)[] = [];
    const closed: string[] = [];
    let buffered = 0;
    let open = true;
    const output = new TerminalOutput({
        maxEventBytes: 1024,
        isOpen: () => open,
        bufferedBytes: () => buffered,
        write: (text, done) => {
            writes.push(JSON.parse(text));
            completions.push(done);
        },
        close: (reason) => closed.push(reason),
    });

    return {
        output,
        writes,
        closed,
        buffered: (bytes: number) => (buffered = bytes),
        disconnected: () => (open = false),
        complete(error?: Error) {
            const done = completions.shift();

            assert.ok(done, "a transport write must exist before its completion");
            done(error);
        },
    };
}

const fence = "synthetic-boot:9007199254740993:2x1";

test("a blocked browser gets the first and newest complete surface, not a stale scroll tail", () => {
    const f = fixture();

    for (let offset = 20; offset >= 0; offset--) {
        f.output.send(surface(offset), fence);
    }

    assert.deepEqual(f.writes, [surface(20)], "the first surface is sent immediately");
    f.complete();
    assert.deepEqual(f.writes, [surface(20), surface(0)]);
    f.complete();
    f.output.send(surface(5), fence);
    assert.deepEqual(f.writes, [surface(20), surface(0), surface(5)]);
    assert.deepEqual(f.closed, []);
});

test("non-surface events are ordered barriers, including image-set replacement and RPC replies", () => {
    const barriers = [
        { type: "images", images: { assets: [{ key: "synthetic-image" }] } },
        { type: "images", images: { assets: [] } },
        { type: "snapshot", snapshot: { boot_id: "synthetic-boot", revision: "9007199254740994" } },
        { type: "message", message: { TerminalBell: null } },
        { type: "response", requestId: "synthetic-request", response: { result: {} } },
        { type: "rejected", requestId: "synthetic-request", reason: "Synthetic rejection" },
    ];

    for (const barrier of barriers) {
        const f = fixture();

        f.output.send(surface(20), fence);
        f.output.send(surface(19), fence);
        f.output.send(surface(18), fence);
        f.output.send(barrier);
        f.output.send(surface(17), fence);
        f.output.send(surface(16), fence);
        assert.deepEqual(f.writes, [surface(20), surface(18), barrier]);
        f.complete();
        f.complete();
        assert.equal(f.writes.length, 3, "a barrier's write is still outstanding");
        f.complete();
        assert.deepEqual(f.writes, [surface(20), surface(18), barrier, surface(16)]);
    }
});

test("different boot, exact projection or geometry fences cannot supersede a held surface", () => {
    const nextFences = [
        "other-boot:9007199254740993:2x1",
        "synthetic-boot:9007199254740994:2x1",
        "synthetic-boot:9007199254740993:3x1",
    ];

    for (const nextFence of nextFences) {
        const f = fixture();

        f.output.send(surface(20), fence);
        f.output.send(surface(19), fence);
        f.output.send(surface(18), nextFence);
        f.output.send(surface(17), nextFence);
        assert.deepEqual(f.writes, [surface(20), surface(19)]);
        f.complete();
        assert.equal(f.writes.length, 2);
        f.complete();
        assert.deepEqual(f.writes, [surface(20), surface(19), surface(17)]);
    }
});

test("disposal, disconnect and write errors never release retained terminal content", () => {
    for (const mode of ["dispose", "disconnect", "error"] as const) {
        const f = fixture();

        f.output.send(surface(20), fence);
        f.output.send(surface(0), fence);

        if (mode === "dispose") {
            f.output.dispose();
        } else if (mode === "disconnect") {
            f.disconnected();
        }

        f.complete(mode === "error" ? new Error("SECRET_SYNTHETIC_TRANSPORT_DETAIL") : undefined);
        f.output.send(surface(5), fence);
        assert.deepEqual(f.writes, [surface(20)]);
        assert.equal(f.closed.length, mode === "error" ? 1 : 0);
        assert.doesNotMatch(f.closed.join(""), /SECRET_SYNTHETIC_TRANSPORT_DETAIL/);
    }
});

test("oversized UTF-8 pending output fails closed rather than bypassing the original byte limit", () => {
    const f = fixture();

    const oversized = surface(0);

    oversized.surface.frame.cells = [{ symbol: "🖥".repeat(260) }, { symbol: " " }];
    f.output.send(surface(20), fence);
    f.output.send(oversized, fence);
    assert.equal(f.closed.length, 1);
    assert.match(f.closed.join(""), /queue limit/);
    f.complete();
    assert.deepEqual(f.writes, [surface(20)]);
});

test("delayed writes recheck the browser byte budget before releasing the pending surface", () => {
    const f = fixture();

    f.output.send(surface(20), fence);
    f.output.send(surface(0), fence);
    f.buffered(2047);
    f.complete();
    assert.equal(f.closed.length, 1);
    assert.match(f.closed.join(""), /queue limit/);
    assert.deepEqual(f.writes, [surface(20)]);
});
