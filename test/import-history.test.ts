// Real HTTP/service history discovery; ordinary Pi fixtures and isolated roots only.
import { cleanUp, context, openApp, owner, root, scriptedModel, work } from "./helpers.ts";
import assert from "node:assert/strict";
import {
    appendFileSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    symlinkSync,
    truncateSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import fs from "node:fs/promises";
import { IncomingMessage, ServerResponse } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { Socket } from "node:net";
import { dirname, join } from "node:path";
import { after, mock, test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createHandler } from "../src/server/http.ts";
import { ImportsDoc } from "../src/server/docs.ts";
import { fakeHerdr } from "./active-import-fixture.ts";

const agent = process.env.PI_CODING_AGENT_DIR!;

after(cleanUp);

async function isolatedHistory(
    name: string,
    run: (app: Awaited<ReturnType<typeof openApp>>, directory: string) => Promise<void>,
) {
    const previous = process.env.PI_CODING_AGENT_DIR;
    const directory = join(root, `agent-${name}`);

    mkdirSync(directory);
    process.env.PI_CODING_AGENT_DIR = directory;
    const app = await openApp(scriptedModel(), join(root, `data-${name}`));

    app.piSessions.active.local.sockets = async () => [];

    try {
        await run(app, directory);
    } finally {
        await app.close();
        process.env.PI_CODING_AGENT_DIR = previous;
    }
}

function saved(cwd: string, prompt: string, name?: string) {
    mkdirSync(cwd, { recursive: true });
    const source = SessionManager.create(cwd);

    if (name) {
        source.appendSessionInfo(name);
    }

    source.appendMessage({ role: "user", content: prompt, timestamp: Date.now() });
    source.appendMessage(fauxAssistantMessage("A saved answer"));
    const path = source.getSessionFile()!;

    return { source, path: realpathSync(path), bytes: readFileSync(path) };
}

test("HTTP history lists saved Pi titles and paths newest first across project directories without publishing", async () => {
    const older = saved(join(work, "history/project-one"), "Repair the index", "Named index work");
    const newer = saved(join(work, "history/nested/project-two"), "Explain the failing checkout");

    utimesSync(older.path, 1_700_000_000, 1_700_000_000);
    utimesSync(newer.path, 1_700_000_100, 1_700_000_100);
    assert.notEqual(dirname(older.path), dirname(newer.path));
    const model = scriptedModel();
    const app = await openApp(model, join(root, "data-history-http"));

    const sockets = mock.fn(async (): Promise<string[]> => []);

    app.piSessions.active.local.sockets = sockets;
    const guest = app.config.addUser("History guest", "guest");
    const handler = createHandler({
        app,
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
    });

    // Exercise the real authenticated HTTP handler without a network listener.
    const get = async (token: string) => {
        const request = new IncomingMessage(new Socket());
        const response = new ServerResponse(request);
        let output = "";

        request.url = "/api/pi-sessions/history";
        request.method = "GET";
        request.headers = { authorization: `Bearer ${token}` };

        response.end = (chunk?: unknown) => {
            output = String(chunk ?? "");

            return response;
        };

        await handler(request, response);

        return new Response(output, {
            status: response.statusCode,
            headers: { "cache-control": String(response.getHeader("cache-control") ?? "") },
        });
    };

    try {
        for (const token of ["invalid", guest.token]) {
            const denied = await get(token);

            assert.equal(denied.status, token === "invalid" ? 401 : 403);
            assert.doesNotMatch(
                await denied.text(),
                /Named index work|Explain the failing checkout/,
            );
        }

        await assert.rejects(app.piSessions.history(guest.user), { status: 403 });
        assert.equal(sockets.mock.callCount(), 0, "ownership is checked before local discovery");
        const response = await get(app.config.ownerToken);

        assert.equal(response.status, 200, "the history picker has a real HTTP endpoint");
        assert.equal(response.headers.get("cache-control"), "no-store");
        const list = await response.json();

        assert.deepEqual(list.sessions, [
            {
                path: newer.path,
                title: "Explain the failing checkout",
                cwd: join(work, "history/nested/project-two"),
                modified: 1_700_000_100_000,
                messages: 2,
            },
            {
                path: older.path,
                title: "Named index work",
                cwd: join(work, "history/project-one"),
                modified: 1_700_000_000_000,
                messages: 2,
            },
        ]);
        assert.equal(list.directory, realpathSync(join(agent, "sessions")));
        assert.equal(sockets.mock.callCount(), 1, "authorized history runs real discovery");
        assert.match(list.warnings.join(" "), /may still be running/i);
        assert.match(list.warnings.join(" "), /does not stop or change/i);
        assert.equal(app.sessions().length, 0);
        assert.equal(await app.harness.snapshot(ImportsDoc, context), undefined);
        assert.equal((await app.harness.inspect(context)).tasks.length, 0);
        assert.equal(model.state.callCount, 0);
        assert.deepEqual(readFileSync(older.path), older.bytes);
        assert.deepEqual(readFileSync(newer.path), newer.bytes);
    } finally {
        await app.close();
    }
});

test("saved-file preview returns only the latest six bounded plain-text messages from the selected branch", async () => {
    await isolatedHistory("excerpts", async (app) => {
        const fixture = saved(join(work, "excerpts"), "Shared first prompt");
        const source = fixture.source;
        const point = source.getLeafId()!;

        source.appendMessage({ role: "user", content: "Alternate prompt", timestamp: Date.now() });
        const alternate = source.appendMessage(fauxAssistantMessage("Alternate answer"));

        source.branch(point);

        for (const number of [1, 2]) {
            source.appendMessage({
                role: "user",
                content: "Main prompt " + number,
                timestamp: Date.now(),
            });
            source.appendMessage(fauxAssistantMessage("Main answer " + number));
        }

        source.appendMessage({ role: "user", content: "x".repeat(2000), timestamp: Date.now() });
        source.appendMessage(
            fauxAssistantMessage([
                { type: "thinking", thinking: "PRIVATE_THINKING" },
                { type: "text", text: "Main answer 3" },
            ]),
        );
        source.appendMessage({
            role: "user",
            content: [
                { type: "text", text: "Main prompt 4" },
                { type: "image", mimeType: "image/png", data: "PRIVATE_IMAGE" },
            ],
            timestamp: Date.now(),
        });
        source.appendMessage(
            fauxAssistantMessage(
                [
                    {
                        type: "toolCall",
                        id: "private-call",
                        name: "read",
                        arguments: { path: "PRIVATE_TOOL_ARGUMENT" },
                    },
                ],
                { stopReason: "toolUse" },
            ),
        );
        source.appendMessage({
            role: "toolResult",
            toolCallId: "private-call",
            toolName: "read",
            content: [{ type: "text", text: "PRIVATE_TOOL_RESULT" }],
            isError: false,
            timestamp: Date.now(),
        });
        source.appendMessage(fauxAssistantMessage("Main answer 4"));
        const before = readFileSync(fixture.path);
        const preview = await app.piSessions.preview(owner(app), { path: fixture.path });

        assert.equal(preview.history.length, 6);
        assert.deepEqual(
            preview.history.map((item) => item.role),
            ["user", "assistant", "user", "assistant", "user", "assistant"],
        );
        assert.deepEqual(
            preview.history.map((item) => item.text).filter((text) => !text.startsWith("x")),
            ["Main prompt 2", "Main answer 2", "Main answer 3", "Main prompt 4", "Main answer 4"],
        );
        assert.equal(preview.history[2]!.text.length, 400);
        assert.ok(preview.history[2]!.text.endsWith("…"));
        assert.doesNotMatch(
            JSON.stringify(preview.history),
            /PRIVATE_|Alternate|Shared first|Main prompt 1/,
        );
        const other = await app.piSessions.preview(owner(app), {
            path: fixture.path,
            leafId: alternate,
        });

        assert.deepEqual(other.history, [
            { role: "user", text: "Shared first prompt" },
            { role: "assistant", text: "A saved answer" },
            { role: "user", text: "Alternate prompt" },
            { role: "assistant", text: "Alternate answer" },
        ]);
        assert.deepEqual(readFileSync(fixture.path), before);
        assert.equal(app.sessions().length, 0);
        assert.equal(await app.harness.snapshot(ImportsDoc, context), undefined);
        assert.equal((await app.harness.inspect(context)).tasks.length, 0);
        await assert.rejects(
            app.piSessions.create(owner(app), {
                path: preview.path,
                leafId: preview.leafId,
                sha256: preview.sha256,
                acknowledged: false,
                model: "faux/faux-vision",
                thinkingLevel: "off",
            }),
            /Confirm copying/,
        );
        source.appendMessage({
            role: "user",
            content: "Unsaved pending request",
            timestamp: Date.now(),
        });
        const pending = await app.piSessions.preview(owner(app), { path: fixture.path });

        assert.equal(pending.history.at(-1)?.text, "Unsaved pending request");
        assert.equal((await app.harness.inspect(context)).tasks.length, 0);
    });
});

test("history ignores malformed, oversized, unsupported and symlinked files without traversing deeper directories", async () => {
    await isolatedHistory("unsafe", async (app, directory) => {
        const fixture = saved(join(work, "safe-history"), "Safe prompt", "Safe history");
        const project = dirname(fixture.path);
        const outside = saved(join(work, "outside-history"), "SECRET_OUTSIDE", "SECRET_OUTSIDE");
        const external = join(root, "outside.jsonl");

        writeFileSync(external, outside.bytes);
        // The genuine outside session is removed from the discovery tree, leaving only a link to it.
        writeFileSync(outside.path, "not a session");
        symlinkSync(external, join(project, "linked.jsonl"));
        symlinkSync(dirname(external), join(directory, "sessions", "linked-project"));
        writeFileSync(join(project, "malformed.jsonl"), "{bad json");
        writeFileSync(
            join(project, "unsupported.jsonl"),
            fixture.bytes.toString().replace('"version":3', '"version":2'),
        );
        writeFileSync(join(project, "invalid-utf8.jsonl"), Buffer.from([0xff]));
        const oversized = join(project, "oversized.jsonl");

        writeFileSync(oversized, "");
        truncateSync(oversized, 16 * 1024 * 1024 + 1);
        mkdirSync(join(project, "deeper"));
        writeFileSync(join(project, "deeper", "nested.jsonl"), outside.bytes);
        const list = await app.piSessions.history(owner(app));

        assert.deepEqual(
            list.sessions.map((item) => item.path),
            [fixture.path],
        );
        assert.doesNotMatch(JSON.stringify(list), /SECRET_OUTSIDE/);
        assert.match(list.warnings.join(" "), /symbolic links/);
        assert.match(list.warnings.join(" "), /malformed.*unsupported.*oversized/);
        assert.deepEqual(readFileSync(fixture.path), fixture.bytes);
        assert.deepEqual(readFileSync(external), outside.bytes);
        assert.equal(app.sessions().length, 0);
    });
});

test("missing and symlinked session roots return an empty list with warnings", async () => {
    await isolatedHistory("missing", async (app, directory) => {
        const missing = await app.piSessions.history(owner(app));

        assert.deepEqual(missing.sessions, []);
        assert.match(missing.warnings.join(" "), /missing or unreadable/);
        const outside = join(root, "external-history");

        mkdirSync(outside);
        symlinkSync(outside, join(directory, "sessions"));
        const linked = await app.piSessions.history(owner(app));

        assert.deepEqual(linked.sessions, []);
        assert.match(linked.warnings.join(" "), /links are not followed/);
    });
});

test("history caps and sorts large catalogues and reports a bounded discovery warning", async () => {
    await isolatedHistory("catalogue", async (app) => {
        const fixture = saved(join(work, "catalogue"), "Catalogue prompt", "Catalogue");
        const project = dirname(fixture.path);

        utimesSync(fixture.path, 1, 1);

        for (let index = 0; index < 120; index++) {
            const path = join(project, "copy-" + index + ".jsonl");

            writeFileSync(path, fixture.bytes);
            utimesSync(path, 100 + index, 100 + index);
        }

        const list = await app.piSessions.history(owner(app));

        assert.equal(list.sessions.length, 100);
        assert.equal(list.sessions[0]!.path, join(project, "copy-119.jsonl"));
        assert.equal(list.sessions.at(-1)!.path, join(project, "copy-20.jsonl"));
        assert.match(list.warnings.join(" "), /100 most recently/);
        assert.ok(
            list.sessions.every(
                (item, index) => index === 0 || item.modified <= list.sessions[index - 1]!.modified,
            ),
        );
        assert.ok(JSON.stringify(list).length < 100_000);
    });
});

test("history omits known live files and carries incomplete active discovery warnings without control", async () => {
    await isolatedHistory("active-history", async (app) => {
        const fixture = saved(join(work, "known-live-history"), "Live source", "Live source");
        const { state, local } = fakeHerdr(app, fixture.path);
        const request = local.request;

        local.sockets = async () => ["/synthetic/herdr.sock", "/synthetic/unavailable.sock"];

        local.request = async <T>(
            socket: string,
            method: string,
            params?: Record<string, unknown>,
        ): Promise<T> => {
            if (socket === "/synthetic/unavailable.sock") {
                throw new Error("Offline synthetic instance");
            }

            return request<T>(socket, method, params);
        };

        const list = await app.piSessions.history(owner(app));

        assert.deepEqual(list.sessions, []);
        assert.match(list.warnings.join(" "), /Herdr|discover/);
        assert.deepEqual(state.signals, []);
        assert.deepEqual(state.escapes, []);
        assert.deepEqual(readFileSync(fixture.path), fixture.bytes);

        local.sockets = async () => {
            throw new Error("Discovery unavailable");
        };

        const uncertain = await app.piSessions.history(owner(app));

        assert.equal(uncertain.sessions[0]!.path, fixture.path);
        assert.match(uncertain.warnings.join(" "), /Live Pi discovery is unavailable/);
        assert.match(uncertain.warnings.join(" "), /original Pi may still be running/);
    });
});

test("history stops at its aggregate read budget even when large candidates are malformed", async () => {
    await isolatedHistory("read-budget", async (app, directory) => {
        const project = join(directory, "sessions", "--budget--");

        mkdirSync(project, { recursive: true });

        for (let index = 0; index < 6; index++) {
            const path = join(project, "large-" + index + ".jsonl");

            writeFileSync(path, "");
            truncateSync(path, 16 * 1024 * 1024);
            utimesSync(path, 100 + index, 100 + index);
        }

        const list = await app.piSessions.history(owner(app));

        assert.deepEqual(list.sessions, []);
        assert.match(list.warnings.join(" "), /64 MiB read budget/);
        assert.match(list.warnings.join(" "), /4 malformed/);
        assert.ok(list.warnings.length < 10);
    });
});

test("clearing a saved session name restores its first-user fallback instead of an older name", async () => {
    await isolatedHistory("cleared-name", async (app) => {
        const fixture = saved(
            join(work, "cleared-name"),
            "Repair the checkout",
            "Old session name",
        );

        fixture.source.appendSessionInfo("");
        const before = readFileSync(fixture.path);
        const list = await app.piSessions.history(owner(app));

        assert.equal(list.sessions.length, 1);
        assert.equal(list.sessions[0]!.title, "Repair the checkout");
        assert.deepEqual(readFileSync(fixture.path), before);
    });
});

for (const growth of ["after-stat", "before-stat"]) {
    test("history bounds actual descriptor reads when a candidate grows " + growth, async (t) => {
        await isolatedHistory("descriptor-cap-" + growth, async (app) => {
            const fixture = saved(join(work, "descriptor-cap-" + growth), "Bound the real read");
            const charged = fixture.bytes.length;
            const open = fs.open;
            let grown = false;
            let bytesRead = 0;

            const grow = () => {
                appendFileSync(fixture.path, " ".repeat(4096));
                grown = true;
            };

            const hook = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
                const file = await open(...args);

                if (args[0] !== fixture.path) {
                    return file;
                }

                if (growth === "before-stat") {
                    grow();
                }

                const stat = file.stat.bind(file);
                const read = file.read.bind(file);

                t.mock.method(file, "stat", async (...options: Parameters<typeof file.stat>) => {
                    const before = await stat(...options);

                    if (!grown) {
                        grow();
                    }

                    return before;
                });
                t.mock.method(
                    file,
                    "read",
                    async (buffer: Buffer, offset: number, length: number, position: number) => {
                        const result = await read(buffer, offset, length, position);

                        bytesRead += result.bytesRead;

                        return result;
                    },
                );

                return file;
            });

            syncBuiltinESMExports();

            try {
                const list = await app.piSessions.history(owner(app));

                assert.equal(grown, true, "fault injection reached the actual opened descriptor");
                assert.deepEqual(list.sessions, [], "both readers reject the changed source");
                assert.match(list.warnings.join(" "), /changed session files were omitted/);
                assert.equal(app.sessions().length, 0);

                if (growth === "after-stat") {
                    assert.ok(
                        bytesRead > 0,
                        "growth after FD stat cannot be rejected only at precheck",
                    );
                }

                assert.ok(
                    bytesRead <= charged,
                    "read " + bytesRead + " bytes against a " + charged + "-byte discovery charge",
                );

                if (growth === "before-stat") {
                    assert.equal(
                        bytesRead,
                        0,
                        "an already over-budget descriptor must not be read",
                    );
                }
            } finally {
                hook.mock.restore();
                syncBuiltinESMExports();
            }
        });
    });
}
