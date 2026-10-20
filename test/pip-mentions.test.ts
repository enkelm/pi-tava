// Real discussion admission, registered source-scoped model/tool execution, durable replay and service delivery.
// No server listener, native Git confinement, private model request, or live app data is involved.
import {
    type App,
    cleanUp,
    context,
    fakeTab,
    lastText,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { awaitWithContext, withAbortSignal } from "@earendil-works/chord/context";
import {
    createAssistantMessageEventStream,
    getCurrentTools,
    type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { type ConversationId, type TaskId, UsageDoc } from "@earendil-works/pi-durable";
import { ChatDoc, PipMentionJobDoc, PipMentionsDoc } from "../src/server/docs.ts";
import { pipMentionParts } from "../web/pip-mention-text.js";

const calls: {
    text: string;
    system: string;
    model: string;
    sessionId?: string;
    tools: string[];
    maxTokens?: number;
    maxRetries?: number;
    timeoutMs?: number;
}[] = [];

const answer = () => {
    const result = fauxAssistantMessage("PiP's shared answer.");

    result.usage = {
        input: 11,
        output: 7,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 18,
        cost: { input: 0.25, output: 1, cacheRead: 0, cacheWrite: 0, total: 1.25 },
    };

    return result;
};

let response: FauxResponseStep = answer;
let beforeCompletion: ((signal: AbortSignal | undefined) => Promise<void>) | undefined;
const faux = scriptedModel((request, options, state, selected) => {
    calls.push({
        text: lastText(request).text,
        system: JSON.stringify(request.messages.filter((entry) => entry.role === "system")),
        model: selected.id,
        sessionId: options?.sessionId,
        tools: getCurrentTools(request.messages).map((tool) => tool.name),
        maxTokens: options?.maxTokens,
        maxRetries: options?.maxRetries,
        timeoutMs: options?.timeoutMs,
    });

    return typeof response === "function" ? response(request, options, state, selected) : response;
});
// Faux deliberately estimates zero dollars. This native provider adapter reports a deterministic nominal
// price on completed responses; production still owns every admission, usage receipt and accounting write.
const model = {
    ...faux,
    provider: {
        ...faux.provider,
        streamSimple(...args: Parameters<typeof faux.provider.streamSimple>) {
            const stream = faux.provider.streamSimple(...args);
            const priced = createAssistantMessageEventStream();

            void (async () => {
                for await (const event of stream) {
                    if (event.type === "done" || event.type === "error") {
                        const terminal = event.type === "done" ? event.message : event.error;
                        const message = {
                            ...terminal,
                            usage: {
                                ...terminal.usage,
                                cost: {
                                    input: 0.25,
                                    output: 1,
                                    cacheRead: 0,
                                    cacheWrite: 0,
                                    total: 1.25,
                                },
                            },
                        };

                        await beforeCompletion?.(args[2]?.signal);
                        priced.push(
                            event.type === "done"
                                ? { ...event, message }
                                : { ...event, error: message },
                        );
                        priced.end(message);

                        return;
                    }

                    priced.push(event);
                }

                priced.end(await stream.result());
            })();

            return priced;
        },
    },
};
let app: App;
let count = 0;

before(async () => {
    app = await openApp(model);
    app.pip.configureCollaborator(owner(app), {
        model: { provider: "faux", modelId: "faux-2" },
        thinkingLevel: "off",
        expectedRevision: 0,
    });
});

after(async () => {
    await app?.close();
    cleanUp();
});

async function source() {
    const { id } = await app.commands.createSession(owner(app), { cwd: work, threadType: "chat" });

    return id;
}

function guest() {
    return app.config.addUser(`Mention requester ${++count}`, "guest").user;
}

async function chat(id: ConversationId) {
    return (await app.harness.snapshot(ChatDoc, id, context))?.messages ?? [];
}

async function posted(
    id: ConversationId,
    user = owner(app),
    text = "@PiP explain this",
    requestId = crypto.randomUUID(),
) {
    return app.collab.postChat(id, user, { text, requestId });
}

async function settled(id: ConversationId, messageId: string) {
    await until(async () => {
        const message = (await chat(id)).find((item) => item.id === messageId);

        return !!message?.pip && !["queued", "working"].includes(message.pip.status);
    }, "PiP mention settlement");

    return (await chat(id)).find((item) => item.id === messageId)!;
}

async function job(id: ConversationId) {
    const lane = (await app.harness.snapshot(PipMentionsDoc, context))?.lane;

    assert.ok(lane);
    const page = await app.harness.commit(
        (tx) =>
            tx.scanTasks(
                {
                    conversationId: lane as ConversationId,
                    kind: "pocket.pip-mention",
                    order: "descending",
                },
                100,
            ),
        context,
    );
    const record = page.items.find(
        (item) => (item.input as { source: number }).source === Number(id),
    );

    assert.ok(record);
    const input = record.input as { source: number; key: string };
    const saved = (await app.harness.snapshot(PipMentionJobDoc, id, input.key, context))?.job;

    assert.ok(saved);

    return { record, input, saved, lane: lane as ConversationId };
}

function gate() {
    let release = () => {};

    const promise = new Promise<void>((resolve) => {
        release = resolve;
    });

    return { release, promise };
}

// Primary owner of the real mention contract: caller identity and source-only data flow all the way to delivery.
test("chat mentions use the selected shared model, isolate private context and charge the actual requester exactly once", async () => {
    const id = await source();
    const requester = guest();
    const other = guest();
    const privateId = await app.pip.ensure(owner(app));

    await app.commands.note(privateId, owner(app), "PRIVATE_PIP_CANARY");
    await app.commands.note(id, other, "last source requester is a different person");
    await posted(id, other, "Shared discussion context.");
    const tab = fakeTab(id, owner(app));

    await app.attach(tab.client);
    const requestId = crypto.randomUUID();
    const before = calls.length;
    const human = await posted(id, requester, "@PiP explain this shared context", requestId);
    const done = await settled(id, human.id);
    const delivered = (await chat(id)).find((item) => item.service === "pip");

    assert.equal(done.pip?.status, "answered");
    assert.equal(delivered?.name, "PiP");
    assert.equal(delivered?.userId, "pip");
    assert.equal(delivered?.replyTo?.id, human.id);
    assert.equal(delivered?.replyTo?.name, requester.name);
    const sentStates = tab.events
        .filter((event) => event.event === "chat")
        .flatMap((event) => event.data.messages as { id: string; pip?: { status: string } }[])
        .filter((item) => item.id === human.id)
        .map((item) => item.pip?.status);

    assert.deepEqual(
        sentStates,
        ["queued", "working", "answered"],
        "live tabs receive replacements for the original message, not just new IDs",
    );
    app.detach(tab.client);
    assert.equal(calls.length, before + 1);
    const call = calls.at(-1)!;

    assert.equal(call.model, "faux-2");
    assert.equal(call.sessionId, undefined);
    assert.deepEqual(call.tools, ["work_context"]);
    assert.equal(call.maxTokens, 1600);
    assert.equal(call.maxRetries, 0);
    assert.equal(call.timeoutMs, 60_000);
    assert.match(call.text, /Shared discussion context/);
    assert.doesNotMatch(
        call.text + call.system,
        /PRIVATE_PIP_CANARY|session_start|codemode|schedule_add/,
    );
    assert.ok(call.text.length <= 32_000);
    assert.equal(app.attribution.requesterOf(id), other.id);
    assert.equal(app.spend.personSpent(requester.id), 1.25);
    assert.equal(app.spend.personSpent(other.id), 0);
    assert.equal(app.spend.sessionSpent(id), 1.25);
    assert.equal(
        (await app.harness.snapshot(UsageDoc, id, context))?.models["faux/faux-2"],
        undefined,
    );
    const { saved, lane } = await job(id);

    assert.equal(saved.result?.provider, "faux");
    assert.equal(saved.context, "", "terminal receipts do not retain execution-only prompts");
    assert.equal(saved.result?.text, undefined);
    assert.equal(saved.result?.model, "faux-2");
    assert.equal(saved.selection.revision, app.config.pipCollaborator?.revision);
    assert.equal(saved.requesterId, requester.id);
    assert.equal(app.canSee(owner(app), lane), false);
    assert.equal(app.canSee(requester, lane), false);
    await assert.rejects(app.room(lane), /not shared/);
    assert.ok(!app.sessions().some((entry) => entry.id === Number(lane)));
    await posted(id, requester, "@PiP explain this shared context", requestId);
    assert.equal(calls.length, before + 1);
    assert.equal((await chat(id)).filter((item) => item.service === "pip").length, 1);

    // Rolling chat is not the dedup store. Replaying a lost old send must not purchase another answer.
    for (let index = 0; index < 501; index++) {
        await posted(id, other, `ordinary line ${index}`);
    }

    assert.ok(!(await chat(id)).some((item) => item.id === human.id));
    await posted(id, requester, "@PiP explain this shared context", requestId);
    assert.equal(calls.length, before + 1);
    assert.equal(app.spend.personSpent(requester.id), 1.25);
});

test("a review mention delivers an applicable PiP suggestion and only the human click writes code", async () => {
    const id = await source();
    const file = join(work, "mention-suggestion.ts");
    const original = "export function example() {\n    const value = 1;\n    return value;\n}\n";
    const replacement = "    const value = 2;\n    return value * 2;";
    const proposed = `Use the revised calculation.\n\n\`\`\`suggestion\n${replacement}\n\`\`\``;
    let round = 0;

    writeFileSync(file, original);

    response = (request) => {
        if (++round === 1) {
            return fauxAssistantMessage(
                fauxToolCall("work_context", { action: "file", path: "mention-suggestion.ts" }),
                { stopReason: "toolUse" },
            );
        }

        assert.match(
            JSON.stringify(request.messages.filter((entry) => entry.role === "toolResult")),
            /const value = 1/,
        );

        return fauxAssistantMessage(proposed);
    };

    const before = calls.length;
    const posted = await app.reviews.comment(id, owner(app), {
        requestId: crypto.randomUUID(),
        text: "@PiP update this calculation and suggest the change",
        path: "mention-suggestion.ts",
        side: "new",
        startLine: 2,
        line: 3,
        context: "    const value = 1;\n    return value;",
    });

    await until(
        async () => (await app.reviews.list(id, owner(app))).threads[0]?.pip?.status === "answered",
        "PiP review suggestion delivery",
    );
    const thread = (await app.reviews.list(id, owner(app))).threads[0]!;
    const reply = thread.replies[0]!;

    assert.equal(thread.id, posted.id);
    assert.equal(reply.service, "pip");
    assert.equal(reply.name, "PiP");
    assert.equal(reply.text, proposed);
    assert.equal(readFileSync(file, "utf8"), original, "PiP's proposal cannot mutate code");
    assert.equal(calls.length, before + 2);
    assert.equal(
        (
            await app.reviews.applySuggestion(id, owner(app), {
                requestId: crypto.randomUUID(),
                threadId: thread.id,
                commentId: reply.id,
                index: 0,
            })
        ).status,
        "applied",
    );
    assert.equal(readFileSync(file, "utf8"), `export function example() {\n${replacement}\n}\n`);
    assert.equal(calls.length, before + 2, "human application is not another generation");
    assert.equal(app.spend.sessionSpent(id), 2.5);
    assert.equal((await app.reviews.list(id, owner(app))).threads[0]!.resolved, false);
});

// The real model/tool loop must pull current work, not pretend the discussion snippet contains code/history.
test("shared PiP reads current thread, work metadata and code with app tools and accounts for every model response", async () => {
    const { id } = await app.commands.createSession(owner(app), {
        cwd: work,
        threadType: "chat",
        title: "Current work context",
    });
    const requester = guest();
    const privateId = await app.pip.ensure(owner(app));

    await app.commands.note(privateId, owner(app), "PRIVATE_TOOL_CONTEXT_CANARY");
    await app.commands.note(id, owner(app), "SOURCE_TRANSCRIPT_CANARY");
    writeFileSync(
        join(work, "current-context.ts"),
        "export const current = 'CURRENT_CODE_CANARY';\n",
    );
    const before = calls.length;
    let round = 0;
    let results = "";
    let continuedReasoning = false;

    response = (request) => {
        if (++round === 1) {
            app.pip.configureCollaborator(owner(app), {
                model: { provider: "faux", modelId: "faux-1" },
                thinkingLevel: "off",
                expectedRevision: app.config.pipCollaborator!.revision,
            });

            return fauxAssistantMessage(
                [
                    {
                        type: "thinking",
                        thinking: "SHARED_REASONING_NOT_PUBLIC",
                        thinkingSignature: "opaque-continuation",
                    },
                    fauxToolCall("work_context", { action: "thread" }),
                    fauxToolCall("work_context", { action: "status" }),
                    fauxToolCall("work_context", { action: "files", query: "current-context" }),
                    fauxToolCall("work_context", { action: "file", path: "current-context.ts" }),
                ],
                { stopReason: "toolUse" },
            );
        }

        results = JSON.stringify(
            request.messages.filter((message) => message.role === "toolResult"),
        );
        continuedReasoning = request.messages.some(
            (message) =>
                message.role === "assistant" &&
                message.content.some(
                    (part) =>
                        part.type === "thinking" &&
                        part.thinkingSignature === "opaque-continuation",
                ),
        );

        return fauxAssistantMessage("An answer based on the current work.");
    };

    try {
        const human = await posted(
            id,
            requester,
            "@PiP inspect the current implementation and thread",
        );

        assert.equal((await settled(id, human.id)).pip?.status, "answered");
        assert.equal(calls.length, before + 2);
        assert.ok(calls[before]!.tools.includes("work_context"));
        assert.match(calls[before]!.text, /Current work context/);
        assert.match(calls[before]!.text, /SOURCE_TRANSCRIPT_CANARY/);
        assert.ok(calls.slice(before).every((call) => call.model === "faux-2"));
        assert.equal(continuedReasoning, true);
        assert.doesNotMatch(JSON.stringify(await chat(id)), /SHARED_REASONING_NOT_PUBLIC/);
        assert.match(results, /SOURCE_TRANSCRIPT_CANARY/);
        assert.match(results, /CURRENT_CODE_CANARY/);
        assert.match(results, /current-context\.ts/);
        assert.doesNotMatch(results, /PRIVATE_TOOL_CONTEXT_CANARY/);
        assert.equal(app.spend.personSpent(requester.id), 2.5);
        assert.equal(app.spend.sessionSpent(id), 2.5);
        assert.equal((await job(id)).saved.responses, 2);
        assert.equal(calls[before + 1]!.sessionId, undefined);
        assert.deepEqual((await app.harness.snapshot(PipMentionsDoc, context))?.active, {});
    } finally {
        response = answer;
        app.pip.configureCollaborator(owner(app), {
            model: { provider: "faux", modelId: "faux-2" },
            thinkingLevel: "off",
            expectedRevision: app.config.pipCollaborator!.revision,
        });
    }
});

// A real owner may see private/foreign threads and host paths, but a shared answer must not inherit that power.
test("shared context tools reject foreign/private threads and escaped paths even for the owner", async () => {
    const id = await source();
    const foreign = await source();
    const privateId = await app.pip.ensure(owner(app));
    const outside = join(root, "outside-shared-code.ts");

    await app.commands.note(foreign, owner(app), "FOREIGN_THREAD_CANARY");
    writeFileSync(outside, "OUTSIDE_WORKSPACE_CANARY\n");
    symlinkSync(outside, join(work, "escaped-context.ts"));
    mkdirSync(join(work, ".ssh"), { recursive: true });
    const credentials = join(work, ".ssh", "credentials");

    writeFileSync(credentials, "PRIVATE_SSH_FILE_CANARY\n");
    symlinkSync(credentials, join(work, "credential-alias.txt"));
    let round = 0;
    let results: { isError: boolean; content: unknown }[] = [];

    response = (request) => {
        if (++round === 1) {
            return fauxAssistantMessage(
                [
                    fauxToolCall("work_context", { action: "thread", threadId: Number(foreign) }),
                    fauxToolCall("work_context", { action: "thread", threadId: Number(privateId) }),
                    fauxToolCall("work_context", { action: "file", path: outside }),
                    fauxToolCall("work_context", {
                        action: "file",
                        path: "../outside-shared-code.ts",
                    }),
                    fauxToolCall("work_context", { action: "file", path: "escaped-context.ts" }),
                    fauxToolCall("work_context", { action: "file", path: "private-context.txt" }),
                    fauxToolCall("work_context", { action: "file", path: "credential-alias.txt" }),
                ],
                { stopReason: "toolUse" },
            );
        }

        results = request.messages.filter((message) => message.role === "toolResult");

        return fauxAssistantMessage("Those sources are outside this shared work.");
    };

    try {
        // Even a shared thread deliberately rooted at private app/Pi configuration must not expose it.
        for (const cwd of [work, process.env.PI_CODING_AGENT_DIR!, app.dataDir]) {
            const sourceId =
                cwd === work
                    ? id
                    : (await app.commands.createSession(owner(app), { cwd, threadType: "chat" }))
                          .id;

            if (cwd !== work) {
                writeFileSync(join(cwd, "private-context.txt"), "PRIVATE_APP_FILE_CANARY\n");
            }

            round = 0;
            results = [];
            const human = await posted(sourceId);

            assert.equal((await settled(sourceId, human.id)).pip?.status, "answered");
            assert.equal(results.length, 7);
            assert.ok(results.every((result) => result.isError));
            assert.doesNotMatch(
                JSON.stringify(results),
                /FOREIGN_THREAD_CANARY|OUTSIDE_WORKSPACE_CANARY|PRIVATE_TOOL_CONTEXT_CANARY|PRIVATE_APP_FILE_CANARY|PRIVATE_SSH_FILE_CANARY/,
            );
        }
    } finally {
        response = answer;
    }
});

// Tool loops add spend, unlike free reads: both continuation spend and total work must remain bounded.
test("shared read loops stop at the model/read allowance or current requester budget", async () => {
    for (const boundary of ["model", "reads", "budget"]) {
        const id = await source();
        const requester = guest();
        const before = calls.length;

        if (boundary === "budget") {
            app.spend.setPersonBudget(owner(app), requester.id, 0.5);
        }

        response = () =>
            fauxAssistantMessage(
                Array.from({ length: boundary === "reads" ? 9 : 1 }, () =>
                    fauxToolCall("work_context", { action: "status" }),
                ),
                { stopReason: "toolUse" },
            );

        try {
            const human = await posted(id, requester);
            const done = await settled(id, human.id);
            const expected = boundary === "model" ? 4 : 1;

            assert.equal(done.pip?.status, "failed", boundary);
            assert.equal(calls.length, before + expected, boundary);
            assert.equal(app.spend.personSpent(requester.id), 1.25 * expected);
            assert.equal((await job(id)).saved.responses, expected);

            if (boundary === "model") {
                assert.deepEqual(calls.at(-1)!.tools, [], "the final response has no read tools");
            }

            assert.equal((await chat(id)).filter((message) => message.service === "pip").length, 0);
        } finally {
            response = answer;
        }
    }
});

// Hold the real app-owned read's completion, not the scope/authority guard or its returned contents.
test("revocation during a code read prevents forwarding the result or buying a continuation", async (t) => {
    const id = await source();
    const requester = guest();
    const original = app.sshSessions.withWorkspace.bind(app.sshSessions);
    const read = gate();
    const release = gate();
    const before = calls.length;

    writeFileSync(join(work, "revoked-read.ts"), "DO_NOT_FORWARD_AFTER_REVOCATION\n");
    t.mock.method(
        app.sshSessions,
        "withWorkspace",
        async (...args: Parameters<typeof original>) => {
            const result = await original(...args);

            read.release();
            await release.promise;

            return result;
        },
    );
    response = () =>
        fauxAssistantMessage(
            fauxToolCall("work_context", { action: "file", path: "revoked-read.ts" }),
            { stopReason: "toolUse" },
        );

    try {
        const human = await posted(id, requester);

        await read.promise;
        app.config.updateUser(requester.id, { role: "viewer" });
        release.release();
        assert.notEqual((await settled(id, human.id)).pip?.status, "answered");
        assert.equal(calls.length, before + 1);
        assert.equal(app.spend.personSpent(requester.id), 1.25);
        assert.doesNotMatch(JSON.stringify(await chat(id)), /DO_NOT_FORWARD_AFTER_REVOCATION/);
        assert.equal((await job(id)).saved.result?.text, undefined);
    } finally {
        release.release();
        t.mock.restoreAll();
        response = answer;
    }
});

// A distinct transport/sink contract: review replies preserve an existing range rather than starting a new thread.
test("review mentions reply in the same anchored discussion without resolving it or recursively invoking PiP", async () => {
    const id = await source();
    const requester = guest();

    writeFileSync(join(work, "shared-mention.ts"), "one\ntwo\nthree\n");
    const original = await app.reviews.comment(id, owner(app), {
        requestId: crypto.randomUUID(),
        path: "shared-mention.ts",
        side: "new",
        startLine: 2,
        line: 3,
        context: "two\nthree",
        text: "A human range finding.",
    });
    const before = calls.length;
    const question = await app.reviews.comment(id, requester, {
        requestId: crypto.randomUUID(),
        threadId: original.id,
        text: "@PiP explain the captured range",
    });

    await until(
        async () =>
            (await app.reviews.list(id, requester)).threads[0]?.replies.some(
                (item) => item.service === "pip",
            ) === true,
        "in-place review answer",
    );
    const thread = (await app.reviews.list(id, requester)).threads[0]!;
    const reply = thread.replies.find((item) => item.service === "pip")!;

    assert.equal(thread.id, original.id);
    assert.equal(thread.startLine, 2);
    assert.equal(thread.line, 3);
    assert.equal(thread.context, "two\nthree");
    assert.equal(thread.resolved, false);
    assert.equal(reply.name, "PiP");
    assert.equal(thread.replies.find((item) => item.id === question.id)?.pip?.replyId, reply.id);
    assert.equal(calls.length, before + 1);
    assert.match(calls.at(-1)!.text, /A human range finding/);
    assert.match(calls.at(-1)!.text, /two\\nthree/);
    assert.equal((await app.reviews.list(id, requester)).threads.length, 1);
});

// Highlighting has a separate byte-position contract from admission: never normalize the displayed Markdown.
test("shared mention highlighting preserves source bytes around nested code and prose", () => {
    const prefix =
        "😀\r\n- Example:\r\n\r\n      @PiP indented\r\n\r\n- `a\r\n  @PiP inline\r\n  b`\r\n\r\n";
    const suffix = "\r\n> @PiP quoted\r\n";
    const text = `${prefix}@PiP explain${suffix}`;
    const parts = pipMentionParts(text);

    assert.equal(parts.map((part) => part.text).join(""), text);
    assert.deepEqual(parts, [
        { text: prefix },
        { text: "@PiP", mention: true },
        { text: ` explain${suffix}` },
    ]);
});

// Negative controls reach the actual admission owner and still permit the ordinary discussion write.
test("non-invocations, viewers, turns, pause, missing selection and budgets cannot silently purchase replies", async () => {
    const id = await source();
    const requester = guest();
    const viewer = app.config.addUser(`Viewer ${++count}`, "viewer").user;
    const before = calls.length;

    for (const text of [
        "ordinary prose",
        "mail@pip.example",
        "@PiPExtra",
        "\\@PiP",
        "`@PiP` is an example",
        "Example:\n\n    @PiP example",
        "`a\n@PiP\nb`",
        "- Example:\n\n      @PiP example",
        "- `a\n  @PiP\n  b`",
        "    @PiP example",
        "@p`example`ip is not a literal mention",
        "> @PiP quoted\nNot another question",
        "```\n@PiP example\n```",
        "~~~\n@PiP example\n~~~",
        "````\n```\n@PiP still in code\n````",
        "```\n```not a closing fence\n@PiP still in code\n```",
    ]) {
        const message = await posted(id, requester, text);

        assert.equal(message.text, text.trimEnd());
        assert.equal(message.pip, undefined, text);
        const input = { text, requestId: crypto.randomUUID() };
        const review = await app.reviews.comment(id, requester, input);
        const thread = (await app.reviews.list(id, requester)).threads.find(
            (item) => item.id === review.id,
        )!;

        assert.equal(thread.text, text.trimEnd());
        assert.equal(thread.pip, undefined, `review: ${text}`);
        assert.deepEqual(
            await app.reviews.comment(id, requester, {
                ...input,
                requestId: ` ${input.requestId} `,
            }),
            review,
            "requestId whitespace still normalizes to the same replay receipt",
        );
    }

    for (const [text, expected] of [
        [" \n\t ", /empty|required/],
        ["x".repeat(4001), /limited to 4000/],
    ] as const) {
        await assert.rejects(posted(id, requester, text), expected);
        await assert.rejects(
            app.reviews.comment(id, requester, { text, requestId: crypto.randomUUID() }),
            expected,
        );
    }

    const denied = await posted(id, viewer);

    assert.deepEqual(denied.pip, { status: "unavailable", reason: "permission" });
    const review = await app.reviews.comment(id, viewer, {
        requestId: crypto.randomUUID(),
        text: "@PiP viewer question",
    });

    assert.equal(
        (await app.reviews.list(id, viewer)).threads.find((item) => item.id === review.id)?.pip
            ?.reason,
        "permission",
    );
    await app.collab.turns(id, owner(app), { action: "on" });
    assert.equal((await posted(id, requester)).pip?.reason, "turn");
    await app.collab.turns(id, owner(app), { action: "off" });
    await app.setPipEnabled(owner(app), false);
    assert.equal((await posted(id, requester)).pip?.reason, "paused");
    await app.setPipEnabled(owner(app), true);
    const unconfiguredModel = scriptedModel();
    const unconfigured = await openApp(unconfiguredModel, join(root, "mentions-unconfigured"));

    try {
        const fresh = await unconfigured.commands.createSession(owner(unconfigured), {
            cwd: work,
            threadType: "chat",
        });
        const unavailable = await unconfigured.collab.postChat(fresh.id, owner(unconfigured), {
            text: "@PiP no shared model selected",
            requestId: crypto.randomUUID(),
        });

        assert.equal(unavailable.pip?.reason, "model");
        assert.equal(unconfiguredModel.state.callCount, 0);
    } finally {
        await unconfigured.close();
    }

    app.spend.setPersonBudget(owner(app), requester.id, 0.5);
    // The already recorded real first answer exceeded this lower source limit.
    await app.spend.setSessionBudget(owner(app), id, 0.01);
    assert.equal(calls.length, before);
    const paid = await posted(id, requester, "@PiP one bounded answer");

    assert.equal((await settled(id, paid.id)).pip?.status, "answered");
    assert.equal(
        (await posted(id, requester, "@PiP cannot spend beyond that")).pip?.reason,
        "budget",
    );
    assert.equal(calls.length, before + 1);
});

// Returned provider content is data, never a source of executable tools or native publication claims.
test("shared results expose text only, bound output and context, and never execute provider tool claims", async () => {
    try {
        for (const decision of [
            fauxAssistantMessage(fauxToolCall("session_start", { message: "do not execute" }), {
                stopReason: "toolUse",
            }),
            fauxAssistantMessage(fauxToolCall("public_web", {}), { stopReason: "toolUse" }),
            fauxAssistantMessage(fauxToolCall("work_context", { action: "status" }), {
                stopReason: "length",
            }),
            fauxAssistantMessage("", {
                stopReason: "error",
                errorMessage: "PRIVATE_PROVIDER_PATH",
            }),
        ]) {
            const id = await source();
            const before = calls.length;

            response = decision;
            const requester = guest();
            const human = await posted(id, requester);

            assert.equal((await settled(id, human.id)).pip?.status, "failed");
            assert.equal(app.spend.personSpent(requester.id), 1.25);
            assert.equal((await job(id)).saved.responses, 1);
            assert.equal((await chat(id)).filter((item) => item.service === "pip").length, 0);
            assert.equal(calls.length, before + 1);
            assert.doesNotMatch(JSON.stringify(await chat(id)), /PRIVATE_PROVIDER_PATH/);
        }

        const id = await source();
        const requester = guest();

        response = Object.assign(
            fauxAssistantMessage([
                { type: "thinking", thinking: "PRIVATE_THINKING" },
                { type: "text", text: "Public answer mentioning @PiP is not another invocation." },
            ]),
            { pocketDiffComments: [{ threadId: "FORGED_NATIVE_REFERENCE" }] },
        );
        const before = calls.length;
        const human = await posted(id, requester);

        assert.equal((await settled(id, human.id)).pip?.status, "answered");
        assert.equal(calls.length, before + 1);
        assert.doesNotMatch(
            JSON.stringify(await chat(id)),
            /PRIVATE_THINKING|FORGED_NATIVE_REFERENCE/,
        );
        response = fauxAssistantMessage("A".repeat(6000));
        const long = await posted(id, requester, "@PiP long answer");

        await settled(id, long.id);
        const shortened = (await chat(id)).find((item) => item.replyTo?.id === long.id)!;

        assert.ok(shortened.text.length <= 4000);
        assert.match(shortened.text, /Reply shortened/);
        response = answer;
        await posted(id, requester, String.fromCharCode(1).repeat(4000));
        const question = `@PiP ${String.fromCharCode(1).repeat(3990)}`;
        const bounded = await posted(id, requester, question);

        assert.equal((await settled(id, bounded.id)).pip?.status, "answered");
        const sent = calls.at(-1)!.text;

        assert.ok(sent.length <= 32_000);
        assert.equal(JSON.parse(sent).question.text, question);
        assert.equal(JSON.parse(sent).omitted, true);
    } finally {
        response = answer;
    }
});

// The actual provider is held, not the authority or publication code. Existing source idle checks remain usable.
test("running mentions pin their model, do not block source idle, and suppress delivery after requester revocation", async () => {
    const id = await source();
    const requester = guest();
    const hold = gate();
    const before = calls.length;

    response = async (_request, options) => {
        await awaitWithContext(hold.promise, withAbortSignal(options!.signal!, context));

        return answer();
    };

    try {
        const human = await posted(id, requester, "@PiP held question");

        await until(() => calls.length > before, "registered provider dispatch");
        await app.harness.commit((tx) => app.workItems.requireIdle(tx, id), context);
        assert.equal(app.isBusy(id), false);
        app.pip.configureCollaborator(owner(app), {
            model: { provider: "faux", modelId: "faux-1" },
            thinkingLevel: "off",
            expectedRevision: app.config.pipCollaborator!.revision,
        });
        assert.equal((await job(id)).saved.selection.modelId, "faux-2");
        app.config.updateUser(requester.id, { role: "viewer" });
        hold.release();
        const done = await settled(id, human.id);

        assert.notEqual(done.pip?.status, "answered");
        assert.equal((await chat(id)).filter((item) => item.service === "pip").length, 0);
        assert.equal(calls.length, before + 1);
    } finally {
        hold.release();
        response = answer;
        app.pip.configureCollaborator(owner(app), {
            model: { provider: "faux", modelId: "faux-2" },
            thinkingLevel: "off",
            expectedRevision: app.config.pipCollaborator!.revision,
        });
    }
});

// If cancellation wins after the provider reported usage, accounting survives but no public text escapes.
test("PiP pause cancels independent work while retaining already reported usage", async () => {
    const id = await source();
    const requester = guest();
    const reported = gate();

    beforeCompletion = async (signal) => {
        reported.release();
        await new Promise<void>((resolve) => {
            if (signal?.aborted) {
                resolve();
            } else {
                signal?.addEventListener("abort", () => resolve(), { once: true });
            }
        });
    };

    const human = await posted(id, requester, "@PiP pause this reply");

    await reported.promise;
    await app.setPipEnabled(owner(app), false);
    assert.equal((await settled(id, human.id)).pip?.status, "interrupted");
    assert.equal((await chat(id)).filter((item) => item.service === "pip").length, 0);
    assert.equal(app.spend.personSpent(requester.id), 1.25);
    assert.equal(app.spend.sessionSpent(id), 1.25);
    const receipt = (await job(id)).saved;

    assert.equal(receipt.result?.usage.cost.total, 1.25);
    assert.equal(receipt.status, "interrupted");
    assert.equal(receipt.result?.text, undefined);
    beforeCompletion = undefined;
    await app.setPipEnabled(owner(app), true);
});

// Remote generation is not exactly-once: uncertain attempts must not regenerate after restart.
test("restart interrupts an uncertain provider attempt without automatic regeneration", async () => {
    const id = await source();
    const requester = guest();
    const hold = gate();
    const before = calls.length;

    response = async (_request, options) => {
        await awaitWithContext(hold.promise, withAbortSignal(options!.signal!, context));

        return answer();
    };

    const human = await posted(id, requester, "@PiP uncertain on restart");

    await until(() => calls.length > before, "pending provider attempt");
    await app.close();
    hold.release();
    response = answer;
    app = await openApp(model);
    const done = await settled(id, human.id);

    assert.equal(done.pip?.status, "interrupted");
    assert.equal(calls.length, before + 1);
    assert.equal((await chat(id)).filter((item) => item.service === "pip").length, 0);
    assert.equal(app.canSee(owner(app), (await job(id)).lane), false);
    const fresh = await posted(id, app.config.userById(requester.id)!, "@PiP explicitly ask again");

    assert.equal((await settled(id, fresh.id)).pip?.status, "answered");
    assert.equal(calls.length, before + 2);
});

// A saved response is local durable work: recovery delivers it without paying for another generation.
test("restart delivers a saved response once without another model call or duplicate charge", async (t) => {
    const id = await source();
    const requester = guest();
    const original = app.harness.commit.bind(app.harness);
    const saved = gate();
    let signal: AbortSignal | undefined;
    let waiting = false;
    const before = calls.length;

    response = (_request, options) => {
        signal = options?.signal;

        return answer();
    };

    t.mock.method(app.harness, "commit", async (...args: Parameters<typeof app.harness.commit>) => {
        const result = await original(...args);

        if (!waiting && signal) {
            const index = await app.harness.snapshot(PipMentionsDoc, context);
            const active = Object.entries(index?.active ?? {}).find(
                ([, entry]) => entry.source === Number(id),
            );
            const record =
                active &&
                (await app.harness.snapshot(PipMentionJobDoc, id, active[0], context))?.job;

            if (record?.status === "ready") {
                waiting = true;
                saved.release();
                await awaitWithContext(
                    new Promise<void>(() => {}),
                    withAbortSignal(signal, context),
                );
            }
        }

        return result;
    });
    const human = await posted(id, requester, "@PiP saved result on restart");

    await saved.promise;
    await app.close();
    t.mock.restoreAll();
    response = answer;
    app = await openApp(model);
    assert.equal((await settled(id, human.id)).pip?.status, "answered");
    assert.equal((await chat(id)).filter((item) => item.service === "pip").length, 1);
    assert.equal(calls.length, before + 1);
    assert.equal(app.spend.personSpent(requester.id), 1.25);
    assert.equal(app.spend.sessionSpent(id), 1.25);
    const { record } = await job(id);

    await app.harness.waitForTask(record.id as TaskId, context);
    assert.deepEqual((await app.harness.snapshot(PipMentionsDoc, context))?.active, {});
});

// Hold only the completed provider response; policy and source changes go through their real owners.
test("late turn changes and evicted sources suppress delivery while retaining reported usage", async () => {
    for (const change of ["turn", "eviction"]) {
        const id = await source();
        const requester = guest();
        const reported = gate();
        const deliver = gate();

        beforeCompletion = async () => {
            reported.release();
            await deliver.promise;
        };

        try {
            await posted(id, requester);
            await reported.promise;

            if (change === "turn") {
                await app.collab.turns(id, owner(app), { action: "on" });
            } else {
                for (let i = 0; i < 501; i++) {
                    await posted(id, owner(app), `Later discussion ${i}`);
                }
            }

            deliver.release();
            const { record } = await job(id);

            await app.harness.waitForTask(record.id as TaskId, context);
            assert.equal(
                (await job(id)).saved.status,
                "failed",
                `delivery must stop after ${change}`,
            );
            assert.equal((await chat(id)).filter((item) => item.service === "pip").length, 0);
            assert.equal(app.spend.personSpent(requester.id), 1.25);
            assert.equal(app.spend.sessionSpent(id), 1.25);
        } finally {
            deliver.release();
            beforeCompletion = undefined;
        }
    }
});

// A first lane is not in the visibility cache until commit. Queue ordinary reads against that real admission.
test("guessed lane IDs stay private while their first admission commits", async (t) => {
    const isolated = await openApp(model, join(root, "mentions-lane-race"));
    const created = gate();
    const release = gate();
    let lane: ConversationId | undefined;

    try {
        isolated.pip.configureCollaborator(owner(isolated), {
            model: { provider: "faux", modelId: "faux-2" },
            thinkingLevel: "off",
            expectedRevision: 0,
        });
        const { id } = await isolated.commands.createSession(owner(isolated), {
            cwd: work,
            threadType: "chat",
        });
        const original = isolated.harness.commit.bind(isolated.harness);

        t.mock.method(
            isolated.harness,
            "commit",
            async (...args: Parameters<typeof isolated.harness.commit>) =>
                original(async (tx) => {
                    const result = await args[0](tx);
                    const index = await tx.doc(PipMentionsDoc);

                    if (!lane && index.lane) {
                        lane = index.lane as ConversationId;
                        created.release();
                        await release.promise;
                    }

                    return result;
                }, args[1]),
        );
        const posting = isolated.collab.postChat(id, owner(isolated), {
            text: "@PiP first admission",
            requestId: crypto.randomUUID(),
        });

        await created.promise;
        assert.ok(lane);
        const probes = [isolated.conversation(lane), isolated.room(lane)].map((probe) =>
            probe.then(
                () => "exposed",
                (error: { status: number }) => error.status,
            ),
        );

        release.release();
        await posting;
        assert.deepEqual(await Promise.all(probes), [404, 404]);
        assert.equal(isolated.canSee(owner(isolated), lane), false);
    } finally {
        release.release();
        t.mock.restoreAll();
        await isolated.close();
    }
});
