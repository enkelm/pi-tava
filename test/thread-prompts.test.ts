// Authoring gate: actual provider requests own role selection, scope and shared-context composition.
// A generic/wrong role, lost role after restart, or child/source adopting the active successor's role must fail here.
// Handoff/security tests own runtime flow and write enforcement; these assertions own delivered prompt content only.
// Saved legacy prompts losing the common human-control override is a distinct request-composition regression.
// No prompt renderer or test-only production export is used.
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
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { SessionsDoc, SubagentsDoc } from "../src/server/docs.ts";
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
    app = await openApp(model, data);
});
after(async () => {
    await app?.close();
    cleanUp();
});

async function thread(type: "chat" | "worker" | "researcher" | "pull") {
    const { id } = await app.commands.createSession(owner(app), { cwd, threadType: type });

    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });

    return id;
}

// Persisted type is input to prompt selection. Runtime handoff tests own Reviewer diff admission;
// this fixture creates no readiness, Changes response, admission receipt or production test seam.
async function persistedReviewer(): Promise<ConversationId> {
    const conversation = await app.harness.createConversation(
        {
            ownership: { kind: "ownerless" },
            agent: {
                cwd,
                model: { provider: "faux", modelId: "faux-1" },
                thinkingLevel: "off",
            },
            init: async (tx, id) => {
                const sessions = await tx.doc(SessionsDoc);
                const now = Date.now();

                sessions.items[String(id)] = {
                    cwd,
                    threadType: "reviewer",
                    createdBy: owner(app).id,
                    createdAt: now,
                    updatedAt: now,
                };
            },
        },
        context,
    );

    return conversation.id;
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
    {
        type: "publish",
        label: "Publish",
        responsibility: /publication for every supported external mutation/i,
    },
    { type: "follow-up", label: "Follow-up", responsibility: /Self-review your delta/i },
    { type: "pull", label: "Pull", responsibility: /ticket\/PR\/repository data/i },
    { type: "researcher", label: "Researcher", responsibility: /deep research/i },
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

async function handoff(
    source: ConversationId,
    type: "worker" | "researcher" | "reviewer" | "land" | "publish" | "follow-up" | "pull",
) {
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
    const reviewer = await persistedReviewer();
    const reviewRole = await probe(reviewer);

    role(reviewRole, roles[2]!);
    assert.match(reviewRole.thread_role!, /bounded to two passes/i);
    assert.match(reviewRole.thread_role!, /abandon that check and notify the human/i);
    assert.match(reviewRole.thread_role!, /never bypass it, retry unchanged failures/i);
    await app.commands.setInstructions(
        reviewer,
        owner(app),
        "REVIEWER_LOCAL_ONLY: inspect test quality.",
    );
    const configuredReview = await probe(reviewer);

    role(configuredReview, roles[2]!);
    assert.match(configuredReview.instructions!, /REVIEWER_LOCAL_ONLY/);
    let id = await thread("worker");

    role(await probe(id), roles[1]!);
    await app.commands.setInstructions(
        id,
        owner(app),
        "WORKER_LOCAL_ONLY: keep implementation iterations focused.",
    );
    assert.match((await probe(id)).instructions!, /WORKER_LOCAL_ONLY/);

    for (const type of ["pull", "follow-up", "land", "publish"] as const) {
        const expected = roles.find((candidate) => candidate.type === type)!;

        id = await handoff(id, type);
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

test("Pull can start independently and Follow-up receives focused self-review rather than a full reviewer role", async () => {
    const pull = await thread("pull");
    const pullRole = await probe(pull);

    role(
        pullRole,
        roles.find((expected) => expected.type === "pull")!,
    );
    const followUp = await handoff(pull, "follow-up");
    const followUpRole = await probe(followUp);

    role(
        followUpRole,
        roles.find((expected) => expected.type === "follow-up")!,
    );
    assert.match(
        followUpRole.thread_role!,
        /rather than restart implementation or a whole-application review/i,
    );
    assert.match(
        followUpRole.thread_role!,
        /Self-review your delta and immediate integration points once/i,
    );
    assert.match(followUpRole.thread_role!, /Preserve the source, scope and limitations/i);
    assert.match(
        followUpRole.thread_role!,
        /disclose material rewrites and invalidated assumptions/i,
    );
    assert.match(followUpRole.thread_role!, /Do not manufacture a review pass/i);
    assert.match(followUpRole.thread_role!, /wait for the human/i);
    assert.match(followUpRole.thread_role!, /wait for every delegated helper/i);
});

// Prompt contract at request delivery: research produces evidence, not feature implementation or flow control.
test("Worker can research and a starter or mid-work Researcher reports evidence for human-directed application", async () => {
    const starter = await probe(await thread("researcher"));

    role(
        starter,
        roles.find((expected) => expected.type === "researcher")!,
    );
    assert.match(starter.thread_role!, /either as a new Work Item or a focused investigation/i);
    const worker = await thread("worker");
    const working = await probe(worker);

    assert.match(working.thread_role!, /primary-source documentation and deeper planning/i);
    assert.match(working.thread_role!, /Use research and browser within capability limits/i);
    const researcher = await handoff(worker, "researcher");
    const investigating = await probe(researcher);

    role(
        investigating,
        roles.find((expected) => expected.type === "researcher")!,
    );
    assert.match(investigating.thread_role!, /do not implement the feature here/i);
    assert.match(investigating.thread_role!, /Cite URLs, commits and code paths/i);
    assert.match(
        investigating.thread_role!,
        /Separate confirmed facts, hypotheses and unavailable evidence/i,
    );
    assert.match(investigating.thread_role!, /Report the findings and wait for the human/i);
    assert.equal(app.sessionMeta(researcher)?.workItemId, app.sessionMeta(worker)?.workItemId);
    assert.equal((await app.handoffs.list(researcher, owner(app))).workflow.status, "active");
    const implementation = await handoff(researcher, "worker");
    const applying = await probe(implementation);

    role(
        applying,
        roles.find((expected) => expected.type === "worker")!,
    );
    assert.equal((await app.handoffs.list(implementation, owner(app))).workflow.status, "active");
});

test("handoff successors, delegated helpers and retired threads retain the right system role across restart", async () => {
    const worker = await thread("worker");

    await probe(worker);
    const researcher = await handoff(worker, "researcher");
    const expected = roles.find((candidate) => candidate.type === "researcher")!;

    role(await probe(researcher), expected);
    app.config.agentPrompts = {
        researcher:
            "You are the Researcher agent for this thread. Conduct deep research. CUSTOM_RESEARCHER_PLAYBOOK.",
    };
    assert.match((await probe(researcher)).thread_role!, /CUSTOM_RESEARCHER_PLAYBOOK/);
    await app.commands.setInstructions(
        researcher,
        owner(app),
        "RESEARCHER_LOCAL_PERSISTENCE: inspect the primary evidence.",
    );
    const retired = await probe(worker);

    role(retired, roles[1]!);
    assert.match(retired.workflow!, /permanently read-only/);
    assert.doesNotMatch(retired.thread_role!, /CUSTOM_RESEARCHER_PLAYBOOK/);
    await say(app, researcher, "SPAWN_ROLE_HELPER");
    const child = (await app.harness.snapshot(SubagentsDoc, researcher, context))?.agents[
        "role-helper"
    ]?.conversationId;

    assert.ok(child);
    await until(
        () => !app.isBusy(child) && !app.isBusy(researcher),
        "role helper and reporter idle",
    );
    const helper = requests.findLast((request) => request.text.includes("HELPER_ROLE_PROBE"));

    assert.ok(helper);
    role(helper.sections, expected);
    assert.match(helper.sections.thread_role!, /delegated helper/i);
    assert.match(helper.sections.thread_role!, /CUSTOM_RESEARCHER_PLAYBOOK/);
    await app.close();
    app = await openApp(model, data);
    const resumedResearcher = await probe(researcher);

    role(resumedResearcher, expected);
    assert.match(resumedResearcher.instructions!, /RESEARCHER_LOCAL_PERSISTENCE/);
    assert.match(resumedResearcher.thread_role!, /CUSTOM_RESEARCHER_PLAYBOOK/);
    const recovered = await probe(worker);

    role(recovered, roles[1]!);
    assert.match(recovered.workflow!, /permanently read-only/);
    assert.doesNotMatch(recovered.thread_role!, /CUSTOM_RESEARCHER_PLAYBOOK/);
});

test("changing app-wide instructions affects the next request without replacing shared scope or session rules", async () => {
    const chat = await thread("chat");
    const worker = await thread("worker");
    const original = (await probe(chat)).thread_role;

    await app.commands.setInstructions(chat, owner(app), "SESSION_RULE_STAYS_SEPARATE");
    app.config.agentPrompts = {
        ...app.config.agentPrompts,
        chat: "Custom Chat instructions: clarify the request. FIRST_GLOBAL_PROMPT. Prepare a handoff, recommend Land and record readiness to unlock it.",
    };
    const first = await probe(chat);

    assert.match(first.thread_role!, /Custom Chat instructions/);
    assert.match(first.thread_role!, /FIRST_GLOBAL_PROMPT/);
    assert.match(first.thread_role!, /Scope: act as this role/);
    assert.match(first.thread_role!, /Humans alone control flow/i);
    assert.match(first.thread_role!, /The handoff tool reports status only/i);
    assert.match(first.thread_role!, /These common rules override any legacy role instruction/i);
    assert.match(first.thread_role!, /Write the requested summary without tools or further work/i);
    assert.ok(
        first.thread_role!.indexOf("These common rules override") >
            first.thread_role!.indexOf("FIRST_GLOBAL_PROMPT"),
        "the provider receives the non-editable override after saved legacy role instructions",
    );
    assert.match(first.guidelines!, /Do not commit, push, publish, or deploy unless asked/);
    assert.match(first.project_context!, /REPO_ROLE_CONTRACT/);
    assert.match(first.instructions!, /SESSION_RULE_STAYS_SEPARATE/);
    assert.doesNotMatch((await probe(worker)).thread_role!, /FIRST_GLOBAL_PROMPT/);
    app.config.agentPrompts = {
        ...app.config.agentPrompts,
        chat: "SECOND_GLOBAL_PROMPT: help with this bounded task.",
    };
    const second = await probe(chat);

    assert.match(second.thread_role!, /SECOND_GLOBAL_PROMPT/);
    assert.doesNotMatch(second.thread_role!, /FIRST_GLOBAL_PROMPT/);
    const prompts = app.config.agentPrompts;

    delete prompts.chat;
    app.config.agentPrompts = prompts;
    assert.equal((await probe(chat)).thread_role, original);
});
