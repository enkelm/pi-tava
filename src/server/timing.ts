/**
 * Stream timing for the footer's speed metrics: every model stream is wrapped so its terminal message carries when
 * the request started, when the first token arrived, and when the stream ended. `projectStats` reads that stamp off
 * the conversation's newest response and turns it into tokens per second and time to first token.
 */
import {
    createAssistantMessageEventStream,
    type Api,
    type AssistantMessage,
    type AssistantMessageEventStream,
    type Model,
    type SimpleStreamOptions,
    type TranscriptContext,
} from "@earendil-works/pi-ai";
import { diagnosticError, type DiagnosticRecorder } from "./diagnostics/recorder.ts";

/** Timing stamped onto a terminal provider message: plain numbers, so it survives the entry's JSON copy. */
export type StreamTiming = { startedAt: number; endedAt: number; firstTokenAt?: number };
type Measured = AssistantMessage & { pocketTiming?: StreamTiming };
type StreamSimple = (
    model: Model<Api>,
    context: TranscriptContext,
    options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

/** Wrap the model runtime's `streamSimple` in place, so every generation and compaction stream is measured. */
export function measureModelStreams(
    models: { streamSimple: StreamSimple },
    recorder?: DiagnosticRecorder,
): void {
    const underlying = models.streamSimple.bind(models);

    models.streamSimple = (model, context, options) => {
        try {
            return forwardMeasured(model, underlying(model, context, options), recorder);
        } catch (error) {
            const parent = recorder?.current();

            if (parent !== undefined) {
                void recorder!
                    .observe(
                        {
                            conversationId: parent.conversationId,
                            taskId: parent.taskId,
                            component: "provider",
                            stage: "response",
                            operation: "streamSimple",
                            provider: model.provider,
                            model: model.id,
                        },
                        async () => {
                            throw error;
                        },
                    )
                    .catch(() => {});
            }

            throw error;
        }
    };
}

/** Forward one stream, stamping the timing onto its terminal message. The consumer keeps its shape. */
function forwardMeasured(
    model: Model<Api>,
    stream: AssistantMessageEventStream,
    recorder?: DiagnosticRecorder,
): AssistantMessageEventStream {
    const measured = createAssistantMessageEventStream();
    const startedAt = Date.now();
    let firstTokenAt: number | undefined;

    const forward = async (): Promise<AssistantMessage> => {
        try {
            for await (const event of stream) {
                if ("partial" in event && event.partial.content.length > 0) {
                    firstTokenAt ??= Date.now();
                }

                if (event.type === "done" || event.type === "error") {
                    const message = event.type === "done" ? event.message : event.error;

                    (message as Measured).pocketTiming = stamp(startedAt, firstTokenAt);
                }

                measured.push(event);
            }

            // A stream that ends without a terminal event ends the forward the same way, with its result: the
            // generation waits on that result. After a terminal event this changes nothing.
            const result = await stream.result();

            measured.end(result);

            return result;
        } catch (error) {
            // The stream broke without a terminal event: end the forward with one, so the waiting generation does not hang.
            const message = {
                role: "assistant",
                content: [],
                api: model.api,
                provider: model.provider,
                model: model.id,
                usage: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 0,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: "error",
                errorMessage: String(error),
                timestamp: startedAt,
            } as AssistantMessage;

            (message as Measured).pocketTiming = stamp(startedAt, firstTokenAt);
            measured.push({ type: "error", reason: "error", error: message });

            return message;
        }
    };

    const parent = recorder?.current();

    if (parent === undefined) {
        void forward();
    } else {
        void recorder!
            .observe(
                {
                    conversationId: parent.conversationId,
                    taskId: parent.taskId,
                    operationId:
                        parent.taskId === undefined ? undefined : `${parent.taskId}/provider`,
                    component: "provider",
                    stage: "response",
                    operation: "streamSimple",
                    provider: model.provider,
                    model: model.id,
                },
                forward,
                (message) =>
                    message.stopReason === "aborted"
                        ? { outcome: "cancelled", cause: "aborted" }
                        : message.stopReason === "error"
                          ? { ...diagnosticError(message), cause: "provider_error" }
                          : { outcome: "ok", cause: "none" },
            )
            .catch(() => {});
    }

    return measured;
}

function stamp(startedAt: number, firstTokenAt: number | undefined): StreamTiming {
    const timing: StreamTiming = { startedAt, endedAt: Date.now() };

    if (firstTokenAt !== undefined) {
        timing.firstTokenAt = firstTokenAt;
    }

    return timing;
}
