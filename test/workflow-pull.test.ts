// Core policy, durable ownership and real child processes own these contracts; no live credentials or remotes.
import {
    cleanUp,
    context,
    executeHandoff,
    lastText,
    modelTexts,
    openApp,
    owner,
    root,
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
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { SessionsDoc, SubagentsDoc } from "../src/server/docs.ts";
import type { ThreadType } from "../src/server/workflow-docs.ts";
import { sshFixture } from "./ssh-fixture.ts";

after(cleanUp);
let serial = 0;

function git(cwd: string, ...args: string[]) {
    return execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    }).trim();
}

async function fixture(t: TestContext, threadType: ThreadType = "pull") {
    const directory = join(root, `pull-${++serial}`);
    const cwd = join(directory, "checkout");
    const upstream = join(directory, "upstream");
    const bin = join(directory, "bin");
    const log = join(directory, "calls.jsonl");
    const barrier = join(directory, "barrier");
    const exit = join(directory, "exit-code");

    for (const path of [cwd, upstream, bin]) {
        mkdirSync(path, { recursive: true });
    }

    git(upstream, "init", "-q", "--initial-branch=main");
    git(upstream, "config", "user.name", "Test");
    git(upstream, "config", "user.email", "test@example.invalid");
    writeFileSync(join(upstream, "code.txt"), "base\n");
    git(upstream, "add", ".");
    git(upstream, "commit", "-qm", "base");
    git(cwd, "clone", "-q", upstream, ".");
    writeFileSync(join(upstream, "code.txt"), "upstream\n");
    git(upstream, "commit", "-qam", "upstream");

    // A launch-PATH executable fixture, not a mocked tool: record actual delivery/env and emit output
    // without external authentication. Network/GitHub semantics are not claimed by this fixture.
    writeFileSync(
        join(bin, "gh"),
        `#!${process.execPath}
import {appendFileSync, existsSync, readFileSync} from 'node:fs';
appendFileSync(${JSON.stringify(log)}, JSON.stringify({argv:process.argv.slice(2), cwd:process.cwd(), pager:process.env.GH_PAGER, host:process.env.GH_HOST, configCount:process.env.GIT_CONFIG_COUNT})+'\\n');
while (existsSync(${JSON.stringify(barrier)})) { await new Promise(resolve=>setTimeout(resolve,20)); }
console.log('UPSTREAM READ RESULT');
process.exitCode=existsSync(${JSON.stringify(exit)})?Number(readFileSync(${JSON.stringify(exit)},'utf8')):0;
`,
    );
    chmodSync(join(bin, "gh"), 0o755);
    const oldPath = process.env.PATH;
    const oldConfigCount = process.env.GIT_CONFIG_COUNT;

    process.env.PATH = `${bin}:${oldPath}`;
    let planned = {
        name: "pull",
        args: { command: ["gh", "pr", "view", "7", "--repo", "team/project"] } as Parameters<
            typeof fauxToolCall
        >[1],
    };
    let releaseWriter: (() => void) | undefined;
    const writerGate = new Promise<void>((resolve) => {
        releaseWriter = resolve;
    });
    const model = scriptedModel(async (request) => {
        const last = lastText(request as never);
        const user = lastText({
            messages: request.messages.filter((each) => each.role === "user"),
        });

        if (user.text.endsWith("HOLD WRITER")) {
            if (last.role === "user") {
                return fauxAssistantMessage(
                    [fauxToolCall("write", { path: "helper-started.txt", content: "started" })],
                    { stopReason: "toolUse" },
                );
            }

            if (!existsSync(join(cwd, "helper-finished.txt"))) {
                await writerGate;

                return fauxAssistantMessage(
                    [fauxToolCall("write", { path: "helper-finished.txt", content: "finished" })],
                    { stopReason: "toolUse" },
                );
            }
        }

        if (last.role === "user" && last.text.includes("FETCH_FROM_HANDOFF")) {
            return fauxAssistantMessage(
                [fauxToolCall("pull", { command: ["git", "fetch", "origin"] })],
                { stopReason: "toolUse" },
            );
        }

        if (last.role === "user" && last.text.endsWith("RUN TOOL")) {
            return fauxAssistantMessage([fauxToolCall(planned.name, planned.args)], {
                stopReason: "toolUse",
            });
        }

        return fauxAssistantMessage([fauxText(`echo: ${last.text}`)]);
    });
    const app = await openApp(model, join(directory, "data"));

    t.after(async () => {
        releaseWriter?.();
        rmSync(barrier, { force: true });
        await app.close();
        process.env.PATH = oldPath;

        if (oldConfigCount === undefined) {
            delete process.env.GIT_CONFIG_COUNT;
        } else {
            process.env.GIT_CONFIG_COUNT = oldConfigCount;
        }
    });
    const project = await app.projects.create(owner(app), {
        name: "Pull fixture",
        cwd,
        requestId: crypto.randomUUID(),
    });
    const { id } = await app.commands.createSession(owner(app), {
        cwd,
        projectId: project.id,
        threadType,
    });

    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });

    const send = async (
        name: string,
        args: Parameters<typeof fauxToolCall>[1],
        target = id,
        user = owner(app),
    ) => {
        planned = { name, args };
        // Simulate a resumed invocation too: retirement/revocation must work without HTTP admission.
        const submitted = await (
            await app.conversation(target)
        ).submit(
            {
                type: "input",
                content: "RUN TOOL",
                requestId: `u:${user.id}:${crypto.randomUUID()}`,
            },
            context,
        );

        await submitted.wait(context);

        return (await modelTexts(app, target)).at(-1)!;
    };

    const calls = () =>
        existsSync(log)
            ? readFileSync(log, "utf8")
                  .trim()
                  .split("\n")
                  .map((line) => JSON.parse(line))
            : [];

    return { app, id, cwd, upstream, send, calls, barrier, exit, releaseWriter };
}

const view = ["gh", "pr", "view", "7", "--repo", "team/project"];

test("Pull delivers bounded explicit GitHub reads and model-visible output; inherited shell remains offline", async (t) => {
    const f = await fixture(t);

    process.env.GIT_CONFIG_COUNT = "1";
    assert.match(await f.send("pull", { command: view }), /UPSTREAM READ RESULT/);
    const { cwd: externalCwd, ...firstCall } = f.calls()[0];

    assert.notEqual(externalCwd, f.cwd, "GitHub reads must not discover checkout configuration");
    assert.match(externalCwd, /pi-pull-github-/);
    assert.equal(existsSync(externalCwd), false, "neutral host staging is removed after the read");
    assert.deepEqual(firstCall, {
        argv: ["pr", "view", "7", "--repo=github.com/team/project"],
        pager: "/bin/cat",
        host: "github.com",
    });
    assert.match(
        await f.send("pull", {
            command: [
                "gh",
                "issue",
                "list",
                "-R",
                "team/project",
                "--state=closed",
                "--json",
                "number,title",
            ],
        }),
        /UPSTREAM READ RESULT/,
    );
    assert.deepEqual(f.calls()[1].argv, [
        "issue",
        "list",
        "--state=closed",
        "--json=number,title",
        "--repo=github.com/team/project",
        "--limit=20",
    ]);
    assert.equal(
        f.app.approvals.all().length,
        0,
        "Constrained reads do not request mutation approval",
    );
    const direct = await f.app
        .envFor(f.id)
        .exec(["gh", "pr", "view", "7", "--repo", "team/project"], undefined, context);

    assert.equal(direct.ok, false, "The Pull role never enables direct gh commands in bash");
    assert.equal(f.calls().length, 2);
});

test("SSH Pull GitHub reads remain host-owned when remote authentication fails", async (t) => {
    const ssh = await sshFixture("auth-failed");
    const f = await fixture(t);

    t.after(async () => {
        await ssh.env.cleanup(context);
        await ssh.close();
    });
    await f.app.harness.commit(async (tx) => {
        (await tx.doc(SessionsDoc)).items[String(f.id)]!.location = {
            kind: "ssh",
            host: "auth-failed",
        };
    }, context);

    assert.match(await f.send("pull", { command: view }), /UPSTREAM READ RESULT/);
    assert.equal(f.calls().length, 1);
    assert.notEqual(f.calls()[0].cwd, f.cwd);
    assert.match(f.calls()[0].cwd, /pi-pull-github-/);
    assert.equal(existsSync(f.calls()[0].cwd), false);
    assert.deepEqual(f.calls()[0].argv, ["pr", "view", "7", "--repo=github.com/team/project"]);
    assert.equal(f.app.approvals.all().length, 0);
});

test("Pull refuses mutation, interactive/config/script payloads, arbitrary API and unbounded reads before spawning", async (t) => {
    const f = await fixture(t);
    const denied = [
        ["git", "push", "origin", "HEAD:refs/heads/main"],
        ["git", "fetch"],
        ["git", "fetch", "origin", "--upload-pack=evil"],
        ["git", "fetch", "https://example.invalid/project.git"],
        ["git", "-c", "alias.fetch=!evil", "fetch", "origin"],
        ["sh", "-c", "gh pr view 7 --repo team/project"],
        ["gh", "pr", "create", "--repo", "team/project"],
        ["gh", "issue", "comment", "7", "--repo", "team/project"],
        ["gh", "api", "repos/team/project", "--method", "POST"],
        ["gh", "extension", "exec", "read"],
        ["gh", "custom-alias"],
        ["gh", "pr", "view", "7"],
        ["gh", "pr", "view", "https://github.com/team/project/pull/7", "--repo", "team/project"],
        [...view, "--repo", "other/project"],
        [...view, "--web"],
        [...view, "--template", "{{evil}}"],
        [...view, "--jq", "."],
        [...view, "--hostname", "other.invalid"],
        [...view, "--json", "title\n--web"],
        ["gh", "issue", "list", "--repo", "team/project", "--limit", "101"],
        ["gh", "issue", "list", "--repo", "team/project", "--paginate"],
    ];

    for (const command of denied) {
        const reply = await f.send("pull", { command });

        assert.doesNotMatch(reply, /UPSTREAM READ RESULT/, JSON.stringify(command));
        assert.match(
            reply,
            /bounded argv|Pull accepts only|Pull supports only|gh view requires|Duplicate Pull option|Unsupported Pull option|gh Pull reads require|--json accepts only|gh list --limit must/,
        );
    }

    assert.equal(f.calls().length, 0, "Not one rejected argv reached the external program");
    assert.equal(f.app.approvals.all().length, 0);
});

test("live role and retirement prevent external reads, including resumed calls", async (t) => {
    const f = await fixture(t);

    for (const threadType of [
        "chat",
        "worker",
        "researcher",
        "reviewer",
        "follow-up",
        "land",
        "publish",
    ] satisfies ThreadType[]) {
        await f.app.harness.commit(async (tx) => {
            (await tx.doc(SessionsDoc)).items[String(f.id)]!.threadType = threadType;
        }, context);
        assert.match(await f.send("pull", { command: view }), /Only the current active Pull/);
    }

    await f.app.harness.commit(async (tx) => {
        (await tx.doc(SessionsDoc)).items[String(f.id)]!.threadType = "pull";
    }, context);
    await executeHandoff(f.app, f.id, "worker");
    assert.match(await f.send("pull", { command: view }), /read-only/);
    assert.equal(f.calls().length, 0);
});

test("helpers inherit Pull GitHub reads but cannot fetch; a revoked requester cannot reuse the capability", async (t) => {
    const f = await fixture(t);

    await f.send("subagent", {
        action: "spawn",
        name: "pull-helper",
        message: "Wait for the next request.",
    });
    const helper = (await f.app.harness.snapshot(SubagentsDoc, f.id, context))?.agents[
        "pull-helper"
    ];

    assert.ok(helper);
    await (await f.app.conversation(helper.conversationId)).waitForIdle(context);
    assert.match(
        await f.send("pull", { command: view }, helper.conversationId),
        /UPSTREAM READ RESULT/,
    );
    assert.match(
        await f.send("pull", { command: ["git", "fetch", "origin"] }, helper.conversationId),
        /Only the main Pull thread/,
    );
    assert.equal(f.calls().length, 1);
    const guest = f.app.config.addUser("Requester", "guest").user;

    await f.send("read", { path: "code.txt" }, f.id, guest);
    f.app.setAccess(owner(f.app), guest.id, { role: "viewer" });
    assert.doesNotMatch(
        await f.send("pull", { command: view }, f.id, guest),
        /UPSTREAM READ RESULT/,
    );
    assert.equal(f.calls().length, 1);
});

// A FIFO keeps an actual filesystem operation in flight, even outside a registered ToolTask.
test(
    "an already-running filesystem writer excludes Pull until it finishes",
    { skip: process.platform === "win32" },
    async (t) => {
        const f = await fixture(t);

        await f.send("read", { path: "code.txt" });
        execFileSync("mkfifo", [join(f.cwd, "writer-pipe")]);
        let settled = false;
        const writer = f.app
            .envFor(f.id)
            .writeFile("writer-pipe", "writer finished", context)
            .finally(() => {
                settled = true;
            });

        try {
            assert.match(
                await f.send("pull", { command: view }),
                /Local workflow writes are still executing/,
            );
            assert.equal(
                f.calls().length,
                0,
                "no external process may start while the write is in flight",
            );
        } finally {
            if (!settled) {
                assert.equal(await readFile(join(f.cwd, "writer-pipe"), "utf8"), "writer finished");
            }

            assert.equal((await writer).ok, true);
        }

        assert.match(await f.send("pull", { command: view }), /UPSTREAM READ RESULT/);
        assert.equal((await f.app.envFor(f.id).writeFile(".", "fails", context)).ok, false);
        assert.match(
            await f.send("pull", { command: view }),
            /UPSTREAM READ RESULT/,
            "failed writes release their reservation too",
        );
    },
);

// Admission must inspect the real descendant task graph, not just deny operations arriving after Pull.
test("fetch refuses an existing helper writer without aborting it; helper GitHub reads remain allowed", async (t) => {
    const f = await fixture(t);
    const originalRefs = git(f.cwd, "show-ref");

    await f.send("subagent", { action: "spawn", name: "writer", message: "HOLD WRITER" });
    const helper = (await f.app.harness.snapshot(SubagentsDoc, f.id, context))?.agents.writer;

    assert.ok(helper);
    await until(() => existsSync(join(f.cwd, "helper-started.txt")), "helper writes then waits");
    assert.equal(f.app.isBusy(helper.conversationId), true);
    // Do not apply fetch's main-invocation exemption to ordinary GitHub helper reads.
    assert.match(await f.send("pull", { command: view }), /UPSTREAM READ RESULT/);
    assert.match(
        await f.send("pull", { command: ["git", "fetch", "origin"] }),
        /Wait.*delegated helpers/,
        "Fetch must refuse before reaching Git, including the offline preflight or external read",
    );
    assert.equal(git(f.cwd, "show-ref"), originalRefs);
    assert.equal(readFileSync(join(f.cwd, "code.txt"), "utf8"), "base\n");
    assert.equal(f.calls().length, 1);
    assert.equal(f.app.isBusy(helper.conversationId), true, "admission must never abort writers");
    assert.equal(existsSync(join(f.cwd, "helper-finished.txt")), false);
    assert.equal(
        (await f.app.envFor(f.id).writeFile("after-refusal.txt", "unlocked", context)).ok,
        true,
    );

    f.releaseWriter?.();
    await until(async () => {
        const agents = await f.app.harness.snapshot(SubagentsDoc, f.id, context);

        // A finished model can still have a report waiting in the batched courier.
        return (
            !f.app.isBusy(helper.conversationId) &&
            !f.app.isBusy(f.id) &&
            agents?.courier === undefined &&
            (agents?.outbox?.length ?? 0) === 0 &&
            agents?.sending === undefined
        );
    }, "helper and its reporter finish naturally");
    assert.equal(readFileSync(join(f.cwd, "helper-finished.txt"), "utf8"), "finished");
    assert.match(await f.send("pull", { command: view }), /UPSTREAM READ RESULT/);

    // Reach a real fetch preflight without executing the unavailable sandbox: missing cwd fails
    // at realpath, not on fetch's own tool/run. This also checks release after fetch failure.
    renameSync(f.cwd, `${f.cwd}-moved`);

    try {
        assert.match(
            await f.send("pull", { command: ["git", "fetch", "origin"] }),
            /ENOENT.*realpath/,
        );
    } finally {
        renameSync(`${f.cwd}-moved`, f.cwd);
    }

    assert.equal(
        (await f.app.envFor(f.id).writeFile("after-fetch-failure.txt", "unlocked", context)).ok,
        true,
    );
});

// The incoming delivery waits for this very run: it is not an independent background writer.
test("a Pull successor can admit its first fetch while its own handoff brief is being delivered", async (t) => {
    const f = await fixture(t, "worker");

    renameSync(f.cwd, `${f.cwd}-moved`);

    try {
        const next = await executeHandoff(f.app, f.id, "pull", {
            summary: "FETCH_FROM_HANDOFF: fetch the configured origin.",
        });
        const id = next.id as ConversationId;

        await until(
            async () => !f.app.isBusy(id) && (await modelTexts(f.app, id)).length > 0,
            "the successor's initial fetch report",
        );
        const reply = (await modelTexts(f.app, id)).at(-1)!;

        assert.match(reply, /ENOENT.*realpath/, "own delivery must not block fetch admission");
        assert.doesNotMatch(reply, /background tasks|Cannot fingerprint|sandbox_apply/);
        assert.equal(f.calls().length, 0);
    } finally {
        renameSync(`${f.cwd}-moved`, f.cwd);
    }
});

test("a running Pull read holds the workflow mutation lock and a failed child is never retried automatically", async (t) => {
    const f = await fixture(t);

    writeFileSync(f.barrier, "wait");
    const operation = f.send("pull", { command: view });

    await until(() => f.calls().length === 1, "read program starts");
    assert.equal((await f.app.envFor(f.id).writeFile("code.txt", "race", context)).ok, false);
    assert.equal(
        (await f.app.envFor(f.id).exec("printf race > code.txt", undefined, context)).ok,
        false,
    );
    assert.equal(readFileSync(join(f.cwd, "code.txt"), "utf8"), "base\n");
    rmSync(f.barrier);
    await operation;
    writeFileSync(f.exit, "23");
    assert.match(await f.send("pull", { command: view }), /23.*No automatic retry/);
    assert.equal(f.calls().length, 2);
    assert.equal((await f.app.envFor(f.id).writeFile("after.txt", "unlocked", context)).ok, true);
});

test(
    "fetch imports only the named remote's heads, not configured local destinations, tags or working files",
    { skip: process.platform !== "darwin" },
    async (t) => {
        const f = await fixture(t);
        const originalHead = git(f.cwd, "rev-parse", "HEAD");
        const remoteHead = git(f.upstream, "rev-parse", "HEAD");
        const trackingHead = git(f.cwd, "symbolic-ref", "refs/remotes/origin/HEAD");
        const localBranches = git(
            f.cwd,
            "for-each-ref",
            "--format=%(refname) %(objectname)",
            "refs/heads/",
        );

        git(f.cwd, "config", "remote.origin.fetch", "+refs/heads/*:refs/heads/*");
        git(f.upstream, "tag", "remote-tag");
        assert.match(
            await f.send("pull", { command: ["git", "fetch", "origin"] }),
            /Fetched origin/,
        );
        assert.equal(git(f.cwd, "rev-parse", "refs/remotes/origin/main"), remoteHead);
        assert.equal(git(f.cwd, "rev-parse", "HEAD"), originalHead);
        assert.equal(git(f.cwd, "symbolic-ref", "refs/remotes/origin/HEAD"), trackingHead);
        assert.equal(
            git(f.cwd, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/"),
            localBranches,
        );
        assert.equal(readFileSync(join(f.cwd, "code.txt"), "utf8"), "base\n");
        assert.equal(git(f.cwd, "tag", "--list"), "");
    },
);

// Real Git owns symbolic-ref semantics; do not replace the mandatory sandbox with an unsandboxed adapter.
test(
    "fetch rejects direct, chained, dangling and HEAD symbolic destinations without changing checkout refs",
    { skip: process.platform !== "darwin" },
    async (t) => {
        const f = await fixture(t);
        const originalHead = git(f.cwd, "rev-parse", "HEAD");
        const remoteHead = git(f.upstream, "rev-parse", "HEAD");
        const trackingMain = "refs/remotes/origin/main";
        const trackingHead = "refs/remotes/origin/HEAD";
        const intermediate = "refs/remotes/other/link";
        const branches = () =>
            git(f.cwd, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/");

        git(f.cwd, "tag", "local-tag");
        git(f.upstream, "tag", "remote-tag");
        const localBranches = branches();
        const tags = git(f.cwd, "show-ref", "--tags");

        for (const [destination, target] of [
            [trackingMain, "refs/heads/main"],
            [trackingMain, intermediate],
            [trackingMain, "refs/heads/unborn"],
            [trackingHead, trackingMain],
        ]) {
            git(f.cwd, "symbolic-ref", intermediate, "refs/heads/main");
            git(f.cwd, "symbolic-ref", destination!, target!);

            if (destination === trackingHead) {
                // git branch disallows this spelling, but a remote can advertise the valid full ref.
                git(f.upstream, "update-ref", "refs/heads/HEAD", remoteHead);
            }

            const reply = await f.send("pull", { command: ["git", "fetch", "origin"] });

            assert.match(reply, /will not import into symbolic tracking ref/);
            assert.ok(reply.includes(destination!));
            assert.equal(git(f.cwd, "rev-parse", "HEAD"), originalHead);
            assert.equal(git(f.cwd, "symbolic-ref", "HEAD"), "refs/heads/main");
            assert.equal(
                branches(),
                localBranches,
                "no local branch, including unborn targets, may change",
            );
            assert.equal(git(f.cwd, "show-ref", "--tags"), tags);
            assert.equal(readFileSync(join(f.cwd, "code.txt"), "utf8"), "base\n");
            assert.equal(git(f.cwd, "symbolic-ref", "--no-recurse", destination!), target);
            git(f.cwd, "update-ref", "--no-deref", trackingMain, originalHead);
            assert.equal(
                (await f.app.envFor(f.id).writeFile("after-refusal.txt", "unlocked", context)).ok,
                true,
            );
        }

        git(f.upstream, "update-ref", "-d", "refs/heads/HEAD");
        assert.match(
            await f.send("pull", { command: ["git", "fetch", "origin"] }),
            /Fetched origin/,
        );
        assert.equal(git(f.cwd, "rev-parse", trackingMain), remoteHead);
        assert.equal(git(f.cwd, "symbolic-ref", trackingHead), trackingMain);
        assert.equal(branches(), localBranches);
        assert.equal(git(f.cwd, "show-ref", "--tags"), tags);
        assert.equal(readFileSync(join(f.cwd, "code.txt"), "utf8"), "base\n");
    },
);

test(
    "resolved custom transports, including URL rewrites, are refused before any helper can execute",
    { skip: process.platform !== "darwin" },
    async (t) => {
        const f = await fixture(t);
        const marker = join(f.cwd, "transport-executed");
        const payload = `ext::sh -c 'touch ${marker}'`;

        git(f.cwd, "remote", "set-url", "origin", payload);
        assert.match(
            await f.send("pull", { command: ["git", "fetch", "origin"] }),
            /custom transports/,
        );
        assert.equal(existsSync(marker), false);
        git(f.cwd, "remote", "set-url", "origin", "https://example.invalid/project.git");
        git(f.cwd, "config", `url.${payload}.insteadOf`, "https://example.invalid/");
        assert.match(
            await f.send("pull", { command: ["git", "fetch", "origin"] }),
            /custom transports/,
        );
        assert.equal(existsSync(marker), false);
    },
);
