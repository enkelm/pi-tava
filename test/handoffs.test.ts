// Real app/HTTP, Git and restart boundaries own durable handoffs; no production test-only hooks.
import {
    type App,
    cleanUp,
    context,
    lastText,
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
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
    type ConversationId,
    InboxDoc,
    type SubmissionId,
    type TaskId,
} from "@earendil-works/pi-durable";
import { AuthorsDoc, REPORT_PREFIX, SessionsDoc, SubagentsDoc } from "../src/server/docs.ts";
import { HttpError } from "../src/server/errors.ts";
import { createHandler } from "../src/server/http.ts";
import { HandoffsDoc, WorkflowDoc } from "../src/server/workflow-docs.ts";

let app: App;
const data = join(root, "handoffs-data");
let releaseChild: (() => void) | undefined;
let childGate: Promise<void> | undefined;
const model = scriptedModel(async (input) => {
    const last = lastText(input as never);

    if (last.role === "user" && /SPAWN_AND_(?:PREPARE|COMPLETE)$/.test(last.text)) {
        const handoff: Record<string, string> = last.text.endsWith("SPAWN_AND_COMPLETE")
            ? {
                  action: "complete",
                  status: "needs-review",
                  summary: "Premature completion while a helper still works.",
              }
            : {
                  action: "prepare",
                  targetType: "reviewer",
                  relationship: "same-work",
                  brief: "Premature brief while a helper still works.",
              };

        return fauxAssistantMessage(
            [
                fauxToolCall("subagent", {
                    action: "spawn",
                    name: "writer",
                    message: "HOLD_CHILD",
                }),
                fauxToolCall("handoff", handoff),
            ],
            { stopReason: "toolUse" },
        );
    }

    if (last.role === "user" && last.text.endsWith("SPAWN_CHILD")) {
        return fauxAssistantMessage(
            [fauxToolCall("subagent", { action: "spawn", name: "writer", message: "HOLD_CHILD" })],
            { stopReason: "toolUse" },
        );
    }

    if (last.role === "user" && last.text.includes("HOLD_CHILD")) {
        await childGate;
    }

    if (last.role === "user" && /PREPARE_(?:ONLY|LONG)$/.test(last.text)) {
        return fauxAssistantMessage(
            [
                fauxToolCall("handoff", {
                    action: "prepare",
                    targetType: "reviewer",
                    relationship: "same-work",
                    brief:
                        "COMPLETE_FROM_TOOL. Original ask: repair the retry path. Spec: docs/retries.md. Tests: run the lifecycle tests. Risks: duplicate delivery. Git checkpoint: inspect the current HEAD." +
                        (last.text.endsWith("PREPARE_LONG")
                            ? `\n${"Relevant implementation context. ".repeat(140)}\nDeferred checks: browser unavailable; manual UI verification still required.`
                            : ""),
                }),
            ],
            { stopReason: "toolUse" },
        );
    }

    if (last.role === "user" && last.text.includes("COMPLETE_FROM_TOOL")) {
        return fauxAssistantMessage(
            [
                fauxToolCall("handoff", {
                    action: "complete",
                    status: "review-complete",
                    summary: "Reviewer fixed the retry issue and reran lifecycle tests.",
                    recommendations: [
                        {
                            targetType: "land",
                            relationship: "same-work",
                            reason: "Review passed; continue with local landing.",
                        },
                    ],
                }),
            ],
            { stopReason: "toolUse" },
        );
    }

    if (last.role === "user" && last.text.endsWith("INVENT_EXTERNAL_REVIEW")) {
        return fauxAssistantMessage(
            [
                fauxToolCall("handoff", {
                    action: "record-review",
                    source: "GitHub review by an independent reviewer",
                    scope: "The implementation",
                    findings: "Fix the missing retry guard.",
                    checkpoint: "a".repeat(40),
                }),
            ],
            { stopReason: "toolUse" },
        );
    }

    if (last.role === "user" && last.text.endsWith("MATERIAL_REWRITE_CHECKPOINT_UNAVAILABLE")) {
        return fauxAssistantMessage(
            [
                fauxToolCall("handoff", {
                    action: "complete",
                    status: "needs-review",
                    reviewApplicability: "invalidated",
                    summary:
                        "A material rewrite invalidated the original independent assessment; checkout inspection is unavailable.",
                }),
            ],
            { stopReason: "toolUse" },
        );
    }

    const externalInput = /RECORD_EXTERNAL_REVIEW\n(\{[^\n]+\})$/.exec(last.text);

    if (last.role === "user" && externalInput !== null) {
        const request = JSON.parse(externalInput[1]!);

        return fauxAssistantMessage(
            [fauxToolCall("handoff", { action: "record-review", ...request })],
            { stopReason: "toolUse" },
        );
    }

    if (last.role === "user" && last.text.includes("RESTART_DELAY")) {
        await new Promise((resolve) => setTimeout(resolve, 400));
    }

    return fauxAssistantMessage([fauxText(`checked: ${last.text.slice(0, 100)}`)]);
});

before(async () => {
    app = await openApp(model, data);
});
after(async () => {
    releaseChild?.();
    await app.close();
    cleanUp();
});

function git(cwd: string, ...args: string[]) {
    return execFileSync("git", ["-c", "core.fsmonitor=false", ...args], { cwd, encoding: "utf8" });
}

function repo(name: string) {
    const cwd = join(root, name);

    mkdirSync(cwd);
    git(cwd, "init", "-q");
    writeFileSync(join(cwd, "code.txt"), "original\n");
    commit(cwd, "baseline");

    return cwd;
}

function commit(cwd: string, message: string) {
    git(cwd, "add", ".");
    git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", message);
}

const cid = (id: number) => id as ConversationId;
const status = (expected: number) => (error: unknown) =>
    error instanceof HttpError && error.status === expected;
const start = (
    id: ConversationId,
    targetType: string,
    requestId: string,
    relationship = "same-work",
    brief?: string,
) =>
    app.handoffs.start(id, owner(app), {
        targetType,
        relationship,
        requestId,
        ...(brief === undefined ? {} : { brief }),
    });

async function delivered(id: ConversationId) {
    await until(async () => {
        const list = await app.handoffs.list(id, owner(app));

        return (
            !app.isBusy(id) &&
            list.handoffs.some(
                (record) => record.targetThreadId === Number(id) && record.delivery === "delivered",
            )
        );
    }, "handoff delivery and answer");
}

// Attribution, not slash text, decides whether submission is a native human command.
test("assistant relays of /handoff remain model input while a person's command opens only the passive picker", async () => {
    const id = await newSession(app);
    const before = await modelTexts(app, id);
    const count = app.sessions().length;
    const picker = await app.commands.submit(id, owner(app), {
        text: "/handoff",
        requestId: "human-picker",
    });

    assert.equal(picker.handoffPicker, true);
    assert.deepEqual(await modelTexts(app, id), before);
    const relay = await app.commands.submit(
        id,
        owner(app),
        {
            text: "/handoff",
            requestId: "relay-not-command",
        },
        "PiP",
    );

    assert.equal(
        relay.handoffPicker,
        undefined,
        "an assistant cannot open the human handoff picker",
    );
    assert.equal(relay.handoffThreadId, undefined);
    await (await app.harness.submission(relay.submissionId, context))!.wait(context);
    assert.ok((await modelTexts(app, id)).some((text) => text.includes("[via PiP] /handoff")));
    assert.equal(app.sessions().length, count);
});

// Real reporters/couriers author every batch; public task abort interrupts before or after submission admission.
test("handoff quiescence rejects stranded reports but allows delivered and explicitly discarded batches", async (t) => {
    for (const mode of ["outbox", "sending", "placed", "discarded"] as const) {
        await t.test(mode, async () => {
            let releaseParent!: () => void;
            const parentGate = new Promise<void>((resolve) => {
                releaseParent = resolve;
            });
            let releaseChild!: () => void;
            const childGate = new Promise<void>((resolve) => {
                releaseChild = resolve;
            });
            const reportTurns: string[] = [];
            const scripted = scriptedModel(async (input) => {
                const last = lastText(input);

                if (last.role === "user" && last.text.endsWith("CREATE_REPORT")) {
                    return fauxAssistantMessage(
                        [
                            fauxToolCall("subagent", {
                                action: "spawn",
                                name: "reporter",
                                message: "Finish this delegated task.",
                            }),
                        ],
                        { stopReason: "toolUse" },
                    );
                }

                if (last.role === "user" && last.text.endsWith("RESUME_REPORTS")) {
                    return fauxAssistantMessage(
                        [
                            fauxToolCall("subagent", {
                                action: "send",
                                name: "reporter",
                                message: "Finish one more delegated task.",
                            }),
                        ],
                        { stopReason: "toolUse" },
                    );
                }

                if (
                    mode === "outbox" &&
                    last.role === "user" &&
                    last.text === "Finish this delegated task."
                ) {
                    await childGate;
                }

                if (
                    mode === "discarded" &&
                    last.role === "toolResult" &&
                    last.text.includes("Started reporter")
                ) {
                    await parentGate;
                }

                if (last.role === "user" && last.text.includes(REPORT_PREFIX)) {
                    reportTurns.push(last.text);
                }

                return fauxAssistantMessage([fauxText("Completed delegated work.")]);
            });
            const isolated = await openApp(scripted, join(root, `stranded-reports-${mode}`));
            const id = await newSession(isolated);
            let courier: TaskId | undefined;
            let request: string | undefined;
            let queued: SubmissionId | undefined;
            let interrupted: Promise<void> | undefined;

            const interrupt = () => {
                if (courier === undefined || interrupted !== undefined) {
                    return;
                }

                const task = courier;

                interrupted = (async () => {
                    await isolated.harness.abortTask(task, context);
                    await isolated.harness.waitForTask(task, context);
                })();
            };

            const unsubscribe = isolated.harness.subscribeCommits((publication) => {
                for (const change of publication.changes) {
                    if (
                        change.type === "document" &&
                        change.conversationId === id &&
                        change.record.kind === SubagentsDoc.definition.kind
                    ) {
                        const state = change.value;

                        courier = state?.courier as TaskId | undefined;
                        request =
                            (state?.sending as { request?: string } | undefined)?.request ??
                            request;

                        if (mode === "sending" && request !== undefined) {
                            interrupt();
                        }
                    }

                    if (
                        change.type === "submission" &&
                        change.value.conversationId === id &&
                        change.value.requestId === request
                    ) {
                        if (mode === "placed" && change.value.status === "placed") {
                            interrupt();
                        } else if (mode === "discarded" && change.value.status === "queued") {
                            queued = change.value.id;
                            interrupt();
                        }
                    }
                }
            });

            try {
                const answer = say(isolated, id, "CREATE_REPORT");

                if (mode === "outbox") {
                    await answer;
                    // Finish the real child only after the parent turn ends, so the courier gathers at idle.
                    releaseChild();
                    await until(async () => {
                        const state = await isolated.harness.snapshot(SubagentsDoc, id, context);
                        const child = state?.agents.reporter;

                        return (
                            child?.reported.length === 1 &&
                            !isolated.isBusy(child.conversationId) &&
                            state?.outbox?.length === 1
                        );
                    }, "a genuine completed answer waiting for its courier");
                    await recordCost(isolated, id, 2);
                    await isolated.spend.setSessionBudget(owner(isolated), id, 1);
                    await until(
                        async () =>
                            (await isolated.harness.snapshot(SubagentsDoc, id, context))?.held !==
                            undefined,
                        "the courier's real spend hold",
                    );
                    interrupt();
                } else {
                    await until(() => interrupted !== undefined, `the ${mode} batch interruption`);
                }

                await interrupted;

                if (mode === "discarded") {
                    assert.ok(queued);
                    await isolated.commands.withdraw(id, owner(isolated), Number(queued));
                    releaseParent();
                }

                await answer;
                await until(async () => {
                    const tasks = await isolated.harness.commit(
                        (tx) => tx.scanTasks({ conversationId: id }, 100),
                        context,
                    );

                    return tasks.items.every((task) => task.state.status === "terminal");
                }, "all parent background tasks terminal");
                const state = await isolated.harness.snapshot(SubagentsDoc, id, context);
                const batch = state?.sending;
                const receipt =
                    batch === undefined
                        ? undefined
                        : await isolated.harness.commit(
                              (tx) => tx.submissionByRequest(id, batch.request),
                              context,
                          );

                assert.equal(state?.courier, undefined);
                assert.equal(isolated.isBusy(id), false);
                assert.equal(
                    (await isolated.harness.snapshot(InboxDoc, id, context))?.items.length,
                    0,
                );

                if (mode === "outbox" || mode === "sending") {
                    assert.equal((state?.outbox?.length ?? 0) + (batch?.reports.length ?? 0), 1);
                    assert.equal(receipt, undefined, "the pending batch has never been admitted");
                    await assert.rejects(
                        isolated.harness.commit(
                            (tx) => isolated.handoffs.requireIdle(tx, id),
                            context,
                        ),
                        /pending subagent reports/,
                    );
                    await isolated.spend.setSessionBudget(owner(isolated), id, null);
                    await say(isolated, id, "RESUME_REPORTS");
                    await until(async () => {
                        const current = await isolated.harness.snapshot(SubagentsDoc, id, context);

                        return (
                            current?.courier === undefined &&
                            !current?.outbox?.length &&
                            current?.sending === undefined &&
                            !isolated.isBusy(id)
                        );
                    }, "recovered reports delivered and courier settled");
                    assert.ok(
                        reportTurns.length > 0,
                        "recovery actually delivers the delegated reports",
                    );
                } else {
                    assert.ok(batch, "interruption leaves durable sending metadata behind");
                    assert.ok(receipt);

                    if (mode === "discarded") {
                        assert.equal(batch.discarded, true);
                        assert.equal(receipt.status, "unanswered");
                        assert.equal(receipt.entry, undefined);
                    } else {
                        assert.equal(reportTurns.length, 1);
                        assert.notEqual(
                            receipt.entry,
                            undefined,
                            "the model already received this batch",
                        );
                    }
                }

                await isolated.harness.commit(
                    (tx) => isolated.handoffs.requireIdle(tx, id),
                    context,
                );
            } finally {
                releaseParent();
                releaseChild();
                unsubscribe();
                await isolated.close();
            }
        });
    }
});

// Empty history is not reviewable work; both discovery and actual activation must agree.
test("an untouched thread cannot start review, but completed work can", async () => {
    const { id: source } = await app.commands.createSession(owner(app), {
        cwd: repo("empty-handoff"),
        threadType: "worker",
    });

    await app.commands.configure(source, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });
    const count = app.sessions().length;
    const option = (await app.handoffs.list(source, owner(app))).options.find(
        (each) => each.targetType === "reviewer",
    );

    assert.equal(option?.enabled, false);
    assert.match(option?.reason ?? "", /completed work/i);
    await assert.rejects(start(source, "reviewer", "empty-review"), status(409));
    assert.equal(app.sessions().length, count);
    await say(app, source, "Implement and report the work to review.");
    assert.equal(
        (await app.handoffs.list(source, owner(app))).options.find(
            (each) => each.targetType === "reviewer",
        )?.enabled,
        true,
    );
    await delivered(cid((await start(source, "reviewer", "empty-review")).id));
});

// Recommendations are advisory: an alternate successor still needs the author's detailed brief.
test("choosing a different role retains the prepared handoff brief", async () => {
    const source = await newSession(app, repo("alternate-handoff"));

    await say(app, source, "PREPARE_LONG");
    const created = await start(source, "worker", "choose-alternate");
    const id = cid(created.id);

    await delivered(id);
    const record = (await app.handoffs.list(id, owner(app))).handoffs.find(
        (each) => each.targetThreadId === created.id,
    );

    assert.equal(app.sessionMeta(id)?.threadType, "worker");
    assert.match(record?.brief ?? "", /COMPLETE_FROM_TOOL\. Original ask/);
    assert.match(record?.brief ?? "", /Risks: duplicate delivery/);
    assert.match(
        record?.brief ?? "",
        /Deferred checks: browser unavailable; manual UI verification still required/,
        "a long prepared brief must not lose its final verification gaps",
    );
});

// Helper work belongs to its parent even when the parent has returned from spawning it.
test("preparing or completing a handoff waits for delegated helpers instead of recording unfinished work", async () => {
    for (const action of ["PREPARE", "COMPLETE"]) {
        const source = await newSession(app, repo(`${action.toLowerCase()}-helper-handoff`));
        let child: ConversationId | undefined;

        childGate = new Promise<void>((resolve) => {
            releaseChild = resolve;
        });

        try {
            await say(app, source, `SPAWN_AND_${action}`);
            child = (await app.harness.snapshot(SubagentsDoc, source, context))?.agents.writer
                ?.conversationId;

            assert.ok(child);
            await until(() => app.isBusy(child!), "delegated helper remains running");
            const list = await app.handoffs.list(source, owner(app));
            const output = JSON.stringify(await modelTexts(app, source));

            assert.equal(list.workflow.proposal, undefined);
            assert.equal(list.workflow.status, "active");
            assert.equal(list.workflow.summary, undefined);
            assert.match(output, /delegated helpers/);
            assert.doesNotMatch(output, /Cannot fingerprint/);
            assert.equal(
                list.options.every((each) => !each.enabled),
                true,
            );
            assert.equal(app.isBusy(child), true, "handoff tools must not abort helpers");
            await assert.rejects(
                app.handoffs.complete(source, owner(app), {
                    status: "needs-review",
                    summary: "Cannot complete while the delegated helper still works.",
                }),
                (error: unknown) =>
                    error instanceof HttpError &&
                    error.status === 409 &&
                    /delegated helpers/.test(error.message),
                "human completion also explains helper work before inspecting the checkpoint",
            );
        } finally {
            releaseChild?.();
            await until(
                () => !app.isBusy(source) && (child === undefined || !app.isBusy(child)),
                "helper and parent reporter idle",
            );
        }
    }
});

// Gate: transport/native semantics, scoped visibility and no model activation are new public contracts.
test("HTTP/native handoffs inherit scope without broadening access; viewers cannot activate and hidden members stay private", async () => {
    const cwd = repo("http-handoff");
    const source = await newSession(app, cwd);

    await say(app, source, "Original ask: keep durable receipts; spec docs/retries.md");
    await app.commands.updateSession(source, owner(app), { title: "Private original work title" });
    const scoped = app.config.addUser("Scoped steering", "guest", [String(source)]);
    const viewer = app.config.addUser("Scoped viewer", "viewer", [String(source)]);
    const elsewhere = app.config.addUser("Elsewhere", "guest", ["999999"]);
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();

    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}/api/c/${source}`;
    const request = (path: string, token: string, body?: unknown) =>
        fetch(base + path, {
            method: body === undefined ? "GET" : "POST",
            headers: {
                authorization: `Bearer ${token}`,
                "x-pocket": "1",
                "content-type": "application/json",
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });

    try {
        assert.equal((await request("/handoffs", viewer.token)).status, 200);
        assert.equal((await request("/handoffs", elsewhere.token)).status, 404);
        assert.equal(
            (
                await request("/handoffs", viewer.token, {
                    targetType: "reviewer",
                    relationship: "same-work",
                    requestId: "viewer-start",
                })
            ).status,
            403,
        );

        for (const token of [viewer.token, elsewhere.token]) {
            assert.equal(
                (
                    await request("/handoffs/external-review", token, {
                        source: "External review",
                        scope: "Implementation",
                        findings: "Fix retries",
                        checkpoint: "a".repeat(40),
                    })
                ).status,
                token === viewer.token ? 403 : 404,
                "external intake retains steering and conversation visibility gates",
            );
        }

        const before = await modelTexts(app, source);
        const picker = await request("/submit", scoped.token, {
            text: "/handoff",
            requestId: "picker",
        });
        const picked = await picker.json();

        assert.equal(picker.status, 200);
        assert.equal(picked.handoffPicker, true);
        assert.equal(typeof picked.submissionId, "number");
        assert.deepEqual(await modelTexts(app, source), before);
        assert.equal(app.isBusy(source), false);
        assert.equal(
            (
                await request("/submit", scoped.token, {
                    text: "/handoff worker",
                    requestId: "ambiguous",
                })
            ).status,
            400,
        );
        const response = await request("/submit", scoped.token, {
            text: "/handoff reviewer",
            requestId: "native-review",
        });
        const result = await response.json();
        const reviewer = cid(result.handoffThreadId);

        assert.equal(response.status, 200);
        assert.equal(typeof result.submissionId, "number");
        assert.equal(app.canSee(scoped.user, reviewer), true);
        assert.equal(app.canSee(viewer.user, reviewer), true);
        assert.equal(app.canSee(elsewhere.user, reviewer), false);
        assert.equal(app.cwdOf(reviewer), cwd);
        await delivered(reviewer);
        assert.deepEqual(await modelTexts(app, source), before);
        const limited = app.config.addUser("Only reviewer", "guest", [String(reviewer)]).user;
        const projected = await app.handoffs.list(reviewer, limited);

        assert.equal(projected.workItem?.title, "Work item");
        assert.deepEqual(projected.workItem?.threadIds, [Number(reviewer)]);
        assert.equal(projected.workItem?.originThreadId, undefined);
        assert.deepEqual(projected.handoffs, []);
        assert.equal(app.sessions(limited)[0]?.workItemTitle, "Work item");
        assert.equal(app.sessions(limited)[0]?.title, "Review");
        assert.equal("accessFrom" in app.sessions(limited)[0]!, false);
        await assert.rejects(
            app.handoffs.updateWorkItem(reviewer, limited, { archived: true }),
            status(404),
        );
        const retry = await request("/submit", scoped.token, {
            text: "/handoff reviewer",
            requestId: "native-review",
        });

        assert.equal((await retry.json()).handoffThreadId, Number(reviewer));
        await say(app, source, "Discuss the earlier design without modifying code");
        assert.equal(app.handoffs.isReadOnly(source), true);
        await assert.rejects(app.commands.configure(source, owner(app), { cwd }), status(409));
        await assert.rejects(app.commands.fork(source, owner(app), { entryId: 0 }), status(409));
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

// Gate: origin grouping, milestone/fingerprint safety, atomic organization and persisted retry independently guard lifecycle.
test("review/land/publish/new-work transitions bind exact code and group archive/move survives restart and retries", async () => {
    const cwd = repo("transition-handoff");
    const textconvMarker = join(root, "textconv-was-executed");

    writeFileSync(join(cwd, ".gitattributes"), "code.txt diff=offline\n");
    commit(cwd, "diff attributes");
    git(cwd, "config", "diff.offline.textconv", `touch ${textconvMarker}`);
    const source = await newSession(app, cwd);

    await say(app, source, "Implement the original work and run tests");
    await app.commands.updateSession(source, owner(app), { title: "Origin title" });
    const review = await start(source, "reviewer", "review-transition");
    const reviewer = cid(review.id);

    await delivered(reviewer);
    await assert.rejects(start(reviewer, "land", "premature-land"), status(409));
    writeFileSync(join(cwd, "code.txt"), "tracked change\n");
    writeFileSync(join(cwd, "new-code.txt"), "one\n");
    await app.handoffs.complete(reviewer, owner(app), {
        status: "review-complete",
        summary: "Reviewed tracked and untracked code; tests pass.",
    });
    const firstFingerprint = await app.handoffs.fingerprint(reviewer);

    assert.equal(
        existsSync(textconvMarker),
        false,
        "readiness inspection must never execute configured textconv programs",
    );
    writeFileSync(join(cwd, "new-code.txt"), "two\n");
    assert.notEqual(await app.handoffs.fingerprint(reviewer), firstFingerprint);
    await assert.rejects(start(reviewer, "land", "drift-land"), status(409));
    await app.handoffs.complete(reviewer, owner(app), {
        status: "review-complete",
        summary: "Reviewed the changed untracked contents.",
    });
    // A recorded unresolved review is still independent evidence for bounded repairs.
    await app.handoffs.complete(reviewer, owner(app), {
        status: "needs-review",
        summary: "Independent review found a small remaining gap; investigate and repair it.",
    });
    const followUp = await start(reviewer, "follow-up", "follow-up-transition");

    assert.equal(followUp.workItemId, review.workItemId);
    const followUpId = cid(followUp.id);

    await delivered(followUpId);
    await assert.rejects(start(followUpId, "land", "premature-follow-up-land"), status(409));
    writeFileSync(join(cwd, "new-code.txt"), "small review repair\n");
    await app.close();
    app = await openApp(model, data);
    assert.equal(
        (await app.harness.snapshot(WorkflowDoc, reviewer, context))?.status,
        "needs-review",
    );
    await say(app, followUpId, "PREPARE_ONLY");
    const repairBrief = (await app.handoffs.list(followUpId, owner(app))).workflow.proposal?.brief;

    await app.handoffs.complete(followUpId, owner(app), {
        status: "review-complete",
        summary:
            "Reused the independent review and self-reviewed the small repair with focused checks.",
    });
    assert.deepEqual(
        (await app.handoffs.list(followUpId, owner(app))).workflow.recommendations?.map(
            (rec) => rec.targetType,
        ),
        ["land"],
        "bounded review repairs normally recommend Land without another review session",
    );
    assert.equal(
        (await app.handoffs.list(followUpId, owner(app))).workflow.proposal?.targetType,
        "land",
        "earlier repair suggestions do not override the final completion recommendation",
    );
    assert.equal(
        (await app.handoffs.list(followUpId, owner(app))).workflow.proposal?.brief,
        repairBrief,
        "completion preserves the authored successor brief",
    );
    const land = await start(followUpId, "land", "land-transition");
    const landId = cid(land.id);

    assert.equal(land.workItemId, review.workItemId);
    await delivered(landId);
    await assert.rejects(
        app.handoffs.complete(landId, owner(app), {
            status: "landed",
            summary: "Not yet committed",
            readyForPublish: true,
        }),
        status(409),
    );
    commit(cwd, "land changes");
    await app.handoffs.complete(landId, owner(app), {
        status: "landed",
        summary: "Committed locally, hooks/tests and impact review pass.",
        readyForPublish: true,
    });
    const publish = await start(landId, "publish", "publish-transition");
    const publishId = cid(publish.id);

    await delivered(publishId);
    const publishState = await app.harness.snapshot(WorkflowDoc, publishId, context);

    assert.equal(publishState?.status, "active");
    assert.equal(publishState?.readyForPublish, true);
    assert.equal(publishState?.fingerprint?.digest, await app.handoffs.fingerprint(landId));
    await app.handoffs.complete(publishId, owner(app), {
        status: "published",
        summary: "Human attests the separately approved publication completed.",
    });
    const scoped = app.config.addUser("Scoped completion participant", "guest", [
        String(source),
    ]).user;

    await assert.rejects(
        app.handoffs.start(publishId, scoped, {
            targetType: "worker",
            relationship: "new-work",
            requestId: "scoped-new-work",
        }),
        status(403),
    );
    const next = await start(
        publishId,
        "worker",
        "new-work",
        "new-work",
        "New ask: implement independent follow-up",
    );
    const nextId = cid(next.id);

    await delivered(nextId);
    assert.notEqual(next.workItemId, review.workItemId);
    const nextItem = (await app.handoffs.list(nextId, owner(app))).workItem;

    assert.equal(nextItem?.originThreadId, Number(nextId));
    const doc = await app.harness.snapshot(HandoffsDoc, context);

    assert.equal(doc?.workItems[next.workItemId]?.predecessorWorkItemId, review.workItemId);
    const nextOnly = app.config.addUser("Only new-work origin", "guest", [String(nextId)]).user;

    assert.equal(app.canSee(nextOnly, source), false);
    assert.equal(app.canSee(nextOnly, publishId), false);
    const newItemRepair = cid((await start(nextId, "follow-up", "new-item-repair")).id);

    await delivered(newItemRepair);
    await assert.rejects(
        app.handoffs.complete(newItemRepair, owner(app), {
            status: "review-complete",
            summary: "The predecessor work item's independent review must not certify new work.",
        }),
        /recorded independent Reviewer outcome/,
    );
    const scopedReview = await app.handoffs.start(newItemRepair, nextOnly, {
        targetType: "reviewer",
        relationship: "same-work",
        requestId: "scoped-new-item-review",
    });
    const scopedReviewId = cid(scopedReview.id);

    assert.equal(app.canSee(nextOnly, scopedReviewId), true);
    assert.equal(
        app.canSee(scoped, scopedReviewId),
        true,
        "The original source-scoped grant still flows forward",
    );
    assert.equal(app.sessionMeta(scopedReviewId)?.accessFrom, Number(newItemRepair));
    await delivered(scopedReviewId);
    assert.equal(app.attribution.requesterOf(scopedReviewId), nextOnly.id);
    assert.equal(
        app.canSee(nextOnly, source),
        false,
        "Creating a descendant never grants its caller access to older ancestors",
    );
    const project = await app.projects.create(owner(app), {
        name: "Grouped",
        cwd,
        requestId: "grouped-project",
    });

    await app.projects.assign(owner(app), reviewer, { projectId: project.id });
    const goalWorker = await app.commands.createSession(owner(app), {
        projectId: project.id,
        newGoal: true,
    });
    const goalId = app.sessionMeta(goalWorker.id)?.goalId;

    assert.ok(goalId);
    await app.projects.assign(owner(app), reviewer, { projectId: project.id, goalId });
    const oldMembers = [source, reviewer, followUpId, landId, publishId];

    assert.deepEqual(
        oldMembers.map((id) => app.sessionMeta(id)?.projectId),
        oldMembers.map(() => project.id),
    );
    assert.equal(app.sessionMeta(nextId)?.projectId, undefined);
    await app.projects.updateGoal(owner(app), goalId, { archived: true });
    assert.equal(
        oldMembers.every((id) => app.sessionMeta(id)?.archivedByGoal === goalId),
        true,
    );
    await app.commands.updateSession(landId, owner(app), { archived: false });
    assert.equal(
        oldMembers.every((id) => app.sessionMeta(id)?.archivedByGoal === undefined),
        true,
    );
    assert.equal(
        oldMembers.every((id) => app.sessionMeta(id)?.archived !== true),
        true,
    );
    await app.projects.updateGoal(owner(app), goalId, { archived: false });
    assert.equal(app.sessionMeta(goalWorker.id)?.archived, false);
    await app.commands.updateSession(landId, owner(app), { archived: true });
    assert.equal(
        oldMembers.every((id) => app.sessionMeta(id)?.archived === true),
        true,
    );
    await app.commands.updateSession(source, owner(app), { archived: false });
    assert.equal(
        oldMembers.every((id) => app.sessionMeta(id)?.archived !== true),
        true,
    );
    await app.commands.updateSession(source, owner(app), { title: "Renamed origin" });
    assert.equal((await app.handoffs.list(reviewer, owner(app))).workItem?.title, "Renamed origin");
    const count = app.sessions().length;

    await app.close();
    app = await openApp(model, data);
    assert.deepEqual(await start(source, "reviewer", "review-transition"), review);
    assert.deepEqual(await start(landId, "publish", "publish-transition"), publish);
    assert.equal(app.sessions().length, count);
    assert.equal(app.handoffs.isReadOnly(source), true);
    assert.equal(app.handoffs.isReadOnly(publishId), true);
    assert.equal(app.handoffs.isReadOnly(nextId), true);
    assert.equal(app.handoffs.isReadOnly(scopedReviewId), false);
    const restoredNextOnly = app.config.userById(nextOnly.id)!;

    assert.equal(app.canSee(restoredNextOnly, scopedReviewId), true);
    assert.equal(app.canSee(restoredNextOnly, source), false);
    await assert.rejects(start(source, "worker", "review-transition", "same-work"), status(409));
    await app.handoffs.complete(scopedReviewId, owner(app), {
        status: "needs-review",
        summary: "This review calls for renewed implementation, not a small repair.",
    });
    const implementation = cid((await start(scopedReviewId, "worker", "renewed-worker")).id);

    await delivered(implementation);
    const renewedRepair = cid((await start(implementation, "follow-up", "renewed-repair")).id);

    await delivered(renewedRepair);
    await assert.rejects(
        app.handoffs.complete(renewedRepair, owner(app), {
            status: "review-complete",
            summary: "An earlier review must not certify renewed implementation automatically.",
        }),
        /recorded independent Reviewer outcome/,
    );
    const hiddenSource = await newSession(app, cwd);

    await app.harness.commit(async (tx) => {
        (await tx.doc(SessionsDoc)).items[String(hiddenSource)]!.ownerOnly = true;
    }, context);
    await say(app, hiddenSource, "Report the owner-only implementation for review.");
    const hiddenReview = await start(hiddenSource, "reviewer", "owner-only-review");
    const guest = app.config.addUser("Unrestricted guest", "guest").user;

    assert.equal(app.canSee(guest, cid(hiddenReview.id)), false);
    assert.equal(app.sessionMeta(cid(hiddenReview.id))?.ownerOnly, true);
    await delivered(cid(hiddenReview.id));
});

// Intake owner: real human attribution, model calls and courier delivery must not manufacture third-party review.
test("external review intake rejects agent inventions, links alone and copied handoff evidence", async () => {
    const source = await newSession(app, repo("ungrounded-external-review"));

    await say(app, source, "INVENT_EXTERNAL_REVIEW");
    const output = JSON.stringify(await modelTexts(app, source));

    assert.match(output, /Paste the external review source, findings and reviewed checkpoint/);
    assert.doesNotMatch(output, /Cannot fingerprint/);
    assert.equal(
        (await app.harness.snapshot(WorkflowDoc, source, context))?.externalReview,
        undefined,
    );
    const evidence = {
        source: "https://github.com/example/repo/pull/1#pullrequestreview-123",
        scope: "Retry behavior",
        findings: "Fix the missing retry guard.",
        checkpoint: "a".repeat(40),
    };

    await say(app, source, `Please follow up on ${evidence.source}`);
    // Attribution is deferred metadata. Intake must validate the durable human submission even if it is absent.
    await app.harness.commit(async (tx) => {
        const entries = await tx.scanEntries({ conversationId: source }, 16);
        const input = entries.items.find((entry) => entry.kind === "pi.user");

        assert.ok(input);
        delete (await tx.doc(AuthorsDoc, source)).entries[String(input.id)];
    }, context);
    await assert.rejects(
        app.handoffs.recordExternalReview(source, owner(app), evidence),
        /Paste the external review/,
    );
    const copied = cid(
        (
            await start(
                source,
                "follow-up",
                "copied-external-review",
                "same-work",
                JSON.stringify(evidence),
            )
        ).id,
    );

    await delivered(copied);
    await assert.rejects(
        app.handoffs.recordExternalReview(copied, owner(app), evidence),
        /No matching human-supplied/,
    );
    await assert.rejects(
        app.handoffs.complete(copied, owner(app), {
            status: "review-complete",
            summary: "Material rewrite cannot inherit a passed review.",
            reviewApplicability: "invalidated",
        }),
        /Material rewrites require needs-review/,
    );
    assert.equal((await app.handoffs.list(copied, owner(app))).workflow.externalReview, undefined);
    await say(app, copied, "COMPLETE_FROM_TOOL");
    const refusedCompletion = JSON.stringify(await modelTexts(app, copied));

    assert.match(refusedCompletion, /recorded independent Reviewer outcome/);
    assert.doesNotMatch(refusedCompletion, /Cannot fingerprint/);
    const copiedState = await app.handoffs.list(copied, owner(app));

    assert.equal(copiedState.workflow.status, "active");
    assert.equal(
        (await app.harness.snapshot(WorkflowDoc, copied, context))?.fingerprint,
        undefined,
    );
    assert.equal(
        copiedState.options.find((option) => option.targetType === "land")?.enabled,
        false,
    );
});

// A material rewrite must revoke readiness even when code-bound completion cannot inspect the checkout.
test("material review invalidation persists without manufacturing completion when checkpoint inspection fails", async () => {
    const cwd = join(root, "non-git-material-rewrite");

    mkdirSync(cwd);
    const source = await newSession(app, cwd);

    await say(app, source, "Review the implementation.");
    const reviewer = cid((await start(source, "reviewer", "unfingerprintable-review")).id);

    await delivered(reviewer);
    await say(app, reviewer, "MATERIAL_REWRITE_CHECKPOINT_UNAVAILABLE");
    const state = (await app.handoffs.list(reviewer, owner(app))).workflow;
    const stored = await app.harness.snapshot(WorkflowDoc, reviewer, context);

    assert.equal(state.status, "needs-review");
    assert.equal(state.reviewApplicability, "invalidated");
    assert.deepEqual(
        state.recommendations?.map((rec) => rec.targetType),
        ["reviewer"],
    );
    assert.equal(
        stored?.completedAt,
        undefined,
        "failed fingerprint inspection never establishes code-bound completion",
    );
    assert.equal(stored?.fingerprint, undefined);
    await app.close();
    app = await openApp(model, data);
    const repair = cid((await start(reviewer, "follow-up", "invalidated-without-completion")).id);

    await delivered(repair);
    await assert.rejects(
        app.handoffs.complete(repair, owner(app), {
            status: "review-complete",
            summary: "Try to reuse invalidated review after a failed completion.",
        }),
        /Material changes invalidate/,
    );
});

// Stored outcomes are historical input, not a fixture substituting for successful checkpoint inspection.
test("unresolved checks revoke earlier readiness even when checkpoint inspection fails, preserving independent evidence", async () => {
    const cwd = join(root, "non-git-unresolved-review");

    mkdirSync(cwd);
    const source = await newSession(app, cwd);

    await say(app, source, "Review the implementation.");
    const reviewer = cid((await start(source, "reviewer", "historical-review-blocker")).id);

    await delivered(reviewer);
    const recordedAt = Date.now() - 1000;
    const previousCheckpoint = {
        cwd,
        digest: "historical-reviewed-checkpoint",
        head: "historical-head",
        status: "",
    };

    await app.harness.commit(async (tx) => {
        const state = await tx.doc(WorkflowDoc, reviewer);

        state.status = "review-complete";
        state.summary = "Previously recorded independent review.";
        state.fingerprint = previousCheckpoint;
        state.completedAt = recordedAt;
        state.completedBy = owner(app).id;
        state.recommendations = [{ targetType: "land", relationship: "same-work" }];
    }, context);
    const summary = "A required verification check is unresolved; do not land yet.";

    await assert.rejects(
        app.handoffs.complete(reviewer, owner(app), { status: "needs-review", summary }),
        /Cannot fingerprint/,
    );
    const state = await app.harness.snapshot(WorkflowDoc, reviewer, context);

    assert.equal(state?.status, "needs-review", "a blocker revokes the previous passed milestone");
    assert.equal(state?.summary, summary);
    assert.equal(state?.readyForPublish, false);
    assert.deepEqual(state?.recommendations, []);
    assert.equal(
        state?.reviewApplicability,
        undefined,
        "ordinary blockers do not invalidate review",
    );
    assert.deepEqual(state?.fingerprint, previousCheckpoint);
    assert.equal(
        state?.completedAt,
        recordedAt,
        "failed inspection creates no new completion identity",
    );
    assert.equal(state?.completedBy, owner(app).id);
    await app.close();
    app = await openApp(model, data);
    const restored = await app.handoffs.list(reviewer, owner(app));
    const land = restored.options.find((option) => option.targetType === "land");

    assert.equal(restored.workflow.status, "needs-review");
    assert.equal(land?.enabled, false);
    assert.match(land?.reason ?? "", /Complete review/);
});

// Positive checkpoint proof requires the real OS sandbox, just like the internal-review lifecycle above.
test("external review survives repair and restart; only material rewrites request fresh independent review", async () => {
    const cwd = repo("external-review-repair");
    const { id: source } = await app.commands.createSession(owner(app), {
        cwd,
        threadType: "worker",
    });

    await app.commands.configure(source, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });
    const evidence = {
        source: "https://github.com/example/repo/pull/1#pullrequestreview-123",
        scope: "The complete retry feature and its tests",
        findings:
            "Independent reviewer: fix the missing retry guard; the rest of the feature is sound.",
        checkpoint: git(cwd, "rev-parse", "HEAD").trim(),
    };

    await say(
        app,
        source,
        `External independent review to repair. RECORD_EXTERNAL_REVIEW\n${JSON.stringify(evidence)}`,
    );
    const recorded = (await app.handoffs.list(source, owner(app))).workflow.externalReview;

    assert.ok(recorded, JSON.stringify(await modelTexts(app, source)));
    assert.equal(recorded.source, evidence.source);
    assert.equal(recorded.scope, evidence.scope);
    assert.equal(recorded.suppliedBy, owner(app).id);
    assert.equal(recorded.checkpoint, evidence.checkpoint);
    assert.equal(
        "fingerprint" in recorded,
        false,
        "intake does not expose private inspected Git status through HTTP/room projections",
    );
    assert.equal(
        "findings" in recorded,
        false,
        "raw review text stays in the attributed input rather than room-wide workflow metadata",
    );
    const storedReview = (await app.harness.snapshot(WorkflowDoc, source, context))?.externalReview;

    assert.equal(storedReview?.findings, evidence.findings);
    assert.ok(storedReview?.sourceSubmissionId);
    assert.match(storedReview?.sourceRequestId ?? "", /^u:/);
    assert.equal(
        (await app.handoffs.list(source, owner(app))).workflow.status,
        "active",
        "intake is not review completion",
    );
    const repair = cid((await start(source, "follow-up", "external-small-repair")).id);

    await delivered(repair);
    writeFileSync(join(cwd, "code.txt"), "bounded retry repair\n");
    await assert.rejects(
        app.handoffs.recordExternalReview(source, owner(app), evidence),
        /permanently read-only/,
    );
    await app.close();
    app = await openApp(model, data);
    await app.handoffs.complete(repair, owner(app), {
        status: "needs-review",
        summary:
            "A required repair check is still unresolved; independent review remains applicable.",
    });
    assert.equal(
        (await app.handoffs.list(repair, owner(app))).workflow.recommendations?.some(
            (rec) => rec.targetType === "reviewer",
        ),
        false,
    );
    await app.handoffs.complete(repair, owner(app), {
        status: "review-complete",
        summary:
            "External independent review applies to untouched code; repair checks and delta self-review passed.",
    });
    const repaired = await app.handoffs.list(repair, owner(app));

    assert.deepEqual(
        repaired.workflow.recommendations?.map((rec) => rec.targetType),
        ["land"],
    );
    assert.equal(repaired.options.find((option) => option.targetType === "land")?.enabled, true);
    const rewrite = cid((await start(repair, "follow-up", "external-material-rewrite")).id);

    await delivered(rewrite);
    writeFileSync(join(cwd, "code.txt"), "materially redesigned feature\n");
    await app.handoffs.complete(rewrite, owner(app), {
        status: "needs-review",
        summary: "The repair materially reworked the feature; original review no longer applies.",
        reviewApplicability: "invalidated",
    });
    const rewritten = await app.handoffs.list(rewrite, owner(app));

    assert.deepEqual(
        rewritten.workflow.recommendations?.map((rec) => rec.targetType),
        ["reviewer"],
    );
    assert.equal(rewritten.options.find((option) => option.targetType === "land")?.enabled, false);
    await assert.rejects(
        app.handoffs.complete(rewrite, owner(app), {
            status: "review-complete",
            summary: "Try to clear invalidation with a self-attestation.",
            reviewApplicability: "preserved",
        }),
        /fresh independent review/,
    );
    const repeated = cid((await start(rewrite, "follow-up", "external-invalidated-successor")).id);

    await delivered(repeated);
    await assert.rejects(
        app.handoffs.complete(repeated, owner(app), {
            status: "review-complete",
            summary: "A new repair thread cannot restore invalidated evidence.",
        }),
        /Material changes invalidate/,
    );
    const renewed = {
        ...evidence,
        source: "External review system: independent assessment by Casey",
        findings:
            "Casey independently reviewed the redesigned feature and tests; no findings remain.",
        checkpoint: await app.handoffs.fingerprint(repeated),
    };

    await say(
        app,
        repeated,
        `Original reviewed commit ${evidence.checkpoint}; new independent assessment: ${JSON.stringify(renewed)}`,
    );
    await assert.rejects(
        app.handoffs.recordExternalReview(repeated, owner(app), {
            ...renewed,
            checkpoint: evidence.checkpoint,
        }),
        /checkpoint does not match/,
    );
    await app.handoffs.recordExternalReview(repeated, owner(app), renewed);
    await app.handoffs.complete(repeated, owner(app), {
        status: "review-complete",
        summary: "Fresh external review, applicable checks and delta review support landing.",
    });
    const landed = cid((await start(repeated, "land", "external-reviewed-land")).id);

    await delivered(landed);
    assert.equal(app.sessionMeta(landed)?.threadType, "land");
});

// Migration contract: older versions accepted Follow-up attestations without Reviewer provenance.
// Stored readiness is historical input here, not a fixture pretending to produce an approved review.
test("legacy Follow-up attestations require provenance before Land inspection and after restart", async () => {
    const source = await newSession(app, repo("legacy-follow-up"));

    await say(app, source, "Implemented work without independent review.");
    const repair = cid((await start(source, "follow-up", "legacy-follow-up")).id);

    await delivered(repair);
    await app.harness.commit(async (tx) => {
        const state = await tx.doc(WorkflowDoc, repair);

        state.status = "review-complete";
        state.summary = "Historical self-attestation without a Reviewer.";
        state.completedAt = Date.now();
        state.completedBy = owner(app).id;
        state.fingerprint = {
            cwd: app.cwdOf(repair),
            digest: "historical-attestation",
            head: "historical-head",
            status: "",
        };
    }, context);
    const land = (await app.handoffs.list(repair, owner(app))).options.find(
        (option) => option.targetType === "land",
    );

    assert.equal(land?.enabled, false);
    assert.match(land?.reason ?? "", /recorded independent Reviewer outcome/);
    await app.close();
    app = await openApp(model, data);
    await assert.rejects(
        start(repair, "land", "legacy-land"),
        /recorded independent Reviewer outcome/,
    );
    await assert.rejects(
        app.handoffs.complete(repair, owner(app), {
            status: "review-complete",
            summary: "The earlier Follow-up milestone alone is not independent review.",
        }),
        /recorded independent Reviewer outcome/,
    );
    const successor = cid((await start(repair, "follow-up", "legacy-successor")).id);

    await delivered(successor);
    await assert.rejects(
        app.handoffs.complete(successor, owner(app), {
            status: "review-complete",
            summary: "A predecessor Follow-up attestation is not independent review either.",
        }),
        /recorded independent Reviewer outcome/,
    );
});

// Compatibility admission reads real human submissions plus historical workflow/transfer documents.
// These stored fixtures do not substitute for positive intake or real sandbox fingerprint coverage.
test("stored external review cannot cross implementation or integration drift before the repair chain", async () => {
    for (const threadType of ["worker", "pull", "chat"] as const) {
        const cwd = join(root, `non-git-historical-external-${threadType}`);

        mkdirSync(cwd);
        const { id: source } = await app.commands.createSession(owner(app), { cwd, threadType });

        await app.commands.configure(source, owner(app), {
            model: { provider: "faux", modelId: "faux-1" },
            thinkingLevel: "off",
        });
        const evidence = {
            source: "External independent review by Casey",
            scope: "The original feature",
            findings: "One bounded retry repair remains.",
            checkpoint: "a".repeat(40),
        };
        const requestId = `historical-external-${threadType}`;
        const submitted = await app.commands.submit(source, owner(app), {
            text: JSON.stringify(evidence),
            requestId,
        });

        await (await app.harness.submission(submitted.submissionId, context))!.wait(context);
        const inspected = { cwd, head: evidence.checkpoint, digest: "b".repeat(64), status: "" };

        await app.harness.commit(async (tx) => {
            const submission = await tx.submissionByRequest(
                source,
                `u:${owner(app).id}:${requestId}`,
            );

            assert.ok(submission?.entry);
            (await tx.doc(WorkflowDoc, source)).externalReview = {
                ...evidence,
                sourceEntryId: Number(submission.entry),
                sourceSubmissionId: Number(submission.id),
                sourceRequestId: submission.requestId!,
                suppliedBy: owner(app).id,
                recordedBy: owner(app).id,
                recordedAt: Date.now() - 1000,
                fingerprint: inspected,
            };
        }, context);
        const handoff = await start(
            source,
            "follow-up",
            `historical-external-transfer-${threadType}`,
        );
        const repair = cid(handoff.id);

        await delivered(repair);
        await app.harness.commit(async (tx) => {
            (await tx.doc(HandoffsDoc)).handoffs[handoff.handoffId]!.codeCheckpoint = {
                ...inspected,
                digest: "c".repeat(64),
            };
        }, context);
        await app.close();
        app = await openApp(model, data);
        const complete = () =>
            app.handoffs.complete(repair, owner(app), {
                status: "review-complete",
                summary:
                    "Try to reuse the external review after renewed implementation/integration.",
            });

        await assert.rejects(
            complete(),
            /External review checkpoint changed before entering repairs/,
        );
        await app.harness.commit(async (tx) => {
            delete (await tx.doc(HandoffsDoc)).handoffs[handoff.handoffId]!.codeCheckpoint;
        }, context);
        await assert.rejects(
            complete(),
            /External review checkpoint changed before entering repairs/,
        );
        await app.harness.commit(async (tx) => {
            (await tx.doc(HandoffsDoc)).handoffs[handoff.handoffId]!.codeCheckpoint = inspected;
        }, context);
        // A matching historical transfer passes provenance admission and reaches the missing-checkout guard.
        // This control proves drift refusal was not an unrelated authorship or identity guard.
        await assert.rejects(complete(), /Cannot fingerprint/);
    }
});

// Configured filters are real child processes: they must remain offline/read-only and cannot alias raw code fingerprints.
test(
    "fingerprint inspection sandboxes Git filters and binds actual tracked bytes rather than normalized output",
    { skip: process.platform !== "darwin" },
    async () => {
        const cwd = repo("filter-handoff");
        const probe = join(root, "clean-filter-probe");
        const helper = join(root, "malicious-clean-filter.sh");
        let requests = 0;
        const server = createServer((_request, response) => {
            requests++;
            response.end("normalized\\n");
        });

        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();

        assert.ok(address && typeof address === "object");

        try {
            writeFileSync(join(cwd, ".gitattributes"), "code.txt filter=alias\n");
            git(cwd, "config", "filter.alias.clean", "printf 'normalized\\n'");
            git(cwd, "add", "--renormalize", ".");
            commit(cwd, "normalized baseline");
            assert.equal(git(cwd, "show", "HEAD:code.txt"), "normalized\n");
            writeFileSync(
                helper,
                `printf escaped > ${JSON.stringify(probe)} 2>/dev/null\n/usr/bin/curl --max-time 2 --silent http://127.0.0.1:${address.port}/ > /dev/null\nprintf 'normalized\\n'\n`,
            );
            git(cwd, "config", "filter.alias.clean", `/bin/sh ${JSON.stringify(helper)}`);
            const source = await newSession(app, cwd);

            writeFileSync(join(cwd, "code.txt"), "changedA\n");
            await say(app, source, "Report the physical tracked-byte change for review.");
            const reviewer = cid((await start(source, "reviewer", "filter-review")).id);

            await delivered(reviewer);
            await app.handoffs.complete(reviewer, owner(app), {
                status: "review-complete",
                summary: "Inspected the physical tracked bytes.",
            });
            const state = await app.harness.snapshot(WorkflowDoc, reviewer, context);
            const first = await app.handoffs.fingerprint(reviewer);

            assert.equal(
                state?.fingerprint?.status,
                "",
                "The actual configured clean filter normalized Git status",
            );
            writeFileSync(join(cwd, "code.txt"), "changedB\n");
            assert.notEqual(
                await app.handoffs.fingerprint(reviewer),
                first,
                "Equal-length raw changes cannot alias through Git clean filters",
            );
            assert.equal(
                existsSync(probe),
                false,
                "A configured filter cannot write outside the inspection sandbox",
            );
            assert.equal(
                requests,
                0,
                "Git filters and descendants cannot reach even a local HTTP listener",
            );
            await assert.rejects(start(reviewer, "land", "filter-drift"), status(409));
        } finally {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    },
);

// Gate: actual invocation commits and live descendant/background writers—not metadata-only mocks—guard activation.
test("tools prepare/complete but never activate; descendant and background writers reject activation without aborting", async () => {
    const cwd = repo("writer-handoff");
    const source = await newSession(app, cwd);
    const before = app.sessions().length;

    await say(app, source, "PREPARE_ONLY");
    assert.equal(app.sessions().length, before);
    assert.equal(
        (await app.handoffs.list(source, owner(app))).workflow.proposal?.targetType,
        "reviewer",
        JSON.stringify(
            await app.harness.commit(
                (tx) => tx.scanTasks({ conversationId: source }, 100),
                context,
            ),
        ),
    );
    const prepared = await start(source, "reviewer", "prepared-review");
    const reviewer = cid(prepared.id);

    await delivered(reviewer);
    const review = await app.handoffs.list(reviewer, owner(app));

    assert.equal(
        review.workflow.status,
        "review-complete",
        JSON.stringify(await modelTexts(app, reviewer)),
    );
    assert.equal(
        review.workflow.summary,
        "Reviewer fixed the retry issue and reran lifecycle tests.",
    );
    assert.equal(review.workflow.recommendations?.[0]?.targetType, "land");
    assert.ok(
        review.handoffs.some(
            (record) =>
                record.targetThreadId === prepared.id &&
                record.brief.includes("COMPLETE_FROM_TOOL. Original ask"),
        ),
        "human activation consumes the agent-authored brief without a replacement human payload",
    );
    assert.equal(
        app.sessions().length,
        before + 1,
        "agent completion/recommendation never activates Land",
    );
    const free = await newSession(app, cwd);

    childGate = new Promise<void>((resolve) => {
        releaseChild = resolve;
    });
    await say(app, free, "SPAWN_CHILD");
    const child = (await app.harness.snapshot(SubagentsDoc, free, context))?.agents.writer
        ?.conversationId;

    assert.ok(child);
    await until(() => app.isBusy(child), "child writer running");
    const count = app.sessions().length;

    await assert.rejects(start(free, "reviewer", "child-busy"), status(409));
    assert.equal(app.sessions().length, count);
    assert.equal(app.isBusy(child), true);
    releaseChild?.();
    await until(() => !app.isBusy(child) && !app.isBusy(free), "child writer and reporter idle");
    const resumed = await start(free, "reviewer", "child-busy");

    await delivered(cid(resumed.id));
    assert.equal(app.handoffs.isReadOnly(child), true);
    assert.equal(app.handoffs.isManaged(child), true);
    assert.equal((await app.envFor(child).writeFile("forbidden.txt", "bad", context)).ok, false);
    const shellSource = await newSession(app, cwd);

    await app.shell.start(shellSource, owner(app), {
        command: "sleep 1; printf done > background-finished.txt",
        requestId: "background-writer",
    });
    assert.equal(
        (await app.handoffs.list(shellSource, owner(app))).options.every((each) => !each.enabled),
        true,
        "discovery must include background work even without a main-thread run",
    );
    await assert.rejects(start(shellSource, "reviewer", "shell-busy"), status(409));
    await until(
        () => existsSync(join(cwd, "background-finished.txt")),
        "background shell was not aborted",
    );
    await until(
        async () =>
            (await app.harness.snapshot(InboxDoc, shellSource, context))?.items.length === 0,
        "shell result admitted",
    );
});

// Gate: restart between activation and first prompt proves delivery reservations are durable and destination ownerless.
test("a committed destination resumes delivery after restart with one attributed input and no source ownership", async () => {
    const cwd = repo("restart-handoff");
    const source = await newSession(app, cwd);

    await say(app, source, "Original specification: restart must deliver exactly once.");
    const created = await start(
        source,
        "reviewer",
        "pending-delivery",
        "same-work",
        "RESTART_DELAY",
    );
    const id = cid(created.id);

    await app.close();
    app = await openApp(model, data);
    await delivered(id);
    const record = await app.harness.commit((tx) => tx.conversation(id), context);

    assert.ok(record);
    assert.equal(record.owner, undefined);
    assert.deepEqual(
        await start(source, "reviewer", "pending-delivery", "same-work", "RESTART_DELAY"),
        created,
    );
    const entries = (
        await (await app.conversation(id)).entries({ order: "ascending" }, 100, undefined, context)
    ).items;

    assert.equal(entries.filter((entry) => entry.kind === "pi.user").length, 1);
    assert.equal(app.attribution.requesterOf(id), owner(app).id);
    assert.ok(
        (await app.handoffs.list(id, owner(app))).handoffs[0]?.brief.includes(
            "Original specification",
        ),
    );
});

// Cleanup owns a distinct filesystem lifecycle: all metadata moves together and deleted checkouts cannot stay ready.
test("human worktree cleanup moves the whole item and invalidates readiness when the source checkout differs", async () => {
    const cwd = repo("cleanup-handoff");
    const source = (await app.commands.createSession(owner(app), { cwd, worktree: true })).id;
    const checkout = app.cwdOf(source);

    await say(app, source, "Report the worktree implementation for review.");
    const review = await start(source, "reviewer", "cleanup-review");
    const reviewer = cid(review.id);

    await delivered(reviewer);
    assert.equal(app.cwdOf(reviewer), checkout);
    writeFileSync(join(checkout, "code.txt"), "landed feature\n");
    await app.handoffs.complete(reviewer, owner(app), {
        status: "review-complete",
        summary: "Reviewed the feature and checks.",
    });
    const land = await start(reviewer, "land", "cleanup-land");
    const landId = cid(land.id);

    await delivered(landId);
    commit(checkout, "local feature");
    await app.handoffs.complete(landId, owner(app), {
        status: "landed",
        summary: "Local hooks and impact checks passed.",
        readyForPublish: true,
    });
    await assert.rejects(app.commands.removeWorktree(landId, owner(app), true), status(409));
    await app.commands.removeWorktree(landId, owner(app), false);
    assert.equal(existsSync(checkout), false);
    assert.deepEqual(
        [source, reviewer, landId].map((id) => app.cwdOf(id)),
        [cwd, cwd, cwd],
    );
    assert.equal(app.handoffs.isReadOnly(source), true);
    assert.equal(app.handoffs.isReadOnly(reviewer), true);
    assert.equal(app.handoffs.isReadOnly(landId), false);
    assert.equal((await app.handoffs.list(landId, owner(app))).workflow.readyForPublish, false);
    await assert.rejects(start(landId, "publish", "cleanup-publish"), status(409));
});
