// The real registered tool owns current-human-input admission, route binding, atomic transfer and retry receipts.
// Faux generation supplies decisions, never the authority, successor or receipt asserted below.
import {
    type App,
    cleanUp,
    context,
    lastText,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { awaitWithContext } from "@earendil-works/chord/context";
import { dirname, isAbsolute, join, relative } from "node:path";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId, JsonObject } from "@earendil-works/pi-durable";
import { err, FileError } from "@earendil-works/pi-durable/env";
import { sshFixture } from "./ssh-fixture.ts";
import type { Changes } from "../src/server/changes.ts";
import { PlanDoc, SessionsDoc, SubagentsDoc, TurnsDoc } from "../src/server/docs.ts";
import { handoffInputKey } from "../src/server/handoff-input.ts";
import { requestFor } from "../src/server/requests.ts";
import { TITLE_PROMPT } from "../src/server/titles.ts";
import { HandoffsDoc, type ThreadType } from "../src/server/workflow-docs.ts";
import { PublicationsDoc } from "../src/server/workflow-publication.ts";
import { reserveWorkflowLocalWrite } from "../src/server/workflow-policy.ts";

let app: App;
const data = join(root, "handoff-execution");
const summary =
    "Ask: investigate retries. Files: handoffs.ts. Tests: focused only. Deferred: browser. No commits or restart authorized.";
const cid = (id: number) => id as ConversationId;
const changed: Changes = {
    files: [{ path: "retry.ts", kind: "modified", byPi: true }],
    piOnly: [],
    more: 0,
};

type Gate = { promise: Promise<void>; release: () => void };

function gate(): Gate {
    let release = () => {};

    const promise = new Promise<void>((resolve) => {
        release = resolve;
    });

    return { promise, release };
}

type Call = JsonObject;
type Result = { text: string; isError: boolean };
type Scenario = {
    calls: Call[];
    round: number;
    results: Result[];
    hold?: Gate;
    entered: boolean;
};
const scenarios = new Map<string, Scenario>();
const courierResults: Result[] = [];
const courierReads = new Map<string, Result>();
const handoffDirectories = new Set<string>();
const helperResults: Result[] = [];
let helperGate: Gate | undefined;
const stripAuthor = (text: string) =>
    text.replace(/^\[from:[^\]]+\]\s*/, "").replace(/^\[via handoff\]\s*/, "");
const model = scriptedModel(async (input) => {
    const last = lastText(input as never);
    const lastUser = input.messages.findLast((message) => message.role === "user");
    const original =
        lastUser === undefined ? "" : stripAuthor(lastText({ messages: [lastUser] } as never).text);

    if (last.role === "user" && last.text.startsWith(TITLE_PROMPT)) {
        return fauxAssistantMessage("Investigate durable retry execution");
    }

    if (original.startsWith("Continue as the ")) {
        const pathMatch = /Read the handoff file ("(?:\\.|[^"\\])*") using read/.exec(original);
        const path = pathMatch === null ? undefined : (JSON.parse(pathMatch[1]!) as string);
        const read = input.messages.findLast(
            (message) => message.role === "toolResult" && message.toolName === "read",
        );
        const latest = input.messages.at(-1);
        const contents =
            read === undefined ? original : lastText({ messages: [read] } as never).text;

        if (path !== undefined && last.role === "user") {
            handoffDirectories.add(dirname(path));

            return fauxAssistantMessage([fauxToolCall("read", { path })], {
                stopReason: "toolUse",
            });
        }

        if (path !== undefined && read !== undefined) {
            courierReads.set(path, {
                text: contents,
                isError: "isError" in read && read.isError === true,
            });
        }

        if (contents.includes("TRY_COURIER_CHAIN")) {
            if (
                last.role === "user" ||
                (latest?.role === "toolResult" && latest.toolName === "read")
            ) {
                return fauxAssistantMessage(
                    [
                        fauxToolCall("handoff", {
                            action: "start",
                            targetType: "worker",
                            summary,
                        }),
                    ],
                    { stopReason: "toolUse" },
                );
            }

            if (last.role === "toolResult") {
                const message = input.messages.at(-1)!;

                courierResults.push({
                    text: last.text,
                    isError: "isError" in message && message.isError === true,
                });
            }
        }

        return fauxAssistantMessage("Successor received the summary and human direction.");
    }

    if (original.includes("HOLD_HANDOFF_HELPER")) {
        if (last.role === "user") {
            return fauxAssistantMessage(
                [
                    fauxToolCall("handoff", {
                        action: "start",
                        targetType: "researcher",
                        summary,
                    }),
                ],
                { stopReason: "toolUse" },
            );
        }

        if (last.role === "toolResult") {
            const message = input.messages.at(-1)!;

            helperResults.push({
                text: last.text,
                isError: "isError" in message && message.isError === true,
            });
        }

        await helperGate?.promise;

        return fauxAssistantMessage("Helper completed its work.");
    }

    if (original === "Delegate a helper before a later handoff") {
        return last.role === "user"
            ? fauxAssistantMessage(
                  [
                      fauxToolCall("subagent", {
                          action: "spawn",
                          name: "writer",
                          message: "HOLD_HANDOFF_HELPER",
                      }),
                  ],
                  { stopReason: "toolUse" },
              )
            : fauxAssistantMessage("Waiting for the delegated report.");
    }

    const scenario = scenarios.get(original);

    if (scenario !== undefined) {
        if (last.role === "toolResult") {
            const message = input.messages.at(-1)!;

            scenario.results.push({
                text: last.text,
                isError: "isError" in message && message.isError === true,
            });
            scenario.round++;
        }

        if (last.role === "user" || last.role === "toolResult") {
            scenario.entered = true;
            await scenario.hold?.promise;
            const call = scenario.calls[scenario.round];

            if (call !== undefined) {
                return fauxAssistantMessage([fauxToolCall("handoff", call)], {
                    stopReason: "toolUse",
                });
            }
        }
    }

    return fauxAssistantMessage("Which role and scope should take this next?");
});

before(async () => {
    app = await openApp(model, data);
});
after(async () => {
    helperGate?.release();

    for (const scenario of scenarios.values()) {
        scenario.hold?.release();
    }

    await app.close();

    for (const directory of handoffDirectories) {
        rmSync(directory, { recursive: true, force: true });
    }

    cleanUp();
});

async function source(threadType: ThreadType = "worker") {
    const { id } = await app.commands.createSession(owner(app), {
        cwd: work,
        threadType,
        title: "Handoff execution",
    });

    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });

    return id;
}

function script(body: string, calls: Call[], hold?: Gate) {
    const scenario: Scenario = {
        calls,
        round: 0,
        results: [],
        entered: false,
        ...(hold === undefined ? {} : { hold }),
    };

    scenarios.set(body, scenario);

    return scenario;
}

async function run(
    id: ConversationId,
    body: string,
    calls: Call[],
    requestId: string = crypto.randomUUID(),
) {
    const scenario = script(body, calls);
    const accepted = await app.commands.submit(id, owner(app), { text: body, requestId });

    await (await app.harness.submission(accepted.submissionId, context))!.wait(context);
    await until(() => !app.isBusy(id), "source tool round settles");

    return { scenario, accepted };
}

async function records(id: ConversationId) {
    return Object.values((await app.harness.snapshot(HandoffsDoc, context))?.handoffs ?? {}).filter(
        (record) => record.sourceThreadId === Number(id),
    );
}

async function delivered(id: ConversationId) {
    await until(async () => {
        const incoming = Object.values(
            (await app.harness.snapshot(HandoffsDoc, context))?.handoffs ?? {},
        ).find((record) => record.targetThreadId === Number(id));

        return incoming?.delivery === "delivered" && !app.isBusy(id);
    }, "successor courier settles");
}

async function sourceUsers(id: ConversationId) {
    const entries = await (
        await app.conversation(id)
    ).entries({ order: "ascending" }, 200, undefined, context);

    return entries.items.filter((entry) => entry.kind === "pi.user");
}

const start = (targetType = "researcher", relationship = "same-work"): Call => ({
    action: "start",
    targetType,
    relationship,
    summary,
});

// New owner-boundary proof: normal submitted input reaches the registered tool with no synthetic summary turn.
// Regression: retaining the old command interceptor, unbound tool args or dropping human direction breaks this.
test("normal slash/freeform/English inputs execute with exact human direction and no synthetic source input", async (t) => {
    t.mock.method(app.workspace, "changes", async () => changed);
    const rows = [
        {
            body: "/handoff review --same Inspect retries.\n  Keep --new literal here.",
            kind: "reviewer",
            relation: "same-work",
            direction: "Inspect retries.\n  Keep --new literal here.",
        },
        {
            body: "/handoff --new worker Implement this follow-up.",
            kind: "worker",
            relation: "new-work",
            direction: "Implement this follow-up.",
        },
        {
            body: "/handoff researcher Investigate only cancellation.",
            kind: "researcher",
            relation: "same-work",
            direction: "Investigate only cancellation.",
        },
        {
            body: "/handoff investigate retries --new is literal prose now",
            kind: "researcher",
            relation: "same-work",
            direction: "investigate retries --new is literal prose now",
        },
        {
            body: "Please hand this to a researcher to investigate only duplicate delivery.",
            kind: "researcher",
            relation: "same-work",
            direction: "Please hand this to a researcher to investigate only duplicate delivery.",
        },
        {
            body: `/handoff researcher ${"Keep the exact direction. 🧭 ".repeat(400)}`.trim(),
            kind: "researcher",
            relation: "same-work",
            direction: "Keep the exact direction. 🧭 ".repeat(400).trim(),
            summary: "Keep the full generated handoff. 漢字\n".repeat(500),
        },
    ];

    for (const row of rows) {
        const id = await source();
        const requestId = row === rows[0] ? "schedule-foo" : crypto.randomUUID();
        const count = app.sessions().length;
        const { scenario, accepted } = await run(
            id,
            row.body,
            [{ ...start(row.kind, row.relation), summary: row.summary ?? summary }],
            requestId,
        );

        assert.equal(scenario.results.length, 1);
        assert.equal(scenario.results[0]!.isError, false, scenario.results[0]!.text);
        const [record] = await records(id);

        assert.ok(record);
        assert.equal(record.targetType, row.kind);
        assert.equal(record.relationship, row.relation);
        assert.ok(record.file, "the actual Markdown file is written before creating the successor");
        handoffDirectories.add(dirname(record.file));
        assert.ok(isAbsolute(record.file));
        assert.ok(relative(work, record.file).startsWith(".."), "handoff is outside the checkout");
        assert.match(dirname(record.file), /pi-coop-handoff-/);
        assert.equal(statSync(dirname(record.file)).mode & 0o777, 0o700);
        assert.equal(
            readFileSync(record.file, "utf8"),
            [
                `# Handoff from thread ${id}`,
                row.summary ?? summary,
                `Human direction for the successor (verbatim; subject to its role, safety and mutation limits):\n<human_handoff_direction>\n${row.direction}\n</human_handoff_direction>`,
            ].join("\n\n") + "\n",
        );
        assert.equal(record.brief, undefined, "no second stored inline summary");
        assert.equal(record.instructions, undefined, "human direction lives in the file");
        assert.equal(
            record.requestKey,
            handoffInputKey(owner(app).id, id, `u:${owner(app).id}:${requestId}`),
        );
        assert.ok("handoffRequestKey" in accepted);
        assert.equal(accepted.handoffRequestKey, record.requestKey);
        assert.equal(app.sessions().length, count + 1);
        assert.equal(app.workItems.isReadOnly(id), true);
        assert.equal(app.sessionMeta(cid(record.targetThreadId))?.threadType, row.kind);
        assert.equal((await sourceUsers(id)).length, 1, "no app-authored source summary turn");
        assert.equal(
            Object.values((await app.harness.snapshot(HandoffsDoc, context))?.pending ?? {}).some(
                (pending) => pending.sourceThreadId === Number(id),
            ),
            false,
        );
        await delivered(cid(record.targetThreadId));
        const successorUsers = await sourceUsers(cid(record.targetThreadId));

        assert.equal(successorUsers.length, 1);
        const prompt = JSON.stringify(successorUsers[0]!.model);

        assert.ok(prompt.includes(record.file));
        assert.ok(!prompt.includes((row.summary ?? summary).replaceAll("\n", "\\n")));
        assert.ok(!prompt.includes(row.direction.replaceAll("\n", "\\n")));
        assert.equal(
            courierReads.get(record.file)?.isError,
            false,
            "the successor can use the existing read tool",
        );
        assert.ok(courierReads.get(record.file)?.text.includes(row.direction.slice(0, 80)));
        const submission = await app.harness.commit(
            (tx) =>
                tx.submissionByRequest(
                    cid(record.targetThreadId),
                    requestFor(owner(app).id, `handoff:${record.id}:0`),
                ),
            context,
        );

        assert.equal(submission?.type, "input");

        assert.match(
            submission?.requestId ?? "",
            /^p:/,
            "generated delivery is not forged human authorship",
        );
        const retried = await app.commands.submit(id, owner(app), { text: row.body, requestId });

        assert.equal(retried.submissionId, accepted.submissionId);
        assert.equal((await records(id)).length, 1);
    }
});

// status has a distinct risk: its own live run must not disable every option before the agent can act.
// Repeated real invocations independently prove immutable request receipts, not a mocked receipt store.
test("status exempts its own invocation; repeated start returns one receipt and pins arguments", async (t) => {
    t.mock.method(app.workspace, "changes", async () => changed);
    const id = await source();
    const { scenario } = await run(id, "/handoff researcher Inspect retry receipts.", [
        { action: "status" },
        start(),
        start(),
        { ...start(), summary: "Different summary" },
    ]);
    const status = JSON.parse(scenario.results[0]!.text);

    assert.equal(
        status.options.find(
            (option: { targetType: string; relationship: string }) =>
                option.targetType === "researcher" && option.relationship === "same-work",
        ).enabled,
        true,
    );
    assert.equal(scenario.results[1]!.isError, false, scenario.results[1]!.text);
    assert.equal(scenario.results[2]!.isError, false, scenario.results[2]!.text);
    assert.deepEqual(JSON.parse(scenario.results[1]!.text), JSON.parse(scenario.results[2]!.text));
    assert.equal(scenario.results[3]!.isError, true);
    assert.match(scenario.results[3]!.text, /already started a different handoff/);
    const [record] = await records(id);

    assert.equal((await records(id)).length, 1);
    await delivered(cid(record!.targetThreadId));

    const fresh = await run(id, "Start another handoff from this retired source.", [start()]);

    assert.equal(fresh.scenario.results[0]!.isError, true);
    assert.match(fresh.scenario.results[0]!.text, /previous writer is permanently read-only/);
    assert.equal((await records(id)).length, 1, "receipt recovery never enables a new transfer");
});

// Distinct integration risk: moving handoffs from app UI to a tool must not make plan mode
// prevent human workflow direction. The plan hook still owns the separate checkout-write restriction.
test("a human-requested handoff executes through the plan hook without approving implementation", async () => {
    const id = await source();

    await app.commands.setPlan(id, owner(app), true);
    const { scenario } = await run(id, "/handoff researcher Investigate before implementing.", [
        { action: "status" },
        start(),
    ]);

    assert.equal(scenario.results.length, 2);
    assert.equal(scenario.results[0]!.isError, false, scenario.results[0]!.text);
    assert.equal(scenario.results[1]!.isError, false, scenario.results[1]!.text);
    const [record] = await records(id);

    assert.ok(record);
    assert.equal(record.targetType, "researcher");
    assert.equal((await app.harness.snapshot(PlanDoc, id, context))?.on, true);
    assert.equal(app.workItems.isReadOnly(id), true);
    await delivered(cid(record.targetThreadId));
});

// Distinct lifecycle risk from a second call: the transfer committed but the tool response was lost.
// Reopening disposable storage must replay the real tool against its saved receipt, not mint a new thread.
test("an interrupted tool response replays its committed receipt after a disposable app restart", async (t) => {
    const id = await source();
    const body = "/handoff researcher Persist the transfer before returning the tool result.";
    const scenario = script(body, [start()]);
    const lostResponse = gate();
    let transferred = false;
    const invoke = app.workItems.invoke.bind(app.workItems);

    t.mock.method(app.workItems, "invoke", async (...args: Parameters<typeof invoke>) => {
        const result = await invoke(...args);

        if (args[0].action === "start") {
            transferred = true;
            await awaitWithContext(lostResponse.promise, args[2]);
        }

        return result;
    });
    const accepted = await app.commands.submit(id, owner(app), {
        text: body,
        requestId: "interrupted-tool-result",
    });

    try {
        await until(() => transferred, "atomic transfer committed before the intercepted response");
        const [before] = await records(id);

        assert.ok(before);
        await app.close();
        lostResponse.release();
        t.mock.restoreAll();
        app = await openApp(model, data);
        await (await app.harness.submission(accepted.submissionId, context))!.wait(context);
        await until(() => !app.isBusy(id), "replayed source response settles");
        assert.equal(scenario.results[0]!.isError, false, scenario.results[0]!.text);
        const after = await records(id);

        assert.equal(after.length, 1);
        assert.equal(after[0]!.id, before.id);
        assert.equal(after[0]!.targetThreadId, before.targetThreadId);
        assert.equal(JSON.parse(scenario.results[0]!.text).id, before.targetThreadId);
        assert.equal((await sourceUsers(id)).length, 1);
        await delivered(cid(before.targetThreadId));
        assert.equal((await sourceUsers(cid(before.targetThreadId))).length, 1);
    } finally {
        lostResponse.release();
        t.mock.restoreAll();
    }
});

test("ambiguous requests can ask follow-ups without creating intent or a successor", async () => {
    const id = await source();
    const { scenario } = await run(id, "/handoff take this somewhere useful", []);

    assert.equal(scenario.results.length, 0);
    assert.equal((await records(id)).length, 0);
    assert.equal(app.workItems.isReadOnly(id), false);
    assert.equal((await sourceUsers(id)).length, 1);
});

test("a failed temporary-file write leaves the source active and creates no successor", async (t) => {
    const id = await source();
    const count = app.sessions().length;
    const envFor = app.envFor.bind(app);

    t.mock.method(app, "envFor", (...args: Parameters<App["envFor"]>) => {
        const env = envFor(...args);

        return new Proxy(env, {
            get(target, name) {
                if (name === "writeFile") {
                    return async (path: string) => {
                        handoffDirectories.add(dirname(path));

                        return err(
                            new FileError(
                                "permission_denied",
                                "Fixture handoff write denied",
                                path,
                            ),
                        );
                    };
                }

                const value = Reflect.get(target, name, target);

                return typeof value === "function" ? value.bind(target) : value;
            },
        });
    });
    const { scenario } = await run(id, "/handoff researcher File writing must succeed first.", [
        start(),
    ]);

    assert.equal(scenario.results[0]?.isError, true);
    assert.match(scenario.results[0]?.text ?? "", /Fixture handoff write denied/);
    assert.equal(app.sessions().length, count);
    assert.equal((await records(id)).length, 0);
    assert.equal(app.workItems.isReadOnly(id), false);
});

test("losing the file after transfer does not let optional naming suppress the successor prompt", async (t) => {
    const id = await source();
    const envFor = app.envFor.bind(app);

    t.mock.method(app, "envFor", (...args: Parameters<App["envFor"]>) => {
        const env = envFor(...args);

        if (args[0] === id) {
            return env;
        }

        return new Proxy(env, {
            get(target, name) {
                if (name === "readTextFile") {
                    return async (...args: Parameters<typeof target.readTextFile>) => {
                        handoffDirectories.add(dirname(args[0]));
                        rmSync(args[0], { force: true });

                        return target.readTextFile(...args);
                    };
                }

                const value = Reflect.get(target, name, target);

                return typeof value === "function" ? value.bind(target) : value;
            },
        });
    });
    const { scenario } = await run(id, "/handoff researcher Report a missing file honestly.", [
        start(),
    ]);

    assert.equal(
        scenario.results[0]?.isError,
        false,
        scenario.results[0]?.text ?? "No tool result",
    );
    const [record] = await records(id);

    await until(
        async () =>
            (await records(id))[0]?.delivery !== "pending" &&
            !app.isBusy(cid(record!.targetThreadId)),
        "delivery settles after file loss",
    );
    assert.equal(
        (await records(id))[0]!.delivery,
        "delivered",
        "optional naming cannot block the read instruction",
    );
    assert.ok(
        JSON.stringify((await sourceUsers(cid(record!.targetThreadId)))[0]!.model).includes(
            record!.file!,
        ),
    );
    assert.equal(
        courierReads.get(record!.file!)?.isError,
        true,
        "the existing read tool reports the real missing file",
    );
});

test("SSH handoffs write and read the Markdown in the target temporary directory", async () => {
    const host = "fixture-handoff-host";
    const ssh = await sshFixture(host);
    const remote = await openApp(model, join(ssh.root, "app"));

    try {
        const { id } = await remote.commands.createSession(owner(remote), {
            cwd: ssh.root,
            location: { kind: "ssh", host },
            threadType: "worker",
        });

        await remote.commands.configure(id, owner(remote), {
            model: { provider: "faux", modelId: "faux-1" },
            thinkingLevel: "off",
        });
        const body = "/handoff researcher Keep this on the SSH target.";
        const scenario = script(body, [start()]);

        await say(remote, id, body);
        assert.equal(
            scenario.results[0]?.isError,
            false,
            scenario.results[0]?.text ?? "No tool result",
        );
        const record = Object.values(
            (await remote.harness.snapshot(HandoffsDoc, context))!.handoffs,
        ).find((each) => each.sourceThreadId === Number(id))!;

        assert.ok(record.file);
        handoffDirectories.add(dirname(record.file));
        assert.match(record.file, /^\/tmp\/pi-coop-handoff-[^/]+\/handoff\.md$/);
        assert.equal(remote.locationOf(cid(record.targetThreadId))?.host, host);
        await until(async () => {
            const saved = (await remote.harness.snapshot(HandoffsDoc, context))?.handoffs[
                record.id
            ];

            return saved?.delivery === "delivered" && !remote.isBusy(cid(record.targetThreadId));
        }, "remote successor reads the handoff");
        assert.equal(courierReads.get(record.file)?.isError, false);
        assert.ok(courierReads.get(record.file)?.text.includes("Keep this on the SSH target."));
        const packets = readFileSync(join(ssh.root, "packets"), "utf8").trim().split("\n");

        assert.ok(packets.includes("14"), "the directory was created over SFTP");
        assert.ok(
            packets.includes("6"),
            "the Markdown bytes were written over SFTP, not host fallback",
        );
    } finally {
        await remote.close();
        await ssh.close();
    }
});

// Explicit target/relationship come from actual persisted input, never the model's summary or tool arguments.
test("explicit route mismatches and malformed route prefixes refuse without reserving a receipt", async () => {
    for (const [body, call, expected] of [
        ["/handoff researcher Target must not change.", start("pull"), /explicit \/handoff route/],
        [
            "/handoff removed:Agent A missing profile must never become freeform direction.",
            start(),
            /explicit \/handoff route/,
        ],
        [
            "/handoff removed:Agent Keep the unavailable destination pinned.",
            start("removed:Agent"),
            /current thread state/,
        ],
        [
            "/handoff land This role is unavailable from the current state.",
            start("land"),
            /current thread state/,
        ],
        [
            "/handoff researcher --new Relationship must not change.",
            start(),
            /explicit \/handoff route/,
        ],
        ["/handoff --other researcher Invalid leading flag.", start(), /relationship flag/],
        ["/handoff researcher --same --new Conflicting flags.", start(), /flags must precede/],
    ] as const) {
        const id = await source();
        const { scenario } = await run(id, body, [call]);

        assert.equal(scenario.results[0]!.isError, true);
        assert.match(scenario.results[0]!.text, expected);
        assert.equal((await records(id)).length, 0);
        assert.equal(app.workItems.isReadOnly(id), false);
    }
});

test("the handoff tool accepts a registered maximum-length namespaced destination", async () => {
    const module = "m".repeat(64);
    const from = `${module}:source`;
    const target = `${module}:${"t".repeat(64)}`;
    const definition = {
        id: `${module}:flow`,
        profiles: [from, target].map((id) => ({
            id,
            name: id === from ? "Source" : "Destination",
            description: "Bounded custom role",
            prompt: "Perform only the explicitly requested task.",
            title: "Custom task",
            starter: true,
        })),
        transitions: [{ from, to: target, relationship: "same-work" }],
    };
    const folder = join(data, "extensions");

    mkdirSync(folder, { recursive: true });
    writeFileSync(
        join(folder, `${module}.ts`),
        `/** Long profile identifiers. */\nexport default (_host, web) => { web.workflow(${JSON.stringify(definition)}); };`,
    );
    await app.setExtensionEnabled(owner(app), `${module}.ts`, true);

    try {
        const id = await source(from);
        const { scenario } = await run(id, `/handoff ${target} Continue this bounded task.`, [
            start(target),
        ]);

        assert.equal(scenario.results[0]!.isError, false, scenario.results[0]!.text);
        const [receipt] = await records(id);

        assert.equal(receipt!.targetType, target);
        assert.equal(app.workItems.isReadOnly(id), true);
    } finally {
        await app.setExtensionEnabled(owner(app), `${module}.ts`, false);
    }
});

// Courier and scheduler submissions carry attribution but were not written by a human in this run.
test("courier-only and scheduled runs cannot autonomously start a successor", async () => {
    const id = await source();
    const { scenario } = await run(id, "/handoff researcher TRY_COURIER_CHAIN", [start()]);

    assert.equal(scenario.results[0]!.isError, false);
    const [record] = await records(id);
    const next = cid(record!.targetThreadId);

    await delivered(next);
    assert.equal(courierResults.at(-1)!.isError, true);
    assert.match(courierResults.at(-1)!.text, /written human input/);
    assert.equal((await records(next)).length, 0);
    const scheduled = await source();

    await say(app, scheduled, "An earlier real human task has already finished.");
    const body = "Scheduled handoff to a researcher, not an actual human input";
    const scheduledScenario = script(body, [start()]);
    const submission = await (
        await app.conversation(scheduled)
    ).submit(
        {
            type: "input",
            content: app.commands.messageText(owner(app), body),
            requestId: requestFor(owner(app).id, "scheduled-handoff"),
        },
        context,
    );

    await submission.wait(context);
    assert.equal(scheduledScenario.results[0]!.isError, true);
    assert.match(scheduledScenario.results[0]!.text, /written human input/);
    assert.equal((await records(scheduled)).length, 0);
});

test("human-created schedules cannot grant handoff authority through their ownRequest attribution", async () => {
    const scheduledData = join(root, "human-scheduled-handoff");
    let now = Date.now();
    let scheduledApp = await openApp(model, scheduledData, () => now);
    const person = owner(scheduledApp);
    const { id } = await scheduledApp.commands.createSession(person, {
        cwd: work,
        threadType: "worker",
        title: "Scheduled input is not fresh authority",
    });

    await scheduledApp.commands.configure(id, person, {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });
    const body = "Please hand this scheduled task to a researcher.";
    const scenario = script(`[scheduled] ${body}`, [start()]);
    const schedule = await scheduledApp.schedules.add(id, {
        when: "in 1m",
        text: body,
        zone: "UTC",
        by: person,
    });

    try {
        await scheduledApp.close();
        now += 61_000;
        scheduledApp = await openApp(model, scheduledData, () => now);
        await until(
            () => scenario.results.length > 0 && !scheduledApp.isBusy(id),
            "actual human schedule delivery settles",
        );
        assert.equal(scenario.results[0]!.isError, true, scenario.results[0]!.text);
        assert.match(scenario.results[0]!.text, /written human input/);
        const doc = await scheduledApp.harness.snapshot(HandoffsDoc, context);

        assert.equal(
            Object.values(doc?.handoffs ?? {}).some(
                (record) => record.sourceThreadId === Number(id),
            ),
            false,
        );
        assert.equal(scheduledApp.workItems.isReadOnly(id), false);
        const sent = await scheduledApp.harness.commit(
            (tx) => tx.submissionByRequest(id, `u:${person.id}:schedule-${schedule.taskId}-0`),
            context,
        );

        assert.ok(sent, "the real schedule sent with its human-attributed reserved request origin");
    } finally {
        await scheduledApp.close();
    }
});

// The tool's late transaction rechecks real graph state and authorization, not a prior status answer.
test("busy delegated writers block tool activation without stopping their work", async () => {
    const id = await source();

    helperGate = gate();

    try {
        await say(app, id, "Delegate a helper before a later handoff");
        const child = (await app.harness.snapshot(SubagentsDoc, id, context))!.agents.writer!
            .conversationId;

        await until(() => helperResults.length > 0, "delegated helper's handoff refusal");
        assert.equal(helperResults.at(-1)!.isError, true);
        assert.match(helperResults.at(-1)!.text, /main thread/);
        assert.equal(app.isBusy(child), true);
        const { scenario } = await run(id, "/handoff researcher Helpers must finish first.", [
            { action: "status" },
            start(),
        ]);
        const status = JSON.parse(scenario.results[0]!.text);

        assert.ok(status.options.every((option: { enabled: boolean }) => !option.enabled));
        assert.equal(scenario.results[1]!.isError, true);
        assert.match(scenario.results[1]!.text, /delegated helpers|background tasks/);
        assert.equal((await records(id)).length, 0);
        assert.equal(app.isBusy(child), true);
    } finally {
        helperGate.release();
        helperGate = undefined;
    }

    await until(async () => {
        try {
            await app.harness.commit((tx) => app.workItems.requireIdle(tx, id), context);

            return true;
        } catch {
            return false;
        }
    }, "delegated helper and report settle");
});

test("tool transfer rechecks driver, archive, uncertainty, writer reservations and whole-item privacy", async () => {
    for (const mode of ["driver", "archive", "uncertain", "writer"] as const) {
        const id = await source();
        const body = `/handoff researcher Recheck ${mode} before transfer.`;
        const hold = gate();
        const scenario = script(body, [start()], hold);
        const accepted = await app.commands.submit(id, owner(app), {
            text: body,
            requestId: crypto.randomUUID(),
        });

        await until(() => scenario.entered, "model ready to request transfer");

        let release = () => {};

        if (mode === "writer") {
            release = reserveWorkflowLocalWrite(app, id);
        } else {
            await app.harness.commit(async (tx) => {
                if (mode === "driver") {
                    const turns = await tx.doc(TurnsDoc, id);

                    turns.on = true;
                    turns.driver = "another-person";
                } else if (mode === "archive") {
                    (await tx.doc(SessionsDoc)).items[String(id)]!.archived = true;
                } else {
                    (await tx.doc(PublicationsDoc, id)).receipts.uncertain = {
                        id: "uncertain",
                        command: ["git", "push", "origin", "HEAD:topic"],
                        cwd: work,
                        fingerprint: "historical",
                        requester: owner(app).id,
                        approver: owner(app).id,
                        approvedAt: 1,
                        reason: "Uncertain external effect",
                        state: "executing",
                    };
                }
            }, context);
        }

        try {
            hold.release();
            await (await app.harness.submission(accepted.submissionId, context))!.wait(context);
            assert.equal(scenario.results[0]!.isError, true);
            const expected = {
                driver: /wheel/,
                archive: /Restore/,
                uncertain: /Reconcile uncertain publication/,
                writer: /Local workflow writes/,
            }[mode];

            assert.match(scenario.results[0]!.text, expected);
            assert.equal((await records(id)).length, 0);
        } finally {
            release();
        }
    }

    const origin = await source();

    await run(origin, "/handoff researcher Establish a shared work item.", [start()]);
    const next = cid((await records(origin))[0]!.targetThreadId);

    await delivered(next);
    const guest = app.config.addUser("Only current member", "guest", [String(next)]).user;
    const body = "/handoff worker I cannot see the predecessor.";
    const scenario = script(body, [start("worker")]);
    const accepted = await app.commands.submit(next, guest, {
        text: body,
        requestId: crypto.randomUUID(),
    });

    await (await app.harness.submission(accepted.submissionId, context))!.wait(context);
    assert.equal(scenario.results[0]!.isError, true);
    assert.match(scenario.results[0]!.text, /work item is not shared/);
    assert.equal((await records(next)).length, 0);
});

test("Review activation reads the current diff again rather than trusting an earlier status", async (t) => {
    let reads = 0;

    t.mock.method(app.workspace, "changes", async () => {
        reads++;

        return reads === 1 ? changed : { files: [], piOnly: [], more: 0 };
    });
    const id = await source();
    const { scenario } = await run(
        id,
        "/handoff review Check the current diff, not the old status.",
        [{ action: "status" }, start("reviewer")],
    );
    const status = JSON.parse(scenario.results[0]!.text);

    assert.equal(
        status.options.find((option: { targetType: string }) => option.targetType === "reviewer")
            .enabled,
        true,
    );
    assert.equal(scenario.results[1]!.isError, true);
    assert.match(scenario.results[1]!.text, /no current Pi diff/);
    assert.equal((await records(id)).length, 0);
    assert.equal(app.workItems.isReadOnly(id), false);
});

test("the final Review diff inspection holds the writer lock and rechecks revoked steering rights", async (t) => {
    const id = await source();
    const guest = app.config.addUser("Current requester", "guest").user;
    const hold = gate();
    let inspecting = false;

    t.mock.method(app.workspace, "changes", async () => {
        inspecting = true;
        await hold.promise;

        return changed;
    });
    const body = "/handoff review Inspect the actual current diff.";
    const scenario = script(body, [start("reviewer")]);
    const accepted = await app.commands.submit(id, guest, {
        text: body,
        requestId: crypto.randomUUID(),
    });

    try {
        await until(() => inspecting, "late Review diff inspection");
        const write = await app
            .envFor(id)
            .writeFile("must-not-race-transfer.txt", "forbidden", context);

        assert.equal(write.ok, false, "new writes cannot enter while the transfer holds its lock");
        app.config.updateUser(guest.id, { role: "viewer" });
        hold.release();
        await (await app.harness.submission(accepted.submissionId, context))!.wait(context);
        assert.equal(scenario.results[0]!.isError, true);
        assert.match(scenario.results[0]!.text, /not steer/);
        assert.equal((await records(id)).length, 0);
        assert.equal(app.workItems.isReadOnly(id), false);
    } finally {
        hold.release();
    }
});
