import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

const modulePath: string = "../web/dock.js";
const { fitDock } = await import(modulePath);

// Controlled DOM measurements, not a second allocator. Boxes obey only their supplied dimensions,
// hidden ancestors and max-height; fitDock itself decides the budgets, folding and capping.
class Box {
    classList: { contains: (name: string) => boolean };
    children: Box[] = [];
    parentElement: Box | null = null;
    style = { maxHeight: "", overflowY: "" };
    dataset: Record<string, string> = {};
    css = {
        marginTop: "0",
        marginBottom: "0",
        paddingTop: "0",
        paddingBottom: "0",
        rowGap: "0",
        fontSize: "16px",
        maxHeight: "none",
    };
    hidden = false;
    isConnected = true;
    scrollTop = 0;
    scrollHeight = 0;
    clientHeight = 0;
    reads = 0;
    top = 0;
    size: number | (() => number);

    constructor(classes: string, size: number | (() => number)) {
        const names = new Set(classes.split(" "));

        this.classList = { contains: (name) => names.has(name) };
        this.size = size;
    }

    append(...children: Box[]) {
        for (const child of children) {
            child.parentElement = this;
            this.children.push(child);
        }
    }

    closest(selector: string): Box | null {
        let current: Box | null = this;

        while (current) {
            if (current.classList.contains(selector.slice(1))) {
                return current;
            }

            current = current.parentElement;
        }

        return null;
    }

    querySelectorAll(selector: string): Box[] {
        const direct = selector.startsWith(":scope > ");
        const name = selector.replace(/^:scope > /, "").slice(1);
        const candidates = direct
            ? this.children
            : this.children.flatMap((child) => [child, ...child.descendants()]);

        return candidates.filter((child) => child.classList.contains(name));
    }

    descendants(): Box[] {
        return this.children.flatMap((child) => [child, ...child.descendants()]);
    }

    querySelector(selector: string): Box | null {
        return this.querySelectorAll(selector)[0] ?? null;
    }

    getBoundingClientRect() {
        this.reads++;
        let ancestor: Box | null = this;

        while (ancestor && !ancestor.hidden) {
            ancestor = ancestor.parentElement;
        }

        const natural = ancestor ? 0 : typeof this.size === "function" ? this.size() : this.size;
        const limit = parseFloat(this.style.maxHeight || this.css.maxHeight);
        const height = Number.isFinite(limit) ? Math.min(natural, limit) : natural;

        return { top: this.top, bottom: this.top + height, height };
    }
}

const height = (box: Box) => box.getBoundingClientRect().height;
const outer = (box: Box) => height(box) + Number(box.css.marginTop) + Number(box.css.marginBottom);

function fixture(
    t: TestContext,
    { wrapped = true, hidden = false, room = 400, list = false, rowHeight = 40, rowCount = 8 } = {},
) {
    const inbox = new Box("inbox", rowCount * rowHeight + Math.max(0, rowCount - 1) * 4);
    const rows = Array.from({ length: rowCount }, (_, index) => {
        const row = new Box(index === 0 ? "queued editing" : "queued", rowHeight);

        row.top = index * (rowHeight + 4);

        return row;
    });

    inbox.append(...rows);
    inbox.hidden = hidden;
    inbox.css.maxHeight = "96px";
    inbox.css.rowGap = "4";
    inbox.css.marginBottom = "6";
    const toggle = new Box("queue-toggle", 40);

    toggle.css.marginTop = hidden ? "0" : "4";
    const owner = new Box("queue", () => (inbox.hidden ? 0 : outer(inbox)) + outer(toggle));

    owner.css.marginBottom = "5";
    owner.append(inbox, toggle);
    const count = new Box("inbox-count", 20);
    const fixed = new Box("plan-bar", 40);
    const agents = new Box("agents-list", 120);

    agents.scrollHeight = 120;
    agents.append(new Box("agent-row", 30));
    const bar = new Box("agents-bar", () => 30 + height(agents));

    bar.append(agents);
    const dock: Box = new Box("dock", () =>
        dock.children.reduce((sum, child) => sum + outer(child), 0),
    );

    if (wrapped) {
        dock.append(owner);
    } else {
        dock.append(inbox, count);
    }

    dock.append(fixed);

    if (list) {
        dock.append(bar);
    }

    const wrap = new Box("composer-wrap", () => height(dock) + 100);

    wrap.append(dock);
    const pane = new Box("pane", room + 100);

    pane.clientHeight = room + 100;
    pane.append(new Box("scroller", 100), wrap);
    const document = { documentElement: new Box("root", 0), activeElement: rows[0] };
    const globals = {
        document,
        innerHeight: 1000,
        getComputedStyle: (box: Box) => box.css,
    };
    const originals = new Map(
        Object.keys(globals).map((name) => [
            name,
            Object.getOwnPropertyDescriptor(globalThis, name),
        ]),
    );

    for (const [name, value] of Object.entries(globals)) {
        Object.defineProperty(globalThis, name, { configurable: true, value });
    }

    t.after(() => {
        for (const [name, descriptor] of originals) {
            if (descriptor) {
                Object.defineProperty(globalThis, name, descriptor);
            } else {
                Reflect.deleteProperty(globalThis, name);
            }
        }
    });

    return { dock, inbox, owner, count, toggle, agents, rows, document };
}

test("wrapped queue receives its budget without counting inbox margins twice", (t) => {
    const f = fixture(t);

    fitDock(f.dock);
    // 400 * .45 - fixed bar 40 - wrapper chrome (40 + 4 + 5) - inbox margin 6.
    assert.equal(f.inbox.style.maxHeight, "85px");
    assert.equal(f.inbox.style.overflowY, "auto");
    assert.equal(f.inbox.hidden, false);
    assert.equal(f.dock.dataset.queue, undefined);
    fitDock(f.dock);
    assert.equal(f.inbox.style.maxHeight, "85px", "a second fit must not change the budget");
});

test("wrapped queue that fits shows all rows without clipping their tap targets", (t) => {
    const f = fixture(t, { rowCount: 3, room: 600 });

    fitDock(f.dock);
    assert.equal(f.inbox.style.maxHeight, "none");
    assert.equal(f.inbox.style.overflowY, "visible");
    assert.equal(f.inbox.hidden, false);
    assert.equal(f.dock.dataset.queue, undefined);
});

test("collapsed Coop queue stays hidden and only its toggle consumes fixed space", (t) => {
    const f = fixture(t, { hidden: true, list: true });

    f.inbox.style.maxHeight = "77px";
    fitDock(f.dock);
    assert.equal(f.inbox.hidden, true);
    assert.equal(f.inbox.style.maxHeight, "77px");
    assert.equal(
        f.rows.reduce((sum, row) => sum + row.reads, 0),
        0,
    );
    assert.equal(f.agents.style.maxHeight, "65px");
    assert.equal(f.dock.dataset.queue, undefined);
});

for (const scenario of [
    { name: "a wrapped inbox with zero-height rows", options: { rowHeight: 0 } },
    { name: "an empty wrapped inbox", options: { rowCount: 0 } },
]) {
    test(`${scenario.name} is not treated as a visible queue`, (t) => {
        const f = fixture(t, scenario.options);

        fitDock(f.dock);
        assert.equal(f.inbox.style.maxHeight, "");
        assert.equal(f.inbox.style.overflowY, "");
        assert.equal(f.dock.dataset.queue, undefined);
    });
}

test("open editing queue and list keep whole rows when the dock must grow and cap", (t) => {
    const f = fixture(t, { list: true, room: 200 });
    const editing = f.document.activeElement;

    fitDock(f.dock);
    assert.equal(f.inbox.style.maxHeight, "40px");
    assert.equal(f.inbox.hidden, false);
    assert.equal(f.dock.dataset.queue, undefined, "Coop owns folding while editing or focused");
    assert.equal(f.document.activeElement, editing);
    assert.equal(f.agents.style.maxHeight, "31px");
    assert.equal(f.dock.dataset.capped, "on");
    assert.equal(f.dock.style.maxHeight, "150px");
});

test("bar compaction accounts for the wrapped queue's nonfoldable row beside the list", (t) => {
    const f = fixture(t, { list: true, room: 250 });

    fitDock(f.dock);
    assert.equal(f.dock.dataset.compact, "on");
    assert.equal(f.inbox.style.maxHeight, "40px");
    assert.equal(f.agents.style.maxHeight, "31px");
});

test("native flat queue retains allocation and its independent overflow count", (t) => {
    const f = fixture(t, { wrapped: false });

    fitDock(f.dock);
    assert.equal(f.inbox.style.maxHeight, "110px");
    assert.equal(f.inbox.style.overflowY, "auto");
    assert.equal(f.dock.dataset.count, "on");
    assert.equal(f.dock.dataset.queue, undefined);
});

test("native flat queue still folds for the subagent list in a short dock", (t) => {
    const f = fixture(t, { wrapped: false, list: true, room: 200 });

    fitDock(f.dock);
    assert.equal(f.inbox.style.maxHeight, "0px");
    assert.equal(f.dock.dataset.queue, "folded");
    assert.equal(f.dock.dataset.count, "on");
    assert.equal(f.agents.style.maxHeight, "31px");
});
