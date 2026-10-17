// This owner-boundary integration imports the unchanged browser store. Minimal browser globals provide
// storage/transport only; the real app produces every accepted submission, receipt and successor.
// Regression: losing POST acceptance must not mint a second input on retry or replay input on reload.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import {
    cleanUp,
    context,
    lastText,
    openApp,
    owner,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";

function storage() {
    const values = new Map<string, string>();

    return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, String(value)),
        removeItem: (key: string) => values.delete(key),
    };
}

test("lost browser submission acceptance retains its identity across explicit retry and passive reload recovery", async (t) => {
    const app = await openApp(
        scriptedModel((request) => {
            const last = lastText(request as never);
            const text = last.text.replace(/^\[from:[^\]]+\]\s*/, "");

            return last.role === "user" && text.startsWith("/handoff researcher")
                ? fauxAssistantMessage(
                      [
                          fauxToolCall("handoff", {
                              action: "start",
                              targetType: "researcher",
                              summary:
                                  "Investigate uncertain input delivery. No mutations authorized.",
                          }),
                      ],
                      { stopReason: "toolUse" },
                  )
                : fauxAssistantMessage("Input received; no external action performed.");
        }),
    );
    const user = owner(app);

    const createSource = async () => {
        const { id } = await app.commands.createSession(user, {
            cwd: work,
            threadType: "worker",
            title: "Uncertain acceptance fixture",
        });

        await app.commands.configure(id, user, {
            model: { provider: "faux", modelId: "faux-1" },
            thinkingLevel: "off",
        });

        return id;
    };

    const first = await createSource();
    const session = storage();
    const location = {
        pathname: `/s/${first}`,
        hostname: "localhost",
        href: `http://localhost/s/${first}`,
    };
    const events = new Map<string, () => void>();
    let stream: FakeEventSource | undefined;

    class FakeEventSource {
        handlers = new Map<string, (event: { data: string }) => void>();
        onopen: (() => void) | undefined;

        constructor() {
            stream = this;
        }

        addEventListener(name: string, handler: (event: { data: string }) => void) {
            this.handlers.set(name, handler);
        }

        emit(name: string, data: unknown) {
            this.handlers.get(name)?.({ data: JSON.stringify(data) });
        }

        close() {}
    }

    const globals = {
        sessionStorage: session,
        localStorage: storage(),
        location,
        history: { state: null },
        document: {
            visibilityState: "visible",
            documentElement: { dataset: {} },
            addEventListener() {},
        },
        addEventListener: (name: string, handler: () => void) => events.set(name, handler),
        removeEventListener: (name: string) => events.delete(name),
        matchMedia: () => ({ matches: false, addEventListener() {} }),
        EventSource: FakeEventSource,
    };
    const descriptors = new Map<string, PropertyDescriptor | undefined>();

    for (const [name, value] of Object.entries(globals)) {
        descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, { configurable: true, value });
    }

    t.after(async () => {
        events.get("pagehide")?.();

        for (const [name, descriptor] of descriptors) {
            if (descriptor) {
                Object.defineProperty(globalThis, name, descriptor);
            } else {
                Reflect.deleteProperty(globalThis, name);
            }
        }

        await app.close();
        cleanUp();
    });

    const posts: Array<{ requestId: string; mode: string; text: string }> = [];
    let loseSuccess = true;
    let allowReceiptReads = false;
    let receiptReads = 0;

    t.mock.method(globalThis, "fetch", async (address: string, options: RequestInit = {}) => {
        const url = new URL(String(address), "http://localhost");
        const match = /^\/api\/c\/(\d+)\/submit$/.exec(url.pathname);

        if (url.pathname === "/api/me") {
            return Response.json(await app.hello(user));
        }

        assert.ok(match, `unexpected request ${url}`);
        const id = Number(match[1]) as ConversationId;

        if (options.method === "POST") {
            const body = JSON.parse(String(options.body));

            posts.push(body);
            const receipt = await app.commands.submit(id, user, body);

            if (loseSuccess) {
                loseSuccess = false;

                throw new TypeError("Fixture accepted response lost");
            }

            return Response.json(receipt);
        }

        receiptReads++;

        if (!allowReceiptReads) {
            return Response.json({ error: "Fixture receipt unavailable" }, { status: 503 });
        }

        const receipt = await app.commands.submissionReceipt(
            id,
            user,
            url.searchParams.get("requestId"),
        );

        return receipt === undefined
            ? Response.json({ error: "Not found" }, { status: 404 })
            : Response.json(receipt);
    });

    // Query-qualified imports model a reload without source transforms or private production exports.
    const modulePath = new URL("../web/store.js?submission-recovery=initial", import.meta.url).href;
    const initial = await import(modulePath);

    initial.store.set({ me: user, server: { handoffs: 6 } });
    const command = "/handoff researcher Investigate delivery without publication.";

    await assert.rejects(initial.actions.submit(command, [], "followUp"), /accepted response lost/);
    await until(
        () => app.sessions().length === 2 && app.sessions().every((item) => !item.busy),
        "one real successor is delivered",
    );
    const attempts = () =>
        JSON.parse(session.getItem("pocket.submitAttempts") ?? '{"requests":[]}').requests;
    const originalId = posts[0]!.requestId;

    // The source has retired, and busy/steering mode changed. Neither may mint a new input identity.
    await initial.actions.submit(command, [], "steer");
    assert.equal(posts.length, 2);
    assert.equal(posts[0]!.requestId, originalId);
    assert.equal(posts[1]!.requestId, originalId);
    assert.notEqual(posts[0]!.mode, posts[1]!.mode);
    await until(() => receiptReads === 1, "uncertain admission uses passive receipt lookup");
    const sourceEntries = await (
        await app.conversation(first)
    ).entries({ order: "ascending" }, 100, undefined, context);

    assert.equal(sourceEntries.items.filter((entry) => entry.kind === "pi.user").length, 1);
    assert.equal(app.sessions().length, 2);
    assert.equal(attempts().length, 0);

    const second = await createSource();

    location.pathname = `/s/${second}`;
    initial.store.set({ conversationId: second });
    const drafts = ["Keep the older uncertain input.", "Keep the newer uncertain input."];

    for (const text of drafts) {
        loseSuccess = true;
        await assert.rejects(
            initial.actions.submit(text, [], "followUp"),
            /accepted response lost/,
        );
    }

    assert.equal(
        attempts().length,
        2,
        "editing creates an identity without discarding older uncertainty",
    );
    assert.notEqual(attempts()[0].requestId, attempts()[1].requestId);
    const beforeReload = posts.length;

    allowReceiptReads = true;
    const reloadPath = new URL("../web/store.js?submission-recovery=reload", import.meta.url).href;
    const reloaded = await import(reloadPath);

    await reloaded.start();
    stream!.emit("hello", await app.hello(user));
    await until(
        () =>
            attempts().length === 2 &&
            attempts().every((attempt: { receipt?: unknown }) => attempt.receipt),
        "reload passively finds both real receipts",
    );
    assert.equal(posts.length, beforeReload, "reload never replays POST");

    for (const text of drafts.toReversed()) {
        await reloaded.actions.submit(text, [], "steer");
    }

    assert.equal(
        posts.length,
        beforeReload,
        "resending a still-visible accepted draft returns its receipt",
    );
    assert.equal(attempts().length, 0);
    await until(() => !app.isBusy(second), "accepted inputs settle");
    const acceptedEntries = await (
        await app.conversation(second)
    ).entries({ order: "ascending" }, 100, undefined, context);

    assert.equal(acceptedEntries.items.filter((entry) => entry.kind === "pi.user").length, 2);
});
