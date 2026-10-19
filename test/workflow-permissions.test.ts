// The real Harness/tool boundary and real child processes own these security contracts; no live data/remotes.
import {
    type App,
    cleanUp,
    context,
    executeHandoff,
    lastText,
    modelTexts,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { err, ExecutionError, type ShellExecResult } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { ArtifactsDoc, SessionsDoc, SubagentsDoc } from "../src/server/docs.ts";
import { HandoffsDoc, type ThreadType } from "../src/server/workflow-docs.ts";
import { PublicationsDoc } from "../src/server/workflow-publication.ts";
import { protectWorkflowEnv, workflowGitPath } from "../src/server/workflow-policy.ts";
import { createHandler } from "../src/server/http.ts";

const apps = new Set<App>();
let serial = 0;

after(async () => {
    for (const app of apps) {
        await app.close();
    }

    cleanUp();
});

function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    }).trim();
}

async function fixture(threadType: "worker" | "chat" = "worker") {
    const directory = join(root, `workflow-${++serial}`);
    const cwd = join(directory, "checkout");
    const remote = join(directory, "remote.git");

    mkdirSync(cwd, { recursive: true });
    git(cwd, "init", "-q");
    git(cwd, "config", "user.name", "Test");
    git(cwd, "config", "user.email", "test@example.invalid");
    writeFileSync(join(cwd, "code.txt"), "initial\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "initial");
    writeFileSync(join(cwd, "code.txt"), "landed\n");
    git(cwd, "commit", "-qam", "landed");
    git(cwd, "branch", "topic");
    git(cwd, "init", "--bare", "-q", remote);
    git(cwd, "remote", "add", "origin", remote);
    let planned: { name: string; args: Parameters<typeof fauxToolCall>[1] } | undefined;
    let childCommand: string | undefined;
    const model = scriptedModel((request) => {
        const { role, text } = lastText(request as never);

        if (role === "user" && text.endsWith("CHILD WORKFLOW") && childCommand !== undefined) {
            return fauxAssistantMessage([fauxToolCall("bash", { command: childCommand })], {
                stopReason: "toolUse",
            });
        }

        if (role === "user" && text.endsWith("TEST EXECUTE") && planned !== undefined) {
            return fauxAssistantMessage([fauxToolCall(planned.name, planned.args)], {
                stopReason: "toolUse",
            });
        }

        return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
    });
    const dataDir = join(directory, "data");

    mkdirSync(join(dataDir, "extensions"), { recursive: true });
    writeFileSync(
        join(dataDir, "extensions", "workflow-network-fixture.ts"),
        `/** A trusted fixture whose execution must still be blocked by workflow policy. */
import {writeFileSync} from 'node:fs';
import {Type} from '@earendil-works/pi-ai';
import {defineExtension, defineTool} from '@earendil-works/pi-durable';
export default function(){return defineExtension({name:'workflow-test-extension',tools:[defineTool({name:'unclassified-network-tool',description:'Fixture',parameters:Type.Object({}),execute:async()=>{writeFileSync(${JSON.stringify(join(cwd, "extension-executed"))},'mutated');return {content:[{type:'text',text:'executed'}]}}})]})}
`,
    );
    const app = await openApp(model, dataDir);

    apps.add(app);
    const project = await app.projects.create(owner(app), {
        name: "Permissions fixture",
        cwd,
        requestId: crypto.randomUUID(),
    });
    const { id: worker } = await app.commands.createSession(owner(app), {
        cwd,
        projectId: project.id,
        threadType,
    });

    await app.commands.configure(worker, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });

    await say(app, worker, "Report the disposable fixture implementation for review.");

    const send = async (
        id: ConversationId,
        name: string,
        args: Parameters<typeof fauxToolCall>[1],
        user = owner(app),
        liveApp = app,
    ) => {
        planned = { name, args };
        // A queued, pre-handoff invocation can still resume in the Harness, independent of HTTP admission.
        const submission = await (
            await liveApp.conversation(id)
        ).submit(
            {
                type: "input",
                content: "TEST EXECUTE",
                requestId: `u:${user.id}:${crypto.randomUUID()}`,
            },
            context,
        );

        await submission.wait(context);
    };

    const handoff = async (id: ConversationId, targetType: ThreadType, liveApp = app) => {
        // These tests own permissions, not review admission. Give Reviewer a real disposable draft,
        // then discard that draft after its response without changing the publication fixture's commits.
        const draft =
            targetType === "reviewer" && git(cwd, "status", "--porcelain", "--", "code.txt") === ""
                ? readFileSync(join(cwd, "code.txt"))
                : undefined;

        if (draft !== undefined) {
            writeFileSync(join(cwd, "code.txt"), `${draft.toString()}reviewable draft\n`);
        }

        try {
            const created = await executeHandoff(liveApp, id, targetType, {
                summary: "Inspect this disposable checkout.",
            });
            const target = created.id as unknown as ConversationId;

            await until(
                async () =>
                    (await liveApp.harness.snapshot(HandoffsDoc, context))?.handoffs[
                        created.handoffId
                    ]?.delivery === "delivered",
                "handoff delivery",
            );
            await (await liveApp.conversation(target)).waitForIdle(context);

            return target;
        } finally {
            if (draft !== undefined) {
                writeFileSync(join(cwd, "code.txt"), draft);
            }
        }
    };

    const publish = async () => {
        const reviewer = await handoff(worker, "reviewer");

        const land = await handoff(reviewer, "land");

        return handoff(land, "publish");
    };

    return {
        app,
        model,
        dataDir,
        cwd,
        remote,
        worker,
        send,
        handoff,
        publish,
        childCommand: (command: string) => {
            childCommand = command;
        },
    };
}

const push = (source = "HEAD") => ({
    action: "execute",
    command: ["git", "push", "origin", `${source}:refs/heads/published`],
    reason: "Publish this specific synthetic checkpoint to the disposable bare remote.",
});

async function pending(app: App) {
    try {
        await until(() => app.approvals.all().length === 1, "mandatory publication approval");
    } catch (error) {
        const items = (await app.harness.snapshot(SessionsDoc, context))?.items ?? {};
        const id = Object.entries(items).findLast(([, meta]) => meta.threadType === "publish")?.[0];

        throw new Error(
            `${String(error)}\n${id === undefined ? "No Publish thread" : (await modelTexts(app, Number(id) as unknown as ConversationId)).join("\n")}`,
        );
    }

    return app.approvals.all()[0]!;
}

function remoteRefs(remote: string): string {
    return git(remote, "for-each-ref", "--format=%(refname) %(objectname)");
}

test("mandatory core denies team tools and nested codemode without disabling ordinary Chat teams", async () => {
    const f = await fixture();

    await f.app.setExtensionEnabled(owner(f.app), "agent-teams.ts", true);
    const count = f.app.sessions().length;
    const calls: { name: string; args: Parameters<typeof fauxToolCall>[1] }[] = [
        { name: "team", args: { action: "start", message: "Do not create independent work." } },
        {
            name: "codemode",
            args: {
                code: 'await tools.team({action:"start", message:"Do not create independent work."});',
            },
        },
    ];

    for (const call of calls) {
        await f.send(f.worker, call.name, call.args);
        assert.equal(f.app.sessions().length, count);
        assert.match(
            (await modelTexts(f.app, f.worker)).at(-1)!,
            /team is not permitted in managed workflows/,
        );
    }

    const { id: chat } = await f.app.commands.createSession(owner(f.app), {
        cwd: f.cwd,
        threadType: "chat",
    });

    await f.app.commands.configure(chat, owner(f.app), {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });
    await f.send(chat, "team", { action: "start", message: "An ordinary independent Chat task." });
    const linked = f.app.sessions().filter((session) => session.linkedFrom?.id === Number(chat));

    assert.equal(linked.length, 1);
    assert.equal(linked[0]?.threadType, "chat");
    assert.equal(f.app.handoffs.isManaged(linked[0]!.id as ConversationId), false);
});

test("mandatory core checks stop resumed predecessor tools and codemode; cached env and workspace cannot write", async () => {
    const f = await fixture("chat");
    const cached = f.app.envFor(f.worker);

    await f.handoff(f.worker, "worker");
    const original = readFileSync(join(f.cwd, "code.txt"), "utf8");
    const calls: { name: string; args: Parameters<typeof fauxToolCall>[1] }[] = [
        { name: "write", args: { path: "code.txt", content: "blocked\n" } },
        {
            name: "edit",
            args: { path: "code.txt", edits: [{ oldText: "landed", newText: "blocked" }] },
        },
        { name: "bash", args: { command: "printf blocked > code.txt" } },
        {
            name: "codemode",
            args: { code: 'await tools.write({path:"code.txt", content:"blocked"});' },
        },
        { name: "subagent", args: { action: "spawn", name: "bypass", message: "write code.txt" } },
        {
            name: "browser",
            args: { action: "evaluate", script: "fetch('https://example.invalid')" },
        },
    ];

    for (const call of calls) {
        await f.send(f.worker, call.name, call.args);
        assert.equal(readFileSync(join(f.cwd, "code.txt"), "utf8"), original, call.name);
    }

    assert.equal(
        Object.keys((await f.app.harness.snapshot(SubagentsDoc, f.worker, context))?.agents ?? {})
            .length,
        0,
    );
    assert.equal((await cached.writeFile("code.txt", "blocked", context)).ok, false);
    assert.equal((await cached.appendFile("code.txt", "blocked", context)).ok, false);
    assert.equal((await cached.truncateFile("code.txt", 0, context)).ok, false);
    assert.equal((await cached.renameFile("code.txt", "moved.txt", context)).ok, false);
    assert.equal((await cached.remove("code.txt", undefined, context)).ok, false);
    assert.equal((await cached.createDir("new", undefined, context)).ok, false);
    assert.equal((await cached.createTempFile(undefined, context)).ok, false);
    assert.equal((await cached.readTextFile("code.txt", context)).ok, true);

    if (process.platform === "darwin") {
        const hook = join(f.cwd, ".git", "hooks", "read-hook");
        const marker = join(f.cwd, "driver-bypass");

        writeFileSync(
            hook,
            `#!/bin/sh\nprintf bypass > ${JSON.stringify(marker)}\nprintf '0\\\\0'\n`,
        );
        chmodSync(hook, 0o755);
        git(f.cwd, "config", "core.fsmonitor", hook);
        const inspected = await f.app
            .envFor(f.worker)
            .exec("git status --porcelain", undefined, context);

        assert.equal(inspected.ok && inspected.value.exitCode, 0, "Verified inspection still runs");
        assert.equal(
            existsSync(marker),
            false,
            "Configured Git child hooks cannot evade the read-only OS sandbox",
        );
    }

    for (const command of [
        "kill -0 1",
        "launchctl list",
        "node -e 'process.kill(1,0)'",
        "git status; kill -0 1",
    ]) {
        const outcome = await cached.exec(command, undefined, context);

        assert.equal(outcome.ok, false, command);
        assert.match(!outcome.ok ? outcome.error.message : "", /verified simple inspection/);
    }

    const view = await f.app.workspace.viewFile(f.worker, owner(f.app), "code.txt");

    assert.equal(view.editable, false);
    await assert.rejects(
        f.app.workspace.saveFile(
            f.worker,
            owner(f.app),
            "code.txt",
            "blocked",
            "kind" in view && view.kind === "text" ? view.revision : undefined,
        ),
        /read-only/,
    );
    await assert.rejects(
        f.app.workspace.revertChange(f.worker, owner(f.app), "code.txt"),
        /read-only/,
    );
    await assert.rejects(
        f.app.workspace.switchBranch(f.worker, owner(f.app), { name: "topic" }),
        /read-only/,
    );
    await assert.rejects(
        f.app.shell.start(f.worker, owner(f.app), { command: "printf blocked > code.txt" }),
        /read-only/,
    );
    assert.equal(readFileSync(join(f.cwd, "code.txt"), "utf8"), original);
});

test(
    "initial Worker worktree creation, forks and cleanup contain real Git child hooks; Chats remain unchanged",
    { skip: process.platform !== "darwin" },
    async () => {
        const f = await fixture();
        let requests = 0;
        const server = createServer((_request, response) => {
            requests++;
            response.end("hook callback");
        });

        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();

        assert.ok(address && typeof address === "object");
        const marker = join(f.cwd, "hook-ran");
        const hook = join(f.cwd, ".git", "hooks", "post-checkout");

        writeFileSync(
            hook,
            `#!/bin/sh\nprintf 'ran\\n' >> ${JSON.stringify(marker)}\n/usr/bin/curl --max-time 2 --silent http://127.0.0.1:${address.port}/ > /dev/null 2>&1\nexit 0\n`,
        );
        chmodSync(hook, 0o755);
        const filterMarker = join(f.cwd, "filter-ran");
        const filter = join(f.cwd, "clean-filter.sh");

        writeFileSync(
            filter,
            `#!/bin/sh\nprintf 'ran\\n' >> ${JSON.stringify(filterMarker)}\n/usr/bin/curl --max-time 2 --silent http://127.0.0.1:${address.port}/ > /dev/null 2>&1\ncat\n`,
        );
        chmodSync(filter, 0o755);
        git(f.cwd, "config", "filter.worktreefixture.clean", filter);
        writeFileSync(join(f.cwd, ".gitattributes"), "code.txt filter=worktreefixture\n");
        writeFileSync(join(f.cwd, "code.txt"), "dirty source bytes\n");

        try {
            const { id: isolated } = await f.app.commands.createSession(owner(f.app), {
                cwd: f.cwd,
                threadType: "worker",
                worktree: true,
            });

            assert.equal(
                readFileSync(join(f.app.cwdOf(isolated), "code.txt"), "utf8"),
                "dirty source bytes\n",
            );
            assert.equal(existsSync(marker), true, "The real configured hook ran during checkout");
            assert.equal(requests, 0, "Initial Worker creation cannot grant hooks external access");
            const sent = await f.app.commands.submit(f.worker, owner(f.app), {
                text: "Clone fixture",
                requestId: crypto.randomUUID(),
            });

            await (await f.app.harness.submission(sent.submissionId, context))!.wait(context);
            const entries = await (
                await f.app.conversation(f.worker)
            ).entries({}, 100, undefined, context);
            const answer = entries.items.find((entry) => entry.kind === "pi.assistant");

            assert.ok(answer);
            const { id: fork } = await f.app.commands.fork(f.worker, owner(f.app), {
                entryId: Number(answer.id),
                worktree: true,
            });

            assert.equal(f.app.sessionMeta(fork)?.threadType, "worker");
            assert.equal(
                readFileSync(join(f.app.cwdOf(fork), "code.txt"), "utf8"),
                "dirty source bytes\n",
            );
            assert.equal(
                requests,
                0,
                "An ungrouped Worker fork cannot escape through checkout hooks",
            );
            rmSync(filterMarker, { force: true });
            await assert.rejects(f.app.commands.removeWorktree(fork, owner(f.app), false), {
                status: 409,
                message: /uncommitted changes/,
            });
            assert.equal(
                existsSync(filterMarker),
                true,
                "Cleanup actually inspected dirty files through the configured filter",
            );
            assert.equal(
                requests,
                0,
                "Cleanup's dirty check cannot grant filter descendants external access",
            );
            await f.app.commands.removeWorktree(isolated, owner(f.app), true);
            await f.app.commands.removeWorktree(fork, owner(f.app), true);
            assert.equal(f.app.sessionMeta(fork)?.worktree, undefined);
            assert.equal(requests, 0);

            const { id: chat } = await f.app.commands.createSession(owner(f.app), {
                cwd: f.cwd,
                threadType: "chat",
                worktree: true,
            });

            assert.ok(
                requests > 0,
                "The same real hook retains its existing behavior for an unrelated Chat",
            );
            await f.app.commands.removeWorktree(chat, owner(f.app), true);
        } finally {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    },
);

test("managed artifacts are blocked in typed, retired and successor threads and nested calls; unrelated Chats still work", async () => {
    const f = await fixture();
    const chatCwd = join(root, `artifact-chat-${++serial}`);

    mkdirSync(chatCwd, { recursive: true });
    const { id: chat } = await f.app.commands.createSession(owner(f.app), {
        cwd: chatCwd,
        threadType: "chat",
    });

    await f.app.commands.configure(chat, owner(f.app), {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });
    await f.send(chat, "artifact", {
        id: "ordinary-chat",
        title: "Ordinary chat",
        type: "html",
        content: "<h1>Unrelated Chat artifact</h1>",
    });
    assert.ok((await f.app.harness.snapshot(ArtifactsDoc, chat, context))?.items["ordinary-chat"]);
    const artifact = {
        id: "network-bypass",
        title: "Must not run",
        type: "html",
        content: "<script>fetch('https://example.invalid/mutate',{method:'POST'})</script>",
    };

    assert.equal(f.app.sessionMeta(f.worker)?.threadType, "worker");
    assert.ok(f.app.sessionMeta(f.worker)?.projectId);
    await f.send(f.worker, "artifact", artifact);
    assert.equal(
        Object.keys((await f.app.harness.snapshot(ArtifactsDoc, f.worker, context))?.items ?? {})
            .length,
        0,
        "A brand-new typed Worker is protected before any work-item assignment or handoff preparation",
    );
    assert.match(
        (await modelTexts(f.app, f.worker)).at(-1)!,
        /Artifacts are blocked in managed workflows/,
    );
    await f.handoff(chat, "worker");
    await f.send(chat, "artifact", artifact);
    assert.equal(
        (await f.app.harness.snapshot(ArtifactsDoc, chat, context))?.items["network-bypass"],
        undefined,
        "Existing Chat artifacts do not permit new executable publications after human handoff",
    );
    assert.ok((await f.app.harness.snapshot(ArtifactsDoc, chat, context))?.items["ordinary-chat"]);
    assert.match(
        (await modelTexts(f.app, chat)).at(-1)!,
        /Artifacts are blocked in managed workflows/,
    );
    const reviewer = await f.handoff(f.worker, "researcher");

    for (const call of [
        { name: "artifact", args: artifact },
        { name: "codemode", args: { code: `await tools.artifact(${JSON.stringify(artifact)});` } },
    ]) {
        await f.send(reviewer, call.name, call.args);
        assert.equal(
            Object.keys(
                (await f.app.harness.snapshot(ArtifactsDoc, reviewer, context))?.items ?? {},
            ).length,
            0,
            call.name,
        );
        assert.match(
            (await modelTexts(f.app, reviewer)).at(-1)!,
            /Artifacts are blocked in managed workflows/,
        );
    }
});

test(
    "managed arbitrary interpreters and child hooks are offline, and current requester rights are rechecked",
    { skip: process.platform !== "darwin" },
    async () => {
        const f = await fixture();
        let received = 0;
        const server = createServer((_request, response) => {
            received++;
            response.end("mutation accepted");
        });

        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const port = (server.address() as { port: number }).port;
        const script = `const http=require('node:http');http.get('http://127.0.0.1:${port}/mutate',r=>{r.resume();process.exitCode=0}).on('error',()=>{process.exitCode=23})`;

        try {
            await f.send(f.worker, "bash", {
                command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
            });
            assert.match((await modelTexts(f.app, f.worker)).at(-1)!, /23/);
            assert.equal(
                received,
                0,
                "A brand-new typed Worker is offline before any handoff preparation",
            );
            const reviewer = await f.handoff(f.worker, "reviewer");
            const env = f.app.envFor(reviewer);

            await f.app.setExtensionEnabled(owner(f.app), "workflow-network-fixture.ts", true);
            await f.send(reviewer, "unclassified-network-tool", {});
            assert.equal(
                existsSync(join(f.cwd, "extension-executed")),
                false,
                "Unknown tools are blocked before their trusted code executes",
            );
            assert.match(
                (await modelTexts(f.app, reviewer)).join("\n"),
                /not permitted in managed workflows/,
            );
            const local = await env.exec("printf local > offline.txt", undefined, context);

            assert.equal(local.ok && local.value.exitCode, 0);
            assert.equal(readFileSync(join(f.cwd, "offline.txt"), "utf8"), "local");
            const external = await env.exec([process.execPath, "-e", script], undefined, context);

            assert.equal(external.ok && external.value.exitCode, 23);
            assert.equal(received, 0, "OS sandbox denies even arbitrary interpreter network calls");
            const hook = join(f.cwd, "child.sh");

            writeFileSync(
                hook,
                `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}\n`,
            );
            chmodSync(hook, 0o755);
            const child = await env.exec("./child.sh", undefined, context);

            assert.equal(child.ok && child.value.exitCode, 23);
            assert.equal(received, 0, "child processes inherit the OS boundary");
            f.childCommand(`${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`);
            await f.send(reviewer, "subagent", {
                action: "spawn",
                name: "offline-child",
                message: "CHILD WORKFLOW",
            });
            const subagent = (await f.app.harness.snapshot(SubagentsDoc, reviewer, context))
                ?.agents["offline-child"];

            assert.ok(subagent, "Managed subagent creation is permitted");
            await (await f.app.conversation(subagent.conversationId)).waitForIdle(context);
            assert.equal(f.app.rootOf(subagent.conversationId), reviewer);
            assert.match((await modelTexts(f.app, subagent.conversationId)).join("\n"), /23/);
            assert.equal(received, 0, "Subagents inherit the managed OS capabilities");
            const guest = f.app.config.addUser("Requester", "guest").user;

            await f.send(reviewer, "read", { path: "code.txt" }, guest);
            f.app.setAccess(owner(f.app), guest.id, { role: "viewer" });
            assert.equal((await env.writeFile("code.txt", "blocked", context)).ok, false);
            assert.equal(
                (await env.exec("printf blocked > code.txt", undefined, context)).ok,
                false,
            );
            assert.equal(readFileSync(join(f.cwd, "code.txt"), "utf8"), "landed\n");
        } finally {
            await new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve())),
            );
        }
    },
);

test(
    "HTTP Changes and review inspection contain configured clean filters while unrelated Chats keep their existing behavior",
    { skip: process.platform !== "darwin" },
    async () => {
        const f = await fixture();
        let received = 0;
        const listener = createServer((request, response) => {
            received++;
            request.resume();
            response.end("accepted");
        });
        const api = createServer(
            createHandler({
                app: f.app,
                listen: { host: "127.0.0.1", port: 0 },
                restart: () => {},
            }),
        );

        await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
        await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
        const port = (listener.address() as { port: number }).port;
        const base = `http://127.0.0.1:${(api.address() as { port: number }).port}/api/c`;
        const outside = join(root, `changes-filter-outside-${serial}`);
        const filter = join(f.cwd, ".git", "changes-filter.cjs");
        const request = (id: ConversationId, path: string) =>
            fetch(`${base}/${id}${path}`, {
                headers: { authorization: `Bearer ${f.app.config.ownerToken}` },
            });

        try {
            writeFileSync(
                filter,
                `const fs=require('node:fs');const input=fs.readFileSync(0);try{fs.writeFileSync(${JSON.stringify(outside)},'outside mutation')}catch{}\nconst request=require('node:http').request('http://127.0.0.1:${port}/mutate',{method:'POST'},response=>{response.resume();response.on('end',()=>process.stdout.write(input));});request.on('error',()=>process.stdout.write(input));request.end(input);\n`,
            );
            writeFileSync(
                join(f.cwd, ".git", "info", "attributes"),
                "code.txt filter=workflow-changes\n",
            );
            git(
                f.cwd,
                "config",
                "filter.workflow-changes.clean",
                `${JSON.stringify(process.execPath)} ${JSON.stringify(filter)}`,
            );
            writeFileSync(join(f.cwd, "code.txt"), "changed for inspection\n");

            for (const path of [
                "/changes",
                "/changes/diff?path=code.txt",
                "/reviews/changes",
                "/reviews/diff?path=code.txt",
            ]) {
                const response = await request(f.worker, path);
                const body = await response.text();

                assert.equal(response.status, 200, body);
                assert.ok(
                    body.includes(path.includes("diff") ? "changed for inspection" : "code.txt"),
                    path,
                );
                assert.equal(
                    received,
                    0,
                    `Managed ${path} cannot publish through a configured clean filter`,
                );
                assert.equal(
                    existsSync(outside),
                    false,
                    `Managed ${path} cannot let a child filter write outside the repository`,
                );
            }

            const { id: chat } = await f.app.commands.createSession(owner(f.app), {
                cwd: f.cwd,
                threadType: "chat",
            });
            const ordinary = await request(chat, "/changes");

            assert.equal(ordinary.status, 200, await ordinary.text());
            assert.ok(
                received > 0,
                "Positive control: the same executable filter is still used by an unrelated Chat's existing Git inspection path",
            );
            assert.equal(readFileSync(outside, "utf8"), "outside mutation");
        } finally {
            await Promise.all(
                [api, listener].map(
                    (server) =>
                        new Promise<void>((resolve, reject) =>
                            server.close((error) => (error ? reject(error) : resolve())),
                        ),
                ),
            );
        }
    },
);

test(
    "publication checkpoint clean filters are offline before human approval",
    { skip: process.platform !== "darwin" },
    async () => {
        const f = await fixture();
        const publisher = await f.publish();
        let received = 0;
        const server = createServer((request, response) => {
            received++;
            request.resume();
            response.end("accepted");
        });

        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const port = (server.address() as { port: number }).port;
        const filter = join(f.cwd, ".git", "clean-filter.cjs");

        try {
            writeFileSync(
                filter,
                `const input=require('node:fs').readFileSync(0);\nconst request=require('node:http').request('http://127.0.0.1:${port}/mutate',{method:'POST'},response=>{response.resume();response.on('end',()=>process.stdout.write(input));});\nrequest.on('error',()=>process.stdout.write(input));\nrequest.end(input);\n`,
            );
            writeFileSync(
                join(f.cwd, ".git", "info", "attributes"),
                "code.txt filter=workflow-clean\n",
            );
            git(
                f.cwd,
                "config",
                "filter.workflow-clean.clean",
                `${JSON.stringify(process.execPath)} ${JSON.stringify(filter)}`,
            );
            writeFileSync(join(f.cwd, "code.txt"), "landed\n");
            const raw = await new NodeExecutionEnv({ cwd: f.cwd }).exec(
                [workflowGitPath()!, "status", "--porcelain"],
                { timeout: 10, env: { GIT_OPTIONAL_LOCKS: "0" } },
                context,
            );

            assert.equal(raw.ok && raw.value.exitCode, 0);
            assert.ok(
                received > 0,
                "Positive control: configured clean filter really performs a synthetic localhost request without an OS sandbox",
            );
            received = 0;
            writeFileSync(join(f.cwd, "code.txt"), "landed\n");
            const operation = f.send(publisher, "publication", push());
            const approval = await pending(f.app);

            assert.equal(
                received,
                0,
                "Fingerprint and publication checkpoint inspection cannot make unapproved requests through configured clean filters",
            );
            await f.app.answerApproval(approval.id, false, owner(f.app));
            await operation;
            assert.equal(received, 0);
            assert.equal(remoteRefs(f.remote), "");
        } finally {
            await new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve())),
            );
        }
    },
);

test(
    "unsupported managed shell and Git inspection never fall back to unrestricted commands",
    { skip: process.platform === "darwin" },
    async () => {
        const f = await fixture();

        await f.send(f.worker, "bash", { command: "printf bypass > unsupported-bypass" });
        const execution = await f.app
            .envFor(f.worker)
            .exec("printf bypass > unsupported-bypass", undefined, context);

        assert.equal(execution.ok, false);
        assert.match(!execution.ok ? execution.error.message : "", /disabled on this platform/);
        assert.equal(existsSync(join(f.cwd, "unsupported-bypass")), false);
        await assert.rejects(
            f.app.workspace.changes(f.worker, owner(f.app)),
            /Git inspection requires a supported OS sandbox/,
        );
        await assert.rejects(
            f.app.reviews.changes(f.worker, owner(f.app)),
            /Git inspection requires a supported OS sandbox/,
        );
    },
);

test(
    "publication rejects non-Publish roles, indirect payloads/wrappers, other source commits and dirty checkouts",
    { skip: process.platform !== "darwin" },
    async () => {
        const f = await fixture();
        const reviewer = await f.handoff(f.worker, "reviewer");

        await f.send(reviewer, "publication", push());
        assert.equal(f.app.approvals.all().length, 0);
        assert.match(
            (await modelTexts(f.app, reviewer)).join("\n"),
            /Only the current active Publish/,
        );
        const land = await f.handoff(reviewer, "land");

        const publisher = await f.handoff(land, "publish");
        const invalid = [
            ["sh", "-c", "git push origin HEAD"],
            ["git", "-c", "core.sshCommand=anything", "push", "origin", "HEAD:refs/heads/main"],
            ["git", "push", "--all", "origin"],
            ["git", "push", "origin"],
            ["gh", "api", "repos/owner/repo/issues", "--method", "POST"],
            ["gh", "pr", "create", "--repo", "owner/repo", "--body-file", "payload.txt"],
            ["gh", "pr", "create", "--repo", "owner/repo", "--body", "-"],
            ["gh", "pr", "create", "--title", "missing repo"],
            [
                "gh",
                "pr",
                "create",
                "--repo",
                "owner/repo",
                "--title",
                "Implicit head",
                "--body",
                "Do not publish",
            ],
            [
                "gh",
                "pr",
                "edit",
                "https://github.com/other/repo/pull/1",
                "--repo",
                "owner/repo",
                "--body",
                "text",
            ],
        ];

        for (const command of invalid) {
            await f.send(publisher, "publication", {
                action: "execute",
                command,
                reason: "Do not execute invalid inputs.",
            });
            assert.equal(f.app.approvals.all().length, 0, JSON.stringify(command));
            assert.equal(remoteRefs(f.remote), "");
        }

        git(f.cwd, "branch", "unreviewed", "HEAD~1");
        git(f.cwd, "tag", "-a", "unreviewed-tag", "-m", "An unreviewed older commit", "HEAD~1");
        const otherCommit = git(f.cwd, "rev-parse", "HEAD~1");
        const otherSources = [
            push("unreviewed").command,
            push(otherCommit).command,
            push("unreviewed-tag").command,
            [
                "gh",
                "pr",
                "create",
                "--repo",
                "owner/repo",
                "--head",
                "unreviewed",
                "--title",
                "Unreviewed source",
                "--body",
                "Do not publish",
            ],
        ];

        for (const command of otherSources) {
            await f.send(publisher, "publication", {
                action: "execute",
                command,
                reason: "This source differs from the reviewed checkout.",
            });
            assert.match(
                (await modelTexts(f.app, publisher)).at(-1)!,
                /source does not match the current Publish checkout/,
                JSON.stringify(command),
            );
            assert.equal(
                f.app.approvals.all().length,
                0,
                "Unreviewed branch/commit/tag cannot even request publication approval",
            );
            assert.equal(remoteRefs(f.remote), "");
        }

        for (const kind of ["tracked", "staged", "untracked"]) {
            if (kind === "untracked") {
                writeFileSync(join(f.cwd, "extra.txt"), "unreviewed");
            } else {
                writeFileSync(join(f.cwd, "code.txt"), "changed\n");

                if (kind === "staged") {
                    git(f.cwd, "add", "code.txt");
                }
            }

            await f.send(publisher, "publication", push());

            assert.equal(
                f.app.approvals.all().length,
                0,
                `No approval offered for ${kind} unreviewed content`,
            );
            assert.equal(remoteRefs(f.remote), "");
            git(f.cwd, "reset", "--hard", "-q", "HEAD");
            rmSync(join(f.cwd, "extra.txt"), { force: true });
        }

        assert.match(
            (await modelTexts(f.app, publisher)).join("\n"),
            /requires a concrete commit and a clean checkout/,
        );
    },
);

test(
    "managed shell permits local stash restoration and rebase without confusing stash push with publication",
    { skip: process.platform !== "darwin" },
    async () => {
        const f = await fixture();
        const env = f.app.envFor(f.worker);

        const run = async (command: string | readonly string[]) => {
            let output = "";
            const execution = await env.exec(
                command,
                {
                    timeout: 10,
                    env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
                    onOutput: (text) => {
                        output += text;
                    },
                },
                context,
            );

            assert.ok(
                execution.ok,
                `${JSON.stringify(command)}: ${!execution.ok ? execution.error.message : ""}`,
            );
            assert.equal(execution.value.exitCode, 0, `${JSON.stringify(command)}: ${output}`);
        };

        const commands: (string | readonly string[])[] = [
            ["git", "stash", "push", "--message", "local changes"],
            `git --no-pager -C '${f.cwd}' -c core.fsmonitor=false stash push --message options`,
            ["/bin/bash", "-c", "git stash push --message nested"],
            "env GIT_TERMINAL_PROMPT=0 git stash push --message wrapped",
            "git status --short && git stash push --message compound",
        ];

        for (const command of commands) {
            writeFileSync(join(f.cwd, "code.txt"), "preserved local changes\n");
            await run(command);
            assert.equal(readFileSync(join(f.cwd, "code.txt"), "utf8"), "landed\n");
            assert.notEqual(git(f.cwd, "stash", "list"), "");
            await run(["git", "stash", "pop"]);
            assert.equal(
                readFileSync(join(f.cwd, "code.txt"), "utf8"),
                "preserved local changes\n",
            );
            assert.equal(git(f.cwd, "stash", "list"), "");
        }

        // A later command's data is not an operation of the preceding Git command.
        await run("git status --short; printf '%s\\n' push send-pack receive-pack");
        writeFileSync(join(f.cwd, "code.txt"), "landed\n");
        git(f.cwd, "checkout", "-qb", "local-rebase", "HEAD~1");
        writeFileSync(join(f.cwd, "local.txt"), "local commit\n");
        git(f.cwd, "add", "local.txt");
        git(f.cwd, "commit", "-qm", "local commit");
        await run(["git", "rebase", "topic"]);
        assert.equal(git(f.cwd, "rev-parse", "HEAD^"), git(f.cwd, "rev-parse", "topic"));
        assert.equal(readFileSync(join(f.cwd, "code.txt"), "utf8"), "landed\n");
        assert.equal(readFileSync(join(f.cwd, "local.txt"), "utf8"), "local commit\n");
        assert.equal(git(f.cwd, "status", "--porcelain"), "");
        assert.equal(remoteRefs(f.remote), "");
        assert.equal(f.app.approvals.all().length, 0);
    },
);

test("managed shell delivers literal commit messages and search operands unchanged to confinement", async () => {
    const f = await fixture();
    const delivered: { command: string | readonly string[]; readOnly: boolean }[] = [];
    const refused = err<ShellExecResult, ExecutionError>(
        new ExecutionError("shell_unavailable", "fixture refuses native launch"),
    );
    const protect = (id: ConversationId) =>
        protectWorkflowEnv(
            f.app,
            id,
            new NodeExecutionEnv({ cwd: f.cwd }),
            async (readOnly, command) => {
                delivered.push({ command, readOnly });

                return refused;
            },
        );
    const message =
        "Document git push/send-pack/receive-pack and gh restrictions.\n\nNo push or restart.";
    const commands: (string | readonly string[])[] = [
        `git -C '${f.cwd}' commit -m '${message}' && git -C '${f.cwd}' status --porcelain && test HEAD = HEAD && git -C '${f.cwd}' merge --ff-only topic`,
        ["git", "-C", f.cwd, "commit", "-m", message],
        `git commit --message='Explain git push and gh pr create'`,
        ["git", "commit", "--message", message, "-m", "bash -c 'git push'; gh pr create"],
        ["git", "commit", "-mExplain git push and gh pr create"],
        `git commit --amend --no-edit -a -q -m "Explain git push | gh pr create" || git status`,
        ["git", "-C", "push", "status"],
        ["git", "stash", "push"],
        ["git", "rebase", "topic"],
        `rg -n 'Direct Git|send-pack|receive-pack|publicationCommand|publication.*shell|isPublication|publication.*command' src/server/workflow-policy.ts`,
        ["rg", "-n", "git push|gh pr create", "src/server/workflow-policy.ts"],
        `/usr/bin/grep -n 'git push and gh pr create' src/server/workflow-policy.ts`,
        `rg 'git push|gh pr create' code.txt | head -n 2`,
    ];
    const env = protect(f.worker);

    for (const command of commands) {
        const before = delivered.length;
        const result = await env.exec(command, undefined, context);

        assert.equal(result, refused, JSON.stringify(command));
        assert.deepEqual(delivered.slice(before), [{ command, readOnly: false }]);
    }

    // Retirement still permits literal searches, never local integration or an interpreter.
    await f.handoff(f.worker, "researcher");
    const retired = env;
    const search = commands.find(
        (command) => typeof command === "string" && command.startsWith("rg -n"),
    )!;

    assert.equal(await retired.exec(search, undefined, context), refused);
    assert.deepEqual(delivered.at(-1), { command: search, readOnly: true });
    const before = delivered.length;
    const commit = await retired.exec(commands[0]!, undefined, context);

    assert.match(!commit.ok ? commit.error.message : "", /verified simple inspection/);
    assert.equal(delivered.length, before);
});

test("managed shell refuses publication before spawning, including wrappers and file remotes", async () => {
    const f = await fixture();

    await f.send(f.worker, "bash", { command: push().command.join(" ") });
    assert.equal(
        remoteRefs(f.remote),
        "",
        "An active Worker's direct push must not mutate even a local bare remote",
    );
    assert.equal(
        f.app.approvals.all().length,
        0,
        "Shell publication cannot bypass the mandatory publication tool by creating an ordinary approval",
    );
    let launches = 0;
    const env = protectWorkflowEnv(
        f.app,
        f.worker,
        new NodeExecutionEnv({ cwd: f.cwd }),
        async () => {
            launches++;

            return err(new ExecutionError("shell_unavailable", "fixture refuses native launch"));
        },
    );
    const program = workflowGitPath() ?? "git";
    const helpers = git(f.cwd, "--exec-path");
    const commands: (string | readonly string[])[] = [
        push().command,
        ["git", "push", `file://${f.remote}`, "HEAD:refs/heads/published"],
        ["git", "-C", "stash", "push", f.remote, "HEAD:refs/heads/published"],
        ["git", "--unknown-option", "stash", "push", f.remote],
        `git stash list; ${push().command.join(" ")}`,
        `git stash push && ${push().command.join(" ")}`,
        `/bin/bash -c 'git stash list; ${push().command.join(" ")}'`,
        `git status | /bin/sh -c '${push().command.join(" ")}'`,
        `printf '%s' '${push().command.join(" ")}' | /bin/sh`,
        `rg '${push().command.join(" ")}' code.txt | /bin/sh`,
        `grep '${push().command.join(" ")}' code.txt | xargs /bin/sh -c`,
        ["node", "-e", `require('child_process').execSync('${push().command.join(" ")}')`],
        `/bin/sh -c "git commit -m 'gh pr create'"`,
        `find . -exec /bin/sh -c '${push().command.join(" ")}' \\;`,
        `git rebase --exec '${push().command.join(" ")}' HEAD~1`,
        `rg --pre '${push().command.join(" ")}' pattern code.txt`,
        `rg --hostname-bin '${push().command.join(" ")}' pattern code.txt`,
        ["rg", `--pr=${push().command.join(" ")}`, "pattern", "code.txt"],
        ["rg", `--hostname-b=${push().command.join(" ")}`, "pattern", "code.txt"],
        `rg "$(${push().command.join(" ")})" code.txt`,
        `git commit -m 'literal message' && ${push().command.join(" ")}`,
        `git -c core.editor=/bin/sh commit --edit -m '${push().command.join(" ")}'`,
        ["git", "-c", "core.editor=/bin/sh", "commit", "-e", "-m", push().command.join(" ")],
        `git -c core.editor=/bin/sh commit -ae -m '${push().command.join(" ")}'`,
        `git commit --allow-empty -m 'local; ${push().command.join(" ")}' | /bin/sh`,
        `git commit -m '${push().command.join(" ")}'; /bin/sh .git/COMMIT_EDITMSG`,
        `git commit -m '${push().command.join(" ")}' && /bin/sh .git/COMMIT_EDITMSG`,
        `git commit -m '${push().command.join(" ")}'; git -c core.editor=/bin/sh commit --amend --edit`,
        `git commit --template -m 'gh pr create'`,
        `git commit -m "$(${push().command.join(" ")})"`,
        ["git", "-c", `core.editor=${push().command.join(" ")}`, "commit", "-m", "literal"],
        `(${push().command.join(" ")})`,
        `echo "$(${push().command.join(" ")})"`,
        `git -c alias.publish='!${push().command.join(" ")}' publish`,
        ["git", "-c", "alias.publish=!git", "publish", ...push().command.slice(1)],
        ["git", "publish", "push", f.remote, "HEAD:refs/heads/published"],
        ["git", "-c", `core.fsmonitor=${push().command.join(" ")}`, "stash", "list"],
        ["/bin/bash", "-c", `git -c core.fsmonitor=false ${push().command.slice(1).join(" ")}`],
        ["/bin/bash", "--noprofile", "--norc", "-c", push().command.join(" ")],
        ["/bin/bash", "-c", `/bin/sh -c '${push().command.join(" ")}'`],
        "gi\\\nt pu\\\nsh origin HEAD:refs/heads/published",
        `/bin/bash -c '${push().command.join(" ")}'`,
        `env GIT_TERMINAL_PROMPT=0 ${push().command.join(" ")}`,
        [
            program,
            "--no-pager",
            "-C",
            f.cwd,
            "-c",
            "core.fsmonitor=false",
            ...push().command.slice(1),
        ],
        ["/usr/bin/git", "--git-dir", join(f.cwd, ".git"), ...push().command.slice(1)],
        `'${program}' --no-pager -C '${f.cwd}' -c core.fsmonitor=false push origin HEAD:refs/heads/published`,
        `g'it' pu"sh" origin HEAD:refs/heads/published`,
        `git -C'${f.cwd}' -ccore.fsmonitor=false push origin HEAD:refs/heads/published > /dev/null`,
        ["git", "send-pack", f.remote, "HEAD:refs/heads/published"],
        `true && '${join(helpers, "git-send-pack")}' '${f.remote}' HEAD:refs/heads/published`,
        ["git", "receive-pack", f.remote],
        [join(helpers, "git-receive-pack"), f.remote],
        ["gh", "api", "--method", "POST", "repos/example/test/issues"],
        `'/no-such/bin/gh' pr create --repo example/test --title Test --body Test`,
    ];

    for (const command of commands) {
        const execution = await env.exec(command, { timeout: 5 }, context);

        assert.equal(execution.ok, false, JSON.stringify(command));
        assert.match(
            !execution.ok ? execution.error.message : "",
            /publication/,
            `Known publication CLI commands must be refused before spawning, not merely fail offline or because a binary is missing: ${JSON.stringify(command)}`,
        );
        assert.equal(launches, 0, "No publication candidate may reach native execution");
        assert.equal(remoteRefs(f.remote), "", JSON.stringify(command));
        assert.equal(f.app.approvals.all().length, 0);
    }
});

test(
    "approval binds concrete source commit, push URL and bytes",
    { skip: process.platform !== "darwin" },
    async () => {
        const f = await fixture();

        git(f.cwd, "tag", "-a", "landed-tag", "-m", "Reviewed Land head", "HEAD");
        const publisher = await f.publish();

        const guest = f.app.config.addUser("Publication requester", "guest").user;

        for (const change of ["deny", "source", "remote", "content", "requester"]) {
            const operation = f.send(
                publisher,
                "publication",
                push(change === "deny" ? "landed-tag" : "topic"),
                change === "requester" ? guest : owner(f.app),
            );
            const approval = await pending(f.app);
            const subject = JSON.parse(approval.subject) as {
                command: string[];
                cwd: string;
                fingerprint: string;
            };

            assert.equal(subject.command.at(-2), f.remote);
            assert.equal(
                subject.command.at(-1),
                `${git(f.cwd, "rev-parse", "topic")}:refs/heads/published`,
                "Sources, including annotated tags, are peeled and bound to the approved checkout head",
            );
            assert.equal(subject.cwd, realpathSync(f.cwd));
            assert.match(subject.fingerprint, /^[0-9a-f]{64}$/);

            if (change === "source") {
                git(f.cwd, "update-ref", "refs/heads/topic", "HEAD~1");
            } else if (change === "remote") {
                git(f.cwd, "remote", "set-url", "--push", "origin", `${f.remote}-changed`);
            } else if (change === "content") {
                writeFileSync(join(f.cwd, "code.txt"), "changed\n");
            } else if (change === "requester") {
                f.app.setAccess(owner(f.app), guest.id, { role: "viewer" });
            }

            await f.app.answerApproval(approval.id, change !== "deny", owner(f.app));
            await operation;
            assert.equal(remoteRefs(f.remote), "", change);
            assert.equal(
                Object.keys(
                    (await f.app.harness.snapshot(PublicationsDoc, publisher, context))?.receipts ??
                        {},
                ).length,
                0,
            );
            git(f.cwd, "update-ref", "refs/heads/topic", "HEAD");
            git(f.cwd, "remote", "set-url", "--push", "origin", f.remote);
            git(f.cwd, "reset", "--hard", "-q", "HEAD");
        }

        const withoutIdentity = f.send(publisher, "publication", push());
        const unrecorded = await pending(f.app);

        f.app.approvals.answer(unrecorded.id, { allow: true, by: owner(f.app).name });
        await withoutIdentity;
        assert.equal(
            remoteRefs(f.remote),
            "",
            "Direct approval answers without a durable human receipt fail closed",
        );
        const operation = f.send(publisher, "publication", push());
        const approval = await pending(f.app);

        assert.equal(
            JSON.parse(approval.subject).command.at(-1),
            `${git(f.cwd, "rev-parse", "HEAD")}:refs/heads/published`,
            "The approved tool binds the same push that the active Worker shell could not execute",
        );
        assert.equal(remoteRefs(f.remote), "", "Nothing executes while waiting");
        await f.app.answerApproval(approval.id, true, owner(f.app));
        await operation;
        assert.equal(
            remoteRefs(f.remote),
            `refs/heads/published ${git(f.cwd, "rev-parse", "HEAD")}`,
        );
        const receipt = Object.values(
            (await f.app.harness.snapshot(PublicationsDoc, publisher, context))?.receipts ?? {},
        )[0]!;

        assert.equal(receipt.state, "completed");
        assert.equal(receipt.exitCode, 0);
        assert.equal(receipt.approver, owner(f.app).id);
        assert.equal(receipt.requester, owner(f.app).id);
    },
);

test(
    "a nonzero publication exit stays uncertain even after a real remote mutation",
    { skip: process.platform !== "darwin" },
    async () => {
        const f = await fixture();
        const publisher = await f.publish();
        const head = git(f.cwd, "rev-parse", "HEAD");
        const trace = join(f.cwd, ".git", "nonzero-trace");
        const hook = join(f.cwd, ".git", "hooks", "pre-push");

        // Seed objects without publishing a ref. The approved child hook then simulates a partial publication.
        git(f.remote, "fetch", "-q", f.cwd, "HEAD");
        writeFileSync(
            hook,
            `#!/bin/sh\nprintf 'attempt\\n' >> ${JSON.stringify(trace)}\ngit --git-dir=${JSON.stringify(f.remote)} update-ref refs/heads/published ${head} || exit 24\nexit 23\n`,
        );
        chmodSync(hook, 0o755);
        assert.equal(remoteRefs(f.remote), "");
        const operation = f.send(publisher, "publication", push());
        const approval = await pending(f.app);

        await f.app.answerApproval(approval.id, true, owner(f.app));
        await operation;
        const receipt = Object.values(
            (await f.app.harness.snapshot(PublicationsDoc, publisher, context))?.receipts ?? {},
        )[0]!;

        assert.equal(
            remoteRefs(f.remote),
            `refs/heads/published ${head}`,
            "The external ref really changed despite CLI failure",
        );
        assert.equal(receipt.state, "executing");
        assert.notEqual(receipt.exitCode, 0);
        assert.notEqual(
            receipt.exitCode,
            undefined,
            "Nonzero exit is retained for human diagnostics",
        );
        await f.send(publisher, "publication", push());
        assert.equal(
            f.app.approvals.all().length,
            0,
            "A duplicate attempt cannot even ask until uncertainty is reconciled",
        );
        assert.equal(readFileSync(trace, "utf8"), "attempt\n");
        await assert.rejects(
            f.handoff(publisher, "pull"),
            /Reconcile uncertain publication actions/,
        );
        assert.equal(
            (
                await f.app
                    .envFor(publisher)
                    .writeFile(".git/hooks/pre-push", "#!/bin/sh\nexit 0\n", context)
            ).ok,
            true,
            "Offline hook repairs remain possible while outcome is uncertain",
        );
        const resolving = f.send(publisher, "publication", {
            action: "resolve",
            receiptId: receipt.id,
            outcome: "completed",
            reason: "Human verified the bare remote ref changed to the approved commit, despite the CLI error.",
        });
        const reconciliation = await pending(f.app);

        await f.app.answerApproval(reconciliation.id, true, owner(f.app));
        await resolving;
        assert.equal(
            (await f.app.harness.snapshot(PublicationsDoc, publisher, context))?.receipts[
                receipt.id
            ]?.state,
            "reconciled",
        );
        const retry = f.send(publisher, "publication", push());
        const fresh = await pending(f.app);

        assert.notEqual(fresh.id, receipt.id, "A retry requires new exact approval");
        assert.equal(readFileSync(trace, "utf8"), "attempt\n");
        await f.app.answerApproval(fresh.id, false, owner(f.app));
        await retry;
        assert.equal(readFileSync(trace, "utf8"), "attempt\n");
    },
);

test(
    "an interrupted real push persists uncertainty across restart and cannot repeat without human reconciliation",
    { skip: process.platform !== "darwin" },
    async () => {
        const f = await fixture();
        const publisher = await f.publish();

        await f.send(publisher, "subagent", {
            action: "spawn",
            name: "reconciliation-helper",
            message: "Wait for a reconciliation request.",
        });
        const helper = (await f.app.harness.snapshot(SubagentsDoc, publisher, context))?.agents[
            "reconciliation-helper"
        ];

        assert.ok(helper);
        await (await f.app.conversation(helper.conversationId)).waitForIdle(context);
        const trace = join(f.cwd, ".git", "mutation-trace");
        const hook = join(f.cwd, ".git", "hooks", "pre-push");

        writeFileSync(
            hook,
            `#!/bin/sh\nprintf 'attempt\\n' >> ${JSON.stringify(trace)}\nsleep 30\n`,
        );
        chmodSync(hook, 0o755);
        const operation = f.send(publisher, "publication", push());
        const approval = await pending(f.app);

        await f.app.answerApproval(approval.id, true, owner(f.app));
        await until(() => existsSync(trace), "real approved child hook starts");
        assert.equal(
            (await f.app.envFor(publisher).writeFile("code.txt", "race", context)).ok,
            false,
            "Publication lock excludes sibling local mutations",
        );
        assert.equal(
            (await f.app.envFor(publisher).exec("printf race > code.txt", undefined, context)).ok,
            false,
        );
        const before = Object.values(
            (await f.app.harness.snapshot(PublicationsDoc, publisher, context))?.receipts ?? {},
        )[0]!;

        assert.equal(before.state, "executing");
        await f.send(helper.conversationId, "publication", {
            action: "resolve",
            receiptId: before.id,
            outcome: "not-executed",
            reason: "Do not reconcile a publication while its real child process is running.",
        });
        assert.equal(
            f.app.approvals.all().length,
            0,
            "A running publication cannot be reconciled, even by another managed subagent",
        );
        assert.match(
            (await modelTexts(f.app, helper.conversationId)).at(-1)!,
            /Another publication is executing/,
        );
        assert.equal(
            (await f.app.harness.snapshot(PublicationsDoc, publisher, context))?.receipts[before.id]
                ?.state,
            "executing",
        );
        await f.app.harness.abortTask(approval.taskId, context);
        await operation;
        await f.app.close();
        apps.delete(f.app);
        const reopened = await openApp(f.model, f.dataDir);

        apps.add(reopened);
        await reopened.harness.waitForIdle(context);
        assert.equal(
            readFileSync(trace, "utf8"),
            "attempt\n",
            "Recovery never replays the external process",
        );
        assert.equal(
            (await reopened.harness.snapshot(PublicationsDoc, publisher, context))?.receipts[
                before.id
            ]?.state,
            "executing",
        );
        await f.send(publisher, "publication", push(), owner(reopened), reopened);
        assert.equal(reopened.approvals.all().length, 0);
        assert.equal(readFileSync(trace, "utf8"), "attempt\n");
        assert.match(
            (await modelTexts(reopened, publisher)).join("\n"),
            /earlier publication may have executed/,
        );
        writeFileSync(join(f.cwd, "code.txt"), "hook repair needs fresh review\n");
        await assert.rejects(
            f.handoff(publisher, "pull", reopened),
            /Reconcile uncertain publication actions/,
        );
        assert.equal(reopened.handoffs.isReadOnly(publisher), false);
        assert.equal(readFileSync(trace, "utf8"), "attempt\n");
        const resolving = f.send(
            publisher,
            "publication",
            {
                action: "resolve",
                receiptId: before.id,
                outcome: "not-executed",
                reason: "Human checked the disposable remote refs; the hook was stopped before any ref update.",
            },
            owner(reopened),
            reopened,
        );
        const reconciliation = await pending(reopened);

        assert.match(reconciliation.reason, /Human reconciliation required/);
        assert.equal(
            (await reopened.harness.snapshot(PublicationsDoc, publisher, context))?.receipts[
                before.id
            ]?.state,
            "executing",
        );
        await reopened.answerApproval(reconciliation.id, true, owner(reopened));
        await resolving;
        const reconciled = (await reopened.harness.snapshot(PublicationsDoc, publisher, context))
            ?.receipts[before.id];

        assert.equal(reconciled?.state, "reconciled");
        assert.equal(reconciled?.resolution?.by, owner(reopened).id);
        assert.equal(
            readFileSync(trace, "utf8"),
            "attempt\n",
            "Resolution itself never invokes the CLI",
        );
        const intake = await f.handoff(publisher, "pull", reopened);
        const repair = await f.handoff(intake, "worker", reopened);
        const nextReviewer = await f.handoff(repair, "reviewer", reopened);

        git(f.cwd, "commit", "-qam", "Locally reviewed hook repair");
        const nextLand = await f.handoff(nextReviewer, "land", reopened);

        const nextPublisher = await f.handoff(nextLand, "publish", reopened);

        await f.send(nextPublisher, "publication", { action: "status" }, owner(reopened), reopened);
        const history = (await modelTexts(reopened, nextPublisher)).at(-1)!;

        assert.ok(
            history.includes(before.id),
            "Successor sees the original member's publication receipt",
        );
        assert.match(history, /reconciled/);
        assert.equal(
            Object.keys(
                (await reopened.harness.snapshot(PublicationsDoc, nextPublisher, context))
                    ?.receipts ?? {},
            ).length,
            0,
            "Publication ledger is not copied into successors",
        );
        const retry = f.send(nextPublisher, "publication", push(), owner(reopened), reopened);
        const freshApproval = await pending(reopened);

        assert.notEqual(
            freshApproval.id,
            before.id,
            "A new attempt still needs separate human approval",
        );
        assert.equal(
            readFileSync(trace, "utf8"),
            "attempt\n",
            "Successor activation never repeats the prior command",
        );
        await reopened.answerApproval(freshApproval.id, false, owner(reopened));
        await retry;
        assert.equal(readFileSync(trace, "utf8"), "attempt\n");
    },
);
