import { readFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import {
    createProvider,
    createAssistantMessageEventStream,
    type Model,
    type Api,
    type AssistantMessage,
} from "@earendil-works/pi-ai";
import * as hostAi from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fixtureModel } from "./metadata.js";

export default async function fixture(pi: ExtensionAPI) {
    const { fixture: settings } = JSON.parse(
        await readFile(join(getAgentDir(), "settings.json"), "utf8"),
    );

    // Official Pi extensions receive the public compatibility surface through the root alias.
    if (settings.activationPath) {
        await appendFile(settings.activationPath, `${process.pid}\n`);
    }

    const api = (hostAi as typeof import("@earendil-works/pi-ai/compat")).openAICompletionsApi();
    const pending = new Map<string, number>();
    const models = [
        fixtureModel(settings.baseUrl),
        fixtureModel(settings.baseUrl, "fixture-physical"),
    ];

    const diagnosticStream = (model: Model<Api>) => {
        const stream = createAssistantMessageEventStream();
        const message: AssistantMessage = {
            role: "assistant",
            api: model.api,
            model: model.id,
            provider: model.provider,
            content: [{ type: "text", text: "ordinary successful content" }],
            timestamp: Date.now(),
            stopReason: "stop",
            errorMessage: "temporary-test-key credential URL https://secret.invalid",
            usage: {
                input: 4,
                output: 6,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 10,
                cost: { input: 0.4, output: 0.6, cacheRead: 0, cacheWrite: 0, total: 1 },
            },
        };

        Object.assign(message, { diagnostics: [{ message: "temporary-test-key" }] });
        stream.push({ type: "start", partial: message });

        if (settings.failure === "result-only-error") {
            message.stopReason = "error";
            message.content = [{ type: "text", text: "temporary-test-key error body" }];
            stream.end(message); // The queued start shares the now-failed native object.
        } else {
            stream.push({ type: "done", reason: "stop", message });
            stream.end();
        }

        return stream;
    };

    pi.registerProvider(
        createProvider({
            id: "fixture-provider",
            name: "Synthetic provider",
            models,
            api: ["result-only-error", "partial-diagnostics"].includes(settings.failure)
                ? { stream: diagnosticStream, streamSimple: diagnosticStream }
                : api,
            auth: {
                apiKey: {
                    name: "Fixture API key",
                    check: async ({ credential }) =>
                        credential?.key ? { type: "api_key", source: "fixture" } : undefined,
                    resolve: async ({ credential, ctx }) => {
                        const extra = await ctx.env("FIXTURE_AUTH_HEADER");

                        return credential?.key
                            ? {
                                  auth: {
                                      apiKey: credential.key,
                                      headers: { "x-fixture-auth": extra ?? "none" },
                                  },
                              }
                            : undefined;
                    },
                    login: async (interaction) => {
                        interaction.notify({
                            type: "progress",
                            message: "Enter fixture credentials",
                        });
                        const key = await interaction.prompt({
                            type: "secret",
                            message: "Fixture key",
                            signal: interaction.signal,
                        });

                        return { type: "api_key", key };
                    },
                },
            },
        }),
    );
    pi.on("before_provider_headers", (event, ctx) => {
        if (settings.failure === "headers") {
            throw new Error("Do not leak secret: temporary-test-key");
        }

        event.headers["x-fixture-session"] = ctx.sessionManager.getSessionId();
        event.headers["x-fixture-model"] = ctx.model!.id;
        event.headers["x-fixture-pid"] = String(process.pid);
    });
    pi.on("before_provider_request", (event) => {
        if (settings.failure === "payload") {
            throw new Error("Policy rejected");
        }

        return { ...(event.payload as object), fixture_policy: "applied-last" };
    });
    pi.on("after_provider_response", (event, ctx) => {
        pending.set(ctx.model!.provider, Number(event.headers["x-fixture-cost"]));

        if (settings.failure === "response") {
            throw new Error("Accounting response rejected");
        }
    });
    pi.on("message_end", (event) => {
        if (event.message.role !== "assistant") {
            return;
        }

        if (settings.failure === "result-only-error") {
            return {
                message: {
                    ...event.message,
                    errorMessage: "transformed temporary-test-key",
                    content: [{ type: "text", text: "transformed temporary-test-key" }],
                },
            };
        }

        if (settings.failure === "terminal") {
            throw new Error("Accounting finalization rejected");
        }

        const message = event.message;
        const total = pending.get(message.provider) ?? 0;

        pending.delete(message.provider);

        return {
            message: {
                ...message,
                content: [{ type: "text", text: "first-replacement" }],
                usage: {
                    ...message.usage,
                    cost: {
                        input: total / 2,
                        output: total / 2,
                        cacheRead: 0,
                        cacheWrite: 0,
                        total: settings.failure === "malformed" ? Number.NaN : total,
                    },
                },
            },
        };
    });
    pi.on("message_end", (event, ctx) => {
        if (settings.failure === "result-only-error" || event.message.role !== "assistant") {
            return;
        }

        const found = ctx.modelRegistry.find(event.message.provider, event.message.model);
        const first = event.message.content[0];

        return {
            message: {
                ...event.message,
                content: [
                    {
                        type: "text",
                        text: `${first?.type === "text" ? first.text : "wrong"}:${found!.id}`,
                    },
                ],
            },
        };
    });
    pi.on("session_shutdown", async () => {
        if (settings.shutdownPath) {
            await appendFile(settings.shutdownPath, `${process.pid}\n`);
        }
    });

    if (settings.failure === "unsupported") {
        pi.on("before_agent_start", () => undefined);
    }
}
