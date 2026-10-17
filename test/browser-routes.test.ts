// The real HTTP boundary owns panel admission and writer lifetime. Only the page adapter is replaced:
// no Chromium, listener, fingerprint stub or production-only test seam is needed.
import {
    type App,
    cleanUp,
    context,
    executeHandoff,
    newSession,
    openApp,
    owner,
    scriptedModel,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { after, before, test, type TestContext } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { BrowserError } from "../src/server/browser/cdp.ts";
import { ChatDoc, TurnsDoc } from "../src/server/docs.ts";
import { HttpError } from "../src/server/errors.ts";
import { createHandler } from "../src/server/http.ts";
import { WorkflowDoc } from "../src/server/workflow-docs.ts";
import { withWorkflowPublicationLock } from "../src/server/workflow-policy.ts";

let app: App;
let handle: ReturnType<typeof createHandler>;

before(async () => {
    app = await openApp(scriptedModel());
    handle = createHandler({
        app,
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
    });
});
after(async () => {
    await app.close();
    cleanUp();
});

function request(
    id: ConversationId,
    route: string,
    method = "POST",
    token: string | null = app.config.ownerToken,
) {
    const incoming = new IncomingMessage(new Socket());
    const response = new ServerResponse(incoming);
    const reading = Promise.withResolvers<void>();
    let output = "";
    let ended = false;

    incoming.url = `/api/c/${id}/${route}`;
    incoming.method = method;
    incoming.headers = {
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        "x-pocket": "1",
        "content-type": "application/json",
    };
    incoming._read = () => reading.resolve();

    response.end = (chunk?: unknown) => {
        output = String(chunk ?? "");

        return response;
    };

    const handled = handle(incoming, response).then(() => ({
        status: response.statusCode,
        output,
    }));

    return {
        incoming,
        handled,
        reading: reading.promise,
        end(body: unknown = {}) {
            if (!ended) {
                ended = true;
                incoming.push(Buffer.from(JSON.stringify(body)));
                incoming.push(null);
            }

            return handled;
        },
    };
}

const actions = [
    "open",
    "navigate",
    "back",
    "forward",
    "reload",
    "viewport",
    "input",
    "stop",
    "clear",
];
const body = { url: "https://example.com/", viewport: "mobile", events: [] };

function pageAdapter(t: TestContext) {
    const effects: string[] = [];

    const settled = async (action: string) => {
        effects.push(action);
    };

    const page = {
        closed: false,
        researchReader: true,
        state: () => ({ open: true }),
        logs: () => [],
        frame: async () => undefined,
        input: () => settled("input"),
        stop: () => settled("stop"),
        clearLogs: () => effects.push("clear"),
        navigate: async () => {
            await settled("navigate");

            return {};
        },
        go: (direction: number) => settled(direction < 0 ? "back" : "forward"),
        reload: () => settled("reload"),
        setViewport: () => settled("viewport"),
    } as unknown as BrowserPage;

    t.mock.method(app.browsers, "open", async () => {
        await settled("open");

        return page;
    });

    t.mock.method(app.browsers, "page", () => page);

    return { page, effects };
}

async function retire(id: ConversationId) {
    await app.harness.commit(async (tx) => {
        const workflow = await tx.doc(WorkflowDoc, id);

        workflow.readOnly = true;
    }, context);
}

async function assertExclusiveBlocked(id: ConversationId) {
    const listed = await app.handoffs.list(id, owner(app));

    assert.ok(listed.options.length > 0);
    assert.ok(
        listed.options.every(
            (option) => !option.enabled && /writes.*executing/i.test(option.reason ?? ""),
        ),
    );
    await assert.rejects(
        executeHandoff(app, id, "researcher", {
            summary: "Transfer only after the panel settles.",
        }),
        /Local workflow writes are still executing/,
    );
    assert.deepEqual((await app.handoffs.list(id, owner(app))).handoffs, []);
}

// Authoring gate: delayed transport can outlive its source. Existing browser tests dispatch immediately;
// this must fail if body arrival is not followed by live ownership checks on every mutating route.
test("Browser-panel delayed bodies cannot act after source retirement", async (t) => {
    const adapter = pageAdapter(t);

    for (const action of actions) {
        const id = await newSession(app);
        const pending = request(id, `browser/${action}`);

        await pending.reading;
        await retire(id);
        const result = await pending.end(body);

        assert.equal(result.status, 409, `${action}: ${result.output}`);
        assert.match(result.output, /read-only|active thread/i);
        assert.deepEqual(adapter.effects, [], action);
    }
});

// Authoring gate: authority transfer must observe a body/action already admitted by HTTP,
// not just Durable tasks. The real admission path must reject before persistence.
test("Browser-panel reservations exclude handoff through body and action settlement", async (t) => {
    const { page, effects } = pageAdapter(t);
    const id = await newSession(app);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    t.mock.method(page, "input", async () => {
        effects.push("input");
        entered.resolve();
        await release.promise;
    });
    const pending = request(id, "browser/input");

    try {
        // Synchronous reservation must precede even the first async driver/conversation check.
        await assert.rejects(
            withWorkflowPublicationLock(app, id, async () => "must not enter"),
            /Local workflow writes are still executing/,
        );
        await pending.reading;
        await assertExclusiveBlocked(id);
        pending.end(body);
        await entered.promise;
        await assertExclusiveBlocked(id);
    } finally {
        release.resolve();
        pending.end(body);
        await pending.handled;
    }

    assert.equal((await pending.handled).status, 200);
    assert.deepEqual(effects, ["input"]);
    assert.equal(await withWorkflowPublicationLock(app, id, async () => "released"), "released");
});

// Authoring gate: an exclusive operation must exclude later HTTP writers but leave passive observers and
// unrelated Chats alone. Checking all mutations catches a route accidentally left outside the reservation.
test("Browser-panel mutations refuse an exclusive lock while passive reads and unrelated Chat remain usable", async (t) => {
    const { effects } = pageAdapter(t);
    const id = await newSession(app);
    const { id: chat } = await app.commands.createSession(owner(app), { threadType: "chat" });
    const chatId = chat as ConversationId;

    await withWorkflowPublicationLock(app, id, async () => {
        for (const action of actions) {
            const result = await request(id, `browser/${action}`).end(body);

            assert.equal(result.status, 409, `${action}: ${result.output}`);
            assert.match(result.output, /Publication|workflow.*execut/i);
        }

        assert.deepEqual(effects, []);

        for (const route of ["browser", "browser/frame", "browser/console"]) {
            const result = await request(id, route, "GET").end();

            assert.ok([200, 204].includes(result.status), `${route}: ${result.output}`);
        }

        assert.equal((await request(chatId, "browser/input").end(body)).status, 200);
    });
    assert.deepEqual(effects, ["input"]);
});

// Authoring gate: the requester captured before a slow body is not durable authority. These independent
// authorization changes bypass the old pre-body check, even without retiring the workflow itself.
test("Browser-panel rechecks requester identity, visibility, steering and driving after body arrival", async (t) => {
    const { effects } = pageAdapter(t);

    for (const change of ["removed", "hidden", "viewer", "driver"]) {
        const id = await newSession(app);
        const guest = app.config.addUser(`Panel ${change}`, "guest");
        const pending = request(id, "browser/input", "POST", guest.token);

        await pending.reading;

        if (change === "removed") {
            app.config.removeUser(guest.user.id);
        } else if (change === "hidden") {
            app.config.updateUser(guest.user.id, { sessions: ["999999"] });
        } else if (change === "viewer") {
            app.config.updateUser(guest.user.id, { role: "viewer" });
        } else {
            await app.harness.commit(async (tx) => {
                const turns = await tx.doc(TurnsDoc, id);

                turns.on = true;
                turns.driver = owner(app).id;
            }, context);
        }

        const result = await pending.end(body);

        assert.equal(
            result.status,
            { removed: 401, hidden: 404, viewer: 403, driver: 409 }[change],
            result.output,
        );
        assert.deepEqual(effects, [], change);
        assert.equal(
            await withWorkflowPublicationLock(app, id, async () => "released"),
            "released",
        );
    }
});

// Authoring gate: browser creation is another await after body arrival. A dispatch-time fence must prevent
// the second effect (navigation/activity) if authority is lost while opening the page.
test("Browser-panel rechecks authority after asynchronous page opening", async (t) => {
    const { page, effects } = pageAdapter(t);
    const id = await newSession(app);
    const before = await app.harness.snapshot(ChatDoc, id, context);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    t.mock.method(app.browsers, "open", async () => {
        entered.resolve();
        await release.promise;

        return page;
    });
    const pending = request(id, "browser/navigate");

    pending.end(body);

    try {
        await entered.promise;
        await retire(id);
    } finally {
        release.resolve();
        await pending.handled;
    }

    assert.equal((await pending.handled).status, 409);
    assert.deepEqual(effects, []);
    assert.deepEqual(await app.harness.snapshot(ChatDoc, id, context), before);
});

// Authoring gate: every failing exit must release HTTP's writer reservation. Real malformed/aborted bodies,
// invalid payloads, driver denial and adapter failures cover distinct lifetimes; successful routes still work.
test("Browser-panel reservations release after failures and preserve ordinary dispatch", async (t) => {
    const { page, effects } = pageAdapter(t);
    const id = await newSession(app);

    const assertReleased = async (pending: ReturnType<typeof request>, status: number) => {
        assert.equal((await pending.handled).status, status);
        assert.equal(
            await withWorkflowPublicationLock(app, id, async () => "released"),
            "released",
        );
    };

    const malformed = request(id, "browser/input");

    malformed.incoming.push(Buffer.from("{"));
    malformed.incoming.push(null);
    await assertReleased(malformed, 400);
    const aborted = request(id, "browser/input");

    await aborted.reading;
    aborted.incoming.destroy(new HttpError(408, "body aborted"));
    await assertReleased(aborted, 408);
    const invalid = request(id, "browser/input");

    invalid.end({ events: "not a list" });
    await assertReleased(invalid, 400);
    const viewer = app.config.addUser("Panel viewer", "viewer");
    const denied = request(id, "browser/input", "POST", viewer.token);

    denied.end(body);
    await assertReleased(denied, 403);
    const fail = t.mock.method(page, "input", async () => {
        throw new BrowserError("input failed");
    });
    const failure = request(id, "browser/input");

    failure.end(body);
    await assertReleased(failure, 409);
    fail.mock.restore();
    const failOpen = t.mock.method(app.browsers, "open", async () => {
        throw new BrowserError("open failed");
    });
    const opening = request(id, "browser/open");

    opening.end();
    await assertReleased(opening, 409);
    failOpen.mock.restore();
    assert.deepEqual(effects, []);

    for (const action of actions) {
        const start: number = effects.length;
        const pending = request(id, `browser/${action}`);

        pending.end(body);
        await assertReleased(pending, 200);
        assert.deepEqual(
            effects.slice(start),
            [
                ...(["open", "navigate", "back", "forward", "reload", "viewport"].includes(action)
                    ? ["open"]
                    : []),
                ...(action === "open" ? [] : [action]),
            ],
            action,
        );
    }
});
