// Native public handoff routing from a real controller, not fabricated epochs or transfer receipts.
import {
    activateWorkPip,
    cleanUp,
    context,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId, JsonObject } from "@earendil-works/pi-durable";
import { SubagentsDoc } from "../src/server/docs.ts";
import { TITLE_PROMPT } from "../src/server/titles.ts";
import { HandoffsDoc, WorkflowDoc } from "../src/server/workflow-docs.ts";

const text = (value: string) => fauxAssistantMessage([fauxText(value)]);
const tool = (name: string, args: JsonObject) =>
    fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

after(cleanUp);

type Status = {
    sourceThreadId: number;
    options: { targetType: string; relationship: string; enabled: boolean; reason?: string }[];
};

test("public controller handoff transfers the exact active execution, retains its controller and refuses stale or unrelated sources", async (t) => {
    let source!: ConversationId;
    let target!: ConversationId;
    let other!: ConversationId;
    let controller!: ConversationId;
    let phase: "transfer" | "refusals" = "transfer";
    let step = 0;
    const instructions = "CONTROLLER_NOTE: preserve the bounded scope; no staging or commits.";
    const creationFields: JsonObject[] = [
        { folder: root },
        { repo: "owner/repository" },
        { title: "Unrelated creation" },
        { model: "faux/faux-1" },
        { report: false },
    ];
    const refuse: { name: string; args: () => JsonObject; reason: RegExp }[] = [
        {
            name: "historical source status",
            args: () => ({ action: "status", session: Number(source) }),
            reason: /active thread changed/,
        },
        {
            name: "stale execution transfer",
            args: () => ({
                action: "start",
                session: Number(source),
                targetType: "researcher",
                summary: "Do not transfer the retired historical source.",
            }),
            reason: /active thread changed/,
        },
        {
            name: "cross-item source",
            args: () => ({
                action: "start",
                session: Number(other),
                targetType: "researcher",
                summary: "Do not transfer another visible item.",
            }),
            reason: /outside.*Work Item/,
        },
        {
            name: "controller as execution source",
            args: () => ({
                action: "start",
                session: Number(controller),
                targetType: "researcher",
                summary: "Do not retire or enroll this private controller.",
            }),
            reason: /own conversation/,
        },
        {
            name: "missing expected source",
            args: () => ({
                action: "start",
                targetType: "researcher",
                summary: "An observed execution source must be explicit.",
            }),
            reason: /requires the exact expected execution session/,
        },
        {
            name: "new work",
            args: () => ({
                action: "start",
                session: Number(target),
                relationship: "new-work",
                targetType: "researcher",
                summary: "Do not create unrelated controller work.",
            }),
            reason: /only hand off within its current Work Item/,
        },
        {
            name: "worktree",
            args: () => ({
                action: "start",
                session: Number(target),
                targetType: "researcher",
                summary: "Do not allocate a controller worktree.",
                worktree: true,
            }),
            reason: /creation settings/,
        },
        ...creationFields.map((creation) => ({
            name: `${Object.keys(creation)[0]} creation field`,
            args: () => ({
                action: "start",
                session: Number(target),
                targetType: "researcher",
                summary: "Do not ignore controller-incompatible creation fields.",
                ...creation,
            }),
            reason: /creation settings/,
        })),
    ];
    const model = scriptedModel((request) => {
        const scoped = JSON.stringify(
            request.messages.filter((message) => message.role === "system"),
        ).includes("the private supervisor for Work Item");

        if (!scoped) {
            return text("The disposable execution fixture settled.");
        }

        if (phase === "transfer") {
            const calls = [
                () => tool("work_context", { session: Number(source), action: "thread" }),
                () => tool("handoff", { action: "status", session: Number(source) }),
                () =>
                    tool("handoff", {
                        action: "start",
                        session: Number(source),
                        targetType: "reviewer",
                        summary:
                            "Inspect this settled fixture; no landing or publication authorized.",
                        instructions,
                    }),
                () =>
                    tool("work_supervise", {
                        action: "finish",
                        text: "Exact execution transferred; retain this controller and wait.",
                    }),
            ];

            return calls[step++]!();
        }

        const round = step++;

        if (round === 0) {
            return tool("work_context", { session: Number(target), action: "thread" });
        }

        if (round === 1) {
            return tool("handoff", { action: "status" });
        }

        const refusal = refuse[round - 2];

        return refusal === undefined
            ? tool("work_supervise", {
                  action: "finish",
                  text: "Rejected historical, unrelated and creation-only requests without transfer.",
              })
            : tool("handoff", refusal.args());
    });
    const app = await openApp(model, join(root, "public-controller-transfer"));

    t.after(() => app.close());
    source = await newSession(app, app.defaultCwd, "worker");
    other = await newSession(app, app.defaultCwd, "worker");
    await say(app, source, "Settle the implementation fixture; no checkout edits requested.");
    await until(async () => {
        try {
            await app.harness.commit((tx) => app.workItems.requireIdle(tx, source), context);

            return true;
        } catch {
            return false;
        }
    }, "source execution and auxiliary naming settle before the transfer");
    const opened = await activateWorkPip(app, source, owner(app), {
        text: "Inspect this settled execution and hand it to a Reviewer once.",
    });

    controller = opened.orchestration!.conversationId as ConversationId;
    await until(
        () =>
            !app.isBusy(controller) &&
            app.workItems.itemFor(source)?.supervisor?.status === "reclaimed",
        "native public handoff and controller finish",
    );
    const item = app.workItems.itemFor(source)!;

    target = item.activeThreadId as ConversationId;
    assert.notEqual(target, source);
    await until(async () => {
        const doc = await app.harness.snapshot(HandoffsDoc, context);

        return (
            !app.isBusy(target) &&
            Object.values(doc!.handoffs).some(
                (record) =>
                    record.targetThreadId === Number(target) && record.delivery === "delivered",
            )
        );
    }, "the actual successor courier settles");
    const first = (await app.transcripts.allEntries(controller, true))
        .filter((entry) => entry.kind === "toolResult")
        .filter((entry) => entry.name === "handoff");

    assert.equal(first.length, 2);
    assert.equal(first[0]!.isError, false, first[0]!.text);
    assert.equal(first[1]!.isError, false, first[1]!.text);
    const status: Status = JSON.parse(first[0]!.text);
    const transfer = JSON.parse(first[1]!.text);

    assert.equal(status.sourceThreadId, Number(source));
    assert.ok(
        status.options.some(
            (option) =>
                option.targetType === "reviewer" &&
                option.relationship === "same-work" &&
                option.enabled,
        ),
        "controller status preserves its registered-profile policy without an ordinary diff gate",
    );
    assert.equal(transfer.id, Number(target));
    assert.equal(transfer.workItemId, item.id);
    const saved = (await app.harness.snapshot(HandoffsDoc, context))!.handoffs[transfer.handoffId];

    assert.ok(saved?.file);
    assert.ok(readFileSync(saved.file, "utf8").includes(instructions));
    assert.equal(app.sessionMeta(target)?.threadType, "reviewer");
    assert.equal(app.workItems.isReadOnly(source), true);
    assert.equal(app.workItems.isReadOnly(target), false);
    assert.equal(item.supervisor!.conversationId, Number(controller));
    assert.equal(app.sessionMeta(controller)?.pipWorkItemId, item.id);
    assert.equal(app.parentOf(controller), undefined);
    assert.deepEqual(app.workItems.members(source).map(Number), [Number(source), Number(target)]);

    phase = "refusals";
    step = 0;
    const reopened = await activateWorkPip(app, source, owner(app), {
        text: "Inspect current execution; refuse stale sources and unrelated creation settings.",
    });

    assert.equal(reopened.orchestration!.conversationId, Number(controller));
    await until(
        () =>
            !app.isBusy(controller) &&
            app.workItems.itemFor(source)?.supervisor?.status === "reclaimed",
        "registered public source refusals",
    );
    const later = (await app.transcripts.allEntries(controller, true))
        .filter((entry) => entry.kind === "toolResult")
        .filter((entry) => entry.name === "handoff")
        .slice(first.length);

    assert.equal(later.length, refuse.length + 1);
    assert.equal(later[0]!.isError, false, later[0]!.text);
    assert.equal(JSON.parse(later[0]!.text).sourceThreadId, Number(target));

    for (const [index, refusal] of refuse.entries()) {
        const result = later[index + 1]!;

        assert.equal(result.isError, true, `${refusal.name}: ${result.text}`);
        assert.match(result.text, refusal.reason, refusal.name);
    }

    assert.equal(app.workItems.itemFor(source)!.activeThreadId, Number(target));
    assert.equal(app.workItems.isReadOnly(target), false);
    assert.equal(app.workItems.isReadOnly(controller), false);
    assert.equal(app.workItems.itemFor(other), undefined);
    assert.equal(
        Object.keys((await app.harness.snapshot(HandoffsDoc, context))!.handoffs).length,
        1,
    );
});

test("public controller status and start refuse a real busy helper without stopping it or retiring its source", async (t) => {
    let source!: ConversationId;
    let helperEntered = false;
    let step = 0;

    let release = () => {};

    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    const model = scriptedModel(async (request) => {
        const scoped = JSON.stringify(
            request.messages.filter((message) => message.role === "system"),
        ).includes("the private supervisor for Work Item");

        if (scoped) {
            const calls = [
                () => tool("work_context", { session: Number(source), action: "thread" }),
                () => tool("handoff", { action: "status", session: Number(source) }),
                () =>
                    tool("handoff", {
                        action: "start",
                        session: Number(source),
                        targetType: "researcher",
                        summary:
                            "Do not retire execution while its literal helper is still running.",
                    }),
                () =>
                    tool("work_supervise", {
                        action: "finish",
                        text: "Helper work remains active; no transfer or interruption occurred.",
                    }),
            ];

            return calls[step++]!();
        }

        if (lastText(request).text.startsWith(TITLE_PROMPT)) {
            return text("Native controller helper refusal");
        }

        const user = request.messages.findLast((message) => message.role === "user");
        const original = user === undefined ? "" : lastText({ messages: [user] }).text;

        if (original.includes("BLOCKED_CONTROLLER_HELPER")) {
            helperEntered = true;
            await held;

            return text("The real delegated helper has now settled.");
        }

        if (original.includes("SPAWN_CONTROLLER_HELPER") && lastText(request).role === "user") {
            return tool("subagent", {
                action: "spawn",
                name: "writer",
                message:
                    "BLOCKED_CONTROLLER_HELPER: wait until the fixture releases this actual run.",
            });
        }

        return text(
            "Main execution yielded; its helper remains responsible for its assigned work.",
        );
    });
    const app = await openApp(model, join(root, "public-controller-busy-helper"));

    t.after(async () => {
        release();
        await app.close();
    });
    source = await newSession(app, app.defaultCwd, "worker");
    await say(app, source, "SPAWN_CONTROLLER_HELPER");
    const child = (await app.harness.snapshot(SubagentsDoc, source, context))!.agents.writer!
        .conversationId;

    await until(() => helperEntered && app.isBusy(child), "real delegated helper is running");
    assert.equal(app.isBusy(source), false, "the helper, not the main execution run, is busy");
    const opened = await activateWorkPip(app, source, owner(app), {
        text: "Inspect helper idleness and refuse a transfer while delegated work is running.",
    });
    const controller = opened.orchestration!.conversationId as ConversationId;

    await until(
        () =>
            !app.isBusy(controller) &&
            app.workItems.itemFor(source)?.supervisor?.status === "reclaimed",
        "native busy-helper status and transfer refusal",
    );
    const results = (await app.transcripts.allEntries(controller, true))
        .filter((entry) => entry.kind === "toolResult")
        .filter((entry) => entry.name === "handoff");

    assert.equal(results.length, 2);
    assert.equal(results[0]!.isError, false, results[0]!.text);
    const status: Status = JSON.parse(results[0]!.text);

    assert.equal(status.sourceThreadId, Number(source));
    assert.ok(status.options.length > 0);
    assert.ok(status.options.every((option) => !option.enabled));
    assert.ok(
        status.options.every((option) =>
            /delegated helpers|background tasks/.test(option.reason ?? ""),
        ),
    );
    assert.equal(results[1]!.isError, true, results[1]!.text);
    assert.match(results[1]!.text, /delegated helpers|background tasks/);
    assert.equal(app.isBusy(child), true, "handoff refusal must not abort the helper");
    assert.equal(app.workItems.itemFor(source)!.activeThreadId, Number(source));
    assert.equal(
        (await app.harness.snapshot(WorkflowDoc, source, context))?.readOnly ?? false,
        false,
    );
    assert.equal(
        Object.keys((await app.harness.snapshot(HandoffsDoc, context))!.handoffs).length,
        0,
    );
});

test("public controller status leaves its final action available for the exact transfer", async (t) => {
    let source!: ConversationId;
    let controller!: ConversationId;
    let step = 0;
    let actionsAfterStatus: number | undefined;
    const app = await openApp(
        scriptedModel((request) => {
            const scoped = JSON.stringify(
                request.messages.filter((message) => message.role === "system"),
            ).includes("the private supervisor for Work Item");

            if (!scoped) {
                return text("Execution fixture settled.");
            }

            switch (step++) {
                case 0:
                    return tool("work_context", { session: Number(source), action: "thread" });
                case 1:
                    return tool("handoff", { action: "status", session: Number(source) });
                case 2:
                    actionsAfterStatus = app.workItems.itemFor(source)?.supervisor?.actions;

                    return tool("handoff", {
                        action: "start",
                        session: Number(source),
                        targetType: "researcher",
                        summary: "Continue this exact investigation; no publication.",
                    });
                default:
                    return text("The one authorized transfer action is complete.");
            }
        }),
        join(root, "public-controller-passive-status"),
    );

    t.after(() => app.close());
    source = await newSession(app, app.defaultCwd, "worker");
    const opened = await activateWorkPip(app, source, owner(app), {
        text: "Inspect availability, then transfer this settled execution once.",
        maxActions: 1,
    });

    controller = opened.orchestration!.conversationId as ConversationId;
    await until(
        async () =>
            (await app.transcripts.allEntries(controller, true)).filter(
                (entry) => entry.kind === "toolResult" && entry.name === "handoff",
            ).length === 2,
        "passive status and the final available transfer action settle",
    );
    const results = (await app.transcripts.allEntries(controller, true))
        .filter((entry) => entry.kind === "toolResult")
        .filter((entry) => entry.name === "handoff");

    assert.equal(actionsAfterStatus, 0, "availability must not consume a native action");
    assert.equal(results[0]!.isError, false, results[0]!.text);
    assert.ok(
        JSON.parse(results[0]!.text).options.some(
            (option: Status["options"][number]) =>
                option.targetType === "researcher" && option.enabled,
        ),
    );
    assert.equal(results[1]!.isError, false, results[1]!.text);
    assert.equal(JSON.parse(results[1]!.text).id, app.workItems.itemFor(source)!.activeThreadId);
    assert.equal(app.workItems.isReadOnly(source), true);
    assert.equal(app.workItems.itemFor(source)!.supervisor!.actions, 1);
});
