import { cleanUp, context, openApp, owner, root, scriptedModel, work, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { createHandler } from "../src/server/http.ts";
import { join } from "node:path";
import { after, test } from "node:test";
import { ImportedSessionDoc, TakeoversDoc } from "../src/server/docs.ts";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import {
    herdrRequest,
    isPiArgv,
    localProcesses,
    LocalPiSessions,
    parseProcesses,
} from "../src/server/imports/herdr.ts";
import { fakeHerdr } from "./active-import-fixture.ts";
import { importFixture } from "./import-fixtures.ts";

after(cleanUp);

const request = (
    preview: Awaited<
        ReturnType<Awaited<ReturnType<typeof openApp>>["imports"]["active"]["preview"]>
    >,
) => ({
    id: preview.activeId,
    sha256: preview.sha256,
    leafId: preview.leafId,
    model: "faux/faux-vision",
    thinkingLevel: "off",
    acknowledged: true,
});

async function fixture(name: string) {
    const folder = join(work, name);

    mkdirSync(folder);
    const source = importFixture(folder);
    const model = scriptedModel();
    const app = await openApp(model, join(root, `data-${name}`));
    const herdr = fakeHerdr(app, source.path);

    return { source, app, model, ...herdr };
}

test("active discovery hides paths and PIDs; move stops one Pi, preserves the shell and archives without replay", async () => {
    const { source, app, state, pi, shell } = await fixture("move");

    try {
        const list = await app.imports.active.list(owner(app));

        assert.equal(list.sessions.length, 1);
        assert.equal(list.sessions[0]!.reason, undefined);
        assert.doesNotMatch(JSON.stringify(list), /73002|herdr\.sock/);
        assert.equal(JSON.stringify(list).includes(source.path), false);
        const preview = await app.imports.active.preview(owner(app), { id: list.sessions[0]!.id });
        const input = request(preview);
        const [result, retry] = await Promise.all([
            app.imports.active.move(owner(app), input),
            app.imports.active.move(owner(app), input),
        ]);

        assert.equal(result.id, retry.id);
        assert.deepEqual(state.signals, [pi.pid]);
        assert.deepEqual(state.table, [shell]);
        assert.equal(app.sessions().length, 1);
        assert.equal(await app.imports.archive(owner(app), result.id), source.archive);
        assert.equal(readFileSync(source.path, "utf8"), source.archive);
        assert.equal((await app.harness.inspect(context)).tasks.length, 0);
        await app.close();
        const reopened = await openApp(scriptedModel(), join(root, "data-move"));

        try {
            const herdr = fakeHerdr(reopened, source.path);
            const existing = await reopened.imports.active.move(owner(reopened), input);

            assert.deepEqual(existing, { id: result.id, existing: true });
            assert.deepEqual(herdr.state.signals, []);
        } finally {
            await reopened.close();
        }
    } finally {
        await app.close();
    }
});

test("idle Pi remains importable after web terminal input", async () => {
    const { app, state, pi, shell } = await fixture("terminal-idle-import");

    try {
        await app.privateSessions.markTerminalInput(owner(app), "/synthetic/herdr.sock");
        const list = await app.imports.active.list(owner(app));

        assert.equal(list.sessions[0]!.reason, undefined, "idle Pi must be selectable");
        const preview = await app.imports.active.preview(owner(app), { id: list.sessions[0]!.id });
        const result = await app.imports.active.move(owner(app), request(preview));

        assert.ok(result.id);
        assert.deepEqual(state.signals, [pi.pid]);
        assert.deepEqual(state.table, [shell]);
    } finally {
        await app.close();
    }
});

for (const tail of ["user", "toolResult"] as const) {
    test(`externally aborted idle Pi imports its complete ${tail} tail without Escape or replay`, async () => {
        const { app, source, state, pi, shell, model } = await fixture(`manual-abort-${tail}`);

        source.source.appendMessage({
            role: "user",
            content: "MANUALLY_ABORTED_REQUEST",
            timestamp: Date.now(),
        });

        if (tail === "toolResult") {
            source.source.appendMessage({
                ...fauxAssistantMessage(""),
                stopReason: "toolUse",
                content: [
                    {
                        type: "toolCall",
                        id: "manual-call",
                        name: "bash",
                        arguments: { command: "NEVER_EXECUTE_MANUAL_HISTORY" },
                    },
                ],
            });
            source.source.appendMessage({
                role: "toolResult",
                toolCallId: "manual-call",
                toolName: "bash",
                content: [{ type: "text", text: "Cancelled manually in terminal" }],
                isError: true,
                timestamp: Date.now(),
            });
        }

        const finalArchive = readFileSync(source.path, "utf8");

        try {
            await app.privateSessions.markTerminalInput(owner(app), "/synthetic/herdr.sock");
            assert.equal(await app.harness.snapshot(TakeoversDoc, context), undefined);
            await assert.rejects(
                app.imports.preview(owner(app), { path: source.path }),
                /saved assistant/,
            );
            const listing = await app.imports.active.list(owner(app));

            assert.equal(listing.sessions[0]!.reason, undefined);
            assert.equal(listing.sessions[0]!.running, false);
            const preview = await app.imports.active.preview(owner(app), {
                id: listing.sessions[0]!.id,
            });

            assert.equal(preview.running, false);
            const result = await app.imports.active.move(owner(app), request(preview));

            assert.equal(await app.imports.archive(owner(app), result.id), finalArchive);
            assert.equal(readFileSync(source.path, "utf8"), finalArchive);
            assert.deepEqual(state.escapes, []);
            assert.deepEqual(state.signals, [pi.pid]);
            assert.deepEqual(state.table, [shell]);
            assert.equal((await app.harness.inspect(context)).tasks.length, 0);
            assert.equal(model.state.callCount, 0);
            assert.match(
                JSON.stringify(
                    (await (await app.conversation(result.id)).context(context)).messages,
                ),
                /MANUALLY_ABORTED_REQUEST/,
            );
        } finally {
            await app.close();
        }
    });
}

test("macOS Herdr PID-only foreground records identify Pi using its exact local process title", async () => {
    const { app, state, pi, shell } = await fixture("pid-only");

    state.omitArgv = true;

    try {
        const list = await app.imports.active.list(owner(app));

        assert.equal(list.sessions.length, 1);
        assert.equal(
            list.sessions[0]!.reason,
            undefined,
            "the real PID-only response must not disable a verified Pi",
        );
        const preview = await app.imports.active.preview(owner(app), { id: list.sessions[0]!.id });

        await app.imports.active.move(owner(app), request(preview));
        assert.deepEqual(state.signals, [pi.pid]);
        assert.deepEqual(state.table, [shell]);
    } finally {
        await app.close();
    }
});

test("PID-only fallback still rejects unrelated processes, nonleaders, other users and the shell", async () => {
    const { app, state, pi, shell } = await fixture("pid-only-refusals");

    state.omitArgv = true;

    try {
        for (const command of [
            "pi-rpc",
            "node unrelated.js",
            "sh -c pi",
            "pi --mode rpc",
            "pi-helper",
        ]) {
            state.table = [shell, { ...pi, command }];
            assert.match(
                (await app.imports.active.list(owner(app))).sessions[0]!.reason!,
                /Cannot identify/,
                command,
            );
        }

        state.table = [shell, { ...pi, uid: pi.uid + 1 }];
        assert.match(
            (await app.imports.active.list(owner(app))).sessions[0]!.reason!,
            /Cannot identify/,
        );
        state.table = [shell, pi];
        state.foregroundGroup = pi.pid + 1;
        assert.match(
            (await app.imports.active.list(owner(app))).sessions[0]!.reason!,
            /Cannot identify/,
        );
        state.foregroundGroup = pi.pid;
        state.shellPid = pi.pid;
        assert.match(
            (await app.imports.active.list(owner(app))).sessions[0]!.reason!,
            /Cannot identify/,
        );
        state.shellPid = shell.pid;
        state.table = [shell, { ...pi, parent: 98765 }];
        assert.match(
            (await app.imports.active.list(owner(app))).sessions[0]!.reason!,
            /Cannot identify/,
        );
        assert.deepEqual(state.signals, []);
    } finally {
        await app.close();
    }
});

test("PID-only detection identifies an ancestor but refuses to stop it with a specific explanation", async () => {
    const { app, state, pi, local } = await fixture("pid-only-ancestor");

    state.omitArgv = true;
    state.table.push({ ...pi, pid: process.pid, parent: pi.pid, command: "app" });

    try {
        const list = await app.imports.active.list(owner(app));

        assert.match(list.sessions[0]!.reason!, /ancestor.*separate shell/);
        await assert.rejects(local.find(list.sessions[0]!.id), /ancestor/);
        assert.deepEqual(state.signals, []);
    } finally {
        await app.close();
    }
});

for (const status of ["working", "blocked"]) {
    test(`${status} Pi previews pending tools, refuses unconfirmed abort, then imports the final saved journal without replay`, async () => {
        const { app, source, state, pi, shell, model } = await fixture(`abort-${status}`);

        state.status = status;
        source.source.appendMessage({
            role: "user",
            content: "RUNNING_TASK",
            timestamp: Date.now(),
        });
        source.source.appendMessage({
            ...fauxAssistantMessage(""),
            stopReason: "toolUse",
            content: [
                {
                    type: "toolCall",
                    id: "running-call",
                    name: "bash",
                    arguments: { command: "NEVER_RUN" },
                },
            ],
        });
        state.table.push({ ...pi, pid: 74000, parent: pi.pid, command: "sleep 100" });
        const signal = app.imports.active.local.signal;

        app.imports.active.local.signal = (pid) => {
            const result = signal(pid);

            source.source.appendCustomEntry("shutdown-flush", { saved: "FINAL_SHUTDOWN_BYTES" });

            return result;
        };

        state.onEscape = async () => {
            const reservation = await app.harness.snapshot(TakeoversDoc, context);

            assert.equal(reservation?.items[id]?.result, undefined);
            assert.ok(reservation?.items[id], "takeover intent must be durable before Escape");
            source.source.appendMessage({
                role: "toolResult",
                toolCallId: "running-call",
                toolName: "bash",
                content: [{ type: "text", text: "Cancelled by Escape" }],
                isError: true,
                timestamp: Date.now(),
            });
        };

        let id = "";

        try {
            const listing = await app.imports.active.list(owner(app));

            assert.equal(listing.sessions[0]!.reason, undefined);
            id = listing.sessions[0]!.id;
            const preview = await app.imports.active.preview(owner(app), { id });

            assert.equal(preview.running, true);
            assert.equal(listing.sessions[0]!.running, true);
            assert.match(preview.warnings.join(" "), /abort.*current/i);
            await assert.rejects(
                app.imports.preview(owner(app), { path: source.path }),
                /Incomplete/,
            );
            await assert.rejects(
                app.imports.active.move(owner(app), request(preview)),
                /abortRunning|abort.*confirm/i,
            );
            await assert.rejects(
                app.imports.active.move(owner(app), { ...request(preview), abortRunning: "true" }),
                /abortRunning|abort.*confirm/i,
            );
            await assert.rejects(
                app.imports.active.move(owner(app), {
                    ...request(preview),
                    abortRunning: true,
                    model: "missing/model",
                }),
                /available destination/,
            );
            assert.deepEqual(state.escapes, []);
            assert.deepEqual(state.signals, []);
            const result = await app.imports.active.move(owner(app), {
                ...request(preview),
                abortRunning: true,
            });
            const finalArchive = readFileSync(source.path, "utf8");
            const provenance = await app.harness.snapshot(ImportedSessionDoc, result.id, context);

            assert.notEqual(finalArchive, source.archive);
            assert.notEqual(provenance!.source!.sha256, preview.sha256);
            assert.notEqual(provenance!.source!.leafId, preview.leafId);
            assert.equal(await app.imports.archive(owner(app), result.id), finalArchive);
            assert.deepEqual(state.escapes, [{ pane_id: "pane", keys: ["esc"] }]);
            assert.deepEqual(state.signals, [pi.pid]);
            assert.deepEqual(state.table, [shell]);
            assert.equal((await app.harness.inspect(context)).tasks.length, 0);
            assert.equal(model.state.callCount, 0);
            assert.match(
                JSON.stringify(
                    (await (await app.conversation(result.id)).context(context)).messages,
                ),
                /Cancelled by Escape/,
            );
        } finally {
            await app.close();
        }
    });
}

test("idle preview racing a busy Pi requires fresh explicit abort consent", async () => {
    const { app, state, pi, shell } = await fixture("abort-race");

    try {
        const id = (await app.imports.active.list(owner(app))).sessions[0]!.id;
        const preview = await app.imports.active.preview(owner(app), { id });

        state.status = "working";
        await assert.rejects(
            app.imports.active.move(owner(app), request(preview)),
            /abortRunning|abort.*confirm/i,
        );
        assert.deepEqual(state.escapes, []);
        assert.deepEqual(state.signals, []);
        await app.imports.active.move(owner(app), { ...request(preview), abortRunning: true });
        assert.equal(state.escapes.length, 1);
        assert.deepEqual(state.signals, [pi.pid]);
        assert.deepEqual(state.table, [shell]);
    } finally {
        await app.close();
    }
});

for (const failure of ["stale-process", "source-switch", "missing-results"] as const) {
    test(`confirmed abort ${failure} never stops Pi or publishes history`, async () => {
        const { app, state, source, pi } = await fixture(`abort-failure-${failure}`);
        const prepare = app.imports.prepare.bind(app.imports);

        state.status = "working";

        if (failure === "missing-results") {
            source.source.appendMessage({
                ...fauxAssistantMessage(""),
                stopReason: "toolUse",
                content: [
                    {
                        type: "toolCall",
                        id: "missing",
                        name: "read",
                        arguments: { path: "NEVER_READ" },
                    },
                ],
            });
        }

        if (failure === "stale-process") {
            app.imports.prepare = async (...args) => {
                const result = await prepare(...args);

                state.table = state.table.map((item) =>
                    item.pid === pi.pid
                        ? { ...item, commandHash: "changed-identity-after-preflight" }
                        : item,
                );

                return result;
            };
        } else if (failure === "source-switch") {
            state.onEscape = () => {
                const entries = readFileSync(source.path, "utf8").split("\n");
                const header = JSON.parse(entries[0]!);

                header.id = "different-session";
                entries[0] = JSON.stringify(header);
                writeFileSync(source.path, entries.join("\n"));
            };
        }

        try {
            const id = (await app.imports.active.list(owner(app))).sessions[0]!.id;
            const preview = await app.imports.active.preview(owner(app), { id });

            await assert.rejects(
                app.imports.active.move(owner(app), { ...request(preview), abortRunning: true }),
                failure === "stale-process"
                    ? /changed or exited|process changed/
                    : failure === "source-switch"
                      ? /identity.*changed/
                      : /Incomplete tool/,
            );
            assert.equal(state.escapes.length, failure === "stale-process" ? 0 : 1);
            assert.deepEqual(state.signals, []);
            assert.ok(state.table.some((item) => item.pid === pi.pid));
            assert.equal(app.sessions().length, 0);
            assert.equal((await app.harness.inspect(context)).tasks.length, 0);
        } finally {
            await app.close();
        }
    });
}

for (const acknowledgement of ["unknown", "lost", "ok", "child"] as const) {
    test(`${acknowledgement} Escape acknowledgement alone never authorizes stopping Pi`, async () => {
        const { app, state, local, pi } = await fixture(`abort-ack-${acknowledgement}`);
        const socketPath = join(root, `abort-ack-${acknowledgement}.sock`);
        const deliveries: unknown[] = [];
        const server = createServer((socket) => {
            socket.once("data", (chunk) => {
                const input = JSON.parse(chunk.toString());

                deliveries.push(input.params);
                // Invalid ack must fail even after idle; native Ok must still wait for actual idle.
                state.status = acknowledgement === "ok" ? "working" : "idle";

                if (acknowledgement === "lost") {
                    socket.end();
                } else {
                    socket.end(
                        JSON.stringify({
                            id: input.id,
                            result: acknowledgement === "unknown" ? {} : { type: "ok" },
                        }) + "\n",
                    );
                }
            });
        });
        const syntheticRequest = local.request;

        state.status = "working";

        if (acknowledgement === "child") {
            state.table.push({ ...pi, pid: 74000, parent: pi.pid, command: "sleep 100" });
        }

        local.abortTimeoutMs = 10;
        local.request = <T>(socket: string, method: string, params?: Record<string, unknown>) =>
            method === "pane.send_keys"
                ? herdrRequest<T>(socketPath, method, params)
                : syntheticRequest<T>(socket, method, params);
        await new Promise<void>((resolve) => server.listen(socketPath, resolve));

        try {
            const id = (await app.imports.active.list(owner(app))).sessions[0]!.id;
            const preview = await app.imports.active.preview(owner(app), { id });

            await assert.rejects(
                app.imports.active.move(owner(app), { ...request(preview), abortRunning: true }),
                ["unknown", "lost"].includes(acknowledgement)
                    ? /did not confirm.*Escape|did not confirm.*abort|acknowledgement/i
                    : /did not finish.*Escape|abort.*timed out/i,
            );
            assert.deepEqual(deliveries, [{ pane_id: "pane", keys: ["esc"] }]);
            assert.equal(state.status, acknowledgement === "ok" ? "working" : "idle");
            assert.deepEqual(state.signals, []);
            assert.ok(state.table.some((item) => item.pid === pi.pid));

            if (acknowledgement === "child") {
                assert.ok(state.table.some((item) => item.parent === pi.pid));
            }

            assert.equal(app.sessions().length, 0);
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await app.close();
        }
    });
}

test("abort timeout stays durable across restart but never replays without fresh explicit consent", async () => {
    const { app, state, source, local } = await fixture("abort-timeout");
    let id = "";

    state.status = "blocked";
    state.refuseAbort = true;
    local.abortTimeoutMs = 10;

    try {
        id = (await app.imports.active.list(owner(app))).sessions[0]!.id;
        const preview = await app.imports.active.preview(owner(app), { id });

        await assert.rejects(
            app.imports.active.move(owner(app), { ...request(preview), abortRunning: true }),
            /abort.*timed out|did not.*idle|did not.*finish|timeout/i,
        );
        assert.equal(state.escapes.length, 1);
        assert.deepEqual(state.signals, []);
        assert.ok((await app.harness.snapshot(TakeoversDoc, context))?.items[id]);
        assert.equal(app.sessions().length, 0);
    } finally {
        await app.close();
    }

    const reopened = await openApp(scriptedModel(), join(root, "data-abort-timeout"));
    const recovered = fakeHerdr(reopened, source.path);

    recovered.state.status = "blocked";

    try {
        await reopened.imports.active.list(owner(reopened));
        const preview = await reopened.imports.active.preview(owner(reopened), { id });

        assert.deepEqual(recovered.state.escapes, []);
        assert.deepEqual(recovered.state.signals, []);
        await assert.rejects(
            reopened.imports.active.move(owner(reopened), request(preview)),
            /abortRunning|abort.*confirm/i,
        );
        assert.deepEqual(recovered.state.escapes, []);
        assert.deepEqual(recovered.state.signals, []);
        const result = await reopened.imports.active.move(owner(reopened), {
            ...request(preview),
            abortRunning: true,
        });

        assert.equal(result.existing, false);
        assert.equal(recovered.state.escapes.length, 1);
        assert.equal(recovered.state.signals.length, 1);
    } finally {
        await reopened.close();
    }
});

test("stopped interrupted aborted handoff recovers a saved user tail after restart without historical execution", async () => {
    const { app, state, source } = await fixture("aborted-user-recovery");
    let id = "";

    state.status = "working";

    state.onEscape = () => {
        source.source.appendMessage({
            role: "user",
            content: "SAVED_UNFINISHED_REQUEST",
            timestamp: Date.now(),
        });
    };

    app.imports.create = async () => {
        throw new Error("publication unavailable");
    };

    try {
        id = (await app.imports.active.list(owner(app))).sessions[0]!.id;
        const preview = await app.imports.active.preview(owner(app), { id });

        await assert.rejects(
            app.imports.active.move(owner(app), { ...request(preview), abortRunning: true }),
            /Pi has stopped.*preview and retry/,
        );
        assert.equal(state.escapes.length, 1);
        assert.equal(state.signals.length, 1);
        assert.equal(app.sessions().length, 0);
    } finally {
        await app.close();
    }

    const model = scriptedModel();
    const reopened = await openApp(model, join(root, "data-aborted-user-recovery"));
    const recovered = fakeHerdr(reopened, source.path);

    recovered.state.table = [recovered.shell];
    recovered.state.agent = "";

    try {
        const listing = await reopened.imports.active.list(owner(reopened));

        assert.equal(listing.sessions[0]!.recovery, true);
        assert.equal(listing.sessions[0]!.running, false);
        assert.deepEqual(reopened.sessions(), []);
        const preview = await reopened.imports.active.preview(owner(reopened), { id });

        assert.equal(preview.running, false);
        const result = await reopened.imports.active.move(owner(reopened), request(preview));

        assert.equal(
            await reopened.imports.archive(owner(reopened), result.id),
            readFileSync(source.path, "utf8"),
        );
        assert.match(
            JSON.stringify(
                (await (await reopened.conversation(result.id)).context(context)).messages,
            ),
            /SAVED_UNFINISHED_REQUEST/,
        );
        assert.deepEqual(recovered.state.escapes, []);
        assert.deepEqual(recovered.state.signals, []);
        assert.equal((await reopened.harness.inspect(context)).tasks.length, 0);
        assert.equal(model.state.callCount, 0);
    } finally {
        await reopened.close();
    }
});

for (const phase of ["preflight", "abort", "shutdown"] as const) {
    test(`confirmed move rejects a same-session branch switch during ${phase}`, async () => {
        const { app, state, source, local } = await fixture(`abort-branch-${phase}`);

        const switchBranch = () => {
            source.source.branch(source.lastAnswer);
            source.source.appendMessage(fauxAssistantMessage("DIFFERENT_SELECTED_BRANCH"));
        };

        state.status = "working";

        try {
            const id = (await app.imports.active.list(owner(app))).sessions[0]!.id;
            const preview = await app.imports.active.preview(owner(app), { id });

            if (phase === "preflight") {
                switchBranch();
            } else if (phase === "abort") {
                state.onEscape = switchBranch;
            } else {
                const signal = local.signal;

                local.signal = (pid) => {
                    const result = signal(pid);

                    switchBranch();

                    return result;
                };
            }

            await assert.rejects(
                app.imports.active.move(owner(app), { ...request(preview), abortRunning: true }),
                /branch.*changed|changed.*branch/i,
            );
            assert.equal(state.escapes.length, phase === "preflight" ? 0 : 1);
            assert.equal(state.signals.length, phase === "shutdown" ? 1 : 0);
            assert.equal(app.sessions().length, 0);
        } finally {
            await app.close();
        }
    });
}

test("invalid destination, stale preview and missing confirmation never stop Pi", async () => {
    const { app, source, state } = await fixture("preflight");

    try {
        const { sessions } = await app.imports.active.list(owner(app));
        const preview = await app.imports.active.preview(owner(app), { id: sessions[0]!.id });
        const input = request(preview);

        await assert.rejects(
            async () => app.imports.active.move(owner(app), { ...input, acknowledged: false }),
            /Confirm/,
        );
        await assert.rejects(
            app.imports.active.move(owner(app), { ...input, model: "missing/model" }),
            /available destination/,
        );
        appendFileSync(source.path, "\n");
        await assert.rejects(app.imports.active.move(owner(app), input), /changed since preview/);
        assert.deepEqual(state.signals, []);
        assert.equal(app.sessions().length, 0);
    } finally {
        await app.close();
    }
});

test("busy, stale references, shell-as-Pi, child processes, changed identity and source switches are refused", async () => {
    const { app, source, state, pi, local } = await fixture("guards");

    try {
        const id = (await app.imports.active.list(owner(app))).sessions[0]!.id;
        const preview = await app.imports.active.preview(owner(app), { id });
        const verified = await local.find(id);

        await assert.rejects(
            local.stop({ ...verified, process: { ...verified.process!, pid: 0 } }),
            /No verified/,
        );
        state.status = "working";
        await assert.rejects(app.imports.active.move(owner(app), request(preview)), /current turn/);
        state.status = "idle";
        state.referenceAgent = "claude";
        assert.match(
            (await app.imports.active.list(owner(app))).sessions[0]!.reason!,
            /not reported/,
        );
        state.referenceAgent = "pi";
        state.shellPid = pi.pid;
        assert.match(
            (await app.imports.active.list(owner(app))).sessions[0]!.reason!,
            /separate local/,
        );
        state.shellPid = 76543;
        assert.match(
            (await app.imports.active.list(owner(app))).sessions[0]!.reason!,
            /separate local/,
        );
        state.shellPid = pi.parent;
        state.table.push({ ...pi, pid: 74000, parent: pi.pid, command: "sleep 100" });
        await assert.rejects(
            app.imports.active.move(owner(app), request(preview)),
            /child processes/,
        );
        state.table.pop();
        state.table = state.table.map((item) =>
            item.pid === pi.pid ? { ...item, started: "Tue Jan 2 00:00:00 2024" } : item,
        );
        await assert.rejects(
            app.imports.active.move(owner(app), request(preview)),
            /changed or exited/,
        );
        state.table = state.table.map((item) => (item.pid === pi.pid ? pi : item));
        state.path = `${source.path}.different`;
        await assert.rejects(
            app.imports.active.move(owner(app), request(preview)),
            /changed or exited/,
        );
        assert.deepEqual(state.signals, []);
    } finally {
        await app.close();
    }
});

test("stop timeout never force-kills; a stopped unfinished move survives reopen and can be retried", async () => {
    const { app, source, state, local, shell } = await fixture("timeout");
    let input: ReturnType<typeof request>;

    try {
        const id = (await app.imports.active.list(owner(app))).sessions[0]!.id;

        input = request(await app.imports.active.preview(owner(app), { id }));
        state.refuseExit = true;
        const signal = local.signal;

        local.signal = (pid) => {
            const sent = signal(pid);

            // A title/argv change is not proof of exit. Keep waiting for this process lifetime.
            state.table = state.table.map((item) =>
                item.pid === pid ? { ...item, commandHash: "changed-title" } : item,
            );

            return sent;
        };

        local.stopTimeoutMs = 10;
        await assert.rejects(app.imports.active.move(owner(app), input), /not force-killed/);
        assert.equal(state.signals.length, 1);
        assert.equal(app.sessions().length, 0);
        assert.equal(
            (await app.harness.snapshot(TakeoversDoc, context))!.items[id]!.result,
            undefined,
        );
    } finally {
        await app.close();
    }

    const reopened = await openApp(scriptedModel(), join(root, "data-timeout"));

    try {
        const recovered = fakeHerdr(reopened, source.path);

        recovered.state.table = [shell];
        recovered.state.agent = "";
        const listing = await reopened.imports.active.list(owner(reopened));

        assert.equal(listing.sessions[0]!.recovery, true);
        const preview = await reopened.imports.active.preview(owner(reopened), { id: input!.id });
        const result = await reopened.imports.active.move(owner(reopened), request(preview));

        assert.equal(result.existing, false);
        assert.deepEqual(recovered.state.signals, []);
    } finally {
        await reopened.close();
    }
});

test("source changes during shutdown leave a recoverable stopped session, not a silent context change", async () => {
    const { app, source, state, local } = await fixture("shutdown-write");
    const stop = local.signal;

    local.signal = (pid) => {
        const result = stop(pid);

        appendFileSync(source.path, "\n");

        return result;
    };

    try {
        const id = (await app.imports.active.list(owner(app))).sessions[0]!.id;
        const preview = await app.imports.active.preview(owner(app), { id });

        await assert.rejects(
            app.imports.active.move(owner(app), request(preview)),
            /Pi has stopped.*preview and retry/,
        );
        assert.equal(app.sessions().length, 0);
        const next = await app.imports.active.preview(owner(app), { id });

        await app.imports.active.move(owner(app), request(next));
        assert.equal(state.signals.length, 1);
    } finally {
        await app.close();
    }
});

test("discovery and takeover reject non-owners before any process or socket access", async () => {
    const { app, local } = await fixture("authorization");

    local.processes = async () => {
        throw new Error("must not inspect processes");
    };

    const guest = { ...owner(app), role: "guest" as const };

    try {
        await assert.rejects(app.imports.active.list(guest), /Only the owner/);
        await assert.rejects(
            app.imports.active.preview(guest, { id: "a".repeat(64) }),
            /Only the owner/,
        );
        await assert.rejects(
            async () => app.imports.active.move(guest, { id: "a".repeat(64), acknowledged: true }),
            /Only the owner/,
        );
    } finally {
        await app.close();
    }
});

test("HTTP auth protects discovery and a move continues after its requesting browser disconnects", async () => {
    const { app, state, local } = await fixture("http-disconnect");
    const guest = app.config.addUser("Guest", "guest");
    const server = createHttpServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/imports/active`;
    const headers = {
        authorization: `Bearer ${app.config.ownerToken}`,
        "x-pocket": "1",
        "content-type": "application/json",
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const stop = local.stop.bind(local);
    let stopping = false;

    local.stop = async (session) => {
        stopping = true;
        await gate;
        await stop(session);
    };

    try {
        assert.equal((await fetch(base)).status, 401);
        assert.equal(
            (await fetch(base, { headers: { authorization: `Bearer ${guest.token}` } })).status,
            403,
        );
        assert.equal(
            (
                await fetch(base, {
                    method: "POST",
                    headers: { authorization: headers.authorization },
                    body: "{}",
                })
            ).status,
            403,
        );
        const list = await (await fetch(base, { headers })).json();
        const response = await fetch(`${base}/preview`, {
            method: "POST",
            headers,
            body: JSON.stringify({ id: list.sessions[0].id }),
        });
        const preview = await response.json();
        const input = request(preview);
        const controller = new AbortController();
        const pending = fetch(base, {
            method: "POST",
            headers,
            body: JSON.stringify(input),
            signal: controller.signal,
        });
        const aborted = assert.rejects(pending, { name: "AbortError" });

        await until(() => stopping, "server started the move");
        controller.abort();
        await aborted;
        release();
        await until(() => app.sessions().length === 1, "disconnected move completed");
        const retry = await (
            await fetch(base, { method: "POST", headers, body: JSON.stringify(input) })
        ).json();

        assert.equal(retry.id, app.sessions()[0]!.id);
        assert.equal(retry.existing, true);
        assert.equal(state.signals.length, 1);
    } finally {
        release();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await app.close();
    }
});

test("Pi detection and ps parsing do not mistake shells, prompts, RPC children or zombies for an interactive Pi", () => {
    assert.equal(isPiArgv(["/bin/zsh", "pi"]), false);
    assert.equal(isPiArgv(["node", "other.js", "pi"]), false);
    assert.equal(isPiArgv(["pi-rpc"]), false);
    assert.equal(isPiArgv(["pi", "--mode", "rpc"]), false);
    assert.equal(isPiArgv(["pi", "--print", "hello"]), false);
    assert.equal(isPiArgv(["pi"]), true);
    assert.equal(
        isPiArgv(["node", "/packages/@earendil-works/pi-coding-agent/dist/bundle/cli.js"]),
        true,
    );
    assert.equal(parseProcesses("12 1 501 Z Mon Jan 1 00:00:00 2024 pi").length, 0);
    assert.equal(parseProcesses("garbage").length, 0);
});

test("Herdr JSON-line transport handles split replies, error replies and EOF", async () => {
    const path = join(root, "transport.sock");
    let mode = "split";
    const server = createServer((socket) => {
        socket.once("data", (chunk) => {
            const input = JSON.parse(chunk.toString());

            if (mode === "eof") {
                socket.end();
            } else if (mode === "error") {
                socket.end(JSON.stringify({ id: input.id, error: { message: "no" } }) + "\n");
            } else {
                const response = JSON.stringify({ id: input.id, result: { ok: true } }) + "\n";

                socket.write(response.slice(0, 8));
                setImmediate(() => socket.end(response.slice(8)));
            }
        });
    });

    await new Promise<void>((resolve) => server.listen(path, resolve));

    try {
        assert.deepEqual(await herdrRequest(path, "session.snapshot"), { ok: true });
        mode = "error";
        await assert.rejects(herdrRequest(path, "session.snapshot"), /refused/);
        mode = "eof";
        await assert.rejects(herdrRequest(path, "session.snapshot"), /closed/);
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

test(
    "real SIGTERM ends only a synthetic Pi child and leaves its parent shell alive",
    { skip: process.platform === "win32" },
    async () => {
        const ready = join(root, "ready");
        const script = join(root, "synthetic-pi.mjs");

        writeFileSync(
            script,
            `import { writeFileSync } from 'node:fs'; process.title = 'pi'; process.on('SIGTERM', () => process.exit(0)); writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(() => {}, 1000);`,
        );
        // No real Pi code, sessions, providers or Herdr instances are launched by this fixture.
        const shell = spawn(
            "/bin/sh",
            ["-c", '"$1" "$2"; read keep_shell_alive', "fixture-shell", process.execPath, script],
            { stdio: ["pipe", "ignore", "ignore"] },
        );

        try {
            await until(() => {
                try {
                    return Number(readFileSync(ready, "utf8")) > 0;
                } catch {
                    return false;
                }
            }, "synthetic Pi ready");
            const pid = Number(readFileSync(ready, "utf8"));
            const local = new LocalPiSessions();
            const identity = (await localProcesses()).find((item) => item.pid === pid)!;

            assert.equal(identity.command, "pi");
            const session = {
                id: "a".repeat(64),
                socket: "/synthetic",
                pane: "p1",
                path: "/synthetic.jsonl",
                title: "Synthetic",
                cwd: root,
                location: "Test",
                state: "idle",
                process: identity,
            };

            local.find = async () => session;
            await local.stop(session);
            assert.equal(await local.exited(session), true);
            assert.equal(shell.exitCode, null);
            assert.equal(process.kill(shell.pid!, 0), true);
        } finally {
            for (const child of (await localProcesses()).filter(
                (item) => item.parent === shell.pid && item.command === "pi",
            )) {
                try {
                    process.kill(child.pid, "SIGTERM");
                } catch {
                    // The synthetic child may have exited between inspection and cleanup.
                }
            }

            shell.stdin.end("done\n");
            await new Promise<void>((resolve) => {
                if (shell.exitCode !== null) {
                    resolve();
                } else {
                    shell.once("exit", () => resolve());
                }
            });
        }
    },
);
