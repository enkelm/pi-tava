// Generated sources, temporary SQLite and fake process controls only. No real Herdr or signals.
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
import { appendFileSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, mock, test } from "node:test";
import type { Context } from "@earendil-works/chord";
import type { Tx } from "@earendil-works/pi-durable";
import { ImportedSessionDoc, ImportsDoc, SessionsDoc, TakeoversDoc } from "../src/server/docs.ts";
import { createHandler } from "../src/server/http.ts";
import type { ImportRequest } from "../src/server/imports.ts";
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

function confirm(preview: Awaited<ReturnType<App["imports"]["preview"]>>): ImportRequest {
    return {
        path: preview.path,
        sha256: preview.sha256,
        leafId: preview.leafId,
        stopped: true,
        acknowledged: true,
        model: "faux/faux-vision",
        thinkingLevel: "off",
    };
}

async function moveRequest(app: App) {
    const id = (await app.imports.active.list(owner(app))).sessions[0]!.id;
    const preview = await app.imports.active.preview(owner(app), { id });

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

test("shared imports reach signed-in unscoped initial/live lists and forks, never archives or anonymous readers", async () => {
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
        const preview = await app.imports.preview(owner(app), { path: source.path });
        const input = { ...confirm(preview), visibility: "shared" };

        assert.equal((await post("imports", input, guest.token)).status, 403);
        assert.equal((await post("imports", { ...input, acknowledged: false })).status, 400);
        const response = await post("imports", input);

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

        for (const path of ["sessions", `c/${id}/history`, `imports/${id}/archive`]) {
            assert.equal((await get(path)).status, 401);
        }

        assert.equal((await get(`c/${id}/history`, scoped.token)).status, 404);
        const history = await get(`c/${id}/history`, guest.token);

        assert.equal(history.status, 200);
        assert.doesNotMatch(await history.text(), privateArchive);

        for (const token of [guest.token, viewer.token, scoped.token, invited.token]) {
            assert.equal((await get(`imports/${id}/archive`, token)).status, 403);
        }

        await assert.rejects(app.imports.archive(guest.user, id), { status: 403 });
        assert.equal(
            await (await get(`imports/${id}/archive`, app.config.ownerToken)).text(),
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
        assert.equal((await get(`imports/${fork.id}/archive`, guest.token)).status, 403);
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
        const request = confirm(await app.imports.preview(owner(app), { path: source.path }));
        const original = await app.imports.create(owner(app), request);
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
        const alternative = await app.imports.create(owner(app), {
            ...confirm(
                await app.imports.preview(owner(app), { path: source.path, leafId: alternate.id }),
            ),
            visibility: "owner",
        });

        assert.equal(app.sessionMeta(original.id)!.ownerOnly, true);
        assert.deepEqual(app.sessions(guest), []);
        await app.imports.preview(owner(app), { path: source.path, visibility: "shared" });
        await app.imports.prepare(owner(app), { ...request, visibility: "shared" });
        assert.equal(app.canSee(guest, original.id), false);
        await assert.rejects(
            app.imports.create(owner(app), {
                ...request,
                visibility: "shared",
                acknowledged: false,
            }),
            { status: 400 },
        );
        const promoted = await app.imports.create(owner(app), { ...request, visibility: "shared" });

        assert.deepEqual(promoted, { id: original.id, existing: true });
        assert.equal(app.sessionMeta(original.id)!.ownerOnly, false);

        for (const visibility of [undefined, "owner", "shared"]) {
            assert.deepEqual(
                await app.imports.create(owner(app), { ...request, visibility }),
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
        assert.equal(await app.imports.archive(owner(app), original.id), source.archive);
    } finally {
        await app.close();
    }
});

test("saved-file and active previews disclose existing shared imports without publishing or changing visibility", async () => {
    const { app, source } = await fixture("preview-visibility");

    try {
        const initial = await app.imports.preview(owner(app), { path: source.path });

        assert.equal(initial.visibility, "owner");
        assert.equal(
            (await app.imports.preview(owner(app), { path: source.path, visibility: "shared" }))
                .visibility,
            "shared",
        );
        assert.deepEqual(app.sessions(), []);
        const request = confirm(initial);
        const result = await app.imports.create(owner(app), request);
        const privateSessions = await app.harness.snapshot(SessionsDoc, context);

        assert.equal(
            (await app.imports.preview(owner(app), { path: source.path })).visibility,
            "owner",
        );
        assert.equal(
            (await app.imports.preview(owner(app), { path: source.path, visibility: "shared" }))
                .visibility,
            "shared",
        );
        assert.deepEqual(await app.harness.snapshot(SessionsDoc, context), privateSessions);
        await app.imports.create(owner(app), { ...request, visibility: "shared" });
        const sharedSessions = await app.harness.snapshot(SessionsDoc, context);
        const provenance = await app.harness.snapshot(ImportedSessionDoc, result.id, context);
        const index = await app.harness.snapshot(ImportsDoc, context);
        const id = (await app.imports.active.list(owner(app))).sessions[0]!.id;

        for (const visibility of [undefined, "owner", "shared"]) {
            assert.equal(
                (await app.imports.preview(owner(app), { path: source.path, visibility }))
                    .visibility,
                "shared",
            );
            assert.equal(
                (await app.imports.active.preview(owner(app), { id, visibility })).visibility,
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
            (await app.imports.preview(owner(app), { path: source.path, leafId: alternate.id }))
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

test("invalid visibility and absent consent fail before any fake signal or reservation", async () => {
    const { app, state } = await fixture("validation");

    try {
        const request = await moveRequest(app);

        for (const visibility of [null, false, true, 0, "public", "SHARED", "", {}, []]) {
            await assert.rejects(app.imports.prepare(owner(app), { ...request, visibility }), {
                status: 400,
            });
            await assert.rejects(
                async () => app.imports.active.move(owner(app), { ...request, visibility }),
                { status: 400 },
            );
        }

        await assert.rejects(
            async () =>
                app.imports.active.move(owner(app), {
                    ...request,
                    visibility: "shared",
                    acknowledged: false,
                }),
            { status: 400 },
        );
        assert.deepEqual(state.signals, []);
        assert.deepEqual(app.sessions(), []);
        assert.deepEqual((await app.harness.snapshot(TakeoversDoc, context))?.items ?? {}, {});
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
        const request = confirm(await app.imports.preview(owner(app), { path: source.path }));

        fault = failCommit();
        await assert.rejects(
            app.imports.create(owner(app), { ...request, visibility: "shared" }),
            /injected/,
        );
        fault.mock.restore();
        assert.deepEqual(app.sessions(), []);
        assert.deepEqual((await app.harness.snapshot(ImportsDoc, context))?.items ?? {}, {});
        assert.deepEqual(
            (await app.harness.commit((tx) => tx.scanConversations({}, 100), context)).items,
            [],
        );
        const original = await app.imports.create(owner(app), request);

        fault = failCommit();
        await assert.rejects(
            app.imports.create(owner(app), { ...request, visibility: "shared" }),
            /injected/,
        );
        fault.mock.restore();
        assert.equal(app.sessionMeta(original.id)!.ownerOnly, true);
        assert.equal(
            (await app.harness.snapshot(SessionsDoc, context))!.items[String(original.id)]!
                .ownerOnly,
            true,
        );
        await app.imports.create(owner(app), { ...request, visibility: "shared" });
        assert.equal(app.sessionMeta(original.id)!.ownerOnly, false);
    } finally {
        fault?.mock.restore();
        await app.close();
    }
});

for (const firstVisibility of ["owner", "shared"] as const) {
    test(`saved-file concurrent ${firstVisibility} imports deduplicate and reject conflicting visibility`, async () => {
        const { app, source } = await fixture(`concurrent-file-${firstVisibility}`);
        const hold = gate();
        const prepare = app.imports.prepare.bind(app.imports);
        let waiting = false;
        const delayed = mock.method(
            app.imports,
            "prepare",
            async (...args: Parameters<typeof prepare>) => {
                waiting = true;
                await hold.promise;

                return prepare(...args);
            },
        );

        try {
            const request = {
                ...confirm(await app.imports.preview(owner(app), { path: source.path })),
                visibility: firstVisibility,
            };
            const first = app.imports.create(owner(app), request);

            await until(() => waiting, "import waiting at preflight");
            await assert.rejects(
                app.imports.create(owner(app), {
                    ...request,
                    visibility: firstVisibility === "owner" ? "shared" : "owner",
                }),
                { status: 409 },
            );
            const matching = app.imports.create(owner(app), request);

            hold.release();
            const results = await Promise.all([first, matching]);

            assert.equal(results[0].id, results[1].id);
            assert.equal(Number(results[0].existing) + Number(results[1].existing), 1);
            assert.equal(app.sessions().length, 1);
            assert.equal(app.sessionMeta(results[0].id)!.ownerOnly, firstVisibility === "owner");
        } finally {
            hold.release();
            delayed.mock.restore();
            await app.close();
        }
    });

    test(`active concurrent ${firstVisibility} requests keep the same promise and reject conflicting consent`, async () => {
        const { app, local, state } = await fixture(`concurrent-active-${firstVisibility}`);
        const hold = gate();
        const stop = local.stop.bind(local);
        let waiting = false;

        local.stop = async (session) => {
            waiting = true;
            await hold.promise;
            await stop(session);
        };

        try {
            const request = { ...(await moveRequest(app)), visibility: firstVisibility };
            const session = await local.find(request.id);
            const first = app.imports.active.move(owner(app), request);

            await until(() => waiting, "move waiting before fake stop");
            assert.equal(app.imports.active.move(owner(app), request), first);
            await assert.rejects(
                async () =>
                    app.imports.active.move(owner(app), {
                        ...request,
                        visibility: firstVisibility === "owner" ? "shared" : "owner",
                    }),
                { status: 409 },
            );
            await assert.rejects(
                async () => app.imports.active.move(owner(app), { ...request, visibility: null }),
                { status: 400 },
            );
            await assert.rejects(
                async () =>
                    app.imports.active.move(owner(app), { ...request, acknowledged: false }),
                { status: 400 },
            );
            await assert.rejects(
                local.withPane(session.socket, session.pane, async () => {
                    assert.fail("pane operation entered during stop");
                }),
                { status: 409 },
            );
            assert.deepEqual(state.signals, []);
            assert.equal(
                (await app.imports.active.list(owner(app))).sessions.find(
                    (item) => item.id === request.id,
                )!.visibility,
                firstVisibility,
            );
            assert.equal(
                (await app.imports.active.preview(owner(app), { id: request.id })).visibility,
                firstVisibility,
            );
            hold.release();
            const result = await first;

            assert.equal(state.signals.length, 1);
            assert.equal(app.sessionMeta(result.id)!.ownerOnly, firstVisibility === "owner");
            assert.equal(
                (await app.harness.snapshot(TakeoversDoc, context))!.items[request.id]!.visibility,
                firstVisibility,
            );
        } finally {
            hold.release();
            await app.close();
        }
    });
}

test("completed legacy takeovers promote after reopen without source/process access and never downgrade", async () => {
    const initial = await fixture("completed");
    let app = initial.app;

    try {
        const request = await moveRequest(app);
        const result = await app.imports.active.move(owner(app), request);

        await app.harness.commit(async (tx) => {
            const stored = await tx.doc(TakeoversDoc);

            delete stored.items[request.id]!.visibility;
        }, context);
        await app.close();
        app = await openApp(scriptedModel(), initial.data);
        unlinkSync(initial.source.path);

        const unexpected = async (): Promise<never> => {
            throw new Error("must not inspect a completed source");
        };

        app.imports.active.local.list = unexpected;
        app.imports.active.local.exited = unexpected;
        app.imports.active.local.stop = unexpected;
        app.imports.active.local.withPane = unexpected;
        assert.equal(app.sessionMeta(result.id)!.ownerOnly, true);
        const minimal = { id: request.id, acknowledged: true };

        await assert.rejects(
            async () =>
                app.imports.active.move(owner(app), {
                    ...minimal,
                    visibility: "shared",
                    acknowledged: false,
                }),
            { status: 400 },
        );
        await assert.rejects(
            async () => app.imports.active.move(owner(app), { ...minimal, visibility: "invalid" }),
            { status: 400 },
        );
        assert.deepEqual(
            await app.imports.active.move(owner(app), { ...minimal, visibility: "shared" }),
            { id: result.id, existing: true },
        );
        assert.equal(app.sessionMeta(result.id)!.ownerOnly, false);

        for (const visibility of [undefined, "owner", "shared"]) {
            assert.deepEqual(
                await app.imports.active.move(owner(app), { ...minimal, visibility }),
                { id: result.id, existing: true },
            );
            assert.equal(app.sessionMeta(result.id)!.ownerOnly, false);
        }

        assert.equal(await app.imports.archive(owner(app), result.id), initial.source.archive);
        assert.equal(initial.state.signals.length, 1);
    } finally {
        await app.close();
    }
});

for (const originalVisibility of [undefined, "owner", "shared"]) {
    test(`unfinished ${originalVisibility ?? "legacy"} takeover persists consent; preview never widens; explicit retry recovers`, async () => {
        const initial = await fixture(`recovery-${originalVisibility ?? "legacy"}`);
        let app = initial.app;
        const signal = initial.local.signal;

        initial.local.signal = (pid) => {
            const result = signal(pid);

            appendFileSync(initial.source.path, "\n");

            return result;
        };

        try {
            const request = await moveRequest(app);

            await assert.rejects(
                app.imports.active.move(owner(app), { ...request, visibility: originalVisibility }),
                /Pi has stopped.*preview and retry/,
            );
            assert.equal(initial.state.signals.length, 1);

            if (originalVisibility === undefined) {
                await app.harness.commit(async (tx) => {
                    const stored = await tx.doc(TakeoversDoc);

                    delete stored.items[request.id]!.visibility;
                }, context);
            }

            const before = await app.harness.snapshot(TakeoversDoc, context);

            await app.close();
            app = await openApp(scriptedModel(), initial.data);
            const recovered = fakeHerdr(app, initial.source.path);

            recovered.state.table = [recovered.shell];
            recovered.state.agent = "";
            const expectedVisibility = originalVisibility === "shared" ? "shared" : "owner";
            const listing = await app.imports.active.list(owner(app));
            const recovery = listing.sessions.find((session) => session.id === request.id)!;
            const preview = await app.imports.active.preview(owner(app), { id: request.id });

            assert.equal(recovery.recovery, true);
            assert.equal(recovery.visibility, expectedVisibility);
            assert.equal(preview.visibility, expectedVisibility);
            assert.equal(
                (
                    await app.imports.active.preview(owner(app), {
                        id: request.id,
                        visibility: "shared",
                    })
                ).visibility,
                "shared",
            );

            if (originalVisibility === "shared") {
                await assert.rejects(
                    app.imports.active.preview(owner(app), { id: request.id, visibility: "owner" }),
                    { status: 409 },
                );
                await assert.rejects(
                    app.imports.active.move(owner(app), {
                        ...confirm(preview),
                        id: request.id,
                        visibility: "owner",
                    }),
                    { status: 409 },
                );
            }

            assert.deepEqual(await app.harness.snapshot(TakeoversDoc, context), before);
            assert.deepEqual(app.sessions(), []);
            assert.deepEqual(recovered.state.signals, []);
            // Upgrade a private reservation explicitly; a legacy retry must retain already-confirmed sharing.
            const visibility = originalVisibility === "owner" ? "shared" : undefined;
            const result = await app.imports.active.move(owner(app), {
                ...confirm(preview),
                id: request.id,
                visibility,
            });

            assert.equal(app.sessionMeta(result.id)!.ownerOnly, originalVisibility === undefined);
            assert.deepEqual(recovered.state.signals, []);
            assert.equal(
                (await app.harness.snapshot(TakeoversDoc, context))!.items[request.id]!.result,
                result.id,
            );

            if (originalVisibility === "shared") {
                assert.deepEqual(
                    await app.imports.active.move(owner(app), {
                        id: request.id,
                        acknowledged: true,
                        visibility: "owner",
                    }),
                    { id: result.id, existing: true },
                );
                assert.equal(app.sessionMeta(result.id)!.ownerOnly, false);
            }
        } finally {
            await app.close();
        }
    });
}

test("an in-flight legacy recovery cannot accept explicit owner intent when it inherits shared consent", async () => {
    const { app, local, state, shell } = await fixture("inherited-concurrent");
    const hold = gate();
    const prepare = app.imports.prepare.bind(app.imports);
    let preparing = false;
    const delayed = mock.method(
        app.imports,
        "prepare",
        async (...args: Parameters<typeof prepare>) => {
            preparing = true;
            await hold.promise;

            return prepare(...args);
        },
    );

    try {
        const request = await moveRequest(app);
        const session = await local.find(request.id);

        await app.harness.commit(async (tx) => {
            const document = await tx.doc(TakeoversDoc);

            document.items[request.id] = { session, startedAt: Date.now(), visibility: "shared" };
        }, context);
        state.table = [shell];
        state.agent = "";
        const first = app.imports.active.move(owner(app), request);

        await until(() => preparing, "legacy recovery preflight");
        assert.equal(app.imports.active.move(owner(app), request), first);
        await assert.rejects(
            app.imports.active.move(owner(app), { ...request, visibility: "owner" }),
            { status: 409 },
        );
        assert.deepEqual(state.signals, []);
        hold.release();
        const result = await first;

        assert.equal(app.sessionMeta(result.id)!.ownerOnly, false);
        assert.deepEqual(state.signals, []);
    } finally {
        hold.release();
        delayed.mock.restore();
        await app.close();
    }
});

test("the shared pane lock covers preflight through publication and refuses takeover during another pane operation", async () => {
    const { app, local, state } = await fixture("pane-lock");
    const preflight = gate();
    const publication = gate();
    const busy = gate();
    const prepare = app.imports.prepare.bind(app.imports);
    const create = app.imports.create.bind(app.imports);
    let preparing = false;
    let creating = false;
    const prepareMock = mock.method(
        app.imports,
        "prepare",
        async (...args: Parameters<typeof prepare>) => {
            preparing = true;
            await preflight.promise;

            return prepare(...args);
        },
    );
    const createMock = mock.method(
        app.imports,
        "create",
        async (...args: Parameters<typeof create>) => {
            creating = true;
            await publication.promise;

            return create(...args);
        },
    );

    try {
        const request = { ...(await moveRequest(app)), visibility: "shared" };
        const session = await local.find(request.id);
        const occupied = local.withPane(session.socket, session.pane, () => busy.promise);

        await assert.rejects(app.imports.active.move(owner(app), request), { status: 409 });
        assert.equal(preparing, false);
        assert.deepEqual(state.signals, []);
        assert.deepEqual((await app.harness.snapshot(TakeoversDoc, context))?.items ?? {}, {});
        busy.release();
        await occupied;
        const moving = app.imports.active.move(owner(app), request);
        const refusesPaneOperation = () =>
            assert.rejects(
                local.withPane(session.socket, session.pane, async () => {
                    assert.fail("pane operation entered during takeover");
                }),
                { status: 409 },
            );

        await until(() => preparing, "preflight under pane lock");
        await refusesPaneOperation();
        assert.deepEqual(state.signals, []);
        preflight.release();
        await until(() => creating, "publication under pane lock");
        await refusesPaneOperation();
        assert.equal(state.signals.length, 1);
        publication.release();
        const result = await moving;

        assert.equal(app.sessionMeta(result.id)!.ownerOnly, false);
        assert.equal(
            await local.withPane(session.socket, session.pane, async () => "released"),
            "released",
        );
    } finally {
        busy.release();
        preflight.release();
        publication.release();
        prepareMock.mock.restore();
        createMock.mock.restore();
        await app.close();
    }
});
