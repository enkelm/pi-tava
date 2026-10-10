// Generated journals and synthetic Herdr replies only. No real Herdr sockets or processes are touched.
import { cleanUp, context, openApp, owner, root, scriptedModel, until, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { createHandler } from "../src/server/http.ts";
import { projectJournal, readJournal } from "../src/server/private-sessions/journal.ts";
import { PrivateSessions } from "../src/server/private-sessions.ts";
import { fakeHerdr } from "./active-import-fixture.ts";
import { importFixture } from "./import-fixtures.ts";

after(cleanUp);

const longRepoKey = `/repos/${"k".repeat(500)}`;

async function fixture(name: string) {
    const directory = join(work, name);

    mkdirSync(directory);
    const checkout = join(directory, "checkout");
    const linked = join(directory, "linked");
    const linkedGit = join(checkout, ".git", "worktrees", "linked");

    mkdirSync(join(checkout, "src"), { recursive: true });
    mkdirSync(linkedGit, { recursive: true });
    mkdirSync(linked);
    writeFileSync(join(checkout, ".git", "HEAD"), "ref: refs/heads/local-main\n");
    writeFileSync(join(linked, ".git"), `gitdir: ${linkedGit}\n`);
    writeFileSync(join(linkedGit, "HEAD"), "ref: refs/heads/worktree/feature\n");
    const source = importFixture(directory);
    const model = scriptedModel();
    const app = await openApp(model, join(root, name));
    const fake = fakeHerdr(app, source.path);
    const original = fake.local.request;
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const options = {
        unavailable: false,
        failPrompt: false,
        duringRead: () => {},
        promptGate: Promise.resolve(),
    };

    fake.state.omitArgv = true;
    fake.local.sockets = async () => [
        "/synthetic/herdr.sock",
        "/synthetic/sessions/Research/herdr.sock",
        ...(options.unavailable ? ["/synthetic/sessions/Offline/herdr.sock"] : []),
    ];

    fake.local.request = async <T>(socket: string, method: string, params = {}): Promise<T> => {
        calls.push({ method, params });

        if (socket.includes("Offline")) {
            throw new Error("offline");
        }

        if (method === "session.snapshot") {
            if (socket.includes("Research")) {
                return {
                    snapshot: {
                        workspaces: [
                            {
                                workspace_id: "research",
                                label: "Research workspace",
                                active_tab_id: "r:t1",
                                agent_status: "working",
                                custom_label: false,
                                worktree: {
                                    repo_key: "/repos/example",
                                    repo_name: "\u001b[32mExample\u001b[0m\u0000 project",
                                    is_linked_worktree: true,
                                    checkout_path: linked,
                                    repo_root: checkout,
                                },
                            },
                            {
                                workspace_id: "empty",
                                label: "Empty workspace",
                                active_tab_id: {},
                                agent_status: [],
                                custom_label: "true",
                                branch: "bad\u0000branch",
                                worktree: {
                                    repo_key: "/repos/example",
                                    repo_name: "Example project",
                                    is_linked_worktree: "true",
                                    checkout_path: "relative/checkout",
                                    repo_root: checkout,
                                },
                            },
                            { workspace_id: "cwd-only", label: "Example project worktree" },
                            ...[longRepoKey + "/a", longRepoKey + "/b"].map((key, index) => ({
                                workspace_id: `long-${index}`,
                                label: "Long repository",
                                worktree: {
                                    repo_key: key,
                                    repo_name: "L".repeat(500),
                                    is_linked_worktree: index === 1,
                                },
                            })),
                            ...["k".repeat(4097), "bad\u001b[31mkey"].map((key, index) => ({
                                workspace_id: `invalid-${index}`,
                                label: "Invalid repository",
                                worktree: {
                                    repo_key: key,
                                    repo_name: "Invalid repository",
                                    is_linked_worktree: true,
                                },
                            })),
                            {
                                workspace_id: "unsafe-path",
                                label: "Unsafe path",
                                worktree: {
                                    repo_key: "/repos/safe-key",
                                    repo_name: "Safe name",
                                    is_linked_worktree: false,
                                    checkout_path: ".",
                                    repo_root: checkout,
                                },
                            },
                        ],
                        tabs: [
                            { workspace_id: "research", tab_id: "r:t1", label: "Notes" },
                            { workspace_id: "research", tab_id: "r:t2", label: "Inactive tab" },
                            { workspace_id: "empty", tab_id: "e:t1", label: "Empty tab" },
                        ],
                        panes: [
                            {
                                pane_id: "r:p1",
                                workspace_id: "research",
                                tab_id: "r:t1",
                                terminal_id: "rt",
                                agent: "codex",
                                agent_status: "working",
                                label: "Other agent",
                                cwd: "/example/notes",
                            },
                            {
                                pane_id: "cwd:p1",
                                workspace_id: "cwd-only",
                                tab_id: "cwd:t1",
                                cwd: join(checkout, "src"),
                            },
                            {
                                pane_id: "absent:p1",
                                workspace_id: "absent-workspace",
                                tab_id: "absent:t1",
                                label: "Missing workspace row",
                            },
                        ],
                    },
                } as T;
            }

            const value = await original<{
                snapshot: { workspaces: unknown[]; panes: Record<string, unknown>[] };
            }>(socket, method);

            return {
                snapshot: {
                    ...value.snapshot,
                    workspaces: value.snapshot.workspaces.map((row) => ({
                        ...(row as Record<string, unknown>),
                        active_tab_id: "tab",
                        agent_status: "done",
                        custom_label: true,
                        branch: "wire/main",
                        worktree: {
                            repo_key: "/repos/example",
                            repo_name: "Example project",
                            is_linked_worktree: false,
                            checkout_path: checkout,
                            repo_root: checkout,
                        },
                    })),
                    tabs: [{ workspace_id: "workspace", tab_id: "tab", label: "Main tab" }],
                    panes: [
                        ...value.snapshot.panes.map((pane) => ({
                            ...pane,
                            tab_id: "tab",
                            terminal_id: "terminal-1",
                        })),
                        {
                            pane_id: "shell",
                            workspace_id: "workspace",
                            tab_id: "tab",
                            terminal_id: "terminal-shell",
                            cwd: "/example/project",
                            label: "Shell pane",
                        },
                    ],
                },
            } as T;
        }

        if (method === "pane.read") {
            options.duringRead();

            return {
                read: {
                    pane_id: (params as { pane_id: string }).pane_id,
                    text: "\u001b[32mLIVE_PRIVATE_OUTPUT\u001b[0m",
                    revision: 1,
                },
            } as T;
        }

        if (method === "agent.prompt") {
            await options.promptGate;

            if (options.failPrompt) {
                throw new Error("reply lost after delivery");
            }

            return { type: "agent_prompted", agent: { pane_id: "pane", agent: "pi" } } as T;
        }

        return original(socket, method, params);
    };

    const list = await app.privateSessions.list(owner(app));
    const pane = list.instances[0]!.workspaces[0]!.tabs[0]!.panes[0]!;

    return { app, source, model, ...fake, calls, options, pane };
}

test("owner navigation includes native hierarchy IDs while HTTP targets remain opaque", async () => {
    const f = await fixture("native-navigation");

    try {
        const listing = await f.app.privateSessions.list(owner(f.app));
        const workspace = listing.instances[0]!.workspaces[0]!;
        const tab = workspace.tabs[0]!;

        assert.equal(workspace.nativeId, "workspace");
        assert.equal(tab.nativeId, "tab");
        assert.equal(f.pane.nativeId, "pane");
        assert.notEqual(workspace.id, workspace.nativeId);
        assert.notEqual(tab.id, tab.nativeId);
        assert.notEqual(f.pane.id, f.pane.nativeId);
        const other = listing.instances[1]!.workspaces[0]!;

        assert.equal(other.nativeId, "research");
        assert.equal(other.tabs[0]!.nativeId, "r:t1");
        assert.equal(other.tabs[0]!.panes[0]!.nativeId, "r:p1");
        const view = await f.app.privateSessions.pane(owner(f.app), f.pane.id);

        assert.equal(view.pane.nativeId, "pane");
        await assert.rejects(f.app.privateSessions.pane(owner(f.app), "pane"), {
            status: 400,
            message: "Select a pane from Private",
        });
    } finally {
        await f.app.close();
    }
});

test("plain Chat rejects commands and multiline before discovery with a Terminal mode explanation", async () => {
    const f = await fixture("plain-only");

    try {
        const view = await f.app.privateSessions.pane(owner(f.app), f.pane.id);
        const before = f.calls.length;

        for (const [index, text] of [
            "/model",
            "   /quit",
            "!echo hi",
            "\t!!pwd",
            "hello\nworld",
            "hello\rworld",
            "hello\r\nworld",
            "hello\u2028world",
            "hello\u2029world",
            "hello\tworld",
        ].entries()) {
            await assert.rejects(
                async () =>
                    f.app.privateSessions.prompt(owner(f.app), f.pane.id, {
                        revision: view.revision,
                        requestId: `rejected-${index}`,
                        text,
                    }),
                /Use Terminal mode/,
            );
        }

        assert.equal(f.calls.length, before);
        assert.deepEqual(f.state.signals, []);
        assert.deepEqual(f.app.sessions(), []);
        assert.equal(f.model.state.callCount, 0);
    } finally {
        await f.app.close();
    }
});

test("terminalTarget authorizes before I/O and resolves shells/all agents, even during holds or uncertainty", async () => {
    const f = await fixture("terminal-target");

    try {
        const tree = await f.app.privateSessions.list(owner(f.app));
        const pi = tree.instances[0]!.workspaces[0]!.tabs[0]!.panes[0]!;
        const shell = tree.instances[0]!.workspaces[0]!.tabs[0]!.panes[1]!;
        const codex = tree.instances[1]!.workspaces[0]!.tabs[0]!.panes[0]!;
        const guest = f.app.config.addUser("Not owner", "guest").user;
        const before = f.calls.length;

        await assert.rejects(f.app.privateSessions.terminalTarget(guest, pi.id), /Only the owner/);
        await assert.rejects(
            f.app.privateSessions.terminalTarget({ ...guest, role: "owner" }, pi.id),
            /Only the owner/,
        );
        await assert.rejects(
            f.app.privateSessions.terminalTarget(owner(f.app), "/browser/herdr.sock"),
            /Select a pane/,
        );
        assert.equal(f.calls.length, before);
        assert.deepEqual(await f.app.privateSessions.terminalTarget(owner(f.app), pi.id), {
            socket: "/synthetic/herdr.sock",
            pane: "pane",
            terminal: "terminal-1",
            instanceId: tree.instances[0]!.id,
        });
        const release = f.local.holdInstance("/synthetic/herdr.sock");

        await f.app.privateSessions.markTerminalInput(owner(f.app), "/synthetic/herdr.sock");
        assert.deepEqual(await f.app.privateSessions.terminalTarget(owner(f.app), shell.id), {
            socket: "/synthetic/herdr.sock",
            pane: "shell",
            terminal: "terminal-shell",
            instanceId: tree.instances[0]!.id,
        });
        release();
        assert.deepEqual(await f.app.privateSessions.terminalTarget(owner(f.app), codex.id), {
            socket: "/synthetic/sessions/Research/herdr.sock",
            pane: "r:p1",
            terminal: "rt",
            instanceId: tree.instances[1]!.id,
        });
        const original = f.local.request;
        let terminal: string | undefined = "replacement";

        f.local.request = async <T>(socket: string, method: string, params = {}): Promise<T> => {
            const response = await original<T>(socket, method, params);

            if (method === "session.snapshot" && socket === "/synthetic/herdr.sock") {
                const value = response as { snapshot: { panes: { terminal_id?: string }[] } };

                value.snapshot.panes[0]!.terminal_id = terminal;
            }

            return response;
        };

        assert.equal(
            (await f.app.privateSessions.terminalTarget(owner(f.app), pi.id)).terminal,
            "replacement",
        );
        terminal = undefined;
        await assert.rejects(
            f.app.privateSessions.terminalTarget(owner(f.app), pi.id),
            /no supported terminal/,
        );
        assert.equal(
            f.calls.some((call) => call.method === "agent.prompt"),
            false,
        );
        assert.deepEqual(f.state.signals, []);
    } finally {
        await f.app.close();
    }
});

test("private tree mirrors instances, empty workspaces/tabs, Pi, other agents and shells without Durable work", async () => {
    const f = await fixture("tree");

    try {
        f.options.unavailable = true;
        const tree = await f.app.privateSessions.list(owner(f.app));

        assert.deepEqual(
            tree.instances.map((item) => item.label),
            ["Default Herdr", "Research", "Offline"],
        );
        assert.equal(tree.instances[0]!.workspaces[0]!.tabs[0]!.panes.length, 2);
        assert.equal(tree.instances[1]!.workspaces[1]!.tabs[0]!.panes.length, 0);
        assert.equal(tree.instances[2]!.available, false);
        assert.equal(tree.warnings.length, 1);
        assert.doesNotMatch(
            JSON.stringify(tree),
            /synthetic|73002|session\.jsonl|LIVE_PRIVATE_OUTPUT/,
        );
        const view = await f.app.privateSessions.pane(owner(f.app), f.pane.id);

        assert.match(JSON.stringify(view.entries), /OLD_HISTORY|Ready to continue/);
        assert.doesNotMatch(JSON.stringify(view.entries), /UNSELECTED_BRANCH/);
        assert.equal(view.terminal, "LIVE_PRIVATE_OUTPUT");
        assert.equal(view.canPrompt, true);
        const shell = tree.instances[0]!.workspaces[0]!.tabs[0]!.panes[1]!;
        const shellView = await f.app.privateSessions.pane(owner(f.app), shell.id);

        assert.equal(shellView.canPrompt, false);
        assert.equal(shellView.canImport, false);
        assert.deepEqual(shellView.entries, []);
        const other = tree.instances[1]!.workspaces[0]!.tabs[0]!.panes[0]!;

        assert.equal((await f.app.privateSessions.pane(owner(f.app), other.id)).canPrompt, false);
        assert.deepEqual(f.app.sessions(), []);
        assert.equal((await f.app.harness.inspect(context)).tasks.length, 0);
        assert.equal(f.model.state.callCount, 0);
        assert.deepEqual(f.state.signals, []);
        assert.equal(readFileSync(f.source.path, "utf8"), f.source.archive);
    } finally {
        await f.app.close();
    }
});

test("private journal follows the saved branch and tolerates only an unfinished final write", async () => {
    const f = await fixture("journal");

    try {
        appendFileSync(f.source.path, '{"type":"message"');
        const partial = await readJournal(f.source.path);

        assert.equal(partial.warnings.length, 1);
        assert.match(JSON.stringify(partial.entries), /Ready to continue/);
        assert.throws(() => projectJournal(f.source.archive + "not-json\n"), /invalid record/);
        const records = f.source.archive
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));

        records.find((row) => row.message?.role === "assistant").message.content = [
            null,
            { type: "text", text: "x".repeat(50_000) },
        ];
        const bounded = projectJournal(records.map((row) => JSON.stringify(row)).join("\n"));

        assert.match(JSON.stringify(bounded), /text truncated/);
        assert.ok(JSON.stringify(bounded).length < 50_000);
        writeFileSync(f.source.path, Buffer.from([0xff, 0xfe]));
        await assert.rejects(readJournal(f.source.path));
    } finally {
        await f.app.close();
    }
});

test("private prompts recheck process/session identity, deduplicate, and use only agent-aware input", async () => {
    const f = await fixture("input");

    try {
        const view = await f.app.privateSessions.pane(owner(f.app), f.pane.id);
        const request = {
            revision: view.revision,
            text: "Hello from my phone",
            requestId: "once",
        };

        await Promise.all([
            f.app.privateSessions.prompt(owner(f.app), f.pane.id, request),
            f.app.privateSessions.prompt(owner(f.app), f.pane.id, request),
        ]);
        const sent = f.calls.filter((call) => call.method === "agent.prompt");

        assert.equal(sent.length, 1);
        // Herdr protocol 22 schema: AgentPromptParams requires target/text; wait is an object or null, not boolean.
        assert.deepEqual(sent[0]!.params, { target: "pane", text: request.text });
        assert.equal(
            f.calls.some((call) => call.method.startsWith("pane.send")),
            false,
        );
        await assert.rejects(
            async () =>
                f.app.privateSessions.prompt(owner(f.app), f.pane.id, {
                    ...request,
                    text: "changed",
                }),
            /different message/,
        );
        await assert.rejects(
            async () =>
                f.app.privateSessions.prompt(owner(f.app), f.pane.id, {
                    ...request,
                    requestId: "escape",
                    text: "hello\u001b[201~",
                }),
            /plain-text/,
        );
        f.state.path += ".other";
        await assert.rejects(
            f.app.privateSessions.prompt(owner(f.app), f.pane.id, {
                ...request,
                requestId: "source-change",
            }),
            /changed/,
        );
        f.state.path = f.source.path;
        f.state.table = f.state.table.map((process) =>
            process.pid === f.pi.pid ? { ...process, started: "Mon Jan 1 00:00:01 2024" } : process,
        );
        await assert.rejects(
            f.app.privateSessions.prompt(owner(f.app), f.pane.id, {
                ...request,
                requestId: "pid-reused",
            }),
            /changed/,
        );
        f.state.table = [f.shell];
        await assert.rejects(
            f.app.privateSessions.prompt(owner(f.app), f.pane.id, {
                ...request,
                requestId: "shell-now",
            }),
            /changed/,
        );
        assert.equal(f.calls.filter((call) => call.method === "agent.prompt").length, 1);
        assert.deepEqual(f.state.signals, []);
    } finally {
        await f.app.close();
    }
});

test("busy/blocked Pi is read-only, replacement during a read is rejected, restart invalidates old input", async () => {
    const f = await fixture("stale");

    try {
        const view = await f.app.privateSessions.pane(owner(f.app), f.pane.id);

        for (const state of ["working", "blocked", "unknown"]) {
            f.state.status = state;
            assert.equal(
                (await f.app.privateSessions.pane(owner(f.app), f.pane.id)).canPrompt,
                false,
            );
            await assert.rejects(
                f.app.privateSessions.prompt(owner(f.app), f.pane.id, {
                    revision: view.revision,
                    requestId: state,
                    text: "No",
                }),
                /working or waiting/,
            );
        }

        f.state.status = "idle";

        f.options.duringRead = () => {
            f.state.path += ".replacement";
        };

        await assert.rejects(
            f.app.privateSessions.pane(owner(f.app), f.pane.id),
            /changed while loading/,
        );

        f.options.duringRead = () => {};

        f.state.path = f.source.path;
        const restarted = new PrivateSessions(f.app);

        await assert.rejects(
            restarted.prompt(owner(f.app), f.pane.id, {
                revision: view.revision,
                requestId: "old-revision",
                text: "No",
            }),
            /changed/,
        );
        assert.equal(f.calls.filter((call) => call.method === "agent.prompt").length, 0);
    } finally {
        await f.app.close();
    }
});

test("uncertain input is never automatically retried; pane input and import cannot overlap", async () => {
    const f = await fixture("coordination");

    try {
        const view = await f.app.privateSessions.pane(owner(f.app), f.pane.id);
        const preview = await f.app.privateSessions.importPreview(owner(f.app), f.pane.id, {
            revision: view.revision,
        });
        let release!: () => void;

        f.options.promptGate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const request = { revision: view.revision, requestId: "delayed", text: "Hello" };
        const sending = f.app.privateSessions.prompt(owner(f.app), f.pane.id, request);

        await until(
            () => f.calls.some((call) => call.method === "agent.prompt"),
            "prompt in flight",
        );
        await assert.rejects(
            f.app.imports.active.move(owner(f.app), {
                id: preview.activeId,
                sha256: preview.sha256,
                leafId: preview.leafId,
                model: "faux/faux-vision",
                thinkingLevel: "off",
                acknowledged: true,
                visibility: "shared",
            }),
            /operation in progress|delivery is uncertain/,
        );
        release();
        await sending;
        assert.deepEqual(f.state.signals, []);
        f.options.failPrompt = true;
        const uncertain = { ...request, requestId: "uncertain" };

        await assert.rejects(
            f.app.privateSessions.prompt(owner(f.app), f.pane.id, uncertain),
            /did not confirm delivery/,
        );
        await assert.rejects(
            f.app.privateSessions.prompt(owner(f.app), f.pane.id, uncertain),
            /did not confirm delivery/,
        );
        assert.equal(f.calls.filter((call) => call.method === "agent.prompt").length, 2);
        const quarantined = await f.app.privateSessions.pane(owner(f.app), f.pane.id);

        assert.equal(quarantined.canPrompt, false);
        assert.equal(quarantined.canImport, false);
        await assert.rejects(
            f.app.imports.active.move(owner(f.app), {
                id: preview.activeId,
                sha256: preview.sha256,
                leafId: preview.leafId,
                model: "faux/faux-vision",
                thinkingLevel: "off",
                acknowledged: true,
                visibility: "shared",
            }),
            /delivery is uncertain/,
        );
        assert.deepEqual(f.state.signals, []);
    } finally {
        await f.app.close();
    }
});

test("private HTTP authorizes before I/O and returns uncached, sanitized workspace metadata", async () => {
    const f = await fixture("http");
    const server = createServer(
        createHandler({ app: f.app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/private`;
    const headers = {
        authorization: `Bearer ${f.app.config.ownerToken}`,
        "x-pocket": "1",
        "content-type": "application/json",
    };

    try {
        const guests = [
            f.app.config.addUser("Guest", "guest"),
            f.app.config.addUser("Viewer", "viewer"),
            f.app.config.addUser("Scoped", "guest"),
        ];

        f.app.config.updateUser(guests[2]!.user.id, { sessions: [] });
        const before = f.calls.length;

        assert.equal((await fetch(base)).status, 401);

        for (const person of guests) {
            for (const route of [
                "",
                `/${f.pane.id}`,
                `/${f.pane.id}/prompt`,
                `/${f.pane.id}/import-preview`,
            ]) {
                const method =
                    route.endsWith("prompt") || route.endsWith("preview") ? "POST" : "GET";

                assert.equal(
                    (
                        await fetch(base + route, {
                            method,
                            headers: { ...headers, authorization: `Bearer ${person.token}` },
                            ...(method === "POST" ? { body: "{}" } : {}),
                        })
                    ).status,
                    403,
                );
            }
        }

        assert.equal(
            (
                await fetch(`${base}/${f.pane.id}/prompt`, {
                    method: "POST",
                    headers: { authorization: headers.authorization },
                    body: "{}",
                })
            ).status,
            403,
        );
        assert.equal(f.calls.length, before);
        const response = await fetch(base, { headers });

        assert.equal(response.status, 200);
        assert.equal(response.headers.get("cache-control"), "no-store");
        const listing = await response.json();
        const parent = listing.instances[0].workspaces[0];
        const [linked, empty, cwdOnly, longA, longB, invalidA, invalidB, unsafe, absent] =
            listing.instances[1].workspaces;

        assert.deepEqual(parent.worktree, {
            key: "/repos/example",
            label: "Example project",
            isLinkedWorktree: false,
        });
        assert.deepEqual(linked.worktree, {
            key: "/repos/example",
            label: "Example project",
            isLinkedWorktree: true,
        });
        assert.equal(parent.customLabel, true);
        assert.equal(linked.customLabel, false);
        assert.equal(parent.state, "done");
        assert.equal(linked.state, "working");
        assert.equal(parent.tabs[0].active, true);
        assert.deepEqual(
            linked.tabs.map((tab: { active: boolean }) => tab.active),
            [true, false],
        );
        assert.equal(parent.branch, "wire/main");
        assert.equal(linked.branch, "worktree/feature");
        assert.equal(cwdOnly.branch, "local-main");
        assert.equal(cwdOnly.worktree, undefined); // Labels never imply worktree membership.
        assert.equal(longA.worktree.key, longRepoKey + "/a");
        assert.equal(longB.worktree.key, longRepoKey + "/b");
        assert.notEqual(longA.worktree.key, longB.worktree.key);
        assert.equal(longA.worktree.label, "L".repeat(400));

        for (const invalid of [empty, invalidA, invalidB]) {
            assert.equal(invalid.worktree, undefined);
        }

        assert.equal(empty.customLabel, undefined);
        assert.equal(empty.state, undefined);
        assert.equal(empty.branch, undefined);
        assert.equal(empty.tabs[0].active, undefined);
        assert.equal(unsafe.branch, undefined); // No relative paths or repo_root fallback.
        assert.equal(absent.nativeId, "absent-workspace");
        assert.equal(absent.tabs[0].panes[0].nativeId, "absent:p1");
        assert.equal(listing.instances[1].available, true);
        assert.deepEqual(listing.warnings, []);
        assert.equal(parent.nativeId, "workspace");
        assert.equal(parent.tabs[0].nativeId, "tab");
        assert.equal(parent.tabs[0].panes[0].nativeId, "pane");
        assert.match(parent.id, /^[a-f0-9]{64}$/);
        assert.match(linked.id, /^[a-f0-9]{64}$/);
        assert.doesNotMatch(JSON.stringify(listing), /checkout_path|repo_root|\\u001b|\\u0000/i);
        const viewResponse = await fetch(`${base}/${f.pane.id}`, { headers });

        assert.equal(viewResponse.headers.get("cache-control"), "no-store");
        const view = await viewResponse.json();
        const result = await fetch(`${base}/${f.pane.id}/prompt`, {
            method: "POST",
            headers,
            body: JSON.stringify({
                revision: view.revision,
                requestId: "http-send",
                text: "One message",
            }),
        });

        assert.equal(result.status, 200);
        assert.equal(f.calls.filter((call) => call.method === "agent.prompt").length, 1);
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await f.app.close();
    }
});
