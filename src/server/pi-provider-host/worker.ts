import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
    discoverAndLoadExtensions,
    ExtensionRunner,
    ModelRegistry,
    ModelRuntime,
    SessionManager,
} from "@earendil-works/pi-coding-agent";
import { isContextOverflow, isRetryableAssistantError } from "@earendil-works/pi-ai";
import type {
    Api,
    Model,
    Provider,
    ProviderHeaders,
    AssistantMessage,
    ApiKeyCredential,
} from "@earendil-works/pi-ai";
import { assertSerializable, type HostConfiguration, type WireMessage } from "./protocol.ts";
import { CatalogModelsStore, type CatalogSnapshot } from "./models-store.ts";

const configuration: HostConfiguration = JSON.parse(process.env.PI_PROVIDER_HOST_CONFIG!);
const providers = new Map<string, Provider>();
const callbacks = new Map<number, { resolve: (data: any) => void; reject: () => void }>();
let callbackToken = 0;
let runner: ExtensionRunner | undefined;
let runtime: ModelRuntime;
let modelsStore: CatalogModelsStore;
let model: Model<Api> | undefined;
let controller: AbortController | undefined;
let requestId = 0;
let fingerprint = "";
let stage = "initialization";
let hookError = false;

let capabilityGuard = () => {};

let shutdown = false;
let queue = Promise.resolve();

function send(message: WireMessage): void {
    if (process.connected) {
        process.send!(message);
    }
}

function unsupported(): never {
    throw new Error("Unsupported provider-host capability");
}

function gate(): void {
    capabilityGuard();

    if (hookError) {
        throw new Error("Critical extension hook failed");
    }

    if (controller?.signal.aborted) {
        throw new Error("Aborted");
    }
}

async function callback(op: string, data: any, signal?: AbortSignal): Promise<any> {
    signal?.throwIfAborted();
    const id = requestId;
    const token = ++callbackToken;

    return new Promise((resolve, reject) => {
        const abort = () => {
            callbacks.delete(token);
            send({ kind: "callbackCancel", id, token });
            reject(new Error("Callback aborted"));
        };

        const dispose = () => signal?.removeEventListener("abort", abort);

        signal?.addEventListener("abort", abort, { once: true });
        callbacks.set(token, {
            resolve: (value) => {
                dispose();
                resolve(value);
            },
            reject: () => {
                dispose();
                reject(new Error("Callback failed"));
            },
        });
        send({ kind: "callback", id, token, op, data });
    });
}

function noCommands(value: unknown): void {
    if (typeof value === "string" && value.trimStart().startsWith("!")) {
        throw new Error("Command-valued credentials/configuration are unsupported");
    }

    if (value && typeof value === "object") {
        for (const child of Object.values(value)) {
            noCommands(child);
        }
    }
}

async function preflight(): Promise<{ settings: any; manifest: any }> {
    const settingsText = await readFile(join(configuration.agentDir, "settings.json"), "utf8");
    const manifestText = await readFile(join(configuration.packageRoot, "package.json"), "utf8");
    const settings = JSON.parse(settingsText);
    const manifest = JSON.parse(manifestText);
    let auth: Record<string, any>;

    try {
        auth = JSON.parse(await readFile(configuration.authPath, "utf8"));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
        }

        auth = {};
    }

    if (
        !settings ||
        typeof settings !== "object" ||
        Array.isArray(settings) ||
        !manifest.pi?.extensions?.length
    ) {
        throw new Error("Invalid dedicated settings/package manifest");
    }

    for (const resource of ["skills", "prompts", "themes"]) {
        if (manifest.pi[resource]?.length) {
            unsupported();
        }
    }

    let ids = configuration.providerIds;

    if (configuration.profile === "litellm") {
        if (manifest.name !== "pi-provider-litellm" || manifest.version !== "4.2.0") {
            throw new Error("Unsupported LiteLLM compatibility profile version");
        }

        for (const feature of ["skills", "mcp", "budget"]) {
            if (settings.litellm?.[feature]?.enabled !== false) {
                throw new Error("LiteLLM optional gateways must be explicitly disabled");
            }
        }

        noCommands(settings.litellm);
        ids = ["litellm", ...Object.keys(settings.litellm.providers ?? {})];
    }

    for (const [id, credential] of Object.entries(auth)) {
        if (!ids || ids.includes(id)) {
            if (credential?.type === "oauth") {
                throw new Error("Stored OAuth is unsupported by this API-key host");
            }

            noCommands(credential);
        }
    }

    const hash = createHash("sha256").update(settingsText).update(manifestText).digest("hex");

    if (fingerprint && fingerprint !== hash) {
        throw new Error("Provider configuration changed; rebuild required");
    }

    fingerprint = hash;

    return { settings, manifest };
}

function validateHeaders(headers: unknown): asserts headers is ProviderHeaders {
    if (
        !headers ||
        typeof headers !== "object" ||
        Array.isArray(headers) ||
        Object.values(headers).some((value) => value !== null && typeof value !== "string")
    ) {
        throw new Error("Invalid critical header transform");
    }
}

function validateFinal(
    message: unknown,
    physical: Model<Api>,
): asserts message is AssistantMessage {
    const final = message as AssistantMessage;

    if (
        !final ||
        final.role !== "assistant" ||
        final.provider !== physical.provider ||
        final.model !== physical.id ||
        final.api !== physical.api ||
        !Array.isArray(final.content) ||
        !["stop", "length", "toolUse", "error", "aborted"].includes(final.stopReason) ||
        !final.usage ||
        !final.usage.cost ||
        typeof final.timestamp !== "number" ||
        !Number.isFinite(final.timestamp)
    ) {
        throw new Error("Invalid final assistant message");
    }

    for (const value of [
        final.usage.input,
        final.usage.output,
        final.usage.cacheRead,
        final.usage.cacheWrite,
        final.usage.totalTokens,
        final.usage.cost.input,
        final.usage.cost.output,
        final.usage.cost.cacheRead,
        final.usage.cost.cacheWrite,
        final.usage.cost.total,
    ]) {
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
            throw new Error("Invalid final usage accounting");
        }
    }

    for (const part of final.content) {
        if (
            !part ||
            (part.type === "text"
                ? typeof part.text !== "string"
                : part.type === "thinking"
                  ? typeof part.thinking !== "string"
                  : part.type === "toolCall"
                    ? typeof part.id !== "string" ||
                      typeof part.name !== "string" ||
                      !part.arguments ||
                      typeof part.arguments !== "object" ||
                      Array.isArray(part.arguments)
                    : true)
        ) {
            throw new Error("Invalid final assistant content");
        }
    }

    assertSerializable(final);
}

function safeErrorMessage(message: AssistantMessage): string {
    if (isContextOverflow(message)) {
        return "Provider context_length_exceeded; remote outcome may be unknown";
    }

    if (isRetryableAssistantError(message)) {
        return "Provider transient rate limit or network error; remote outcome may be unknown";
    }

    return "Provider request failed; remote outcome may be unknown";
}

function sanitizeMessage(final: AssistantMessage, diagnostic?: string): AssistantMessage {
    const failed = final.stopReason === "error" || final.stopReason === "aborted";
    const usage = final.usage;
    const safe: AssistantMessage = failed
        ? {
              role: "assistant",
              api: final.api,
              provider: final.provider,
              model: final.model,
              timestamp: final.timestamp,
              durationMs: final.durationMs,
              stopReason: final.stopReason,
              content: [],
              usage: {
                  input: usage.input,
                  output: usage.output,
                  cacheRead: usage.cacheRead,
                  cacheWrite: usage.cacheWrite,
                  totalTokens: usage.totalTokens,
                  cost: {
                      input: usage.cost.input,
                      output: usage.cost.output,
                      cacheRead: usage.cost.cacheRead,
                      cacheWrite: usage.cost.cacheWrite,
                      total: usage.cost.total,
                  },
              },
              errorMessage:
                  final.stopReason === "aborted"
                      ? "Provider request aborted"
                      : (diagnostic ?? safeErrorMessage(final)),
          }
        : { ...final, errorMessage: undefined, diagnostics: undefined, rawStopReason: undefined };

    return safe;
}

function sendTerminal(final: AssistantMessage, diagnostic?: string): void {
    const safe = sanitizeMessage(final, diagnostic);
    const failed = safe.stopReason === "error" || safe.stopReason === "aborted";

    send({
        kind: "event",
        id: requestId,
        data: failed
            ? { type: "error", reason: safe.stopReason, error: safe }
            : { type: "done", reason: safe.stopReason, message: safe },
    });
}

async function catalog() {
    const snapshot = await modelsStore.snapshot();

    for (const provider of providers.values()) {
        snapshot.entries[provider.id] = {
            ...snapshot.entries[provider.id],
            models: provider.getModels(),
        };
    }

    return {
        snapshot,
        fingerprint,
        providers: [...providers.values()].map((provider) => ({
            id: provider.id,
            name: provider.name,
            baseUrl: provider.baseUrl,
            headers: provider.headers,
            models: provider.getModels(),
            apiKeyName: provider.auth.apiKey!.name,
            login: !!provider.auth.apiKey!.login,
            check: !!provider.auth.apiKey!.check,
            refresh: !!provider.refreshModels,
            filter: !!provider.filterModels,
        })),
    };
}

async function initialize(data: {
    snapshot?: CatalogSnapshot;
}): Promise<Awaited<ReturnType<typeof catalog>>> {
    stage = "configuration validation";
    await preflight();
    await mkdir(join(configuration.cwd, "discovery"));
    stage = "public extension loading";
    const loaded = await discoverAndLoadExtensions(
        [configuration.packageRoot],
        configuration.cwd,
        join(configuration.cwd, "discovery"),
    );

    if (loaded.errors.length || !loaded.extensions.length) {
        if (loaded.errors.some((error) => /Cannot find module|Package subpath/.test(error.error))) {
            stage = "public extension loading (SDK import resolution)";
        }

        throw new Error("Public extension loader failed");
    }

    stage = "extension capability validation";
    const allowed = new Set([
        "session_start",
        "session_shutdown",
        "before_provider_headers",
        "before_provider_request",
        "after_provider_response",
        "provider_stream_event",
        "message_end",
    ]);

    if (configuration.profile === "litellm") {
        allowed.add("before_agent_start"); // Pinned LiteLLM disabled-skills callback is inert.
    }

    capabilityGuard = () => {
        for (const extension of loaded.extensions) {
            if (
                extension.tools.size ||
                extension.shortcuts.size ||
                extension.flags.size ||
                extension.messageRenderers.size ||
                extension.entryRenderers?.size ||
                extension.toolRenderers?.length ||
                extension.markdownTransformer ||
                [...extension.handlers.keys()].some((event) => !allowed.has(event))
            ) {
                unsupported();
            }
        }

        if (loaded.runtime.mcpServers.list().length) {
            unsupported();
        }
    };

    capabilityGuard();

    const accepted =
        data.snapshot?.fingerprint === fingerprint ? data.snapshot : { fingerprint, entries: {} };

    // An auth-only empty cache must not mask fresh factory discovery after credentials arrive.
    modelsStore = new CatalogModelsStore(join(configuration.cwd, "models-store.json"), {
        fingerprint,
        entries: Object.fromEntries(
            Object.entries(accepted.entries).filter(([, entry]) => entry.models.length > 0),
        ),
    });
    runtime = await ModelRuntime.create({
        authPath: configuration.authPath,
        modelsPath: null,
        modelsStore,
        refreshOnCreate: false,
    });
    const registry = new ModelRegistry(runtime);
    const find = registry.find.bind(registry);

    registry.find = (provider, id) =>
        model?.provider === provider && model.id === id ? model : find(provider, id);
    const session = SessionManager.inMemory(configuration.cwd);

    // Only this public identity method is overridden: no Durable journal is recreated here.
    session.getSessionId = () => configuration.sessionId;
    runner = new ExtensionRunner(
        loaded.extensions,
        loaded.runtime,
        configuration.cwd,
        session,
        registry,
    );
    runner.onError(() => {
        hookError = true;
    });
    stage = "native provider core binding";
    runner.bindCore(
        {
            sendMessage: unsupported,
            sendUserMessage: unsupported,
            appendEntry: unsupported,
            setSessionName: unsupported,
            getSessionName: () => undefined,
            setLabel: unsupported,
            getActiveTools: () => [],
            getAllTools: () => [],
            getSettings: unsupported,
            setActiveTools: unsupported,
            refreshTools: unsupported,
            getCommands: unsupported,
            setModel: unsupported,
            getThinkingLevel: () => "off",
            setThinkingLevel: unsupported,
        },
        {
            getModel: () => model,
            getScopedModels: () => [],
            isIdle: () => !model,
            isProjectTrusted: () => true,
            getSignal: () => controller?.signal,
            abort: () => controller?.abort(),
            hasPendingMessages: () => false,
            shutdown: unsupported,
            getContextUsage: () => undefined,
            compact: unsupported,
            getSystemPrompt: unsupported,
        },
        {
            registerProvider: unsupported,
            registerNativeProvider: (provider) => {
                if (
                    providers.has(provider.id) ||
                    !provider.auth.apiKey ||
                    provider.fetchDeferred ||
                    provider.cancelDeferred ||
                    provider.generateImages ||
                    provider.classify ||
                    provider.filterAllModels ||
                    (configuration.providerIds && !configuration.providerIds.includes(provider.id))
                ) {
                    unsupported();
                }

                const all = provider.getAllModels?.() ?? provider.getModels();

                if (all.some((entry) => "type" in entry && entry.type !== "chat")) {
                    unsupported();
                }

                providers.set(provider.id, provider);
                runtime.registerNativeProvider({
                    id: provider.id,
                    name: provider.name,
                    baseUrl: provider.baseUrl,
                    headers: provider.headers,
                    auth: { apiKey: provider.auth.apiKey },
                    getModels: provider.getModels.bind(provider),
                    getAllModels: provider.getAllModels?.bind(provider),
                    filterModels: provider.filterModels?.bind(provider),
                    refreshModels: provider.refreshModels?.bind(provider),
                    stream: provider.stream.bind(provider),
                    streamSimple: provider.streamSimple.bind(provider),
                });
            },
            unregisterProvider: unsupported,
            registerVirtualModel: unsupported,
            unregisterVirtualModel: unsupported,
        },
    );
    runner.bindCommandContext({
        waitForIdle: unsupported,
        newSession: unsupported,
        fork: unsupported,
        navigateTree: unsupported,
        switchSession: unsupported,
        reload: unsupported,
    });
    gate();

    if (!providers.size || configuration.providerIds?.some((id) => !providers.has(id))) {
        throw new Error("Required native provider registration missing");
    }

    stage = "catalog initialization";
    const refreshed = await runtime.refresh({
        providers: [...providers.keys()],
        allowNetwork: false,
        signal: controller!.signal,
    });

    if (refreshed.aborted || refreshed.errors.size) {
        throw new Error("Catalog initialization failed");
    }

    stage = "session_start hook";
    await runner.emit({ type: "session_start", reason: "new" });
    gate();

    return catalog();
}

function validateCredential(credential: any): void {
    if (credential && credential.type !== "api_key") {
        unsupported();
    }

    noCommands(credential);
}

async function stream(data: any): Promise<void> {
    await preflight();
    const provider = providers.get(data.providerId)!;
    const physical: Model<Api> = data.model;
    const canonical = provider.getModels().find((entry) => entry.id === physical.id);

    if (!canonical || canonical.api !== physical.api || physical.provider !== provider.id) {
        throw new Error("Off-catalog model prohibited");
    }

    // Native Models may change endpoint/auth headers, never model policy/cost/protocol metadata.
    const metadata = ({ baseUrl: _baseUrl, headers: _headers, ...rest }: Model<Api>) => rest;

    if (JSON.stringify(metadata(physical)) !== JSON.stringify(metadata(canonical))) {
        throw new Error("Custom model overrides prohibited");
    }

    model = physical;
    stage = "before_provider_headers hook";
    const headers = await runner!.emitBeforeProviderHeaders(data.options.headers ?? {});

    gate();
    validateHeaders(headers);
    const callbacksEnabled = data.callbacks;

    const bindPhysicalModel = (requestModel: Model<Api>) => {
        if (
            requestModel.provider !== physical.provider ||
            requestModel.id !== physical.id ||
            requestModel.api !== physical.api
        ) {
            throw new Error("Native internal model rerouting is unsupported");
        }

        model = requestModel;
    };

    const criticalCallback =
        (handler: (...args: any[]) => Promise<any>) =>
        async (...args: any[]) => {
            try {
                return await handler(...args);
            } catch (error) {
                hookError = true;

                throw error;
            }
        };

    const options = {
        ...data.options,
        headers,
        signal: controller!.signal,
        onPayload: criticalCallback(async (payload: unknown, requestModel: Model<Api>) => {
            bindPhysicalModel(requestModel);
            stage = "caller payload callback";
            const replacement = callbacksEnabled.onPayload
                ? await callback(
                      "onPayload",
                      { value: payload, model: requestModel },
                      controller!.signal,
                  )
                : undefined;

            stage = "before_provider_request hook";
            const result = await runner!.emitBeforeProviderRequest(
                replacement === undefined ? payload : replacement,
            );

            gate();
            assertSerializable(result);

            return result;
        }),
        onResponse: criticalCallback(async (response: any, requestModel: Model<Api>) => {
            bindPhysicalModel(requestModel);
            stage = "after_provider_response hook";

            if (configuration.profile === "litellm") {
                const cost = response.headers?.["x-litellm-response-cost"];

                if (
                    cost !== undefined &&
                    cost.trim() !== "" &&
                    (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(cost) ||
                        !Number.isFinite(Number(cost)) ||
                        Number(cost) < 0)
                ) {
                    throw new Error("Invalid proxy cost header");
                }
            }

            await runner!.emit({
                type: "after_provider_response",
                status: response.status,
                headers: response.headers,
            });
            gate();

            if (callbacksEnabled.onResponse) {
                await callback(
                    "onResponse",
                    { value: response, model: requestModel },
                    controller!.signal,
                );
            }
        }),
        onProviderStreamEvent: criticalCallback(
            async (value: unknown, requestModel: Model<Api>) => {
                bindPhysicalModel(requestModel);
                stage = "provider_stream_event hook";
                await runner!.emit({
                    type: "provider_stream_event",
                    data: value,
                    provider: requestModel.provider,
                    model: requestModel.id,
                    api: requestModel.api,
                });
                gate();

                if (callbacksEnabled.onProviderStreamEvent) {
                    await callback(
                        "onProviderStreamEvent",
                        { value, model: requestModel },
                        controller!.signal,
                    );
                }
            },
        ),
    };
    const events =
        data.method === "stream"
            ? provider.stream(physical, data.context, options)
            : provider.streamSimple(physical, data.context, options);
    let terminal = false;

    for await (const event of events) {
        gate();

        if (event.type === "done" || event.type === "error") {
            stage = "message_end hook (request may already be charged)";
            const message = event.type === "done" ? event.message : event.error;
            // Classify before hooks can replace/mutate diagnostics; never send original prose.
            const diagnostic =
                message.stopReason === "error" ? safeErrorMessage(message) : undefined;
            const final =
                (await runner!.emitMessageEnd({ type: "message_end", message })) ?? message;

            gate();
            validateFinal(final, physical);

            if (
                event.type === "error" &&
                final.stopReason !== "error" &&
                final.stopReason !== "aborted"
            ) {
                throw new Error(
                    "Failed transport cannot become successful through a terminal hook",
                );
            }

            sendTerminal(final, diagnostic);
            terminal = true;
            break;
        }

        if (
            "partial" in event &&
            (event.partial.stopReason === "error" || event.partial.stopReason === "aborted")
        ) {
            continue; // Queued native partials can share an object later mutated into a failure.
        }

        send({
            kind: "event",
            id: requestId,
            data:
                "partial" in event ? { ...event, partial: sanitizeMessage(event.partial) } : event,
        });
    }

    if (!terminal) {
        stage = "result-only message_end hook";
        const message = await events.result();
        const diagnostic = message.stopReason === "error" ? safeErrorMessage(message) : undefined;
        const final = (await runner!.emitMessageEnd({ type: "message_end", message })) ?? message;

        gate();
        validateFinal(final, physical);

        if (
            (message.stopReason === "error" || message.stopReason === "aborted") &&
            final.stopReason !== "error" &&
            final.stopReason !== "aborted"
        ) {
            throw new Error("Failed transport cannot become successful through a terminal hook");
        }

        sendTerminal(final, diagnostic);
    }
}

async function dispatch(op: string, data: any): Promise<any> {
    if (op === "initialize") {
        return initialize(data);
    }

    if (op === "shutdown") {
        stage = "session_shutdown hook";
        await runner?.emit({ type: "session_shutdown", reason: "quit" });
        runner?.invalidate();
        shutdown = true;
        gate();

        return;
    }

    if (!runner || shutdown) {
        unsupported();
    }

    if (op === "catalog") {
        return catalog();
    }

    if (op === "refresh") {
        await preflight();
        const result = await runtime.refresh({
            providers: [...providers.keys()],
            allowNetwork: true,
            force: true,
            signal: controller!.signal,
        });

        if (result.aborted || result.errors.size) {
            throw new Error("Native catalog refresh failed");
        }

        return catalog();
    }

    const provider = providers.get(data.providerId);

    if (!provider) {
        unsupported();
    }

    if (op === "stream") {
        await stream(data);

        return;
    }

    validateCredential(data.credential);
    const signal = controller!.signal;

    if (op === "check" || op === "resolve") {
        const input = {
            credential: data.credential as ApiKeyCredential | undefined,
            signal,
            ctx: {
                env: async (name: string) => {
                    const value = await callback("env", name, signal);

                    if (
                        (name === "LITELLM_API_KEY_HELPER" ||
                            name === "LITELLM_GCLOUD_TOKEN_AUTH") &&
                        value
                    ) {
                        unsupported();
                    }

                    noCommands(value);

                    return value;
                },
                fileExists: (path: string) => callback("fileExists", path, signal),
            },
        };

        const result =
            op === "check"
                ? await provider.auth.apiKey!.check?.(input)
                : await provider.auth.apiKey!.resolve(input);

        return {
            result,
            filtered: provider.filterModels?.(provider.getModels(), input.credential),
        };
    }

    if (op === "login") {
        const result = await provider.auth.apiKey!.login!({
            signal,
            prompt: async (prompt) => {
                const { signal: promptSignal, ...wirePrompt } = prompt;

                // Prompt-level cancellation rejects the step; abort the owning operation to suppress late replies.
                const abort = () => controller?.abort();

                promptSignal?.addEventListener("abort", abort, { once: true });

                try {
                    return await callback("prompt", wirePrompt, signal);
                } finally {
                    promptSignal?.removeEventListener("abort", abort);
                }
            },
            notify: (event) => {
                void callback("notify", event, signal).catch(() => controller?.abort());
            },
        });

        validateCredential(result);

        return result; // Parent Models owns credential persistence.
    }

    unsupported();
}

process.on("message", (message: WireMessage) => {
    if (message.kind === "callbackReply") {
        const pending = callbacks.get(message.token!);

        callbacks.delete(message.token!);

        if (message.failed) {
            pending?.reject();
        } else {
            pending?.resolve(message.data);
        }
    } else if (message.kind === "cancel") {
        controller?.abort();
    } else if (message.kind === "request") {
        queue = queue.then(async () => {
            requestId = message.id;
            controller = new AbortController();
            model = undefined;
            hookError = false;
            stage = message.op ?? "operation";

            try {
                const data = await dispatch(message.op!, message.data);

                gate();
                send({ kind: "reply", id: message.id, data });
            } catch {
                send({
                    kind: "reply",
                    id: message.id,
                    failed: true,
                    data: `Provider host ${stage} failed; remote outcome may be unknown`,
                });
            } finally {
                controller?.abort();
                model = undefined;
            }
        });
    }
});

process.on("SIGTERM", () => {
    controller?.abort();
    const timer = setTimeout(() => process.exit(1), 800);

    void queue.then(async () => {
        if (!shutdown) {
            await runner?.emit({ type: "session_shutdown", reason: "quit" });
            runner?.invalidate();
        }

        clearTimeout(timer);
        process.exit(0);
    });
});
process.on("disconnect", () => {
    controller?.abort();
    process.exit(0);
});
