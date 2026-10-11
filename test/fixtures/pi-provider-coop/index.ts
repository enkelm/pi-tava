/** Synthetic native provider: no network, ordinary public Pi extension entry. */
import {
    createAssistantMessageEventStream,
    createProvider,
    type AssistantMessage,
    type Model,
    type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function coopFixture(pi: ExtensionAPI) {
    const model: Model<string> = {
        api: "coop-fixture-chat",
        provider: "litellm",
        id: "coop-fixture",
        name: "Coop fixture",
        baseUrl: "https://fixture.invalid",
        reasoning: false,
        input: ["text"],
        contextWindow: 128000,
        maxTokens: 8192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };

    const stream = (physical: Model<string>, _context: unknown, options?: SimpleStreamOptions) => {
        const events = createAssistantMessageEventStream();

        queueMicrotask(async () => {
            await options?.onResponse?.({ status: 200, headers: {} }, physical);

            const message: AssistantMessage = {
                role: "assistant",
                api: physical.api,
                provider: physical.provider,
                model: physical.id,
                content: [{ type: "text", text: "untransformed" }],
                stopReason: "stop",
                timestamp: Date.now(),
                usage: {
                    input: 1,
                    output: 1,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 2,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
            };

            events.push({ type: "done", reason: "stop", message });
            events.end(message);
        });

        return events;
    };

    pi.registerProvider(
        createProvider({
            id: "litellm",
            name: "Coop fixture provider",
            auth: { apiKey: { name: "Synthetic key", resolve: async () => ({ auth: {} }) } },
            models: [model],
            api: { stream, streamSimple: stream },
        }),
    );
    pi.on("message_end", (event, context) => {
        if (event.message.role !== "assistant") {
            return;
        }

        return {
            message: {
                ...event.message,
                content: [{ type: "text", text: `hosted:${context.model!.id}` }],
                usage: {
                    ...event.message.usage,
                    cost: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, total: 3 },
                },
            },
        };
    });
}
