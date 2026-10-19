import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { NamespaceEnv } from "./remote-project-fixture.ts";
import {
    RemoteProjectResources,
    type RemoteProjectTrustDecision,
} from "../src/server/remote-project-resources.ts";

const context = BACKGROUND_CONTEXT;

async function fixture() {
    const folder = await mkdtemp(join(tmpdir(), "coop-remote-resources-"));
    const root = await realpath(folder);
    const one = join(root, "one");
    const two = join(root, "two");

    const put = async (namespace: string, path: string, content: string | Uint8Array) => {
        const file = join(namespace, path);

        await mkdir(posix.dirname(file), { recursive: true });
        await writeFile(file, content);
    };

    const skill = (name: string, description = name) =>
        `---\nname: ${name}\ndescription: ${description}\n---\nInstructions for ${description}.\n`;

    for (const namespace of [one, two]) {
        await mkdir(join(namespace, "project", "app"), { recursive: true });
        await mkdir(join(namespace, "project", ".git"), { recursive: true });
        await mkdir(join(namespace, "home", "remote"), { recursive: true });
        await put(
            namespace,
            "/project/app/.pi/skills/guide/SKILL.md",
            skill("guide", namespace === one ? "remote one" : "remote two"),
        );
    }

    return {
        root,
        one,
        two,
        put,
        skill,
        cleanup: () => rm(root, { recursive: true, force: true }),
    };
}

test("remote project resources require exact host-owned trust, preserve discovery precedence and revoke immediately", async () => {
    const f = await fixture();

    try {
        await f.put(
            f.one,
            "/project/app/.agents/skills/guide/SKILL.md",
            f.skill("guide", "shadowed"),
        );
        await f.put(f.one, "/project/.agents/skills/parent/SKILL.md", f.skill("parent"));
        await f.put(f.one, "/.agents/skills/outside/SKILL.md", f.skill("outside"));
        await f.put(
            f.one,
            "/project/app/.pi/prompts/review.md",
            "---\ndescription: Review remote files\nargument-hint: '[path]'\n---\nReview $1.",
        );
        await f.put(f.one, "/project/app/.pi/settings.json", '{"defaultProjectTrust":"always"}');
        const resources = new RemoteProjectResources();
        const env = new NamespaceEnv(f.one, "ssh:one");
        const other = new NamespaceEnv(f.two, "ssh:two");
        const before = await resources.load(env, env.cwd, [], context);

        assert.equal(before.trust.ask, true);
        assert.equal(before.trust.trusted, false);
        assert.equal(before.trust.settings, true);
        assert.deepEqual(before.trust.ownSkills, [{ name: "guide", description: "remote one" }]);
        assert.deepEqual(before.skills, []);
        assert.deepEqual(before.templates, []);
        let decisions = await resources.saveTrust(env, env.cwd, [], "trust", context);

        assert.deepEqual(decisions, [
            { filesystem: "ssh:one", path: "/project/app", trusted: true },
        ]);
        await symlink(join(f.one, "project", "app"), join(f.one, "project", "alias"));
        assert.equal(
            (await resources.load(env, "/project/alias", decisions, context)).trust.folder,
            "/project/app",
        );
        assert.equal(
            (await resources.load(env, "/project/alias", decisions, context)).trust.trusted,
            true,
        );
        const trusted = await resources.load(env, env.cwd, decisions, context);

        assert.deepEqual(
            trusted.skills.map((skill) => skill.name),
            ["guide", "parent"],
        );
        assert.match(trusted.skills[0]!.content, /Instructions for remote one/);
        assert.equal(trusted.templates[0]!.content, "Review $1.");
        assert.equal(trusted.templates[0]!.argumentHint, "[path]");
        assert.equal(
            (await resources.load(other, other.cwd, decisions, context)).trust.trusted,
            false,
        );
        assert.deepEqual((await resources.load(other, other.cwd, decisions, context)).skills, []);
        decisions = await resources.saveTrust(env, env.cwd, decisions, "distrust", context);
        assert.equal((await resources.load(env, env.cwd, decisions, context)).trust.trusted, false);
        await assert.rejects(
            resources.readSkill(env, env.cwd, decisions, "guide", undefined, context),
            /No trusted remote project skill/,
        );

        // Parent trust is explicit, canonical, inherited by siblings and overridden by a nearer refusal.
        decisions = await resources.saveTrust(env, env.cwd, decisions, "trust-parent", context);
        await mkdir(join(f.one, "project", "sibling"));
        assert.equal(
            (await resources.load(env, "/project/sibling", decisions, context)).trust.trusted,
            true,
        );
        decisions = await resources.saveTrust(
            env,
            "/project/sibling",
            decisions,
            "distrust",
            context,
        );
        assert.equal(
            (await resources.load(env, "/project/sibling", decisions, context)).trust.trusted,
            false,
        );
        assert.equal((await resources.load(env, env.cwd, decisions, context)).trust.trusted, true);
    } finally {
        await f.cleanup();
    }
});

test("remote skill resources use canonical confinement, bounded UTF-8 reads and never host-local namesakes", async () => {
    const f = await fixture();

    try {
        const env = new NamespaceEnv(f.one, "ssh:one");
        const resources = new RemoteProjectResources();
        const decisions = await resources.saveTrust(env, env.cwd, [], "trust", context);
        const base = "/project/app/.pi/skills/guide";

        await f.put(f.one, `${base}/reference '雪'.md`, "Remote resource 🐕\nSecond line");
        await f.put(f.one, `${base}/binary.dat`, new Uint8Array([0, 1, 2]));
        await f.put(f.one, `${base}/bad-utf8.md`, new Uint8Array([0xff, 0xfe]));
        await f.put(f.one, `${base}/large.md`, "雪".repeat(18_000));
        await f.put(f.one, "/project/private.txt", "Not registered");
        await symlink(join(f.one, "project", "private.txt"), join(f.one, base, "escape.md"));
        assert.equal(
            await resources.readSkill(
                env,
                env.cwd,
                decisions,
                "guide",
                "reference '雪'.md",
                context,
            ),
            "Remote resource 🐕\nSecond line",
        );
        await assert.rejects(
            resources.readSkill(
                env,
                env.cwd,
                decisions,
                "guide",
                "../../../../private.txt",
                context,
            ),
            /inside its skill directory/,
        );
        await assert.rejects(
            resources.readSkill(env, env.cwd, decisions, "guide", "escape.md", context),
            /escapes its discovery folder/,
        );
        await assert.rejects(
            resources.readSkill(env, env.cwd, decisions, "guide", "/project/private.txt", context),
            /relative path/,
        );
        await assert.rejects(
            resources.readSkill(env, env.cwd, decisions, "guide", "binary.dat", context),
            /UTF-8 text/,
        );
        await assert.rejects(
            resources.readSkill(env, env.cwd, decisions, "guide", "bad-utf8.md", context),
            /encoded data/,
        );
        await assert.rejects(
            resources.readSkill(env, env.cwd, decisions, "guide", "large.md", context),
            /size limit/,
        );

        // The cwd is an actual host directory containing traps, but only the separate namespace may supply resources.
        const namesake = join(f.root, "namesake");
        const trap = "Host-local namesake must not enter remote resources";

        await f.put(namesake, "/.pi/skills/host/SKILL.md", f.skill("host", trap));
        await f.put(namesake, "/.pi/prompts/trap.md", trap);
        await f.put(f.one, `${namesake}/.pi/skills/remote/SKILL.md`, f.skill("remote"));
        const namesakeDecisions = await resources.saveTrust(env, namesake, [], "trust", context);
        const result = await resources.load(env, namesake, namesakeDecisions, context);

        assert.deepEqual(
            result.skills.map((skill) => skill.name),
            ["remote"],
        );
        assert.doesNotMatch(JSON.stringify(result), /Host-local namesake/);
        env.disconnected = true;
        await assert.rejects(
            resources.load(env, namesake, namesakeDecisions, context),
            /Connection lost/,
        );
        env.disconnected = false;
        assert.equal(
            (await resources.load(env, namesake, namesakeDecisions, context)).skills[0]!.name,
            "remote",
        );
    } finally {
        await f.cleanup();
    }
});

test("automatic discovery bounds total bytes, directory entries and recursion before returning any project resources", async () => {
    const f = await fixture();

    try {
        const env = new NamespaceEnv(f.one, "ssh:one");
        const resources = new RemoteProjectResources();
        const decisions = await resources.saveTrust(env, env.cwd, [], "trust", context);
        const skills = "/project/app/.pi/skills";

        for (let i = 0; i < 22; i++) {
            await f.put(
                f.one,
                `${skills}/bulk-${String(i)}/SKILL.md`,
                `${f.skill(`bulk-${String(i)}`)}${"x".repeat(49 * 1024)}`,
            );
        }

        await assert.rejects(resources.load(env, env.cwd, decisions, context), /size limit/);
        await rm(join(f.one, skills), { recursive: true });
        const nested = `${skills}/${Array.from({ length: 17 }, () => "nested").join("/")}`;

        await f.put(f.one, `${nested}/SKILL.md`, f.skill("deep"));
        await assert.rejects(resources.load(env, env.cwd, decisions, context), /16 nested folders/);
        await rm(join(f.one, skills), { recursive: true });
        const prompts = "/project/app/.pi/prompts";

        await mkdir(join(f.one, prompts), { recursive: true });

        for (let i = 0; i < 4097; i++) {
            await f.put(f.one, `${prompts}/${String(i)}.txt`, "");
        }

        await assert.rejects(resources.load(env, env.cwd, decisions, context), /4096 entries/);
        await rm(join(f.one, prompts), { recursive: true });
        await f.put(f.one, `${skills}/repaired/SKILL.md`, f.skill("repaired"));
        assert.deepEqual(
            (await resources.load(env, env.cwd, decisions, context)).skills.map(
                (skill) => skill.name,
            ),
            ["repaired"],
        );
    } finally {
        await f.cleanup();
    }
});

test("trusted remote model defaults select only a known model pair; invalid settings fail without leaking contents", async () => {
    const f = await fixture();
    const models = await ModelRuntime.create({
        authPath: join(f.root, "isolated-auth.json"),
        modelsPath: null,
        modelsStorePath: join(f.root, "isolated-models.json"),
        refreshOnCreate: false,
        allowModelNetwork: false,
    });

    try {
        const known = models.getModel("anthropic", "claude-sonnet-4-5");

        assert.ok(known, "the bundled catalog includes an Anthropic model");
        const env = new NamespaceEnv(f.one, "ssh:one");
        const resources = new RemoteProjectResources();
        const path = "/project/app/.pi/settings.json";
        const settings = JSON.stringify({
            defaultProvider: known.provider,
            defaultModel: known.id,
            defaultThinkingLevel: "off",
            apiKey: "never-copy-or-print-this",
        });

        await f.put(f.one, path, settings);
        assert.equal(await resources.modelDefault(env, env.cwd, [], models, context), undefined);
        const decisions: RemoteProjectTrustDecision[] = await resources.saveTrust(
            env,
            env.cwd,
            [],
            "trust",
            context,
        );
        const selected = await resources.modelDefault(env, env.cwd, decisions, models, context);

        assert.equal(selected?.model, known);
        assert.equal(selected?.thinkingLevel, "off");
        await f.put(f.one, path, '{"defaultThinkingLevel":"high"}');
        assert.equal(
            await resources.modelDefault(env, env.cwd, decisions, models, context),
            undefined,
        );
        await f.put(
            f.one,
            path,
            '{"defaultProvider":"unknown","defaultModel":"missing","apiKey":"never-copy-or-print-this"}',
        );
        await assert.rejects(
            resources.modelDefault(env, env.cwd, decisions, models, context),
            (error: Error) => {
                assert.match(error.message, /provider or model is not known/);
                assert.doesNotMatch(error.message, /never-copy-or-print-this/);

                return true;
            },
        );
        await f.put(f.one, path, "invalid JSON never-copy-or-print-this");
        await assert.rejects(
            resources.modelDefault(env, env.cwd, decisions, models, context),
            /Cannot read bounded UTF-8 JSON/,
        );
        await f.put(f.one, path, '{"defaultProvider":"anthropic"}');
        await assert.rejects(
            resources.modelDefault(env, env.cwd, decisions, models, context),
            /Set both/,
        );
        await f.put(
            f.one,
            path,
            JSON.stringify({
                defaultProvider: known.provider,
                defaultModel: known.id,
                defaultThinkingLevel: "secret-invalid-thinking",
            }),
        );
        await assert.rejects(
            resources.modelDefault(env, env.cwd, decisions, models, context),
            /Invalid defaultThinkingLevel/,
        );
    } finally {
        await f.cleanup();
    }
});
