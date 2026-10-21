// Protocol owner: committed room views cross the real app boundary into the production delta consumer.
// The scripted provider is free; browser stand-ins supply only transport/storage, never delta or lifecycle logic.
// Regressions covered here are block replacement/base drift, whole-message compatibility and retry ownership.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { LiveDoc } from "@earendil-works/pi-durable";
import {
    cleanUp,
    context,
    fakeTab,
    newSession,
    openApp,
    owner,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import type { ClientBlock, ClientLive, ClientLiveUpdate } from "../src/server/projection.ts";

type FixtureBlock =
    | Exclude<ClientBlock, { type: "toolCall" }>
    | { type: "toolCall"; id: string; name: string; args: Record<string, string> };
type Message = { blocks: ClientBlock[] };
type View = { full: boolean; live: ClientLiveUpdate };
const { api, provider, model, usage, stopReason, timestamp } = fauxAssistantMessage("");
const messageFields = {
    role: "assistant" as const,
    api,
    provider,
    model,
    usage,
    stopReason,
    timestamp,
};
const { liveMessage } = (await import(new URL("../web/live.js", import.meta.url).href)) as {
    liveMessage: (current: Message | undefined, update: unknown) => Message | undefined | null;
};

test("committed room deltas rebuild replacements, retries and full refreshes exactly as old tabs see them", async (t) => {
    const app = await openApp(scriptedModel());

    t.after(async () => {
        await app.close();
        cleanUp();
    });
    const id = await newSession(app);
    const tab = fakeTab(id, owner(app));
    const modern = { ...tab.client, protocol: 3 };
    const old = fakeTab(id, owner(app));
    const room = await app.room(id);

    await app.attach(modern);
    await app.attach(old.client);
    t.after(() => {
        app.detach(modern);
        app.detach(old.client);
    });
    let shown: Message | undefined;
    let cursor = 0;

    const check = () => {
        const updates = tab.events.slice(cursor).filter((event) => event.event === "view");

        cursor = tab.events.length;

        for (const update of updates) {
            const data = update.data as unknown as View;
            const next = liveMessage(data.full ? undefined : shown, data.live.generation?.message);

            assert.notEqual(next, null, "every delivered delta fits its preceding message");
            shown = next!;
        }

        const whole = (old.last("view")!.live as ClientLive).generation?.message;

        assert.deepEqual(shown, whole);
        assert.equal("keep" in (whole ?? {}), false, "protocol 2 always receives a whole message");
    };

    const write = async (blocks?: FixtureBlock[], attempt = 0) => {
        await app.harness.commit(async (tx) => {
            const live = await tx.doc(LiveDoc, id);

            if (blocks === undefined) {
                delete live.generation;
            } else {
                live.generation = {
                    attempt,
                    message: {
                        ...messageFields,
                        content: blocks.map((block) =>
                            block.type === "text"
                                ? { type: "text", text: block.text }
                                : block.type === "thinking"
                                  ? {
                                        type: "thinking",
                                        thinking: block.text,
                                        redacted: block.redacted ?? false,
                                    }
                                  : {
                                        type: "toolCall",
                                        id: block.id,
                                        name: block.name,
                                        arguments: block.args,
                                    },
                        ),
                    },
                };
            }
        }, context);
    };

    const push = () => {
        room.push(modern, false);
        room.push(old.client, false);
        check();
    };

    const call: FixtureBlock = {
        type: "toolCall",
        id: "read-1",
        name: "read",
        args: { path: "a" },
    };
    const thought: FixtureBlock = { type: "thinking", text: "Consider 🦉", redacted: false };
    const cases: (FixtureBlock[] | undefined)[] = [
        [thought],
        [{ ...thought, text: "Consider 🦉 carefully" }],
        [{ ...thought, text: "Consider 🦉 carefully", redacted: true }],
        [thought, { type: "text", text: "Answer" }, call],
        [thought, { type: "text", text: "Answer changed" }, { ...call, args: { path: "b" } }],
        [thought, { type: "text", text: "Replacement" }],
        [thought],
        [],
        undefined,
        [{ type: "text", text: "A different attempt" }],
    ];

    for (const [attempt, blocks] of cases.entries()) {
        await write(blocks, attempt);
        push();
    }

    // A failed projection or send must not make a connection's next delta omit characters it never received.
    for (const failure of ["projection", "send"]) {
        await write([{ type: "text", text: `A different attempt after ${failure}` }]);
        const mock =
            failure === "projection"
                ? t.mock.method(app.approvals, "forConversation", () => {
                      throw new Error("projection failed");
                  })
                : t.mock.method(modern, "send", () => {
                      throw new Error("send failed");
                  });

        assert.throws(() => room.push(modern, false), /failed/);
        mock.mock.restore();
        push();
    }

    room.push(modern, true);
    room.push(old.client, true);
    check();
    assert.equal(
        "keep" in ((tab.last("view")!.live as ClientLive).generation!.message ?? {}),
        false,
        "full refresh discards the connection's delta base",
    );
    app.detach(modern);
    await app.attach(modern);
    check();
    assert.equal(tab.last("view")!.full, true, "reconnect sends a new full view");

    // Growing text should add roughly its own bytes, not repeat its accumulated prefix on every room update.
    tab.events.length = 0;
    old.events.length = 0;
    cursor = 0;

    for (let length = 1; length <= 20; length++) {
        await write([{ type: "text", text: "x".repeat(length * 1000) }]);
        push();
    }

    const wireBytes = (events: typeof tab.events) =>
        JSON.stringify(
            events.filter((event) => event.event === "view").map((event) => event.data.live),
        ).length;

    const deltaBytes = wireBytes(tab.events);
    const wholeBytes = wireBytes(old.events);

    t.diagnostic(
        `Growing-message fixture: ${deltaBytes} delta bytes versus ${wholeBytes} whole-message bytes`,
    );
    assert.ok(deltaBytes * 5 < wholeBytes);
    await write();
    push();
    await say(app, id, "A saved answer");
    await until(
        () =>
            (tab.last("view")!.live as ClientLive).busy === false &&
            (tab.last("view")!.entries as { kind: string }[]).some(
                (entry) => entry.kind === "assistant",
            ),
        "the saved answer to replace the live generation",
    );
    check();
    await app.commands.reset(id, owner(app), undefined);
    push();
    assert.equal(shown, undefined, "reset cannot retain a previous live answer");

    // PiP is a second client: neither room may borrow the other one's blocks or protocol version.
    await app.setPip(owner(app), modern.connection, true);
    await until(() => tab.last("pipview") !== undefined, "the separate PiP client");
    const pip = modern.pip!;
    const pipRoom = await app.room(pip.conversationId!);

    await app.harness.commit(async (tx) => {
        const live = await tx.doc(LiveDoc, pip.conversationId!);

        live.generation = {
            attempt: 0,
            message: {
                ...messageFields,
                content: [{ type: "text", text: "private panel" }],
            },
        };
    }, context);
    pipRoom.push(pip, false);
    const first = (tab.last("pipview")!.live as ClientLive).generation!.message;

    await app.harness.commit(async (tx) => {
        const live = await tx.doc(LiveDoc, pip.conversationId!);

        live.generation!.message = {
            ...messageFields,
            content: [{ type: "text", text: "private panel grows" }],
        };
    }, context);
    pipRoom.push(pip, false);
    assert.deepEqual(
        liveMessage(first, (tab.last("pipview")!.live as ClientLiveUpdate).generation!.message),
        { blocks: [{ type: "text", text: "private panel grows" }] },
    );
    assert.equal(shown, undefined);
});

function storage() {
    const values = new Map<string, string>();

    return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, String(value)),
        removeItem: (key: string) => values.delete(key),
    };
}

async function browserStore(t: TestContext, mode: string) {
    const page = new EventTarget();
    const document = Object.assign(new EventTarget(), {
        visibilityState: "visible",
        documentElement: { dataset: {} },
        querySelector: () => null,
    });
    const streams: Stream[] = [];
    const polls: { url: string; resolve: (value: Response) => void }[] = [];
    const localStorage = storage();

    class Stream {
        handlers = new Map<string, (event: { data: string }) => void>();
        url: string;

        constructor(url: string) {
            this.url = url;
            streams.push(this);
        }

        addEventListener(name: string, handler: (event: { data: string }) => void) {
            this.handlers.set(name, handler);
        }

        close() {}
    }

    if (mode === "poll") {
        localStorage.setItem("pocket.transport", `poll:${Date.now()}`);
    }

    const globals = {
        document,
        navigator: { onLine: true },
        localStorage,
        sessionStorage: storage(),
        location: { pathname: "/s/1", hostname: "example.test", href: "https://example.test/s/1" },
        history: { state: null },
        addEventListener: page.addEventListener.bind(page),
        removeEventListener: page.removeEventListener.bind(page),
        matchMedia: () => ({ matches: false, addEventListener() {} }),
        EventSource: Stream,
    };
    const descriptors = new Map<string, PropertyDescriptor | undefined>();

    for (const [name, value] of Object.entries(globals)) {
        descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, { configurable: true, value });
    }

    t.after(() => {
        page.dispatchEvent(new Event("pagehide"));

        for (const [name, descriptor] of descriptors) {
            if (descriptor) {
                Object.defineProperty(globalThis, name, descriptor);
            } else {
                Reflect.deleteProperty(globalThis, name);
            }
        }
    });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    t.mock.method(globalThis, "fetch", (url: string) => {
        if (url.includes("close=1")) {
            return Promise.resolve(Response.json({}));
        }

        assert.ok(url.startsWith("/api/poll?"), `unexpected fetch ${url}`);

        return new Promise<Response>((resolve) => polls.push({ url, resolve }));
    });
    const module = await import(
        new URL(`../web/store.js?live-deltas=${mode}`, import.meta.url).href
    );
    let seq = 0;
    let session = 0;
    const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
    const opens = () =>
        streams.length + polls.filter((poll) => !poll.url.includes("session=")).length;

    const deliver = async (...events: { event: string; data: unknown }[]) => {
        if (mode === "stream") {
            for (const event of events) {
                streams.at(-1)!.handlers.get(event.event)!({ data: JSON.stringify(event.data) });
            }
        } else {
            const poll = polls.at(-1)!;

            if (!poll.url.includes("session=")) {
                session++;
                seq = 0;
            }

            poll.resolve(
                Response.json({
                    session: `connection-${session}`,
                    events: events.map((event) => ({ ...event, seq: ++seq })),
                }),
            );
            await flush();
        }
    };

    module.store.set({ me: { id: "owner", role: "owner" } });
    module.connect();
    assert.match((streams[0] ?? polls[0])!.url, /[?&]p=3(?:&|$)/);

    return { ...module, page, document, opens, deliver, flush };
}

test("browser SSE and poll consumers keep independent room bases and coalesce mismatches without escaping pagehide", async (t) => {
    for (const mode of ["stream", "poll"]) {
        await t.test(mode, async (t) => {
            const { store, page, opens, deliver, flush } = await browserStore(t, mode);
            const view = (id: number, message: unknown, full = false) => ({
                full,
                conversation: { id },
                entries: [],
                live: { busy: true, generation: { attempt: 0, message } },
            });
            const full = { blocks: [{ type: "text", text: "ab" }] };
            const append = { keep: 0, blocks: [{ type: "text", from: 2, text: "c" }] };
            const message = (pip = false) =>
                (pip ? store.state.pipView : store.state.view).live.generation.message;

            // Existing protocol 2 servers stay compatible during the live backport, before any restart.
            await deliver(
                { event: "view", data: view(1, full, true) },
                {
                    event: "pipview",
                    data: view(9, { blocks: [{ type: "thinking", text: "private" }] }, true),
                },
                { event: "view", data: view(1, append) },
                {
                    event: "pipview",
                    data: view(9, {
                        keep: 0,
                        blocks: [{ type: "thinking", from: 7, text: " thought" }],
                    }),
                },
            );
            assert.deepEqual(message(), { blocks: [{ type: "text", text: "abc" }] });
            assert.deepEqual(message(true), {
                blocks: [{ type: "thinking", text: "private thought" }],
            });
            const had = message();
            const mismatched = { event: "view", data: view(1, append) };
            const before = opens();

            await deliver(
                mismatched,
                { event: "view", data: view(1, { keep: 4, blocks: [] }) },
                { event: "view", data: view(1, { keep: -1, blocks: [] }) },
            );
            assert.deepEqual(message(), had, "bad append lengths never replace the shown message");
            t.mock.timers.tick(1);
            await flush();
            assert.equal(
                opens(),
                before + 1,
                "one mismatched batch requests only one full reconnect",
            );
            await deliver({ event: "view", data: view(1, full, true) });
            assert.deepEqual(message(), full);

            await deliver(mismatched); // Fits again, now that the server supplied its full view.
            assert.deepEqual(message(), { blocks: [{ type: "text", text: "abc" }] });
            await deliver(mismatched);
            page.dispatchEvent(new Event("pagehide"));
            const departed = opens();

            page.dispatchEvent(new Event("online"));
            t.mock.timers.tick(10);
            await flush();
            assert.equal(
                opens(),
                departed,
                "a queued delta recovery cannot reopen a departed page",
            );
            page.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
            assert.equal(opens(), departed + 1);
            await deliver({ event: "view", data: view(1, undefined, true) });
            assert.equal(message(), undefined, "a new full view drops the pre-suspension message");
        });
    }
});
