// The real app owns naming/task persistence; browser coverage owns the no-name creation form. These cases catch
// lost naming admissions, duplicate model spend on reopen, and AI responses overwriting a person's newer name.
import {
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
    type App,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { type TaskId, UsageDoc } from "@earendil-works/pi-durable";
import { ProjectsDoc } from "../src/server/docs.ts";
import { GOAL_NAME_PROMPT } from "../src/server/goal-names.ts";

const goalName = "Repair login flow";

after(cleanUp);

async function worker(app: App) {
    const { id: projectId } = await app.projects.create(owner(app), {
        name: "Login project",
        cwd: work,
        requestId: crypto.randomUUID(),
    });
    const { id } = await app.commands.createSession(owner(app), {
        projectId,
        newGoal: true,
        requestId: crypto.randomUUID(),
    });

    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });
    const goalId = app.sessionMeta(id)!.goalId!;

    return { id, goalId };
}

test("a new worker's first message names its goal once, survives reopen and records naming usage", async () => {
    let namingCalls = 0;

    const route: FauxResponseStep = (request) => {
        const naming = lastText(request as never).text.startsWith(GOAL_NAME_PROMPT);

        namingCalls += Number(naming);

        return fauxAssistantMessage([fauxText(naming ? `"${goalName}."` : "I will fix it.")]);
    };

    // A distinct small naming model separates its usage from the worker's ordinary answers.
    const model = fauxProvider({
        tokensPerSecond: 2000,
        models: [{ id: "faux-1" }, { id: "faux-mini" }],
    });

    model.setResponses(Array.from({ length: 10 }, () => route));
    const directory = join(root, "goal-name-once");
    let app = await openApp(model, directory);

    try {
        const { id, goalId } = await worker(app);

        assert.equal(
            app.projects.list(owner(app)).goals.find((goal) => goal.id === goalId)?.name,
            "New goal",
        );
        await say(app, id, "Fix login");
        await until(
            () =>
                app.projects.list(owner(app)).goals.find((goal) => goal.id === goalId)?.name ===
                goalName,
            "AI goal name",
        );
        const goal = (await app.harness.snapshot(ProjectsDoc, context))!.goals[goalId]!;

        assert.equal(goal.named, true);
        assert.equal(
            (await app.harness.getTask(goal.namingTaskId! as TaskId, context))?.state.status,
            "terminal",
        );
        const namingUsage = structuredClone(
            (await app.harness.snapshot(UsageDoc, id, context))!.models["faux/faux-mini"]!,
        );

        assert.ok(
            namingUsage.totalTokens > 0,
            "the goal's naming model usage is stored with its name",
        );
        await say(app, id, "Another task");
        await app.close();
        app = await openApp(model, directory);
        await say(app, id, "Continue please");

        assert.equal(
            app.projects.list(owner(app)).goals.find((item) => item.id === goalId)?.name,
            goalName,
        );
        assert.equal(namingCalls, 1);
        assert.deepEqual(
            (await app.harness.snapshot(UsageDoc, id, context))!.models["faux/faux-mini"],
            namingUsage,
        );
    } finally {
        await app.close();
    }
});

test("a person's rename wins over an in-flight AI goal name", async () => {
    let started = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const model = scriptedModel(async (request) => {
        if (lastText(request as never).text.startsWith(GOAL_NAME_PROMPT)) {
            started = true;
            await gate;

            return fauxAssistantMessage([fauxText(goalName)]);
        }

        return fauxAssistantMessage([fauxText("Working on it.")]);
    });
    const app = await openApp(model, join(root, "goal-name-rename"));

    try {
        const { id, goalId } = await worker(app);

        await say(app, id, "Fix login");
        await until(() => started, "naming request started");
        await app.projects.updateGoal(owner(app), goalId, { name: "Owner's chosen goal" });
        release();
        const goal = (await app.harness.snapshot(ProjectsDoc, context))!.goals[goalId]!;

        await app.harness.waitForTask(goal.namingTaskId! as TaskId, context);
        assert.equal(
            app.projects.list(owner(app)).goals.find((item) => item.id === goalId)?.name,
            "Owner's chosen goal",
        );
    } finally {
        release();
        await app.close();
    }
});

test("scheduled admissions name the goal, and a missed reservation still uses the durable first message", async () => {
    const namingPrompts: string[] = [];
    const model = scriptedModel((request) => {
        const text = lastText(request as never).text;
        const naming = text.startsWith(GOAL_NAME_PROMPT);

        if (naming) {
            namingPrompts.push(text);
        }

        return fauxAssistantMessage([fauxText(naming ? goalName : "Done.")]);
    });
    const directory = join(root, "goal-name-scheduled");
    let offset = 0;
    let app = await openApp(model, directory, () => Date.now() + offset);

    try {
        const scheduled = await worker(app);

        await app.commands.schedule(scheduled.id, owner(app), {
            when: "in 1m Repair login",
            zone: "UTC",
        });
        await app.close();
        offset = 120_000;
        app = await openApp(model, directory, () => Date.now() + offset);
        await until(
            () =>
                app.projects.list(owner(app)).goals.find((item) => item.id === scheduled.goalId)
                    ?.name === goalName,
            "the first scheduled input names its goal after the schedule fires",
        );
        assert.equal(namingPrompts.length, 1);
        assert.ok(namingPrompts[0]!.includes("<message>\nRepair login\n</message>"));
        await say(app, scheduled.id, "Review dashboard");
        assert.equal(namingPrompts.length, 1);

        const missed = await worker(app);
        const submission = await (
            await app.conversation(missed.id)
        ).submit(
            { type: "input", content: "Repair signup", requestId: "missed-naming-first" },
            context,
        );

        await submission.wait(context);
        assert.equal(
            (await app.harness.snapshot(ProjectsDoc, context))!.goals[missed.goalId]!.namingTaskId,
            undefined,
        );
        await say(app, missed.id, "Review dashboard");
        await until(
            () =>
                app.projects.list(owner(app)).goals.find((item) => item.id === missed.goalId)
                    ?.name === goalName,
            "a later admission repairs naming from the durable first input",
        );
        assert.equal(namingPrompts.length, 2);
        assert.ok(namingPrompts[1]!.includes("<message>\nRepair signup\n</message>"));
        assert.equal(namingPrompts[1]!.includes("Review dashboard"), false);
    } finally {
        await app.close();
    }
});

test("reopen repairs a durable first message admitted before its goal naming task", async () => {
    let namingCalls = 0;
    const model = scriptedModel((request) => {
        const naming = lastText(request as never).text.startsWith(GOAL_NAME_PROMPT);

        namingCalls += Number(naming);

        return fauxAssistantMessage([fauxText(naming ? goalName : "Done.")]);
    });
    const directory = join(root, "goal-name-repair");
    let app = await openApp(model, directory);

    try {
        const { id, goalId } = await worker(app);
        // The public durable admission is stored without Commands' subsequent metadata commit, as after interruption.
        const submission = await (
            await app.conversation(id)
        ).submit({ type: "input", content: "Fix login", requestId: "repair-first-input" }, context);

        await submission.wait(context);
        assert.equal(
            (await app.harness.snapshot(ProjectsDoc, context))!.goals[goalId]!.namingTaskId,
            undefined,
        );
        await app.close();
        app = await openApp(model, directory);
        await until(
            () =>
                app.projects.list(owner(app)).goals.find((goal) => goal.id === goalId)?.name ===
                goalName,
            "recovered goal name",
        );

        assert.equal(namingCalls, 1);
        assert.equal(app.sessionMeta(id)?.goalId, goalId);
    } finally {
        await app.close();
    }
});
