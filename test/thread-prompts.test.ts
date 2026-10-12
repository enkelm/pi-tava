// Authoring gate: actual provider requests own role selection, scope and shared-context composition.
// A generic/wrong role, lost role after restart, or child/source adopting the active successor's role must fail here.
// Existing handoff/security tests own readiness and write enforcement; no prompt renderer or test-only export is used.
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
} from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { SubagentsDoc } from "../src/server/docs.ts";
import type { ThreadType } from "../src/server/workflow-docs.ts";

const data = join(root, "thread-prompt-data");
const cwd = join(root, "thread-prompt-work");
const requests: { text: string; sections: Record<string, string> }[] = [];
const model = scriptedModel((input) => {
    const last = lastText(input);
    const sections: Record<string, string> = {};

    // Replay the public system-message section patches as a provider does; user/brief text is not system authority.
    for (const message of input.messages) {
        if (message.role !== "system") {
            continue;
        }

        for (const [key, value] of Object.entries(message.sections ?? {})) {
            if (value === null) {
                delete sections[key];
            } else {
                sections[key] = value;
            }
        }
    }

    requests.push({ text: last.text, sections });

    if (last.role === "user" && last.text.endsWith("SPAWN_ROLE_HELPER")) {
        return fauxAssistantMessage(
            [
                fauxToolCall("subagent", {
                    action: "spawn",
                    name: "role-helper",
                    message: "HELPER_ROLE_PROBE",
                }),
            ],
            { stopReason: "toolUse" },
        );
    }

    return fauxAssistantMessage([fauxText("Role request observed.")]);
});
let app: App;

before(async () => {
    mkdirSync(cwd);
    writeFileSync(join(cwd, "AGENTS.md"), "# Repository rules\nPreserve the REPO_ROLE_CONTRACT.\n");
    execFileSync("git", ["init", "-q"], { cwd });
    execFileSync("git", ["add", "."], { cwd });
    execFileSync(
        "git",
        ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture"],
        { cwd },
    );
    app = await openApp(model, data);
});
after(async () => {
    await app?.close();
    cleanUp();
});

async function thread(type: "chat" | "worker") {
    const { id } = await app.commands.createSession(owner(app), { cwd, threadType: type });

    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });

    return id;
}

async function probe(id: ConversationId) {
    await say(app, id, "ROLE_PROBE");
    const seen = requests.at(-1)!;

    assert.ok(seen.text.endsWith("ROLE_PROBE"));

    return seen.sections;
}

const roles = [
    { type: "chat", label: "Chat", responsibility: /clarify/i },
    { type: "worker", label: "Worker", responsibility: /focused tests/i },
    { type: "reviewer", label: "Reviewer", responsibility: /test quality/i },
    { type: "land", label: "Land", responsibility: /integration-impact/i },
    { type: "publish", label: "Publish", responsibility: /publication tool/i },
] satisfies { type: ThreadType; label: string; responsibility: RegExp }[];

function role(sections: Record<string, string>, expected: (typeof roles)[number]) {
    assert.ok(
        sections.thread_role,
        "a dedicated system role is sent to the model, not only a user-message brief",
    );
    assert.match(sections.thread_role, new RegExp(`You are the ${expected.label} agent`));
    assert.match(sections.thread_role, expected.responsibility);

    for (const other of roles.filter((candidate) => candidate.type !== expected.type)) {
        assert.doesNotMatch(sections.thread_role, new RegExp(`You are the ${other.label} agent`));
    }

    assert.match(sections.guidelines!, /Do not commit, push, publish, or deploy unless asked/);
    assert.match(sections.project_context!, /REPO_ROLE_CONTRACT/);
}

async function handoff(source: ConversationId, type: "reviewer" | "land" | "publish") {
    const created = await app.handoffs.start(source, owner(app), {
        targetType: type,
        relationship: "same-work",
        requestId: `role-${type}`,
        brief: "Inspect this fixture independently; the brief is orientation, not role instructions.",
    });
    const id = created.id as ConversationId;

    await until(
        async () =>
            !app.isBusy(id) &&
            (await app.handoffs.list(id, owner(app))).handoffs.some(
                (record) => record.targetThreadId === created.id && record.delivery === "delivered",
            ),
        `${type} role delivered`,
    );

    const initial = requests.findLast((request) =>
        request.text.includes(`Independent handoff from thread ${source};`),
    );

    assert.ok(initial, "the destination agent receives its own initial handoff request");
    role(
        initial.sections,
        roles.find((expected) => expected.type === type)!,
    );
    assert.equal(
        initial.sections.instructions,
        undefined,
        "initial delivery cannot carry the source agent's thread-local instructions",
    );

    return id;
}

test("each thread type receives its own system working playbook and retains shared safety/repository instructions", async () => {
    role(await probe(await thread("chat")), roles[0]!);
    let id = await thread("worker");

    role(await probe(id), roles[1]!);
    await app.commands.setInstructions(
        id,
        owner(app),
        "WORKER_LOCAL_ONLY: keep implementation iterations focused.",
    );
    assert.match((await probe(id)).instructions!, /WORKER_LOCAL_ONLY/);

    for (const expected of roles.slice(2)) {
        // These human fixture checkpoints admit the next stage; this test owns prompt delivery, not verification.
        if (expected.type === "land") {
            await app.handoffs.complete(id, owner(app), {
                status: "review-complete",
                summary: "Fixture checkpoint for inspecting the Land system prompt.",
            });
        } else if (expected.type === "publish") {
            await app.handoffs.complete(id, owner(app), {
                status: "landed",
                summary: "Clean local fixture checkpoint for inspecting the Publish system prompt.",
                readyForPublish: true,
            });
        }

        assert.ok(
            expected.type === "reviewer" || expected.type === "land" || expected.type === "publish",
        );
        id = await handoff(id, expected.type);
        const fresh = await probe(id);

        role(fresh, expected);
        assert.equal(
            fresh.instructions,
            undefined,
            "a successor agent does not inherit its predecessor's thread-local instructions",
        );
        await app.commands.setInstructions(
            id,
            owner(app),
            `${expected.label}_LOCAL_ONLY: follow this agent's assignment.`,
        );
        const configured = await probe(id);

        role(configured, expected);
        assert.match(configured.instructions!, new RegExp(`${expected.label}_LOCAL_ONLY`));
    }
});

test("handoff successors, delegated helpers and retired threads retain the right system role across restart", async () => {
    const worker = await thread("worker");

    await probe(worker);
    const reviewer = await handoff(worker, "reviewer");

    role(await probe(reviewer), roles[2]!);
    await app.commands.setInstructions(
        reviewer,
        owner(app),
        "REVIEWER_LOCAL_PERSISTENCE: inspect the test boundaries.",
    );
    const retired = await probe(worker);

    role(retired, roles[1]!);
    assert.match(retired.workflow!, /permanently read-only/);
    await say(app, reviewer, "SPAWN_ROLE_HELPER");
    const child = (await app.harness.snapshot(SubagentsDoc, reviewer, context))?.agents[
        "role-helper"
    ]?.conversationId;

    assert.ok(child);
    await until(() => !app.isBusy(child) && !app.isBusy(reviewer), "role helper and reporter idle");
    const helper = requests.findLast((request) => request.text.includes("HELPER_ROLE_PROBE"));

    assert.ok(helper);
    role(helper.sections, roles[2]!);
    assert.match(helper.sections.thread_role!, /delegated helper/i);
    await app.close();
    app = await openApp(model, data);
    const resumedReviewer = await probe(reviewer);

    role(resumedReviewer, roles[2]!);
    assert.match(resumedReviewer.instructions!, /REVIEWER_LOCAL_PERSISTENCE/);
    const recovered = await probe(worker);

    role(recovered, roles[1]!);
    assert.match(recovered.workflow!, /permanently read-only/);
});
