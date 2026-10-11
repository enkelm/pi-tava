// Public app lifecycle: native provider registration precedes Durable, and final usage commits once.
import {
    cleanUp,
    context,
    fakeTab,
    modelTexts,
    newSession,
    openApp,
    owner,
    recordCost,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import {
    cpSync,
    copyFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { GenerationTask, LiveDoc, UsageDoc } from "@earendil-works/pi-durable";
import { ConfigStore, type ProviderPackageRelease } from "../src/server/config.ts";
import { createHandler } from "../src/server/http.ts";
import { SessionsDoc } from "../src/server/docs.ts";

after(cleanUp);

function retain(dataDir: string, version: string, broken = false): ProviderPackageRelease {
    const id = randomUUID();
    const directory = join(dataDir, "provider-packages", "releases", id, "npm");
    const packageRoot = join(directory, "node_modules", "pi-provider-litellm");

    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
        join(packageRoot, "package.json"),
        JSON.stringify({
            name: "pi-provider-litellm",
            version,
            pi: { extensions: ["./index.ts"] },
        }),
    );
    writeFileSync(
        join(directory, "package-lock.json"),
        JSON.stringify({
            lockfileVersion: 3,
            packages: { "node_modules/pi-provider-litellm": { version } },
        }),
    );

    if (broken) {
        writeFileSync(
            join(packageRoot, "index.ts"),
            'export default () => { throw new Error("startup fixture failure"); };',
        );
    } else {
        copyFileSync(
            new URL("./fixtures/pi-provider-coop/index.ts", import.meta.url),
            join(packageRoot, "index.ts"),
        );
    }

    return { id, version, source: `npm:pi-provider-litellm@${version}` };
}

test("headless provider finalization reaches Durable usage, survives restart and falls back without repinning", async () => {
    const dataDir = join(root, "hosted-app");
    const retained = retain(dataDir, "4.2.0");
    const config = new ConfigStore(dataDir);

    writeFileSync(
        join(root, "agent", "models.json"),
        JSON.stringify({
            providers: {
                litellm: {
                    api: "openai-completions",
                    baseUrl: "https://bypass.invalid",
                    apiKey: "ephemeral-unused",
                    models: [
                        {
                            id: "bypass",
                            name: "Not a hosted model",
                            contextWindow: 8192,
                            maxTokens: 1024,
                        },
                    ],
                },
            },
        }),
    );
    config.setExtensionEnabled("pi-providers.ts", true);
    config.providerPackages = {
        packages: [{ name: "pi-provider-litellm", enabled: true, release: retained }],
    };

    let app = await openApp(scriptedModel(), dataDir);

    try {
        const first = await app.providerPackages.list();

        assert.equal(first.activeEnabled, true);
        assert.equal(first.restartRequired, false);
        assert.equal(first.packages[0]?.activeVersion, "4.2.0");
        assert.ok(app.models.getProvider("litellm"));
        assert.equal(
            app.models.getModel("litellm", "bypass"),
            undefined,
            "models.json cannot bypass hosted policy events",
        );

        const id = await newSession(app);

        await app.commands.configure(id, owner(app), {
            model: { provider: "litellm", modelId: "coop-fixture" },
        });
        await say(app, id, "one");
        assert.match((await modelTexts(app, id)).join("\n"), /hosted:coop-fixture/);
        assert.equal(
            (await app.harness.snapshot(UsageDoc, id, context))?.models["litellm/coop-fixture"]
                ?.cost.total,
            3,
        );

        await app.close();
        app = await openApp(scriptedModel(), dataDir);
        await say(app, id, "two");
        assert.equal(
            (await app.harness.snapshot(UsageDoc, id, context))?.models["litellm/coop-fixture"]
                ?.cost.total,
            6,
        );

        const stagedButNeverApplied = retain(dataDir, "4.2.1");
        const broken = retain(dataDir, "4.2.2", true);
        const desired = app.config.providerPackages;

        desired.packages[0]!.previous = stagedButNeverApplied;
        desired.packages[0]!.release = broken;
        app.config.providerPackages = desired;

        assert.equal((await app.providerPackages.list()).packages[0]?.activeVersion, "4.2.0");

        await app.close();
        app = await openApp(scriptedModel(), dataDir);

        const fallback = await app.providerPackages.list();

        assert.equal(
            fallback.packages[0]?.version,
            "4.2.2",
            "failed candidate remains the requested pin",
        );
        assert.equal(
            fallback.packages[0]?.activeVersion,
            "4.2.0",
            "last applied release, not an arbitrary staged version",
        );
        assert.equal(fallback.restartRequired, true);
        assert.ok(fallback.error);
        assert.equal(
            fallback.error.includes("startup fixture failure"),
            false,
            "raw extension errors stay private",
        );
        await say(app, id, "three");
        assert.equal(
            (await app.harness.snapshot(UsageDoc, id, context))?.models["litellm/coop-fixture"]
                ?.cost.total,
            9,
        );

        await until(
            () => app.spend.personSpent(owner(app).id) === 9,
            "transformed usage to be charged once to its requester across restarts",
        );
        await app.providerPackages.rollback("pi-provider-litellm");
        assert.equal(
            (await app.providerPackages.list()).restartRequired,
            false,
            "selecting the running retained code needs no extra restart",
        );
        await app.providerPackages.setModuleEnabled(false);
        await app.close();
        app = await openApp(scriptedModel(), dataDir);
        assert.ok(
            app.models.getModel("litellm", "bypass"),
            "ordinary custom models return when compatibility is off",
        );
    } finally {
        await app.close();
    }

    assert.deepEqual(
        readdirSync(join(dataDir, "provider-packages", "hosts")),
        [],
        "app shutdown removes isolated provider settings homes",
    );
    assert.equal(
        readdirSync(join(dataDir, "provider-packages", "releases")).length,
        3,
        "shutdown retains immutable rollback releases",
    );
});

test("an invalid first activation keeps recovery controls available without installing another provider", async () => {
    const dataDir = join(root, "failed-first-hosted-app");
    const config = new ConfigStore(dataDir);

    config.setExtensionEnabled("pi-providers.ts", true);
    config.providerPackages = {
        packages: [
            {
                name: "pi-provider-litellm",
                enabled: true,
                release: {
                    id: randomUUID(),
                    version: "4.2.0",
                    source: "npm:pi-provider-litellm@4.2.0",
                },
            },
        ],
    };

    let app = await openApp(scriptedModel(), dataDir);
    const server = createServer((request, response) =>
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} })(
            request,
            response,
        ),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const address = server.address();

    assert.ok(address !== null && typeof address === "object");

    try {
        const failed = await app.providerPackages.list();

        assert.equal(failed.enabled, true);
        assert.equal(failed.activeEnabled, false);
        assert.equal(failed.restartRequired, true);
        assert.ok(failed.error);
        assert.equal(app.models.getProvider("litellm"), undefined);
        assert.ok(
            (await app.extensions(owner(app))).modules.find(
                (module) => module.file === "pi-providers.ts",
            )?.error,
        );
        assert.equal((await app.harness.inspect(context)).scheduling, "paused");

        // Reserve a real built-in task through the public Durable API, without requesting progress.
        const conversation = await app.harness.createConversation(
            {
                ownership: { kind: "ownerless" },
                agent: { model: { provider: "litellm", modelId: "coop-fixture" } },
            },
            context,
        );
        const task = await app.harness.commit(
            (tx) =>
                tx.createTask(
                    GenerationTask,
                    {},
                    {
                        conversationId: conversation.id,
                        ownership: { kind: "conversation" },
                    },
                ),
            context,
        );
        const response = await fetch(
            `http://127.0.0.1:${address.port}/api/c/${conversation.id}/stop`,
            {
                method: "POST",
                headers: {
                    authorization: `Bearer ${app.config.ownerToken}`,
                    "x-pocket": "1",
                    "content-type": "application/json",
                },
                body: "{}",
            },
        );

        assert.equal(
            response.status,
            503,
            "a progress route cannot accidentally resume all held work",
        );
        await assert.rejects(app.commands.createSession(owner(app), {}), { status: 503 });
        assert.equal((await app.harness.inspect(context)).scheduling, "paused");
        assert.equal((await app.harness.getTask(task, context))?.state.status, "pending");

        // A crash can leave an over-budget busy run with usage not yet attributed to its payer.
        // Its budget abort must not enable Durable's global scheduler and settle other held tasks.
        const overBudget = await app.harness.createConversation(
            {
                ownership: { kind: "ownerless" },
                agent: { model: { provider: "litellm", modelId: "coop-fixture" } },
            },
            context,
        );
        const overBudgetTask = await app.harness.commit(async (tx) => {
            const pending = await tx.createTask(
                GenerationTask,
                {},
                {
                    conversationId: overBudget.id,
                    ownership: { kind: "conversation" },
                },
            );
            const live = await tx.doc(LiveDoc, overBudget.id);

            live.run = { taskId: pending, inputs: [] };
            const sessions = await tx.doc(SessionsDoc);

            sessions.items[String(overBudget.id)] = {
                cwd: root,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                createdBy: owner(app).id,
                budget: 1,
            };

            return pending;
        }, context);

        await recordCost(app, overBudget.id, 5);
        app.spend.close(); // Stop before the delayed attribution commit, as a crash does.
        assert.equal(app.spend.personSpent(owner(app).id), 0);
        await app.close();
        app = await openApp(scriptedModel(), dataDir);
        assert.equal(
            app.spend.personSpent(owner(app).id),
            5,
            "accounting still reconciles during recovery",
        );
        assert.equal((await app.harness.inspect(context)).scheduling, "paused");
        assert.equal((await app.harness.getTask(overBudgetTask, context))?.state.status, "pending");
        assert.equal(
            (await app.harness.getTask(task, context))?.state.status,
            "pending",
            "recovery did not settle pending work as no_model",
        );
        await app.setExtensionEnabled(owner(app), "pi-providers.ts", false);
        assert.equal((await app.providerPackages.list()).enabled, false);
        assert.equal(
            (await app.harness.inspect(context)).scheduling,
            "paused",
            "requested changes still await restart",
        );
    } finally {
        await app.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

test("fresh unmodified LiteLLM reaches owner sign-in before any catalog or credentials exist", async (t) => {
    const installed = "/Users/enkelm/.pi/agent/npm/node_modules/pi-provider-litellm";

    if (!existsSync(join(installed, "package.json"))) {
        t.skip("unmodified LiteLLM package not installed");

        return;
    }

    // Only this isolated test process changes; no inherited production key is inspected or used.
    process.env.LITELLM_API_KEY = "";
    process.env.LITELLM_BASE_URL = "";
    const dataDir = join(root, "fresh-litellm-app");
    const id = randomUUID();
    const npm = join(dataDir, "provider-packages", "releases", id, "npm");
    const retained = join(npm, "node_modules", "pi-provider-litellm");
    const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));

    mkdirSync(retained, { recursive: true });
    copyFileSync(join(installed, "package.json"), join(retained, "package.json"));
    cpSync(join(installed, "src"), join(retained, "src"), { recursive: true });
    writeFileSync(
        join(npm, "package-lock.json"),
        JSON.stringify({
            lockfileVersion: 3,
            packages: { "node_modules/pi-provider-litellm": { version: manifest.version } },
        }),
    );
    const config = new ConfigStore(dataDir);

    config.setExtensionEnabled("pi-providers.ts", true);
    config.providerPackages = {
        packages: [
            {
                name: "pi-provider-litellm",
                enabled: true,
                release: {
                    id,
                    version: manifest.version,
                    source: `npm:pi-provider-litellm@${manifest.version}`,
                },
            },
        ],
    };
    const requests: string[] = [];
    let offline = false;
    const proxy = createServer((request, response) => {
        requests.push(request.headers.authorization ?? "");

        if (offline) {
            response.writeHead(503).end("catalog temporarily unavailable");

            return;
        }

        if (!request.url?.split("?")[0]?.endsWith("/model/info")) {
            response.writeHead(404).end();

            return;
        }

        assert.equal(request.headers.authorization, "Bearer temporary-bootstrap-key");
        response.setHeader("content-type", "application/json");
        response.end(
            JSON.stringify({
                data: [
                    {
                        model_name: "fixture-bootstrap-chat",
                        litellm_params: { model: "openai/gpt-4o-mini" },
                        model_info: {
                            id: "fixture-bootstrap",
                            mode: "chat",
                            max_input_tokens: 8192,
                            max_output_tokens: 1024,
                            input_cost_per_token: 0.000001,
                            output_cost_per_token: 0.000002,
                        },
                    },
                ],
            }),
        );
    });

    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const address = proxy.address();

    assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}`;
    let app;

    try {
        app = await openApp(scriptedModel(), dataDir);
        assert.equal(app.providerExtensions.recoveryRequired, true);
        assert.equal((await app.harness.inspect(context)).scheduling, "paused");
        const shown = app.providers.list().find((provider) => provider.id === "litellm");

        assert.equal(shown?.hosted, true);
        assert.equal(shown?.apiKey, true);
        assert.equal(shown?.models, 0, "auth-only provider must not fabricate fallback models");
        assert.deepEqual(requests, [], "empty-auth activation does not contact a provider");
        const tab = fakeTab(undefined, owner(app));

        app.attach(tab.client);
        const flow = app.providers.startLogin(owner(app), "litellm", "api_key");
        const answered = new Set<string>();

        await until(
            () => {
                for (const event of tab.events) {
                    if (
                        event.event !== "auth" ||
                        event.data.flowId !== flow ||
                        event.data.step !== "prompt"
                    ) {
                        continue;
                    }

                    const promptId = String(event.data.promptId);

                    if (!answered.has(promptId)) {
                        answered.add(promptId);
                        const prompt = event.data.prompt as { type: string };

                        app!.providers.answerLogin(
                            owner(app!),
                            flow,
                            promptId,
                            prompt.type === "secret" ? "temporary-bootstrap-key" : url,
                        );
                    }
                }

                return tab.events.some(
                    (event) =>
                        event.event === "auth" &&
                        event.data.flowId === flow &&
                        event.data.step === "done",
                );
            },
            "the owner's hosted credential flow to finish",
            15000,
        );
        const done = tab.events.find(
            (event) =>
                event.event === "auth" && event.data.flowId === flow && event.data.step === "done",
        )!;

        assert.equal(done.data.ok, true, JSON.stringify(done.data));
        assert.ok(requests.length > 0, "sign-in refresh uses the fake proxy");
        assert.ok(app.models.getModels("litellm").length > 0);
        assert.equal(
            app.providerExtensions.recoveryRequired,
            true,
            "sign-in does not unpause work before restart",
        );
        assert.equal((await app.harness.inspect(context)).scheduling, "paused");
        offline = true;
        await app.close();
        app = await openApp(scriptedModel(), dataDir);
        assert.equal(app.providerExtensions.recoveryRequired, false);
        assert.ok(
            app.models.getModels("litellm").length > 0,
            "accepted catalog survives restart while discovery is unavailable",
        );
    } finally {
        await app?.close();
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
});
