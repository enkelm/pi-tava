// Generated sources, temporary SQLite and synthetic discovery only. No real Herdr or signals.
import {
    type App,
    cleanUp,
    context,
    fakeTab,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, mock, test } from "node:test";
import type { Context } from "@earendil-works/chord";
import type { Tx } from "@earendil-works/pi-durable";
import {
    ImportedSessionDoc,
    ImportsDoc,
    PrivateControlDoc,
    SessionsDoc,
    TakeoversDoc,
} from "../src/server/docs.ts";
import { createHandler } from "../src/server/http.ts";
import type { ImportRequest } from "../src/server/pi-sessions.ts";
import { fakeHerdr } from "./active-import-fixture.ts";
import { importFixture } from "./import-fixtures.ts";

async function fixture(name: string) {
    const directory = join(work, name);

    mkdirSync(directory, { recursive: true });
    const source = importFixture(directory);
    const data = join(root, `shared-${name}`);
    const app = await openApp(scriptedModel(), data);

    return { app, source, data, ...fakeHerdr(app, source.path) };
}

function confirm(preview: Awaited<ReturnType<App["piSessions"]["preview"]>>): ImportRequest {
    return {
        path: preview.path,
        sha256: preview.sha256,
        leafId: preview.leafId,
        acknowledged: true,
        model: "faux/faux-vision",
        thinkingLevel: "off",
    };
}

async function moveRequest(app: App) {
    const id = (await app.piSessions.active.list(owner(app))).sessions[0]!.id;
    const preview = await app.piSessions.active.preview(owner(app), { id });

    return { ...confirm(preview), id };
}

function gate() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
        release = resolve;
    });

    return { promise, release };
}

const privateArchive = /ABANDONED_BRANCH|OPAQUE_ARCHIVE_ONLY|importedBy|entryIds|sourceSessionId/;

after(cleanUp);

test("HTTP shared imports reach signed-in unscoped initial/live lists and forks, never archives or anonymous readers", async () => {
    const { app, source } = await fixture("access");
    const guest = app.config.addUser("Guest", "guest");
    const viewer = app.config.addUser("Viewer", "viewer");
    const scoped = app.config.addUser("Other session", "guest", ["999999"]);
    const live = fakeTab(undefined, guest.user);
    const scopedLive = fakeTab(undefined, scoped.user);
    const tabs = [live, scopedLive];
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/`;
    const get = (path: string, token?: string) =>
        fetch(base + path, {
            headers: token ? { authorization: `Bearer ${token}` } : {},
        });
    const post = (path: string, body: unknown, token = app.config.ownerToken) =>
        fetch(base + path, {
            method: "POST",
            headers: {
                authorization: `Bearer ${token}`,
                "x-pocket": "1",
                "content-type": "application/json",
            },
            body: JSON.stringify(body),
        });

    try {
        await app.attach(live.client);
        await app.attach(scopedLive.client);
        const preview = await app.piSessions.preview(owner(app), { path: source.path });
        const input = { ...confirm(preview), visibility: "shared" };

        assert.equal((await post("pi-sessions", input, guest.token)).status, 403);
        assert.equal((await post("pi-sessions", { ...input, acknowledged: false })).status, 400);
        const response = await post("pi-sessions", input);

        assert.equal(response.status, 200);
        const { id } = await response.json();

        assert.equal(app.sessionMeta(id)!.ownerOnly, false);
        assert.equal(app.canSee(guest.user, id), true);
        assert.equal(app.canSee(viewer.user, id), true);
        assert.equal(app.canSee(scoped.user, id), false);
        const invited = app.config.addUser("This session", "viewer", [String(id)]);

        assert.equal(app.canSee(invited.user, id), true);
        assert.deepEqual(app.sessions(scoped.user), []);
        assert.deepEqual(
            (await (await get("sessions", guest.token)).json()).map((s: { id: number }) => s.id),
            [id],
        );
        const initial = fakeTab(id, guest.user);

        tabs.push(initial);
        await app.attach(initial.client);
        assert.match(JSON.stringify(initial.last("sessions")), new RegExp(`"id":${id}`));
        assert.match(JSON.stringify(initial.events), /HISTORICAL_TOOL_RESULT/);
        assert.doesNotMatch(JSON.stringify(initial.events), privateArchive);
        assert.ok(
            !JSON.stringify(initial.events).includes(source.path),
            "source path stays private",
        );
        await until(
            () => JSON.stringify(live.last("sessions")).includes(`"id":${id}`),
            "shared live list",
        );
        await until(
            () => scopedLive.events.filter((e) => e.event === "sessions").length >= 2,
            "scoped live list",
        );
        assert.deepEqual(scopedLive.last("sessions"), []);

        for (const path of ["sessions", `c/${id}/history`, `pi-sessions/${id}/archive`]) {
            assert.equal((await get(path)).status, 401);
        }

        assert.equal((await get(`c/${id}/history`, scoped.token)).status, 404);
        const history = await get(`c/${id}/history`, guest.token);

        assert.equal(history.status, 200);
        assert.doesNotMatch(await history.text(), privateArchive);

        for (const token of [guest.token, viewer.token, scoped.token, invited.token]) {
            assert.equal((await get(`pi-sessions/${id}/archive`, token)).status, 403);
        }

        await assert.rejects(app.piSessions.archive(guest.user, id), { status: 403 });
        assert.equal(
            await (await get(`pi-sessions/${id}/archive`, app.config.ownerToken)).text(),
            source.archive,
        );
        const stored = (await app.harness.snapshot(ImportedSessionDoc, id, context))!;
        const fork = await app.commands.fork(id, guest.user, {
            entryId: stored.source!.entryIds[source.lastAnswer],
        });
        const forkView = fakeTab(fork.id, guest.user);

        tabs.push(forkView);
        await app.attach(forkView.client);
        assert.equal(app.canSee(guest.user, fork.id), true);
        assert.equal(app.canSee(scoped.user, fork.id), false);
        assert.equal(
            app.canSee(invited.user, fork.id),
            false,
            "session invite does not expand to a new fork",
        );
        assert.doesNotMatch(JSON.stringify(forkView.events), privateArchive);
        assert.equal(await app.harness.snapshot(ImportedSessionDoc, fork.id, context), undefined);
        assert.equal((await get(`pi-sessions/${fork.id}/archive`, guest.token)).status, 403);
        assert.equal((await app.harness.inspect(context)).tasks.length, 0);
        assert.equal(readFileSync(source.path, "utf8"), source.archive);
    } finally {
        for (const tab of tabs) {
            app.detach(tab.client);
        }

        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await app.close();
    }
});

test("defaults stay private; preview cannot promote; confirmed retry promotes only the selected import", async () => {
    const { app, source } = await fixture("promotion");
    const guest = app.config.addUser("Guest", "guest").user;

    try {
        const request = confirm(await app.piSessions.preview(owner(app), { path: source.path }));
        const original = await app.piSessions.create(owner(app), request);
        const stored = (await app.harness.snapshot(ImportedSessionDoc, original.id, context))!;
        const fork = await app.commands.fork(original.id, owner(app), {
            entryId: stored.source!.entryIds[source.lastAnswer],
        });
        const alternate = source.source
            .getEntries()
            .find(
                (entry) =>
                    entry.type === "message" &&
                    JSON.stringify(entry.message).includes("Unselected answer"),
            )!;
        const alternative = await app.piSessions.create(owner(app), {
            ...confirm(
                await app.piSessions.preview(owner(app), {
                    path: source.path,
                    leafId: alternate.id,
                }),
            ),
            visibility: "owner",
        });

        assert.equal(app.sessionMeta(original.id)!.ownerOnly, true);
        assert.deepEqual(app.sessions(guest), []);
        await app.piSessions.preview(owner(app), { path: source.path, visibility: "shared" });
        await app.piSessions.prepare(owner(app), { ...request, visibility: "shared" });
        assert.equal(app.canSee(guest, original.id), false);
        await assert.rejects(
            app.piSessions.create(owner(app), {
                ...request,
                visibility: "shared",
                acknowledged: false,
            }),
            { status: 400 },
        );
        const promoted = await app.piSessions.create(owner(app), {
            ...request,
            visibility: "shared",
        });

        assert.deepEqual(promoted, { id: original.id, existing: true });
        assert.equal(app.sessionMeta(original.id)!.ownerOnly, false);

        for (const visibility of [undefined, "owner", "shared"]) {
            assert.deepEqual(
                await app.piSessions.create(owner(app), { ...request, visibility }),
                promoted,
            );
            assert.equal(app.canSee(guest, original.id), true);
        }

        assert.equal(app.canSee(guest, fork.id), false, "old private forks are not promoted");
        assert.equal(
            app.canSee(guest, alternative.id),
            false,
            "another selected branch is not promoted",
        );
        assert.deepEqual(
            await app.harness.snapshot(ImportedSessionDoc, original.id, context),
            stored,
        );
        assert.equal(await app.piSessions.archive(owner(app), original.id), source.archive);
    } finally {
        await app.close();
    }
});

test("saved-file and active previews disclose existing shared imports without publishing or changing visibility", async () => {
    const { app, source } = await fixture("preview-visibility");

    try {
        const initial = await app.piSessions.preview(owner(app), { path: source.path });

        assert.equal(initial.visibility, "owner");
        assert.equal(
            (await app.piSessions.preview(owner(app), { path: source.path, visibility: "shared" }))
                .visibility,
            "shared",
        );
        assert.deepEqual(app.sessions(), []);
        const request = confirm(initial);
        const result = await app.piSessions.create(owner(app), request);
        const privateSessions = await app.harness.snapshot(SessionsDoc, context);

        assert.equal(
            (await app.piSessions.preview(owner(app), { path: source.path })).visibility,
            "owner",
        );
        assert.equal(
            (await app.piSessions.preview(owner(app), { path: source.path, visibility: "shared" }))
                .visibility,
            "shared",
        );
        assert.deepEqual(await app.harness.snapshot(SessionsDoc, context), privateSessions);
        await app.piSessions.create(owner(app), { ...request, visibility: "shared" });
        const sharedSessions = await app.harness.snapshot(SessionsDoc, context);
        const provenance = await app.harness.snapshot(ImportedSessionDoc, result.id, context);
        const index = await app.harness.snapshot(ImportsDoc, context);
        const id = (await app.piSessions.active.list(owner(app))).sessions[0]!.id;

        for (const visibility of [undefined, "owner", "shared"]) {
            assert.equal(
                (await app.piSessions.preview(owner(app), { path: source.path, visibility }))
                    .visibility,
                "shared",
            );
            assert.equal(
                (await app.piSessions.active.preview(owner(app), { id, visibility })).visibility,
                "shared",
            );
        }

        const alternate = source.source
            .getEntries()
            .find(
                (entry) =>
                    entry.type === "message" &&
                    JSON.stringify(entry.message).includes("Unselected answer"),
            )!;

        assert.equal(
            (await app.piSessions.preview(owner(app), { path: source.path, leafId: alternate.id }))
                .visibility,
            "owner",
        );
        assert.deepEqual(await app.harness.snapshot(SessionsDoc, context), sharedSessions);
        assert.deepEqual(
            await app.harness.snapshot(ImportedSessionDoc, result.id, context),
            provenance,
        );
        assert.deepEqual(await app.harness.snapshot(ImportsDoc, context), index);
        assert.equal(await app.harness.snapshot(TakeoversDoc, context), undefined);
    } finally {
        await app.close();
    }
});

test("invalid visibility and absent consent cannot publish or change the source", async () => {
    const { app, source, state } = await fixture("validation");
    const processes = structuredClone(state.table);

    try {
        const request = await moveRequest(app);

        for (const visibility of [null, false, true, 0, "public", "SHARED", "", {}, []]) {
            await assert.rejects(app.piSessions.prepare(owner(app), { ...request, visibility }), {
                status: 400,
            });
            await assert.rejects(
                async () => app.piSessions.active.move(owner(app), { ...request, visibility }),
                { status: 400 },
            );
        }

        await assert.rejects(
            async () =>
                app.piSessions.active.move(owner(app), {
                    ...request,
                    visibility: "shared",
                    acknowledged: false,
                }),
            { status: 400 },
        );
        assert.deepEqual(state.table, processes);
        assert.equal(readFileSync(source.path, "utf8"), source.archive);
        assert.deepEqual(app.sessions(), []);
        assert.deepEqual((await app.harness.snapshot(ImportsDoc, context))?.items ?? {}, {});
    } finally {
        await app.close();
    }
});

test("shared creation and private promotion roll back atomically with the import transaction", async () => {
    const { app, source } = await fixture("rollback");
    const commit = app.harness.commit.bind(app.harness);
    let fault: ReturnType<typeof mock.method> | undefined;
    const failCommit = () =>
        mock.method(app.harness, "commit", <T>(change: (tx: Tx) => T | Promise<T>, ctx: Context) =>
            commit(async (tx) => {
                await change(tx);

                throw new Error("injected before publication");
            }, ctx),
        );

    try {
        const request = confirm(await app.piSessions.preview(owner(app), { path: source.path }));

        fault = failCommit();
        await assert.rejects(
            app.piSessions.create(owner(app), { ...request, visibility: "shared" }),
            /injected/,
        );
        fault.mock.restore();
        assert.deepEqual(app.sessions(), []);
        assert.deepEqual((await app.harness.snapshot(ImportsDoc, context))?.items ?? {}, {});
        assert.deepEqual(
            (await app.harness.commit((tx) => tx.scanConversations({}, 100), context)).items,
            [],
        );
        const original = await app.piSessions.create(owner(app), request);

        fault = failCommit();
        await assert.rejects(
            app.piSessions.create(owner(app), { ...request, visibility: "shared" }),
            /injected/,
        );
        fault.mock.restore();
        assert.equal(app.sessionMeta(original.id)!.ownerOnly, true);
        assert.equal(
            (await app.harness.snapshot(SessionsDoc, context))!.items[String(original.id)]!
                .ownerOnly,
            true,
        );
        await app.piSessions.create(owner(app), { ...request, visibility: "shared" });
        assert.equal(app.sessionMeta(original.id)!.ownerOnly, false);
    } finally {
        fault?.mock.restore();
        await app.close();
    }
});

for (const visibility of ["owner", "shared"] as const) {
    test(`concurrent saved-file ${visibility} copies atomically reuse one conversation with the confirmed visibility`, async () => {
        const { app, source } = await fixture(`concurrent-file-${visibility}`);
        const hold = gate();
        const prepare = app.piSessions.prepare.bind(app.piSessions);
        let waiting = 0;
        const delayed = mock.method(
            app.piSessions,
            "prepare",
            async (...args: Parameters<typeof prepare>) => {
                waiting++;
                await hold.promise;

                return prepare(...args);
            },
        );
        let first: ReturnType<App["piSessions"]["create"]> | undefined;
        let second: typeof first;

        try {
            const request = {
                ...confirm(await app.piSessions.preview(owner(app), { path: source.path })),
                visibility,
            };

            first = app.piSessions.create(owner(app), request);
            second = app.piSessions.create(owner(app), request);
            await until(() => waiting === 2, "both copies waiting at preflight");
            hold.release();
            const results = await Promise.all([first, second]);

            assert.equal(results[0].id, results[1].id);
            assert.equal(Number(results[0].existing) + Number(results[1].existing), 1);
            assert.equal(app.sessions().length, 1);
            assert.equal(app.sessionMeta(results[0].id)!.ownerOnly, visibility === "owner");
            assert.equal(await app.piSessions.archive(owner(app), results[0].id), source.archive);
        } finally {
            hold.release();
            await Promise.allSettled([first, second]);
            delayed.mock.restore();
            await app.close();
        }
    });
}

test("live shared copying neither takes the pane input lock nor clears uncertain Chat delivery", async () => {
    const { app, source, local, state } = await fixture("copy-input-independence");
    const input = { ...(await moveRequest(app)), visibility: "shared" };
    const session = await local.find(input.id);
    const preflight = gate();
    const preparing = gate();
    const nativeInput = gate();
    const prepare = app.piSessions.prepare.bind(app.piSessions);
    const processes = structuredClone(state.table);
    const delayed = mock.method(
        app.piSessions,
        "prepare",
        async (...args: Parameters<typeof prepare>) => {
            preparing.release();
            await preflight.promise;

            return prepare(...args);
        },
    );
    const occupied = local.withTerminalInput(session.socket, undefined, () => nativeInput.promise);
    let moving: ReturnType<App["piSessions"]["active"]["move"]> | undefined;

    try {
        await app.privateSessions.control.admitPrompt(session.socket, session.pane);
        const receipt = await app.harness.snapshot(PrivateControlDoc, context);

        moving = app.piSessions.active.move(owner(app), input);
        await Promise.race([preparing.promise, moving]);
        // The copy reached preflight while native input still owns the entire instance.
        nativeInput.release();
        await occupied;
        assert.equal(
            await local.withTerminalInput(
                session.socket,
                session.pane,
                async () => "input remains available",
            ),
            "input remains available",
        );
        preflight.release();
        const result = await moving;

        assert.equal(app.sessionMeta(result.id)!.ownerOnly, false);
        assert.equal(await app.piSessions.archive(owner(app), result.id), source.archive);
        assert.equal(readFileSync(source.path, "utf8"), source.archive);
        assert.deepEqual(state.table, processes);
        assert.deepEqual(await app.harness.snapshot(PrivateControlDoc, context), receipt);
        assert.match((await local.inputReason(session.socket, session.pane))!, /uncertain/);
        assert.equal((await app.harness.inspect(context)).tasks.length, 0);
    } finally {
        nativeInput.release();
        preflight.release();
        await Promise.allSettled([occupied, moving]);
        delayed.mock.restore();
        await app.close();
    }
});

test("historical takeover records survive reopen unchanged and cannot select, share or recover a source", async () => {
    const initial = await fixture("historical-takeovers");
    let app = initial.app;

    try {
        const active = (await initial.local.list()).sessions[0]!;
        const original = await app.piSessions.create(
            owner(app),
            confirm(await app.piSessions.preview(owner(app), { path: initial.source.path })),
        );
        const missingId = "b".repeat(64);

        await app.harness.commit(async (tx) => {
            const historical = await tx.doc(TakeoversDoc);

            historical.items[active.id] = {
                session: active,
                startedAt: 1,
                visibility: "shared",
            };
            historical.items[missingId] = {
                session: { ...active, id: missingId, path: initial.source.path + ".old" },
                startedAt: 2,
                result: original.id,
                visibility: "shared",
            };
        }, context);
        const historical = await app.harness.snapshot(TakeoversDoc, context);

        await app.close();
        app = await openApp(scriptedModel(), initial.data);
        const recovered = fakeHerdr(app, initial.source.path);
        const listing = await app.piSessions.active.list(owner(app));

        assert.deepEqual(
            listing.sessions.map((session) => session.id),
            [active.id],
        );
        await assert.rejects(
            app.piSessions.active.preview(owner(app), { id: missingId }),
            /changed or exited/,
        );
        const preview = await app.piSessions.active.preview(owner(app), { id: active.id });

        assert.equal(preview.visibility, "owner", "old takeover consent cannot publish a copy");
        const result = await app.piSessions.active.move(owner(app), {
            ...confirm(preview),
            id: active.id,
        });

        assert.deepEqual(result, { id: original.id, existing: true });
        assert.equal(app.sessionMeta(result.id)!.ownerOnly, true);
        assert.deepEqual(await app.harness.snapshot(TakeoversDoc, context), historical);
        assert.deepEqual(recovered.state.table, [recovered.shell, recovered.pi]);
        assert.equal(readFileSync(initial.source.path, "utf8"), initial.source.archive);
    } finally {
        await app.close();
    }
});
