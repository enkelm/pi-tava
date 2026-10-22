// Public seams: disposable app HTTP, registered Memory tool and actual provider prompt. No document edits or
// internal Memory mocks. Existing memory.test.ts owns shared approvals; these cases own private isolation,
// automatic maintenance and durable identity/replay. Regressions include caller scope escaping into shared memory,
// guessed IDs crossing agents, a revoked identity falling back to global, and private changes broadcasting globally.
import {
    type App,
    cleanUp,
    context,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { awaitWithContext, withAbortSignal } from "@earendil-works/chord/context";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { createHandler } from "../src/server/http.ts";
import type { MemoryView } from "../src/server/memory.ts";
import type { Client } from "../src/server/room.ts";

const cid = (id: number) => id as ConversationId;
const prompts = new Map<string, string>();
const model = () =>
    scriptedModel((request) => {
        const last = lastText(request);
        const text = last.text.replace(/^\[from:[^\]]+\]\s*/, "");

        if (last.role === "user" && text.startsWith("memory ")) {
            return fauxAssistantMessage([fauxToolCall("memory", JSON.parse(text.slice(7)))], {
                stopReason: "toolUse",
            });
        }

        if (last.role === "user" && text.startsWith("probe ")) {
            prompts.set(
                text.slice(6),
                JSON.stringify(request.messages.filter((message) => message.role === "system")),
            );
        }

        return fauxAssistantMessage([fauxText("Done")]);
    });

after(cleanUp);

async function request(app: App, path: string, body?: unknown, token = app.config.ownerToken) {
    const incoming = new IncomingMessage(new Socket());
    const response = new ServerResponse(incoming);
    let output = "";

    incoming.url = `/api/${path}`;
    incoming.method = body === undefined ? "GET" : "POST";
    incoming.headers = {
        authorization: `Bearer ${token}`,
        "x-pocket": "1",
        "content-type": "application/json",
    };

    response.end = (chunk?: unknown) => {
        output = String(chunk ?? "");

        return response;
    };

    const handled = createHandler({
        app,
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
    })(incoming, response);

    if (body !== undefined) {
        incoming.push(Buffer.from(JSON.stringify(await body)));
    }

    incoming.push(null);
    await handled;

    return new Response(output, {
        status: response.statusCode,
        headers: { "content-type": "application/json" },
    });
}

async function create(app: App, name: string): Promise<ConversationId> {
    app.config.defaultModel = { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
    const response = await request(app, "pip/agents", { requestId: crypto.randomUUID(), name });

    assert.equal(response.status, 200, await response.clone().text());

    return cid(((await response.json()) as { id: number }).id);
}

async function view(app: App, id: ConversationId): Promise<MemoryView> {
    const response = await request(app, `c/${id}/memory`);

    assert.equal(response.status, 200, await response.clone().text());

    return response.json();
}

async function call(app: App, id: ConversationId, args: object, expectedError = false) {
    const previous = (await app.transcripts.allEntries(id, true)).at(-1)?.id ?? 0;

    await say(app, id, `memory ${JSON.stringify(args)}`);
    const result = (await app.transcripts.allEntries(id, true)).findLast(
        (entry) => entry.id > previous && entry.kind === "toolResult" && entry.name === "memory",
    );

    assert.ok(result?.kind === "toolResult", "the registered Memory tool answered");
    assert.equal(result.isError, expectedError, result.text);

    return result;
}

test("a private agent automatically maintains learned Memory, without editing its charter or shared approvals", async () => {
    const app = await openApp(model(), join(root, "private-memory-maintenance"));

    try {
        const id = await create(app, "Ada");
        const { chats: beforeChats, ...charter } = await app.pip.agents.read(id, owner(app));

        await call(app, id, { action: "add", scope: "everywhere", text: "PRIVATE_LEARNED_COBALT" });
        let lessons = (await view(app, id)).lessons;

        assert.equal(lessons.length, 1);
        assert.equal(lessons[0]?.pending, false, "private learning is immediately in force");
        assert.equal(lessons[0]?.scope, "private-agent", "never labelled everywhere");
        const lessonId = lessons[0]!.id;

        await say(app, id, "probe private-maintenance");
        assert.match(prompts.get("private-maintenance")!, /PRIVATE_LEARNED_COBALT/);
        assert.match(prompts.get("private-maintenance")!, /private.*agent|agent.*private/i);
        await call(app, id, {
            action: "update",
            id: lessonId,
            text: "PRIVATE_LEARNED_CERULEAN",
            expectedRevision: 1,
        });
        lessons = (await view(app, id)).lessons;
        assert.equal(lessons[0]?.text, "PRIVATE_LEARNED_CERULEAN");
        assert.equal(lessons[0]?.proposal, undefined);
        assert.equal(lessons[0]?.revision, 2);
        assert.match(prompts.get("private-maintenance")!, /revision 1/);
        const listed = await call(app, id, { action: "list" });

        assert.match(listed.text, /revision 2/);
        const stale = await call(
            app,
            id,
            { action: "update", id: lessonId, text: "STALE_TOOL_TEXT", expectedRevision: 1 },
            true,
        );

        assert.match(stale.text, /current observed revision/);
        assert.equal((await view(app, id)).lessons[0]?.text, "PRIVATE_LEARNED_CERULEAN");
        await call(app, id, { action: "remove", id: lessonId, expectedRevision: 2 });
        assert.deepEqual((await view(app, id)).lessons, []);
        const { chats: afterChats, ...currentCharter } = await app.pip.agents.read(id, owner(app));

        assert.deepEqual(currentCharter, charter, "learned data is not charter");
        assert.deepEqual(
            afterChats.map((chat) => chat.id),
            beforeChats.map((chat) => chat.id),
            "Memory leaves transcripts intact; their native activity timestamps may advance",
        );
    } finally {
        await app.close();
    }
});

test("Memory HTTP, tool lists and prompts isolate private identities from each other, generic PiP and shared scopes", async () => {
    const app = await openApp(model(), join(root, "private-memory-isolation"));

    try {
        const shared = await newSession(app);
        const generic = await app.pip.ensure(owner(app));
        const ada = await create(app, "Ada");
        const bea = await create(app, "Bea");
        const adaChat = cid(
            (await app.pip.agents.newChat(ada, owner(app), { requestId: "second-chat" })).id,
        );
        const sharedIds: string[] = [];

        for (const scope of ["project", "everywhere"]) {
            const added = await request(app, `c/${shared}/memory`, {
                text: `SHARED_${scope}_MARIGOLD`,
                scope,
            });

            assert.equal(added.status, 200);
            sharedIds.push(((await added.json()) as { id: string }).id);
        }

        await call(app, ada, { action: "add", scope: "project", text: "ADA_ONLY_VERMILION" });
        await call(app, bea, { action: "add", scope: "everywhere", text: "BEA_ONLY_VERDIGRIS" });
        const adaLesson = (await view(app, ada)).lessons[0]!;
        const beaLesson = (await view(app, bea)).lessons[0]!;

        assert.deepEqual(
            (await view(app, adaChat)).lessons.map((lesson) => lesson.text),
            ["ADA_ONLY_VERMILION"],
        );
        assert.deepEqual(
            (await view(app, bea)).lessons.map((lesson) => lesson.text),
            ["BEA_ONLY_VERDIGRIS"],
        );

        for (const id of [shared, generic]) {
            assert.ok(
                !(await view(app, id)).lessons.some((lesson) => lesson.text.includes("ONLY_")),
            );
        }

        for (const [id, forbidden] of [
            [ada, [...sharedIds, beaLesson.id]],
            [bea, [adaLesson.id]],
            [shared, [adaLesson.id]],
            [generic, [beaLesson.id]],
        ] as const) {
            for (const lessonId of forbidden) {
                for (const [suffix, body] of [
                    ["", { text: "LEAKED_EDIT" }],
                    ["/remove", {}],
                    ["/approve", { text: "LEAKED_APPROVAL" }],
                    ["/discard", {}],
                ] as const) {
                    const response = await request(
                        app,
                        `c/${id}/memory/${lessonId}${suffix}`,
                        body,
                    );

                    assert.equal(response.status, 404, `${id} cannot act on ${lessonId}${suffix}`);
                }
            }
        }

        assert.equal((await request(app, `c/${ada}/memory?pending=all`)).status, 403);
        const queue = await request(app, `c/${generic}/memory?pending=all`);

        assert.equal(queue.status, 200);
        assert.deepEqual(((await queue.json()) as MemoryView).lessons, []);
        assert.equal(
            (
                await request(app, `c/${ada}/memory/${adaLesson.id}/approve`, {
                    text: adaLesson.text,
                })
            ).status,
            400,
        );

        for (const [id, present, absent] of [
            [
                adaChat,
                "ADA_ONLY_VERMILION",
                ["BEA_ONLY_VERDIGRIS", "SHARED_project_MARIGOLD", "SHARED_everywhere_MARIGOLD"],
            ],
            [bea, "BEA_ONLY_VERDIGRIS", ["ADA_ONLY_VERMILION", "SHARED_everywhere_MARIGOLD"]],
            [generic, "SHARED_everywhere_MARIGOLD", ["ADA_ONLY_VERMILION", "BEA_ONLY_VERDIGRIS"]],
        ] as const) {
            const listed = await call(app, id, { action: "list" });

            assert.equal(listed.isError, false, listed.text);
            assert.match(listed.text, new RegExp(present));
            await say(app, id, `probe scope-${id}`);
            const prompt = prompts.get(`scope-${id}`)!;

            assert.match(prompt, new RegExp(present));

            for (const word of absent) {
                assert.ok(!listed.text.includes(word), `list excludes ${word}`);
                assert.ok(!prompt.includes(word), `prompt excludes ${word}`);
            }
        }

        const guest = app.config.addUser("Memory guest", "guest");

        assert.equal((await request(app, `c/${ada}/memory`, undefined, guest.token)).status, 404);
        assert.equal(
            (await request(app, `c/${ada}/memory`, { text: "LEAKED_GUEST" }, guest.token)).status,
            404,
        );
        assert.equal((await view(app, ada)).lessons[0]?.text, "ADA_ONLY_VERMILION");
        assert.equal((await view(app, bea)).lessons[0]?.text, "BEA_ONLY_VERDIGRIS");
    } finally {
        await app.close();
    }
});

test("private Memory invalidations reach only authorized tabs for the same identity", async () => {
    const app = await openApp(model(), join(root, "private-memory-events"));
    const clients: Client[] = [];

    try {
        const ada = await create(app, "Ada");
        const adaChat = cid(
            (await app.pip.agents.newChat(ada, owner(app), { requestId: "event-chat" })).id,
        );
        const bea = await create(app, "Bea");
        const generic = await app.pip.ensure(owner(app));
        const shared = await newSession(app);
        const events = new Map<ConversationId, string[]>();

        for (const id of [ada, adaChat, bea, generic, shared]) {
            const received: string[] = [];
            const client: Client = {
                id: `memory-${id}`,
                connection: `memory-${id}`,
                conversationId: id,
                user: owner(app),
                sentEntries: new Set(),
                orderKey: "",
                send: (event) => received.push(event),
            };

            events.set(id, received);
            clients.push(client);
            await app.attach(client);
        }

        for (const received of events.values()) {
            received.length = 0;
        }

        await call(app, ada, { action: "add", text: "PRIVATE_EVENT_SIENNA" });
        await until(
            () => events.get(adaChat)!.includes("memory"),
            "same-identity memory invalidation",
        );
        assert.ok(events.get(ada)!.includes("memory"));

        for (const id of [bea, generic, shared]) {
            assert.ok(!events.get(id)!.includes("memory"), `private learning does not ping ${id}`);
        }

        for (const received of events.values()) {
            received.length = 0;
        }

        const added = await request(app, `c/${shared}/memory`, {
            text: "SHARED_EVENT_UMBER",
            scope: "everywhere",
        });

        assert.equal(added.status, 200);
        await until(() => events.get(shared)!.includes("memory"), "shared memory invalidation");

        for (const id of [ada, adaChat, bea]) {
            assert.ok(
                !events.get(id)!.includes("memory"),
                `shared memory does not ping private ${id}`,
            );
        }
    } finally {
        for (const client of clients) {
            app.detach(client);
        }

        await app.close();
    }
});

// The public Memory write API carries Durable's task/call idempotency key; HTTP intentionally never accepts one.
// Exercise that production entry point for exact replay, while HTTP remains the independent read/delete boundary.
test("private Memory request tombstones survive deletion and restart and cannot overwrite later learning", async () => {
    const data = join(root, "private-memory-replay");
    let app = await openApp(model(), data);

    try {
        const ada = await create(app, "Ada");
        const bea = await create(app, "Bea");
        const pi = { userId: owner(app).id, byPi: true, name: "Pi" };
        const input = {
            text: "REPLAY_ORIGINAL_OCHRE",
            scope: "everywhere" as const,
            key: "task:original-call",
        };
        const first = await app.memory.add(ada, undefined, pi, input);
        const duplicate = await app.memory.add(ada, undefined, pi, input);

        assert.equal(duplicate.id, first.id);
        assert.equal((await view(app, ada)).lessons.length, 1);
        const sibling = await app.memory.add(bea, undefined, pi, input);

        assert.notEqual(sibling.id, first.id, "a request key is scoped to owner plus identity");
        await assert.rejects(
            app.memory.add(ada, undefined, pi, { ...input, text: "DIFFERENT_INPUT" }),
            { status: 409 },
        );
        await app.memory.change(
            ada,
            undefined,
            pi,
            first.id,
            { text: "REPLAY_UPDATED_OCHRE" },
            undefined,
            false,
            "task:update-call",
            1,
        );
        assert.equal((await view(app, ada)).lessons[0]?.text, "REPLAY_UPDATED_OCHRE");
        const replayedUpdate = await app.memory.change(
            ada,
            undefined,
            pi,
            first.id,
            { text: "REPLAY_UPDATED_OCHRE" },
            undefined,
            false,
            "task:update-call",
            1,
        );

        assert.equal(
            replayedUpdate.revision,
            2,
            "exact successful replay does not become a stale first write or increment again",
        );
        await assert.rejects(app.memory.add(ada, undefined, pi, input), { status: 409 });
        const edited = await request(app, `c/${ada}/memory/${first.id}`, {
            text: "OWNER_NEWER_OCHRE",
            expectedRevision: 2,
        });

        assert.equal(edited.status, 200);
        await assert.rejects(
            app.memory.change(
                ada,
                undefined,
                pi,
                first.id,
                { text: "REPLAY_UPDATED_OCHRE" },
                undefined,
                false,
                "task:update-call",
                1,
            ),
            { status: 409 },
        );
        assert.equal((await view(app, ada)).lessons[0]?.text, "OWNER_NEWER_OCHRE");
        let releaseStale!: (body: object) => void;
        const delayedBody = new Promise<object>((resolve) => {
            releaseStale = resolve;
        });
        const staleWrite = request(app, `c/${ada}/memory/${first.id}`, delayedBody);
        const removed = await request(app, `c/${ada}/memory/${first.id}/remove`, {
            expectedRevision: 3,
        });

        assert.equal(removed.status, 200);
        releaseStale({ text: "DELAYED_STALE_OCHRE", expectedRevision: 3 });
        assert.equal(
            (await staleWrite).status,
            404,
            "an in-flight stale HTTP edit cannot recreate a deleted lesson",
        );
        await app.close();
        app = await openApp(model(), data);
        await assert.rejects(app.memory.add(ada, undefined, pi, input), { status: 404 });
        await assert.rejects(
            app.memory.change(
                ada,
                undefined,
                pi,
                first.id,
                { text: "REPLAY_UPDATED_OCHRE" },
                undefined,
                false,
                "task:update-call",
                1,
            ),
            { status: 404 },
        );
        assert.deepEqual((await view(app, ada)).lessons, []);
        assert.equal((await view(app, bea)).lessons[0]?.text, "REPLAY_ORIGINAL_OCHRE");
        const replayedSibling = await app.memory.add(bea, undefined, pi, input);

        assert.equal(replayedSibling.id, sibling.id);
        await call(app, ada, { action: "list" });
        await say(app, ada, "probe deleted-memory");
        assert.ok(!prompts.get("deleted-memory")!.includes("REPLAY_ORIGINAL_OCHRE"));
        assert.ok(!prompts.get("deleted-memory")!.includes("OWNER_NEWER_OCHRE"));
    } finally {
        await app.close();
    }
});

test("two chats cannot correct or delete private Memory from a stale observed revision", async () => {
    const app = await openApp(model(), join(root, "private-memory-revisions"));

    try {
        const first = await create(app, "Ada");
        const second = cid(
            (await app.pip.agents.newChat(first, owner(app), { requestId: "revision-chat" })).id,
        );
        const added = await request(app, `c/${first}/memory`, { text: "ORIGINAL_REVISION_TEAL" });

        assert.equal(added.status, 200);
        const initial = (await added.json()) as { id: string; revision: number };
        const firstSaw = (await view(app, first)).lessons[0]!;
        const secondSaw = (await view(app, second)).lessons[0]!;
        const corrected = await request(app, `c/${second}/memory/${initial.id}`, {
            text: "CURRENT_REVISION_TEAL",
            expectedRevision: initial.revision,
        });

        assert.equal(corrected.status, 200);
        const current = (await corrected.json()) as { revision: number };
        const staleCorrection = await request(app, `c/${first}/memory/${initial.id}`, {
            text: "STALE_REVISION_TEAL",
            expectedRevision: initial.revision,
        });

        assert.equal(
            staleCorrection.status,
            409,
            "the first execution of a stale correction is rejected",
        );
        assert.equal(
            (
                await request(app, `c/${first}/memory/${initial.id}/remove`, {
                    expectedRevision: initial.revision,
                })
            ).status,
            409,
            "a stale delete cannot remove a newer correction",
        );
        assert.equal(firstSaw.revision, 1);
        assert.equal(secondSaw.revision, 1);
        assert.equal(current.revision, 2);
        const visible = (await view(app, first)).lessons[0]!;

        assert.equal(visible.text, "CURRENT_REVISION_TEAL");
        assert.equal(visible.revision, 2);
        assert.equal(
            (await request(app, `c/${first}/memory/${initial.id}`, { text: "NO_REVISION" })).status,
            409,
        );
        assert.equal(
            (await request(app, `c/${second}/memory/${initial.id}/remove`, {})).status,
            409,
        );
        assert.equal(
            (
                await request(app, `c/${first}/memory/${initial.id}/remove`, {
                    expectedRevision: visible.revision,
                })
            ).status,
            200,
        );
        assert.deepEqual((await view(app, second)).lessons, []);
    } finally {
        await app.close();
    }
});

test("an old-owner external model response cannot write private Memory after token rotation", async () => {
    for (const action of ["add", "update", "remove"] as const) {
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        let modelCalls = 0;
        let entered = false;
        const app = await openApp(
            scriptedModel(async (input, options) => {
                modelCalls++;
                const last = lastText(input);
                const text = last.text.replace(/^\[from:[^\]]+\]\s*/, "");

                if (last.role === "user" && text.startsWith("revoked-memory ")) {
                    entered = true;
                    await awaitWithContext(
                        held,
                        options?.signal ? withAbortSignal(options.signal, context) : context,
                    );

                    return fauxAssistantMessage(
                        [fauxToolCall("memory", JSON.parse(text.slice(15)))],
                        { stopReason: "toolUse" },
                    );
                }

                if (last.role === "user" && text.startsWith("memory ")) {
                    return fauxAssistantMessage(
                        [fauxToolCall("memory", JSON.parse(text.slice(7)))],
                        { stopReason: "toolUse" },
                    );
                }

                return fauxAssistantMessage([fauxText("Done")]);
            }),
            join(root, `private-memory-revoked-${action}`),
        );

        try {
            const id = await create(app, "Revocation Ada");
            let args: object = { action: "add", text: "REVOKED_PRIVATE_MEMORY" };

            if (action !== "add") {
                const seeded = await request(app, `c/${id}/memory`, {
                    text: "CURRENT_PRIVATE_MEMORY",
                });

                assert.equal(seeded.status, 200);
                const lesson = (await seeded.json()) as { id: string; revision: number };

                args = {
                    action,
                    id: lesson.id,
                    expectedRevision: lesson.revision,
                    ...(action === "update" ? { text: "REVOKED_PRIVATE_MEMORY" } : {}),
                };
            }

            const { submissionId } = await app.commands.submit(id, owner(app), {
                text: `revoked-memory ${JSON.stringify(args)}`,
                requestId: `held-${action}`,
            });

            await until(() => entered, "private generation enters external model");
            // Native first-input naming has settled; only the held model response is under test.
            const before = await view(app, id);

            app.config.rotateOwnerToken();
            release();
            await (await app.harness.submission(submissionId, context))!.wait(context);
            await until(() => !app.isBusy(id), "revoked Memory generation settles");
            assert.deepEqual(
                (await view(app, id)).lessons,
                before.lessons,
                `${action}: old-owner model cannot change learned data`,
            );
            const entries = await app.transcripts.allEntries(id, true);

            const results = entries
                .filter((entry) => entry.kind === "toolResult")
                .filter((entry) => entry.name === "memory");
            const outcome = await (await app.harness.submission(submissionId, context))!.status(
                context,
            );

            assert.ok(
                results.every((entry) => entry.isError),
                `${action}: a revoked call must never report successful Memory execution`,
            );
            assert.ok(
                outcome.status === "unanswered" || results.length > 0,
                `${action}: native admission aborts the run or returns an explicit tool refusal`,
            );
            assert.equal(modelCalls, 1, "revocation cannot buy a fresh model turn");
            await call(app, id, { action: "add", text: "FRESH_OWNER_PRIVATE_MEMORY" });
            assert.ok(
                (await view(app, id)).lessons.some(
                    (lesson) => lesson.text === "FRESH_OWNER_PRIVATE_MEMORY",
                ),
                "a fresh owner's registered tool still works",
            );
        } finally {
            release();
            await app.close();
        }
    }
});
