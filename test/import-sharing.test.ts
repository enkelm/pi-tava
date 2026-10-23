// Real app/SQLite and in-memory HTTP, with generated Pi journals only. No listener or live data.
import {
    type App,
    cleanUp,
    context,
    fakeTab,
    modelTexts,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, unlinkSync } from "node:fs";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { dirname, join } from "node:path";
import { after, mock, test } from "node:test";
import type { Context } from "@earendil-works/chord";
import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import { Auth } from "../src/server/auth.ts";
import {
    ImportedSessionDoc,
    ImportsDoc,
    SessionsDoc,
    type SessionMeta,
} from "../src/server/docs.ts";
import { HttpError } from "../src/server/errors.ts";
import { createHandler } from "../src/server/http.ts";
import { importFixture } from "./import-fixtures.ts";

function folder(name: string): string {
    const path = join(work, name);

    mkdirSync(path, { recursive: true });

    return path;
}

async function fixture(name: string) {
    const source = importFixture(folder(name));
    const app = await openApp(scriptedModel(), join(root, `sharing-${name}`));

    // Saved-file discovery must not inspect the developer's running Herdr instances.
    app.piSessions.active.local.sockets = async () => [];
    const handler = createHandler({
        app,
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
    });

    const request = async (
        method: string,
        path: string,
        body?: unknown,
        token: string | null = app.config.ownerToken,
        pocket = true,
    ) => {
        const incoming = new IncomingMessage(new Socket());
        const response = new ServerResponse(incoming);
        let output = "";

        incoming.method = method;
        incoming.url = `/api/${path}`;
        incoming.headers = {
            ...(token === null ? {} : { authorization: `Bearer ${token}` }),
            ...(pocket ? { "x-pocket": "1" } : {}),
            "content-type": "application/json",
        };

        response.end = (chunk?: unknown) => {
            output = String(chunk ?? "");

            return response;
        };

        const handled = handler(incoming, response);

        incoming.push(body === undefined ? null : Buffer.from(JSON.stringify(body)));

        if (body !== undefined) {
            incoming.push(null);
        }

        await handled;

        return new Response(output, { status: response.statusCode });
    };

    const preview = await app.piSessions.preview(owner(app), { path: source.path });
    const input = {
        path: preview.path,
        sha256: preview.sha256,
        leafId: preview.leafId,
        acknowledged: true,
        model: "faux/faux-vision",
        thinkingLevel: "off",
    };

    return { app, source, request, input };
}

async function project(app: App, name: string): Promise<string> {
    return (
        await app.projects.create(owner(app), {
            name,
            cwd: folder(name),
            requestId: crypto.randomUUID(),
        })
    ).id;
}

const denied = (error: unknown) =>
    error instanceof HttpError && [400, 403, 404, 409].includes(error.status);

function gate() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
        release = resolve;
    });

    return { promise, release };
}

after(cleanUp);

test("share HTTP requires owner authentication, CSRF protection and explicit confirmation", async () => {
    const { app, request, input } = await fixture("route-guards");

    try {
        const projectId = await project(app, "cleared-import-project");
        const { id } = await app.piSessions.create(owner(app), { ...input, projectId });
        const guest = app.config.addUser("Steering guest", "guest", undefined, true);
        const viewer = app.config.addUser("Viewer", "viewer");
        const path = `pi-sessions/${id}/share`;

        assert.equal((await request("POST", path, { acknowledged: true }, null)).status, 401);
        assert.equal(
            (await request("POST", path, { acknowledged: true }, app.config.ownerToken, false))
                .status,
            403,
        );

        for (const token of [guest.token, viewer.token]) {
            assert.equal((await request("POST", path, { acknowledged: true }, token)).status, 403);
        }

        for (const acknowledged of [undefined, false, "true", 1]) {
            assert.equal((await request("POST", path, { acknowledged })).status, 400);
        }

        assert.equal(app.sessionMeta(id)!.ownerOnly, true);
        assert.equal(
            (await request("POST", path, { acknowledged: true, projectId: null })).status,
            200,
        );
        assert.equal(app.sessionMeta(id)!.projectId, undefined);
        assert.equal(app.canSee(guest.user, id), true);
    } finally {
        await app.close();
    }
});

test("sharing a continued private import after unlink preserves history and publishes only its selected project", async () => {
    const { app, source, request, input } = await fixture("continued-import");
    const tabs: ReturnType<typeof fakeTab>[] = [];

    try {
        const selected = await project(app, "shared-import-project");
        const other = await project(app, "other-import-project");
        const collaborator = app.config.addUser("Selected project", "guest", undefined, undefined, {
            projectIds: [selected],
        });
        const outsider = app.config.addUser("Other project", "viewer", undefined, undefined, {
            projectIds: [other],
        });
        const { id } = await app.piSessions.create(owner(app), input);
        const imported = (await app.harness.snapshot(ImportedSessionDoc, id, context))!;
        const fork = await app.commands.fork(id, owner(app), {
            entryId: imported.source!.entryIds[source.lastAnswer],
        });
        const invite = await request("POST", "invite", { role: "viewer", session: id });
        const invited = new Auth(app.config).redeem((await invite.json()).code, "Exact import")!;
        const collaboratorTab = fakeTab(undefined, collaborator.user);
        const invitedTab = fakeTab(undefined, invited.user);
        const outsiderTab = fakeTab(undefined, outsider.user);

        tabs.push(collaboratorTab, invitedTab, outsiderTab);

        for (const tab of tabs) {
            await app.attach(tab.client);
        }

        assert.deepEqual(app.sessions(collaborator.user), []);
        assert.deepEqual(app.sessions(invited.user), []);
        assert.deepEqual(app.projects.list(invited.user), { projects: [] });
        await app.commands.note(id, owner(app), "CONTINUATION_BEFORE_SHARING");
        await app.commands.updateSession(id, owner(app), {
            title: "Continued imported Chat",
            archived: true,
        });
        const history = await (await request("GET", `c/${id}/history`)).text();
        const modelHistory = await modelTexts(app, id);
        const settings = await app.agentState(id);
        const before = structuredClone(app.sessionMeta(id)!);

        unlinkSync(source.path);
        const shared = await request("POST", `pi-sessions/${id}/share`, {
            acknowledged: true,
            projectId: selected,
        });

        assert.equal(shared.status, 200, await shared.clone().text());
        assert.equal(app.sessionMeta(id)!.ownerOnly, false);
        assert.equal(app.sessionMeta(id)!.projectId, selected);
        assert.equal(app.sessionMeta(id)!.cwd, before.cwd);
        assert.notEqual(
            app.cwdOf(id),
            app.projects.list(owner(app)).projects.find((p) => p.id === selected)!.cwd,
        );
        assert.equal(app.sessionMeta(id)!.title, before.title);
        assert.equal(app.sessionMeta(id)!.archived, true);
        assert.equal(app.sessionMeta(id)!.createdAt, before.createdAt);
        assert.deepEqual(await app.agentState(id), settings);
        assert.deepEqual(await modelTexts(app, id), modelHistory);
        assert.deepEqual(await app.harness.snapshot(ImportedSessionDoc, id, context), imported);
        assert.equal(await (await request("GET", `c/${id}/history`)).text(), history);
        assert.match(history, /CONTINUATION_BEFORE_SHARING/);
        assert.equal(app.canSee(collaborator.user, id), true);
        assert.equal(app.canSee(invited.user, id), true);
        assert.equal(app.canSee(outsider.user, id), false);
        assert.equal(app.canSee(collaborator.user, fork.id), false);
        assert.equal(app.canSee(invited.user, fork.id), false);
        assert.equal(app.sessionMeta(fork.id)!.ownerOnly, true);
        await until(
            () =>
                JSON.stringify(collaboratorTab.last("sessions")).includes(`"id":${id}`) &&
                JSON.stringify(invitedTab.last("sessions")).includes(`"id":${id}`) &&
                JSON.stringify(invitedTab.last("projects")).includes(selected),
            "shared session and newly visible scoped project reach attached tabs",
        );
        assert.deepEqual(outsiderTab.last("sessions"), []);
        assert.deepEqual(
            app.projects.list(invited.user).projects.map((p) => p.id),
            [selected],
        );
        assert.equal(Object.hasOwn(app.projects.list(invited.user).projects[0]!, "cwd"), false);
        const sharedHistory = await request("GET", `c/${id}/history`, undefined, invited.token);

        assert.equal(sharedHistory.status, 200);
        assert.match(await sharedHistory.text(), /HISTORICAL_TOOL_RESULT/);
        assert.equal(
            (await request("GET", `c/${id}/history`, undefined, outsider.token)).status,
            404,
        );

        for (const token of [collaborator.token, invited.token, outsider.token]) {
            assert.equal(
                (await request("GET", `pi-sessions/${id}/archive`, undefined, token)).status,
                403,
            );
        }

        assert.equal(
            await (await request("GET", `pi-sessions/${id}/archive`)).text(),
            source.archive,
        );
    } finally {
        for (const tab of tabs) {
            app.detach(tab.client);
        }

        await app.close();
    }
});

test("share rejects ordinary Chats, private forks and reserved imported namespaces, but supports legacy imports", async () => {
    const { app, source, input } = await fixture("eligible-roots");

    try {
        const ordinary = await app.commands.createSession(owner(app), {
            cwd: work,
            threadType: "chat",
        });

        await assert.rejects(
            app.piSessions.share(owner(app), ordinary.id, { acknowledged: true }),
            denied,
        );
        const { id } = await app.piSessions.create(owner(app), input);
        const imported = (await app.harness.snapshot(ImportedSessionDoc, id, context))!;
        const fork = await app.commands.fork(id, owner(app), {
            entryId: imported.source!.entryIds[source.lastAnswer],
        });

        await assert.rejects(
            app.piSessions.share(owner(app), fork.id, { acknowledged: true }),
            denied,
        );
        const original = structuredClone(app.sessionMeta(id)!);
        const forbidden: Partial<SessionMeta>[] = [
            { pip: owner(app).id },
            { pipAgent: true },
            { pipAgentId: "private-agent" },
            { pipWorkItemId: "private-controller" },
            { workItemId: "work-item" },
            { accessFrom: Number(ordinary.id) },
            { linkedFrom: { id: Number(ordinary.id) } },
            { threadType: "reviewer" },
            { imported: false },
        ];

        for (const marker of forbidden) {
            await app.harness.commit(async (tx) => {
                const meta = { ...original, ...marker };

                if (marker.imported === false) {
                    delete meta.fromPi;
                }

                (await tx.doc(SessionsDoc)).items[String(id)] = meta;
            }, context);
            await assert.rejects(
                app.piSessions.share(owner(app), id, { acknowledged: true }),
                denied,
                JSON.stringify(marker),
            );
            assert.equal(app.sessionMeta(id)!.ownerOnly, true, JSON.stringify(marker));
        }

        await app.harness.commit(async (tx) => {
            (await tx.doc(SessionsDoc)).items[String(id)] = original;
            delete (await tx.doc(ImportedSessionDoc, id)).source;
        }, context);
        await assert.rejects(app.piSessions.share(owner(app), id, { acknowledged: true }), denied);
        await app.harness.commit(async (tx) => {
            (await tx.doc(ImportedSessionDoc, id)).source = imported.source;
            const meta = (await tx.doc(SessionsDoc)).items[String(id)]!;

            delete meta.imported;
            meta.threadType = "worker";
        }, context);
        await app.piSessions.share(owner(app), id, { acknowledged: true });
        assert.equal(
            app.sessionMeta(id)!.ownerOnly,
            false,
            "legacy fromPi imports remain shareable",
        );
        assert.equal(app.sessionMeta(fork.id)!.ownerOnly, true);
    } finally {
        await app.close();
    }
});

test("owner imports accept a project without changing source cwd; invalid placement and guest placement create nothing", async () => {
    const { app, source, request, input } = await fixture("import-placement");
    const previousDirectory = process.env.PI_CODING_AGENT_SESSION_DIR;

    try {
        const projectId = await project(app, "new-import-project");
        const guest = app.config.addUser("History-enabled guest", "guest", undefined, true);

        process.env.PI_CODING_AGENT_SESSION_DIR = dirname(source.path);

        for (const selected of [42, {}, "missing-project"]) {
            const response = await request("POST", "pi-sessions", {
                ...input,
                projectId: selected,
            });

            assert.ok([400, 404].includes(response.status), await response.text());
        }

        for (const selected of [projectId, null]) {
            const response = await request(
                "POST",
                "pi-sessions",
                { ...input, visibility: "shared", projectId: selected },
                guest.token,
            );

            assert.equal(response.status, 403);
        }

        assert.deepEqual(app.sessions(owner(app)), []);
        assert.deepEqual((await app.harness.snapshot(ImportsDoc, context))?.items ?? {}, {});
        const imported = await request("POST", "pi-sessions", { ...input, projectId });

        assert.equal(imported.status, 200, await imported.clone().text());
        const id = (await imported.json()).id as ConversationId;

        assert.equal(
            app.sessionMeta(id)!.ownerOnly,
            true,
            "project placement never implies sharing",
        );
        assert.equal(app.sessionMeta(id)!.projectId, projectId);
        assert.equal(app.cwdOf(id), dirname(dirname(source.path)));
        const guestImport = await request(
            "POST",
            "pi-sessions",
            { ...input, visibility: "shared" },
            guest.token,
        );

        assert.equal(guestImport.status, 200, await guestImport.clone().text());
        assert.notEqual(
            (await guestImport.json()).id,
            id,
            "guest success does not reuse the owner's private receipt",
        );
    } finally {
        if (previousDirectory === undefined) {
            delete process.env.PI_CODING_AGENT_SESSION_DIR;
        } else {
            process.env.PI_CODING_AGENT_SESSION_DIR = previousDirectory;
        }

        await app.close();
    }
});

test("receipt promotion requires the previewed existing Chat and can clear its former project without exposing it", async () => {
    const { app, input, source } = await fixture("receipt-consent");

    try {
        const projectId = await project(app, "receipt-private-project");
        const collaborator = app.config.addUser("Former project", "viewer", undefined, undefined, {
            projectIds: [projectId],
        });
        const { id } = await app.piSessions.create(owner(app), { ...input, projectId });

        await app.commands.note(id, owner(app), "PRIVATE_CONTINUATION");
        await app.commands.updateSession(id, owner(app), { title: "Continued private import" });
        const before = await app.harness.snapshot(SessionsDoc, context);

        for (const existingId of [undefined, Number(id) + 1, String(id)]) {
            await assert.rejects(
                app.piSessions.create(owner(app), {
                    ...input,
                    visibility: "shared",
                    existingId,
                    projectId: null,
                }),
                { status: 409 },
            );
            assert.deepEqual(await app.harness.snapshot(SessionsDoc, context), before);
            assert.equal(app.canSee(collaborator.user, id), false);
        }

        const preview = await app.piSessions.preview(owner(app), { path: source.path });

        assert.equal(preview.existing, Number(id));
        assert.equal(preview.existingTitle, "Continued private import");
        const shared = await app.piSessions.create(owner(app), {
            ...input,
            existingId: preview.existing,
            visibility: "shared",
            projectId: null,
        });

        assert.deepEqual(shared, { id, existing: true });
        assert.equal(app.sessionMeta(id)!.ownerOnly, false);
        assert.equal(app.sessionMeta(id)!.projectId, undefined);
        assert.equal(app.canSee(collaborator.user, id), false);
        assert.match((await modelTexts(app, id)).join("\n"), /PRIVATE_CONTINUATION/);
    } finally {
        await app.close();
    }
});

test("promotion and placement are atomic; share and receipt retries cannot relocate an already-shared import", async () => {
    const { app, input } = await fixture("promotion-placement");

    try {
        const first = await project(app, "first-share-project");
        const second = await project(app, "second-share-project");
        const { id } = await app.piSessions.create(owner(app), { ...input, projectId: first });
        const before = await app.harness.snapshot(SessionsDoc, context);

        await assert.rejects(
            app.piSessions.share(owner(app), id, {
                acknowledged: true,
                projectId: "missing-project",
            }),
            denied,
        );
        assert.deepEqual(await app.harness.snapshot(SessionsDoc, context), before);
        assert.equal(app.sessionMeta(id)!.ownerOnly, true);
        await assert.rejects(
            app.piSessions.create(owner(app), {
                ...input,
                existingId: Number(id),
                visibility: "shared",
                projectId: "missing-project",
            }),
            denied,
        );
        assert.deepEqual(await app.harness.snapshot(SessionsDoc, context), before);
        assert.deepEqual(
            await app.piSessions.create(owner(app), {
                ...input,
                existingId: Number(id),
                visibility: "shared",
                projectId: second,
            }),
            { id, existing: true },
        );
        assert.equal(app.sessionMeta(id)!.projectId, second);

        for (const projectId of [first, null, undefined]) {
            await app.piSessions.share(owner(app), id, { acknowledged: true, projectId });
            assert.equal(app.sessionMeta(id)!.projectId, second);

            for (const visibility of ["owner", "shared"]) {
                const reused = await app.piSessions.create(owner(app), {
                    ...input,
                    visibility,
                    projectId,
                });

                assert.deepEqual(reused, { id, existing: true });
                assert.equal(app.sessionMeta(id)!.ownerOnly, false);
                assert.equal(app.sessionMeta(id)!.projectId, second);
            }
        }
    } finally {
        await app.close();
    }
});

test("a stale private create queued behind sharing cannot downgrade or relocate the imported Chat", async () => {
    const { app, input } = await fixture("queued-private-retry");
    const hold = gate();
    const entered = gate();
    let stale: ReturnType<App["piSessions"]["create"]> | undefined;
    let delayed: ReturnType<typeof mock.method> | undefined;

    try {
        const first = await project(app, "queued-import-original");
        const second = await project(app, "queued-import-shared");
        const { id } = await app.piSessions.create(owner(app), { ...input, projectId: first });
        const commit = app.harness.commit.bind(app.harness);
        let waiting = true;

        delayed = mock.method(
            app.harness,
            "commit",
            async <T>(change: (tx: Tx) => T | Promise<T>, ctx: Context) => {
                if (waiting) {
                    waiting = false;
                    entered.release();
                    await hold.promise;
                }

                return commit(change, ctx);
            },
        );
        stale = app.piSessions.create(owner(app), { ...input, projectId: first });
        await Promise.race([entered.promise, stale]);
        await app.piSessions.share(owner(app), id, { acknowledged: true, projectId: second });
        hold.release();
        assert.deepEqual(await stale, { id, existing: true });
        assert.equal(app.sessionMeta(id)!.ownerOnly, false);
        assert.equal(app.sessionMeta(id)!.projectId, second);
        assert.equal(app.sessions(owner(app)).length, 1);
    } finally {
        hold.release();
        await Promise.allSettled([stale]);
        delayed?.mock.restore();
        await app.close();
    }
});

test("sharing rechecks the pinned owner token after awaited transactional reads and rolls back placement", async () => {
    const { app, input } = await fixture("revoked-token");
    const hold = gate();
    const entered = gate();
    let sharing: ReturnType<App["piSessions"]["share"]> | undefined;
    let delayed: ReturnType<typeof mock.method> | undefined;

    try {
        const projectId = await project(app, "revoked-token-project");
        const { id } = await app.piSessions.create(owner(app), input);
        const original = owner(app);
        const stale = structuredClone(original);
        const before = await app.harness.snapshot(SessionsDoc, context);
        const commit = app.harness.commit.bind(app.harness);

        delayed = mock.method(
            app.harness,
            "commit",
            <T>(change: (tx: Tx) => T | Promise<T>, ctx: Context) =>
                commit(async (tx) => {
                    const doc = tx.doc.bind(tx);
                    const read = mock.method(tx, "doc", async (...args: Parameters<typeof doc>) => {
                        const result = await doc(...args);

                        entered.release();
                        await hold.promise;

                        return result;
                    });

                    try {
                        return await change(tx);
                    } finally {
                        read.mock.restore();
                    }
                }, ctx),
        );
        sharing = app.piSessions.share(original, id, { acknowledged: true, projectId });
        // Attach rejection handling before invalidating the caller while its transaction is paused.
        const rejected = assert.rejects(sharing, denied);

        await Promise.race([entered.promise, sharing]);
        app.config.rotateOwnerToken();
        hold.release();
        await rejected;
        assert.deepEqual(await app.harness.snapshot(SessionsDoc, context), before);
        assert.equal(app.sessionMeta(id)!.ownerOnly, true);
        assert.equal(app.sessionMeta(id)!.projectId, undefined);
        await assert.rejects(app.piSessions.share(stale, id, { acknowledged: true }), denied);
    } finally {
        hold.release();
        await Promise.allSettled([sharing]);
        delayed?.mock.restore();
        await app.close();
    }
});
