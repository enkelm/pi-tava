// Native first sends reuse Commands request identities/receipts. Client view dismissal is owned by agent-drafts.test.ts.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, mock, test } from "node:test";
import type { ConversationId, SubmissionId } from "@earendil-works/pi-durable";
import { SessionsDoc } from "../src/server/docs.ts";
import { AgentIdentitiesDoc } from "../src/server/agent-identity-docs.ts";
import { privateAgentRequest as request } from "./private-agent-http.ts";
import {
    cleanUp,
    context,
    echo,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";

after(cleanUp);

test("identity-only creation and rejected first input leave History empty; accepted input persists once across retry/restart", async () => {
    const data = join(root, "named-agent-first-send");
    let app = await openApp(scriptedModel(echo), data);

    try {
        const before = await app.harness.snapshot(SessionsDoc, context);
        const creation = { requestId: "identity-only", name: "Ada" };
        const made = await request(app, "pip/agents?identityOnly=1", creation);

        assert.equal(made.status, 200, await made.clone().text());
        const agent = await made.json();
        const path = `pip/agents/${agent.agentId}`;

        assert.equal(agent.id, null);
        assert.deepEqual(agent.chats, []);
        const draftShell = await request(app, `/agents/${agent.agentId}/drafts/local-view`);

        assert.equal(
            draftShell.status,
            200,
            "reload of a local draft serves the app shell, not a durable room",
        );
        assert.match(await draftShell.text(), /<!doctype html>/i);
        assert.deepEqual(
            (await (await request(app, "pip/agents?identityOnly=1", creation)).json()).agentId,
            agent.agentId,
        );
        assert.deepEqual(
            await app.harness.snapshot(SessionsDoc, context),
            before,
            "creating/viewing an identity never stores a welcome conversation",
        );
        assert.equal(
            (await request(app, `${path}/submit`, { requestId: "empty", text: " " })).status,
            400,
        );
        const first = { requestId: "first-message", text: "Plan a careful implementation" };

        assert.equal(
            (await request(app, `${path}/submit`, first)).status,
            409,
            "a missing model rejects before reserving a conversation",
        );
        assert.deepEqual(await app.harness.snapshot(SessionsDoc, context), before);
        assert.deepEqual((await (await request(app, path)).json()).chats, []);
        assert.equal(
            (
                await request(app, `${path}/configure`, {
                    model: { provider: "faux", modelId: "faux-1" },
                })
            ).status,
            200,
        );
        const sent = await Promise.all([
            request(app, `${path}/submit`, first),
            request(app, `${path}/submit`, first),
        ]);

        assert.deepEqual(
            sent.map((response) => response.status),
            [200, 200],
        );
        const [accepted, duplicate] = await Promise.all(sent.map((response) => response.json()));

        assert.equal(accepted.id, duplicate.id);
        assert.equal(accepted.submissionId, duplicate.submissionId);
        await (await app.harness.submission(accepted.submissionId as SubmissionId, context))!.wait(
            context,
        );
        const chat = accepted.id as ConversationId;
        const entries = (await (await app.conversation(chat)).context(context)).entries;

        assert.equal(entries.filter((entry) => entry.kind === "pi.user").length, 1);
        assert.ok(
            !entries.some(
                (entry) => (entry.data as { appAuthored?: boolean } | undefined)?.appAuthored,
            ),
            "no stored onboarding message",
        );
        const passive = await request(app, `${path}/submit?requestId=${first.requestId}`);

        assert.equal(passive.status, 200);
        assert.equal((await passive.json()).submissionId, accepted.submissionId);
        assert.deepEqual(
            (await (await request(app, path)).json()).chats.map((item: { id: number }) => item.id),
            [accepted.id],
        );
        // Simulate interruption after native admission but before its visibility marker was committed.
        const interruptVisibility = (legacyFingerprint = false) =>
            app.harness.commit(async (tx) => {
                const doc = await tx.doc(AgentIdentitiesDoc);
                const reservation = Object.values(doc.requests).find(
                    (item) => item.chatId === accepted.id,
                )!;

                delete reservation.accepted;

                if (legacyFingerprint) {
                    reservation.fingerprint = createHash("sha256")
                        .update(JSON.stringify({ agentId: agent.agentId, text: first.text }))
                        .digest("hex");
                }
            }, context);

        await interruptVisibility();
        assert.deepEqual(
            (await (await request(app, path)).json()).chats.map((item: { id: number }) => item.id),
            [accepted.id],
            "History recovers accepted native input even after the originating view closes",
        );
        await interruptVisibility(true);
        await app.close();
        app = await openApp(scriptedModel(echo), data);
        const recovered = await request(app, `${path}/submit?requestId=${first.requestId}`);

        assert.equal(recovered.status, 200);
        assert.equal((await recovered.json()).id, accepted.id);
        const retry = await request(app, `${path}/submit`, first);

        assert.equal(retry.status, 200);
        assert.equal((await retry.json()).submissionId, accepted.submissionId);
        assert.deepEqual(
            app.pip.agents.list(owner(app))[0]!.chats.map((item) => item.id),
            [accepted.id],
        );
        assert.equal(
            (await (await app.conversation(chat)).context(context)).entries.filter(
                (entry) => entry.kind === "pi.user",
            ).length,
            1,
        );
        assert.equal(
            (await request(app, `${path}/submit`, { ...first, text: "Different intent" })).status,
            409,
        );
    } finally {
        await app.close();
    }
});

test("identity project settings persist independently of saved Chats and project defaults", async () => {
    const data = join(root, "named-agent-project-settings");
    const folders = ["linked-project", "moved-project"].map((name) => {
        const cwd = join(work, name);

        mkdirSync(cwd, { recursive: true });

        return cwd;
    });
    let holdNext = false;
    let started = false;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    const model = () =>
        scriptedModel(async (...args) => {
            if (holdNext) {
                holdNext = false;
                started = true;
                await held;
            }

            return typeof echo === "function" ? echo(...args) : echo;
        });

    let app = await openApp(model(), data);

    const ok = async (path: string, body?: unknown) => {
        const response = await request(app, path, body);

        assert.equal(response.status, 200, await response.clone().text());

        return response.json();
    };

    const assertLink = async (agentId: string, projectId?: string) => {
        const detail = await ok(`pip/agents/${agentId}`);
        const catalogue = await ok("pip/agents");
        const summary = catalogue.agents.find(
            (item: { agentId: string }) => item.agentId === agentId,
        );

        assert.ok(summary, "an identity remains listed even without a saved Chat");
        assert.equal(
            summary.projectId,
            projectId,
            "owner catalogue retains the identity's project link independently of its Chats",
        );
        assert.equal(detail.projectId, projectId);
        assert.equal(detail.project?.id, projectId);

        if (projectId !== undefined) {
            assert.equal(detail.project.available, true);
        }

        return detail;
    };

    try {
        app.config.lastModel = { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
        assert.equal((await app.hello(owner(app))).server.projectAgentLinks, 1);
        const projects = [];

        for (const [index, cwd] of folders.entries()) {
            projects.push(
                await ok("projects", {
                    requestId: `linked-project-${index}`,
                    name: `Project ${index}`,
                    cwd,
                }),
            );
        }

        const [original, destination] = projects;
        const beforeChats = await app.harness.snapshot(SessionsDoc, context);
        const agent = await ok("pip/agents?identityOnly=1", {
            requestId: "linked-identity",
            name: "Linked identity",
            instructions: "Original instructions",
            focus: "Original focus",
            projectId: original.id,
        });
        const sibling = await ok("pip/agents?identityOnly=1", {
            requestId: "second-linked-identity",
            name: "Second linked identity",
            projectId: original.id,
        });
        const defaultOnly = await ok("pip/agents?identityOnly=1", {
            requestId: "default-only-identity",
            name: "Project default without an identity link",
        });
        const path = `pip/agents/${agent.agentId}`;

        for (const linked of [agent, sibling]) {
            assert.equal(linked.id, null);
            assert.deepEqual(linked.chats, []);
            await assertLink(linked.agentId, original.id);
        }

        await ok(`projects/${destination.id}`, { defaultAgentId: defaultOnly.agentId });
        const projectDefaults = await ok("projects");

        await assertLink(defaultOnly.agentId);

        let current = agent;

        const update = async (body: Record<string, unknown>, target = path) => {
            const response = await request(app, target, {
                ...body,
                expectedRevision: current.revision,
            });

            assert.equal(response.status, 200, await response.clone().text());
            const saved = await response.json();

            assert.equal(saved.revision, current.revision + 1);
            current = saved;
        };

        await update({ name: "Renamed identity" });
        await assertLink(agent.agentId, original.id);
        await update({ projectId: destination.id });
        assert.deepEqual(
            [current.name, current.instructions, current.focus],
            ["Renamed identity", "Original instructions", "Original focus"],
            "a project-only edit preserves omitted charter fields",
        );
        await update({ instructions: "Revised instructions" });
        await assertLink(agent.agentId, destination.id);
        // Charter Undo restores text only: it must not reinstate an older project association.
        await update({ action: "undo", revision: agent.revision });
        assert.deepEqual(
            [current.name, current.instructions, current.focus],
            ["Linked identity", "Original instructions", "Original focus"],
        );
        await assertLink(agent.agentId, destination.id);
        await update({ projectId: null });
        await assertLink(agent.agentId);
        await update({ projectId: original.id });
        await assertLink(agent.agentId, original.id);
        await assertLink(sibling.agentId, original.id);
        assert.deepEqual(
            (await app.harness.snapshot(SessionsDoc, context))?.items ?? {},
            beforeChats?.items ?? {},
            "linking and editing zero-chat identities never creates or moves a conversation",
        );

        for (const [projectId, status] of [
            ["missing-project", 404],
            ["__proto__", 404],
            ["constructor", 404],
            [42, 400],
            [false, 400],
            [[original.id], 400],
        ] as const) {
            const rejected = await request(app, path, {
                expectedRevision: current.revision,
                projectId,
            });

            assert.equal(rejected.status, status, await rejected.clone().text());
            assert.equal((await assertLink(agent.agentId, original.id)).revision, current.revision);
        }

        for (const [expectedRevision, status] of [
            [current.revision - 1, 409],
            [0, 400],
        ]) {
            const rejected = await request(app, path, {
                expectedRevision,
                projectId: destination.id,
            });

            assert.equal(rejected.status, status, await rejected.clone().text());
        }

        const guest = app.config.addUser("Project guest", "guest");
        const otherOwner = app.config.addUser("Other owner", "owner");

        for (const [token, status] of [
            [guest.token, 403],
            [otherOwner.token, 404],
        ] as const) {
            const rejected = await request(
                app,
                path,
                { expectedRevision: current.revision, projectId: destination.id },
                token,
            );

            assert.equal(rejected.status, status, await rejected.clone().text());
            const catalogue = await request(app, "pip/agents", undefined, token);

            if (status === 403) {
                assert.equal(catalogue.status, 403);
            } else {
                assert.equal(catalogue.status, 200);
                assert.deepEqual(
                    (await catalogue.json()).agents,
                    [],
                    "another owner cannot see private project links",
                );
            }
        }

        assert.equal((await assertLink(agent.agentId, original.id)).revision, current.revision);
        const first = await ok(`${path}/submit`, {
            requestId: "before-project-reassignment",
            text: "Keep this Chat in its original folder",
        });

        await (await app.harness.submission(first.submissionId as SubmissionId, context))!.wait(
            context,
        );
        await update({ projectId: destination.id }, `c/${first.id}/private-agent`);
        await assertLink(agent.agentId, destination.id);
        assert.equal(app.sessionMeta(first.id)?.projectId, original.id);
        assert.equal(app.cwdOf(first.id), folders[0]);

        holdNext = true;
        const second = await ok(`${path}/submit`, {
            requestId: "after-project-reassignment",
            text: "Use the new default in a separate Chat",
        });

        try {
            await until(() => started, "the native response in a sibling Chat is held");
            const rejected = await request(app, `c/${first.id}/private-agent`, {
                expectedRevision: current.revision,
                projectId: original.id,
            });

            assert.equal(rejected.status, 409, await rejected.clone().text());
            assert.match(await rejected.text(), /working/i);
            assert.equal(
                (await assertLink(agent.agentId, destination.id)).revision,
                current.revision,
            );
        } finally {
            release();
            await (await app.harness.submission(
                second.submissionId as SubmissionId,
                context,
            ))!.wait(context);
        }

        assert.equal(app.sessionMeta(second.id)?.projectId, destination.id);
        assert.equal(app.cwdOf(second.id), folders[1]);
        assert.deepEqual(await ok("projects"), projectDefaults);
        const savedRevision = current.revision;

        await app.close();
        app = await openApp(model(), data);
        const restored = await assertLink(agent.agentId, destination.id);

        assert.equal(restored.revision, savedRevision);
        await assertLink(sibling.agentId, original.id);
        await assertLink(defaultOnly.agentId);
        assert.equal(app.sessionMeta(first.id)?.projectId, original.id);
        assert.equal(app.cwdOf(first.id), folders[0]);
        assert.equal(app.sessionMeta(second.id)?.projectId, destination.id);
        assert.equal(app.cwdOf(second.id), folders[1]);
        assert.deepEqual(await ok("projects"), projectDefaults);
    } finally {
        release();
        await app.close();
    }
});

test("Home first-send project context and saved-Chat follow-on keep exact native input receipts across recovery", async () => {
    const data = join(root, "named-agent-home-context");
    let app = await openApp(scriptedModel(echo), data);
    const folders = ["identity-context", "home-context", "changed-home-context"].map((name) => {
        const cwd = join(work, name);

        mkdirSync(cwd, { recursive: true });

        return cwd;
    });

    try {
        app.config.lastModel = { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
        const original = await app.projects.create(owner(app), {
            requestId: "original-project",
            name: "Identity default",
            cwd: folders[0],
        });
        const selected = await app.projects.create(owner(app), {
            requestId: "selected-project",
            name: "Home selection",
            cwd: folders[1],
        });
        const agent = await app.pip.agents.createIdentity(owner(app), {
            requestId: "context-identity",
            name: "Context",
            projectId: original.id,
        });
        const path = `pip/agents/${agent.agentId}`;

        const send = async (
            body: { requestId: string; text: string; projectId?: string | null },
            route = `${path}/submit`,
            chatId?: number,
        ) => {
            const response = await request(app, route, body);

            assert.equal(response.status, 200, await response.clone().text());
            const accepted = await response.json();
            const chat = (chatId ?? accepted.id) as ConversationId;
            const submission = await app.harness.submission(
                accepted.submissionId as SubmissionId,
                context,
            );

            assert.ok(submission, "HTTP acceptance names an actual native input");
            await submission.wait(context);
            const native = await app.harness.commit(
                (tx) => tx.submissionByRequest(chat, accepted.requestId),
                context,
            );

            assert.equal(native?.type, "input");
            assert.equal(native?.id, accepted.submissionId);
            assert.equal(native?.conversationId, chat);
            assert.equal(native?.status, "done");
            const receipt = await request(app, `c/${chat}/submit?requestId=${body.requestId}`);

            assert.equal(receipt.status, 200, await receipt.clone().text());
            assert.deepEqual(await receipt.json(), {
                submissionId: accepted.submissionId,
                requestId: accepted.requestId,
                handoffRequestKey: accepted.handoffRequestKey,
            });

            return accepted;
        };

        const first = await send({
            requestId: "default-context",
            text: "Use the identity default",
        });
        const homeInput = {
            requestId: "home-context",
            text: "Start new work here",
            projectId: selected.id,
        };
        const beforeUnknown = await app.harness.snapshot(SessionsDoc, context);
        const unknown = await request(app, `${path}/submit`, {
            ...homeInput,
            unknownSetting: true,
        });

        assert.equal(unknown.status, 400);
        assert.deepEqual(await unknown.json(), { error: "Unknown private agent setting" });
        assert.deepEqual(await app.harness.snapshot(SessionsDoc, context), beforeUnknown);
        assert.equal(
            (await request(app, `${path}/submit?requestId=${homeInput.requestId}`)).status,
            404,
            "unknown keys fail before native input or a Chat is reserved",
        );
        const second = await send(homeInput);
        const followInput = { requestId: "saved-chat-follow-on", text: "Continue this exact Chat" };
        const followRoute = `c/${second.id}/submit`;
        const follow = await send(followInput, followRoute, second.id);

        assert.notEqual(follow.submissionId, second.submissionId);
        const unassigned = await send({
            requestId: "no-context",
            text: "No project",
            projectId: null,
        });
        const { user: guest, token: guestToken } = app.config.addUser("All projects", "guest");

        assert.notEqual(first.id, second.id);
        assert.equal(app.sessionMeta(first.id)?.projectId, original.id);
        assert.equal(app.cwdOf(first.id), folders[0]);
        assert.equal(app.sessionMeta(second.id)?.projectId, selected.id);
        assert.equal(app.cwdOf(second.id), folders[1]);
        assert.equal(app.sessionMeta(unassigned.id)?.projectId, undefined);
        assert.equal(app.cwdOf(unassigned.id), app.defaultCwd);

        for (const id of [first.id, second.id, unassigned.id]) {
            assert.equal(app.sessionMeta(id)?.ownerOnly, true);
            assert.equal(app.sessionMeta(id)?.pipAgentId, agent.agentId);
            assert.equal(app.sessionMeta(id)?.threadType, "chat");
            assert.equal(
                app.canSee(guest, id),
                false,
                "project membership never shares named Chats",
            );
        }

        const expectedContexts = [
            [first.id, original.id],
            [second.id, selected.id],
            [unassigned.id, undefined],
        ];

        const assertChatContexts = async () => {
            const catalogue = await (await request(app, "pip/agents")).json();
            const detail = await (await request(app, path)).json();

            for (const record of [
                catalogue.agents.find(
                    (item: { agentId: string }) => item.agentId === agent.agentId,
                ),
                detail,
            ]) {
                assert.deepEqual(
                    record.chats.map((chat: { id: number; projectId?: string }) => [
                        chat.id,
                        chat.projectId,
                    ]),
                    expectedContexts,
                    "saved Chat contexts come from each exact Chat, not the identity remit",
                );
            }

            assert.equal(detail.projectId, original.id);
        };

        await assertChatContexts();
        assert.equal(
            (await request(app, "pip/agents", undefined, guestToken)).status,
            403,
            "per-Chat context stays inside the owner-private catalogue",
        );
        assert.ok(
            !app
                .sessions(owner(app))
                .some((item) => [first.id, second.id, unassigned.id].includes(item.id)),
            "named Chats remain excluded from Collab even for their owner",
        );

        for (const projectId of [original.id, null, "missing-project", 42]) {
            const response = await request(app, `${path}/submit`, { ...homeInput, projectId });

            assert.equal(response.status, projectId === 42 ? 400 : 409);
        }

        assert.equal(
            (
                await request(app, `${path}/submit`, {
                    requestId: "invalid-project",
                    text: "New",
                    projectId: "missing-project",
                })
            ).status,
            404,
        );
        await app.projects.update(owner(app), selected.id, { cwd: folders[2] });
        await app.close();
        app = await openApp(scriptedModel(echo), data);
        const recovered = await request(app, `${path}/submit?requestId=${homeInput.requestId}`);

        assert.equal(recovered.status, 200);
        assert.equal((await recovered.json()).id, second.id);
        const retried = await send(homeInput);

        assert.equal(retried.id, second.id);
        assert.equal(retried.submissionId, second.submissionId);
        const followRecovered = await request(
            app,
            `${followRoute}?requestId=${followInput.requestId}`,
        );

        assert.equal(followRecovered.status, 200, await followRecovered.clone().text());
        assert.deepEqual(await followRecovered.json(), follow);
        const followRetried = await send(followInput, followRoute, second.id);

        assert.deepEqual(followRetried, follow);
        const entries = (
            await (await app.conversation(second.id as ConversationId)).context(context)
        ).entries;

        assert.equal(
            entries.filter((entry) => entry.kind === "pi.user").length,
            2,
            "first Send, follow-on Send, passive recovery and exact retries append only two inputs",
        );
        await assertChatContexts();
        assert.equal(
            app.cwdOf(second.id),
            folders[1],
            "a retry never re-resolves current defaults",
        );
        const later = await send({ ...homeInput, requestId: "new-after-default-edit" });

        assert.equal(app.cwdOf(later.id), folders[2]);
        assert.equal(app.cwdOf(first.id), folders[0], "prior Chats are never moved or retargeted");
        assert.equal((await app.pip.agents.read(agent.agentId, owner(app))).projectId, original.id);
        const hello = await request(app, "me");

        assert.equal(hello.status, 200, await hello.clone().text());
        assert.equal(
            (await hello.json()).server.agentDraftProjects,
            1,
            "the delivered hello capability promises the explicit-project Send just exercised",
        );
    } finally {
        await app.close();
    }
});

test("native spend rejection after model selection preserves saved Chat capacity and exact retry across restart", async () => {
    const data = join(root, "named-agent-spend-capacity");
    let app = await openApp(scriptedModel(echo), data);

    try {
        const agent = await app.pip.agents.createIdentity(owner(app), {
            requestId: "capacity-identity",
            name: "Capacity",
        });

        await app.pip.agents.configureIdentity(agent.agentId, owner(app), {
            model: { provider: "faux", modelId: "faux-1" },
        });
        const first = await app.pip.agents.submitDraft(agent.agentId, owner(app), {
            requestId: "accepted-first",
            text: "Keep this saved history",
        });

        await (await app.harness.submission(first.submissionId, context))!.wait(context);
        const saved = [first.id];

        // Native explicit-chat callers retain saved empty Chats, not just accepted first sends.
        for (let index = 1; index < 127; index++) {
            saved.push(
                (
                    await app.pip.agents.newChat(first.id as ConversationId, owner(app), {
                        requestId: `saved-${index}`,
                    })
                ).id,
            );
        }

        await app.pip.agents.setBudget(first.id as ConversationId, owner(app), 0);

        // Substitute only destination preparation; native admission still owns reservation and spend.
        const prepare = mock.method(app.sshSessions, "prepare", async () => "/remote/home");
        let projectId: string;

        try {
            projectId = (
                await app.projects.create(owner(app), {
                    requestId: "rejected-remote-project",
                    name: "Remote context",
                    cwd: "/remote/home",
                    location: { kind: "ssh", host: "home-fixture" },
                })
            ).id;
        } finally {
            prepare.mock.restore();
        }

        const rejected = {
            requestId: "rejected-first",
            text: "Try the native admission",
            projectId,
        };
        const attempt = () => app.pip.agents.submitDraft(agent.agentId, owner(app), rejected);

        await assert.rejects(attempt, /spend limit/);
        await assert.rejects(attempt, /spend limit/);
        assert.deepEqual(
            (await app.pip.agents.read(agent.agentId, owner(app))).chatIds,
            saved,
            "native rejection never exposes the reserved Chat in History",
        );
        const reservation = Object.values(
            (await app.harness.snapshot(AgentIdentitiesDoc, context))!.requests,
        ).find((item) => item.firstInputRequestId?.endsWith(":rejected-first"));

        assert.ok(reservation?.chatId, "the exact rejected reservation is retained for retry");
        const pinned = {
            projectId,
            cwd: "/remote/home",
            location: { kind: "ssh", host: "home-fixture" },
        };

        const reservedContext = () => {
            const meta = app.sessionMeta(reservation.chatId as ConversationId)!;

            return { projectId: meta.projectId, cwd: meta.cwd, location: meta.location };
        };

        assert.deepEqual(reservedContext(), pinned);
        await app.projects.update(owner(app), projectId, { cwd: work, location: null });
        await assert.rejects(attempt, /spend limit/);
        assert.deepEqual(
            reservedContext(),
            pinned,
            "unaccepted retries retain their exact destination",
        );
        assert.equal(
            await app.pip.agents.draftReceipt(agent.agentId, owner(app), rejected.requestId),
            undefined,
            "a definite native rejection has no acceptance receipt",
        );

        await app.pip.agents.setBudget(first.id as ConversationId, owner(app), undefined);

        await app.close();
        app = await openApp(scriptedModel(echo), data);
        assert.deepEqual(
            reservedContext(),
            pinned,
            "reload retains an unaccepted reservation's context",
        );
        const corrected = { requestId: "corrected-first", text: "Use the last saved slot" };
        const accepted = await app.pip.agents.submitDraft(agent.agentId, owner(app), corrected);

        await (await app.harness.submission(accepted.submissionId, context))!.wait(context);
        assert.deepEqual(
            (await app.pip.agents.read(agent.agentId, owner(app))).chatIds,
            [...saved, accepted.id],
            "rejected reservations consume none of the 128 saved slots after restart",
        );
        assert.equal(
            (await app.pip.agents.submitDraft(agent.agentId, owner(app), corrected)).submissionId,
            accepted.submissionId,
        );
        await assert.rejects(attempt, /At most 128 chats/);
        assert.equal(
            Object.values((await app.harness.snapshot(AgentIdentitiesDoc, context))!.requests).find(
                (item) => item.firstInputRequestId === reservation.firstInputRequestId,
            )?.chatId,
            reservation.chatId,
            "retry keeps the same rejected request and Chat identities even at capacity",
        );
        // A native acceptance whose projection was interrupted must still occupy its saved slot.
        await app.harness.commit(async (tx) => {
            const doc = await tx.doc(AgentIdentitiesDoc);
            const waiting = Object.values(doc.requests).find(
                (item) => item.chatId === accepted.id,
            )!;

            delete waiting.accepted;
        }, context);
        await assert.rejects(
            app.pip.agents.newChat(first.id as ConversationId, owner(app), {
                requestId: "beyond-capacity",
            }),
            /At most 128 chats/,
        );
        assert.deepEqual(
            (await app.pip.agents.read(agent.agentId, owner(app))).chatIds,
            [...saved, accepted.id],
            "accepted and preexisting Chats are never removed to free capacity",
        );
    } finally {
        await app.close();
    }
});

test("owner-private identity History includes retained saved Chats and never another agent's conversation", async (t) => {
    const app = await openApp(scriptedModel(echo));

    t.after(() => app.close());
    app.config.lastModel = { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
    const ada = await app.pip.agents.createIdentity(owner(app), {
        requestId: "history-ada",
        name: "Ada",
    });
    const bea = await app.pip.agents.createIdentity(owner(app), {
        requestId: "history-bea",
        name: "Bea",
    });
    const first = await app.pip.agents.submitDraft(ada.agentId, owner(app), {
        requestId: "first",
        text: "First history",
    });

    await (await app.harness.submission(first.submissionId, context))!.wait(context);
    const second = await app.pip.agents.submitDraft(ada.agentId, owner(app), {
        requestId: "second",
        text: "Second history",
    });
    const sibling = await app.pip.agents.submitDraft(bea.agentId, owner(app), {
        requestId: "first",
        text: "Other identity",
    });
    const history = await (await request(app, `pip/agents/${ada.agentId}`)).json();

    assert.deepEqual(
        history.chats.map((item: { id: number }) => item.id),
        [first.id, second.id],
    );
    assert.ok(!history.chats.some((item: { id: number }) => item.id === sibling.id));
    assert.equal(
        (await request(app, `c/${first.id}/private-agent`)).status,
        200,
        "exact navigation reopens a saved Chat without creating a new one",
    );
    assert.deepEqual(
        (await app.pip.agents.read(ada.agentId, owner(app))).chats.map((item) => item.id),
        [first.id, second.id],
    );
    const guest = app.config.addUser("Guest", "guest");

    for (const path of [
        "pip/agents",
        `pip/agents/${ada.agentId}`,
        `pip/agents/${ada.agentId}/submit?requestId=first`,
    ]) {
        const denied = await request(app, path, undefined, guest.token);

        assert.equal(denied.status, 403);
        assert.ok(!(await denied.text()).includes("First history"));
    }

    assert.equal(
        (await request(app, `pip/agents/${bea.agentId}/submit?requestId=second`)).status,
        404,
        "receipt lookup cannot cross identities",
    );
});
