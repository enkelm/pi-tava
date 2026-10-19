// The real app/storage owns destination pinning, inheritance and workflow admission. Transport is isolated below.
import {
    type App,
    cleanUp,
    context,
    modelTexts,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { join, posix } from "node:path";
import { writeFileSync } from "node:fs";
import { after, before, mock, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { err, FileError, ok } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { SubagentsDoc } from "../src/server/docs.ts";
import { WorkflowDoc } from "../src/server/workflow-docs.ts";
import { HttpError } from "../src/server/errors.ts";
import { SshExecutionEnv } from "../src/server/ssh-env.ts";

const location = { kind: "ssh" as const, host: "ssh://fixture-user@fixture-devbox:20977" };
const remoteCwd = "/fixture/remote-project";
const data = join(root, "ssh-locations");
let stagingSource = "";
const staged: { path: string; bytes: Buffer }[] = [];
const model = scriptedModel((request) => {
    const last = request.messages.at(-1);

    if (
        last?.role === "user" &&
        JSON.stringify(last.content).includes("delegate a fixture check")
    ) {
        return fauxAssistantMessage(
            [
                fauxToolCall("subagent", {
                    action: "spawn",
                    name: "fixture-helper",
                    message: "child fixture check",
                }),
            ],
            { stopReason: "toolUse" },
        );
    }

    if (
        last?.role === "user" &&
        JSON.stringify(last.content).includes("stage fixture attachment")
    ) {
        return fauxAssistantMessage([fauxToolCall("stage_upload", { path: stagingSource })], {
            stopReason: "toolUse",
        });
    }

    return fauxAssistantMessage([fauxText("fixture done")]);
});
let app: App;
let transportCalls = 0;

before(async () => {
    // No sockets or owner SSH settings: only the transport boundary is replaced. The app must still
    // select, persist and inherit the right namespace and enforce live policy itself.
    mock.method(SshExecutionEnv.prototype, "absolutePath", async (path: string) => {
        transportCalls++;

        return ok(path === "~" ? remoteCwd : posix.resolve(remoteCwd, path));
    });
    mock.method(SshExecutionEnv.prototype, "canonicalPath", async function (path: string) {
        transportCalls++;

        return ok(path === "~" ? remoteCwd : posix.resolve(remoteCwd, path));
    });
    mock.method(SshExecutionEnv.prototype, "fileInfo", async function (path: string) {
        transportCalls++;

        if (/(?:^|\/)(?:\.pi|\.agents|\.git)(?:\/|$)/.test(path)) {
            return err(new FileError("not_found", "No fixture project resources", path));
        }

        return ok({
            name: posix.basename(path),
            path,
            kind: "directory",
            size: 0,
            mtimeMs: 0,
        });
    });
    mock.method(SshExecutionEnv.prototype, "readTextFile", async () => {
        transportCalls++;

        return ok("Remote fixture project instructions.");
    });
    mock.method(SshExecutionEnv.prototype, "exec", async () => {
        transportCalls++;

        return ok({ exitCode: 0 });
    });
    mock.method(SshExecutionEnv.prototype, "createTempDir", async () => ok("/tmp/fixture-staged"));
    mock.method(
        SshExecutionEnv.prototype,
        "writeFile",
        async (path: string, bytes: Uint8Array | string) => {
            transportCalls++;
            staged.push({ path, bytes: Buffer.from(bytes) });

            return ok(undefined);
        },
    );
    app = await openApp(model, data);
});
after(async () => {
    await app?.close();
    mock.restoreAll();
    cleanUp();
});

test("SSH project defaults are creation-time only; explicit local overrides, retries and reopen preserve targets", async () => {
    const person = owner(app);
    const projectId = (
        await app.projects.create(person, {
            name: "Remote fixture",
            cwd: remoteCwd,
            location,
            requestId: "remote-project",
        })
    ).id;
    const first = await app.commands.createSession(person, {
        projectId,
        threadType: "chat",
        requestId: "remote-first",
    });
    const local = await app.commands.createSession(person, {
        projectId,
        threadType: "chat",
        cwd: work,
        location: null,
    });
    const secondHost = { kind: "ssh", host: "ssh://fixture-user@fixture-devbox:2200" };

    assert.deepEqual(app.locationOf(first.id), location);
    assert.equal(app.cwdOf(first.id), remoteCwd);
    assert.equal(app.locationOf(local.id), undefined);
    assert.equal(app.cwdOf(local.id), work);
    await app.projects.update(person, projectId, { cwd: "/fixture/other", location: secondHost });
    const later = await app.commands.createSession(person, { projectId, threadType: "chat" });

    assert.deepEqual(app.locationOf(later.id), secondHost);
    assert.deepEqual(app.locationOf(first.id), location);
    assert.equal(app.cwdOf(first.id), remoteCwd);
    await app.projects.assign(person, first.id, { projectId: null });
    assert.deepEqual(app.locationOf(first.id), location);
    assert.equal(app.cwdOf(first.id), remoteCwd);
    const retried = await app.commands.createSession(person, {
        projectId,
        threadType: "chat",
        requestId: "remote-first",
    });

    assert.equal(retried.id, first.id);
    await assert.rejects(
        app.commands.createSession(person, {
            projectId,
            threadType: "chat",
            requestId: "remote-first",
            location: secondHost,
        }),
        (error: unknown) => error instanceof HttpError && error.status === 409,
    );
    const scoped = app.config.addUser("Scoped remote", "guest", [String(later.id)]).user;
    const projection = app.projects.list(scoped).projects[0]!;

    assert.equal(Object.hasOwn(projection, "cwd"), false);
    assert.equal(Object.hasOwn(projection, "location"), false);
    const beforeListing = transportCalls;

    app.sessions(person);
    assert.equal(
        transportCalls,
        beforeListing,
        "a passive sidebar must not probe saved SSH targets",
    );
    await app.close();
    app = await openApp(model, data);
    assert.deepEqual(app.locationOf(first.id), location);
    assert.deepEqual(app.locationOf(later.id), secondHost);
    assert.equal(app.envFor(first.id).id === app.envFor(later.id).id, false);
});

test("SSH Worker creation writes remotely and honors later read-only workflow state", async () => {
    const person = owner(app);
    const { id } = await app.commands.createSession(person, {
        cwd: remoteCwd,
        location,
        threadType: "worker",
    });
    const env = app.envFor(id, person);

    assert.equal(app.sessionMeta(id)?.threadType, "worker");
    assert.equal(app.handoffs.isManaged(id), true);
    assert.deepEqual(app.locationOf(id), location);
    const path = `${remoteCwd}/managed.txt`;

    assert.equal((await env.writeFile(path, "remote managed bytes", context)).ok, true);
    assert.deepEqual(staged.at(-1), { path, bytes: Buffer.from("remote managed bytes") });

    // The coordinator must revoke the already-issued environment, not merely new tool invocations.
    // Full human transfer/transaction behavior is owned by handoff-execution tests.
    await app.harness.commit(async (tx) => {
        (await tx.doc(WorkflowDoc, id)).readOnly = true;
    }, context);
    const calls = transportCalls;
    const results = await Promise.all([
        env.exec(["touch", "forbidden.txt"], undefined, context),
        env.writeFile(path, "forbidden", context),
    ]);

    for (const result of results) {
        assert.equal(result.ok, false);

        if (!result.ok) {
            assert.match(result.error.message, /read.only|previous writer/i);
        }
    }

    assert.equal(transportCalls, calls);
    assert.equal((await env.readTextFile("AGENTS.md", context)).ok, true);
    assert.equal(transportCalls, calls + 1);
});

test("inline SSH mentions send remote bytes to the model, never a host-local namesake", async (t) => {
    const namesake = join(root, "inline.txt");
    const backing = join(root, "remote-inline.txt");
    const remoteText = "REMOTE INLINE SOURCE";
    const localText = "HOST NAMESAKE MUST NOT ENTER THE MODEL";
    const files = new NodeExecutionEnv({ cwd: root });
    const originalInfo = SshExecutionEnv.prototype.fileInfo;

    writeFileSync(namesake, localText);
    writeFileSync(backing, remoteText);
    t.mock.method(
        SshExecutionEnv.prototype,
        "fileInfo",
        async function (this: SshExecutionEnv, path: string) {
            return path === namesake
                ? files.fileInfo(backing, context)
                : originalInfo.call(this, path, context);
        },
    );
    t.mock.method(
        SshExecutionEnv.prototype,
        "openBinaryReader",
        async (path: string, options: { noFollow?: boolean } | undefined) => {
            assert.equal(path, namesake);

            return files.openBinaryReader(backing, options, context);
        },
    );
    const person = owner(app);
    const { id } = await app.commands.createSession(person, {
        cwd: remoteCwd,
        location,
        threadType: "chat",
    });

    await app.commands.configure(id, person, {
        model: { provider: "faux", modelId: "faux-1" },
    });
    const { submissionId } = await app.commands.submit(id, person, {
        text: `Read @${namesake}`,
        requestId: "remote-inline",
        inlineFiles: true,
    });

    await (await app.harness.submission(submissionId, context))!.wait(context);
    const received = (await modelTexts(app, id)).join("\n");

    assert.match(received, /REMOTE INLINE SOURCE/);
    assert.equal(received.includes(localText), false);
});

test("managed SSH upload staging copies only this thread's attachment bytes, not arbitrary host files", async () => {
    const { id } = await app.commands.createSession(owner(app), {
        cwd: remoteCwd,
        location,
        threadType: "worker",
    });

    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
    });
    const source = join(app.workspace.uploadDirectory(id), "fixture.bin");
    const bytes = Buffer.from([0, 255, 42, 10]);

    writeFileSync(source, bytes);
    stagingSource = source;
    const before = staged.length;

    await say(app, id, "stage fixture attachment");
    assert.equal(staged.length, before + 1);
    assert.equal(staged.at(-1)!.path, "/tmp/fixture-staged/fixture.bin");
    assert.deepEqual(staged.at(-1)!.bytes, bytes);
    stagingSource = join(work, "not-an-upload.txt");
    writeFileSync(stagingSource, "host-only secret sentinel");
    await say(app, id, "stage fixture attachment");
    assert.equal(staged.length, before + 1);
    const entries = await app.transcripts.allEntries(id, false);

    assert.match(JSON.stringify(entries), /Only attachments uploaded to this thread/);
    assert.doesNotMatch(JSON.stringify(entries), /host-only secret sentinel/);
});

test("locally spawned subagents, linked sessions and forks retain the bound SSH namespace", async () => {
    const { id } = await app.commands.createSession(owner(app), {
        cwd: remoteCwd,
        location,
        threadType: "chat",
    });

    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
    });
    await say(app, id, "delegate a fixture check");
    await until(async () => {
        const children = await app.harness.snapshot(SubagentsDoc, id, context);
        const child = children?.agents["fixture-helper"]?.conversationId;

        return child !== undefined && !app.isBusy(child);
    }, "remote helper settled");
    const child = (await app.harness.snapshot(SubagentsDoc, id, context))!.agents["fixture-helper"]!
        .conversationId;

    assert.deepEqual(app.locationOf(child), location);
    assert.equal(app.envFor(child).id, app.envFor(id).id);
    assert.equal(app.envFor(child).cwd, remoteCwd);
    await until(() => !app.isBusy(id), "parent reports settled");
    const { session: linked } = await app.linkedSessions.start(
        id,
        { title: "Remote linked", message: "linked fixture check" },
        "remote-linked",
    );

    assert.deepEqual(app.locationOf(linked), location);
    assert.equal(app.envFor(linked).id, app.envFor(id).id);
    const peerProject = await app.memory.project(linked, remoteCwd);
    const local = await app.commands.createSession(owner(app), { cwd: work });
    const localProject = await app.memory.project(local.id, work);

    assert.notEqual(peerProject?.key, localProject?.key);
    await until(() => !app.isBusy(linked), "linked fixture settled");
    const entry = (await app.transcripts.allEntries(id, false)).findLast(
        (entry) => entry.kind === "assistant",
    );

    assert.ok(entry);
    const fork = await app.commands.fork(id, owner(app), { entryId: entry.id });

    assert.deepEqual(app.locationOf(fork.id), location);
    assert.equal(app.envFor(fork.id).cwd, remoteCwd);
});
