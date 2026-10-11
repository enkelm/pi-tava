import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import {
    normalizeContext,
    createModels,
    InMemoryCredentialStore,
    isContextOverflow,
    isRetryableAssistantError,
    type AssistantMessageEvent,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PiProviderHost, type PiProviderHostOptions } from "../src/server/pi-provider-host.ts";

const fixtureRoot = fileURLToPath(new URL("./fixtures/pi-provider-host", import.meta.url));
const litellmRoot = "/Users/enkelm/.pi/agent/npm/node_modules/pi-provider-litellm";
const context = (text: string) => ({
    messages: [{ role: "user" as const, content: text, timestamp: Date.now() }],
});

type Request = {
    headers: IncomingMessage["headers"];
    body: any;
    started: number;
    finished?: number;
};

async function environment(failure?: string) {
    const root = await mkdtemp(join(tmpdir(), "provider-host-test-"));
    const agentDir = join(root, "agent");
    const authPath = join(root, "external-auth.json");
    const shutdownPath = join(root, "shutdown.txt");
    const activationPath = join(root, "activations.txt");
    const requests: Request[] = [];
    const discoveryRequests: string[] = [];
    const held = new Map<string, () => void>();
    let discovered = "fixture-litellm-chat";
    let discoveryAvailable = true;
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method === "GET") {
            discoveryRequests.push(req.url ?? "");

            if (!discoveryAvailable) {
                res.writeHead(503);
                res.end("Temporary discovery failure");

                return;
            }

            res.setHeader("content-type", "application/json");

            if (req.url?.includes("model/info")) {
                res.end(
                    JSON.stringify({
                        data: [
                            {
                                model_name: discovered,
                                litellm_params: { model: `openai/${discovered}` },
                                model_info: {
                                    mode: "chat",
                                    max_tokens: 100,
                                    max_input_tokens: 10000,
                                    input_cost_per_token: 0.000001,
                                    output_cost_per_token: 0.000002,
                                },
                            },
                        ],
                    }),
                );
            } else if (req.url?.includes("models")) {
                res.end(
                    JSON.stringify({
                        data: [{ id: discovered, object: "model", owned_by: "openai" }],
                    }),
                );
            } else {
                res.end(JSON.stringify({ info: { models: [discovered] } }));
            }

            return;
        }

        let text = "";

        for await (const chunk of req) {
            text += chunk;
        }

        const body = JSON.parse(text);

        if (!body.messages) {
            res.writeHead(400);
            res.end("Unsupported fake transport");

            return;
        }

        const prompt = String(body.messages.at(-1).content);
        const cost = prompt.includes("expensive") ? 9 : 2;
        const record: Request = { headers: req.headers, body, started: Date.now() };

        const costCases: Record<string, string | undefined> = {
            "missing-cost": undefined,
            "empty-cost": "",
            "blank-cost": " \t ",
            "malformed-cost": "2garbage",
            "negative-cost": "-1",
            "nonfinite-cost": "1e309",
        };
        const costCase = Object.keys(costCases).find((name) => prompt.includes(name));
        const proxyCost = costCase ? costCases[costCase] : String(cost);
        const headers: Record<string, string> = {
            "content-type": "text/event-stream",
            "x-fixture-cost": String(cost),
        };

        if (proxyCost !== undefined) {
            headers["x-litellm-response-cost"] = proxyCost;
        }

        requests.push(record);

        if (prompt.includes("echoed-error")) {
            const overflow = prompt.includes("overflow");
            const quota = prompt.includes("quota");
            const throttle = prompt.includes("rate-limit");
            const classification = overflow
                ? "Requested token count exceeds the model's maximum context length of 131072 tokens"
                : quota
                  ? "insufficient_quota"
                  : throttle
                    ? "Rate limit exceeded"
                    : "Unauthorized";

            res.writeHead(overflow ? 400 : quota || throttle ? 429 : 401, {
                "content-type": "application/json",
            });
            res.end(
                JSON.stringify({
                    error: {
                        message: `${classification} temporary-litellm-key https://user:temporary-litellm-key@proxy.invalid/path?token=temporary-litellm-key`,
                    },
                }),
            );

            return;
        }

        res.writeHead(200, headers);
        res.write(
            `data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "proxy-original" }, finish_reason: null }] })}\n\n`,
        );

        if (prompt.includes("held")) {
            await new Promise<void>((resolve) => held.set(prompt, resolve));
        } else {
            await delay(prompt.includes("slow") ? 400 : 40);
        }

        if (!res.destroyed) {
            res.write(
                `data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\n`,
            );
            res.end("data: [DONE]\n\n");
        }

        record.finished = Date.now();
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();

    assert(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;

    await mkdir(agentDir);
    await writeFile(
        authPath,
        JSON.stringify({ "fixture-provider": { type: "api_key", key: "temporary-test-key" } }),
    );
    await writeFile(
        join(agentDir, "settings.json"),
        JSON.stringify({ fixture: { baseUrl, failure, shutdownPath, activationPath } }),
    );

    return {
        root,
        agentDir,
        authPath,
        shutdownPath,
        activationPath,
        requests,
        discoveryRequests,
        releaseStream: (prompt: string) => held.get(prompt)?.(),
        baseUrl,
        setDiscovered: (id: string) => {
            discovered = id;
        },
        setDiscoveryAvailable: (available: boolean) => {
            discoveryAvailable = available;
        },
        open: (options: Pick<PiProviderHostOptions, "maxLanes" | "idleTimeoutMs"> = {}) =>
            PiProviderHost.open({
                ...options,
                packageRoot: fixtureRoot,
                agentDir,
                authPath,
                providerIds: ["fixture-provider"],
            }),
        async close() {
            for (const release of held.values()) {
                release();
            }

            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await rm(root, { recursive: true, force: true });
        },
    };
}

async function runtime(host: PiProviderHost, authPath: string) {
    const models = await ModelRuntime.create({
        authPath,
        modelsPath: null,
        refreshOnCreate: false,
    });

    for (const provider of host.getProviders()) {
        models.registerNativeProvider(provider);
    }

    await models.refresh({ providers: host.getProviders().map((p) => p.id), allowNetwork: false });

    return models;
}

// Authoring gate: real loader/IPC/HTTP boundary owns these contracts. Regressions include
// lost callbacks, a shared activation cost map, premature terminal forwarding and stale ctx.model.
// Existing app tests use faux models and cannot reach any of these paths; no test-only host seams.
test(
    "real TS extension host transforms transport and final results, isolates costs, and serializes session lanes",
    { timeout: 60000 },
    async (t) => {
        const env = await environment();

        t.after(() => env.close());
        const parentAgentDir = process.env.PI_CODING_AGENT_DIR;
        const host = await env.open();

        try {
            assert.equal(process.env.PI_CODING_AGENT_DIR, parentAgentDir);
            const models = await runtime(host, env.authPath);
            const model = models.getModel("fixture-provider", "fixture-physical")!;
            const events: AssistantMessageEvent[] = [];
            const seenCallbacks: string[] = [];
            const stream = models.stream(model, context("expensive slow"), {
                sessionId: "conversation-a",
                maxRetries: 0,
                headers: { "x-caller": "kept" },
                transformHeaders: (headers) => ({ ...headers, "x-parent-transform": "kept" }),
                onPayload: (payload) => {
                    seenCallbacks.push("payload");

                    return {
                        ...(payload as object),
                        caller_payload: true,
                        fixture_policy: "caller-cannot-bypass",
                    };
                },
                onResponse: () => {
                    seenCallbacks.push("response");
                },
                onProviderStreamEvent: () => {
                    seenCallbacks.push("stream");
                },
            });
            const collect = (async () => {
                for await (const event of stream) {
                    events.push(event);
                }
            })();
            const cheap = models.completeSimple(model, context("cheap"), {
                sessionId: "conversation-b",
                maxRetries: 0,
            });
            const [a, b] = await Promise.all([stream.result(), cheap]);

            await collect;
            assert.equal(a.usage.cost.total, 9);
            assert.equal(b.usage.cost.total, 2);
            assert.deepEqual(a.content, [
                { type: "text", text: "first-replacement:fixture-physical" },
            ]);
            const terminal = events.at(-1);

            assert(terminal?.type === "done");
            assert.deepEqual(terminal.message, a);
            const request = env.requests.find(
                (r) => r.headers["x-fixture-session"] === "conversation-a",
            )!;

            assert.equal(request.headers["x-fixture-session"], "conversation-a");
            assert.equal(request.headers["x-fixture-model"], "fixture-physical");
            assert.equal(request.headers["x-parent-transform"], "kept");
            assert.equal(request.headers["x-caller"], "kept");
            assert.equal(request.body.caller_payload, true);
            assert.equal(request.body.fixture_policy, "applied-last");
            assert.equal(request.headers.authorization, "Bearer temporary-test-key");
            assert.deepEqual(seenCallbacks.slice(0, 2), ["payload", "response"]);
            assert(seenCallbacks.includes("stream"));
            const start = env.requests.length;
            const [c, d] = await Promise.all([
                models.completeSimple(model, context("expensive slow"), {
                    sessionId: "conversation-a",
                    maxRetries: 0,
                }),
                models.completeSimple(model, context("cheap"), {
                    sessionId: "conversation-a",
                    maxRetries: 0,
                }),
            ]);

            assert.equal(c.usage.cost.total, 9);
            assert.equal(d.usage.cost.total, 2);
            assert(env.requests[start + 1]!.started >= env.requests[start]!.finished!);
            const [aux1, aux2] = await Promise.all([
                models.completeSimple(model, context("cheap"), { maxRetries: 0 }),
                models.completeSimple(model, context("expensive"), { maxRetries: 0 }),
            ]);

            assert.equal(aux1.usage.cost.total, 2);
            assert.equal(aux2.usage.cost.total, 9);
            const auxiliary = env.requests.slice(-2);

            assert.notEqual(
                auxiliary[0]!.headers["x-fixture-session"],
                auxiliary[1]!.headers["x-fixture-session"],
            );
            const requestCount = env.requests.length;
            const unsupportedFetch = await host
                .getProviders()[0]!
                .streamSimple(model, normalizeContext(context("not-sent")), {
                    fetch: globalThis.fetch,
                })
                .result();

            assert.equal(unsupportedFetch.stopReason, "error");
            assert.match(unsupportedFetch.errorMessage!, /custom fetch\/functions are unsupported/);
            assert.equal(env.requests.length, requestCount);
            await host.refresh();
            assert.equal(host.getProviders()[0]!.getModels().length, 2);
        } finally {
            await host.close();
            const pids = new Set(env.requests.map((r) => Number(r.headers["x-fixture-pid"])));
            const shutdowns = (await readFile(env.shutdownPath, "utf8")).split("\n");

            for (const pid of pids) {
                assert(shutdowns.includes(String(pid)), "shutdown hook was delivered");
                assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
            }
        }
    },
);

test(
    "API-key login/env callbacks, cancellation, queued abort and close do not retain children or emit late success",
    { timeout: 60000 },
    async (t) => {
        const env = await environment();

        t.after(() => env.close());
        const host = await env.open();

        try {
            const provider = host.getProviders()[0]!;
            const controller = new AbortController();
            const notices: string[] = [];
            const credential = await provider.auth.apiKey!.login!({
                signal: controller.signal,
                prompt: async (prompt) => {
                    assert.equal(prompt.type, "secret");

                    return "new-temporary-key";
                },
                notify: (event) => {
                    notices.push(event.type);
                },
            });

            assert.deepEqual(credential, { type: "api_key", key: "new-temporary-key" });
            assert.equal(
                JSON.parse(await readFile(env.authPath, "utf8"))[provider.id].key,
                "temporary-test-key",
                "login returns credentials but does not persist them",
            );
            assert.deepEqual(notices, ["progress"]);
            const auth = await provider.auth.apiKey!.resolve({
                credential,
                signal: controller.signal,
                ctx: {
                    env: async (name) =>
                        name === "FIXTURE_AUTH_HEADER" ? "native-env-bridge" : undefined,
                    fileExists: async () => false,
                },
            });

            assert.equal(auth?.auth.headers?.["x-fixture-auth"], "native-env-bridge");
            const loginAbort = new AbortController();
            let promptCancelled = false;
            let promptEntered!: () => void;
            const entered = new Promise<void>((resolve) => {
                promptEntered = resolve;
            });
            const cancelledLogin = provider.auth.apiKey!.login!({
                signal: loginAbort.signal,
                notify: () => {},
                prompt: (prompt) =>
                    new Promise((_resolve, reject) => {
                        promptEntered();
                        prompt.signal!.addEventListener(
                            "abort",
                            () => {
                                promptCancelled = true;
                                reject(new Error("Prompt cancelled"));
                            },
                            { once: true },
                        );
                    }),
            });

            await entered;
            loginAbort.abort();
            await assert.rejects(cancelledLogin, /aborted/);
            assert(promptCancelled, "IPC cancellation reached the actual login prompt");
            const models = await runtime(host, env.authPath);
            const model = provider.getModels()[0]!;
            const first = models.streamSimple(model, context("slow"), {
                sessionId: "abort-lane",
                maxRetries: 0,
            });

            while (!env.requests.length) {
                await delay(10);
            }

            const queued = new AbortController();
            const second = provider.streamSimple(
                model,
                normalizeContext(context("must-not-send")),
                { sessionId: "abort-lane", signal: queued.signal, maxRetries: 0 },
            );

            queued.abort();
            assert.equal((await second.result()).stopReason, "aborted");
            assert.equal(
                (await first.result()).stopReason,
                "stop",
                "queued cancellation must not kill the active request",
            );
            assert.equal(env.requests.length, 1);
            const activeAbort = new AbortController();
            const active = models.streamSimple(model, context("slow"), {
                sessionId: "abort-lane",
                signal: activeAbort.signal,
                maxRetries: 0,
            });

            while (env.requests.length < 2) {
                await delay(10);
            }

            activeAbort.abort();
            assert.equal((await active.result()).stopReason, "aborted");
            const closing = models.streamSimple(model, context("slow"), {
                sessionId: "abort-lane",
                maxRetries: 0,
            });

            while (env.requests.length < 3) {
                await delay(10);
            }

            await host.close();
            assert.notEqual((await closing.result()).stopReason, "stop");
            assert.equal(env.requests.length, 3);
            assert.notEqual(
                env.requests[1]!.headers["x-fixture-pid"],
                env.requests[2]!.headers["x-fixture-pid"],
                "active cancellation discarded the activation before the next same-session call",
            );

            for (const pid of new Set(
                env.requests.map((request) => Number(request.headers["x-fixture-pid"])),
            )) {
                assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
            }

            assert.equal(
                (
                    await provider
                        .streamSimple(model, normalizeContext(context("after-close")))
                        .result()
                ).stopReason,
                "aborted",
            );
        } finally {
            await host.close();
        }
    },
);

test(
    "critical hooks fail closed before dispatch or successful terminal acceptance, and diagnostics redact secrets",
    { timeout: 90000 },
    async () => {
        for (const failure of [
            "headers",
            "payload",
            "response",
            "terminal",
            "malformed",
            "unsupported",
        ]) {
            const env = await environment(failure);
            let host: PiProviderHost | undefined;

            try {
                if (failure === "unsupported") {
                    await assert.rejects(env.open(), /extension capability validation failed/);
                    continue;
                }

                host = await env.open();
                const models = await runtime(host, env.authPath);
                const model = host.getProviders()[0]!.getModels()[0]!;
                const answer = await models.completeSimple(model, context("cheap"), {
                    maxRetries: 0,
                });

                assert.equal(answer.stopReason, "error", failure);
                assert(!answer.errorMessage?.includes("temporary-test-key"));
                assert.equal(
                    env.requests.length,
                    failure === "headers" || failure === "payload" ? 0 : 1,
                );
                assert.equal(answer.content.length, 0, "fail-open runner value is never accepted");
            } finally {
                await host?.close();
                await env.close();
            }
        }
    },
);

// Real child activation PIDs and stalled HTTP responses own the resource contract: unbounded
// starts, early idle eviction or duplicate catalog recovery would change these external receipts.
// Production capacity/retention options are used; there is no test-only pool inspection seam.
test(
    "worker admission is bounded, only idle LRU lanes are evicted, idle workers expire, and catalog recovery is single-flight",
    { timeout: 60000 },
    async (t) => {
        const env = await environment();
        let host: PiProviderHost | undefined;

        t.after(async () => {
            await host?.close();
            await env.close();
        });
        const activated = async () =>
            (await readFile(env.activationPath, "utf8")).trim().split("\n").map(Number);

        const alive = (pid: number) => {
            try {
                process.kill(pid, 0);

                return true;
            } catch {
                return false;
            }
        };

        const until = async (predicate: () => boolean) => {
            const deadline = Date.now() + 5000;

            while (!predicate()) {
                assert(
                    Date.now() < deadline,
                    "resource transition did not finish within its bound",
                );
                await delay(10);
            }
        };

        host = await env.open({ maxLanes: 2, idleTimeoutMs: 60_000 });
        const provider = host.getProviders()[0]!;
        const model = provider.getModels()[0]!;
        const request = (sessionId: string, text: string) =>
            provider.streamSimple(model, normalizeContext(context(text)), {
                sessionId,
                apiKey: "temporary-test-key",
                maxRetries: 0,
            });
        const a = request("pool-a", "held-a");
        const b = request("pool-b", "held-b");
        const openingOverflow = await request("pool-opening-overflow", "must-not-send").result();

        assert.match(openingOverflow.errorMessage!, /capacity reached/);
        await until(() => env.requests.length === 2);
        const pidA = Number(
            env.requests.find((r) => r.headers["x-fixture-session"] === "pool-a")!.headers[
                "x-fixture-pid"
            ],
        );
        const pidB = Number(
            env.requests.find((r) => r.headers["x-fixture-session"] === "pool-b")!.headers[
                "x-fixture-pid"
            ],
        );
        const queued = request("pool-a", "queued-a");
        const activeOverflow = await request("pool-active-overflow", "must-not-send").result();

        assert.equal(activeOverflow.stopReason, "error");
        assert.match(activeOverflow.errorMessage!, /capacity reached/);
        assert.equal(env.requests.length, 2, "neither overflow nor queued request dispatched");
        assert.equal(
            (await activated()).length,
            3,
            "exactly two request workers plus the catalog were activated",
        );
        assert(alive(pidA) && alive(pidB), "active workers were not evicted");
        env.releaseStream("held-a");
        assert.equal((await a.result()).stopReason, "stop");
        assert.equal((await queued.result()).stopReason, "stop");
        assert.equal(
            Number(
                env.requests.find((r) => r.body.messages.at(-1).content === "queued-a")!.headers[
                    "x-fixture-pid"
                ],
            ),
            pidA,
        );
        assert.equal(
            (await activated()).length,
            3,
            "same-session serialization reused its reserved worker",
        );
        const c = await request("pool-c", "cheap-c").result();

        assert.equal(c.stopReason, "stop");
        const pidC = Number(
            env.requests.find((r) => r.headers["x-fixture-session"] === "pool-c")!.headers[
                "x-fixture-pid"
            ],
        );

        assert(!alive(pidA), "idle worker exit was joined before its replacement dispatched");
        assert(alive(pidB), "held active worker survived capacity pressure");
        assert.equal((await activated()).filter(alive).length, 3);
        env.releaseStream("held-b");
        assert.equal((await b.result()).stopReason, "stop");
        assert.equal((await request("pool-d", "cheap-d").result()).stopReason, "stop");
        assert(!alive(pidC), "least recently used idle worker was selected");
        assert(alive(pidB), "more recently used idle worker was retained");
        assert.equal((await activated()).filter(alive).length, 3);
        await host.close();
        host = await env.open({ maxLanes: 1, idleTimeoutMs: 40 });
        const expiring = host.getProviders()[0]!;
        const expired = await expiring
            .streamSimple(expiring.getModels()[0]!, normalizeContext(context("expire")), {
                sessionId: "expiring",
                apiKey: "temporary-test-key",
                maxRetries: 0,
            })
            .result();

        assert.equal(expired.stopReason, "stop");
        const expiringPid = Number(env.requests.at(-1)!.headers["x-fixture-pid"]);

        await until(() => !alive(expiringPid));
        assert.equal(
            (await activated()).filter(alive).length,
            1,
            "only the catalog remains after expiry",
        );
        const beforeRecovery = (await activated()).length;
        const abort = new AbortController();
        let entered!: () => void;
        const prompt = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const login = expiring.auth.apiKey!.login!({
            signal: abort.signal,
            notify: () => {},
            prompt: (input) =>
                new Promise((_resolve, reject) => {
                    entered();
                    input.signal!.addEventListener("abort", () => reject(new Error("Cancelled")), {
                        once: true,
                    });
                }),
        });

        await prompt;
        abort.abort();
        await assert.rejects(login);
        const input = {
            credential: { type: "api_key" as const, key: "temporary-test-key" },
            signal: new AbortController().signal,
            ctx: { env: async () => undefined, fileExists: async () => false },
        };

        await Promise.all([
            expiring.auth.apiKey!.check!(input),
            expiring.auth.apiKey!.resolve(input),
        ]);
        assert.equal(
            (await activated()).length,
            beforeRecovery + 1,
            "concurrent auth calls recreated one catalog worker",
        );
        assert.equal((await activated()).filter(alive).length, 1);
        await host.close();
        assert.equal((await activated()).filter(alive).length, 0);
    },
);

test(
    "result-only failures and queued partial diagnostics are sanitized after extension transforms",
    { timeout: 30000 },
    async () => {
        for (const failure of ["result-only-error", "partial-diagnostics"]) {
            const env = await environment(failure);
            let host: PiProviderHost | undefined;

            try {
                host = await env.open();
                const models = await runtime(host, env.authPath);
                const stream = models.streamSimple(
                    host.getProviders()[0]!.getModels()[0]!,
                    context("fixture"),
                );
                const events: AssistantMessageEvent[] = [];

                for await (const event of stream) {
                    events.push(event);
                }

                const result = await stream.result();

                assert(!JSON.stringify({ events, result }).includes("temporary-test-key"));
                assert(!JSON.stringify({ events, result }).includes("secret.invalid"));

                if (failure === "result-only-error") {
                    assert.equal(result.stopReason, "error");
                    assert.equal(
                        result.usage.cost.total,
                        1,
                        "sanitization preserves transformed usage",
                    );
                    assert.deepEqual(result.content, []);
                    assert(
                        !events.some((event) => event.type === "start"),
                        "already-failed shared partial was suppressed",
                    );
                } else {
                    const start = events.find((event) => event.type === "start");

                    assert(start?.type === "start");
                    assert.deepEqual(start.partial.content, [
                        { type: "text", text: "ordinary successful content" },
                    ]);
                    assert.equal(result.stopReason, "stop");
                }
            } finally {
                await host?.close();
                await env.close();
            }
        }
    },
);

test(
    "unmodified LiteLLM bootstraps empty auth, preserves accepted cache across failed refresh and offline restart, and seeds from controlled env",
    { timeout: 90000 },
    async (t) => {
        try {
            await access(join(litellmRoot, "package.json"));
        } catch {
            t.skip("unmodified LiteLLM package not installed");

            return;
        }

        const env = await environment();
        let host: PiProviderHost | undefined;

        t.after(async () => {
            await host?.close();
            await env.close();
        });
        const settings = JSON.stringify({
            litellm: {
                skills: { enabled: false },
                mcp: { enabled: false },
                budget: { enabled: false },
                providers: { litellm: { baseUrl: env.baseUrl, allowInsecureHttp: true } },
            },
        });
        const cachePath = join(env.root, "durable-cache", "models.json");
        const noAmbientAuth = { env: async () => undefined, fileExists: async () => false };
        const options = {
            packageRoot: litellmRoot,
            agentDir: env.agentDir,
            authPath: env.authPath,
            profile: "litellm" as const,
            providerIds: ["litellm"],
            modelsStorePath: cachePath,
            authContext: noAmbientAuth,
        };

        await writeFile(join(env.agentDir, "settings.json"), settings);
        await writeFile(env.authPath, "{}");
        host = await PiProviderHost.open(options);
        const provider = host.getProviders()[0]!;

        assert.deepEqual(provider.getModels(), [], "auth-only bootstrap invents no models");
        assert(provider.auth.apiKey?.login, "native sign-in is available before discovery");
        assert.equal(provider.auth.oauth, undefined);
        const models = await runtime(host, env.authPath);

        assert.deepEqual(await models.getAvailable("litellm"), []);
        await models.login("litellm", "api_key", {
            prompt: async (prompt) =>
                prompt.type === "secret"
                    ? "temporary-login-key"
                    : prompt.type === "select"
                      ? prompt.options[0]!.id
                      : env.baseUrl,
            notify: () => {},
        });
        await host.refresh();
        await models.refresh({ providers: ["litellm"], allowNetwork: false });
        const model = models.getModel("litellm", "fixture-litellm-chat")!;

        assert(model, "login followed by explicit discovery published chat models");
        assert.equal(
            (
                await models.completeSimple(model, context("cheap"), {
                    sessionId: "cached-conversation",
                    maxRetries: 0,
                })
            ).stopReason,
            "stop",
        );
        const accepted = await readFile(cachePath, "utf8");

        assert(
            !accepted.includes("temporary-login-key"),
            "the model cache does not copy credentials",
        );
        env.setDiscoveryAvailable(false);
        await assert.rejects(host.refresh(), /refresh failed/);
        assert.equal(
            await readFile(cachePath, "utf8"),
            accepted,
            "failed candidate did not modify the accepted cache",
        );
        assert.equal(host.getProviders()[0], provider, "provider identity survives failed refresh");
        assert.equal(
            (
                await models.completeSimple(model, context("cheap"), {
                    sessionId: "cached-conversation",
                    maxRetries: 0,
                })
            ).stopReason,
            "stop",
            "accepted request lane remains usable after discovery failure",
        );
        env.setDiscoveryAvailable(true);
        env.setDiscovered("fixture-litellm-refreshed");
        await host.refresh();
        assert(
            provider.getModels().some((entry) => entry.id === "fixture-litellm-refreshed"),
            "refresh is retryable",
        );
        await host.close();
        await rm(env.agentDir, { recursive: true, force: true });
        await mkdir(env.agentDir);
        await writeFile(join(env.agentDir, "settings.json"), settings);
        env.setDiscoveryAvailable(false);
        const beforeRestart = env.discoveryRequests.length;

        host = await PiProviderHost.open(options);
        assert.equal(
            env.discoveryRequests.length,
            beforeRestart,
            "offline cached bootstrap does not rediscover",
        );
        const restarted = await runtime(host, env.authPath);
        const restored = restarted.getModel("litellm", "fixture-litellm-refreshed")!;

        assert(restored, "config-scoped public ModelsStore survived settings-directory recreation");
        assert.equal(
            (await restarted.completeSimple(restored, context("missing-cost"), { maxRetries: 0 }))
                .stopReason,
            "stop",
            "fresh request lane hydrated the accepted catalog while discovery was offline",
        );
        await host.close();
        env.setDiscoveryAvailable(true);
        await writeFile(env.authPath, "{}");
        await writeFile(
            join(env.agentDir, "settings.json"),
            JSON.stringify({
                litellm: {
                    skills: { enabled: false },
                    mcp: { enabled: false },
                    budget: { enabled: false },
                    providers: { litellm: { allowInsecureHttp: true } },
                },
            }),
        );
        const controlled = {
            env: async (name: string) =>
                name === "LITELLM_API_KEY"
                    ? "temporary-env-key"
                    : name === "LITELLM_BASE_URL"
                      ? env.baseUrl
                      : undefined,
            fileExists: async () => false,
        };

        const envCachePath = join(env.root, "env-cache.json");

        host = await PiProviderHost.open({ ...options, modelsStorePath: envCachePath });
        assert.deepEqual(host.getProviders()[0]!.getModels(), []);
        await host.close();
        host = await PiProviderHost.open({
            ...options,
            modelsStorePath: envCachePath,
            authContext: controlled,
        });
        const envModels = createModels({
            credentials: new InMemoryCredentialStore(),
            authContext: controlled,
        });

        for (const entry of host.getProviders()) {
            envModels.setProvider(entry);
        }

        const available = await envModels.getAvailable("litellm");

        assert(
            available.length > 0,
            "allowlisted env auth reached factory seeding and native availability",
        );
        assert.equal(
            (await envModels.completeSimple(available[0]!, context("cheap"), { maxRetries: 0 }))
                .stopReason,
            "stop",
        );
        assert.equal(env.requests.at(-1)!.headers.authorization, "Bearer temporary-env-key");
    },
);

test(
    "installed unmodified LiteLLM discovers isolated chat models, resolves API-key auth, streams proxy costs and refreshes",
    { timeout: 90000 },
    async (t) => {
        try {
            await access(join(litellmRoot, "package.json"));
        } catch {
            t.skip("unmodified LiteLLM package not installed");

            return;
        }

        const env = await environment();
        let host: PiProviderHost | undefined;

        try {
            await writeFile(
                join(env.agentDir, "settings.json"),
                JSON.stringify({
                    litellm: {
                        skills: { enabled: false },
                        mcp: { enabled: false },
                        budget: { enabled: false },
                        providers: { litellm: { baseUrl: env.baseUrl, allowInsecureHttp: true } },
                    },
                }),
            );
            await writeFile(
                env.authPath,
                JSON.stringify({
                    litellm: {
                        type: "api_key",
                        key: "temporary-litellm-key",
                        env: { LITELLM_BASE_URL: env.baseUrl },
                    },
                }),
            );
            host = await PiProviderHost.open({
                packageRoot: litellmRoot,
                agentDir: env.agentDir,
                authPath: env.authPath,
                profile: "litellm",
                providerIds: ["litellm"],
                authContext: { env: async () => undefined, fileExists: async () => false },
            });
            const models = await runtime(host, env.authPath);
            const available = await models.getAvailable("litellm");

            assert(available.length > 0, "real package discovery returned a usable chat catalog");
            const model = available.find((m) => m.id === "fixture-litellm-chat")!;

            assert(model);
            const [a, b] = await Promise.all([
                models.completeSimple(model, context("expensive slow"), {
                    sessionId: "litellm-a",
                    maxRetries: 0,
                }),
                models.completeSimple(model, context("cheap"), {
                    sessionId: "litellm-b",
                    maxRetries: 0,
                }),
            ]);

            assert.equal(a.stopReason, "stop", a.errorMessage ?? "request succeeded");
            assert.equal(a.usage.cost.total, 9);
            assert.equal(b.usage.cost.total, 2);
            assert(env.requests.some((r) => r.headers["x-litellm-session-id"] === "litellm-a"));
            assert.equal(env.requests[0]!.headers.authorization, "Bearer temporary-litellm-key");

            // Official proxies can publish no streaming charge. Preserve the known native
            // rate estimate; these headers are neither proof of free usage nor an invoice.
            for (const unavailable of ["missing-cost", "empty-cost", "blank-cost"]) {
                const answer = await models.completeSimple(model, context(unavailable), {
                    sessionId: "litellm-a",
                    maxRetries: 0,
                });

                assert.equal(
                    answer.stopReason,
                    "stop",
                    `${unavailable}: ${answer.errorMessage ?? "success"}`,
                );
                assert(
                    Math.abs(answer.usage.cost.total - 0.00003) < 1e-12,
                    `${unavailable} must preserve the 10 input / 10 output token rate estimate`,
                );
            }

            for (const invalid of ["malformed-cost", "negative-cost", "nonfinite-cost"]) {
                const answer = await models.completeSimple(model, context(invalid), {
                    sessionId: "litellm-invalid",
                    maxRetries: 0,
                });

                assert.equal(answer.stopReason, "error", `${invalid} must fail closed`);
            }

            const cancelled = new AbortController();
            let observedResponse!: () => void;
            const response = new Promise<void>((resolve) => {
                observedResponse = resolve;
            });
            const chargedThenAborted = models.streamSimple(
                model,
                context("expensive held-cancelled"),
                {
                    sessionId: "litellm-cancelled",
                    signal: cancelled.signal,
                    maxRetries: 0,
                    onResponse: () => {
                        observedResponse();
                    },
                },
            );

            // The provider-owned hook has captured the response cost before this callback.
            await response;
            cancelled.abort();
            assert.equal((await chargedThenAborted.result()).stopReason, "aborted");
            env.releaseStream("expensive held-cancelled");
            const beforeRestart = env.discoveryRequests.length;
            const afterAbort = await models.completeSimple(model, context("missing-cost"), {
                sessionId: "litellm-cancelled",
                maxRetries: 0,
            });

            assert.equal(afterAbort.stopReason, "stop");
            assert(Math.abs(afterAbort.usage.cost.total - 0.00003) < 1e-12);
            assert(
                env.discoveryRequests.length === beforeRestart,
                "replacement lane hydrated the accepted snapshot without factory rediscovery",
            );

            for (const [prompt, retryable, overflow] of [
                ["echoed-error", false, false],
                ["echoed-error-rate-limit", true, false],
                ["echoed-error-overflow", false, true],
                ["echoed-error-quota", false, false],
            ] as const) {
                const echoed = models.streamSimple(model, context(prompt), {
                    sessionId: "litellm-errors",
                    maxRetries: 0,
                });
                const echoedEvents: AssistantMessageEvent[] = [];

                for await (const event of echoed) {
                    echoedEvents.push(event);
                }

                const echoedResult = await echoed.result();

                assert.equal(echoedResult.stopReason, "error");
                assert(
                    !JSON.stringify({ echoedEvents, echoedResult }).includes(
                        "temporary-litellm-key",
                    ),
                    "provider HTTP diagnostics must not leak echoed credentials through IPC",
                );
                assert(!JSON.stringify({ echoedEvents, echoedResult }).includes("proxy.invalid"));
                assert.equal(
                    isRetryableAssistantError(echoedResult),
                    retryable,
                    `${prompt}: Durable retry classification survives IPC`,
                );
                assert.equal(
                    isContextOverflow(echoedResult),
                    overflow,
                    `${prompt}: Durable compaction classification survives IPC`,
                );
            }

            env.setDiscovered("fixture-litellm-refreshed");
            await host.refresh();
            assert(
                host
                    .getProviders()[0]!
                    .getModels()
                    .some((m) => m.id === "fixture-litellm-refreshed"),
            );
            await host.close();
            host = undefined;
            await writeFile(
                env.authPath,
                JSON.stringify({
                    litellm: {
                        type: "oauth",
                        access: "temporary",
                        refresh: "temporary",
                        expires: 0,
                    },
                }),
            );
            await assert.rejects(
                PiProviderHost.open({
                    packageRoot: litellmRoot,
                    agentDir: env.agentDir,
                    authPath: env.authPath,
                    profile: "litellm",
                    authContext: { env: async () => undefined, fileExists: async () => false },
                }),
                /configuration validation failed/,
            );
        } finally {
            await host?.close();
            await env.close();
        }
    },
);
