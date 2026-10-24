// Persistent charter and authority contracts. The removed conversation notebook is intentionally not retained.
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import {
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
    work,
} from "./helpers.ts";

const cid = (id: number) => id as ConversationId;

after(cleanUp);

test("approved charter revisions and inactive proposals belong to the identity, not its chat", async () => {
    const prompts: string[] = [];
    const app = await openApp(
        scriptedModel((request) => {
            prompts.push(JSON.stringify(request));
            const last = lastText(request);

            return last.role === "user" && last.text.includes("draft charter")
                ? fauxAssistantMessage(
                      [
                          fauxToolCall("agent_charter", {
                              action: "propose_instructions",
                              expectedRevision: 1,
                              instructions: "DRAFT_IS_NOT_APPROVED",
                          }),
                      ],
                      { stopReason: "toolUse" },
                  )
                : fauxAssistantMessage([fauxText("Done")]);
        }),
        join(root, "agent-charters"),
    );

    try {
        app.config.lastModel = { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
        const user = owner(app);
        const a = await app.pip.agents.create(user, {
            requestId: "a",
            name: "Atlas",
            instructions: "APPROVED_A",
        });
        const a2 = await app.pip.agents.newChat(cid(a.id), user, { requestId: "a2" });
        const b = await app.pip.agents.create(user, {
            requestId: "b",
            name: "Birch",
            instructions: "APPROVED_B",
        });

        await say(app, cid(a.id), "draft charter");
        const proposed = await app.pip.agents.read(cid(a2.id), user);

        assert.equal(proposed.instructions, "APPROVED_A");
        assert.equal(proposed.proposal?.instructions, "DRAFT_IS_NOT_APPROVED");
        assert.equal(proposed.revision, 2);
        await say(app, cid(a2.id), "Check active instructions");
        assert.ok(prompts.at(-1)!.includes("APPROVED_A"));
        assert.ok(!prompts.at(-1)!.includes("DRAFT_IS_NOT_APPROVED"));
        await assert.rejects(
            app.pip.agents.update(cid(a.id), user, { expectedRevision: 1, instructions: "STALE" }),
            /changed elsewhere/,
        );
        const saved = await app.pip.agents.update(cid(a2.id), user, {
            expectedRevision: 2,
            instructions: proposed.proposal!.instructions,
            name: "Atlas updated",
        });

        assert.equal(saved.revision, 3);
        assert.equal(saved.proposal, undefined);
        assert.equal(
            (await app.pip.agents.read(cid(a.id), user)).instructions,
            "DRAFT_IS_NOT_APPROVED",
        );
        assert.equal(saved.name, "Atlas updated");
        const undone = await app.pip.agents.undo(cid(a.id), user, {
            expectedRevision: 3,
            revision: 1,
        });

        assert.equal(undone.revision, 4);
        assert.equal(undone.instructions, "APPROVED_A");
        await app.commands.reset(cid(a2.id), user, undefined);
        await say(app, cid(a2.id), "After reset");
        assert.ok(prompts.at(-1)!.includes("APPROVED_A"));
        await say(app, cid(b.id), "Sibling identity");
        assert.ok(prompts.at(-1)!.includes("APPROVED_B"));
        assert.ok(!prompts.at(-1)!.includes("APPROVED_A"));
        const ordinary = await newSession(app);

        await say(app, ordinary, "Ordinary thread");
        assert.ok(!prompts.at(-1)!.includes("APPROVED_A"));
        const generic = await app.pip.ensure(user);

        await say(app, generic, "Popup");
        assert.ok(!prompts.at(-1)!.includes("APPROVED_A"));
    } finally {
        await app.close();
    }
});

test("creation remit is explicit and never inherits project cwd, membership, model or authority", async () => {
    const app = await openApp(scriptedModel(), join(root, "agent-remit"));

    try {
        const user = owner(app);

        app.config.lastModel = { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
        const project = await app.projects.create(user, {
            requestId: "remit",
            name: "Remit",
            cwd: work,
        });
        const a = await app.pip.agents.create(user, {
            requestId: "a",
            projectId: project.id,
            focus: "/not/a/workspace",
        });
        const a2 = await app.pip.agents.newChat(cid(a.id), user, { requestId: "a2" });
        const b = await app.pip.agents.create(user, { requestId: "b" });

        assert.deepEqual(a.project, { id: project.id, available: true, name: "Remit" });
        assert.equal(a2.projectId, project.id);
        assert.equal(b.projectId, undefined);

        for (const id of [a.id, a2.id]) {
            assert.equal(app.sessionMeta(cid(id))?.cwd, work);
            assert.equal(app.sessionMeta(cid(id))?.projectId, undefined);
            assert.equal(app.sessionMeta(cid(id))?.pipWorkItemId, undefined);
            assert.equal((await app.agentState(cid(id)))?.model?.modelId, "faux-1");
        }

        await assert.rejects(app.commands.configure(cid(a.id), user, { cwd: "/tmp" }), /remit/);
        await assert.rejects(app.commands.setInstructions(cid(a.id), user, "bypass"), /revisioned/);
        await assert.rejects(
            app.commands.updateSession(cid(a.id), user, { title: "bypass" }),
            /PiP settings/,
        );
        await assert.rejects(
            app.pip.agents.create(user, { requestId: "bad", projectId: "guessed-project" }),
            /project/i,
        );
        await assert.rejects(
            app.pip.agents.create(user, { requestId: "notes", notes: "removed notebook" }),
            /Unknown/,
        );
    } finally {
        await app.close();
    }
});

test("only the live owner can inspect, edit or create private identities; stale sign-in cannot mutate them", async () => {
    const app = await openApp(scriptedModel(), join(root, "agent-owner"));

    try {
        const user = { ...owner(app) };
        const a = await app.pip.agents.create(user, { requestId: "a" });
        const guest = app.config.addUser("Guest", "guest").user;

        assert.throws(() => app.pip.agents.list(guest), /owner/);
        await assert.rejects(app.pip.agents.read(cid(a.id), guest), /owner/);
        await assert.rejects(
            app.pip.agents.update(cid(a.id), guest, { expectedRevision: 1, name: "intruder" }),
            /owner/,
        );
        app.config.rotateOwnerToken();
        await assert.rejects(app.pip.agents.create(user, { requestId: "stale" }), /access changed/);
        await assert.rejects(app.pip.agents.read(cid(a.id), user), /access changed/);
        assert.equal((await app.pip.agents.read(cid(a.id), owner(app))).name, "New agent");
    } finally {
        await app.close();
    }
});

test("distinct chats complete independently while shared settings cannot race a running sibling", async () => {
    let firstStarted = false;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    const app = await openApp(
        scriptedModel(async (request) => {
            if (lastText(request).text.includes("Hold this response")) {
                firstStarted = true;
                await held;
            }

            return fauxAssistantMessage([fauxText(`Done: ${lastText(request).text}`)]);
        }),
        join(root, "agent-lane"),
    );

    try {
        app.config.lastModel = { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
        const user = owner(app);
        const a = await app.pip.agents.create(user, { requestId: "a" });
        const a2 = await app.pip.agents.newChat(cid(a.id), user, { requestId: "a2" });
        const answer = say(app, cid(a.id), "Hold this response");

        try {
            await until(
                () => firstStarted,
                "the first native provider response is deliberately held",
            );
            await say(app, cid(a2.id), "Concurrent chat");
            assert.ok(
                app.isBusy(cid(a.id)),
                "the sibling did not abort or supersede the held source",
            );
            const reply = await (await app.conversation(cid(a2.id))).context(context);

            assert.match(
                JSON.stringify(reply.messages.at(-1)),
                /Done: .*Concurrent chat/,
                "the second native chat completes without releasing the first response",
            );
            const fresh = await app.pip.agents.submitDraft(a.agentId, user, {
                requestId: "fresh-while-busy",
                text: "First send in another chat",
            });

            await (await app.harness.submission(fresh.submissionId, context))!.wait(context);
            const freshReply = await (await app.conversation(cid(fresh.id))).context(context);

            assert.match(
                JSON.stringify(freshReply.messages.at(-1)),
                /Done: .*First send in another chat/,
            );
            assert.ok(
                app.isBusy(cid(a.id)),
                "first-send admission also leaves its sibling running",
            );
            await assert.rejects(
                app.pip.agents.update(cid(a2.id), user, { expectedRevision: 1, name: "Busy edit" }),
                /working/,
            );
            await assert.rejects(
                app.commands.configure(cid(a2.id), user, {
                    model: { provider: "faux", modelId: "faux-2" },
                }),
                /working/,
            );
        } finally {
            release();
            await answer;
        }

        const firstReply = await (await app.conversation(cid(a.id))).context(context);

        assert.match(JSON.stringify(firstReply.messages.at(-1)), /Done: .*Hold this response/);
    } finally {
        release?.();
        await app.close();
    }
});
