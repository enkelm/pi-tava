// Native identity HTTP owns pre-chat Memory access: owner-only authorization, no chat side effects,
// server-derived isolation and the same observed revisions used by conversation-bound learned Memory.
// Existing private-agent-memory.test.ts owns tool maintenance, prompt injection and receipt replay.
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import { SessionsDoc } from "../src/server/docs.ts";
import { privateAgentRequest as request } from "./private-agent-http.ts";
import type { LessonView, MemoryView } from "../src/server/memory.ts";
import {
    type App,
    cleanUp,
    context,
    echo,
    openApp,
    owner,
    root,
    scriptedModel,
} from "./helpers.ts";

after(cleanUp);

async function view(app: App, path: string): Promise<MemoryView> {
    const response = await request(app, path);

    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get("cache-control"), "no-store");

    return response.json();
}

test("owner identity Memory persists before any chat, isolated per agent with observed revisions", async () => {
    const data = join(root, "identity-memory-before-chat");
    let app = await openApp(scriptedModel(echo), data);

    try {
        const ada = await app.pip.agents.createIdentity(owner(app), {
            requestId: "memory-ada",
            name: "Ada",
        });
        const bea = await app.pip.agents.createIdentity(owner(app), {
            requestId: "memory-bea",
            name: "Bea",
        });
        const path = `pip/agents/${ada.agentId}/memory`;
        const sibling = `pip/agents/${bea.agentId}/memory`;
        const before = await app.harness.snapshot(SessionsDoc, context);
        const empty = await view(app, path);

        assert.deepEqual(empty.lessons, []);
        assert.equal(empty.privateAgent, true);
        assert.equal(empty.project, null);
        assert.equal(empty.owner, true);
        assert.equal(empty.canWrite, true);
        const response = await request(app, path, {
            text: "PREFER_NATIVE_IDENTITY_MEMORY",
            scope: "everywhere",
        });

        assert.equal(response.status, 200, await response.clone().text());
        const initial: LessonView = (await view(app, path)).lessons[0]!;

        assert.equal(initial.text, "PREFER_NATIVE_IDENTITY_MEMORY");
        assert.equal(initial.scope, "private-agent", "client scope cannot select shared Memory");
        assert.equal(initial.revision, 1);
        assert.equal(initial.pending, false);
        assert.equal(initial.from, undefined, "identity edits have no invented transcript source");
        assert.deepEqual((await view(app, sibling)).lessons, []);

        for (const suffix of ["", "/remove"]) {
            const denied = await request(app, `${sibling}/${initial.id}${suffix}`, {
                text: "CROSS_IDENTITY_OVERWRITE",
                expectedRevision: 1,
            });

            assert.equal(denied.status, 404, "a guessed lesson ID cannot cross identities");
        }

        const corrected = await request(app, `${path}/${initial.id}`, {
            text: "PREFER_CORRECTED_NATIVE_MEMORY",
            expectedRevision: 1,
        });

        assert.equal(corrected.status, 200, await corrected.clone().text());

        for (const suffix of ["", "/remove"]) {
            for (const expectedRevision of [undefined, 1]) {
                const stale = await request(app, `${path}/${initial.id}${suffix}`, {
                    text: "STALE_NATIVE_MEMORY",
                    expectedRevision,
                });

                assert.equal(
                    stale.status,
                    409,
                    "missing/stale observations cannot change learning",
                );
            }
        }

        assert.deepEqual(await app.harness.snapshot(SessionsDoc, context), before);
        assert.deepEqual(app.pip.agents.ownedIdentity(ada.agentId, owner(app)).chatIds, []);
        assert.deepEqual(app.pip.agents.ownedIdentity(bea.agentId, owner(app)).chatIds, []);
        assert.equal(app.pip.idOf(owner(app).id), undefined, "Memory does not open global PiP");
        await app.close();
        app = await openApp(scriptedModel(echo), data);
        const retained = (await view(app, path)).lessons[0]!;

        assert.equal(retained.text, "PREFER_CORRECTED_NATIVE_MEMORY");
        assert.equal(retained.revision, 2);
        assert.deepEqual((await view(app, sibling)).lessons, []);
        const removed = await request(app, `${path}/${initial.id}/remove`, {
            expectedRevision: retained.revision,
        });

        assert.equal(removed.status, 200, await removed.clone().text());
        assert.deepEqual((await view(app, path)).lessons, []);
        assert.deepEqual(await app.harness.snapshot(SessionsDoc, context), before);
        assert.deepEqual(app.pip.agents.ownedIdentity(ada.agentId, owner(app)).chatIds, []);
    } finally {
        await app.close();
    }
});

test("native identity Memory refuses non-owners, missing identities and revoked owner credentials", async () => {
    const app = await openApp(scriptedModel(echo), join(root, "identity-memory-access"));

    try {
        const identity = await app.pip.agents.createIdentity(owner(app), {
            requestId: "memory-access-agent",
            name: "Private",
        });
        const path = `pip/agents/${identity.agentId}/memory`;
        const added = await request(app, path, { text: "OWNER_ONLY_NATIVE_MEMORY" });

        assert.equal(added.status, 200, await added.clone().text());
        const lesson = (await view(app, path)).lessons[0]!;

        for (const role of ["guest", "viewer"] as const) {
            const person = app.config.addUser(role, role);

            for (const [target, body] of [
                [path, undefined],
                [path, { text: "UNAUTHORIZED_NATIVE_MEMORY" }],
                [`${path}/${lesson.id}`, { text: "UNAUTHORIZED_EDIT", expectedRevision: 1 }],
                [`${path}/${lesson.id}/remove`, { expectedRevision: 1 }],
            ] as const) {
                const denied = await request(app, target, body, person.token);

                assert.equal(denied.status, 403);
                assert.ok(!(await denied.text()).includes(lesson.text));
            }
        }

        for (const body of [undefined, { text: "MISSING_IDENTITY_MUST_NOT_USE_SHARED_MEMORY" }]) {
            assert.equal(
                (await request(app, "pip/agents/missing-identity/memory", body)).status,
                404,
            );
        }

        // HTTP pins the request's credentials before its body arrives. Rotation must fence that in-flight edit.
        let release!: (body: unknown) => void;
        const body = new Promise((resolve) => {
            release = resolve;
        });
        const stale = request(app, `${path}/${lesson.id}`, body);
        const formerOwner = structuredClone(owner(app));

        app.config.rotateOwnerToken();
        release({ text: "REVOKED_NATIVE_EDIT", expectedRevision: 1 });
        assert.equal((await stale).status, 401);
        await assert.rejects(app.memory.identityView(identity.agentId, formerOwner), {
            status: 401,
        });
        await assert.rejects(
            app.memory.identityRemember(identity.agentId, formerOwner, { text: "REVOKED_ADD" }),
            { status: 401 },
        );
        await assert.rejects(
            app.memory.identityEdit(identity.agentId, formerOwner, lesson.id, "remove", 1),
            { status: 401 },
        );
        assert.equal((await view(app, path)).lessons[0]!.text, "OWNER_ONLY_NATIVE_MEMORY");
        assert.deepEqual(app.pip.agents.ownedIdentity(identity.agentId, owner(app)).chatIds, []);
    } finally {
        await app.close();
    }
});
