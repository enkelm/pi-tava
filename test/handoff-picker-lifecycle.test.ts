// Actual eligibility service, sheet and controls with batched hooks and a memory-only element tree.
// Owns picker recovery, drafts, focus and control output; not Preact reconciliation or iPad energy.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

const { createHandoffState } = await import(
    new URL("../src/server/work-items/browser/state.js", import.meta.url).href
);
const { createHandoffSheet } = await import(
    new URL("../src/server/work-items/browser/sheet.js", import.meta.url).href
);
const { createControls } = await import(
    new URL("../src/server/work-items/browser/controls.js", import.meta.url).href
);
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

type Component = (props: Record<string, any>) => Tree;
type Element = { type: string | Component; props: Record<string, any>; children: Tree[] };
type Tree = Element | Tree[] | string | number | boolean | null | undefined;
type Hook = { value?: any; deps?: unknown[]; cleanup?: () => void };
type Fiber = { hooks: Hook[]; cursor: number };
type Effect = { hook: Hook; run: () => (() => void) | void };
type Ref = { current: any };

const h = (type: Element["type"], props: Element["props"] = {}, ...children: Tree[]): Element => ({
    type,
    props,
    children,
});

// Only the ordinary tagged-template element/attribute subset used by this sheet is needed.
// Values retain callbacks/refs; the parser implements no eligibility or UI policy.
function html(parts: TemplateStringsArray, ...values: any[]): Tree {
    const marker = (index: number) => `\u0001${index}\u0002`;
    const source = parts
        .map((part, index) => part + (index < values.length ? marker(index) : ""))
        .join("");

    const valueOf = (value: string) => {
        const match = /^\u0001(\d+)\u0002$/.exec(value);

        return match ? values[Number(match[1])] : value;
    };

    const root: Element = h("fragment");
    const stack = [root];

    for (const token of source.match(/<[^>]*>|[^<]+/g) ?? []) {
        if (token.startsWith("</")) {
            stack.pop();
        } else if (token.startsWith("<")) {
            const match = /^<([^\s/>]+)([\s\S]*?)\/?\s*>$/.exec(token);

            assert.ok(match, `unsupported element token: ${token}`);
            const props: Element["props"] = {};

            for (const attr of match[2]!.matchAll(/([^\s=]+)(?:=("[^"]*"|'[^']*'|[^\s]+))?/g)) {
                const raw = attr[2];

                props[attr[1]!] =
                    raw === undefined ? true : valueOf(raw.replace(/^["']|["']$/g, ""));
            }

            const element = h(valueOf(match[1]!), props);

            stack.at(-1)!.children.push(element);

            if (!token.endsWith("/>") && !["input", "br"].includes(String(element.type))) {
                stack.push(element);
            }
        } else {
            for (const part of token.split(/(\u0001\d+\u0002)/)) {
                if (part) {
                    stack.at(-1)!.children.push(valueOf(part));
                }
            }
        }
    }

    return root;
}

function elements(tree: Tree): Element[] {
    if (Array.isArray(tree)) {
        return tree.flatMap(elements);
    }

    return tree && typeof tree === "object" ? [tree, ...tree.children.flatMap(elements)] : [];
}

function textOf(tree: Tree): string {
    if (Array.isArray(tree)) {
        return tree.map(textOf).join("");
    }

    if (tree && typeof tree === "object") {
        return tree.children.map(textOf).join("");
    }

    return typeof tree === "string" || typeof tree === "number" ? String(tree) : "";
}

test("composer context retains status without thread navigation across handoff histories", () => {
    // A three-stage history exercises the distinct source and origin links as well as the
    // retired writer's active-thread link. The browser owner covers sidebar navigation.
    for (const scenario of ["active", "retired", "new-work"]) {
        const readOnly = scenario === "retired";
        const workflow = { managed: true, readOnly, status: "active" };
        const session = {
            me: { id: "alice", role: "owner" },
            id: 3,
            canSteer: true,
            conversation: { kind: "session", threadType: "worker" },
            sessions: [
                { id: 1, threadType: "worker" },
                { id: 2, threadType: "reviewer" },
                { id: 3, threadType: "worker", workflow },
                { id: 4, threadType: "land" },
            ],
            profiles: [{ id: "worker", name: "Worker" }],
        };
        const opened: unknown[] = [];
        const { WorkflowTools, HandoffButton } = createControls(
            {
                html,
                Icon: () => null,
                AgentProfileTag: () => null,
                session: () => session,
                openSheet: (...args: unknown[]) => opened.push(args),
                requestId: () => "opening-1",
            },
            {
                useContext: () => ({
                    session,
                    status: {
                        data: {
                            workflow,
                            workItem: { originThreadId: 1, activeThreadId: readOnly ? 4 : 3 },
                            handoffs: [
                                {
                                    targetThreadId: 3,
                                    sourceThreadId: 2,
                                    relationship:
                                        scenario === "new-work" ? "new-work" : "same-work",
                                },
                            ],
                        },
                    },
                }),
                isCurrent: () => true,
            },
        );
        const context = elements(WorkflowTools());
        const indicator = context.find((node) => node.props.role === "img");

        assert.ok(indicator, `${scenario}: workspace status must remain visible`);
        assert.equal(
            indicator.props["aria-label"],
            readOnly ? "Read-only workspace" : "Workflow status",
        );
        assert.equal(
            context.filter((node) => node.type === "button" || node.type === "a").length,
            0,
            `${scenario}: handoff history must not add composer navigation`,
        );
        const header = elements(HandoffButton()).find((node) => node.type === "button");

        if (readOnly) {
            assert.equal(header, undefined, "retired writers cannot start a handoff");
        } else {
            assert.ok(header, "active writers keep the header picker");
            assert.equal(header.props["aria-label"], "Choose next thread");
            header.props.onClick();
            assert.deepEqual(opened, [["handoff", { id: 3, opening: "opening-1" }]]);
        }
    }
});

const eligibility = (reason = "Fresh eligibility") => ({
    workflow: { readOnly: false, profileAvailable: true },
    options: [{ targetType: "reviewer", relationship: "same-work", enabled: true, reason }],
});

type Data = ReturnType<typeof eligibility>;
type Request = {
    signal: AbortSignal;
    resolve: (data: Data) => void;
    reject: (failure: Error) => void;
};

function fixture(
    t: TestContext,
    submit?: (id: number, body: { text: string; requestId: string; mode: string }) => Promise<void>,
) {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
    const window = new EventTarget();
    const navigator = { onLine: true };
    const storage = new Map<string, string>();
    const sessionStorage = {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
    };
    const descriptors = Object.entries({ document, window, navigator, sessionStorage }).map(
        ([key, value]) => {
            const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);

            Object.defineProperty(globalThis, key, { configurable: true, value });

            return [key, descriptor] as const;
        },
    );
    let session = {
        me: { id: "alice", role: "owner" },
        id: 1,
        canSteer: true,
        busy: false,
        conversation: { kind: "session" },
        sessions: [{ id: 1, workflow: { readOnly: false, paused: false } }],
        profiles: [{ id: "reviewer", name: "Reviewer" }],
    };
    const observers = new Set<(value: typeof session) => void>();
    const requests: Request[] = [];
    const fibers = new Map<string, Fiber>();
    const effects = new Map<Hook, Effect>();
    const layouts = new Map<Hook, Effect>();
    const focuses: string[] = [];
    const refElements = new Map<Ref, { label: string; focus: () => void }>();
    const seenRefs = new Set<Ref>();
    let current: Fiber;
    let dirty = true;
    let tree: Tree = null;
    let sequence = 0;

    const hook = () => {
        const index = current.cursor++;

        return (current.hooks[index] ??= {});
    };

    const effect = (queue: Map<Hook, Effect>, run: Effect["run"], deps: unknown[]) => {
        const item = hook();

        if (!item.deps || deps.some((value, index) => !Object.is(value, item.deps![index]))) {
            item.deps = deps;
            queue.set(item, { hook: item, run });
        }
    };

    const pocket = {
        h,
        html,
        Loader: ({ label }: { label: string }) => h("test-loader", { label }),
        AgentProfileTag: () => h("test-profile"),
        session: () => session,
        onSessionChange(listener: (value: typeof session) => void) {
            observers.add(listener);

            return () => observers.delete(listener);
        },
        sessionApi(id: number, path: string, _body: undefined, options: { signal: AbortSignal }) {
            assert.equal(id, 1);
            assert.equal(path, "handoffs");

            // Deliberately ignore abort: HTTP completion can race suspension or resumed success.
            return new Promise<Data>((resolve, reject) => {
                requests.push({ signal: options.signal, resolve, reject });
            });
        },
        requestId: () => `request-${++sequence}`,
        useState(initial: any) {
            const item = hook();

            if (!("value" in item)) {
                item.value = typeof initial === "function" ? initial() : initial;
            }

            return [
                item.value,
                (change: any) => {
                    const value = typeof change === "function" ? change(item.value) : change;

                    if (!Object.is(value, item.value)) {
                        item.value = value;
                        dirty = true;
                    }
                },
            ];
        },
        useRef(initial: any) {
            const item = hook();

            return (item.value ??= { current: initial });
        },
        useEffect: (run: Effect["run"], deps: unknown[]) => effect(effects, run, deps),
        useLayoutEffect: (run: Effect["run"], deps: unknown[]) => effect(layouts, run, deps),
        submit: submit ?? (() => assert.fail("recovery must not submit a handoff")),
    };
    const state = createHandoffState(pocket);
    const Sheet = createHandoffSheet(pocket, state);
    const props = { id: 1, opening: "opening-1", close: () => {}, isOpen: () => true };

    const runEffects = (queue: Map<Hook, Effect>) => {
        const pending = [...queue.values()];

        queue.clear();

        for (const item of pending) {
            item.hook.cleanup?.();
            item.hook.cleanup = item.run() || undefined;
        }
    };

    const resolveTree = (node: Tree, path: string): Tree => {
        if (Array.isArray(node)) {
            return node.map((child, index) => resolveTree(child, `${path}.${index}`));
        }

        if (!node || typeof node !== "object") {
            return node;
        }

        if (typeof node.type === "function") {
            const key = `${path}:${node.props.key ?? ""}`;
            const fiber = fibers.get(key) ?? { hooks: [], cursor: 0 };

            fibers.set(key, fiber);
            current = fiber;
            current.cursor = 0;

            return resolveTree(node.type(node.props), `${key}.child`);
        }

        const element = {
            ...node,
            children: node.children.map((child, index) => resolveTree(child, `${path}.${index}`)),
        };
        const ref = node.props.ref;

        if (ref) {
            const target = refElements.get(ref) ?? {
                label: "",
                focus() {
                    focuses.push(this.label);
                },
            };

            target.label = textOf(element).trim() || element.props.id;
            seenRefs.add(ref);
            refElements.set(ref, target);
            ref.current = target;
        }

        return element;
    };

    const render = () => {
        for (let count = 0; dirty; count++) {
            assert.ok(count < 20, "render loop did not settle");
            dirty = false;
            seenRefs.clear();
            tree = resolveTree(h(Sheet, props), "sheet");

            for (const ref of refElements.keys()) {
                if (!seenRefs.has(ref)) {
                    ref.current = null;
                }
            }

            runEffects(layouts);
        }
    };

    const commit = () => {
        for (let count = 0; dirty || effects.size; count++) {
            assert.ok(count < 20, "effect loop did not settle");
            render();
            runEffects(effects);
        }
    };

    const settle = async () => {
        for (let count = 0; count < 3; count++) {
            commit();
            await flush();
        }

        commit();
    };

    const find = (type: string, label?: string) =>
        elements(tree).filter(
            (node) => node.type === type && (label === undefined || textOf(node).trim() === label),
        );

    const unmount = () => {
        for (const fiber of fibers.values()) {
            fiber.hooks.forEach((item) => item.cleanup?.());
        }

        fibers.clear();
        effects.clear();
        layouts.clear();
    };

    t.after(() => {
        unmount();
        state.dispose();

        for (const [key, descriptor] of descriptors) {
            if (descriptor) {
                Object.defineProperty(globalThis, key, descriptor);
            } else {
                Reflect.deleteProperty(globalThis, key);
            }
        }
    });

    return {
        requests,
        focuses,
        storage,
        render,
        effects: () => runEffects(effects),
        commit,
        settle,
        find,
        text: () => textOf(tree),
        reopen() {
            unmount();
            props.opening = "opening-2";
            dirty = true;
        },
        hide() {
            document.visibilityState = "hidden";
            document.dispatchEvent(new Event("visibilitychange"));
        },
        show() {
            document.visibilityState = "visible";
            document.dispatchEvent(new Event("visibilitychange"));
        },
        changeRole(role: string) {
            session = { ...session, me: { ...session.me, role } };
            observers.forEach((listener) => listener(session));
        },
        changePaused(paused: boolean) {
            session = { ...session, sessions: [{ id: 1, workflow: { readOnly: false, paused } }] };
            observers.forEach((listener) => listener(session));
        },
        changeBusy(busy: boolean) {
            session = { ...session, busy };
            observers.forEach((listener) => listener(session));
        },
        async tick() {
            t.mock.timers.tick(10_000);
            await flush();
        },
        async respond(index: number, data = eligibility()) {
            assert.ok(requests[index], `missing API request ${index}`);
            requests[index]!.resolve(data);
            await settle();
        },
        choose() {
            const radio = find("input")[0];

            assert.ok(radio, "eligible destination must be rendered");
            radio.props.onChange();
            commit();
        },
    };
}

type Fixture = ReturnType<typeof fixture>;

function assertReady(f: Fixture) {
    assert.equal(f.find("test-loader").length, 0, "fresh eligibility must finish picker loading");
    assert.equal(f.find("form").length, 1, "resumed eligibility must restore the picker form");
    assert.equal(f.find("button", "Retry").length, 0, "suspension must not become a retry error");
    assert.ok(f.text().includes("Fresh eligibility"), "the form must show the resumed response");
}

test("batched hide/show uses a fast resumed result without another request", async (t) => {
    const f = fixture(t);

    await f.settle();
    assert.equal(f.requests.length, 1);
    assert.equal(f.find("test-loader").length, 1);
    f.hide();
    f.show();
    await flush();
    assert.equal(f.requests[0]!.signal.aborted, true);
    assert.equal(f.requests.length, 2);
    f.requests[1]!.resolve(eligibility());
    f.requests[0]!.resolve(eligibility("Obsolete eligibility"));
    await flush();
    // Hide and return have not rendered yet; the resumed API has already settled.
    f.render();
    f.effects();
    await f.settle();
    assertReady(f);
    assert.equal(f.requests.length, 2, "return must consume the fresh cache, not refresh it again");
    assert.equal(f.find("button", "Next")[0]!.props.disabled, true, "Next requires a choice");
    f.choose();
    assert.equal(f.find("button", "Next")[0]!.props.disabled, false);
});

test("ordinary resume fences the original reply after fresh picker success", async (t) => {
    const f = fixture(t);

    await f.settle();
    f.hide();
    await f.settle();
    assert.equal(f.find("test-loader").length, 1, "a paused initial read remains loading");
    f.show();
    await f.settle();
    assert.equal(f.requests.length, 2, "the picker must join the service's resumed request");
    await f.respond(1);
    assertReady(f);
    f.requests[0]!.resolve(eligibility("Obsolete eligibility"));
    await f.settle();
    assertReady(f);
    assert.equal(f.requests.length, 2);
    assert.ok(!f.text().includes("Obsolete eligibility"));
});

test("a same-person role change recovers the initial picker read without reopening", async (t) => {
    const f = fixture(t);

    await f.settle();
    assert.equal(f.requests.length, 1);
    f.changeRole("guest");
    await f.settle();
    assert.equal(f.requests[0]!.signal.aborted, true);
    assert.equal(f.requests.length, 2, "the new permission scope gets its own eligibility read");
    await f.respond(1);
    assertReady(f);
    assert.equal(f.requests.length, 2, "the same picker joins the new scope's pending read");
    assert.equal(f.find("button", "Next")[0]!.props.disabled, true);
    f.choose();
    assert.equal(f.find("button", "Next")[0]!.props.disabled, false);
    f.requests[0]!.resolve(eligibility("Obsolete owner eligibility"));
    await f.settle();
    assertReady(f);
    assert.ok(!f.text().includes("Obsolete owner eligibility"));
});

test("resume preserves an edited direction draft and its submission identity", async (t) => {
    const f = fixture(t);

    await f.settle();
    await f.respond(0);
    f.choose();
    await f.find("form")[0]!.props.onSubmit({ preventDefault() {} });
    await f.settle();
    const field = f.find("textarea")[0];

    assert.ok(field, "Next must open the instruction editor");
    field.props.onInput({
        currentTarget: { value: "Check hidden work, keep notification policy." },
    });
    await f.settle();
    const saved = f.storage.get("pocket.handoffDraft.alice.1");

    assert.ok(saved, "editing must save the actual picker draft");
    f.hide();
    await f.settle();
    assert.equal(f.find("test-loader").length, 1, "the picker waits while paused");
    assert.equal(f.find("form").length, 0, "stale options must not remain actionable while paused");
    f.show();
    await f.settle();
    assert.equal(f.requests.length, 2);
    await f.respond(1);
    assert.equal(f.find("test-loader").length, 0);
    assert.equal(f.find("form").length, 1);
    assert.equal(
        f.find("textarea")[0]!.props.value,
        "Check hidden work, keep notification policy.",
    );
    assert.equal(f.find("button", "Start thread")[0]!.props.disabled, false);
    assert.equal(
        f.storage.get("pocket.handoffDraft.alice.1"),
        saved,
        "resume cannot replace draft/request identity",
    );
    assert.equal(f.requests.length, 2, "resume shares the service's fresh read");
});

// A live execution pause can arrive before the outstanding eligibility response. The actual sheet
// must not submit its cached enabled choice, and must preserve the selected draft for explicit resume.
test("a live execution pause fences a cached enabled choice without losing the draft", async (t) => {
    const f = fixture(t);

    await f.settle();
    await f.respond(0);
    f.choose();
    const saved = [...f.storage];

    assert.equal(f.find("button", "Next")[0]!.props.disabled, false);
    f.changePaused(true);
    await f.settle();
    // The server read can have completed just before the pause; live metadata must still fence it.
    await f.respond(1, eligibility());
    assert.equal(f.find("button", "Next")[0]!.props.disabled, true);
    assert.match(f.text(), /execution is paused/i);
    await f.find("form")[0]!.props.onSubmit({ preventDefault() {} });
    f.commit();
    assert.equal(
        f.find("button", "Next").length,
        1,
        "the cached choice cannot advance to submission",
    );
    assert.deepEqual([...f.storage], saved);
});

test("routine polling does not refocus Next or block the selected choice", async (t) => {
    const f = fixture(t);

    await f.settle();
    await f.respond(0);
    assertReady(f);
    f.choose();
    const focused = f.focuses.filter((label) => label === "Next").length;

    assert.equal(focused, 1, "the initial loaded picker focuses Next once");
    await f.tick();
    await f.settle();
    assert.equal(f.requests.length, 2, "exercise an interval refresh while the sheet stays open");
    assert.equal(f.find("test-loader").length, 0, "polling must not restart picker loading");
    assert.equal(f.find("button", "Next")[0]!.props.disabled, false);
    const changed = eligibility("Wait for current work to finish");

    changed.options[0]!.enabled = false;
    await f.respond(1, changed);
    assert.equal(f.find("test-loader").length, 0);
    assert.ok(f.text().includes("Wait for current work to finish"));
    assert.equal(f.find("button", "Next")[0]!.props.disabled, true);
    assert.equal(f.find("input")[0]!.props.checked, true, "polls preserve the saved selection");
    assert.equal(f.focuses.filter((label) => label === "Next").length, focused);
});

test("relevant changes during initial loading wait for current options without another opening", async (t) => {
    const f = fixture(t);

    await f.settle();
    f.changeBusy(true);
    f.changeBusy(false);
    await f.settle();
    f.requests[0]!.resolve(eligibility("Obsolete before completion"));
    await f.settle();
    assert.equal(f.requests.length, 2, "pending invalidations need one fresh serialized read");
    assert.equal(f.find("test-loader").length, 1);
    assert.equal(f.find("form").length, 0, "old options must never become actionable");
    assert.ok(!f.text().includes("Obsolete before completion"));
    await f.respond(1);
    assertReady(f);
    assert.equal(f.requests.length, 2, "the picker joins the full freshness chain");
});

test("explicit Refresh rechecks a saved choice and Retry recovers after cancellation", async (t) => {
    const f = fixture(t);

    await f.settle();
    await f.respond(0);
    f.choose();
    const saved = f.storage.get("pocket.handoffDraft.alice.1");

    f.find("button", "Refresh options")[0]!.props.onClick();
    await f.settle();
    assert.equal(f.requests.length, 2, "explicit Refresh cannot consume the settled cache");
    assert.equal(f.find("test-loader").length, 1);
    assert.equal(f.storage.get("pocket.handoffDraft.alice.1"), saved);
    f.requests[1]!.reject(new Error("Refresh unavailable"));
    await f.settle();
    assert.ok(f.text().includes("Refresh unavailable"));
    assert.equal(f.find("form").length, 0, "failed Refresh cannot offer the old enabled choice");
    assert.equal(f.find("button", "Next").length, 0);
    assert.equal(f.storage.get("pocket.handoffDraft.alice.1"), saved);
    f.find("button", "Retry")[0]!.props.onClick();
    await f.settle();
    assert.equal(f.requests.length, 3);
    f.hide();
    f.show();
    await f.settle();
    assert.equal(f.requests[2]!.signal.aborted, true);
    assert.equal(f.requests.length, 4);
    await f.respond(3);
    assertReady(f);
    assert.equal(f.find("input")[0]!.props.checked, true);
    assert.equal(f.find("button", "Next")[0]!.props.disabled, false);
    assert.equal(f.storage.get("pocket.handoffDraft.alice.1"), saved);
    f.requests[2]!.resolve(eligibility("Obsolete retry"));
    await f.settle();
    assertReady(f);
});

for (const verification of ["routine poll", "reopen"] as const) {
    test(`a failed ${verification} blocks cached options until fresh recovery`, async (t) => {
        const f = fixture(t);

        await f.settle();
        await f.respond(0);
        f.choose();
        const saved = f.storage.get("pocket.handoffDraft.alice.1");

        if (verification === "routine poll") {
            await f.tick();
        } else {
            f.reopen();
        }

        await f.settle();
        assert.equal(f.requests.length, 2);
        f.requests[1]!.reject(new Error(`${verification} verification failed`));
        await f.settle();
        assert.equal(
            f.find("form").length,
            0,
            "cached enabled choices cannot survive verification failure",
        );
        assert.equal(f.find("button", "Next").length, 0);
        assert.equal(f.find("button", "Start thread").length, 0);
        assert.ok(f.text().includes(`${verification} verification failed`));
        assert.equal(f.find("button", "Retry").length, 1);
        assert.equal(f.storage.get("pocket.handoffDraft.alice.1"), saved);

        if (verification === "routine poll") {
            // A later automatic retry must not resurrect the failed verification's cache.
            await f.tick();
        } else {
            f.find("button", "Retry")[0]!.props.onClick();
        }

        await f.settle();
        assert.equal(f.requests.length, 3);
        assert.equal(f.find("form").length, 0, "pending retry cannot reenable stale choices");
        await f.respond(2);
        assertReady(f);
        assert.equal(f.find("input")[0]!.props.checked, true);
        assert.equal(f.find("button", "Next")[0]!.props.disabled, false);
        assert.equal(f.storage.get("pocket.handoffDraft.alice.1"), saved);
        assert.ok(
            !f.text().includes("verification failed"),
            "fresh recovery clears the read error",
        );
    });
}

// The sheet owns explicit human selection, persisted retries and command construction. This
// proof does not duplicate server/Git isolation: it checks the actual submitted human payload.
test("own-worktree selection survives reopening and submits only for owner-selected new work", async (t) => {
    const submitted: { text: string; requestId: string }[] = [];
    const f = fixture(t, async (_id, body) => {
        submitted.push(body);
    });
    const data = {
        ...eligibility(),
        options: [
            {
                targetType: "worker",
                relationship: "new-work",
                enabled: true,
                reason: "Separate work",
            },
            {
                targetType: "researcher",
                relationship: "same-work",
                enabled: true,
                reason: "Current work",
            },
        ],
    };

    await f.settle();
    await f.respond(0, data);
    f.find("input")
        .find((node) => node.props.value === "worker:new-work")!
        .props.onChange();
    await f.settle();
    await f.find("form")[0]!.props.onSubmit({ preventDefault() {} });
    await f.settle();
    const checkbox = f.find("input").find((node) => node.props.type === "checkbox");

    assert.ok(checkbox);
    assert.equal(checkbox.props.checked, false, "inheritance is the default");
    checkbox.props.onChange({ currentTarget: { checked: true } });
    await f.settle();
    const saved = f.storage.get("pocket.handoffDraft.alice.1");

    assert.ok(saved);
    assert.ok(f.text().includes("source thread still becomes read-only"));
    f.reopen();
    await f.settle();
    await f.respond(1, data);
    await f.find("form")[0]!.props.onSubmit({ preventDefault() {} });
    await f.settle();
    assert.equal(
        f.find("input").find((node) => node.props.type === "checkbox")?.props.checked,
        true,
    );
    await f.find("form")[0]!.props.onSubmit({ preventDefault() {} });
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0]!.text, "/handoff worker --new --worktree");
    assert.equal(submitted[0]!.requestId, JSON.parse(saved).revision);
});

test("switching to same-work or losing owner status cannot submit a remembered isolation choice", async (t) => {
    for (const mode of ["same-work", "collaborator"]) {
        await t.test(mode, async (t) => {
            const submitted: string[] = [];
            const f = fixture(t, async (_id, body) => {
                submitted.push(body.text);
            });
            const data = {
                ...eligibility(),
                options: [
                    {
                        targetType: "worker",
                        relationship: "new-work",
                        enabled: true,
                        reason: "Separate work",
                    },
                    {
                        targetType: "researcher",
                        relationship: "same-work",
                        enabled: true,
                        reason: "Current work",
                    },
                ],
            };

            await f.settle();
            await f.respond(0, data);
            f.find("input")
                .find((node) => node.props.value === "worker:new-work")!
                .props.onChange();
            await f.settle();
            await f.find("form")[0]!.props.onSubmit({ preventDefault() {} });
            await f.settle();
            f.find("input")
                .find((node) => node.props.type === "checkbox")!
                .props.onChange({ currentTarget: { checked: true } });
            await f.settle();

            if (mode === "same-work") {
                f.find("button", "Back")[0]!.props.onClick();
                await f.settle();
                f.find("input")
                    .find((node) => node.props.value === "researcher:same-work")!
                    .props.onChange();
                await f.settle();
                await f.find("form")[0]!.props.onSubmit({ preventDefault() {} });
            } else {
                f.changeRole("guest");
                await f.settle();
                await f.respond(1, data);
            }

            await f.settle();
            assert.equal(
                f.find("input").some((node) => node.props.type === "checkbox"),
                mode === "collaborator",
            );
            assert.equal(
                f.find("button", "Start thread")[0]!.props.disabled,
                mode === "collaborator",
            );
            await f.find("form")[0]!.props.onSubmit({ preventDefault() {} });
            assert.deepEqual(submitted, mode === "same-work" ? ["/handoff researcher --same"] : []);
        });
    }
});
