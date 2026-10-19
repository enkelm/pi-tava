import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { err, FileError } from "@earendil-works/pi-durable/env";
import createPrompt from "../src/server/extensions/prompt.ts";
import { Memory } from "../src/server/memory.ts";
import { RemoteContext, readHostSkill } from "../src/server/remote-context.ts";
import { loadGlobalSkills, type SkillSources } from "../src/server/skills.ts";

const context = BACKGROUND_CONTEXT;

/** A disposable filesystem namespace with remote-looking paths, not an SSH transport simulation. */
class FixtureEnv extends NodeExecutionEnv {
    override readonly id: string;
    root: string;
    disconnected = false;

    constructor(root: string, id: string) {
        super({ cwd: "/project/app" });
        this.root = root;
        this.id = id;
    }

    override openBinaryReader(
        path: string,
        options: { noFollow?: boolean } | undefined,
        ctx: typeof context,
    ) {
        if (this.disconnected) {
            return Promise.resolve(
                err<never, FileError>(new FileError("unknown", "SSH connection lost")),
            );
        }

        return super.openBinaryReader(join(this.root, posix.normalize(path)), options, ctx);
    }
}

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "coop-ssh-context-"));
    const home = join(root, "host-home");
    const agentDir = join(home, ".pi", "agent");
    const sources: SkillSources = {
        home,
        agentDir,
        settingsPaths: [],
        defaultProjectTrust: "always",
    };

    await mkdir(join(agentDir, "skills", "guide"), { recursive: true });
    await writeFile(
        join(agentDir, "skills", "guide", "SKILL.md"),
        "---\nname: guide\ndescription: Host guide\n---\nUse the global guide.\n",
    );
    await writeFile(join(agentDir, "AGENTS.md"), "Host-global rules.");
    await mkdir(join(home, ".pi", "skills", "local-only"), { recursive: true });
    await writeFile(
        join(home, ".pi", "skills", "local-only", "SKILL.md"),
        "---\nname: local-only\ndescription: Not a global skill\n---\nNever discover this as a global skill.\n",
    );
    await writeFile(join(agentDir, "trust.json"), "unreadable project trust store");

    return { root, home, agentDir, sources, skills: loadGlobalSkills(sources) };
}

test("SSH prompt separates remote project skills from host-global skills and keeps host skills usable during connection failure", async () => {
    const f = await fixture();

    try {
        const remote = join(f.root, "remote");

        assert.deepEqual(
            f.skills.map((skill) => skill.name),
            ["guide"],
        );
        await mkdir(join(remote, "project", "app"), { recursive: true });
        await writeFile(join(remote, "AGENTS.md"), "Remote root rules.");
        await writeFile(join(remote, "project", "AGENTS.md"), "Remote project rules.");
        await writeFile(
            join(remote, "project", "app", "AGENTS.override.md"),
            "Remote override rules.",
        );
        await writeFile(join(remote, "project", "app", "AGENTS.md"), "Shadowed rules.");
        const env = new FixtureEnv(remote, "ssh:devbox");
        const projectSkill = {
            ...f.skills[0]!,
            name: "remote-guide",
            description: "Remote project guide",
            filePath: "/project/app/.pi/skills/remote-guide/SKILL.md",
            baseDir: "/project/app/.pi/skills/remote-guide",
            sourceInfo: {
                ...f.skills[0]!.sourceInfo,
                source: env.id,
                scope: "project" as const,
            },
        };
        const extension = createPrompt({
            agentDir: f.agentDir,
            dataDir: join(f.root, "data"),
            workspace: () => ({ location: { kind: "ssh", host: "devbox" }, env }),
            globalSkills: () => f.skills,
            projectResources: async () => ({ skills: [projectSkill, ...f.skills] }),
            skills: () => {
                throw new Error("Local project skill lookup must not run");
            },
            text: { defang: (text: string) => text.replace(/<\//g, "< /") },
        } as never);
        const input = { conversationId: 1, env, agent: { cwd: env.cwd } } as never;
        const render = (key: string) =>
            extension.sections!.find((section) => section.key === key)!.render(input, context);
        const project = String(await render("project_context"));

        assert.match(project, /Host-global rules/);
        assert.ok(project.indexOf("Remote root rules") < project.indexOf("Remote project rules"));
        assert.ok(
            project.indexOf("Remote project rules") < project.indexOf("Remote override rules"),
        );
        assert.doesNotMatch(project, /Shadowed rules/);
        const skillPrompt = String(await render("skills"));

        assert.match(skillPrompt, /host_skill\(name\)/);
        assert.match(skillPrompt, /Use the read tool/);
        assert.match(
            skillPrompt,
            /<location>\/project\/app\/\.pi\/skills\/remote-guide\/SKILL.md<\/location>/,
        );
        assert.match(skillPrompt, /guide: Host guide/);
        assert.ok(!skillPrompt.includes(f.skills[0]!.filePath));
        assert.doesNotMatch(skillPrompt, /Remote project skills.*unsupported/);
        assert.match(String(await render("environment")), /SSH · devbox/);
        const guidelines = String(await render("guidelines"));

        assert.match(guidelines, /stage_upload\(path\)/);
        assert.match(guidelines, /source remains on the host/);
        assert.match(guidelines, /does not stage host scripts or global skill resources/);
        assert.doesNotMatch(guidelines, /upload staging are unsupported/);
        const tool = extension.tools!.find((tool) => tool.name === "host_skill")!;
        const result = await tool.execute(
            { name: "guide" },
            { conversationId: 1 } as never,
            context,
        );

        assert.match(JSON.stringify(result), /Use the global guide/);

        // New namespace has no successful cache entry: the previous host's rules cannot leak into it.
        const failed = new FixtureEnv(remote, "ssh:offline");

        failed.disconnected = true;
        const offline = createPrompt({
            agentDir: f.agentDir,
            workspace: () => ({ location: { kind: "ssh", host: "offline" }, env: failed }),
            globalSkills: () => f.skills,
            projectResources: async () => {
                throw new Error("SSH resource connection lost");
            },
            skills: () => {
                throw new Error("No host-local project namesake may be consulted");
            },
            text: { defang: (text: string) => text },
        } as never);
        const failure = String(
            await offline
                .sections!.find((section) => section.key === "project_context")!
                .render(input, context),
        );

        assert.match(failure, /SSH connection lost/);
        assert.match(failure, /No local project context was substituted/);
        assert.doesNotMatch(failure, /Remote project rules/);
        const skillFailure = String(
            await offline
                .sections!.find((section) => section.key === "skills")!
                .render(input, context),
        );

        assert.match(skillFailure, /SSH resource connection lost/);
        assert.match(skillFailure, /guide: Host guide/);
        assert.match(skillFailure, /host_skill\(name\)/);
        assert.doesNotMatch(
            skillFailure,
            /remote-guide|No host-local project namesake may be consulted/,
        );
    } finally {
        await rm(f.root, { recursive: true, force: true });
    }
});

test("the prompt extension rejects installation when its required project resource host API is absent", () => {
    assert.throws(() => createPrompt({} as never), TypeError);
});

test("remote context cache separates equal cwd paths by filesystem identity and does not retain failures", async () => {
    const f = await fixture();

    try {
        const a = join(f.root, "a");
        const b = join(f.root, "b");

        for (const [root, text] of [
            [a, "A rules"],
            [b, "B rules"],
        ]) {
            await mkdir(join(root!, "project", "app"), { recursive: true });
            await writeFile(join(root!, "project", "AGENTS.md"), text!);
        }

        const cache = new RemoteContext();
        const first = new FixtureEnv(a, "ssh:a");
        const second = new FixtureEnv(b, "ssh:b");

        first.disconnected = true;
        await assert.rejects(cache.load(first, first.cwd, context), /SSH connection lost/);
        first.disconnected = false;
        assert.equal((await cache.load(first, first.cwd, context))[0]?.content, "A rules");
        assert.equal((await cache.load(second, second.cwd, context))[0]?.content, "B rules");
        const oversized = new FixtureEnv(b, "ssh:oversized");

        await writeFile(join(b, "project", "AGENTS.md"), "x".repeat(50 * 1024 + 1));
        await assert.rejects(cache.load(oversized, oversized.cwd, context), /size limit/);
        await writeFile(join(b, "project", "AGENTS.md"), "Fixed rules");
        assert.equal(
            (await cache.load(oversized, oversized.cwd, context))[0]?.content,
            "Fixed rules",
        );
    } finally {
        await rm(f.root, { recursive: true, force: true });
    }
});

test("host_skill confines registered resources, rejects symlink escapes and oversized files, and pages lines", async () => {
    const f = await fixture();

    try {
        const base = f.skills[0]!.baseDir;

        await writeFile(join(base, "notes.txt"), "one\ntwo\nthree");
        await writeFile(join(f.root, "secret.txt"), "Not a skill resource");
        await symlink(join(f.root, "secret.txt"), join(base, "escape.txt"));
        await writeFile(join(base, "huge.txt"), "x".repeat(50 * 1024 + 1));
        assert.match(
            await readHostSkill(f.skills, "guide", "notes.txt", 2, 1),
            /^two\n\[More lines/,
        );
        assert.equal(await readHostSkill(f.skills, "guide", "notes.txt", 3, 1), "three");
        await assert.rejects(readHostSkill(f.skills, "missing"), /No host-global skill/);
        await assert.rejects(
            readHostSkill(f.skills, "guide", "escape.txt"),
            /inside the registered skill directory/,
        );
        await assert.rejects(
            readHostSkill(f.skills, "guide", "../../../../secret.txt"),
            /inside the registered skill directory/,
        );
        await assert.rejects(
            readHostSkill(f.skills, "guide", join(f.root, "secret.txt")),
            /relative path/,
        );
        await assert.rejects(readHostSkill(f.skills, "guide", "huge.txt"), /limited to/);
    } finally {
        await rm(f.root, { recursive: true, force: true });
    }
});

test("remote memory isolates the same folder on different SSH hosts from local folder memory", async () => {
    const f = await fixture();

    try {
        const locations = new Map([
            [1, { kind: "ssh", host: "one" }],
            [2, { kind: "ssh", host: "two" }],
        ]);
        const memory = new Memory({
            rootOf: (id: number) => id,
            sessionMeta: () => ({}),
            cwdOf: () => f.root,
            locationOf: (id: number) => locations.get(id),
            now: () => Date.now(),
        } as never);
        const one = await memory.project(1 as never, f.root);
        const two = await memory.project(2 as never, f.root);
        const local = await memory.project(3 as never, f.root);

        assert.notEqual(one!.key, two!.key);
        assert.notEqual(one!.key, local!.key);
        assert.notEqual(two!.key, local!.key);
        assert.equal((await memory.project(1 as never, `${f.root}/child/..`))!.key, one!.key);
        assert.match(one!.name, /^one · /);
    } finally {
        await rm(f.root, { recursive: true, force: true });
    }
});
