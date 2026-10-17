// Owner-boundary contracts: read-only transport bounds/SSRF, managed delivery/retirement/helpers, and isolated clones.
// DNS/HTTPS and the online Git transport are fixture boundaries; no live sites, credentials or production seams.
import {
    cleanUp,
    context,
    executeHandoff,
    lastText,
    modelTexts,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import dns from "node:dns/promises";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    symlinkSync,
    truncateSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import https from "node:https";
import { IncomingMessage } from "node:http";
import { EventEmitter } from "node:events";
import { Socket } from "node:net";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, test, type TestContext } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { SubagentsDoc } from "../src/server/docs.ts";
import { readPublicDocument } from "../src/server/public-read.ts";
import { Browsers } from "../src/server/browser.ts";
import { Connection, Chromium } from "../src/server/browser/cdp.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";

after(cleanUp);
let serial = 0;
const source = "https://docs.example.invalid/guide";

function transport(t: TestContext) {
    const reads: { url: URL; options: https.RequestOptions }[] = [];
    let addresses = [{ address: "93.184.216.34", family: 4 }];
    let response = {
        status: 200,
        headers: { "content-type": "text/html" } as Record<string, string>,
        chunks: ["<h1>Primary evidence</h1>"],
    };

    const lookup = t.mock.method(dns, "lookup", async (_hostname: string) => addresses);

    t.mock.method(https, "request", ((
        url: URL,
        options: https.RequestOptions,
        callback: (incoming: IncomingMessage) => void,
    ) => {
        reads.push({ url, options });
        const call = new EventEmitter() as EventEmitter & { end(): void };

        call.end = () =>
            queueMicrotask(() => {
                const incoming = new IncomingMessage(new Socket());

                incoming.statusCode = response.status;
                incoming.headers = response.headers;
                callback(incoming);

                for (const chunk of response.chunks) {
                    incoming.push(Buffer.from(chunk));
                }

                incoming.push(null);
            });

        return call;
    }) as typeof https.request);

    return {
        reads,
        lookup,
        addresses(value: typeof addresses) {
            addresses = value;
        },
        response(value: typeof response) {
            response = value;
        },
    };
}

function git(cwd: string, ...args: string[]) {
    return execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    }).trim();
}

async function fixture(t: TestContext) {
    const directory = join(root, `research-${++serial}`);
    const cwd = join(directory, "checkout");

    mkdirSync(cwd, { recursive: true });
    git(cwd, "init", "-q", "--initial-branch=main");
    git(cwd, "config", "user.name", "Test");
    git(cwd, "config", "user.email", "test@example.invalid");
    writeFileSync(join(cwd, "code.txt"), "existing implementation\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "base");
    let planned = {
        name: "research",
        args: { action: "read", url: source } as Parameters<typeof fauxToolCall>[1],
    };
    const app = await openApp(
        scriptedModel((request) => {
            const last = lastText(request as never);

            if (last.role === "user" && last.text.includes("HELPER_RESEARCH")) {
                return fauxAssistantMessage(
                    [fauxToolCall("research", { action: "read", url: source })],
                    { stopReason: "toolUse" },
                );
            }

            if (last.role === "user" && last.text.endsWith("RUN TOOL")) {
                return fauxAssistantMessage([fauxToolCall(planned.name, planned.args)], {
                    stopReason: "toolUse",
                });
            }

            return fauxAssistantMessage([fauxText(`echo: ${last.text}`)]);
        }),
        join(directory, "data"),
    );

    t.after(() => app.close());
    const project = await app.projects.create(owner(app), {
        name: "Research fixture",
        cwd,
        requestId: crypto.randomUUID(),
    });
    // Default must remain Worker, not a new planning stage.
    const { id } = await app.commands.createSession(owner(app), { projectId: project.id });

    assert.equal(app.sessionMeta(id)?.threadType, "worker");
    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });

    const send = async (name: string, args: Parameters<typeof fauxToolCall>[1], target = id) => {
        planned = { name, args };
        const submitted = await (
            await app.conversation(target)
        ).submit(
            {
                type: "input",
                content: "RUN TOOL",
                requestId: `u:${owner(app).id}:${crypto.randomUUID()}`,
            },
            context,
        );

        await submitted.wait(context);

        return (
            JSON.parse((await modelTexts(app, target)).at(-1)!) as { type: string; text?: string }[]
        )
            .map((part) => part.text ?? "")
            .join("\n");
    };

    const handoff = async (
        from: ConversationId,
        type: "researcher" | "follow-up" | "reviewer" | "pull",
    ) => {
        const created = await executeHandoff(app, from, type, {
            summary: "Investigate this topic and apply the evidence through a focused successor.",
        });
        const next = created.id as ConversationId;

        await until(
            async () =>
                !app.isBusy(next) &&
                (await app.handoffs.list(next, owner(app))).handoffs.some(
                    (record) =>
                        record.targetThreadId === created.id && record.delivery === "delivered",
                ),
            "research successor idle",
        );

        return next;
    };

    return { app, id, cwd, directory, send, handoff };
}

test("public documentation GETs pin public DNS, omit credentials and reject SSRF, redirects and oversized bodies", async (t) => {
    const network = transport(t);
    const document = await readPublicDocument(source);

    assert.equal(document.body, "<h1>Primary evidence</h1>");
    assert.equal(document.url, source);
    const { options } = network.reads[0]!;

    assert.equal(options.method, "GET");
    assert.equal(options.family, 4);
    assert.equal(options.agent, false);
    assert.equal(options.rejectUnauthorized, true);
    assert.equal((options.headers as Record<string, string>).authorization, undefined);
    assert.equal((options.headers as Record<string, string>).cookie, undefined);
    await new Promise<void>((resolve) => {
        options.lookup!("changed.invalid", {}, (error, address, family) => {
            assert.equal(error, null);
            assert.equal(address, "93.184.216.34");
            assert.equal(family, 4);
            resolve();
        });
    });

    for (const url of [
        "http://docs.example.invalid",
        "https://127.0.0.1",
        "https://[::1]",
        "https://[::ffff:127.0.0.1]",
        "https://user:secret@docs.example.invalid",
        "https://docs.example.invalid:444",
        "file:///etc/passwd",
        "https://localhost",
        "https://docs.example.invalid\\@evil.invalid",
    ]) {
        await assert.rejects(readPublicDocument(url));
    }

    assert.equal(network.reads.length, 1, "invalid sources never reach HTTPS");

    for (const address of [
        "127.0.0.1",
        "10.1.2.3",
        "169.254.169.254",
        "172.16.1.1",
        "192.168.1.1",
        "100.64.1.1",
        "0.0.0.0",
        "198.18.1.1",
        "224.0.0.1",
    ]) {
        network.addresses([{ address, family: 4 }]);
        await assert.rejects(readPublicDocument(source), /refuses private/);
    }

    network.addresses([
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
    ]);
    await assert.rejects(readPublicDocument(source), /refuses private/);
    assert.equal(network.reads.length, 1);
    network.addresses([{ address: "93.184.216.34", family: 4 }]);
    network.response({
        status: 302,
        headers: { location: "https://127.0.0.1/private" },
        chunks: [],
    });
    await assert.rejects(readPublicDocument(source));
    assert.equal(network.reads.length, 2, "a redirect cannot skip destination checks");
    network.response({ status: 302, headers: { location: "/loop" }, chunks: [] });
    await assert.rejects(readPublicDocument(source), /redirect limit/);
    assert.equal(network.reads.length, 7, "redirect chains are bounded");
    network.response({
        status: 200,
        headers: { "content-type": "text/plain" },
        chunks: ["x".repeat(2 * 1024 * 1024 + 1)],
    });
    await assert.rejects(readPublicDocument(source), /2 MiB/);
    network.response({
        status: 200,
        headers: { "content-type": "application/octet-stream" },
        chunks: ["not a document"],
    });
    await assert.rejects(readPublicDocument(source), /documents only/);
    network.response({ status: 503, headers: {}, chunks: [] });
    await assert.rejects(readPublicDocument(source), /HTTP 503/);
    const before = network.reads.length;

    await assert.rejects(readPublicDocument(source, AbortSignal.abort()));
    assert.equal(network.reads.length, before, "pre-cancelled reads never reach transport");
    network.lookup.mock.mockImplementation(() => new Promise<never>(() => {}));
    const controller = new AbortController();
    const pending = readPublicDocument(source, controller.signal);

    controller.abort();
    await assert.rejects(pending);
    assert.equal(network.reads.length, before, "DNS waiting is cancellable");
});

test("Worker research reaches the model and isolated storage; Researcher/helpers inherit it while predecessors and Pull cannot", async (t) => {
    const network = transport(t);
    const f = await fixture(t);

    await f.app.commands.setPlan(f.id, owner(f.app), true);
    const result = await f.send("research", { action: "read", url: source });
    const downloaded = result.match(/Local path: ([^\n]+)/)?.[1];

    assert.ok(downloaded);
    assert.ok(downloaded.startsWith(join(f.app.dataDir, "research", String(f.id))));
    assert.equal(readFileSync(downloaded, "utf8"), "<h1>Primary evidence</h1>");
    assert.equal(readFileSync(join(f.cwd, "code.txt"), "utf8"), "existing implementation\n");
    assert.match(await f.send("research", { action: "cleanup" }), /Plan mode is on/);
    assert.equal(existsSync(downloaded), true);
    await f.app.commands.setPlan(f.id, owner(f.app), false);
    const documentReads = network.reads.length;
    const quotaFiles = ["quota-a", "quota-b", "quota-c"].map((name) =>
        join(f.app.dataDir, "research", String(f.id), name),
    );

    for (const path of quotaFiles) {
        writeFileSync(path, "");
        truncateSync(path, 90 * 1024 * 1024);
    }

    assert.match(
        await f.send("research", { action: "read", url: source }),
        /Research storage is full/,
    );
    assert.equal(
        network.reads.length,
        documentReads,
        "storage admission counts all retained sources before reading",
    );
    quotaFiles.forEach((path) => unlinkSync(path));

    for (const url of [
        "https://gitlab.com/team/project",
        "https://github.com/team/project?ref=main",
        "ssh://github.com/team/project",
        "https://token@github.com/team/project",
        "file:///tmp/upstream",
    ]) {
        assert.match(
            await f.send("research", { action: "clone", url }),
            /public.*(?:URL only|hostname)/,
        );
    }

    assert.equal(
        network.reads.length,
        documentReads,
        "invalid clone URLs never reach document transport",
    );
    assert.equal(
        (await readdir(join(f.app.dataDir, "research", String(f.id)))).length,
        1,
        "invalid clones remove their staging directories",
    );
    await f.send("subagent", {
        action: "spawn",
        name: "research-helper",
        message: "HELPER_RESEARCH",
        tools: ["research"],
    });
    const helper = (await f.app.harness.snapshot(SubagentsDoc, f.id, context))?.agents[
        "research-helper"
    ]?.conversationId;

    assert.ok(helper);
    await until(async () => {
        const reports = await f.app.harness.snapshot(SubagentsDoc, f.id, context);

        return (
            !f.app.isBusy(helper) &&
            !f.app.isBusy(f.id) &&
            (reports?.outbox?.length ?? 0) === 0 &&
            reports?.sending === undefined &&
            reports?.agents["research-helper"]?.answeredAt !== undefined &&
            (reports?.batches ?? 0) > 0
        );
    }, "research helper report delivered and parent idle");
    assert.match((await modelTexts(f.app, helper)).join("\n"), /Primary evidence/);
    const researcher = await f.handoff(f.id, "researcher");

    assert.equal(f.app.sessionMeta(researcher)?.workItemId, f.app.sessionMeta(f.id)?.workItemId);
    assert.match(
        await f.send("research", { action: "read", url: source }, researcher),
        /Primary evidence/,
    );
    const before = network.reads.length;

    assert.match(await f.send("research", { action: "read", url: source }), /read-only/);
    assert.equal(network.reads.length, before, "a resumed predecessor cannot download");
    assert.match(
        await f.send(
            "browser",
            { action: "evaluate", script: "fetch('https://evil.invalid')" },
            researcher,
        ),
        /static reader/,
    );
    assert.equal(
        network.reads.length,
        before,
        "unsafe browser actions are blocked before opening Chromium",
    );
    // Pull intake supplies the history required for Follow-up; research alone is not review.
    const intake = await f.handoff(researcher, "pull");
    const followUp = await f.handoff(intake, "follow-up");

    assert.match(
        await f.send("research", { action: "read", url: source }, followUp),
        /Primary evidence/,
    );
    assert.match(await f.send("research", { action: "cleanup" }, followUp), /Removed this thread/);
    assert.equal(existsSync(join(f.app.dataDir, "research", String(followUp))), false);
    assert.equal(
        existsSync(downloaded),
        true,
        "cleanup never removes the predecessor's cited downloads",
    );

    const pull = await f.handoff(followUp, "pull");
    const reads = network.reads.length;

    assert.match(
        await f.send("research", { action: "read", url: source }, pull),
        /Research is available only/,
    );
    assert.equal(network.reads.length, reads);
});

test(
    "research cloning inspects a real isolated Git snapshot without changing working refs, running configured filters or following symlinks",
    { skip: process.platform !== "darwin" },
    async (t) => {
        const network = transport(t);
        const f = await fixture(t);
        const upstream = join(f.directory, "upstream");

        mkdirSync(upstream);
        git(upstream, "init", "-q", "--initial-branch=main");
        git(upstream, "config", "user.name", "Test");
        git(upstream, "config", "user.email", "test@example.invalid");
        writeFileSync(join(upstream, "README.md"), "Repository evidence\n");
        symlinkSync("/etc/passwd", join(upstream, "external-link"));
        writeFileSync(join(upstream, ".gitattributes"), "README.md filter=attack\n");
        git(upstream, "add", ".");
        git(upstream, "commit", "-qm", "evidence");
        const commit = git(upstream, "rev-parse", "HEAD");
        const original = childProcess.spawn;
        let calls = 0;

        // Substitute only the remote transport with a disposable file remote. The clone, tree admission and checkout
        // remain real Git in the production OS sandbox; this does not claim live GitHub/TLS verification.
        t.mock.method(childProcess, "spawn", ((program, args, options) => {
            calls++;
            assert.equal(program, "/usr/bin/sandbox-exec");
            assert.equal(options?.env?.GIT_TERMINAL_PROMPT, "0");
            assert.equal(options?.env?.GITHUB_TOKEN, undefined);
            assert.equal(options?.env?.GIT_CONFIG_COUNT, undefined);
            const argv = [...args!];
            const at = argv.indexOf("https://github.com/team/project.git");

            assert.ok(at > 0);
            argv[at] = `file://${upstream}`;
            argv.splice(argv.indexOf("clone"), 0, "-c", "protocol.file.allow=always");

            return original(program, argv, options);
        }) as typeof childProcess.spawn);
        writeFileSync(join(f.cwd, "dirty.txt"), "Keep this work\n");
        const refs = git(f.cwd, "show-ref");
        const status = git(f.cwd, "status", "--porcelain");
        const injected = ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"];
        const prior = injected.map((key) => process.env[key]);
        const filterMarker = join(f.directory, "filter-executed");

        t.after(() => {
            injected.forEach((key, index) => {
                if (prior[index] === undefined) {
                    delete process.env[key];
                } else {
                    process.env[key] = prior[index];
                }
            });
        });
        process.env.GIT_CONFIG_COUNT = "1";
        process.env.GIT_CONFIG_KEY_0 = "filter.attack.smudge";
        process.env.GIT_CONFIG_VALUE_0 = `touch ${filterMarker}; cat`;
        const result = await f.send("research", {
            action: "clone",
            url: "https://github.com/team/project",
        });
        const path = result.match(/Local path: ([^\n]+)/)?.[1];

        assert.ok(path, result);
        assert.match(result, new RegExp(commit));
        assert.equal(readFileSync(join(path, "README.md"), "utf8"), "Repository evidence\n");
        assert.equal(
            existsSync(filterMarker),
            false,
            "launch-environment Git filters never execute",
        );
        assert.equal((await lstat(join(path, "external-link"))).isSymbolicLink(), false);
        assert.equal(readFileSync(join(path, "external-link"), "utf8"), "/etc/passwd");
        assert.equal(existsSync(join(path, ".git", "shallow")), true);
        assert.equal(git(f.cwd, "show-ref"), refs);
        assert.equal(git(f.cwd, "status", "--porcelain"), status);
        assert.equal(network.reads.length, 0, "clone never uses document transport");

        assert.equal(calls, 1, "the adapter performs one clone without automatic retries");
    },
);

// Pipe-backed CDP responses model Chromium's document writes, not the owner's cancellation or ordering.
// Actual Chromium sanitization/resource isolation is exercised by the static-reader test below.
function readerCdp(t: TestContext) {
    const output = new PassThrough();
    const input = new PassThrough();
    const connection = new Connection(output, input);
    let contents = "";

    output.on("data", (chunk: Buffer) => {
        const request = JSON.parse(chunk.toString().replace(/\0$/, ""));
        let result: unknown = {};

        if (request.method === "Target.attachToTarget") {
            result = { sessionId: "reader" };
        } else if (request.method === "Target.createTarget") {
            result = { targetId: "target" };
        } else if (request.method === "Target.createBrowserContext") {
            result = { browserContextId: "isolated" };
        } else if (request.method === "Page.getFrameTree") {
            result = { frameTree: { frame: { id: "frame" } } };
        } else if (request.method === "Runtime.evaluate") {
            // Only the simple h1 fixtures are parsed here; no claim of sanitizer fidelity.
            const encoded = /parseFromString\(("(?:\\.|[^"\\])*"),/.exec(
                request.params.expression,
            )?.[1];

            result = {
                result: {
                    value: {
                        body: encoded === undefined ? "" : JSON.parse(encoded),
                        title: "Evidence",
                    },
                },
            };
        } else if (request.method === "Page.setDocumentContent") {
            contents = request.params.html;
        }

        queueMicrotask(() => input.write(`${JSON.stringify({ id: request.id, result })}\0`));
    });
    t.mock.method(
        Chromium,
        "launch",
        async () =>
            ({
                connection,
                userAgent: "fixture",
                stop: async () => {},
                kill: () => {},
            }) as unknown as Chromium,
    );
    t.after(() => {
        connection.close("Fixture finished.");
        output.destroy();
        input.destroy();
    });

    return { contents: () => contents };
}

test("managed document navigation cancels replaced, stopped and closed reads without leaving stale rendered content", async (t) => {
    for (const [action, phase] of [
        ["replace", "dns"],
        ["stop", "dns"],
        ["close", "dns"],
        ["replace", "sanitize"],
        ["replace", "render"],
        ["stop", "sanitize"],
        ["stop", "render"],
    ] as const) {
        // Each case owns its mock tracker: stacked replacements in one tracker restore in insertion
        // order and can leak a previous case's closed CDP connection into the real-browser test.
        await t.test(`${action} during ${phase}`, async (t) => {
            const network = transport(t);
            const send = Connection.prototype.send;
            let release!: () => void;
            let began!: () => void;
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            const started = new Promise<void>((resolve) => {
                began = resolve;
            });
            let newerSanitized!: () => void;
            const newerReady = new Promise<void>((resolve) => {
                newerSanitized = resolve;
            });
            let paused = false;
            let armed = false;
            const previous = "https://docs.example.invalid/previous";
            const slow = "https://slow.example.invalid/guide";

            const pause = async (stage: string) => {
                if (armed && stage === phase && !paused) {
                    paused = true;
                    began();
                    await gate;
                }
            };

            network.lookup.mock.mockImplementation(async (hostname: string) => {
                if (hostname === "slow.example.invalid") {
                    await pause("dns");
                }

                return [{ address: "93.184.216.34", family: 4 }];
            });
            t.mock.method(
                Connection.prototype,
                "send",
                async function (this: Connection, ...args: Parameters<typeof send>) {
                    if (
                        args[0] === "Runtime.evaluate" &&
                        String(args[1]?.expression).includes("new DOMParser")
                    ) {
                        const result = await send.apply(this, args);

                        if (String(args[1]?.expression).includes("Current evidence")) {
                            newerSanitized();
                        } else {
                            await pause("sanitize");
                        }

                        return result;
                    }

                    if (args[0] === "Page.setDocumentContent") {
                        // Delivery may still finish after the cancellation. Keep the actual Chromium write.
                        await pause("render");
                    }

                    return send.apply(this, args);
                },
            );
            const cdp = readerCdp(t);
            const saved: string[] = [];
            const browsers = new Browsers({
                executable: "fixture",
                dataDir: join(root, `cancel-reader-${action}-${phase}`),
                researchReader: () => true,
                save: (_id, value) => {
                    saved.push(value.url ?? "");
                },
            });

            try {
                const page = await browsers.open(1, { restore: false });

                network.response({
                    status: 200,
                    headers: { "content-type": "text/html" },
                    chunks: ["<h1>Previous evidence</h1>"],
                });
                await page.navigate(previous);
                saved.length = 0;
                armed = true;
                network.response({
                    status: 200,
                    headers: { "content-type": "text/html" },
                    chunks: ["<h1>Stale evidence</h1>"],
                });
                const pending = page.navigate(slow).then(
                    () => "completed",
                    () => "cancelled",
                );

                await started;
                assert.equal(page.state(true).loading, true);
                let replacement: Promise<unknown> = Promise.resolve();

                if (action === "replace") {
                    network.response({
                        status: 200,
                        headers: { "content-type": "text/html" },
                        chunks: ["<h1>Current evidence</h1>"],
                    });
                    replacement = page.navigate(source);
                } else if (action === "stop") {
                    replacement = page.stop();
                } else {
                    page.close();
                }

                if (action === "replace" && phase !== "dns") {
                    await newerReady;
                    // Let the replacement's ready write reach the CDP boundary while the old one is held.
                    await new Promise<void>((resolve) => setImmediate(resolve));
                }

                release();
                assert.equal(await pending, "cancelled", `${action} during ${phase}`);
                await replacement;
                assert.deepEqual(saved, action === "replace" ? [source] : []);
                assert.equal(page.url, action === "replace" ? source : previous);
                assert.equal(page.state(true).loading, false);

                if (action === "close") {
                    await assert.rejects(page.navigate(source), /page is closed/);
                } else {
                    assert.doesNotMatch(
                        cdp.contents(),
                        /Stale evidence/,
                        `${action} during ${phase} must not leave stale content`,
                    );

                    assert.match(
                        cdp.contents(),
                        action === "replace" ? /Current evidence/ : /Previous evidence/,
                    );
                }
            } finally {
                release();
                await browsers.closeAll();
            }
        });
    }
});

test("saved reader restoration cancels an abandoned open but preserves a concurrent caller's shared page", async (t) => {
    for (const concurrent of [false, true]) {
        await t.test(concurrent ? "shared waiter" : "abandoned waiter", async (t) => {
            const network = transport(t);
            let began!: () => void;
            let release!: () => void;
            const started = new Promise<void>((resolve) => {
                began = resolve;
            });
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });

            network.lookup.mock.mockImplementation(async () => {
                began();
                await gate;

                return [{ address: "93.184.216.34", family: 4 }];
            });
            const cdp = readerCdp(t);
            const saved: string[] = [];
            const browsers = new Browsers({
                executable: "fixture",
                dataDir: join(root, `restore-reader-${concurrent}`),
                researchReader: () => true,
                load: async () => ({ url: source }),
                save: (_id, value) => {
                    saved.push(value.url ?? "");
                },
            });
            const controller = new AbortController();
            const before = network.reads.length;

            try {
                const pending = browsers.open(1, { signal: controller.signal }).then(
                    () => "completed",
                    () => "cancelled",
                );

                await started;
                const immediate = await browsers.open(1, {
                    restore: false,
                    signal: AbortSignal.timeout(1000),
                });

                assert.equal(
                    immediate,
                    browsers.page(1),
                    "a new navigation can reuse the page without waiting for saved DNS",
                );
                const other = concurrent ? browsers.open(1) : undefined;

                controller.abort();
                release();
                assert.equal(
                    await pending,
                    "cancelled",
                    "caller cancellation must reach saved-address restoration",
                );
                const page = other === undefined ? await browsers.open(1) : await other;

                assert.equal(
                    page.closed,
                    false,
                    "cancelling a waiter never closes the shared page",
                );
                assert.equal(browsers.page(1), page);
                assert.equal(network.reads.length - before, concurrent ? 1 : 0);
                assert.deepEqual(saved, concurrent ? [source] : []);
                assert.equal(page.url, concurrent ? source : "about:blank");
                assert.equal(page.state(true).loading, false);

                if (concurrent) {
                    assert.match(cdp.contents(), /Primary evidence/);
                } else {
                    assert.doesNotMatch(cdp.contents(), /Primary evidence/);
                }
            } finally {
                release();
                await browsers.closeAll();
            }
        });
    }
});

test(
    "managed browser renders evidence as a static document with no executable content or live links",
    { skip: findBrowser() === undefined ? "no Chromium installed" : false },
    async (t) => {
        const network = transport(t);

        network.response({
            status: 200,
            headers: { "content-type": "text/html" },
            chunks: [
                '<title>Evidence</title><h1>Verified text</h1><details open><summary>Build options</summary><p>Expanded source evidence</p></details><details><summary>Compatibility</summary><p>Collapsed source evidence</p></details><p><a href="/api">API documentation</a></p><script>document.body.textContent="UNSAFE";fetch("https://evil.invalid")</script><img src="https://evil.invalid/image"><iframe src="https://evil.invalid/frame"></iframe><form action="https://evil.invalid"><input value="secret"><button>Submit</button></form><div onclick="fetch(\'https://evil.invalid\')">More evidence</div>',
            ],
        });
        const browsers = new Browsers({
            dataDir: join(root, "research-browser"),
            researchReader: () => true,
        });

        try {
            const page = await browsers.open(1, { restore: false });

            await page.navigate(source);
            const outline = await page.snapshot();

            assert.match(outline.lines, /Verified text/);
            assert.match(outline.lines, /Expanded source evidence/);
            assert.match(outline.lines, /Collapsed source evidence/);
            assert.match(outline.lines, /https:\/\/docs\.example\.invalid\/api/);
            assert.doesNotMatch(outline.lines, /UNSAFE|Submit|textbox|button|link "/);
            assert.equal(page.url, source);
            assert.ok((await page.screenshot()).data.length > 0);
            assert.equal(network.reads.length, 1, "only the explicit document is read");
            // The rendered DOM itself has no resource/event/form/URL surface, even when a human uses the shared panel.
            assert.equal(
                await page.evaluate(
                    "document.querySelectorAll('script,img,iframe,form,input,button,details,summary,[href],[src],[onclick]').length",
                ),
                "0",
            );
        } finally {
            await browsers.closeAll();
        }
    },
);
