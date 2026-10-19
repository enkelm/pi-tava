// Cache delivery and room projections only: no SSH, native sandbox, sockets, or owner credentials.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import type { Head } from "../src/server/branches.ts";
import type { User } from "../src/server/config.ts";
import { DestinationHeads } from "../src/server/destination-heads.ts";
import { Room, type Client } from "../src/server/room.ts";
import { fakeTab, openApp, owner, scriptedModel } from "./helpers.ts";

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });

    return { promise, resolve, reject };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("destination HEAD cache delivers only actual-user results, refreshes once and drops failed/stale completions", async () => {
    const root = await mkdtemp(join(tmpdir(), "coop-destination-heads-"));
    const app = await openApp(scriptedModel(), join(root, "app"));
    const id = 999 as ConversationId;
    const heads = new DestinationHeads(app);
    const room = new Room(app, id);
    const patches: { mock: { restore(): void } }[] = [];
    const requests: {
        user: User;
        context: Context;
        lookup: ReturnType<typeof deferred<Head | undefined>>;
    }[] = [];
    let location = { kind: "ssh" as const, host: "fixture-a" };
    let cwd = "/remote/project";
    let clock = Date.now();
    let sessions = 0;
    let rooms = 0;
    let local = 0;

    patches.push(mock.method(app, "locationOf", () => location));
    patches.push(mock.method(app, "cwdOf", () => cwd));
    patches.push(mock.method(Date, "now", () => clock));
    patches.push(
        mock.method(app, "scheduleSessions", () => {
            sessions++;
        }),
    );
    patches.push(
        mock.method(room, "schedule", () => {
            rooms++;
        }),
    );
    patches.push(mock.method(app, "openRoom", () => Promise.resolve(room)));
    patches.push(
        mock.method(app.workspace, "head", () => {
            local++;

            return { branch: "local-namesake" };
        }),
    );
    patches.push(
        mock.method(
            app.workspace,
            "destinationHead",
            (_id: ConversationId, user?: User, context?: Context) => {
                assert.ok(user);
                assert.ok(context?.abortSignal);
                const lookup = deferred<Head | undefined>();

                requests.push({ user, context, lookup });

                return lookup.promise;
            },
        ),
    );

    try {
        const person = owner(app);
        const reader = app.config.addUser("Scoped viewer", "viewer", [String(id)]).user;

        assert.equal(heads.peek(id, person), undefined);
        assert.equal(heads.get(id), undefined);
        assert.equal(heads.get(id, { ...person, tokenHash: "stale" }), undefined);
        assert.equal(heads.get(id, person), undefined);
        assert.equal(heads.get(id, person), undefined);
        await settle();
        assert.equal(requests.length, 1, "a pending destination has one lookup");
        assert.equal(requests[0]!.user.id, person.id);
        requests[0]!.lookup.resolve({ branch: "remote-main" });
        await settle();
        assert.deepEqual(heads.get(id, person), { branch: "remote-main" });
        assert.deepEqual(heads.peek(id, person), { branch: "remote-main" });
        assert.equal(heads.peek(id), undefined);
        assert.equal(sessions, 1);
        assert.equal(rooms, 1, "the existing room receives completion without opening another");
        assert.equal(heads.get(id, reader), undefined, "another reader cannot borrow this result");
        await settle();
        assert.equal(requests.length, 2);
        requests[1]!.lookup.resolve({ detached: "abc1234" });
        await settle();
        assert.deepEqual(heads.get(id, reader), { detached: "abc1234" });
        assert.deepEqual(heads.get(id, person), { branch: "remote-main" });
        clock += 3001;
        assert.deepEqual(heads.peek(id, person), { branch: "remote-main" });
        await settle();
        assert.equal(requests.length, 2, "passive sidebar reads never refresh a saved host");
        assert.deepEqual(
            heads.get(id, person),
            { branch: "remote-main" },
            "stale data may render during one refresh",
        );
        heads.get(id, person);
        await settle();
        assert.equal(requests.length, 3);
        requests[2]!.lookup.reject(new Error("fixture auth expired"));
        await settle();
        assert.equal(sessions, 3, "a failed refresh removes its previously displayed branch");
        assert.equal(rooms, 3);
        assert.equal(heads.get(id, person), undefined);
        await settle();
        assert.equal(
            requests.length,
            4,
            "failure is not retained as a successful or negative observation",
        );
        location = { kind: "ssh", host: "fixture-b" };
        requests[3]!.lookup.resolve({ branch: "wrong-destination" });
        await settle();
        assert.equal(sessions, 3, "old destination completion is ignored");
        assert.equal(heads.get(id, person), undefined);
        await settle();
        assert.equal(requests.length, 5);
        requests[4]!.lookup.resolve({ branch: "destination-b" });
        await settle();
        assert.deepEqual(heads.get(id, person), { branch: "destination-b" });
        cwd = "/remote/another-project";
        assert.equal(heads.get(id, reader), undefined);
        await settle();
        assert.equal(requests.length, 6);
        app.config.updateUser(reader.id, { sessions: [] });
        requests[5]!.lookup.resolve({ branch: "revoked-reader" });
        await settle();
        assert.equal(heads.get(id, reader), undefined);
        assert.equal(sessions, 4, "revoked reader completion cannot schedule or populate a view");
        app.config.updateUser(reader.id, { sessions: [String(id)] });
        assert.equal(heads.get(id, reader), undefined);
        await settle();
        reader.tokenHash = "fixture rotated token";
        requests[6]!.lookup.resolve({ branch: "revoked-token" });
        await settle();
        assert.equal(heads.get(id, requests[6]!.user), undefined);
        assert.equal(
            sessions,
            4,
            "a mutated User object cannot resurrect an old-token observation",
        );
        assert.equal(heads.get(id, person), undefined);
        await settle();
        const beforeClose = sessions;

        let joined = false;
        const closing = heads.close().then(() => {
            joined = true;
        });

        assert.equal(requests[7]!.context.abortSignal?.aborted, true);
        await settle();
        assert.equal(
            joined,
            false,
            "shutdown joins transport settlement after requesting cancellation",
        );
        requests[7]!.lookup.resolve({ branch: "after-close" });
        await closing;
        await settle();
        assert.equal(heads.get(id, person), undefined);
        assert.equal(sessions, beforeClose);
        assert.equal(
            local,
            0,
            "remote failures and missing callers never inspect a local namesake",
        );
    } finally {
        for (const request of requests) {
            request.lookup.resolve(undefined);
        }

        await heads.close();
        room.close();

        for (const patch of patches.reverse()) {
            patch.mock.restore();
        }

        await app.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("destination HEAD cache bounds active lookups and keeps local observation synchronous", async () => {
    const root = await mkdtemp(join(tmpdir(), "coop-head-bounds-"));
    const app = await openApp(scriptedModel(), join(root, "app"));
    const heads = new DestinationHeads(app);
    const patches: { mock: { restore(): void } }[] = [];
    const requests: ReturnType<typeof deferred<Head | undefined>>[] = [];
    let remote = true;
    let delivered = 0;

    patches.push(
        mock.method(app, "locationOf", () =>
            remote ? { kind: "ssh", host: "fixture" } : undefined,
        ),
    );
    patches.push(mock.method(app, "cwdOf", (id: ConversationId) => `/workspace/${id}`));
    patches.push(
        mock.method(app, "scheduleSessions", () => {
            delivered++;
        }),
    );
    patches.push(mock.method(app.workspace, "head", () => ({ branch: "local" })));
    patches.push(
        mock.method(app.workspace, "destinationHead", () => {
            const lookup = deferred<Head | undefined>();

            requests.push(lookup);

            return lookup.promise;
        }),
    );

    try {
        for (let id = 1; id <= 600; id++) {
            assert.equal(heads.peek(id as ConversationId, owner(app)), undefined);
        }

        await settle();
        assert.equal(
            requests.length,
            0,
            "a sidebar containing saved remote threads opens no connections",
        );

        for (let id = 1; id <= 600; id++) {
            assert.equal(heads.get(id as ConversationId, owner(app)), undefined);
        }

        await settle();
        assert.ok(
            requests.length > 0 && requests.length < 600,
            "unsettled reads cannot grow without a bound",
        );
        const started = requests.length;

        for (let id = 1; id <= 600; id++) {
            heads.get(id as ConversationId, owner(app));
        }

        await settle();
        assert.equal(
            requests.length,
            started,
            "pending reads are not evicted and restarted to evade the bound",
        );
        remote = false;
        assert.equal(heads.peek(1 as ConversationId), undefined);
        assert.deepEqual(heads.get(1 as ConversationId), { branch: "local" });
        const closing = heads.close();

        for (const request of requests) {
            request.resolve({ branch: "closed" });
        }

        await closing;
        await settle();
        assert.equal(delivered, 0);
    } finally {
        for (const request of requests) {
            request.resolve(undefined);
        }

        await heads.close();

        for (const patch of patches.reverse()) {
            patch.mock.restore();
        }

        await app.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("room branch delivery and quiet refresh use each attached reader without cross-caller head oscillation", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "coop-room-heads-"));
    const app = await openApp(scriptedModel(), join(root, "app"));
    const patches: { mock: { restore(): void } }[] = [];
    const asks: (string | undefined)[] = [];
    const infoUsers: (string | undefined)[] = [];
    let sessions = 0;
    const first = owner(app);
    const second = app.config.addUser("Second reader", "viewer").user;
    const values = new Map<string, Head>([
        [first.id, { branch: "first" }],
        [second.id, { detached: "abc1234" }],
    ]);

    try {
        const { id } = await app.commands.createSession(first, { cwd: root, threadType: "chat" });
        const actualInfo = app.conversationInfo.bind(app);

        patches.push(
            mock.method(app, "workspaceHead", (_id: ConversationId, user?: User) => {
                asks.push(user?.id);

                return user === undefined ? undefined : values.get(user.id);
            }),
        );
        patches.push(
            mock.method(app, "conversationInfo", (room: Room, user?: User) => {
                infoUsers.push(user?.id);

                return actualInfo(room, user);
            }),
        );
        patches.push(
            mock.method(app, "scheduleSessions", () => {
                sessions++;
            }),
        );
        t.mock.timers.enable({ apis: ["setInterval"] });
        const room = await app.room(id);

        const makeClient = (user: User) => {
            const events: { event: string; data: unknown }[] = [];
            const client: Client = {
                id: user.id,
                connection: user.id,
                user,
                conversationId: id,
                sentEntries: new Set(),
                orderKey: "",
                protocol: 2,
                send: (event, data) => {
                    events.push({ event, data });
                },
            };

            room.clients.add(client);

            return { client, events };
        };

        const a = makeClient(first);
        const b = makeClient(second);

        room.push(a.client, true);
        room.push(b.client, true);
        assert.deepEqual((a.events.at(-1)!.data as { branch: Head }).branch, { branch: "first" });
        assert.deepEqual((b.events.at(-1)!.data as { branch: Head }).branch, {
            detached: "abc1234",
        });
        assert.deepEqual(infoUsers, [first.id, second.id]);

        for (let count = 0; count < 4; count++) {
            room.push(a.client, false);
            room.push(b.client, false);
        }

        assert.equal(sessions, 0, "different callers do not repeatedly invalidate one shared head");
        asks.length = 0;
        t.mock.timers.tick(3000);
        assert.ok(asks.includes(first.id) && asks.includes(second.id));
        assert.ok(!asks.includes(undefined), "quiet refresh never borrows anonymous attribution");
        values.set(second.id, { branch: "second-updated" });
        t.mock.timers.tick(3000);
        room.push(b.client, false);
        assert.deepEqual((b.events.at(-1)!.data as { branch: Head }).branch, {
            branch: "second-updated",
        });
        assert.equal(sessions, 1);
        room.clients.clear();
    } finally {
        t.mock.timers.reset();

        for (const patch of patches.reverse()) {
            patch.mock.restore();
        }

        await app.close();
        await rm(root, { recursive: true, force: true });
    }
});

// An abandoned room projection has no HTTP reader to abort it. Visible tab ownership must
// release that separate HEAD lifecycle, without cancelling another visible tab's observation.
test("remote HEAD work stops when its last visible tab leaves and resumes only on demand", async () => {
    const root = await mkdtemp(join(tmpdir(), "coop-head-visibility-"));
    const app = await openApp(scriptedModel(), join(root, "app"));
    const id = 999 as ConversationId;
    const person = owner(app);
    const first = fakeTab(undefined, person);
    const second = fakeTab(undefined, person);
    const requests: { context: Context; lookup: ReturnType<typeof deferred<Head | undefined>> }[] =
        [];
    const patches = [
        mock.method(app, "locationOf", () => ({ kind: "ssh" as const, host: "fixture" })),
        mock.method(
            app.workspace,
            "destinationHead",
            (_id: ConversationId, _user: User | undefined, context: Context) => {
                const lookup = deferred<Head | undefined>();

                requests.push({ context, lookup });

                return lookup.promise;
            },
        ),
    ];

    try {
        await app.attach(first.client);
        await app.attach(second.client);
        first.client.conversationId = id;
        second.client.conversationId = id;
        app.workspaceHead(id, person);
        await settle();
        assert.equal(requests.length, 1);
        app.setVisible(person, first.client.id, false);
        assert.equal(
            requests[0]!.context.abortSignal?.aborted,
            false,
            "another visible tab still owns the read",
        );
        app.setVisible(person, second.client.id, false);
        assert.equal(
            requests[0]!.context.abortSignal?.aborted,
            true,
            "the last visible reader releases its HEAD work",
        );
        requests[0]!.lookup.resolve({ branch: "abandoned" });
        await settle();
        assert.equal(app.workspaceHead(id, person), undefined);
        await settle();
        assert.equal(requests.length, 1, "hidden projections do not restart HEAD");
        app.setVisible(person, first.client.id, true);
        assert.equal(requests.length, 1, "visibility is not a poller");
        app.workspaceHead(id, person);
        await settle();
        assert.equal(requests.length, 2);
        app.detach(first.client);
        assert.equal(
            requests[1]!.context.abortSignal?.aborted,
            true,
            "disconnect releases the visible reader too",
        );
        requests[1]!.lookup.resolve(undefined);
    } finally {
        for (const request of requests) {
            request.lookup.resolve(undefined);
        }

        app.detach(first.client);
        app.detach(second.client);
        await app.close();

        for (const patch of patches.reverse()) {
            patch.mock.restore();
        }

        await rm(root, { recursive: true, force: true });
    }
});
