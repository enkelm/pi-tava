import type { Api, AssistantMessage, Model, ProviderHeaders } from "@earendil-works/pi-ai";

/** The host is a trusted-code boundary, not a sandbox. No provider diagnostics cross IPC. */
export type HostConfiguration = {
    packageRoot: string;
    agentDir: string;
    authPath: string;
    profile: "litellm" | "native";
    providerIds?: string[];
    cwd: string;
    sessionId: string;
    restoreOnly: boolean;
};

export type ProviderDescription = {
    id: string;
    name: string;
    baseUrl?: string;
    headers?: ProviderHeaders;
    models: Model<Api>[];
    apiKeyName: string;
    check: boolean;
    login: boolean;
    refresh: boolean;
    filter: boolean;
};

export type WireMessage = {
    kind:
        "request" | "reply" | "callback" | "callbackReply" | "callbackCancel" | "event" | "cancel";
    id: number;
    op?: string;
    data?: any;
    token?: number;
    failed?: boolean;
};

export const STARTUP_TIMEOUT_MS = 30_000;
export const OPERATION_TIMEOUT_MS = 120_000;
export const REQUEST_TIMEOUT_MS = 600_000;

export function failureMessage(
    model: Model<Api>,
    aborted: boolean,
    message: string,
): AssistantMessage {
    return {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [],
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: aborted ? "aborted" : "error",
        errorMessage: message,
        timestamp: Date.now(),
    };
}

export const SERIALIZATION_ERROR =
    "Provider host requires JSON-serializable options/context; custom fetch/functions are unsupported";

export function assertSerializable(value: unknown): void {
    try {
        JSON.stringify(value, (_key, item) => {
            if (
                typeof item === "function" ||
                typeof item === "symbol" ||
                typeof item === "bigint" ||
                (typeof item === "number" && !Number.isFinite(item)) ||
                (item &&
                    typeof item === "object" &&
                    !Array.isArray(item) &&
                    Object.getPrototypeOf(item) !== Object.prototype &&
                    Object.getPrototypeOf(item) !== null)
            ) {
                throw new Error(SERIALIZATION_ERROR);
            }

            return item;
        });
    } catch {
        throw new Error(SERIALIZATION_ERROR);
    }
}
