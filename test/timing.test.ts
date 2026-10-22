/** Measuring a model's stream for the footer's speed must never hold back its result. */
import assert from "node:assert/strict";
import test from "node:test";
import {
    type AssistantMessage,
    type AssistantMessageEventStream,
    createAssistantMessageEventStream,
    normalizeContext,
} from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { measureModelStreams } from "../src/server/timing.ts";
import { DiagnosticRecorder, type DiagnosticRecord } from "../src/server/diagnostics/recorder.ts";

function message(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: text === "" ? [] : [{ type: "text", text }],
        api: "faux",
        provider: "faux",
        model: "faux-1",
        usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
    };
}

/** A model runtime whose one stream `script` drives. */
function runtime(script: (stream: AssistantMessageEventStream) => Promise<void>) {
    const models = {
        streamSimple: () => {
            const stream = createAssistantMessageEventStream();

            void script(stream);

            return stream;
        },
    };

    measureModelStreams(models as never);

    return models.streamSimple as unknown as () => AssistantMessageEventStream;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a measured stream that ends without a terminal event still gives its result", async () => {
    const final = message("hi");
    const stream = runtime(async (source) => {
        source.push({ type: "start", partial: message("") });
        source.end(final);
    })();

    const consumed = (async () => {
        for await (const event of stream) {
            assert.equal(event.type, "start");
        }

        return stream.result();
    })();
    const result = await Promise.race([consumed, pause(1000).then(() => "hung")]);

    assert.equal(result, final);
});

test("provider diagnostics retain context and terminal outcomes without changing stream results or throws", async (t) => {
    const model = fauxProvider().getModel();
    const secret = "PRIVATE-provider-prompt-error-response";

    for (const mode of [
        "ok",
        "provider-error",
        "aborted",
        "sync-throw",
        "observer-fault",
    ] as const) {
        await t.test(mode, async () => {
            const records: DiagnosticRecord[] = [];
            const recorder = new DiagnosticRecorder((record) => {
                records.push(record);

                if (mode === "observer-fault") {
                    throw new Error(secret);
                }
            });
            const final = message(secret);
            const fault = Object.assign(new Error(secret), { code: "ECONNRESET" });
            let calls = 0;
            const models: Parameters<typeof measureModelStreams>[0] = {
                streamSimple() {
                    calls++;

                    if (mode === "sync-throw") {
                        throw fault;
                    }

                    const stream = createAssistantMessageEventStream();

                    if (mode === "provider-error" || mode === "aborted") {
                        final.stopReason = mode === "aborted" ? "aborted" : "error";
                        final.errorMessage = secret;
                        stream.push({ type: "error", reason: final.stopReason, error: final });
                    } else {
                        stream.push({ type: "done", reason: "stop", message: final });
                    }

                    return stream;
                },
            };

            measureModelStreams(models, recorder);
            const result = recorder.observe(
                {
                    conversationId: 17,
                    taskId: 23,
                    component: "runtime",
                    stage: "phase",
                    operation: "pi.generation",
                },
                async () => {
                    const stream = models.streamSimple(
                        model,
                        normalizeContext({ messages: [], systemPrompt: secret }),
                    );
                    const events = [];

                    for await (const event of stream) {
                        events.push(event);
                    }

                    assert.equal(events.length, 1);
                    assert.equal(events[0]!.type, final.stopReason === "stop" ? "done" : "error");

                    return stream.result();
                },
            );

            if (mode === "sync-throw") {
                await assert.rejects(result, (error) => error === fault);
            } else {
                assert.equal(
                    await result,
                    final,
                    "observer preserves the provider's terminal result identity",
                );
            }

            const provider = records.find(
                (record) => record.component === "provider" && record.endedAt !== undefined,
            )!;
            const parent = records.find((record) => record.component === "runtime")!;

            assert.ok(provider);
            assert.equal(provider.conversationId, 17);
            assert.equal(provider.taskId, 23);
            assert.equal(provider.parentId, parent.id);
            assert.equal(provider.provider, model.provider);
            assert.equal(provider.model, model.id);
            assert.equal(
                provider.outcome,
                mode === "aborted"
                    ? "cancelled"
                    : mode === "provider-error" || mode === "sync-throw"
                      ? "failure"
                      : "ok",
            );
            assert.equal(
                provider.cause,
                mode === "aborted"
                    ? "aborted"
                    : mode === "provider-error"
                      ? "provider_error"
                      : mode === "sync-throw"
                        ? "transport"
                        : "none",
            );
            assert.equal(calls, 1, "diagnostic faults never replay the provider request");
            assert.equal(JSON.stringify(records).includes(secret), false);

            if (mode === "observer-fault") {
                assert.equal(recorder.dropped, 4);
            }
        });
    }
});
