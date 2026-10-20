// Real registered tools, Durable ownership and temporary Git checkouts own Reviewer publication.
// Faux responses choose calls; they do not fabricate author identities, receipts, task ancestry or review anchors.
import {
    type App,
    cleanUp,
    context,
    executeHandoff,
    lastText,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { awaitWithContext } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type {
    ConversationId,
    EntryId,
    JsonObject,
    SubmissionId,
    TaskId,
} from "@earendil-works/pi-durable";
import {
    PipReviewCommentsDoc,
    SessionsDoc,
    SubagentsDoc,
    type PipDiffComment,
} from "../src/server/docs.ts";
import { HttpError } from "../src/server/errors.ts";
import { HandoffsDoc, type ThreadType } from "../src/server/workflow-docs.ts";

const OLD = ["first", "old alpha", "old interior", "old omega", "fifth", "sixth"];
const NEW = ["first", "new alpha", "new interior", "new omega", "fifth", "sixth"];
const PATH = "code.txt";
const data = join(root, "pip-reviewer-data");
let app: App;

type Result = { callId: string; name: string; text: string; isError: boolean; details?: unknown };
type Decision = ReturnType<typeof fauxToolCall> | string;
type Step = Decision | ((scenario: Scenario) => Decision | Promise<Decision>);
type Scenario = { body: string; steps: Step[]; requests: number; results: Result[] };
const scenarios = new Map<string, Scenario>();
const stripAuthor = (text: string) => text.replace(/^\[from:[^\]]+\]\s*/, "");
const model = scriptedModel(async (input) => {
    const user = input.messages.findLast((message) => message.role === "user");
    const body = user === undefined ? "" : stripAuthor(lastText({ messages: [user] }).text);
    const scenario = [...scenarios.values()].find((candidate) => body.includes(candidate.body));

    if (scenario === undefined) {
        return fauxAssistantMessage("Disposable setup received.");
    }

    const last = input.messages.findLast((message) => message.role !== "system");

    if (last?.role === "toolResult") {
        scenario.results.push({
            callId: last.toolCallId,
            name: last.toolName,
            text: last.content
                .flatMap((part) => (part.type === "text" ? [part.text] : []))
                .join("\n"),
            isError: last.isError === true,
            ...(last.details === undefined ? {} : { details: last.details }),
        });
    }

    const next = scenario.steps[scenario.requests++];

    assert.notEqual(next, undefined, "the real runtime requested no unexpected extra generation");
    const decision = typeof next === "function" ? await next(scenario) : next!;

    const answer =
        typeof decision === "string"
            ? fauxAssistantMessage(decision)
            : fauxAssistantMessage([decision], { stopReason: "toolUse" });

    return Object.assign(answer, {
        // Structurally valid claims on both tool rounds and final answers must be cleared by core.
        pocketDiffComments: [
            {
                conversationId: 1,
                threadId: "fabricated-provider-reference",
                commentId: "fabricated-provider-comment",
                path: PATH,
                side: "new",
                line: 2,
                text: "Provider output is not a successful publication receipt.",
            },
        ],
    });
});

before(async () => {
    app = await openApp(model, data);
});
after(async () => {
    await app?.close();
    cleanUp();
});

function git(cwd: string, ...args: string[]): void {
    execFileSync("git", ["-c", "core.fsmonitor=false", ...args], {
        cwd,
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
        stdio: "pipe",
    });
}

async function scene(kind: ThreadType = "reviewer") {
    const cwd = realpathSync(mkdtempSync(join(root, "pip-reviewer-checkout-")));

    git(cwd, "init", "-q");
    writeFileSync(join(cwd, PATH), `${OLD.join("\n")}\n`);
    git(cwd, "add", ".");
    git(
        cwd,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-qm",
        "baseline",
    );
    const { id: source } = await app.commands.createSession(owner(app), {
        cwd,
        threadType: kind === "reviewer" ? "worker" : kind,
        title: "PiP Reviewer fixture",
    });

    await app.commands.configure(source, owner(app), {
        model: { provider: "faux", modelId: "faux-2" },
        thinkingLevel: "off",
    });
    const implemented = await run(source, [
        fauxToolCall("write", { path: PATH, content: `${NEW.join("\n")}\n` }),
        "The disposable implementation is ready for independent review.",
    ]);

    assert.equal(
        implemented.scenario.results[0]?.isError,
        false,
        implemented.scenario.results[0]?.text ?? "the actual fixture write must succeed",
    );
    assert.equal(readFileSync(join(cwd, PATH), "utf8"), `${NEW.join("\n")}\n`);
    let id = source;

    if (kind === "reviewer") {
        const changes = await app.workspace.changes(source, owner(app));

        assert.ok(
            changes.files.some((file) => file.path === PATH),
            JSON.stringify(changes),
        );
        id = (await executeHandoff(app, source, "reviewer")).id as ConversationId;
        await until(async () => {
            const records = (await app.harness.snapshot(HandoffsDoc, context))?.handoffs ?? {};
            const incoming = Object.values(records).find(
                (record) => record.targetThreadId === Number(id),
            );

            return incoming?.delivery === "delivered" && !app.isBusy(id);
        }, "the real Reviewer courier and setup run to settle");
    }

    return { id, source, cwd };
}

function script(steps: Step[]): Scenario {
    const scenario: Scenario = {
        body: `PIP_REVIEWER_SCENARIO_${crypto.randomUUID()}`,
        steps,
        requests: 0,
        results: [],
    };

    scenarios.set(scenario.body, scenario);

    return scenario;
}

async function submit(id: ConversationId, scenario: Scenario, user = owner(app)) {
    const submitted = await app.commands.submit(id, user, {
        text: scenario.body,
        requestId: crypto.randomUUID(),
    });

    return { ...submitted, wait: () => wait(id, submitted.submissionId) };
}

async function wait(id: ConversationId, submissionId: SubmissionId): Promise<void> {
    const submission = await app.harness.submission(submissionId, context);

    assert.ok(submission);
    await submission.wait(context);
    await until(() => !app.isBusy(id), "the scripted Reviewer episode to settle");
}

async function run(id: ConversationId, steps: Step[], user = owner(app)) {
    const scenario = script(steps);
    const submitted = await submit(id, scenario, user);

    await submitted.wait();

    return { scenario, submissionId: submitted.submissionId };
}

function inspect(): Decision {
    return fauxToolCall("review_comment", { action: "inspect", path: PATH });
}

function inspected(scenario: Scenario): string {
    const result = scenario.results.find(
        (result) => result.name === "review_comment" && !result.isError,
    );

    assert.ok(result, "the actual inspect tool succeeded");
    const parsed = JSON.parse(result.text) as { observation: string; diff: string };

    assert.match(parsed.observation, /^[0-9a-f]{64}$/);
    assert.ok(parsed.diff.includes("-old interior"));
    assert.ok(parsed.diff.includes("+new interior"));

    return parsed.observation;
}

function post(observation: string, extra: JsonObject = {}): Decision {
    return fauxToolCall("review_comment", {
        action: "post",
        path: PATH,
        observation,
        side: "new",
        line: 4,
        startLine: 2,
        context: NEW.slice(1, 4).join("\n"),
        text: "The middle line must be validated as part of the whole range.",
        ...extra,
    });
}

async function receipts(id: ConversationId) {
    return Object.values(
        (await app.harness.snapshot(PipReviewCommentsDoc, id, context))?.receipts ?? {},
    );
}

async function final(id: ConversationId) {
    const entry = (await app.transcripts.allEntries(id, true)).findLast(
        (entry) => entry.kind === "assistant",
    );

    assert.ok(entry?.kind === "assistant");

    return entry;
}

function gate() {
    let release = () => {};

    const promise = new Promise<void>((resolve) => {
        release = resolve;
    });

    return { promise, release };
}

// This is the owner of publication/episode membership: successful native results, not generated prose or all PiP history.
test(
    "registered Reviewer calls publish complete ranges, preserve actual model provenance and attach only this episode's successes",
    { timeout: 30_000 },
    async () => {
        app.pip.configureCollaborator(owner(app), {
            model: { provider: "faux", modelId: "faux-1" },
            thinkingLevel: "off",
            expectedRevision: app.config.pipCollaborator?.revision ?? 0,
        });
        const { id } = await scene();
        const longFinding =
            "This finding is intentionally longer than its native assessment excerpt. ".repeat(8);
        const { scenario, submissionId } = await run(id, [
            inspect(),
            (s) => post(inspected(s), { text: longFinding }),
            (s) =>
                post(inspected(s), {
                    context: "new alpha\nWRONG INTERIOR\nnew omega",
                    text: "Must not publish",
                }),
            (s) =>
                post(inspected(s), {
                    side: "old",
                    line: 3,
                    startLine: 3,
                    context: OLD[2]!,
                    text: "Old-side finding",
                }),
            "Assessment with the successfully posted findings.",
        ]);

        assert.equal(
            scenario.requests,
            5,
            "inspect + three posts + one assessment; no extra PiP generation",
        );
        assert.deepEqual(
            scenario.results.map((result) => result.isError),
            [false, false, true, false],
        );
        assert.match(scenario.results[2]!.text, /complete finding context does not match/i);
        const saved = await receipts(id);

        assert.equal(saved.length, 2);
        assert.ok(saved.every((receipt) => receipt.episode === Number(submissionId)));
        assert.ok(
            saved.every(
                (receipt) =>
                    receipt.origin.provider === "faux" && receipt.origin.model === "faux-2",
            ),
        );
        assert.ok(saved.every((receipt) => receipt.origin.requesterId === owner(app).id));
        assert.ok(saved.every((receipt) => receipt.origin.role === "reviewer"));
        const threads = (await app.reviews.list(id, owner(app))).threads;

        assert.equal(threads.length, 2);
        assert.deepEqual(
            threads.map(({ userId, name, service }) => ({ userId, name, service })),
            [
                { userId: "pip", name: "PiP", service: "pip" },
                { userId: "pip", name: "PiP", service: "pip" },
            ],
        );
        assert.equal(threads[0]!.context, NEW.slice(1, 4).join("\n"));
        assert.equal(threads[0]!.startLine, 2);
        assert.equal(threads[0]!.line, 4);

        for (const receipt of saved) {
            await app.harness.commit(async (tx) => {
                const task = await tx.task(receipt.origin.taskId as TaskId);

                assert.ok(task?.kind === "pi.tool");
                const assistant = await tx.entry(
                    (task.input as { assistant: number }).assistant as EntryId,
                );

                assert.equal(Number(assistant?.byTaskId), receipt.origin.generationId);
                assert.equal(assistant?.model?.[0]?.role, "assistant");
                assert.equal(Number(assistant?.conversationId), Number(id));
                const source = assistant?.model?.[0];

                assert.ok(source?.role === "assistant");
                assert.equal(source.provider, receipt.origin.provider);
                assert.equal(source.model, receipt.origin.model);
            }, context);
        }

        const published = scenario.results
            .filter((result) => result.name === "review_comment" && !result.isError)
            .slice(1);
        const refs = published.map(
            (result) => (result.details as { pipDiffComment: PipDiffComment }).pipDiffComment,
        );

        assert.deepEqual(
            refs.map((ref) => ref.commentId).sort(),
            saved.map((receipt) => receipt.commentId).sort(),
        );
        assert.equal(refs[0]!.text, longFinding.trim(), "tool receipt keeps the full finding");
        const assessment = await final(id);

        assert.deepEqual(
            assessment.diffComments?.map((ref) => ref.commentId).sort(),
            refs.map((ref) => ref.commentId).sort(),
        );
        assert.equal(
            assessment.diffComments?.find((ref) => ref.commentId === refs[0]!.commentId)?.text,
            longFinding.slice(0, 280),
        );
        const catalogue = await app.harness.snapshot(SessionsDoc, context);

        assert.equal(
            Object.values(catalogue?.items ?? {}).some((session) => session.pip !== undefined),
            false,
            "publication never creates the private assistant",
        );

        const later = await run(id, [
            "A later independent answer contains no fabricated or earlier finding list.",
        ]);

        assert.equal(later.scenario.requests, 1);
        assert.equal((await final(id)).diffComments, undefined);
        assert.equal(
            (await receipts(id)).length,
            2,
            "older successful receipts remain durable but are not relabelled as this episode",
        );
    },
);

// The observation is a state check: knowing an earlier token is not authority to publish against changed code.
test(
    "a real checkout edit makes an inspection stale and publishes neither comment nor native reference",
    { timeout: 30_000 },
    async () => {
        const { id, cwd } = await scene();
        const { scenario } = await run(id, [
            inspect(),
            (s) => {
                writeFileSync(
                    join(cwd, PATH),
                    `${NEW.map((line, at) => (at === 2 ? "externally changed interior" : line)).join("\n")}\n`,
                );

                return post(inspected(s));
            },
            "The file changed; no finding was posted.",
        ]);

        assert.equal(scenario.results[1]!.isError, true);
        assert.match(scenario.results[1]!.text, /observation is stale/i);
        assert.equal((await receipts(id)).length, 0);
        assert.equal((await app.reviews.list(id, owner(app))).threads.length, 0);
        assert.equal((await final(id)).diffComments, undefined);
    },
);

// Optional presentation hooks cannot be the authority for an application-owned service post.
test(
    "native PiP pause and retained Plan state prevent fresh posts without creating private chat",
    { timeout: 30_000 },
    async () => {
        const { id } = await scene();
        const observed = await run(id, [inspect(), "Inspection only."]);
        const observation = inspected(observed.scenario);

        try {
            await app.setPipEnabled(owner(app), false);
            const paused = await run(id, [post(observation), "PiP publication is paused."]);

            assert.equal(paused.scenario.results[0]!.isError, true);
            assert.match(paused.scenario.results[0]!.text, /PiP is paused/i);
            assert.equal((await final(id)).diffComments, undefined);
            await app.setPipEnabled(owner(app), true);
            await app.commands.setPlan(id, owner(app), true);
            await app.setExtensionEnabled(owner(app), "plan.ts", false);
            const planned = await run(id, [
                post(observation),
                "Plan mode does not authorize changing discussion.",
            ]);

            assert.equal(planned.scenario.results[0]!.isError, true);
            assert.match(planned.scenario.results[0]!.text, /Plan mode is on/i);
            assert.equal((await final(id)).diffComments, undefined);
            assert.equal((await receipts(id)).length, 0);
            assert.equal((await app.reviews.list(id, owner(app))).threads.length, 0);
            const catalogue = await app.harness.snapshot(SessionsDoc, context);

            assert.equal(
                Object.values(catalogue?.items ?? {}).some((session) => session.pip !== undefined),
                false,
            );
        } finally {
            await app.setPipEnabled(owner(app), true);
            await app.setExtensionEnabled(owner(app), "plan.ts", true);
            await app.commands.setPlan(id, owner(app), false);
        }
    },
);

// Real registration is not itself authority. Chat crosses the tool's runtime guard; Worker crosses mandatory policy.
test(
    "registered tool refuses unrelated Chat and Worker invocations",
    { timeout: 30_000 },
    async () => {
        for (const kind of ["chat", "worker"] as const) {
            const { id } = await scene(kind);
            const { scenario } = await run(id, [
                inspect(),
                "Only the real main Reviewer can publish findings.",
            ]);

            assert.equal(scenario.results[0]!.isError, true, kind);
            assert.match(scenario.results[0]!.text, /Only the active main Reviewer/i);
            assert.equal((await receipts(id)).length, 0);
            assert.equal((await app.reviews.list(id, owner(app))).threads.length, 0);
            assert.equal((await final(id)).diffComments, undefined);
            const toolAnswer = (await app.transcripts.allEntries(id, true)).findLast(
                (entry) => entry.kind === "assistant" && entry.stopReason === "toolUse",
            );

            assert.ok(toolAnswer?.kind === "assistant");
            assert.equal(
                toolAnswer.diffComments,
                undefined,
                "tool rounds cannot carry provider claims either",
            );
        }
    },
);

// Inheriting Reviewer's tools/profile does not confer the main thread's publication authority.
test(
    "a real Reviewer's delegated helper cannot post, while main-thread codemode retains distinct call receipts",
    { timeout: 30_000 },
    async () => {
        const { id } = await scene();
        const helper = script([inspect(), "The helper cannot publish as the main Reviewer."]);

        await run(id, [
            fauxToolCall("subagent", {
                action: "spawn",
                name: "reviewer-helper",
                message: helper.body,
            }),
            "Wait for the helper's independent report.",
        ]);
        await until(async () => {
            const state = await app.harness.snapshot(SubagentsDoc, id, context);
            const record = state?.agents["reviewer-helper"];

            return (
                record !== undefined &&
                record.reported.length > 0 &&
                !app.isBusy(id) &&
                !app.isBusy(record.conversationId)
            );
        }, "the real helper report and parent run to settle");
        await until(async () => {
            try {
                await app.harness.commit((tx) => app.workItems.requireIdle(tx, id), context);

                return true;
            } catch (error) {
                if (error instanceof HttpError && error.status === 409) {
                    return false;
                }

                throw error;
            }
        }, "all real helper reporters and couriers to settle before the next episode");
        const helperRecord = (await app.harness.snapshot(SubagentsDoc, id, context))!.agents[
            "reviewer-helper"
        ]!;

        assert.equal(app.rootOf(helperRecord.conversationId), id);
        assert.equal(helper.results[0]!.isError, true);
        assert.match(helper.results[0]!.text, /Only the active main Reviewer/i);
        assert.equal((await receipts(helperRecord.conversationId)).length, 0);
        assert.equal((await receipts(id)).length, 0);
        const nested = await run(id, [
            fauxToolCall("codemode", {
                code: `const inspected = JSON.parse(await tools.review_comment({action:"inspect",path:${JSON.stringify(PATH)}})); const finding = {action:"post",path:${JSON.stringify(PATH)},observation:inspected.observation,side:"new",startLine:2,line:4,context:${JSON.stringify(NEW.slice(1, 4).join("\n"))},text:"Nested first finding"}; text(await tools.review_comment(finding)); text(await tools.review_comment({...finding,text:"Nested second finding"}));`,
            }),
            "The main Reviewer posted two distinct nested findings.",
        ]);

        assert.equal(
            nested.scenario.requests,
            2,
            "one codemode request and one assessment, with no collaborator generation",
        );
        assert.equal(nested.scenario.results[0]!.isError, false, nested.scenario.results[0]!.text);
        const saved = await receipts(id);

        assert.equal(saved.length, 2);
        assert.equal(saved[0]!.origin.taskId, saved[1]!.origin.taskId);
        assert.notEqual(saved[0]!.origin.callId, saved[1]!.origin.callId);
        assert.ok(saved.every((receipt) => /\/[23]$/.test(receipt.origin.callId)));
        assert.equal((await final(id)).diffComments?.length, 2);
    },
);

// The operation has already crossed a real scoped diff read when authority changes; no fake backend supplies evidence.
test(
    "held publication excludes workflow transfer and local writes, then rejects revoked current steering",
    { timeout: 30_000 },
    async (t) => {
        const { id, cwd } = await scene();
        const guest = app.config.addUser("Current Reviewer requester", "guest").user;
        const hold = gate();
        let entered = false;
        let reads = 0;
        const diff = app.reviews.diff.bind(app.reviews);

        t.mock.method(app.reviews, "diff", async (...args: Parameters<typeof diff>) => {
            const patch = await diff(...args);

            if (args[0] === id && ++reads === 2) {
                entered = true;
                await awaitWithContext(hold.promise, args[3] ?? context);
            }

            return patch;
        });
        const scenario = script([
            inspect(),
            (s) => post(inspected(s)),
            "Steering changed; no comment was posted.",
        ]);
        const submitted = await submit(id, scenario, guest);

        try {
            await until(
                () => entered,
                "the actual scoped post diff read to complete while its reservation stays held",
            );
            const write = await app
                .envFor(id)
                .writeFile("must-not-race-review.txt", "not allowed", context);

            assert.equal(write.ok, false);

            if (!write.ok) {
                assert.match(write.error.message, /Publication is executing/i);
            }

            const choices = await app.workItems.list(id, owner(app));

            assert.ok(choices.options.length > 0);
            assert.ok(
                choices.options.every(
                    (choice) =>
                        !choice.enabled && /publication is executing/i.test(choice.reason ?? ""),
                ),
                "handoff discovery sees the same exclusive reservation, rather than only a busy run",
            );
            app.setAccess(owner(app), guest.id, { role: "viewer" });
            hold.release();
            await submitted.wait();
            assert.equal(scenario.results[1]!.isError, true);
            assert.match(scenario.results[1]!.text, /steer|authority|requester/i);
            assert.equal((await receipts(id)).length, 0);
            assert.equal((await app.reviews.list(id, owner(app))).threads.length, 0);
            assert.equal(readFileSync(join(cwd, PATH), "utf8"), `${NEW.join("\n")}\n`);
            assert.equal((await final(id)).diffComments, undefined);
        } finally {
            hold.release();
            t.mock.restoreAll();
        }
    },
);

// A lost tool return is not a lost comment. Recovery returns the committed IDs even after the checkout changes.
test(
    "safe replay recovers the exact committed finding after restart and before tool-result settlement",
    { timeout: 30_000 },
    async (t) => {
        const { id, cwd } = await scene();
        const hold = gate();
        const tool = app.pip.reviewTool;
        const execute = tool.execute.bind(tool);
        let committed = false;

        t.mock.method(tool, "execute", async (...args: Parameters<typeof execute>) => {
            const result = await execute(...args);

            if (args[0].action === "post") {
                committed = true;
                await awaitWithContext(hold.promise, args[2]);
            }

            return result;
        });
        const scenario = script([
            inspect(),
            (s) => post(inspected(s)),
            "Assessment after exact receipt recovery.",
        ]);
        const submitted = await submit(id, scenario);

        try {
            await until(
                () => committed,
                "the real comment and receipt commit before its intercepted tool response",
            );
            const before = await receipts(id);

            assert.equal(before.length, 1);
            assert.equal((await app.reviews.list(id, owner(app))).threads.length, 1);
            await app.close();
            hold.release();
            t.mock.restoreAll();
            writeFileSync(
                join(cwd, PATH),
                "different checkout contents after the committed publication\n",
            );
            app = await openApp(model, data);
            await wait(id, submitted.submissionId);
            const after = await receipts(id);

            assert.deepEqual(
                after,
                before,
                "safe replay returns the original receipt, not a fresh destination or anchor",
            );
            assert.equal((await app.reviews.list(id, owner(app))).threads.length, 1);
            assert.equal(scenario.results[1]!.isError, false, scenario.results[1]!.text);
            const result = JSON.parse(scenario.results[1]!.text) as PipDiffComment;

            assert.equal(result.threadId, before[0]!.threadId);
            assert.equal(result.commentId, before[0]!.commentId);
            assert.equal(result.conversationId, Number(id));
            assert.equal(
                scenario.requests,
                3,
                "restart replays the tool, not another model publication generation",
            );
            const assessment = await final(id);

            assert.equal(assessment.diffComments?.[0]?.commentId, before[0]!.commentId);
            const fork = await app.commands.fork(id, owner(app), { entryId: assessment.id });

            assert.deepEqual(
                await receipts(fork.id),
                [],
                "a real fork never inherits internal publication authority or receipts",
            );
            const inherited = await final(fork.id);

            assert.deepEqual(inherited.diffComments, assessment.diffComments);
            assert.equal(inherited.diffComments?.[0]?.conversationId, Number(id));
            assert.equal(inherited.diffComments?.[0]?.threadId, before[0]!.threadId);
        } finally {
            hold.release();
            t.mock.restoreAll();
        }
    },
);

// Private PiP deliberately omits pocket-core, so its own registration must clear provider claims too.
test("private PiP cannot project provider claims as native shared diff references", async () => {
    const id = await app.pip.ensure(owner(app));

    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "faux-2" },
        thinkingLevel: "off",
    });
    const { scenario } = await run(id, [
        fauxToolCall("sessions", {}),
        "A private answer does not publish shared findings.",
    ]);

    assert.equal(scenario.requests, 2);
    assert.equal(
        scenario.results[0]?.isError,
        false,
        scenario.results[0]?.text ?? "The private sessions tool must complete",
    );
    const answers = (await app.transcripts.allEntries(id, true)).filter(
        (entry) => entry.kind === "assistant",
    );

    assert.equal(answers.length, 2);
    assert.ok(answers.every((entry) => entry.diffComments === undefined));
});
