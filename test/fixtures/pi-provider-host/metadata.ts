import type { Model } from "@earendil-works/pi-ai";

export function fixtureModel(baseUrl: string, id = "fixture-chat"): Model<"openai-completions"> {
    return {
        id,
        provider: "fixture-provider",
        name: id,
        api: "openai-completions",
        baseUrl,
        reasoning: false,
        input: ["text"],
        cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 10000,
        maxTokens: 100,
    };
}
